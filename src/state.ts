/**
 * 同步状态文件管理（schema v2）
 *
 * 状态文件：$PI_CODING_AGENT_DIR/.pi-sync/state.json
 * 保存同步基线，用于三方比较（B = 基线, L = 本地 agent, R = repo）
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";

// ========== 类型定义 ==========

export interface SyncState {
  schemaVersion: number;
  /** 配置仓库的本地绝对路径 */
  repoPath: string;
  /** 同步分支 */
  branch: string;
  /** 上次成功同步的 commit */
  lastSyncedCommit: string | null;
  /** 上次同步时间 */
  lastSyncedAt: string | null;
  /** 同步基线：相对路径 → SHA-256 + mode */
  files: Record<string, { sha256: string; mode: number }>;
  /** 待处理的 Git 操作（如 "push-rebase-conflict"），null 表示无待处理操作 */
  pendingOperation: string | null;
  /** 上次备份时间戳 */
  lastBackup: string | null;
}

const DEFAULT_STATE: SyncState = {
  schemaVersion: 2,
  repoPath: "",
  branch: "main",
  lastSyncedCommit: null,
  lastSyncedAt: null,
  files: {},
  pendingOperation: null,
  lastBackup: null,
};

// ========== 路径 ==========

export function getStatePath(agentDir: string): string {
  return join(agentDir, ".pi-sync", "state.json");
}

// ========== 读取 ==========

export async function loadState(agentDir: string): Promise<SyncState> {
  const statePath = getStatePath(agentDir);

  if (!existsSync(statePath)) {
    return { ...DEFAULT_STATE };
  }

  try {
    const content = await readFile(statePath, "utf-8");
    const parsed = JSON.parse(content);
    // 自动升级 schema v1 → v2
    if (parsed.schemaVersion === 1) {
      return migrateV1ToV2(parsed);
    }
    return { ...DEFAULT_STATE, ...parsed };
  } catch {
    return { ...DEFAULT_STATE };
  }
}

// ========== 保存 ==========

export async function saveState(
  agentDir: string,
  state: SyncState,
): Promise<void> {
  const statePath = getStatePath(agentDir);
  await mkdir(dirname(statePath), { recursive: true });
  await writeFile(statePath, JSON.stringify(state, null, 2), "utf-8");
}

// ========== 更新 ==========

export async function updateState(
  agentDir: string,
  updates: Partial<SyncState>,
): Promise<SyncState> {
  const current = await loadState(agentDir);
  const updated = { ...current, ...updates };
  await saveState(agentDir, updated);
  return updated;
}

// ========== 基线计算 ==========

/**
 * 从文件记录计算基线条目
 */
export function computeBaselineEntry(
  sha256: string,
  mode: number,
): { sha256: string; mode: number } {
  return { sha256, mode };
}

/**
 * 从状态中查找某文件的基线记录
 */
export function getBaselineFile(
  state: SyncState,
  relativePath: string,
): { sha256: string; mode: number } | null {
  return state.files[relativePath] ?? null;
}

// ========== 迁移 ==========

function migrateV1ToV2(v1: Record<string, unknown>): SyncState {
  return {
    schemaVersion: 2,
    repoPath: (v1.repoPath as string) ?? "",
    branch: (v1.branch as string) ?? "main",
    lastSyncedCommit: (v1.lastAppliedCommit as string) ?? null,
    lastSyncedAt: (v1.lastAppliedAt as string) ?? null,
    files: {},
    pendingOperation: null,
    lastBackup: (v1.lastBackup as string) ?? null,
  };
}
