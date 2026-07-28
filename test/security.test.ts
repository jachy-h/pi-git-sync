import { describe, it, expect } from "vitest";
import { isDenied, scanSecrets, findDeniedFiles } from "../src/security.ts";

describe("isDenied", () => {
	it("should deny built-in hard deny files (no extra patterns needed)", () => {
		expect(isDenied("auth.json")).toBe(true);
		expect(isDenied("trust.json")).toBe(true);
		expect(isDenied(".env")).toBe(true);
		expect(isDenied("subdir/.env")).toBe(true);
		expect(isDenied("key.pem")).toBe(true);
		expect(isDenied("id_rsa")).toBe(true);
		expect(isDenied(".ssh/id_rsa")).toBe(true);
		expect(isDenied("sessions/foo.jsonl")).toBe(true);
		expect(isDenied("sessions/a/b/c.jsonl")).toBe(true);
		expect(isDenied("id_ed25519")).toBe(true);
	});

	it("should allow non-denied files", () => {
		expect(isDenied("settings.json")).toBe(false);
		expect(isDenied("AGENTS.md")).toBe(false);
		expect(isDenied("SYSTEM.md")).toBe(false);
		expect(isDenied("extensions/example.ts")).toBe(false);
	});

	it("should accept extra deny patterns", () => {
		// Custom extra deny pattern
		expect(isDenied("secrets.json", ["secrets.json"])).toBe(true);
		// Built-in hard deny still applies
		expect(isDenied("auth.json", [])).toBe(true);
	});

	it("should deny node_modules and npm/git directories", () => {
		expect(isDenied("node_modules/some-pkg/index.js")).toBe(true);
		expect(isDenied("npm/something")).toBe(true);
		expect(isDenied("git/something")).toBe(true);
	});
});

describe("scanSecrets", () => {
	it("should find GitHub tokens", () => {
		const fakeToken = [
			"gh",
			"p_",
			"1234567890abcdef",
			"1234567890abcdef123456",
		].join("");
		const findings = scanSecrets(`GITHUB_TOKEN=${fakeToken}`, ".env");
		const ghTokenFindings = findings.filter((f) => f.type === "GitHub Token");
		expect(ghTokenFindings).toHaveLength(1);
		expect(ghTokenFindings[0]!.type).toBe("GitHub Token");
	});

	it("should find OpenAI API keys", () => {
		const findings = scanSecrets(
			"OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz1234",
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
		const fakeJwt = [
			"eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9",
			"eyJzdWIiOiIxMjM0NTY3ODkwIn0",
			"dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
		].join(".");
		const findings = scanSecrets(
			JSON.stringify({ token: fakeJwt }),
			"config.json",
		);
		expect(findings).toHaveLength(1);
		expect(findings[0]!.type).toBe("JWT Token");
	});
});

describe("findDeniedFiles", () => {
	it("should filter files denied by built-in hard deny", () => {
		const files = ["auth.json", "settings.json", "AGENTS.md", ".env"];
		const denied = findDeniedFiles(files);
		expect(denied).toEqual(["auth.json", ".env"]);
	});

	it("should return empty when no denied files", () => {
		const files = ["settings.json", "AGENTS.md", "SYSTEM.md"];
		const denied = findDeniedFiles(files);
		expect(denied).toEqual([]);
	});

	it("should detect built-in deny patterns like sessions/ and .pem", () => {
		const files = ["sessions/chat.jsonl", "certs/ca.pem", "AGENTS.md"];
		const denied = findDeniedFiles(files);
		expect(denied).toEqual(["sessions/chat.jsonl", "certs/ca.pem"]);
	});
});
