/**
 * TUI 提示和 diff 展示
 *
 * 为各种命令生成格式化的展示输出
 */
import type {
  GitStatus,
  GitDiff,
} from "./git.ts";
import type { DoctorResult } from "./doctor.ts";
import type { PackageDiff } from "./packages.ts";

/**
 * 格式化 git status 展示
 */
export function formatGitStatus(status: GitStatus): string {
  const lines: string[] = [
    `Branch:          ${status.branch}`,
    `Commit:          ${status.commitShort} (${status.commit})`,
    `Remote:          ${status.remoteExists ? "origin" : "none"}`,
  ];

  if (status.remoteExists) {
    if (status.ahead > 0) {
      lines.push(`Ahead:           +${status.ahead} commit(s)`);
    }
    if (status.behind > 0) {
      lines.push(`Behind:          -${status.behind} commit(s)`);
    }
    if (status.ahead === 0 && status.behind === 0) {
      lines.push(`Sync:            up to date`);
    }
  }

  lines.push(`Uncommitted:     ${status.hasUncommittedChanges ? "YES" : "no"}`);

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

/**
 * 格式化 file diff 展示
 */
export function formatFileDiffs(diffs: GitDiff[]): string {
  if (diffs.length === 0) {
    return "No file changes.";
  }

  const lines: string[] = ["Changes to be applied:"];
  for (const diff of diffs) {
    const icon = { added: "+", modified: "M", deleted: "-", renamed: "R" }[diff.status];
    const path = diff.status === "renamed" && diff.oldPath
      ? `${diff.oldPath} → ${diff.path}`
      : diff.path;
    lines.push(`  ${icon} ${path}`);
  }
  return lines.join("\n");
}

/**
 * 格式化 settings 变更展示
 */
export function formatSettingsChanges(
  changes: Record<string, { before: unknown; after: unknown }>,
): string {
  if (Object.keys(changes).length === 0) {
    return "No settings changes.";
  }

  const lines: string[] = ["Settings changes:"];
  for (const [key, change] of Object.entries(changes)) {
    const beforeStr = change.before === undefined
      ? "(not set)"
      : JSON.stringify(change.before);
    const afterStr = JSON.stringify(change.after);

    // Truncate long values
    const truncateLen = 80;
    const b = beforeStr.length > truncateLen ? beforeStr.slice(0, truncateLen) + "..." : beforeStr;
    const a = afterStr.length > truncateLen ? afterStr.slice(0, truncateLen) + "..." : afterStr;

    lines.push(`  ${key}:`);
    lines.push(`    - ${b}`);
    lines.push(`    + ${a}`);
  }
  return lines.join("\n");
}

/**
 * 格式化 doctor 结果展示
 */
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

/**
 * 格式化同步状态摘要
 */
export function formatSyncStatus(
  repoStatus: GitStatus,
  settingsChanges: Record<string, { before: unknown; after: unknown }>,
  fileChanges: Record<string, { action: string; diff?: string }>,
  lastApplied: string | null,
  pkgDiff?: PackageDiff,
): string {
  const lines: string[] = ["=== pi-git-sync Status ===", ""];

  // Git 状态
  lines.push("--- Git ---");
  lines.push(formatGitStatus(repoStatus));
  lines.push("");

  // 上次同步
  lines.push("--- Last Sync ---");
  if (lastApplied) {
    lines.push(`Last applied: ${lastApplied}`);
  } else {
    lines.push("Last applied: never");
  }
  lines.push("");

  // Settings 变更
  lines.push("--- Pending Settings Changes ---");
  lines.push(formatSettingsChanges(settingsChanges));
  lines.push("");

  // 文件变更
  lines.push("--- Pending File Changes ---");
  if (Object.keys(fileChanges).length === 0) {
    lines.push("No file changes pending.");
  } else {
    for (const [file, change] of Object.entries(fileChanges)) {
      const icon = {
        will_create: "+",
        will_update: "M",
        unchanged: "=",
        source_missing: "!",
      }[change.action] ?? "?";

      const detail = change.diff ? ` (${change.diff})` : "";
      lines.push(`  ${icon} ${file}${detail}`);
    }
  }
  lines.push("");

  // Package 变更
  if (pkgDiff) {
    lines.push("--- Package Changes ---");
    lines.push(formatPackageDiff(pkgDiff));
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * 格式化秘密扫描结果
 */
export function formatSecretsFindings(
  findings: Array<{ type: string; file: string; line?: number }>,
): string {
  if (findings.length === 0) {
    return "No secrets detected.";
  }

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

/**
 * 格式化 rollback 备份列表
 */
/**
 * 格式化 package diff 展示
 */
export function formatPackageDiff(diff: PackageDiff): string {
  if (diff.added.length === 0 && diff.removed.length === 0 && diff.changed.length === 0) {
    return "No package changes.";
  }

  const lines: string[] = [];
  if (diff.added.length > 0) {
    lines.push(`  Packages to install (${diff.added.length}):`);
    for (const pkg of diff.added) {
      lines.push(`    + ${pkg}`);
    }
  }
  if (diff.removed.length > 0) {
    lines.push(`  Local-only packages (not auto-removed) (${diff.removed.length}):`);
    for (const pkg of diff.removed) {
      lines.push(`    - ${pkg}`);
    }
  }
  if (diff.changed.length > 0) {
    lines.push(`  Packages to update (${diff.changed.length}):`);
    for (const pkg of diff.changed) {
      lines.push(`    ~ ${pkg}`);
    }
  }
  if (diff.unchanged.length > 0) {
    lines.push(`  Packages unchanged: ${diff.unchanged.length}`);
  }
  return lines.join("\n");
}

/**
 * 格式化 rollback 备份列表
 */
export function formatBackupList(
  backups: Array<{
    timestamp: string;
    commit: string;
    reason: string;
  }>,
): string {
  if (backups.length === 0) {
    return "No backups available.";
  }

  const lines: string[] = ["Available backups:"];
  for (let i = 0; i < backups.length; i++) {
    const b = backups[i]!;
    const date = b.timestamp.replace("T", " ").replace(/-\d{2}-\d{2}$/, "");
    lines.push(`  [${i}] ${date} - ${b.commit.substring(0, 7)} - ${b.reason}`);
  }
  return lines.join("\n");
}
