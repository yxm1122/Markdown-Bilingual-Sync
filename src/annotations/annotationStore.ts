/**
 * 本地批注 sidecar 存储（annotations/annotationStore）。
 *
 * 位置与缓存文件同目录：`<cache>.annotations.json`。批注不进入缓存 Markdown，
 * 也不进入导出；清缓存时由调用方一并删除。写入采用临时文件 + rename，尽量
 * 避免进程崩溃留下半截 JSON。
 */
import * as path from "node:path";
import * as vscode from "vscode";
import type { CacheStore } from "../cache/cacheStore";
import { newBlockId } from "../util/hash";
import {
  MAX_ANNOTATION_EXCERPT,
  MAX_ANNOTATION_MESSAGE,
  MAX_ANNOTATION_SUGGESTION,
  normalizeAnnotationText,
  type AnnotationRecord,
} from "./types";

interface StoredAnnotations {
  version: 1;
  annotations: AnnotationRecord[];
}

export interface AnnotationReadResult {
  annotations: AnnotationRecord[];
  /** sidecar 损坏时的告警；调用方只记录，不阻断预览。 */
  warning?: string;
}

const VALID_SIDES = new Set(["source", "target"]);
const VALID_AUTHORS = new Set(["ai", "user"]);
const VALID_KINDS = new Set([
  "source-issue",
  "translation-uncertain",
  "term",
  "structure",
  "note",
  "request-change",
]);
const VALID_SEVERITIES = new Set(["info", "check"]);
const VALID_STATUSES = new Set(["open", "resolved", "dismissed"]);
const warnedCorruptFiles = new Set<string>();

/** 兼容真实 FileSystemError 与测试替身的 code。 */
function isFileNotFound(error: unknown): boolean {
  return (
    (typeof vscode.FileSystemError === "function" &&
      error instanceof vscode.FileSystemError &&
      error.code === "FileNotFound") ||
    (typeof error === "object" &&
      error !== null &&
      (error as { code?: unknown }).code === "FileNotFound")
  );
}

function readString(value: unknown, max: number): string | undefined {
  return normalizeAnnotationText(value, max);
}

/** 校验单条批注；字段不合法时返回 undefined。 */
export function normalizeAnnotationRecord(
  raw: unknown,
): AnnotationRecord | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }
  const record = raw as Record<string, unknown>;
  const id = readString(record.id, 80);
  const blockId = readString(record.blockId, 160);
  const message = readString(record.message, MAX_ANNOTATION_MESSAGE);
  const side = readString(record.side, 20);
  const author = readString(record.author, 20);
  const kind = readString(record.kind, 40);
  const severity = readString(record.severity, 20);
  const status = readString(record.status, 20);
  const createdAt = readString(record.createdAt, 40);
  const updatedAt = readString(record.updatedAt, 40);
  const sourceIndex =
    typeof record.sourceIndex === "number" &&
    Number.isInteger(record.sourceIndex) &&
    record.sourceIndex >= 0
      ? record.sourceIndex
      : undefined;
  if (
    !id ||
    !blockId ||
    !message ||
    !side ||
    !author ||
    !kind ||
    !severity ||
    !status ||
    !createdAt ||
    !updatedAt ||
    !VALID_SIDES.has(side) ||
    !VALID_AUTHORS.has(author) ||
    !VALID_KINDS.has(kind) ||
    !VALID_SEVERITIES.has(severity) ||
    !VALID_STATUSES.has(status)
  ) {
    return undefined;
  }
  return {
    id,
    blockId,
    side: side as AnnotationRecord["side"],
    author: author as AnnotationRecord["author"],
    kind: kind as AnnotationRecord["kind"],
    severity: severity as AnnotationRecord["severity"],
    message,
    ...(readString(record.question, MAX_ANNOTATION_MESSAGE)
      ? { question: readString(record.question, MAX_ANNOTATION_MESSAGE) }
      : {}),
    ...(readString(record.sourceExcerpt, MAX_ANNOTATION_EXCERPT)
      ? {
          sourceExcerpt: readString(
            record.sourceExcerpt,
            MAX_ANNOTATION_EXCERPT,
          ),
        }
      : {}),
    ...(readString(record.targetExcerpt, MAX_ANNOTATION_EXCERPT)
      ? {
          targetExcerpt: readString(
            record.targetExcerpt,
            MAX_ANNOTATION_EXCERPT,
          ),
        }
      : {}),
    ...(readString(record.suggestion, MAX_ANNOTATION_SUGGESTION)
      ? {
          suggestion: readString(
            record.suggestion,
            MAX_ANNOTATION_SUGGESTION,
          ),
        }
      : {}),
    status: status as AnnotationRecord["status"],
    ...(readString(record.sourceHash, 120)
      ? { sourceHash: readString(record.sourceHash, 120) }
      : {}),
    ...(sourceIndex !== undefined ? { sourceIndex } : {}),
    createdAt,
    updatedAt,
  };
}

/** 损坏 sidecar 只备份一次，避免每次预览都产生新文件。 */
async function backupCorruptSidecar(
  uri: vscode.Uri,
  bytes: Uint8Array,
): Promise<string> {
  const base = `invalid annotations sidecar: ${path.basename(uri.fsPath)}`;
  if (warnedCorruptFiles.has(uri.fsPath)) {
    return base;
  }
  warnedCorruptFiles.add(uri.fsPath);
  const backup = vscode.Uri.file(
    `${uri.fsPath}.corrupt-${newBlockId()}.json`,
  );
  try {
    await vscode.workspace.fs.writeFile(backup, bytes);
    return `${base}; backup: ${path.basename(backup.fsPath)}`;
  } catch {
    return base;
  }
}

/** 批注 sidecar 读写。 */
export class AnnotationStore {
  constructor(private readonly cacheStore: CacheStore) {}

  /** sidecar 路径；与缓存文件同目录、同语言后缀。 */
  getAnnotationUri(
    sourceUri: vscode.Uri,
    targetLanguage: string,
  ): vscode.Uri {
    const cacheUri = this.cacheStore.getCacheUri(sourceUri, targetLanguage);
    const file = cacheUri.fsPath.endsWith(".md")
      ? `${cacheUri.fsPath.slice(0, -3)}.annotations.json`
      : `${cacheUri.fsPath}.annotations.json`;
    return vscode.Uri.file(file);
  }

  /** 读取批注；文件不存在返回空数组，损坏时返回空数组并给告警。 */
  async read(
    sourceUri: vscode.Uri,
    targetLanguage: string,
  ): Promise<AnnotationReadResult> {
    const uri = this.getAnnotationUri(sourceUri, targetLanguage);
    let text: string;
    let bytes: Uint8Array;
    try {
      bytes = await vscode.workspace.fs.readFile(uri);
      text = new TextDecoder("utf-8").decode(bytes).trim();
    } catch (error) {
      if (isFileNotFound(error)) {
        return { annotations: [] };
      }
      throw error;
    }
    if (!text) {
      return { annotations: [] };
    }
    const corrupted = async (): Promise<AnnotationReadResult> => ({
      annotations: [],
      warning: await backupCorruptSidecar(uri, bytes),
    });
    try {
      const parsed: unknown = JSON.parse(text);
      const raw =
        parsed && typeof parsed === "object" && !Array.isArray(parsed)
          ? (parsed as Record<string, unknown>).annotations
          : parsed;
      if (!Array.isArray(raw)) {
        return corrupted();
      }
      const annotations = raw
        .map((item) => normalizeAnnotationRecord(item))
        .filter((item): item is AnnotationRecord => Boolean(item));
      warnedCorruptFiles.delete(uri.fsPath);
      return { annotations };
    } catch {
      return corrupted();
    }
  }

  /** 原子写入批注 sidecar；空数组也会写入（保留版本文件）。 */
  async write(
    sourceUri: vscode.Uri,
    targetLanguage: string,
    annotations: readonly AnnotationRecord[],
  ): Promise<void> {
    const uri = this.getAnnotationUri(sourceUri, targetLanguage);
    const payload: StoredAnnotations = {
      version: 1,
      annotations: [...annotations],
    };
    await vscode.workspace.fs.createDirectory(
      vscode.Uri.file(path.dirname(uri.fsPath)),
    );
    const temp = vscode.Uri.file(`${uri.fsPath}.${newBlockId()}.tmp`);
    try {
      await vscode.workspace.fs.writeFile(
        temp,
        new TextEncoder().encode(JSON.stringify(payload, null, 2)),
      );
      await vscode.workspace.fs.rename(temp, uri, { overwrite: true });
    } catch (error) {
      try {
        await vscode.workspace.fs.delete(temp, { useTrash: false });
      } catch {
        // 临时文件可能尚未创建。
      }
      throw error;
    }
  }

  /** 删除 sidecar；文件不存在时静默。 */
  async delete(
    sourceUri: vscode.Uri,
    targetLanguage: string,
  ): Promise<void> {
    const uri = this.getAnnotationUri(sourceUri, targetLanguage);
    try {
      await vscode.workspace.fs.delete(uri, { useTrash: false });
    } catch (error) {
      if (isFileNotFound(error)) {
        return;
      }
      throw error;
    }
  }
}
