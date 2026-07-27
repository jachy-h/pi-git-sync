import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  hasConflictMarkers,
  validateFiles,
  validateJson,
  validateSettingsPortability,
} from "../src/validate.ts";
import { createPiSyncConfig } from "./helpers/factories.ts";
import { withTestEnvironment } from "./helpers/temp-env.ts";

describe("content validation", () => {
  it.each(["<<<<<<< HEAD\nlocal", "=======\nremote", ">>>>>>> branch\n"]) 
    ("recognizes Git conflict markers", (content) => {
      expect(hasConflictMarkers(content)).toBe(true);
    });

  it("does not treat ordinary prose as a conflict marker", () => {
    expect(hasConflictMarkers("Use <<< arrows to describe the flow.")).toBe(false);
  });

  it("returns structured JSON validation errors", () => {
    expect(validateJson("settings.json", '{ "valid": true }')).toEqual([]);
    expect(validateJson("settings.json", "{ broken")).toMatchObject([
      { file: "settings.json", severity: "error" },
    ]);
  });

  it("reports non-portable settings while accepting portable package sources", () => {
    const portable = JSON.stringify({ packages: ["npm:@jachy/pi-git-sync", "git:github.com/acme/tool@v1"] });
    expect(validateSettingsPortability(portable)).toEqual([]);

    const nonPortable = JSON.stringify({
      packages: ["~/work/private-package"],
      externalEditor: "/Applications/Code.app",
      outputPath: "/Users/alice/.cache",
    });
    const errors = validateSettingsPortability(nonPortable);
    expect(errors.map(({ severity }) => severity)).toContain("error");
    expect(errors.map(({ message }) => message)).toEqual(expect.arrayContaining([
      expect.stringContaining("Absolute package path"),
      expect.stringContaining("pi-git-sync"),
      expect.stringContaining("machine-specific"),
      expect.stringContaining("externalEditor"),
    ]));
  });
});

describe.sequential("validateFiles", () => {
  it("aggregates conflict, JSON, and settings portability failures before apply", async () => {
    await withTestEnvironment(async ({ repoDir }) => {
      const syncDir = join(repoDir, "sync");
      await mkdir(syncDir, { recursive: true });
      await Promise.all([
        writeFile(join(syncDir, "conflict.md"), "<<<<<<< HEAD\nlocal\n=======\nremote\n>>>>>>> main\n", "utf-8"),
        writeFile(join(syncDir, "broken.json"), "{ broken", "utf-8"),
        writeFile(join(syncDir, "settings.json"), JSON.stringify({ packages: ["/tmp/package"] }), "utf-8"),
      ]);

      const result = await validateFiles(
        repoDir,
        createPiSyncConfig({ include: ["**"] }),
        ["conflict.md", "broken.json", "settings.json"],
      );

      expect(result.blocked).toBe(true);
      expect(result.errors.map(({ file }) => file)).toEqual(expect.arrayContaining([
        "conflict.md",
        "broken.json",
        "settings.json",
      ]));
      expect(result.errors).toHaveLength(5);
    });
  });

  it("refuses path traversal and Windows absolute paths without reading outside sync", async () => {
    await withTestEnvironment(async ({ rootDir, repoDir }) => {
      const outsidePath = join(rootDir, "outside.json");
      await writeFile(outsidePath, "{ broken", "utf-8");

      const result = await validateFiles(
        repoDir,
        createPiSyncConfig({ include: ["**"] }),
        ["../outside.json", "C:\\outside.json", ""],
      );

      expect(result).toEqual({
        blocked: true,
        errors: [
          { file: "../outside.json", message: expect.stringContaining("relative path"), severity: "error" },
          { file: "C:\\outside.json", message: expect.stringContaining("relative path"), severity: "error" },
          { file: "", message: expect.stringContaining("relative path"), severity: "error" },
        ],
      });
    });
  });
});
