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
  gitRenameBranch,
  gitDiff,
  gitDiffFiles,
  gitDiffRange,
  gitCommit,
  getHeadCommit,
  hasUncommittedChanges,
  isDiverged,
  gitExec,
  isGitFailure,
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

  // ============ init (统一入口: 首次设置 clone/scaffold，后续调用直接 apply) ============

  /**
   * 统一 init 命令。
   * - 如果已经初始化过（state 中有 repoPath 且 repo 存在），直接 apply
   * - 如果没有初始化，要求提供 gitUrl：
   *   - 空仓库：scaffold 配置结构
   *   - 已有 pi-sync.json 的标准同步仓库：拉取并 apply
   *   - 有内容但不是标准同步仓库：报错提示
   */
  async init(gitUrl?: string): Promise<{
    message: string;
    needsReload: boolean;
    /** 是否整体成功（单步最佳努力型失败，如 pi install 失败，仍视为成功） */
    ok: boolean;
    /** 用于调用方决定提示级别；不再靠字符串嗅探猜测 */
    level: "info" | "warning" | "error";
  }> {
    const defaultPath = join(this.agentDir, "..", "config-repo");

    // 已初始化：直接 apply
    if (await this.isAlreadyInitialized(defaultPath)) {
      const acquired = await this.lock.acquire("apply", 5000);
      if (!acquired) {
        return { message: "Another sync operation is in progress.", needsReload: false, ok: false, level: "warning" };
      }
      try {
        // Fetch latest first
        try {
          await gitFetch(defaultPath);
          const status = await gitStatus(defaultPath);
          if (status.behind > 0) {
            await gitPull(defaultPath, status.branch);
          }
        } catch {
          // Offline or no remote — proceed with local apply
        }
        const config = await loadPiSyncConfig(defaultPath);
        const applyResult = await this.applyCurrent(defaultPath, config, "init");
        return { message: `Already initialized. Applied current config.\n${applyResult}`, needsReload: true, ok: true, level: "info" };
      } finally {
        await this.lock.release();
      }
    }

    // 未初始化 — 需要 gitUrl
    if (!gitUrl) {
      return {
        message: "Enter your config repo Git URL to get started:\n" +
          "  /pisync init git@github.com:you/pi-config.git",
        needsReload: false,
        ok: false,
        level: "info",
      };
    }

    // Validate URL format
    if (!isValidGitUrl(gitUrl)) {
      return {
        message: `Invalid Git URL: ${gitUrl}\n` +
          "Expected formats:\n" +
          "  git@github.com:user/repo.git\n" +
          "  https://github.com/user/repo.git\n" +
          "  ssh://git@github.com/user/repo.git",
        needsReload: false,
        ok: false,
        level: "error",
      };
    }

    const acquired = await this.lock.acquire("init", 5000);
    if (!acquired) {
      return { message: "Another sync operation is in progress.", needsReload: false, ok: false, level: "warning" };
    }

    try {
      const lines: string[] = [];
      let isNewClone = false;

      if (existsSync(defaultPath) && existsSync(join(defaultPath, ".git"))) {
        // Repo already exists locally, verify it's the same remote
        const result = await gitExec(defaultPath, ["remote", "get-url", "origin"]);
        const existingUrl = result.stdout.trim();

        if (!urlsMatch(existingUrl, gitUrl)) {
          return {
            message: `A config repo already exists at ${defaultPath}\n` +
              `Existing remote: ${existingUrl}\n` +
              `Provided URL:   ${gitUrl}\n` +
              "To switch, remove the existing repo first: rm -rf ~/.pi/config-repo",
            needsReload: false,
            ok: false,
            level: "error",
          };
        }
        lines.push(`Config repo already exists at ${defaultPath}`);
      } else {
        // Fresh clone
        lines.push(`Cloning ${gitUrl}...`);
        const { mkdir } = await import("node:fs/promises");
        await mkdir(join(defaultPath, ".."), { recursive: true });

        // Preflight：在真正 clone 之前验证可连通性与认证。失败时给出可操作的提示，
        // 而不是留下半成品目录让用户去猜原因。
        const preflight = await gitExec(
          process.cwd(),
          ["ls-remote", "--", gitUrl],
          { timeout: 30000 },
        );
        if (isGitFailure(preflight.stdout, preflight.stderr)) {
          return {
            message: `Clone failed: cannot reach ${gitUrl}\n${preflight.stderr.trim() || preflight.stdout.trim()}\n\n` +
              "Verify the URL, your network, and (for SSH URLs) that your key can authenticate.\n" +
              "Tip: run `ssh -T git@github.com` in a terminal to confirm access.",
            needsReload: false,
            ok: false,
            level: "error",
          };
        }

        // clone（gitExec 已注入 accept-new，避免首次连接主机时 ys 提示在非交互环境下挂住）
        const cloneResult = await gitExec(
          join(defaultPath, ".."),
          ["clone", "--", gitUrl, defaultPath],
          { timeout: 60000 },
        );
        if (
          isGitFailure(cloneResult.stdout, cloneResult.stderr) ||
          !existsSync(join(defaultPath, ".git"))
        ) {
          if (existsSync(defaultPath)) {
            const { rm } = await import("node:fs/promises");
            await rm(defaultPath, { recursive: true, force: true });
          }
          return {
            message: `Clone failed:\n${cloneResult.stderr.trim() || cloneResult.stdout.trim() || "Unknown error"}\n\n` +
              "Common fixes:\n" +
              "  - Confirm the URL is correct and the repo exists and is accessible to you.\n" +
              "  - For SSH: ensure your key is reachable (try `ssh -T git@github.com` in a terminal).\n" +
              "  - For HTTPS: avoid URLs that require an interactive password prompt, or configure a credential helper.",
            needsReload: false,
            ok: false,
            level: "error",
          };
        }
        lines.push("Clone complete.");
        isNewClone = true;
      }

      // Fetch latest
      await gitFetch(defaultPath).catch(() => {});

      // Detect repo state: empty / valid sync repo / invalid
      const repoState = await detectRepoState(defaultPath);

      if (repoState === "empty") {
        // Empty repo — scaffold
        lines.push("Empty repository detected — scaffolding config structure...");
        await scaffoldConfigRepo(defaultPath);
        await gitCommit(defaultPath, "pi-sync: initial config scaffold");

        // A newly cloned empty repository has no reliable local branch name
        // (it can be either main or master).  The scaffold declares main, so
        // make that explicit and push it immediately.
        await gitRenameBranch(defaultPath, "main");
        try {
          await gitPush(defaultPath, "main");
          lines.push("Scaffold committed and pushed to origin/main.");
        } catch (err) {
          // Keep the local scaffold usable: the user can resolve the remote
          // issue and retry with /pisync push without re-running init.
          await updateState(this.agentDir, { repoPath: defaultPath });
          const detail = err instanceof Error ? err.message : "Unknown error";
          return {
            message: `${lines.join("\n")}\n\n` +
              "The initial scaffold was committed locally but could not be pushed.\n" +
              "The remote may have received another commit while initialization was running, or access was denied. " +
              "Resolve the remote conflict/authentication issue, then run /pisync push.\n" +
              `Details: ${detail}`,
            needsReload: false,
            // 本地脚手架已生成，只是没能推送到远端 —— 可恢复，不算硬失败。
            ok: false,
            level: "warning",
          };
        }
        lines.push("");
      } else if (repoState === "invalid") {
        return {
          message: `The repository at ${gitUrl} has commits but is not a valid pi-sync config repo.\n` +
            "A pi-sync config repo must have a pi-sync.json at its root.\n" +
            "Either:\n" +
            "  1. Use an empty repository for auto-scaffolding, or\n" +
            "  2. Ensure the repo contains a valid pi-sync.json file.",
          needsReload: false,
          ok: false,
          level: "error",
        };
      } else {
        // Valid sync repo — pull latest
        lines.push("Valid sync repo detected — fetching latest...");
        const status = await gitStatus(defaultPath);
        const { pulled } = await gitPull(defaultPath, status.branch);
        lines.push(pulled ? "Updated to latest." : "Already up to date.");
      }

      // Update state
      await updateState(this.agentDir, { repoPath: defaultPath });

      // Install as Pi package
      lines.push("Installing as Pi package...");
      try {
        const { execFile: execFileCb } = await import("node:child_process");
        const { promisify } = await import("node:util");
        const execFileAsync = promisify(execFileCb);
        // Use an argv array (not a shell string) so paths containing spaces
        // are passed to `pi` verbatim instead of being shell-split.
        await execFileAsync("pi", ["install", defaultPath], {
          timeout: 60000,
          env: { ...process.env },
        });
        lines.push("Package installed.");
      } catch (err: unknown) {
        lines.push(
          `pi install failed: ${err instanceof Error ? err.message : "Unknown"}`,
        );
        lines.push(`Run manually: pi install ${defaultPath}`);
      }

      // Apply config
      const config = await loadPiSyncConfig(defaultPath);
      const applyResult = await this.applyCurrent(defaultPath, config, "init");
      lines.push(applyResult);

      lines.push("");
      lines.push("Setup complete! Your config is now synced.");
      lines.push("Use /pisync for day-to-day sync operations.");

      return { message: lines.join("\n"), needsReload: true, ok: true, level: "info" };
    } catch (err) {
      return {
        message: `Init failed: ${err instanceof Error ? err.message : "Unknown error"}`,
        needsReload: false,
        ok: false,
        level: "error",
      };
    } finally {
      await this.lock.release();
    }
  }

  /**
   * 判断是否已初始化：state 中有 repoPath 且 repo 存在且是有效的同步仓库
   */
  private async isAlreadyInitialized(repoPath: string): Promise<boolean> {
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

  // ============ apply (保留给高级用户，命令行直接调用) ============

  async apply(repoPath?: string): Promise<string> {
    const rp = repoPath ?? (await getRepoPath());
    const config = await loadPiSyncConfig(rp);

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
 * 检测仓库状态:
 * - "empty": 没有 commits（真正的空仓库）
 * - "valid": 有 pi-sync.json，是标准同步仓库
 * - "invalid": 有 commits 但没有 pi-sync.json
 */
async function detectRepoState(repoPath: string): Promise<"empty" | "valid" | "invalid"> {
  // 检查是否有 commits
  let hasCommits = false;
  try {
    const result = await gitExec(repoPath, ["rev-list", "--count", "HEAD"]);
    hasCommits = parseInt(result.stdout.trim(), 10) > 0;
  } catch {
    // rev-list fails on truly empty repo (no HEAD)
    hasCommits = false;
  }

  if (!hasCommits) return "empty";

  // Has commits — check for pi-sync.json
  if (existsSync(join(repoPath, "pi-sync.json"))) return "valid";

  return "invalid";
}

/**
 * 在空仓库中生成配置脚手架文件
 */
async function scaffoldConfigRepo(repoPath: string): Promise<void> {
  const { mkdir, writeFile } = await import("node:fs/promises");

  // Create directories
  await mkdir(join(repoPath, "config", "machines"), { recursive: true });
  await mkdir(join(repoPath, "extensions"), { recursive: true });
  await mkdir(join(repoPath, "skills"), { recursive: true });
  await mkdir(join(repoPath, "prompts"), { recursive: true });
  await mkdir(join(repoPath, "themes"), { recursive: true });
  await mkdir(join(repoPath, "files"), { recursive: true });

  // package.json
  const pkgJson = {
    name: "personal-pi-config",
    private: true,
    keywords: ["pi-package"],
    pi: {
      extensions: ["./extensions"],
      skills: ["./skills"],
      prompts: ["./prompts"],
      themes: ["./themes"],
    },
  };
  await writeFile(join(repoPath, "package.json"), JSON.stringify(pkgJson, null, 2), "utf-8");

  // pi-sync.json
  const piSync = {
    schemaVersion: 1,
    branch: "main",
    settings: {
      source: "config/settings.shared.json",
      strategy: "managed-keys",
      preserve: ["lastChangelogVersion", "trackingId", "httpProxy"],
    },
    files: [
      { source: "files/AGENTS.md", target: "AGENTS.md" },
      { source: "files/SYSTEM.md", target: "SYSTEM.md", optional: true },
      { source: "files/keybindings.json", target: "keybindings.json", optional: true },
    ],
    security: {
      deny: ["auth.json", "trust.json", "sessions/**", "**/.env"],
      scanSecretsBeforePush: true,
    },
  };
  await writeFile(join(repoPath, "pi-sync.json"), JSON.stringify(piSync, null, 2), "utf-8");

  // config/settings.shared.json (empty, to be populated by capture)
  await writeFile(join(repoPath, "config", "settings.shared.json"), "{}", "utf-8");

  // .gitignore
  await writeFile(join(repoPath, ".gitignore"), "# Local state — never sync\n.pi-sync/\n", "utf-8");
}

/**
 * 校验 Git URL 格式
 */
function isValidGitUrl(url: string): boolean {
  // git@host:path  (SCP-like syntax; no explicit port in this form)
  if (/^git@[\w.-]+:[\w./-]+(\.git)?$/.test(url)) return true;
  // https://host[:port]/path(.git)?
  if (/^https?:\/\/[\w.-]+(:\d+)?\/[\w./-]+(\.git)?$/.test(url)) return true;
  // ssh://git@host[:port]/path(.git)?
  if (/^ssh:\/\/git@[\w.-]+(:\d+)?\/[\w./-]+(\.git)?$/.test(url)) return true;
  // git://host[:port]/path(.git)?
  if (/^git:\/\/[\w.-]+(:\d+)?\/[\w./-]+(\.git)?$/.test(url)) return true;
  return false;
}

/**
 * 比较两个 Git URL 是否指向同一个仓库
 */
function urlsMatch(a: string, b: string): boolean {
  const normalize = (url: string) =>
    url
      .replace(/^https?:\/\//, "")
      .replace(/^ssh:\/\/git@/, "")
      .replace(/^git@/, "")
      .replace(/^git:\/\//, "")
      .replace(/\.git$/, "")
      .replace(/:\d+\//, "/") // strip port
      .toLowerCase();
  return normalize(a) === normalize(b);
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
