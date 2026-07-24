/**
 * /pisync 命令路由
 *
 * 所有同步操作的主入口
 */
import { join } from "node:path";
import { existsSync } from "node:fs";
import { writeFile, readFile } from "node:fs/promises";
import { hostname } from "node:os";
import {
  gitStatus,
  gitFetch,
  gitPull,
  gitPush,
  gitDiff,
  gitDiffFiles,
  gitDiffRange,
  gitCommit,
  getHeadCommit,
  hasUncommittedChanges,
  isDiverged,
} from "./git.ts";
import { loadPiSyncConfig } from "./config.ts";
import type { PiSyncConfig } from "./config.ts";
import { mergeSettings } from "./settings.ts";
import { materializeFiles, diffFiles } from "./materialize.ts";
import { createBackup, listBackups, restoreBackup } from "./backup.ts";
import { SyncLock } from "./lock.ts";
import { isDenied, scanSecrets } from "./security.ts";
import { loadState, saveState, updateState } from "./state.ts";
import { captureFiles, extractManagedSettings } from "./capture.ts";
import { runDoctorChecks } from "./doctor.ts";
import { reconcilePackages, getPackageDiff } from "./packages.ts";
import {
  formatGitStatus,
  formatSettingsChanges,
  formatSyncStatus,
  formatDoctorResult,
  formatSecretsFindings,
  formatBackupList,
  formatPackageDiff,
} from "./ui.ts";

/** 获取 Pi agent 目录 */
export function getAgentDir(): string {
  const envDir = process.env.PI_CODING_AGENT_DIR;
  if (envDir) return envDir;

  const home = process.env.HOME ?? process.env.USERPROFILE ?? "~";
  return join(home, ".pi", "agent");
}

/** 安全获取仓库路径（不抛异常） */
export async function getRepoPathSafe(agentDir: string): Promise<string | null> {
  try {
    return await getRepoPath();
  } catch {
    return null;
  }
}

/** 从 state 或 config 获取仓库路径 */
export async function getRepoPath(configOverrride?: string): Promise<string> {
  if (configOverrride) return configOverrride;

  const agentDir = getAgentDir();
  const state = await loadState(agentDir);
  if (state.repoPath && existsSync(state.repoPath)) {
    return state.repoPath;
  }
  throw new Error(
    "No config repo found. Use /pisync apply <repo-path> or set repoPath in state.",
  );
}

export class PiSyncCommands {
  private agentDir: string;
  private lock: SyncLock;

  constructor(agentDir?: string) {
    this.agentDir = agentDir ?? getAgentDir();
    this.lock = new SyncLock(join(this.agentDir, ".pi-sync"));
  }

  // ============ status ============

  async status(repoPath?: string): Promise<string> {
    const rp = repoPath ?? (await getRepoPathSafe(this.agentDir));
    if (!rp) return "No config repo configured. Use /pisync apply <repo-path> first.";

    const config = await loadPiSyncConfig(rp);
    const status = await gitStatus(rp);
    const state = await loadState(this.agentDir);

    // Check settings changes
    const localSettings = await this.loadLocalSettings();
    const settingsResult = await mergeSettings(
      localSettings,
      rp,
      config.settings,
      hostname(),
    );

    // Check file changes
    const fileChanges = await diffFiles(rp, this.agentDir, config.files);

    // Check package changes
    let pkgDiff = null;
    try {
      pkgDiff = await getPackageDiff(rp, this.agentDir, config);
    } catch {
      // best-effort
    }

    return formatSyncStatus(
      status,
      settingsResult.changed,
      fileChanges,
      state.lastAppliedCommit,
      pkgDiff ?? undefined,
    );
  }

  // ============ diff ============

  async diff(repoPath?: string): Promise<string> {
    const rp = repoPath ?? (await getRepoPathSafe(this.agentDir));
    if (!rp) return "No config repo configured. Use /pisync apply <repo-path> first.";

    const config = await loadPiSyncConfig(rp);
    const lines: string[] = [];

    // Git diff
    const status = await gitStatus(rp);
    lines.push("=== Git Changes ===");
    if (status.hasUncommittedChanges) {
      lines.push(await gitDiff(rp));
    } else if (status.behind > 0) {
      try {
        await gitFetch(rp);
      } catch {
        // fetch may fail if no network
      }
      const currentCommit = await getHeadCommit(rp);
      try {
        const rangeDiff = await gitDiffRange(rp, currentCommit, `origin/${status.branch}`);
        if (rangeDiff) {
          lines.push(rangeDiff);
        } else {
          lines.push("(no content diff available - run /pisync pull to update)");
        }
      } catch {
        lines.push(formatGitStatus(status));
      }
    } else {
      lines.push(formatGitStatus(status));
    }
    lines.push("");

    // Settings diff
    const localSettings = await this.loadLocalSettings();
    const settingsResult = await mergeSettings(
      localSettings,
      rp,
      config.settings,
      hostname(),
    );
    lines.push("=== Settings Changes ===");
    lines.push(formatSettingsChanges(settingsResult.changed));
    lines.push("");

    // File diff
    const fileChanges = await diffFiles(rp, this.agentDir, config.files);
    lines.push("=== File Changes ===");
    if (Object.keys(fileChanges).length === 0) {
      lines.push("No file changes pending.");
    } else {
      for (const [file, change] of Object.entries(fileChanges)) {
        const icon = {
          will_create: "[create]",
          will_update: "[update]",
          unchanged: "[ok]",
          source_missing: "[MISSING]",
        }[change.action] ?? "[?]";
        lines.push(`  ${icon} ${file}${change.diff ? ` — ${change.diff}` : ""}`);
      }
    }
    lines.push("");

    // Package diff
    try {
      const pkgDiff = await getPackageDiff(rp, this.agentDir, config);
      lines.push("=== Package Changes ===");
      lines.push(formatPackageDiff(pkgDiff));
    } catch {
      // best-effort
    }

    return lines.join("\n");
  }

  // ============ pull ============

  async pull(repoPath?: string): Promise<string> {
    const rp = repoPath ?? (await getRepoPath());
    const config = await loadPiSyncConfig(rp);

    // 获取锁
    const acquired = await this.lock.acquire("pull", 5000);
    if (!acquired) {
      const existing = await this.lock.readLock();
      return `Another sync operation is in progress: ${existing?.operation} (PID ${existing?.pid}, started ${existing?.startedAt})`;
    }

    try {
      const status = await gitStatus(rp);

      // 检查未提交变更
      if (status.hasUncommittedChanges) {
        return "Repository has uncommitted changes. Please commit or stash them first.";
      }

      // Fetch
      try {
        await gitFetch(rp);
      } catch (err) {
        return `git fetch failed: ${err instanceof Error ? err.message : "Unknown error"}`;
      }

      // 检查 divergence
      const diverged = await isDiverged(rp, status.branch, `origin/${status.branch}`);
      if (diverged) {
        return "Local and remote branches have diverged. Please resolve manually with git pull --rebase in the repo.";
      }

      // Pull (fast-forward only)
      const { pulled } = await gitPull(rp, status.branch);
      if (!pulled) {
        return "Already up to date.";
      }

      const newCommit = await getHeadCommit(rp);

      // 应用配置
      const applyResult = await this.applyCurrent(rp, config, `pull-${newCommit.substring(0, 7)}`);

      // 更新状态
      await updateState(this.agentDir, {
        lastAppliedCommit: newCommit,
        lastAppliedAt: new Date().toISOString(),
        managedSettings: Object.keys(
          (await mergeSettings(
            await this.loadLocalSettings(),
            rp,
            config.settings,
            hostname(),
          )).merged,
        ),
      });

      return `Pulled and applied successfully.\nNew commit: ${newCommit.substring(0, 7)}\n${applyResult}`;
    } finally {
      await this.lock.release();
    }
  }

  // ============ push ============

  async push(repoPath?: string, message?: string): Promise<string> {
    const rp = repoPath ?? (await getRepoPath());
    const config = await loadPiSyncConfig(rp);

    // 获取锁
    const acquired = await this.lock.acquire("push", 5000);
    if (!acquired) {
      return "Another sync operation is in progress.";
    }

    try {
      // 检查未提交变更
      const hasChanges = await hasUncommittedChanges(rp);
      if (!hasChanges) {
        return "No changes to push.";
      }

      // 获取变更文件列表并进行 denylist 检查
      const status = await gitStatus(rp);
      const deniedFiles: string[] = [];
      for (const file of status.changedFiles) {
        if (isDenied(file, config.security.deny)) {
          deniedFiles.push(file);
        }
      }

      if (deniedFiles.length > 0) {
        return `Push blocked: The following files are in the denylist:\n${deniedFiles.map((f) => `  - ${f}`).join("\n")}\n\nRemove these files from staging or update pi-sync.json security.deny.`;
      }

      // 秘密扫描
      if (config.security.scanSecretsBeforePush) {
        const diffContent = await gitDiff(rp);
        if (diffContent) {
          const findings = scanSecrets(diffContent, "diff");
          if (findings.length > 0) {
            return `Push blocked: Potential secrets detected:\n${formatSecretsFindings(findings)}`;
          }
        }
      }

      // Commit
      const commitMsg = message ?? "pi-sync: update configuration";
      await gitCommit(rp, commitMsg);

      // Pull rebase before push
      try {
        await gitFetch(rp);
        const diverged = await isDiverged(rp, status.branch, `origin/${status.branch}`);
        if (diverged) {
          return "Remote has new commits. Would recommend using /pisync pull first. Or run git pull --rebase manually in the repo.";
        }
      } catch {
        // Proceed with push attempt
      }

      // Push
      await gitPush(rp, config.branch ?? status.branch);

      // 更新状态
      await updateState(this.agentDir, {
        lastPushAt: new Date().toISOString(),
      });

      const newCommit = await getHeadCommit(rp);
      return `Pushed successfully. Commit: ${newCommit.substring(0, 7)}`;
    } catch (err) {
      return `Push failed: ${err instanceof Error ? err.message : "Unknown error"}`;
    } finally {
      await this.lock.release();
    }
  }

  // ============ apply ============

  async apply(repoPath?: string): Promise<string> {
    const rp = repoPath ?? (await getRepoPath());
    const config = await loadPiSyncConfig(rp);

    // 保存 repoPath 到 state
    await updateState(this.agentDir, { repoPath: rp });

    const acquired = await this.lock.acquire("apply", 5000);
    if (!acquired) {
      return "Another sync operation is in progress.";
    }

    try {
      return await this.applyCurrent(rp, config, "apply");
    } finally {
      await this.lock.release();
    }
  }

  // ============ capture ============

  async capture(repoPath?: string): Promise<string> {
    const rp = repoPath ?? (await getRepoPath());
    const config = await loadPiSyncConfig(rp);

    const acquired = await this.lock.acquire("capture", 5000);
    if (!acquired) {
      return "Another sync operation is in progress.";
    }

    try {
      const localSettings = await this.loadLocalSettings();

      // Capture settings
      const settingsResult = await mergeSettings(
        localSettings,
        rp,
        config.settings,
        hostname(),
      );

      // Only capture keys that are in managed settings but not yet set locally
      const managedKeys = Object.keys(settingsResult.merged);
      const extractedSettings = extractManagedSettings(localSettings, managedKeys);

      if (Object.keys(extractedSettings).length > 0) {
        const sharedSettingsPath = join(rp, config.settings.source);
        let sharedSettings: Record<string, unknown> = {};

        if (existsSync(sharedSettingsPath)) {
          sharedSettings = JSON.parse(await readFile(sharedSettingsPath, "utf-8"));
        }

        // Merge extracted into shared (don't overwrite existing)
        const merged = { ...extractedSettings, ...sharedSettings };
        await writeFile(sharedSettingsPath, JSON.stringify(merged, null, 2), "utf-8");
      }

      // Capture files
      const fileMappings = config.files.map((f) => ({
        source: f.source,
        target: f.target,
      }));
      const captureResult = await captureFiles(this.agentDir, rp, config, fileMappings);

      const lines: string[] = ["Capture complete:"];
      if (Object.keys(extractedSettings).length > 0) {
        lines.push(`Settings captured: ${Object.keys(extractedSettings).join(", ")}`);
      } else {
        lines.push("Settings: nothing to capture (all managed keys already in repo)");
      }

      if (captureResult.captured.length > 0) {
        lines.push(`Files captured: ${captureResult.captured.join(", ")}`);
      }
      if (captureResult.denied.length > 0) {
        lines.push(`Files denied: ${captureResult.denied.join(", ")}`);
      }
      if (captureResult.skipped.length > 0) {
        lines.push(`Files skipped: ${captureResult.skipped.join(", ")}`);
      }

      return lines.join("\n");
    } finally {
      await this.lock.release();
    }
  }

  // ============ doctor ============

  async doctor(repoPath?: string): Promise<string> {
    const rp = repoPath ?? (await getRepoPathSafe(this.agentDir));
    if (!rp) return "No config repo configured.";

    const config = await loadPiSyncConfig(rp);
    const result = await runDoctorChecks(rp, this.agentDir, config);
    return formatDoctorResult(result);
  }

  // ============ rollback ============

  async rollback(repoPath?: string): Promise<string> {
    const rp = repoPath ?? (await getRepoPathSafe(this.agentDir));
    if (!rp) return "No config repo configured.";

    const config = await loadPiSyncConfig(rp);
    const backups = await listBackups(this.agentDir);

    if (backups.length === 0) {
      return "No backups available for rollback.";
    }

    const latestBackup = backups[0]!;

    // 先创建当前状态的备份
    const currentCommit = await getHeadCommit(rp).catch(() => "unknown");
    await createBackup(
      this.agentDir,
      currentCommit,
      "pre-rollback",
      config.files.map((f) => ({ source: f.source, target: f.target })),
    );

    // 恢复
    await restoreBackup(
      this.agentDir,
      latestBackup,
      config.files.map((f) => ({ source: f.source, target: f.target })),
    );

    return `Rolled back to backup: ${latestBackup.timestamp}\nCommit: ${latestBackup.commit}\nReason: ${latestBackup.reason}`;
  }

  // ============ rollback-list ============

  async rollbackList(): Promise<string> {
    const backups = await listBackups(this.agentDir);
    return formatBackupList(backups);
  }

  // ============ Private helpers ============

  private async loadLocalSettings(): Promise<Record<string, unknown>> {
    const settingsPath = join(this.agentDir, "settings.json");
    if (!existsSync(settingsPath)) return {};
    try {
      return JSON.parse(await readFile(settingsPath, "utf-8"));
    } catch {
      return {};
    }
  }

  private async applyCurrent(
    rp: string,
    config: PiSyncConfig,
    reason: string,
  ): Promise<string> {
    const commit = await getHeadCommit(rp);
    const lines: string[] = [];

    // 备份
    const backup = await createBackup(
      this.agentDir,
      commit,
      reason,
      config.files.map((f) => ({ source: f.source, target: f.target })),
    );
    lines.push(`Backup created: ${backup.timestamp}`);

    // 应用 settings
    const localSettings = await this.loadLocalSettings();
    const settingsResult = await mergeSettings(
      localSettings,
      rp,
      config.settings,
      hostname(),
    );

    // 合并到本地 settings
    const mergedSettings = deepMergeLocal(localSettings, settingsResult.merged);
    const settingsPath = join(this.agentDir, "settings.json");
    await writeFile(settingsPath, JSON.stringify(mergedSettings, null, 2), "utf-8");
    lines.push(`Settings: ${Object.keys(settingsResult.changed).length} fields changed`);

    // 应用文件
    const materializeResult = await materializeFiles(
      rp,
      this.agentDir,
      config.files,
      join(this.agentDir, ".pi-sync", "backups", backup.timestamp, "data"),
    );
    if (materializeResult.applied.length > 0) {
      lines.push(`Files: ${materializeResult.applied.length} applied`);
    }
    if (materializeResult.skipped.length > 0) {
      lines.push(`Files skipped: ${materializeResult.skipped.join(", ")}`);
    }
    if (materializeResult.failed.length > 0) {
      lines.push(`Files failed: ${materializeResult.failed.map((f) => `${f.file} (${f.reason})`).join(", ")}`);
    }

    // 更新状态
    await updateState(this.agentDir, {
      lastAppliedCommit: commit,
      lastAppliedAt: new Date().toISOString(),
      lastBackup: backup.timestamp,
      managedSettings: Object.keys(settingsResult.merged),
    });

    // Package reconciliation
    try {
      const packageResult = await reconcilePackages(
        rp,
        this.agentDir,
        config,
      );
      if (packageResult.installed.length > 0) {
        lines.push(`Packages installed: ${packageResult.installed.join(", ")}`);
      }
      if (packageResult.removed.length > 0) {
        lines.push(`Packages removed: ${packageResult.removed.join(", ")}`);
      }
      if (packageResult.errors.length > 0) {
        lines.push(`Package errors: ${packageResult.errors.join("; ")}`);
      }
    } catch {
      // Package reconciliation is best-effort
    }

    return lines.join("\n");
  }
}

/**
 * 深度合并到本地 settings（保护 preserved 字段）
 */
function deepMergeLocal(
  local: Record<string, unknown>,
  managed: Record<string, unknown>,
): Record<string, unknown> {
  const result = { ...local };

  for (const [key, value] of Object.entries(managed)) {
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      const localVal = result[key];
      if (typeof localVal === "object" && localVal !== null && !Array.isArray(localVal)) {
        result[key] = deepMergeLocal(
          localVal as Record<string, unknown>,
          value as Record<string, unknown>,
        );
        continue;
      }
    }
    result[key] = value;
  }

  return result;
}
