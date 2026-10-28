/** 测试：审校批注、用户批注与按批注重译的集成链路。 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OutputChannel, Uri } from "vscode";
import { SyncService } from "../src/sync/syncService";
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
  let reviewRequests: ReviewRequest[];
  let reviewDrafts: ReviewAnnotationDraft[];

  beforeEach(async () => {
    mocks.documentState.text = SOURCE;
    mocks.annotationFiles.clear();
    const result = await translate();
    cacheStore = new FakeCacheStore();
    cacheStore.text = result.cacheText;
    requests = [];
    reviewRequests = [];
    reviewDrafts = [];
    const provider: TranslationProvider = {
      id: "batch:test",
      label: "Test",
      supportsSummary: true,
      supportsReview: true,
      async translate(request) {
        requests.push(request);
        return request.items.map((item) => ({
          id: item.id,
          text:
            item.kind === "heading"
              ? `# 回译：${item.id}`
              : `回译：${item.id}`,
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
      second.annotations.some(
        (entry) => entry.author === "user" && entry.kind === "note",
      ),
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
    await service.retranslateBlock(uri, target.source.index);
    expect(requests[0].annotations).toEqual([
      {
        author: "user",
        kind: "request-change",
        text: "Use the business sense of “bite”.",
      },
    ]);
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
});
