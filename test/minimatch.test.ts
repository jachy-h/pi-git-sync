import { describe, it, expect } from "vitest";
import { minimatch } from "../src/minimatch.ts";

describe("minimatch", () => {
  it("should match exact strings", () => {
    expect(minimatch("file.txt", "file.txt")).toBe(true);
    expect(minimatch("file.txt", "other.txt")).toBe(false);
  });

  it("should match * (single segment)", () => {
    expect(minimatch("file.txt", "*.txt")).toBe(true);
    expect(minimatch("dir/file.txt", "*.txt")).toBe(false);
    expect(minimatch("file.js", "*.txt")).toBe(false);
  });

  it("should match ** (any depth)", () => {
    expect(minimatch("file.txt", "**")).toBe(true);
    expect(minimatch("dir/file.txt", "**")).toBe(true);
    expect(minimatch("a/b/c/file.txt", "**")).toBe(true);
  });

  it("should match ** with suffix", () => {
    expect(minimatch("file.txt", "**.txt")).toBe(true);
    expect(minimatch("a/file.txt", "**.txt")).toBe(true);
    expect(minimatch("a/b/file.txt", "**.txt")).toBe(true);
    expect(minimatch("file.js", "**.txt")).toBe(false);
  });

  it("should match **/ pattern", () => {
    expect(minimatch("sessions/foo", "sessions/**")).toBe(true);
    expect(minimatch("sessions/a/b", "sessions/**")).toBe(true);
    expect(minimatch("auth.json", "sessions/**")).toBe(false);
  });

  it("should match ? (single character)", () => {
    expect(minimatch("a.txt", "?.txt")).toBe(true);
    expect(minimatch("ab.txt", "?.txt")).toBe(false);
    expect(minimatch("ab", "?b")).toBe(true);
  });

  it("should match **/* pattern", () => {
    expect(minimatch("a/b/c", "**/*")).toBe(true);
    expect(minimatch("file.txt", "**/*")).toBe(true);
    expect(minimatch("", "**/*")).toBe(false);
  });

  it("should handle dotfiles", () => {
    expect(minimatch(".env", "**/.env")).toBe(true);
    expect(minimatch("dir/.env", "**/.env")).toBe(true);
    expect(minimatch("dir/sub/.env", "**/.env")).toBe(true);
  });

  it("should handle escaped characters", () => {
    expect(minimatch("a.txt", "a.txt")).toBe(true);
  });
});
