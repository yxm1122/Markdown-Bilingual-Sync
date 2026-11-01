/**
 * 摘要/术语表生成质量指标（纯逻辑）。
 *
 * 职责：检查摘要长度、brief 字段长度和 AI 生成术语表的可解释性/可用性。
 * “是否必要”仍需人工评分；这里只给出确定性红旗：
 * - source 在原文中不存在；
 * - source 与 target 相同；
 * - target 含并列译法；
 * - 含代码/URL/HTML/脚注 id/换行；
 * - 与用户术语表冲突；
 * - 只在原文中出现一次（提示性指标，不是硬错误）。
 */
import { hasAlternativeTarget, hasProtectedGlossaryText } from "../glossary/generatedGlossary";
import { countTermOccurrences } from "../util/glossaryMatch";
import {
  BRIEF_FIELD_KEYS,
  type BriefField,
} from "../translation/summaryLocks";
import type {
  GlossaryEntry,
  SummaryResult,
  TranslationBrief,
} from "../translation/types";

export const SUMMARY_MIN_WORDS = 120;
export const SUMMARY_MAX_WORDS = 250;

export type SummaryGlossaryIssueCode =
  | "source-missing"
  | "source-equals-target"
  | "target-alternatives"
  | "target-protected-syntax"
  | "user-glossary-conflict";

export interface SummaryGlossaryIssue {
  code: SummaryGlossaryIssueCode;
  source: string;
  target: string;
  message: string;
}

export interface SummaryGlossaryEntryEvaluation {
  entry: GlossaryEntry;
  /** source 在原文中的词形/子串出现次数。 */
  occurrences: number;
  /** 只出现一次；不影响一致性，提示人工判断是否值得保留。 */
  singleOccurrence: boolean;
  issues: SummaryGlossaryIssue[];
}

export interface SummaryBriefOverlap {
  field: BriefField;
  /** 在摘要中逐段出现的 brief 片段。 */
  segments: string[];
}

export interface SummaryCaseEvaluation {
  id: string;
  tags: string[];
  summary: string;
  summaryWords: number;
  summaryWithinRange: boolean;
  brief?: TranslationBrief;
  /** 任意 brief 字段的显著片段出现在摘要中；用于人工判断越界程度。 */
  briefOverlapFields: BriefField[];
  /** audience/toneAndStyle 被写进摘要；这是明确的翻译要求泄漏。 */
  guidanceLeaks: SummaryBriefOverlap[];
  /** 摘要中出现翻译指导措辞（受众/语气/译法/禁译），advisory。 */
  guidancePhrases: string[];
  /** 摘要对 brief 的字符 8-gram 包含度（0–1，advisory）。 */
  briefOverlapRatio: number;
  glossaryCount: number;
  invalidGlossaryCount: number;
  singleOccurrenceCount: number;
  userGlossaryConflictCount: number;
  entries: SummaryGlossaryEntryEvaluation[];
  issues: SummaryGlossaryIssue[];
}

export interface SummaryEvaluationAggregate {
  caseCount: number;
  totalGlossaryEntries: number;
  averageGlossaryEntries: number;
  totalInvalidEntries: number;
  invalidEntryRate: number;
  totalSingleOccurrenceEntries: number;
  singleOccurrenceRate: number;
  totalUserGlossaryConflicts: number;
  casesWithInvalidEntries: number;
  averageSummaryWords: number;
  summariesWithinRange: number;
  totalBriefOverlapFields: number;
  casesWithGuidanceLeak: number;
  totalGuidancePhrases: number;
  casesWithGuidancePhrases: number;
  averageBriefOverlapRatio: number;
  issueCounts: Record<SummaryGlossaryIssueCode, number>;
}

const ISSUE_CODES: SummaryGlossaryIssueCode[] = [
  "source-missing",
  "source-equals-target",
  "target-alternatives",
  "target-protected-syntax",
  "user-glossary-conflict",
];

function normalizeTerm(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/** 统计摘要词数；中文按词切分，英文/混排也能用同一 Segmenter。 */
export function countSummaryWords(text: string): number {
  const segmenter = new Intl.Segmenter("zh", { granularity: "word" });
  let count = 0;
  for (const part of segmenter.segment(text)) {
    if (part.isWordLike) {
      count += 1;
    }
  }
  return count;
}

function userGlossaryMap(
  userGlossary: readonly GlossaryEntry[] | undefined,
): Map<string, GlossaryEntry> {
  const map = new Map<string, GlossaryEntry>();
  for (const entry of userGlossary ?? []) {
    const source = normalizeTerm(entry.source);
    if (!source) continue;
    map.set(source.toLowerCase(), entry);
  }
  return map;
}

const BRIEF_SEGMENT_SPLIT =
  /[，。；、,;.!?！？:：/|()（）\[\]{}<>《》\s]+|\b(?:and|or)\b|[和与及]/;
const BRIEF_COMPACT_STRIP =
  /[，。；、,;.!?！？:：/|()（）\[\]{}<>《》"'“”‘’—–\-_\s]+/g;
const CJK_PATTERN = /[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/;
const MIN_CJK_SEGMENT = 4;
const MIN_LATIN_SEGMENT = 12;
const BRIEF_OVERLAP_NGRAM = 8;

/** 摘要中出现这些措辞时，说明它可能在写翻译要求而不是描述文档。 */
const GUIDANCE_PHRASE_PATTERNS: Array<{
  label: string;
  pattern: RegExp;
}> = [
  {
    label: "audience",
    pattern: /目标受众|目标读者|面向.{0,16}(读者|用户|工程师|人员|团队)/,
  },
  {
    label: "tone",
    pattern: /语气|语调|语言风格|文体风格|行文风格|写作风格/,
  },
  {
    label: "translation-decision",
    pattern: /译为|译作|应译|统一译|标准译法|翻译为|翻译成/,
  },
  {
    label: "do-not-translate",
    pattern: /不应翻译|不要翻译|无需翻译|保持原文|保持原样|禁译/,
  },
];

function compactOverlapText(value: string): string {
  return value.toLowerCase().replace(BRIEF_COMPACT_STRIP, "");
}

function splitBriefSegments(value: string): string[] {
  return value
    .split(BRIEF_SEGMENT_SPLIT)
    .map((segment) => segment.trim())
    .filter(Boolean);
}

function isSignificantBriefSegment(segment: string): boolean {
  const compact = compactOverlapText(segment);
  if (!compact) {
    return false;
  }
  return compact.length >= (CJK_PATTERN.test(compact)
    ? MIN_CJK_SEGMENT
    : MIN_LATIN_SEGMENT);
}

function evaluateGuidancePhrases(summary: string): string[] {
  return GUIDANCE_PHRASE_PATTERNS.filter(({ pattern }) =>
    pattern.test(summary),
  ).map(({ label }) => label);
}

function characterNgrams(value: string, size: number): Set<string> {
  const compact = compactOverlapText(value);
  const grams = new Set<string>();
  for (let index = 0; index + size <= compact.length; index += 1) {
    grams.add(compact.slice(index, index + size));
  }
  return grams;
}

/**
 * 检测摘要复述 brief 的程度。
 * - briefOverlapFields：显著片段逐字出现在摘要中，advisory；
 * - guidanceLeaks：audience / toneAndStyle 出现在摘要中，属于明确的翻译要求泄漏；
 * - ratio：brief 的 8-gram 被摘要包含的比例，用于看趋势而非硬判定。
 */
function evaluateBriefOverlap(
  summary: string,
  brief: TranslationBrief | undefined,
): { fields: SummaryBriefOverlap[]; ratio: number } {
  if (!brief) {
    return { fields: [], ratio: 0 };
  }
  const summaryCompact = compactOverlapText(summary);
  const fields: SummaryBriefOverlap[] = [];
  for (const field of BRIEF_FIELD_KEYS) {
    const value = brief[field]?.trim();
    if (!value) {
      continue;
    }
    const segments = splitBriefSegments(value).filter(
      (segment) =>
        isSignificantBriefSegment(segment) &&
        summaryCompact.includes(compactOverlapText(segment)),
    );
    if (segments.length > 0) {
      fields.push({ field, segments });
    }
  }
  const briefText = BRIEF_FIELD_KEYS.map((field) => brief[field]?.trim() ?? "")
    .filter(Boolean)
    .join(" ");
  const summaryGrams = characterNgrams(summary, BRIEF_OVERLAP_NGRAM);
  const briefGrams = characterNgrams(briefText, BRIEF_OVERLAP_NGRAM);
  let shared = 0;
  for (const gram of briefGrams) {
    if (summaryGrams.has(gram)) {
      shared += 1;
    }
  }
  return {
    fields,
    ratio: briefGrams.size > 0 ? shared / briefGrams.size : 0,
  };
}

function evaluateEntry(
  entry: GlossaryEntry,
  sourceText: string,
  userGlossary: Map<string, GlossaryEntry>,
): SummaryGlossaryEntryEvaluation {
  const source = normalizeTerm(entry.source);
  const target = normalizeTerm(entry.target);
  const occurrences = countTermOccurrences(sourceText, source);
  const issues: SummaryGlossaryIssue[] = [];
  const add = (code: SummaryGlossaryIssueCode, message: string): void => {
    issues.push({ code, source, target, message });
  };

  if (occurrences === 0) {
    add("source-missing", "source does not appear in the source text");
  }
  if (source.toLowerCase() === target.toLowerCase()) {
    add("source-equals-target", "source and target are identical");
  }
  if (hasAlternativeTarget(source, target)) {
    add("target-alternatives", "target contains more than one rendering");
  }
  if (
    hasProtectedGlossaryText(source) ||
    hasProtectedGlossaryText(target)
  ) {
    add("target-protected-syntax", "term contains code, URL, HTML, or a newline");
  }
  const userEntry = userGlossary.get(source.toLowerCase());
  if (
    userEntry &&
    normalizeTerm(userEntry.target).toLowerCase() !== target.toLowerCase()
  ) {
    add(
      "user-glossary-conflict",
      "generated target differs from the user glossary target",
    );
  }

  return {
    entry: { source, target },
    occurrences,
    singleOccurrence: occurrences === 1,
    issues,
  };
}

/** 评估一份摘要结果；sourceText 应该是剥离 frontmatter 后的正文。 */
export function evaluateSummaryCase(input: {
  id: string;
  tags?: readonly string[];
  sourceText: string;
  result: SummaryResult;
  userGlossary?: readonly GlossaryEntry[];
}): SummaryCaseEvaluation {
  const userGlossary = userGlossaryMap(input.userGlossary);
  const entries = input.result.glossary.map((entry) =>
    evaluateEntry(entry, input.sourceText, userGlossary),
  );
  const issues = entries.flatMap((entry) => entry.issues);
  const summaryWords = countSummaryWords(input.result.summary);
  const briefOverlap = evaluateBriefOverlap(
    input.result.summary,
    input.result.brief,
  );
  return {
    id: input.id,
    tags: [...(input.tags ?? [])],
    summary: input.result.summary,
    summaryWords,
    summaryWithinRange:
      summaryWords >= SUMMARY_MIN_WORDS &&
      summaryWords <= SUMMARY_MAX_WORDS,
    ...(input.result.brief ? { brief: input.result.brief } : {}),
    briefOverlapFields: briefOverlap.fields.map((item) => item.field),
    guidanceLeaks: briefOverlap.fields.filter(
      (item) => item.field === "audience" || item.field === "toneAndStyle",
    ),
    guidancePhrases: evaluateGuidancePhrases(input.result.summary),
    briefOverlapRatio: briefOverlap.ratio,
    glossaryCount: entries.length,
    invalidGlossaryCount: entries.filter((entry) => entry.issues.length > 0)
      .length,
    singleOccurrenceCount: entries.filter((entry) => entry.singleOccurrence)
      .length,
    userGlossaryConflictCount: issues.filter(
      (issue) => issue.code === "user-glossary-conflict",
    ).length,
    entries,
    issues,
  };
}

/** 聚合多份摘要评估；空输入返回全零。 */
export function aggregateSummaryEvaluations(
  cases: readonly SummaryCaseEvaluation[],
): SummaryEvaluationAggregate {
  const issueCounts = Object.fromEntries(
    ISSUE_CODES.map((code) => [code, 0]),
  ) as Record<SummaryGlossaryIssueCode, number>;
  let totalGlossaryEntries = 0;
  let totalInvalidEntries = 0;
  let totalSingleOccurrenceEntries = 0;
  let totalUserGlossaryConflicts = 0;
  let casesWithInvalidEntries = 0;
  let totalSummaryWords = 0;
  let summariesWithinRange = 0;
  let totalBriefOverlapFields = 0;
  let casesWithGuidanceLeak = 0;
  let totalGuidancePhrases = 0;
  let casesWithGuidancePhrases = 0;
  let totalBriefOverlapRatio = 0;
  for (const item of cases) {
    totalGlossaryEntries += item.glossaryCount;
    totalInvalidEntries += item.invalidGlossaryCount;
    totalSingleOccurrenceEntries += item.singleOccurrenceCount;
    totalUserGlossaryConflicts += item.userGlossaryConflictCount;
    if (item.invalidGlossaryCount > 0) {
      casesWithInvalidEntries += 1;
    }
    totalSummaryWords += item.summaryWords;
    if (item.summaryWithinRange) {
      summariesWithinRange += 1;
    }
    totalBriefOverlapFields += item.briefOverlapFields.length;
    if (item.guidanceLeaks.length > 0) {
      casesWithGuidanceLeak += 1;
    }
    if (item.guidancePhrases.length > 0) {
      casesWithGuidancePhrases += 1;
    }
    totalGuidancePhrases += item.guidancePhrases.length;
    totalBriefOverlapRatio += item.briefOverlapRatio;
    for (const issue of item.issues) {
      issueCounts[issue.code] += 1;
    }
  }
  const caseCount = cases.length;
  return {
    caseCount,
    totalGlossaryEntries,
    averageGlossaryEntries:
      caseCount > 0 ? totalGlossaryEntries / caseCount : 0,
    totalInvalidEntries,
    invalidEntryRate:
      totalGlossaryEntries > 0
        ? totalInvalidEntries / totalGlossaryEntries
        : 0,
    totalSingleOccurrenceEntries,
    singleOccurrenceRate:
      totalGlossaryEntries > 0
        ? totalSingleOccurrenceEntries / totalGlossaryEntries
        : 0,
    totalUserGlossaryConflicts,
    casesWithInvalidEntries,
    averageSummaryWords:
      caseCount > 0 ? totalSummaryWords / caseCount : 0,
    summariesWithinRange,
    totalBriefOverlapFields,
    casesWithGuidanceLeak,
    totalGuidancePhrases,
    casesWithGuidancePhrases,
    averageBriefOverlapRatio:
      caseCount > 0 ? totalBriefOverlapRatio / caseCount : 0,
    issueCounts,
  };
}
