/**
 * Materialize: repo → agent
 *
 * 将仓库 sync/ 目录中的文件应用到 Pi agent 目录。
 *
 * 功能：
 * - 原子单文件写入（临时文件 → fsync → rename）
 * - 支持创建、更新和删除（仅 tracked 文件）
 * - 完整备份与失败回滚
 * - 全部预校验后再执行
 */
import { readFile, writeFile, rename, mkdir, unlink, stat as fsStat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { randomBytes } from "node:crypto";
import { normalizePath, isPathAllowed } from "./glob.ts";
import { isDenied } from "./security.ts";
import { hasConflictMarkers, validateJson, validateSettingsPortability } from "./validate.ts";
import type { PiSyncConfig } from "./config.ts";
import type { SyncState } from "./state.ts";
import {
  compareFiles,
  getApplicableFiles,
  hasBilateralConflicts,
  sha256File,
  type FileComparison,
} from "./inventory.ts";

// ========== 类型定义 ==========

export interface MaterializePlan {
  /** 要创建/更新的文件 */
  toWrite: Array<{ relativePath: string; content: Buffer; mode: number }>;
  /** 要删除的文件 */
  toDelete: string[];
  /** 冲突文件 */
  conflicts: FileComparison[];
  /** 预校验错误 */
  validationErrors: Array<{ file: string; message: string; severity: "error" | "warning" }>;
  /** 是否有阻断性错误 */
  blocked: boolean;
}

export interface MaterializeResult {
  /** 成功写入的文件 */
  written: string[];
  /** 成功删除的文件 */
  deleted: string[];
  /** 跳过的文件 */
  skipped: string[];
  /** 失败的文件 */
  failed: Array<{ file: string; reason: string }>;
}

// ========== 原子写入 ==========

/**
 * 原子写入文件：
 * 1. 写入同目录临时文件
 * 2. 设置 mode
 * 3. rename 到目标路径
 */
export async function atomicWrite(
  targetPath: string,
  content: Buffer | string,
  mode?: number,
): Promise<void> {
  const targetDir = dirname(targetPath);
  await mkdir(targetDir, { recursive: true });

  const tmpName = `.${basename(targetPath)}.${randomBytes(4).toString("hex")}.tmp`;
  const tmpPath = join(targetDir, tmpName);

  const buffer = typeof content === "string" ? Buffer.from(content, "utf-8") : content;
  await writeFile(tmpPath, buffer, { mode: mode ?? 0o644 });

  try {
    await rename(tmpPath, targetPath);
  } catch {
    // rename 失败时清理临时文件
    try { await unlink(tmpPath); } catch { /* ignore */ }
    throw new Error(`Failed to rename ${tmpName} → ${basename(targetPath)}`);
  }
}

// ========== 计划生成 ==========

/**
 * 生成 apply 计划：列出需要创建、更新、删除的文件
 */
export async function planMaterialize(
  agentDir: string,
  repoPath: string,
  config: PiSyncConfig,
  state: SyncState,
): Promise<MaterializePlan> {
  const syncRoot = join(repoPath, config.root);
  const inventory = await compareFiles(agentDir, repoPath, config, state);

  const plan: MaterializePlan = {
    toWrite: [],
    toDelete: [],
    conflicts: [],
    validationErrors: [],
    blocked: false,
  };

  // 收集冲突
  plan.conflicts = inventory.comparisons.filter(
    (c) =>
      c.changeType === "both_modified" ||
      c.changeType === "local_modified_remote_deleted" ||
      c.changeType === "local_deleted_remote_modified",
  );

  // 获取需要 apply 的变更
  const applicable = getApplicableFiles(inventory.comparisons);

  for (const comp of applicable) {
    const relPath = comp.relativePath;

    // Hard deny 检查 —— 永不 apply
    if (isDenied(relPath)) {
      continue;
    }

    switch (comp.changeType) {
      case "remote_created":
      case "remote_only": {
        // repo 中有新文件或更新的文件 → 写回 agent
        const repoFilePath = join(syncRoot, relPath);
        if (existsSync(repoFilePath)) {
          try {
            const content = await readFile(repoFilePath);
            const fileStat = await fsStat(repoFilePath);

            // 冲突标记检查
            const contentStr = content.toString("utf-8");
            if (hasConflictMarkers(contentStr)) {
              plan.validationErrors.push({
                file: relPath,
                message: "Contains Git conflict markers",
                severity: "error",
              });
            }

            // JSON 校验
            if (relPath.endsWith(".json")) {
              const jsonErrors = validateJson(relPath, contentStr);
              plan.validationErrors.push(...jsonErrors);
            }

            // settings.json 可移植性检查
            if (relPath === "settings.json") {
              plan.validationErrors.push(...validateSettingsPortability(contentStr));
            }

            plan.toWrite.push({
              relativePath: relPath,
              content,
              mode: fileStat.mode & 0o777,
            });
          } catch (err) {
            plan.validationErrors.push({
              file: relPath,
              message: `Cannot read: ${err instanceof Error ? err.message : "Unknown"}`,
              severity: "error",
            });
          }
        }
        break;
      }
      case "remote_deleted": {
        // repo 中删除了已管理的文件 → agent 中也删除
        if (config.delete === "tracked") {
          const baseline = state.files[relPath];
          if (baseline) {
            plan.toDelete.push(relPath);
          }
        }
        break;
      }
      case "converged": {
        // 两边独立修改但结果相同 → 更新基线即可，不实际写入
        break;
      }
    }
  }

  // 判断是否被阻断
  const blockingErrors = plan.validationErrors.filter((e) => e.severity === "error");
  plan.blocked = blockingErrors.length > 0 || plan.conflicts.length > 0;

  return plan;
}

// ========== 执行 ==========

/**
 * 执行 materialize 计划
 *
 * @returns 执行结果
 */
export async function executeMaterialize(
  agentDir: string,
  plan: MaterializePlan,
): Promise<MaterializeResult> {
  const result: MaterializeResult = {
    written: [],
    deleted: [],
    skipped: [],
    failed: [],
  };

  // 1. 写入文件
  for (const item of plan.toWrite) {
    const targetPath = join(agentDir, item.relativePath);
    try {
      await atomicWrite(targetPath, item.content, item.mode);
      result.written.push(item.relativePath);
    } catch (err) {
      result.failed.push({
        file: item.relativePath,
        reason: err instanceof Error ? err.message : "Unknown error",
      });
    }
  }

  // 2. 删除文件
  for (const relPath of plan.toDelete) {
    const targetPath = join(agentDir, relPath);
    try {
      if (existsSync(targetPath)) {
        await unlink(targetPath);
        result.deleted.push(relPath);
      } else {
        result.skipped.push(relPath);
      }
    } catch (err) {
      result.failed.push({
        file: relPath,
        reason: err instanceof Error ? err.message : "Unknown error",
      });
    }
  }

  return result;
}

// ========== 辅助函数 ==========

/**
 * 从 agent 目录读取文件并计算基线 hash
 */
export async function readAgentFile(
  agentDir: string,
  relativePath: string,
): Promise<{ content: Buffer; sha256: string; mode: number } | null> {
  const fullPath = join(agentDir, relativePath);
  if (!existsSync(fullPath)) return null;

  const content = await readFile(fullPath);
  const fileStat = await fsStat(fullPath);

  return {
    content,
    sha256: await sha256File(fullPath),
    mode: fileStat.mode & 0o777,
  };
}
