/** 测试：导出差异预览的行级 diff 与截断。 */
import { describe, expect, it } from "vitest";
import { buildExportDiff } from "../src/export/diffPreview";

describe("buildExportDiff", () => {
  it("shows a new file as added lines", () => {
    const diff = buildExportDiff("", "a\nb\n");

    expect(diff.added).toBe(2);
    expect(diff.removed).toBe(0);
    expect(diff.rows).toHaveLength(2);
    expect(diff.rows.every((row) => row.left === null)).toBe(true);
    expect(diff.rows.map((row) => row.right?.lineNumber)).toEqual([1, 2]);
  });

  it("pairs removed and added lines in change rows", () => {
    const diff = buildExportDiff(
      "a\nb\nc\n",
      "a\nB\nc\n",
    );

    expect(diff.added).toBe(1);
    expect(diff.removed).toBe(1);
    expect(diff.rows.map((row) => row.kind)).toEqual([
      "context",
      "change",
      "context",
    ]);
    expect(diff.rows[1].left).toEqual({ lineNumber: 2, text: "b" });
    expect(diff.rows[1].right).toEqual({ lineNumber: 2, text: "B" });
  });

  it("keeps independent line numbers after insertions", () => {
    const diff = buildExportDiff("a\nb\nc\n", "a\nX\nb\nc\n");

    expect(diff.rows).toHaveLength(4);
    expect(diff.rows[1].left).toBeNull();
    expect(diff.rows[1].right).toEqual({ lineNumber: 2, text: "X" });
    expect(diff.rows[2].left?.lineNumber).toBe(2);
    expect(diff.rows[2].right?.lineNumber).toBe(3);
    expect(diff.rows[3].left?.lineNumber).toBe(3);
    expect(diff.rows[3].right?.lineNumber).toBe(4);
  });

  it("collapses long unchanged runs", () => {
    const before = Array.from({ length: 18 }, (_, index) => `line ${index}`);
    const after = [...before];
    after[8] = "changed";
    const diff = buildExportDiff(
      `${before.join("\n")}\n`,
      `${after.join("\n")}\n`,
    );

    const collapsed = diff.rows.filter((row) => row.kind === "collapsed");
    expect(collapsed).toHaveLength(2);
    expect(collapsed.map((row) => row.hidden)).toEqual([2, 3]);
  });

  it("falls back to a coarse diff and caps rendered rows", () => {
    const before = Array.from(
      { length: 1500 },
      (_, index) => `before ${index}`,
    ).join("\n");
    const after = Array.from(
      { length: 1500 },
      (_, index) => `after ${index}`,
    ).join("\n");
    const diff = buildExportDiff(`${before}\n`, `${after}\n`);

    expect(diff.coarse).toBe(true);
    expect(diff.added).toBe(1500);
    expect(diff.removed).toBe(1500);
    expect(diff.truncated).toBeGreaterThan(0);
    expect(diff.rows.at(-1)?.kind).toBe("truncated");
  });
});
