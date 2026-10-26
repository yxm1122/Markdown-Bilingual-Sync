/**
 * 术语表解析（glossary/glossary）
 *
 * 职责：把用户编辑的 glossary.json 解析为去重后的术语条目，并收集可展示的警告。
 * 术语只会作为提示词上下文与纯文本替换使用，不参与 Markdown 结构解析。
 *
 * 关键不变量：
 * - 最多保留 MAX_ENTRIES 条；source 不区分大小写去重，后出现的条目覆盖先出现的；
 * - 单项 source/target 去除首尾空白，超过 MAX_TERM_LENGTH 或缺失时忽略并警告；
 * - 解析失败抛本地化错误；可恢复问题通过 warnings 返回，不中断翻译。
 *
 * 外部依赖：仅 translation/types 的 GlossaryEntry；不做 I/O。
 */
import type { GlossaryEntry } from "../translation/types";
import { tError } from "../i18n/errors";

const MAX_ENTRIES = 1000;
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

/**
 * 解析术语表 JSON。
 * 支持顶层数组或 `{ "entries": [...] }` 两种形式。
 * @throws JSON 语法错误或顶层结构不合法时抛出本地化错误。
 */
export function parseGlossaryText(text: string): GlossaryLoadResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(
      tError("glossary.invalidJson"),
    );
  }

  const rawEntries = Array.isArray(parsed)
    ? parsed
    : isRecord(parsed) && Array.isArray(parsed.entries)
      ? parsed.entries
      : undefined;
  if (!rawEntries) {
    throw new Error(
      tError("glossary.notArray"),
    );
  }

  const entries = new Map<string, GlossaryEntry>();
  const warnings: string[] = [];
  for (let index = 0; index < rawEntries.length; index += 1) {
    const raw = rawEntries[index];
    if (!isRecord(raw)) {
      warnings.push(tError("glossary.nonObject", { index: index + 1 }));
      continue;
    }
    const source = readTerm(raw.source);
    const target = readTerm(raw.target);
    if (!source || !target) {
      warnings.push(
        tError("glossary.invalidEntry", { index: index + 1, max: MAX_TERM_LENGTH }),
      );
      continue;
    }
    const key = source.toLowerCase();
    if (entries.has(key)) {
      warnings.push(
        tError("glossary.duplicateEntry", { index: index + 1, source: source }),
      );
    }
    if (!entries.has(key) && entries.size >= MAX_ENTRIES) {
      warnings.push(tError("glossary.limit", { max: MAX_ENTRIES }));
      break;
    }
    entries.set(key, { source, target });
  }

  return { entries: [...entries.values()], warnings };
}
