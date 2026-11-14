/** 测试：逐批译文快照回调（预览即时显示通道）。 */
import { describe, expect, it } from "vitest";
import { syncDocument, type SyncOptions } from "../src/sync/sync";
import type { TranslationProvider } from "../src/translation/types";
import { SOURCE, inspect, makeMd } from "./helpers";

function textFor(kind: string): string {
  if (kind === "heading") {
    return "# 标题译";
  }
  if (kind === "list") {
    return "- 列表译";
  }
  return "第一段译。";
}

/** 先交付标题，再交付段落与列表；用于验证每批都有完整缓存快照。 */
function chunkedProvider(): TranslationProvider {
  return {
    id: "chunked",
    label: "Chunked",
    async translate(request, _signal, _onProgress, onChunk) {
      const results = request.items.map((item) => ({
        id: item.id,
        text: textFor(item.kind),
      }));
      const first = results.slice(0, 1);
      await onChunk?.(first, first.length, results.length);
      const rest = results.slice(1);
      await onChunk?.(rest, results.length, results.length);
      return results;
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

describe("sync cache progress", () => {
  it("emits a complete cache snapshot after each provider chunk", async () => {
    const snapshots: string[] = [];
    const provider = chunkedProvider();

    const result = await syncDocument(
      options(provider, {
        onCacheProgress: (cacheText) => {
          snapshots.push(cacheText);
        },
      }),
    );

    expect(snapshots).toHaveLength(2);
    expect(snapshots[0]).toContain("标题译");
    expect(snapshots[0]).not.toContain("第一段译");
    expect(snapshots[1]).toContain("标题译");
    expect(snapshots[1]).toContain("第一段译");
    expect(snapshots[1]).toBe(result.cacheText);
    expect(
      inspect(SOURCE, snapshots[1] ?? "").alignment.blocks.map(
        (block) => block.status,
      ),
    ).toEqual(["translated", "translated", "translated", "copy"]);
  });

  it("works without partial mode and never lets callback errors break sync", async () => {
    const provider = chunkedProvider();
    let calls = 0;

    const result = await syncDocument(
      options(provider, {
        onCacheProgress: () => {
          calls += 1;
          throw new Error("预览回调失败");
        },
      }),
    );

    expect(calls).toBe(2);
    expect(result.failedTaskCount).toBe(0);
    expect(result.cacheText).toContain("第一段译");
  });
});
