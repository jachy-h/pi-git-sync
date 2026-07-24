/**
 * denylist 和 secret scanning
 */
import { minimatch } from "./minimatch.ts";

/** 常见的敏感信息模式 */
const SECRET_PATTERNS: Array<{ name: string; pattern: RegExp; requiresContext?: RegExp }> = [
  {
    name: "GitHub Token",
    pattern: /\b(?:gh[pousr]_[A-Za-z0-9_]{36,}|github_pat_[A-Za-z0-9_]{22,})\b/,
  },
  {
    name: "OpenAI API Key",
    pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}\b/,
  },
  {
    name: "Anthropic API Key",
    pattern: /\bsk-ant-[A-Za-z0-9_-]{32,}\b/,
  },
  {
    name: "AWS Access Key",
    pattern: /AKIA[0-9A-Z]{16}/,
  },
  {
    name: "AWS Secret Key",
    pattern: /(?<![A-Za-z0-9\/+=])[A-Za-z0-9\/+=]{40}(?![A-Za-z0-9\/+=])/,
    // Only flag when the context suggests AWS
    requiresContext: /aws|amazon|secret.?key|secret.?access/i,
  },
  {
    name: "Generic API Key",
    pattern: /(?:\bapi[_-]?key\b|\bapikey\b|\bsecret[_-]?key\b)\s*[:=]\s*['"]?[A-Za-z0-9_\-.]{20,}['"]?/i,
  },
  {
    name: "JWT Token",
    pattern: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
  },
  {
    name: "Private Key",
    pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/,
  },
];

/**
 * 检查文件路径是否被 denylist 阻止
 */
export function isDenied(path: string, denyPatterns: string[]): boolean {
  const normalized = path.replace(/\\/g, "/");

  for (const pattern of denyPatterns) {
    if (minimatch(normalized, pattern)) {
      return true;
    }
  }

  return false;
}

/**
 * 扫描内容中的秘密信息
 * @returns 发现的疑似秘密列表
 */
export function scanSecrets(
  content: string,
  filePath: string,
): Array<{ type: string; file: string; line?: number }> {
  const findings: Array<{ type: string; file: string; line?: number }> = [];
  const lines = content.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    for (const secret of SECRET_PATTERNS) {
      if (secret.pattern.test(line)) {
        findings.push({
          type: secret.name,
          file: filePath,
          line: i + 1,
        });
      }
    }
  }

  return findings;
}

/**
 * 批量扫描多个文件中的秘密
 */
export async function scanFilesForSecrets(
  files: Array<{ path: string; content: string }>,
): Promise<Array<{ type: string; file: string; line?: number }>> {
  const results: Array<{ type: string; file: string; line?: number }> = [];

  for (const file of files) {
    const findings = scanSecrets(file.content, file.path);
    results.push(...findings);
  }

  return results;
}

/**
 * 检查是否有敏感文件被加入跟踪
 */
export function findDeniedFiles(
  trackedPaths: string[],
  denyPatterns: string[],
): string[] {
  return trackedPaths.filter((path) => isDenied(path, denyPatterns));
}
