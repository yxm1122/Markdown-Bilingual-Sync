/** 测试：已有译文导入的结构校验与锁定。 */
import { describe, expect, it } from "vitest";
import {
  buildImportedCache,
  ImportTranslationError,
} from "../src/import/importTranslation";
import { parseCacheDocument } from "../src/markdown/anchors";
import { SOURCE, inspect, makeMd } from "./helpers";

const TRANSLATION = [
  "# 标题",
  "",
  "第一段。",
  "",
  "- 项目一",
  "- 项目二",
  "",
  "```ts",
  "const value = 1;",
  "```",
  "",
].join("\n");

describe("buildImportedCache", () => {
  it("imports matching blocks as human-locked entries", () => {
    const result = buildImportedCache(SOURCE, TRANSLATION, makeMd());
    expect(result.translatedCount).toBe(3);
    expect(result.copiedCount).toBe(1);

    const state = inspect(SOURCE, result.cacheText);
    expect(state.alignment.blocks.map((block) => block.status)).toEqual([
      "human",
      "human",
      "human",
      "copy",
    ]);
    expect(
      state.alignment.blocks.map((block) => block.cache?.anchor.mode),
    ).toEqual(["human", "human", "human", "copy"]);
    expect(result.cacheText).toContain("# 标题");
    expect(result.cacheText).toContain("第一段。");
  });

  it("rejects files with a different block count", () => {
    expect(() =>
      buildImportedCache(
        SOURCE,
        `${TRANSLATION}\n额外的段落。\n`,
        makeMd(),
      ),
    ).toThrow(/结构一致/);
  });

  it("rejects files whose block kinds do not match", () => {
    const mismatched = TRANSLATION.replace(
      "第一段。",
      "> 这不是段落",
    );
    expect(() => buildImportedCache(SOURCE, mismatched, makeMd())).toThrow(
      /结构不一致/,
    );
  });

  it("rejects cache files that still contain anchors", () => {
    expect(() =>
      buildImportedCache(
        SOURCE,
        `<!-- mbs:{"id":"a","kind":"paragraph","src":"b","dst":"c","mode":"human"} -->\n\n${TRANSLATION}`,
        makeMd(),
      ),
    ).toThrow(/缓存文件/);
  });

  it("uses the source frontmatter instead of the translation frontmatter", () => {
    const source = ["---", "title: Source", "---", "", "Body.", ""].join("\n");
    const translation = [
      "---",
      "title: Translation",
      "---",
      "",
      "正文。",
      "",
    ].join("\n");
    const result = buildImportedCache(source, translation, makeMd());
    expect(result.cacheText).toContain("title: Source");
    expect(result.cacheText).not.toContain("title: Translation");

    const parsed = parseCacheDocument(result.cacheText, makeMd());
    expect(parsed.frontmatter?.raw).toContain("title: Source");
    expect(parsed.blocks).toHaveLength(1);
    expect(parsed.blocks[0].anchor.mode).toBe("human");
  });

  it("reports a clear error for empty translations", () => {
    expect(() =>
      buildImportedCache("Body.", "", makeMd()),
    ).toThrow(ImportTranslationError);
  });
});
