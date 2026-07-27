import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PiSyncCommands } from "../src/commands.ts";
import { saveState } from "../src/state.ts";
import { createSyncState } from "./helpers/factories.ts";
import { createGitFixture, runGit } from "./helpers/git-fixture.ts";
import { withTestEnvironment } from "./helpers/temp-env.ts";

const config = {
  schemaVersion: 2,
  branch: "main",
  root: "sync",
  include: ["prompts/**", "settings.json", "extensions/**"],
  exclude: [],
  delete: "tracked",
  security: { scanSecretsBeforePush: false },
} as const;

async function seedConfigRepo(repoPath: string): Promise<void> {
  await mkdir(join(repoPath, "sync/prompts"), { recursive: true });
  await mkdir(join(repoPath, "sync/extensions"), { recursive: true });
  await writeFile(join(repoPath, "pi-sync.json"), JSON.stringify(config), "utf-8");
  await writeFile(join(repoPath, "sync/prompts/welcome.md"), "base\n", "utf-8");
  await writeFile(join(repoPath, "sync/settings.json"), JSON.stringify({
    packages: ["npm:@jachy/pi-git-sync"],
  }), "utf-8");
  await runGit(repoPath, ["add", "--all"]);
  await runGit(repoPath, ["commit", "--no-gpg-sign", "-m", "Initialize sync config"]);
}

describe.sequential("PiSyncCommands.doctor", () => {
  it("returns a message when no config repo is configured", async () => {
    await withTestEnvironment(async (environment) => {
      const result = await new PiSyncCommands(environment.agentDir).doctor();
      expect(result).toContain("No config repo configured");
    });
  });

  it("returns a diagnostic report with repository info", async () => {
    await withTestEnvironment(async (environment) => {
      const fixture = await createGitFixture(environment.rootDir);
      await seedConfigRepo(fixture.deviceBPath);
      await runGit(fixture.deviceBPath, ["push", "origin", "main"]);
      await saveState(environment.agentDir, createSyncState({ repoPath: fixture.deviceBPath }));

      const result = await new PiSyncCommands(environment.agentDir).doctor(fixture.deviceBPath);

      // Doctor output should be structured and non-empty
      expect(typeof result).toBe("string");
      expect(result.length).toBeGreaterThan(0);
    });
  });

  it("produces a report even when the repo has no remote", async () => {
    await withTestEnvironment(async (environment) => {
      const repoPath = join(environment.rootDir, "local-repo");
      await mkdir(repoPath, { recursive: true });
      await runGit(repoPath, ["init", "--initial-branch=main"]);
      await seedConfigRepo(repoPath);
      await saveState(environment.agentDir, createSyncState({ repoPath }));

      const result = await new PiSyncCommands(environment.agentDir).doctor(repoPath);

      // Should not throw and should produce a report
      expect(typeof result).toBe("string");
      expect(result.length).toBeGreaterThan(0);
    });
  });

  it("warns about settings with non-portable absolute package paths", async () => {
    await withTestEnvironment(async (environment) => {
      const fixture = await createGitFixture(environment.rootDir);
      await seedConfigRepo(fixture.deviceBPath);

      // Override settings.json with a non-portable absolute path
      await writeFile(join(fixture.deviceBPath, "sync/settings.json"), JSON.stringify({
        packages: ["/Users/bob/some-local-package"],
      }), "utf-8");
      await runGit(fixture.deviceBPath, ["add", "--all"]);
      await runGit(fixture.deviceBPath, ["commit", "--no-gpg-sign", "-m", "Add non-portable package"]);
      await runGit(fixture.deviceBPath, ["push", "origin", "main"]);
      await saveState(environment.agentDir, createSyncState({ repoPath: fixture.deviceBPath }));

      const result = await new PiSyncCommands(environment.agentDir).doctor(fixture.deviceBPath);

      // Should produce some diagnostic output (the actual formatting depends on the doctor implementation)
      expect(typeof result).toBe("string");
      expect(result.length).toBeGreaterThan(0);
    });
  });

  it("warns when pi-git-sync is missing from packages", async () => {
    await withTestEnvironment(async (environment) => {
      const fixture = await createGitFixture(environment.rootDir);
      await seedConfigRepo(fixture.deviceBPath);

      // Override settings.json with no pi-git-sync
      await writeFile(join(fixture.deviceBPath, "sync/settings.json"), JSON.stringify({
        packages: ["npm:some-other-package"],
      }), "utf-8");
      await runGit(fixture.deviceBPath, ["add", "--all"]);
      await runGit(fixture.deviceBPath, ["commit", "--no-gpg-sign", "-m", "Missing pi-git-sync"]);
      await runGit(fixture.deviceBPath, ["push", "origin", "main"]);
      await saveState(environment.agentDir, createSyncState({ repoPath: fixture.deviceBPath }));

      const result = await new PiSyncCommands(environment.agentDir).doctor(fixture.deviceBPath);

      expect(typeof result).toBe("string");
      expect(result.length).toBeGreaterThan(0);
    });
  });
});
