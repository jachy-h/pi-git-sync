import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PiSyncCommands } from "../src/commands.ts";
import { gitStatus } from "../src/git.ts";
import { loadState, saveState } from "../src/state.ts";
import { createSyncState } from "./helpers/factories.ts";
import { createGitFixture, runGit } from "./helpers/git-fixture.ts";
import { withTestEnvironment } from "./helpers/temp-env.ts";

const customConfig = {
  schemaVersion: 2,
  branch: "sync-config",
  root: "sync",
  include: ["prompts/**"],
  exclude: [],
  delete: "tracked",
  security: { scanSecretsBeforePush: false },
} as const;

async function seedCustomBranch(fixture: {
  deviceAPath: string;
  deviceBPath: string;
}): Promise<void> {
  await runGit(fixture.deviceAPath, ["switch", "-c", "sync-config"]);
  await mkdir(join(fixture.deviceAPath, "sync/prompts"), { recursive: true });
  await writeFile(join(fixture.deviceAPath, "pi-sync.json"), JSON.stringify(customConfig), "utf-8");
  await writeFile(join(fixture.deviceAPath, "sync/prompts/custom.md"), "custom branch\n", "utf-8");
  await runGit(fixture.deviceAPath, ["add", "."]);
  await runGit(fixture.deviceAPath, ["commit", "-m", "Create custom sync branch"]);
  await runGit(fixture.deviceAPath, ["push", "--set-upstream", "origin", "sync-config"]);

  // Keep the config visible on the clone's current main branch. The pull
  // command must then fetch and switch to the configured branch explicitly.
  await runGit(fixture.deviceAPath, ["switch", "main"]);
  await writeFile(join(fixture.deviceAPath, "pi-sync.json"), JSON.stringify(customConfig), "utf-8");
  await runGit(fixture.deviceAPath, ["add", "pi-sync.json"]);
  await runGit(fixture.deviceAPath, ["commit", "-m", "Declare custom sync branch"]);
  await runGit(fixture.deviceAPath, ["push", "origin", "main"]);
  await runGit(fixture.deviceBPath, ["pull", "--ff-only"]);
}

describe.sequential("config.branch semantics", () => {
  it("pulls and materializes from a configured non-main branch", async () => {
    await withTestEnvironment(async (environment) => {
      const fixture = await createGitFixture(environment.rootDir);
      await seedCustomBranch(fixture);
      await saveState(environment.agentDir, createSyncState({ repoPath: fixture.deviceBPath }));

      const result = await new PiSyncCommands(environment.agentDir).pull(fixture.deviceBPath);

      expect(result).toMatchObject({ ok: true, reload: true });
      expect(await readFile(join(environment.agentDir, "prompts/custom.md"), "utf-8")).toBe("custom branch\n");
      expect((await gitStatus(fixture.deviceBPath)).branch).toBe("sync-config");
      expect((await loadState(environment.agentDir)).branch).toBe("sync-config");
    });
  });

  it("does not switch a dirty repository away from its current branch", async () => {
    await withTestEnvironment(async (environment) => {
      const fixture = await createGitFixture(environment.rootDir);
      await seedCustomBranch(fixture);
      await writeFile(join(fixture.deviceBPath, ".gitkeep"), "dirty\n", "utf-8");
      await saveState(environment.agentDir, createSyncState({ repoPath: fixture.deviceBPath }));

      const result = await new PiSyncCommands(environment.agentDir).pull(fixture.deviceBPath);

      expect(result).toMatchObject({ ok: false, code: "blocked_conflict", reload: false });
      expect(result.message).toContain("local changes");
      expect((await gitStatus(fixture.deviceBPath)).branch).toBe("main");
    });
  });
});
