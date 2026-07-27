import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	FakeCommandContext,
	FakeExtensionApi,
	FakeUi,
} from "./helpers/fake-pi.ts";

const manualMergeMessage = [
	"Cloning git@github.com:example/pi-settings.git...",
	"Clone complete.",
	"Valid sync repo detected — fetching latest...",
	"Already up to date.",
	"Sync conflict detected. The shared branch was left unchanged.",
	"Current-device changes were saved to origin/pisync-device/test.",
	"",
	"Merge the current-device branch into the shared branch:",
	"  cd /tmp/config-repo",
	"  git fetch origin",
	"  git switch main",
	"  git merge origin/pisync-device/test",
	"",
	"Resolve any conflicts, then run git add, git commit, and git push origin main.",
].join("\n");

vi.mock("../src/commands.ts", () => ({
	PiSyncCommands: class {
		async init() {
			return {
				code: "blocked_conflict",
				level: "error" as const,
				message: manualMergeMessage,
				needsReload: false,
				ok: false,
				reload: false,
			};
		}
	},
	getAgentDir: () => "/tmp/agent",
	getRepoPathSafe: async () => "/tmp/config-repo",
}));

const { default: extension } = await import("../index.ts");

class StyledFakeUi extends FakeUi {
	readonly theme = {
		fg: (role: string, text: string) => `[${role}]${text}[/${role}]`,
	};
}

describe("manual merge guidance", () => {
	it("uses an info notification with white logs and accented user actions", async () => {
		const api = new FakeExtensionApi();
		extension(api as unknown as ExtensionAPI);
		const ctx = new FakeCommandContext("rpc");
		ctx.ui = new StyledFakeUi();

		await api.commands
			.get("pisync")!
			.handler("init git@github.com:example/pi-settings.git", ctx);

		const notification = ctx.ui.notifications.at(-1);
		expect(notification).toMatchObject({ level: "info" });
		expect(notification?.message).toContain(
			"[text]Cloning git@github.com:example/pi-settings.git...[/text]",
		);
		expect(notification?.message).toContain(
			"[accent]Merge the current-device branch into the shared branch:[/accent]",
		);
		expect(notification?.message).toContain(
			"[accent]  git merge origin/pisync-device/test[/accent]",
		);
	});
});
