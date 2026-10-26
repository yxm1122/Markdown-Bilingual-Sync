/** 测试：跨文件翻译请求合并与结果路由。 */
import { describe, expect, it } from "vitest";
import { BatchTranslationCoordinator } from "../src/translation/batchCoordinator";
import type {
  TranslationChunkHandler,
  TranslationItem,
  TranslationProgress,
  TranslationProvider,
  TranslationRequest,
} from "../src/translation/types";

function item(id: string, text: string): TranslationItem {
  return { id, text, kind: "paragraph", headingPath: ["Guide"] };
}

function request(items: TranslationItem[]): TranslationRequest {
  return {
    sourceLanguage: "en",
    targetLanguage: "zh-CN",
    items,
    glossary: [],
  };
}

describe("BatchTranslationCoordinator", () => {
  it("coalesces concurrent calls from different files into one request", async () => {
    const calls: TranslationRequest[] = [];
    const delegate: TranslationProvider = {
      id: "fake",
      label: "Fake",
      async translate(requested, _signal, _progress, onChunk) {
        calls.push(requested);
        const results = requested.items.map((entry) => ({
          id: entry.id,
          text: `译:${entry.text}`,
        }));
        await onChunk?.(results, results.length, requested.items.length);
        return results;
      },
    };
    const coordinator = new BatchTranslationCoordinator(delegate, {
      flushDelayMs: 0,
    });
    const progressA: Array<[number, number]> = [];
    const progressB: Array<[number, number]> = [];
    const chunksA: string[] = [];
    const chunksB: string[] = [];
    const onChunkA: TranslationChunkHandler = (items) => {
      chunksA.push(...items.map((entry) => entry.id));
    };
    const onChunkB: TranslationChunkHandler = (items) => {
      chunksB.push(...items.map((entry) => entry.id));
    };

    const [a, b] = await Promise.all([
      coordinator.translate(
        request([item("a1", "A1"), item("a2", "A2")]),
        undefined,
        (completed, total) => progressA.push([completed, total]),
        onChunkA,
      ),
      coordinator.translate(
        request([item("b1", "B1"), item("b2", "B2")]),
        undefined,
        (completed, total) => progressB.push([completed, total]),
        onChunkB,
      ),
    ]);

    expect(calls).toHaveLength(1);
    expect(calls[0].items).toHaveLength(4);
    expect(calls[0].items.map((entry) => entry.text)).toEqual([
      "A1",
      "A2",
      "B1",
      "B2",
    ]);
    expect(a.map((entry) => entry.id)).toEqual(["a1", "a2"]);
    expect(b.map((entry) => entry.id)).toEqual(["b1", "b2"]);
    expect(chunksA).toEqual(["a1", "a2"]);
    expect(chunksB).toEqual(["b1", "b2"]);
    expect(progressA[progressA.length - 1]).toEqual([2, 2]);
    expect(progressB[progressB.length - 1]).toEqual([2, 2]);
  });

  it("assigns distinct document ids when merging calls without metadata", async () => {
    const calls: TranslationRequest[] = [];
    const delegate: TranslationProvider = {
      id: "fake",
      label: "Fake",
      async translate(requested) {
        calls.push(requested);
        return requested.items.map((entry) => ({
          id: entry.id,
          text: `译:${entry.text}`,
        }));
      },
    };
    const coordinator = new BatchTranslationCoordinator(delegate, {
      flushDelayMs: 0,
    });

    await Promise.all([
      coordinator.translate(request([item("a1", "A1"), item("a2", "A2")])),
      coordinator.translate(request([item("b1", "B1"), item("b2", "B2")])),
    ]);

    expect(calls).toHaveLength(1);
    const documentIds = calls[0].items.map((entry) => entry.documentId);
    expect(documentIds.every(Boolean)).toBe(true);
    expect(documentIds[0]).toBe(documentIds[1]);
    expect(documentIds[2]).toBe(documentIds[3]);
    expect(documentIds[0]).not.toBe(documentIds[2]);
  });

  it("does not coalesce calls with different document summaries", async () => {
    const calls: TranslationRequest[] = [];
    const delegate: TranslationProvider = {
      id: "fake",
      label: "Fake",
      async translate(requested, _signal, _progress, onChunk) {
        calls.push(requested);
        const results = requested.items.map((entry) => ({
          id: entry.id,
          text: `译:${entry.text}`,
        }));
        await onChunk?.(results, results.length, requested.items.length);
        return results;
      },
    };
    const coordinator = new BatchTranslationCoordinator(delegate, {
      flushDelayMs: 0,
    });

    await Promise.all([
      coordinator.translate({
        ...request([item("a1", "A1")]),
        summary: "摘要 A",
      }),
      coordinator.translate({
        ...request([item("b1", "B1")]),
        summary: "摘要 B",
      }),
    ]);

    expect(calls).toHaveLength(2);
    expect(calls.map((entry) => entry.summary).sort()).toEqual([
      "摘要 A",
      "摘要 B",
    ]);
  });

  it("coalesces calls that share the same document summary", async () => {
    const calls: TranslationRequest[] = [];
    const delegate: TranslationProvider = {
      id: "fake",
      label: "Fake",
      async translate(requested, _signal, _progress, onChunk) {
        calls.push(requested);
        const results = requested.items.map((entry) => ({
          id: entry.id,
          text: `译:${entry.text}`,
        }));
        await onChunk?.(results, results.length, requested.items.length);
        return results;
      },
    };
    const coordinator = new BatchTranslationCoordinator(delegate, {
      flushDelayMs: 0,
    });
    const assisted = (id: string) => ({
      ...request([item(id, id)]),
      summary: "共享摘要",
    });

    await Promise.all([
      coordinator.translate(assisted("a1")),
      coordinator.translate(assisted("b1")),
    ]);

    expect(calls).toHaveLength(1);
    expect(calls[0].summary).toBe("共享摘要");
    expect(calls[0].items).toHaveLength(2);
  });

  it("forwards summary requests without coalescing", async () => {
    const delegate: TranslationProvider = {
      id: "summary",
      label: "Summary",
      supportsSummary: true,
      async translate() {
        return [];
      },
      async summarize(request) {
        return { summary: `摘要：${request.text}`, glossary: [] };
      },
    };
    const coordinator = new BatchTranslationCoordinator(delegate, {
      flushDelayMs: 0,
    });

    expect(coordinator.supportsSummary).toBe(true);
    await expect(
      coordinator.summarize({
        text: "全文",
        sourceLanguage: "en",
        targetLanguage: "zh-CN",
      }),
    ).resolves.toEqual({ summary: "摘要：全文", glossary: [] });
  });

  it("rejects summary generation when the delegate does not support it", async () => {
    const delegate: TranslationProvider = {
      id: "plain",
      label: "Plain",
      async translate() {
        return [];
      },
    };
    const coordinator = new BatchTranslationCoordinator(delegate, {
      flushDelayMs: 0,
    });

    expect(coordinator.supportsSummary).toBe(false);
    await expect(
      coordinator.summarize({
        text: "全文",
        sourceLanguage: "en",
        targetLanguage: "zh-CN",
      }),
    ).rejects.toThrow(/不支持自动生成全文摘要/);
  });

  it("routes partial results and rejects only the calls with missing blocks", async () => {
    const delegate: TranslationProvider = {
      id: "partial",
      label: "Partial",
      async translate(requested, _signal, _progress, onChunk) {
        const first = requested.items[0];
        await onChunk?.(
          [{ id: first.id, text: "部分译文" }],
          1,
          requested.items.length,
        );
        throw new Error("后续批次失败");
      },
    };
    const coordinator = new BatchTranslationCoordinator(delegate, {
      flushDelayMs: 0,
    });
    const completed: string[] = [];

    const first = coordinator.translate(
      request([item("a1", "A1")]),
      undefined,
      undefined,
      (items) => {
        completed.push(...items.map((entry) => entry.id));
      },
    );
    const second = coordinator.translate(
      request([item("b1", "B1")]),
      undefined,
    );

    await expect(first).resolves.toEqual([
      { id: "a1", text: "部分译文" },
    ]);
    await expect(second).rejects.toThrow(/后续批次失败/);
    expect(completed).toEqual(["a1"]);
  });

  it("rejects a queued call when it is cancelled before flush", async () => {
    let delegateCalls = 0;
    const delegate: TranslationProvider = {
      id: "fake",
      label: "Fake",
      async translate(requested, _signal, _progress, onChunk) {
        delegateCalls += 1;
        const results = requested.items.map((entry) => ({
          id: entry.id,
          text: "译",
        }));
        await onChunk?.(results, results.length, requested.items.length);
        return results;
      },
    };
    const coordinator = new BatchTranslationCoordinator(delegate, {
      flushDelayMs: 20,
    });
    const controller = new AbortController();

    const pending = coordinator.translate(
      request([item("a1", "A1")]),
      controller.signal,
    );
    controller.abort();

    await expect(pending).rejects.toThrow(/已取消/);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(delegateCalls).toBe(0);
  });
});
