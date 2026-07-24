/**
 * 本地配置导入仓库（capture）
 *
 * 用于首次迁移，把本机允许同步的内容导入仓库。
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, basename, dirname } from "node:path";
import { isDenied } from "./security.ts";
import type { PiSyncConfig } from "./config.ts";

export interface CaptureResult {
  /** 已导入的文件 */
  captured: string[];
  /** 被 denylist 阻止的文件 */
  denied: string[];
  /** 跳过的文件（目标已存在） */
  skipped: string[];
  /** 失败的文件 */
  failed: Array<{ file: string; reason: string }>;
}

/**
 * 将本地文件导入仓库对应位置
 */
export async function captureFiles(
  agentDir: string,
  repoPath: string,
  config: PiSyncConfig,
  files: Array<{ source: string; target: string }>,
): Promise<CaptureResult> {
  const result: CaptureResult = {
    captured: [],
    denied: [],
    skipped: [],
    failed: [],
  };

  for (const mapping of files) {
    const localPath = join(agentDir, mapping.target);
    const repoPathFull = join(repoPath, mapping.source);

    try {
      // denylist 检查
      if (isDenied(mapping.target, config.security.deny)) {
        result.denied.push(mapping.target);
        continue;
      }

      // 本地文件是否存在
      if (!existsSync(localPath)) {
        result.skipped.push(mapping.target);
        continue;
      }

      // 检查仓库中是否已有该文件
      if (existsSync(repoPathFull)) {
        result.skipped.push(mapping.target);
        continue;
      }

      // 复制文件到仓库
      const content = await readFile(localPath);
      await mkdir(dirname(repoPathFull), { recursive: true });
      await writeFile(repoPathFull, content);
      result.captured.push(mapping.target);
    } catch (err) {
      result.failed.push({
        file: mapping.target,
        reason: err instanceof Error ? err.message : "Unknown error",
      });
    }
  }

  return result;
}

/**
 * 从本地 settings.json 中提取 managed keys
 */
export function extractManagedSettings(
  localSettings: Record<string, unknown>,
  managedKeys: string[],
): Record<string, unknown> {
  const extracted: Record<string, unknown> = {};

  for (const key of managedKeys) {
    if (key in localSettings) {
      extracted[key] = localSettings[key];
    }
  }

  return extracted;
}
