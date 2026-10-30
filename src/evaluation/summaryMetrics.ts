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

export interface SummaryCaseEvaluation {
  id: string;
  tags: string[];
  summary: string;
  summaryWords: number;
  summaryWithinRange: boolean;
  brief?: TranslationBrief;
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
  return {
    id: input.id,
    tags: [...(input.tags ?? [])],
    summary: input.result.summary,
    summaryWords,
    summaryWithinRange:
      summaryWords >= SUMMARY_MIN_WORDS &&
      summaryWords <= SUMMARY_MAX_WORDS,
    ...(input.result.brief ? { brief: input.result.brief } : {}),
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
    issueCounts,
  };
}
