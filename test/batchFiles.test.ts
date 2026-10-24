/** 测试：目录批量处理的文件筛选与边界判断。 */
import { describe, expect, it } from "vitest";
import {
  filterBatchMarkdownFiles,
  isFileInsideFolder,
  isTargetExportFile,
} from "../src/batch/batchFiles";

describe("batch file selection", () => {
  it("recognizes target-language export files case-insensitively", () => {
    expect(isTargetExportFile("/docs/guide.zh.md", "zh-CN")).toBe(true);
    expect(isTargetExportFile("/docs/guide.ZH.md", "zh-CN")).toBe(true);
    expect(isTargetExportFile("/docs/guide.en.md", "zh-CN")).toBe(false);
    expect(isTargetExportFile("/docs/guide.ja.md", "ja-JP")).toBe(true);
  });

  it("checks folder containment without prefix false positives", () => {
    expect(isFileInsideFolder("/docs", "/docs/guide.md")).toBe(true);
    expect(isFileInsideFolder("/docs", "/docs/sub/guide.md")).toBe(true);
    expect(isFileInsideFolder("/docs", "/docs-other/guide.md")).toBe(false);
    expect(isFileInsideFolder("/docs", "/docs")).toBe(false);
  });

  it("filters export files and sorts the remaining paths", () => {
    const files = [
      { fsPath: "/docs/b.md" },
      { fsPath: "/docs/a.zh.md" },
      { fsPath: "/docs/a.md" },
    ];
    expect(filterBatchMarkdownFiles(files, "zh-CN").map((file) => file.fsPath)).toEqual([
      "/docs/a.md",
      "/docs/b.md",
    ]);
  });
});
