/**
 * pi-git-sync Extension
 *
 * 通过 GitHub Private Repository 在多台机器之间同步 Pi 的配置。
 *
 * 命令：
 *   /pisync          - TUI 操作菜单
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

  // 状态栏远端更新提示
  pi.on("session_start", async (_event, ctx) => {
    try {
      const agentDir = getAgentDir();
      const state = await loadState(agentDir);
      if (!state.repoPath || !existsSync(state.repoPath)) return;

      const repoStatus = await gitStatus(state.repoPath);
      if (repoStatus.remoteExists && repoStatus.behind > 0) {
        ctx.ui.setStatus(
          "pi-sync",
          `pi-sync: remote +${repoStatus.behind} commit(s)`,
        );
      } else if (repoStatus.remoteExists && repoStatus.ahead > 0) {
        ctx.ui.setStatus(
          "pi-sync",
          `pi-sync: local +${repoStatus.ahead} (unpushed)`,
        );
      } else if (repoStatus.remoteExists && repoStatus.ahead === 0 && repoStatus.behind === 0) {
        ctx.ui.setStatus("pi-sync", "pi-sync: up to date");
      }
    } catch {
      // Silently ignore — status check is best-effort
    }
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    ctx.ui.setStatus("pi-sync", undefined);
  });

  // /pisync - 状态概览（无子命令时显示菜单）
  pi.registerCommand("pisync", {
    description: "Sync Pi configuration via Git repository (status|diff|pull|push|apply|capture|doctor|rollback)",
    async handler(args, ctx) {
      const parts = args?.trim().split(/\s+/);
      const subCommand = parts?.[0];
      const subArgs = parts?.slice(1).join(" ");

      switch (subCommand) {
        case "init":
          await handleInit(cmds, subArgs, ctx);
          return;
        case "status":
          return handleRoute(await cmds.status(), ctx);
        case "diff":
          return handleRoute(await cmds.diff(), ctx);
        case "pull":
          return handleRouteWithConfirm("pull", await cmds.pull(), ctx);
        case "push":
          return handleRoute(await cmds.push(undefined, subArgs), ctx);
        case "apply":
          return handleRouteWithReload(await cmds.apply(), ctx);
        case "capture":
          return handleRoute(await cmds.capture(), ctx);
        case "doctor":
          return handleRoute(await cmds.doctor(), ctx);
        case "rollback":
          return handleRouteWithConfirmAndReload("rollback", await cmds.rollback(), ctx);
        case "rollback-list":
          return handleRoute(await cmds.rollbackList(), ctx);
        default: {
          // 无子命令时显示 TUI 操作菜单
          await showMenu(cmds, ctx);
          return;
        }
      }
    },
  });
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
    { value: "status", label: "Status" },
    { value: "diff", label: "Diff" },
    { value: "pull", label: "Pull" },
    { value: "push", label: "Push" },
    { value: "apply", label: "Apply" },
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
    "Available commands: /pisync status|diff|pull|push|apply|capture|doctor|rollback",
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
      status: "Show detailed sync status",
      diff: "Show pending changes before sync",
      pull: "Pull and apply remote changes",
      push: "Commit and push local changes",
      apply: "Apply current repo version (offline)",
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
      ctx.ui.notify(await cmds.status(), "info");
      return;
    case "diff":
      ctx.ui.notify(await cmds.diff(), "info");
      return;
    case "pull":
      await handleRouteWithConfirm("pull", await cmds.pull(), ctx);
      return;
    case "push":
      ctx.ui.notify(await cmds.push(), "info");
      return;
    case "apply":
      await handleRouteWithReload(await cmds.apply(), ctx);
      return;
    case "capture":
      ctx.ui.notify(await cmds.capture(), "info");
      return;
    case "doctor":
      ctx.ui.notify(await cmds.doctor(), "info");
      return;
    case "rollback":
      await handleRouteWithConfirmAndReload("rollback", await cmds.rollback(), ctx);
      return;
  }
}

/**
 * /pisync init 处理 — 如果没提供 URL，通过对话提示用户输入
 */
async function handleInit(
  cmds: PiSyncCommands,
  gitUrl: string | undefined,
  ctx: ExtensionCommandContext,
): Promise<void> {
  let url = gitUrl;

  if (!url) {
    // 交互式获取 URL
    url = await ctx.ui.input(
      "Enter your config repo Git URL:",
      "git@github.com:you/pi-config.git",
    );

    if (!url) {
      ctx.ui.notify("Init cancelled.", "info");
      return;
    }
  }

  const result = await cmds.init(url);

  if (result.needsReload) {
    ctx.ui.notify(result.message, "info");
    await ctx.reload();
    return;
  }

  ctx.ui.notify(result.message, "info");
}

/**
 * 不需要 reload 的命令结果处理
 */
async function handleRoute(result: string, ctx: ExtensionCommandContext): Promise<void> {
  ctx.ui.notify(result, "info");
}

/**
 * 需要 reload 的命令结果处理
 */
async function handleRouteWithReload(result: string, ctx: ExtensionCommandContext): Promise<void> {
  ctx.ui.notify(result, "info");
  await ctx.reload();
  return;
}

/**
 * 需要用户确认的操作（不需要 reload）
 */
async function handleRouteWithConfirm(
  operation: string,
  result: string,
  ctx: ExtensionCommandContext,
): Promise<void> {
  // 先展示 diff/result
  ctx.ui.notify(result, "info");

  // 如果结果包含错误或无需操作，跳过确认
  if (
    result.includes("error:") ||
    result.includes("failed:") ||
    result.includes("Already up to date") ||
    result.includes("No changes") ||
    result.includes("blocked")
  ) {
    return;
  }

  const confirmed = await ctx.ui.confirm(
    `pi-sync: Confirm ${operation}`,
    "Apply these changes?",
  );

  if (!confirmed) {
    ctx.ui.notify(`${operation} cancelled.`, "warning");
  }
}

/**
 * 需要用户确认的操作（需要 reload）
 */
async function handleRouteWithConfirmAndReload(
  operation: string,
  result: string,
  ctx: ExtensionCommandContext,
): Promise<void> {
  ctx.ui.notify(result, "info");

  if (result.includes("No backups")) {
    return;
  }

  const confirmed = await ctx.ui.confirm(
    `pi-sync: Confirm ${operation}`,
    `Rollback to the previous backup? Current state will be backed up first.`,
  );

  if (!confirmed) {
    ctx.ui.notify(`${operation} cancelled.`, "warning");
    return;
  }

  await ctx.reload();
  return;
}
