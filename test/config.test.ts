import { describe, it, expect } from "vitest";
import { validateConfig, DEFAULT_CONFIG } from "../src/config.ts";

describe("validateConfig", () => {
  it("should accept a valid v2 config", () => {
    const raw = {
      schemaVersion: 2,
      root: "sync",
      include: ["settings.json", "AGENTS.md", "extensions/**"],
      exclude: ["**/.DS_Store"],
      delete: "tracked",
      security: {
        scanSecretsBeforePush: true,
      },
    };

    const config = validateConfig(raw);
    expect(config.schemaVersion).toBe(2);
    expect(config.root).toBe("sync");
    expect(config.include).toEqual(["settings.json", "AGENTS.md", "extensions/**"]);
    expect(config.exclude).toEqual(["**/.DS_Store"]);
    expect(config.delete).toBe("tracked");
    expect(config.security.scanSecretsBeforePush).toBe(true);
  });

  it("should throw for unsupported schemaVersion", () => {
    expect(() =>
      validateConfig({ schemaVersion: 3, include: [], files: [] }),
    ).toThrow("Unsupported schemaVersion");
  });

  it("should throw for missing include array", () => {
    expect(() =>
      validateConfig({
        schemaVersion: 2,
        include: [],
      }),
    ).toThrow("include must be a non-empty array");
  });

  it("should throw for include patterns with ..", () => {
    expect(() =>
      validateConfig({
        schemaVersion: 2,
        include: ["../escape"],
      }),
    ).toThrow('must not contain ".."');
  });

  it("should use default branch when not specified", () => {
    const raw = {
      schemaVersion: 2,
      include: ["settings.json"],
    };

    const config = validateConfig(raw);
    expect(config.branch).toBe("main");
  });

  it("should accept custom branch", () => {
    const raw = {
      schemaVersion: 2,
      branch: "develop",
      include: ["settings.json"],
    };

    const config = validateConfig(raw);
    expect(config.branch).toBe("develop");
  });

  it("should use default security when not specified", () => {
    const raw = {
      schemaVersion: 2,
      include: ["settings.json"],
    };

    const config = validateConfig(raw);
    expect(config.security.scanSecretsBeforePush).toBe(true);
  });

  it("should use defaults for optional fields", () => {
    const raw = {
      schemaVersion: 2,
      include: ["settings.json", "extensions/**"],
    };

    const config = validateConfig(raw);
    expect(config.root).toBe("sync");
    expect(config.exclude).toEqual([]);
    expect(config.delete).toBe("tracked");
  });

  it("should accept exclude list", () => {
    const raw = {
      schemaVersion: 2,
      include: ["**"],
      exclude: ["**/*.tmp", "**/*.log"],
    };

    const config = validateConfig(raw);
    expect(config.exclude).toEqual(["**/*.tmp", "**/*.log"]);
  });

  it("should reject invalid root with ..", () => {
    expect(() =>
      validateConfig({
        schemaVersion: 2,
        root: "../escape",
        include: ["settings.json"],
      }),
    ).toThrow("root must be a relative path");
  });
});
