/** 测试：导出 Markdown 的块合并、复制与删除语义。 */
import { describe, expect, it } from "vitest";
import { replaceCachedBlock } from "../src/cache/editCache";
import { createDeletedMarker } from "../src/cache/deletedMarker";
import { serializeAnchor } from "../src/markdown/anchors";
import { blockHash } from "../src/util/hash";
import {
  buildExportFileName,
  buildExportMarkdown,
} from "../src/export/exportMarkdown";
import { makeMd, inspect, translate, SOURCE } from "./helpers";

describe("buildExportFileName", () => {
  it("inserts the language suffix before the Markdown extension", () => {
    expect(buildExportFileName("notes/guide.md", "zh-CN")).toBe(
      "guide.zh.md",
    );
    expect(buildExportFileName("notes/guide.markdown", "zh-Hans")).toBe(
      "guide.zh.markdown",
    );
    expect(buildExportFileName("notes/guide.mdx", "en-US")).toBe(
      "guide.en.mdx",
    );
  });

  it("falls back to .md for other extensions and missing bases", () => {
    expect(buildExportFileName("notes/guide.txt", "zh-CN")).toBe(
      "guide.zh.md",
    );
    expect(buildExportFileName("README", "zh-CN")).toBe("README.zh.md");
  });

  it("rejects a language that cannot produce a safe suffix", () => {
    expect(() => buildExportFileName("guide.md", "中文")).toThrow(
      /targetLanguage/,
    );
    expect(() => buildExportFileName("guide.md", "zh CN")).toThrow(
      /targetLanguage/,
    );
  });
});

describe("buildExportMarkdown", () => {
  it("omits deleted target blocks from export", async () => {
    const result = await translate();
    const before = inspect(SOURCE, result.cacheText);
    const paragraph = before.alignment.blocks.find(
      (block) => block.source.kind === "paragraph" && block.cache,
    );
    const deleted = replaceCachedBlock({
      cacheText: result.cacheText,
      cache: before.cache,
      target: paragraph!.cache!,
      content: createDeletedMarker({
        mode: "auto",
        content: paragraph!.cache!.block.raw,
      }),
      sourceHash: paragraph!.source.hash,
      sourceKind: paragraph!.source.kind,
      mode: "deleted",
      md: before.md,
    });

    const exported = buildExportMarkdown({
      md: makeMd(),
      sourceText: SOURCE,
      cacheText: deleted.text,
    });

    expect(exported.stats.deleted).toBe(1);
    expect(exported.text).not.toContain("First paragraph.");
    expect(exported.warnings.join("\n")).toContain("译文已删除");
  });

  it("omits deleted copy blocks from export", async () => {
    const result = await translate();
    const before = inspect(SOURCE, result.cacheText);
    const code = before.alignment.blocks.find(
      (block) => block.source.kind === "code" && block.cache,
    );
    const deleted = replaceCachedBlock({
      cacheText: result.cacheText,
      cache: before.cache,
      target: code!.cache!,
      content: createDeletedMarker({
        mode: "copy",
        content: code!.cache!.block.raw,
      }),
      sourceHash: code!.source.hash,
      sourceKind: code!.source.kind,
      mode: "deleted",
      md: before.md,
    });

    const exported = buildExportMarkdown({
      md: makeMd(),
      sourceText: SOURCE,
      cacheText: deleted.text,
    });

    expect(exported.stats.deleted).toBe(1);
    expect(exported.text).not.toContain("const value = 1;");
  });

  it("exports translated footnote definitions with their labels", async () => {
    const sourceText =
      "A decision was recorded.[^lock]\n\n[^lock]: Locked translations are safe.\n";
    const result = await translate(sourceText);
    const exported = buildExportMarkdown({
      md: makeMd(),
      sourceText,
      cacheText: result.cacheText,
    });

    expect(result.translatedCount).toBe(2);
    expect(exported.text).toContain("[^lock]:");
    expect(exported.text).not.toContain("Locked translations are safe.");
  });

  it("exports a target-only cache block without modifying the source", async () => {
    const result = await translate();
    const before = inspect(SOURCE, result.cacheText);
    const heading = before.alignment.blocks.find(
      (block) => block.source.kind === "heading",
    );
    const targetText = "新增的独立译文。";
    const anchor = serializeAnchor({
      id: "target-1",
      kind: "paragraph",
      src: `t-${heading!.source.hash}`,
      dst: blockHash("paragraph", targetText),
      mode: "target",
    });
    const exported = buildExportMarkdown({
      md: makeMd(),
      sourceText: SOURCE,
      cacheText: `${result.cacheText}\n\n${anchor}\n\n${targetText}\n`,
    });

    expect(exported.stats.human).toBe(1);
    expect(exported.text).toContain(targetText);
    expect(SOURCE).not.toContain(targetText);
  });

  it("writes translated blocks and source copies without anchors", async () => {
    const result = await translate();
    const exportResult = buildExportMarkdown({
      md: makeMd(),
      sourceText: SOURCE,
      cacheText: result.cacheText,
    });

    expect(exportResult.stats).toEqual({
      translated: 3,
      stale: 0,
      human: 0,
      humanStale: 0,
      copied: 1,
      missing: 0,
      deleted: 0,
    });
    expect(exportResult.text).toContain("# 标题");
    expect(exportResult.text).toContain("const value = 1;");
    expect(exportResult.text).not.toContain("<!-- mbs:");
    expect(exportResult.warnings).toEqual([]);
    expect(exportResult.text.endsWith("\n")).toBe(true);
  });

  it("preserves frontmatter and falls back to source without a cache", () => {
    const sourceText = [
      "---",
      "title: Demo",
      "tags:",
      "  - a",
      "---",
      "",
      "# Heading",
      "",
      "Paragraph.",
      "",
    ].join("\n");
    const exportResult = buildExportMarkdown({
      md: makeMd(),
      sourceText,
    });

    expect(exportResult.text.startsWith("---\ntitle: Demo\ntags:")).toBe(
      true,
    );
    expect(exportResult.text).toContain("# Heading");
    expect(exportResult.stats.missing).toBe(2);
    expect(exportResult.stats.copied).toBe(0);
    expect(exportResult.warnings.join("\n")).toContain("尚未生成译文缓存");
  });

  it("exports stale machine translations with a warning", async () => {
    const initial = await translate();
    const changed = SOURCE.replace(
      "First paragraph.",
      "First paragraph changed.",
    );
    const exportResult = buildExportMarkdown({
      md: makeMd(),
      sourceText: changed,
      cacheText: initial.cacheText,
    });

    expect(exportResult.stats.stale).toBe(1);
    expect(exportResult.stats.translated).toBe(2);
    expect(exportResult.text).toContain("First 段落.");
    expect(exportResult.warnings.join("\n")).toContain("过期");
  });

  it("keeps human-locked content when its source changed", async () => {
    const initial = await translate();
    const state = inspect(SOURCE, initial.cacheText);
    const paragraph = state.alignment.blocks.find(
      (block) => block.source.kind === "paragraph" && block.cache,
    );
    const edited = replaceCachedBlock({
      cacheText: initial.cacheText,
      cache: state.cache,
      target: paragraph!.cache!,
      content: "人工译文。",
      sourceHash: paragraph!.source.hash,
      sourceKind: paragraph!.source.kind,
      mode: "human",
      md: state.md,
    });
    const changed = SOURCE.replace(
      "First paragraph.",
      "First paragraph updated.",
    );
    const exportResult = buildExportMarkdown({
      md: makeMd(),
      sourceText: changed,
      cacheText: edited.text,
    });

    expect(exportResult.text).toContain("人工译文。");
    expect(exportResult.stats.humanStale).toBe(1);
    expect(exportResult.warnings.join("\n")).toContain("译文锁定");
  });

  it("rejects a cache that contains untracked content", () => {
    expect(() =>
      buildExportMarkdown({
        md: makeMd(),
        sourceText: SOURCE,
        cacheText: "没有锚点的译文。\n",
      }),
    ).toThrow(/未加锚点/);
  });
});
