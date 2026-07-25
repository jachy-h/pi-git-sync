/**
 * Package reconciliation
 *
 * 比较共享 settings.json 与本地 settings.json 中的 packages 声明。
 * 只同步 package 来源声明，不复制 npm/、git/、node_modules/。
 *
 * 注意：不会自动卸载本地独有的 package（避免移除 pi-git-sync 自身）。
 */
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import type { PiSyncConfig } from "./config.ts";

const execFileAsync = promisify(execFileCb);

// ========== 类型 ==========

export interface PackageDiff {
  added: string[];
  removed: string[];
  changed: string[];
  unchanged: string[];
}

export interface ReconcileResult {
  installed: string[];
  errors: string[];
}

// ========== 差异计算 ==========

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
 * 获取 repo sync/settings.json 与本地 settings.json 之间的 package 差异
 */
export async function getPackageDiff(
  repoPath: string,
  agentDir: string,
  config: PiSyncConfig,
): Promise<PackageDiff> {
  // 读取 repo sync/settings.json
  const repoSettingsPath = join(repoPath, config.root, "settings.json");
  const repoSettings: Record<string, unknown> = existsSync(repoSettingsPath)
    ? JSON.parse(await readFile(repoSettingsPath, "utf-8"))
    : {};

  // 读取本地 settings.json
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

// ========== 执行 reconciliation ==========

/**
 * 安装缺失的 packages，更新已声明的 packages。
 * 不自动卸载本地 package。
 */
export async function reconcilePackages(
  repoPath: string,
  agentDir: string,
  config: PiSyncConfig,
): Promise<ReconcileResult> {
  const diff = await getPackageDiff(repoPath, agentDir, config);
  const result: ReconcileResult = { installed: [], errors: [] };

  // 检查 pi CLI 是否可用
  const piAvailable = await isPiCliAvailable();
  if (!piAvailable) {
    if (diff.added.length > 0) {
      result.errors.push(
        `pi CLI not available. Run manually: pi install ${diff.added.join(" ")}`,
      );
    }
    return result;
  }

  // 安装新增的 packages（使用 argv 数组，防止 shell 注入）
  for (const pkg of diff.added) {
    try {
      await execFileAsync("pi", ["install", pkg], {
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

  // 重新安装变更的 packages
  for (const pkg of diff.changed) {
    try {
      const pkgName = normalizePackageName(pkg);
      await execFileAsync("pi", ["remove", pkgName], {
        env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
        timeout: 60000,
      }).catch(() => {});
      await execFileAsync("pi", ["install", pkg], {
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

// ========== 辅助 ==========

async function isPiCliAvailable(): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync("pi", ["--version"], {
      timeout: 10000,
    });
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

function normalizePackageName(pkg: string): string {
  const npmMatch = pkg.match(/^npm:(.+?)(?:@[\d.].*)?$/);
  if (npmMatch) return npmMatch[1]!;

  const gitMatch = pkg.match(/^(?:git:)?(.+?)(?:@.+)?$/);
  if (gitMatch) {
    let name = gitMatch[1]!;
    name = name.replace(/^https?:\/\//, "");
    name = name.replace(/^ssh:\/\//, "");
    return name;
  }

  return pkg;
}
