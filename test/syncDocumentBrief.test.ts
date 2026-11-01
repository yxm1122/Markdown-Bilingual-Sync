/** 测试：SyncService 的文档简报与文档术语表补丁写入。 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OutputChannel, Uri } from "vscode";
import { parseCacheDocument } from "../src/markdown/anchors";
import { summarySourceHash } from "../src/cache/summaryMarker";
import type { CacheStore } from "../src/cache/cacheStore";
import type { GlossaryStore } from "../src/glossary/glossaryStore";
import { SyncService } from "../src/sync/syncService";
import type { TranslationProvider } from "../src/translation/types";
import { SOURCE, makeMd, translate } from "./helpers";

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

  const documentState = { text: "", isDirty: false, saves: 0 };
  const workspaceFolder = {
    uri: FakeUri.file("/project"),
    name: "project",
    index: 0,
  };
  const document = {
    uri: FakeUri.file("/project/demo.md"),
    getText: () => documentState.text,
    get isDirty() {
      return documentState.isDirty;
    },
    async save() {
      documentState.saves += 1;
      documentState.isDirty = false;
      return true;
    },
  };

  const vscode = {
    workspace: {
      workspaceFolders: [workspaceFolder],
      getWorkspaceFolder(uri: FakeUri) {
        return uri.fsPath === workspaceFolder.uri.fsPath ||
          uri.fsPath.startsWith(`${workspaceFolder.uri.fsPath}/`)
          ? workspaceFolder
          : undefined;
      },
      asRelativePath(uri: FakeUri) {
        return uri.fsPath.replace(`${workspaceFolder.uri.fsPath}/`, "");
      },
      getConfiguration() {
        return {
          get(key: string, fallback: unknown) {
            if (key === "sourceLanguage") {
              return "en";
            }
            if (key === "targetLanguage") {
              return "zh-CN";
            }
            if (key === "assistantLanguage") {
              return "target";
            }
            return fallback;
          },
        };
      },
      async openTextDocument() {
        return document;
      },
      textDocuments: [],
      fs: {
        async readFile() {
          throw { code: "FileNotFound" };
        },
        async writeFile() {},
        async createDirectory() {},
        async stat() {
          throw { code: "FileNotFound" };
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

  return { vscode, FakeUri, documentState, document };
});

vi.mock("vscode", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./vscodeStub")>();
  return { ...actual.vscodeStub, ...mocks.vscode };
});

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

  async delete(): Promise<boolean> {
    const existed = this.text !== undefined;
    this.text = undefined;
    return existed;
  }
}

const provider: TranslationProvider = {
  id: "test",
  label: "Test",
  supportsSummary: true,
  async translate(request) {
    return request.items.map((item) => ({
      id: item.id,
      text: `译：${item.id}`,
    }));
  },
};

function inspect(text: string | undefined) {
  return parseCacheDocument(text ?? "", makeMd());
}

describe("SyncService document brief and glossary patches", () => {
  let service: SyncService;
  let cacheStore: FakeCacheStore;

  beforeEach(() => {
    mocks.documentState.text = SOURCE;
    mocks.documentState.isDirty = false;
    mocks.documentState.saves = 0;
    cacheStore = new FakeCacheStore();
    const glossaryStore = {
      async load() {
        return { entries: [], warnings: [] };
      },
      async loadFor() {
        return { entries: [], warnings: [] };
      },
    };
    service = new SyncService(
      cacheStore as unknown as CacheStore,
      glossaryStore as unknown as GlossaryStore,
      provider,
      { appendLine() {} } as unknown as OutputChannel,
    );
  });

  const uri = () => mocks.FakeUri.file("/project/demo.md") as unknown as Uri;

  async function createBrief(): Promise<void> {
    await service.patchDocumentBrief(uri(), {
      summary: "全文摘要。",
      brief: {
        audience: "后端开发者",
        toneAndStyle: "简洁",
        ambiguities: "bite 指业务影响",
      },
      glossary: [
        { source: "API", target: "接口" },
        { source: "cache", target: "缓存" },
      ],
    });
  }

  it("creates a metadata-only cache with summary, brief and document glossary", async () => {
    const result = await service.patchDocumentBrief(uri(), {
      summary: "全文摘要。",
      brief: { audience: "后端开发者" },
      glossary: [{ source: "API", target: "接口" }],
    });

    expect(result.previous).toBeUndefined();
    expect(result.overrodeLocks).toEqual([]);
    expect(cacheStore.text).toContain("<!-- mbs-summary:");
    expect(result.summary.text).toBe("全文摘要。");
    expect(result.summary.brief).toEqual({ audience: "后端开发者" });
    expect(result.summary.glossary).toEqual([
      { source: "API", target: "接口" },
    ]);
    expect(result.summary.model).toBe("manual");
    expect(result.summary.sourceHash).toBe(summarySourceHash(SOURCE));
    expect(inspect(cacheStore.text).blocks).toEqual([]);
    expect(inspect(cacheStore.text).untracked).toEqual([]);
  });

  it("merges brief fields without losing summary or glossary", async () => {
    await createBrief();
    const before = inspect(cacheStore.text).summary!;

    await service.patchDocumentBrief(uri(), {
      brief: { toneAndStyle: "更简洁" },
    });
    const after = inspect(cacheStore.text).summary!;

    expect(after.text).toBe(before.text);
    expect(after.glossary).toEqual(before.glossary);
    expect(after.brief).toEqual({
      audience: "后端开发者",
      toneAndStyle: "更简洁",
      ambiguities: "bite 指业务影响",
    });
  });

  it("clears a brief field with an empty string", async () => {
    await createBrief();

    await service.patchDocumentBrief(uri(), { brief: { audience: "  " } });
    const after = inspect(cacheStore.text).summary!;

    expect(after.brief?.audience).toBeUndefined();
    expect(after.brief?.toneAndStyle).toBe("简洁");
  });

  it("rejects an over-long brief field without changing the cache", async () => {
    await createBrief();
    const before = cacheStore.text;
    const writes = cacheStore.writes;

    await expect(
      service.patchDocumentBrief(uri(), {
        brief: { audience: "x".repeat(401) },
      }),
    ).rejects.toThrow(/400/);

    expect(cacheStore.text).toBe(before);
    expect(cacheStore.writes).toBe(writes);
  });

  it("requires a summary when creating a document brief", async () => {
    await expect(
      service.patchDocumentBrief(uri(), {
        brief: { audience: "后端开发者" },
      }),
    ).rejects.toThrow(/摘要/);
    expect(cacheStore.text).toBeUndefined();
    expect(cacheStore.writes).toBe(0);
  });

  it("requires a document brief before writing the document glossary", async () => {
    await expect(
      service.patchDocumentGlossary(uri(), {
        mode: "merge",
        entries: [{ source: "API", target: "接口" }],
      }),
    ).rejects.toThrow(/摘要/);
    expect(cacheStore.text).toBeUndefined();
    expect(cacheStore.writes).toBe(0);
  });

  it("merges document glossary entries while preserving brief and metadata", async () => {
    await createBrief();
    await service.setSummaryLocks(uri(), "glossary", true);
    const before = inspect(cacheStore.text).summary!;

    const result = await service.patchDocumentGlossary(uri(), {
      mode: "merge",
      remove: ["API"],
      entries: [
        { source: "cache", target: "高速缓存" },
        { source: "queue", target: "队列" },
      ],
    });
    const after = inspect(cacheStore.text).summary!;

    expect(after.text).toBe(before.text);
    expect(after.brief).toEqual(before.brief);
    expect(after.updatedAt).toBe(before.updatedAt);
    expect(after.sourceHash).toBe(before.sourceHash);
    expect(after.glossary).toEqual([
      { source: "cache", target: "高速缓存" },
      { source: "queue", target: "队列" },
    ]);
    expect(result.added).toEqual([
      { source: "queue", target: "队列" },
    ]);
    expect(result.updated).toEqual([
      { source: "cache", target: "高速缓存" },
    ]);
    expect(result.removed).toEqual([{ source: "API", target: "接口" }]);
    expect(result.overrodeLocks).toEqual(["glossary"]);
    expect(after.locks?.glossary).toBe(true);
  });

  it("replaces the document glossary through the brief patch", async () => {
    await createBrief();
    const before = inspect(cacheStore.text).summary!;

    await service.patchDocumentBrief(uri(), { glossary: [] });
    const after = inspect(cacheStore.text).summary!;

    expect(after.glossary).toBeUndefined();
    expect(after.text).toBe(before.text);
    expect(after.brief).toEqual(before.brief);
    expect(after.updatedAt).toBe(before.updatedAt);
    expect(after.sourceHash).toBe(before.sourceHash);
  });

  it("overrides a locked brief field but keeps the lock", async () => {
    await createBrief();
    await service.setSummaryLocks(uri(), "audience", true);

    const result = await service.patchDocumentBrief(uri(), {
      brief: { audience: "运维人员" },
    });
    const after = inspect(cacheStore.text).summary!;

    expect(after.brief?.audience).toBe("运维人员");
    expect(after.locks?.brief?.audience).toBe(true);
    expect(result.overrodeLocks).toEqual(["audience"]);
  });

  it("rejects document glossary overflow atomically", async () => {
    await createBrief();
    const before = cacheStore.text;
    const writes = cacheStore.writes;
    const entries = Array.from({ length: 201 }, (_, index) => ({
      source: `term-${index}`,
      target: `术语-${index}`,
    }));

    await expect(
      service.patchDocumentGlossary(uri(), { mode: "replace", entries }),
    ).rejects.toThrow(/200/);

    expect(cacheStore.text).toBe(before);
    expect(cacheStore.writes).toBe(writes);
  });

  it("preserves existing translation blocks when writing a brief", async () => {
    cacheStore.text = (await translate()).cacheText;
    const beforeBlocks = inspect(cacheStore.text).blocks.length;

    await service.patchDocumentBrief(uri(), {
      summary: "全文摘要。",
      brief: { audience: "后端开发者" },
    });
    const parsed = inspect(cacheStore.text);

    expect(parsed.summary?.text).toBe("全文摘要。");
    expect(parsed.blocks).toHaveLength(beforeBlocks);
    expect(parsed.untracked).toEqual([]);
  });

  it("writes against an unsaved source buffer without forcing a save", async () => {
    mocks.documentState.isDirty = true;

    await service.patchDocumentBrief(uri(), { summary: "缓冲摘要。" });

    expect(mocks.documentState.saves).toBe(0);
    expect(mocks.documentState.isDirty).toBe(true);
    expect(inspect(cacheStore.text).summary?.text).toBe("缓冲摘要。");
    expect(cacheStore.writes).toBe(1);
  });

  it("does not report a glossary lock when the merge changes nothing", async () => {
    await createBrief();
    await service.setSummaryLocks(uri(), "glossary", true);
    const entries = inspect(cacheStore.text).summary?.glossary ?? [];

    const result = await service.patchDocumentGlossary(uri(), {
      mode: "merge",
      entries,
    });

    expect(result.overrodeLocks).toEqual([]);
    expect(result.added).toEqual([]);
    expect(result.updated).toEqual([]);
    expect(result.removed).toEqual([]);
  });

  it("rejects merge overflow against an existing document glossary", async () => {
    const existing = Array.from({ length: 199 }, (_, index) => ({
      source: `term-${index}`,
      target: `术语-${index}`,
    }));
    await service.patchDocumentBrief(uri(), {
      summary: "摘要。",
      glossary: existing,
    });
    const before = cacheStore.text;
    const writes = cacheStore.writes;

    await expect(
      service.patchDocumentGlossary(uri(), {
        mode: "merge",
        entries: [
          { source: "a", target: "甲" },
          { source: "b", target: "乙" },
        ],
      }),
    ).rejects.toThrow(/200/);

    expect(cacheStore.text).toBe(before);
    expect(cacheStore.writes).toBe(writes);
  });

  it("rejects writing when the cache contains untracked content", async () => {
    cacheStore.text = "没有任何锚点的内容\n";

    await expect(
      service.patchDocumentBrief(uri(), { summary: "摘要" }),
    ).rejects.toThrow(/未跟踪|锚点/);
    expect(cacheStore.text).toBe("没有任何锚点的内容\n");
  });
});
