/** 测试：AI 生成术语表的确定性过滤。 */
import { describe, expect, it } from "vitest";
import {
  filterGeneratedGlossary,
  hasAlternativeTarget,
} from "../src/glossary/generatedGlossary";
import {
  containsTerm,
  countTermOccurrences,
} from "../src/util/glossaryMatch";

const SOURCE =
  "The cache stores data. The cache is fast. Use I/O carefully.";

describe("term matching", () => {
  it("matches Latin terms next to CJK without spaces", () => {
    expect(containsTerm("配置cache后使用cache。", "cache")).toBe(true);
    expect(countTermOccurrences("配置cache后使用cache。", "cache")).toBe(2);
    expect(containsTerm("调用API接口", "API")).toBe(true);
  });

  it("uses conservative word forms without matching unrelated words", () => {
    expect(
      countTermOccurrences("cache caching cached caches", "cache"),
    ).toBe(4);
    expect(countTermOccurrences("car card cars", "car")).toBe(2);
  });
});

describe("filterGeneratedGlossary", () => {
  it("keeps usable entries and normalizes whitespace", () => {
    const result = filterGeneratedGlossary(
      [
        { source: " cache ", target: " 缓存 " },
        { source: "I/O", target: "输入/输出" },
      ],
      SOURCE,
    );
    expect(result.entries).toEqual([
      { source: "cache", target: "缓存" },
      { source: "I/O", target: "输入/输出" },
    ]);
    expect(result.dropped).toEqual([]);
  });

  it("drops missing sources, identical targets, and alternatives", () => {
    const result = filterGeneratedGlossary(
      [
        { source: "missing", target: "缺失" },
        { source: "data", target: "data" },
        { source: "cache", target: "缓存 / 高速缓存" },
        { source: "cache", target: "缓存、快取" },
        { source: "cache", target: "缓存 或 快取" },
        { source: "cache", target: "缓存或高速缓存" },
        { source: "cache", target: "缓存；快取" },
      ],
      SOURCE,
    );
    expect(result.entries).toEqual([]);
    expect(result.dropped.map((entry) => entry.reason)).toEqual([
      "missing-source",
      "same-target",
      "alternative-target",
      "alternative-target",
      "alternative-target",
      "alternative-target",
      "alternative-target",
    ]);
  });

  it("keeps a slash target only when the source itself is paired", () => {
    expect(hasAlternativeTarget("I/O", "输入/输出")).toBe(false);
    expect(hasAlternativeTarget("input", "输入/输出")).toBe(true);
    expect(hasAlternativeTarget("I/O", "输入、输出")).toBe(true);
    expect(hasAlternativeTarget("CI", "CI/CD")).toBe(false);
    expect(hasAlternativeTarget("cache", "cache/caching")).toBe(true);
    expect(hasAlternativeTarget("cache", "缓存或高速缓存")).toBe(true);
    expect(hasAlternativeTarget("logical OR operation", "逻辑或运算")).toBe(
      false,
    );
    expect(hasAlternativeTarget("cache", "缓存；快取")).toBe(true);
  });

  it("drops single-occurrence and user-glossary duplicates when requested", () => {
    const result = filterGeneratedGlossary(
      [
        { source: "cache", target: "缓存" },
        { source: "data", target: "数据" },
        { source: "I/O", target: "输入/输出" },
      ],
      SOURCE,
      { minOccurrences: 2, reservedSources: ["data"] },
    );
    expect(result.entries).toEqual([{ source: "cache", target: "缓存" }]);
    expect(result.dropped.map((entry) => entry.reason)).toEqual([
      "user-glossary-duplicate",
      "single-occurrence",
    ]);
  });

  it("drops protected syntax and duplicate sources", () => {
    const result = filterGeneratedGlossary(
      [
        { source: "cache", target: "`缓存`" },
        { source: "cache", target: "https://example.com/cache" },
        { source: "cache", target: "缓存" },
        { source: "cache", target: "快取" },
      ],
      SOURCE,
    );
    expect(result.entries).toEqual([{ source: "cache", target: "缓存" }]);
    expect(result.dropped.map((entry) => entry.reason)).toEqual([
      "protected-syntax",
      "protected-syntax",
      "duplicate-source",
    ]);
  });
});
