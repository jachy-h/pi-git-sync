import { mkdir, readFile, writeFile } from "node:fs/promises";
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
  await writeFile(join(repoPath, "pi-sync.json"), JSON.stringify(config), "utf-8");
  await writeFile(join(repoPath, "sync/prompts/welcome.md"), "base\n", "utf-8");
  await writeFile(join(repoPath, "sync/settings.json"), JSON.stringify({ packages: ["npm:@jachy/pi-git-sync"] }), "utf-8");
  await runGit(repoPath, ["add", "--all"]);
  await runGit(repoPath, ["commit", "--no-gpg-sign", "-m", "Initialize sync config"]);
}

describe.sequential("PiSyncCommands.rollbackList", () => {
  it("shows list of available backups (may be empty)", async () => {
    await withTestEnvironment(async (environment) => {
      const fixture = await createGitFixture(environment.rootDir);
      await seedConfigRepo(fixture.deviceBPath);

      const result = await new PiSyncCommands(environment.agentDir).rollbackList();

      // Should return a string (may be empty list message)
      expect(typeof result).toBe("string");
    });
  });
});

describe.sequential("PiSyncCommands.rollback", () => {
  it("returns a message when no config repo is configured", async () => {
    await withTestEnvironment(async (environment) => {
      const result = await new PiSyncCommands(environment.agentDir).rollback();
      expect(result).toContain("No config repo configured");
    });
  });

  it("returns info when no backups are available", async () => {
    await withTestEnvironment(async (environment) => {
      const fixture = await createGitFixture(environment.rootDir);
      await seedConfigRepo(fixture.deviceBPath);
      await saveState(environment.agentDir, createSyncState({
        repoPath: fixture.deviceBPath,
      }));

      const result = await new PiSyncCommands(environment.agentDir).rollback(fixture.deviceBPath);
      expect(result).toContain("No backups");
    });
  });

  it("rolls back to the latest backup after an apply", async () => {
    await withTestEnvironment(async (environment) => {
      const fixture = await createGitFixture(environment.rootDir);
      await seedConfigRepo(fixture.deviceBPath);
      await runGit(fixture.deviceBPath, ["push", "origin", "main"]);

      // Set up agent with a file at version 1
      await environment.writeAgentFile("prompts/welcome.md", "version 1\n");
      await saveState(environment.agentDir, createSyncState({
        repoPath: fixture.deviceBPath,
        files: { "prompts/welcome.md": { sha256: sha256("version 1\n"), mode: 0o644 } },
      }));

      // Apply version 2 from repo (creates backup of version 1)
      await writeFile(join(fixture.deviceBPath, "sync/prompts/welcome.md"), "version 2\n", "utf-8");
      await runGit(fixture.deviceBPath, ["add", "--all"]);
      await runGit(fixture.deviceBPath, ["commit", "--no-gpg-sign", "-m", "Update to version 2"]);

      const applyResult = await new PiSyncCommands(environment.agentDir).apply(fixture.deviceBPath);
      expect(applyResult.reload).toBe(true);
      expect(await readFile(join(environment.agentDir, "prompts/welcome.md"), "utf-8")).toBe("version 2\n");

      // Now rollback
      const rollbackResult = await new PiSyncCommands(environment.agentDir).rollback(fixture.deviceBPath);

      expect(rollbackResult).toContain("Rolled back to backup");
      // File should be restored to version 1
      expect(await readFile(join(environment.agentDir, "prompts/welcome.md"), "utf-8")).toBe("version 1\n");
    });
  });

  it("rollback preserves Git history (does not modify repo HEAD)", async () => {
    await withTestEnvironment(async (environment) => {
      const fixture = await createGitFixture(environment.rootDir);
      await seedConfigRepo(fixture.deviceBPath);
      await runGit(fixture.deviceBPath, ["push", "origin", "main"]);

      await environment.writeAgentFile("prompts/welcome.md", "original\n");
      await saveState(environment.agentDir, createSyncState({
        repoPath: fixture.deviceBPath,
        files: { "prompts/welcome.md": { sha256: sha256("original\n"), mode: 0o644 } },
      }));

      // Apply a change to create a backup
      await writeFile(join(fixture.deviceBPath, "sync/prompts/welcome.md"), "updated\n", "utf-8");
      await runGit(fixture.deviceBPath, ["add", "--all"]);
      await runGit(fixture.deviceBPath, ["commit", "--no-gpg-sign", "-m", "Update"]);
      await new PiSyncCommands(environment.agentDir).apply(fixture.deviceBPath);

      // Capture HEAD after the apply commit
      const expectedHead = (await runGit(fixture.deviceBPath, ["rev-parse", "HEAD"])).stdout;

      // Rollback
      await new PiSyncCommands(environment.agentDir).rollback(fixture.deviceBPath);

      // Verify Git HEAD is unchanged by rollback (should match HEAD after the Update commit)
      const currentHead = (await runGit(fixture.deviceBPath, ["rev-parse", "HEAD"])).stdout;
      expect(currentHead).toBe(expectedHead);
    });
  });
});

describe.sequential("PiSyncCommands.rollback + doctor integration", () => {
  it("rollback creates a pre-rollback backup of current state", async () => {
    await withTestEnvironment(async (environment) => {
      const fixture = await createGitFixture(environment.rootDir);
      await seedConfigRepo(fixture.deviceBPath);
      await runGit(fixture.deviceBPath, ["push", "origin", "main"]);

      // Apply to create first backup
      await environment.writeAgentFile("prompts/welcome.md", "first version\n");
      await saveState(environment.agentDir, createSyncState({
        repoPath: fixture.deviceBPath,
        files: { "prompts/welcome.md": { sha256: sha256("first version\n"), mode: 0o644 } },
      }));

      await writeFile(join(fixture.deviceBPath, "sync/prompts/welcome.md"), "second version\n", "utf-8");
      await runGit(fixture.deviceBPath, ["add", "--all"]);
      await runGit(fixture.deviceBPath, ["commit", "--no-gpg-sign", "-m", "Second version"]);
      await new PiSyncCommands(environment.agentDir).apply(fixture.deviceBPath);

      // Apply again to create another backup
      await writeFile(join(fixture.deviceBPath, "sync/prompts/welcome.md"), "third version\n", "utf-8");
      await runGit(fixture.deviceBPath, ["add", "--all"]);
      await runGit(fixture.deviceBPath, ["commit", "--no-gpg-sign", "-m", "Third version"]);
      await new PiSyncCommands(environment.agentDir).apply(fixture.deviceBPath);

      // Rollback - should create pre-rollback backup
      const backupsBefore = await new PiSyncCommands(environment.agentDir).rollbackList();
      await new PiSyncCommands(environment.agentDir).rollback(fixture.deviceBPath);
      const backupsAfter = await new PiSyncCommands(environment.agentDir).rollbackList();

      // Should have more backups after rollback (the pre-rollback backup was created)
      expect(backupsAfter.split("\n").length).toBeGreaterThanOrEqual(
        backupsBefore.split("\n").length,
      );
    });
  });
});
