/** 测试：预览术语表纯模型。 */
import { describe, expect, it } from "vitest";
import {
  canonicalGlossaryText,
  cleanGlossaryText,
  parseGlossaryRows,
  serializeGlossaryRows,
  validateGlossaryRows,
} from "../../src/webview/preview/glossaryModel";

describe("glossary table model", () => {
  it("parses comments, empty placeholders, and invalid lines", () => {
    const parsed = parseGlossaryRows(
      "# comment\n\ntable => 表格\n => \nmissing separator\ncode=>代码",
    );
    expect(parsed.rows).toEqual([
      { source: "table", target: "表格" },
      { source: "", target: "" },
      { source: "code", target: "代码" },
    ]);
    expect(parsed.invalidLines).toEqual([5]);
  });

  it("serializes and drops only empty placeholder rows when saving", () => {
    const rows = [
      { source: " table ", target: " 表格 " },
      { source: "", target: "" },
      { source: "code", target: "代码" },
    ];
    expect(serializeGlossaryRows(rows)).toBe(
      "table => 表格\n => \ncode => 代码",
    );
    expect(serializeGlossaryRows(rows, true)).toBe(
      "table => 表格\ncode => 代码",
    );
    expect(cleanGlossaryText("table => 表格\n => ")).toBe("table => 表格");
  });

  it("flags one-sided rows, long terms, duplicates, and overflow", () => {
    const rows = [
      { source: "table", target: "表格" },
      { source: "Table", target: "数据表" },
      { source: "only-source", target: "" },
      { source: "x".repeat(201), target: "y" },
    ];
    const validation = validateGlossaryRows(rows);
    expect(validation.count).toBe(4);
    expect(validation.invalidRows).toEqual(new Set([2, 3]));
    expect(validation.duplicateRows).toEqual(new Set([0, 1]));
    expect(validation.hasErrors).toBe(true);

    const tooMany = Array.from({ length: 201 }, (_, index) => ({
      source: `term-${index}`,
      target: `术语-${index}`,
    }));
    expect(validateGlossaryRows(tooMany).tooMany).toBe(true);
  });

  it("canonicalizes duplicates with the last value in first position", () => {
    expect(
      canonicalGlossaryText(
        "# comment\ntable => 表格\ncode => 代码\nTABLE => 数据表\n => ",
      ),
    ).toBe("TABLE => 数据表\ncode => 代码");
  });
});
