import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PiSyncCommands } from "../src/orchestration/commands.ts";
import { resolveAutomaticConflict } from "../src/system/conflict-resolution.ts";
import type { SyncConflictRequest } from "../src/orchestration/operation-result.ts";
import { sha256 } from "../src/sync/inventory.ts";
import { saveState } from "../src/system/state.ts";
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
	security: { scanSecretsBeforePush: true },
} as const;

async function seed(repoPath: string): Promise<void> {
	await mkdir(join(repoPath, "sync/prompts"), { recursive: true });
	await writeFile(join(repoPath, "pi-sync.json"), JSON.stringify(config));
	await writeFile(join(repoPath, "sync/prompts/welcome.md"), "base\n");
	await writeFile(join(repoPath, "sync/settings.json"), '{"packages":[]}\n');
	await runGit(repoPath, ["add", "--all"]);
	await runGit(repoPath, [
		"commit",
		"--no-gpg-sign",
		"-m",
		"Initialize sync config",
	]);
	await runGit(repoPath, ["push", "origin", "main"]);
}

async function createConflict(
	environment: Parameters<Parameters<typeof withTestEnvironment>[0]>[0],
	remoteContent: string | null = "remote\n",
): Promise<{
	commands: PiSyncCommands;
	repoPath: string;
	remotePath: string;
	publisherPath: string;
	request: SyncConflictRequest;
}> {
	const fixture = await createGitFixture(environment.rootDir);
	await seed(fixture.deviceAPath);
	await runGit(fixture.deviceBPath, ["pull", "--ff-only"]);
	await environment.writeAgentFile("prompts/welcome.md", "base\n");
	await environment.writeAgentFile("settings.json", '{"packages":[]}\n');
	await saveState(
		environment.agentDir,
		createSyncState({
			repoPath: fixture.deviceBPath,
			files: {
				"prompts/welcome.md": { sha256: sha256("base\n"), mode: 0o644 },
			},
		}),
	);
	if (remoteContent === null) {
		await runGit(fixture.deviceAPath, ["rm", "sync/prompts/welcome.md"]);
	} else {
		await writeFile(
			join(fixture.deviceAPath, "sync/prompts/welcome.md"),
			remoteContent,
		);
		await runGit(fixture.deviceAPath, ["add", "--all"]);
	}
	await runGit(fixture.deviceAPath, [
		"commit",
		"--no-gpg-sign",
		"-m",
		"Remote change",
	]);
	await runGit(fixture.deviceAPath, ["push", "origin", "main"]);
	await environment.writeAgentFile("prompts/welcome.md", "local\n");

	const commands = new PiSyncCommands(environment.agentDir);
	const blocked = await commands.push(fixture.deviceBPath);
	const request = (blocked.details as { conflict?: SyncConflictRequest })
		.conflict;
	expect(request, blocked.message).toBeDefined();
	return {
		commands,
		repoPath: fixture.deviceBPath,
		remotePath: fixture.remotePath,
		publisherPath: fixture.deviceAPath,
		request: request!,
	};
}

function chooseAllPaths(
	request: SyncConflictRequest,
	choice: "use_local" | "use_remote",
): { byPath: Record<string, "use_local" | "use_remote"> } {
	return {
		byPath: Object.fromEntries(
			request.paths.flatMap((path) => [
				[path.relativePath, choice],
				[`sync/${path.relativePath}`, choice],
			]),
		),
	};
}

async function advanceDeviceSnapshot(
	conflict: Awaited<ReturnType<typeof createConflict>>,
	relativePath: string,
	content: string,
	message: string,
): Promise<SyncConflictRequest> {
	await runGit(conflict.publisherPath, ["fetch", "origin"]);
	await runGit(conflict.publisherPath, [
		"switch",
		"-c",
		"advance-device-snapshot",
		`origin/${conflict.request.deviceBranch}`,
	]);
	await writeFile(join(conflict.publisherPath, "sync", relativePath), content);
	await runGit(conflict.publisherPath, ["add", "--all"]);
	await runGit(conflict.publisherPath, [
		"commit",
		"--no-gpg-sign",
		"-m",
		message,
	]);
	await runGit(conflict.publisherPath, [
		"push",
		"origin",
		`HEAD:${conflict.request.deviceBranch}`,
	]);
	await runGit(conflict.repoPath, ["fetch", "origin"]);
	return {
		...conflict.request,
		deviceHead: (
			await runGit(conflict.repoPath, [
				"rev-parse",
				`origin/${conflict.request.deviceBranch}`,
			])
		).stdout,
	};
}

describe.sequential("PiSyncCommands.resolveConflict", () => {
	it("uses current-device content only for conflicted paths and preserves the device branch", async () => {
		await withTestEnvironment(async (environment) => {
			const conflict = await createConflict(environment);

			const result = await conflict.commands.resolveConflict(
				conflict.request,
				"use_local",
			);

			expect(result.ok, result.message).toBe(true);
			expect(
				await readFile(
					join(conflict.repoPath, "sync/prompts/welcome.md"),
					"utf-8",
				),
			).toBe("local\n");
			expect(
				await runGit(conflict.remotePath, [
					"show",
					`refs/heads/${conflict.request.deviceBranch}:sync/prompts/welcome.md`,
				]),
			).toMatchObject({ stdout: "local" });
		});
	});

	it("uses shared-remote content for conflicted paths and applies it to the agent", async () => {
		await withTestEnvironment(async (environment) => {
			const conflict = await createConflict(environment);

			const result = await conflict.commands.resolveConflict(
				conflict.request,
				"use_remote",
			);

			expect(result.ok, result.message).toBe(true);
			expect(
				await readFile(
					join(conflict.repoPath, "sync/prompts/welcome.md"),
					"utf-8",
				),
			).toBe("remote\n");
			expect(
				await readFile(
					join(environment.agentDir, "prompts/welcome.md"),
					"utf-8",
				),
			).toBe("remote\n");
		});
	});

	it("rejects a stale choice after the shared branch advances", async () => {
		await withTestEnvironment(async (environment) => {
			const conflict = await createConflict(environment);
			await writeFile(
				join(conflict.publisherPath, "sync/prompts/other.md"),
				"new remote work\n",
			);
			await runGit(conflict.publisherPath, ["add", "--all"]);
			await runGit(conflict.publisherPath, [
				"commit",
				"--no-gpg-sign",
				"-m",
				"Advance shared branch",
			]);
			await runGit(conflict.publisherPath, ["push", "origin", "main"]);

			const result = await conflict.commands.resolveConflict(
				conflict.request,
				"use_local",
			);

			expect(result).toMatchObject({ ok: false, code: "blocked_conflict" });
			expect(result.details).toMatchObject({
				conflict: { kind: "sync_conflict" },
			});
		});
	});

	it("rejects a choice after the published device snapshot advances", async () => {
		await withTestEnvironment(async (environment) => {
			const conflict = await createConflict(environment);
			await runGit(conflict.publisherPath, ["fetch", "origin"]);
			await runGit(conflict.publisherPath, [
				"switch",
				"-c",
				"advance-device-snapshot",
				`origin/${conflict.request.deviceBranch}`,
			]);
			await writeFile(
				join(conflict.publisherPath, "sync/prompts/device-only.md"),
				"new device snapshot\n",
			);
			await runGit(conflict.publisherPath, ["add", "--all"]);
			await runGit(conflict.publisherPath, [
				"commit",
				"--no-gpg-sign",
				"-m",
				"Advance device snapshot",
			]);
			await runGit(conflict.publisherPath, [
				"push",
				"origin",
				`HEAD:${conflict.request.deviceBranch}`,
			]);

			const result = await conflict.commands.resolveConflict(
				conflict.request,
				"use_local",
			);

			expect(result).toMatchObject({ ok: false, code: "blocked_conflict" });
		});
	});

	it("fails closed without discarding a worktree change made during selection", async () => {
		await withTestEnvironment(async (environment) => {
			const conflict = await createConflict(environment);
			await writeFile(
				join(conflict.repoPath, "user-note.txt"),
				"do not discard\n",
			);

			const result = await conflict.commands.resolveConflict(
				conflict.request,
				"use_local",
			);

			expect(result).toMatchObject({ ok: false, code: "blocked_validation" });
			expect(
				await readFile(join(conflict.repoPath, "user-note.txt"), "utf-8"),
			).toBe("do not discard\n");
		});
	});

	it("aborts the merge and leaves the shared branch clean when validation fails", async () => {
		await withTestEnvironment(async (environment) => {
			const conflict = await createConflict(environment);

			const result = await resolveAutomaticConflict({
				repoPath: conflict.repoPath,
				request: conflict.request,
				choice: chooseAllPaths(conflict.request, "use_local"),
				beforeCommit: async () => ({
					code: "blocked_validation",
					message: "Synthetic validation failure",
				}),
			});

			expect(result).toMatchObject({
				kind: "blocked",
				code: "blocked_validation",
			});
			expect(
				await runGit(conflict.repoPath, ["status", "--porcelain"]),
			).toMatchObject({
				stdout: "",
			});
			expect(
				await runGit(conflict.repoPath, ["rev-parse", "HEAD"]),
			).toMatchObject({
				stdout: conflict.request.sharedHead,
			});
		});
	});

	it("safely reverts the local merge when the shared branch advances before push", async () => {
		await withTestEnvironment(async (environment) => {
			const conflict = await createConflict(environment);

			const result = await resolveAutomaticConflict({
				repoPath: conflict.repoPath,
				request: conflict.request,
				choice: chooseAllPaths(conflict.request, "use_local"),
				beforeCommit: async () => {
					await writeFile(
						join(conflict.publisherPath, "sync/prompts/race.md"),
						"new shared work\n",
					);
					await runGit(conflict.publisherPath, ["add", "--all"]);
					await runGit(conflict.publisherPath, [
						"commit",
						"--no-gpg-sign",
						"-m",
						"Advance shared during selection",
					]);
					await runGit(conflict.publisherPath, ["push", "origin", "main"]);
					return undefined;
				},
			});

			expect(result).toMatchObject({ kind: "stale" });
			expect(
				await runGit(conflict.repoPath, ["status", "--porcelain"]),
			).toMatchObject({
				stdout: "",
			});
			expect(
				await runGit(conflict.repoPath, ["rev-parse", "HEAD"]),
			).toMatchObject({
				stdout: await runGit(conflict.repoPath, [
					"rev-parse",
					"origin/main",
				]).then((result) => result.stdout),
			});
		});
	});

	it("requires package approval before committing a selected merge", async () => {
		await withTestEnvironment(async (environment) => {
			const conflict = await createConflict(environment);
			const request = await advanceDeviceSnapshot(
				conflict,
				"settings.json",
				'{"packages":["npm:@scope/needs-approval@1.0.0"]}\n',
				"Add package to device snapshot",
			);

			const result = await conflict.commands.resolveConflict(
				request,
				"use_local",
			);

			expect(result).toMatchObject({
				ok: false,
				code: "approval_required",
				details: {
					conflict: { kind: "sync_conflict" },
					packages: ["npm:@scope/needs-approval@1.0.0"],
				},
			});
			expect(
				await runGit(conflict.repoPath, ["status", "--porcelain"]),
			).toMatchObject({
				stdout: "",
			});
			expect(
				await runGit(conflict.repoPath, ["rev-parse", "HEAD"]),
			).toMatchObject({
				stdout: conflict.request.sharedHead,
			});
		});
	});

	it("aborts the merge before a selected snapshot with a secret can be committed", async () => {
		await withTestEnvironment(async (environment) => {
			const conflict = await createConflict(environment);
			const request = await advanceDeviceSnapshot(
				conflict,
				"prompts/secret.md",
				"sk-proj-abcdefghijklmnopqrstuvwxyz0123456789\n",
				"Add accidental secret to device snapshot",
			);

			const result = await conflict.commands.resolveConflict(
				request,
				"use_local",
			);

			expect(result).toMatchObject({ ok: false, code: "blocked_secret" });
			expect(
				await runGit(conflict.repoPath, ["status", "--porcelain"]),
			).toMatchObject({
				stdout: "",
			});
			expect(
				await runGit(conflict.repoPath, ["rev-parse", "HEAD"]),
			).toMatchObject({
				stdout: conflict.request.sharedHead,
			});
		});
	});

	it("keeps a local modification when the shared remote deleted that path", async () => {
		await withTestEnvironment(async (environment) => {
			const conflict = await createConflict(environment, null);

			const result = await conflict.commands.resolveConflict(
				conflict.request,
				"use_local",
			);

			expect(result.ok, result.message).toBe(true);
			expect(
				await readFile(
					join(environment.agentDir, "prompts/welcome.md"),
					"utf-8",
				),
			).toBe("local\n");
		});
	});

	it("applies a shared-remote deletion when that side is selected", async () => {
		await withTestEnvironment(async (environment) => {
			const conflict = await createConflict(environment, null);

			const result = await conflict.commands.resolveConflict(
				conflict.request,
				"use_remote",
			);

			expect(result.ok, result.message).toBe(true);
			await expect(
				readFile(join(environment.agentDir, "prompts/welcome.md"), "utf-8"),
			).rejects.toMatchObject({ code: "ENOENT" });
		});
	});
});
