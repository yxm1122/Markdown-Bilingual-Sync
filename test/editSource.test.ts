/** 测试：原文编辑/删除/插入暂存的行级写回构建。 */
import { describe, expect, it } from "vitest";
import { parseMarkdownDocument } from "../src/markdown/segmenter";
import {
  buildProposedSource,
  type SourceStage,
} from "../src/source/editSource";
import { SOURCE, makeMd } from "./helpers";

function blockByKind(kind: string) {
  const md = makeMd();
  const parsed = parseMarkdownDocument(SOURCE, md);
  const block = parsed.blocks.find((item) => item.kind === kind);
  if (!block) {
    throw new Error(`missing ${kind} block`);
  }
  return { md, block };
}

function stage(
  edits: SourceStage["edits"] = new Map(),
  deletions: SourceStage["deletions"] = new Set(),
  insertions: SourceStage["insertions"] = [],
): SourceStage {
  return { edits, deletions, insertions };
}

describe("buildProposedSource", () => {
  it("replaces a single block and keeps the rest of the document", () => {
    const { md, block } = blockByKind("paragraph");
    const proposed = buildProposedSource(
      SOURCE,
      stage(
        new Map([
          [
            block.index,
            { text: "First paragraph edited.", sourceHash: block.hash },
          ],
        ]),
      ),
      md,
    );

    expect(proposed.changedBlocks).toBe(1);
    expect(proposed.text).toContain("First paragraph edited.");
    expect(proposed.text).not.toContain("\nFirst paragraph.\n");
    expect(proposed.text).toContain("- item one");
    expect(proposed.text).toContain("```ts\nconst value = 1;\n```");
  });

  it("applies multiple edits from bottom to top without shifting", () => {
    const md = makeMd();
    const parsed = parseMarkdownDocument(SOURCE, md);
    const heading = parsed.blocks.find((item) => item.kind === "heading")!;
    const list = parsed.blocks.find((item) => item.kind === "list")!;
    const proposed = buildProposedSource(
      SOURCE,
      stage(
        new Map([
          [
            heading.index,
            {
              text: "# Updated heading\n\nExtra line.",
              sourceHash: heading.hash,
            },
          ],
          [
            list.index,
            { text: "- only one item", sourceHash: list.hash },
          ],
        ]),
      ),
      md,
    );

    expect(proposed.changedBlocks).toBe(2);
    expect(proposed.text).toContain("# Updated heading\n\nExtra line.");
    expect(proposed.text).toContain("- only one item");
    expect(proposed.text).not.toContain("- item two");
  });

  it("deletes a block and preserves surrounding separators", () => {
    const { md, block } = blockByKind("paragraph");
    const proposed = buildProposedSource(
      SOURCE,
      stage(new Map(), new Set([block.index])),
      md,
    );

    expect(proposed.changedBlocks).toBe(1);
    expect(proposed.text).not.toContain("First paragraph.");
    expect(proposed.text).toContain("# Heading");
    expect(proposed.text).toContain("- item one");
  });

  it("inserts a block after the target block", () => {
    const { md, block } = blockByKind("heading");
    const proposed = buildProposedSource(
      SOURCE,
      stage(new Map(), new Set(), [
        {
          id: "insert-1",
          afterIndex: block.index,
          text: "Inserted paragraph.",
        },
      ]),
      md,
    );

    expect(proposed.changedBlocks).toBe(1);
    expect(proposed.text).toContain(
      "# Heading\n\nInserted paragraph.\n\nFirst paragraph.",
    );
  });

  it("keeps multiple insertions after the same block in order", () => {
    const { md, block } = blockByKind("heading");
    const proposed = buildProposedSource(
      SOURCE,
      stage(new Map(), new Set(), [
        { id: "a", afterIndex: block.index, text: "First inserted." },
        { id: "b", afterIndex: block.index, text: "Second inserted." },
      ]),
      md,
    );

    expect(proposed.text).toContain(
      "# Heading\n\nFirst inserted.\n\nSecond inserted.\n\nFirst paragraph.",
    );
  });

  it("inserts at the beginning of the document", () => {
    const { md } = blockByKind("paragraph");
    const proposed = buildProposedSource(
      SOURCE,
      stage(new Map(), new Set(), [
        { id: "start", afterIndex: -1, text: "# Intro" },
      ]),
      md,
    );

    expect(proposed.text.startsWith("# Intro\n\n# Heading")).toBe(true);
  });

  it("rejects edits for stale blocks", () => {
    const { md, block } = blockByKind("paragraph");
    expect(() =>
      buildProposedSource(
        SOURCE,
        stage(
          new Map([[block.index, { text: "Changed.", sourceHash: "stale" }]]),
        ),
        md,
      ),
    ).toThrow(/原文已变化/);
  });

  it("rejects editing and deleting the same block", () => {
    const { md, block } = blockByKind("paragraph");
    expect(() =>
      buildProposedSource(
        SOURCE,
        stage(
          new Map([
            [block.index, { text: "Changed.", sourceHash: block.hash }],
          ]),
          new Set([block.index]),
        ),
        md,
      ),
    ).toThrow(/同时被修改和删除/);
  });

  it("rejects inserting after a deleted block", () => {
    const { md, block } = blockByKind("paragraph");
    expect(() =>
      buildProposedSource(
        SOURCE,
        stage(new Map(), new Set([block.index]), [
          { id: "x", afterIndex: block.index, text: "New block" },
        ]),
        md,
      ),
    ).toThrow(/已被标记删除/);
  });

  it("rejects empty source edits", () => {
    const { md, block } = blockByKind("paragraph");
    expect(() =>
      buildProposedSource(
        SOURCE,
        stage(
          new Map([[block.index, { text: "  ", sourceHash: block.hash }]]),
        ),
        md,
      ),
    ).toThrow(/不能为空/);
  });

  it("returns the original text when there are no changes", () => {
    const { md } = blockByKind("paragraph");
    const proposed = buildProposedSource(SOURCE, stage(), md);
    expect(proposed.changedBlocks).toBe(0);
    expect(proposed.text).toBe(SOURCE);
  });
});
