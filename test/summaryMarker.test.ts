/** 测试：缓存内全文摘要标记的解析、序列化与源文哈希。 */
import { describe, expect, it } from "vitest";
import { serializeAnchor } from "../src/markdown/anchors";
import { serializeCacheDocument } from "../src/sync/sync";
import { parseCacheDocument } from "../src/markdown/anchors";
import {
  createSummaryMarker,
  parseSummaryMarker,
  summarySourceHash,
} from "../src/cache/summaryMarker";
import { makeMd } from "./helpers";
import { blockHash } from "../src/util/hash";

describe("cache summary marker", () => {
  it("round-trips a summary without exposing it as a block", () => {
    const md = makeMd();
    const anchor = serializeAnchor({
      id: "b1",
      kind: "paragraph",
      src: "src-hash",
      dst: blockHash("paragraph", "译文"),
      mode: "auto",
    });
    const cacheText = serializeCacheDocument(undefined, [
      { anchor: {
        id: "b1",
        kind: "paragraph",
        src: "src-hash",
        dst: blockHash("paragraph", "译文"),
        mode: "auto",
      }, content: "译文" },
    ], {
      text: "这是一段文档摘要。",
      sourceHash: "source-hash",
      updatedAt: "2026-10-24T00:00:00.000Z",
      model: "test-model",
    });

    expect(cacheText).toContain("<!-- mbs-summary:");
    expect(cacheText).toContain(anchor);
    const parsed = parseCacheDocument(cacheText, md);
    expect(parsed.summary).toEqual({
      text: "这是一段文档摘要。",
      sourceHash: "source-hash",
      updatedAt: "2026-10-24T00:00:00.000Z",
      model: "test-model",
    });
    expect(parsed.blocks).toHaveLength(1);
    expect(parsed.untracked).toHaveLength(0);
    expect(parsed.cleanedText).not.toContain("mbs-summary");
  });

  it("strips invalid summary markers with a warning", () => {
    const md = makeMd();
    const parsed = parseCacheDocument(
      "<!-- mbs-summary:not-base64 -->\n\nParagraph\n",
      md,
    );
    expect(parsed.summary).toBeUndefined();
    expect(parsed.untracked).toHaveLength(1);
    expect(parsed.warnings.join("\n")).toContain("摘要标记格式无效");
  });

  it("creates and parses a standalone marker", () => {
    const marker = createSummaryMarker({
      text: "summary",
      sourceHash: "hash",
      updatedAt: "now",
    });
    expect(parseSummaryMarker(marker)?.text).toBe("summary");
    expect(parseSummaryMarker("<!-- mbs-summary: -->")).toBeUndefined();
  });

  it("round-trips a document glossary and drops invalid entries", () => {
    const marker = createSummaryMarker({
      text: "summary",
      sourceHash: "hash",
      updatedAt: "now",
      glossary: [
        { source: "table", target: "表格" },
        { source: "table", target: "数据表" },
        { source: "", target: "空" },
      ],
    });
    expect(parseSummaryMarker(marker)?.glossary).toEqual([
      { source: "table", target: "数据表" },
    ]);
  });

  it("hashes normalized source text stably", () => {
    expect(summarySourceHash("a\r\nb")).toBe(summarySourceHash("a\nb"));
    expect(summarySourceHash("a")).not.toBe(summarySourceHash("b"));
  });
});
