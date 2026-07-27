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
import { readFile, stat, lstat, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { gitProbe } from "./git.ts";
import type { PiSyncConfig } from "./config.ts";
import { resolveRepoSyncRoot } from "./path-safety.ts";

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
  checks.push(await checkConfiguredBranch(repoPath, config));
  checks.push(await checkSettingsPortability(repoPath, config));
  checks.push(await checkPiGitSyncInPackages(repoPath, config));
  checks.push(await checkFilePermissions(repoPath));
  checks.push(await checkSymlinks(repoPath, agentDir, config));
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
  const result = await gitProbe(process.cwd(), ["--version"]);
  if (result.ok && result.stdout.includes("git version")) {
    return { name: "Git", status: "ok", message: result.stdout.trim() };
  }
  return { name: "Git", status: "error", message: "Git command not available in PATH" };
}

async function checkSshAvailable(repoPath: string): Promise<DoctorCheck> {
  const urlProbe = await gitProbe(repoPath, ["remote", "get-url", "origin"]);
  const url = urlProbe.stdout.trim();
  if (!url) {
    return { name: "SSH", status: "warning", message: "No 'origin' remote configured" };
  }
  if (!/^git@|^ssh:\/\//.test(url)) {
    return { name: "SSH", status: "ok", message: "HTTPS remote (SSH check skipped)" };
  }

  const probe = await gitProbe(repoPath, ["ls-remote", "origin"], { timeout: 20000 });
  const hostMatch = url.match(/(?:git@|ssh:\/\/git@)([^:/]+)/);
  const host = hostMatch?.[1] ?? "remote";

  if (!probe.ok || /fatal:|error:|Permission denied|Could not read from remote|Host key verification failed/i.test(`${probe.stderr}\n${probe.stdout}`)) {
    return {
      name: "SSH",
      status: "error",
      message: `Cannot reach ${host} via SSH: ${probe.stderr.trim() || probe.stdout.trim()}. ` +
        "Tip: run `ssh -T git@github.com` in a terminal to confirm access.",
    };
  }
  return { name: "SSH", status: "ok", message: `Authenticated to ${host} (${url})` };
}

async function checkRepoExists(repoPath: string): Promise<DoctorCheck> {
  const gitDir = join(repoPath, ".git");
  if (existsSync(gitDir)) {
    return { name: "Repository", status: "ok", message: `Found at ${repoPath}` };
  }
  return { name: "Repository", status: "error", message: `Not a git repository: ${repoPath}` };
}

async function checkRemoteOrigin(repoPath: string): Promise<DoctorCheck> {
  const probe = await gitProbe(repoPath, ["remote", "get-url", "origin"]);
  if (probe.ok && probe.stdout.trim()) {
    return { name: "Remote", status: "ok", message: `Origin: ${probe.stdout.trim()}` };
  }
  return { name: "Remote", status: "warning", message: "No 'origin' remote configured" };
}

function checkConfigFormat(config: PiSyncConfig): DoctorCheck {
  return {
    name: "pi-sync.json",
    status: "ok",
    message: `Schema v${config.schemaVersion}, root="${config.root}", ${config.include.length} include patterns`,
  };
}

async function checkConfiguredBranch(
  repoPath: string,
  config: PiSyncConfig,
): Promise<DoctorCheck> {
  const formatProbe = await gitProbe(repoPath, ["check-ref-format", "--branch", config.branch]);
  if (!formatProbe.ok) {
    return {
      name: "Configured Branch",
      status: "error",
      message: `Invalid configured branch: ${config.branch}`,
    };
  }

  const currentProbe = await gitProbe(repoPath, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (!currentProbe.ok) {
    return {
      name: "Configured Branch",
      status: "error",
      message: `Cannot determine current branch; expected ${config.branch}`,
    };
  }

  const current = currentProbe.stdout.trim();
  if (current !== config.branch) {
    return {
      name: "Configured Branch",
      status: "error",
      message: `Repository is on ${current}, but pi-sync.json targets ${config.branch}`,
    };
  }

  const remoteProbe = await gitProbe(repoPath, ["ls-remote", "--heads", "origin", config.branch]);
  if (!remoteProbe.ok) {
    return {
      name: "Configured Branch",
      status: "warning",
      message: `Could not verify origin/${config.branch}: ${remoteProbe.stderr.trim() || "remote unavailable"}`,
    };
  }
  if (!remoteProbe.stdout.trim()) {
    return {
      name: "Configured Branch",
      status: "warning",
      message: `origin/${config.branch} does not exist yet; first push will create it`,
    };
  }
  return {
    name: "Configured Branch",
    status: "ok",
    message: `Current and remote branch: ${config.branch}`,
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

async function checkSymlinks(
  repoPath: string,
  agentDir: string,
  config: PiSyncConfig,
): Promise<DoctorCheck> {
  const findings: string[] = [];

  const inspect = async (root: string): Promise<void> => {
    if (!existsSync(root)) return;
    const info = await lstat(root);
    if (info.isSymbolicLink()) {
      findings.push(`${root} is a symlink`);
      return;
    }
    if (!info.isDirectory()) return;
    for (const entry of await readdir(root, { withFileTypes: true })) {
      const fullPath = join(root, entry.name);
      if (entry.isSymbolicLink()) {
        findings.push(`${fullPath} is a symlink`);
      } else if (entry.isDirectory()) {
        await inspect(fullPath);
      }
    }
  };

  try {
    await inspect(repoPath);
    await inspect(agentDir);
    await resolveRepoSyncRoot(repoPath, config.root, "read");
  } catch (error) {
    findings.push(error instanceof Error ? error.message : "Unable to inspect symlink safety");
  }

  if (findings.length > 0) {
    return { name: "Symlinks", status: "error", message: findings.join("; ") };
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
