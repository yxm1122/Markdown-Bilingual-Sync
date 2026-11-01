/**
 * 术语表解析（glossary/glossary）
 *
 * 职责：把用户编辑的 glossary.json 解析为去重后的术语条目，并收集可展示的警告。
 * 术语只会作为提示词上下文与纯文本替换使用，不参与 Markdown 结构解析。
 *
 * 关键不变量：
 * - 最多保留 MAX_USER_GLOSSARY_ENTRIES 条；source 不区分大小写去重，后出现的条目覆盖先出现的；
 * - 单项 source/target 去除首尾空白，超过 MAX_TERM_LENGTH 或缺失时忽略并警告；
 * - 解析失败抛本地化错误；可恢复问题通过 warnings 返回，不中断翻译。
 *
 * 外部依赖：仅 translation/types 的 GlossaryEntry；不做 I/O。
 */
import type { GlossaryEntry } from "../translation/types";
import { tError } from "../i18n/errors";

/** 用户术语表（全局/工作区）的条目上限。 */
export const MAX_USER_GLOSSARY_ENTRIES = 1000;
export const MAX_TERM_LENGTH = 200;
/** 单篇文档随摘要保存的术语上限；远小于用户术语表，避免把摘要元数据撑大。 */
export const MAX_DOCUMENT_GLOSSARY_ENTRIES = 200;

/** 解析结果：有效条目 + 可展示警告（不会包含重复项）。 */
export interface GlossaryLoadResult {
  entries: GlossaryEntry[];
  warnings: string[];
}

/** 一个已解析的术语表来源，用于按作用域顺序合并。 */
export interface NamedGlossary {
  /** 文件名/作用域标签，用于给告警加前缀。 */
  label: string;
  result: GlossaryLoadResult;
}

/**
 * 按给定顺序合并多个术语表：后出现的同名 source 覆盖前面的条目。
 * 告警会带上来源标签，便于用户定位是哪个文件出了问题。
 */
export function mergeGlossaryResults(
  sources: readonly NamedGlossary[],
): GlossaryLoadResult {
  const warnings: string[] = [];
  const groups: GlossaryEntry[][] = [];
  for (const source of sources) {
    for (const warning of source.result.warnings) {
      warnings.push(`${source.label}: ${warning}`);
    }
    groups.push(source.result.entries);
  }
  return { entries: mergeGlossaryEntries(groups), warnings };
}

/**
 * 按给定顺序合并术语组：后出现的同名 source 覆盖前面的条目。
 * 用于把用户术语表与缓存中的文档术语表合并；不产生警告。
 */
export function mergeGlossaryEntries(
  groups: readonly (readonly GlossaryEntry[])[],
): GlossaryEntry[] {
  const entries = new Map<string, GlossaryEntry>();
  for (const group of groups) {
    for (const entry of group) {
      if (!entry.source || !entry.target) {
        continue;
      }
      entries.set(entry.source.toLowerCase(), entry);
    }
  }
  return [...entries.values()];
}

/**
 * 把指定 source 的条目排到前面，供请求侧在条数/字符上限内优先保留文档术语。
 * 不改变条目内容，只调整顺序。
 */
export function prioritizeGlossaryEntries(
  entries: readonly GlossaryEntry[],
  prioritySources: readonly string[],
): GlossaryEntry[] {
  if (prioritySources.length === 0) {
    return [...entries];
  }
  const keys = new Set(prioritySources.map((source) => source.toLowerCase()));
  return [
    ...entries.filter((entry) => keys.has(entry.source.toLowerCase())),
    ...entries.filter((entry) => !keys.has(entry.source.toLowerCase())),
  ];
}

/**
 * 校验并归一化不可信术语数组（摘要模型输出、缓存元数据）。
 * 非数组、非对象、空字段、超长项会被忽略；同名 source 以最后一条为准。
 */
export function normalizeGlossaryEntries(
  raw: unknown,
  maxEntries = MAX_DOCUMENT_GLOSSARY_ENTRIES,
): GlossaryEntry[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const entries = new Map<string, GlossaryEntry>();
  for (const item of raw) {
    if (!isRecord(item)) {
      continue;
    }
    const source = readTerm(item.source);
    const target = readTerm(item.target);
    if (!source || !target) {
      continue;
    }
    const key = source.toLowerCase();
    if (!entries.has(key) && entries.size >= maxEntries) {
      break;
    }
    entries.set(key, { source, target });
  }
  return [...entries.values()];
}

/** 判断值是否为普通对象（排除 null 与数组）。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** 读取术语字符串：trim 后非空且不超过长度上限，否则返回 undefined。 */
function readTerm(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const term = value.trim();
  return term && term.length <= MAX_TERM_LENGTH ? term : undefined;
}

/** 术语表扫描问题；按条目出现顺序记录，便于还原既有告警顺序。 */
interface GlossaryScanIssue {
  kind: "non-object" | "invalid" | "duplicate" | "limit";
  /** 1 基条目序号；limit 表示触发上限的条目。 */
  index: number;
  /** duplicate 的原文 source。 */
  source?: string;
}

interface GlossaryScan {
  entries: GlossaryEntry[];
  issues: GlossaryScanIssue[];
  invalidItems: number[];
  duplicateSources: string[];
  overflow: boolean;
}

/** 术语表顶层结构错误；Agent 工具据此返回稳定的 GLOSSARY_INVALID。 */
export type GlossaryParseErrorReason = "invalid-json" | "not-array";

export class GlossaryParseError extends Error {
  constructor(
    readonly reason: GlossaryParseErrorReason,
    message: string,
  ) {
    super(message);
    this.name = "GlossaryParseError";
  }
}

/** 术语表结构检查结果；供更新操作在合并前拒绝会丢数据的文件。 */
export interface GlossaryInspection {
  entries: GlossaryEntry[];
  /** 结构无效的条目序号（1 基）。 */
  invalidItems: number[];
  /** 重复 source 的原文拼写。 */
  duplicateSources: string[];
  /** 是否因超过 MAX_USER_GLOSSARY_ENTRIES 而截断。 */
  overflow: boolean;
}

/** 解析顶层 JSON 并取出条目数组；结构错误抛出本地化错误。 */
function readGlossaryItems(text: string): unknown[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new GlossaryParseError(
      "invalid-json",
      tError("glossary.invalidJson"),
    );
  }

  const rawEntries = Array.isArray(parsed)
    ? parsed
    : isRecord(parsed) && Array.isArray(parsed.entries)
      ? parsed.entries
      : undefined;
  if (!rawEntries) {
    throw new GlossaryParseError(
      "not-array",
      tError("glossary.notArray"),
    );
  }
  return rawEntries;
}

/**
 * 扫描条目数组：保留有效的最后一条同名 source，并记录无效项、重复项与上限溢出。
 * 不抛错；JSON 结构问题由 readGlossaryItems 负责。
 */
function scanGlossaryItems(rawEntries: readonly unknown[]): GlossaryScan {
  const entries = new Map<string, GlossaryEntry>();
  const issues: GlossaryScanIssue[] = [];
  const invalidItems: number[] = [];
  const duplicateSources: string[] = [];
  let overflow = false;

  for (let index = 0; index < rawEntries.length; index += 1) {
    const raw = rawEntries[index];
    const itemIndex = index + 1;
    if (!isRecord(raw)) {
      issues.push({ kind: "non-object", index: itemIndex });
      invalidItems.push(itemIndex);
      continue;
    }
    const source = readTerm(raw.source);
    const target = readTerm(raw.target);
    if (!source || !target) {
      issues.push({ kind: "invalid", index: itemIndex });
      invalidItems.push(itemIndex);
      continue;
    }
    const key = source.toLowerCase();
    if (entries.has(key)) {
      issues.push({ kind: "duplicate", index: itemIndex, source });
      duplicateSources.push(source);
    }
    if (!entries.has(key) && entries.size >= MAX_USER_GLOSSARY_ENTRIES) {
      issues.push({ kind: "limit", index: itemIndex });
      overflow = true;
      break;
    }
    entries.set(key, { source, target });
  }

  return {
    entries: [...entries.values()],
    issues,
    invalidItems,
    duplicateSources,
    overflow,
  };
}

/**
 * 严格检查术语表文本：区分无效条目、重复条目和上限溢出。
 * @throws GlossaryParseError JSON 语法错误或顶层结构不合法时抛出本地化错误。
 */
export function inspectGlossaryText(text: string): GlossaryInspection {
  const scan = scanGlossaryItems(readGlossaryItems(text));
  return {
    entries: scan.entries,
    invalidItems: scan.invalidItems,
    duplicateSources: scan.duplicateSources,
    overflow: scan.overflow,
  };
}

/**
 * 解析术语表 JSON。
 * 支持顶层数组或 `{ "entries": [...] }` 两种形式。
 * @throws JSON 语法错误或顶层结构不合法时抛出本地化错误。
 */
export function parseGlossaryText(text: string): GlossaryLoadResult {
  const scan = scanGlossaryItems(readGlossaryItems(text));
  const warnings = scan.issues.map((issue) => {
    switch (issue.kind) {
      case "non-object":
        return tError("glossary.nonObject", { index: issue.index });
      case "invalid":
        return tError("glossary.invalidEntry", {
          index: issue.index,
          max: MAX_TERM_LENGTH,
        });
      case "duplicate":
        return tError("glossary.duplicateEntry", {
          index: issue.index,
          source: issue.source ?? "",
        });
      case "limit":
        return tError("glossary.limit", {
          max: MAX_USER_GLOSSARY_ENTRIES,
        });
    }
  });
  return { entries: scan.entries, warnings };
}
