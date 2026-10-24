/** 测试：同步流程、缓存写入与部分失败语义。 */
import { describe, expect, it } from "vitest";
import { replaceCachedBlock } from "../src/cache/editCache";
import { createDeletedMarker } from "../src/cache/deletedMarker";
import { parseCacheDocument, serializeAnchor } from "../src/markdown/anchors";
import { blockHash } from "../src/util/hash";
import { syncDocument, SyncBlockedError } from "../src/sync/sync";
import type {
  GlossaryEntry,
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
