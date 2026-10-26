/** 测试：译后术语与受保护 Markdown 一致性检查。 */
import { describe, expect, it } from "vitest";
import { replaceCachedBlock } from "../src/cache/editCache";
import { createMarkdownRuntime } from "../src/markdown/markdown";
import { checkDocumentConsistency } from "../src/quality/consistency";
import { syncDocument } from "../src/sync/sync";
import type { TranslationProvider } from "../src/translation/types";
import { inspect, makeMd } from "./helpers";

const SOURCE = [
  "# Table",
  "",
  "The table below uses `code` and [docs](https://example.com/docs).",
  "",
  "> [!WARNING]",
  "> Keep `code` in the note.",
  "",
].join("\n");

const GLOSSARY = [
  { source: "table", target: "表格" },
  { source: "code", target: "代码" },
];

function providerReturning(
  byKind: Record<string, string>,
): TranslationProvider {
  return {
    id: "quality-test",
    label: "Quality test",
    async translate(request) {
      return request.items.map((item) => ({
        id: item.id,
        text: byKind[item.kind] ?? item.text,
      }));
    },
  };
}

async function buildCache(byKind: Record<string, string>): Promise<string> {
  const result = await syncDocument({
    md: makeMd(),
    sourceText: SOURCE,
    provider: providerReturning(byKind),
    sourceLanguage: "en",
    targetLanguage: "zh-CN",
    retranslateStale: false,
  });
  return result.cacheText;
}

describe("checkDocumentConsistency", () => {
  it("reports missing glossary targets and protected Markdown", async () => {
    const cacheText = await buildCache({
      heading: "# 表格",
      paragraph: "下表使用代码并参考文档。",
      // 完全省略 Alert 标记，避免同步层把本地化标记自动还原成 [!WARNING]。
      blockquote: "> 保留代码。",
    });
    const report = checkDocumentConsistency({
      md: makeMd(),
      sourceText: SOURCE,
      cacheText,
      glossary: GLOSSARY,
    });

    expect(report.cacheExists).toBe(true);
    expect(report.checkedBlocks).toBe(3);
    expect(report.skippedHumanBlocks).toBe(0);
    expect(
      report.issues.some(
        (issue) =>
          issue.kind === "glossary" &&
          issue.source === "table" &&
          issue.target === "表格",
      ),
    ).toBe(true);
    expect(
      report.issues.some(
        (issue) => issue.kind === "protected" && issue.token === "`code`",
      ),
    ).toBe(true);
    expect(
      report.issues.some(
        (issue) =>
          issue.kind === "protected" &&
          issue.token === "https://example.com/docs",
      ),
    ).toBe(true);
    expect(
      report.issues.some(
        (issue) =>
          issue.kind === "protected" && issue.token === "[!WARNING]",
      ),
    ).toBe(true);
  });

  it("passes a translation that keeps glossary targets and protected Markdown", async () => {
    const cacheText = await buildCache({
      heading: "# 表格",
      paragraph:
        "下面的表格使用 `code`，并参考[文档](https://example.com/docs)。",
      blockquote: "> [!WARNING]\n> 在备注中保留 `code`。",
    });
    const report = checkDocumentConsistency({
      md: makeMd(),
      sourceText: SOURCE,
      cacheText,
      glossary: GLOSSARY,
    });

    expect(report.issues).toEqual([]);
  });

  it("skips locked human translations", async () => {
    const cacheText = await buildCache({
      heading: "# 表格",
      paragraph: "下表使用代码并参考文档。",
      // 完全省略 Alert 标记，避免同步层把本地化标记自动还原成 [!WARNING]。
      blockquote: "> 保留代码。",
    });
    const view = inspect(SOURCE, cacheText);
    const paragraph = view.alignment.blocks.find(
      (block) => block.source.kind === "paragraph",
    );
    expect(paragraph?.cache).toBeTruthy();
    const edited = replaceCachedBlock({
      cacheText,
      cache: view.cache,
      target: paragraph!.cache!,
      content: "手工译文，不使用术语。",
      sourceHash: paragraph!.source.hash,
      sourceKind: paragraph!.source.kind,
      mode: "human",
      md: view.md,
    });

    const report = checkDocumentConsistency({
      md: createMarkdownRuntime(),
      sourceText: SOURCE,
      cacheText: edited.text,
      glossary: GLOSSARY,
    });

    expect(report.skippedHumanBlocks).toBe(1);
    expect(
      report.issues.every(
        (issue) => issue.blockIndex !== paragraph!.source.index,
      ),
    ).toBe(true);
  });

  it("reports no cache without parsing translations", () => {
    const report = checkDocumentConsistency({
      md: makeMd(),
      sourceText: SOURCE,
      glossary: GLOSSARY,
    });
    expect(report).toEqual({
      cacheExists: false,
      checkedBlocks: 0,
      skippedHumanBlocks: 0,
      issues: [],
    });
  });
});
