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
 *   /pisync capture      - 导入本地配置到仓库
 *   /pisync doctor       - 诊断检查
 *   /pisync rollback     - 回滚到上一个备份
 */
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import { Container, type SelectItem, SelectList, Text } from "@earendil-works/pi-tui";
import { PiSyncCommands, getRepoPath, getRepoPathSafe, getAgentDir } from "./src/commands.ts";
import { loadState } from "./src/state.ts";
import { gitStatus } from "./src/git.ts";
import { existsSync } from "node:fs";

export default function (pi: ExtensionAPI) {
  const cmds = new PiSyncCommands();

  pi.on("session_start", (_event, ctx) => {
    ctx.ui.setStatus("pi-sync", undefined);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    ctx.ui.setStatus("pi-sync", undefined);
  });

  pi.registerCommand("pisync", {
    description: "Sync Pi configuration via Git repository (init|status|diff|pull|push|capture|doctor|rollback)",
    async handler(args, ctx) {
      const parts = args?.trim().split(/\s+/) ?? [];
      const subCommand = parts[0];
      const subArgs = parts.slice(1).join(" ");

      switch (subCommand) {
        case "init":
          await handleInit(cmds, subArgs || undefined, ctx);
          break;
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
        case "capture":
          await handleCapture(cmds, ctx);
          break;
        case "doctor":
          await handleDoctor(cmds, ctx);
          break;
        case "rollback":
          await handleRollback(cmds, ctx);
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

function classifyResult(output: string, operation: string): ClassifiedResult {
  const lower = output.toLowerCase();

  if (
    lower.includes("error:") || lower.includes("failed:") ||
    lower.includes("fatal:") || lower.includes("blocked") ||
    lower.includes("another sync operation is in progress") ||
    lower.includes("bilateral") || lower.includes("conflict")
  ) {
    const firstLine = output.split("\n")[0]!.trim();
    return { kind: "error", summary: `${operation} failed: ${firstLine}`, detail: output };
  }

  if (
    lower.includes("already up to date") ||
    lower.includes("no changes") ||
    lower.includes("up to date") ||
    lower.includes("nothing to")
  ) {
    return { kind: "warning", summary: `${operation}: no changes`, detail: output };
  }

  if (lower.includes("no config repo")) {
    return { kind: "warning", summary: "No config repo configured", detail: output };
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

function notifyResult(result: ClassifiedResult, ctx: ExtensionCommandContext): void {
  if (result.kind === "detail") {
    ctx.ui.notify(result.detail, "info");
  } else if (result.kind === "success") {
    ctx.ui.notify(result.summary, "info");
  } else if (result.kind === "warning") {
    ctx.ui.notify(result.summary, "warning");
  } else {
    ctx.ui.notify(result.summary, "error");
  }
}

// ========== TUI 菜单 ==========

async function showMenu(cmds: PiSyncCommands, ctx: ExtensionCommandContext): Promise<void> {
  const choice = await getMenuChoice(ctx);
  if (!choice) return;

  await executeMenuChoice(choice, cmds, ctx);
}

async function getMenuChoice(ctx: ExtensionCommandContext): Promise<string | null> {
  const menuOptions = [
    { value: "init", label: "Init" },
    { value: "status", label: "Status" },
    { value: "diff", label: "Diff" },
    { value: "pull", label: "Pull" },
    { value: "push", label: "Push" },
    { value: "capture", label: "Capture" },
    { value: "doctor", label: "Doctor" },
    { value: "rollback", label: "Rollback" },
  ];

  const summary = await getRepoSummary();

  if (ctx.mode === "tui") {
    return showTuiMenu(menuOptions, summary, ctx);
  }

  if (ctx.mode === "rpc") {
    return showRpcMenu(menuOptions, summary, ctx);
  }

  const lines = [
    `pi-git-sync${summary}`,
    "Available commands: /pisync init|status|diff|pull|push|capture|doctor|rollback",
  ];
  ctx.ui.notify(lines.join("\n"), "info");
  return null;
}

async function showTuiMenu(
  options: Array<{ value: string; label: string }>,
  summary: string,
  ctx: ExtensionCommandContext,
): Promise<string | null> {
  const items: SelectItem[] = options.map((opt) => {
    const descriptions: Record<string, string> = {
      init: "Initialize or clone a config repo",
      status: "Show detailed sync status",
      diff: "Show pending changes before sync",
      pull: "Pull and apply remote changes",
      push: "Commit and push local changes",
      capture: "Import local config into repo",
      doctor: "Run diagnostic checks",
      rollback: "Restore previous backup",
    };
    return { value: opt.value, label: opt.label, description: descriptions[opt.value] };
  });

  return ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
    const container = new Container();

    container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

    const title = `pi-git-sync${summary}`;
    container.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));
    container.addChild(new Text(theme.fg("dim", "Sync Pi configuration via Git (v2)"), 1, 0));

    const selectList = new SelectList(items, Math.min(items.length, 10), {
      selectedPrefix: (t: string) => theme.fg("accent", t),
      selectedText: (t: string) => theme.fg("accent", t),
      description: (t: string) => theme.fg("muted", t),
      scrollInfo: (t: string) => theme.fg("dim", t),
      noMatch: (t: string) => theme.fg("warning", t),
    });
    selectList.onSelect = (item) => done(item.value);
    selectList.onCancel = () => done(null);
    container.addChild(selectList);

    container.addChild(new Text(
      theme.fg("dim", "↑↓ navigate • enter select • esc cancel • or type /pisync <cmd>"),
      1,
      0,
    ));

    container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

    return {
      render: (w: number) => container.render(w),
      invalidate: () => container.invalidate(),
      handleInput: (data: string) => {
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

    const repoStatus = await gitStatus(rp);
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
    case "status": await handleStatus(cmds, ctx); return;
    case "diff": await handleDiff(cmds, ctx); return;
    case "pull": await handlePull(cmds, ctx); return;
    case "push": await handlePush(cmds, undefined, ctx); return;
    case "init": await handleInit(cmds, undefined, ctx); return;
    case "capture": await handleCapture(cmds, ctx); return;
    case "doctor": await handleDoctor(cmds, ctx); return;
    case "rollback": await handleRollback(cmds, ctx); return;
  }
}

// ========== 命令处理器 ==========

async function handleInit(
  cmds: PiSyncCommands,
  gitUrl: string | undefined,
  ctx: ExtensionCommandContext,
): Promise<void> {
  let url = gitUrl;

  if (!url) {
    ctx.ui.setWorkingMessage("Checking pi-sync status...");
    const result = await cmds.init();
    ctx.ui.setWorkingMessage();

    if (!result.message.includes("Enter your config repo Git URL")) {
      notifyInitResult(result, ctx);
      if (result.needsReload) await ctx.reload();
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

  ctx.ui.setWorkingMessage("Initializing pi-sync...");
  const initResult = await cmds.init(url);
  ctx.ui.setWorkingMessage();

  notifyInitResult(initResult, ctx);

  if (initResult.needsReload) {
    await ctx.reload();
  }
}

function notifyInitResult(
  result: { message: string; ok: boolean; level: "info" | "warning" | "error" },
  ctx: ExtensionCommandContext,
): void {
  ctx.ui.notify(result.message, result.level);
}

async function handleStatus(cmds: PiSyncCommands, ctx: ExtensionCommandContext): Promise<void> {
  const output = await cmds.status();
  ctx.ui.notify(output, "info");
}

async function handleDiff(cmds: PiSyncCommands, ctx: ExtensionCommandContext): Promise<void> {
  const output = await cmds.diff();
  ctx.ui.notify(output, "info");
}

async function handleDoctor(cmds: PiSyncCommands, ctx: ExtensionCommandContext): Promise<void> {
  const output = await cmds.doctor();
  ctx.ui.notify(output, "info");
}

// ========== push：两步交互（diff 确认 → 实际执行） ==========

async function handlePush(
  cmds: PiSyncCommands,
  subArgs: string | undefined,
  ctx: ExtensionCommandContext,
): Promise<void> {
  // push --continue：直接继续冲突解决
  if (subArgs === "--continue") {
    ctx.ui.setWorkingMessage("Continuing push...");
    const result = await cmds.push(undefined, undefined, "--continue");
    ctx.ui.setWorkingMessage();
    const classified = classifyResult(result.message, "Push");
    notifyResult(classified, ctx);
    if (result.reload) await ctx.reload();
    return;
  }

  // 第一步：capture + diff
  ctx.ui.setWorkingMessage("Checking changes...");

  // 先 capture 看看有什么变化
  const captureOutput = await cmds.capture();
  ctx.ui.setWorkingMessage();

  if (captureOutput.includes("blocked") || captureOutput.includes("No changes")) {
    // 被阻止或无变更，直接展示
    const lower = captureOutput.toLowerCase();
    if (lower.includes("no changes") || lower.includes("nothing to")) {
      ctx.ui.notify(captureOutput, "warning");
    } else {
      ctx.ui.notify(captureOutput, "error");
    }
    return;
  }

  // 展示已捕获的内容 + 请求确认
  ctx.ui.notify(captureOutput, "info");

  // 展示 diff
  ctx.ui.setWorkingMessage("Generating diff...");
  const diffOutput = await cmds.diff();
  ctx.ui.setWorkingMessage();

  // 提取 Git diff 部分展示（如果有）
  ctx.ui.notify(diffOutput, "info");

  // 确认
  const confirmed = await ctx.ui.confirm(
    "pi-sync: Confirm push",
    "Push these changes to the remote repository?",
  );

  if (!confirmed) {
    ctx.ui.notify("Push cancelled.", "warning");
    return;
  }

  // 第二步：执行实际 push
  ctx.ui.setWorkingMessage("Pushing...");
  const result = await cmds.push(undefined, subArgs);
  ctx.ui.setWorkingMessage();

  const classified = classifyResult(result.message, "Push");
  notifyResult(classified, ctx);

  if (result.reload) {
    await ctx.reload();
  }
}

// ========== capture ==========

async function handleCapture(cmds: PiSyncCommands, ctx: ExtensionCommandContext): Promise<void> {
  ctx.ui.setWorkingMessage("Capturing...");
  const output = await cmds.capture();
  ctx.ui.setWorkingMessage();

  const result = classifyResult(output, "Capture");
  notifyResult(result, ctx);
}

// ========== pull ==========

async function handlePull(cmds: PiSyncCommands, ctx: ExtensionCommandContext): Promise<void> {
  ctx.ui.setWorkingMessage("Checking remote...");
  const result = await cmds.pull();
  ctx.ui.setWorkingMessage();

  if (result.message.includes("Already up to date") || result.message.includes("No changes")) {
    ctx.ui.notify(result.message, "warning");
    return;
  }

  if (result.message.includes("blocked") || result.message.includes("failed") ||
      result.message.includes("Local changes detected")) {
    ctx.ui.notify(result.message, "error");
    return;
  }

  // 展示结果
  ctx.ui.notify(result.message, "info");

  if (result.reload) {
    await ctx.reload();
  }
}

// ========== rollback ==========

async function handleRollback(cmds: PiSyncCommands, ctx: ExtensionCommandContext): Promise<void> {
  const output = await cmds.rollback();

  if (output.includes("No backups")) {
    ctx.ui.notify("No backups available.", "warning");
    return;
  }

  // 展示备份信息
  ctx.ui.notify(output, "info");

  const confirmed = await ctx.ui.confirm(
    "pi-sync: Confirm rollback",
    "Rollback to the previous backup? Current state will be backed up first.",
  );

  if (!confirmed) {
    ctx.ui.notify("Rollback cancelled.", "warning");
    return;
  }

  // rollback 已经在 cmds.rollback() 中完成
  const result = classifyResult(output, "Rollback");
  notifyResult(result, ctx);
  await ctx.reload();
}
