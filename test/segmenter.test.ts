/** 测试：Markdown 顶层语义块切分。 */
import { describe, expect, it } from "vitest";
import { createMarkdownRuntime } from "../src/markdown/markdown";
import { parseMarkdownDocument } from "../src/markdown/segmenter";

const DOCUMENT = [
  "---",
  "title: Demo",
  "---",
  "",
  "# Heading",
  "",
  "Paragraph.",
  "",
  "- one",
  "- two",
  "",
  "> [!NOTE]",
  "> Alert",
  "",
  "| a | b |",
  "| --- | --- |",
  "| 1 | 2 |",
  "",
  "$$",
  "x^2",
  "$$",
  "",
  "```ts",
  "const x = 1;",
  "```",
  "",
  "[^1]: note",
  "",
].join("\n");

describe("parseMarkdownDocument", () => {
  const parsed = parseMarkdownDocument(DOCUMENT, createMarkdownRuntime());

  it("separates frontmatter from body blocks", () => {
    expect(parsed.frontmatter?.raw).toContain("title: Demo");
    expect(parsed.blocks.some((block) => block.raw.includes("title:"))).toBe(
      false,
    );
  });

  it("classifies top-level semantic blocks", () => {
    expect(parsed.blocks.map((block) => block.kind)).toEqual([
      "heading",
      "paragraph",
      "list",
      "blockquote",
      "table",
      "math",
      "code",
      "footnote",
    ]);
  });

  it("excludes trailing blank lines from block ranges", () => {
    const list = parsed.blocks.find((block) => block.kind === "list");
    expect(list?.startLine).toBe(8);
    expect(list?.endLine).toBe(10);
    expect(list?.raw).toBe("- one\n- two");
  });

  it("excludes trailing blank lines before a cache anchor", () => {
    const text = "- one\n- two\n\n<!-- mbs:anchor -->\n\n# Next\n";
    const result = parseMarkdownDocument(text, createMarkdownRuntime());
    expect(result.blocks[0]).toMatchObject({
      kind: "list",
      startLine: 0,
      endLine: 2,
    });
  });

  it("marks only semantic prose blocks as translatable", () => {
    const byKind = new Map(
      parsed.blocks.map((block) => [block.kind, block.translatable]),
    );
    expect(byKind.get("heading")).toBe(true);
    expect(byKind.get("list")).toBe(true);
    expect(byKind.get("table")).toBe(true);
    expect(byKind.get("blockquote")).toBe(true);
    expect(byKind.get("math")).toBe(false);
    expect(byKind.get("code")).toBe(false);
    expect(byKind.get("footnote")).toBe(true);
  });

  it("recognizes standalone math instead of a paragraph", () => {
    const result = parseMarkdownDocument(
      "$$\nx^2\n$$",
      createMarkdownRuntime(),
    );
    expect(result.blocks).toHaveLength(1);
    expect(result.blocks[0].kind).toBe("math");
  });
});
