export type ResultCode =
  | "ok"
  | "noop"
  | "blocked_conflict"
  | "blocked_validation"
  | "blocked_secret"
  | "approval_required"
  | "git_failed"
  | "partial_failure";

export interface CommandResult {
  ok: boolean;
  code: ResultCode;
  message: string;
  reload: boolean;
  details?: unknown;
}
