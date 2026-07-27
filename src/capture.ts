/**
 * Capture: agent → repo
 *
 * 将 agent 中的本地变更复制到配置仓库的 sync/ 目录。
 *
 * 流程：
 * 1. 扫描 agent 和 repo 的白名单文件集合
 * 2. 根据基线检测双边修改
 * 3. 双边修改时停止，不覆盖任一方
 * 4. 把仅本地修改复制到 repo
 * 5. 把 agent 中对已管理文件的删除反映到 repo
 * 6. 校验捕获结果
 */
import { readFile, writeFile, mkdir, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import type { PiSyncConfig } from "./config.ts";
import type { SyncState } from "./state.ts";
import {
	compareFiles,
	getCapturableFiles,
	sha256File,
	type FileComparison,
} from "./inventory.ts";
import { normalizePath, isPathAllowed } from "./glob.ts";
import { isDenied } from "./security.ts";
import { resolveRepoSyncRoot, resolveWithinRoot } from "./path-safety.ts";
import { isPortablePackageSource } from "./packages.ts";

export interface CaptureResult {
	/** 已捕获的文件路径 */
	captured: string[];
	/** 已删除的文件路径 */
	deleted: string[];
	/** 被 hard deny 阻止的文件 */
	denied: string[];
	/** 错误 */
	errors: Array<{ file: string; message: string }>;
	/** 是否有双边冲突 */
	hasConflicts: boolean;
	/** 冲突详情 */
	conflicts: FileComparison[];
}

/**
 * 将 agent 变更捕获到 repo 工作树（不访问网络、不 commit、不 push）
 */
export async function captureChanges(
	agentDir: string,
	repoPath: string,
	config: PiSyncConfig,
	state: SyncState,
	options?: { preferLocalOnConflicts?: boolean },
): Promise<CaptureResult> {
	const safeRoot = await resolveRepoSyncRoot(repoPath, config.root, "write");
	const inventory = await compareFiles(agentDir, repoPath, config, state);

	const result: CaptureResult = {
		captured: [],
		deleted: [],
		denied: [],
		errors: [],
		hasConflicts: false,
		conflicts: [],
	};

	// 1. 检查双边冲突
	const bilateralConflicts = inventory.comparisons.filter(
		(c) =>
			c.changeType === "both_modified" ||
			c.changeType === "local_modified_remote_deleted" ||
			c.changeType === "local_deleted_remote_modified",
	);
	if (bilateralConflicts.length > 0 && !options?.preferLocalOnConflicts) {
		result.hasConflicts = true;
		result.conflicts = bilateralConflicts;
		return result;
	}

	// 2. 处理仅本地变更。冲突分支以当前设备的版本为准，保留其完整修改。
	const capturable = options?.preferLocalOnConflicts
		? inventory.comparisons.filter(
				(c) =>
					c.changeType === "local_only" ||
					c.changeType === "local_created" ||
					c.changeType === "local_deleted" ||
					c.changeType === "both_modified" ||
					c.changeType === "local_modified_remote_deleted" ||
					c.changeType === "local_deleted_remote_modified",
			)
		: getCapturableFiles(inventory.comparisons);

	for (const comp of capturable) {
		try {
			const relPath = comp.relativePath;

			// Hard deny 检查
			if (isDenied(relPath)) {
				result.denied.push(relPath);
				continue;
			}

			// 白名单检查
			const allowed = isPathAllowed(relPath, config.include, config.exclude);
			if (!allowed.allowed) {
				continue; // 不在白名单内，静默跳过
			}

			const repoFilePath = await resolveWithinRoot(safeRoot, relPath, "write");
			const agentFilePath = await resolveWithinRoot(agentDir, relPath, "read");

			if (
				comp.changeType === "local_deleted" ||
				comp.changeType === "local_deleted_remote_modified"
			) {
				// agent 中删除了，repo 中也删除
				if (existsSync(repoFilePath)) {
					await unlink(repoFilePath);
					result.deleted.push(relPath);
				}
			} else if (
				comp.changeType === "local_only" ||
				comp.changeType === "local_created" ||
				comp.changeType === "both_modified" ||
				comp.changeType === "local_modified_remote_deleted"
			) {
				// agent 中有新内容或修改，复制到 repo
				if (existsSync(agentFilePath)) {
					let content = await readFile(agentFilePath);

					// Sanitize settings.json: strip local-path packages that are machine-specific
					// and should never be synced to other devices (e.g. local dev installs).
					if (relPath === "settings.json") {
						try {
							const parsed: unknown = JSON.parse(content.toString("utf-8"));
							if (
								parsed &&
								typeof parsed === "object" &&
								!Array.isArray(parsed)
							) {
								const settings = parsed as Record<string, unknown>;
								if (Array.isArray(settings.packages)) {
									const originalLen = settings.packages.length;
									(settings as Record<string, unknown>).packages =
										settings.packages.filter((pkg: unknown) => {
											if (typeof pkg === "string")
												return isPortablePackageSource(pkg);
											if (
												typeof pkg === "object" &&
												pkg !== null &&
												!Array.isArray(pkg) &&
												"source" in pkg
											) {
												return isPortablePackageSource(
													(pkg as { source: unknown }).source as string,
												);
											}
											return false;
										});
									if ((settings.packages as unknown[]).length < originalLen) {
										content = Buffer.from(
											JSON.stringify(settings, null, 2) + "\n",
											"utf-8",
										);
									}
								}
							}
						} catch {
							// If we can't parse the JSON, write the original content as-is and let
							// validation catch the issue later.
						}
					}

					await mkdir(dirname(repoFilePath), { recursive: true });
					await writeFile(repoFilePath, content);
					result.captured.push(relPath);
				}
			}
		} catch (err) {
			result.errors.push({
				file: comp.relativePath,
				message: err instanceof Error ? err.message : "Unknown error",
			});
		}
	}

	return result;
}

/**
 * 验证捕获结果的一致性
 * 确保 repo 中已捕获的文件与 agent 源文件一致
 */
export async function verifyCapture(
	agentDir: string,
	repoPath: string,
	config: PiSyncConfig,
	files: string[],
): Promise<Array<{ file: string; match: boolean; error?: string }>> {
	const safeRoot = await resolveRepoSyncRoot(repoPath, config.root, "read");
	const results: Array<{ file: string; match: boolean; error?: string }> = [];

	for (const relPath of files) {
		try {
			const normalizedPath = normalizePath(relPath);
			if (normalizedPath === "") throw new Error("Path must not be empty");
			const agentPath = await resolveWithinRoot(
				agentDir,
				normalizedPath,
				"read",
			);
			const repoPath_ = await resolveWithinRoot(
				safeRoot,
				normalizedPath,
				"read",
			);

			if (!existsSync(agentPath) || !existsSync(repoPath_)) {
				results.push({
					file: relPath,
					match: false,
					error: "File missing from one side",
				});
				continue;
			}

			const agentHash = await sha256File(agentPath);
			const repoHash = await sha256File(repoPath_);
			results.push({ file: relPath, match: agentHash === repoHash });
		} catch (err) {
			results.push({
				file: relPath,
				match: false,
				error: err instanceof Error ? err.message : "Unknown",
			});
		}
	}

	return results;
}
