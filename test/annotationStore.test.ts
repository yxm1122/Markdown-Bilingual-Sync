/** 测试：本机批注 sidecar 的校验、往返与损坏处理。 */
import { afterEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";

vi.mock("vscode", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./vscodeStub")>();
  return { ...actual.vscodeStub };
});
import type { CacheStore } from "../src/cache/cacheStore";
import {
  AnnotationStore,
  normalizeAnnotationRecord,
} from "../src/annotations/annotationStore";
import type { AnnotationRecord } from "../src/annotations/types";

function record(
  overrides: Partial<AnnotationRecord> = {},
): AnnotationRecord {
  return {
    id: "a1",
    blockId: "b1",
    side: "target",
    author: "user",
    kind: "request-change",
    severity: "info",
    message: "Check this.",
    mode: "once",
    status: "pending",
    sourceIndex: 2,
    createdAt: "2026-10-28T00:00:00.000Z",
    updatedAt: "2026-10-28T00:00:00.000Z",
    ...overrides,
  };
}

function memoryFs() {
  const files = new Map<string, string>();
  vi.spyOn(vscode.workspace.fs, "readFile").mockImplementation(async (uri) => {
    const text = files.get(uri.fsPath);
    if (text === undefined) {
      throw { code: "FileNotFound" };
    }
    return new TextEncoder().encode(text);
  });
  vi.spyOn(vscode.workspace.fs, "writeFile").mockImplementation(
    async (uri, bytes) => {
      files.set(uri.fsPath, new TextDecoder().decode(bytes));
    },
  );
  vi.spyOn(vscode.workspace.fs, "createDirectory").mockResolvedValue();
  vi.spyOn(vscode.workspace.fs, "rename").mockImplementation(
    async (from, to) => {
      const text = files.get(from.fsPath);
      if (text === undefined) {
        throw { code: "FileNotFound" };
      }
      files.set(to.fsPath, text);
      files.delete(from.fsPath);
    },
  );
  vi.spyOn(vscode.workspace.fs, "delete").mockImplementation(async (uri) => {
    if (!files.delete(uri.fsPath)) {
      throw { code: "FileNotFound" };
    }
  });
  return files;
}

const cacheStore = {
  getCacheUri: () => vscode.Uri.file("/storage/cache/demo.zh.md"),
} as unknown as CacheStore;

afterEach(() => {
  vi.restoreAllMocks();
});

describe("annotation store", () => {
  it("round-trips annotations through the sidecar", async () => {
    const files = memoryFs();
    const store = new AnnotationStore(cacheStore);
    await store.write(vscode.Uri.file("/project/demo.md"), "zh-CN", [
      record(),
    ]);
    expect([...files.keys()]).toEqual([
      "/storage/cache/demo.zh.annotations.json",
    ]);
    const result = await store.read(
      vscode.Uri.file("/project/demo.md"),
      "zh-CN",
    );
    expect(result.annotations).toEqual([record()]);
  });

  it("drops invalid records and reports corrupt sidecars", async () => {
    const files = memoryFs();
    const store = new AnnotationStore(cacheStore);
    const uri = store.getAnnotationUri(
      vscode.Uri.file("/project/demo.md"),
      "zh-CN",
    );
    files.set(
      uri.fsPath,
      JSON.stringify({
        version: 1,
        annotations: [
          record(),
          { ...record({ id: "bad" }), side: "middle" },
          { ...record({ id: "bad-kind" }), kind: "unknown" },
        ],
      }),
    );
    const result = await store.read(
      vscode.Uri.file("/project/demo.md"),
      "zh-CN",
    );
    expect(result.annotations.map((entry) => entry.id)).toEqual(["a1"]);

    files.set(uri.fsPath, "{not json");
    const corrupt = await store.read(
      vscode.Uri.file("/project/demo.md"),
      "zh-CN",
    );
    expect(corrupt.annotations).toEqual([]);
    expect(corrupt.warning).toContain("invalid annotations sidecar");
    expect(
      [...files.keys()].some((key) => key.includes(".corrupt-")),
    ).toBe(true);
  });

  it("deletes the sidecar and treats a missing file as empty", async () => {
    memoryFs();
    const store = new AnnotationStore(cacheStore);
    await store.write(vscode.Uri.file("/project/demo.md"), "zh-CN", [
      record(),
    ]);
    await store.delete(vscode.Uri.file("/project/demo.md"), "zh-CN");
    const result = await store.read(
      vscode.Uri.file("/project/demo.md"),
      "zh-CN",
    );
    expect(result.annotations).toEqual([]);
    await expect(
      store.delete(vscode.Uri.file("/project/demo.md"), "zh-CN"),
    ).resolves.toBeUndefined();
  });
});

describe("normalizeAnnotationRecord", () => {
  it("clamps text fields and preserves valid records", () => {
    const normalized = normalizeAnnotationRecord({
      ...record({ message: "  hello  " }),
      question: " q ",
      suggestion: "s".repeat(3000),
    });
    expect(normalized?.message).toBe("hello");
    expect(normalized?.question).toBe("q");
    expect(normalized?.suggestion).toHaveLength(2000);
  });

  it("rejects missing required fields", () => {
    expect(normalizeAnnotationRecord({})).toBeUndefined();
    expect(
      normalizeAnnotationRecord({ ...record(), message: "   " }),
    ).toBeUndefined();
  });

  it("migrates legacy user annotations and keeps suggested answers", () => {
    const legacy = normalizeAnnotationRecord({
      ...record(),
      status: "open",
      kind: "note",
      mode: undefined,
    });
    expect(legacy?.status).toBe("pending");
    expect(legacy?.mode).toBe("persistent");

    const ai = normalizeAnnotationRecord({
      ...record({
        author: "ai",
        kind: "translation-uncertain",
        status: "open",
        mode: undefined,
      }),
      question: "Which register?",
      suggestedAnswers: [
        "Use a neutral register.",
        "Match the document tone.",
        "Use a neutral register.",
      ],
    });
    expect(ai?.suggestedAnswers).toEqual([
      "Use a neutral register.",
      "Match the document tone.",
    ]);
    expect(ai?.mode).toBeUndefined();

    const legacyAnswer = normalizeAnnotationRecord({
      ...record({
        author: "ai",
        kind: "translation-uncertain",
        status: "open",
        mode: undefined,
      }),
      question: "Which register?",
      suggestedAnswer: "Legacy single answer.",
    });
    expect(legacyAnswer?.suggestedAnswers).toEqual([
      "Legacy single answer.",
    ]);
  });

  it("rejects user-status values on AI annotations", () => {
    expect(
      normalizeAnnotationRecord({
        ...record({
          author: "ai",
          kind: "translation-uncertain",
          status: "pending",
          mode: undefined,
        }),
      }),
    ).toBeUndefined();
  });
});
