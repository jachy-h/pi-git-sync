import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PiSyncCommands } from "../src/commands.ts";
import { sha256 } from "../src/inventory.ts";
import { loadState, saveState } from "../src/state.ts";
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

async function seedConfigRepo(
	repoPath: string,
	commitMsg = "Initialize sync config",
): Promise<string> {
	await mkdir(join(repoPath, "sync/prompts"), { recursive: true });
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
	await runGit(repoPath, ["commit", "--no-gpg-sign", "-m", commitMsg]);
	return (await runGit(repoPath, ["rev-parse", "HEAD"])).stdout;
}

describe.sequential("PiSyncCommands.push", () => {
	it("pushes local changes to the remote and applies the result back to the agent", async () => {
		await withTestEnvironment(async (environment) => {
			const fixture = await createGitFixture(environment.rootDir);

			// Device A: seed the repo and push
			await seedConfigRepo(fixture.deviceAPath);
			await runGit(fixture.deviceAPath, ["push", "origin", "main"]);

			// Device B: clone and set baseline
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

			// Agent: modify a tracked file
			await environment.writeAgentFile("prompts/welcome.md", "local update\n");

			// Push
			const result = await new PiSyncCommands(environment.agentDir).push(
				fixture.deviceBPath,
			);

			expect(result).toMatchObject({
				reload: true,
				message: expect.stringContaining("Pushed successfully"),
			});
			expect(
				await readFile(
					join(fixture.deviceBPath, "sync/prompts/welcome.md"),
					"utf-8",
				),
			).toBe("local update\n");

			// Remote should have the new commit
			const remoteHead = (
				await runGit(fixture.deviceBPath, ["rev-parse", "origin/main"])
			).stdout;
			const localHead = (
				await runGit(fixture.deviceBPath, ["rev-parse", "HEAD"])
			).stdout;
			expect(localHead).toBe(remoteHead);

			// Every successful push publishes an immutable-name snapshot for this
			// agent as well as the shared main branch.
			const deviceRefs = (
				await runGit(fixture.deviceBPath, [
					"for-each-ref",
					"--format=%(refname)",
					"refs/remotes/origin/pisync-device",
				])
			).stdout
				.trim()
				.split("\n")
				.filter(Boolean);
			expect(deviceRefs).toHaveLength(1);
			expect(
				(await runGit(fixture.deviceBPath, ["rev-parse", deviceRefs[0]!]))
					.stdout,
			).toBe(remoteHead);
		});
	});

	it("returns 'No changes to push' when there is nothing to capture", async () => {
		await withTestEnvironment(async (environment) => {
			const fixture = await createGitFixture(environment.rootDir);

			await seedConfigRepo(fixture.deviceAPath);
			await runGit(fixture.deviceAPath, ["push", "origin", "main"]);
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

			const result = await new PiSyncCommands(environment.agentDir).push(
				fixture.deviceBPath,
			);

			expect(result).toMatchObject({
				reload: false,
				message: expect.stringContaining("No changes to push"),
			});
		});
	});

	it("calibrates an uninitialized scaffold settings placeholder from the local agent", async () => {
		await withTestEnvironment(async (environment) => {
			const fixture = await createGitFixture(environment.rootDir);
			await seedConfigRepo(fixture.deviceAPath);
			await runGit(fixture.deviceAPath, ["push", "origin", "main"]);
			await runGit(fixture.deviceBPath, ["pull", "--ff-only"]);

			const localSettings = {
				packages: ["npm:@jachy/pi-git-sync", "npm:pi-lens"],
			};
			await environment.writeAgentFile(
				"settings.json",
				JSON.stringify(localSettings),
			);
			await saveState(
				environment.agentDir,
				createSyncState({
					repoPath: fixture.deviceBPath,
					files: {},
				}),
			);

			const preparation = await new PiSyncCommands(
				environment.agentDir,
			).preparePush(fixture.deviceBPath);

			expect(preparation.kind).toBe("ready");
			expect(preparation.capture.captured).toContain("settings.json");
			expect(
				JSON.parse(
					await readFile(
						join(fixture.deviceBPath, "sync/settings.json"),
						"utf-8",
					),
				),
			).toEqual(localSettings);
		});
	});

	it("refreshes stale local capture staging instead of reporting a bilateral conflict", async () => {
		await withTestEnvironment(async (environment) => {
			const fixture = await createGitFixture(environment.rootDir);
			const baselineCommit = await seedConfigRepo(fixture.deviceBPath);
			await runGit(fixture.deviceBPath, ["push", "origin", "main"]);
			await environment.writeAgentFile("prompts/welcome.md", "base\n");
			await saveState(
				environment.agentDir,
				createSyncState({
					repoPath: fixture.deviceBPath,
					lastSyncedCommit: baselineCommit,
					files: {
						"prompts/welcome.md": {
							sha256: sha256("base\n"),
							mode: 0o644,
						},
					},
				}),
			);

			const commands = new PiSyncCommands(environment.agentDir);
			await environment.writeAgentFile(
				"prompts/welcome.md",
				"first snapshot\n",
			);
			const firstPreparation = await commands.preparePush(fixture.deviceBPath);
			expect(firstPreparation.kind).toBe("ready");
			expect(
				await readFile(
					join(fixture.deviceBPath, "sync/prompts/welcome.md"),
					"utf-8",
				),
			).toBe("first snapshot\n");

			// Simulate a mutable local file changing after a blocked/cancelled prepare.
			// The dirty repo copy is staging produced by this same device, so retrying
			// must refresh it rather than creating a conflict branch.
			await environment.writeAgentFile(
				"prompts/welcome.md",
				"second snapshot\n",
			);
			const retryPreparation = await commands.preparePush(fixture.deviceBPath);
			expect(retryPreparation.kind).toBe("ready");
			expect(retryPreparation.message).not.toContain("Sync conflict detected");
			expect(
				await readFile(
					join(fixture.deviceBPath, "sync/prompts/welcome.md"),
					"utf-8",
				),
			).toBe("second snapshot\n");
			if (retryPreparation.kind !== "ready") {
				throw new Error("Expected retry preparation to be ready");
			}

			const result = await commands.executePush(retryPreparation);
			expect(result).toMatchObject({
				ok: true,
				message: expect.stringContaining("Pushed successfully"),
			});
			expect(
				await runGit(fixture.deviceBPath, [
					"show",
					"origin/main:sync/prompts/welcome.md",
				]),
			).toMatchObject({ stdout: "second snapshot" });
		});
	});

	it("detects bilateral conflicts and blocks the push without modifying remote", async () => {
		await withTestEnvironment(async (environment) => {
			const fixture = await createGitFixture(environment.rootDir);

			// Setup: both sides diverge on the same file
			await seedConfigRepo(fixture.deviceAPath);
			await runGit(fixture.deviceAPath, ["push", "origin", "main"]);
			await runGit(fixture.deviceBPath, ["pull", "--ff-only"]);

			// Establish baseline
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

			// Remote: modify
			await writeFile(
				join(fixture.deviceAPath, "sync/prompts/welcome.md"),
				"remote change\n",
				"utf-8",
			);
			await runGit(fixture.deviceAPath, ["add", "--all"]);
			await runGit(fixture.deviceAPath, ["commit", "-m", "Remote change"]);
			await runGit(fixture.deviceAPath, ["push", "origin", "main"]);

			// Local: modify same file differently
			await environment.writeAgentFile("prompts/welcome.md", "local change\n");

			// Preserve the current-device commit on a new branch instead of leaving
			// the repository in a rebase or asking the user to compare two files.
			const result = await new PiSyncCommands(environment.agentDir).push(
				fixture.deviceBPath,
			);
			const conflictBranch = result.message.match(/git merge ([^\s]+)/)?.[1];

			expect(result).toMatchObject({
				reload: false,
				message: expect.stringContaining("Sync conflict detected"),
			});
			expect(result.message).toContain("git merge origin/pisync-device/");
			expect(result.message).not.toContain("Agent (local)");
			expect(conflictBranch).toBeDefined();

			const state = await loadState(environment.agentDir);
			expect(state.pendingOperation).toBeNull();
			expect(
				await runGit(fixture.deviceBPath, [
					"show",
					`${conflictBranch!}:sync/prompts/welcome.md`,
				]),
			).toMatchObject({ stdout: "local change" });

			// The configured branch is restored to the remote version, ready for
			// `git merge <current-device-branch>`.
			const remoteHeadAfter = (
				await runGit(fixture.deviceAPath, ["rev-parse", "origin/main"])
			).stdout;
			const localHeadAfter = (
				await runGit(fixture.deviceBPath, ["rev-parse", "HEAD"])
			).stdout;
			expect(localHeadAfter).toBe(remoteHeadAfter);
			expect(
				await runGit(fixture.deviceBPath, ["branch", "--show-current"]),
			).toMatchObject({ stdout: "main" });
		});
	});

	it("preserves an already-detected bilateral conflict on a current-device branch", async () => {
		await withTestEnvironment(async (environment) => {
			const fixture = await createGitFixture(environment.rootDir);
			await seedConfigRepo(fixture.deviceAPath);
			await runGit(fixture.deviceAPath, ["push", "origin", "main"]);
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
				"remote change\n",
				"utf-8",
			);
			await runGit(fixture.deviceAPath, ["add", "--all"]);
			await runGit(fixture.deviceAPath, ["commit", "-m", "Remote change"]);
			await runGit(fixture.deviceAPath, ["push", "origin", "main"]);
			await runGit(fixture.deviceBPath, ["pull", "--ff-only"]);
			await environment.writeAgentFile("prompts/welcome.md", "local change\n");

			const preparation = await new PiSyncCommands(
				environment.agentDir,
			).preparePush(fixture.deviceBPath);
			const conflictBranch =
				preparation.message?.match(/git merge ([^\s]+)/)?.[1];

			expect(preparation.kind).toBe("blocked");
			expect(preparation.message).toContain("Sync conflict detected");
			expect(preparation.message).toContain("git merge origin/pisync-device/");
			expect(conflictBranch).toBeDefined();
			expect(
				await runGit(fixture.deviceBPath, [
					"show",
					`${conflictBranch!}:sync/prompts/welcome.md`,
				]),
			).toMatchObject({ stdout: "local change" });
			expect(
				await readFile(
					join(fixture.deviceBPath, "sync/prompts/welcome.md"),
					"utf-8",
				),
			).toBe("remote change\n");
		});
	});

	it("blocks push when potential secrets are detected (scanSecretsBeforePush=true)", async () => {
		await withTestEnvironment(async (environment) => {
			const fixture = await createGitFixture(environment.rootDir);

			const secretConfig = {
				...config,
				security: { scanSecretsBeforePush: true },
			};
			await mkdir(join(fixture.deviceBPath, "sync/prompts"), {
				recursive: true,
			});
			await writeFile(
				join(fixture.deviceBPath, "pi-sync.json"),
				JSON.stringify(secretConfig),
				"utf-8",
			);
			await writeFile(
				join(fixture.deviceBPath, "sync/prompts/welcome.md"),
				"base\n",
				"utf-8",
			);
			await runGit(fixture.deviceBPath, ["add", "--all"]);
			await runGit(fixture.deviceBPath, [
				"commit",
				"--no-gpg-sign",
				"-m",
				"Init with secret scan on",
			]);
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

			// Write a file with a fake GitHub token pattern
			await environment.writeAgentFile(
				"prompts/welcome.md",
				"ghp_1234567890abcdef1234567890abcdef123456\n",
			);

			const result = await new PiSyncCommands(environment.agentDir).push(
				fixture.deviceBPath,
			);

			expect(result).toMatchObject({
				reload: false,
				message: expect.stringContaining("potential secrets detected"),
			});
		});
	});

	it("blocks push when validation errors are present (e.g., corrupted JSON)", async () => {
		await withTestEnvironment(async (environment) => {
			const fixture = await createGitFixture(environment.rootDir);

			// Config includes settings.json
			const myConfig = { ...config, include: ["prompts/**", "settings.json"] };
			await mkdir(join(fixture.deviceBPath, "sync"), { recursive: true });
			await mkdir(join(fixture.deviceBPath, "sync/prompts"), {
				recursive: true,
			});
			await writeFile(
				join(fixture.deviceBPath, "pi-sync.json"),
				JSON.stringify(myConfig),
				"utf-8",
			);
			await writeFile(
				join(fixture.deviceBPath, "sync/settings.json"),
				JSON.stringify({ packages: ["npm:@jachy/pi-git-sync"] }),
				"utf-8",
			);
			await writeFile(
				join(fixture.deviceBPath, "sync/prompts/welcome.md"),
				"base\n",
				"utf-8",
			);
			await runGit(fixture.deviceBPath, ["add", "--all"]);
			await runGit(fixture.deviceBPath, [
				"commit",
				"--no-gpg-sign",
				"-m",
				"Init",
			]);
			await runGit(fixture.deviceBPath, ["push", "origin", "main"]);

			await environment.writeAgentFile("prompts/welcome.md", "base\n");
			await environment.writeAgentFile(
				"settings.json",
				JSON.stringify({ packages: ["npm:@jachy/pi-git-sync"] }),
			);
			await saveState(
				environment.agentDir,
				createSyncState({
					repoPath: fixture.deviceBPath,
					files: {
						"prompts/welcome.md": { sha256: sha256("base\n"), mode: 0o644 },
						"settings.json": {
							sha256: sha256(
								JSON.stringify({ packages: ["npm:@jachy/pi-git-sync"] }),
							),
							mode: 0o644,
						},
					},
				}),
			);

			// Corrupt settings.json in the repo working tree (pre-dirty the repo)
			await writeFile(
				join(fixture.deviceBPath, "sync/settings.json"),
				"not valid json at all {{{{{",
				"utf-8",
			);

			const result = await new PiSyncCommands(environment.agentDir).push(
				fixture.deviceBPath,
			);

			// Validation errors are diagnosed; the push may still proceed with errors reported
			expect(result.message).toContain("Validation errors");
			expect(result.message).toContain("Invalid JSON");
		});
	});
});

describe.sequential("PiSyncCommands.push (rebase conflict and --continue)", () => {
	it("preserves a rebase conflict on a current-device branch", async () => {
		await withTestEnvironment(async (environment) => {
			const fixture = await createGitFixture(environment.rootDir);

			// Setup remote with a commit
			await seedConfigRepo(fixture.deviceAPath);
			await runGit(fixture.deviceAPath, ["push", "origin", "main"]);

			// Device B clones and makes a local commit that will conflict
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

			// Remote: add a distant commit so B is behind
			await writeFile(
				join(fixture.deviceAPath, "sync/prompts/welcome.md"),
				"remote change for conflict\n",
				"utf-8",
			);
			await runGit(fixture.deviceAPath, ["add", "--all"]);
			await runGit(fixture.deviceAPath, [
				"commit",
				"--no-gpg-sign",
				"-m",
				"Remote diverging change",
			]);
			await runGit(fixture.deviceAPath, ["push", "origin", "main"]);

			// Agent: modify same file with conflicting content
			await environment.writeAgentFile(
				"prompts/welcome.md",
				"local conflicting change\n",
			);

			// Push captures the local change, but preserves it on a separate branch
			// rather than leaving the repository in a rebase state.
			const result = await new PiSyncCommands(environment.agentDir).push(
				fixture.deviceBPath,
			);
			const conflictBranch = result.message.match(/git merge ([^\s]+)/)?.[1];

			expect(result).toMatchObject({
				reload: false,
				message: expect.stringContaining("Sync conflict detected"),
			});
			expect(result.message).toContain("git merge origin/pisync-device/");
			expect(conflictBranch).toBeDefined();
			expect(
				await runGit(fixture.deviceBPath, [
					"show",
					`${conflictBranch!}:sync/prompts/welcome.md`,
				]),
			).toMatchObject({ stdout: "local conflicting change" });
			expect(
				(await loadState(environment.agentDir)).pendingOperation,
			).toBeNull();
		});
	});

	it("push --continue returns error when there is no pending operation", async () => {
		await withTestEnvironment(async (environment) => {
			const fixture = await createGitFixture(environment.rootDir);
			await seedConfigRepo(fixture.deviceBPath);

			const result = await new PiSyncCommands(environment.agentDir).push(
				fixture.deviceBPath,
				undefined,
				"--continue",
			);

			expect(result).toMatchObject({
				reload: false,
				message: expect.stringContaining("No pending push operation"),
			});
		});
	});

	it("push --continue returns error when unmerged paths still exist", async () => {
		await withTestEnvironment(async (environment) => {
			const fixture = await createGitFixture(environment.rootDir);

			await seedConfigRepo(fixture.deviceBPath);
			await runGit(fixture.deviceBPath, ["push", "origin", "main"]);

			// Set pending operation state
			await saveState(
				environment.agentDir,
				createSyncState({
					repoPath: fixture.deviceBPath,
					pendingOperation: {
						type: "push-rebase-conflict" as const,
						startedAt: "2026-01-01T00:00:00.000Z",
					},
					files: {
						"prompts/welcome.md": { sha256: sha256("base\n"), mode: 0o644 },
					},
				}),
			);

			// Create a real conflict via merge
			await runGit(fixture.deviceBPath, ["checkout", "-b", "conflict-test"]);
			await writeFile(
				join(fixture.deviceBPath, "sync/prompts/welcome.md"),
				"branch-content\n",
				"utf-8",
			);
			await runGit(fixture.deviceBPath, ["add", "--all"]);
			await runGit(fixture.deviceBPath, [
				"commit",
				"--no-gpg-sign",
				"-m",
				"Branch commit",
			]);

			await runGit(fixture.deviceBPath, ["checkout", "main"]);
			await writeFile(
				join(fixture.deviceBPath, "sync/prompts/welcome.md"),
				"main-content\n",
				"utf-8",
			);
			await runGit(fixture.deviceBPath, ["add", "--all"]);
			await runGit(fixture.deviceBPath, [
				"commit",
				"--no-gpg-sign",
				"-m",
				"Main commit",
			]);

			// Try merge without resolution
			try {
				await runGit(fixture.deviceBPath, ["merge", "conflict-test"]);
			} catch {
				// Expected conflict
			}

			const result = await new PiSyncCommands(environment.agentDir).push(
				fixture.deviceBPath,
				undefined,
				"--continue",
			);

			expect(result).toMatchObject({
				reload: false,
				message: expect.stringContaining("unmerged"),
			});
		});
	});

	it("push --continue after rebase resolution succeeds", async () => {
		await withTestEnvironment(async (environment) => {
			const fixture = await createGitFixture(environment.rootDir);

			// Seed remote with base commit
			await seedConfigRepo(fixture.deviceAPath);
			await runGit(fixture.deviceAPath, ["push", "origin", "main"]);

			// Device B: clone, set baseline, then simulate a rebase-conflict resolution
			await runGit(fixture.deviceBPath, ["pull", "--ff-only"]);
			await environment.writeAgentFile("prompts/welcome.md", "base\n");
			await saveState(
				environment.agentDir,
				createSyncState({
					repoPath: fixture.deviceBPath,
					files: {
						"prompts/welcome.md": { sha256: sha256("base\n"), mode: 0o644 },
					},
					pendingOperation: {
						type: "push-rebase-conflict" as const,
						startedAt: "2026-01-01T00:00:00.000Z",
					},
				}),
			);

			// Make a local commit on B (simulating what would happen during capture+commit in push)
			await writeFile(
				join(fixture.deviceBPath, "sync/prompts/welcome.md"),
				"resolved content after conflict\n",
				"utf-8",
			);
			await runGit(fixture.deviceBPath, ["add", "--all"]);
			await runGit(fixture.deviceBPath, [
				"commit",
				"--no-gpg-sign",
				"-m",
				"Resolved rebase conflict",
			]);

			// Now push --continue should succeed
			const result = await new PiSyncCommands(environment.agentDir).push(
				fixture.deviceBPath,
				undefined,
				"--continue",
			);

			expect(result.reload).toBe(true);

			// State should no longer have pending operation
			const state = await loadState(environment.agentDir);
			expect(state.pendingOperation).toBeNull();
		});
	});

	it("push --continue blocks when worktree is not clean", async () => {
		await withTestEnvironment(async (environment) => {
			const fixture = await createGitFixture(environment.rootDir);

			await seedConfigRepo(fixture.deviceBPath);
			await runGit(fixture.deviceBPath, ["push", "origin", "main"]);

			// Set pending operation state
			await saveState(
				environment.agentDir,
				createSyncState({
					repoPath: fixture.deviceBPath,
					pendingOperation: {
						type: "push-rebase-conflict" as const,
						startedAt: "2026-01-01T00:00:00.000Z",
					},
					files: {
						"prompts/welcome.md": { sha256: sha256("base\n"), mode: 0o644 },
					},
				}),
			);

			// Make worktree dirty
			await writeFile(
				join(fixture.deviceBPath, "sync/prompts/welcome.md"),
				"unsaved changes\n",
				"utf-8",
			);

			const result = await new PiSyncCommands(environment.agentDir).push(
				fixture.deviceBPath,
				undefined,
				"--continue",
			);

			expect(result).toMatchObject({
				reload: false,
				message: expect.stringContaining("Worktree is not clean"),
			});
		});
	});

	it("pushes successfully with a custom commit message", async () => {
		await withTestEnvironment(async (environment) => {
			const fixture = await createGitFixture(environment.rootDir);

			await seedConfigRepo(fixture.deviceAPath);
			await runGit(fixture.deviceAPath, ["push", "origin", "main"]);
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

			await environment.writeAgentFile(
				"prompts/welcome.md",
				"custom commit message test\n",
			);

			const result = await new PiSyncCommands(environment.agentDir).push(
				fixture.deviceBPath,
				"my custom sync message --verbose",
			);

			expect(result).toMatchObject({
				reload: true,
				message: expect.stringContaining("Pushed successfully"),
			});

			// Verify the commit message was used
			const log = (
				await runGit(fixture.deviceBPath, ["log", "--format=%s", "-1"])
			).stdout;
			expect(log).toBe("my custom sync message --verbose");
		});
	});

	it("handles push failure when remote is unreachable", async () => {
		await withTestEnvironment(async (environment) => {
			const fixture = await createGitFixture(environment.rootDir);

			// Make SSH fail fast to simulate unreachable remote
			const prevSsh = process.env.GIT_SSH_COMMAND;
			process.env.GIT_SSH_COMMAND = "exit 1";

			try {
				// Setup local repo without pushing
				await seedConfigRepo(fixture.deviceBPath);
				// Set origin to an SSH host (won't be reached because SSH exits 1 immediately)
				await runGit(fixture.deviceBPath, [
					"remote",
					"set-url",
					"origin",
					"git@ssh.invalid:nope/repo.git",
				]);

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

				await environment.writeAgentFile(
					"prompts/welcome.md",
					"change for failed push\n",
				);

				const result = await new PiSyncCommands(environment.agentDir).push(
					fixture.deviceBPath,
				);

				// Should gracefully report push failure
				expect(result.reload).toBe(false);
				expect(result.message).toBeDefined();
			} finally {
				if (prevSsh === undefined) {
					delete process.env.GIT_SSH_COMMAND;
				} else {
					process.env.GIT_SSH_COMMAND = prevSsh;
				}
			}
		});
	});
});
