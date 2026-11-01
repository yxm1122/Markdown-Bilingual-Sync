/** 测试：AgentService 的路径解析、读写编排、摘要依赖与术语表分页。 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as vscode from "vscode";
import { AgentService, AgentToolError } from "../src/agent/agentService";
import type { CacheStore } from "../src/cache/cacheStore";
import { summarySourceHash } from "../src/cache/summaryMarker";
import { GlossaryParseError } from "../src/glossary/glossary";
import { GlossaryPatchError } from "../src/glossary/glossaryPatch";
import {
  GlossaryStoreError,
  type GlossaryScopeSnapshot,
  type GlossaryStore,
} from "../src/glossary/glossaryStore";
import { tError } from "../src/i18n/errors";
import type { PreviewManager } from "../src/preview/previewManager";
import type {
  DocumentBriefPatchResult,
  DocumentGlossaryPatchResult,
  PreviewState,
  SyncService,
} from "../src/sync/syncService";
import type { CacheSummary } from "../src/markdown/types";
import { SOURCE } from "./helpers";

const mocks = vi.hoisted(() => {
  class FakeUri {
    constructor(
      readonly fsPath: string,
      readonly scheme = "file",
    ) {}

    get path(): string {
      return this.fsPath.replace(/\\/g, "/");
    }

    static file(fsPath: string): FakeUri {
      return new FakeUri(fsPath);
    }

    static joinPath(base: FakeUri, ...parts: string[]): FakeUri {
      return new FakeUri(
        [base.fsPath.replace(/[\\/]+$/, ""), ...parts].join("/"),
      );
    }

    toString(): string {
      return `${this.scheme}://${this.path}`;
    }
  }

  class FileSystemError extends Error {
    constructor(readonly code: string) {
      super(code);
      this.name = "FileSystemError";
    }
  }

  interface FakeDocument {
    uri: FakeUri;
    languageId: string;
    getText: () => string;
    isDirty: boolean;
    save: () => Promise<boolean>;
  }

  const documents = new Map<string, FakeDocument>();
  const existing = new Set<string>();
  const folderList: Array<{
    uri: FakeUri;
    name: string;
    index: number;
  }> = [];
  const active = { editor: undefined as unknown };
  const visible: unknown[] = [];

  const vscode = {
    Uri: FakeUri,
    FileSystemError,
    workspace: {
      get workspaceFolders() {
        return folderList;
      },
      set workspaceFolders(value) {
        folderList.length = 0;
        folderList.push(...(value ?? []));
      },
      getWorkspaceFolder(uri: FakeUri) {
        return folderList.find(
          (folder) =>
            uri.fsPath === folder.uri.fsPath ||
            uri.fsPath.startsWith(`${folder.uri.fsPath}/`),
        );
      },
      asRelativePath(uri: FakeUri) {
        const folder = folderList.find(
          (item) =>
            uri.fsPath === item.uri.fsPath ||
            uri.fsPath.startsWith(`${item.uri.fsPath}/`),
        );
        return folder
          ? uri.fsPath.slice(folder.uri.fsPath.length + 1)
          : uri.fsPath;
      },
      async openTextDocument(uri: FakeUri) {
        const document = documents.get(uri.toString());
        if (!document) {
          throw new FileSystemError("FileNotFound");
        }
        return document;
      },
      textDocuments: [] as FakeDocument[],
      async applyEdit() {
        return true;
      },
      fs: {
        async stat(uri: FakeUri) {
          if (!existing.has(uri.toString())) {
            throw new FileSystemError("FileNotFound");
          }
          return {};
        },
      },
    },
    window: {
      get activeTextEditor() {
        return active.editor;
      },
      set activeTextEditor(value) {
        active.editor = value;
      },
      visibleTextEditors: visible,
    },
  };

  return {
    vscode,
    FakeUri,
    FileSystemError,
    documents,
    existing,
    folderList,
    active,
    visible,
  };
});

vi.mock("vscode", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./vscodeStub")>();
  return { ...actual.vscodeStub, ...mocks.vscode };
});

const PROJECT = {
  uri: mocks.FakeUri.file("/project"),
  name: "project",
  index: 0,
};
const PROJECT2 = {
  uri: mocks.FakeUri.file("/project2"),
  name: "project2",
  index: 1,
};

function addDocument(
  path: string,
  languageId = "markdown",
): vscode.Uri {
  const uri = mocks.FakeUri.file(path) as unknown as vscode.Uri;
  mocks.existing.add(uri.toString());
  mocks.documents.set(uri.toString(), {
    uri: mocks.FakeUri.file(path),
    languageId,
    getText: () => SOURCE,
    isDirty: false,
    async save() {
      return true;
    },
  });
  return uri;
}

function makeSummary(overrides: Partial<CacheSummary> = {}): CacheSummary {
  return {
    text: "全文摘要。",
    sourceHash: summarySourceHash(SOURCE),
    updatedAt: "2026-01-01T00:00:00.000Z",
    model: "manual",
    brief: { audience: "后端开发者" },
    glossary: [{ source: "API", target: "接口" }],
    ...overrides,
  };
}

function makeState(
  summary: CacheSummary | null = makeSummary(),
): PreviewState {
  const actual = summary ?? undefined;
  return {
    sourceLanguage: "en",
    targetLanguage: "zh-CN",
    sourceText: SOURCE,
    cacheText: actual ? "<!-- mbs-summary:... -->\n" : undefined,
    cacheUri: mocks.FakeUri.file("/storage/demo.zh.md") as unknown as vscode.Uri,
    ...(actual ? { summary: actual } : {}),
  };
}

describe("AgentService", () => {
  let service: AgentService;
  let state: PreviewState;
  let briefCalls: unknown[];
  let glossaryCalls: unknown[];
  let briefError: Error | undefined;
  let glossaryError: Error | undefined;
  let globalReadError: Error | undefined;
  let workspaceReadError: Error | undefined;
  let userUpdateError: Error | undefined;
  let userUpdateCalls: Array<{
    scope: string;
    sourceUri: unknown;
    patch: unknown;
  }>;
  let refresh: ReturnType<typeof vi.fn>;
  let globalSnapshot: GlossaryScopeSnapshot;
  let workspaceSnapshot: GlossaryScopeSnapshot;
  let briefResult: DocumentBriefPatchResult;
  let docGlossaryResult: DocumentGlossaryPatchResult;
  let userUpdateResult: Awaited<ReturnType<GlossaryStore["updateScope"]>>;

  beforeEach(() => {
    mocks.documents.clear();
    mocks.existing.clear();
    mocks.folderList.length = 0;
    mocks.folderList.push(PROJECT);
    mocks.active.editor = undefined;
    mocks.visible.length = 0;
    addDocument("/project/docs/guide.md");
    addDocument("/project/docs/other.md");
    addDocument("/project2/docs/guide.md");
    addDocument("/project/notes.json", "json");
    addDocument("/storage/cache/project/docs/guide.zh.md");

    state = makeState();
    briefCalls = [];
    glossaryCalls = [];
    briefError = undefined;
    glossaryError = undefined;
    globalReadError = undefined;
    workspaceReadError = undefined;
    userUpdateError = undefined;
    userUpdateCalls = [];
    refresh = vi.fn();
    globalSnapshot = {
      scope: "global",
      uri: mocks.FakeUri.file("/storage/glossary.json") as unknown as vscode.Uri,
      entries: [
        { source: "API", target: "接口" },
        { source: "cache", target: "缓存" },
      ],
      warnings: [],
    };
    workspaceSnapshot = {
      scope: "workspace",
      uri: mocks.FakeUri.file(
        "/project/.mbs-glossary.json",
      ) as unknown as vscode.Uri,
      entries: [
        { source: "API", target: "应用程序接口" },
        { source: "token", target: "令牌" },
      ],
      warnings: ["duplicate"],
    };
    userUpdateResult = {
      scope: "global",
      uri: globalSnapshot.uri,
      before: globalSnapshot.entries,
      entries: [
        ...globalSnapshot.entries,
        { source: "queue", target: "队列" },
      ],
      added: [{ source: "queue", target: "队列" }],
      updated: [],
      removed: [],
      duplicates: [],
    };
    briefResult = {
      cacheText: "cache",
      summary: makeSummary({
        text: "新的摘要。",
        brief: {
          audience: "后端开发者",
          toneAndStyle: "简洁",
          doNotTranslate: "API",
        },
        glossary: [
          { source: "API", target: "接口" },
          { source: "queue", target: "队列" },
        ],
      }),
      previous: makeSummary(),
      overrodeLocks: [],
    };
    docGlossaryResult = {
      cacheText: "cache",
      previous: makeSummary(),
      summary: makeSummary({
        glossary: [
          { source: "API", target: "接口" },
          { source: "cache", target: "高速缓存" },
        ],
      }),
      overrodeLocks: ["glossary"],
      added: [],
      updated: [{ source: "cache", target: "高速缓存" }],
      removed: [],
      duplicates: [],
    };

    const syncService = {
      async loadPreviewState() {
        return state;
      },
      async patchDocumentBrief(_uri: vscode.Uri, input: unknown) {
        briefCalls.push(input);
        if (briefError) {
          throw briefError;
        }
        return briefResult;
      },
      async patchDocumentGlossary(_uri: vscode.Uri, input: unknown) {
        glossaryCalls.push(input);
        if (glossaryError) {
          throw glossaryError;
        }
        return docGlossaryResult;
      },
    } as unknown as SyncService;
    const glossaryStore = {
      glossaryUri: globalSnapshot.uri,
      workspaceGlossaryUri(folder: { uri: { fsPath: string } }) {
        return mocks.FakeUri.file(
          `${folder.uri.fsPath}/.mbs-glossary.json`,
        );
      },
      async readScope(scope: string) {
        if (scope === "global" && globalReadError) {
          throw globalReadError;
        }
        if (scope === "workspace" && workspaceReadError) {
          throw workspaceReadError;
        }
        return scope === "global" ? globalSnapshot : workspaceSnapshot;
      },
      async updateScope(
        scope: string,
        sourceUri: unknown,
        patch: unknown,
      ) {
        userUpdateCalls.push({ scope, sourceUri, patch });
        if (userUpdateError) {
          throw userUpdateError;
        }
        return userUpdateResult;
      },
    } as unknown as GlossaryStore;
    const cacheStore = {
      isCacheUri(uri: { fsPath: string }) {
        return uri.fsPath.replace(/\\/g, "/").startsWith("/storage/cache/");
      },
    } as unknown as CacheStore;
    service = new AgentService({
      syncService,
      glossaryStore,
      cacheStore,
      previewManager: { refresh } as unknown as PreviewManager,
      output: { appendLine: vi.fn() } as unknown as vscode.OutputChannel,
    });
  });

  it("reads a document brief with summary, locks and glossary", async () => {
    const view = await service.readDocumentBrief({
      file: "/project/docs/guide.md",
    });
    expect(view.ok).toBe(true);
    expect(view.relativePath).toBe("docs/guide.md");
    expect(view.documentBrief.exists).toBe(true);
    expect(view.documentBrief.stale).toBe(false);
    expect(view.documentBrief.summary).toBe("全文摘要。");
    expect(view.documentBrief.brief).toEqual({ audience: "后端开发者" });
    expect(view.documentBrief.glossary).toEqual([
      { source: "API", target: "接口" },
    ]);
    expect(view.limits.maxDocumentGlossaryEntries).toBe(200);
  });

  it("omits summary and glossary when requested", async () => {
    const view = await service.readDocumentBrief({
      file: "/project/docs/guide.md",
      includeSummary: false,
      includeGlossary: false,
    });
    expect(view.documentBrief.summary).toBeUndefined();
    expect(view.documentBrief.glossary).toBeUndefined();
    expect(view.documentBrief.summaryChars).toBeGreaterThan(0);
    expect(view.documentBrief.glossaryCount).toBe(1);
  });

  it("marks a summary stale when the source hash differs", async () => {
    state = makeState(makeSummary({ sourceHash: "old-hash" }));
    const view = await service.readDocumentBrief({
      file: "/project/docs/guide.md",
    });
    expect(view.documentBrief.stale).toBe(true);
  });

  it("passes a merged brief update to SyncService and refreshes the preview", async () => {
    const view = await service.updateDocumentBrief({
      file: "/project/docs/guide.md",
      summary: "新的摘要。",
      brief: { toneAndStyle: "简洁", doNotTranslate: "API" },
      glossary: [
        { source: "API", target: "接口" },
        { source: "queue", target: "队列" },
      ],
    });

    expect(briefCalls).toEqual([
      {
        summary: "新的摘要。",
        brief: { toneAndStyle: "简洁", doNotTranslate: "API" },
        glossary: [
          { source: "API", target: "接口" },
          { source: "queue", target: "队列" },
        ],
      },
    ]);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(view.created).toBe(false);
    expect(view.changes.summary).toBe("updated");
    expect(view.changes.brief).toEqual(["toneAndStyle", "doNotTranslate"]);
    expect(view.changes.glossary).toEqual({
      added: 1,
      updated: 0,
      removed: 0,
    });
    expect(view.locksOverridden).toEqual([]);
  });

  it("reports lock overrides from SyncService", async () => {
    briefResult.overrodeLocks = ["audience", "glossary"];
    const view = await service.updateDocumentBrief({
      file: "/project/docs/guide.md",
      brief: { audience: "运维人员" },
    });
    expect(view.locksOverridden).toEqual(["audience", "glossary"]);
  });

  it("requires a summary when creating a document brief", async () => {
    state = makeState(null);
    await expect(
      service.updateDocumentBrief({
        file: "/project/docs/guide.md",
        brief: { audience: "后端开发者" },
      }),
    ).rejects.toMatchObject({ code: "SUMMARY_REQUIRED" });
    expect(briefCalls).toEqual([]);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("rejects an over-long brief field before calling SyncService", async () => {
    await expect(
      service.updateDocumentBrief({
        file: "/project/docs/guide.md",
        brief: { audience: "x".repeat(401) },
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(briefCalls).toEqual([]);
  });

  it("rejects a no-op brief update", async () => {
    await expect(
      service.updateDocumentBrief({ file: "/project/docs/guide.md" }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(briefCalls).toEqual([]);
  });

  it("rejects document glossary writes without a summary", async () => {
    state = makeState(null);
    await expect(
      service.updateDocumentGlossary({
        file: "/project/docs/guide.md",
        entries: [{ source: "API", target: "接口" }],
      }),
    ).rejects.toMatchObject({ code: "SUMMARY_REQUIRED" });
    expect(glossaryCalls).toEqual([]);
  });

  it("updates the document glossary and returns sampled changes", async () => {
    const view = await service.updateDocumentGlossary({
      file: "/project/docs/guide.md",
      mode: "merge",
      entries: [{ source: "cache", target: "高速缓存" }],
    });
    expect(glossaryCalls).toEqual([
      {
        mode: "merge",
        entries: [{ source: "cache", target: "高速缓存" }],
      },
    ]);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(view.counts).toEqual({ added: 0, updated: 1, removed: 0 });
    expect(view.changed.updated).toEqual([
      { source: "cache", target: "高速缓存" },
    ]);
    expect(view.locksOverridden).toEqual(["glossary"]);
  });

  it("rejects remove with replace mode before writing", async () => {
    await expect(
      service.updateDocumentGlossary({
        file: "/project/docs/guide.md",
        mode: "replace",
        entries: [],
        remove: ["API"],
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(glossaryCalls).toEqual([]);
  });

  it("reads the effective glossary with provenance, filtering and paging", async () => {
    const all = await service.readGlossary({
      scope: "effective",
      file: "/project/docs/guide.md",
    });
    expect(all.total).toBe(3);
    expect(all.matched).toBe(3);
    expect(all.entries).toEqual([
      { source: "API", target: "应用程序接口", from: "workspace" },
      { source: "cache", target: "缓存", from: "global" },
      { source: "token", target: "令牌", from: "workspace" },
    ]);
    expect(all.sources.map((source) => source.scope)).toEqual([
      "global",
      "workspace",
    ]);
    expect(all.workspaceAvailable).toBe(true);
    expect(all.degraded).toBe(false);
    expect(all.warnings).toEqual([]);

    const filtered = await service.readGlossary({
      scope: "effective",
      file: "/project/docs/guide.md",
      query: "api",
      limit: 1,
      offset: 0,
    });
    expect(filtered.matched).toBe(1);
    expect(filtered.entries).toHaveLength(1);
    expect(filtered.hasMore).toBe(false);

    const paged = await service.readGlossary({
      scope: "effective",
      file: "/project/docs/guide.md",
      limit: 2,
      offset: 0,
    });
    expect(paged.entries).toHaveLength(2);
    expect(paged.hasMore).toBe(true);
  });

  it("refuses the workspace glossary scope without a workspace", async () => {
    mocks.folderList.length = 0;
    await expect(
      service.readGlossary({ scope: "workspace" }),
    ).rejects.toMatchObject({ code: "NO_WORKSPACE" });
  });

  it("updates the global glossary and reports workspace shadowing", async () => {
    const view = await service.updateGlossary({
      scope: "global",
      file: "/project/docs/guide.md",
      entries: [{ source: "queue", target: "队列" }],
    });
    expect(view.scope).toBe("global");
    expect(view.counts.added).toBe(1);
    expect(view.shadowing).toEqual({
      scope: "workspace",
      count: 1,
      sample: ["API"],
    });
  });

  it("refuses the workspace glossary update without a workspace", async () => {
    mocks.folderList.length = 0;
    await expect(
      service.updateGlossary({
        scope: "workspace",
        entries: [{ source: "API", target: "接口" }],
      }),
    ).rejects.toMatchObject({ code: "NO_WORKSPACE" });
  });

  it("resolves a unique relative path and the active editor fallback", async () => {
    const relative = await service.readDocumentBrief({
      file: "docs/guide.md",
    });
    expect(relative.file.replace(/\\/g, "/")).toMatch(
      /^\/project(2)?\/docs\/guide\.md$/,
    );

    mocks.active.editor = {
      document: {
        uri: mocks.FakeUri.file("/project/docs/other.md"),
        languageId: "markdown",
      },
    };
    const active = await service.readDocumentBrief({});
    expect(active.relativePath).toBe("docs/other.md");

    mocks.active.editor = undefined;
    mocks.visible.push(
      {
        document: {
          uri: mocks.FakeUri.file("/project/docs/guide.md"),
          languageId: "markdown",
        },
      },
      {
        document: {
          uri: mocks.FakeUri.file("/project/docs/guidemd"),
          languageId: "json",
        },
      },
    );
    const visible = await service.readDocumentBrief({});
    expect(visible.relativePath).toBe("docs/guide.md");
  });

  it("rejects ambiguous relative paths", async () => {
    mocks.folderList.push(PROJECT2);
    mocks.existing.add(
      mocks.FakeUri.file("/project2/docs/guide.md").toString(),
    );
    mocks.documents.set(
      mocks.FakeUri.file("/project2/docs/guide.md").toString(),
      {
        uri: mocks.FakeUri.file("/project2/docs/guide.md"),
        languageId: "markdown",
        getText: () => SOURCE,
        isDirty: false,
        async save() {
          return true;
        },
      },
    );
    await expect(
      service.readDocumentBrief({ file: "docs/guide.md" }),
    ).rejects.toMatchObject({ code: "AMBIGUOUS_FILE" });
  });

  it("rejects traversal, missing files, cache paths, glossary paths and non-Markdown files", async () => {
    await expect(
      service.readDocumentBrief({ file: "../secret.md" }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(
      service.readDocumentBrief({ file: "docs/missing.md" }),
    ).rejects.toMatchObject({ code: "FILE_NOT_FOUND" });
    await expect(
      service.readDocumentBrief({
        file: "/storage/cache/project/docs/guide.zh.md",
      }),
    ).rejects.toMatchObject({ code: "CACHE_PATH" });
    await expect(
      service.readDocumentBrief({
        file: "/project/.mbs-glossary.json",
      }),
    ).rejects.toMatchObject({ code: "GLOSSARY_PATH" });
    await expect(
      service.readDocumentBrief({ file: "/project/notes.json" }),
    ).rejects.toMatchObject({ code: "NOT_MARKDOWN" });
    await expect(
      service.readDocumentBrief({ file: 42 as unknown as string }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("rejects when no active or unique visible Markdown editor exists", async () => {
    await expect(service.readDocumentBrief({})).rejects.toMatchObject({
      code: "NO_ACTIVE_EDITOR",
    });
    mocks.visible.push(
      {
        document: {
          uri: mocks.FakeUri.file("/project/docs/guide.md"),
          languageId: "markdown",
        },
      },
      {
        document: {
          uri: mocks.FakeUri.file("/project/docs/other.md"),
          languageId: "markdown",
        },
      },
    );
    await expect(service.readDocumentBrief({})).rejects.toMatchObject({
      code: "NO_ACTIVE_EDITOR",
    });
  });

  it("maps a busy document sync to a retryable BUSY error", async () => {
    briefError = new Error(tError("sync.fileSyncBusy"));
    try {
      await service.updateDocumentBrief({
        file: "/project/docs/guide.md",
        brief: { audience: "运维人员" },
      });
      throw new Error("expected failure");
    } catch (error) {
      expect(error).toBeInstanceOf(AgentToolError);
      expect((error as AgentToolError).code).toBe("BUSY");
      expect((error as AgentToolError).hint).toBeTruthy();
    }
  });

  it("maps a summary race to a structured SUMMARY_REQUIRED error", async () => {
    briefError = new Error(tError("sync.summaryRequiredForBrief"));
    await expect(
      service.updateDocumentBrief({
        file: "/project/docs/guide.md",
        brief: { audience: "运维人员" },
      }),
    ).rejects.toMatchObject({ code: "SUMMARY_REQUIRED" });
  });

  it("maps a final document glossary overflow to LIMIT_EXCEEDED", async () => {
    glossaryError = new GlossaryPatchError([
      { code: "too-many", count: 201, max: 200 },
    ]);
    await expect(
      service.updateDocumentGlossary({
        file: "/project/docs/guide.md",
        entries: [{ source: "queue", target: "队列" }],
      }),
    ).rejects.toMatchObject({ code: "LIMIT_EXCEEDED" });
  });

  it("maps cache and glossary file conflicts to stable codes", async () => {
    briefError = new Error(tError("cache.dirty"));
    await expect(
      service.updateDocumentBrief({
        file: "/project/docs/guide.md",
        brief: { audience: "运维人员" },
      }),
    ).rejects.toMatchObject({ code: "FILE_DIRTY" });

    briefError = new Error(tError("sync.summaryUntrackedCache"));
    await expect(
      service.updateDocumentBrief({
        file: "/project/docs/guide.md",
        brief: { audience: "运维人员" },
      }),
    ).rejects.toMatchObject({ code: "CACHE_CONFLICT" });

    userUpdateError = new GlossaryStoreError("dirty", "dirty");
    await expect(
      service.updateGlossary({
        scope: "global",
        entries: [{ source: "API", target: "接口" }],
      }),
    ).rejects.toMatchObject({ code: "FILE_DIRTY" });

    userUpdateError = new GlossaryStoreError("invalid-existing", "bad");
    await expect(
      service.updateGlossary({
        scope: "global",
        entries: [{ source: "API", target: "接口" }],
      }),
    ).rejects.toMatchObject({ code: "GLOSSARY_INVALID" });

    briefError = new Error(tError("cache.saveFailed"));
    await expect(
      service.updateDocumentBrief({
        file: "/project/docs/guide.md",
        brief: { audience: "运维人员" },
      }),
    ).rejects.toMatchObject({ code: "WRITE_FAILED" });

    userUpdateError = new GlossaryStoreError("write-failed", "write failed");
    await expect(
      service.updateGlossary({
        scope: "global",
        entries: [{ source: "API", target: "接口" }],
      }),
    ).rejects.toMatchObject({ code: "WRITE_FAILED" });

    userUpdateError = new GlossaryPatchError([
      { code: "too-many", count: 1001, max: 1000 },
    ]);
    await expect(
      service.updateGlossary({
        scope: "global",
        entries: [{ source: "API", target: "接口" }],
      }),
    ).rejects.toMatchObject({ code: "LIMIT_EXCEEDED" });
  });

  it("maps a corrupt requested scope to GLOSSARY_INVALID", async () => {
    globalReadError = new GlossaryParseError(
      "invalid-json",
      "bad global glossary",
    );
    await expect(
      service.readGlossary({
        scope: "global",
        file: "/project/docs/guide.md",
      }),
    ).rejects.toMatchObject({ code: "GLOSSARY_INVALID" });
  });

  it("keeps a successful update successful when shadowing cannot be read", async () => {
    workspaceReadError = new GlossaryStoreError(
      "file-error",
      "broken workspace glossary",
    );
    const view = await service.updateGlossary({
      scope: "global",
      file: "/project/docs/guide.md",
      entries: [{ source: "queue", target: "队列" }],
    });
    expect(view.ok).toBe(true);
    expect(view.shadowing).toMatchObject({
      scope: "workspace",
      count: 0,
      unavailable: true,
    });
  });

  it("returns a partial effective glossary when one scope is invalid", async () => {
    globalReadError = new GlossaryParseError(
      "invalid-json",
      "bad global glossary",
    );
    const view = await service.readGlossary({
      scope: "effective",
      file: "/project/docs/guide.md",
    });
    expect(view.ok).toBe(true);
    expect(view.workspaceAvailable).toBe(true);
    expect(view.degraded).toBe(true);
    expect(view.warnings.join("\n")).toContain("bad global glossary");
    expect(view.entries).toEqual([
      { source: "API", target: "应用程序接口", from: "workspace" },
      { source: "token", target: "令牌", from: "workspace" },
    ]);
    expect(view.sources[0]).toMatchObject({ scope: "global", total: 0 });
    expect(view.sources[0].warnings.join("\n")).toContain(
      "bad global glossary",
    );
  });

  it("resolves backslash relative paths and records the second workspace target", async () => {
    const backslash = await service.readDocumentBrief({
      file: "docs\\guide.md",
    });
    expect(backslash.relativePath).toBe("docs/guide.md");

    mocks.folderList.push(PROJECT2);
    await service.updateGlossary({
      scope: "workspace",
      file: "/project2/docs/guide.md",
      entries: [{ source: "API", target: "接口" }],
    });
    expect(userUpdateCalls[0]?.scope).toBe("workspace");
    expect(
      (userUpdateCalls[0]?.sourceUri as { fsPath: string }).fsPath.replace(
        /\\/g,
        "/",
      ),
    ).toBe("/project2/docs/guide.md");
  });

  it("does not guess a workspace when several are open and no editor is active", async () => {
    mocks.folderList.push(PROJECT2);
    await expect(
      service.readGlossary({ scope: "workspace" }),
    ).rejects.toMatchObject({ code: "NO_WORKSPACE" });
    await expect(
      service.updateGlossary({
        scope: "workspace",
        entries: [{ source: "API", target: "接口" }],
      }),
    ).rejects.toMatchObject({ code: "NO_WORKSPACE" });

    const effective = await service.readGlossary({ scope: "effective" });
    expect(effective.workspaceAvailable).toBe(false);
    expect(effective.degraded).toBe(true);
    expect(effective.warnings.join("\n")).toContain("多个工作区");
    expect(effective.sources.map((source) => source.scope)).toEqual([
      "global",
    ]);

    const withFile = await service.readGlossary({
      scope: "workspace",
      file: "/project2/docs/guide.md",
    });
    expect(withFile.workspaceAvailable).toBe(true);
  });

  it("returns AgentToolError instances with hints", async () => {
    try {
      await service.readDocumentBrief({});
      throw new Error("expected failure");
    } catch (error) {
      expect(error).toBeInstanceOf(AgentToolError);
      expect((error as AgentToolError).hint).toBeTruthy();
    }
  });
});
