import { execFileSync } from "node:child_process";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { describe, expect, it } from "vitest";
import { PiSyncCommands } from "../src/commands.ts";
import { getHeadCommit } from "../src/git.ts";
import { sha256 } from "../src/inventory.ts";
import { normalizeSettingsForComparison } from "../src/settings-portability.ts";
import { loadState, saveState } from "../src/state.ts";
import { createSyncState } from "./helpers/factories.ts";
import { createGitFixture, runGit } from "./helpers/git-fixture.ts";
import { withTestEnvironment } from "./helpers/temp-env.ts";

const config = {
	schemaVersion: 2,
	branch: "main",
	root: "sync",
	include: ["prompts/**"],
	exclude: [],
	delete: "tracked",
	security: { scanSecretsBeforePush: false },
} as const;

async function seedConfigRepo(
	repoPath: string,
	configOverride: Record<string, unknown> = config,
): Promise<void> {
	await mkdir(join(repoPath, "sync/prompts"), { recursive: true });
	await writeFile(
		join(repoPath, "pi-sync.json"),
		JSON.stringify(configOverride),
		"utf-8",
	);
	await writeFile(join(repoPath, "sync/prompts/welcome.md"), "base\n", "utf-8");
	await runGit(repoPath, ["add", "pi-sync.json", "sync/prompts/welcome.md"]);
	await runGit(repoPath, ["commit", "-m", "Add sync configuration"]);
	await runGit(repoPath, ["push", "origin", "main"]);
}

describe.sequential("PiSyncCommands.pull", () => {
	it("captures and commits agent-only changes before pulling remote updates", async () => {
		await withTestEnvironment(async (environment) => {
			const fixture = await createGitFixture(environment.rootDir);
			await seedConfigRepo(fixture.deviceAPath);
			await runGit(fixture.deviceBPath, ["pull", "--ff-only"]);
			await environment.writeAgentFile("prompts/welcome.md", "base\n");
			await environment.writeAgentFile("prompts/local.md", "local\n");
			await saveState(
				environment.agentDir,
				createSyncState({
					repoPath: fixture.deviceBPath,
					files: {
						"prompts/welcome.md": { sha256: sha256("base\n"), mode: 0o644 },
					},
				}),
			);
			await writeFile(
				join(fixture.deviceAPath, "sync/prompts/welcome.md"),
				"remote\n",
				"utf-8",
			);
			await runGit(fixture.deviceAPath, ["add", "sync/prompts/welcome.md"]);
			await runGit(fixture.deviceAPath, ["commit", "-m", "Remote change"]);
			await runGit(fixture.deviceAPath, ["push", "origin", "main"]);

			const result = await new PiSyncCommands(environment.agentDir).pull(
				fixture.deviceBPath,
			);
			const state = await loadState(environment.agentDir);

			expect(result.ok, result.message).toBe(true);
			expect(result.reload).toBe(true);
			expect(
				await readFile(
					join(fixture.deviceBPath, "sync/prompts/welcome.md"),
					"utf-8",
				),
			).toBe("remote\n");
			expect(
				await readFile(
					join(fixture.deviceBPath, "sync/prompts/local.md"),
					"utf-8",
				),
			).toBe("local\n");
			expect(
				await readFile(
					join(environment.agentDir, "prompts/welcome.md"),
					"utf-8",
				),
			).toBe("remote\n");
			expect(
				await readFile(join(environment.agentDir, "prompts/local.md"), "utf-8"),
			).toBe("local\n");
			expect(
				(
					await runGit(fixture.deviceBPath, [
						"log",
						"--format=%s",
						"origin/main..HEAD",
					])
				).stdout,
			).toContain("pi-sync: capture local changes before pull");
			expect(state.files["prompts/local.md"]?.sha256).toBe(sha256("local\n"));
			expect(
				(await runGit(fixture.deviceBPath, ["status", "--porcelain"])).stdout,
			).toBe("");
		});
	});

	it.skipIf(process.platform === "win32")(
		"stops the whole fast-forward promptly after Git times out and remains usable",
		async () => {
			await withTestEnvironment(async (environment) => {
				const fixture = await createGitFixture(environment.rootDir);
				await seedConfigRepo(fixture.deviceAPath, {
					...config,
					pullTimeoutMs: 75,
				});
				await runGit(fixture.deviceBPath, ["pull", "--ff-only"]);
				await environment.writeAgentFile("prompts/welcome.md", "base\n");
				await saveState(
					environment.agentDir,
					createSyncState({
						repoPath: fixture.deviceBPath,
						files: {
							"prompts/welcome.md": {
								sha256: sha256("base\n"),
								mode: 0o644,
							},
						},
					}),
				);

				const realGit = execFileSync("which", ["git"], {
					encoding: "utf-8",
				}).trim();
				const fakeBin = join(environment.rootDir, "fake-bin");
				const fakeGit = join(fakeBin, "git");
				await mkdir(fakeBin, { recursive: true });
				await writeFile(
					fakeGit,
					`#!/bin/sh\nif [ "$1" = "merge" ]; then\n  sh -c 'sleep 30 & wait'\n  exit 0\nfi\nexec ${JSON.stringify(realGit)} "$@"\n`,
					"utf-8",
				);
				await chmod(fakeGit, 0o755);

				const previousPath = process.env.PATH;
				process.env.PATH = `${fakeBin}${delimiter}${previousPath ?? ""}`;
				try {
					const commands = new PiSyncCommands(environment.agentDir);
					const startedAt = Date.now();
					const result = await commands.pull(fixture.deviceBPath);

					expect(Date.now() - startedAt).toBeLessThan(1_500);
					expect(result).toMatchObject({ ok: false, code: "git_failed" });
					expect(result.message).toContain("timed out after 75 ms");

					// A timed-out pull must release its lock and process handles so the
					// next command can run immediately in the same Pi session.
					await expect(commands.status(fixture.deviceBPath)).resolves.toContain(
						"=== pi-git-sync Status ===",
					);
				} finally {
					process.env.PATH = previousPath;
				}
			});
		},
	);

	it("fast-forwards and materializes a remote-only change before updating state", async () => {
		await withTestEnvironment(async (environment) => {
			const fixture = await createGitFixture(environment.rootDir);
			await seedConfigRepo(fixture.deviceAPath);
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
			await writeFile(
				join(fixture.deviceAPath, "sync/prompts/welcome.md"),
				"remote\n",
				"utf-8",
			);
			await runGit(fixture.deviceAPath, ["add", "sync/prompts/welcome.md"]);
			await runGit(fixture.deviceAPath, ["commit", "-m", "Remote change"]);
			await runGit(fixture.deviceAPath, ["push", "origin", "main"]);

			const progress: string[] = [];
			const result = await new PiSyncCommands(environment.agentDir).pull(
				fixture.deviceBPath,
				undefined,
				(_phase, message) => progress.push(message),
			);
			const state = await loadState(environment.agentDir);

			expect(result).toMatchObject({
				reload: true,
				message: expect.stringContaining("Files written: 1"),
			});
			expect(progress).toEqual(
				expect.arrayContaining([
					"Inspecting repository state...",
					"Comparing local and remote changes...",
					"Running: git fetch origin (timeout: 10s)...",
					"Running: git merge --ff-only origin/main (timeout: 10s)...",
					"Applying pulled changes...",
				]),
			);
			expect(progress.some((message) => message.includes("git pull"))).toBe(
				false,
			);
			expect(
				await readFile(
					join(environment.agentDir, "prompts/welcome.md"),
					"utf-8",
				),
			).toBe("remote\n");
			expect(state.lastSyncedCommit).toBe(
				await getHeadCommit(fixture.deviceBPath),
			);
			expect(state.files["prompts/welcome.md"]?.sha256).toBe(
				sha256("remote\n"),
			);
		});
	});

	it("preserves local package paths while applying portable settings updates", async () => {
		await withTestEnvironment(async (environment) => {
			const fixture = await createGitFixture(environment.rootDir);
			await seedConfigRepo(fixture.deviceAPath, {
				...config,
				include: ["settings.json"],
			});
			const oldRemoteSettings = `${JSON.stringify(
				{
					packages: ["npm:@jachy/pi-git-sync"],
					theme: "old",
				},
				null,
				2,
			)}\n`;
			await writeFile(
				join(fixture.deviceAPath, "sync/settings.json"),
				oldRemoteSettings,
				"utf-8",
			);
			await runGit(fixture.deviceAPath, ["add", "sync/settings.json"]);
			await runGit(fixture.deviceAPath, ["commit", "-m", "Add settings"]);
			await runGit(fixture.deviceAPath, ["push", "origin", "main"]);
			await runGit(fixture.deviceBPath, ["pull", "--ff-only"]);

			await environment.writeAgentFile(
				"settings.json",
				`${JSON.stringify(
					{
						packages: ["npm:@jachy/pi-git-sync", "./local-extension"],
						theme: "old",
					},
					null,
					2,
				)}\n`,
			);
			await saveState(
				environment.agentDir,
				createSyncState({
					repoPath: fixture.deviceBPath,
					files: {
						"settings.json": {
							// Legacy states stored a raw-byte hash. Pull must migrate it
							// before fetching the next remote settings revision.
							sha256: sha256(oldRemoteSettings),
							mode: 0o644,
						},
					},
				}),
			);

			const newRemoteSettings = `${JSON.stringify(
				{
					packages: ["npm:@jachy/pi-git-sync"],
					theme: "new",
				},
				null,
				2,
			)}\n`;
			await writeFile(
				join(fixture.deviceAPath, "sync/settings.json"),
				newRemoteSettings,
				"utf-8",
			);
			await runGit(fixture.deviceAPath, ["add", "sync/settings.json"]);
			await runGit(fixture.deviceAPath, ["commit", "-m", "Update settings"]);
			await runGit(fixture.deviceAPath, ["push", "origin", "main"]);

			const startedAt = Date.now();
			const result = await new PiSyncCommands(environment.agentDir).pull(
				fixture.deviceBPath,
			);
			const applied = JSON.parse(
				await readFile(join(environment.agentDir, "settings.json"), "utf-8"),
			) as { packages: string[]; theme: string };
			const state = await loadState(environment.agentDir);

			expect(result.ok, result.message).toBe(true);
			expect(Date.now() - startedAt).toBeLessThan(10_000);
			expect(applied.theme).toBe("new");
			expect(applied.packages).toEqual([
				"npm:@jachy/pi-git-sync",
				"./local-extension",
			]);
			expect(state.files["settings.json"]?.sha256).toBe(
				sha256(normalizeSettingsForComparison(Buffer.from(newRemoteSettings))),
			);
		});
	});
});
