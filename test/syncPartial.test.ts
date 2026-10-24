/** 测试：同步部分成功时的渐进式缓存持久化。 */
import { describe, expect, it } from "vitest";
import { syncDocument, type SyncOptions } from "../src/sync/sync";
import type { TranslationProvider } from "../src/translation/types";
import { SOURCE, inspect, makeMd, translate } from "./helpers";

function partialProvider(): TranslationProvider {
  return {
    id: "partial",
    label: "Partial",
    async translate(request, _signal, _onProgress, onChunk) {
      const first = request.items[0];
      await onChunk?.(
        [{ id: first.id, text: "# 部分译文" }],
        1,
        request.items.length,
      );
      throw new Error("第二批翻译失败");
    },
  };
}

function options(
  provider: TranslationProvider,
  extra: Partial<SyncOptions> = {},
): SyncOptions {
  return {
    md: makeMd(),
    sourceText: SOURCE,
    provider,
    sourceLanguage: "en",
    targetLanguage: "zh-CN",
    retranslateStale: false,
    ...extra,
  };
}

describe("partial sync", () => {
  it("keeps successful chunks when a later chunk fails", async () => {
    const writes: string[] = [];
    const result = await syncDocument(
      options(partialProvider(), {
        allowPartial: true,
        onCacheCommit: async (cacheText) => {
          writes.push(cacheText);
        },
      }),
    );

    expect(result.partial).toBe(true);
    expect(result.translatedCount).toBe(1);
    expect(result.failedTaskCount).toBe(2);
    expect(result.failures.join("\n")).toContain("第二批翻译失败");
    expect(writes.length).toBeGreaterThan(0);
    expect(writes[writes.length - 1]).toContain("部分译文");
    expect(result.cacheText).toContain("部分译文");

    const statuses = inspect(SOURCE, result.cacheText).alignment.blocks.map(
      (block) => block.status,
    );
    expect(statuses).toEqual([
      "translated",
      "untranslated",
      "untranslated",
      "copy",
    ]);
  });

  it("lets the next sync fill only the missing blocks", async () => {
    const partial = await syncDocument(
      options(partialProvider(), { allowPartial: true }),
    );

    const completed = await translate(SOURCE, partial.cacheText, false);
    const statuses = inspect(SOURCE, completed.cacheText).alignment.blocks.map(
      (block) => block.status,
    );
    expect(statuses).toEqual(["translated", "translated", "translated", "copy"]);
    expect(completed.translatedCount).toBe(2);
  });

  it("serializes concurrent chunk callbacks", async () => {
    const provider: TranslationProvider = {
      id: "concurrent",
      label: "Concurrent",
      async translate(request, _signal, _progress, onChunk) {
        const results = request.items.map((item) => ({
          id: item.id,
          text:
            item.kind === "heading"
              ? "# 并发译文"
              : item.kind === "list"
                ? "- 并发译文"
                : "并发译文。",
        }));
        await Promise.all(
          results.map((result, index) =>
            onChunk?.([result], index + 1, results.length),
          ),
        );
        return results;
      },
    };

    const result = await syncDocument(
      options(provider, {
        allowPartial: true,
        onCacheCommit: async () => {},
      }),
    );

    expect(result.partial).toBe(false);
    expect(result.failedTaskCount).toBe(0);
    expect(
      inspect(SOURCE, result.cacheText).alignment.blocks.map(
        (block) => block.status,
      ),
    ).toEqual(["translated", "translated", "translated", "copy"]);
  });

  it("throws when no chunk succeeds", async () => {
    const provider: TranslationProvider = {
      id: "failing",
      label: "Failing",
      async translate() {
        throw new Error("完全失败");
      },
    };
    await expect(
      syncDocument(options(provider, { allowPartial: true })),
    ).rejects.toThrow(/完全失败/);
  });

  it("remains strict when partial mode is disabled", async () => {
    await expect(syncDocument(options(partialProvider()))).rejects.toThrow(
      /第二批翻译失败/,
    );
  });
});
