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
import type { PiSyncConfig } from "./config.ts";

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
 * 同步状态摘要的输入参数
 */
export interface SyncStatusInput {
  status: GitStatus;
  config: PiSyncConfig;
  settingsChanges: Record<string, { before: unknown; after: unknown }>;
  fileChanges: Record<string, { action: string; diff?: string }>;
  /** 已管理的 settings key 列表（来自 state） */
  managedSettings: string[];
  lastAppliedCommit: string | null;
  lastAppliedAt: string | null;
  /** Pi 包加载的内容目录及其条目数量（extensions/ skills/ prompts/ themes …） */
  dirs: Array<{ dir: string; count: number }>;
  pkgDiff?: PackageDiff;
}

/**
 * 格式化同步状态摘要
 *
 * 设计取舍：
 * 1. Git 状态压缩为单行，去掉对齐 padding 与 changed-files 列表（diff 命令已覆盖）。
 * 2. 新增 “Managed (synced)” 区块：一行一类，让人一眼看出本机到底同步了什么。
 * 3. 文件按单字符图标内联展示同步状态，避免把每个文件单独占一行。
 * 4. “Pending” 区块只在确实有变更时出现；完全同步时退化为单行提示。
 */
export function formatSyncStatus(input: SyncStatusInput): string {
  const {
    status: repoStatus,
    config,
    settingsChanges,
    fileChanges,
    managedSettings,
    lastAppliedCommit,
    lastAppliedAt,
    dirs,
    pkgDiff,
  } = input;

  const lines: string[] = ["=== pi-git-sync Status ===", ""];

  // ---- Git + 上次同步：压缩为两行 ----
  lines.push("  " + formatGitLine(repoStatus));
  lines.push("  last applied " + formatLastApplied(lastAppliedCommit, lastAppliedAt));
  lines.push("");

  // ---- Managed (synced)：本机同步了哪些内容 ----
  lines.push("Managed (synced)");
  lines.push("  " + formatManaged(config, fileChanges, managedSettings, dirs, pkgDiff));
  lines.push("");

  // ---- Pending：仅在确实有变更时展示 ----
  const pending = formatPending(settingsChanges, fileChanges, pkgDiff);
  if (pending) {
    lines.push("Pending");
    lines.push(pending);
  } else {
    lines.push("Up to date — no pending changes.");
  }

  return lines.join("\n").replace(/\n+$/, "");
}

/**
 * 单行 Git 摘要：branch @ short  ↑N ↓N  clean/dirty(N)
 */
function formatGitLine(s: GitStatus): string {
  let line = `${s.branch} @ ${s.commitShort}`;
  if (s.remoteExists) {
    const arrows: string[] = [];
    if (s.ahead > 0) arrows.push(`↑${s.ahead}`);
    if (s.behind > 0) arrows.push(`↓${s.behind}`);
    line += arrows.length > 0 ? `  ${arrows.join(" ")}` : "  ↑0 ↓0";
  } else {
    line += "  (no remote)";
  }
  line += s.hasUncommittedChanges
    ? `  dirty (${s.changedFiles.length})`
    : "  clean";
  return line;
}

/**
 * “上次应用” 单行：时间 + 短 commit；从未应用时显示 never
 */
function formatLastApplied(commit: string | null, at: string | null): string {
  if (!commit && !at) return "never";
  const when = at ? formatTimestamp(at) : "unknown";
  const short = commit ? commit.substring(0, 7) : "?";
  return `${when} (${short})`;
}

/**
 * ISO 时间戳 → “YYYY-MM-DD HH:MM”
 */
function formatTimestamp(iso: string): string {
  const m = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.exec(iso);
  return m ? m[0]!.replace("T", " ") : iso;
}

/**
 * Managed (synced) 区块：按类别各一行
 */
function formatManaged(
  config: PiSyncConfig,
  fileChanges: Record<string, { action: string; diff?: string }>,
  managedSettings: string[],
  dirs: Array<{ dir: string; count: number }>,
  pkgDiff?: PackageDiff,
): string {
  const rows: string[] = [];

  // 内容目录（extensions/ skills/ prompts/ themes …）
  if (dirs.length > 0) {
    const parts = dirs.map((d) =>
      d.count > 0 ? `${d.dir} (${d.count})` : d.dir,
    );
    rows.push(`dirs      ${parts.join("  ")}`);
  }

  // Settings：源文件 + 已管理 key 数量
  rows.push(
    `settings  ${config.settings.source} (${managedSettings.length} keys)`,
  );

  // 文件：单字符图标内联
  rows.push(`files     ${formatFileLine(config, fileChanges)}`);

  // Packages：已同步数量
  if (pkgDiff) {
    rows.push(`packages  ${pkgDiff.unchanged.length} synced`);
  }

  return rows.join("\n  ");
}

/**
 * 文件同步状态单行：每个映射文件一个 “{icon} {target}" 片段
 * 图标：✓ synced  ~ pending update  + pending new  ! source missing  – optional absent
 */
function formatFileLine(
  config: PiSyncConfig,
  fileChanges: Record<string, { action: string; diff?: string }>,
): string {
  const parts = config.files.map((f) => {
    const change = fileChanges[f.target];
    const icon = change
      ? { unchanged: "✓", will_update: "~", will_create: "+", source_missing: "!" }[
          change.action
        ] ?? "?"
      : "–";
    return `${icon} ${f.target}`;
  });
  return parts.join("  ");
}

/**
 * Pending 区块：仅展示有变更的类别；返回空串表示无变更
 */
function formatPending(
  settingsChanges: Record<string, { before: unknown; after: unknown }>,
  fileChanges: Record<string, { action: string; diff?: string }>,
  pkgDiff?: PackageDiff,
): string {
  const rows: string[] = [];

  // Settings 变更
  const settingsKeys = Object.keys(settingsChanges);
  if (settingsKeys.length > 0) {
    rows.push(`  settings  ${settingsKeys.join("  ·  ")}`);
    for (const key of settingsKeys) {
      const c = settingsChanges[key]!;
      rows.push(`    ${key}:  ${formatValue(c.before)} → ${formatValue(c.after)}`);
    }
  }

  // 文件变更（只列有 action 的，排除 unchanged）
  const filePending = Object.entries(fileChanges).filter(
    ([, c]) => c.action !== "unchanged",
  );
  if (filePending.length > 0) {
    rows.push("  files");
    for (const [file, change] of filePending) {
      let note = "";
      if (change.action === "will_create") note = " (new)";
      else if (change.action === "source_missing") note = " (source missing!)";
      else if (change.diff) note = ` (${change.diff})`;
      rows.push(`    ${file}${note}`);
    }
  }

  // Package 变更
  if (pkgDiff) {
    const pkgParts: string[] = [];
    for (const p of pkgDiff.added) pkgParts.push(`+ ${p}`);
    for (const p of pkgDiff.changed) pkgParts.push(`~ ${p}`);
    const localOnly = pkgDiff.removed.filter(
      (p) => !pkgDiff.added.includes(p) && !pkgDiff.changed.includes(p),
    );
    for (const p of localOnly) pkgParts.push(`- ${p} (local-only)`);
    if (pkgParts.length > 0) {
      rows.push(`  packages  ${pkgParts.join("  ·  ")}`);
    }
  }

  return rows.join("\n");
}

/**
 * 紧凑显示一个 settings 值：未设置显示 (unset)，长值截断
 */
function formatValue(v: unknown): string {
  if (v === undefined) return "(unset)";
  const s = JSON.stringify(v);
  if (s === undefined) return "(unset)";
  return s.length > 40 ? s.slice(0, 37) + "..." : s;
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
