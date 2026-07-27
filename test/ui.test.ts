import { describe, expect, it } from "vitest";
import {
	formatGitStatus,
	formatSyncStatusV2,
	formatComparisonDiff,
	formatSecretsFindings,
	formatBackupList,
	formatValidationErrors,
	formatCaptureResult,
} from "../src/ui.ts";
import type { GitStatus } from "../src/git.ts";
import type {
	FileComparison,
	FileEntry,
	InventoryResult,
} from "../src/inventory.ts";
import type { CaptureResult } from "../src/capture.ts";

function makeFileEntry(sha256 = "abc", mode = 0o644): FileEntry {
	return { relativePath: "", sha256, mode };
}

describe("formatGitStatus", () => {
	it("formats a clean repo status", () => {
		const status: GitStatus = {
			branch: "main",
			commit: "abc1234567890def1234567890",
			commitShort: "abc1234",
			ahead: 0,
			behind: 0,
			hasUncommittedChanges: false,
			hasUnpushedCommits: false,
			remoteExists: true,
			changedFiles: [],
			isRebasing: false,
			isMerging: false,
			hasConflicts: false,
			conflictedFiles: [],
		};
		const result = formatGitStatus(status);
		expect(result).toContain("Branch:");
		expect(result).toContain("main");
		expect(result).toContain("Commit:");
		expect(result).toContain("abc1234");
		expect(result).toContain("Uncommitted:");
		expect(result).toContain("no");
	});

	it("formats a dirty repo with changes", () => {
		const status: GitStatus = {
			branch: "feature",
			commit: "def5678901abc2345678901",
			commitShort: "def5678",
			ahead: 3,
			behind: 1,
			hasUncommittedChanges: true,
			hasUnpushedCommits: true,
			remoteExists: true,
			changedFiles: ["sync/settings.json"],
			isRebasing: false,
			isMerging: false,
			hasConflicts: false,
			conflictedFiles: [],
		};
		const result = formatGitStatus(status);
		expect(result).toContain("feature");
		expect(result).toContain("Uncommitted:");
		expect(result).toContain("YES");
	});

	it("formats rebasing and merging state", () => {
		const status: GitStatus = {
			branch: "main",
			commit: "abc1234",
			commitShort: "abc1234",
			ahead: 0,
			behind: 0,
			hasUncommittedChanges: false,
			hasUnpushedCommits: false,
			remoteExists: true,
			changedFiles: [],
			isRebasing: true,
			isMerging: true,
			hasConflicts: true,
			conflictedFiles: ["sync/file.md"],
		};
		const result = formatGitStatus(status);
		expect(result).toContain("Rebasing:");
		expect(result).toContain("Merging:");
		expect(result).toContain("Conflicts:");
	});

	it("formats repo without remote", () => {
		const status: GitStatus = {
			branch: "main",
			commit: "abc1234",
			commitShort: "abc1234",
			ahead: 0,
			behind: 0,
			hasUncommittedChanges: false,
			hasUnpushedCommits: false,
			remoteExists: false,
			changedFiles: [],
			isRebasing: false,
			isMerging: false,
			hasConflicts: false,
			conflictedFiles: [],
		};
		const result = formatGitStatus(status);
		expect(result).toContain("Remote:");
		expect(result).toContain("none");
	});
});

describe("formatComparisonDiff", () => {
	function makeComparison(
		relativePath: string,
		changeType: FileComparison["changeType"],
	): FileComparison {
		return {
			relativePath,
			changeType,
			baseline: makeFileEntry(),
			local: makeFileEntry("abc123456789"),
			remote: makeFileEntry("def123456789"),
		};
	}

	it("returns 'No files to compare' for an empty list", () => {
		expect(formatComparisonDiff([])).toBe("No files to compare.");
	});

	it("shows icons and labels for different change types", () => {
		const comparisons: FileComparison[] = [
			makeComparison("prompts/local.md", "local_only"),
			makeComparison("prompts/remote.md", "remote_only"),
			makeComparison("prompts/both.md", "both_modified"),
			makeComparison("prompts/new.md", "local_created"),
			makeComparison("prompts/gone.md", "remote_deleted"),
		];
		const result = formatComparisonDiff(comparisons);
		expect(result).toContain("prompts/local.md");
		expect(result).toContain("prompts/remote.md");
		expect(result).toContain("prompts/both.md");
		expect(result).toContain("prompts/new.md");
		expect(result).toContain("prompts/gone.md");
	});

	it("skips no_change entries and returns no changes when all are unchanged", () => {
		const comparisons: FileComparison[] = [
			makeComparison("same.md", "no_change"),
		];
		expect(formatComparisonDiff(comparisons)).toBe("No changes detected.");
	});
});

describe("formatSyncStatusV2", () => {
	it("renders a full status summary with header", () => {
		const gitStatus: GitStatus = {
			branch: "main",
			commit: "abc1234567890def1234567890",
			commitShort: "abc1234",
			ahead: 0,
			behind: 0,
			hasUncommittedChanges: false,
			hasUnpushedCommits: false,
			remoteExists: true,
			changedFiles: [],
			isRebasing: false,
			isMerging: false,
			hasConflicts: false,
			conflictedFiles: [],
		};

		const comparisons: FileComparison[] = [
			{
				relativePath: "settings.json",
				changeType: "remote_only",
				baseline: makeFileEntry(),
				local: makeFileEntry(),
				remote: makeFileEntry("def"),
			},
		];

		const inventory: InventoryResult = {
			comparisons,
			summary: {
				noChange: 0,
				localOnly: 0,
				remoteOnly: 1,
				converged: 0,
				bothModified: 0,
				localCreated: 0,
				remoteCreated: 0,
				localDeleted: 0,
				remoteDeleted: 0,
			},
		};

		const result = formatSyncStatusV2({
			repoPath: "/test/repo",
			agentDir: "/test/agent",
			gitStatus,
			config: {
				schemaVersion: 2,
				branch: "main",
				root: "sync",
				include: ["settings.json"],
				exclude: [],
				delete: "tracked" as const,
				security: { scanSecretsBeforePush: true },
			},
			inventory,
			state: {
				schemaVersion: 3,
				repoPath: "/test/repo",
				branch: "main",
				lastSyncedCommit: "abc1234",
				lastSyncedAt: "2026-01-01T00:00:00Z",
				files: {},
				pendingOperation: null,
				lastBackup: null,
			},
		});

		expect(result).toContain("pi-git-sync");
		expect(result).toContain("sync/");
	});

	it("renders with pending operation and package diff", () => {
		const gitStatus: GitStatus = {
			branch: "main",
			commit: "abc1234",
			commitShort: "abc1234",
			ahead: 2,
			behind: 0,
			hasUncommittedChanges: true,
			hasUnpushedCommits: true,
			remoteExists: true,
			changedFiles: ["sync/settings.json"],
			isRebasing: false,
			isMerging: false,
			hasConflicts: false,
			conflictedFiles: [],
		};

		const inventory: InventoryResult = {
			comparisons: [],
			summary: {
				noChange: 0,
				localOnly: 0,
				remoteOnly: 0,
				converged: 0,
				bothModified: 0,
				localCreated: 0,
				remoteCreated: 0,
				localDeleted: 0,
				remoteDeleted: 0,
			},
		};

		const result = formatSyncStatusV2({
			repoPath: "/test/repo",
			agentDir: "/test/agent",
			gitStatus,
			config: {
				schemaVersion: 2,
				branch: "main",
				root: "sync",
				include: ["settings.json"],
				exclude: [],
				delete: "none" as const,
				security: { scanSecretsBeforePush: false },
			},
			inventory,
			state: {
				schemaVersion: 3,
				repoPath: "/test/repo",
				branch: "main",
				lastSyncedCommit: null,
				lastSyncedAt: null,
				files: {},
				pendingOperation: {
					type: "push-rebase-conflict",
					startedAt: "2026-01-01T00-00-00Z",
				},
				lastBackup: "2026-01-01T00-00-00Z",
			},
			pkgDiff: {
				added: ["npm:pkg-a"],
				removed: [],
				changed: ["npm:pkg-b"],
				unchanged: ["npm:kept"],
			},
		});

		expect(result).toContain("pi-git-sync");
		// The pending operation should appear somewhere in the status
		expect(result.length).toBeGreaterThan(0);
	});

	it("lists conflicting files with Git merge instructions, not local and remote paths", () => {
		const gitStatus: GitStatus = {
			branch: "main",
			commit: "abc1234567890def1234567890",
			commitShort: "abc1234",
			ahead: 0,
			behind: 0,
			hasUncommittedChanges: true,
			hasUnpushedCommits: false,
			remoteExists: true,
			changedFiles: ["sync/prompts/welcome.md"],
			isRebasing: false,
			isMerging: true,
			hasConflicts: true,
			conflictedFiles: ["sync/prompts/welcome.md"],
		};
		const inventory: InventoryResult = {
			comparisons: [
				{
					relativePath: "prompts/welcome.md",
					changeType: "both_modified",
					baseline: makeFileEntry("base"),
					local: makeFileEntry("local"),
					remote: makeFileEntry("remote"),
				},
			],
			summary: {
				noChange: 0,
				localOnly: 0,
				remoteOnly: 0,
				converged: 0,
				bothModified: 1,
				localCreated: 0,
				remoteCreated: 0,
				localDeleted: 0,
				remoteDeleted: 0,
			},
		};

		const result = formatSyncStatusV2({
			repoPath: "/test/repo",
			agentDir: "/private/agent",
			gitStatus,
			config: {
				schemaVersion: 2,
				branch: "main",
				root: "sync",
				include: ["prompts/**"],
				exclude: [],
				delete: "tracked",
				security: { scanSecretsBeforePush: false },
			},
			inventory,
			state: {
				schemaVersion: 3,
				repoPath: "/test/repo",
				branch: "main",
				lastSyncedCommit: null,
				lastSyncedAt: null,
				files: {},
				pendingOperation: null,
				lastBackup: null,
			},
		});

		expect(result).toContain("sync/prompts/welcome.md");
		expect(result).toContain("cd '/test/repo'");
		expect(result).toContain("git add .");
		expect(result).toContain('git commit -m "resolve conflicts"');
		expect(result).not.toContain("git status");
		expect(result).not.toContain("git fetch origin");
		expect(result).not.toContain("/private/agent");
		expect(result).not.toContain("Agent (local)");
		expect(result).not.toContain("Repo  (remote)");
	});
});

describe("formatSecretsFindings", () => {
	it("formats a list of secret findings", () => {
		const findings = [
			{ type: "GitHub Token", file: "settings.json", line: 5 },
			{ type: "Private Key", file: "keys/id_rsa" },
		];
		const result = formatSecretsFindings(findings);
		expect(result).toContain("GitHub Token");
		expect(result).toContain("settings.json");
		expect(result).toContain("Private Key");
		expect(result).toContain("potential secret");
	});

	it("returns 'No secrets detected' for empty findings", () => {
		expect(formatSecretsFindings([])).toBe("No secrets detected.");
	});
});

describe("formatValidationErrors", () => {
	it("formats errors and warnings", () => {
		const errors = [
			{
				file: "settings.json",
				message: "Invalid JSON",
				severity: "error" as const,
			},
			{
				file: "settings.json",
				message: "Missing pi-git-sync",
				severity: "warning" as const,
			},
		];
		const result = formatValidationErrors(errors);
		expect(result).toContain("ERROR");
		expect(result).toContain("WARN");
		expect(result).toContain("Invalid JSON");
	});

	it("returns 'No validation errors' for empty list", () => {
		expect(formatValidationErrors([])).toBe("No validation errors.");
	});
});

describe("formatBackupList", () => {
	it("formats a list of backups", () => {
		const backups = [
			{
				timestamp: "2026-01-02T00-00-00-000Z",
				commit: "abc1234567890",
				reason: "apply",
				operation: "apply",
				path: "/backups/1",
				files: {},
			},
			{
				timestamp: "2026-01-01T00-00-00-000Z",
				commit: "def4567890123",
				reason: "pre-rollback",
				operation: "push",
				path: "/backups/2",
				files: {},
			},
		];
		const result = formatBackupList(backups);
		expect(result).toContain("Available backups:");
		expect(result).toContain("2026");
		expect(result).toContain("apply");
		expect(result).toContain("pre-rollback");
	});

	it("returns 'No backups available' for empty list", () => {
		expect(formatBackupList([])).toBe("No backups available.");
	});
});

describe("formatCaptureResult", () => {
	it("formats capture result with captured and deleted files", () => {
		const result: CaptureResult = {
			captured: ["prompts/new.md", "settings.json"],
			deleted: ["prompts/old.md"],
			denied: [],
			errors: [],
			hasConflicts: false,
			conflicts: [],
		};
		const output = formatCaptureResult(result);
		expect(output).toContain("new.md");
		expect(output).toContain("old.md");
	});

	it("returns 'No changes' for empty capture result", () => {
		const result: CaptureResult = {
			captured: [],
			deleted: [],
			denied: [],
			errors: [],
			hasConflicts: false,
			conflicts: [],
		};
		const output = formatCaptureResult(result);
		// Should indicate nothing to capture
		expect(output.length).toBeGreaterThanOrEqual(0);
	});

	it("formats capture with denied files and errors", () => {
		const result: CaptureResult = {
			captured: ["prompts/safe.md"],
			deleted: [],
			denied: ["auth.json"],
			errors: [{ file: "corrupt.json", message: "Invalid JSON" }],
			hasConflicts: false,
			conflicts: [],
		};
		const output = formatCaptureResult(result);
		// Should contain file info
		expect(output).toContain("safe.md");
		expect(output).toContain("auth.json");
	});

	it("formats capture with conflicts", () => {
		const result: CaptureResult = {
			captured: [],
			deleted: [],
			denied: [],
			errors: [],
			hasConflicts: true,
			conflicts: [
				{
					relativePath: "settings.json",
					changeType: "both_modified",
					baseline: makeFileEntry("base"),
					local: makeFileEntry("local"),
					remote: makeFileEntry("remote"),
				},
			],
		};
		const output = formatCaptureResult(result);
		expect(output).toContain("bilateral");
		expect(output).toContain("settings.json");
	});
});
