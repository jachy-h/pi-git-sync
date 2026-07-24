import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { readFile, existsSync } from "node:fs";
import { exec as execCb } from "node:child_process";
import { promisify } from "node:util";
import {
  gitStatus,
  gitCommit,
  getHeadCommit,
  hasUncommittedChanges,
  canFastForward,
  gitDiff,
} from "../src/git.ts";

const execAsync = promisify(execCb);

async function initTestRepo(dir: string): Promise<void> {
  await execAsync("git init", { cwd: dir });
  await execAsync('git config user.email "test@test.com"', { cwd: dir });
  await execAsync('git config user.name "Test"', { cwd: dir });
  // Create initial commit immediately so rev-parse works
  await writeFile(join(dir, ".gitkeep"), "");
  await execAsync("git add -A && git commit -m initial", { cwd: dir });
}

describe("git", () => {
  let repoDir: string;

  beforeEach(async () => {
    repoDir = join(tmpdir(), `pi-git-sync-test-${randomBytes(4).toString("hex")}`);
    await mkdir(repoDir, { recursive: true });
    await initTestRepo(repoDir);
  });

  afterEach(async () => {
    await rm(repoDir, { recursive: true, force: true });
  });

  describe("gitStatus", () => {
    it("should return commit info for a repo with commits", async () => {
      const status = await gitStatus(repoDir);
      expect(status.commit).toBeTruthy();
      expect(status.commit).toHaveLength(40); // Full SHA
      expect(status.commitShort).toHaveLength(7);
    });

    it("should return no uncommitted changes for clean repo", async () => {
      const status = await gitStatus(repoDir);
      expect(status.hasUncommittedChanges).toBe(false);
    });

    it("should detect uncommitted changes", async () => {
      await writeFile(join(repoDir, "test.txt"), "hello");
      const status = await gitStatus(repoDir);
      expect(status.hasUncommittedChanges).toBe(true);
    });
  });

  describe("gitCommit", () => {
    it("should stage and commit changes", async () => {
      await writeFile(join(repoDir, "test.txt"), "hello");
      await gitCommit(repoDir, "add test.txt");

      // After commit, working tree should be clean
      expect(await hasUncommittedChanges(repoDir)).toBe(false);

      // File should exist
      expect(existsSync(join(repoDir, "test.txt"))).toBe(true);
    });
  });

  describe("hasUncommittedChanges", () => {
    it("should return false for clean repo", async () => {
      expect(await hasUncommittedChanges(repoDir)).toBe(false);
    });

    it("should return true for dirty repo", async () => {
      await writeFile(join(repoDir, "new-file.txt"), "content");
      expect(await hasUncommittedChanges(repoDir)).toBe(true);
    });
  });

  describe("getHeadCommit", () => {
    it("should return 40-char full SHA", async () => {
      const commit = await getHeadCommit(repoDir);
      expect(commit).toHaveLength(40);
      expect(commit).toMatch(/^[0-9a-f]{40}$/);
    });
  });

  describe("canFastForward", () => {
    it("should detect ancestor relationship", async () => {
      const commit1 = await getHeadCommit(repoDir);

      // Create second commit
      await writeFile(join(repoDir, "test2.txt"), "world");
      await gitCommit(repoDir, "second");

      const commit2 = await getHeadCommit(repoDir);

      // commit1 should be ancestor of commit2
      expect(await canFastForward(repoDir, commit1, commit2)).toBe(true);

      // commit2 is NOT ancestor of commit1
      expect(await canFastForward(repoDir, commit2, commit1)).toBe(false);
    });
  });

  describe("gitDiff", () => {
    it("should return empty diff for clean repo", async () => {
      const diff = await gitDiff(repoDir);
      expect(diff).toBe("");
    });

    it("should show diff for modified file", async () => {
      await writeFile(join(repoDir, "test.txt"), "hello");
      await gitCommit(repoDir, "add");

      await writeFile(join(repoDir, "test.txt"), "world");
      const diff = await gitDiff(repoDir);
      expect(diff).toContain("hello");
      expect(diff).toContain("world");
    });
  });
});
