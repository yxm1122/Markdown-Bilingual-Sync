/** 测试：测试共享的示例文档、翻译与对齐工具。 */
import { alignDocument } from "../src/markdown/align";
import { parseCacheDocument } from "../src/markdown/anchors";
import { createMarkdownRuntime } from "../src/markdown/markdown";
import { parseMarkdownDocument } from "../src/markdown/segmenter";
import { syncDocument, type SyncResult } from "../src/sync/sync";
import { MockTranslationProvider } from "../src/translation/mockProvider";

export const SOURCE = [
  "# Heading",
  "",
  "First paragraph.",
  "",
  "- item one",
  "- item two",
  "",
  "```ts",
  "const value = 1;",
  "```",
  "",
].join("\n");

export function makeMd() {
  return createMarkdownRuntime();
}

export async function translate(
  sourceText = SOURCE,
  cacheText?: string,
  retranslateStale = false,
  retranslateAll = false,
): Promise<SyncResult> {
  return syncDocument({
    md: makeMd(),
    sourceText,
    cacheText,
    provider: new MockTranslationProvider(),
    sourceLanguage: "en",
    targetLanguage: "zh-CN",
    retranslateStale,
    retranslateAll,
  });
}

export function inspect(sourceText: string, cacheText: string) {
  const md = makeMd();
  const source = parseMarkdownDocument(sourceText, md);
  const cache = parseCacheDocument(cacheText, md);
  return {
    md,
    source,
    cache,
    alignment: alignDocument(source.blocks, cache),
  };
}
