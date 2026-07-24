/**
 * Git 操作封装：status, fetch, pull, push, log
 */
import { promisify } from "node:util";
import { exec as execCb } from "node:child_process";

const execAsync = promisify(execCb);

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
}

export interface GitDiff {
  path: string;
  status: "added" | "modified" | "deleted" | "renamed";
  oldPath?: string;
}

/**
 * 在指定仓库路径执行 git 命令
 */
export async function gitExec(
  repoPath: string,
  args: string[],
  options?: { timeout?: number },
): Promise<{ stdout: string; stderr: string }> {
  const command = `git ${args.join(" ")}`;
  try {
    const result = await execAsync(command, {
      cwd: repoPath,
      timeout: options?.timeout ?? 30000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
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

/**
 * 获取仓库状态
 */
export async function gitStatus(repoPath: string): Promise<GitStatus> {
  const [branchResult, statusResult, diffResult] = await Promise.all([
    gitExec(repoPath, ["rev-parse", "--abbrev-ref", "HEAD"]),
    gitExec(repoPath, ["rev-parse", "HEAD"]),
    gitExec(repoPath, ["status", "--porcelain"]),
  ]);

  const branch = branchResult.stdout.trim();
  const commit = statusResult.stdout.trim();
  const commitShort = commit.substring(0, 7);
  const hasUncommittedChanges = diffResult.stdout.trim().length > 0;

  const changedFiles = diffResult.stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => line.substring(3).trim());

  // Check remote
  let remoteExists = false;
  let ahead = 0;
  let behind = 0;

  try {
    const remoteResult = await gitExec(repoPath, ["remote", "get-url", "origin"]);
    remoteExists = remoteResult.stdout.trim().length > 0;

    if (remoteExists) {
      // Try to get ahead/behind counts
      const revListResult = await gitExec(repoPath, [
        "rev-list",
        "--left-right",
        "--count",
        `${branch}...origin/${branch}`,
      ]);

      const counts = revListResult.stdout.trim().split(/\s+/);
      if (counts.length === 2) {
        ahead = Number.parseInt(counts[0], 10) || 0;
        behind = Number.parseInt(counts[1], 10) || 0;
      }
    }
  } catch {
    // No remote configured or fetch hasn't been done yet
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
  };
}

/**
 * 获取完整 diff（用于展示）
 */
export async function gitDiff(repoPath: string): Promise<string> {
  // Staged + unstaged diff
  const result = await gitExec(repoPath, ["diff", "HEAD"]);
  return result.stdout;
}

/**
 * 获取两个 commit 之间的文件变化列表
 */
export async function gitDiffFiles(
  repoPath: string,
  from: string,
  to: string,
): Promise<GitDiff[]> {
  const result = await gitExec(repoPath, [
    "diff",
    "--name-status",
    from,
    to,
  ]);

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

/**
 * 获取仓库版本间的 diff
 */
export async function gitDiffRange(
  repoPath: string,
  from: string,
  to: string,
): Promise<string> {
  const result = await gitExec(repoPath, ["diff", from, to]);
  return result.stdout;
}

/**
 * Fetch 远端
 */
export async function gitFetch(repoPath: string): Promise<void> {
  const result = await gitExec(repoPath, ["fetch", "origin"]);
  if (result.stderr && !result.stderr.includes("->")) {
    throw new Error(`git fetch failed: ${result.stderr}`);
  }
}

/**
 * Pull (fast-forward only)
 */
export async function gitPull(repoPath: string, branch: string): Promise<{ pulled: boolean }> {
  const result = await gitExec(repoPath, [
    "pull",
    "--ff-only",
    "origin",
    branch,
  ]);

  const pulled = !result.stdout.includes("Already up to date") &&
    !result.stdout.includes("Already up-to-date");
  return { pulled };
}

/**
 * Push
 */
export async function gitPush(repoPath: string, branch: string): Promise<void> {
  const result = await gitExec(repoPath, ["push", "origin", branch]);
  if (result.stderr && !result.stderr.startsWith("To ") && !result.stderr.startsWith("Enumerating")) {
    if (result.stderr.includes("error:") || result.stderr.includes("fatal:")) {
      throw new Error(`git push failed: ${result.stderr}`);
    }
  }
}

/**
 * Pull with rebase
 */
export async function gitPullRebase(repoPath: string, branch: string): Promise<void> {
  const result = await gitExec(repoPath, [
    "pull",
    "--rebase",
    "origin",
    branch,
  ]);
  if (result.stderr && (result.stderr.includes("error:") || result.stderr.includes("fatal:") || result.stderr.includes("CONFLICT"))) {
    throw new Error(`git pull --rebase failed: ${result.stderr}`);
  }
}

/**
 * Stage 所有变更并提交
 */
export async function gitCommit(
  repoPath: string,
  message: string,
): Promise<void> {
  await gitExec(repoPath, ["add", "-A"]);
  const result = await gitExec(repoPath, ["commit", "-m", message]);
  if (result.stderr && result.stderr.includes("nothing to commit")) {
    // No changes is fine
  } else if (result.stderr && result.stderr.includes("fatal:")) {
    throw new Error(`git commit failed: ${result.stderr}`);
  }
}

/**
 * 检查仓库是否存在未提交变更
 */
export async function hasUncommittedChanges(repoPath: string): Promise<boolean> {
  const result = await gitExec(repoPath, ["status", "--porcelain"]);
  return result.stdout.trim().length > 0;
}

/**
 * 检查两个分支是否可以 fast-forward
 */
export async function canFastForward(
  repoPath: string,
  local: string,
  remote: string,
): Promise<boolean> {
  try {
    const { promisify } = await import("node:util");
    const { exec: execCb } = await import("node:child_process");
    const execAsync = promisify(execCb);
    await execAsync(
      `git merge-base --is-ancestor "${local}" "${remote}"`,
      { cwd: repoPath, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } },
    );
    // exit code 0 means local is ancestor of remote (can fast-forward)
    return true;
  } catch {
    return false;
  }
}

/**
 * 检查是否存在分叉（即本地和远端都有独立的提交）
 */
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
 * 获取当前 HEAD 的 commit hash
 */
export async function getHeadCommit(repoPath: string): Promise<string> {
  const result = await gitExec(repoPath, ["rev-parse", "HEAD"]);
  return result.stdout.trim();
}
