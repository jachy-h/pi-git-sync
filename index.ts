/**
 * pi-git-sync Extension (v2)
 *
 * 通过 Git 私有仓库在多台机器之间同步 Pi 配置。
 *
 * v2 核心变化：
 * - schema v2 manifest（root + include/exclude glob，取代 files[] 映射）
 * - 配置仓库不再作为 Pi Package 安装
 * - settings.json 整文件共享，不做 managed-key merge
 * - 基于同步基线的三方比较
 * - 完整 push 链：capture → commit → fetch → rebase → push → apply
 * - push --continue 冲突处理
 *
 * 命令：
 *   /pisync              - TUI 操作菜单
 *   /pisync init [url]   - 初始化配置仓库
 *   /pisync status       - 显示详情状态
 *   /pisync diff         - 显示差异
 *   /pisync pull         - 从远端拉取并应用
 *   /pisync push         - 捕获、提交并推送
 */
import type {
	ExtensionAPI,
	ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import {
	Container,
	Input,
	type SelectItem,
	SelectList,
	Text,
} from "@earendil-works/pi-tui";
import {
	PiSyncCommands,
	getRepoPathSafe,
	getAgentDir,
} from "./src/commands.ts";
import { gitStatus } from "./src/git.ts";
import { loadPiSyncConfig } from "./src/config.ts";

const pisyncSubcommands: SelectItem[] = [
	{
		value: "init",
		label: "init",
		description: "Initialize or clone a config repo",
	},
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
	{
		value: "pull",
		label: "pull",
		description: "Pull and apply remote changes",
	},
	{
		value: "push",
		label: "push",
		description: "Commit and push local changes",
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
		description:
			"Sync Pi configuration via Git repository (init|status|diff|pull|push)",
		getArgumentCompletions: getPiSyncArgumentCompletions,
		async handler(args, ctx) {
			const parts = args?.trim().split(/\s+/) ?? [];
			const subCommand = parts[0];
			const subArgs = parts.slice(1).join(" ");

			switch (subCommand) {
				case "init": {
					const initArgs = parts.slice(1);
					const force = initArgs.includes("--force");
					const initUrl = initArgs
						.filter((a) => a !== "--force")
						.join(" ")
						.trim();
					await handleInit(cmds, initUrl || undefined, ctx, force);
					break;
				}
				case "status":
					await handleStatus(cmds, ctx);
					break;
				case "diff":
					await handleDiff(cmds, ctx);
					break;
				case "pull":
					await handlePull(cmds, ctx);
					break;
				case "push":
					await handlePush(cmds, subArgs || undefined, ctx);
					break;
				default:
					await showMenu(cmds, ctx);
					break;
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

// ========== TUI 菜单 ==========

async function showMenu(
	cmds: PiSyncCommands,
	ctx: ExtensionCommandContext,
): Promise<void> {
	const choice = await getMenuChoice(ctx);
	if (!choice) return;

	await executeMenuChoice(choice, cmds, ctx);
}

async function getMenuChoice(
	ctx: ExtensionCommandContext,
): Promise<string | null> {
	const menuOptions = pisyncSubcommands.map((command) => ({
		...command,
		label: command.label.charAt(0).toUpperCase() + command.label.slice(1),
	}));

	const summary = await getRepoSummary();

	if (ctx.mode === "tui") {
		return showTuiMenu(menuOptions, summary, ctx);
	}

	if (ctx.mode === "rpc") {
		return showRpcMenu(menuOptions, summary, ctx);
	}

	const lines = [
		`pi-git-sync${summary}`,
		"Available commands: /pisync init|status|diff|pull|push",
	];
	ctx.ui.notify(lines.join("\n"), "info");
	return null;
}

async function showTuiMenu(
	options: Array<{ value: string; label: string }>,
	summary: string,
	ctx: ExtensionCommandContext,
): Promise<string | null> {
	const items: SelectItem[] = options.map((opt) => ({
		...opt,
		description: pisyncSubcommands.find(
			(command) => command.value === opt.value,
		)?.description,
	}));

	return ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
		const container = new Container();

		container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

		const title = `pi-git-sync${summary}`;
		container.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));
		container.addChild(
			new Text(theme.fg("dim", "Sync Pi configuration via Git (v2)"), 1, 0),
		);

		const selectList = new SelectList(items, Math.min(items.length, 10), {
			selectedPrefix: (t: string) => theme.fg("accent", t),
			selectedText: (t: string) => theme.fg("accent", t),
			description: (t: string) => theme.fg("muted", t),
			scrollInfo: (t: string) => theme.fg("dim", t),
			noMatch: (t: string) => theme.fg("warning", t),
		});
		selectList.onSelect = (item) => done(item.value);
		selectList.onCancel = () => done(null);

		const filterInput = new Input();
		container.addChild(new Text(theme.fg("dim", "Filter commands:"), 1, 0));
		container.addChild(filterInput);
		container.addChild(selectList);

		container.addChild(
			new Text(
				theme.fg(
					"dim",
					"Type to filter • ↑↓ navigate • enter select • esc cancel",
				),
				1,
				0,
			),
		);

		container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

		return {
			render: (w: number) => container.render(w),
			invalidate: () => container.invalidate(),
			handleInput: (data: string) => {
				const previousFilter = filterInput.getValue();
				filterInput.handleInput(data);
				if (filterInput.getValue() !== previousFilter) {
					selectList.setFilter(filterInput.getValue());
				}
				selectList.handleInput(data);
				tui.requestRender();
			},
		};
	});
}

async function showRpcMenu(
	options: Array<{ value: string; label: string }>,
	summary: string,
	ctx: ExtensionCommandContext,
): Promise<string | null> {
	const result = await ctx.ui.select(
		`pi-git-sync${summary}`,
		options.map((opt) => opt.value),
	);
	return result ?? null;
}

async function getRepoSummary(): Promise<string> {
	try {
		const rp = await getRepoPathSafe(getAgentDir());
		if (!rp) return "";

		const config = await loadPiSyncConfig(rp);
		const repoStatus = await gitStatus(rp, config.branch);
		let s = ` [${repoStatus.commitShort}`;
		if (repoStatus.remoteExists && repoStatus.behind > 0) {
			s += ` ↓${repoStatus.behind}`;
		}
		if (repoStatus.ahead > 0) {
			s += ` ↑${repoStatus.ahead}`;
		}
		if (repoStatus.hasUncommittedChanges) {
			s += " •";
		}
		if (repoStatus.hasConflicts) {
			s += " !";
		}
		s += "]";
		return s;
	} catch {
		return "";
	}
}

async function executeMenuChoice(
	choice: string,
	cmds: PiSyncCommands,
	ctx: ExtensionCommandContext,
): Promise<void> {
	switch (choice) {
		case "status":
			await handleStatus(cmds, ctx);
			return;
		case "diff":
			await handleDiff(cmds, ctx);
			return;
		case "pull":
			await handlePull(cmds, ctx);
			return;
		case "push":
			await handlePush(cmds, undefined, ctx);
			return;
		case "init":
			await handleInit(cmds, undefined, ctx, false);
			return;
	}
}

// ========== 命令处理器 ==========

async function handleInit(
	cmds: PiSyncCommands,
	gitUrl: string | undefined,
	ctx: ExtensionCommandContext,
	force = false,
): Promise<void> {
	let url = gitUrl;

	if (!url) {
		ctx.ui.setStatus(
			"pi-sync",
			ctx.ui.theme.fg("text", "Checking pi-sync status..."),
		);
		let result = await cmds.init(
			undefined,
			(msg) => {
				ctx.ui.setStatus("pi-sync", ctx.ui.theme.fg("text", msg));
			},
			force,
		);
		ctx.ui.setStatus("pi-sync", undefined);

		if (result.code === "approval_required") {
			const approval = await requestPackageApproval(result, ctx);
			if (!approval.approved) {
				ctx.ui.notify("Package installation cancelled.", "warning");
				return;
			}
			result = await cmds.init(undefined, undefined, force, approval);
		}

		const details = result.details as { needsGitUrl?: boolean } | undefined;
		if (!details?.needsGitUrl) {
			notifyOperationResult(result, ctx);
			if (result.reload) await ctx.reload();
			return;
		}

		url = await ctx.ui.input(
			"Enter your config repo Git URL:",
			"git@github.com:you/pi-config.git",
		);

		if (!url) {
			ctx.ui.notify("Init cancelled.", "warning");
			return;
		}
	}

	ctx.ui.setStatus("pi-sync", ctx.ui.theme.fg("text", "Initializing..."));
	let initResult = await cmds.init(
		url,
		(msg) => {
			ctx.ui.setStatus("pi-sync", ctx.ui.theme.fg("text", msg));
		},
		force,
	);
	ctx.ui.setStatus("pi-sync", undefined);

	if (initResult.code === "approval_required") {
		const approval = await requestPackageApproval(initResult, ctx);
		if (!approval.approved) {
			ctx.ui.notify("Package installation cancelled.", "warning");
			return;
		}
		initResult = await cmds.init(url, undefined, force, approval);
	}

	notifyOperationResult(initResult, ctx);

	if (initResult.reload) {
		await ctx.reload();
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

// ========== push：准备、展示变更并立即执行 ==========

async function handlePush(
	cmds: PiSyncCommands,
	subArgs: string | undefined,
	ctx: ExtensionCommandContext,
): Promise<void> {
	// push --continue：直接继续冲突解决
	if (subArgs === "--continue") {
		ctx.ui.setStatus("pi-sync", ctx.ui.theme.fg("text", "Continuing push..."));
		const result = await cmds.push(undefined, undefined, "--continue");
		ctx.ui.setStatus("pi-sync", undefined);
		notifyOperationResult(result, ctx);
		if (result.reload) await ctx.reload();
		return;
	}

	// 第一步：结构化准备，不依赖人类可读文案决定控制流
	ctx.ui.setStatus("pi-sync", ctx.ui.theme.fg("text", "Checking changes..."));
	const preparation = await cmds.preparePush();
	ctx.ui.setStatus("pi-sync", undefined);

	if (preparation.kind === "noop") {
		notifyOperationResult(
			{
				message: preparation.message ?? "No changes to push.",
				ok: true,
				code: "noop",
			},
			ctx,
		);
		return;
	}
	if (preparation.kind === "blocked") {
		notifyOperationResult(
			{
				message: preparation.message ?? "Push blocked.",
				ok: false,
				code: "blocked",
			},
			ctx,
		);
		return;
	}

	ctx.ui.notify(
		ctx.ui.theme.fg(
			"text",
			`${preparation.message ?? "Push ready."}\n` +
				`Captured: ${preparation.capture.captured.length}, deleted: ${preparation.capture.deleted.length}`,
		),
		"info",
	);

	ctx.ui.setStatus("pi-sync", ctx.ui.theme.fg("text", "Pushing..."));
	const result = await cmds.executePush(preparation);
	ctx.ui.setStatus("pi-sync", undefined);

	notifyOperationResult(result, ctx);
	if (result.reload) await ctx.reload();
}

// ========== capture ==========

// ========== pull ==========

async function handlePull(
	cmds: PiSyncCommands,
	ctx: ExtensionCommandContext,
): Promise<void> {
	ctx.ui.setStatus("pi-sync", ctx.ui.theme.fg("text", "Checking remote..."));
	let result = await cmds.pull();
	ctx.ui.setStatus("pi-sync", undefined);

	if (result.code === "approval_required") {
		const approval = await requestPackageApproval(result, ctx);
		if (!approval.approved) {
			ctx.ui.notify("Package installation cancelled.", "warning");
			return;
		}
		ctx.ui.setStatus(
			"pi-sync",
			ctx.ui.theme.fg("text", "Applying approved packages..."),
		);
		result = await cmds.pull(undefined, approval);
		ctx.ui.setStatus("pi-sync", undefined);
	}

	notifyOperationResult(result, ctx);

	if (result.reload) {
		await ctx.reload();
	}
}
