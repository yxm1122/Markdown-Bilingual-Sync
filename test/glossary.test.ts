/** 测试：术语表 JSON 解析、去重与警告。 */
import { describe, expect, it } from "vitest";
import {
  mergeGlossaryResults,
  parseGlossaryText,
  prioritizeGlossaryEntries,
} from "../src/glossary/glossary";

describe("parseGlossaryText", () => {
  it("parses a JSON array and trims terms", () => {
    const result = parseGlossaryText(
      '[{"source":" API ","target":" 接口 "},{"source":"cache","target":"缓存"}]',
    );
    expect(result.entries).toEqual([
      { source: "API", target: "接口" },
      { source: "cache", target: "缓存" },
    ]);
    expect(result.warnings).toEqual([]);
  });

  it("accepts an entries wrapper object", () => {
    const result = parseGlossaryText(
      '{"entries":[{"source":"token","target":"令牌"}]}',
    );
    expect(result.entries).toEqual([{ source: "token", target: "令牌" }]);
  });

  it("rejects invalid JSON and unsupported shapes", () => {
    expect(() => parseGlossaryText("{oops")).toThrow(/不是有效的 JSON/);
    expect(() => parseGlossaryText('{"items":[]}')).toThrow(/JSON 数组/);
    expect(() => parseGlossaryText('"text"')).toThrow(/JSON 数组/);
  });

  it("skips malformed entries with warnings", () => {
    const result = parseGlossaryText(
      JSON.stringify([
        { source: "valid", target: "有效" },
        null,
        { source: 42, target: "数字" },
        { source: "missing-target" },
        { source: "x".repeat(201), target: "超长" },
      ]),
    );
    expect(result.entries).toEqual([{ source: "valid", target: "有效" }]);
    expect(result.warnings).toHaveLength(4);
    expect(result.warnings[1]).toContain("第 3 项");
  });

  it("deduplicates case-insensitively with the last entry winning", () => {
    const result = parseGlossaryText(
      JSON.stringify([
        { source: "API", target: "接口" },
        { source: "api", target: "应用程序接口" },
      ]),
    );
    expect(result.entries).toEqual([
      { source: "api", target: "应用程序接口" },
    ]);
    expect(result.warnings.join("\n")).toContain("重复");
  });

  it("merges scoped glossaries with later scopes overriding earlier ones", () => {
    const result = mergeGlossaryResults([
      {
        label: "glossary.json",
        result: {
          entries: [
            { source: "API", target: "接口" },
            { source: "cache", target: "缓存" },
          ],
          warnings: ["global warning"],
        },
      },
      {
        label: ".mbs-glossary.json",
        result: {
          entries: [{ source: "api", target: "API 端点" }],
          warnings: ["project warning"],
        },
      },
      {
        label: "guide.mbs-glossary.json",
        result: {
          entries: [{ source: "cache", target: "高速缓存" }],
          warnings: [],
        },
      },
    ]);

    expect(result.entries).toEqual([
      { source: "api", target: "API 端点" },
      { source: "cache", target: "高速缓存" },
    ]);
    expect(result.warnings).toContain("glossary.json: global warning");
    expect(result.warnings).toContain(".mbs-glossary.json: project warning");
  });

  it("prioritizes document terms without changing their values", () => {
    const entries = [
      { source: "api", target: "接口" },
      { source: "cache", target: "缓存" },
      { source: "table", target: "表格" },
    ];
    expect(
      prioritizeGlossaryEntries(entries, ["table", "API"]),
    ).toEqual([
      { source: "api", target: "接口" },
      { source: "table", target: "表格" },
      { source: "cache", target: "缓存" },
    ]);
  });

  it("caps entries at 1000", () => {
    const many = Array.from({ length: 1005 }, (_, index) => ({
      source: `term-${index}`,
      target: `术语-${index}`,
    }));
    const result = parseGlossaryText(JSON.stringify(many));
    expect(result.entries).toHaveLength(1000);
    expect(result.warnings.join("\n")).toContain("最多支持 1000 条");
  });
});
