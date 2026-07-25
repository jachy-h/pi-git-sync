/**
 * Settings 工具函数（保留，供测试使用）
 *
 * v2 中不再使用 managed-key merge 模型。
 * 此文件仅保留 deepMerge / deepEqual 等工具函数供测试参考。
 */
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { existsSync } from "node:fs";

export interface ManagedSettingsResult {
  merged: Record<string, unknown>;
  changed: Record<string, { before: unknown; after: unknown }>;
  preserved: string[];
}

/**
 * 分层合并 settings（v1 遗留，仅供测试）
 */
export async function mergeSettings(
  localSettings: Record<string, unknown>,
  repoPath: string,
  settingsConfig: { source: string; preserve: string[] },
  hostname: string,
): Promise<ManagedSettingsResult> {
  // v2 中不再执行分层合并，直接返回空结果
  return {
    merged: {},
    changed: {},
    preserved: settingsConfig.preserve,
  };
}

export function getPlatform(): string {
  const plat = process.platform;
  if (plat === "darwin") return "macos";
  if (plat === "linux") return "linux";
  return plat;
}

export function deepMerge(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
): Record<string, unknown> {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    const sourceVal = source[key];
    const targetVal = target[key];
    if (isPlainObject(sourceVal) && isPlainObject(targetVal)) {
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
      ) return false;
    }
    return true;
  }
  return false;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
