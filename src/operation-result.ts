import type { PackageApproval } from "./packages.ts";

export type ResultCode =
	| "ok"
	| "noop"
	| "blocked_conflict"
	| "blocked_validation"
	| "blocked_secret"
	| "approval_required"
	| "git_failed"
	| "partial_failure";

export type RunMode = "setup" | "sync" | "recovery";
export type SyncPhase = "preflight" | "pull" | "apply" | "push" | "complete";

export interface RunOptions {
	gitUrl?: string;
	packageApproval?: PackageApproval;
	/** Cancels nested subprocesses when the user aborts or a deadline fires. */
	signal?: AbortSignal;
	onProgress?: (phase: SyncPhase, message: string) => void;
	/** Starts a UI-level fail-safe independent of the child-process timeout. */
	onGitCommandStart?: (
		phase: SyncPhase,
		command: string,
		timeoutMs: number,
	) => void;
}

export interface RunResult extends CommandResult {
	mode: RunMode;
	phase: SyncPhase;
	details?: {
		needsGitUrl?: boolean;
		pull?: CommandResult;
		push?: CommandResult;
		approvalRequired?: string[];
		reason?: string;
		[key: string]: unknown;
	};
}

export interface CommandResult {
	ok: boolean;
	code: ResultCode;
	message: string;
	reload: boolean;
	details?: unknown;
}
