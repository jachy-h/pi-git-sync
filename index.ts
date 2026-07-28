/**
 * pi-git-sync Extension (v3)
 *
 * 通过 Git 私有仓库在多台机器之间同步 Pi 配置。
 *
 * v2 核心变化：
 * - schema v2 manifest（root + include/exclude glob，取代 files[] 映射）
 * - 配置仓库不再作为 Pi Package 安装
 * - settings.json 整文件共享，不做 managed-key merge
 * - 基于同步基线的三方比较
 * - 完整 push 链：capture → commit → fetch → rebase → push → apply
 * - 统一 run() 编排 setup/recovery/pull/push
 *
 * 命令：
 *   /pisync              - 初始化或执行双向同步
 *   /pisync status       - 显示详情状态
 *   /pisync diff         - 显示差异
 */
import type {
	ExtensionAPI,
	ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { matchesKey, type SelectItem } from "@earendil-works/pi-tui";
import { PiSyncCommands } from "./src/commands.ts";
import type { RunOptions, RunResult } from "./src/operation-result.ts";

const COMMAND_SETTLE_GRACE_MS = 100;
const ELAPSED_REFRESH_MS = 1000;
const USER_CANCELLATION_NOTICE_DELAY_MS = 1_000;
const PISYNC_RUN_TIMEOUT_MS = 60_000;

function formatElapsed(elapsedMs: number): string {
	const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = totalSeconds % 60;
	return hours > 0
		? `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
		: `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

const pisyncSubcommands: SelectItem[] = [
	{
		value: "status",
		label: "status",
		description: "Show detailed sync status",
	},
	{
		value: "diff",
		label: "diff",
		description: "Show pending changes before sync",
	},
];

function getPiSyncArgumentCompletions(prefix: string): SelectItem[] | null {
	if (/\s/.test(prefix)) return null;

	const query = prefix.toLowerCase();
	const matches = pisyncSubcommands.filter((command) =>
		command.value.toLowerCase().includes(query),
	);
	return matches.length > 0 ? matches : null;
}

export default function (pi: ExtensionAPI) {
	const cmds = new PiSyncCommands();

	pi.on("session_start", (_event, ctx) => {
		ctx.ui.setStatus("pi-sync", undefined);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		ctx.ui.setStatus("pi-sync", undefined);
	});

	pi.registerCommand("debug:clear-repo", {
		description:
			"[DEBUG] Clear local and remote sync repo contents — for testing only",
		async handler(_args, ctx) {
			const confirmed = await ctx.ui.confirm(
				"⚠ DEBUG: Clear Sync Repo",
				"This will DELETE ALL contents from both local and remote sync repos.\nThis action cannot be undone. Continue?",
			);
			if (!confirmed) {
				ctx.ui.notify("Cancelled.", "warning");
				return;
			}

			ctx.ui.setStatus("pi-sync", ctx.ui.theme.fg("text", "Clearing repo..."));
			const result = await cmds.clearRepo();
			ctx.ui.setStatus("pi-sync", undefined);

			ctx.ui.notify(
				result.message,
				result.message.includes("successfully") ? "info" : "error",
			);

			if (result.reload) await ctx.reload();
		},
	});

	pi.registerCommand("pisync", {
		description: "Set up or sync Pi configuration via Git",
		getArgumentCompletions: getPiSyncArgumentCompletions,
		async handler(args, ctx) {
			switch (args?.trim()) {
				case "":
				case undefined:
					await handlePiSync(cmds, ctx);
					break;
				case "status":
					await handleStatus(cmds, ctx);
					break;
				case "diff":
					await handleDiff(cmds, ctx);
					break;
				default:
					ctx.ui.notify(
						"This command was removed in v0.3. Run /pisync to set up or sync.",
						"warning",
					);
			}
		},
	});
}

// ========== 结果类型 ==========

type ResultKind = "success" | "warning" | "error" | "detail";

interface ClassifiedResult {
	kind: ResultKind;
	summary: string;
	detail: string;
}

/** A UI-agnostic notification payload for completed sync operations. */
interface OperationNotification {
	message: string;
	level: "info" | "warning" | "error";
}

interface OperationNotificationSource {
	message: string;
	ok?: boolean;
	code?: string;
	level?: OperationNotification["level"];
}

function createOperationNotification(
	result: OperationNotificationSource,
): OperationNotification {
	const message = result.message.startsWith("pi-git-sync: ")
		? result.message
		: `pi-git-sync: ${result.message}`;
	if (result.level) return { message, level: result.level };
	if (typeof result.ok === "boolean") {
		return { message, level: result.ok ? "info" : "error" };
	}
	const classified = classifyResult(result.message, "Operation");
	return {
		message,
		level: classified.kind === "error" ? "error" : "info",
	};
}

function notifyOperationResult(
	result: OperationNotificationSource,
	ctx: ExtensionCommandContext,
): void {
	if (isManualMergeMessage(result.message)) {
		notifyManualMergeMessage(result.message, ctx);
		return;
	}
	const notification = createOperationNotification(result);
	const color = notification.level === "info" ? "accent" : notification.level;
	ctx.ui.notify(
		ctx.ui.theme.fg(color, `◆ ${notification.message}`),
		notification.level,
	);
}

function classifyResult(output: string, operation: string): ClassifiedResult {
	const lower = output.toLowerCase();

	if (
		lower.includes("error:") ||
		lower.includes("failed:") ||
		lower.includes("fatal:") ||
		lower.includes("blocked") ||
		lower.includes("another sync operation is in progress") ||
		lower.includes("bilateral") ||
		lower.includes("conflict")
	) {
		const firstLine = output.split("\n")[0]!.trim();
		return {
			kind: "error",
			summary: firstLine,
			detail: output,
		};
	}

	if (
		lower.includes("already up to date") ||
		lower.includes("no changes") ||
		lower.includes("up to date") ||
		lower.includes("nothing to")
	) {
		return {
			kind: "warning",
			summary: `${operation}: no changes`,
			detail: output,
		};
	}

	if (lower.includes("no config repo")) {
		return {
			kind: "warning",
			summary: "No config repo configured",
			detail: output,
		};
	}

	const successPatterns = [
		"pushed successfully",
		"pulled and applied",
		"rolled back",
		"capture complete",
		"setup complete",
		"already initialized",
		"scaffold pushed",
		"scaffold committed",
		"backup created",
		"applied successfully",
		"push continued successfully",
	];

	for (const pattern of successPatterns) {
		if (lower.includes(pattern)) {
			return { kind: "success", summary: `${operation}: done`, detail: output };
		}
	}

	return { kind: "detail", summary: "", detail: output };
}

// ========== 命令处理器 ==========

async function handlePiSync(
	cmds: PiSyncCommands,
	ctx: ExtensionCommandContext,
): Promise<void> {
	let gitUrl: string | undefined;
	let packageApproval: RunOptions["packageApproval"];

	const run = async (options: RunOptions = {}): Promise<RunResult | null> => {
		const startedAt = Date.now();
		let currentMessage = "Checking sync state...";
		const controller = new AbortController();
		let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
		let runDeadlineTimer: ReturnType<typeof setTimeout> | undefined;
		let elapsedTimer: ReturnType<typeof setInterval> | undefined;
		let removeTerminalInputListener: (() => void) | undefined;
		let watchdogResolve: ((result: RunResult) => void) | undefined;
		let cancellationResolve: ((result: RunResult) => void) | undefined;
		let cancellationNotification: Promise<void> | undefined;
		let lastPublishedProgress: string | undefined;
		let watchdogFired = false;
		let cancelled = false;
		let currentPhase: RunResult["phase"] = "preflight";
		let commandExecution: Promise<RunResult> | undefined;
		let execution: Promise<RunResult> | undefined;
		const watchdog = new Promise<RunResult>((resolve) => {
			watchdogResolve = resolve;
		});
		const cancellation = new Promise<RunResult>((resolve) => {
			cancellationResolve = resolve;
		});
		const elapsed = () => formatElapsed(Date.now() - startedAt);
		const renderProgress = () =>
			ctx.ui.theme.fg(
				"text",
				`pi-sync [${elapsed()}] ${currentMessage}${ctx.mode === "tui" ? " — Esc to cancel" : ""}`,
			);
		// Pi notifications append to the conversation flow. There is no public API
		// for replacing an existing conversation entry, so publish the active phase
		// and its elapsed time once per second while sync is in progress.
		const publishProgress = () => {
			if (controller.signal.aborted) return;
			const progress = renderProgress();
			if (progress === lastPublishedProgress) return;
			lastPublishedProgress = progress;
			ctx.ui.notify(progress, "info");
		};
		const clearDeadline = () => {
			if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
			deadlineTimer = undefined;
		};
		const stopForTimeout = (result: RunResult) => {
			if (watchdogFired) return;
			watchdogFired = true;
			watchdogResolve?.(result);
			controller.abort();
		};
		const cancel = () => {
			if (controller.signal.aborted) return;
			cancelled = true;
			ctx.ui.notify("pi-sync: Stopping...", "info");
			cancellationNotification = new Promise<void>((resolve) =>
				setTimeout(resolve, USER_CANCELLATION_NOTICE_DELAY_MS),
			).then(() => {
				ctx.ui.notify("pi-sync: Cancelled by user.", "warning");
			});
			cancellationResolve?.({
				ok: false,
				code: "partial_failure",
				message: "pi-sync cancelled.",
				reload: false,
				mode: "sync",
				phase: currentPhase,
			});
			controller.abort();
		};
		const startExecution = () => {
			if (execution) return execution;
			runDeadlineTimer = setTimeout(() => {
				stopForTimeout({
					ok: false,
					code: "partial_failure",
					message: `pi-sync exceeded ${PISYNC_RUN_TIMEOUT_MS / 1000} seconds and was stopped during ${currentPhase}.`,
					reload: false,
					mode: "sync",
					phase: currentPhase,
				});
			}, PISYNC_RUN_TIMEOUT_MS);
			commandExecution = cmds.run({
				...options,
				signal: controller.signal,
				onProgress: (phase, message) => {
					if (controller.signal.aborted) return;
					clearDeadline();
					currentPhase = phase;
					currentMessage = message;
					publishProgress();
				},
				onGitCommandStart: (phase, command, timeoutMs) => {
					if (controller.signal.aborted) return;
					clearDeadline();
					currentPhase = phase;
					currentMessage = `Running: ${command} (timeout: ${Math.ceil(timeoutMs / 1000)}s)...`;
					publishProgress();
					deadlineTimer = setTimeout(() => {
						// Resolve the UI command first, then abort the lower-level process.
						// Even if child-process cleanup itself is broken, Pi regains input.
						stopForTimeout({
							ok: false,
							code: "git_failed",
							message: `${command} timed out after ${timeoutMs} ms. Sync stopped.`,
							reload: false,
							mode: "sync",
							phase,
						});
					}, timeoutMs + COMMAND_SETTLE_GRACE_MS);
				},
			});
			execution = Promise.race([commandExecution, watchdog, cancellation]);
			return execution;
		};
		const awaitExecution = async () => {
			const result = await startExecution();
			if ((watchdogFired || cancelled) && commandExecution) {
				// Give the aborted command a short chance to release its sync lock,
				// without ever retaining the TUI indefinitely.
				await Promise.race([
					commandExecution.then(
						() => undefined,
						() => undefined,
					),
					new Promise<void>((resolve) =>
						setTimeout(resolve, COMMAND_SETTLE_GRACE_MS),
					),
				]);
			}
			return result;
		};

		publishProgress();
		elapsedTimer = setInterval(publishProgress, ELAPSED_REFRESH_MS);
		if (ctx.mode === "tui") {
			removeTerminalInputListener = ctx.ui.onTerminalInput((data) => {
				if (!matchesKey(data, "escape") || controller.signal.aborted) return;
				cancel();
				return { consume: true };
			});
		}
		try {
			const result = await awaitExecution();
			if (!controller.signal.aborted || watchdogFired) return result;

			if (commandExecution) {
				await Promise.race([
					commandExecution.then(
						() => undefined,
						() => undefined,
					),
					new Promise<void>((resolve) =>
						setTimeout(resolve, COMMAND_SETTLE_GRACE_MS),
					),
				]);
			}
			await cancellationNotification;
			return null;
		} catch (error) {
			if (!controller.signal.aborted) throw error;
			await cancellationNotification;
			return null;
		} finally {
			clearDeadline();
			if (runDeadlineTimer !== undefined) clearTimeout(runDeadlineTimer);
			if (elapsedTimer !== undefined) clearInterval(elapsedTimer);
			removeTerminalInputListener?.();
			controller.abort();
		}
	};

	let result = await run();
	if (result === null) return;
	const details = result.details;
	if (details?.needsGitUrl) {
		gitUrl = await ctx.ui.input(
			"Enter your config repo Git URL:",
			"git@github.com:you/pi-config.git",
		);
		if (!gitUrl) {
			ctx.ui.notify("Setup cancelled.", "warning");
			return;
		}
		result = await run({ gitUrl });
		if (result === null) return;
	}

	if (result.code === "approval_required") {
		const approval = await requestPackageApproval(result, ctx);
		if (!approval.approved) {
			ctx.ui.notify("Package installation cancelled.", "warning");
			return;
		}
		packageApproval = {
			approvedSources: approval.approvedSources,
			remember: approval.remember,
		};
		result = await run({ gitUrl, packageApproval });
		if (result === null) return;
	}

	notifyOperationResult(result, ctx);
	if (result.reload) {
		const shouldReload = await ctx.ui.confirm(
			"Reload Pi?",
			"Synchronization updated your configuration. Reload Pi now to apply the changes?",
		);
		if (shouldReload) await ctx.reload();
	}
}

async function requestPackageApproval(
	result: { details?: unknown },
	ctx: ExtensionCommandContext,
): Promise<{
	approved: boolean;
	approvedSources: string[];
	remember: boolean;
}> {
	const details = result.details as { packages?: unknown } | undefined;
	const packages = Array.isArray(details?.packages)
		? details.packages.filter((pkg): pkg is string => typeof pkg === "string")
		: [];
	const approved = await ctx.ui.confirm(
		"pi-sync: Approve package installation",
		packages.length > 0
			? `The synced settings request these packages:\n\n${packages.join("\n")}\n\nInstall them?`
			: "The synced settings request package changes. Install them?",
	);
	return {
		approved,
		approvedSources: approved ? packages : [],
		remember: false,
	};
}

const MANUAL_MERGE_HEADING =
	"Merge the current-device branch into the shared branch:";

function isManualMergeMessage(message: string): boolean {
	return message.includes(MANUAL_MERGE_HEADING);
}

function formatManualMergeMessageForDisplay(
	message: string,
	theme: { fg(role: string, text: string): string },
): string {
	let inActionSection = false;

	return message
		.split("\n")
		.map((line) => {
			if (line === MANUAL_MERGE_HEADING) inActionSection = true;
			if (line === "") return line;
			return theme.fg(inActionSection ? "accent" : "text", line);
		})
		.join("\n");
}

function notifyManualMergeMessage(
	message: string,
	ctx: ExtensionCommandContext,
): void {
	// This is a recoverable state, not an extension error. Use an info
	// notification so Pi does not prepend "Error:", while retaining the
	// normal log in the text colour and highlighting the required next steps.
	ctx.ui.notify(
		formatManualMergeMessageForDisplay(message, ctx.ui.theme),
		"info",
	);
}

async function handleStatus(
	cmds: PiSyncCommands,
	ctx: ExtensionCommandContext,
): Promise<void> {
	const output = await cmds.status();
	// Notifications are appended to Pi's text flow without taking focus, so the
	// user can read the status while continuing to type in the input editor.
	ctx.ui.notify(output, "info");
}

async function handleDiff(
	cmds: PiSyncCommands,
	ctx: ExtensionCommandContext,
): Promise<void> {
	const output = await cmds.diff();
	await showOutput(ctx, output);
}

// ========== 通用纯文本输出（text 颜色） ==========

async function showOutput(
	ctx: ExtensionCommandContext,
	text: string,
): Promise<void> {
	await ctx.ui.custom<void>((_tui, theme, _kb, done) => {
		const lines = text.split("\n");
		return {
			render: (_w: number) => lines.map((l) => theme.fg("text", l)),
			invalidate: () => {},
			handleInput: () => done(),
		};
	});
}
