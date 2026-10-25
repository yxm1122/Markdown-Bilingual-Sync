/** 测试：导出准备、覆盖确认与写盘。 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OutputChannel, Uri } from "vscode";
import {
  ExportService,
  type ExportPreparation,
  type PreparedExport,
} from "../src/export/exportService";
import type { SyncService } from "../src/sync/syncService";
import { SOURCE, translate } from "./helpers";

const TARGET_KEY = "file:///project/demo.zh.md";

const mocks = vi.hoisted(() => {
  function resolvePath(base: string, ...parts: string[]): string {
    const output: string[] = [];
    for (const segment of [base, ...parts].join("/").split("/")) {
      if (!segment || segment === ".") {
        continue;
      }
      if (segment === "..") {
        output.pop();
        continue;
      }
      output.push(segment);
    }
    return `/${output.join("/")}`;
  }

  class FileSystemError extends Error {
    constructor(readonly code: string) {
      super(code);
      this.name = "FileSystemError";
    }
  }

  class FakeUri {
    constructor(
      readonly fsPath: string,
      readonly scheme = "file",
      readonly query = "",
    ) {}

    static file(fsPath: string): FakeUri {
      return new FakeUri(fsPath);
    }

    static joinPath(base: FakeUri, ...parts: string[]): FakeUri {
      return new FakeUri(resolvePath(base.fsPath, ...parts));
    }

    with(change: { scheme?: string; query?: string }): FakeUri {
      return new FakeUri(
        this.fsPath,
        change.scheme ?? this.scheme,
        change.query ?? this.query,
      );
    }

    toString(): string {
      return `${this.scheme}://${this.fsPath}${this.query ? `?${this.query}` : ""}`;
    }
  }

  const files = new Map<string, string>();
  const textDocuments: unknown[] = [];
  const readFile = vi.fn(async (uri: FakeUri) => {
    const value = files.get(uri.toString());
    if (value === undefined) {
      throw new FileSystemError("FileNotFound");
    }
    return new TextEncoder().encode(value);
  });
  const writeFile = vi.fn(
    async (_uri: unknown, _bytes: Uint8Array) => undefined,
  );

  const vscode = {
    workspace: {
      fs: {
        readFile,
        writeFile,
        async createDirectory() {},
      },
      get textDocuments() {
        return textDocuments;
      },
      asRelativePath(uri: FakeUri) {
        return uri.fsPath.split("/").pop() ?? uri.fsPath;
      },
      async applyEdit() {
        return true;
      },
    },
    Uri: FakeUri,
    FileSystemError,
  };

  return {
    vscode,
    files,
    textDocuments,
    readFile,
    writeFile,
  };
});

// 展开全局 stub 保留 l10n/env；FakeUri 等本文件所需 API 覆盖 stub 实现。
vi.mock("vscode", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./vscodeStub")>();
  return { ...actual.vscodeStub, ...mocks.vscode };
});

function expectReady(preparation: ExportPreparation): PreparedExport {
  if (preparation.status !== "ready") {
    throw new Error(`expected ready, got ${preparation.status}`);
  }
  return preparation.prepared;
}

describe("ExportService", () => {
  let service: ExportService;
  let output: OutputChannel;

  beforeEach(async () => {
    mocks.files.clear();
    mocks.textDocuments.length = 0;
    mocks.readFile.mockClear();
    mocks.writeFile.mockClear();

    const result = await translate();
    const syncService = {
      async loadState() {
        return {
          sourceUri: mocks.vscode.Uri.file("/project/demo.md"),
          sourceText: SOURCE,
          cacheText: result.cacheText,
          cacheUri: mocks.vscode.Uri.file("/storage/demo.zh.md"),
          sourceLanguage: "en",
          targetLanguage: "zh-CN",
        };
      },
    };
    output = {
      appendLine: vi.fn(),
    } as unknown as OutputChannel;
    service = new ExportService(
      syncService as unknown as SyncService,
      output,
    );
  });

  afterEach(() => {
    mocks.files.clear();
    mocks.textDocuments.length = 0;
  });

  it("prepares a new export without writing and writes on commit", async () => {
    const sourceUri = mocks.vscode.Uri.file(
      "/project/demo.md",
    ) as unknown as Uri;
    const preparation = await service.prepare(sourceUri);
    const prepared = expectReady(preparation);

    expect(prepared.destination).toBe("demo.zh.md");
    expect(prepared.existingText).toBeUndefined();
    expect(prepared.summary.length).toBeGreaterThan(0);
    expect(mocks.writeFile).not.toHaveBeenCalled();

    await service.commit(prepared);

    expect(mocks.writeFile).toHaveBeenCalledTimes(1);
    const bytes = mocks.writeFile.mock.calls[0]?.[1] as Uint8Array;
    expect(new TextDecoder().decode(bytes)).toContain("# 标题");
  });

  it("reports unchanged when the target already matches", async () => {
    const sourceUri = mocks.vscode.Uri.file(
      "/project/demo.md",
    ) as unknown as Uri;
    const first = expectReady(await service.prepare(sourceUri));
    await service.commit(first);
    const written = new TextDecoder().decode(
      mocks.writeFile.mock.calls[0]?.[1] as Uint8Array,
    );
    mocks.files.set(TARGET_KEY, written);
    mocks.writeFile.mockClear();

    const second = await service.prepare(sourceUri);

    expect(second.status).toBe("unchanged");
    if (second.status === "unchanged") {
      expect(second.destination).toBe("demo.zh.md");
    }
    expect(mocks.writeFile).not.toHaveBeenCalled();
  });

  it("includes existing target text for diffing", async () => {
    mocks.files.set(TARGET_KEY, "旧内容\n");
    const sourceUri = mocks.vscode.Uri.file(
      "/project/demo.md",
    ) as unknown as Uri;

    const prepared = expectReady(await service.prepare(sourceUri));

    expect(prepared.existingText).toBe("旧内容\n");
  });

  it("refuses to prepare when the target is open and dirty", async () => {
    mocks.files.set(TARGET_KEY, "旧内容\n");
    mocks.textDocuments.push({
      uri: mocks.vscode.Uri.file("/project/demo.zh.md"),
      isDirty: true,
    });
    const sourceUri = mocks.vscode.Uri.file(
      "/project/demo.md",
    ) as unknown as Uri;

    await expect(service.prepare(sourceUri)).rejects.toThrow(
      "导出目标正在编辑且有未保存修改",
    );
    expect(mocks.writeFile).not.toHaveBeenCalled();
  });

  it("refuses to commit when the target changed during confirmation", async () => {
    const sourceUri = mocks.vscode.Uri.file(
      "/project/demo.md",
    ) as unknown as Uri;
    const prepared = expectReady(await service.prepare(sourceUri));

    mocks.files.set(TARGET_KEY, "确认期间被其他程序写入\n");

    await expect(service.commit(prepared)).rejects.toThrow(
      "导出目标在确认期间已被修改",
    );
    expect(mocks.writeFile).not.toHaveBeenCalled();
  });
});
