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
import { readFile, mkdir } from "node:fs/promises";
import {
  gitStatus, gitFetch, gitPull, gitPush, gitRenameBranch,
  gitDiff, gitDiffRange, gitDiffStaged,
  gitRebase,
  gitCommit, getHeadCommit, isDiverged,
  hasUnmergedPaths, isWorktreeClean, gitExec, gitProbe,
  gitRemoteRefExists, GitCommandError,
} from "./git.ts";
import { loadPiSyncConfig } from "./config.ts";
import type { PiSyncConfig } from "./config.ts";
import { planMaterialize, executeMaterialize } from "./materialize.ts";
import { createBackup, listBackups, restoreBackup } from "./backup.ts";
import { SyncLock } from "./lock.ts";
import { scanSecrets } from "./security.ts";
import { loadState, saveState, updateState } from "./state.ts";
import type { SyncState } from "./state.ts";
import type { CommandResult, ResultCode } from "./operation-result.ts";
import { captureChanges } from "./capture.ts";
import { compareFiles, hasLocalChanges, sha256 } from "./inventory.ts";
import { validateFiles } from "./validate.ts";
import { runDoctorChecks } from "./doctor.ts";
import {
  getPackageDiff, preparePackagePlan, executePackagePlan,
  approvePackagePlan,
} from "./packages.ts";
import type { PackageApproval } from "./packages.ts";
import { resolveRepoSyncRoot } from "./path-safety.ts";
import {
  formatGitStatus, formatSyncStatusV2, formatComparisonDiff,
  formatDoctorResult, formatSecretsFindings, formatBackupList,
  formatValidationErrors, formatCaptureResult,
} from "./ui.ts";

// ========== 路径工具 ==========

export function getAgentDir(): string {
  const envDir = process.env.PI_CODING_AGENT_DIR;
  if (envDir) return envDir;

  const home = process.env.HOME ?? process.env.USERPROFILE ?? "~";
  return join(home, ".pi", "agent");
}

export async function getRepoPathSafe(_agentDir: string): Promise<string | null> {
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

/**
 * Ensure all sync operations use the branch declared by pi-sync.json.
 * A clean worktree may be switched; dirty or in-progress Git operations are
 * rejected so we never move user work implicitly.
 */
export async function ensureConfiguredBranch(repoPath: string, branch: string): Promise<boolean> {
  const branchFormat = await gitProbe(repoPath, ["check-ref-format", "--branch", branch]);
  if (!branchFormat.ok) {
    throw new Error(`Invalid configured sync branch "${branch}".`);
  }

  const status = await gitStatus(repoPath);
  if (status.branch === branch) return false;
  if (status.isRebasing || status.isMerging || status.hasUncommittedChanges) {
    throw new Error(
      `Configured sync branch is "${branch}", but repository is on "${status.branch}" ` +
      "with local changes or an active Git operation. Switch branches manually after resolving it.",
    );
  }

  const localRef = await gitProbe(repoPath, ["show-ref", "--verify", `refs/heads/${branch}`]);
  if (localRef.ok) {
    await gitExec(repoPath, ["switch", branch]);
    return true;
  }

  const remoteRef = await gitProbe(repoPath, ["show-ref", "--verify", `refs/remotes/origin/${branch}`]);
  if (!remoteRef.ok) {
    throw new Error(`Configured sync branch "${branch}" does not exist locally or on origin.`);
  }
  await gitExec(repoPath, ["switch", "--track", "-c", branch, `origin/${branch}`]);
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
}

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

function resultFromPreparation(preparation: PushPreparation): CommandResult {
  if (preparation.kind === "ready") {
    return {
      ok: false,
      code: "partial_failure",
      message: preparation.message ?? "Push preparation is ready for confirmation.",
      reload: false,
      details: preparation,
    };
  }
  return {
    ok: preparation.kind === "noop",
    code: preparation.kind === "noop" ? "noop" : "blocked_conflict",
    message: preparation.message ?? (preparation.kind === "noop" ? "No changes to push." : "Push blocked."),
    reload: false,
    details: preparation,
  };
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
    const status = await gitStatus(rp, config.branch);
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
    const status = await gitStatus(rp, config.branch);
    const state = await loadState(this.agentDir);

    // 三方比较
    const inventory = await compareFiles(this.agentDir, rp, config, state);

    const lines: string[] = [];

    // Git 状态
    lines.push("=== Git Status ===");
    lines.push(formatGitStatus(status));
    if (status.branch !== config.branch) {
      lines.push(`WARNING: config.branch is "${config.branch}" but repository is on "${status.branch}".`);
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
      try {
        await ensureConfiguredBranch(rp, config.branch);
      } catch (error) {
        return `Capture blocked: ${error instanceof Error ? error.message : "Configured branch check failed."}`;
      }
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

  async apply(repoPath?: string, packageApproval?: PackageApproval): Promise<CommandResult> {
    const rp = repoPath ?? (await getRepoPath());
    const config = await loadPiSyncConfig(rp);
    const state = await loadState(this.agentDir);

    const acquired = await this.lock.acquire("apply", 5000);
    if (!acquired) {
      return {
        ok: false,
        code: "partial_failure",
        message: "Another sync operation is in progress.",
        reload: false,
      };
    }

    try {
      try {
        await ensureConfiguredBranch(rp, config.branch);
      } catch (error) {
        return {
          ok: false,
          code: "blocked_conflict",
          message: error instanceof Error ? error.message : "Configured branch check failed.",
          reload: false,
        };
      }
      return await this.applyCurrent(rp, config, state, "apply", packageApproval);
    } finally {
      await this.lock.release();
    }
  }

  // ========== pull ==========

  async pull(repoPath?: string, packageApproval?: PackageApproval): Promise<CommandResult> {
    const rp = repoPath ?? (await getRepoPath());
    const config = await loadPiSyncConfig(rp);
    const state = await loadState(this.agentDir);

    const acquired = await this.lock.acquire("pull", 5000);
    if (!acquired) {
      return {
        ok: false,
        code: "partial_failure",
        message: "Another sync operation is in progress.",
        reload: false,
      };
    }

    try {
      // 1. 检查 repo 状态。若需要从另一个干净分支切换，先 fetch 目标
      // branch，使 ensureConfiguredBranch 能建立 origin/<branch> tracking branch。
      let status = await gitStatus(rp);
      let switchedBranch = false;
      if (status.branch !== config.branch) {
        if (status.isRebasing || status.isMerging || status.hasUncommittedChanges) {
          return {
            ok: false,
            code: "blocked_conflict",
            message: `Configured sync branch is "${config.branch}", but repository is on "${status.branch}" with local changes or an active Git operation. Switch branches manually after resolving it.`,
            reload: false,
          };
        }
        try {
          await gitFetch(rp);
          switchedBranch = await ensureConfiguredBranch(rp, config.branch);
          status = await gitStatus(rp);
        } catch (error) {
          return {
            ok: false,
            code: "blocked_conflict",
            message: error instanceof Error ? error.message : "Configured branch check failed.",
            reload: false,
          };
        }
      }

      if (status.isRebasing || status.isMerging) {
        return {
          ok: false,
          code: "blocked_conflict",
          message: "Repository is in rebase/merge state. Resolve conflicts first.",
          reload: false,
        };
      }

      if (status.hasUncommittedChanges) {
        return {
          ok: false,
          code: "blocked_conflict",
          message: "Repository has uncommitted changes. Commit or stash them first.",
          reload: false,
        };
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
          ok: false,
          code: "blocked_conflict",
          message: `Local changes detected that have not been captured:\n${localChanges}\n\nRun /pisync push or /pisync capture first, or discard local changes.`,
          reload: false,
          details: { localChanges: inventory.comparisons.filter((c) =>
            c.changeType === "local_only" ||
            c.changeType === "local_created" ||
            c.changeType === "local_deleted",
          ).map((c) => c.relativePath) },
        };
      }

      // 3. Fetch
      try {
        await gitFetch(rp);
      } catch (err) {
        return {
          ok: false,
          code: "git_failed",
          message: `git fetch failed: ${err instanceof Error ? err.message : "Unknown"}`,
          reload: false,
        };
      }

      // 4. 检查 divergence
      const diverged = await isDiverged(rp, config.branch, `origin/${config.branch}`);
      if (diverged) {
        return {
          ok: false,
          code: "blocked_conflict",
          message: "Local and remote branches have diverged. Resolve manually with git pull --rebase in the repo.",
          reload: false,
        };
      }

      // 5. Pull (fast-forward only)
      const { pulled } = await gitPull(rp, config.branch);
      const newState = await loadState(this.agentDir);
      if (!pulled) {
        // A previous pull may have fast-forwarded before package approval was
        // granted. Re-run apply so approval can complete without another pull.
        if (packageApproval || switchedBranch) {
          return await this.applyCurrent(rp, config, newState, "pull", packageApproval);
        }
        return { ok: true, code: "noop", message: "Already up to date.", reload: false };
      }

      // 6. Apply
      return await this.applyCurrent(rp, config, newState, "pull", packageApproval);
    } finally {
      await this.lock.release();
    }
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
      captured: [], deleted: [], denied: [], errors: [], hasConflicts: false, conflicts: [],
    };

    const acquired = await this.lock.acquire("push-prepare", 5000);
    if (!acquired) {
      return {
        kind: "blocked", capture: emptyCapture, changedFiles: [], diff: "", repoHead: "",
        worktreeFingerprint: "", repoPath: rp, branch: config.branch,
        message: "Another sync operation is in progress.",
      };
    }

    try {
      let statusBefore = await gitStatus(rp);
      if (statusBefore.branch !== config.branch &&
          !statusBefore.isRebasing && !statusBefore.isMerging && !statusBefore.hasUncommittedChanges) {
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
          kind: "blocked", capture: emptyCapture, changedFiles: [], diff: "",
          repoHead: statusBefore.commit, worktreeFingerprint: "", repoPath: rp, branch: config.branch,
          message: error instanceof Error ? error.message : "Configured branch check failed.",
        };
      }
      if (statusBefore.isRebasing || statusBefore.isMerging || statusBefore.hasConflicts) {
        return {
          kind: "blocked", capture: emptyCapture, changedFiles: [], diff: "",
          repoHead: statusBefore.commit, worktreeFingerprint: "", repoPath: rp,
          branch: config.branch,
          message: "Repository is in conflict/resolution state. Resolve it before preparing push.",
        };
      }

      const capture = await captureChanges(this.agentDir, rp, config, state);
      if (capture.hasConflicts) {
        const conflicts = capture.conflicts.map((c) => `  ${c.relativePath}`).join("\n");
        return {
          kind: "blocked", capture, changedFiles: [], diff: "", repoHead: statusBefore.commit,
          worktreeFingerprint: "", repoPath: rp, branch: config.branch,
          message: `Push blocked: bilateral modifications detected.\n\nConflicts:\n${conflicts}`,
        };
      }
      if (capture.errors.length > 0) {
        return {
          kind: "blocked", capture, changedFiles: [], diff: "", repoHead: statusBefore.commit,
          worktreeFingerprint: "", repoPath: rp, branch: config.branch,
          message: `Push blocked while capturing files.\n${capture.errors.map((e) => `${e.file}: ${e.message}`).join("\n")}`,
        };
      }

      const status = await gitStatus(rp);
      const changedFiles = this.normalizeRepoChangedFiles(status.changedFiles, config);
      if (!status.hasUncommittedChanges) {
        const head = await getHeadCommit(rp);
        return {
          kind: "noop", capture, changedFiles: [], diff: "", repoHead: head,
          worktreeFingerprint: await this.computePushFingerprint(rp, config, state),
          repoPath: rp, branch: config.branch, message: "No changes to push.",
        };
      }

      const validation = await validateFiles(rp, config, changedFiles);
      if (validation.blocked) {
        return {
          kind: "blocked", capture, changedFiles, diff: await gitDiff(rp),
          repoHead: status.commit,
          worktreeFingerprint: await this.computePushFingerprint(rp, config, state),
          repoPath: rp, branch: config.branch,
          message: `Push blocked: validation errors.\n${formatValidationErrors(validation.errors)}`,
        };
      }

      if (config.security.scanSecretsBeforePush) {
        const secretFindings = await this.scanForSecrets(rp, config);
        if (secretFindings.length > 0) {
          return {
            kind: "blocked", capture, changedFiles, diff: await gitDiff(rp),
            repoHead: status.commit,
            worktreeFingerprint: await this.computePushFingerprint(rp, config, state),
            repoPath: rp, branch: config.branch,
            message: `Push blocked: potential secrets detected.\n${formatSecretsFindings(secretFindings)}`,
          };
        }
      }

      // Package preparation is read-only here. Installation belongs to the
      // apply phase after settings have been materialized.
      try {
        const packagePlan = await preparePackagePlan(rp, this.agentDir, config);
        if (packagePlan.approvalRequired.length > 0) {
          return {
            kind: "blocked", capture, changedFiles, diff: await gitDiff(rp),
            repoHead: status.commit,
            worktreeFingerprint: await this.computePushFingerprint(rp, config, state),
            repoPath: rp, branch: config.branch,
            message: `Package approval required before push: ${packagePlan.approvalRequired.join(", ")}`,
          };
        }
      } catch (error) {
        return {
          kind: "blocked", capture, changedFiles, diff: await gitDiff(rp),
          repoHead: status.commit,
          worktreeFingerprint: await this.computePushFingerprint(rp, config, state),
          repoPath: rp, branch: config.branch,
          message: `Package validation failed: ${error instanceof Error ? error.message : "Unknown"}`,
        };
      }

      return {
        kind: "ready", capture, changedFiles, diff: await gitDiff(rp),
        repoHead: status.commit,
        worktreeFingerprint: await this.computePushFingerprint(rp, config, state),
        repoPath: rp, branch: config.branch,
        message: `Push ready: ${changedFiles.length} changed file(s).`,
      };
    } finally {
      await this.lock.release();
    }
  }

  /** 执行已确认的 preparation，并在执行前重新校验 HEAD/worktree 指纹。 */
  async executePush(
    preparation: PushPreparation,
    message?: string,
  ): Promise<CommandResult> {
    if (preparation.kind !== "ready") return resultFromPreparation(preparation);

    const acquired = await this.lock.acquire("push", 5000);
    if (!acquired) {
      return { ok: false, code: "partial_failure", message: "Another sync operation is in progress.", reload: false };
    }

    try {
      const rp = preparation.repoPath;
      const config = await loadPiSyncConfig(rp);
      const state = await loadState(this.agentDir);
      try {
        await ensureConfiguredBranch(rp, config.branch);
      } catch (error) {
        return {
          ok: false,
          code: "blocked_conflict",
          message: error instanceof Error ? error.message : "Configured branch check failed.",
          reload: false,
        };
      }
      const currentHead = await getHeadCommit(rp);
      const currentFingerprint = await this.computePushFingerprint(rp, config, state);
      if (currentHead !== preparation.repoHead || currentFingerprint !== preparation.worktreeFingerprint) {
        return {
          ok: false, code: "blocked_conflict",
          message: "Push preparation is stale: the repository or agent changed after confirmation. Prepare push again.",
          reload: false,
        };
      }

      await gitCommit(rp, message ?? "pi-sync: update configuration");

      try {
        await gitFetch(rp);
      } catch (err) {
        return {
          ok: false, code: "git_failed",
          message: `git fetch failed after local commit: ${err instanceof Error ? err.message : "Unknown"}. Local commit is preserved.`,
          reload: false,
        };
      }

      const remoteRefExists = await gitRemoteRefExists(rp, preparation.branch);
      if (remoteRefExists) {
        try {
          const rebaseResult = await gitRebase(rp, preparation.branch);
          if (rebaseResult.conflict) {
            await updateState(this.agentDir, {
              pendingOperation: { type: "push-rebase-conflict", startedAt: new Date().toISOString() },
            });
            return {
              ok: false, code: "blocked_conflict",
              message: "Rebase conflict detected. Resolve conflicts, run git add and git rebase --continue, then /pisync push --continue.",
              reload: false,
            };
          }
        } catch (err) {
          return { ok: false, code: "git_failed", message: `Rebase failed: ${err instanceof Error ? err.message : "Unknown"}`, reload: false };
        }
      }

      try {
        await gitPush(rp, preparation.branch);
      } catch (err) {
        return {
          ok: false, code: "git_failed",
          message: `Push failed: ${err instanceof Error ? err.message : "Unknown"}\nLocal commits are preserved.`,
          reload: false,
        };
      }

      const newState = await loadState(this.agentDir);
      const applyResult = await this.applyCurrent(rp, config, newState, "push");
      const partial = /^(ERROR|Rollback failed)|Package errors:/m.test(applyResult.message);
      return {
        ok: !partial,
        code: partial ? "partial_failure" : "ok",
        message: `Pushed successfully.\n${applyResult.message}`,
        reload: applyResult.reload,
      };
    } finally {
      await this.lock.release();
    }
  }

  async push(
    repoPath?: string,
    message?: string,
    subCommand?: string,
  ): Promise<{ message: string; reload: boolean }> {
    if (subCommand === "--continue") return this.pushContinue(repoPath);
    const preparation = await this.preparePush(repoPath);
    if (preparation.kind !== "ready") {
      return { message: preparation.message ?? "Push blocked.", reload: false };
    }
    const result = await this.executePush(preparation, message);
    return { message: result.message, reload: result.reload };
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
      return { message: "No pending push operation to continue.", reload: false };
    }

    const acquired = await this.lock.acquire("push-continue", 5000);
    if (!acquired) {
      return { message: "Another sync operation is in progress.", reload: false };
    }

    try {
      try {
        await ensureConfiguredBranch(rp, config.branch);
      } catch (error) {
        return { message: error instanceof Error ? error.message : "Configured branch check failed.", reload: false };
      }

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
      await gitDiffRange(rp, `origin/${config.branch}`, "HEAD").catch(() => "");
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
        await gitPush(rp, config.branch);
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

  async init(
    gitUrl?: string,
    onProgress?: (message: string) => void,
    force = false,
    packageApproval?: PackageApproval,
  ): Promise<InitResult> {
    const defaultPath = join(this.agentDir, "..", "config-repo");

    // 已初始化：直接 apply（force 时跳过，走 fresh 流程）
    if (!force && await this.isAlreadyInitialized(defaultPath)) {
      return normalizeInitResult(await this.initAlreadyInitialized(defaultPath, onProgress, packageApproval));
    }

    // 未初始化 — 需要 gitUrl
    if (!gitUrl) {
      return normalizeInitResult({
        message: "Enter your config repo Git URL to get started:\n" +
          "  /pisync init git@github.com:you/pi-config.git",
        needsReload: false,
        ok: false,
        code: "blocked_validation",
        details: { needsGitUrl: true },
        level: "info",
      });
    }

    // 校验 URL 格式
    if (!isValidGitUrl(gitUrl)) {
      return normalizeInitResult({
        message: `Invalid Git URL: ${gitUrl}\n` +
          "Expected formats:\n" +
          "  git@github.com:user/repo.git\n" +
          "  https://github.com/user/repo.git",
        needsReload: false,
        ok: false,
        code: "blocked_validation",
        level: "error",
      });
    }

    return normalizeInitResult(await this.initFresh(gitUrl, defaultPath, onProgress, force, packageApproval));
  }

  private async initAlreadyInitialized(
    defaultPath: string,
    onProgress?: (message: string) => void,
    packageApproval?: PackageApproval,
  ): Promise<InitInternalResult> {
    const acquired = await this.lock.acquire("apply", 5000);
    if (!acquired) {
      return { message: "Another sync operation is in progress.", needsReload: false, ok: false, level: "warning" };
    }

    try {
      const config = await loadPiSyncConfig(defaultPath);

      // Fetch latest
      onProgress?.("Fetching latest changes...");
      try {
        await gitFetch(defaultPath);
      } catch { /* offline */ }

      try {
        await ensureConfiguredBranch(defaultPath, config.branch);
      } catch (error) {
        return {
          message: error instanceof Error ? error.message : "Configured branch check failed.",
          needsReload: false,
          ok: false,
          code: "blocked_conflict",
          level: "error",
        };
      }

      const status = await gitStatus(defaultPath);
      if (status.behind > 0) {
        onProgress?.("Pulling remote changes...");
        await gitPull(defaultPath, config.branch);
      }

      onProgress?.("Applying config to agent...");
      const state = await loadState(this.agentDir);
      const applyResult = await this.applyCurrent(defaultPath, config, state, "init", packageApproval);

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
      return { message: "Another sync operation is in progress.", needsReload: false, ok: false, level: "warning" };
    }

    try {
      const lines: string[] = [];

      onProgress?.("Checking local repo...");

      if (existsSync(defaultPath) && existsSync(join(defaultPath, ".git"))) {
        if (force) {
          // --force: remove existing repo and re-clone
          onProgress?.("Removing existing repo (--force)...");
          lines.push("Force flag set — removing existing repo and re-cloning...");
          const { rm } = await import("node:fs/promises");
          await rm(defaultPath, { recursive: true, force: true });
          // Continue to clone below
        } else {
          // 仓库已存在，验证 origin
          const existingProbe = await gitProbe(defaultPath, ["remote", "get-url", "origin"]);
          const existingUrl = existingProbe.stdout.trim();

          if (!urlsMatch(existingUrl, gitUrl)) {
            return {
              message: `A config repo already exists at ${defaultPath}\n` +
                `Existing remote: ${existingUrl}\nProvided URL:   ${gitUrl}\n` +
                "To switch, remove the existing repo first: rm -rf ~/.pi/config-repo\n" +
                "Or use: /pisync init --force <git-url>",
              needsReload: false, ok: false, level: "error",
            };
          }
          lines.push(`Config repo already exists at ${defaultPath}`);
        }
      }

      // Clone if no existing repo (or after force-removal above)
      if (!existsSync(defaultPath) || !existsSync(join(defaultPath, ".git"))) {
        onProgress?.(`Cloning ${gitUrl}...`);
        lines.push(`Cloning ${gitUrl}...`);
        await mkdir(join(defaultPath, ".."), { recursive: true });

        // Preflight
        onProgress?.("Checking remote connectivity...");
        const preflight = await gitProbe(
          process.cwd(),
          ["ls-remote", "--", gitUrl],
          { timeout: 30000 },
        );
        if (!preflight.ok) {
          return {
            message: `Clone failed: cannot reach ${gitUrl}\n${preflight.stderr.trim() || preflight.stdout.trim()}\n\n` +
              "Verify the URL, your network, and (for SSH URLs) that your key can authenticate.",
            needsReload: false, ok: false, level: "error",
          };
        }

        try {
          await gitExec(
            join(defaultPath, ".."),
            ["clone", "--", gitUrl, defaultPath],
            { timeout: 60000 },
          );
        } catch (cloneErr) {
          if (existsSync(defaultPath)) {
            const { rm } = await import("node:fs/promises");
            await rm(defaultPath, { recursive: true, force: true });
          }
          const msg = cloneErr instanceof GitCommandError
            ? (cloneErr.stderr || cloneErr.stdout || cloneErr.message)
            : (cloneErr instanceof Error ? cloneErr.message : "Unknown error");
          return {
            message: `Clone failed:\n${msg}`,
            needsReload: false, ok: false, level: "error",
          };
        }
        if (!existsSync(join(defaultPath, ".git"))) {
          return {
            message: "Clone completed but .git directory not found.",
            needsReload: false, ok: false, level: "error",
          };
        }
        lines.push("Clone complete.");
      }

      // Fetch latest
      onProgress?.("Fetching latest changes...");
      await gitFetch(defaultPath).catch(() => {});

      // 检测仓库状态
      onProgress?.("Analyzing repo state...");
      const repoState = await detectRepoState(defaultPath);

      if (force || repoState === "empty") {
        // Scaffold schema v2
        // force: always scaffold regardless of repo state — skip the "invalid" error below
        if (force && repoState !== "empty") {
          onProgress?.("Clearing existing repo contents (--force)...");
          lines.push("Force flag set — clearing existing repo contents...");
          await clearRepoContents(defaultPath);
          await gitExec(defaultPath, ["add", "-A"]);
          await gitExec(defaultPath, ["commit", "-m", "pi-sync: force clear before rebuild", "--allow-empty"]);
        }

        onProgress?.("Scaffolding config structure...");
        lines.push(`${force && repoState !== "empty" ? "Force rebuilding" : "Empty repository"} — scaffolding config structure (schema v2)...`);
        await scaffoldConfigRepoV2(defaultPath);
        const scaffoldConfig = await loadPiSyncConfig(defaultPath);
        onProgress?.("Committing scaffold...");
        await gitCommit(defaultPath, "pi-sync: initial config scaffold (v2)");

        onProgress?.("Pushing to remote...");
        await gitRenameBranch(defaultPath, scaffoldConfig.branch);
        try {
          const pushArgs = force
            ? ["push", "--force", "origin", scaffoldConfig.branch]
            : ["push", "origin", scaffoldConfig.branch];
          if (force) {
            await gitExec(defaultPath, pushArgs);
          } else {
            await gitPush(defaultPath, scaffoldConfig.branch);
          }
          lines.push(`Scaffold committed and pushed to origin/${scaffoldConfig.branch}.`);
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
            "Either use an empty repository for auto-scaffolding, or ensure the repo contains a valid pi-sync.json file.\n\n" +
            "To force rebuild this repository, use: /pisync init --force <git-url>",
          needsReload: false, ok: false, level: "error",
        };
      } else {
        // Valid sync repo: load the declared branch before any pull.
        onProgress?.("Fetching latest...");
        lines.push("Valid sync repo detected — fetching latest...");
        const existingConfig = await loadPiSyncConfig(defaultPath);
        await ensureConfiguredBranch(defaultPath, existingConfig.branch);
        const { pulled } = await gitPull(defaultPath, existingConfig.branch);
        lines.push(pulled ? "Updated to latest." : "Already up to date.");
      }

      // 更新 state（但不再 pi install）
      onProgress?.("Saving state...");
      await updateState(this.agentDir, { repoPath: defaultPath });

      // Apply config
      onProgress?.("Applying config to agent...");
      const config = await loadPiSyncConfig(defaultPath);
      const state = await loadState(this.agentDir);
      const applyResult = await this.applyCurrent(defaultPath, config, state, "init", packageApproval);
      lines.push(applyResult.message);

      if (!applyResult.ok) {
        return {
          message: lines.join("\n"),
          needsReload: false,
          ok: false,
          code: applyResult.code,
          details: applyResult.details,
          level: applyResult.code === "approval_required" ? "warning" : "error",
        };
      }

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

  // ========== debug: clear-repo ==========

  async clearRepo(repoPath?: string): Promise<{ message: string; reload: boolean }> {
    const rp = repoPath ?? (await getRepoPathSafe(this.agentDir));
    if (!rp) return { message: "No config repo configured.", reload: false };

    const acquired = await this.lock.acquire("clear-repo", 5000);
    if (!acquired) {
      return { message: "Another sync operation is in progress.", reload: false };
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
  private async applyCurrent(
    rp: string,
    config: PiSyncConfig,
    state: SyncState,
    reason: string,
    packageApproval?: PackageApproval,
  ): Promise<CommandResult> {
    const commit = await getHeadCommit(rp);
    const lines: string[] = [];

    // 1. 生成 apply 计划（包含完整 nextBaseline）
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
      return {
        ok: false,
        code: plan.conflicts.length > 0 ? "blocked_conflict" : "blocked_validation",
        message: errorLines.join("\n"),
        reload: false,
        details: { conflicts: plan.conflicts, validationErrors: plan.validationErrors },
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
      if (!packageApproval || !approvePackagePlan(packagePlan, packageApproval).approved) {
        return {
          ok: false,
          code: "approval_required",
          message: `Package approval required before applying settings: ${packagePlan.approvalRequired.join(", ")}`,
          reload: false,
          details: { packages: packagePlan.approvalRequired },
        };
      }
    }
    let packageResult: Awaited<ReturnType<typeof executePackagePlan>> = { installed: [], errors: [] };

    // 3. 无文件 I/O 且基线已一致 → 真正 no-op
    const hasFileOperations = plan.toWrite.length > 0 || plan.toDelete.length > 0;
    const baselineChanged = plan.nextBaseline !== null &&
      JSON.stringify(plan.nextBaseline) !== JSON.stringify(state.files);
    const commitChanged = state.lastSyncedCommit !== commit;
    const branchChanged = state.branch !== config.branch;

    if (!hasFileOperations && !baselineChanged && !commitChanged && !branchChanged) {
      return { ok: true, code: "noop", message: "Already up to date.", reload: false };
    }

    // 3. 无文件 I/O 但基线或 commit 需要收敛 → 仅更新 state，不 reload
    if (!hasFileOperations && plan.nextBaseline) {
      await updateState(this.agentDir, {
        lastSyncedCommit: commit,
        lastSyncedAt: new Date().toISOString(),
        branch: config.branch,
        files: plan.nextBaseline,
        pendingOperation: null,
      });
      lines.push("Sync state updated (no file changes needed).");

      return { ok: true, code: "ok", message: lines.join("\n"), reload: false };
    }

    // 4. 有文件变更 → 创建备份。备份失败时 fail-closed，绝不开始写入。
    let backup: Awaited<ReturnType<typeof createBackup>>;
    try {
      backup = await createBackup(this.agentDir, commit, reason, plan);
    } catch (error) {
      return {
        ok: false,
        code: "partial_failure",
        message: `Backup failed; apply blocked: ${error instanceof Error ? error.message : "Unknown"}`,
        reload: false,
        details: { backupFailed: true },
      };
    }
    lines.push(`Backup created: ${backup.timestamp}`);

    // 5. 执行写入
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
      return { ok: false, code: "partial_failure", message: lines.join("\n"), reload: false };
    }

    if (result.written.length > 0) {
      lines.push(`Files written: ${result.written.length}`);
    }
    if (result.deleted.length > 0) {
      lines.push(`Files deleted: ${result.deleted.length}`);
    }

    // 6. settings 已经写入后才执行 package 安装。安装失败时恢复本次
    //    apply，保留 pending operation，并且绝不提交完成状态。
    try {
      packageResult = await executePackagePlan(packagePlan, this.agentDir, { approval: packageApproval });
    } catch (error) {
      packageResult = {
        installed: [],
        errors: [`Unexpected package execution failure: ${error instanceof Error ? error.message : "Unknown"}`],
      };
    }
    if (packageResult.approvalRequired?.length || packageResult.errors.length > 0) {
      lines.push(
        `ERROR: Package installation failed: ${packageResult.errors.join("; ") ||
          packageResult.approvalRequired?.join(", ") || "Unknown"}`,
      );
      try {
        await restoreBackup(this.agentDir, backup);
        lines.push("Rolled back to pre-apply state.");
      } catch (rollbackErr) {
        lines.push(
          `Rollback failed: ${rollbackErr instanceof Error ? rollbackErr.message : "Unknown"}. ` +
          `Manual restore from backup: ${backup.path}`,
        );
      }
      try {
        await updateState(this.agentDir, {
          pendingOperation: {
            type: "apply-failed",
            startedAt: new Date().toISOString(),
            context: {
              commit,
              reason,
              backupPath: backup.path,
              packageErrors: packageResult.errors,
            },
          },
        });
      } catch (stateError) {
        lines.push(`Could not record pending operation: ${stateError instanceof Error ? stateError.message : "Unknown"}`);
      }
      return { ok: false, code: "partial_failure", message: lines.join("\n"), reload: false };
    }

    // 7. 用 nextBaseline 完整替换 state.files（不合并）
    if (!plan.nextBaseline) {
      lines.push("ERROR: No baseline computed after successful apply.");
      return { ok: false, code: "partial_failure", message: lines.join("\n"), reload: false };
    }

    await updateState(this.agentDir, {
      lastSyncedCommit: commit,
      lastSyncedAt: new Date().toISOString(),
      branch: config.branch,
      lastBackup: backup.timestamp,
      files: plan.nextBaseline,
      pendingOperation: null,
    });

    // package 已在写入后完成安装；此处只提交同步状态。
    if (packageResult.installed.length > 0) {
      lines.push(`Packages installed: ${packageResult.installed.join(", ")}`);
    }

    return { ok: true, code: "ok", message: lines.join("\n"), reload: true };
  }

  private normalizeRepoChangedFiles(
    changedFiles: string[],
    config: PiSyncConfig,
  ): string[] {
    const prefix = `${config.root.replace(/\\/g, "/")}/`;
    return changedFiles
      .map((file) => file.replace(/\\/g, "/"))
      .map((file) => file.startsWith(prefix) ? file.slice(prefix.length) : file)
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
    return sha256(JSON.stringify({
      head: status.commit,
      changedFiles: status.changedFiles,
      diff,
      files,
    }));
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
    } catch { /* best-effort: staged diff scan is non-critical */ }

    // 扫描变更的完整文件
    try {
      const safeRoot = await resolveRepoSyncRoot(rp, config.root, "read");
      const syncRoot = safeRoot.path;
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
          if (entry.isSymbolicLink()) throw new Error(`Refusing to scan symbolic link: ${fullPath}`);
          if (entry.isDirectory()) { await walk(fullPath); continue; }
          if (!entry.isFile()) continue;

          const allowed = isPathAllowed(relPath, config.include, config.exclude);
          if (!allowed.allowed) continue;

          try {
            const content = await readFile(fullPath, "utf-8");
            findings.push(...scanSecrets(content, relPath));
          } catch { /* best-effort: individual file scan failure doesn't block */ }
        }
      }

      await walk(syncRoot);
    } catch { /* best-effort: full file scan is non-critical */ }

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
      try { entries = await rd(dir, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        const fullPath = join(dir, entry.name);
        const relPath = fullPath.replace(syncRoot + "/", "").replace(syncRoot, "");
        if (entry.name.startsWith(".")) continue;
        if (entry.isSymbolicLink()) throw new Error(`Refusing to enumerate symbolic link: ${fullPath}`);
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
  const probe = await gitProbe(repoPath, ["rev-list", "--count", "HEAD"]);
  hasCommits = probe.ok && parseInt(probe.stdout.trim(), 10) > 0;

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

/**
 * 清空仓库工作目录中的所有文件（保留 .git 目录）
 */
async function clearRepoContents(repoPath: string): Promise<void> {
  const { readdir: rd, rm } = await import("node:fs/promises");

  async function walk(dir: string): Promise<void> {
    if (!existsSync(dir)) return;
    let entries;
    try {
      entries = await rd(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === ".git") continue;
      const fullPath = join(dir, entry.name);
      try {
        await rm(fullPath, { recursive: true, force: true });
      } catch {
        // 忽略删除失败
      }
    }
  }

  await walk(repoPath);
}
