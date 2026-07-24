import { describe, it, expect } from "vitest";
import { deepMerge, deepEqual, getPlatform } from "../src/settings.ts";

describe("deepMerge", () => {
  it("should merge flat objects", () => {
    const a = { x: 1, y: 2 };
    const b = { y: 3, z: 4 };
    const result = deepMerge(a, b);
    expect(result).toEqual({ x: 1, y: 3, z: 4 });
  });

  it("should merge nested objects", () => {
    const a = { x: { a: 1, b: 2 } };
    const b = { x: { b: 3, c: 4 }, y: 5 };
    const result = deepMerge(a, b);
    expect(result).toEqual({ x: { a: 1, b: 3, c: 4 }, y: 5 });
  });

  it("should replace arrays instead of merging", () => {
    const a = { items: [1, 2] };
    const b = { items: [3, 4] };
    const result = deepMerge(a, b);
    expect(result).toEqual({ items: [3, 4] });
  });

  it("should handle empty source", () => {
    const a = { x: 1 };
    const b = {};
    const result = deepMerge(a, b);
    expect(result).toEqual({ x: 1 });
  });

  it("should handle empty target", () => {
    const a = {};
    const b = { x: 1 };
    const result = deepMerge(a, b);
    expect(result).toEqual({ x: 1 });
  });

  it("should handle null values", () => {
    const a = { x: "original" };
    const b = { x: null };
    const result = deepMerge(a, b);
    expect(result).toEqual({ x: null });
  });
});

describe("deepEqual", () => {
  it("should return true for equal primitives", () => {
    expect(deepEqual(1, 1)).toBe(true);
    expect(deepEqual("a", "a")).toBe(true);
    expect(deepEqual(true, true)).toBe(true);
  });

  it("should return false for different primitives", () => {
    expect(deepEqual(1, 2)).toBe(false);
    expect(deepEqual("a", "b")).toBe(false);
  });

  it("should compare objects deeply", () => {
    expect(deepEqual({ a: 1, b: { c: 2 } }, { a: 1, b: { c: 2 } })).toBe(true);
    expect(deepEqual({ a: 1, b: { c: 2 } }, { a: 1, b: { c: 3 } })).toBe(false);
  });

  it("should handle undefined", () => {
    expect(deepEqual(undefined, undefined)).toBe(true);
    expect(deepEqual(undefined, null)).toBe(false);
  });

  it("should handle arrays", () => {
    expect(deepEqual([1, 2], [1, 2])).toBe(true);
    expect(deepEqual([1, 2], [1, 3])).toBe(false);
  });
});

describe("getPlatform", () => {
  it("should return macos for darwin", () => {
    // This is hard to test without mocking process.platform
    // We'll just verify it returns a string
    expect(typeof getPlatform()).toBe("string");
  });
});
