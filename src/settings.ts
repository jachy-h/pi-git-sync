/**
 * Settings 分层合并和 managed-key merge
 *
 * 合并模型：
 *   settings.shared.json
 *     ↓
 *   settings.<platform>.json
 *     ↓
 *   machines/<hostname>.json
 *     ↓
 *   本机保留字段（不可覆盖）
 */
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { existsSync } from "node:fs";
import type { PiSyncConfig } from "./config.ts";

export interface ManagedSettingsResult {
  /** 合并后的完整 settings */
  merged: Record<string, unknown>;
  /** 哪些字段被修改了（用于 diff 展示） */
  changed: Record<string, { before: unknown; after: unknown }>;
  /** 哪些字段被保护（不可覆盖） */
  preserved: string[];
}

/**
 * 分层合并 settings
 *
 * @param localSettings 当前本地 settings.json
 * @param repoPath 配置仓库路径
 * @param config 同步配置
 * @param hostname 本机 hostname
 */
export async function mergeSettings(
  localSettings: Record<string, unknown>,
  repoPath: string,
  config: PiSyncConfig["settings"],
  hostname: string,
): Promise<ManagedSettingsResult> {
  const platform = getPlatform();
  const layers: Array<Record<string, unknown>> = [];

  // Layer 1: settings.shared.json
  const sharedPath = resolve(repoPath, config.source);
  if (existsSync(sharedPath)) {
    const shared = JSON.parse(await readFile(sharedPath, "utf-8"));
    layers.push(shared);
  }

  // Layer 2: settings.<platform>.json
  const platformPath = join(repoPath, "config", `settings.${platform}.json`);
  if (existsSync(platformPath)) {
    const platformSettings = JSON.parse(await readFile(platformPath, "utf-8"));
    layers.push(platformSettings);
  }

  // Layer 3: machines/<hostname>.json
  const machinePath = join(repoPath, "config", "machines", `${hostname}.json`);
  if (existsSync(machinePath)) {
    const machineSettings = JSON.parse(await readFile(machinePath, "utf-8"));
    layers.push(machineSettings);
  }

  // 合并所有层
  let merged: Record<string, unknown> = {};
  for (const layer of layers) {
    merged = deepMerge(merged, layer);
  }

  // 计算变更：哪些字段被修改了
  const changed: Record<string, { before: unknown; after: unknown }> = {};

  // 遍历管理字段，找出差异
  const managedKeys = getManagedKeys(merged);
  for (const key of managedKeys) {
    // 检查本地 settings 中是否存在该字段
    const before = localSettings[key];
    const after = merged[key];

    // 如果 before 不存在而 after 存在，或者值不同
    if (!deepEqual(before, after)) {
      changed[key] = { before, after };
    }
  }

  // 从最终 merged 中移除 preserved 字段
  const finalMerged = { ...merged };
  for (const preserveKey of config.preserve) {
    delete finalMerged[preserveKey];
  }

  return {
    merged: finalMerged,
    changed,
    preserved: config.preserve,
  };
}

/**
 * 获取所有被管理的 key（repo settings 中声明的所有 key）
 */
function getManagedKeys(settings: Record<string, unknown>): string[] {
  return Object.keys(settings);
}

/**
 * 获取平台标识
 */
export function getPlatform(): string {
  const plat = process.platform;
  if (plat === "darwin") return "macos";
  if (plat === "linux") return "linux";
  return plat;
}

/**
 * 深度合并两个对象
 */
export function deepMerge(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
): Record<string, unknown> {
  const result = { ...target };

  for (const key of Object.keys(source)) {
    const sourceVal = source[key];
    const targetVal = target[key];

    if (
      isPlainObject(sourceVal) &&
      isPlainObject(targetVal)
    ) {
      result[key] = deepMerge(
        targetVal as Record<string, unknown>,
        sourceVal as Record<string, unknown>,
      );
    } else {
      result[key] = sourceVal;
    }
  }

  return result;
}

/**
 * 深度比较两个值是否相等
 */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === undefined && b === undefined) return true;

  if (a == null || b == null) return false;
  if (typeof a !== typeof b) return false;

  if (typeof a === "object" && typeof b === "object") {
    const keysA = Object.keys(a as Record<string, unknown>);
    const keysB = Object.keys(b as Record<string, unknown>);
    if (keysA.length !== keysB.length) return false;

    for (const key of keysA) {
      if (
        !deepEqual(
          (a as Record<string, unknown>)[key],
          (b as Record<string, unknown>)[key],
        )
      ) {
        return false;
      }
    }
    return true;
  }

  return false;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
