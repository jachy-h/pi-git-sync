const STATUS_KEY = "pi-sync";

export enum SyncStatus {
	None = "",
	SyncNeeded = "Sync needed",
}

export interface StatusUi {
	setStatus(key: string, value: string | undefined): void;
}

export function setStatus(ui: StatusUi, status: SyncStatus): void {
	ui.setStatus(STATUS_KEY, status || undefined);
}
