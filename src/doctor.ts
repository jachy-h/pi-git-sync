/**
 * 环境与配置诊断（/pisync doctor）
 *
 * 检查：
 * - Git 和 SSH 可用性
 * - Origin 是否为预期仓库
 * - JSON 格式
 * - 设置可移植性（绝对路径、package 来源等）
 * - pi-git-sync 是否在 packages 中
 * - 文件权限
 * - 符号链接
 */
import { readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { gitExec } from "./git.ts";
import type { PiSyncConfig } from "./config.ts";

// ========== 类型 ==========

export interface DoctorCheck {
  name: string;
  status: "ok" | "warning" | "error";
  message: string;
}

export interface DoctorResult {
  checks: DoctorCheck[];
  summary: { ok: number; warning: number; error: number };
}

// ========== 运行所有检查 ==========

export async function runDoctorChecks(
  repoPath: string,
  agentDir: string,
  config: PiSyncConfig,
): Promise<DoctorResult> {
  const checks: DoctorCheck[] = [];

  checks.push(await checkGitAvailable());
  checks.push(await checkSshAvailable(repoPath));
  checks.push(await checkRepoExists(repoPath));
  checks.push(await checkRemoteOrigin(repoPath));
  checks.push(checkConfigFormat(config));
  checks.push(await checkSettingsPortability(repoPath, config));
  checks.push(await checkPiGitSyncInPackages(repoPath, config));
  checks.push(await checkFilePermissions(repoPath));
  checks.push(await checkSymlinks(repoPath));
  checks.push(await checkAbsolutePaths(repoPath, config));

  const summary = {
    ok: checks.filter((c) => c.status === "ok").length,
    warning: checks.filter((c) => c.status === "warning").length,
    error: checks.filter((c) => c.status === "error").length,
  };

  return { checks, summary };
}

// ========== 各项检查 ==========

async function checkGitAvailable(): Promise<DoctorCheck> {
  try {
    const result = await gitExec(process.cwd(), ["--version"]);
    if (result.stdout.includes("git version")) {
      return { name: "Git", status: "ok", message: result.stdout.trim() };
    }
    return { name: "Git", status: "error", message: "Git not found" };
  } catch {
    return { name: "Git", status: "error", message: "Git command not available in PATH" };
  }
}

async function checkSshAvailable(repoPath: string): Promise<DoctorCheck> {
  try {
    const result = await gitExec(repoPath, ["remote", "get-url", "origin"]);
    const url = result.stdout.trim();
    if (!url) {
      return { name: "SSH", status: "warning", message: "No 'origin' remote configured" };
    }
    if (!/^git@|^ssh:\/\//.test(url)) {
      return { name: "SSH", status: "ok", message: "HTTPS remote (SSH check skipped)" };
    }

    const probe = await gitExec(repoPath, ["ls-remote", "origin"], { timeout: 20000 });
    const hostMatch = url.match(/(?:git@|ssh:\/\/git@)([^:/]+)/);
    const host = hostMatch?.[1] ?? "remote";

    if (/fatal:|error:|Permission denied|Could not read from remote|Host key verification failed/i.test(`${probe.stderr}\n${probe.stdout}`)) {
      return {
        name: "SSH",
        status: "error",
        message: `Cannot reach ${host} via SSH: ${probe.stderr.trim() || probe.stdout.trim()}. ` +
          "Tip: run `ssh -T git@github.com` in a terminal to confirm access.",
      };
    }
    return { name: "SSH", status: "ok", message: `Authenticated to ${host} (${url})` };
  } catch {
    return { name: "SSH", status: "warning", message: "Could not determine remote URL" };
  }
}

async function checkRepoExists(repoPath: string): Promise<DoctorCheck> {
  const gitDir = join(repoPath, ".git");
  if (existsSync(gitDir)) {
    return { name: "Repository", status: "ok", message: `Found at ${repoPath}` };
  }
  return { name: "Repository", status: "error", message: `Not a git repository: ${repoPath}` };
}

async function checkRemoteOrigin(repoPath: string): Promise<DoctorCheck> {
  try {
    const result = await gitExec(repoPath, ["remote", "get-url", "origin"]);
    const url = result.stdout.trim();
    if (url) {
      return { name: "Remote", status: "ok", message: `Origin: ${url}` };
    }
    return { name: "Remote", status: "warning", message: "No 'origin' remote configured" };
  } catch {
    return { name: "Remote", status: "warning", message: "No 'origin' remote configured" };
  }
}

function checkConfigFormat(config: PiSyncConfig): DoctorCheck {
  return {
    name: "pi-sync.json",
    status: "ok",
    message: `Schema v${config.schemaVersion}, root="${config.root}", ${config.include.length} include patterns`,
  };
}

async function checkSettingsPortability(
  repoPath: string,
  config: PiSyncConfig,
): Promise<DoctorCheck> {
  const settingsPath = join(repoPath, config.root, "settings.json");
  if (!existsSync(settingsPath)) {
    return {
      name: "Settings Portability",
      status: "ok",
      message: "No settings.json in sync root (nothing to check)",
    };
  }

  const warnings: string[] = [];

  try {
    const content = await readFile(settingsPath, "utf-8");
    const settings = JSON.parse(content);

    // 检查 packages
    const packages = settings.packages;
    if (Array.isArray(packages)) {
      for (const pkg of packages) {
        if (typeof pkg === "string" && (pkg.startsWith("/") || pkg.startsWith("~/"))) {
          warnings.push(`Absolute package path: ${pkg}`);
        }
      }
    }

    // 检查可疑的绝对路径
    const contentStr = JSON.stringify(settings);
    if (/\/home\/|\/Users\//.test(contentStr)) {
      warnings.push("Contains paths that look machine-specific (/home/ or /Users/)");
    }

    // 检查 externalEditor
    if (typeof settings.externalEditor === "string" && settings.externalEditor.startsWith("/")) {
      warnings.push("externalEditor is an absolute path");
    }
  } catch (err) {
    return {
      name: "Settings Portability",
      status: "error",
      message: `Cannot parse settings.json: ${err instanceof Error ? err.message : "Unknown"}`,
    };
  }

  if (warnings.length > 0) {
    return {
      name: "Settings Portability",
      status: "warning",
      message: warnings.join("; "),
    };
  }

  return { name: "Settings Portability", status: "ok", message: "No portability issues detected" };
}

async function checkPiGitSyncInPackages(
  repoPath: string,
  config: PiSyncConfig,
): Promise<DoctorCheck> {
  const settingsPath = join(repoPath, config.root, "settings.json");
  if (!existsSync(settingsPath)) {
    return {
      name: "pi-git-sync in Packages",
      status: "warning",
      message: "settings.json not found — cannot verify pi-git-sync is declared",
    };
  }

  try {
    const content = await readFile(settingsPath, "utf-8");
    const settings = JSON.parse(content);
    const packages: unknown[] = settings.packages ?? [];

    const hasPiGitSync = packages.some(
      (p: unknown) => typeof p === "string" && (
        p.includes("pi-git-sync") || p.includes("jachy/pi-git-sync")
      ),
    );

    if (hasPiGitSync) {
      return { name: "pi-git-sync in Packages", status: "ok", message: "pi-git-sync is declared" };
    }
    return {
      name: "pi-git-sync in Packages",
      status: "error",
      message: 'packages should include "npm:@jachy/pi-git-sync" to ensure it loads after sync',
    };
  } catch {
    return {
      name: "pi-git-sync in Packages",
      status: "warning",
      message: "Could not parse settings.json",
    };
  }
}

async function checkFilePermissions(repoPath: string): Promise<DoctorCheck> {
  const sensitivePatterns = [
    join(repoPath, ".git", "config"),
    join(repoPath, "pi-sync.json"),
  ];

  const warnings: string[] = [];
  for (const path of sensitivePatterns) {
    if (!existsSync(path)) continue;
    try {
      const fileStat = await stat(path);
      const mode = fileStat.mode & 0o777;
      if (mode & 0o022) {
        warnings.push(`${path} is group/other writable (mode ${mode.toString(8)})`);
      }
    } catch {
      // skip
    }
  }

  if (warnings.length > 0) {
    return { name: "Permissions", status: "warning", message: warnings.join("; ") };
  }
  return { name: "Permissions", status: "ok", message: "No permission issues" };
}

async function checkSymlinks(repoPath: string): Promise<DoctorCheck> {
  const checkDirs = ["sync", "skills", "extensions", "prompts", "themes"];
  const warnings: string[] = [];

  for (const dir of checkDirs) {
    const dirPath = join(repoPath, dir);
    if (!existsSync(dirPath)) continue;
    try {
      const fileStat = await stat(dirPath);
      if (fileStat.isSymbolicLink()) {
        warnings.push(`${dir}/ is a symlink`);
      }
    } catch {
      // skip
    }
  }

  if (warnings.length > 0) {
    return { name: "Symlinks", status: "warning", message: warnings.join("; ") };
  }
  return { name: "Symlinks", status: "ok", message: "No problematic symlinks" };
}

async function checkAbsolutePaths(
  repoPath: string,
  config: PiSyncConfig,
): Promise<DoctorCheck> {
  const checkFiles = [join(repoPath, config.root, "settings.json")];
  const warnings: string[] = [];

  for (const file of checkFiles) {
    if (!existsSync(file)) continue;
    try {
      const content = await readFile(file, "utf-8");
      if (/\/home\/|\/Users\//.test(content)) {
        warnings.push(`${file} may contain absolute paths`);
      }
    } catch {
      // skip
    }
  }

  if (warnings.length > 0) {
    return { name: "Absolute Paths", status: "warning", message: warnings.join("; ") };
  }
  return { name: "Absolute Paths", status: "ok", message: "No absolute paths found" };
}
