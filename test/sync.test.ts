/** 测试：同步流程、缓存写入与部分失败语义。 */
import { describe, expect, it } from "vitest";
import { replaceCachedBlock } from "../src/cache/editCache";
import { createDeletedMarker } from "../src/cache/deletedMarker";
import { parseCacheDocument, serializeAnchor } from "../src/markdown/anchors";
import { blockHash } from "../src/util/hash";
import { syncDocument, SyncBlockedError } from "../src/sync/sync";
import { MockTranslationProvider } from "../src/translation/mockProvider";
import type {
  GlossaryEntry,
  TranslationItem,
  TranslationProvider,
} from "../src/translation/types";
import { SOURCE, inspect, makeMd, translate } from "./helpers";

describe("syncDocument", () => {
  it("creates a cache for missing blocks and copies non-translatable blocks", async () => {
    const result = await translate();
    expect(result.translatedCount).toBe(3);
    expect(result.copiedCount).toBe(1);
    expect(result.cacheText).toContain("# 标题");
    expect(result.cacheText).toContain("```ts\nconst value = 1;\n```");
    const { alignment } = inspect(SOURCE, result.cacheText);
    expect(alignment.blocks.map((block) => block.status)).toEqual([
      "translated",
      "translated",
      "translated",
      "copy",
    ]);
  });

  it("keeps stale machine translations when retranslation is disabled", async () => {
    const initial = await translate();
    const changed = SOURCE.replace(
      "First paragraph.",
      "First paragraph changed.",
    );
    const kept = await translate(changed, initial.cacheText, false);
    expect(kept.translatedCount).toBe(0);
    expect(kept.keptMachineStaleCount).toBe(1);
    expect(kept.cacheText).not.toContain("changed.");
    expect(kept.warnings.join("\n")).toContain("保留了旧机器译文");

    const paragraph = inspect(changed, kept.cacheText).alignment.blocks.find(
      (block) => block.source.kind === "paragraph",
    );
    expect(paragraph?.status).toBe("stale");
  });

  it("retranslates only stale blocks when requested", async () => {
    const initial = await translate();
    const changed = SOURCE.replace(
      "First paragraph.",
      "First paragraph changed.",
    );
    const refreshed = await translate(changed, initial.cacheText, true);
    expect(refreshed.translatedCount).toBe(1);
    expect(refreshed.cacheText).toContain("changed.");
    const paragraph = inspect(
      changed,
      refreshed.cacheText,
    ).alignment.blocks.find((block) => block.source.kind === "paragraph");
    expect(paragraph?.status).toBe("translated");
  });

  it("retranslates every machine block when requested", async () => {
    const initial = await translate();
    const refreshed = await translate(
      SOURCE,
      initial.cacheText,
      false,
      true,
    );

    expect(refreshed.translatedCount).toBe(3);
    expect(refreshed.keptMachineStaleCount).toBe(0);
    const beforeIds = inspect(SOURCE, initial.cacheText).cache.blocks.map(
      (block) => block.anchor.id,
    );
    const afterIds = inspect(SOURCE, refreshed.cacheText).cache.blocks.map(
      (block) => block.anchor.id,
    );
    expect(afterIds).toEqual(beforeIds);
  });

  it("retranslates only selected blocks and can unlock human translations", async () => {
    const initial = await translate();
    const before = inspect(SOURCE, initial.cacheText);
    const paragraph = before.alignment.blocks.find(
      (block) => block.source.kind === "paragraph" && block.cache,
    );
    const human = replaceCachedBlock({
      cacheText: initial.cacheText,
      cache: before.cache,
      target: paragraph!.cache!,
      content: "人工译文。",
      sourceHash: paragraph!.source.hash,
      sourceKind: paragraph!.source.kind,
      mode: "human",
      md: before.md,
    });

    const result = await syncDocument({
      md: makeMd(),
      sourceText: SOURCE,
      cacheText: human.text,
      provider: new MockTranslationProvider(),
      sourceLanguage: "en",
      targetLanguage: "zh-CN",
      retranslateStale: false,
      retranslateAll: true,
      allowPartial: true,
      onlySourceIndexes: new Set([paragraph!.source.index]),
      includeHuman: true,
    });

    expect(result.translatedCount).toBe(1);
    expect(result.humanLockedCount).toBe(0);
    const after = inspect(SOURCE, result.cacheText).alignment.blocks.find(
      (block) => block.source.index === paragraph!.source.index,
    );
    expect(after?.cache?.anchor.mode).toBe("auto");
    expect(after?.human).toBe(false);
    expect(result.cacheText).not.toContain("人工译文。");
  });

  it("leaves unselected missing blocks out of a selective sync", async () => {
    const result = await syncDocument({
      md: makeMd(),
      sourceText: SOURCE,
      provider: new MockTranslationProvider(),
      sourceLanguage: "en",
      targetLanguage: "zh-CN",
      retranslateStale: false,
      retranslateAll: true,
      allowPartial: true,
      onlySourceIndexes: new Set([1]),
      includeHuman: true,
    });

    expect(result.translatedCount).toBe(1);
    const statuses = inspect(SOURCE, result.cacheText).alignment.blocks.map(
      (block) => block.status,
    );
    expect(statuses.filter((status) => status === "translated")).toHaveLength(
      1,
    );
    expect(statuses.filter((status) => status === "untranslated")).toHaveLength(
      2,
    );
  });

  it("preserves human-locked blocks when retranslating everything", async () => {
    const initial = await translate();
    const before = inspect(SOURCE, initial.cacheText);
    const paragraph = before.alignment.blocks.find(
      (block) => block.source.kind === "paragraph" && block.cache,
    );
    const edited = replaceCachedBlock({
      cacheText: initial.cacheText,
      cache: before.cache,
      target: paragraph!.cache!,
      content: "人工译文。",
      sourceHash: paragraph!.source.hash,
      sourceKind: paragraph!.source.kind,
      mode: "human",
      md: before.md,
    });

    const result = await translate(SOURCE, edited.text, false, true);

    expect(result.translatedCount).toBe(2);
    expect(result.humanLockedCount).toBe(1);
    expect(result.cacheText).toContain("人工译文。");
  });

  it("never overwrites human-locked blocks", async () => {
    const initial = await translate();
    const before = inspect(SOURCE, initial.cacheText);
    const paragraph = before.alignment.blocks.find(
      (block) => block.source.kind === "paragraph" && block.cache,
    );
    expect(paragraph?.cache).toBeTruthy();
    const edited = replaceCachedBlock({
      cacheText: initial.cacheText,
      cache: before.cache,
      target: paragraph!.cache!,
      content: "人工译文。",
      sourceHash: paragraph!.source.hash,
      sourceKind: paragraph!.source.kind,
      mode: "human",
      md: before.md,
    });

    const changed = SOURCE.replace(
      "First paragraph.",
      "First paragraph changed.",
    );
    const result = await translate(changed, edited.text, true);
    expect(result.humanLockedCount).toBe(1);
    expect(result.cacheText).toContain("人工译文。");

    const after = inspect(changed, result.cacheText).alignment.blocks.find(
      (block) => block.source.kind === "paragraph",
    );
    expect(after?.status).toBe("human-stale");
  });

  it("refreshes copied blocks when the source changes", async () => {
    const initial = await translate();
    const changed = SOURCE.replace("const value = 1;", "const value = 2;");
    const result = await translate(changed, initial.cacheText, false);
    expect(result.translatedCount).toBe(0);
    expect(result.copiedCount).toBe(1);
    expect(result.cacheText).toContain("const value = 2;");
    const code = inspect(changed, result.cacheText).alignment.blocks.find(
      (block) => block.source.kind === "code",
    );
    expect(code?.status).toBe("copy");
  });

  it("keeps stable anchor ids for unchanged blocks", async () => {
    const initial = await translate();
    const first = inspect(SOURCE, initial.cacheText).cache.blocks.map(
      (block) => block.anchor.id,
    );
    const changed = SOURCE.replace(
      "First paragraph.",
      "First paragraph changed.",
    );
    const result = await translate(changed, initial.cacheText, true);
    const second = inspect(changed, result.cacheText).cache.blocks.map(
      (block) => block.anchor.id,
    );
    expect(second).toEqual(first);
  });

  it("does not translate deleted target blocks", async () => {
    const initial = await translate();
    const before = inspect(SOURCE, initial.cacheText);
    const paragraph = before.alignment.blocks.find(
      (block) => block.source.kind === "paragraph" && block.cache,
    );
    const deleted = replaceCachedBlock({
      cacheText: initial.cacheText,
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

    const result = await translate(SOURCE, deleted.text, false);

    expect(result.translatedCount).toBe(0);
    const view = inspect(SOURCE, result.cacheText).alignment.blocks.find(
      (block) => block.source.kind === "paragraph",
    );
    expect(view?.status).toBe("deleted");
    expect(view?.cache?.anchor.mode).toBe("deleted");
    expect(view?.cache?.block.raw).toContain("mbs-deleted:");
  });

  it("preserves target-only cache blocks during sync", async () => {
    const initial = await translate();
    const before = inspect(SOURCE, initial.cacheText);
    const heading = before.alignment.blocks.find(
      (block) => block.source.kind === "heading",
    );
    const targetText = "保留的目标译文。";
    const anchor = serializeAnchor({
      id: "target-1",
      kind: "paragraph",
      src: `t-${heading!.source.hash}`,
      dst: blockHash("paragraph", targetText),
      mode: "target",
    });
    const cacheText = `${initial.cacheText}\n\n${anchor}\n\n${targetText}\n`;

    const result = await translate(SOURCE, cacheText, false);

    expect(result.translatedCount).toBe(0);
    const parsed = parseCacheDocument(result.cacheText, makeMd());
    expect(parsed.targetBlocks).toHaveLength(1);
    expect(parsed.targetBlocks[0].block.raw).toBe(targetText);
    expect(parsed.targetBlocks[0].anchor.mode).toBe("target");
  });

  it("drops legacy deleted target-only cache blocks during sync", async () => {
    const initial = await translate();
    const before = inspect(SOURCE, initial.cacheText);
    const heading = before.alignment.blocks.find(
      (block) => block.source.kind === "heading",
    );
    const marker = createDeletedMarker({
      mode: "target",
      content: "旧的无原文译文。",
      kind: "paragraph",
    });
    const anchor = serializeAnchor({
      id: "target-legacy",
      kind: "html",
      src: `t-${heading!.source.hash}`,
      dst: blockHash("html", marker),
      mode: "target",
    });
    const cacheText = `${initial.cacheText}\n\n${anchor}\n\n${marker}\n`;

    const result = await translate(SOURCE, cacheText, false);

    expect(result.translatedCount).toBe(0);
    const parsed = parseCacheDocument(result.cacheText, makeMd());
    expect(parsed.targetBlocks).toHaveLength(0);
    expect(result.cacheText).not.toContain("target-legacy");
  });

  it("blocks syncing when the cache contains untracked content", async () => {
    const initial = await translate();
    const cacheText = `${initial.cacheText}\n\nUnanchored paragraph.\n`;
    try {
      await translate(SOURCE, cacheText, false);
      throw new Error("expected sync to be blocked");
    } catch (error) {
      expect(error).toBeInstanceOf(SyncBlockedError);
      expect((error as SyncBlockedError).reasons.join("\n")).toContain(
        "未加锚点",
      );
    }
  });

  it("restores inline code that the provider translated", async () => {
    const sourceText = "Use `Translate Current File` now.\n";
    const provider: TranslationProvider = {
      id: "spy",
      label: "Spy",
      async translate(request) {
        return request.items.map((item) => ({
          id: item.id,
          text: item.text
            .replace("Use", "使用")
            .replace("Translate Current File", "翻译当前文件")
            .replace(" now.", "。"),
        }));
      },
    };

    const result = await syncDocument({
      md: makeMd(),
      sourceText,
      provider,
      sourceLanguage: "en",
      targetLanguage: "zh-CN",
      retranslateStale: false,
    });

    expect(result.cacheText).toContain("`Translate Current File`");
    expect(result.cacheText).not.toContain("翻译当前文件");
  });

  it("restores alert markers that the provider translated", async () => {
    const sourceText = "> [!WARNING]\n> Do not deploy during the freeze.\n";
    const provider: TranslationProvider = {
      id: "spy",
      label: "Spy",
      async translate(request) {
        return request.items.map((item) => ({
          id: item.id,
          text: "> [!警告]\n> 冻结期间请勿部署。",
        }));
      },
    };

    const result = await syncDocument({
      md: makeMd(),
      sourceText,
      provider,
      sourceLanguage: "en",
      targetLanguage: "zh-CN",
      retranslateStale: false,
    });

    expect(result.cacheText).toContain("[!WARNING]");
    expect(result.cacheText).not.toContain("[!警告]");
  });

  it("translates footnote definitions and restores their labels", async () => {
    const sourceText =
      "A decision was recorded.[^lock]\n\n[^lock]: Locked translations are never overwritten.\n";
    const provider: TranslationProvider = {
      id: "spy",
      label: "Spy",
      async translate(request) {
        return request.items.map((item) => ({
          id: item.id,
          text:
            item.kind === "footnote"
              ? item.text
                  .replace("[^lock]", "[^锁定]")
                  .replace(
                    "Locked translations are never overwritten.",
                    "已锁定的译文永远不会被覆盖。",
                  )
              : "记录了一项决定。[^lock]",
        }));
      },
    };

    const result = await syncDocument({
      md: makeMd(),
      sourceText,
      provider,
      sourceLanguage: "en",
      targetLanguage: "zh-CN",
      retranslateStale: false,
    });

    expect(result.cacheText).toContain(
      "[^lock]: 已锁定的译文永远不会被覆盖。",
    );
    expect(result.cacheText).not.toContain("[^锁定]");
    const footnote = inspect(sourceText, result.cacheText).alignment.blocks.find(
      (block) => block.source.kind === "footnote",
    );
    expect(footnote?.status).toBe("translated");
    expect(footnote?.translatable).toBe(true);
  });

  it("annotates blocks with document and section ids for batching", async () => {
    const received: TranslationItem[] = [];
    const provider: TranslationProvider = {
      id: "spy",
      label: "Spy",
      async translate(request) {
        received.push(...request.items);
        return request.items.map((item) => ({
          id: item.id,
          text: item.text,
        }));
      },
    };

    await syncDocument({
      md: makeMd(),
      sourceText: "# A\n\nOne.\n\n## B\n\nTwo.\n\nThree.\n",
      provider,
      sourceLanguage: "en",
      targetLanguage: "zh-CN",
      retranslateStale: false,
    });

    expect(received).toHaveLength(5);
    expect(new Set(received.map((item) => item.documentId)).size).toBe(1);
    expect(received[0]?.documentId).toBeTruthy();
    expect(received.map((item) => item.sectionId)).toEqual([
      "section-1",
      "section-1",
      "section-2",
      "section-2",
      "section-2",
    ]);
  });

  it("forwards glossary entries to the provider", async () => {
    const glossary: GlossaryEntry[] = [
      { source: "Heading", target: "标题" },
    ];
    const received: GlossaryEntry[][] = [];
    const provider: TranslationProvider = {
      id: "spy",
      label: "Spy",
      async translate(request) {
        received.push(request.glossary);
        return request.items.map((item) => ({
          id: item.id,
          text: item.text,
        }));
      },
    };
    const result = await syncDocument({
      md: makeMd(),
      sourceText: SOURCE,
      provider,
      sourceLanguage: "en",
      targetLanguage: "zh-CN",
      retranslateStale: false,
      glossary,
    });
    expect(received).toEqual([glossary]);
    expect(result.cacheText).toContain("# Heading");
  });
});
