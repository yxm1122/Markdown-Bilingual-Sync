/** 测试：审校批注、用户批注、同步/重译应用与建议回答。 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OutputChannel, Uri } from "vscode";
import {
  SyncService,
  planReviewChunks,
} from "../src/sync/syncService";
import type { CacheStore } from "../src/cache/cacheStore";
import type { GlossaryStore } from "../src/glossary/glossaryStore";
import type {
  ReviewAnnotationDraft,
  ReviewRequest,
  TranslationProvider,
  TranslationRequest,
} from "../src/translation/types";
import { SOURCE, inspect, translate } from "./helpers";

const mocks = vi.hoisted(() => {
  class FakeUri {
    constructor(
      readonly fsPath: string,
      readonly scheme = "file",
    ) {}

    static file(fsPath: string): FakeUri {
      return new FakeUri(fsPath);
    }

    static joinPath(base: FakeUri, ...parts: string[]): FakeUri {
      return new FakeUri(`${base.fsPath}/${parts.join("/")}`);
    }

    toString(): string {
      return `${this.scheme}://${this.fsPath}`;
    }
  }

  const documentState = { text: "" };
  const document = {
    uri: FakeUri.file("/project/demo.md"),
    getText: () => documentState.text,
    isDirty: false,
    async save() {
      return true;
    },
  };
  const annotationFiles = new Map<string, string>();

  const vscode = {
    workspace: {
      getConfiguration() {
        return {
          get(key: string, fallback: unknown) {
            if (key === "sourceLanguage") {
              return "en";
            }
            if (key === "targetLanguage") {
              return "zh-CN";
            }
            return fallback;
          },
        };
      },
      async openTextDocument() {
        return document;
      },
      fs: {
        async readFile(uri: FakeUri) {
          const text = annotationFiles.get(uri.fsPath);
          if (text === undefined) {
            throw { code: "FileNotFound" };
          }
          return new TextEncoder().encode(text);
        },
        async writeFile(uri: FakeUri, bytes: Uint8Array) {
          annotationFiles.set(uri.fsPath, new TextDecoder().decode(bytes));
        },
        async createDirectory() {},
        async rename(from: FakeUri, to: FakeUri) {
          const text = annotationFiles.get(from.fsPath);
          if (text === undefined) {
            throw { code: "FileNotFound" };
          }
          annotationFiles.set(to.fsPath, text);
          annotationFiles.delete(from.fsPath);
        },
        async delete(uri: FakeUri) {
          annotationFiles.delete(uri.fsPath);
        },
      },
    },
    window: {
      async showWarningMessage() {
        return undefined;
      },
    },
    Uri: FakeUri,
  };

  return { vscode, FakeUri, documentState, annotationFiles };
});

vi.mock("vscode", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./vscodeStub")>();
  return { ...actual.vscodeStub, ...mocks.vscode };
});

class FakeCacheStore {
  text?: string;

  getCacheUri(): Uri {
    return mocks.FakeUri.file("/storage/demo.zh.md") as unknown as Uri;
  }

  async read(): Promise<string | undefined> {
    return this.text;
  }

  async write(_uri: Uri, text: string): Promise<void> {
    this.text = text;
  }

  async delete(): Promise<boolean> {
    const existed = this.text !== undefined;
    this.text = undefined;
    return existed;
  }
}

describe("sync annotations", () => {
  let service: SyncService;
  let cacheStore: FakeCacheStore;
  let requests: TranslationRequest[];
  let translateOutput: string | undefined;
  let reviewRequests: ReviewRequest[];
  let reviewDrafts: ReviewAnnotationDraft[];
  let reviewGate: Promise<void> | null;
  let reviewCalled: (() => void) | undefined;

  beforeEach(async () => {
    mocks.documentState.text = SOURCE;
    mocks.annotationFiles.clear();
    const result = await translate();
    cacheStore = new FakeCacheStore();
    cacheStore.text = result.cacheText;
    requests = [];
    translateOutput = undefined;
    reviewRequests = [];
    reviewDrafts = [];
    reviewGate = null;
    reviewCalled = undefined;
    const provider: TranslationProvider = {
      id: "batch:test",
      label: "Test",
      supportsSummary: true,
      supportsReview: true,
      supportsAnnotations: true,
      async translate(request) {
        requests.push(request);
        return request.items.map((item) => ({
          id: item.id,
          text:
            translateOutput ??
            (item.kind === "heading"
              ? `# 回译：${item.id}`
              : `回译：${item.id}`),
        }));
      },
      async summarize(summaryRequest) {
        return {
          summary: `摘要：${summaryRequest.text.split("\n")[0]}`,
          glossary: [],
        };
      },
      async review(request) {
        reviewRequests.push(request);
        reviewCalled?.();
        if (reviewGate) {
          await reviewGate;
        }
        return reviewDrafts;
      },
    };
    const glossaryStore = {
      async load() {
        return { entries: [], warnings: [] };
      },
      async loadFor() {
        return { entries: [], warnings: [] };
      },
    };
    const output = { appendLine: vi.fn() } as unknown as OutputChannel;
    service = new SyncService(
      cacheStore as unknown as CacheStore,
      glossaryStore as unknown as GlossaryStore,
      provider,
      output,
    );
  });

  function paragraph() {
    return inspect(SOURCE, cacheStore.text!).alignment.blocks.find(
      (block) => block.source.kind === "paragraph" && block.cache,
    )!;
  }

  it("reviews a block and replaces only that block's AI annotations", async () => {
    const uri = mocks.FakeUri.file("/project/demo.md") as unknown as Uri;
    const target = paragraph();
    const blockId = target.cache!.anchor.id;

    const user = await service.saveUserAnnotation(uri, target.source.index, {
      side: "target",
      kind: "note",
      message: "This is the operator-facing wording.",
    });
    expect(user).toHaveLength(1);

    reviewDrafts = [
      {
        id: blockId,
        side: "target",
        type: "translation-uncertain",
        severity: "check",
        message: "Verify the tone.",
        question: "Is this too informal?",
      },
    ];
    const first = await service.reviewBlock(uri, target.source.index);
    expect(first.added).toBe(1);
    expect(first.annotations).toHaveLength(2);
    expect(reviewRequests[0].outputLanguage).toBe("zh-CN");
    expect(reviewRequests[0].items[0]).toMatchObject({
      id: blockId,
      sourceText: target.source.raw,
      targetText: target.cache!.block.raw,
    });

    reviewDrafts = [
      {
        id: blockId,
        side: "target",
        type: "term",
        severity: "info",
        message: "Check the term.",
      },
    ];
    const second = await service.reviewBlock(uri, target.source.index);
    expect(second.added).toBe(1);
    expect(second.annotations).toHaveLength(2);
    expect(
      second.annotations.filter((entry) => entry.author === "ai"),
    ).toHaveLength(1);
    expect(
      second.annotations.find((entry) => entry.author === "ai")?.message,
    ).toBe("Check the term.");
    expect(
      second.annotations.some((entry) => entry.author === "user"),
    ).toBe(true);
  });

  it("includes open user annotations when retranslating a block", async () => {
    const uri = mocks.FakeUri.file("/project/demo.md") as unknown as Uri;
    const target = paragraph();
    await service.saveUserAnnotation(uri, target.source.index, {
      side: "target",
      kind: "request-change",
      message: "Use the business sense of “bite”.",
    });

    requests = [];
    await service.retranslateBlock(
      uri,
      target.source.index,
      undefined,
      { stableTranslation: true, summaryContext: false },
    );
    expect(requests[0].items[0].annotations).toEqual([
      {
        author: "user",
        kind: "request-change",
        text: "Use the business sense of “bite”.",
      },
    ]);
    expect(requests[0].items[0].reference).toEqual({
      role: "previous-target",
      text: target.cache!.block.raw,
    });
  });

  it("applies pending one-shot annotations during sync and consumes them", async () => {
    const uri = mocks.FakeUri.file("/project/demo.md") as unknown as Uri;
    const target = paragraph();
    const saved = await service.saveUserAnnotation(uri, target.source.index, {
      side: "target",
      message: "Use the new wording.",
    });

    requests = [];
    const first = await service.sync(
      uri,
      false,
      undefined,
      undefined,
      false,
      { stableTranslation: true, summaryContext: false },
    );
    expect(first.result.translatedCount).toBe(1);
    expect(requests[0].items[0].annotations).toEqual([
      {
        author: "user",
        kind: "request-change",
        text: "Use the new wording.",
      },
    ]);
    expect(requests[0].items[0].reference).toEqual({
      role: "previous-target",
      text: target.cache!.block.raw,
    });

    const preview = await service.loadPreviewState(uri);
    const applied = preview.annotations?.find(
      (entry) => entry.id === saved[0].id,
    );
    expect(applied?.status).toBe("applied");
    expect(applied?.lastAppliedAt).toBeTruthy();

    requests = [];
    const second = await service.sync(
      uri,
      false,
      undefined,
      undefined,
      false,
      { stableTranslation: true, summaryContext: false },
    );
    expect(second.result.translatedCount).toBe(0);
    expect(requests).toHaveLength(0);
  });

  it("keeps persistent annotations active without forcing repeated sync", async () => {
    const uri = mocks.FakeUri.file("/project/demo.md") as unknown as Uri;
    const target = paragraph();
    const saved = await service.saveUserAnnotation(uri, target.source.index, {
      side: "target",
      mode: "persistent",
      message: "Keep this rule.",
    });

    requests = [];
    const first = await service.sync(
      uri,
      false,
      undefined,
      undefined,
      false,
      { stableTranslation: true, summaryContext: false },
    );
    expect(first.result.translatedCount).toBe(1);
    const preview = await service.loadPreviewState(uri);
    expect(
      preview.annotations?.find((entry) => entry.id === saved[0].id)?.status,
    ).toBe("applied");

    requests = [];
    const second = await service.sync(
      uri,
      false,
      undefined,
      undefined,
      false,
      { stableTranslation: true, summaryContext: false },
    );
    expect(second.result.translatedCount).toBe(0);
    expect(requests).toHaveLength(0);

    requests = [];
    await service.retranslateBlock(
      uri,
      target.source.index,
      undefined,
      { stableTranslation: true, summaryContext: false },
    );
    expect(requests[0].items[0].annotations).toEqual([
      {
        author: "user",
        kind: "request-change",
        text: "Keep this rule.",
      },
    ]);
    expect(requests[0].items[0].reference?.role).toBe("previous-target");
    expect(requests[0].items[0].reference?.text).toBeTruthy();
  });

  it("releases one-shot annotations even when the translation is unchanged", async () => {
    const uri = mocks.FakeUri.file("/project/demo.md") as unknown as Uri;
    const target = paragraph();
    const saved = await service.saveUserAnnotation(uri, target.source.index, {
      side: "target",
      message: "This may not change.",
    });
    translateOutput = target.cache!.block.raw;
    requests = [];
    await service.sync(
      uri,
      false,
      undefined,
      undefined,
      false,
      { stableTranslation: true, summaryContext: false },
    );
    translateOutput = undefined;
    const preview = await service.loadPreviewState(uri);
    const result = preview.annotations?.find(
      (entry) => entry.id === saved[0].id,
    );
    expect(result?.status).toBe("ineffective");
    expect(result?.lastAppliedAt).toBeTruthy();
  });

  it("adopts a suggested answer and resolves the AI question atomically", async () => {
    const uri = mocks.FakeUri.file("/project/demo.md") as unknown as Uri;
    const target = paragraph();
    const blockId = target.cache!.anchor.id;
    reviewDrafts = [
      {
        id: blockId,
        side: "target",
        type: "translation-uncertain",
        severity: "check",
        message: "Check the register.",
        question: "Which register should this use?",
        suggestedAnswers: [
          "Use a neutral, professional register.",
          "Match the document brief's tone.",
        ],
      },
    ];
    const reviewed = await service.reviewBlock(uri, target.source.index);
    const ai = reviewed.annotations.find((entry) => entry.author === "ai")!;
    expect(ai.suggestedAnswers).toEqual([
      "Use a neutral, professional register.",
      "Match the document brief's tone.",
    ]);

    const next = await service.saveUserAnnotation(
      uri,
      target.source.index,
      {
        side: ai.side,
        message: ai.suggestedAnswers![0],
        originAnnotationId: ai.id,
        resolveAnnotationId: ai.id,
      },
    );
    const user = next.find((entry) => entry.author === "user")!;
    const resolved = next.find((entry) => entry.id === ai.id)!;
    expect(user.mode).toBe("once");
    expect(user.status).toBe("pending");
    expect(user.originAnnotationId).toBe(ai.id);
    expect(resolved.status).toBe("resolved");
    expect(resolved.answeredBy).toBe(user.id);

    requests = [];
    await service.sync(
      uri,
      false,
      undefined,
      undefined,
      false,
      { stableTranslation: true, summaryContext: false },
    );
    expect(requests[0].items[0].annotations).toEqual([
      {
        author: "user",
        kind: "request-change",
        text: "Use a neutral, professional register.",
      },
    ]);
    expect(requests[0].items[0].reference).toEqual({
      role: "previous-target",
      text: target.cache!.block.raw,
    });

    const reopened = await service.setAnnotationStatus(uri, ai.id, "open");
    const reopenedAi = reopened.find((entry) => entry.id === ai.id)!;
    expect(reopenedAi.status).toBe("open");
    expect(reopenedAi.answeredBy).toBeUndefined();
  });

  it("reviews all machine blocks in chunks and replaces only AI annotations", async () => {
    const uri = mocks.FakeUri.file("/project/demo.md") as unknown as Uri;
    const target = paragraph();
    await service.saveUserAnnotation(uri, target.source.index, {
      side: "target",
      kind: "note",
      message: "Keep this note.",
    });

    reviewDrafts = [];
    const first = await service.reviewBlocks(uri);
    expect(first.reviewed).toBeGreaterThan(1);
    expect(reviewRequests.length).toBeGreaterThan(0);
    expect(reviewRequests.every((request) => request.items.length <= 6)).toBe(
      true,
    );

    const firstId = reviewRequests[0].items[0].id;
    reviewDrafts = [
      {
        id: firstId,
        side: "target",
        type: "translation-uncertain",
        severity: "check",
        message: "Check this block.",
      },
    ];
    const second = await service.reviewBlocks(uri);
    expect(second.added).toBe(1);
    expect(second.annotations.filter((entry) => entry.author === "ai")).toHaveLength(1);
    expect(second.annotations.some((entry) => entry.author === "user")).toBe(
      true,
    );
  });

  it("updates and deletes annotations", async () => {
    const uri = mocks.FakeUri.file("/project/demo.md") as unknown as Uri;
    const target = paragraph();
    const saved = await service.saveUserAnnotation(
      uri,
      target.source.index,
      {
        side: "source",
        kind: "note",
        message: "Check the source wording.",
      },
    );
    const id = saved[0].id;

    const resolved = await service.setAnnotationStatus(
      uri,
      id,
      "resolved",
    );
    expect(resolved[0].status).toBe("resolved");
    const preview = await service.loadPreviewState(uri);
    expect(preview.annotations?.[0].status).toBe("resolved");

    const deleted = await service.deleteAnnotation(uri, id);
    expect(deleted).toEqual([]);
  });

  it("returns no annotations when the reviewer finds no issues", async () => {
    const uri = mocks.FakeUri.file("/project/demo.md") as unknown as Uri;
    reviewDrafts = [];
    const result = await service.reviewBlock(
      uri,
      paragraph().source.index,
    );
    expect(result).toEqual({ annotations: [], added: 0 });
  });

  it("migrates an untranslated-block annotation to the new anchor", async () => {
    const uri = mocks.FakeUri.file("/project/demo.md") as unknown as Uri;
    cacheStore.text = "";
    const target = inspect(SOURCE, "").alignment.blocks.find(
      (block) => block.source.kind === "paragraph",
    )!;
    const saved = await service.saveUserAnnotation(uri, target.source.index, {
      side: "source",
      kind: "request-change",
      mode: "persistent",
      message: "Apply before the first sync.",
    });
    expect(saved[0].blockId.startsWith("src-")).toBe(true);
    expect(saved[0].sourceIndex).toBe(target.source.index);

    await service.sync(uri, false);
    const anchorId = inspect(SOURCE, cacheStore.text!).alignment.blocks.find(
      (block) => block.source.index === target.source.index,
    )?.cache?.anchor.id;
    expect(anchorId).toBeTruthy();
    const preview = await service.loadPreviewState(uri);
    expect(
      preview.annotations?.find((entry) => entry.id === saved[0].id)?.blockId,
    ).toBe(anchorId);

    requests = [];
    await service.retranslateBlock(uri, target.source.index);
    expect(requests[0].items[0].annotations).toEqual([
      {
        author: "user",
        kind: "request-change",
        text: "Apply before the first sync.",
      },
    ]);
  });

  it("rebinds a stale annotation when it is edited", async () => {
    const uri = mocks.FakeUri.file("/project/demo.md") as unknown as Uri;
    const target = paragraph();
    const saved = await service.saveUserAnnotation(uri, target.source.index, {
      side: "target",
      message: "Old instruction.",
    });
    mocks.documentState.text = SOURCE.replace(
      "First paragraph.",
      "First paragraph changed.",
    );

    const updated = await service.updateUserAnnotation(
      uri,
      saved[0].id,
      { message: "Edited instruction." },
    );
    expect(updated[0].status).toBe("pending");
    expect(updated[0].sourceHash).not.toBe(saved[0].sourceHash);

    requests = [];
    await service.sync(
      uri,
      false,
      undefined,
      undefined,
      false,
      { stableTranslation: true, summaryContext: false },
    );
    expect(requests[0].items[0].annotations).toEqual([
      {
        author: "user",
        kind: "request-change",
        text: "Edited instruction.",
      },
    ]);
  });

  it("rebinds by cached anchor when earlier source blocks shift indices", async () => {
    const uri = mocks.FakeUri.file("/project/demo.md") as unknown as Uri;
    const target = paragraph();
    const anchorId = target.cache!.anchor.id;
    const saved = await service.saveUserAnnotation(uri, target.source.index, {
      side: "target",
      message: "Old instruction.",
    });

    mocks.documentState.text = `Inserted paragraph.\n\n${SOURCE}`;
    const updated = await service.updateUserAnnotation(
      uri,
      saved[0].id,
      { message: "Edited instruction." },
    );
    const current = inspect(
      mocks.documentState.text,
      cacheStore.text!,
    ).alignment.blocks.find(
      (block) => block.cache?.anchor.id === anchorId,
    )!;
    expect(updated[0].blockId).toBe(anchorId);
    expect(updated[0].sourceIndex).toBe(current.source.index);
    expect(updated[0].sourceHash).toBe(current.source.hash);
  });

  it("rejects annotations on untranslatable blocks", async () => {
    const uri = mocks.FakeUri.file("/project/demo.md") as unknown as Uri;
    const copy = inspect(SOURCE, cacheStore.text!).alignment.blocks.find(
      (block) => !block.source.translatable,
    )!;
    await expect(
      service.saveUserAnnotation(uri, copy.source.index, {
        side: "target",
        message: "Not applicable.",
      }),
    ).rejects.toThrow(/不参与翻译/);
  });

  it("rejects annotations on deleted translations", async () => {
    const uri = mocks.FakeUri.file("/project/demo.md") as unknown as Uri;
    const target = paragraph();
    await service.deleteTargetBlock(uri, target.source.index);
    await expect(
      service.saveUserAnnotation(uri, target.source.index, {
        side: "target",
        message: "Not applicable.",
      }),
    ).rejects.toThrow(/不参与翻译/);
  });

  it("retranslates hand-edited auto blocks during retranslateAll", async () => {
    const uri = mocks.FakeUri.file("/project/demo.md") as unknown as Uri;
    const target = paragraph();
    const anchorId = target.cache!.anchor.id;
    cacheStore.text = cacheStore.text!.replace(
      target.cache!.block.raw,
      `${target.cache!.block.raw} changed`,
    );
    requests = [];
    await service.retranslateAll(uri);
    expect(
      requests.some((request) =>
        request.items.some((item) => item.id === anchorId),
      ),
    ).toBe(true);
  });

  it("does not count a stale block retranslated by a pending annotation", async () => {
    const uri = mocks.FakeUri.file("/project/demo.md") as unknown as Uri;
    const target = paragraph();
    mocks.documentState.text = SOURCE.replace(
      "First paragraph.",
      "First paragraph changed.",
    );
    await service.saveUserAnnotation(uri, target.source.index, {
      side: "target",
      message: "Apply to the changed source.",
    });
    requests = [];
    const outcome = await service.sync(
      uri,
      false,
      undefined,
      undefined,
      false,
      { stableTranslation: true, summaryContext: false },
    );
    expect(outcome.result.translatedCount).toBe(1);
    expect(outcome.result.keptMachineStaleCount).toBe(0);
  });

  it("rejects a stale annotation save and drops stale instructions", async () => {
    const uri = mocks.FakeUri.file("/project/demo.md") as unknown as Uri;
    const target = paragraph();
    await expect(
      service.saveUserAnnotation(uri, target.source.index, {
        side: "source",
        kind: "note",
        message: "This should not save.",
        expected: { sourceHash: "stale-hash" },
      }),
    ).rejects.toThrow(/原文已更新/);

    await service.saveUserAnnotation(uri, target.source.index, {
      side: "source",
      kind: "request-change",
      message: "Old instruction.",
    });
    mocks.documentState.text = SOURCE.replace(
      "First paragraph.",
      "First paragraph changed.",
    );
    requests = [];
    await service.retranslateBlock(uri, target.source.index);
    expect(requests[0].items[0].annotations).toBeUndefined();
  });

  it("preserves annotations added during review and blocks clear-all", async () => {
    const uri = mocks.FakeUri.file("/project/demo.md") as unknown as Uri;
    const target = paragraph();
    let release!: () => void;
    reviewGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve;
    });
    reviewCalled = started;
    reviewDrafts = [];
    const reviewing = service.reviewBlocks(uri);
    await startedPromise;
    await service.saveUserAnnotation(uri, target.source.index, {
      side: "target",
      kind: "note",
      message: "Added while review is running.",
    });
    await expect(service.clearAllCaches()).rejects.toThrow(/同步或导入/);
    release();
    const result = await reviewing;
    expect(
      result.annotations.some(
        (entry) =>
          entry.author === "user" &&
          entry.message === "Added while review is running.",
      ),
    ).toBe(true);
  });

  it("refuses to review a deleted translation", async () => {
    const uri = mocks.FakeUri.file("/project/demo.md") as unknown as Uri;
    const target = paragraph();
    await service.deleteTargetBlock(uri, target.source.index);
    await expect(
      service.reviewBlock(uri, target.source.index),
    ).rejects.toThrow(/译文/);
  });

  it("runs review chunks concurrently", async () => {
    const paragraphs = Array.from(
      { length: 8 },
      (_, index) => `Paragraph ${index + 1} for concurrent review.`,
    );
    const sourceText = paragraphs.join("\n\n");
    mocks.documentState.text = sourceText;
    cacheStore.text = (await translate(sourceText)).cacheText;
    const uri = mocks.FakeUri.file("/project/demo.md") as unknown as Uri;

    let started = 0;
    let release!: () => void;
    reviewGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let allStarted!: () => void;
    const bothStarted = new Promise<void>((resolve) => {
      allStarted = resolve;
    });
    reviewCalled = () => {
      started += 1;
      if (started === 2) {
        allStarted();
      }
    };
    reviewDrafts = [];
    const reviewing = service.reviewBlocks(uri);
    try {
      await Promise.race([
        bothStarted,
        new Promise<never>((_, reject) => {
          setTimeout(
            () => reject(new Error("review chunks were not concurrent")),
            800,
          );
        }),
      ]);
      expect(reviewRequests).toHaveLength(2);
    } finally {
      release();
    }
    const result = await reviewing;
    expect(result.reviewed).toBe(8);
  });

  it("splits review requests by token budget", () => {
    const item = (id: string, size: number) => ({
      id,
      kind: "paragraph" as const,
      headingPath: [],
      sourceText: "a".repeat(size),
      targetText: "译".repeat(size),
    });
    const chunks = planReviewChunks(
      [item("a", 20_000), item("b", 10), item("c", 10)],
      6,
      6_000,
    );
    expect(chunks.map((chunk) => chunk.map((entry) => entry.id))).toEqual([
      ["a"],
      ["b", "c"],
    ]);
  });
});
