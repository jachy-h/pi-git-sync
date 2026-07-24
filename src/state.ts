/**
 * 同步状态文件管理
 *
 * 状态文件：~/.pi/agent/.pi-sync/state.json
 * 属于本机状态，不提交到配置仓库
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";

export interface SyncState {
  schemaVersion: number;
  /** 配置仓库的本地路径 */
  repoPath: string;
  /** 上次成功应用的 commit */
  lastAppliedCommit: string | null;
  /** 上次应用时间 */
  lastAppliedAt: string | null;
  /** 上次 push 时间 */
  lastPushAt: string | null;
  /** 上次备份目录名 */
  lastBackup: string | null;
  /** 被管理的 settings 字段名列表 */
  managedSettings: string[];
}

const DEFAULT_STATE: SyncState = {
  schemaVersion: 1,
  repoPath: "",
  lastAppliedCommit: null,
  lastAppliedAt: null,
  lastPushAt: null,
  lastBackup: null,
  managedSettings: [],
};

export function getStatePath(agentDir: string): string {
  return join(agentDir, ".pi-sync", "state.json");
}

/**
 * 读取同步状态
 */
export async function loadState(agentDir: string): Promise<SyncState> {
  const statePath = getStatePath(agentDir);

  if (!existsSync(statePath)) {
    return { ...DEFAULT_STATE };
  }

  try {
    const content = await readFile(statePath, "utf-8");
    const parsed = JSON.parse(content);
    return { ...DEFAULT_STATE, ...parsed };
  } catch {
    return { ...DEFAULT_STATE };
  }
}

/**
 * 保存同步状态
 */
export async function saveState(
  agentDir: string,
  state: SyncState,
): Promise<void> {
  const statePath = getStatePath(agentDir);

  // 确保目录存在
  await mkdir(dirname(statePath), { recursive: true });

  await writeFile(statePath, JSON.stringify(state, null, 2), "utf-8");
}

/**
 * 更新部分状态字段
 */
export async function updateState(
  agentDir: string,
  updates: Partial<SyncState>,
): Promise<SyncState> {
  const current = await loadState(agentDir);
  const updated = { ...current, ...updates };
  await saveState(agentDir, updated);
  return updated;
}
