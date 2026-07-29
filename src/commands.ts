/**
 * /pisync 命令路由（schema v2）
 *
 * 所有同步操作的主入口。
 *
 * 核心流程变化（v1 → v2）：
 * - 配置仓库不再作为 Pi Package 安装
 * - settings.json 整文件共享，不做 managed-key merge
 * - 基于同步基线的三方比较
 * - capture → commit → fetch → rebase → push → apply 完整 push 链
 * - 冲突处理与 push --continue
 */
import { existsSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import {
	gitStatus,
	gitFetch,
	gitFastForward,
	gitPush,
	gitPushHeadToBranch,
	gitPushDeviceBranch,
	gitDiff,
	gitDiffRange,
	gitDiffStaged,
	gitRebaseAbort,
	gitCommit,
	getHeadCommit,
	hasUnmergedPaths,
	listUnmergedPaths,
	isWorktreeClean,
	gitExec,
	gitProbe,
	canFastForward,
	GitCommandError,
} from "./git.ts";
import { loadPiSyncConfig } from "./config.ts";
import { withOperationSignal } from "./operation-context.ts";
import type { PiSyncConfig } from "./config.ts";
import { executeApplyTransaction } from "./apply-transaction.ts";
import {
	commitCapturedChangesBeforePull,
	integratePulledHead,
	preparePullWorktree,
} from "./pull-phase.ts";
import { integrateCommittedPush } from "./push-phase.ts";
import {
	clearRepoContents,
	executeSetupFlow,
	isValidSetupGitUrl,
} from "./setup-flow.ts";
import { planMaterialize } from "./materialize.ts";
import { SyncLock } from "./lock.ts";
import { scanSecrets } from "./security.ts";
import { ensureDeviceId, loadState, saveState } from "./state.ts";
import type { SyncState } from "./state.ts";
import { isSyncConflictRequest } from "./operation-result.ts";
import type {
	CommandResult,
	ResultCode,
	RunOptions,
	RunResult,
	SyncConflictPath,
	SyncConflictRequest,
	SyncPhase,
} from "./operation-result.ts";
import { captureChanges } from "./capture.ts";
import { resolveAutomaticConflict } from "./conflict-resolution.ts";
import { compareFiles, hasLocalChanges, sha256 } from "./inventory.ts";
import { validateFiles } from "./validate.ts";
import {
	getPackageDiff,
	preparePackagePlan,
	approvePackagePlan,
} from "./packages.ts";
import type { PackageApproval } from "./packages.ts";
import { resolveRepoSyncRoot, resolveWithinRoot } from "./path-safety.ts";
import {
	formatGitStatus,
	formatSyncStatusV2,
	formatComparisonDiff,
	formatSecretsFindings,
	formatValidationErrors,
} from "./ui.ts";

// ========== 路径工具 ==========

function getAgentDir(): string {
	const envDir = process.env.PI_CODING_AGENT_DIR;
	if (envDir) return envDir;

	const home = process.env.HOME ?? process.env.USERPROFILE ?? "~";
	return join(home, ".pi", "agent");
}

export async function getRepoPathSafe(
	_agentDir: string,
): Promise<string | null> {
	try {
		return await getRepoPath();
	} catch {
		return null;
	}
}

export async function getRepoPath(configOverride?: string): Promise<string> {
	if (configOverride) return configOverride;

	const agentDir = getAgentDir();
	const state = await loadState(agentDir);
	if (state.repoPath && existsSync(state.repoPath)) {
		return state.repoPath;
	}
	throw new Error("No config repo found. Run /pisync to set up.");
}

/**
 * Ensure all sync operations use the branch declared by pi-sync.json.
 * Always let Git attempt the switch. Compatible local changes can move with
 * the user; incompatible changes or an active operation are rejected by Git.
 */
async function ensureConfiguredBranch(
	repoPath: string,
	branch: string,
): Promise<boolean> {
	const branchFormat = await gitProbe(repoPath, [
		"check-ref-format",
		"--branch",
		branch,
	]);
	if (!branchFormat.ok) {
		throw new Error(`Invalid configured sync branch "${branch}".`);
	}

	const status = await gitStatus(repoPath);
	if (status.branch === branch) return false;

	const localRef = await gitProbe(repoPath, [
		"show-ref",
		"--verify",
		`refs/heads/${branch}`,
	]);
	if (localRef.ok) {
		await gitExec(repoPath, ["switch", branch]);
		return true;
	}

	const remoteRef = await gitProbe(repoPath, [
		"show-ref",
		"--verify",
		`refs/remotes/origin/${branch}`,
	]);
	if (!remoteRef.ok) {
		throw new Error(
			`Configured sync branch "${branch}" does not exist locally or on origin.`,
		);
	}
	await gitExec(repoPath, [
		"switch",
		"--track",
		"-c",
		branch,
		`origin/${branch}`,
	]);
	return true;
}

export interface PushPreparation {
	kind: "ready" | "noop" | "blocked";
	capture: Awaited<ReturnType<typeof captureChanges>>;
	changedFiles: string[];
	diff: string;
	repoHead: string;
	worktreeFingerprint: string;
	repoPath: string;
	branch: string;
	message?: string;
	conflict?: SyncConflictRequest;
}

export type LifecycleState =
	| { kind: "uninitialized" }
	| { kind: "initialized"; repoPath: string; state: SyncState }
	| { kind: "broken"; reason: string; repoPath?: string };

type ConflictCoordinationResult =
	| { kind: "resolved"; message: string }
	| {
			kind: "needs_user";
			conflict: SyncConflictRequest;
			message: string;
	  };

interface InitInternalResult {
	message: string;
	needsReload: boolean;
	ok: boolean;
	level: "info" | "warning" | "error";
	code?: ResultCode;
	details?: unknown;
}

export type InitResult = CommandResult & {
	needsReload: boolean;
	level: "info" | "warning" | "error";
};

function normalizeInitResult(result: InitInternalResult): InitResult {
	return {
		...result,
		code: result.code ?? (result.ok ? "ok" : "partial_failure"),
		reload: result.needsReload,
	};
}

function conflictPathsFrom(
	conflicts: ReadonlyArray<{
		relativePath: string;
		changeType: string;
	}>,
): SyncConflictPath[] {
	const paths = new Map<string, SyncConflictPath>();
	for (const conflict of conflicts) {
		const changeType = [
			"both_modified",
			"local_modified_remote_deleted",
			"local_deleted_remote_modified",
		].includes(conflict.changeType)
			? (conflict.changeType as SyncConflictPath["changeType"])
			: "git_conflict";
		paths.set(conflict.relativePath, {
			relativePath: conflict.relativePath,
			changeType,
		});
	}
	return [...paths.values()].sort((a, b) =>
		a.relativePath.localeCompare(b.relativePath),
	);
}

function conflictFromDetails(
	details: unknown,
): SyncConflictRequest | undefined {
	if (!details || typeof details !== "object") return undefined;
	const conflict = (details as { conflict?: unknown }).conflict;
	return isSyncConflictRequest(conflict) ? conflict : undefined;
}

function resultFromPreparation(preparation: PushPreparation): CommandResult {
	if (preparation.kind === "ready") {
		return {
			ok: false,
			code: "partial_failure",
			message:
				preparation.message ?? "Push preparation is ready for confirmation.",
			reload: false,
			details: preparation,
		};
	}
	return {
		ok: preparation.kind === "noop",
		code: preparation.kind === "noop" ? "noop" : "blocked_conflict",
		message:
			preparation.message ??
			(preparation.kind === "noop" ? "No changes to push." : "Push blocked."),
		reload: false,
		details: preparation.conflict
			? { ...preparation, conflict: preparation.conflict }
			: preparation,
	};
}

// ========== 命令类 ==========

export class PiSyncCommands {
	private agentDir: string;
	private lock: SyncLock;
	private orchestrationLockHeld = false;

	constructor(agentDir?: string) {
		this.agentDir = agentDir ?? getAgentDir();
		this.lock = new SyncLock(join(this.agentDir, ".pi-sync"));
	}

	/** Return the configured repository for display-only extension handoffs. */
	async getConflictRepoPath(): Promise<string | null> {
		const state = await loadState(this.agentDir);
		return state.repoPath && existsSync(state.repoPath) ? state.repoPath : null;
	}

	/** Resolve a user-confirmed conflict choice without trusting UI-supplied paths. */
	async resolveConflict(
		request: SyncConflictRequest,
		choice: import("./operation-result.ts").AutomaticConflictChoice,
		options: Pick<
			RunOptions,
			"packageApproval" | "signal" | "onProgress" | "onGitCommandStart"
		> = {},
	): Promise<RunResult> {
		return await withOperationSignal(options.signal, async () => {
			const lifecycle = await this.inspectLifecycleState();
			if (lifecycle.kind !== "initialized") {
				return {
					ok: false,
					code: "blocked_conflict",
					message:
						"Sync repository is not ready to resolve this conflict. Run /pisync again.",
					reload: false,
					mode: "sync",
					phase: "preflight",
				};
			}
			const acquired = await this.lock.acquire("resolve-conflict", 5000);
			if (!acquired) {
				return {
					ok: false,
					code: "partial_failure",
					message: "Another sync operation is in progress.",
					reload: false,
					mode: "sync",
					phase: "preflight",
				};
			}

			try {
				const rp = lifecycle.repoPath;
				const config = await loadPiSyncConfig(rp);
				const state = await loadState(this.agentDir);
				const expectedDeviceBranch = await this.getDeviceBranchName();
				if (
					request.sharedBranch !== config.branch ||
					request.deviceBranch !== expectedDeviceBranch
				) {
					return {
						ok: false,
						code: "blocked_conflict",
						message:
							"This conflict request is stale or belongs to another device. Run /pisync again.",
						reload: false,
						mode: "sync",
						phase: "preflight",
					};
				}

				this.emitProgress(
					options.onProgress,
					"pull",
					"Resolving selected conflict paths...",
				);
				const resolution = await resolveAutomaticConflict({
					repoPath: rp,
					request,
					choice,
					beforeCommit: async () => {
						const files = await this.getRepoSyncFiles(rp, config);
						const validation = await validateFiles(rp, config, files);
						if (validation.blocked) {
							return {
								code: "blocked_validation" as const,
								message: formatValidationErrors(validation.errors),
							};
						}
						try {
							const packagePlan = await preparePackagePlan(
								rp,
								this.agentDir,
								config,
							);
							if (
								packagePlan.approvalRequired.length > 0 &&
								(!options.packageApproval ||
									!approvePackagePlan(packagePlan, options.packageApproval)
										.approved)
							) {
								return {
									code: "approval_required" as const,
									message: `Package approval required before resolving settings: ${packagePlan.approvalRequired.join(", ")}`,
									packages: packagePlan.approvalRequired,
								};
							}
						} catch (error) {
							return {
								code: "blocked_validation" as const,
								message: `Package validation failed: ${error instanceof Error ? error.message : "Unknown error"}`,
							};
						}
						if (config.security.scanSecretsBeforePush) {
							const findings = await this.scanForSecrets(rp, config);
							if (findings.length > 0) {
								return {
									code: "blocked_secret" as const,
									message: `Potential secrets detected.\n${formatSecretsFindings(findings)}`,
								};
							}
						}
						return undefined;
					},
				});

				if (resolution.kind !== "resolved") {
					const refreshed =
						resolution.kind === "stale"
							? await this.createSyncConflictRequest(
									rp,
									config,
									request.deviceBranch,
									request.paths,
								).catch(() => request)
							: request;
					return {
						ok: false,
						code:
							resolution.kind === "blocked"
								? (resolution.code ?? "blocked_validation")
								: "blocked_conflict",
						message: resolution.message,
						reload: false,
						mode: "sync",
						phase: "pull",
						details: {
							conflict: refreshed,
							packages:
								resolution.kind === "blocked" ? resolution.packages : undefined,
						},
					};
				}

				this.emitProgress(
					options.onProgress,
					"apply",
					"Applying resolved configuration...",
				);
				const remoteConflictPaths =
					choice === "use_remote"
						? new Set(request.paths.map((path) => path.relativePath))
						: undefined;
				const apply = await this.applyCurrent(
					rp,
					config,
					state,
					"conflict-resolution",
					options.packageApproval,
					true,
					remoteConflictPaths,
				);
				return {
					...apply,
					message: `Conflict resolved using ${choice === "use_local" ? "current-device" : "shared remote"} content.\n${apply.message}`,
					mode: "sync",
					phase: apply.code === "approval_required" ? "apply" : "complete",
					details:
						typeof apply.details === "object" && apply.details !== null
							? (apply.details as RunResult["details"])
							: undefined,
				};
			} finally {
				await this.lock.release();
			}
		});
	}

	/**
	 * Inspect local lifecycle state without treating a damaged repository as a
	 * fresh installation. This is the single state decision point for `run()`.
	 */
	async inspectLifecycleState(): Promise<LifecycleState> {
		const state = await loadState(this.agentDir);
		const defaultPath = join(this.agentDir, "..", "config-repo");

		if (!state.repoPath) {
			return existsSync(defaultPath)
				? {
						kind: "broken",
						reason:
							"A config repository exists, but local sync state is missing.",
						repoPath: defaultPath,
					}
				: { kind: "uninitialized" };
		}

		if (!existsSync(state.repoPath)) {
			return {
				kind: "broken",
				reason: "Sync state points to a repository that no longer exists.",
				repoPath: state.repoPath,
			};
		}
		if (!existsSync(join(state.repoPath, ".git"))) {
			return {
				kind: "broken",
				reason: "The configured repository is missing its .git directory.",
				repoPath: state.repoPath,
			};
		}
		if (!existsSync(join(state.repoPath, "pi-sync.json"))) {
			return {
				kind: "broken",
				reason: "The configured repository is missing pi-sync.json.",
				repoPath: state.repoPath,
			};
		}

		try {
			await loadPiSyncConfig(state.repoPath);
		} catch (error) {
			return {
				kind: "broken",
				reason:
					error instanceof Error
						? `The configured repository has an invalid pi-sync.json: ${error.message}`
						: "The configured repository has an invalid pi-sync.json.",
				repoPath: state.repoPath,
			};
		}

		return { kind: "initialized", repoPath: state.repoPath, state };
	}

	private emitProgress(
		onProgress: RunOptions["onProgress"],
		phase: SyncPhase,
		message: string,
	): void {
		onProgress?.(phase, message);
	}

	/** Manage lock ownership for public operations without changing phase semantics. */
	private async withCommandLock<T>(
		operation: string,
		onBusy: () => T,
		run: () => Promise<T>,
	): Promise<T> {
		if (this.orchestrationLockHeld) return run();
		if (!(await this.lock.acquire(operation, 5000))) return onBusy();
		try {
			return await run();
		} finally {
			await this.lock.release();
		}
	}

	private busyCommandResult(): CommandResult {
		return {
			ok: false,
			code: "partial_failure",
			message: "Another sync operation is in progress.",
			reload: false,
		};
	}

	private async recoverPendingInternal(
		lifecycle: Extract<LifecycleState, { kind: "initialized" }>,
		options: RunOptions,
	): Promise<CommandResult> {
		const pending = lifecycle.state.pendingOperation;
		if (!pending) {
			return {
				ok: true,
				code: "noop",
				message: "No recovery required.",
				reload: false,
			};
		}
		if (pending.type === "push-rebase-conflict") {
			return await this.push(lifecycle.repoPath, undefined, "--continue");
		}
		if (pending.type === "apply-failed") {
			return await this.apply(lifecycle.repoPath, options.packageApproval);
		}
		return {
			ok: false,
			code: "partial_failure",
			message: `Unknown pending operation "${String((pending as { type?: unknown }).type)}". Resolve it manually before syncing.`,
			reload: false,
		};
	}

	private async syncInternal(
		repoPath: string,
		options: RunOptions,
		initialReload = false,
	): Promise<RunResult> {
		this.emitProgress(options.onProgress, "pull", "Pulling remote changes...");
		const pull = await this.pull(
			repoPath,
			options.packageApproval,
			options.onProgress,
			{
				signal: options.signal,
				onGitCommandStart: options.onGitCommandStart,
			},
		);
		if (!pull.ok || pull.code === "approval_required") {
			const pullDetails =
				typeof pull.details === "object" && pull.details !== null
					? (pull.details as { packages?: unknown })
					: undefined;
			const conflict = conflictFromDetails(pull.details);
			return {
				...pull,
				mode: "sync",
				phase: pull.code === "approval_required" ? "apply" : "pull",
				reload: initialReload || pull.reload,
				details: {
					pull,
					conflict,
					packages: Array.isArray(pullDetails?.packages)
						? pullDetails.packages
						: undefined,
				},
			};
		}

		this.emitProgress(options.onProgress, "push", "Pushing local changes...");
		const push = await this.push(repoPath);
		const code = !push.ok
			? push.code
			: pull.code === "noop" && push.code === "noop"
				? "noop"
				: "ok";
		return {
			ok: push.ok,
			code,
			message:
				`Sync ${push.ok ? "completed" : "incomplete"}.\n` +
				`Pull: ${pull.message}\nPush: ${push.message}`,
			reload: initialReload || pull.reload || push.reload,
			mode: "sync",
			phase: "complete",
			details: {
				pull,
				push,
				conflict: conflictFromDetails(push.details),
			},
		};
	}

	/** Run setup, recovery, or the complete pull-then-push synchronization. */
	async run(options: RunOptions = {}): Promise<RunResult> {
		return await withOperationSignal(options.signal, () =>
			this.runWithOperationSignal(options),
		);
	}

	private async runWithOperationSignal(
		options: RunOptions,
	): Promise<RunResult> {
		this.emitProgress(
			options.onProgress,
			"preflight",
			"Checking sync state...",
		);
		const lifecycle = await this.inspectLifecycleState();

		if (lifecycle.kind === "broken") {
			return {
				ok: false,
				code: "partial_failure",
				message: `Sync state is damaged: ${lifecycle.reason}`,
				reload: false,
				mode: "sync",
				phase: "preflight",
				details: { reason: lifecycle.reason },
			};
		}

		if (lifecycle.kind === "uninitialized") {
			if (!options.gitUrl) {
				return {
					ok: false,
					code: "blocked_validation",
					message: "Enter your config repo Git URL to get started.",
					reload: false,
					mode: "setup",
					phase: "preflight",
					details: { needsGitUrl: true },
				};
			}
			const setup = await this.init(
				options.gitUrl,
				(message) =>
					this.emitProgress(options.onProgress, "preflight", message),
				false,
				options.packageApproval,
			);
			return {
				...setup,
				mode: "setup",
				phase: setup.ok ? "complete" : "preflight",
				details:
					typeof setup.details === "object" && setup.details !== null
						? (setup.details as RunResult["details"])
						: undefined,
			};
		}

		const acquired = await this.lock.acquire("sync", 5000);
		if (!acquired) {
			return {
				ok: false,
				code: "partial_failure",
				message: "Another sync operation is in progress.",
				reload: false,
				mode: "sync",
				phase: "preflight",
			};
		}

		this.orchestrationLockHeld = true;
		try {
			let recoveryReload = false;
			if (lifecycle.state.pendingOperation) {
				this.emitProgress(
					options.onProgress,
					"preflight",
					"Recovering pending operation...",
				);
				const recovery = await this.recoverPendingInternal(lifecycle, options);
				recoveryReload = recovery.reload;
				if (!recovery.ok || recovery.code === "approval_required") {
					return {
						...recovery,
						mode: "recovery",
						phase:
							recovery.code === "approval_required" ? "apply" : "preflight",
						details:
							typeof recovery.details === "object" && recovery.details !== null
								? (recovery.details as RunResult["details"])
								: undefined,
					};
				}
			}
			return await this.syncInternal(
				lifecycle.repoPath,
				options,
				recoveryReload,
			);
		} finally {
			this.orchestrationLockHeld = false;
			await this.lock.release();
		}
	}

	// ========== 冲突分支 ==========

	/**
	 * Each agent owns one stable remote snapshot branch. A hostname is readable
	 * but not unique, so it is paired with a UUID persisted only in local state.
	 * We never scan remote branches and guess: the current device branch is known
	 * deterministically, while other devices may legitimately have many branches.
	 */
	private async getDeviceBranchName(): Promise<string> {
		const host =
			hostname()
				.toLowerCase()
				.replace(/[^a-z0-9_-]+/g, "-")
				.replace(/^-+|-+$/g, "")
				.slice(0, 40) || "device";
		const deviceId = await ensureDeviceId(this.agentDir);
		return `pisync-device/${host}-${deviceId}`;
	}

	/** Push the shared branch and a snapshot of the current device at the same HEAD. */
	private async pushMainAndDeviceBranches(
		repoPath: string,
		branch: string,
	): Promise<string> {
		await gitPush(repoPath, branch);
		const deviceBranch = await this.getDeviceBranchName();
		await gitPushHeadToBranch(repoPath, deviceBranch);
		return deviceBranch;
	}

	private async createSyncConflictRequest(
		repoPath: string,
		config: PiSyncConfig,
		deviceBranch: string,
		paths: SyncConflictPath[],
	): Promise<SyncConflictRequest> {
		const [sharedRef, deviceRef] = await Promise.all([
			gitProbe(repoPath, [
				"show-ref",
				"--hash",
				"--verify",
				`refs/remotes/origin/${config.branch}`,
			]),
			gitProbe(repoPath, [
				"show-ref",
				"--hash",
				"--verify",
				`refs/remotes/origin/${deviceBranch}`,
			]),
		]);
		if (!deviceRef.ok || !deviceRef.stdout.trim()) {
			throw new Error(
				`Current-device branch origin/${deviceBranch} was not published.`,
			);
		}
		return {
			kind: "sync_conflict",
			sharedBranch: config.branch,
			deviceBranch,
			sharedHead: sharedRef.ok ? sharedRef.stdout.trim() : undefined,
			deviceHead: deviceRef.stdout.trim(),
			paths,
		};
	}

	private formatManualMergeMessage(
		repoPath: string,
		config: PiSyncConfig,
		branch: string,
	): string {
		return [
			"Sync conflict detected. The shared branch was left unchanged.",
			`Current-device changes were saved to origin/${branch}.`,
			"",
			"Merge the current-device branch into the shared branch:",
			`  cd ${repoPath}`,
			"  git fetch origin",
			`  git switch ${config.branch}`,
			`  git merge origin/${branch}`,
			"",
			`Resolve any conflicts, then run git add, git commit, and git push origin ${config.branch}.`,
		].join("\n");
	}

	private formatFastForwardedConflictMessage(config: PiSyncConfig): string {
		return [
			"Sync conflict resolved by fast-forwarding current-device changes.",
			`The current-device version was published to ${config.branch}.`,
		].join("\n");
	}

	private formatMergedConflictMessage(config: PiSyncConfig): string {
		return [
			"Sync conflict resolved by automatically merging current-device changes.",
			`The merged version was published to ${config.branch}.`,
		].join("\n");
	}

	/**
	 * Merge a published device snapshot into the shared branch without requiring
	 * user intervention. A real content conflict is aborted, leaving both remote
	 * branches intact for the existing manual-resolution fallback.
	 */
	private async mergeDeviceBranchIntoShared(
		repoPath: string,
		config: PiSyncConfig,
		deviceBranch: string,
	): Promise<boolean> {
		try {
			await gitExec(repoPath, ["merge", "--no-edit", `origin/${deviceBranch}`]);
		} catch (error) {
			const output =
				error instanceof GitCommandError
					? `${error.stdout}\n${error.stderr}`
					: "";
			if (!/CONFLICT|Automatic merge failed/i.test(output)) throw error;
			await gitExec(repoPath, ["merge", "--abort"]);
			return false;
		}

		try {
			await this.pushMainAndDeviceBranches(repoPath, config.branch);
			return true;
		} catch (error) {
			const output =
				error instanceof GitCommandError
					? `${error.stdout}\n${error.stderr}`
					: "";
			if (!/rejected|fetch first|non-fast-forward/i.test(output)) throw error;

			// Preserve the published device snapshot but discard the local merge,
			// which was invalidated by a concurrent shared-branch update.
			await gitFetch(repoPath);
			await gitExec(repoPath, ["reset", "--hard", `origin/${config.branch}`]);
			return false;
		}
	}

	/** Save and publish current-device changes, fast-forwarding the shared branch when safe. */
	private async preserveConflictOnDeviceBranch(
		repoPath: string,
		config: PiSyncConfig,
		state: SyncState,
	): Promise<{
		branch: string;
		fastForwarded: boolean;
		paths: SyncConflictPath[];
	}> {
		const branch = await this.getDeviceBranchName();
		await gitExec(repoPath, ["switch", "-C", branch]);
		try {
			const capture = await captureChanges(
				this.agentDir,
				repoPath,
				config,
				state,
				{ preferLocalOnConflicts: true },
			);
			const paths = conflictPathsFrom(capture.conflicts);
			if (capture.errors.length > 0 || capture.denied.length > 0) {
				throw new Error(
					`Could not preserve current-device changes on ${branch}: ${[
						...capture.errors.map((error) => `${error.file}: ${error.message}`),
						...capture.denied.map((file) => `${file}: denied by sync policy`),
					].join("; ")}`,
				);
			}
			await gitCommit(
				repoPath,
				"pi-sync: preserve current-device conflict changes",
			);
			await gitPushDeviceBranch(repoPath, branch);
			await gitFetch(repoPath);

			if (
				!(await canFastForward(repoPath, `origin/${config.branch}`, branch))
			) {
				return { branch, fastForwarded: false, paths };
			}

			await gitExec(repoPath, ["switch", config.branch]);
			await gitExec(repoPath, ["merge", "--ff-only", branch]);
			try {
				await gitPush(repoPath, config.branch);
				return { branch, fastForwarded: true, paths };
			} catch (error) {
				const output =
					error instanceof GitCommandError
						? `${error.stdout}\n${error.stderr}`
						: "";
				if (!/rejected|fetch first|non-fast-forward/i.test(output)) {
					throw error;
				}
				// A concurrent remote update invalidated the preflight. The device
				// branch is already published, so restore the shared branch and let
				// the normal manual-resolution path handle the new topology.
				await gitFetch(repoPath);
				await gitExec(repoPath, [
					"branch",
					"-f",
					config.branch,
					`origin/${config.branch}`,
				]);
				return { branch, fastForwarded: false, paths };
			}
		} finally {
			await gitExec(repoPath, ["switch", config.branch]);
		}
	}

	/**
	 * A rebase has already committed current-device changes on the configured
	 * branch. Publish that commit on the device branch, then restore the shared
	 * branch to origin so the user can merge the remote device branch explicitly.
	 */
	private async coordinateDeviceBranchConflict(
		repoPath: string,
		config: PiSyncConfig,
		state: SyncState,
		fallbackPaths?: SyncConflictPath[],
	): Promise<ConflictCoordinationResult> {
		const preservation = await this.preserveConflictOnDeviceBranch(
			repoPath,
			config,
			state,
		);
		if (preservation.fastForwarded) {
			return {
				kind: "resolved",
				message: this.formatFastForwardedConflictMessage(config),
			};
		}
		if (
			await this.mergeDeviceBranchIntoShared(
				repoPath,
				config,
				preservation.branch,
			)
		) {
			return {
				kind: "resolved",
				message: this.formatMergedConflictMessage(config),
			};
		}
		const conflict = await this.createSyncConflictRequest(
			repoPath,
			config,
			preservation.branch,
			preservation.paths.length > 0
				? preservation.paths
				: (fallbackPaths ?? []),
		);
		return {
			kind: "needs_user",
			conflict,
			message: this.formatManualMergeMessage(
				repoPath,
				config,
				preservation.branch,
			),
		};
	}

	private async preserveRebaseConflictOnDeviceBranch(
		repoPath: string,
		config: PiSyncConfig,
	): Promise<string> {
		const branch = await this.getDeviceBranchName();
		await gitRebaseAbort(repoPath);
		await gitExec(repoPath, ["branch", "-f", branch]);
		await gitExec(repoPath, ["switch", branch]);
		try {
			await gitExec(repoPath, [
				"branch",
				"-f",
				config.branch,
				`origin/${config.branch}`,
			]);
			await gitPushDeviceBranch(repoPath, branch);
		} finally {
			await gitExec(repoPath, ["switch", config.branch]);
		}
		return branch;
	}

	// ========== status ==========

	async status(repoPath?: string): Promise<string> {
		const rp = repoPath ?? (await getRepoPathSafe(this.agentDir));
		if (!rp) return "No config repo configured. Run /pisync to set up first.";

		const config = await loadPiSyncConfig(rp);
		const status = await gitStatus(rp, config.branch);
		const state = await loadState(this.agentDir);

		// 三方比较
		const inventory = await compareFiles(this.agentDir, rp, config, state);

		// Package diff
		let pkgDiff = null;
		try {
			pkgDiff = await getPackageDiff(rp, this.agentDir, config);
		} catch {
			/* best-effort */
		}

		return formatSyncStatusV2({
			repoPath: rp,
			agentDir: this.agentDir,
			gitStatus: status,
			config,
			inventory,
			state,
			pkgDiff: pkgDiff ?? undefined,
		});
	}

	// ========== diff ==========

	async diff(repoPath?: string): Promise<string> {
		const rp = repoPath ?? (await getRepoPathSafe(this.agentDir));
		if (!rp) return "No config repo configured. Run /pisync to set up first.";

		const config = await loadPiSyncConfig(rp);
		const status = await gitStatus(rp, config.branch);
		const state = await loadState(this.agentDir);

		// 三方比较
		const inventory = await compareFiles(this.agentDir, rp, config, state);

		const lines: string[] = [];

		// Git 状态
		lines.push("=== Git Status ===");
		lines.push(formatGitStatus(status));
		if (status.branch !== config.branch) {
			lines.push(
				`WARNING: config.branch is "${config.branch}" but repository is on "${status.branch}".`,
			);
		}
		lines.push("");

		// Agent ↔ Repo 差异（基于基线）
		lines.push("=== File Comparison ===");
		lines.push(formatComparisonDiff(inventory.comparisons));
		lines.push("");

		// Remote diff（如果有 ahead/behind）
		if (status.remoteExists) {
			if (status.behind > 0) {
				try {
					await gitFetch(rp);
					const rangeDiff = await gitDiffRange(
						rp,
						status.commit,
						`origin/${config.branch}`,
					);
					if (rangeDiff) {
						lines.push("=== Remote Changes (to be pulled) ===");
						lines.push(rangeDiff);
						lines.push("");
					}
				} catch {
					/* offline */
				}
			}
		}

		return lines.join("\n");
	}

	// ========== apply ==========

	async apply(
		repoPath?: string,
		packageApproval?: PackageApproval,
	): Promise<CommandResult> {
		const rp = repoPath ?? (await getRepoPath());
		const config = await loadPiSyncConfig(rp);
		const state = await loadState(this.agentDir);

		return this.withCommandLock<CommandResult>(
			"apply",
			() => this.busyCommandResult(),
			async () => {
				try {
					await ensureConfiguredBranch(rp, config.branch);
				} catch (error) {
					return {
						ok: false,
						code: "blocked_conflict",
						message:
							error instanceof Error
								? error.message
								: "Configured branch check failed.",
						reload: false,
					};
				}
				return this.applyCurrent(rp, config, state, "apply", packageApproval);
			},
		);
	}

	// ========== pull ==========

	async pull(
		repoPath?: string,
		packageApproval?: PackageApproval,
		onProgress?: RunOptions["onProgress"],
		executionOptions: Pick<RunOptions, "signal" | "onGitCommandStart"> = {},
	): Promise<CommandResult> {
		const rp = repoPath ?? (await getRepoPath());
		const config = await loadPiSyncConfig(rp);
		const state = await loadState(this.agentDir);
		const reportProgress = (message: string) =>
			this.emitProgress(onProgress, "pull", message);
		const reportGitStart = (command: string) =>
			executionOptions.onGitCommandStart?.(
				"pull",
				command,
				config.pullTimeoutMs,
			);
		const gitOptions = {
			timeout: config.pullTimeoutMs,
			signal: executionOptions.signal,
		};
		const pullTimeoutSeconds = config.pullTimeoutMs / 1000;

		return this.withCommandLock<CommandResult>(
			"pull",
			() => this.busyCommandResult(),
			async () => {
				// 1. 检查 repo 状态。目标分支已在本地时立即尝试切换；仅在
				// 本地分支不存在时先 fetch，以便建立 origin/<branch> tracking branch。
				reportProgress("Inspecting repository state...");
				let status = await gitStatus(rp);
				let switchedBranch = false;
				if (status.branch !== config.branch) {
					try {
						const localBranch = await gitProbe(rp, [
							"show-ref",
							"--verify",
							`refs/heads/${config.branch}`,
						]);
						if (!localBranch.ok) {
							const command = "git fetch origin";
							reportProgress(
								`Running: ${command} (timeout: ${pullTimeoutSeconds}s)...`,
							);
							reportGitStart(command);
							await gitFetch(rp, gitOptions);
						}
						reportProgress(`Switching to branch ${config.branch}...`);
						switchedBranch = await ensureConfiguredBranch(rp, config.branch);
						status = await gitStatus(rp);
					} catch (error) {
						return {
							ok: false,
							code: "blocked_conflict",
							message:
								error instanceof Error
									? error.message
									: "Configured branch check failed.",
							reload: false,
						};
					}
				}

				const worktree = await preparePullWorktree(rp, status, reportProgress);
				if (worktree.kind === "blocked") {
					return {
						ok: false,
						code: "blocked_conflict",
						message: worktree.message,
						reload: false,
					};
				}
				if (worktree.kind === "failed") {
					return {
						ok: false,
						code: "git_failed",
						message: worktree.message,
						reload: false,
					};
				}
				status = worktree.status;
				const committedRepositoryChanges = worktree.committedRepositoryChanges;

				// 2. Capture and commit agent-only changes before pulling so a pull does
				// not fail merely because the current device has unsynced configuration.
				reportProgress("Comparing local and remote changes...");
				const inventory = await compareFiles(this.agentDir, rp, config, state);
				// Equal local/remote content is safe to adopt as the baseline before
				// fetching. The explicit hash check also migrates legacy settings state
				// from raw-byte hashes to the portable canonical representation.
				let convergedBaselineChanged = false;
				for (const comparison of inventory.comparisons) {
					if (
						comparison.local &&
						comparison.remote &&
						comparison.local.sha256 === comparison.remote.sha256 &&
						state.files[comparison.relativePath]?.sha256 !==
							comparison.remote.sha256
					) {
						state.files[comparison.relativePath] = {
							sha256: comparison.remote.sha256,
							mode: comparison.remote.mode,
						};
						convergedBaselineChanged = true;
					}
				}
				if (convergedBaselineChanged) {
					await saveState(this.agentDir, state);
				}
				const hasRemoteChanges = inventory.comparisons.some((comparison) =>
					[
						"remote_only",
						"remote_created",
						"remote_deleted",
						"local_deleted_remote_modified",
						"converged",
					].includes(comparison.changeType),
				);
				let capturedLocalChanges = committedRepositoryChanges;
				if (hasLocalChanges(inventory.comparisons)) {
					reportProgress("Capturing local changes before pull...");
					const capture = await this.captureWithScaffoldCalibration(
						rp,
						config,
						state,
						this.shouldRefreshLocalCapture(status, state),
					);
					if (capture.hasConflicts) {
						try {
							const coordination = await this.coordinateDeviceBranchConflict(
								rp,
								config,
								state,
							);
							if (coordination.kind === "resolved") {
								const applyResult = await this.applyCurrent(
									rp,
									config,
									state,
									"pull",
									packageApproval,
								);
								return {
									...applyResult,
									message: `${coordination.message}\n${applyResult.message}`,
								};
							}
							return {
								ok: false,
								code: "blocked_conflict",
								message: coordination.message,
								reload: false,
								details: { conflict: coordination.conflict },
							};
						} catch (error) {
							return {
								ok: false,
								code: "git_failed",
								message: `Could not preserve current-device conflict changes: ${error instanceof Error ? error.message : "Unknown error"}`,
								reload: false,
							};
						}
					}
					if (capture.errors.length > 0 || capture.denied.length > 0) {
						return {
							ok: false,
							code: "blocked_conflict",
							message: `Pull blocked while capturing local changes.\n${[
								...capture.errors.map(
									(error) => `${error.file}: ${error.message}`,
								),
								...capture.denied.map(
									(file) => `${file}: denied by sync policy`,
								),
							].join("\n")}`,
							reload: false,
						};
					}
					const captureCommit = await commitCapturedChangesBeforePull(
						rp,
						reportProgress,
					);
					if (captureCommit.kind === "failed") {
						return {
							ok: false,
							code: "git_failed",
							message: captureCommit.message,
							reload: false,
						};
					}
					capturedLocalChanges = true;
				}

				const integration = await integratePulledHead({
					repoPath: rp,
					branch: config.branch,
					timeoutMs: config.pullTimeoutMs,
					capturedLocalChanges,
					signal: executionOptions.signal,
					onProgress: reportProgress,
					onGitCommandStart: reportGitStart,
				});
				if (integration.kind === "failed") {
					return {
						ok: false,
						code: "git_failed",
						message: integration.message,
						reload: false,
					};
				}
				if (integration.kind === "rebase_conflict") {
					try {
						const paths = conflictPathsFrom(
							(await listUnmergedPaths(rp)).map((relativePath) => ({
								relativePath:
									this.normalizeRepoChangedFiles([relativePath], config)[0] ??
									relativePath,
								changeType: "git_conflict",
							})),
						);
						const branch = await this.preserveRebaseConflictOnDeviceBranch(
							rp,
							config,
						);
						const conflict = await this.createSyncConflictRequest(
							rp,
							config,
							branch,
							paths,
						);
						return {
							ok: false,
							code: "blocked_conflict",
							message: this.formatManualMergeMessage(rp, config, branch),
							reload: false,
							details: { conflict },
						};
					} catch (error) {
						return {
							ok: false,
							code: "git_failed",
							message: `Rebase failed after committing local changes: ${error instanceof Error ? error.message : "Unknown error"}`,
							reload: false,
						};
					}
				}
				if (integration.kind === "rebased") {
					reportProgress("Applying pulled changes...");
					return this.applyCurrent(
						rp,
						config,
						await loadState(this.agentDir),
						"pull",
						packageApproval,
					);
				}

				const { pulled } = integration;
				const newState = await loadState(this.agentDir);
				if (!pulled) {
					// A previous pull may have fast-forwarded before package approval was
					// granted. Re-run apply so approval can complete without another pull.
					if (packageApproval || switchedBranch || hasRemoteChanges) {
						return this.applyCurrent(
							rp,
							config,
							newState,
							"pull",
							packageApproval,
						);
					}
					return {
						ok: true,
						code: "noop",
						message: "pi-git-sync: Already up to date.",
						reload: false,
					};
				}

				// 6. Apply
				reportProgress("Applying pulled changes...");
				return this.applyCurrent(rp, config, newState, "pull", packageApproval);
			},
		);
	}

	// ========== push ==========

	/**
	 * 准备 push：捕获变更、校验内容并生成稳定指纹，但不 commit/push。
	 * prepare 结束后 repo 工作树保持可供用户检查和取消后重试。
	 */
	async preparePush(repoPath?: string): Promise<PushPreparation> {
		const rp = repoPath ?? (await getRepoPath());
		const config = await loadPiSyncConfig(rp);
		const state = await loadState(this.agentDir);
		const emptyCapture: Awaited<ReturnType<typeof captureChanges>> = {
			captured: [],
			deleted: [],
			denied: [],
			errors: [],
			hasConflicts: false,
			conflicts: [],
		};

		return this.withCommandLock<PushPreparation>(
			"push-prepare",
			() => ({
				kind: "blocked",
				capture: emptyCapture,
				changedFiles: [],
				diff: "",
				repoHead: "",
				worktreeFingerprint: "",
				repoPath: rp,
				branch: config.branch,
				message: "Another sync operation is in progress.",
			}),
			async () => {
				let statusBefore = await gitStatus(rp);
				if (
					statusBefore.branch !== config.branch &&
					!statusBefore.isRebasing &&
					!statusBefore.isMerging &&
					!statusBefore.hasUncommittedChanges
				) {
					try {
						await gitFetch(rp);
					} catch {
						// ensureConfiguredBranch below reports the actionable branch error.
					}
				}
				try {
					await ensureConfiguredBranch(rp, config.branch);
					statusBefore = await gitStatus(rp);
				} catch (error) {
					return {
						kind: "blocked",
						capture: emptyCapture,
						changedFiles: [],
						diff: "",
						repoHead: statusBefore.commit,
						worktreeFingerprint: "",
						repoPath: rp,
						branch: config.branch,
						message:
							error instanceof Error
								? error.message
								: "Configured branch check failed.",
					};
				}
				if (
					statusBefore.isRebasing ||
					statusBefore.isMerging ||
					statusBefore.hasConflicts
				) {
					return {
						kind: "blocked",
						capture: emptyCapture,
						changedFiles: [],
						diff: "",
						repoHead: statusBefore.commit,
						worktreeFingerprint: "",
						repoPath: rp,
						branch: config.branch,
						message:
							"Repository is in conflict/resolution state. Resolve it before preparing push.",
					};
				}

				const capture = await this.captureWithScaffoldCalibration(
					rp,
					config,
					state,
					this.shouldRefreshLocalCapture(statusBefore, state),
				);
				if (capture.hasConflicts) {
					try {
						const coordination = await this.coordinateDeviceBranchConflict(
							rp,
							config,
							state,
						);
						if (coordination.kind === "resolved") {
							const applyResult = await this.applyCurrent(
								rp,
								config,
								state,
								"push",
							);
							return {
								kind: applyResult.ok ? "noop" : "blocked",
								capture,
								changedFiles: [],
								diff: "",
								repoHead: await getHeadCommit(rp),
								worktreeFingerprint: "",
								repoPath: rp,
								branch: config.branch,
								message: `${coordination.message}\n${applyResult.message}`,
							};
						}
						return {
							kind: "blocked",
							capture,
							changedFiles: [],
							diff: "",
							repoHead: statusBefore.commit,
							worktreeFingerprint: "",
							repoPath: rp,
							branch: config.branch,
							message: coordination.message,
							conflict: coordination.conflict,
						};
					} catch (error) {
						return {
							kind: "blocked",
							capture,
							changedFiles: [],
							diff: "",
							repoHead: statusBefore.commit,
							worktreeFingerprint: "",
							repoPath: rp,
							branch: config.branch,
							message: `Could not create a current-device conflict branch: ${error instanceof Error ? error.message : "Unknown error"}`,
						};
					}
				}
				if (capture.errors.length > 0) {
					return {
						kind: "blocked",
						capture,
						changedFiles: [],
						diff: "",
						repoHead: statusBefore.commit,
						worktreeFingerprint: "",
						repoPath: rp,
						branch: config.branch,
						message: `Push blocked while capturing files.\n${capture.errors.map((e) => `${e.file}: ${e.message}`).join("\n")}`,
					};
				}

				const status = await gitStatus(rp);
				const changedFiles = this.normalizeRepoChangedFiles(
					status.changedFiles,
					config,
				);
				if (!status.hasUncommittedChanges) {
					const head = await getHeadCommit(rp);
					return {
						kind: "noop",
						capture,
						changedFiles: [],
						diff: "",
						repoHead: head,
						worktreeFingerprint: await this.computePushFingerprint(
							rp,
							config,
							state,
						),
						repoPath: rp,
						branch: config.branch,
						message: "No changes to push.",
					};
				}

				const validation = await validateFiles(rp, config, changedFiles);
				if (validation.blocked) {
					return {
						kind: "blocked",
						capture,
						changedFiles,
						diff: await gitDiff(rp),
						repoHead: status.commit,
						worktreeFingerprint: await this.computePushFingerprint(
							rp,
							config,
							state,
						),
						repoPath: rp,
						branch: config.branch,
						message: `Push blocked: validation errors.\n${formatValidationErrors(validation.errors)}`,
					};
				}

				if (config.security.scanSecretsBeforePush) {
					const secretFindings = await this.scanForSecrets(rp, config);
					if (secretFindings.length > 0) {
						return {
							kind: "blocked",
							capture,
							changedFiles,
							diff: await gitDiff(rp),
							repoHead: status.commit,
							worktreeFingerprint: await this.computePushFingerprint(
								rp,
								config,
								state,
							),
							repoPath: rp,
							branch: config.branch,
							message: `Push blocked: potential secrets detected.\n${formatSecretsFindings(secretFindings)}`,
						};
					}
				}

				// Package preparation is read-only here. Installation belongs to the
				// apply phase after settings have been materialized.
				try {
					const packagePlan = await preparePackagePlan(
						rp,
						this.agentDir,
						config,
					);
					if (packagePlan.approvalRequired.length > 0) {
						return {
							kind: "blocked",
							capture,
							changedFiles,
							diff: await gitDiff(rp),
							repoHead: status.commit,
							worktreeFingerprint: await this.computePushFingerprint(
								rp,
								config,
								state,
							),
							repoPath: rp,
							branch: config.branch,
							message: `Package approval required before push: ${packagePlan.approvalRequired.join(", ")}`,
						};
					}
				} catch (error) {
					return {
						kind: "blocked",
						capture,
						changedFiles,
						diff: await gitDiff(rp),
						repoHead: status.commit,
						worktreeFingerprint: await this.computePushFingerprint(
							rp,
							config,
							state,
						),
						repoPath: rp,
						branch: config.branch,
						message: `Package validation failed: ${error instanceof Error ? error.message : "Unknown"}`,
					};
				}

				return {
					kind: "ready",
					capture,
					changedFiles,
					diff: await gitDiff(rp),
					repoHead: status.commit,
					worktreeFingerprint: await this.computePushFingerprint(
						rp,
						config,
						state,
					),
					repoPath: rp,
					branch: config.branch,
					message: `Push ready: ${changedFiles.length} changed file(s).`,
				};
			},
		);
	}

	/** 执行已确认的 preparation，并在执行前重新校验 HEAD/worktree 指纹。 */
	async executePush(
		preparation: PushPreparation,
		message?: string,
	): Promise<CommandResult> {
		if (preparation.kind !== "ready") return resultFromPreparation(preparation);

		return this.withCommandLock<CommandResult>(
			"push",
			() => this.busyCommandResult(),
			async () => {
				const rp = preparation.repoPath;
				const config = await loadPiSyncConfig(rp);
				const state = await loadState(this.agentDir);
				try {
					await ensureConfiguredBranch(rp, config.branch);
				} catch (error) {
					return {
						ok: false,
						code: "blocked_conflict",
						message:
							error instanceof Error
								? error.message
								: "Configured branch check failed.",
						reload: false,
					};
				}
				const currentHead = await getHeadCommit(rp);
				const currentFingerprint = await this.computePushFingerprint(
					rp,
					config,
					state,
				);
				if (
					currentHead !== preparation.repoHead ||
					currentFingerprint !== preparation.worktreeFingerprint
				) {
					return {
						ok: false,
						code: "blocked_conflict",
						message:
							"Push preparation is stale: the repository or agent changed after confirmation. Prepare push again.",
						reload: false,
					};
				}

				await gitCommit(rp, message ?? "pi-sync: update configuration");

				const integration = await integrateCommittedPush({
					repoPath: rp,
					branch: preparation.branch,
				});
				if (integration.kind === "failed") {
					return {
						ok: false,
						code: "git_failed",
						message: integration.message,
						reload: false,
					};
				}
				if (integration.kind === "rebase_conflict") {
					try {
						const paths = conflictPathsFrom(
							(await listUnmergedPaths(rp)).map((relativePath) => ({
								relativePath:
									this.normalizeRepoChangedFiles([relativePath], config)[0] ??
									relativePath,
								changeType: "git_conflict",
							})),
						);
						const branch = await this.preserveRebaseConflictOnDeviceBranch(
							rp,
							config,
						);
						if (!(await this.mergeDeviceBranchIntoShared(rp, config, branch))) {
							const conflict = await this.createSyncConflictRequest(
								rp,
								config,
								branch,
								paths,
							);
							return {
								ok: false,
								code: "blocked_conflict",
								message: this.formatManualMergeMessage(rp, config, branch),
								reload: false,
								details: { conflict },
							};
						}

						const newState = await loadState(this.agentDir);
						const applyResult = await this.applyCurrent(
							rp,
							config,
							newState,
							"push",
						);
						if (!applyResult.ok) {
							return {
								ok: false,
								code: applyResult.code,
								message:
									"Push completed, but applying the synced configuration failed.\n" +
									this.formatMergedConflictMessage(config) +
									"\n" +
									applyResult.message,
								reload: false,
							};
						}
						return {
							ok: true,
							code: "ok",
							message: `Pushed successfully.\n${this.formatMergedConflictMessage(config)}\n${applyResult.message}`,
							reload: applyResult.reload,
						};
					} catch (error) {
						return {
							ok: false,
							code: "git_failed",
							message: `Could not create or merge a current-device conflict branch: ${error instanceof Error ? error.message : "Unknown error"}`,
							reload: false,
						};
					}
				}

				try {
					await this.pushMainAndDeviceBranches(rp, preparation.branch);
				} catch (err) {
					return {
						ok: false,
						code: "git_failed",
						message: `Push failed: ${err instanceof Error ? err.message : "Unknown"}\nLocal commits are preserved.`,
						reload: false,
					};
				}

				const newState = await loadState(this.agentDir);
				const applyResult = await this.applyCurrent(
					rp,
					config,
					newState,
					"push",
				);
				if (!applyResult.ok) {
					return {
						ok: false,
						code: applyResult.code,
						message:
							"Push completed, but applying the synced configuration failed.\n" +
							applyResult.message,
						reload: false,
					};
				}

				return {
					ok: true,
					code: "ok",
					message: `Pushed successfully.\n${applyResult.message}`,
					reload: applyResult.reload,
				};
			},
		);
	}

	async push(
		repoPath?: string,
		message?: string,
		subCommand?: string,
	): Promise<CommandResult> {
		if (subCommand === "--continue") {
			const result = await this.pushContinue(repoPath);
			const successful = result.message.includes("continued successfully");
			return {
				ok: successful,
				code: successful ? "ok" : "partial_failure",
				message: result.message,
				reload: result.reload,
			};
		}
		const preparation = await this.preparePush(repoPath);
		if (preparation.kind === "noop") {
			try {
				const status = await gitStatus(preparation.repoPath);
				const hasAheadCommit = status.ahead > 0;
				if (hasAheadCommit) {
					await this.pushMainAndDeviceBranches(
						preparation.repoPath,
						preparation.branch,
					);
				} else {
					const deviceBranch = await this.getDeviceBranchName();
					const remoteDeviceRef = await gitProbe(preparation.repoPath, [
						"show-ref",
						"--hash",
						"--verify",
						`refs/remotes/origin/${deviceBranch}`,
					]);
					if (
						!remoteDeviceRef.ok ||
						remoteDeviceRef.stdout.trim() !== status.commit
					) {
						await gitPushHeadToBranch(preparation.repoPath, deviceBranch);
					}
				}
				return {
					ok: true,
					code: hasAheadCommit ? "ok" : "noop",
					message: hasAheadCommit
						? "No worktree changes; synchronized ahead commits to shared and device branches."
						: (preparation.message ??
							"No changes to push. Main and device branches are synchronized."),
					reload: false,
				};
			} catch (error) {
				return {
					ok: false,
					code: "git_failed",
					message: `Could not synchronize main and device branches: ${error instanceof Error ? error.message : "Unknown error"}`,
					reload: false,
				};
			}
		}
		if (preparation.kind !== "ready") {
			return {
				ok: false,
				code: "blocked_conflict",
				message: preparation.message ?? "Push blocked.",
				reload: false,
			};
		}
		const result = await this.executePush(preparation, message);
		return result;
	}

	/**
	 * push --continue：解决冲突后继续推送
	 */
	private async pushContinue(
		repoPath?: string,
	): Promise<{ message: string; reload: boolean }> {
		const rp = repoPath ?? (await getRepoPath());
		const config = await loadPiSyncConfig(rp);
		const state = await loadState(this.agentDir);

		if (state.pendingOperation?.type !== "push-rebase-conflict") {
			return {
				message: "No pending push operation to continue.",
				reload: false,
			};
		}

		return this.withCommandLock<{ message: string; reload: boolean }>(
			"push-continue",
			() => ({
				message: "Another sync operation is in progress.",
				reload: false,
			}),
			async () => {
				try {
					await ensureConfiguredBranch(rp, config.branch);
				} catch (error) {
					return {
						message:
							error instanceof Error
								? error.message
								: "Configured branch check failed.",
						reload: false,
					};
				}

				// 1. 确认无 unmerged paths
				if (await hasUnmergedPaths(rp)) {
					return {
						message:
							"There are still unmerged paths. Resolve all conflicts and run git add + git rebase --continue first.",
						reload: false,
					};
				}

				// 2. 确认工作树干净
				if (!(await isWorktreeClean(rp))) {
					return {
						message: "Worktree is not clean. Commit or stash changes first.",
						reload: false,
					};
				}

				// 3. 校验最终提交
				await gitDiffRange(rp, `origin/${config.branch}`, "HEAD").catch(
					() => "",
				);
				const allRepoSyncFiles = await this.getRepoSyncFiles(rp, config);

				const validation = await validateFiles(rp, config, allRepoSyncFiles);
				if (validation.blocked) {
					return {
						message: `Validation errors after conflict resolution:\n${formatValidationErrors(validation.errors)}`,
						reload: false,
					};
				}

				// 4. Secret scan
				if (config.security.scanSecretsBeforePush) {
					const secretFindings = await this.scanForSecrets(rp, config);
					if (secretFindings.length > 0) {
						return {
							message: `Push blocked: potential secrets detected.\n${formatSecretsFindings(secretFindings)}`,
							reload: false,
						};
					}
				}

				// 5. Push the shared branch and the current-device snapshot.
				try {
					await this.pushMainAndDeviceBranches(rp, config.branch);
				} catch (err) {
					return {
						message: `Push failed: ${err instanceof Error ? err.message : "Unknown"}`,
						reload: false,
					};
				}

				// 6. Apply + 更新状态
				const newState = { ...state, pendingOperation: null };
				await saveState(this.agentDir, newState);

				const applyResult = await this.applyCurrent(
					rp,
					config,
					newState,
					"push",
				);

				return {
					message: `Push continued successfully.\n${applyResult.message}`,
					reload: applyResult.reload,
				};
			},
		);
	}

	// ========== init (统一入口) ==========

	async init(
		gitUrl?: string,
		onProgress?: (message: string) => void,
		force = false,
		packageApproval?: PackageApproval,
	): Promise<InitResult> {
		const defaultPath = join(this.agentDir, "..", "config-repo");

		// 已初始化：直接 apply（force 时跳过，走 fresh 流程）
		if (!force && (await this.isAlreadyInitialized(defaultPath))) {
			return normalizeInitResult(
				await this.initAlreadyInitialized(
					defaultPath,
					onProgress,
					packageApproval,
				),
			);
		}

		// 未初始化 — 需要 gitUrl
		if (!gitUrl) {
			return normalizeInitResult({
				message:
					"Run /pisync and enter your config repo Git URL to get started.",
				needsReload: false,
				ok: false,
				code: "blocked_validation",
				details: { needsGitUrl: true },
				level: "info",
			});
		}

		// 校验 URL 格式
		if (!isValidSetupGitUrl(gitUrl)) {
			return normalizeInitResult({
				message:
					`Invalid Git URL: ${gitUrl}\n` +
					"Expected formats:\n" +
					"  git@github.com:user/repo.git\n" +
					"  https://github.com/user/repo.git",
				needsReload: false,
				ok: false,
				code: "blocked_validation",
				level: "error",
			});
		}

		return normalizeInitResult(
			await this.initFresh(
				gitUrl,
				defaultPath,
				onProgress,
				force,
				packageApproval,
			),
		);
	}

	private async initAlreadyInitialized(
		defaultPath: string,
		onProgress?: (message: string) => void,
		packageApproval?: PackageApproval,
	): Promise<InitInternalResult> {
		const acquired = await this.lock.acquire("apply", 5000);
		if (!acquired) {
			return {
				message: "Another sync operation is in progress.",
				needsReload: false,
				ok: false,
				level: "warning",
			};
		}

		try {
			const config = await loadPiSyncConfig(defaultPath);

			// Fetch latest
			onProgress?.("Fetching latest changes...");
			try {
				await gitFetch(defaultPath);
			} catch {
				/* offline */
			}

			try {
				await ensureConfiguredBranch(defaultPath, config.branch);
			} catch (error) {
				return {
					message:
						error instanceof Error
							? error.message
							: "Configured branch check failed.",
					needsReload: false,
					ok: false,
					code: "blocked_conflict",
					level: "error",
				};
			}

			const status = await gitStatus(defaultPath);
			if (status.behind > 0) {
				onProgress?.("Fast-forwarding fetched changes...");
				await gitFastForward(defaultPath, config.branch, {
					timeout: config.pullTimeoutMs,
				});
			}

			onProgress?.("Applying config to agent...");
			const state = await loadState(this.agentDir);
			const applyResult = await this.applyCurrent(
				defaultPath,
				config,
				state,
				"init",
				packageApproval,
			);

			return {
				message: `Already initialized. Applied current config.\n${applyResult.message}`,
				needsReload: applyResult.reload,
				ok: applyResult.ok,
				code: applyResult.code,
				details: applyResult.details,
				level: applyResult.ok ? "info" : "warning",
			};
		} finally {
			await this.lock.release();
		}
	}

	private async initFresh(
		gitUrl: string,
		defaultPath: string,
		onProgress?: (message: string) => void,
		force = false,
		packageApproval?: PackageApproval,
	): Promise<InitInternalResult> {
		const acquired = await this.lock.acquire("init", 5000);
		if (!acquired) {
			return {
				message: "Another sync operation is in progress.",
				needsReload: false,
				ok: false,
				level: "warning",
			};
		}

		try {
			return await executeSetupFlow({
				agentDir: this.agentDir,
				gitUrl,
				repoPath: defaultPath,
				force,
				packageApproval,
				onProgress,
				captureInitialLocalConfig: (repoPath, config) =>
					this.captureInitialLocalConfig(repoPath, config),
				createRepositoryBaseline: (repoPath, config, state) =>
					this.createRepositoryBaseline(repoPath, config, state),
				applyCurrent: (repoPath, config, state, reason, approval) =>
					this.applyCurrent(repoPath, config, state, reason, approval),
				getDeviceBranchName: () => this.getDeviceBranchName(),
				pushMainAndDeviceBranches: (repoPath, branch) =>
					this.pushMainAndDeviceBranches(repoPath, branch),
			});
		} finally {
			await this.lock.release();
		}
	}

	private async isAlreadyInitialized(_repoPath: string): Promise<boolean> {
		try {
			const state = await loadState(this.agentDir);
			if (!state.repoPath || !existsSync(state.repoPath)) return false;
			if (!existsSync(join(state.repoPath, ".git"))) return false;
			if (!existsSync(join(state.repoPath, "pi-sync.json"))) return false;
			return true;
		} catch {
			return false;
		}
	}

	// ========== debug: clear-repo ==========

	async clearRepo(
		repoPath?: string,
	): Promise<{ message: string; reload: boolean }> {
		const rp = repoPath ?? (await getRepoPathSafe(this.agentDir));
		if (!rp) return { message: "No config repo configured.", reload: false };

		const acquired = await this.lock.acquire("clear-repo", 5000);
		if (!acquired) {
			return {
				message: "Another sync operation is in progress.",
				reload: false,
			};
		}

		try {
			const lines: string[] = [];
			const config = await loadPiSyncConfig(rp);
			await ensureConfiguredBranch(rp, config.branch);
			// 1. 清空本地仓库内容（保留 .git）
			lines.push("Clearing local repo contents...");
			await clearRepoContents(rp);

			// 2. 提交清空操作
			lines.push("Committing clear...");
			await gitExec(rp, ["add", "-A"]);
			await gitExec(rp, ["commit", "-m", "debug: clear repo", "--allow-empty"]);

			// 3. 强制推送到远端以清空远端仓库
			lines.push("Force pushing to remote...");
			await gitExec(rp, ["push", "--force", "origin", config.branch]);

			// 4. 清空本地同步状态
			lines.push("Clearing local sync state...");
			await saveState(this.agentDir, {
				schemaVersion: 3,
				repoPath: "",
				branch: "main",
				lastSyncedCommit: null,
				lastSyncedAt: null,
				files: {},
				pendingOperation: null,
				lastBackup: null,
				deviceId: null,
			});

			lines.push("Repo cleared successfully (local + remote).");
			return { message: lines.join("\n"), reload: true };
		} catch (err) {
			return {
				message: `Clear repo failed: ${err instanceof Error ? err.message : "Unknown error"}`,
				reload: false,
			};
		} finally {
			await this.lock.release();
		}
	}

	// ========== Private: applyCurrent ==========

	/**
	 * 将当前 repo 状态应用到 agent（v0.2: 使用完整 nextBaseline 替换）
	 */
	/**
	 * Treat the freshly scaffolded repository as the baseline for the initiating
	 * machine only. This turns a local settings.json plus the scaffold placeholder
	 * into a local-only change, so first-run capture can safely preserve the
	 * user's configuration without persisting a partial baseline.
	 */
	private async captureInitialLocalConfig(
		repoPath: string,
		config: PiSyncConfig,
	): Promise<Awaited<ReturnType<typeof captureChanges>>> {
		const emptyState: SyncState = {
			schemaVersion: 3,
			repoPath,
			branch: config.branch,
			lastSyncedCommit: null,
			lastSyncedAt: null,
			files: {},
			pendingOperation: null,
			lastBackup: null,
			deviceId: null,
		};
		const scaffoldState = await this.createRepositoryBaseline(
			repoPath,
			config,
			emptyState,
		);
		return captureChanges(this.agentDir, repoPath, config, scaffoldState);
	}

	/**
	 * Repair a legacy first-run scaffold without making existing repositories
	 * ambiguous: only an uninitialized state plus the exact generated settings
	 * placeholder is treated as a local-source bootstrap.
	 */
	private async captureWithScaffoldCalibration(
		repoPath: string,
		config: PiSyncConfig,
		state: SyncState,
		preferLocalOnConflicts = false,
	): Promise<Awaited<ReturnType<typeof captureChanges>>> {
		const shouldCalibrate =
			state.lastSyncedCommit === null &&
			state.pendingOperation === null &&
			Object.keys(state.files).length === 0 &&
			(await this.hasScaffoldSettingsPlaceholder(repoPath, config));
		const captureState = shouldCalibrate
			? await this.createRepositoryBaseline(repoPath, config, state)
			: state;

		return captureChanges(this.agentDir, repoPath, config, captureState, {
			preferLocalOnConflicts,
		});
	}

	/**
	 * A dirty worktree on the exact commit recorded by the baseline contains
	 * local capture staging, not a committed repository-side change. Refresh it
	 * from the agent so retries cannot turn two snapshots from this device into
	 * a bilateral conflict. Committed HEAD changes still use strict comparison.
	 */
	private shouldRefreshLocalCapture(
		status: Awaited<ReturnType<typeof gitStatus>>,
		state: SyncState,
	): boolean {
		return (
			status.hasUncommittedChanges &&
			state.lastSyncedCommit !== null &&
			status.commit === state.lastSyncedCommit
		);
	}

	private async hasScaffoldSettingsPlaceholder(
		repoPath: string,
		config: PiSyncConfig,
	): Promise<boolean> {
		try {
			const syncRoot = await resolveRepoSyncRoot(repoPath, config.root, "read");
			const settingsPath = await resolveWithinRoot(
				syncRoot,
				"settings.json",
				"read",
			);
			const parsed: unknown = JSON.parse(await readFile(settingsPath, "utf-8"));
			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
				return false;

			const settings = parsed as Record<string, unknown>;
			return (
				Object.keys(settings).length === 1 &&
				Array.isArray(settings.packages) &&
				settings.packages.length === 1 &&
				settings.packages[0] === "npm:@jachy/pi-git-sync"
			);
		} catch {
			return false;
		}
	}

	private async createRepositoryBaseline(
		repoPath: string,
		config: PiSyncConfig,
		state: SyncState,
	): Promise<SyncState> {
		const inventory = await compareFiles(this.agentDir, repoPath, config, {
			...state,
			files: {},
		});
		return {
			...state,
			files: Object.fromEntries(
				inventory.comparisons.flatMap((comparison) =>
					comparison.remote
						? [
								[
									comparison.relativePath,
									{
										sha256: comparison.remote.sha256,
										mode: comparison.remote.mode,
									},
								],
							]
						: [],
				),
			),
		};
	}

	private async applyCurrent(
		rp: string,
		config: PiSyncConfig,
		state: SyncState,
		reason: string,
		packageApproval?: PackageApproval,
		automaticConflictResolutionAttempted = false,
		useRemoteForConflicts?: ReadonlySet<string>,
	): Promise<CommandResult> {
		const commit = await getHeadCommit(rp);

		// 1. 生成 apply 计划（包含完整 nextBaseline）
		const plan = await planMaterialize(this.agentDir, rp, config, state, {
			useRemoteForConflicts,
		});

		if (plan.blocked) {
			const errorLines: string[] = [];
			let conflictRequest: SyncConflictRequest | undefined;
			if (plan.conflicts.length > 0 && automaticConflictResolutionAttempted) {
				return {
					ok: false,
					code: "blocked_conflict",
					message: `Conflict remained after automatic resolution: ${plan.conflicts.map((conflict) => conflict.relativePath).join(", ")}`,
					reload: false,
					details: { conflicts: plan.conflicts },
				};
			}
			if (plan.conflicts.length > 0) {
				try {
					const coordination = await this.coordinateDeviceBranchConflict(
						rp,
						config,
						state,
						conflictPathsFrom(plan.conflicts),
					);
					if (coordination.kind === "resolved") {
						const resolved = await this.applyCurrent(
							rp,
							config,
							state,
							reason,
							packageApproval,
							true,
						);
						return {
							...resolved,
							message: `${coordination.message}\n${resolved.message}`,
						};
					}
					conflictRequest = coordination.conflict;
					errorLines.push(coordination.message);
				} catch (error) {
					errorLines.push(
						`Could not create a current-device conflict branch: ${error instanceof Error ? error.message : "Unknown error"}`,
					);
				}
			}
			if (plan.validationErrors.length > 0) {
				errorLines.push(formatValidationErrors(plan.validationErrors));
			}
			return {
				ok: false,
				code:
					plan.conflicts.length > 0 ? "blocked_conflict" : "blocked_validation",
				message: errorLines.join("\n"),
				reload: false,
				details: {
					conflict: conflictRequest,
					conflicts: plan.conflicts,
					validationErrors: plan.validationErrors,
				},
			};
		}

		// 2. 只读取并计划 package 变化。审批必须发生在 settings 写入前，
		//    但实际安装要延迟到 materialize 成功之后。
		let packagePlan: Awaited<ReturnType<typeof preparePackagePlan>>;
		try {
			packagePlan = await preparePackagePlan(rp, this.agentDir, config);
		} catch (error) {
			return {
				ok: false,
				code: "blocked_validation",
				message: `Package validation failed: ${error instanceof Error ? error.message : "Unknown"}`,
				reload: false,
			};
		}
		if (packagePlan.approvalRequired.length > 0) {
			if (
				!packageApproval ||
				!approvePackagePlan(packagePlan, packageApproval).approved
			) {
				return {
					ok: false,
					code: "approval_required",
					message: `Package approval required before applying settings: ${packagePlan.approvalRequired.join(", ")}`,
					reload: false,
					details: { packages: packagePlan.approvalRequired },
				};
			}
		}
		return executeApplyTransaction({
			agentDir: this.agentDir,
			commit,
			config,
			state,
			reason,
			plan,
			packagePlan,
			packageApproval,
		});
	}

	private normalizeRepoChangedFiles(
		changedFiles: string[],
		config: PiSyncConfig,
	): string[] {
		const prefix = `${config.root.replace(/\\/g, "/")}/`;
		return changedFiles
			.map((file) => file.replace(/\\/g, "/"))
			.map((file) =>
				file.startsWith(prefix) ? file.slice(prefix.length) : file,
			)
			.filter((file) => file.length > 0 && !file.includes(" -> "));
	}

	private async computePushFingerprint(
		rp: string,
		config: PiSyncConfig,
		state: SyncState,
	): Promise<string> {
		const inventory = await compareFiles(this.agentDir, rp, config, state);
		const status = await gitStatus(rp);
		const diff = await gitDiff(rp);
		const files = inventory.comparisons.map((comparison) => ({
			path: comparison.relativePath,
			type: comparison.changeType,
			local: comparison.local?.sha256 ?? "absent",
			remote: comparison.remote?.sha256 ?? "absent",
			baseline: comparison.baseline?.sha256 ?? "absent",
		}));
		return sha256(
			JSON.stringify({
				head: status.commit,
				changedFiles: status.changedFiles,
				diff,
				files,
			}),
		);
	}

	// ========== Secret scan 辅助 ==========

	private async scanForSecrets(
		rp: string,
		config: PiSyncConfig,
	): Promise<Array<{ type: string; file: string; line?: number }>> {
		const findings: Array<{ type: string; file: string; line?: number }> = [];

		// 扫描 staged diff
		try {
			const stagedDiff = await gitDiffStaged(rp);
			if (stagedDiff) {
				findings.push(...scanSecrets(stagedDiff, "staged-diff"));
			}
		} catch {
			/* best-effort: staged diff scan is non-critical */
		}

		// 扫描变更的完整文件
		try {
			const safeRoot = await resolveRepoSyncRoot(rp, config.root, "read");
			const syncRoot = safeRoot.path;
			const { readdir: rd } = await import("node:fs/promises");
			const { isPathAllowed } = await import("./glob.ts");

			async function walk(dir: string): Promise<void> {
				if (!existsSync(dir)) return;
				let entries;
				try {
					entries = await rd(dir, { withFileTypes: true });
				} catch {
					return;
				}
				for (const entry of entries) {
					const fullPath = join(dir, entry.name);
					const relPath = fullPath
						.replace(syncRoot + "/", "")
						.replace(syncRoot, "");
					if (entry.name.startsWith(".")) continue;
					if (entry.isSymbolicLink())
						throw new Error(`Refusing to scan symbolic link: ${fullPath}`);
					if (entry.isDirectory()) {
						await walk(fullPath);
						continue;
					}
					if (!entry.isFile()) continue;

					const allowed = isPathAllowed(
						relPath,
						config.include,
						config.exclude,
					);
					if (!allowed.allowed) continue;

					try {
						const content = await readFile(fullPath, "utf-8");
						findings.push(...scanSecrets(content, relPath));
					} catch {
						/* best-effort: individual file scan failure doesn't block */
					}
				}
			}

			await walk(syncRoot);
		} catch {
			/* best-effort: full file scan is non-critical */
		}

		return findings;
	}

	private async getRepoSyncFiles(
		rp: string,
		config: PiSyncConfig,
	): Promise<string[]> {
		const safeRoot = await resolveRepoSyncRoot(rp, config.root, "read");
		const syncRoot = safeRoot.path;
		const files: string[] = [];
		const { readdir: rd } = await import("node:fs/promises");

		async function walk(dir: string): Promise<void> {
			if (!existsSync(dir)) return;
			let entries;
			try {
				entries = await rd(dir, { withFileTypes: true });
			} catch {
				return;
			}
			for (const entry of entries) {
				const fullPath = join(dir, entry.name);
				const relPath = fullPath
					.replace(syncRoot + "/", "")
					.replace(syncRoot, "");
				if (entry.name.startsWith(".")) continue;
				if (entry.isSymbolicLink())
					throw new Error(`Refusing to enumerate symbolic link: ${fullPath}`);
				if (entry.isDirectory()) {
					await walk(fullPath);
					continue;
				}
				if (entry.isFile()) files.push(relPath);
			}
		}

		await walk(syncRoot);
		return files;
	}
}
