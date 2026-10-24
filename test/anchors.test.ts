/** 测试：块锚点解析、序列化与删除标记。 */
import { describe, expect, it } from "vitest";
import { parseCacheDocument } from "../src/markdown/anchors";
import { createMarkdownRuntime } from "../src/markdown/markdown";
import { parseMarkdownDocument } from "../src/markdown/segmenter";
import { serializeAnchor } from "../src/markdown/anchors";
import { translate } from "./helpers";

function anchorText(id: string, index: number): string {
  return serializeAnchor({
    id,
    kind: "paragraph",
    src: `source-${index}`,
    dst: `target-${index}`,
    mode: "auto",
  });
}

describe("parseCacheDocument", () => {
  it("associates anchors with the following block", async () => {
    const result = await translate();
    const md = createMarkdownRuntime();
    const cache = parseCacheDocument(result.cacheText, md);
    const source = parseMarkdownDocument(
      "# Heading\n\nFirst paragraph.\n\n- item one\n- item two\n\n```ts\nconst value = 1;\n```\n",
      md,
    );
    expect(cache.blocks).toHaveLength(source.blocks.length);
    expect(cache.untracked).toHaveLength(0);
    expect(cache.orphanAnchors).toHaveLength(0);
    expect(cache.warnings).toHaveLength(0);
    cache.blocks.forEach((entry, index) => {
      expect(entry.anchor.kind).toBe(source.blocks[index].kind);
      expect(entry.anchor.src).toBe(source.blocks[index].hash);
      expect(entry.anchor.dst).toBe(entry.block.hash);
    });
    expect(cache.cleanedText).not.toContain("mbs:");
  });

  it("reports extra anchors as orphans", () => {
    const text = [
      anchorText("keep", 1),
      anchorText("orphan", 2),
      "",
      "Hello.",
    ].join("\n");
    const cache = parseCacheDocument(text, createMarkdownRuntime());
    expect(cache.blocks).toHaveLength(1);
    expect(cache.blocks[0].anchor.id).toBe("orphan");
    expect(cache.orphanAnchors.map((anchor) => anchor.id)).toEqual(["keep"]);
    expect(cache.warnings.join("\n")).toContain("锚点找不到对应译文块");
  });

  it("reports trailing anchors without a block", () => {
    const text = [
      "Hello.",
      "",
      anchorText("trailing", 1),
    ].join("\n");
    const cache = parseCacheDocument(text, createMarkdownRuntime());
    expect(cache.blocks).toHaveLength(0);
    expect(cache.untracked).toHaveLength(1);
    expect(cache.orphanAnchors.map((anchor) => anchor.id)).toEqual([
      "trailing",
    ]);
  });

  it("warns about malformed anchors instead of trusting them", () => {
    const cache = parseCacheDocument(
      "<!-- mbs:{not-json} -->\n\nHello.",
      createMarkdownRuntime(),
    );
    expect(cache.blocks).toHaveLength(0);
    expect(cache.warnings.join("\n")).toContain("锚点格式无效");
  });

  it("warns about duplicate anchor ids", () => {
    const text = [
      anchorText("same", 1),
      "",
      "First.",
      "",
      anchorText("same", 2),
      "",
      "Second.",
    ].join("\n");
    const cache = parseCacheDocument(text, createMarkdownRuntime());
    expect(cache.blocks).toHaveLength(1);
    expect(cache.blocks[0].anchor.id).toBe("same");
    expect(cache.untracked.length).toBeGreaterThan(0);
    expect(cache.warnings.join("\n")).toContain("重复的锚点 id");
  });
});
