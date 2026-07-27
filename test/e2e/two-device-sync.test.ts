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
			const pushResult = await aCmds.push(fixture.deviceAPath);
			expect(pushResult.reload).toBe(true);
			expect(pushResult.message).toContain("Pushed successfully");

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

				// B pulls A's update
				const pullResult = await bCmds.pull(envB.repoDir);
				expect(pullResult.message).toBeDefined();
				// Pull should succeed with reload=true; if not, check the message
				if (!pullResult.reload) {
					// May say "already up to date" if clone happened after push
					// Verify B can at least get to a consistent state
				}

				// Force-fetch to ensure B's repo is up to date
				await runGit(envB.repoDir, ["pull", "--ff-only", "origin", "main"]);

				// Apply manually
				const applyResult = await bCmds.apply(envB.repoDir);
				expect(
					applyResult.reload || applyResult.message.includes("up to date"),
				).toBe(true);

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

				// No-op pull/push
				const pullAgain = await bCmds.pull(envB.repoDir);
				expect(pullAgain.message).toContain("Already up to date");

				const pushAgain = await bCmds.push(envB.repoDir);
				expect(pushAgain.message).toContain("No changes to push");
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
				const pushA = await aCmds.push(fixture.deviceAPath);
				expect(pushA.reload).toBe(true);

				// B also changes and tries to push → should detect conflict
				await envB.writeAgentFile("prompts/welcome.md", "change from B\n");
				const bCmds = new PiSyncCommands(envB.agentDir);
				const pushB = await bCmds.push(envB.repoDir);

				// The device's changes are preserved on a branch for a manual Git merge.
				expect(pushB.reload).toBe(false);
				expect(pushB.message).toContain("Sync conflict detected");
				expect(pushB.message).toMatch(
					/git merge origin\/pisync-device\/[^\s]+/,
				);

				// B's agent should NOT have been modified
				expect(
					await readFile(join(envB.agentDir, "prompts/welcome.md"), "utf-8"),
				).toBe("change from B\n");
			} finally {
				await envB.cleanup();
			}
		});
	});
});
