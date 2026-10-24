/** 测试：SyncService 的译文编辑、删除与回译。 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OutputChannel, Uri } from "vscode";
import { SyncService } from "../src/sync/syncService";
import { parseCacheDocument } from "../src/markdown/anchors";
import { parseMarkdownDocument } from "../src/markdown/segmenter";
import type { CacheStore } from "../src/cache/cacheStore";
import type { GlossaryStore } from "../src/glossary/glossaryStore";
import type {
  TranslationProvider,
  TranslationRequest,
} from "../src/translation/types";
import { SOURCE, inspect, makeMd, translate } from "./helpers";

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
    },
    window: {
      async showWarningMessage() {
        return undefined;
      },
    },
    Uri: FakeUri,
  };

  return { vscode, FakeUri, documentState };
});

vi.mock("vscode", () => mocks.vscode);

class FakeCacheStore {
  text?: string;
  writes = 0;

  getCacheUri(): Uri {
    return mocks.FakeUri.file("/storage/demo.zh.md") as unknown as Uri;
  }

  async read(): Promise<string | undefined> {
    return this.text;
  }

  async write(_uri: Uri, text: string): Promise<void> {
    this.text = text;
    this.writes += 1;
  }
}

describe("SyncService block editing and back-translation", () => {
  let service: SyncService;
  let cacheStore: FakeCacheStore;
  let requests: TranslationRequest[];

  beforeEach(async () => {
    mocks.documentState.text = SOURCE;
    const result = await translate();
    cacheStore = new FakeCacheStore();
    cacheStore.text = result.cacheText;
    requests = [];
    const provider: TranslationProvider = {
      id: "test",
      label: "Test",
      async translate(request) {
        requests.push(request);
        return request.items.map((item) => ({
          id: item.id,
          text: `回译：${item.text}`,
        }));
      },
    };
    const glossaryStore = {
      async load() {
        return { entries: [], warnings: [] };
      },
    };
    const output = {
      appendLine: vi.fn(),
    } as unknown as OutputChannel;
    service = new SyncService(
      cacheStore as unknown as CacheStore,
      glossaryStore as unknown as GlossaryStore,
      provider,
      output,
    );
  });

  it("saves a target edit as a human-locked block", async () => {
    const paragraph = inspect(SOURCE, cacheStore.text!).alignment.blocks.find(
      (block) => block.source.kind === "paragraph",
    );
    expect(paragraph?.cache).toBeTruthy();

    await service.saveTargetEdit(
      mocks.FakeUri.file("/project/demo.md") as unknown as Uri,
      paragraph!.source.index,
      "人工译文。",
    );

    expect(cacheStore.writes).toBe(1);
    const view = inspect(SOURCE, cacheStore.text!).alignment.blocks.find(
      (block) => block.source.kind === "paragraph",
    );
    expect(view?.status).toBe("human");
    expect(view?.cache?.block.raw).toContain("人工译文。");
  });

  it("rejects a stale target edit instead of locking old content", async () => {
    const paragraph = inspect(SOURCE, cacheStore.text!).alignment.blocks.find(
      (block) => block.source.kind === "paragraph",
    );
    const before = cacheStore.text;

    await expect(
      service.saveTargetEdit(
        mocks.FakeUri.file("/project/demo.md") as unknown as Uri,
        paragraph!.source.index,
        "过期编辑。",
        { baseText: "旧译文内容" },
      ),
    ).rejects.toThrow(/译文已更新/);

    expect(cacheStore.writes).toBe(0);
    expect(cacheStore.text).toBe(before);
  });

  it("returns the written cache text for immediate preview rendering", async () => {
    const paragraph = inspect(SOURCE, cacheStore.text!).alignment.blocks.find(
      (block) => block.source.kind === "paragraph",
    );

    const written = await service.saveTargetEdit(
      mocks.FakeUri.file("/project/demo.md") as unknown as Uri,
      paragraph!.source.index,
      "即时预览译文。",
    );

    expect(written).toContain("即时预览译文。");
    expect(cacheStore.text).toBe(written);
  });

  it("persists partial results through SyncService", async () => {
    const store = new FakeCacheStore();
    store.text = undefined;
    const provider: TranslationProvider = {
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
    const partialService = new SyncService(
      store as unknown as CacheStore,
      {
        async load() {
          return { entries: [], warnings: [] };
        },
      } as unknown as GlossaryStore,
      provider,
      { appendLine: vi.fn() } as unknown as OutputChannel,
    );

    const outcome = await partialService.sync(
      mocks.FakeUri.file("/project/demo.md") as unknown as Uri,
      false,
      undefined,
      undefined,
      true,
    );

    expect(outcome.result.partial).toBe(true);
    expect(outcome.result.failedTaskCount).toBe(2);
    expect(store.writes).toBeGreaterThan(0);
    expect(store.text).toContain("部分译文");
    expect(
      inspect(SOURCE, store.text!).alignment.blocks.map(
        (block) => block.status,
      ),
    ).toEqual(["translated", "untranslated", "untranslated", "copy"]);
  });

  it("attaches a target-only draft to the newly written source block", async () => {
    const inserted = "## Inserted source";
    mocks.documentState.text = `${SOURCE.trimEnd()}\n\n${inserted}\n`;

    const written = await service.attachTargetDrafts(
      mocks.FakeUri.file("/project/demo.md") as unknown as Uri,
      [
        {
          targetText: "人工新增译文。",
          generatedSourceText: inserted,
        },
      ],
    );

    expect(written).toBeTruthy();
    const view = inspect(
      mocks.documentState.text,
      written!,
    ).alignment.blocks.find(
      (block) =>
        block.source.kind === "heading" &&
        block.source.raw === inserted,
    );
    expect(view?.status).toBe("human");
    expect(view?.cache?.block.raw).toBe("人工新增译文。");
    expect(view?.cache?.anchor.mode).toBe("human");
  });

  it("adds, updates and removes target-only cache blocks", async () => {
    const heading = inspect(SOURCE, cacheStore.text!).alignment.blocks.find(
      (block) => block.source.kind === "heading",
    );

    const afterInsert = await service.insertTargetBlock(
      mocks.FakeUri.file("/project/demo.md") as unknown as Uri,
      heading!.source.index,
      "新增译文。",
    );
    const inserted = parseCacheDocument(afterInsert, makeMd()).targetBlocks;
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({
      anchor: {
        kind: "paragraph",
        src: `t-${heading!.source.hash}`,
        mode: "target",
      },
      block: { raw: "新增译文。" },
    });
    const id = inserted[0].anchor.id;

    const afterUpdate = await service.updateTargetBlock(
      mocks.FakeUri.file("/project/demo.md") as unknown as Uri,
      id,
      "## 新标题",
    );
    const updated = parseCacheDocument(afterUpdate, makeMd()).targetBlocks;
    expect(updated[0].anchor.kind).toBe("heading");
    expect(updated[0].block.raw).toBe("## 新标题");

    const afterRemove = await service.removeTargetBlock(
      mocks.FakeUri.file("/project/demo.md") as unknown as Uri,
      id,
    );
    expect(parseCacheDocument(afterRemove, makeMd()).targetBlocks).toHaveLength(0);
  });

  it("back-translates and promotes a target-only cache block", async () => {
    const md = makeMd();
    const sourceDoc = parseMarkdownDocument(SOURCE, md);
    const heading = sourceDoc.blocks.find(
      (block) => block.kind === "heading",
    )!;
    const uri = mocks.FakeUri.file("/project/demo.md") as unknown as Uri;
    const cacheText = await service.insertTargetBlock(
      uri,
      heading.index,
      "新增译文。",
    );
    const target = parseCacheDocument(cacheText, md).targetBlocks[0];

    const generated = await service.backTranslateTargetBlock(
      uri,
      target.anchor.id,
    );

    expect(generated.afterIndex).toBe(heading.index);
    expect(requests[0].items[0].text).toBe("新增译文。");
    const generatedBlock = parseMarkdownDocument(generated.text, md).blocks[0];
    const lines = SOURCE.split("\n");
    lines.splice(heading.endLine, 0, "", generated.text);
    mocks.documentState.text = lines.join("\n");
    const promoted = await service.promoteTargetBlock(
      uri,
      target.anchor.id,
      generated.text,
    );

    const view = inspect(mocks.documentState.text, promoted).alignment.blocks.find(
      (block) => block.source.hash === generatedBlock.hash,
    );
    expect(view?.status).toBe("human");
    expect(view?.cache?.anchor.mode).toBe("human");
    expect(view?.cache?.block.raw).toBe("新增译文。");
  });

  it("permanently deletes a target-only cache block", async () => {
    const heading = inspect(SOURCE, cacheStore.text!).alignment.blocks.find(
      (block) => block.source.kind === "heading",
    );
    const uri = mocks.FakeUri.file("/project/demo.md") as unknown as Uri;
    const insertedText = await service.insertTargetBlock(
      uri,
      heading!.source.index,
      "新增译文。",
    );
    const targetId = parseCacheDocument(
      insertedText,
      makeMd(),
    ).targetBlocks[0].anchor.id;

    const deleted = await service.deleteTargetOnlyBlock(uri, targetId);
    const remaining = parseCacheDocument(deleted, makeMd());
    expect(remaining.targetBlocks).toHaveLength(0);
    expect(deleted).not.toContain("mbs-deleted:");
  });

  it("deletes a target while keeping the anchor and a deleted marker", async () => {
    const paragraph = inspect(SOURCE, cacheStore.text!).alignment.blocks.find(
      (block) => block.source.kind === "paragraph",
    );

    const written = await service.deleteTargetBlock(
      mocks.FakeUri.file("/project/demo.md") as unknown as Uri,
      paragraph!.source.index,
    );

    const view = inspect(SOURCE, written).alignment.blocks.find(
      (block) => block.source.kind === "paragraph",
    );
    expect(view?.status).toBe("deleted");
    expect(view?.cache?.anchor.mode).toBe("deleted");
    expect(view?.cache?.block.raw).toContain("mbs-deleted:");
  });

  it("restores a deleted translation on undo", async () => {
    const before = inspect(SOURCE, cacheStore.text!).alignment.blocks.find(
      (block) => block.source.kind === "paragraph",
    );
    const original = before!.cache!.block.raw;
    const uri = mocks.FakeUri.file("/project/demo.md") as unknown as Uri;

    const deleted = await service.deleteTargetBlock(
      uri,
      before!.source.index,
    );
    expect(
      inspect(SOURCE, deleted).alignment.blocks.find(
        (block) => block.source.kind === "paragraph",
      )?.status,
    ).toBe("deleted");

    const restored = await service.undoDeleteTargetBlock(
      uri,
      before!.source.index,
    );
    const view = inspect(SOURCE, restored).alignment.blocks.find(
      (block) => block.source.kind === "paragraph",
    );
    expect(view?.status).toBe("translated");
    expect(view?.cache?.block.raw).toBe(original);
  });

  it("deletes a never-translated block and removes the marker on undo", async () => {
    cacheStore.text = undefined;
    const paragraph = inspect(SOURCE, cacheStore.text ?? "").alignment.blocks.find(
      (block) => block.source.kind === "paragraph",
    );
    const uri = mocks.FakeUri.file("/project/demo.md") as unknown as Uri;

    const deleted = await service.deleteTargetBlock(
      uri,
      paragraph!.source.index,
    );
    const deletedView = inspect(SOURCE, deleted).alignment.blocks.find(
      (block) => block.source.kind === "paragraph",
    );
    expect(deletedView?.status).toBe("deleted");

    const restored = await service.undoDeleteTargetBlock(
      uri,
      paragraph!.source.index,
    );
    const restoredView = inspect(SOURCE, restored).alignment.blocks.find(
      (block) => block.source.kind === "paragraph",
    );
    expect(restoredView?.status).toBe("untranslated");
  });

  it("allows deleting and undoing a copied code block", async () => {
    const code = inspect(SOURCE, cacheStore.text!).alignment.blocks.find(
      (block) => block.source.kind === "code",
    );
    const original = code!.cache!.block.raw;
    const uri = mocks.FakeUri.file("/project/demo.md") as unknown as Uri;

    const deleted = await service.deleteTargetBlock(uri, code!.source.index);
    const deletedView = inspect(SOURCE, deleted).alignment.blocks.find(
      (block) => block.source.kind === "code",
    );
    expect(deletedView?.status).toBe("deleted");

    const restored = await service.undoDeleteTargetBlock(
      uri,
      code!.source.index,
    );
    const restoredView = inspect(SOURCE, restored).alignment.blocks.find(
      (block) => block.source.kind === "code",
    );
    expect(restoredView?.status).toBe("copy");
    expect(restoredView?.cache?.block.raw).toBe(original);
  });

  it("back-translates a target-only draft text", async () => {
    const result = await service.backTranslateTargetText(
      mocks.FakeUri.file("/project/demo.md") as unknown as Uri,
      "这是一段新增译文。",
    );

    expect(requests).toHaveLength(1);
    expect(requests[0].sourceLanguage).toBe("zh-CN");
    expect(requests[0].targetLanguage).toBe("en");
    expect(requests[0].items[0].text).toBe("这是一段新增译文。");
    expect(result).toContain("回译：");
  });

  it("back-translates a target block without writing the cache", async () => {
    const paragraph = inspect(SOURCE, cacheStore.text!).alignment.blocks.find(
      (block) => block.source.kind === "paragraph" && block.cache,
    );
    const targetText = paragraph!.cache!.block.raw;
    const writes = cacheStore.writes;

    const result = await service.backTranslateBlock(
      mocks.FakeUri.file("/project/demo.md") as unknown as Uri,
      paragraph!.source.index,
    );

    expect(requests).toHaveLength(1);
    expect(requests[0].sourceLanguage).toBe("zh-CN");
    expect(requests[0].targetLanguage).toBe("en");
    expect(requests[0].items[0].text).toBe(targetText);
    expect(result.backText).toContain("回译：");
    expect(result.sourceText).toBe(paragraph!.source.raw);
    expect(result.sourceHash).toBe(paragraph!.source.hash);
    expect(result.cacheId).toBe(paragraph!.cache!.anchor.id);
    expect(cacheStore.writes).toBe(writes);
  });

  it("locks a back-translated source block to its cached translation", async () => {
    const paragraph = inspect(SOURCE, cacheStore.text!).alignment.blocks.find(
      (block) => block.source.kind === "paragraph" && block.cache,
    )!;
    const targetText = paragraph.cache!.block.raw;
    const rephrased = "First paragraph rephrased.";
    const nextSourceText = SOURCE.replace("First paragraph.", rephrased);
    mocks.documentState.text = nextSourceText;
    const uri = mocks.FakeUri.file("/project/demo.md") as unknown as Uri;

    const locked = await service.lockCachedBlockToSource(
      uri,
      paragraph.cache!.anchor.id,
      rephrased,
      paragraph.source.index,
    );

    expect(locked).toBeTruthy();
    const view = inspect(nextSourceText, locked!).alignment.blocks.find(
      (block) => block.source.kind === "paragraph",
    );
    expect(view?.status).toBe("human");
    expect(view?.cache?.anchor.mode).toBe("human");
    expect(view?.cache?.anchor.src).toBe(view?.source.hash);
    expect(view?.cache?.block.raw).toBe(targetText);
  });

  it("detaches translations of deleted source blocks from normal alignment", async () => {
    const baseline = inspect(SOURCE, cacheStore.text!);
    const paragraph = baseline.alignment.blocks.find(
      (block) => block.source.kind === "paragraph",
    )!;
    const code = baseline.alignment.blocks.find(
      (block) => block.source.kind === "code",
    )!;
    const paragraphTranslation = paragraph.cache!.block.raw;
    const sourceDoc = parseMarkdownDocument(SOURCE, makeMd());
    const remaining =
      sourceDoc.blocks
        .filter(
          (block) =>
            block.index !== paragraph.source.index &&
            block.index !== code.source.index,
        )
        .map((block) => block.raw)
        .join("\n\n") + "\n";
    mocks.documentState.text = remaining;
    const uri = mocks.FakeUri.file("/project/demo.md") as unknown as Uri;

    const cacheText = await service.detachDeletedSourceBlocks(uri, SOURCE, [
      paragraph.source.index,
      code.source.index,
    ]);

    expect(cacheText).toBeTruthy();
    const cache = parseCacheDocument(cacheText!, makeMd());
    expect(cache.blocks).toHaveLength(2);
    expect(cache.targetBlocks).toHaveLength(1);
    const detached = cache.targetBlocks[0];
    expect(detached.anchor.mode).toBe("target");
    expect(detached.anchor.src).toBe(`t-${sourceDoc.blocks[0].hash}`);
    expect(detached.block.raw).toBe(paragraphTranslation);
    expect(inspect(remaining, cacheText!).alignment.warnings).not.toContain(
      "无法对应到当前原文",
    );
  });

  it("detaches a translation-locked block without creating an orphan", async () => {
    const paragraph = inspect(SOURCE, cacheStore.text!).alignment.blocks.find(
      (block) => block.source.kind === "paragraph",
    )!;
    const uri = mocks.FakeUri.file("/project/demo.md") as unknown as Uri;
    await service.saveTargetEdit(
      uri,
      paragraph.source.index,
      "人工锁定译文。",
    );
    const sourceDoc = parseMarkdownDocument(SOURCE, makeMd());
    const remaining =
      sourceDoc.blocks
        .filter((block) => block.index !== paragraph.source.index)
        .map((block) => block.raw)
        .join("\n\n") + "\n";
    mocks.documentState.text = remaining;

    const cacheText = await service.detachDeletedSourceBlocks(uri, SOURCE, [
      paragraph.source.index,
    ]);

    const alignment = inspect(remaining, cacheText!).alignment;
    expect(alignment.orphanCaches).toHaveLength(0);
    expect(alignment.warnings).not.toContain("无法对应到当前原文");
    const cache = parseCacheDocument(cacheText!, makeMd());
    expect(cache.targetBlocks).toHaveLength(1);
    expect(cache.targetBlocks[0].anchor.mode).toBe("target");
    expect(cache.targetBlocks[0].block.raw).toBe("人工锁定译文。");
  });
});
