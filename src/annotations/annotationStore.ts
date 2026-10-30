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
  MAX_ANNOTATION_OPTION,
  MAX_REVIEW_OPTIONS,
  normalizeAnnotationText,
  normalizeReviewOptions,
  type AnnotationMode,
  type AnnotationRecord,
  type AnnotationStatus,
} from "./types";
import type { ReviewOption } from "../translation/types";

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
const AI_STATUSES = new Set(["open", "resolved", "dismissed"]);
const USER_STATUSES = new Set([
  "open",
  "pending",
  "applied",
  "ineffective",
  "resolved",
  "dismissed",
]);
const VALID_MODES = new Set(["once", "persistent"]);
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

/**
 * 读取 AI 批注的处理项。
 * 旧 sidecar 里的 suggestion/suggestedAnswers 在读取时迁移为 advice/instruction；
 * 旧候选回答没有 mode，按一次性处理。
 */
function readReviewOptions(record: Record<string, unknown>): ReviewOption[] {
  const current = normalizeReviewOptions(record.options);
  if (current.length > 0) {
    return current;
  }
  const answers: unknown[] = [];
  if (Array.isArray(record.suggestedAnswers)) {
    answers.push(...record.suggestedAnswers);
  } else if (record.suggestedAnswers !== undefined) {
    answers.push(record.suggestedAnswers);
  }
  if (record.suggestedAnswer !== undefined) {
    answers.push(record.suggestedAnswer);
  }
  const instructions: ReviewOption[] = [];
  for (const value of answers) {
    const text = readString(value, MAX_ANNOTATION_OPTION);
    if (
      text &&
      !instructions.some((option) => option.text === text) &&
      instructions.length < MAX_REVIEW_OPTIONS
    ) {
      instructions.push({ kind: "instruction", text, mode: "once" });
    }
  }
  if (instructions.length > 0) {
    return instructions;
  }
  const suggestion = readString(record.suggestion, MAX_ANNOTATION_OPTION);
  return suggestion ? [{ kind: "advice", text: suggestion }] : [];
}

/** 校验单条批注；字段不合法时返回 undefined。旧版用户批注会就地迁移到新状态。 */
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
  const authorRaw = readString(record.author, 20);
  const kind = readString(record.kind, 40);
  const severity = readString(record.severity, 20);
  const statusRaw = readString(record.status, 20);
  const modeRaw = readString(record.mode, 20);
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
    !authorRaw ||
    !kind ||
    !severity ||
    !statusRaw ||
    !createdAt ||
    !updatedAt ||
    !VALID_SIDES.has(side) ||
    !VALID_AUTHORS.has(authorRaw) ||
    !VALID_KINDS.has(kind) ||
    !VALID_SEVERITIES.has(severity)
  ) {
    return undefined;
  }
  const author = authorRaw as AnnotationRecord["author"];
  const validStatus =
    author === "ai" ? AI_STATUSES.has(statusRaw) : USER_STATUSES.has(statusRaw);
  if (!validStatus) {
    return undefined;
  }
  // 旧版用户批注用 open 表示未处理；新版改用 pending。
  const status: AnnotationStatus =
    author === "user" && statusRaw === "open"
      ? "pending"
      : (statusRaw as AnnotationStatus);
  if (
    author === "user" &&
    modeRaw !== undefined &&
    !VALID_MODES.has(modeRaw)
  ) {
    return undefined;
  }
  const mode: AnnotationMode | undefined =
    author === "user"
      ? ((modeRaw as AnnotationMode | undefined) ?? "persistent")
      : undefined;
  const question = readString(record.question, MAX_ANNOTATION_MESSAGE);
  const options = author === "ai" ? readReviewOptions(record) : [];
  return {
    id,
    blockId,
    side: side as AnnotationRecord["side"],
    author,
    kind: kind as AnnotationRecord["kind"],
    severity: severity as AnnotationRecord["severity"],
    message,
    ...(question ? { question } : {}),
    ...(options.length ? { options } : {}),
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
    ...(mode ? { mode } : {}),
    status,
    ...(readString(record.sourceHash, 120)
      ? { sourceHash: readString(record.sourceHash, 120) }
      : {}),
    ...(sourceIndex !== undefined ? { sourceIndex } : {}),
    ...(readString(record.originAnnotationId, 160)
      ? {
          originAnnotationId: readString(
            record.originAnnotationId,
            160,
          ),
        }
      : {}),
    ...(readString(record.answeredBy, 160)
      ? { answeredBy: readString(record.answeredBy, 160) }
      : {}),
    ...(readString(record.lastAppliedAt, 40)
      ? { lastAppliedAt: readString(record.lastAppliedAt, 40) }
      : {}),
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
