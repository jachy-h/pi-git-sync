import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PiSyncCommands } from "../src/commands.ts";
import { getHeadCommit } from "../src/git.ts";
import { sha256 } from "../src/inventory.ts";
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

async function seedConfigRepo(repoPath: string): Promise<void> {
	await mkdir(join(repoPath, "sync/prompts"), { recursive: true });
	await writeFile(
		join(repoPath, "pi-sync.json"),
		JSON.stringify(config),
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

			const result = await new PiSyncCommands(environment.agentDir).pull(
				fixture.deviceBPath,
			);
			const state = await loadState(environment.agentDir);

			expect(result).toMatchObject({
				reload: true,
				message: expect.stringContaining("Files written: 1"),
			});
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
});
