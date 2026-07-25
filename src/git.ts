/**
 * Git 操作封装
 *
 * 功能：
 * - status, fetch, pull (ff-only), push
 * - rebase, 冲突检测
 * - commit 前 diff 生成
 * - 受限操作保护（禁止 reset --hard, clean -fd, push --force）
 */
import { promisify } from "node:util";
import { execFile as execFileCb } from "node:child_process";

const execFileAsync = promisify(execFileCb);

// ========== 类型 ==========

export interface GitStatus {
  branch: string;
  commit: string;
  commitShort: string;
  ahead: number;
  behind: number;
  hasUncommittedChanges: boolean;
  hasUnpushedCommits: boolean;
  remoteExists: boolean;
  changedFiles: string[];
  /** 是否处于 merge/rebase/冲突状态 */
  isRebasing: boolean;
  isMerging: boolean;
  hasConflicts: boolean;
  /** 冲突文件列表 */
  conflictedFiles: string[];
}

export interface GitDiff {
  path: string;
  status: "added" | "modified" | "deleted" | "renamed";
  oldPath?: string;
}

// ========== 环境 ==========

const FAIL_PATTERN =
  /fatal:|error:|Permission denied|Could not read from remote|timed out|exceeded timeout|ETIMEDOUT|Connection (?:timed out|refused|reset)/i;

export function buildGitEnv(): Record<string, string | undefined> {
  const existing = process.env.GIT_SSH_COMMAND;
  const sshCmd = existing
    ? `${existing} -o StrictHostKeyChecking=accept-new`
    : "ssh -o StrictHostKeyChecking=accept-new";
  return {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_SSH_COMMAND: sshCmd,
  };
}

export function isGitFailure(stdout: string, stderr: string): boolean {
  return FAIL_PATTERN.test(`${stderr}\n${stdout}`);
}

// ========== git exec ==========

export async function gitExec(
  repoPath: string,
  args: string[],
  options?: { timeout?: number },
): Promise<{ stdout: string; stderr: string }> {
  try {
    const result = await execFileAsync("git", args, {
      cwd: repoPath,
      timeout: options?.timeout ?? 30000,
      env: buildGitEnv(),
      maxBuffer: 20 * 1024 * 1024,
    });
    return { stdout: result.stdout.trimEnd(), stderr: result.stderr.trimEnd() };
  } catch (err: unknown) {
    const error = err as { stdout?: string; stderr?: string; message?: string };
    return {
      stdout: error.stdout?.trimEnd() ?? "",
      stderr: error.stderr?.trimEnd() ?? error.message ?? "Unknown git error",
    };
  }
}

// ========== Status ==========

export async function gitStatus(repoPath: string): Promise<GitStatus> {
  const [branchResult, commitResult, statusResult, rebaseResult] = await Promise.all([
    gitExec(repoPath, ["rev-parse", "--abbrev-ref", "HEAD"]),
    gitExec(repoPath, ["rev-parse", "HEAD"]),
    gitExec(repoPath, ["status", "--porcelain"]),
    gitExec(repoPath, ["rev-parse", "--git-dir"]).then(async (r) => {
      const gitDir = r.stdout.trim();
      const { existsSync: es } = await import("node:fs");
      const { join: j } = await import("node:path");
      return {
        rebasing: es(j(repoPath, gitDir, "rebase-merge")) ||
                   es(j(repoPath, gitDir, "rebase-apply")),
        merging: es(j(repoPath, gitDir, "MERGE_HEAD")),
      };
    }).catch(() => ({ rebasing: false, merging: false })),
  ]);

  const branch = branchResult.stdout.trim();
  const commit = commitResult.stdout.trim();
  const commitShort = commit.substring(0, 7);
  const hasUncommittedChanges = statusResult.stdout.trim().length > 0;

  const changedFiles = statusResult.stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => line.substring(3).trim());

  // 冲突文件列表
  const conflictedFiles: string[] = [];
  for (const line of statusResult.stdout.split("\n").filter(Boolean)) {
    if (line.startsWith("UU ") || line.startsWith("AA ") || line.startsWith("DD ")) {
      conflictedFiles.push(line.substring(3).trim());
    }
  }

  const hasConflicts = conflictedFiles.length > 0;

  // 远端信息
  let remoteExists = false;
  let ahead = 0;
  let behind = 0;

  try {
    const remoteResult = await gitExec(repoPath, ["remote", "get-url", "origin"]);
    remoteExists = remoteResult.stdout.trim().length > 0;

    if (remoteExists) {
      const revListResult = await gitExec(repoPath, [
        "rev-list",
        "--left-right",
        "--count",
        `${branch}...origin/${branch}`,
      ]);

      const counts = revListResult.stdout.trim().split(/\s+/);
      if (counts.length === 2) {
        ahead = Number.parseInt(counts[0]!, 10) || 0;
        behind = Number.parseInt(counts[1]!, 10) || 0;
      }
    }
  } catch {
    remoteExists = false;
  }

  return {
    branch,
    commit,
    commitShort,
    ahead,
    behind,
    hasUncommittedChanges,
    hasUnpushedCommits: ahead > 0,
    remoteExists,
    changedFiles,
    isRebasing: rebaseResult.rebasing,
    isMerging: rebaseResult.merging,
    hasConflicts,
    conflictedFiles,
  };
}

// ========== Diff ==========

export async function gitDiff(repoPath: string): Promise<string> {
  const result = await gitExec(repoPath, ["diff", "HEAD"]);
  return result.stdout;
}

export async function gitDiffRange(
  repoPath: string,
  from: string,
  to: string,
): Promise<string> {
  const result = await gitExec(repoPath, ["diff", from, to]);
  return result.stdout;
}

export async function gitDiffNameOnly(
  repoPath: string,
  from: string,
  to: string,
): Promise<string[]> {
  const result = await gitExec(repoPath, ["diff", "--name-only", from, to]);
  return result.stdout.split("\n").filter(Boolean);
}

export async function gitDiffStaged(repoPath: string): Promise<string> {
  const result = await gitExec(repoPath, ["diff", "--cached"]);
  return result.stdout;
}

export async function gitDiffFiles(
  repoPath: string,
  from: string,
  to: string,
): Promise<GitDiff[]> {
  const result = await gitExec(repoPath, ["diff", "--name-status", from, to]);

  return result.stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const parts = line.split(/\t/);
      const statusCode = parts[0]!;
      const statusMap: Record<string, GitDiff["status"]> = {
        A: "added",
        M: "modified",
        D: "deleted",
        R: "renamed",
      };
      return {
        path: parts.length > 2 ? parts[2]! : parts[1]!,
        status: statusMap[statusCode[0]!] ?? "modified",
        oldPath: parts.length > 2 ? parts[1] : undefined,
      };
    });
}

// ========== Fetch / Pull / Push ==========

export async function gitFetch(repoPath: string): Promise<void> {
  const result = await gitExec(repoPath, ["fetch", "origin"]);
  if (result.stderr && FAIL_PATTERN.test(result.stderr)) {
    throw new Error(`git fetch failed: ${result.stderr}`);
  }
}

export async function gitPull(
  repoPath: string,
  branch: string,
): Promise<{ pulled: boolean }> {
  const result = await gitExec(repoPath, ["pull", "--ff-only", "origin", branch]);
  const pulled = !result.stdout.includes("Already up to date") &&
    !result.stdout.includes("Already up-to-date");
  return { pulled };
}

export async function gitPush(repoPath: string, branch: string): Promise<void> {
  const result = await gitExec(repoPath, ["push", "--set-upstream", "origin", branch]);
  const failed = /fatal:|error:|failed to push some refs|\[rejected\]|remote rejected/i.test(result.stderr);
  if (failed) {
    throw new Error(`git push failed: ${result.stderr || result.stdout}`);
  }
}

export async function gitRenameBranch(repoPath: string, branch: string): Promise<void> {
  const result = await gitExec(repoPath, ["branch", "-M", branch]);
  if (/fatal:|error:/i.test(result.stderr)) {
    throw new Error(`git branch rename failed: ${result.stderr || result.stdout}`);
  }
}

// ========== Rebase ==========

/**
 * 对 origin/<branch> 执行 rebase
 * @returns 是否发生冲突
 */
export async function gitRebase(
  repoPath: string,
  branch: string,
): Promise<{ rebased: boolean; conflict: boolean }> {
  const result = await gitExec(repoPath, ["rebase", `origin/${branch}`]);

  const combined = `${result.stderr}\n${result.stdout}`;

  if (/CONFLICT/i.test(combined)) {
    return { rebased: false, conflict: true };
  }

  if (/fatal:|error:/i.test(result.stderr)) {
    throw new Error(`git rebase failed: ${result.stderr}`);
  }

  const rebased = !combined.includes("Current branch") ||
    !combined.includes("is up to date");

  return { rebased, conflict: false };
}

/**
 * 继续 rebase（用户解决冲突后）
 */
export async function gitRebaseContinue(repoPath: string): Promise<void> {
  const result = await gitExec(repoPath, ["rebase", "--continue"]);
  if (/fatal:|error:/i.test(result.stderr)) {
    throw new Error(`git rebase --continue failed: ${result.stderr}`);
  }
}

/**
 * 中止 rebase
 */
export async function gitRebaseAbort(repoPath: string): Promise<void> {
  await gitExec(repoPath, ["rebase", "--abort"]);
}

// ========== Commit ==========

export async function gitCommit(
  repoPath: string,
  message: string,
): Promise<void> {
  const before = await getHeadCommit(repoPath).catch(() => "");
  await gitExec(repoPath, ["add", "-A"]);
  const result = await gitExec(repoPath, ["commit", "-m", message]);

  const combined = `${result.stderr}\n${result.stdout}`;
  if (/nothing to commit|no changes added to commit/i.test(combined)) {
    return;
  }

  const after = await getHeadCommit(repoPath).catch(() => "");
  if (after === "" || after === before) {
    throw new Error(
      `git commit failed: ${result.stderr || result.stdout || "no commit was created"}`,
    );
  }
}

// ========== 查询 ==========

export async function getHeadCommit(repoPath: string): Promise<string> {
  const result = await gitExec(repoPath, ["rev-parse", "HEAD"]);
  return result.stdout.trim();
}

export async function hasUncommittedChanges(repoPath: string): Promise<boolean> {
  const result = await gitExec(repoPath, ["status", "--porcelain"]);
  return result.stdout.trim().length > 0;
}

export async function canFastForward(
  repoPath: string,
  local: string,
  remote: string,
): Promise<boolean> {
  try {
    await execFileAsync("git", ["merge-base", "--is-ancestor", local, remote], {
      cwd: repoPath,
      env: buildGitEnv(),
    });
    return true;
  } catch {
    return false;
  }
}

export async function isDiverged(
  repoPath: string,
  local: string,
  remote: string,
): Promise<boolean> {
  const [localIsAncestor, remoteIsAncestor] = await Promise.all([
    canFastForward(repoPath, local, remote),
    canFastForward(repoPath, remote, local),
  ]);
  return !localIsAncestor && !remoteIsAncestor;
}

/**
 * 检查是否有未合并的文件
 */
export async function hasUnmergedPaths(repoPath: string): Promise<boolean> {
  const result = await gitExec(repoPath, ["ls-files", "--unmerged"]);
  return result.stdout.trim().length > 0;
}

/**
 * 检查工作树是否干净（无 staged 或 unstaged 变更）
 */
export async function isWorktreeClean(repoPath: string): Promise<boolean> {
  return !(await hasUncommittedChanges(repoPath));
}

/**
 * 获取当前操作状态（rebase/merge 等）
 */
export async function getGitOperationState(repoPath: string): Promise<{
  isRebasing: boolean;
  isMerging: boolean;
  hasConflicts: boolean;
}> {
  const { existsSync: es } = await import("node:fs");
  const { join: j } = await import("node:path");
  const gitDirResult = await gitExec(repoPath, ["rev-parse", "--git-dir"]).catch(() => ({ stdout: ".git" }));
  const gitDir = gitDirResult.stdout.trim();

  return {
    isRebasing: es(j(repoPath, gitDir, "rebase-merge")) ||
                es(j(repoPath, gitDir, "rebase-apply")),
    isMerging: es(j(repoPath, gitDir, "MERGE_HEAD")),
    hasConflicts: await hasUnmergedPaths(repoPath),
  };
}

// ========== Push 流程步骤 ==========

/**
 * Lightweight check for whether origin is reachable and the current branch
 * exists on the remote.  Used in push to detect "no upstream" early.
 */
export async function gitRemoteRefExists(
  repoPath: string,
  branch: string,
): Promise<boolean> {
  const result = await gitExec(repoPath, ["ls-remote", "--heads", "origin", branch]);
  return result.stdout.trim().length > 0;
}
