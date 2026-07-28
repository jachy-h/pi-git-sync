export function getPlatform(): string {
	if (process.platform === "darwin") return "macos";
	if (process.platform === "linux") return "linux";
	return process.platform;
}

export function deepMerge(
	target: Record<string, unknown>,
	source: Record<string, unknown>,
): Record<string, unknown> {
	const result = { ...target };
	for (const key of Object.keys(source)) {
		const sourceValue = source[key];
		const targetValue = target[key];
		result[key] =
			isPlainObject(sourceValue) && isPlainObject(targetValue)
				? deepMerge(targetValue, sourceValue)
				: sourceValue;
	}
	return result;
}

export function deepEqual(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (a === undefined && b === undefined) return true;
	if (a == null || b == null || typeof a !== typeof b) return false;
	if (typeof a !== "object" || typeof b !== "object") return false;
	const left = a as Record<string, unknown>;
	const right = b as Record<string, unknown>;
	const leftKeys = Object.keys(left);
	if (leftKeys.length !== Object.keys(right).length) return false;
	return leftKeys.every((key) => deepEqual(left[key], right[key]));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
