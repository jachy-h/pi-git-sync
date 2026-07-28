import type { PiSyncConfig } from "../../src/config.ts";
import type { SyncState } from "../../src/state.ts";

export interface PiSyncConfigOverrides
	extends Omit<Partial<PiSyncConfig>, "security"> {
	security?: Partial<PiSyncConfig["security"]>;
}

export function createPiSyncConfig(
	overrides: PiSyncConfigOverrides = {},
): PiSyncConfig {
	const { security, ...configOverrides } = overrides;

	return {
		schemaVersion: 2,
		branch: "main",
		root: "sync",
		include: [
			"settings.json",
			"extensions/**",
			"skills/**",
			"prompts/**",
			"themes/**",
		],
		exclude: [],
		delete: "tracked",
		pullTimeoutMs: 30000,
		...configOverrides,
		security: {
			scanSecretsBeforePush: true,
			...security,
		},
	};
}

export function createSyncState(overrides: Partial<SyncState> = {}): SyncState {
	return {
		schemaVersion: 3,
		repoPath: "/test/config-repo",
		branch: "main",
		lastSyncedCommit: null,
		lastSyncedAt: null,
		files: {},
		pendingOperation: null,
		lastBackup: null,
		...overrides,
	};
}
