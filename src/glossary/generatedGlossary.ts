/**
 * AI 生成术语表的确定性过滤。
 *
 * 摘要提示词只能引导模型，不能保证输出质量；这里在写入缓存前丢弃明显不可用的
 * 条目：原文中不存在、原文与译文相同、带并列译法、含受保护 Markdown、只出现
 * 一次、重复用户术语，以及归一化后重复的 source。用户编辑的术语表不经过此过滤。
 */
import type { GlossaryEntry } from "../translation/types";
import { countTermOccurrences } from "../util/glossaryMatch";

export type GeneratedGlossaryDropReason =
  | "empty-term"
  | "missing-source"
  | "same-target"
  | "alternative-target"
  | "protected-syntax"
  | "duplicate-source"
  | "single-occurrence"
  | "user-glossary-duplicate";

export interface GeneratedGlossaryFilterOptions {
  /** source 至少出现的次数；默认 1。产品默认用 2，只保留需要一致性的术语。 */
  minOccurrences?: number;
  /** 用户术语表已覆盖的 source；生成结果不重复收录。 */
  reservedSources?: readonly string[];
}

export interface DroppedGeneratedGlossaryEntry {
  entry: GlossaryEntry;
  reason: GeneratedGlossaryDropReason;
}

export interface GeneratedGlossaryFilterResult {
  entries: GlossaryEntry[];
  dropped: DroppedGeneratedGlossaryEntry[];
}

const ALTERNATIVE_SEPARATOR = /[、；;]/u;
const WORD_ALTERNATIVE = /\s+(?:or|或)\s+/iu;
const CJK_ALTERNATIVE = /[^\s或]{2,}或[^\s或]{2,}/u;
const UPPERCASE_PAIR = /^[A-Z0-9]+(?:[/／][A-Z0-9]+)+$/u;
const SLASH = /[/／]/u;
const PROTECTED_SYNTAX =
  /(?:`|```|https?:\/\/|www\.|<[^>]+>|\[\^[^\]]+\]|\r?\n)/iu;

function normalizeTerm(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/**
 * 判断 target 是否给出多个并列译法。
 *
 * `source` 自身含斜杠时视为成对术语（如 I/O → 输入/输出），允许 target 保留斜杠；
 * `、` 与 `or/或` 无论 source 如何都按并列处理。
 */
export function hasAlternativeTarget(
  source: string,
  target: string,
): boolean {
  if (ALTERNATIVE_SEPARATOR.test(target) || WORD_ALTERNATIVE.test(target)) {
    return true;
  }
  // “缓存或高速缓存”是没有空格的并列；source 本身含 or/或 时可能是“逻辑或运算”这类单一术语。
  if (
    CJK_ALTERNATIVE.test(target) &&
    !/\bor\b/i.test(source) &&
    !/或/.test(source)
  ) {
    return true;
  }
  if (!SLASH.test(target) || SLASH.test(source)) {
    return false;
  }
  // CI/CD、A/B 这类全大写缩写是成对术语，不是“缓存/高速缓存”式并列译法。
  return !UPPERCASE_PAIR.test(target);
}

/** 判断术语文本是否包含代码、URL、HTML、脚注引用或换行。 */
export function hasProtectedGlossaryText(value: string): boolean {
  return PROTECTED_SYNTAX.test(value);
}

/**
 * 过滤 AI 生成的术语条目，并保留丢弃原因供日志/评估使用。
 * 顺序稳定；source 不区分大小写去重，保留先出现的条目。
 */
export function filterGeneratedGlossary(
  entries: readonly GlossaryEntry[],
  sourceText: string,
  options: GeneratedGlossaryFilterOptions = {},
): GeneratedGlossaryFilterResult {
  const kept: GlossaryEntry[] = [];
  const dropped: DroppedGeneratedGlossaryEntry[] = [];
  const seen = new Set<string>();
  const reserved = new Set(
    (options.reservedSources ?? []).map((source) =>
      normalizeTerm(source).toLowerCase(),
    ),
  );
  const minOccurrences = Math.max(1, Math.trunc(options.minOccurrences ?? 1));
  for (const entry of entries) {
    const source = normalizeTerm(entry.source);
    const target = normalizeTerm(entry.target);
    const occurrences = source
      ? countTermOccurrences(sourceText, source)
      : 0;
    let reason: GeneratedGlossaryDropReason | undefined;
    if (!source || !target) {
      reason = "empty-term";
    } else if (occurrences === 0) {
      reason = "missing-source";
    } else if (source.toLowerCase() === target.toLowerCase()) {
      reason = "same-target";
    } else if (
      hasProtectedGlossaryText(source) ||
      hasProtectedGlossaryText(target)
    ) {
      reason = "protected-syntax";
    } else if (hasAlternativeTarget(source, target)) {
      reason = "alternative-target";
    } else if (reserved.has(source.toLowerCase())) {
      reason = "user-glossary-duplicate";
    } else if (occurrences < minOccurrences) {
      reason = "single-occurrence";
    } else if (seen.has(source.toLowerCase())) {
      reason = "duplicate-source";
    }
    if (reason) {
      dropped.push({ entry, reason });
      continue;
    }
    seen.add(source.toLowerCase());
    kept.push({ source, target });
  }
  return { entries: kept, dropped };
}
