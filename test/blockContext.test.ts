/** 测试：单块重译/回译的只读邻块上下文。 */
import { describe, expect, it } from "vitest";
import { parseMarkdownDocument } from "../src/markdown/segmenter";
import { buildBlockContext } from "../src/sync/blockContext";
import { makeMd } from "./helpers";

const SOURCE = [
  "# Title",
  "",
  "First paragraph.",
  "",
  "Second paragraph.",
  "",
  "## Subsection",
  "",
  "Sub paragraph.",
  "",
].join("\n");

function blocks() {
  return parseMarkdownDocument(SOURCE, makeMd()).blocks;
}

describe("buildBlockContext", () => {
  it("takes the following body block for a heading", () => {
    const all = blocks();
    const context = buildBlockContext({
      blocks: all,
      index: 0,
      itemText: all[0].raw,
      textOf: (block) => block.raw,
    });
    expect(context?.before).toBeUndefined();
    expect(context?.after).toEqual([
      { kind: "paragraph", text: "First paragraph." },
    ]);
  });

  it("takes one block before and after for a paragraph", () => {
    const all = blocks();
    const context = buildBlockContext({
      blocks: all,
      index: 1,
      itemText: all[1].raw,
      textOf: (block) => block.raw,
    });
    expect(context?.before).toEqual([
      { kind: "heading", text: "# Title" },
    ]);
    expect(context?.after).toEqual([
      { kind: "paragraph", text: "Second paragraph." },
    ]);
  });

  it("stays inside the section and skips unavailable target blocks", () => {
    const all = blocks();
    const subsection = all.findIndex((block) => block.raw === "## Subsection");
    const context = buildBlockContext({
      blocks: all,
      index: subsection,
      itemText: all[subsection].raw,
      textOf: (block) =>
        block.raw === "Sub paragraph." ? "子段落。" : undefined,
    });
    expect(context?.before).toBeUndefined();
    expect(context?.after).toEqual([
      { kind: "paragraph", text: "子段落。" },
    ]);
  });

  it("omits context for an oversized item or when the token cap is tight", () => {
    const all = blocks();
    expect(
      buildBlockContext({
        blocks: all,
        index: 0,
        itemText: "x".repeat(1000),
        textOf: (block) => block.raw,
        maxTokens: 100,
      }),
    ).toBeUndefined();
    expect(
      buildBlockContext({
        blocks: all,
        index: 1,
        itemText: "short",
        textOf: (block) => block.raw,
        maxTokens: 5,
      }),
    ).toBeUndefined();
  });
});
