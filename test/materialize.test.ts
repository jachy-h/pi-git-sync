import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { materializeFiles, atomicWrite, backupFile, diffFiles } from "../src/materialize.ts";

describe("atomicWrite", () => {
  let targetDir: string;

  beforeEach(async () => {
    targetDir = join(tmpdir(), `pi-sync-atomic-${randomBytes(4).toString("hex")}`);
    await mkdir(targetDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(targetDir, { recursive: true, force: true });
  });

  it("should write a file", async () => {
    const path = join(targetDir, "test.txt");
    await atomicWrite(path, "hello world");

    expect(existsSync(path)).toBe(true);
    const content = await readFile(path, "utf-8");
    expect(content).toBe("hello world");
  });

  it("should overwrite existing file", async () => {
    const path = join(targetDir, "test.txt");
    await writeFile(path, "old content");
    await atomicWrite(path, "new content");

    const content = await readFile(path, "utf-8");
    expect(content).toBe("new content");
  });

  it("should create parent directories", async () => {
    const path = join(targetDir, "sub", "dir", "test.txt");
    await atomicWrite(path, "hello");

    expect(existsSync(path)).toBe(true);
  });
});

describe("materializeFiles", () => {
  let repoPath: string;
  let agentDir: string;
  let backupDir: string;

  beforeEach(async () => {
    const base = tmpdir();
    repoPath = join(base, `pi-sync-repo-${randomBytes(4).toString("hex")}`);
    agentDir = join(base, `pi-sync-agent-${randomBytes(4).toString("hex")}`);
    backupDir = join(base, `pi-sync-backup-${randomBytes(4).toString("hex")}`);

    await mkdir(repoPath, { recursive: true });
    await mkdir(agentDir, { recursive: true });
    await mkdir(backupDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(repoPath, { recursive: true, force: true });
    await rm(agentDir, { recursive: true, force: true });
    await rm(backupDir, { recursive: true, force: true });
  });

  it("should apply files from repo to agent dir", async () => {
    // Create source file
    const filesDir = join(repoPath, "files");
    await mkdir(filesDir, { recursive: true });
    await writeFile(join(filesDir, "AGENTS.md"), "# AGENTS");

    const result = await materializeFiles(
      repoPath,
      agentDir,
      [{ source: "files/AGENTS.md", target: "AGENTS.md" }],
      backupDir,
    );

    expect(result.applied).toEqual(["AGENTS.md"]);
    expect(existsSync(join(agentDir, "AGENTS.md"))).toBe(true);
    const content = await readFile(join(agentDir, "AGENTS.md"), "utf-8");
    expect(content).toBe("# AGENTS");
  });

  it("should skip optional files when source not found", async () => {
    const result = await materializeFiles(
      repoPath,
      agentDir,
      [
        { source: "files/SYSTEM.md", target: "SYSTEM.md", optional: true },
      ],
      backupDir,
    );

    expect(result.skipped).toEqual(["SYSTEM.md"]);
    expect(result.failed).toHaveLength(0);
  });

  it("should fail on non-optional missing source", async () => {
    const result = await materializeFiles(
      repoPath,
      agentDir,
      [{ source: "files/missing.md", target: "missing.md" }],
      backupDir,
    );

    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]!.file).toBe("missing.md");
  });
});

describe("backupFile", () => {
  let backupDir: string;

  beforeEach(async () => {
    backupDir = join(tmpdir(), `pi-sync-backup-${randomBytes(4).toString("hex")}`);
    await mkdir(backupDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(backupDir, { recursive: true, force: true });
  });

  it("should create a backup copy", async () => {
    const sourceDir = join(tmpdir(), `pi-sync-backup-src-${randomBytes(4).toString("hex")}`);
    await mkdir(sourceDir, { recursive: true });
    const sourcePath = join(sourceDir, "test.txt");
    await writeFile(sourcePath, "backup me");

    const backupPath = await backupFile(sourcePath, backupDir);
    expect(existsSync(backupPath)).toBe(true);

    const content = await readFile(backupPath, "utf-8");
    expect(content).toBe("backup me");

    await rm(sourceDir, { recursive: true, force: true });
  });
});
