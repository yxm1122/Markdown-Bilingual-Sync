/** 测试：文档术语表的文本格式解析与序列化。 */
import { describe, expect, it } from "vitest";
import { MAX_DOCUMENT_GLOSSARY_ENTRIES } from "../src/glossary/glossary";
import {
  formatDocumentGlossary,
  parseDocumentGlossaryText,
} from "../src/glossary/documentGlossary";

describe("document glossary text", () => {
  it("round-trips entries and ignores blank/comment lines", () => {
    const entries = [
      { source: "table", target: "表格" },
      { source: "cache", target: "缓存" },
    ];
    expect(formatDocumentGlossary(entries)).toBe(
      "table => 表格\ncache => 缓存",
    );
    expect(
      parseDocumentGlossaryText(
        "\n# comment\ntable => 表格\n\ncache => 缓存\n",
      ),
    ).toEqual({ entries, errorLines: [], overflow: false });
  });

  it("lets the last duplicate source win", () => {
    expect(
      parseDocumentGlossaryText("table => 表格\ntable => 数据表"),
    ).toEqual({
      entries: [{ source: "table", target: "数据表" }],
      errorLines: [],
      overflow: false,
    });
  });

  it("reports invalid lines without throwing", () => {
    expect(
      parseDocumentGlossaryText("table => 表格\ninvalid line\n => 空\n"),
    ).toEqual({
      entries: [{ source: "table", target: "表格" }],
      errorLines: [2, 3],
      overflow: false,
    });
    expect(parseDocumentGlossaryText("a:hover")).toEqual({
      entries: [],
      errorLines: [1],
      overflow: false,
    });
  });

  it("caps entries and reports overflow", () => {
    const lines = Array.from(
      { length: MAX_DOCUMENT_GLOSSARY_ENTRIES + 2 },
      (_, index) => `term-${index} => 术语-${index}`,
    );
    const parsed = parseDocumentGlossaryText(lines.join("\n"));
    expect(parsed.entries).toHaveLength(MAX_DOCUMENT_GLOSSARY_ENTRIES);
    expect(parsed.overflow).toBe(true);
  });
});
