/**
 * TUI 展示和格式化（schema v2）
 *
 * 为各种命令生成格式化的展示输出
 */
import type { GitStatus } from "./git.ts";
import type { DoctorResult } from "./doctor.ts";
import type { PackageDiff } from "./packages.ts";
import type { PiSyncConfig } from "./config.ts";
import type { SyncState } from "./state.ts";
import type { FileComparison, InventoryResult } from "./inventory.ts";
import type { CaptureResult } from "./capture.ts";
import type { ValidationError } from "./validate.ts";

// ========== Git Status 格式化 ==========

export function formatGitStatus(status: GitStatus): string {
  const lines: string[] = [
    `Branch:          ${status.branch}`,
    `Commit:          ${status.commitShort} (${status.commit})`,
    `Remote:          ${status.remoteExists ? "origin" : "none"}`,
  ];

  if (status.remoteExists) {
    const arrows: string[] = [];
    if (status.ahead > 0) arrows.push(`↑${status.ahead}`);
    if (status.behind > 0) arrows.push(`↓${status.behind}`);
    if (arrows.length === 0) arrows.push("up to date");
    lines.push(`Sync:            ${arrows.join(" ")}`);
  }

  lines.push(`Uncommitted:     ${status.hasUncommittedChanges ? "YES" : "no"}`);

  if (status.isRebasing) lines.push(`Rebasing:        YES`);
  if (status.isMerging) lines.push(`Merging:         YES`);
  if (status.hasConflicts) lines.push(`Conflicts:       YES (${status.conflictedFiles.length} files)`);

  if (status.changedFiles.length > 0) {
    lines.push(`Changed files (${status.changedFiles.length}):`);
    for (const f of status.changedFiles.slice(0, 20)) {
      lines.push(`  ${f}`);
    }
    if (status.changedFiles.length > 20) {
      lines.push(`  ... and ${status.changedFiles.length - 20} more`);
    }
  }

  return lines.join("\n");
}

// ========== 同步状态 v2 ==========

export interface SyncStatusV2Input {
  repoPath: string;
  gitStatus: GitStatus;
  config: PiSyncConfig;
  inventory: InventoryResult;
  state: SyncState;
  pkgDiff?: PackageDiff;
}

export function formatSyncStatusV2(input: SyncStatusV2Input): string {
  const { repoPath, gitStatus: gs, config, inventory, state, pkgDiff } = input;

  const lines: string[] = ["=== pi-git-sync Status ===", ""];

  // Git 摘要
  lines.push(`  repo       ${repoPath}`);
  lines.push(`  git        ${gs.branch} @ ${gs.commitShort}` +
    (gs.remoteExists
      ? `  ${gs.ahead > 0 ? `↑${gs.ahead}` : "↑0"} ${gs.behind > 0 ? `↓${gs.behind}` : "↓0"}`
      : "  (no remote)") +
    (gs.hasUncommittedChanges ? `  dirty(${gs.changedFiles.length})` : "  clean") +
    (gs.hasConflicts ? "  CONFLICTS" : ""));

  // 上次同步
  if (state.lastSyncedAt) {
    const when = formatTimestamp(state.lastSyncedAt);
    const short = state.lastSyncedCommit?.substring(0, 7) ?? "?";
    lines.push(`  synced     ${when} (${short})`);
  } else {
    lines.push(`  synced     never`);
  }
  lines.push("");

  // Managed (synced)
  lines.push("Managed (synced)");
  lines.push(`  root       ${config.root}/`);
  lines.push(`  include    ${config.include.length} patterns`);
  lines.push(`  exclude    ${config.exclude.length} patterns`);
  lines.push(`  delete     ${config.delete}`);
  if (pkgDiff) {
    lines.push(`  packages   ${pkgDiff.unchanged.length} synced`);
  }
  lines.push("");

  // Pending 变更摘要
  const pending = formatInventorySummary(inventory);
  if (pending) {
    lines.push("Pending");
    lines.push(pending);
  } else {
    lines.push("Up to date — no pending changes.");
  }

  // 详细变更列表
  const detail = formatInventoryDetail(inventory);
  if (detail) {
    lines.push("");
    lines.push(detail);
  }

  return lines.join("\n").replace(/\n+$/, "");
}

// ========== 文件比较 diff ==========

export function formatComparisonDiff(comparisons: FileComparison[]): string {
  if (comparisons.length === 0) return "No files to compare.";

  const lines: string[] = [];
  let hasContent = false;

  for (const comp of comparisons) {
    const icon = changeTypeIcon(comp.changeType);
    const label = changeTypeLabel(comp.changeType);

    if (comp.changeType === "no_change") continue;
    hasContent = true;

    lines.push(`  ${icon} ${comp.relativePath}  [${label}]`);

    if (
      comp.changeType === "local_only" ||
      comp.changeType === "remote_only" ||
      comp.changeType === "both_modified"
    ) {
      if (comp.local && comp.remote) {
        lines.push(`    local:  ${comp.local.sha256.substring(0, 12)}...`);
        lines.push(`    remote: ${comp.remote.sha256.substring(0, 12)}...`);
      }
    }
  }

  if (!hasContent) return "No changes detected.";
  return lines.join("\n");
}

// ========== Inventory 摘要 ==========

function formatInventorySummary(inventory: InventoryResult): string {
  const s = inventory.summary;
  const parts: string[] = [];

  if (s.localOnly > 0 || s.localCreated > 0 || s.localDeleted > 0) {
    parts.push(`agent changes: ${s.localOnly} modified, ${s.localCreated} new, ${s.localDeleted} deleted`);
  }
  if (s.remoteOnly > 0 || s.remoteCreated > 0 || s.remoteDeleted > 0) {
    parts.push(`repo changes: ${s.remoteOnly} modified, ${s.remoteCreated} new, ${s.remoteDeleted} deleted`);
  }
  if (s.bothModified > 0) {
    parts.push(`CONFLICTS: ${s.bothModified} files modified on both sides`);
  }
  if (s.converged > 0) {
    parts.push(`${s.converged} converged`);
  }

  return parts.length > 0 ? "  " + parts.join("\n  ") : "";
}

// ========== Inventory 详情 ==========

function formatInventoryDetail(inventory: InventoryResult): string {
  const interesting = inventory.comparisons.filter(
    (c) => c.changeType !== "no_change",
  );

  if (interesting.length === 0) return "";

  const lines: string[] = ["Changes:"];
  for (const comp of interesting) {
    const icon = changeTypeIcon(comp.changeType);
    const label = changeTypeLabel(comp.changeType);
    lines.push(`  ${icon} ${comp.relativePath}  (${label})`);
  }

  return lines.join("\n");
}

// ========== 变更类型图标和标签 ==========

function changeTypeIcon(type: string): string {
  switch (type) {
    case "no_change": return " ";
    case "local_only": return "L";
    case "remote_only": return "R";
    case "converged": return "=";
    case "both_modified": return "!";
    case "local_created": return "+";
    case "remote_created": return "+";
    case "local_deleted": return "-";
    case "remote_deleted": return "-";
    case "both_deleted": return "~";
    case "local_modified_remote_deleted": return "!";
    case "local_deleted_remote_modified": return "!";
    case "untracked_local": return "?";
    default: return "?";
  }
}

function changeTypeLabel(type: string): string {
  switch (type) {
    case "no_change": return "unchanged";
    case "local_only": return "agent modified";
    case "remote_only": return "repo modified";
    case "converged": return "converged";
    case "both_modified": return "BOTH MODIFIED";
    case "local_created": return "agent new";
    case "remote_created": return "repo new";
    case "local_deleted": return "agent deleted";
    case "remote_deleted": return "repo deleted";
    case "both_deleted": return "both deleted";
    case "local_modified_remote_deleted": return "CONFLICT: agent mod / repo del";
    case "local_deleted_remote_modified": return "CONFLICT: agent del / repo mod";
    case "untracked_local": return "untracked";
    default: return type;
  }
}

// ========== Settings 变更 ==========

export function formatSettingsChanges(
  changes: Record<string, { before: unknown; after: unknown }>,
): string {
  if (Object.keys(changes).length === 0) return "No settings changes.";

  const lines: string[] = ["Settings changes:"];
  for (const [key, change] of Object.entries(changes)) {
    const beforeStr = change.before === undefined ? "(not set)" : JSON.stringify(change.before);
    const afterStr = JSON.stringify(change.after);
    const truncateLen = 80;
    const b = beforeStr.length > truncateLen ? beforeStr.slice(0, truncateLen) + "..." : beforeStr;
    const a = afterStr.length > truncateLen ? afterStr.slice(0, truncateLen) + "..." : afterStr;
    lines.push(`  ${key}:`);
    lines.push(`    - ${b}`);
    lines.push(`    + ${a}`);
  }
  return lines.join("\n");
}

// ========== Doctor ==========

export function formatDoctorResult(result: DoctorResult): string {
  const lines: string[] = [
    `Diagnostic Results: ${result.summary.ok} ok, ${result.summary.warning} warning(s), ${result.summary.error} error(s)`,
    "",
  ];

  for (const check of result.checks) {
    const icon = check.status === "ok" ? "✓" : check.status === "warning" ? "⚠" : "✗";
    const prefix = check.status === "error" ? "ERROR" : check.status === "warning" ? "WARN" : " OK ";
    lines.push(`  [${prefix}] ${icon} ${check.name}: ${check.message}`);
  }

  return lines.join("\n");
}

// ========== 秘密扫描 ==========

export function formatSecretsFindings(
  findings: Array<{ type: string; file: string; line?: number }>,
): string {
  if (findings.length === 0) return "No secrets detected.";

  const lines: string[] = [
    `⚠ WARNING: ${findings.length} potential secret(s) found:`,
    "",
  ];
  for (const finding of findings) {
    const lineInfo = finding.line ? `:${finding.line}` : "";
    lines.push(`  [${finding.type}] ${finding.file}${lineInfo}`);
  }
  return lines.join("\n");
}

// ========== 备份列表 ==========

export function formatBackupList(
  backups: Array<{ timestamp: string; commit: string; reason: string }>,
): string {
  if (backups.length === 0) return "No backups available.";

  const lines: string[] = ["Available backups:"];
  for (let i = 0; i < backups.length; i++) {
    const b = backups[i]!;
    const date = b.timestamp.replace("T", " ").replace(/-\d{2}-\d{2}$/, "");
    lines.push(`  [${i}] ${date} - ${b.commit.substring(0, 7)} - ${b.reason}`);
  }
  return lines.join("\n");
}

// ========== Package diff ==========

export function formatPackageDiff(diff: PackageDiff): string {
  if (diff.added.length === 0 && diff.removed.length === 0 && diff.changed.length === 0) {
    return "No package changes.";
  }

  const lines: string[] = [];
  if (diff.added.length > 0) {
    lines.push(`  Packages to install (${diff.added.length}):`);
    for (const pkg of diff.added) lines.push(`    + ${pkg}`);
  }
  if (diff.removed.length > 0) {
    lines.push(`  Local-only packages (not auto-removed) (${diff.removed.length}):`);
    for (const pkg of diff.removed) lines.push(`    - ${pkg}`);
  }
  if (diff.changed.length > 0) {
    lines.push(`  Packages to update (${diff.changed.length}):`);
    for (const pkg of diff.changed) lines.push(`    ~ ${pkg}`);
  }
  if (diff.unchanged.length > 0) {
    lines.push(`  Packages unchanged: ${diff.unchanged.length}`);
  }
  return lines.join("\n");
}

// ========== 校验错误 ==========

export function formatValidationErrors(errors: ValidationError[]): string {
  if (errors.length === 0) return "No validation errors.";

  const lines: string[] = ["Validation errors:"];
  for (const err of errors) {
    const prefix = err.severity === "error" ? "ERROR" : "WARN";
    lines.push(`  [${prefix}] ${err.file}: ${err.message}`);
  }
  return lines.join("\n");
}

// ========== Capture 结果 ==========

export function formatCaptureResult(result: CaptureResult): string {
  const lines: string[] = [];

  if (result.hasConflicts) {
    lines.push("Capture blocked: bilateral modifications detected.");
    lines.push("Conflicts:");
    for (const c of result.conflicts) {
      lines.push(`  ${c.relativePath}`);
    }
    return lines.join("\n");
  }

  lines.push("Capture complete:");

  if (result.captured.length > 0) {
    lines.push(`  Captured (${result.captured.length}):`);
    for (const f of result.captured) lines.push(`    + ${f}`);
  }

  if (result.deleted.length > 0) {
    lines.push(`  Deleted from repo (${result.deleted.length}):`);
    for (const f of result.deleted) lines.push(`    - ${f}`);
  }

  if (result.denied.length > 0) {
    lines.push(`  Denied (${result.denied.length}):`);
    for (const f of result.denied) lines.push(`    ! ${f}`);
  }

  if (result.errors.length > 0) {
    lines.push(`  Errors (${result.errors.length}):`);
    for (const e of result.errors) lines.push(`    x ${e.file}: ${e.message}`);
  }

  if (
    result.captured.length === 0 &&
    result.deleted.length === 0 &&
    result.errors.length === 0
  ) {
    lines.push("  No changes to capture.");
  }

  return lines.join("\n");
}

// ========== 辅助 ==========

function formatTimestamp(iso: string): string {
  const m = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.exec(iso);
  return m ? m[0]!.replace("T", " ") : iso;
}
