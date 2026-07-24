/**
 * pi-sync.json 读取、校验和类型定义
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export interface PiSyncFileMapping {
  source: string;
  target: string;
  optional?: boolean;
}

export interface PiSyncSettings {
  source: string;
  strategy: "managed-keys";
  preserve: string[];
}

export interface PiSyncSecurity {
  deny: string[];
  scanSecretsBeforePush: boolean;
}

export interface PiSyncConfig {
  schemaVersion: number;
  branch?: string;
  settings: PiSyncSettings;
  files: PiSyncFileMapping[];
  security: PiSyncSecurity;
  auto?: {
    checkOnStartup?: boolean;
    pullOnStartup?: boolean;
    pushOnShutdown?: boolean;
  };
}

export const DEFAULT_CONFIG: PiSyncConfig = {
  schemaVersion: 1,
  branch: "main",
  settings: {
    source: "config/settings.shared.json",
    strategy: "managed-keys",
    preserve: [
      "lastChangelogVersion",
      "trackingId",
      "httpProxy",
      "sessionDir",
      "externalEditor",
      "npmCommand",
    ],
  },
  files: [
    { source: "files/AGENTS.md", target: "AGENTS.md" },
    { source: "files/SYSTEM.md", target: "SYSTEM.md", optional: true },
    { source: "files/keybindings.json", target: "keybindings.json", optional: true },
    { source: "files/zentui.json", target: "zentui.json", optional: true },
  ],
  security: {
    deny: [
      "auth.json",
      "trust.json",
      "sessions/**",
      "models-store.json",
      "**/.env",
      "**/*.pem",
      "**/id_rsa",
    ],
    scanSecretsBeforePush: true,
  },
};

/**
 * 加载并校验 pi-sync.json
 */
export async function loadPiSyncConfig(repoPath: string): Promise<PiSyncConfig> {
  const configPath = join(repoPath, "pi-sync.json");
  let raw: Record<string, unknown>;

  try {
    const content = await readFile(configPath, "utf-8");
    raw = JSON.parse(content);
  } catch {
    throw new Error(`Cannot read or parse pi-sync.json at ${configPath}`);
  }

  return validateConfig(raw);
}

/**
 * 校验配置对象
 */
export function validateConfig(raw: Record<string, unknown>): PiSyncConfig {
  if (raw.schemaVersion !== 1) {
    throw new Error(`Unsupported schemaVersion: ${raw.schemaVersion}. Expected 1.`);
  }

  const settings = raw.settings as Record<string, unknown> | undefined;
  if (!settings || typeof settings.source !== "string") {
    throw new Error("pi-sync.json: settings.source is required and must be a string.");
  }
  if (settings.strategy !== "managed-keys") {
    throw new Error(
      `pi-sync.json: Unsupported settings strategy "${settings.strategy}". Currently only "managed-keys" is supported.`,
    );
  }
  if (!Array.isArray(settings.preserve)) {
    throw new Error("pi-sync.json: settings.preserve must be an array of strings.");
  }

  const files = raw.files;
  if (files !== undefined && !Array.isArray(files)) {
    throw new Error("pi-sync.json: files must be an array.");
  }

  const security = raw.security as Record<string, unknown> | undefined;
  if (security) {
    if (security.deny !== undefined && !Array.isArray(security.deny)) {
      throw new Error("pi-sync.json: security.deny must be an array.");
    }
  }

  return {
    schemaVersion: 1,
    branch: (typeof raw.branch === "string" ? raw.branch : undefined) ?? "main",
    settings: {
      source: settings.source as string,
      strategy: "managed-keys",
      preserve: settings.preserve as string[],
    },
    files: (files as PiSyncFileMapping[] | undefined) ?? [],
    security: {
      deny: (security?.deny as string[] | undefined) ?? [],
      scanSecretsBeforePush:
        (security?.scanSecretsBeforePush as boolean | undefined) ?? true,
    },
    auto: raw.auto as PiSyncConfig["auto"] | undefined,
  } satisfies PiSyncConfig;
}
