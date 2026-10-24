/** 测试：全局缓存路径、读写与清理。 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as vscode from "vscode";
import { CacheStore } from "../src/cache/cacheStore";

const mocks = vi.hoisted(() => {
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

    with(changes: { path?: string; scheme?: string }): FakeUri {
      if (changes.path !== undefined) {
        return new FakeUri(changes.path, changes.scheme ?? this.scheme);
      }
      return this;
    }

    toString(): string {
      return `${this.scheme}://${this.path}`;
    }
  }

  const files = new Map<string, Uint8Array>();
  const key = (uri: FakeUri) => uri.fsPath.replace(/\\/g, "/");
  const textDocuments: Array<{ uri: FakeUri; isDirty: boolean }> = [];

  const vscode = {
    Uri: FakeUri,
    FileSystemError,
    FileType: { File: 1, Directory: 2 },
    workspace: {
      textDocuments,
      fs: {
        async readFile(uri: FakeUri) {
          const value = files.get(key(uri));
          if (!value) {
            throw new FileSystemError("FileNotFound");
          }
          return value;
        },
        async writeFile(uri: FakeUri, content: Uint8Array) {
          files.set(key(uri), content);
        },
        async createDirectory() {},
        async stat(uri: FakeUri) {
          const target = key(uri);
          const found = [...files.keys()].some(
            (path) => path === target || path.startsWith(`${target}/`),
          );
          if (!found) {
            throw new FileSystemError("FileNotFound");
          }
          return {};
        },
        async readDirectory(uri: FakeUri) {
          const prefix = `${key(uri).replace(/\/+$/, "")}/`;
          const entries = new Map<string, number>();
          for (const path of files.keys()) {
            if (!path.startsWith(prefix)) {
              continue;
            }
            const rest = path.slice(prefix.length);
            const name = rest.split("/")[0];
            if (!name) {
              continue;
            }
            entries.set(name, rest.includes("/") ? 2 : 1);
          }
          return [...entries.entries()];
        },
        async delete(uri: FakeUri) {
          const target = key(uri);
          let removed = false;
          for (const path of [...files.keys()]) {
            if (path === target || path.startsWith(`${target}/`)) {
              files.delete(path);
              removed = true;
            }
          }
          if (!removed) {
            throw new FileSystemError("FileNotFound");
          }
        },
      },
    },
  };

  return { vscode, FakeUri, files, textDocuments };
});

vi.mock("vscode", () => mocks.vscode);

function makeStore() {
  return new CacheStore({
    globalStorageUri: new mocks.FakeUri("/storage"),
  } as unknown as vscode.ExtensionContext);
}

const CACHE_URI = new mocks.FakeUri("/storage/cache/project/demo.zh.md");

describe("CacheStore cleanup", () => {
  beforeEach(() => {
    mocks.files.clear();
    mocks.textDocuments.length = 0;
    mocks.files.set(
      "/storage/cache/project/demo.zh.md",
      new TextEncoder().encode("译文缓存"),
    );
  });

  it("deletes one cache and refuses while it is open in an editor", async () => {
    const store = makeStore();
    mocks.textDocuments.push({ uri: CACHE_URI, isDirty: false });
    await expect(
      store.delete(CACHE_URI as unknown as vscode.Uri),
    ).rejects.toThrow(/关闭缓存标签页/);

    mocks.textDocuments.length = 0;
    await expect(
      store.delete(CACHE_URI as unknown as vscode.Uri),
    ).resolves.toBe(true);
    expect(mocks.files.has(CACHE_URI.fsPath)).toBe(false);
    await expect(
      store.delete(CACHE_URI as unknown as vscode.Uri),
    ).resolves.toBe(false);
  });

  it("removes every cache file recursively", async () => {
    const store = makeStore();
    mocks.files.set(
      "/storage/cache/other/nested/guide.zh.md",
      new TextEncoder().encode("另一个缓存"),
    );
    mocks.files.set(
      "/storage/cache/other/notes.md",
      new TextEncoder().encode("说明"),
    );

    await expect(store.clearAll()).resolves.toBe(3);
    expect(mocks.files.size).toBe(0);
  });

  it("reports zero when there is no cache to clear", async () => {
    const store = makeStore();
    mocks.files.clear();
    await expect(store.clearAll()).resolves.toBe(0);
  });

  it("refuses to clear all caches while a cache editor is open", async () => {
    const store = makeStore();
    mocks.textDocuments.push({ uri: CACHE_URI, isDirty: true });

    await expect(store.clearAll()).rejects.toThrow(/关闭所有缓存标签页/);
    expect(mocks.files.size).toBe(1);
  });
});
