/** 测试：GlossaryStore 的单作用域读取、合并更新与文件保护。 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as vscode from "vscode";
import { GlossaryStore } from "../src/glossary/glossaryStore";

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

  class Position {
    constructor(
      readonly line: number,
      readonly character: number,
    ) {}
  }

  class Range {
    constructor(
      readonly start: Position,
      readonly end: Position,
    ) {}
  }

  class FakeDocument {
    isDirty = false;

    constructor(
      readonly uri: FakeUri,
      public text: string,
    ) {}

    getText(): string {
      return this.text;
    }

    positionAt(offset: number): Position {
      const before = this.text.slice(0, offset);
      const lines = before.split("\n");
      return new Position(lines.length - 1, lines[lines.length - 1].length);
    }

    async save(): Promise<boolean> {
      files.set(key(this.uri), this.text);
      this.isDirty = false;
      return true;
    }
  }

  class FakeWorkspaceEdit {
    readonly ops: Array<{ uri: FakeUri; text: string }> = [];

    replace(uri: FakeUri, _range: Range, text: string): void {
      this.ops.push({ uri, text });
    }
  }

  const files = new Map<string, string>();
  const key = (uri: FakeUri) => uri.fsPath.replace(/\\/g, "/");
  const documents: FakeDocument[] = [];
  const workspaceFolder = {
    uri: FakeUri.file("/project"),
    name: "project",
    index: 0,
  };

  const vscode = {
    Uri: FakeUri,
    FileSystemError,
    Range,
    Position,
    WorkspaceEdit: FakeWorkspaceEdit,
    workspace: {
      workspaceFolders: [workspaceFolder] as
        | Array<typeof workspaceFolder>
        | undefined,
      getWorkspaceFolder(uri: FakeUri) {
        return uri.fsPath === workspaceFolder.uri.fsPath ||
          uri.fsPath.startsWith(`${workspaceFolder.uri.fsPath}/`)
          ? workspaceFolder
          : undefined;
      },
      textDocuments: documents,
      async openTextDocument(uri: FakeUri) {
        const document = documents.find(
          (item) => item.uri.toString() === uri.toString(),
        );
        if (!document) {
          throw new FileSystemError("FileNotFound");
        }
        return document;
      },
      async applyEdit(edit: FakeWorkspaceEdit) {
        for (const op of edit.ops) {
          const document = documents.find(
            (item) => item.uri.toString() === op.uri.toString(),
          );
          if (document) {
            document.text = op.text;
          } else {
            files.set(key(op.uri), op.text);
          }
        }
        return true;
      },
      fs: {
        async readFile(uri: FakeUri) {
          const text = files.get(key(uri));
          if (text === undefined) {
            throw new FileSystemError("FileNotFound");
          }
          return new TextEncoder().encode(text);
        },
        async writeFile(uri: FakeUri, content: Uint8Array) {
          files.set(key(uri), new TextDecoder().decode(content));
        },
        async createDirectory() {},
        async stat(uri: FakeUri) {
          if (!files.has(key(uri))) {
            throw new FileSystemError("FileNotFound");
          }
          return {};
        },
      },
    },
    window: {
      activeTextEditor: undefined,
      async showTextDocument() {},
    },
  };

  return {
    vscode,
    FakeUri,
    FakeDocument,
    files,
    documents,
    workspaceFolder,
  };
});

vi.mock("vscode", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./vscodeStub")>();
  return { ...actual.vscodeStub, ...mocks.vscode };
});

const GLOBAL_PATH = "/storage/glossary.json";
const WORKSPACE_PATH = "/project/.mbs-glossary.json";

function makeStore(): GlossaryStore {
  return new GlossaryStore({
    globalStorageUri: mocks.FakeUri.file("/storage"),
  } as unknown as vscode.ExtensionContext);
}

function uri(path: string): vscode.Uri {
  return mocks.FakeUri.file(path) as unknown as vscode.Uri;
}

function readJson(path: string): unknown {
  const text = mocks.files.get(path);
  return text === undefined ? undefined : JSON.parse(text);
}

describe("GlossaryStore scoped updates", () => {
  beforeEach(() => {
    mocks.files.clear();
    mocks.documents.length = 0;
    mocks.vscode.workspace.workspaceFolders = [mocks.workspaceFolder];
    mocks.vscode.window.activeTextEditor = undefined;
  });

  it("returns an empty global snapshot when the file is missing", async () => {
    const snapshot = await makeStore().readScope("global");
    expect(snapshot.entries).toEqual([]);
    expect(snapshot.warnings).toEqual([]);
    expect(snapshot.uri.fsPath.replace(/\\/g, "/")).toBe(GLOBAL_PATH);
  });

  it("creates the global glossary on first merge", async () => {
    const result = await makeStore().updateScope("global", undefined, {
      mode: "merge",
      entries: [{ source: "API", target: "接口" }],
    });

    expect(result.entries).toEqual([{ source: "API", target: "接口" }]);
    expect(result.added).toEqual([{ source: "API", target: "接口" }]);
    expect(mocks.files.get(GLOBAL_PATH)).toBe(
      `${JSON.stringify([{ source: "API", target: "接口" }], null, 2)}\n`,
    );
    expect(
      (await makeStore().readScope("global")).entries,
    ).toEqual([{ source: "API", target: "接口" }]);
  });

  it("merges, updates and removes entries while preserving order", async () => {
    mocks.files.set(
      GLOBAL_PATH,
      JSON.stringify([
        { source: "API", target: "接口" },
        { source: "cache", target: "缓存" },
        { source: "token", target: "令牌" },
      ]),
    );
    const result = await makeStore().updateScope("global", undefined, {
      mode: "merge",
      remove: ["API"],
      entries: [
        { source: "cache", target: "高速缓存" },
        { source: "queue", target: "队列" },
      ],
    });

    expect(result.entries).toEqual([
      { source: "cache", target: "高速缓存" },
      { source: "token", target: "令牌" },
      { source: "queue", target: "队列" },
    ]);
    expect(result.removed).toEqual([{ source: "API", target: "接口" }]);
    expect(readJson(GLOBAL_PATH)).toEqual(result.entries);
  });

  it("preserves the entries wrapper and extra top-level fields on merge", async () => {
    mocks.files.set(
      GLOBAL_PATH,
      JSON.stringify({
        entries: [{ source: "API", target: "接口" }],
        note: "team glossary",
      }),
    );
    await makeStore().updateScope("global", undefined, {
      mode: "merge",
      entries: [{ source: "cache", target: "缓存" }],
    });

    expect(readJson(GLOBAL_PATH)).toEqual({
      entries: [
        { source: "API", target: "接口" },
        { source: "cache", target: "缓存" },
      ],
      note: "team glossary",
    });
  });

  it("replaces the file in replace mode", async () => {
    mocks.files.set(
      GLOBAL_PATH,
      JSON.stringify([{ source: "API", target: "接口" }]),
    );
    const result = await makeStore().updateScope("global", undefined, {
      mode: "replace",
      entries: [{ source: "docs", target: "文档" }],
    });

    expect(result.entries).toEqual([{ source: "docs", target: "文档" }]);
    expect(readJson(GLOBAL_PATH)).toEqual([
      { source: "docs", target: "文档" },
    ]);
  });

  it("writes the workspace glossary next to the source workspace", async () => {
    const store = makeStore();
    const source = uri("/project/docs/guide.md");
    const result = await store.updateScope("workspace", source, {
      mode: "merge",
      entries: [{ source: "API", target: "接口" }],
    });

    expect(result.uri.fsPath.replace(/\\/g, "/")).toBe(WORKSPACE_PATH);
    expect(mocks.files.get(WORKSPACE_PATH)).toContain("API");
    expect(
      (await store.readScope("workspace", source)).entries,
    ).toEqual([{ source: "API", target: "接口" }]);
  });

  it("refuses the workspace scope when the source is outside any workspace", async () => {
    const store = makeStore();
    await expect(
      store.updateScope("workspace", uri("/elsewhere/guide.md"), {
        mode: "merge",
        entries: [{ source: "API", target: "接口" }],
      }),
    ).rejects.toThrow(/工作区/);
    expect(mocks.files.size).toBe(0);
  });

  it("refuses to write an open glossary with unsaved changes", async () => {
    mocks.files.set(GLOBAL_PATH, "[]\n");
    const document = new mocks.FakeDocument(
      mocks.FakeUri.file(GLOBAL_PATH),
      "[]\n",
    );
    document.isDirty = true;
    mocks.documents.push(document);

    await expect(
      makeStore().updateScope("global", undefined, {
        mode: "merge",
        entries: [{ source: "API", target: "接口" }],
      }),
    ).rejects.toThrow(/未保存/);
    expect(mocks.files.get(GLOBAL_PATH)).toBe("[]\n");
  });

  it("updates an open clean glossary through WorkspaceEdit and saves it", async () => {
    mocks.files.set(GLOBAL_PATH, "[]\n");
    const document = new mocks.FakeDocument(
      mocks.FakeUri.file(GLOBAL_PATH),
      "[]\n",
    );
    mocks.documents.push(document);

    const result = await makeStore().updateScope("global", undefined, {
      mode: "merge",
      entries: [{ source: "API", target: "接口" }],
    });

    expect(result.entries).toEqual([{ source: "API", target: "接口" }]);
    expect(document.text).toContain("API");
    expect(readJson(GLOBAL_PATH)).toEqual([
      { source: "API", target: "接口" },
    ]);
  });

  it("refuses merge when the existing file has invalid entries", async () => {
    const original = JSON.stringify([
      { source: "ok", target: "好" },
      { source: "", target: "坏" },
    ]);
    mocks.files.set(GLOBAL_PATH, original);

    await expect(
      makeStore().updateScope("global", undefined, {
        mode: "merge",
        entries: [{ source: "API", target: "接口" }],
      }),
    ).rejects.toThrow(/无效/);
    expect(mocks.files.get(GLOBAL_PATH)).toBe(original);
  });

  it("refuses merge when the existing file exceeds the entry limit", async () => {
    const original = JSON.stringify(
      Array.from({ length: 1001 }, (_, index) => ({
        source: `term-${index}`,
        target: `术语-${index}`,
      })),
    );
    mocks.files.set(GLOBAL_PATH, original);

    await expect(
      makeStore().updateScope("global", undefined, {
        mode: "merge",
        entries: [{ source: "API", target: "接口" }],
      }),
    ).rejects.toThrow(/1000/);
    expect(mocks.files.get(GLOBAL_PATH)).toBe(original);
  });

  it("collapses existing duplicate sources and reports them", async () => {
    mocks.files.set(
      GLOBAL_PATH,
      JSON.stringify([
        { source: "API", target: "接口" },
        { source: "api", target: "应用程序接口" },
      ]),
    );
    const result = await makeStore().updateScope("global", undefined, {
      mode: "merge",
      entries: [{ source: "cache", target: "缓存" }],
    });

    expect(result.duplicates).toEqual(["api"]);
    expect(result.entries).toEqual([
      { source: "api", target: "应用程序接口" },
      { source: "cache", target: "缓存" },
    ]);
  });

  it("rejects merge on invalid JSON but allows explicit replacement", async () => {
    mocks.files.set(GLOBAL_PATH, "{oops");
    const store = makeStore();

    await expect(
      store.updateScope("global", undefined, {
        mode: "merge",
        entries: [{ source: "API", target: "接口" }],
      }),
    ).rejects.toThrow(/JSON/);
    expect(mocks.files.get(GLOBAL_PATH)).toBe("{oops");

    const result = await store.updateScope("global", undefined, {
      mode: "replace",
      entries: [{ source: "API", target: "接口" }],
    });
    expect(result.entries).toEqual([{ source: "API", target: "接口" }]);
    expect(readJson(GLOBAL_PATH)).toEqual([
      { source: "API", target: "接口" },
    ]);
  });

  it("serializes concurrent merges so neither update is lost", async () => {
    const store = makeStore();
    await Promise.all([
      store.updateScope("global", undefined, {
        mode: "merge",
        entries: [{ source: "API", target: "接口" }],
      }),
      store.updateScope("global", undefined, {
        mode: "merge",
        entries: [{ source: "cache", target: "缓存" }],
      }),
    ]);

    const entries = (await store.readScope("global")).entries;
    expect(entries.map((entry) => entry.source).sort()).toEqual([
      "API",
      "cache",
    ]);
  });

  it("surfaces duplicate warnings when reading a scope", async () => {
    mocks.files.set(
      GLOBAL_PATH,
      JSON.stringify([
        { source: "API", target: "接口" },
        { source: "api", target: "应用程序接口" },
      ]),
    );
    const snapshot = await makeStore().readScope("global");
    expect(snapshot.entries).toEqual([
      { source: "api", target: "应用程序接口" },
    ]);
    expect(snapshot.warnings.join("\n")).toContain("重复");
  });
});
