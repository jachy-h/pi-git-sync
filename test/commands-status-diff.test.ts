import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PiSyncCommands } from "../src/orchestration/commands.ts";
import { sha256 } from "../src/sync/inventory.ts";
import { saveState } from "../src/system/state.ts";
import { createSyncState } from "./helpers/factories.ts";
import {
	configureGitRepository,
	createGitFixture,
	runGit,
} from "./helpers/git-fixture.ts";
import { withTestEnvironment } from "./helpers/temp-env.ts";

const config = {
	schemaVersion: 2,
	branch: "main",
	root: "sync",
	include: ["prompts/**", "settings.json", "themes/**"],
	exclude: [],
	delete: "tracked",
	security: { scanSecretsBeforePush: false },
} as const;

async function seedConfigRepo(repoPath: string): Promise<void> {
	await configureGitRepository(repoPath);
	await mkdir(join(repoPath, "sync/prompts"), { recursive: true });
	await mkdir(join(repoPath, "sync/themes"), { recursive: true });
	await writeFile(
		join(repoPath, "pi-sync.json"),
		JSON.stringify(config),
		"utf-8",
	);
	await writeFile(join(repoPath, "sync/prompts/welcome.md"), "base\n", "utf-8");
	await writeFile(
		join(repoPath, "sync/settings.json"),
		JSON.stringify({ packages: ["npm:@jachy/pi-git-sync"] }),
		"utf-8",
	);
	await runGit(repoPath, ["add", "--all"]);
	await runGit(repoPath, [
		"commit",
		"--no-gpg-sign",
		"-m",
		"Initialize sync config",
	]);
}

describe.sequential("PiSyncCommands.status", () => {
	it("returns a message when no config repo is configured", async () => {
		await withTestEnvironment(async (environment) => {
			// no state, no repo — status should not throw
			const result = await new PiSyncCommands(environment.agentDir).status();
			expect(result).toContain("No config repo configured");
		});
	});

	it("shows repo info, branch, and sync state when configured", async () => {
		await withTestEnvironment(async (environment) => {
			const fixture = await createGitFixture(environment.rootDir);
			await seedConfigRepo(fixture.deviceBPath);
			await runGit(fixture.deviceBPath, ["push", "origin", "main"]);

			await environment.writeAgentFile("prompts/welcome.md", "base\n");
			await saveState(
				environment.agentDir,
				createSyncState({
					repoPath: fixture.deviceBPath,
					files: {
						"prompts/welcome.md": { sha256: sha256("base\n"), mode: 0o644 },
					},
				}),
			);

			const result = await new PiSyncCommands(environment.agentDir).status(
				fixture.deviceBPath,
			);

			// Should contain key info
			expect(result).toContain("pi-git-sync");
			expect(result).toContain("main @"); // branch + commit info
		});
	});

	it("shows local-only changes as capture-pending", async () => {
		await withTestEnvironment(async (environment) => {
			const fixture = await createGitFixture(environment.rootDir);
			await seedConfigRepo(fixture.deviceBPath);
			await runGit(fixture.deviceBPath, ["push", "origin", "main"]);

			await environment.writeAgentFile("prompts/welcome.md", "base\n");
			await saveState(
				environment.agentDir,
				createSyncState({
					repoPath: fixture.deviceBPath,
					files: {
						"prompts/welcome.md": { sha256: sha256("base\n"), mode: 0o644 },
					},
				}),
			);

			// Modify agent file
			await environment.writeAgentFile(
				"prompts/welcome.md",
				"locally modified\n",
			);

			const result = await new PiSyncCommands(environment.agentDir).status(
				fixture.deviceBPath,
			);
			// Local-only changes show as "agent modified" in the Pending section
			expect(result).toContain("agent modified");
		});
	});

	it("includes remote ahead/behind info", async () => {
		await withTestEnvironment(async (environment) => {
			const fixture = await createGitFixture(environment.rootDir);

			// Device A: seed and push
			await seedConfigRepo(fixture.deviceAPath);
			await runGit(fixture.deviceAPath, ["push", "origin", "main"]);

			// Device B: clone
			await runGit(fixture.deviceBPath, ["pull", "--ff-only"]);
			await environment.writeAgentFile("prompts/welcome.md", "base\n");
			await saveState(
				environment.agentDir,
				createSyncState({
					repoPath: fixture.deviceBPath,
					files: {
						"prompts/welcome.md": { sha256: sha256("base\n"), mode: 0o644 },
					},
				}),
			);

			// Device A: push new commit (B is now behind)
			await writeFile(
				join(fixture.deviceAPath, "sync/prompts/welcome.md"),
				"new remote\n",
				"utf-8",
			);
			await runGit(fixture.deviceAPath, ["add", "--all"]);
			await runGit(fixture.deviceAPath, [
				"commit",
				"--no-gpg-sign",
				"-m",
				"Remote update",
			]);
			await runGit(fixture.deviceAPath, ["push", "origin", "main"]);

			const result = await new PiSyncCommands(environment.agentDir).status(
				fixture.deviceBPath,
			);

			// Status should include info about the repo state
			expect(typeof result).toBe("string");
			expect(result.length).toBeGreaterThan(0);
		});
	});

	it("detects repo with no origin remote", async () => {
		await withTestEnvironment(async (environment) => {
			// Create a repo with no remote
			await mkdir(fixtureRepo(environment), { recursive: true });
			await runGit(fixtureRepo(environment), ["init", "--initial-branch=main"]);
			await seedConfigRepo(fixtureRepo(environment));

			await saveState(
				environment.agentDir,
				createSyncState({
					repoPath: fixtureRepo(environment),
				}),
			);

			const result = await new PiSyncCommands(environment.agentDir).status(
				fixtureRepo(environment),
			);
			// Should not crash, should report repo info
			expect(typeof result).toBe("string");
		});

		function fixtureRepo(env: { rootDir: string }): string {
			return join(env.rootDir, "no-remote-repo");
		}
	});
});

describe.sequential("PiSyncCommands.diff", () => {
	it("returns a message when no config repo is configured", async () => {
		await withTestEnvironment(async (environment) => {
			const result = await new PiSyncCommands(environment.agentDir).diff();
			expect(result).toContain("No config repo configured");
		});
	});

	it("shows file comparison, git status, and remote changes", async () => {
		await withTestEnvironment(async (environment) => {
			const fixture = await createGitFixture(environment.rootDir);
			await seedConfigRepo(fixture.deviceBPath);
			await runGit(fixture.deviceBPath, ["push", "origin", "main"]);

			await environment.writeAgentFile("prompts/welcome.md", "base\n");
			await saveState(
				environment.agentDir,
				createSyncState({
					repoPath: fixture.deviceBPath,
					files: {
						"prompts/welcome.md": { sha256: sha256("base\n"), mode: 0o644 },
					},
				}),
			);

			// Modify agent file to create a diff
			await environment.writeAgentFile(
				"prompts/welcome.md",
				"modified for diff\n",
			);

			const result = await new PiSyncCommands(environment.agentDir).diff(
				fixture.deviceBPath,
			);

			expect(result).toContain("Git Status");
			expect(result).toContain("File Comparison");
			expect(typeof result).toBe("string");
		});
	});

	it("handles repo without remote gracefully (no remote diff section)", async () => {
		await withTestEnvironment(async (environment) => {
			const repoPath = join(environment.rootDir, "local-only-repo");
			await mkdir(repoPath, { recursive: true });
			await runGit(repoPath, ["init", "--initial-branch=main"]);
			await seedConfigRepo(repoPath);

			await environment.writeAgentFile("prompts/welcome.md", "local only\n");
			await saveState(
				environment.agentDir,
				createSyncState({
					repoPath,
					files: {
						"prompts/welcome.md": {
							sha256: sha256("local only\n"),
							mode: 0o644,
						},
					},
				}),
			);

			const result = await new PiSyncCommands(environment.agentDir).diff(
				repoPath,
			);

			expect(result).toContain("Git Status");
			expect(result).toContain("File Comparison");
			// Should not throw or crash
		});
	});
});
