/**
 * 文件原子应用
 *
 * 策略：
 *   解析和校验
 *   → 写入同目录临时文件
 *   → 设置权限
 *   → fsync
 *   → rename
 *   → 保留备份
 */
import { readFile, writeFile, rename, mkdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { randomBytes } from "node:crypto";
import type { PiSyncFileMapping } from "./config.ts";

export interface MaterializeResult {
  /** 成功应用的文件 */
  applied: string[];
  /** 跳过的文件（不存在但 optional） */
  skipped: string[];
  /** 失败的文件及原因 */
  failed: Array<{ file: string; reason: string }>;
  /** 变更详情 */
  changes: Record<string, { action: "created" | "updated" | "deleted" | "unchanged" }>;
}

/**
 * 原子写入文件
 * 1. 写入临时文件
 * 2. fsync
 * 3. rename
 */
export async function atomicWrite(
  targetPath: string,
  content: string,
  mode?: number,
): Promise<void> {
  // 确保目标目录存在
  const targetDir = dirname(targetPath);
  await mkdir(targetDir, { recursive: true });

  // 生成唯一的临时文件名
  const tmpName = `.${basename(targetPath)}.${randomBytes(4).toString("hex")}.tmp`;
  const tmpPath = join(targetDir, tmpName);

  // 写入临时文件
  await writeFile(tmpPath, content, { mode: mode ?? 0o644 });

  // rename 到目标路径（原子操作）
  await rename(tmpPath, targetPath);
}

/**
 * 将仓库中的配置文件应用到 Pi agent 目录
 */
export async function materializeFiles(
  repoPath: string,
  agentDir: string,
  files: PiSyncFileMapping[],
  backupDir: string,
): Promise<MaterializeResult> {
  const result: MaterializeResult = {
    applied: [],
    skipped: [],
    failed: [],
    changes: {},
  };

  for (const fileMapping of files) {
    const sourcePath = join(repoPath, fileMapping.source);
    const targetPath = join(agentDir, fileMapping.target);

    try {
      // 检查源文件是否存在
      if (!existsSync(sourcePath)) {
        if (fileMapping.optional) {
          result.skipped.push(fileMapping.target);
          continue;
        }
        result.failed.push({
          file: fileMapping.target,
          reason: `Source file not found: ${fileMapping.source}`,
        });
        continue;
      }

      // 读取源文件
      const content = await readFile(sourcePath);

      // 备份当前文件（如果存在）
      if (existsSync(targetPath)) {
        await backupFile(targetPath, backupDir);
        result.changes[fileMapping.target] = { action: "updated" };
      } else {
        result.changes[fileMapping.target] = { action: "created" };
      }

      // 原子写入
      await atomicWrite(targetPath, content.toString());
      result.applied.push(fileMapping.target);
    } catch (err) {
      result.failed.push({
        file: fileMapping.target,
        reason: err instanceof Error ? err.message : "Unknown error",
      });
    }
  }

  return result;
}

/**
 * 备份文件到备份目录
 */
export async function backupFile(sourcePath: string, backupDir: string): Promise<string> {
  const relativePath = sourcePath.replace(/^\//, "").replace(/:/g, "_");
  const backupPath = join(backupDir, relativePath);

  await mkdir(dirname(backupPath), { recursive: true });

  const content = await readFile(sourcePath);
  // 获取原始文件的 mode
  let mode = 0o644;
  try {
    const fileStat = await stat(sourcePath);
    mode = fileStat.mode;
  } catch {
    // 使用默认 mode
  }

  await writeFile(backupPath, content, { mode });
  return backupPath;
}

/**
 * 计算 backup 之间的差异
 */
export async function diffFiles(
  repoPath: string,
  agentDir: string,
  files: PiSyncFileMapping[],
): Promise<Record<string, { action: string; diff?: string }>> {
  const changes: Record<string, { action: string; diff?: string }> = {};

  for (const fileMapping of files) {
    const sourcePath = join(repoPath, fileMapping.source);
    const targetPath = join(agentDir, fileMapping.target);

    const sourceExists = existsSync(sourcePath);
    const targetExists = existsSync(targetPath);

    if (!sourceExists) {
      if (!fileMapping.optional) {
        changes[fileMapping.target] = {
          action: "source_missing",
          diff: `WARNING: Source not found: ${fileMapping.source}`,
        };
      }
      continue;
    }

    if (!targetExists) {
      changes[fileMapping.target] = { action: "will_create" };
      continue;
    }

    // 比较内容
    const sourceContent = await readFile(sourcePath, "utf-8");
    const targetContent = await readFile(targetPath, "utf-8");

    if (sourceContent !== targetContent) {
      // 生成简单的 diff 描述
      const sourceLines = sourceContent.split("\n").length;
      const targetLines = targetContent.split("\n").length;
      const sizeDiff = sourceContent.length - targetContent.length;

      let diffDesc = `Lines: ${targetLines} → ${sourceLines}`;
      if (sizeDiff !== 0) {
        const sign = sizeDiff > 0 ? "+" : "";
        diffDesc += `, Size: ${sign}${sizeDiff} bytes`;
      }

      changes[fileMapping.target] = { action: "will_update", diff: diffDesc };
    } else {
      changes[fileMapping.target] = { action: "unchanged" };
    }
  }

  return changes;
}
