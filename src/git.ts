/**
 * Git 操作封装
 *
 * 功能：
 * - status, fetch, pull (ff-only), push
 * - rebase, 冲突检测
 * - commit 前 diff 生成
 * - 受限操作保护（禁止 reset --hard, clean -fd, push --force）
 *
 * v0.2: 严格错误模型
 * - gitExec 非零退出时 throw GitCommandError
 * - gitProbe 用于预期可能失败的探测（如 ls-remote、remote get-url）
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

export interface GitCommandOutput {
	stdout: string;
	stderr: string;
}

export interface GitProbeOutput extends GitCommandOutput {
	ok: boolean;
}

// ========== GitCommandError ==========

export class GitCommandError extends Error {
	args: string[];
	cwd: string;
	exitCode: number | null;
	stdout: string;
	stderr: string;
	timedOut: boolean;

	constructor(
		args: string[],
		cwd: string,
		exitCode: number | null,
		stdout: string,
		stderr: string,
		timedOut: boolean,
	) {
		const detail = stderr || stdout || `exit code ${exitCode}`;
		super(`git ${args[0]} failed: ${detail}`);
		this.name = "GitCommandError";
		this.args = args;
		this.cwd = cwd;
		this.exitCode = exitCode;
		this.stdout = stdout;
		this.stderr = stderr;
		this.timedOut = timedOut;
	}

	/** 是否为认证失败 */
	isAuthFailure(): boolean {
		return /Permission denied|Authentication failed|fatal: could not read from remote/i.test(
			`${this.stderr}\n${this.stdout}`,
		);
	}

	/** 是否为远端不存在 */
	isRemoteMissing(): boolean {
		return /fatal:.*remote.*not found|fatal:.*does not appear to be a git repository|fatal:.*could not read from remote/i.test(
			`${this.stderr}\n${this.stdout}`,
		);
	}

	/** 是否为分支不存在 */
	isBranchMissing(): boolean {
		return /fatal:.*branch.*not found|fatal:.*couldn't find remote ref/i.test(
			`${this.stderr}\n${this.stdout}`,
		);
	}

	/** 是否为超时 */
	isTimeout(): boolean {
		return this.timedOut;
	}
}

// ========== 环境 ==========

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

/** @deprecated 保留用于兼容；v0.2 中 gitExec 改为 throw，不再需要此 helper */
export function isGitFailure(stdout: string, stderr: string): boolean {
	const FAIL_PATTERN =
		/fatal:|error:|Permission denied|Could not read from remote|timed out|exceeded timeout|ETIMEDOUT|Connection (?:timed out|refused|reset)/i;
	return FAIL_PATTERN.test(`${stderr}\n${stdout}`);
}

// ========== gitExec（严格：非零退出时 throw） ==========

export async function gitExec(
	repoPath: string,
	args: string[],
	options?: { timeout?: number },
): Promise<GitCommandOutput> {
	try {
		const result = await execFileAsync("git", args, {
			cwd: repoPath,
			timeout: options?.timeout ?? 30000,
			env: buildGitEnv(),
			maxBuffer: 20 * 1024 * 1024,
		});
		return { stdout: result.stdout.trimEnd(), stderr: result.stderr.trimEnd() };
	} catch (err: unknown) {
		const error = err as {
			stdout?: string;
			stderr?: string;
			message?: string;
			code?: string;
			killed?: boolean;
		};
		const timedOut = error.killed === true || error.code === "ETIMEDOUT";
		throw new GitCommandError(
			args,
			repoPath,
			typeof error.code === "number"
				? error.code
				: error.code !== undefined
					? null
					: null,
			error.stdout?.trimEnd() ?? "",
			error.stderr?.trimEnd() ?? error.message ?? "Unknown git error",
			timedOut,
		);
	}
}

// ========== gitProbe（探测用，不 throw） ==========

/**
 * 运行 Git 命令进行探测（预期可能失败，不 throw）。
 * 用于 ls-remote、remote get-url、rev-list --count（空仓库）等场景。
 */
export async function gitProbe(
	repoPath: string,
	args: string[],
	options?: { timeout?: number },
): Promise<GitProbeOutput> {
	try {
		const result = await gitExec(repoPath, args, options);
		return { ...result, ok: true };
	} catch (err) {
		if (err instanceof GitCommandError) {
			return { stdout: err.stdout, stderr: err.stderr, ok: false };
		}
		throw err;
	}
}

// ========== Status ==========

export async function gitStatus(
	repoPath: string,
	trackingBranch?: string,
): Promise<GitStatus> {
	const [branchResult, commitResult, statusResult, rebaseResult] =
		await Promise.all([
			gitExec(repoPath, ["rev-parse", "--abbrev-ref", "HEAD"]),
			gitExec(repoPath, ["rev-parse", "HEAD"]),
			gitExec(repoPath, ["status", "--porcelain"]),
			gitExec(repoPath, ["rev-parse", "--git-dir"])
				.then(async (r) => {
					const gitDir = r.stdout.trim();
					const { existsSync: es } = await import("node:fs");
					const { join: j } = await import("node:path");
					return {
						rebasing:
							es(j(repoPath, gitDir, "rebase-merge")) ||
							es(j(repoPath, gitDir, "rebase-apply")),
						merging: es(j(repoPath, gitDir, "MERGE_HEAD")),
					};
				})
				.catch(() => ({ rebasing: false, merging: false })),
		]);

	const branch = branchResult.stdout.trim();
	const commit = commitResult.stdout.trim();
	const trackedBranch = trackingBranch ?? branch;
	const commitShort = commit.substring(0, 7);
	const hasUncommittedChanges = statusResult.stdout.trim().length > 0;

	const changedFiles = statusResult.stdout
		.split("\n")
		.filter(Boolean)
		.map((line) => line.substring(3).trim());

	// 冲突文件列表
	const conflictedFiles: string[] = [];
	for (const line of statusResult.stdout.split("\n").filter(Boolean)) {
		if (
			line.startsWith("UU ") ||
			line.startsWith("AA ") ||
			line.startsWith("DD ")
		) {
			conflictedFiles.push(line.substring(3).trim());
		}
	}

	const hasConflicts = conflictedFiles.length > 0;

	// 远端信息（使用 probe，因为可能无 origin）
	let remoteExists = false;
	let ahead = 0;
	let behind = 0;

	const remoteProbe = await gitProbe(repoPath, ["remote", "get-url", "origin"]);
	remoteExists = remoteProbe.ok && remoteProbe.stdout.trim().length > 0;

	if (remoteExists) {
		const revListProbe = await gitProbe(repoPath, [
			"rev-list",
			"--left-right",
			"--count",
			`${trackedBranch}...origin/${trackedBranch}`,
		]);

		if (revListProbe.ok) {
			const counts = revListProbe.stdout.trim().split(/\s+/);
			if (counts.length === 2) {
				ahead = Number.parseInt(counts[0]!, 10) || 0;
				behind = Number.parseInt(counts[1]!, 10) || 0;
			}
		} else {
			// origin/branch may not exist yet
			remoteExists = false;
		}
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
	await gitExec(repoPath, ["fetch", "origin"]);
}

export async function gitPull(
	repoPath: string,
	branch: string,
): Promise<{ pulled: boolean }> {
	const result = await gitExec(repoPath, [
		"pull",
		"--ff-only",
		"origin",
		branch,
	]);
	const pulled =
		!result.stdout.includes("Already up to date") &&
		!result.stdout.includes("Already up-to-date");
	return { pulled };
}

export async function gitPush(repoPath: string, branch: string): Promise<void> {
	await gitExec(repoPath, ["push", "--set-upstream", "origin", branch]);
}

/**
 * Publish HEAD as this device's remote snapshot. force-with-lease permits a
 * device to replace its own older snapshot while still refusing to overwrite a
 * ref that changed after the latest fetch.
 */
export async function gitPushHeadToBranch(
	repoPath: string,
	branch: string,
): Promise<void> {
	await gitExec(repoPath, [
		"push",
		"--force-with-lease",
		"origin",
		`HEAD:refs/heads/${branch}`,
	]);
}

/** Publish an existing local device branch as its remote snapshot. */
export async function gitPushDeviceBranch(
	repoPath: string,
	branch: string,
): Promise<void> {
	await gitExec(repoPath, [
		"push",
		"--force-with-lease",
		"--set-upstream",
		"origin",
		branch,
	]);
}

export async function gitRenameBranch(
	repoPath: string,
	branch: string,
): Promise<void> {
	await gitExec(repoPath, ["branch", "-M", branch]);
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
	try {
		const result = await gitExec(repoPath, ["rebase", `origin/${branch}`]);
		const combined = `${result.stderr}\n${result.stdout}`;

		if (/CONFLICT/i.test(combined)) {
			return { rebased: false, conflict: true };
		}

		const rebased =
			!combined.includes("Current branch") ||
			!combined.includes("is up to date");

		return { rebased, conflict: false };
	} catch (err) {
		// rebase 可能因冲突而退出非零，检查输出
		if (err instanceof GitCommandError) {
			const combined = `${err.stderr}\n${err.stdout}`;
			if (/CONFLICT/i.test(combined)) {
				return { rebased: false, conflict: true };
			}
		}
		throw err;
	}
}

/**
 * 继续 rebase（用户解决冲突后）
 */
export async function gitRebaseContinue(repoPath: string): Promise<void> {
	await gitExec(repoPath, ["rebase", "--continue"]);
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

	try {
		await gitExec(repoPath, ["commit", "-m", message]);
	} catch (err) {
		if (err instanceof GitCommandError) {
			const combined = `${err.stderr}\n${err.stdout}`;
			// "nothing to commit" is not an error — it means no changes
			if (/nothing to commit|no changes added to commit/i.test(combined)) {
				return;
			}
		}
		throw err;
	}

	const after = await getHeadCommit(repoPath).catch(() => "");
	if (after === "" || after === before) {
		throw new GitCommandError(
			["commit", "-m", message],
			repoPath,
			null,
			"",
			"no commit was created",
			false,
		);
	}
}

// ========== 查询 ==========

export async function getHeadCommit(repoPath: string): Promise<string> {
	const result = await gitExec(repoPath, ["rev-parse", "HEAD"]);
	return result.stdout.trim();
}

export async function hasUncommittedChanges(
	repoPath: string,
): Promise<boolean> {
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
	const gitDirProbe = await gitProbe(repoPath, ["rev-parse", "--git-dir"]);
	const gitDir = gitDirProbe.ok ? gitDirProbe.stdout.trim() : ".git";

	return {
		isRebasing:
			es(j(repoPath, gitDir, "rebase-merge")) ||
			es(j(repoPath, gitDir, "rebase-apply")),
		isMerging: es(j(repoPath, gitDir, "MERGE_HEAD")),
		hasConflicts: await hasUnmergedPaths(repoPath),
	};
}

// ========== Push 流程步骤 ==========

/**
 * 检查 origin 是否可达且目标分支是否存在。
 * 用于 push 时提前检测 "no upstream"。
 */
export async function gitRemoteRefExists(
	repoPath: string,
	branch: string,
): Promise<boolean> {
	const probe = await gitProbe(repoPath, [
		"ls-remote",
		"--heads",
		"origin",
		branch,
	]);
	return probe.ok && probe.stdout.trim().length > 0;
}
