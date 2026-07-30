import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import {
	atomicWrite,
	planMaterialize,
	executeMaterialize,
	readAgentFile,
} from "../src/sync/materialize.ts";
import type { PiSyncConfig } from "../src/sync/config.ts";
import type { SyncState } from "../src/system/state.ts";

function makeV2Config(overrides?: Partial<PiSyncConfig>): PiSyncConfig {
	return {
		schemaVersion: 2,
		branch: "main",
		root: "sync",
		include: ["**"],
		exclude: [],
		delete: "tracked",
		pullTimeoutMs: 30000,
		security: { scanSecretsBeforePush: false },
		...overrides,
	};
}

function makeEmptyState(repoPath: string): SyncState {
	return {
		schemaVersion: 3,
		repoPath,
		branch: "main",
		lastSyncedCommit: null,
		lastSyncedAt: null,
		files: {},
		pendingOperation: null,
		lastBackup: null,
	};
}

describe("atomicWrite", () => {
	let targetDir: string;

	beforeEach(async () => {
		targetDir = join(
			tmpdir(),
			`pi-sync-atomic-${randomBytes(4).toString("hex")}`,
		);
		await mkdir(targetDir, { recursive: true });
	});

	afterEach(async () => {
		await rm(targetDir, { recursive: true, force: true });
	});

	it("should write a file", async () => {
		const path = join(targetDir, "test.txt");
		await atomicWrite(path, "hello world");

		expect(existsSync(path)).toBe(true);
		const content = await readFile(path, "utf-8");
		expect(content).toBe("hello world");
	});

	it("should overwrite existing file", async () => {
		const path = join(targetDir, "test.txt");
		await writeFile(path, "old content");
		await atomicWrite(path, "new content");

		const content = await readFile(path, "utf-8");
		expect(content).toBe("new content");
	});

	it("should create parent directories", async () => {
		const path = join(targetDir, "sub", "dir", "test.txt");
		await atomicWrite(path, "hello");

		expect(existsSync(path)).toBe(true);
	});
});

describe("planMaterialize + executeMaterialize", () => {
	let repoPath: string;
	let agentDir: string;
	let syncDir: string;

	beforeEach(async () => {
		const base = tmpdir();
		repoPath = join(base, `pi-sync-repo-${randomBytes(4).toString("hex")}`);
		agentDir = join(base, `pi-sync-agent-${randomBytes(4).toString("hex")}`);
		syncDir = join(repoPath, "sync");

		await mkdir(syncDir, { recursive: true });
		await mkdir(agentDir, { recursive: true });
	});

	afterEach(async () => {
		await rm(repoPath, { recursive: true, force: true });
		await rm(agentDir, { recursive: true, force: true });
	});

	it("should apply files from repo sync/ to agent dir", async () => {
		await writeFile(join(syncDir, "AGENTS.md"), "# AGENTS");

		const config = makeV2Config({ include: ["AGENTS.md", "**"] });
		const state = makeEmptyState(repoPath);

		const plan = await planMaterialize(agentDir, repoPath, config, state);

		// Should have a write plan for AGENTS.md
		const writePlan = plan.toWrite.find((w) => w.relativePath === "AGENTS.md");
		expect(writePlan).toBeDefined();

		const result = await executeMaterialize(agentDir, plan);
		expect(result.written).toContain("AGENTS.md");
		expect(existsSync(join(agentDir, "AGENTS.md"))).toBe(true);

		const content = await readFile(join(agentDir, "AGENTS.md"), "utf-8");
		expect(content).toBe("# AGENTS");
	});

	it("should skip files not in include patterns", async () => {
		await writeFile(join(syncDir, "AGENTS.md"), "# AGENTS");

		const config = makeV2Config({ include: ["settings.json"] }); // AGENTS.md not in include
		const state = makeEmptyState(repoPath);

		const plan = await planMaterialize(agentDir, repoPath, config, state);
		expect(plan.toWrite).toHaveLength(0);
	});

	it("should handle tracked deletion", async () => {
		// Baseline had AGENTS.md, but repo has deleted it
		const state = makeEmptyState(repoPath);
		state.files["AGENTS.md"] = { sha256: "abc123", mode: 0o644 };

		const config = makeV2Config({
			include: ["AGENTS.md"],
			delete: "tracked",
		});

		const plan = await planMaterialize(agentDir, repoPath, config, state);
		// Should plan to delete since it was tracked and repo doesn't have it
		const deletePlan = plan.toDelete.find((d) => d === "AGENTS.md");
		expect(deletePlan).toBeDefined();
	});

	it("should not delete untracked files", async () => {
		// Create agent file not in baseline
		await writeFile(join(agentDir, "untracked.md"), "# untracked");

		const config = makeV2Config({ include: ["untracked.md"] });
		const state = makeEmptyState(repoPath);
		// No baseline entry — untracked

		const plan = await planMaterialize(agentDir, repoPath, config, state);
		// Should not plan to delete untracked files just because repo doesn't have them
		const deletePlan = plan.toDelete.find((d) => d === "untracked.md");
		expect(deletePlan).toBeUndefined();
	});
});

describe("readAgentFile", () => {
	let agentDir: string;

	beforeEach(async () => {
		agentDir = join(tmpdir(), `pi-sync-read-${randomBytes(4).toString("hex")}`);
		await mkdir(agentDir, { recursive: true });
	});

	afterEach(async () => {
		await rm(agentDir, { recursive: true, force: true });
	});

	it("should read a file and compute hash", async () => {
		await writeFile(join(agentDir, "test.txt"), "hello");

		const result = await readAgentFile(agentDir, "test.txt");
		expect(result).not.toBeNull();
		expect(result!.sha256).toBeDefined();
		expect(result!.sha256.length).toBe(64); // SHA-256 hex string
	});

	it("should return null for missing file", async () => {
		const result = await readAgentFile(agentDir, "nonexistent.txt");
		expect(result).toBeNull();
	});
});
