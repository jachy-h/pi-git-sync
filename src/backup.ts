/**
 * 备份与回滚
 *
 * 备份目录：$PI_CODING_AGENT_DIR/.pi-sync/backups/<timestamp>/
 *
 * 备份记录：
 * - apply 前存在的文件内容和 mode
 * - apply 前不存在但将被创建的路径
 * - 计划删除的文件
 * - repo commit 和操作类型
 */
import { mkdir, writeFile, readFile, rename, readdir, unlink, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { sha256File } from "./inventory.ts";
import type { MaterializePlan } from "./materialize.ts";

// ========== 类型 ==========

export interface Backup {
  timestamp: string;
  commit: string;
  reason: string;
  path: string;
  /** 操作类型 */
  operation: string;
  /** 记录的文件信息 */
  files: Record<string, { action: "backed_up" | "will_create" | "will_delete"; sha256?: string; mode?: number }>;
}

// ========== 创建备份 ==========

/**
 * 创建完整预操作备份
 *
 * @param agentDir Pi agent 目录
 * @param commit 当前 repo commit
 * @param reason 备份原因（如 "apply", "pull", "pre-rollback"）
 * @param plan 即将执行的 materialize 计划（用于标记 will_create/will_delete）
 */
export async function createBackup(
  agentDir: string,
  commit: string,
  reason: string,
  plan?: MaterializePlan,
): Promise<Backup> {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupRoot = join(agentDir, ".pi-sync", "backups", timestamp);
  const dataDir = join(backupRoot, "data");

  await mkdir(dataDir, { recursive: true });

  const fileRecords: Backup["files"] = {};

  // 如果提供了计划，备份将被覆盖的文件
  if (plan) {
    for (const item of plan.toWrite) {
      const agentPath = join(agentDir, item.relativePath);
      if (existsSync(agentPath)) {
        try {
          const content = await readFile(agentPath);
          const fileStat = await stat(agentPath);
          const backupPath = join(dataDir, item.relativePath);
          await mkdir(dirname(backupPath), { recursive: true });
          await writeFile(backupPath, content);
          fileRecords[item.relativePath] = {
            action: "backed_up",
            sha256: await sha256File(agentPath),
            mode: fileStat.mode & 0o777,
          };
        } catch {
          // 备份失败不阻止操作
        }
      } else {
        fileRecords[item.relativePath] = { action: "will_create" };
      }
    }

    for (const relPath of plan.toDelete) {
      const agentPath = join(agentDir, relPath);
      if (existsSync(agentPath)) {
        try {
          const content = await readFile(agentPath);
          const fileStat = await stat(agentPath);
          const backupPath = join(dataDir, relPath);
          await mkdir(dirname(backupPath), { recursive: true });
          await writeFile(backupPath, content);
          fileRecords[relPath] = {
            action: "will_delete",
            sha256: await sha256File(agentPath),
            mode: fileStat.mode & 0o777,
          };
        } catch {
          // 备份失败不阻止操作
        }
      } else {
        fileRecords[relPath] = { action: "will_delete" };
      }
    }
  } else {
    // 无计划：备份整个 settings.json 和所有白名单文件（兜底）
    await backupAgentDir(agentDir, dataDir, fileRecords);
  }

  // 写入元信息
  const meta = {
    timestamp,
    commit,
    reason,
    operation: reason,
    files: fileRecords,
  };
  await writeFile(join(backupRoot, "backup.json"), JSON.stringify(meta, null, 2), "utf-8");

  return { ...meta, path: backupRoot };
}

/**
 * 兜底：完整备份 agent 目录中可能在白名单内的文件
 */
async function backupAgentDir(
  agentDir: string,
  dataDir: string,
  records: Backup["files"],
): Promise<void> {
  const settingsPath = join(agentDir, "settings.json");
  if (existsSync(settingsPath)) {
    const content = await readFile(settingsPath);
    await mkdir(dirname(join(dataDir, "settings.json")), { recursive: true });
    await writeFile(join(dataDir, "settings.json"), content);
    records["settings.json"] = {
      action: "backed_up",
      sha256: await sha256File(settingsPath),
      mode: (await stat(settingsPath)).mode & 0o777,
    };
  }

  // 递归备份 agent 目录（排除 .pi-sync/, npm/, git/, node_modules/）
  await recursiveBackup(agentDir, agentDir, dataDir, records);
}

async function recursiveBackup(
  baseDir: string,
  currentDir: string,
  dataDir: string,
  records: Backup["files"],
): Promise<void> {
  const { readdir: rd } = await import("node:fs/promises");
  const { relative } = await import("node:path");

  let entries;
  try {
    entries = await rd(currentDir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const fullPath = join(currentDir, entry.name);
    const relPath = relative(baseDir, fullPath).replace(/\\/g, "/");

    // 跳过隐藏文件和不应备份的目录
    if (entry.name.startsWith(".") && entry.name !== ".gitignore") continue;
    if (entry.name === "npm" || entry.name === "git" || entry.name === "node_modules") continue;

    if (entry.isDirectory()) {
      await recursiveBackup(baseDir, fullPath, dataDir, records);
    } else if (entry.isFile()) {
      try {
        const content = await readFile(fullPath);
        const backupPath = join(dataDir, relPath);
        await mkdir(dirname(backupPath), { recursive: true });
        await writeFile(backupPath, content);
        records[relPath] = {
          action: "backed_up",
          sha256: await sha256File(fullPath),
          mode: (await stat(fullPath)).mode & 0o777,
        };
      } catch {
        // skip
      }
    }
  }
}

// ========== 恢复备份 ==========

export async function restoreBackup(
  agentDir: string,
  backup: Backup,
): Promise<void> {
  const dataDir = join(backup.path, "data");

  if (!existsSync(dataDir)) {
    throw new Error(`Backup data directory not found: ${dataDir}`);
  }

  // 恢复所有备份的文件
  for (const [relPath, record] of Object.entries(backup.files)) {
    const backupFilePath = join(dataDir, relPath);
    const targetPath = join(agentDir, relPath);

    if (record.action === "backed_up" || record.action === "will_delete") {
      // 文件需要恢复
      if (existsSync(backupFilePath)) {
        const content = await readFile(backupFilePath);
        await mkdir(dirname(targetPath), { recursive: true });
        await atomicOverwrite(targetPath, content);
        if (record.mode) {
          try { await import("node:fs/promises").then((m) => m.chmod(targetPath, record.mode!)); } catch { /* */ }
        }
      }
    } else if (record.action === "will_create") {
      // 文件在备份时还不存在，恢复时应删除
      if (existsSync(targetPath)) {
        await unlink(targetPath);
      }
    }
  }
}

async function atomicOverwrite(targetPath: string, content: Buffer): Promise<void> {
  const tmpPath = `${targetPath}.restore-${Date.now()}.tmp`;
  await writeFile(tmpPath, content);
  await rename(tmpPath, targetPath);
}

// ========== 列出备份 ==========

export async function listBackups(agentDir: string): Promise<Backup[]> {
  const backupsDir = join(agentDir, ".pi-sync", "backups");

  if (!existsSync(backupsDir)) return [];

  const entries = await readdir(backupsDir, { withFileTypes: true });
  const backups: Backup[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const metaPath = join(backupsDir, entry.name, "backup.json");
    if (!existsSync(metaPath)) continue;

    try {
      const content = await readFile(metaPath, "utf-8");
      const meta = JSON.parse(content);
      backups.push({ ...meta, path: join(backupsDir, entry.name) });
    } catch {
      // 跳过损坏的备份
    }
  }

  backups.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  return backups;
}

export async function getLatestBackup(agentDir: string): Promise<Backup | undefined> {
  const backups = await listBackups(agentDir);
  return backups[0];
}

export async function cleanupOldBackups(
  agentDir: string,
  maxBackups: number,
): Promise<number> {
  const backups = await listBackups(agentDir);
  if (backups.length <= maxBackups) return 0;

  const toRemove = backups.slice(maxBackups);
  for (const backup of toRemove) {
    try {
      const { rm } = await import("node:fs/promises");
      await rm(backup.path, { recursive: true, force: true });
    } catch {
      // continue
    }
  }
  return toRemove.length;
}
