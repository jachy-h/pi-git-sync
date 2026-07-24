/**
 * 备份和回滚
 *
 * 备份目录：~/.pi/agent/.pi-sync/backups/<timestamp>/
 */
import { mkdir, writeFile, readFile, rename, readdir, stat, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, relative } from "node:path";

export interface Backup {
  /** 备份时间戳（目录名） */
  timestamp: string;
  /** 备份时的 commit */
  commit: string;
  /** 备份说明 */
  reason: string;
  /** 备份的绝对路径 */
  path: string;
}

/**
 * 创建完整备份
 * 备份 settings.json 和所有配置文件的当前状态
 */
export async function createBackup(
  agentDir: string,
  commit: string,
  reason: string,
  files: Array<{ source: string; target: string }>,
): Promise<Backup> {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupRoot = join(agentDir, ".pi-sync", "backups", timestamp);
  const dataDir = join(backupRoot, "data");

  await mkdir(dataDir, { recursive: true });

  // 备份 settings.json
  const settingsPath = join(agentDir, "settings.json");
  if (existsSync(settingsPath)) {
    const content = await readFile(settingsPath);
    await writeFile(join(dataDir, "settings.json"), content);
  }

  // 备份所有 mapping 的目标文件
  for (const file of files) {
    const targetPath = join(agentDir, file.target);
    if (existsSync(targetPath)) {
      const content = await readFile(targetPath);
      const backupPath = join(dataDir, file.target);
      const backupDir = join(dataDir, file.target, "..");
      await mkdir(backupDir, { recursive: true });
      await writeFile(backupPath, content);
    }
  }

  // 写入备份元信息
  const meta: Omit<Backup, "path"> = {
    timestamp,
    commit,
    reason,
  };
  await writeFile(
    join(backupRoot, "backup.json"),
    JSON.stringify(meta, null, 2),
    "utf-8",
  );

  return { ...meta, path: backupRoot };
}

/**
 * 从备份恢复
 * 先创建当前状态的新备份，再恢复
 */
export async function restoreBackup(
  agentDir: string,
  backup: Backup,
  files: Array<{ source: string; target: string }>,
): Promise<void> {
  const dataDir = join(backup.path, "data");

  if (!existsSync(dataDir)) {
    throw new Error(`Backup data directory not found: ${dataDir}`);
  }

  // 恢复 settings.json
  const backupSettings = join(dataDir, "settings.json");
  if (existsSync(backupSettings)) {
    const content = await readFile(backupSettings);
    await atomicOverwrite(join(agentDir, "settings.json"), content);
  }

  // 恢复其他文件
  for (const file of files) {
    const backupPath = join(dataDir, file.target);
    if (existsSync(backupPath)) {
      const content = await readFile(backupPath);
      const targetPath = join(agentDir, file.target);
      const targetDir = join(targetPath, "..");
      await mkdir(targetDir, { recursive: true });
      await atomicOverwrite(targetPath, content);
    }
  }
}

/**
 * 原子覆盖文件
 */
async function atomicOverwrite(targetPath: string, content: Buffer | string): Promise<void> {
  const tmpPath = `${targetPath}.restore-${Date.now()}.tmp`;
  await writeFile(tmpPath, content);
  await rename(tmpPath, targetPath);
}

/**
 * 列出所有备份
 */
export async function listBackups(agentDir: string): Promise<Backup[]> {
  const backupsDir = join(agentDir, ".pi-sync", "backups");

  if (!existsSync(backupsDir)) {
    return [];
  }

  const entries = await readdir(backupsDir, { withFileTypes: true });
  const backups: Backup[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const backupJsonPath = join(backupsDir, entry.name, "backup.json");
    if (!existsSync(backupJsonPath)) continue;

    try {
      const content = await readFile(backupJsonPath, "utf-8");
      const meta = JSON.parse(content) as Omit<Backup, "path">;
      backups.push({
        ...meta,
        path: join(backupsDir, entry.name),
      });
    } catch {
      // 跳过损坏的备份
    }
  }

  // 按时间倒序排列
  backups.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  return backups;
}

/**
 * 获取上一次备份
 */
export async function getLatestBackup(agentDir: string): Promise<Backup | undefined> {
  const backups = await listBackups(agentDir);
  return backups[0];
}

/**
 * 清理超过指定数量的旧备份
 */
export async function cleanupOldBackups(
  agentDir: string,
  maxBackups: number,
): Promise<number> {
  const backups = await listBackups(agentDir);
  if (backups.length <= maxBackups) return 0;

  const toRemove = backups.slice(maxBackups);
  for (const backup of toRemove) {
    await rm(backup.path, { recursive: true, force: true });
  }
  return toRemove.length;
}
