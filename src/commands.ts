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
import { join } from "node:path";
import { existsSync } from "node:fs";
import { writeFile, readFile, mkdir } from "node:fs/promises";
import { hostname } from "node:os";
import {
  gitStatus, gitFetch, gitPull, gitPush, gitRenameBranch,
  gitDiff, gitDiffRange, gitDiffStaged,
  gitRebase, gitRebaseContinue, gitRebaseAbort,
  gitCommit, getHeadCommit, hasUncommittedChanges, isDiverged,
  hasUnmergedPaths, isWorktreeClean, gitExec, isGitFailure,
  gitRemoteRefExists,
} from "./git.ts";
import { loadPiSyncConfig } from "./config.ts";
import type { PiSyncConfig } from "./config.ts";
import { planMaterialize, executeMaterialize } from "./materialize.ts";
import type { MaterializePlan, MaterializeResult } from "./materialize.ts";
import { createBackup, listBackups, restoreBackup, getLatestBackup } from "./backup.ts";
import { SyncLock } from "./lock.ts";
import { findDeniedFiles, scanSecrets, scanFilesForSecrets } from "./security.ts";
import { loadState, saveState, updateState } from "./state.ts";
import type { SyncState } from "./state.ts";
import { captureChanges, verifyCapture } from "./capture.ts";
import { compareFiles, hasLocalChanges, sha256File, sha256 } from "./inventory.ts";
import type { FileComparison } from "./inventory.ts";
import { validateFiles } from "./validate.ts";
import { runDoctorChecks } from "./doctor.ts";
import { reconcilePackages, getPackageDiff } from "./packages.ts";
import { readAgentFile } from "./materialize.ts";
import {
  formatGitStatus, formatSyncStatusV2, formatComparisonDiff,
  formatDoctorResult, formatSecretsFindings, formatBackupList,
  formatPackageDiff, formatValidationErrors,
  formatCaptureResult,
} from "./ui.ts";

// ========== 路径工具 ==========

export function getAgentDir(): string {
  const envDir = process.env.PI_CODING_AGENT_DIR;
  if (envDir) return envDir;

  const home = process.env.HOME ?? process.env.USERPROFILE ?? "~";
  return join(home, ".pi", "agent");
}

export async function getRepoPathSafe(agentDir: string): Promise<string | null> {
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
  throw new Error(
    "No config repo found. Use /pisync init <git-url> to set up.",
  );
}

// ========== 命令类 ==========

export class PiSyncCommands {
  private agentDir: string;
  private lock: SyncLock;

  constructor(agentDir?: string) {
    this.agentDir = agentDir ?? getAgentDir();
    this.lock = new SyncLock(join(this.agentDir, ".pi-sync"));
  }

  // ========== status ==========

  async status(repoPath?: string): Promise<string> {
    const rp = repoPath ?? (await getRepoPathSafe(this.agentDir));
    if (!rp) return "No config repo configured. Use /pisync init <git-url> first.";

    const config = await loadPiSyncConfig(rp);
    const status = await gitStatus(rp);
    const state = await loadState(this.agentDir);

    // 三方比较
    const inventory = await compareFiles(this.agentDir, rp, config, state);

    // Package diff
    let pkgDiff = null;
    try {
      pkgDiff = await getPackageDiff(rp, this.agentDir, config);
    } catch { /* best-effort */ }

    return formatSyncStatusV2({
      repoPath: rp,
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
    if (!rp) return "No config repo configured. Use /pisync init <git-url> first.";

    const config = await loadPiSyncConfig(rp);
    const status = await gitStatus(rp);
    const state = await loadState(this.agentDir);

    // 三方比较
    const inventory = await compareFiles(this.agentDir, rp, config, state);

    const lines: string[] = [];

    // Git 状态
    lines.push("=== Git Status ===");
    lines.push(formatGitStatus(status));
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
            `origin/${status.branch}`,
          );
          if (rangeDiff) {
            lines.push("=== Remote Changes (to be pulled) ===");
            lines.push(rangeDiff);
            lines.push("");
          }
        } catch { /* offline */ }
      }
    }

    return lines.join("\n");
  }

  // ========== capture ==========

  async capture(repoPath?: string): Promise<string> {
    const rp = repoPath ?? (await getRepoPath());
    const config = await loadPiSyncConfig(rp);
    const state = await loadState(this.agentDir);

    const acquired = await this.lock.acquire("capture", 5000);
    if (!acquired) {
      const existing = await this.lock.readLock();
      return `Another sync operation is in progress: ${existing?.operation} (PID ${existing?.pid}, started ${existing?.startedAt})`;
    }

    try {
      const result = await captureChanges(this.agentDir, rp, config, state);

      if (result.hasConflicts) {
        const conflictList = result.conflicts.map((c) => `  ${c.relativePath}`).join("\n");
        return `Capture blocked: bilateral modifications detected.\nResolve conflicts manually or run /pisync status for details.\n\nConflicts:\n${conflictList}`;
      }

      return formatCaptureResult(result);
    } finally {
      await this.lock.release();
    }
  }

  // ========== apply ==========

  async apply(repoPath?: string): Promise<{ message: string; reload: boolean }> {
    const rp = repoPath ?? (await getRepoPath());
    const config = await loadPiSyncConfig(rp);
    const state = await loadState(this.agentDir);

    const acquired = await this.lock.acquire("apply", 5000);
    if (!acquired) {
      return { message: "Another sync operation is in progress.", reload: false };
    }

    try {
      return await this.applyCurrent(rp, config, state, "apply");
    } finally {
      await this.lock.release();
    }
  }

  // ========== pull ==========

  async pull(repoPath?: string): Promise<{ message: string; reload: boolean }> {
    const rp = repoPath ?? (await getRepoPath());
    const config = await loadPiSyncConfig(rp);
    const state = await loadState(this.agentDir);

    const acquired = await this.lock.acquire("pull", 5000);
    if (!acquired) {
      return { message: "Another sync operation is in progress.", reload: false };
    }

    try {
      // 1. 检查 repo 状态
      const status = await gitStatus(rp);

      if (status.isRebasing || status.isMerging) {
        return { message: "Repository is in rebase/merge state. Resolve conflicts first.", reload: false };
      }

      if (status.hasUncommittedChanges) {
        return { message: "Repository has uncommitted changes. Commit or stash them first.", reload: false };
      }

      // 2. 检查 agent 是否有未捕获修改
      const inventory = await compareFiles(this.agentDir, rp, config, state);
      if (hasLocalChanges(inventory.comparisons)) {
        const localChanges = inventory.comparisons
          .filter((c) =>
            c.changeType === "local_only" ||
            c.changeType === "local_created" ||
            c.changeType === "local_deleted"
          )
          .map((c) => `  ${c.relativePath}`)
          .join("\n");
        return {
          message: `Local changes detected that have not been captured:\n${localChanges}\n\nRun /pisync push or /pisync capture first, or discard local changes.`,
          reload: false,
        };
      }

      // 3. Fetch
      try {
        await gitFetch(rp);
      } catch (err) {
        return { message: `git fetch failed: ${err instanceof Error ? err.message : "Unknown"}`, reload: false };
      }

      // 4. 检查 divergence
      const diverged = await isDiverged(rp, status.branch, `origin/${status.branch}`);
      if (diverged) {
        return { message: "Local and remote branches have diverged. Resolve manually with git pull --rebase in the repo.", reload: false };
      }

      // 5. Pull (fast-forward only)
      const { pulled } = await gitPull(rp, status.branch);
      if (!pulled) {
        return { message: "Already up to date.", reload: false };
      }

      // 6. Apply
      const newState = await loadState(this.agentDir);
      return await this.applyCurrent(rp, config, newState, "pull");
    } finally {
      await this.lock.release();
    }
  }

  // ========== push ==========

  async push(
    repoPath?: string,
    message?: string,
    subCommand?: string,
  ): Promise<{ message: string; reload: boolean }> {
    // push --continue
    if (subCommand === "--continue") {
      return this.pushContinue(repoPath);
    }

    const rp = repoPath ?? (await getRepoPath());
    const config = await loadPiSyncConfig(rp);
    const state = await loadState(this.agentDir);

    const acquired = await this.lock.acquire("push", 5000);
    if (!acquired) {
      return { message: "Another sync operation is in progress.", reload: false };
    }

    try {
      // 1. 检查 repo 状态
      const status = await gitStatus(rp);

      if (status.isRebasing || status.isMerging || status.hasConflicts) {
        return {
          message: "Repository is in conflict/resolution state. Use /pisync push --continue after resolving, or git rebase --abort to cancel.",
          reload: false,
        };
      }

      // 2. Capture agent → repo
      const captureResult = await captureChanges(this.agentDir, rp, config, state);
      if (captureResult.hasConflicts) {
        const conflictList = captureResult.conflicts.map((c) => `  ${c.relativePath}`).join("\n");
        let msg = `Push blocked: bilateral modifications detected.\n\nConflicts:\n${conflictList}\n`;
        if (captureResult.captured.length > 0) {
          msg += `\nPartially captured: ${captureResult.captured.join(", ")}`;
        }
        return { message: msg, reload: false };
      }

      if (!(await hasUncommittedChanges(rp))) {
        return { message: "No changes to push.", reload: false };
      }

      // 3. 校验白名单内容
      const changedFiles = status.changedFiles;
      if (changedFiles.length > 0) {
        const validation = await validateFiles(rp, config, changedFiles);
        if (validation.blocked) {
          return {
            message: `Push blocked: validation errors.\n${formatValidationErrors(validation.errors)}`,
            reload: false,
          };
        }
      }

      // 4. Secret scan（完整文件 + staged diff）
      if (config.security.scanSecretsBeforePush) {
        const secretFindings = await this.scanForSecrets(rp, config);
        if (secretFindings.length > 0) {
          return {
            message: `Push blocked: potential secrets detected.\n${formatSecretsFindings(secretFindings)}`,
            reload: false,
          };
        }
      }

      // 5. 展示 diff + 确认（此处在 TUI 层处理确认，这里只返回 diff）
      // 由于 Pi 的 Extension API 不直接支持"等待确认再继续"，
      // 在实际 TUI 中由 index.ts 的 handlePush 做两步交互。

      // 6. Commit
      const commitMsg = message ?? "pi-sync: update configuration";
      await gitCommit(rp, commitMsg);

      // 7. Fetch + Rebase
      try {
        await gitFetch(rp);
      } catch {
        // 离线时可继续（后续 push 会失败但给出明确信息）
      }

      try {
        const remoteRefExists = await gitRemoteRefExists(rp, status.branch).catch(() => false);
        if (remoteRefExists) {
          const rebaseResult = await gitRebase(rp, status.branch);

          if (rebaseResult.conflict) {
            // Rebase 冲突 → 停止，记录 pending operation
            await updateState(this.agentDir, { pendingOperation: "push-rebase-conflict" });
            return {
              message: "Rebase conflict detected. The repo contains standard Git conflict markers.\n\n" +
                "To resolve:\n" +
                "  1. Edit files in the repo to fix conflicts\n" +
                "  2. Run: git add <resolved-files>\n" +
                "  3. Run: git rebase --continue\n" +
                "  4. Run: /pisync push --continue\n\n" +
                "Or to abort: git rebase --abort (then /pisync doctor to clean up pending state)",
              reload: false,
            };
          }
        }
      } catch (err) {
        return {
          message: `Rebase failed: ${err instanceof Error ? err.message : "Unknown"}`,
          reload: false,
        };
      }

      // 8. Push
      try {
        await gitPush(rp, status.branch);
      } catch (err) {
        return {
          message: `Push failed: ${err instanceof Error ? err.message : "Unknown"}\nLocal commits are preserved. Fix the remote issue and try again.`,
          reload: false,
        };
      }

      // 9. Apply final HEAD back to agent
      const newState = await loadState(this.agentDir);
      const applyResult = await this.applyCurrent(rp, config, newState, "push");

      return {
        message: `Pushed successfully.\n${applyResult.message}`,
        reload: applyResult.reload,
      };
    } finally {
      await this.lock.release();
    }
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

    if (state.pendingOperation !== "push-rebase-conflict") {
      return { message: "No pending push operation to continue.", reload: false };
    }

    const acquired = await this.lock.acquire("push-continue", 5000);
    if (!acquired) {
      return { message: "Another sync operation is in progress.", reload: false };
    }

    try {
      // 1. 确认无 unmerged paths
      if (await hasUnmergedPaths(rp)) {
        return {
          message: "There are still unmerged paths. Resolve all conflicts and run git add + git rebase --continue first.",
          reload: false,
        };
      }

      // 2. 确认工作树干净
      if (!(await isWorktreeClean(rp))) {
        return { message: "Worktree is not clean. Commit or stash changes first.", reload: false };
      }

      // 3. 校验最终提交
      const status = await gitStatus(rp);
      const diffFiles = await gitDiffRange(rp, `origin/${status.branch}`, "HEAD").catch(() => "");
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

      // 5. Push
      try {
        await gitPush(rp, status.branch);
      } catch (err) {
        return {
          message: `Push failed: ${err instanceof Error ? err.message : "Unknown"}`,
          reload: false,
        };
      }

      // 6. Apply + 更新状态
      const newState = { ...state, pendingOperation: null };
      await saveState(this.agentDir, newState);

      const applyResult = await this.applyCurrent(rp, config, newState, "push");

      return {
        message: `Push continued successfully.\n${applyResult.message}`,
        reload: applyResult.reload,
      };
    } finally {
      await this.lock.release();
    }
  }

  // ========== init (统一入口) ==========

  async init(gitUrl?: string): Promise<{
    message: string;
    needsReload: boolean;
    ok: boolean;
    level: "info" | "warning" | "error";
  }> {
    const defaultPath = join(this.agentDir, "..", "config-repo");

    // 已初始化：直接 apply
    if (await this.isAlreadyInitialized(defaultPath)) {
      return this.initAlreadyInitialized(defaultPath);
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

    // 校验 URL 格式
    if (!isValidGitUrl(gitUrl)) {
      return {
        message: `Invalid Git URL: ${gitUrl}\n` +
          "Expected formats:\n" +
          "  git@github.com:user/repo.git\n" +
          "  https://github.com/user/repo.git",
        needsReload: false,
        ok: false,
        level: "error",
      };
    }

    return this.initFresh(gitUrl, defaultPath);
  }

  private async initAlreadyInitialized(defaultPath: string): Promise<{
    message: string;
    needsReload: boolean;
    ok: boolean;
    level: "info" | "warning" | "error";
  }> {
    const acquired = await this.lock.acquire("apply", 5000);
    if (!acquired) {
      return { message: "Another sync operation is in progress.", needsReload: false, ok: false, level: "warning" };
    }

    try {
      // Fetch latest
      try {
        await gitFetch(defaultPath);
        const status = await gitStatus(defaultPath);
        if (status.behind > 0) {
          await gitPull(defaultPath, status.branch);
        }
      } catch { /* offline */ }

      const config = await loadPiSyncConfig(defaultPath);
      const state = await loadState(this.agentDir);
      const applyResult = await this.applyCurrent(defaultPath, config, state, "init");

      return {
        message: `Already initialized. Applied current config.\n${applyResult.message}`,
        needsReload: true,
        ok: true,
        level: "info",
      };
    } finally {
      await this.lock.release();
    }
  }

  private async initFresh(gitUrl: string, defaultPath: string): Promise<{
    message: string;
    needsReload: boolean;
    ok: boolean;
    level: "info" | "warning" | "error";
  }> {
    const acquired = await this.lock.acquire("init", 5000);
    if (!acquired) {
      return { message: "Another sync operation is in progress.", needsReload: false, ok: false, level: "warning" };
    }

    try {
      const lines: string[] = [];

      if (existsSync(defaultPath) && existsSync(join(defaultPath, ".git"))) {
        // 仓库已存在，验证 origin
        const existingResult = await gitExec(defaultPath, ["remote", "get-url", "origin"]);
        const existingUrl = existingResult.stdout.trim();

        if (!urlsMatch(existingUrl, gitUrl)) {
          return {
            message: `A config repo already exists at ${defaultPath}\n` +
              `Existing remote: ${existingUrl}\nProvided URL:   ${gitUrl}\n` +
              "To switch, remove the existing repo first: rm -rf ~/.pi/config-repo",
            needsReload: false, ok: false, level: "error",
          };
        }
        lines.push(`Config repo already exists at ${defaultPath}`);
      } else {
        // Clone
        lines.push(`Cloning ${gitUrl}...`);
        await mkdir(join(defaultPath, ".."), { recursive: true });

        // Preflight
        const preflight = await gitExec(
          process.cwd(),
          ["ls-remote", "--", gitUrl],
          { timeout: 30000 },
        );
        if (isGitFailure(preflight.stdout, preflight.stderr)) {
          return {
            message: `Clone failed: cannot reach ${gitUrl}\n${preflight.stderr.trim() || preflight.stdout.trim()}\n\n` +
              "Verify the URL, your network, and (for SSH URLs) that your key can authenticate.",
            needsReload: false, ok: false, level: "error",
          };
        }

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
            message: `Clone failed:\n${cloneResult.stderr.trim() || cloneResult.stdout.trim()}`,
            needsReload: false, ok: false, level: "error",
          };
        }
        lines.push("Clone complete.");
      }

      // Fetch latest
      await gitFetch(defaultPath).catch(() => {});

      // 检测仓库状态
      const repoState = await detectRepoState(defaultPath);

      if (repoState === "empty") {
        // Scaffold schema v2
        lines.push("Empty repository — scaffolding config structure (schema v2)...");
        await scaffoldConfigRepoV2(defaultPath);
        await gitCommit(defaultPath, "pi-sync: initial config scaffold (v2)");

        await gitRenameBranch(defaultPath, "main");
        try {
          await gitPush(defaultPath, "main");
          lines.push("Scaffold committed and pushed to origin/main.");
        } catch (err) {
          await updateState(this.agentDir, { repoPath: defaultPath });
          const detail = err instanceof Error ? err.message : "Unknown error";
          return {
            message: `${lines.join("\n")}\n\n` +
              "Scaffold committed locally but could not be pushed.\n" +
              "Resolve the remote issue, then run /pisync push.\n" +
              `Details: ${detail}`,
            needsReload: false, ok: false, level: "warning",
          };
        }
        lines.push("");
      } else if (repoState === "invalid") {
        return {
          message: `The repository at ${gitUrl} has commits but is not a valid pi-sync config repo.\n` +
            "A pi-sync config repo must have a pi-sync.json at its root.\n" +
            "Either use an empty repository for auto-scaffolding, or ensure the repo contains a valid pi-sync.json file.",
          needsReload: false, ok: false, level: "error",
        };
      } else {
        // Valid sync repo
        lines.push("Valid sync repo detected — fetching latest...");
        const status = await gitStatus(defaultPath);
        const { pulled } = await gitPull(defaultPath, status.branch);
        lines.push(pulled ? "Updated to latest." : "Already up to date.");
      }

      // 更新 state（但不再 pi install）
      await updateState(this.agentDir, { repoPath: defaultPath });

      // Apply config
      const config = await loadPiSyncConfig(defaultPath);
      const state = await loadState(this.agentDir);
      const applyResult = await this.applyCurrent(defaultPath, config, state, "init");
      lines.push(applyResult.message);

      lines.push("");
      lines.push("Setup complete! Your config is now synced.");
      lines.push("Use /pisync for day-to-day sync operations.");

      return {
        message: lines.join("\n"),
        needsReload: applyResult.reload,
        ok: true,
        level: "info",
      };
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

  // ========== doctor ==========

  async doctor(repoPath?: string): Promise<string> {
    const rp = repoPath ?? (await getRepoPathSafe(this.agentDir));
    if (!rp) return "No config repo configured.";

    const config = await loadPiSyncConfig(rp);
    const result = await runDoctorChecks(rp, this.agentDir, config);
    return formatDoctorResult(result);
  }

  // ========== rollback ==========

  async rollback(repoPath?: string): Promise<string> {
    const rp = repoPath ?? (await getRepoPathSafe(this.agentDir));
    if (!rp) return "No config repo configured.";

    const config = await loadPiSyncConfig(rp);

    const acquired = await this.lock.acquire("rollback", 5000);
    if (!acquired) {
      return "Another sync operation is in progress.";
    }

    try {
      const backups = await listBackups(this.agentDir);
      if (backups.length === 0) {
        return "No backups available for rollback.";
      }

      const latestBackup = backups[0]!;

      // 先创建当前状态备份
      const commit = await getHeadCommit(rp).catch(() => "unknown");
      await createBackup(this.agentDir, commit, "pre-rollback");

      // 恢复
      await restoreBackup(this.agentDir, latestBackup);

      return `Rolled back to backup: ${latestBackup.timestamp}\nCommit: ${latestBackup.commit}\nReason: ${latestBackup.reason}`;
    } finally {
      await this.lock.release();
    }
  }

  async rollbackList(): Promise<string> {
    const backups = await listBackups(this.agentDir);
    return formatBackupList(backups);
  }

  // ========== Private: applyCurrent ==========

  /**
   * 将当前 repo 状态应用到 agent
   */
  private async applyCurrent(
    rp: string,
    config: PiSyncConfig,
    state: SyncState,
    reason: string,
  ): Promise<{ message: string; reload: boolean }> {
    const commit = await getHeadCommit(rp);
    const lines: string[] = [];

    // 1. 生成 apply 计划
    const plan = await planMaterialize(this.agentDir, rp, config, state);

    if (plan.blocked) {
      const errorLines: string[] = [];
      if (plan.conflicts.length > 0) {
        errorLines.push("Bilateral conflicts detected:");
        for (const c of plan.conflicts) {
          errorLines.push(`  ${c.relativePath}`);
        }
      }
      if (plan.validationErrors.length > 0) {
        errorLines.push(formatValidationErrors(plan.validationErrors));
      }
      return { message: errorLines.join("\n"), reload: false };
    }

    if (plan.toWrite.length === 0 && plan.toDelete.length === 0) {
      return { message: "Already up to date.", reload: false };
    }

    // 2. 创建备份
    const backup = await createBackup(this.agentDir, commit, reason, plan);
    lines.push(`Backup created: ${backup.timestamp}`);

    // 3. 执行写入
    const result = await executeMaterialize(this.agentDir, plan);

    if (result.failed.length > 0) {
      // 失败 → 回滚
      lines.push(`ERROR: ${result.failed.length} files failed to apply.`);
      try {
        await restoreBackup(this.agentDir, backup);
        lines.push("Rolled back to pre-apply state.");
      } catch (rollbackErr) {
        lines.push(
          `Rollback failed: ${rollbackErr instanceof Error ? rollbackErr.message : "Unknown"}. ` +
          `Manual restore from backup: ${backup.path}`,
        );
      }
      lines.push(`Failed files: ${result.failed.map((f) => f.file).join(", ")}`);
      return { message: lines.join("\n"), reload: false };
    }

    if (result.written.length > 0) {
      lines.push(`Files written: ${result.written.length}`);
    }
    if (result.deleted.length > 0) {
      lines.push(`Files deleted: ${result.deleted.length}`);
    }

    // 4. 更新同步基线
    const newBaseline: Record<string, { sha256: string; mode: number }> = {};
    for (const relPath of result.written) {
      const file = await readAgentFile(this.agentDir, relPath);
      if (file) {
        newBaseline[relPath] = { sha256: file.sha256, mode: file.mode };
      }
    }
    // 删除的文件从基线中移除（由 result.deleted 隐式处理）

    await updateState(this.agentDir, {
      lastSyncedCommit: commit,
      lastSyncedAt: new Date().toISOString(),
      lastBackup: backup.timestamp,
      files: { ...state.files, ...newBaseline },
      pendingOperation: null,
    });

    // 5. Package reconciliation
    try {
      const pkgResult = await reconcilePackages(rp, this.agentDir, config);
      if (pkgResult.installed.length > 0) {
        lines.push(`Packages installed: ${pkgResult.installed.join(", ")}`);
      }
      if (pkgResult.errors.length > 0) {
        lines.push(`Package errors: ${pkgResult.errors.join("; ")}`);
      }
    } catch {
      // best-effort
    }

    return { message: lines.join("\n"), reload: true };
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
    } catch { /* */ }

    // 扫描变更的完整文件
    try {
      const syncRoot = join(rp, config.root);
      const { readdir: rd } = await import("node:fs/promises");
      const { isPathAllowed } = await import("./glob.ts");

      async function walk(dir: string): Promise<void> {
        if (!existsSync(dir)) return;
        let entries;
        try { entries = await rd(dir, { withFileTypes: true }); } catch { return; }
        for (const entry of entries) {
          const fullPath = join(dir, entry.name);
          const relPath = fullPath.replace(syncRoot + "/", "").replace(syncRoot, "");
          if (entry.name.startsWith(".")) continue;
          if (entry.isDirectory()) { await walk(fullPath); continue; }
          if (!entry.isFile()) continue;

          const allowed = isPathAllowed(relPath, config.include, config.exclude);
          if (!allowed.allowed) continue;

          try {
            const content = await readFile(fullPath, "utf-8");
            findings.push(...scanSecrets(content, relPath));
          } catch { /* */ }
        }
      }

      await walk(syncRoot);
    } catch { /* */ }

    return findings;
  }

  private async getRepoSyncFiles(
    rp: string,
    config: PiSyncConfig,
  ): Promise<string[]> {
    const syncRoot = join(rp, config.root);
    const files: string[] = [];
    const { readdir: rd } = await import("node:fs/promises");

    async function walk(dir: string): Promise<void> {
      if (!existsSync(dir)) return;
      let entries;
      try { entries = await rd(dir, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        const fullPath = join(dir, entry.name);
        const relPath = fullPath.replace(syncRoot + "/", "").replace(syncRoot, "");
        if (entry.name.startsWith(".")) continue;
        if (entry.isDirectory()) { await walk(fullPath); continue; }
        if (entry.isFile()) files.push(relPath);
      }
    }

    await walk(syncRoot);
    return files;
  }
}

// ========== 辅助函数 ==========

async function detectRepoState(repoPath: string): Promise<"empty" | "valid" | "invalid"> {
  let hasCommits = false;
  try {
    const result = await gitExec(repoPath, ["rev-list", "--count", "HEAD"]);
    hasCommits = parseInt(result.stdout.trim(), 10) > 0;
  } catch {
    hasCommits = false;
  }

  if (!hasCommits) return "empty";
  if (existsSync(join(repoPath, "pi-sync.json"))) return "valid";
  return "invalid";
}

/**
 * 在空仓库中生成 schema v2 脚手架
 * 不再生成 package.json（配置仓库不是 Pi Package）
 */
async function scaffoldConfigRepoV2(repoPath: string): Promise<void> {
  const { mkdir: mkd, writeFile: wf } = await import("node:fs/promises");

  await mkd(join(repoPath, "sync"), { recursive: true });
  await mkd(join(repoPath, "sync", "extensions"), { recursive: true });
  await mkd(join(repoPath, "sync", "skills"), { recursive: true });
  await mkd(join(repoPath, "sync", "prompts"), { recursive: true });
  await mkd(join(repoPath, "sync", "themes"), { recursive: true });

  // pi-sync.json (schema v2)
  const piSync = {
    schemaVersion: 2,
    branch: "main",
    root: "sync",
    include: [
      "settings.json",
      "AGENTS.md",
      "SYSTEM.md",
      "APPEND_SYSTEM.md",
      "keybindings.json",
      "extensions/**",
      "skills/**",
      "prompts/**",
      "themes/**",
    ],
    exclude: [
      "**/.DS_Store",
      "**/*.tmp",
      "**/*.log",
    ],
    delete: "tracked",
    security: {
      scanSecretsBeforePush: true,
    },
  };
  await wf(join(repoPath, "pi-sync.json"), JSON.stringify(piSync, null, 2), "utf-8");

  // sync/settings.json (空模板)
  await wf(
    join(repoPath, "sync", "settings.json"),
    JSON.stringify({
      packages: [
        "npm:@jachy/pi-git-sync",
      ],
    }, null, 2),
    "utf-8",
  );

  // .gitignore
  await wf(join(repoPath, ".gitignore"), "# Local state\n.pi-sync/\n", "utf-8");
}

function isValidGitUrl(url: string): boolean {
  if (/^git@[\w.-]+:[\w./-]+(\.git)?$/.test(url)) return true;
  if (/^https?:\/\/[\w.-]+(:\d+)?\/[\w./-]+(\.git)?$/.test(url)) return true;
  if (/^ssh:\/\/git@[\w.-]+(:\d+)?\/[\w./-]+(\.git)?$/.test(url)) return true;
  if (/^git:\/\/[\w.-]+(:\d+)?\/[\w./-]+(\.git)?$/.test(url)) return true;
  return false;
}

function urlsMatch(a: string, b: string): boolean {
  const normalize = (url: string) =>
    url
      .replace(/^https?:\/\//, "")
      .replace(/^ssh:\/\/git@/, "")
      .replace(/^git@/, "")
      .replace(/\.git$/, "")
      .replace(/:\d+\//, "/")
      .toLowerCase();
  return normalize(a) === normalize(b);
}
