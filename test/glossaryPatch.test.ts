/** 测试：术语表补丁的严格校验、合并、替换与序列化。 */
import { describe, expect, it } from "vitest";
import {
  applyGlossaryPatch,
  assertGlossaryPatch,
  diffGlossaryEntries,
  serializeGlossaryFile,
  validateGlossaryEntries,
} from "../src/glossary/glossaryPatch";
import type { GlossaryEntry } from "../src/translation/types";

const base: GlossaryEntry[] = [
  { source: "API", target: "接口" },
  { source: "cache", target: "缓存" },
  { source: "token", target: "令牌" },
];

describe("applyGlossaryPatch", () => {
  it("merges by updating existing sources in place and appending new ones", () => {
    const result = applyGlossaryPatch(
      base,
      {
        mode: "merge",
        entries: [
          { source: "cache", target: "高速缓存" },
          { source: "queue", target: "队列" },
        ],
      },
      1000,
    );
    assertGlossaryPatch(result);
    expect(result.entries).toEqual([
      { source: "API", target: "接口" },
      { source: "cache", target: "高速缓存" },
      { source: "token", target: "令牌" },
      { source: "queue", target: "队列" },
    ]);
    expect(result.updated).toEqual([
      { source: "cache", target: "高速缓存" },
    ]);
    expect(result.added).toEqual([{ source: "queue", target: "队列" }]);
    expect(result.removed).toEqual([]);
  });

  it("removes sources case-insensitively before applying entries", () => {
    const result = applyGlossaryPatch(
      base,
      {
        mode: "merge",
        remove: ["API", "missing"],
        entries: [{ source: "api", target: "应用程序接口" }],
      },
      1000,
    );
    assertGlossaryPatch(result);
    expect(result.entries).toEqual([
      { source: "cache", target: "缓存" },
      { source: "token", target: "令牌" },
      { source: "api", target: "应用程序接口" },
    ]);
    expect(result.removed).toEqual([]);
    expect(result.added).toEqual([]);
    expect(result.updated).toEqual([
      { source: "api", target: "应用程序接口" },
    ]);
  });

  it("replaces the whole list without reading current entries", () => {
    const result = applyGlossaryPatch(
      base,
      { mode: "replace", entries: [{ source: "docs", target: "文档" }] },
      1000,
    );
    assertGlossaryPatch(result);
    expect(result.entries).toEqual([{ source: "docs", target: "文档" }]);
    expect(result.added).toEqual([{ source: "docs", target: "文档" }]);
    expect(result.removed).toHaveLength(3);
  });

  it("lets the last duplicate input win and reports it", () => {
    const result = applyGlossaryPatch(
      [],
      {
        mode: "merge",
        entries: [
          { source: "API", target: "接口" },
          { source: "api", target: "应用程序接口" },
        ],
      },
      1000,
    );
    assertGlossaryPatch(result);
    expect(result.entries).toEqual([
      { source: "api", target: "应用程序接口" },
    ]);
    expect(result.duplicates).toEqual(["api"]);
  });

  it("rejects invalid entries atomically", () => {
    const result = applyGlossaryPatch(
      base,
      {
        mode: "merge",
        entries: [
          { source: "ok", target: "好" },
          { source: "", target: "空" },
          { source: "x".repeat(201), target: "超长" },
          null,
        ],
      },
      1000,
    );
    expect(result).toEqual({
      ok: false,
      issues: [
        { code: "invalid-entry", index: 2 },
        { code: "invalid-entry", index: 3 },
        { code: "invalid-entry", index: 4 },
      ],
    });
  });

  it("rejects overflow instead of truncating", () => {
    const result = applyGlossaryPatch(
      [{ source: "a", target: "甲" }],
      { mode: "merge", entries: [{ source: "b", target: "乙" }] },
      1,
    );
    expect(result).toEqual({
      ok: false,
      issues: [{ code: "too-many", count: 2, max: 1 }],
    });
  });

  it("rejects remove with replace mode", () => {
    const result = applyGlossaryPatch(
      base,
      { mode: "replace", entries: [], remove: ["API"] },
      1000,
    );
    expect(result).toEqual({
      ok: false,
      issues: [{ code: "remove-with-replace" }],
    });
  });

  it("requires entries for replace mode", () => {
    const result = applyGlossaryPatch(base, { mode: "replace" }, 1000);
    expect(result).toEqual({
      ok: false,
      issues: [{ code: "not-array" }],
    });
  });

  it("rejects malformed remove arrays", () => {
    const notArray = applyGlossaryPatch(
      base,
      { mode: "merge", remove: "API" },
      1000,
    );
    expect(notArray).toEqual({
      ok: false,
      issues: [{ code: "remove-not-array" }],
    });
    const invalid = applyGlossaryPatch(
      base,
      { mode: "merge", remove: ["API", "", 42] },
      1000,
    );
    expect(invalid).toEqual({
      ok: false,
      issues: [
        { code: "invalid-remove", index: 2 },
        { code: "invalid-remove", index: 3 },
      ],
    });
  });

  it("allows a remove-only merge", () => {
    const result = applyGlossaryPatch(
      base,
      { mode: "merge", remove: ["cache"] },
      1000,
    );
    assertGlossaryPatch(result);
    expect(result.entries).toEqual([
      { source: "API", target: "接口" },
      { source: "token", target: "令牌" },
    ]);
    expect(result.removed).toEqual([{ source: "cache", target: "缓存" }]);
  });
});

describe("validateGlossaryEntries", () => {
  it("reports not-array for non-arrays", () => {
    expect(validateGlossaryEntries(undefined, 10)).toEqual({
      entries: [],
      issues: [{ code: "not-array" }],
      duplicates: [],
    });
    expect(validateGlossaryEntries({ source: "a", target: "甲" }, 10)).toEqual({
      entries: [],
      issues: [{ code: "not-array" }],
      duplicates: [],
    });
  });

  it("trims terms and ignores extra object fields", () => {
    const result = validateGlossaryEntries(
      [{ source: "  API  ", target: " 接口 ", note: "ignored" }],
      10,
    );
    expect(result).toEqual({
      entries: [{ source: "API", target: "接口" }],
      issues: [],
      duplicates: [],
    });
  });
});

describe("diffGlossaryEntries", () => {
  it("classifies additions, updates and removals", () => {
    const diff = diffGlossaryEntries(base, [
      { source: "API", target: "应用程序接口" },
      { source: "token", target: "令牌" },
      { source: "queue", target: "队列" },
    ]);
    expect(diff.added).toEqual([{ source: "queue", target: "队列" }]);
    expect(diff.updated).toEqual([
      { source: "API", target: "应用程序接口" },
    ]);
    expect(diff.removed).toEqual([{ source: "cache", target: "缓存" }]);
  });
});

describe("serializeGlossaryFile", () => {
  it("keeps the existing empty-file format", () => {
    expect(serializeGlossaryFile([])).toBe("[]\n");
  });

  it("writes a stable pretty JSON array", () => {
    expect(
      serializeGlossaryFile([{ source: "API", target: "接口" }]),
    ).toBe(`${JSON.stringify([{ source: "API", target: "接口" }], null, 2)}\n`);
  });
});
