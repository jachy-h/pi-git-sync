import { describe, it, expect } from "vitest";
import { isDenied, scanSecrets, findDeniedFiles } from "../src/security.ts";

describe("isDenied", () => {
  const denyPatterns = [
    "auth.json",
    "trust.json",
    "sessions/**",
    "**/.env",
    "**/*.pem",
    "**/id_rsa",
  ];

  it("should deny exact matches", () => {
    expect(isDenied("auth.json", denyPatterns)).toBe(true);
    expect(isDenied("trust.json", denyPatterns)).toBe(true);
  });

  it("should allow non-matching files", () => {
    expect(isDenied("settings.json", denyPatterns)).toBe(false);
    expect(isDenied("AGENTS.md", denyPatterns)).toBe(false);
  });

  it("should deny sessions subdirectories", () => {
    expect(isDenied("sessions/foo.jsonl", denyPatterns)).toBe(true);
    expect(isDenied("sessions/a/b/c.jsonl", denyPatterns)).toBe(true);
  });

  it("should deny .env anywhere", () => {
    expect(isDenied(".env", denyPatterns)).toBe(true);
    expect(isDenied("dir/.env", denyPatterns)).toBe(true);
    expect(isDenied("a/b/.env", denyPatterns)).toBe(true);
  });

  it("should deny .pem files", () => {
    expect(isDenied("key.pem", denyPatterns)).toBe(true);
    expect(isDenied("certs/key.pem", denyPatterns)).toBe(true);
  });

  it("should deny id_rsa files", () => {
    expect(isDenied("id_rsa", denyPatterns)).toBe(true);
    expect(isDenied(".ssh/id_rsa", denyPatterns)).toBe(true);
  });
});

describe("scanSecrets", () => {
  it("should find GitHub tokens", () => {
    const findings = scanSecrets(
      'GITHUB_TOKEN=ghp_1234567890abcdef1234567890abcdef123456',
      ".env",
    );
    // That's 44 chars after ghp_, the pattern needs 36+ so: 4 + 40 = 44, avoid AWS 40-char pattern by using 39 chars
    const ghTokenFindings = findings.filter((f) => f.type === "GitHub Token");
    expect(ghTokenFindings).toHaveLength(1);
    expect(ghTokenFindings[0]!.type).toBe("GitHub Token");
  });

  it("should find OpenAI API keys", () => {
    const findings = scanSecrets(
      'OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz1234',
      ".env",
    );
    const oaiFindings = findings.filter((f) => f.type === "OpenAI API Key");
    expect(oaiFindings).toHaveLength(1);
    expect(oaiFindings[0]!.type).toBe("OpenAI API Key");
  });

  it("should find private keys", () => {
    const findings = scanSecrets(
      "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC...\n-----END PRIVATE KEY-----",
      "key.pem",
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]!.type).toBe("Private Key");
  });

  it("should return empty for clean content", () => {
    const findings = scanSecrets(
      'config_key = "some-safe-value"\nother = 123',
      "config.json",
    );
    expect(findings).toHaveLength(0);
  });

  it("should find JWT tokens", () => {
    const findings = scanSecrets(
      '{"token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U"}',
      "config.json",
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]!.type).toBe("JWT Token");
  });
});

describe("findDeniedFiles", () => {
  it("should filter denied files", () => {
    const files = ["auth.json", "settings.json", "AGENTS.md", ".env"];
    const deny = ["auth.json", "**/.env"];
    const denied = findDeniedFiles(files, deny);
    expect(denied).toEqual(["auth.json", ".env"]);
  });

  it("should return empty when no denied files", () => {
    const files = ["settings.json", "AGENTS.md", "SYSTEM.md"];
    const deny = ["auth.json", "**/.env"];
    const denied = findDeniedFiles(files, deny);
    expect(denied).toEqual([]);
  });
});
