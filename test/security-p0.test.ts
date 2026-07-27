import { describe, expect, it } from "vitest";
import { findDeniedFiles, isDenied, scanFilesForSecrets, scanSecrets } from "../src/security.ts";

describe("hard deny P0 regressions", () => {
  it.each([
    "auth.json",
    "sessions/session.jsonl",
    "trust.json",
    "models-store.json",
    "npm/cache/index.json",
    "git/config",
    "node_modules/pkg/index.js",
    ".pi-sync/state.json",
    ".env",
    "nested/.env",
    "keys/agent.pem",
    "id_rsa",
    "keys/id_ed25519",
    "sessions\\windows.jsonl",
  ])("denies %s regardless of platform separator", (path) => {
    expect(isDenied(path)).toBe(true);
  });

  it("keeps similar but legitimate configuration paths available", () => {
    expect(findDeniedFiles([
      "settings.json",
      "prompts/auth.json.md",
      "themes/agent.pem.json",
      "skills/session-helper.ts",
    ])).toEqual([]);
  });
});

describe("secret scanning P0 regressions", () => {
  it("reports all findings with the originating file and exact line", () => {
    const findings = scanSecrets([
      "safe = true",
      "token = ghp_1234567890abcdef1234567890abcdef123456",
      "private = -----BEGIN PRIVATE KEY-----",
    ].join("\n"), "settings.json");

    expect(findings).toEqual([
      { type: "GitHub Token", file: "settings.json", line: 2 },
      { type: "Private Key", file: "settings.json", line: 3 },
    ]);
  });

  it("requires AWS context before treating a 40-character value as an AWS secret", () => {
    const value = "A".repeat(40);
    expect(scanSecrets(`value = ${value}`, "settings.json")).toEqual([]);
    expect(scanSecrets(`aws_secret_access_key = ${value}`, "settings.json"))
      .toContainEqual({ type: "AWS Secret Key", file: "settings.json", line: 1 });
  });

  it("scans every changed file rather than only the first file", () => {
    expect(scanFilesForSecrets([
      { path: "settings.json", content: "safe = true" },
      { path: "extensions/token.ts", content: "const key = 'sk-proj-abcdefghijklmnopqrstuvwxyz123456';" },
      { path: "keys/private.pem", content: "-----BEGIN RSA PRIVATE KEY-----" },
    ])).toEqual([
      { type: "OpenAI API Key", file: "extensions/token.ts", line: 1 },
      { type: "Private Key", file: "keys/private.pem", line: 1 },
    ]);
  });
});
