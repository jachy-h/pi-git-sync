import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PiSyncCommands } from "../src/commands.ts";
import { sha256 } from "../src/inventory.ts";
import { saveState } from "../src/state.ts";
import { createSyncState } from "./helpers/factories.ts";
import { createGitFixture, runGit } from "./helpers/git-fixture.ts";
import { withTestEnvironment } from "./helpers/temp-env.ts";

const config = {
	schemaVersion: 2,
	branch: "main",
	root: "sync",
	include: ["prompts/**", "settings.json"],
	exclude: [],
	delete: "tracked",
	security: { scanSecretsBeforePush: false },
} as const;

async function seedConfigRepo(repoPath: string): Promise<void> {
	await mkdir(join(repoPath, "sync/prompts"), { recursive: true });
	await writeFile(join(repoPath, "pi-sync.json"), JSON.stringify(config));
	await writeFile(join(repoPath, "sync/settings.json"), "{}\n");
	await writeFile(join(repoPath, "sync/prompts/welcome.md"), "baseline\n");
	await runGit(repoPath, ["add", "--all"]);
	await runGit(repoPath, [
		"commit",
		"--no-gpg-sign",
		"-m",
		"Initialize sync config",
	]);
	await runGit(repoPath, ["push", "--set-upstream", "origin", "main"]);
}

type RunResultLike = {
	ok: boolean;
	mode: "setup" | "sync" | "recovery";
	phase: string;
	reload: boolean;
	details?: { needsGitUrl?: boolean };
};

function runOf(
	commands: PiSyncCommands,
	options?: unknown,
): Promise<RunResultLike> {
	return (
		commands as unknown as {
			run(options?: unknown): Promise<RunResultLike>;
		}
	).run(options);
}

describe("v0.3 unified command domain contract", () => {
	it("returns needsGitUrl without performing setup when uninitialized", async () => {
		await withTestEnvironment(async (environment) => {
			const result = await runOf(new PiSyncCommands(environment.agentDir));

			expect(result.ok).toBe(false);
			expect(result.mode).toBe("setup");
			expect(result.details?.needsGitUrl).toBe(true);
		});
	});

	it("fails closed for a partially initialized repository", async () => {
		await withTestEnvironment(async (environment) => {
			await mkdir(join(environment.agentDir, ".pi-sync"), { recursive: true });
			await writeFile(
				join(environment.agentDir, ".pi-sync/state.json"),
				JSON.stringify(
					createSyncState({
						repoPath: join(environment.rootDir, "missing-repo"),
					}),
				),
			);

			const result = await runOf(new PiSyncCommands(environment.agentDir));

			expect(result.ok).toBe(false);
			expect(result.details).not.toMatchObject({ needsGitUrl: true });
		});
	});

	it("runs pull before push, including when pull has no file changes", async () => {
		await withTestEnvironment(async (environment) => {
			const fixture = await createGitFixture(environment.rootDir);
			await seedConfigRepo(fixture.deviceAPath);
			const baseline = "baseline\n";
			await environment.writeAgentFile("prompts/welcome.md", baseline);
			await saveState(
				environment.agentDir,
				createSyncState({
					repoPath: fixture.deviceAPath,
					files: {
						"prompts/welcome.md": { sha256: sha256(baseline), mode: 0o644 },
					},
				}),
			);

			const phases: string[] = [];
			const result = await runOf(new PiSyncCommands(environment.agentDir), {
				onProgress: (phase: string) => phases.push(phase),
			});

			expect(result.ok).toBe(true);
			expect(phases.indexOf("pull")).toBeGreaterThanOrEqual(0);
			expect(phases.indexOf("push")).toBeGreaterThan(phases.indexOf("pull"));
		});
	});

	it("does not enter push after a fetch failure", async () => {
		await withTestEnvironment(async (environment) => {
			const fixture = await createGitFixture(environment.rootDir);
			await seedConfigRepo(fixture.deviceAPath);
			await environment.writeAgentFile("prompts/welcome.md", "baseline\n");
			await saveState(
				environment.agentDir,
				createSyncState({ repoPath: fixture.deviceAPath }),
			);
			await runGit(fixture.deviceAPath, [
				"remote",
				"set-url",
				"origin",
				join(environment.rootDir, "missing-remote.git"),
			]);

			const phases: string[] = [];
			const result = await runOf(new PiSyncCommands(environment.agentDir), {
				onProgress: (phase: string) => phases.push(phase),
			});

			expect(result.ok).toBe(false);
			expect(phases).not.toContain("push");
		});
	});

	it("pushes an ahead commit even when pull leaves no worktree changes", async () => {
		await withTestEnvironment(async (environment) => {
			const fixture = await createGitFixture(environment.rootDir);
			await seedConfigRepo(fixture.deviceAPath);
			await environment.writeAgentFile("prompts/welcome.md", "baseline\n");
			await saveState(
				environment.agentDir,
				createSyncState({
					repoPath: fixture.deviceAPath,
					files: {
						"prompts/welcome.md": { sha256: sha256("baseline\n"), mode: 0o644 },
					},
				}),
			);
			await writeFile(
				join(fixture.deviceAPath, "sync/prompts/welcome.md"),
				"ahead commit\n",
			);
			await runGit(fixture.deviceAPath, ["add", "--all"]);
			await runGit(fixture.deviceAPath, [
				"commit",
				"--no-gpg-sign",
				"-m",
				"Create ahead commit",
			]);
			const localHead = (
				await runGit(fixture.deviceAPath, ["rev-parse", "HEAD"])
			).stdout;

			const result = await runOf(new PiSyncCommands(environment.agentDir));
			const remoteHead = (
				await runGit(fixture.remotePath, ["rev-parse", "refs/heads/main"])
			).stdout;

			expect(result.ok).toBe(true);
			expect(remoteHead).toBe(localHead);
		});
	});

	it("aggregates reload when pull applies before a later phase", async () => {
		await withTestEnvironment(async (environment) => {
			const fixture = await createGitFixture(environment.rootDir);
			await seedConfigRepo(fixture.deviceAPath);
			await environment.writeAgentFile("prompts/welcome.md", "baseline\n");
			await saveState(
				environment.agentDir,
				createSyncState({
					repoPath: fixture.deviceAPath,
					files: {
						"prompts/welcome.md": { sha256: sha256("baseline\n"), mode: 0o644 },
					},
				}),
			);
			await runGit(fixture.deviceBPath, [
				"pull",
				"--ff-only",
				"origin",
				"main",
			]);
			await writeFile(
				join(fixture.deviceBPath, "sync/prompts/welcome.md"),
				"remote update\n",
			);
			await runGit(fixture.deviceBPath, ["add", "--all"]);
			await runGit(fixture.deviceBPath, [
				"commit",
				"--no-gpg-sign",
				"-m",
				"Remote update",
			]);
			await runGit(fixture.deviceBPath, ["push", "origin", "main"]);

			const result = await runOf(new PiSyncCommands(environment.agentDir));

			expect(result.reload).toBe(true);
		});
	});

	it("automatically considers a legacy push conflict pending operation", async () => {
		await withTestEnvironment(async (environment) => {
			const fixture = await createGitFixture(environment.rootDir);
			await seedConfigRepo(fixture.deviceAPath);
			await environment.writeAgentFile("prompts/welcome.md", "baseline\n");
			await saveState(
				environment.agentDir,
				createSyncState({
					repoPath: fixture.deviceAPath,
					pendingOperation: {
						type: "push-rebase-conflict",
						startedAt: new Date().toISOString(),
					},
				}),
			);

			const result = await runOf(new PiSyncCommands(environment.agentDir));

			expect(["recovery", "sync"]).toContain(result.mode);
		});
	});
});
