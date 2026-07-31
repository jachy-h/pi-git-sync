import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { loadPiSyncConfig } from "../sync/config.ts";
import {
	GitCommandError,
	ensureConfiguredBranch,
	gitCommit,
	gitExec,
	gitFastForward,
	gitFetch,
	gitProbe,
	gitPushHeadToBranch,
	gitRenameBranch,
} from "../system/git.ts";
import type { PiSyncConfig } from "../sync/config.ts";
import type { ResultCode } from "./operation-result.ts";
import type { PackageApproval } from "../system/packages.ts";
import { loadState, updateState } from "../system/state.ts";
import type { SyncState } from "../system/state.ts";

export interface SetupFlowResult {
	message: string;
	needsReload: boolean;
	ok: boolean;
	code?: ResultCode;
	details?: unknown;
	level: "info" | "warning" | "error";
}

interface InitialCaptureResult {
	hasConflicts: boolean;
	conflicts: Array<{ relativePath: string }>;
	errors: Array<{ file: string; message: string }>;
	captured: string[];
	deleted: string[];
}

interface SetupApplyResult {
	message: string;
	reload: boolean;
	ok: boolean;
	code?: ResultCode;
	details?: unknown;
}

export interface SetupFlowDependencies {
	captureInitialLocalConfig: (
		repoPath: string,
		config: PiSyncConfig,
	) => Promise<InitialCaptureResult>;
	createRepositoryBaseline: (
		repoPath: string,
		config: PiSyncConfig,
		state: SyncState,
	) => Promise<SyncState>;
	applyCurrent: (
		repoPath: string,
		config: PiSyncConfig,
		state: SyncState,
		reason: string,
		packageApproval?: PackageApproval,
	) => Promise<SetupApplyResult>;
	getDeviceBranchName: () => Promise<string>;
	pushMainAndDeviceBranches: (
		repoPath: string,
		branch: string,
	) => Promise<unknown>;
}

export interface SetupFlowOptions {
	agentDir: string;
	gitUrl: string;
	repoPath: string;
	force: boolean;
	packageApproval?: PackageApproval;
	onProgress?: (message: string) => void;
	dependencies: SetupFlowDependencies;
}

/**
 * Execute first-time setup after the command façade has acquired its lifecycle
 * lock. This phase owns repository preparation and initial application only;
 * it deliberately does not import the command façade or manage lock ownership.
 */
export async function executeSetupFlow(
	options: SetupFlowOptions,
): Promise<SetupFlowResult> {
	const {
		agentDir,
		gitUrl,
		repoPath,
		force,
		packageApproval,
		onProgress,
		dependencies,
	} = options;
	const {
		captureInitialLocalConfig,
		createRepositoryBaseline,
		applyCurrent,
		getDeviceBranchName,
		pushMainAndDeviceBranches,
	} = dependencies;

	try {
		const lines: string[] = [];
		let capturedInitialLocalConfig = false;
		let initialCapturedFiles = new Set<string>();

		onProgress?.("Checking local repo...");

		if (existsSync(repoPath) && existsSync(join(repoPath, ".git"))) {
			if (force) {
				onProgress?.("Removing existing repo (--force)...");
				lines.push("Force flag set — removing existing repo and re-cloning...");
				const { rm } = await import("node:fs/promises");
				await rm(repoPath, { recursive: true, force: true });
			} else {
				const existingProbe = await gitProbe(repoPath, [
					"remote",
					"get-url",
					"origin",
				]);
				const existingUrl = existingProbe.stdout.trim();

				if (!urlsMatch(existingUrl, gitUrl)) {
					return {
						message:
							`A config repo already exists at ${repoPath}\n` +
							`Existing remote: ${existingUrl}\nProvided URL:   ${gitUrl}\n` +
							"To switch, remove the existing repo first: rm -rf ~/.pi/config-repo\n" +
							"Run /pisync after removing or repairing the existing repository.",
						needsReload: false,
						ok: false,
						level: "error",
					};
				}
				lines.push(`Config repo already exists at ${repoPath}`);
			}
		}

		if (!existsSync(repoPath) || !existsSync(join(repoPath, ".git"))) {
			onProgress?.(`Cloning ${gitUrl}...`);
			lines.push(`Cloning ${gitUrl}...`);
			await mkdir(join(repoPath, ".."), { recursive: true });

			onProgress?.("Checking remote connectivity...");
			const preflight = await gitProbe(
				process.cwd(),
				["ls-remote", "--", gitUrl],
				{
					timeout: 30000,
				},
			);
			if (!preflight.ok) {
				return {
					message:
						`Clone failed: cannot reach ${gitUrl}\n${preflight.stderr.trim() || preflight.stdout.trim()}\n\n` +
						"Verify the URL, your network, and (for SSH URLs) that your key can authenticate.",
					needsReload: false,
					ok: false,
					level: "error",
				};
			}

			try {
				await gitExec(join(repoPath, ".."), ["clone", "--", gitUrl, repoPath], {
					timeout: 60000,
				});
			} catch (cloneErr) {
				if (existsSync(repoPath)) {
					const { rm } = await import("node:fs/promises");
					await rm(repoPath, { recursive: true, force: true });
				}
				let msg = "Unknown error";
				if (cloneErr instanceof GitCommandError) {
					msg = cloneErr.stderr || cloneErr.stdout || cloneErr.message;
				} else if (cloneErr instanceof Error) {
					msg = cloneErr.message;
				}
				return {
					message: `Clone failed:\n${msg}`,
					needsReload: false,
					ok: false,
					level: "error",
				};
			}
			if (!existsSync(join(repoPath, ".git"))) {
				return {
					message: "Clone completed but .git directory not found.",
					needsReload: false,
					ok: false,
					level: "error",
				};
			}
			lines.push("Clone complete.");
		}

		onProgress?.("Fetching latest changes...");
		await gitFetch(repoPath).catch(() => {});

		onProgress?.("Analyzing repo state...");
		const repoState = await detectRepoState(repoPath);

		if (force || repoState === "empty") {
			if (force && repoState !== "empty") {
				onProgress?.("Clearing existing repo contents (--force)...");
				lines.push("Force flag set — clearing existing repo contents...");
				await clearRepoContents(repoPath);
				await gitExec(repoPath, ["add", "-A"]);
				await gitExec(repoPath, [
					"commit",
					"-m",
					"pi-sync: force clear before rebuild",
					"--allow-empty",
				]);
			}

			onProgress?.("Scaffolding config structure...");
			lines.push(
				`${force && repoState !== "empty" ? "Force rebuilding" : "Empty repository"} — scaffolding config structure (schema v2)...`,
			);
			await scaffoldConfigRepoV2(repoPath);
			const scaffoldConfig = await loadPiSyncConfig(repoPath);
			const initialCapture = await captureInitialLocalConfig(
				repoPath,
				scaffoldConfig,
			);
			if (initialCapture.hasConflicts || initialCapture.errors.length > 0) {
				const details = initialCapture.hasConflicts
					? initialCapture.conflicts
							.map((conflict) => conflict.relativePath)
							.join(", ")
					: initialCapture.errors
							.map((error) => `${error.file}: ${error.message}`)
							.join("\n");
				return {
					message: `Initial local configuration capture failed: ${details}`,
					needsReload: false,
					ok: false,
					code: "blocked_conflict",
					level: "error",
				};
			}
			initialCapturedFiles = new Set(initialCapture.captured);
			capturedInitialLocalConfig =
				initialCapture.captured.length > 0 || initialCapture.deleted.length > 0;
			if (capturedInitialLocalConfig) {
				lines.push(
					`Captured ${initialCapture.captured.length} local config file(s) into the new repository.`,
				);
			}

			onProgress?.("Committing scaffold and local config...");
			await gitCommit(repoPath, "pi-sync: initial config scaffold (v2)");

			onProgress?.("Pushing to remote...");
			await gitRenameBranch(repoPath, scaffoldConfig.branch);
			try {
				const pushArgs = force
					? ["push", "--force", "origin", scaffoldConfig.branch]
					: ["push", "origin", scaffoldConfig.branch];
				if (force) {
					await gitExec(repoPath, pushArgs);
					await gitPushHeadToBranch(repoPath, await getDeviceBranchName());
				} else {
					await pushMainAndDeviceBranches(repoPath, scaffoldConfig.branch);
				}
				lines.push(
					`Scaffold committed and pushed to origin/${scaffoldConfig.branch} and the current-device branch.`,
				);
			} catch (err) {
				await updateState(agentDir, { repoPath });
				const detail = err instanceof Error ? err.message : "Unknown error";
				return {
					message:
						`${lines.join("\n")}\n\n` +
						"Scaffold committed locally but could not be pushed.\n" +
						"Resolve the remote issue, then run /pisync.\n" +
						`Details: ${detail}`,
					needsReload: false,
					ok: false,
					level: "warning",
				};
			}
			lines.push("");
		} else if (repoState === "invalid") {
			onProgress?.("Checking repository write access...");
			const writeAccess = await probeRepoWriteAccess(repoPath);
			const accessHint = getRepoWriteAccessHint(writeAccess);
			return {
				message:
					`The repository at ${gitUrl} has commits but is not a valid pi-sync config repo.\n` +
					"A pi-sync config repo must have a pi-sync.json at its root.\n" +
					accessHint +
					"Use an empty repository that you can write to for auto-scaffolding, or ensure the repository contains a valid pi-sync.json file.\n\n" +
					"Repair or replace the repository, then run /pisync again.",
				needsReload: false,
				ok: false,
				details: { reason: "invalid_config_repo", writeAccess },
				level: "error",
			};
		} else {
			onProgress?.("Fetching latest...");
			lines.push("Valid sync repo detected — fetching latest...");
			const existingConfig = await loadPiSyncConfig(repoPath);
			await gitFetch(repoPath, { timeout: existingConfig.pullTimeoutMs });
			await ensureConfiguredBranch(repoPath, existingConfig.branch);
			const { pulled } = await gitFastForward(repoPath, existingConfig.branch, {
				timeout: existingConfig.pullTimeoutMs,
			});
			lines.push(pulled ? "Updated to latest." : "Already up to date.");
		}

		onProgress?.("Saving state...");
		await updateState(agentDir, { repoPath });

		onProgress?.("Applying config to agent...");
		const config = await loadPiSyncConfig(repoPath);
		let state = await loadState(agentDir);
		if (initialCapturedFiles.size > 0) {
			const repositoryBaseline = await createRepositoryBaseline(
				repoPath,
				config,
				state,
			);
			state = {
				...state,
				files: Object.fromEntries(
					Object.entries(repositoryBaseline.files).filter(([relativePath]) =>
						initialCapturedFiles.has(relativePath),
					),
				),
			};
		}
		const applyResult = await applyCurrent(
			repoPath,
			config,
			state,
			"init",
			packageApproval,
		);
		lines.push(applyResult.message);

		if (!applyResult.ok) {
			return {
				message: lines.join("\n"),
				needsReload: false,
				ok: false,
				code: applyResult.code,
				details: applyResult.details,
				level: applyResult.code === "approval_required" ? "warning" : "error",
			};
		}

		lines.push("");
		lines.push("Setup complete! Your config is now synced.");
		lines.push("Use /pisync for day-to-day sync operations.");
		return {
			message: lines.join("\n"),
			needsReload: applyResult.reload || capturedInitialLocalConfig,
			ok: true,
			level: "info",
		};
	} catch (err) {
		return {
			message: `Init failed: ${err instanceof Error ? err.message : "Unknown error"}`,
			needsReload: false,
			ok: false,
			level: "error",
		};
	}
}

export function isValidSetupGitUrl(url: string): boolean {
	if (/^git@[\w.-]+:[\w./-]+(\.git)?$/.test(url)) return true;
	if (/^https?:\/\/[\w.-]+(:\d+)?\/[\w./-]+(\.git)?$/.test(url)) return true;
	if (/^ssh:\/\/git@[\w.-]+(:\d+)?\/[\w./-]+(\.git)?$/.test(url)) return true;
	if (/^git:\/\/[\w.-]+(:\d+)?\/[\w./-]+(\.git)?$/.test(url)) return true;
	return false;
}

async function detectRepoState(
	repoPath: string,
): Promise<"empty" | "valid" | "invalid"> {
	const probe = await gitProbe(repoPath, ["rev-list", "--count", "HEAD"]);
	if (!probe.ok || parseInt(probe.stdout.trim(), 10) === 0) return "empty";
	return existsSync(join(repoPath, "pi-sync.json")) ? "valid" : "invalid";
}

type RepoWriteAccess = "writable" | "denied" | "unknown";

function getRepoWriteAccessHint(writeAccess: RepoWriteAccess): string {
	switch (writeAccess) {
		case "denied":
			return (
				"The repository is readable, but the remote rejected a safe write-access check.\n" +
				"You may have selected someone else's repository or an account without push permission.\n"
			);
		case "writable":
			return "Write access is available, so this is most likely the wrong repository or an uninitialized non-empty repository.\n";
		default:
			return "Write access could not be verified. Check that the repository URL is correct and that your account can push to it.\n";
	}
}

/**
 * Ask the remote to validate a push without updating any refs. This separates a
 * readable public repository from one the current account can actually use for
 * pi-sync. Policy failures remain "unknown" to avoid misreporting them as an
 * authentication problem.
 */
async function probeRepoWriteAccess(
	repoPath: string,
): Promise<RepoWriteAccess> {
	const probe = await gitProbe(
		repoPath,
		[
			"push",
			"--dry-run",
			"--porcelain",
			"origin",
			"HEAD:refs/heads/pi-sync-write-access-check",
		],
		{ timeout: 30000 },
	);
	if (probe.ok) return "writable";

	const output = `${probe.stderr}\n${probe.stdout}`;
	return /access denied|permission denied|permission to .* denied|authentication failed|write access (?:to repository )?not granted|could not read from remote repository|repository not found|not authorized|not permitted|http[^\n]*403/i.test(
		output,
	)
		? "denied"
		: "unknown";
}

async function scaffoldConfigRepoV2(repoPath: string): Promise<void> {
	const { mkdir: makeDir, writeFile } = await import("node:fs/promises");
	for (const dir of [
		"sync",
		"sync/extensions",
		"sync/skills",
		"sync/prompts",
		"sync/themes",
	]) {
		await makeDir(join(repoPath, dir), { recursive: true });
	}
	const piSync = {
		schemaVersion: 2,
		branch: "main",
		root: "sync",
		include: [
			"settings.json",
			"AGENTS.md",
			"SYSTEM.md",
			"APPEND_SYSTEM.md",
			"keybindings.json",
			"extensions/**",
			"skills/**",
			"prompts/**",
			"themes/**",
		],
		exclude: [
			"**/.DS_Store",
			"**/*.tmp",
			"**/*.log",
			"extensions/**/.cache/**",
			"extensions/**/cache/**",
			"extensions/**/coverage/**",
			"extensions/**/logs/**",
			"extensions/**/temp/**",
			"extensions/**/tmp/**",
		],
		delete: "tracked",
		pullTimeoutMs: 10000,
		security: { scanSecretsBeforePush: true },
	};
	await writeFile(
		join(repoPath, "pi-sync.json"),
		JSON.stringify(piSync, null, 2),
		"utf-8",
	);
	await writeFile(
		join(repoPath, "sync", "settings.json"),
		JSON.stringify({ packages: ["npm:@jachy/pi-git-sync"] }, null, 2),
		"utf-8",
	);
	const readmePath = join(repoPath, "README.md");
	if (!existsSync(readmePath)) {
		await writeFile(
			readmePath,
			"# Pi 配置仓库 / Pi Configuration Repository\n\n此仓库用于在多台设备之间同步 Pi 配置。\nThis repository stores Pi configuration synchronized across your machines.\n\n由 [pi-git-sync](https://github.com/jachy-h/pi-git-sync) 创建和维护。\nCreated and maintained by [pi-git-sync](https://github.com/jachy-h/pi-git-sync).\n",
			"utf-8",
		);
	}
	await writeFile(
		join(repoPath, ".gitignore"),
		"# Local state\n.pi-sync/\n",
		"utf-8",
	);
}

function urlsMatch(a: string, b: string): boolean {
	const normalize = (url: string) =>
		url
			.replace(/^https?:\/\//, "")
			.replace(/^ssh:\/\/git@/, "")
			.replace(/^git@/, "")
			.replace(/\.git$/, "")
			.replace(/:\d+\//, "/")
			.toLowerCase();
	return normalize(a) === normalize(b);
}

export async function clearRepoContents(repoPath: string): Promise<void> {
	if (!existsSync(repoPath)) return;
	try {
		const { readdir, rm } = await import("node:fs/promises");
		const entries = await readdir(repoPath, { withFileTypes: true });
		for (const entry of entries) {
			if (entry.name === ".git") continue;
			try {
				await rm(join(repoPath, entry.name), { recursive: true, force: true });
			} catch {
				// Best-effort cleanup preserves the previous clear-repository behavior.
			}
		}
	} catch {
		// Best-effort cleanup preserves the previous clear-repository behavior.
	}
}
