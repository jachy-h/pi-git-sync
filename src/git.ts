/**
 * Git 操作封装：status, fetch, pull, push, log
 */
import { promisify } from "node:util";
import { execFile as execFileCb } from "node:child_process";

const execFileAsync = promisify(execFileCb);

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

const FAIL_PATTERN = /fatal:|error:|Permission denied|Could not read from remote|timed out|exceeded timeout|ETIMEDOUT|Connection (?:timed out|refused|reset)/i;

/**
 * 构建所有 git 子进程共用的环境变量。
 *
 * - GIT_TERMINAL_PROMPT=0：禁止 git 自己的交互式凭据提示（Pi 没有可供输入的tty）。
 * - GIT_SSH_COMMAND 追加 StrictHostKeyChecking=accept-new：首次连接新主机时自动接受
 *   并写入 known_hosts，而不是卡在（在非交互环境下无法回答的）
 *   "Are you sure you want to continue connecting (yes/no)?" 提示上。
 *   这是 "终端里能 clone、在 Pi 里第一次 init 就失败" 最常见的根因。
 *   若用户已自定义 GIT_SSH_COMMAND，则追加选项而非覆盖。
 */
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

/** 判断 git 子进程的输出是否表示真正的失败 */
export function isGitFailure(
  stdout: string,
  stderr: string,
): boolean {
  return FAIL_PATTERN.test(`${stderr}\n${stdout}`);
}

/**
 * 在指定仓库路径执行 git 命令
 */
export async function gitExec(
  repoPath: string,
  args: string[],
  options?: { timeout?: number },
): Promise<{ stdout: string; stderr: string }> {
  // NOTE: we deliberately use execFile (argv array) instead of building a shell
  // string.  Arguments such as commit messages contain spaces and other shell
  // metacharacters; concatenating them into a single shell command would make
  // `git commit -m some message` parse `message` (and everything after it) as
  // pathspecs, silently producing no commit.  Passing an argv array hands each
  // argument to git verbatim with no shell interpolation.
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
  // Set the upstream on the first push as well, so subsequent status/push calls
  // can reliably compare against origin/<branch>.
  const result = await gitExec(repoPath, ["push", "--set-upstream", "origin", branch]);
  const failed = /fatal:|error:|failed to push some refs|\[rejected\]|remote rejected/i.test(result.stderr);
  if (failed) {
    throw new Error(`git push failed: ${result.stderr || result.stdout}`);
  }
}

/** Rename the current branch, failing instead of silently continuing on an error. */
export async function gitRenameBranch(repoPath: string, branch: string): Promise<void> {
  const result = await gitExec(repoPath, ["branch", "-M", branch]);
  if (/fatal:|error:/i.test(result.stderr)) {
    throw new Error(`git branch rename failed: ${result.stderr || result.stdout}`);
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
 *
 * 关键点：不能只靠 stderr 里是否出现 "fatal:" 来判断失败 —— git 在很多失败
 * 场景（例如 pathspec 不匹配）只打印 "error:"，且 gitExec 又会把非零退出码
 * 吞掉转为返回值。这会导致 `git commit -m <multi-word message>` 在旧实现
 * 下因为消息被 shell 拆分而静默不提交，调用方却毫无感知。
 *
 * 这里改为：先记录提交前的 HEAD，提交后再次读取，若既不是 "nothing to
 * commit" 又没有产生新的 commit，则视为真正的失败并抛出，把问题暴露出来。
 */
export async function gitCommit(
  repoPath: string,
  message: string,
): Promise<void> {
  const before = await getHeadCommit(repoPath).catch(() => "");
  await gitExec(repoPath, ["add", "-A"]);
  const result = await gitExec(repoPath, ["commit", "-m", message]);

  const combined = `${result.stderr}\n${result.stdout}`;
  if (/nothing to commit|no changes added to commit/i.test(combined)) {
    // 没有可提交的变更 —— 正常情况
    return;
  }

  const after = await getHeadCommit(repoPath).catch(() => "");
  if (after === "" || after === before) {
    // 既不是 "无变更"，也没有产生新的提交 —— 提交真的失败了。
    throw new Error(
      `git commit failed: ${result.stderr || result.stdout || "no commit was created"}`,
    );
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
    // merge-base --is-ancestor: exit 0 => local is ancestor of remote
    await execFileAsync(
      "git",
      ["merge-base", "--is-ancestor", local, remote],
      { cwd: repoPath, env: buildGitEnv() },
    );
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
