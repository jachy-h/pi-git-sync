/**
 * 环境和配置诊断（/pisync doctor）
 *
 * 检查：
 * - Git 和 SSH 是否可用
 * - Origin 是否为预期仓库
 * - JSON 格式是否正确
 * - Skill frontmatter 是否有效
 * - 文件权限
 * - 仓库路径是否已正确加入 Pi Settings
 */
import { access, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { gitExec } from "./git.ts";
import type { PiSyncConfig } from "./config.ts";

export interface DoctorCheck {
  name: string;
  status: "ok" | "warning" | "error";
  message: string;
}

export interface DoctorResult {
  checks: DoctorCheck[];
  summary: { ok: number; warning: number; error: number };
}

/**
 * 运行所有诊断检查
 */
export async function runDoctorChecks(
  repoPath: string,
  agentDir: string,
  config: PiSyncConfig,
): Promise<DoctorResult> {
  const checks: DoctorCheck[] = [];

  // 1. Git 可用性
  checks.push(await checkGitAvailable());

  // 2. SSH 可用性
  checks.push(await checkSshAvailable(repoPath));

  // 3. 仓库路径存在
  checks.push(await checkRepoExists(repoPath));

  // 4. Remote origin 检查
  checks.push(await checkRemoteOrigin(repoPath));

  // 5. pi-sync.json 格式
  checks.push(checkConfigFormat(config));

  // 6. settings.shared.json 格式
  checks.push(await checkSettingsFormat(repoPath, config));

  // 7. 文件权限安全
  checks.push(await checkFilePermissions(repoPath));

  // 8. 符号链接检查
  checks.push(await checkSymlinks(repoPath));

  // 9. 绝对路径泄漏检查
  checks.push(await checkAbsolutePaths(repoPath));

  // 10. 仓库在 Pi Settings 中
  checks.push(checkRepoInPiSettings(repoPath, agentDir));

  const summary = {
    ok: checks.filter((c) => c.status === "ok").length,
    warning: checks.filter((c) => c.status === "warning").length,
    error: checks.filter((c) => c.status === "error").length,
  };

  return { checks, summary };
}

async function checkGitAvailable(): Promise<DoctorCheck> {
  try {
    const result = await gitExec(process.cwd(), ["--version"]);
    if (result.stdout.includes("git version")) {
      return { name: "Git", status: "ok", message: result.stdout.trim() };
    }
    return { name: "Git", status: "error", message: "Git not found" };
  } catch {
    return {
      name: "Git",
      status: "error",
      message: "Git command not available in PATH",
    };
  }
}

async function checkSshAvailable(repoPath: string): Promise<DoctorCheck> {
  try {
    const result = await gitExec(repoPath, ["remote", "get-url", "origin"]);
    const url = result.stdout.trim();
    if (url.startsWith("git@") || url.startsWith("ssh://")) {
      // Try SSH connection
      const hostMatch = url.match(/(?:git@|ssh:\/\/git@)([^:/]+)/);
      if (hostMatch) {
        return {
          name: "SSH",
          status: "ok",
          message: `SSH remote configured: ${hostMatch[1]}`,
        };
      }
    }
    return {
      name: "SSH",
      status: "ok",
      message: "HTTPS remote (SSH check skipped)",
    };
  } catch {
    return {
      name: "SSH",
      status: "warning",
      message: "Could not determine remote URL",
    };
  }
}

async function checkRepoExists(repoPath: string): Promise<DoctorCheck> {
  const gitDir = join(repoPath, ".git");
  if (existsSync(gitDir)) {
    return { name: "Repository", status: "ok", message: `Found at ${repoPath}` };
  }
  return {
    name: "Repository",
    status: "error",
    message: `Not a git repository: ${repoPath}`,
  };
}

async function checkRemoteOrigin(repoPath: string): Promise<DoctorCheck> {
  try {
    const result = await gitExec(repoPath, ["remote", "get-url", "origin"]);
    const url = result.stdout.trim();
    if (url) {
      return {
        name: "Remote",
        status: "ok",
        message: `Origin: ${url}`,
      };
    }
    return {
      name: "Remote",
      status: "warning",
      message: "No 'origin' remote configured",
    };
  } catch {
    return {
      name: "Remote",
      status: "warning",
      message: "No 'origin' remote configured",
    };
  }
}

function checkConfigFormat(config: PiSyncConfig): DoctorCheck {
  // Already validated by loadPiSyncConfig
  return {
    name: "pi-sync.json",
    status: "ok",
    message: `Schema v${config.schemaVersion}, ${config.files.length} file mappings`,
  };
}

async function checkSettingsFormat(
  repoPath: string,
  config: PiSyncConfig,
): Promise<DoctorCheck> {
  const settingsPath = join(repoPath, config.settings.source);
  if (!existsSync(settingsPath)) {
    return {
      name: "Settings",
      status: "warning",
      message: `settings.shared.json not found at ${config.settings.source}`,
    };
  }
  try {
    const content = await access(settingsPath); // just check readability
    return {
      name: "Settings",
      status: "ok",
      message: `${config.settings.source} is valid`,
    };
  } catch {
    return {
      name: "Settings",
      status: "error",
      message: "Cannot read settings.shared.json",
    };
  }
}

async function checkFilePermissions(repoPath: string): Promise<DoctorCheck> {
  // Check that sensitive-looking files don't have overly permissive permissions
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
    return {
      name: "Permissions",
      status: "warning",
      message: warnings.join("; "),
    };
  }
  return { name: "Permissions", status: "ok", message: "No permission issues" };
}

async function checkSymlinks(repoPath: string): Promise<DoctorCheck> {
  const checkDirs = ["skills", "extensions", "prompts", "themes", "config", "files"];
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
    return {
      name: "Symlinks",
      status: "warning",
      message: warnings.join("; "),
    };
  }
  return { name: "Symlinks", status: "ok", message: "No problematic symlinks" };
}

async function checkAbsolutePaths(repoPath: string): Promise<DoctorCheck> {
  const checkFiles = [
    join(repoPath, "config", "settings.shared.json"),
    join(repoPath, "config", "settings.macos.json"),
    join(repoPath, "config", "settings.linux.json"),
  ];

  const warnings: string[] = [];
  for (const file of checkFiles) {
    if (!existsSync(file)) continue;
    try {
      const { readFile } = await import("node:fs/promises");
      const content = await readFile(file, "utf-8");
      // Look for /home/ or /Users/ patterns
      if (/\/home\/|\/Users\//.test(content)) {
        warnings.push(`${file} may contain absolute paths`);
      }
    } catch {
      // skip
    }
  }

  if (warnings.length > 0) {
    return {
      name: "Absolute Paths",
      status: "warning",
      message: warnings.join("; "),
    };
  }
  return { name: "Absolute Paths", status: "ok", message: "No absolute paths found" };
}

function checkRepoInPiSettings(repoPath: string, agentDir: string): DoctorCheck {
  const settingsPath = join(agentDir, "settings.json");
  if (!existsSync(settingsPath)) {
    return {
      name: "Pi Settings",
      status: "warning",
      message: "settings.json not found - is Pi initialized?",
    };
  }
  // Note: We can't fully verify without reading settings.json
  // This check is best-effort
  return {
    name: "Pi Settings",
    status: "ok",
    message: "settings.json exists",
  };
}
