import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import extension from "../index.ts";
import {
	FakeExtensionApi,
	FakeCommandContext,
	FakeUi,
} from "./helpers/fake-pi.ts";
import { saveState } from "../src/state.ts";
import { createSyncState } from "./helpers/factories.ts";
import { createGitFixture, runGit } from "./helpers/git-fixture.ts";
import {
	createTestEnvironment,
	type TestEnvironment,
	withTestEnvironment,
} from "./helpers/temp-env.ts";

let isolatedEnvironment: TestEnvironment;

beforeAll(async () => {
	isolatedEnvironment = await createTestEnvironment("pi-git-sync-extension-");
});

afterAll(async () => {
	await isolatedEnvironment.cleanup();
});

/** Cast the fake API to the real type for testing the extension entry point. */
function register(api: FakeExtensionApi): void {
	extension(api as unknown as ExtensionAPI);
}

/**
 * A FakeUi that intercepts `custom()` used by `showOutput` and converts
 * it into a notification so we can assert on the rendered content.
 */
class RpcFakeUi extends FakeUi {
	private _showOutputText = "";

	async custom<T>(_renderer: unknown): Promise<T | undefined> {
		try {
			const fn = _renderer as (
				tui: unknown,
				theme: { fg: (role: string, text: string) => string },
				kb: unknown,
				done: (val?: T) => void,
			) => { render: (w: number) => string[] };
			const done = () => {};
			const theme = { fg: (_role: string, text: string) => text };
			const result = fn(undefined, theme, undefined, done);
			const lines = result.render(80);
			this._showOutputText = lines.join("\n");
		} catch {
			// Ignore
		}
		return undefined;
	}

	get showOutputText(): string {
		return this._showOutputText;
	}
}

class FilterableMenuFakeUi extends FakeUi {
	renderedLines: string[] = [];

	async custom<T>(renderer: unknown): Promise<T | undefined> {
		const menuTheme = { ...this.theme, bold: (text: string) => text };
		const createComponent = renderer as (
			tui: { requestRender: () => void },
			theme: {
				fg: (role: string, text: string) => string;
				bold: (text: string) => string;
			},
			keybindings: unknown,
			done: (value?: T) => void,
		) => {
			render: (width: number) => string[];
			handleInput?: (data: string) => void;
		};
		const component = createComponent(
			{ requestRender: () => {} },
			menuTheme,
			undefined,
			() => {},
		);

		for (const key of ["s", "t", "a"]) component.handleInput?.(key);
		this.renderedLines = component.render(120);
		return undefined;
	}
}

function createRpcContext(): FakeCommandContext {
	const ctx = new FakeCommandContext("rpc");
	const rpcUi = new RpcFakeUi();
	rpcUi.confirmResponses = ctx.ui.confirmResponses;
	rpcUi.inputResponses = ctx.ui.inputResponses;
	rpcUi.selectResponses = ctx.ui.selectResponses;
	ctx.ui = rpcUi;
	return ctx;
}

function showOutputOf(ctx: FakeCommandContext): string {
	return (ctx.ui as RpcFakeUi).showOutputText;
}

function notificationTextOf(ctx: FakeCommandContext): string {
	return ctx.ui.notifications
		.map((notification) => notification.message)
		.join("\n");
}

const config = {
	schemaVersion: 2,
	branch: "main",
	root: "sync",
	include: ["prompts/**", "settings.json"],
	exclude: [],
	delete: "tracked",
	security: { scanSecretsBeforePush: false },
} as const;

async function seedConfigRepo(repoPath: string): Promise<void> {
	await mkdir(join(repoPath, "sync/prompts"), { recursive: true });
	await writeFile(
		join(repoPath, "pi-sync.json"),
		JSON.stringify(config),
		"utf-8",
	);
	await writeFile(join(repoPath, "sync/prompts/welcome.md"), "base\n", "utf-8");
	await writeFile(
		join(repoPath, "sync/settings.json"),
		JSON.stringify({ packages: ["npm:@jachy/pi-git-sync"] }),
		"utf-8",
	);
	await runGit(repoPath, ["add", "--all"]);
	await runGit(repoPath, [
		"commit",
		"--no-gpg-sign",
		"-m",
		"Initialize sync config",
	]);
}

describe("Extension registration", () => {
	it("registers pisync command with description and handler", () => {
		const api = new FakeExtensionApi();
		register(api);

		const cmd = api.commands.get("pisync");
		expect(cmd).toBeDefined();
		expect(cmd!.description).toBeDefined();
		expect(typeof cmd!.handler).toBe("function");
	});

	it("filters pisync subcommands as the user types an argument", () => {
		const api = new FakeExtensionApi();
		register(api);

		const completions = api.commands
			.get("pisync")!
			.getArgumentCompletions?.("pu");

		expect(completions).toEqual([
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
		]);
		expect(
			api.commands.get("pisync")!.getArgumentCompletions?.("unknown"),
		).toBeNull();
		expect(
			api.commands.get("pisync")!.getArgumentCompletions?.("init "),
		).toBeNull();
	});

	it("filters commands typed into the /pisync menu", async () => {
		const api = new FakeExtensionApi();
		register(api);
		const ui = new FilterableMenuFakeUi();
		const ctx = {
			mode: "tui",
			ui,
			reload: async () => {},
		} as unknown as FakeCommandContext;

		await api.commands.get("pisync")!.handler(undefined, ctx);

		const menu = ui.renderedLines.join("\n");
		expect(menu).toContain("Filter commands:");
		expect(menu).toContain("→ Status");
		expect(menu).not.toContain("→ Pull");
	});

	it("registers debug:clear-repo command", () => {
		const api = new FakeExtensionApi();
		register(api);

		const cmd = api.commands.get("debug:clear-repo");
		expect(cmd).toBeDefined();
		expect(typeof cmd!.handler).toBe("function");
	});

	it("registers session_start and session_shutdown event handlers", () => {
		const api = new FakeExtensionApi();
		register(api);

		expect(api.eventHandlers.has("session_start")).toBe(true);
		expect(api.eventHandlers.has("session_shutdown")).toBe(true);
	});

	it("clears pi-sync status on session_start and session_shutdown", async () => {
		const api = new FakeExtensionApi();
		register(api);
		const ctx = new FakeCommandContext();

		await api.emit("session_start", {}, ctx);
		expect(
			ctx.ui.statusUpdates.some(
				(s) => s.key === "pi-sync" && s.value === undefined,
			),
		).toBe(true);

		await api.emit("session_shutdown", {}, ctx);
		expect(
			ctx.ui.statusUpdates.filter(
				(s) => s.key === "pi-sync" && s.value === undefined,
			).length,
		).toBe(2);
	});
});

describe("pisync command routing", () => {
	it("routes empty/unknown subcommand to the menu (non-interactive mode)", async () => {
		const api = new FakeExtensionApi();
		register(api);
		const ctx = createRpcContext();
		// Provide a select response so the menu can complete
		ctx.ui.selectResponses = ["status"];

		const cmd = api.commands.get("pisync")!;
		await cmd.handler("unknown", ctx);

		// The menu selects "status" and appends the result without opening a modal.
		expect(notificationTextOf(ctx)).toContain("No config repo");
		expect(showOutputOf(ctx)).toBe("");
	});

	it("does not advertise or route capture as a subcommand", async () => {
		const api = new FakeExtensionApi();
		register(api);
		const ctx = createRpcContext();
		ctx.ui.selectResponses = ["status"];

		const cmd = api.commands.get("pisync")!;
		expect(cmd.description).not.toContain("capture");
		await cmd.handler("capture", ctx);

		expect(ctx.ui.selectCalls[0]?.options).not.toContain("capture");
		expect(notificationTextOf(ctx)).toContain("No config repo");
	});

	it("does not advertise or route rollback as a subcommand", async () => {
		const api = new FakeExtensionApi();
		register(api);
		const ctx = createRpcContext();
		ctx.ui.selectResponses = ["status"];

		const cmd = api.commands.get("pisync")!;
		expect(cmd.description).not.toContain("rollback");
		await cmd.handler("rollback", ctx);

		expect(ctx.ui.selectCalls[0]?.options).not.toContain("rollback");
		expect(notificationTextOf(ctx)).toContain("No config repo");
	});

	it("routes to status subcommand", async () => {
		const api = new FakeExtensionApi();
		register(api);
		const ctx = createRpcContext();

		const cmd = api.commands.get("pisync")!;
		await cmd.handler("status", ctx);

		// Status is a non-blocking notification, not a focused custom component.
		expect(notificationTextOf(ctx)).toContain("No config repo");
		expect(showOutputOf(ctx)).toBe("");
	});

	it("routes to diff subcommand", async () => {
		const api = new FakeExtensionApi();
		register(api);
		const ctx = createRpcContext();

		const cmd = api.commands.get("pisync")!;
		await cmd.handler("diff", ctx);

		expect(showOutputOf(ctx)).toContain("No config repo");
	});

	it("does not advertise or route doctor as a subcommand", async () => {
		const api = new FakeExtensionApi();
		register(api);
		const ctx = createRpcContext();
		ctx.ui.selectResponses = ["status"];

		const cmd = api.commands.get("pisync")!;
		expect(cmd.description).not.toContain("doctor");
		await cmd.handler("doctor", ctx);

		expect(ctx.ui.selectCalls[0]?.options).not.toContain("doctor");
		expect(notificationTextOf(ctx)).toContain("No config repo");
	});

	it("routes init without URL and notifies guidance", async () => {
		const api = new FakeExtensionApi();
		register(api);
		const ctx = createRpcContext();
		// Provide an input response to simulate user entering a URL
		// Without input, the handler waits for input then cancels if none given
		// We'll test the guidance path: when no URL is given and no input, it cancels
		// But first let's test that with input it proceeds
		(ctx.ui as unknown as RpcFakeUi).inputResponses = [
			"git@github.com:test/pi-config.git",
		];

		const cmd = api.commands.get("pisync")!;
		await cmd.handler("init", ctx);

		// Should have some notification (either guidance or init attempt)
		expect(ctx.ui.notifications.length).toBeGreaterThan(0);
	});

	it("notifies 'Init cancelled' when input is empty", async () => {
		const api = new FakeExtensionApi();
		register(api);
		const ctx = createRpcContext();
		// No input responses provided → input() returns undefined → cancelled

		const cmd = api.commands.get("pisync")!;
		await cmd.handler("init", ctx);

		expect(
			ctx.ui.notifications.some((n) => n.message.includes("Init cancelled")),
		).toBe(true);
	});

	it("parses --force flag from init args", async () => {
		const api = new FakeExtensionApi();
		register(api);
		const ctx = createRpcContext();
		// Provide input so init proceeds (albeit failing since no real git remote)
		(ctx.ui as unknown as RpcFakeUi).inputResponses = ["invalid-url"];

		const cmd = api.commands.get("pisync")!;
		await cmd.handler("init --force", ctx);

		// Should attempt init with the invalid URL
		expect(ctx.ui.notifications.length).toBeGreaterThan(0);
		// The notification should mention the invalid URL error
		const joined = ctx.ui.notifications.map((n) => n.message).join("\n");
		expect(joined.length).toBeGreaterThan(0);
	});

	it("routes push --continue subcommand", async () => {
		await withTestEnvironment(async (environment) => {
			const fixture = await createGitFixture(environment.rootDir);
			await seedConfigRepo(fixture.deviceBPath);
			await saveState(
				environment.agentDir,
				createSyncState({
					repoPath: fixture.deviceBPath,
				}),
			);

			const api = new FakeExtensionApi();
			register(api);
			const ctx = createRpcContext();

			const cmd = api.commands.get("pisync")!;
			await cmd.handler("push --continue", ctx);

			// Should show "No pending push operation to continue"
			expect(ctx.ui.notifications.length).toBeGreaterThan(0);
			const joined = ctx.ui.notifications.map((n) => n.message).join("\n");
			expect(joined).toContain("No pending push operation");
		});
	});

	it("trims extra whitespace from args", async () => {
		const api = new FakeExtensionApi();
		register(api);
		const ctx = createRpcContext();

		const cmd = api.commands.get("pisync")!;
		await cmd.handler("  status  ", ctx);

		expect(notificationTextOf(ctx)).toContain("No config repo");
		expect(showOutputOf(ctx)).toBe("");
	});
});

describe("debug:clear-repo command", () => {
	it("cancels when confirm is rejected", async () => {
		const api = new FakeExtensionApi();
		register(api);
		const ctx = new FakeCommandContext();
		ctx.ui.confirmResponses = [false];

		const cmd = api.commands.get("debug:clear-repo")!;
		await cmd.handler(undefined, ctx);

		expect(ctx.ui.confirmCalls.length).toBe(1);
		expect(
			ctx.ui.notifications.some((n) => n.message.includes("Cancelled")),
		).toBe(true);
	});

	it("handles missing repo gracefully (no state)", async () => {
		const api = new FakeExtensionApi();
		register(api);
		const ctx = new FakeCommandContext();
		ctx.ui.confirmResponses = [true];

		const cmd = api.commands.get("debug:clear-repo")!;
		await cmd.handler(undefined, ctx);

		expect(ctx.ui.notifications.length).toBeGreaterThan(0);
	});
});

describe.sequential("Extension push command interaction flow", () => {
	it("push flow does not request confirmation", async () => {
		await withTestEnvironment(async (environment) => {
			const fixture = await createGitFixture(environment.rootDir);
			await seedConfigRepo(fixture.deviceBPath);
			await runGit(fixture.deviceBPath, ["push", "origin", "main"]);
			await saveState(
				environment.agentDir,
				createSyncState({
					repoPath: fixture.deviceBPath,
				}),
			);

			const api = new FakeExtensionApi();
			register(api);
			const ctx = createRpcContext();

			const cmd = api.commands.get("pisync")!;
			await cmd.handler("push", ctx);

			expect(ctx.ui.confirmCalls).toHaveLength(0);
			expect(ctx.ui.notifications.length).toBeGreaterThan(0);
		});
	});

	it("push flow omits the diff and pushes immediately", async () => {
		await withTestEnvironment(async (environment) => {
			const fixture = await createGitFixture(environment.rootDir);
			await seedConfigRepo(fixture.deviceAPath);
			await runGit(fixture.deviceAPath, ["push", "origin", "main"]);
			await runGit(fixture.deviceBPath, ["pull", "--ff-only"]);

			const { sha256 } = await import("../src/inventory.ts");
			await environment.writeAgentFile("prompts/welcome.md", "base\n");
			await saveState(
				environment.agentDir,
				createSyncState({
					repoPath: fixture.deviceBPath,
					files: {
						"prompts/welcome.md": { sha256: sha256("base\n"), mode: 0o644 },
					},
				}),
			);

			await environment.writeAgentFile(
				"prompts/welcome.md",
				"changed for push\n",
			);

			const api = new FakeExtensionApi();
			register(api);
			const ctx = createRpcContext();

			const cmd = api.commands.get("pisync")!;
			await cmd.handler("push", ctx);

			expect(ctx.ui.confirmCalls).toHaveLength(0);
			expect(
				ctx.ui.notifications.some((notification) =>
					notification.message.includes("Push ready:"),
				),
			).toBe(true);
			expect(notificationTextOf(ctx)).not.toContain("diff --git");
			expect(ctx.ui.notifications.at(-1)).toMatchObject({
				message: expect.stringContaining("◆ pi-git-sync: Pushed successfully."),
				level: "info",
			});
			expect(ctx.reloadCalls).toBe(1);
		});
	});

	it("calls reload when push succeeds and result.reload is true", async () => {
		await withTestEnvironment(async (environment) => {
			const fixture = await createGitFixture(environment.rootDir);
			await seedConfigRepo(fixture.deviceAPath);
			await runGit(fixture.deviceAPath, ["push", "origin", "main"]);
			await runGit(fixture.deviceBPath, ["pull", "--ff-only"]);

			const { sha256 } = await import("../src/inventory.ts");
			await environment.writeAgentFile("prompts/welcome.md", "base\n");
			await saveState(
				environment.agentDir,
				createSyncState({
					repoPath: fixture.deviceBPath,
					files: {
						"prompts/welcome.md": { sha256: sha256("base\n"), mode: 0o644 },
					},
				}),
			);

			await environment.writeAgentFile(
				"prompts/welcome.md",
				"changed for push test\n",
			);

			const api = new FakeExtensionApi();
			register(api);
			const ctx = createRpcContext();
			ctx.ui.confirmResponses = [true];

			const cmd = api.commands.get("pisync")!;
			await cmd.handler("push", ctx);

			expect(ctx.reloadCalls).toBe(1);
		});
	});

	it("does NOT call reload when result.reload is false", async () => {
		await withTestEnvironment(async (environment) => {
			const fixture = await createGitFixture(environment.rootDir);
			await seedConfigRepo(fixture.deviceBPath);
			await saveState(
				environment.agentDir,
				createSyncState({
					repoPath: fixture.deviceBPath,
				}),
			);

			const api = new FakeExtensionApi();
			register(api);
			const ctx = createRpcContext();
			ctx.ui.confirmResponses = [true];

			const cmd = api.commands.get("pisync")!;
			await cmd.handler("push", ctx);

			// No changes = reload false
			expect(ctx.reloadCalls).toBe(0);
		});
	});
});

describe.sequential("Extension pull command interaction flow", () => {
	it("pull flow: notifies result", async () => {
		await withTestEnvironment(async (environment) => {
			const fixture = await createGitFixture(environment.rootDir);
			await seedConfigRepo(fixture.deviceAPath);
			await runGit(fixture.deviceAPath, ["push", "origin", "main"]);
			await runGit(fixture.deviceBPath, ["pull", "--ff-only"]);

			const { sha256 } = await import("../src/inventory.ts");
			await environment.writeAgentFile("prompts/welcome.md", "base\n");
			await saveState(
				environment.agentDir,
				createSyncState({
					repoPath: fixture.deviceBPath,
					files: {
						"prompts/welcome.md": { sha256: sha256("base\n"), mode: 0o644 },
					},
				}),
			);

			const api = new FakeExtensionApi();
			register(api);
			const ctx = createRpcContext();

			const cmd = api.commands.get("pisync")!;
			await cmd.handler("pull", ctx);

			expect(ctx.ui.notifications.at(-1)).toEqual({
				message: "◆ pi-git-sync: Already up to date.",
				level: "info",
			});
		});
	});

	it("pull flow asks for package approval before applying synced settings", async () => {
		await withTestEnvironment(async (environment) => {
			const fixture = await createGitFixture(environment.rootDir);
			await seedConfigRepo(fixture.deviceAPath);
			await runGit(fixture.deviceAPath, ["push", "origin", "main"]);
			await runGit(fixture.deviceBPath, ["pull", "--ff-only"]);
			await environment.writeAgentFile("prompts/welcome.md", "base\n");
			const { sha256 } = await import("../src/inventory.ts");
			await saveState(
				environment.agentDir,
				createSyncState({
					repoPath: fixture.deviceBPath,
					files: {
						"prompts/welcome.md": { sha256: sha256("base\n"), mode: 0o644 },
					},
				}),
			);

			await writeFile(
				join(fixture.deviceAPath, "sync/settings.json"),
				JSON.stringify({ packages: ["npm:extension-approved-package@1.0.0"] }),
				"utf-8",
			);
			await runGit(fixture.deviceAPath, ["add", "sync/settings.json"]);
			await runGit(fixture.deviceAPath, ["commit", "-m", "Request package"]);
			await runGit(fixture.deviceAPath, ["push", "origin", "main"]);
			await environment.writeExecutable(
				"pi",
				[
					"#!/bin/sh",
					'if [ "$1" = "--version" ]; then echo pi-test; exit 0; fi',
					"exit 0",
				].join("\n"),
			);

			const api = new FakeExtensionApi();
			register(api);
			const ctx = createRpcContext();
			ctx.ui.confirmResponses = [true];

			await api.commands.get("pisync")!.handler("pull", ctx);

			expect(ctx.ui.confirmCalls[0]?.title).toContain(
				"Approve package installation",
			);
			expect(ctx.ui.notifications.at(-1)?.message).toContain("Files written");
			expect(ctx.reloadCalls).toBe(1);
		});
	});

	it("pull flow keeps settings unchanged when package approval is cancelled", async () => {
		await withTestEnvironment(async (environment) => {
			const fixture = await createGitFixture(environment.rootDir);
			await seedConfigRepo(fixture.deviceAPath);
			await runGit(fixture.deviceAPath, ["push", "origin", "main"]);
			await runGit(fixture.deviceBPath, ["pull", "--ff-only"]);
			await environment.writeAgentFile("prompts/welcome.md", "base\n");
			const { sha256 } = await import("../src/inventory.ts");
			await saveState(
				environment.agentDir,
				createSyncState({
					repoPath: fixture.deviceBPath,
					files: {
						"prompts/welcome.md": { sha256: sha256("base\n"), mode: 0o644 },
					},
				}),
			);

			await writeFile(
				join(fixture.deviceAPath, "sync/settings.json"),
				JSON.stringify({ packages: ["npm:extension-cancelled-package@1.0.0"] }),
				"utf-8",
			);
			await runGit(fixture.deviceAPath, ["add", "sync/settings.json"]);
			await runGit(fixture.deviceAPath, ["commit", "-m", "Request package"]);
			await runGit(fixture.deviceAPath, ["push", "origin", "main"]);

			const api = new FakeExtensionApi();
			register(api);
			const ctx = createRpcContext();
			ctx.ui.confirmResponses = [false];

			await api.commands.get("pisync")!.handler("pull", ctx);

			await expect(
				readFile(join(environment.agentDir, "settings.json"), "utf-8"),
			).rejects.toThrow();
			expect(ctx.reloadCalls).toBe(0);
			expect(ctx.ui.notifications.at(-1)?.message).toContain("cancelled");
		});
	});
});

describe("status updates are cleared on completion", () => {
	it("status command does not crash and produces output", async () => {
		const api = new FakeExtensionApi();
		register(api);
		const ctx = createRpcContext();

		const cmd = api.commands.get("pisync")!;
		await cmd.handler("status", ctx);

		expect(notificationTextOf(ctx)).toContain("No config repo");
		expect(showOutputOf(ctx)).toBe("");
	});
});
