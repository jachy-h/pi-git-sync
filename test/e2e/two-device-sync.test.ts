import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PiSyncCommands } from "../../src/commands.ts";
import { sha256 } from "../../src/inventory.ts";
import { saveState } from "../../src/state.ts";
import { createSyncState } from "../helpers/factories.ts";
import {
	configureGitRepository,
	createGitFixture,
	runGit,
} from "../helpers/git-fixture.ts";
import { withTestEnvironment } from "../helpers/temp-env.ts";

const config = {
	schemaVersion: 2,
	branch: "main",
	root: "sync",
	include: ["prompts/**", "settings.json", "themes/**", "extensions/**"],
	exclude: [],
	delete: "tracked",
	security: { scanSecretsBeforePush: false },
} as const;

async function seedAndPush(
	repoPath: string,
	initialFiles: Record<string, string>,
): Promise<void> {
	await mkdir(join(repoPath, "sync/prompts"), { recursive: true });
	await mkdir(join(repoPath, "sync/themes"), { recursive: true });
	await mkdir(join(repoPath, "sync/extensions"), { recursive: true });
	await writeFile(
		join(repoPath, "pi-sync.json"),
		JSON.stringify(config),
		"utf-8",
	);
	await writeFile(
		join(repoPath, "sync/settings.json"),
		JSON.stringify({ packages: ["npm:@jachy/pi-git-sync"] }),
		"utf-8",
	);
	for (const [path, content] of Object.entries(initialFiles)) {
		await writeFile(join(repoPath, "sync", path), content, "utf-8");
	}
	await runGit(repoPath, ["add", "--all"]);
	await runGit(repoPath, [
		"commit",
		"--no-gpg-sign",
		"-m",
		"Initialize sync config",
	]);
	await runGit(repoPath, ["push", "--set-upstream", "origin", "main"]);
}

describe.sequential("Two-device sync E2E", () => {
	it("full round-trip: A pushes, B pulls, A modifies, B pulls again", async () => {
		await withTestEnvironment(async (envA) => {
			const fixture = await createGitFixture(envA.rootDir);

			// === Step 1: Device A initializes with baseline content ===
			const baselineContent = "hello from device A\n";
			await seedAndPush(fixture.deviceAPath, {
				"prompts/welcome.md": baselineContent,
			});

			// Setup A's agent state to match the repo
			await envA.writeAgentFile("prompts/welcome.md", baselineContent);
			await saveState(
				envA.agentDir,
				createSyncState({
					repoPath: fixture.deviceAPath,
					files: {
						"prompts/welcome.md": {
							sha256: sha256(baselineContent),
							mode: 0o644,
						},
					},
				}),
			);

			// === Step 2: A modifies and pushes ===
			await envA.writeAgentFile(
				"prompts/welcome.md",
				"hello from device A — updated\n",
			);
			await envA.writeAgentFile(
				"themes/custom.json",
				JSON.stringify({ name: "custom" }),
			);

			const aCmds = new PiSyncCommands(envA.agentDir);
			const pushResult = await aCmds.run();
			expect(pushResult.reload).toBe(true);
			expect(pushResult.message).toContain("Sync completed");

			// === Step 3: Device B clones and applies ===
			const { createTestEnvironment: createEnv } = await import(
				"../helpers/temp-env.ts"
			);
			const envB = await createEnv("pi-git-sync-b-");

			try {
				// Clone the remote (B's repo)
				await runGit(envA.rootDir, ["clone", fixture.remotePath, envB.repoDir]);
				await configureGitRepository(envB.repoDir);

				// Set B's baseline to the original (before A's push)
				await envB.writeAgentFile("prompts/welcome.md", baselineContent);
				await saveState(
					envB.agentDir,
					createSyncState({
						repoPath: envB.repoDir,
						files: {
							"prompts/welcome.md": {
								sha256: sha256(baselineContent),
								mode: 0o644,
							},
						},
					}),
				);

				const bCmds = new PiSyncCommands(envB.agentDir);

				// B uses the unified command: pull first, then push.
				const pullResult = await bCmds.run();
				expect(pullResult.ok).toBe(true);
				expect(pullResult.reload).toBe(true);
				expect(pullResult.message).toContain("Pull:");

				// Verify B has the updated content
				const bWelcome = await readFile(
					join(envB.agentDir, "prompts/welcome.md"),
					"utf-8",
				);
				expect(bWelcome).toBe("hello from device A — updated\n");

				const bTheme = await readFile(
					join(envB.agentDir, "themes/custom.json"),
					"utf-8",
				);
				expect(JSON.parse(bTheme)).toEqual({ name: "custom" });

				// A repeated unified run is idempotent.
				const syncAgain = await bCmds.run();
				expect(syncAgain.ok).toBe(true);
				expect(syncAgain.code).toBe("noop");
			} finally {
				await envB.cleanup();
			}
		});
	});

	it("bilateral conflict: A and B diverge, push preserves B on a device branch", async () => {
		await withTestEnvironment(async (envA) => {
			const fixture = await createGitFixture(envA.rootDir);

			// Setup shared baseline in the remote
			const baselineContent = "baseline\n";
			await seedAndPush(fixture.deviceAPath, {
				"prompts/welcome.md": baselineContent,
			});

			// Setup A with baseline state
			await envA.writeAgentFile("prompts/welcome.md", baselineContent);
			await saveState(
				envA.agentDir,
				createSyncState({
					repoPath: fixture.deviceAPath,
					files: {
						"prompts/welcome.md": {
							sha256: sha256(baselineContent),
							mode: 0o644,
						},
					},
				}),
			);

			// Setup B with its own clone and baseline
			const { createTestEnvironment: createEnv } = await import(
				"../helpers/temp-env.ts"
			);
			const envB = await createEnv("pi-git-sync-b-");
			try {
				await runGit(envA.rootDir, ["clone", fixture.remotePath, envB.repoDir]);
				await configureGitRepository(envB.repoDir);
				await envB.writeAgentFile("prompts/welcome.md", baselineContent);
				await saveState(
					envB.agentDir,
					createSyncState({
						repoPath: envB.repoDir,
						files: {
							"prompts/welcome.md": {
								sha256: sha256(baselineContent),
								mode: 0o644,
							},
						},
					}),
				);

				// A changes and pushes first
				await envA.writeAgentFile("prompts/welcome.md", "change from A\n");
				const aCmds = new PiSyncCommands(envA.agentDir);
				const pushA = await aCmds.run();
				expect(pushA.reload).toBe(true);
				expect(pushA.ok).toBe(true);

				// B also changes and tries to synchronize → should detect conflict
				await envB.writeAgentFile("prompts/welcome.md", "change from B\n");
				const bCmds = new PiSyncCommands(envB.agentDir);
				const pushB = await bCmds.run();

				// The device's changes are preserved on a branch for a manual Git merge.
				expect(pushB.reload).toBe(false);
				expect(pushB.message).toContain("Sync conflict detected");
				expect(pushB.message).toMatch(
					/git merge origin\/pisync-device\/[^\s]+/,
				);
				expect(pushB.details?.conflict).toMatchObject({
					kind: "sync_conflict",
					sharedBranch: "main",
					deviceBranch: expect.stringMatching(/^pisync-device\//),
					paths: [
						{
							relativePath: "prompts/welcome.md",
						},
					],
				});

				// B's agent should NOT have been modified
				expect(
					await readFile(join(envB.agentDir, "prompts/welcome.md"), "utf-8"),
				).toBe("change from B\n");
			} finally {
				await envB.cleanup();
			}
		});
	});

	it.each([
		["use_local", "change from B\n"],
		["use_remote", "change from A\n"],
	] as const)(
		"resolves a two-device content conflict with %s",
		async (choice, expected) => {
			await withTestEnvironment(async (envA) => {
				const fixture = await createGitFixture(envA.rootDir);
				const baselineContent = "baseline\n";
				await seedAndPush(fixture.deviceAPath, {
					"prompts/welcome.md": baselineContent,
				});
				await envA.writeAgentFile("prompts/welcome.md", baselineContent);
				await saveState(
					envA.agentDir,
					createSyncState({
						repoPath: fixture.deviceAPath,
						files: {
							"prompts/welcome.md": {
								sha256: sha256(baselineContent),
								mode: 0o644,
							},
						},
					}),
				);

				const { createTestEnvironment: createEnv } = await import(
					"../helpers/temp-env.ts"
				);
				const envB = await createEnv("pi-git-sync-resolution-e2e-");
				try {
					await runGit(envA.rootDir, [
						"clone",
						fixture.remotePath,
						envB.repoDir,
					]);
					await configureGitRepository(envB.repoDir);
					await envB.writeAgentFile("prompts/welcome.md", baselineContent);
					await saveState(
						envB.agentDir,
						createSyncState({
							repoPath: envB.repoDir,
							files: {
								"prompts/welcome.md": {
									sha256: sha256(baselineContent),
									mode: 0o644,
								},
							},
						}),
					);

					await envA.writeAgentFile("prompts/welcome.md", "change from A\n");
					expect((await new PiSyncCommands(envA.agentDir).run()).ok).toBe(true);

					await envB.writeAgentFile("prompts/welcome.md", "change from B\n");
					const bCommands = new PiSyncCommands(envB.agentDir);
					const conflictResult = await bCommands.run();
					const conflict = conflictResult.details?.conflict;
					expect(conflict).toMatchObject({ kind: "sync_conflict" });
					if (!conflict) throw new Error("Expected a structured sync conflict");

					const resolved = await bCommands.resolveConflict(conflict, choice);
					expect(resolved.ok, resolved.message).toBe(true);
					expect(
						await readFile(join(envB.agentDir, "prompts/welcome.md"), "utf-8"),
					).toBe(expected);
					expect((await bCommands.run()).code).toBe("noop");
				} finally {
					await envB.cleanup();
				}
			});
		},
	);
});
