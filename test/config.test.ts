import { describe, it, expect } from "vitest";
import { validateConfig, DEFAULT_CONFIG } from "../src/config.ts";

describe("validateConfig", () => {
  it("should accept a valid config", () => {
    const raw = {
      schemaVersion: 1,
      settings: {
        source: "config/settings.shared.json",
        strategy: "managed-keys",
        preserve: ["lastChangelogVersion"],
      },
      files: [
        { source: "files/AGENTS.md", target: "AGENTS.md" },
      ],
      security: {
        deny: ["auth.json"],
        scanSecretsBeforePush: true,
      },
    };

    const config = validateConfig(raw);
    expect(config.schemaVersion).toBe(1);
    expect(config.settings.source).toBe("config/settings.shared.json");
    expect(config.settings.strategy).toBe("managed-keys");
    expect(config.settings.preserve).toEqual(["lastChangelogVersion"]);
    expect(config.files).toHaveLength(1);
    expect(config.security.deny).toEqual(["auth.json"]);
  });

  it("should throw for unsupported schemaVersion", () => {
    expect(() =>
      validateConfig({ schemaVersion: 2, settings: {}, files: [] }),
    ).toThrow("Unsupported schemaVersion");
  });

  it("should throw for missing settings.source", () => {
    expect(() =>
      validateConfig({
        schemaVersion: 1,
        settings: { strategy: "managed-keys" },
        files: [],
      }),
    ).toThrow("settings.source");
  });

  it("should throw for unsupported strategy", () => {
    expect(() =>
      validateConfig({
        schemaVersion: 1,
        settings: {
          source: "config/settings.json",
          strategy: "overwrite",
          preserve: [],
        },
        files: [],
      }),
    ).toThrow("Unsupported settings strategy");
  });

  it("should use default branch when not specified", () => {
    const raw = {
      schemaVersion: 1,
      settings: {
        source: "config/settings.shared.json",
        strategy: "managed-keys",
        preserve: [],
      },
    };

    const config = validateConfig(raw);
    expect(config.branch).toBe("main");
  });

  it("should accept custom branch", () => {
    const raw = {
      schemaVersion: 1,
      branch: "develop",
      settings: {
        source: "config/settings.shared.json",
        strategy: "managed-keys",
        preserve: [],
      },
    };

    const config = validateConfig(raw);
    expect(config.branch).toBe("develop");
  });

  it("should use default security when not specified", () => {
    const raw = {
      schemaVersion: 1,
      settings: {
        source: "config/settings.shared.json",
        strategy: "managed-keys",
        preserve: [],
      },
    };

    const config = validateConfig(raw);
    expect(config.security.deny).toEqual([]);
    expect(config.security.scanSecretsBeforePush).toBe(true);
  });
});
