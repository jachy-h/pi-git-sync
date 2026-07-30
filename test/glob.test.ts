import { describe, expect, it } from "vitest";
import {
	filterAllowedFiles,
	isPathAllowed,
	minimatch,
	normalizePath,
} from "../src/sync/glob.ts";

describe("normalizePath", () => {
	it("normalizes Windows separators, leading dot segments, duplicate separators, and trailing separators", () => {
		expect(normalizePath("./skills\\review//prompt.md/")).toBe(
			"skills/review/prompt.md",
		);
	});

	it.each([
		"/etc/passwd",
		"\\\\server\\share\\secret",
		"C:\\Users\\agent\\settings.json",
		"C:/Users/agent/settings.json",
		"../escape",
		"skills/../escape",
		"settings.json\0.tmp",
	])("rejects unsafe path %j", (path) => {
		expect(() => normalizePath(path)).toThrow();
	});
});

describe("glob matching and precedence", () => {
	it("matches nested paths without treating a single-star pattern as recursive", () => {
		expect(minimatch("skills/review/SKILL.md", "skills/**/SKILL.md")).toBe(
			true,
		);
		expect(minimatch("skills/review/SKILL.md", "skills/*.md")).toBe(false);
		expect(minimatch("themes/a.json", "themes/?.json")).toBe(true);
	});

	it("matches root-level files with a recursive prefix", () => {
		expect(minimatch("settings.json", "**/settings.json")).toBe(true);
	});

	it("gives hard deny precedence over include and exclude precedence over include", () => {
		expect(isPathAllowed("auth.json", ["**"], [])).toMatchObject({
			allowed: false,
			denied: true,
			reason: "Built-in deny: auth.json",
		});
		expect(
			isPathAllowed(
				"extensions/demo/node_modules/pkg/index.js",
				["extensions/**"],
				[],
			),
		).toMatchObject({
			allowed: false,
			denied: true,
			reason: "Built-in deny: **/node_modules/**",
		});
		expect(
			isPathAllowed("extensions/debug.log", ["extensions/**"], ["**/*.log"]),
		).toMatchObject({
			allowed: false,
			denied: false,
			reason: "Excluded by: **/*.log",
		});
		expect(
			isPathAllowed("prompts/review.md", ["extensions/**"], []),
		).toMatchObject({
			allowed: false,
			denied: false,
			reason: "Not in include patterns",
		});
	});

	it("filters allowlisted files and reports only hard-denied paths", () => {
		expect(
			filterAllowedFiles(
				[
					"skills/review/SKILL.md",
					"auth.json",
					"skills/tmp.log",
					"themes/dark.json",
				],
				["skills/**", "themes/**", "auth.json"],
				["**/*.log"],
			),
		).toEqual({
			allowed: ["skills/review/SKILL.md", "themes/dark.json"],
			denied: ["auth.json"],
		});
	});
});
