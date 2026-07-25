/**
 * pi-git-sync Extension
 *
 * 通过 GitHub Private Repository 在多台机器之间同步 Pi 的配置。
 *
 * 命令：
 *   /pisync          - TUI 操作菜单
 *   /pisync init     - 初始化或克隆配置仓库
 *   /pisync status   - 显示详情状态
 *   /pisync diff     - 显示差异
 *   /pisync pull     - 从远端拉取
 *   /pisync push     - 推送到远端
 *   /pisync apply    - 应用当前仓库版本
 *   /pisync capture  - 导入本地配置到仓库
 *   /pisync doctor   - 诊断检查
 *   /pisync rollback - 回滚到上一个备份
 */
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import { Container, type SelectItem, SelectList, Text } from "@earendil-works/pi-tui";
import { PiSyncCommands, getRepoPath, getRepoPathSafe, getAgentDir } from "./src/commands.ts";
import { loadState } from "./src/state.ts";
import { gitStatus } from "./src/git.ts";
import { loadPiSyncConfig } from "./src/config.ts";
import { existsSync } from "node:fs";

export default function (pi: ExtensionAPI) {
  const cmds = new PiSyncCommands();

  // pi-sync 不常驻显示状态；清理旧版本可能留下的状态项。
  pi.on("session_start", (_event, ctx) => {
    ctx.ui.setStatus("pi-sync", undefined);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    ctx.ui.setStatus("pi-sync", undefined);
  });

  // /pisync - TUI 操作菜单（或子命令）
  pi.registerCommand("pisync", {
    description: "Sync Pi configuration via Git repository (init|status|diff|pull|push|capture|doctor|rollback)",
    async handler(args, ctx) {
      const parts = args?.trim().split(/\s+/);
      const subCommand = parts?.[0];
      const subArgs = parts?.slice(1).join(" ");

      switch (subCommand) {
        case "init":
          await handleInit(cmds, subArgs, ctx);
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
          await handlePush(cmds, subArgs, ctx);
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
        case "rollback-list":
          await handleRollbackList(cmds, ctx);
          break;
        default: {
          // 无子命令时显示 TUI 操作菜单
          await showMenu(cmds, ctx);
          break;
        }
      }

    },
  });
}

// ========== 结果分类 ==========

type ResultKind = "success" | "warning" | "error" | "detail";

interface ClassifiedResult {
  kind: ResultKind;
  /** 一行摘要，用于 notify + 状态栏（detail 类型不需要 notify） */
  summary: string;
  /** 完整详情，detail 类型时直接 notify 展示 */
  detail: string;
}

/**
 * 根据命令输出内容判断结果类型
 */
function classifyResult(output: string, operation: string): ClassifiedResult {
  const lower = output.toLowerCase();

  // 错误
  if (
    lower.includes("error:") || lower.includes("failed:") ||
    lower.includes("fatal:") || lower.includes("blocked") ||
    lower.includes("another sync operation is in progress")
  ) {
    // 提取第一行作为简短摘要
    const firstLine = output.split("\n")[0]!.trim();
    return { kind: "error", summary: `${operation} failed: ${firstLine}`, detail: output };
  }

  // 警告（无变化 / 已是最新 / 被取消）
  if (
    lower.includes("already up to date") ||
    lower.includes("no changes") ||
    lower.includes("up to date") ||
    lower.includes("cancelled") ||
    lower.includes("nothing to")
  ) {
    return { kind: "warning", summary: `${operation}: no changes`, detail: output };
  }

  // 无仓库配置
  if (lower.includes("no config repo")) {
    return { kind: "warning", summary: "No config repo configured", detail: output };
  }

  // 成功
  const successPatterns: Record<string, string> = {
    "pushed successfully": `${operation}: pushed`,
    "pulled and applied": `${operation}: synced`,
    "rolled back": `${operation}: restored`,
    "capture complete": `${operation}: done`,
    "setup complete": `${operation}: ready`,
    "already initialized": `${operation}: applied`,
    "scaffold pushed": `${operation}: ready`,
    "scaffold committed": `${operation}: ready (not pushed)`,
    "backup created": `${operation}: applied`,
    "applied successfully": `${operation}: applied`,
  };

  for (const [pattern, summary] of Object.entries(successPatterns)) {
    if (lower.includes(pattern)) {
      return { kind: "success", summary, detail: output };
    }
  }

  // 默认：详情类（status / diff / doctor 等纯信息展示）
  return { kind: "detail", summary: "", detail: output };
}

/**
 * 统一通知：根据分类结果选择提示方式
 * - success: notify("info") 简短摘要
 * - warning: notify("warning") 简短摘要
 * - error:   notify("error") 简短摘要
 * - detail:  notify("info") 完整内容（status/diff/doctor 等信息展示）
 */
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

/**
 * TUI 操作菜单
 *
 * 根据 ctx.mode 选择不同的展示方式：
 * - tui: SelectList 组件（完整交互菜单）
 * - rpc: ctx.ui.select() 简单列表
 * - json/print: 回退到 notify 文本
 */
async function showMenu(cmds: PiSyncCommands, ctx: ExtensionCommandContext): Promise<void> {
  const choice = await getMenuChoice(ctx);
  if (!choice) return;

  await executeMenuChoice(choice, cmds, ctx);
}

/**
 * 获取用户选择的菜单项
 */
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

  // 获取摘要
  const summary = await getRepoSummary();

  if (ctx.mode === "tui") {
    return showTuiMenu(menuOptions, summary, ctx);
  }

  if (ctx.mode === "rpc") {
    return showRpcMenu(menuOptions, summary, ctx);
  }

  // json / print 模式：无法交互，展示可用命令列表
  const lines = [
    `pi-git-sync${summary}`,
    "Available commands: /pisync init|status|diff|pull|push|capture|doctor|rollback",
  ];
  ctx.ui.notify(lines.join("\n"), "info");
  return null;
}

/**
 * TUI 模式：完整 SelectList 交互菜单
 */
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
    container.addChild(new Text(theme.fg("dim", "Sync Pi configuration via Git"), 1, 0));

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

/**
 * RPC 模式：ctx.ui.select() 简单列表
 */
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

/**
 * 获取 repo 状态摘要字符串
 */
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
    s += "]";
    return s;
  } catch {
    return "";
  }
}

/**
 * 执行菜单选择对应的操作
 */
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
      await handleInit(cmds, undefined, ctx);
      return;
    case "capture":
      await handleCapture(cmds, ctx);
      return;
    case "doctor":
      await handleDoctor(cmds, ctx);
      return;
    case "rollback":
      await handleRollback(cmds, ctx);
      return;
  }
}

/**
 * /pisync init 处理
 * - 如果已初始化：直接 apply（不需 URL）
 * - 如果未初始化：交互式获取 Git URL
 */
async function handleInit(
  cmds: PiSyncCommands,
  gitUrl: string | undefined,
  ctx: ExtensionCommandContext,
): Promise<void> {
  let url = gitUrl;

  if (!url) {
    // 未提供 URL — 先尝试直接 init（已初始化场景会直接 apply）
    ctx.ui.setWorkingMessage("Checking pi-sync status...");
    const quickResult = await cmds.init();
    ctx.ui.setWorkingMessage();

    // 如果不需要 URL（即已初始化），直接处理结果
    if (!quickResult.message.includes("Enter your config repo Git URL")) {
      notifyInitResult(quickResult, ctx);
      if (quickResult.needsReload) {
        await ctx.reload();
      }
      return;
    }

    // 需要 URL — 交互式获取
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

/**
 * 展示 init 结果
 *
 * init 现在会明确返回 ok / level，调用方据此选择提示级别，不再通过对
 * 多行消息做字符串嗅探来猜测结果类型——后者会把“第一行是 Cloning...、
 * 后面某处出现了 failed:”这种情形误判为「初始化失败：Cloning...」，误导用户。
 */
function notifyInitResult(
  result: { message: string; ok: boolean; level: "info" | "warning" | "error" },
  ctx: ExtensionCommandContext,
): void {
  ctx.ui.notify(result.message, result.level);
}

// ========== 各命令处理器 ==========

/** status / diff / doctor / rollback-list：纯信息展示，直接 notify 完整内容 */
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

async function handleRollbackList(cmds: PiSyncCommands, ctx: ExtensionCommandContext): Promise<void> {
  const output = await cmds.rollbackList();
  ctx.ui.notify(output, "info");
}

/** push / capture：成功/警告/错误 简要提示 */
async function handlePush(
  cmds: PiSyncCommands,
  message: string | undefined,
  ctx: ExtensionCommandContext,
): Promise<void> {
  ctx.ui.setWorkingMessage("Pushing...");
  const output = await cmds.push(undefined, message);
  ctx.ui.setWorkingMessage();
  const result = classifyResult(output, "Push");
  notifyResult(result, ctx);
}

async function handleCapture(cmds: PiSyncCommands, ctx: ExtensionCommandContext): Promise<void> {
  ctx.ui.setWorkingMessage("Capturing...");
  const output = await cmds.capture();
  ctx.ui.setWorkingMessage();
  const result = classifyResult(output, "Capture");
  notifyResult(result, ctx);
}

/** pull：先展示 diff 摘要，再确认 */
async function handlePull(cmds: PiSyncCommands, ctx: ExtensionCommandContext): Promise<void> {
  ctx.ui.setWorkingMessage("Checking remote...");
  const output = await cmds.pull();
  ctx.ui.setWorkingMessage();

  const result = classifyResult(output, "Pull");

  // 错误或无需操作：直接通知
  if (result.kind === "error" || result.kind === "warning") {
    notifyResult(result, ctx);
    return;
  }

  // 成功（有新内容）：展示完整 diff 并确认
  ctx.ui.notify(output, "info");

  // pull 已经在 cmds.pull() 中完成了，这里只是确认通知
  notifyResult(result, ctx);
  await ctx.reload();
}

/** rollback：先展示备份信息，再确认 + reload */
async function handleRollback(cmds: PiSyncCommands, ctx: ExtensionCommandContext): Promise<void> {
  const output = await cmds.rollback();
  const result = classifyResult(output, "Rollback");

  if (result.kind === "warning" && output.includes("No backups")) {
    ctx.ui.notify("No backups available.", "warning");
    return;
  }

  // 展示完整回滚信息
  ctx.ui.notify(output, "info");

  if (result.kind === "error") {
    notifyResult(result, ctx);
    return;
  }

  const confirmed = await ctx.ui.confirm(
    "pi-sync: Confirm rollback",
    "Rollback to the previous backup? Current state will be backed up first.",
  );

  if (!confirmed) {
    ctx.ui.notify("Rollback cancelled.", "warning");
    return;
  }

  notifyResult(result, ctx);
  await ctx.reload();
}
