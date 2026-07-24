/**
 * 第三方 Package reconciliation
 *
 * 比较仓库 settings.shared.json 中声明的 packages 和本地 settings.json，
 * 提供 diff 和安装能力。
 *
 * 注意：不保存实际的 npm/、git/ 或 node_modules/ 内容。
 * 只同步 packages 声明。
 */
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { exec as execCb } from "node:child_process";
import { promisify } from "node:util";
import type { PiSyncConfig } from "./config.ts";

const execAsync = promisify(execCb);

export interface PackageDiff {
  /** 仓库中有但本地没有的 packages */
  added: string[];
  /** 本地有但仓库中没有的 packages */
  removed: string[];
  /** 两个地方都有但声明不同的 packages */
  changed: string[];
  /** 未变化的 packages */
  unchanged: string[];
}

export interface ReconcileResult {
  /** 成功安装的 packages */
  installed: string[];
  /** 成功移除的 packages */
  removed: string[];
  /** 安装或移除时的错误 */
  errors: string[];
}

/**
 * 从 settings JSON 中提取 packages 列表
 */
function extractPackages(settings: Record<string, unknown>): string[] {
  const raw = settings["packages"];
  if (!Array.isArray(raw)) return [];

  return raw
    .map((pkg) => {
      if (typeof pkg === "string") return pkg;
      if (typeof pkg === "object" && pkg !== null && "source" in pkg) {
        return (pkg as { source: string }).source;
      }
      return null;
    })
    .filter((p): p is string => p !== null);
}

/**
 * 获取 repo 和本地 packages 之间的差异
 */
export async function getPackageDiff(
  repoPath: string,
  agentDir: string,
  config: PiSyncConfig,
): Promise<PackageDiff> {
  // 读取仓库中的 shared settings
  const sharedSettingsPath = join(repoPath, config.settings.source);
  const repoSettings: Record<string, unknown> = existsSync(sharedSettingsPath)
    ? JSON.parse(await readFile(sharedSettingsPath, "utf-8"))
    : {};

  // 读取本地 settings
  const localSettingsPath = join(agentDir, "settings.json");
  const localSettings: Record<string, unknown> = existsSync(localSettingsPath)
    ? JSON.parse(await readFile(localSettingsPath, "utf-8"))
    : {};

  const repoPackages = extractPackages(repoSettings);
  const localPackages = extractPackages(localSettings);

  const repoSet = new Set(repoPackages.map(normalizePackageName));
  const localSet = new Set(localPackages.map(normalizePackageName));

  const added = repoPackages.filter((p) => !localSet.has(normalizePackageName(p)));
  const removed = localPackages.filter((p) => !repoSet.has(normalizePackageName(p)));
  const unchanged = repoPackages.filter((p) => localSet.has(normalizePackageName(p)));

  // 检查 changed（name 相同但 source 不同）
  const changed: string[] = [];
  const repoMap = new Map(repoPackages.map((p) => [normalizePackageName(p), p]));
  const localMap = new Map(localPackages.map((p) => [normalizePackageName(p), p]));

  for (const [name, repoSource] of repoMap) {
    const localSource = localMap.get(name);
    if (localSource && repoSource !== localSource) {
      changed.push(repoSource);
    }
  }

  return { added, removed, changed, unchanged };
}

/**
 * 执行 package reconciliation（安装缺失的、移除多余的）
 *
 * 这个操作依赖 pi CLI，所以在运行时会尝试调用 `pi install` 和 `pi remove`。
 * 如果 pi CLI 不可用，则跳过。
 */
export async function reconcilePackages(
  repoPath: string,
  agentDir: string,
  config: PiSyncConfig,
): Promise<ReconcileResult> {
  const diff = await getPackageDiff(repoPath, agentDir, config);
  const result: ReconcileResult = { installed: [], removed: [], errors: [] };

  // 检查 pi CLI 是否可用
  const piAvailable = await isPiCliAvailable();
  if (!piAvailable) {
    // pi CLI not available — just report what would change
    if (diff.added.length > 0) {
      result.errors.push(
        `pi CLI not available. Run manually: pi install ${diff.added.join(" ")}`,
      );
    }
    return result;
  }

  // 安装新增的 packages
  for (const pkg of diff.added) {
    try {
      await execAsync(`pi install ${pkg}`, {
        env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
        timeout: 120000,
      });
      result.installed.push(pkg);
    } catch (err) {
      result.errors.push(
        `Failed to install ${pkg}: ${err instanceof Error ? err.message : "Unknown"}`,
      );
    }
  }

  // 移除多余的 packages
  for (const pkg of diff.removed) {
    try {
      await execAsync(`pi remove ${pkg}`, {
        env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
        timeout: 60000,
      });
      result.removed.push(pkg);
    } catch (err) {
      result.errors.push(
        `Failed to remove ${pkg}: ${err instanceof Error ? err.message : "Unknown"}`,
      );
    }
  }

  // 重新安装变更的 packages
  for (const pkg of diff.changed) {
    try {
      // Remove old version by removing the package name, then install new
      const pkgName = normalizePackageName(pkg);
      await execAsync(`pi remove ${pkgName}`, {
        env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
        timeout: 60000,
      }).catch(() => {}); // 忽略 remove 失败（可能还没安装）
      await execAsync(`pi install ${pkg}`, {
        env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
        timeout: 120000,
      });
      result.installed.push(pkg);
    } catch (err) {
      result.errors.push(
        `Failed to update ${pkg}: ${err instanceof Error ? err.message : "Unknown"}`,
      );
    }
  }

  return result;
}

/**
 * 检查 pi CLI 是否可用
 */
async function isPiCliAvailable(): Promise<boolean> {
  try {
    const result = await execAsync("pi --version", { timeout: 10000 });
    return result.stdout.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * 标准化 package 名称用于比较
 * 提取 npm: 或 git: 前缀后的实际名称
 */
function normalizePackageName(pkg: string): string {
  // npm:@scope/name@1.0.0 → @scope/name
  const npmMatch = pkg.match(/^npm:(.+?)(?:@[\d.].*)?$/);
  if (npmMatch) return npmMatch[1]!;

  // git:github.com/user/repo@v1 → github.com/user/repo
  const gitMatch = pkg.match(/^(?:git:)?(.+?)(?:@.+)?$/);
  if (gitMatch) {
    // 去掉 URL scheme
    let name = gitMatch[1]!;
    name = name.replace(/^https?:\/\//, "");
    name = name.replace(/^ssh:\/\//, "");
    return name;
  }

  return pkg;
}
