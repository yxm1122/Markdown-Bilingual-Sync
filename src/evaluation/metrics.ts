/**
 * 翻译质量评估指标（纯逻辑）。
 *
 * 职责：把一份源文档、候选译文和可选人工参考译文解析为可比较的顶层块，输出结构、
 * 漏译/回显、受保护 Markdown 片段、术语遵循、块内结构和参考相似度等指标。供
 * scripts/evaluate-translation.ts 与单元测试共用。
 *
 * 关键不变量：
 * - 评估按顶层块索引对齐，不修改源/候选/参考文本；
 * - 代码、URL、公式、HTML、脚注 id 等受保护片段必须在候选译文中原样出现；
 * - 术语检查只统计源块中实际出现的术语，并按块记录是否使用目标术语；
 * - 人工参考相似度只是辅助信号，不参与 pass/fail；
 * - 所有硬问题写入 `issues`，`pass` 等价于没有任何硬问题。
 *
 * 外部依赖：segmenter、Markdown 类型与术语类型；不依赖 vscode、不读写文件。
 */
import { createMarkdownRuntime } from "../markdown/markdown";
import { parseMarkdownDocument } from "../markdown/segmenter";
import type { BlockKind, MarkdownBlock } from "../markdown/types";
import { TRANSLATABLE_KINDS } from "../markdown/types";
import type { GlossaryEntry } from "../translation/types";
import { containsTerm } from "../util/glossaryMatch";
import { normalizeNewlines } from "../util/hash";
import {
  countProtectedTokens,
  extractProtectedTokens,
  stripProtectedForGlossary,
} from "../util/protectedMarkdown";
import { normalizeBlockContent } from "../util/text";

/** 一条评估问题；code 用于测试和报告分组，message 用于人读。 */
export interface EvaluationIssue {
  code: string;
  message: string;
  blockIndex?: number;
}

/** 单块评估结果；candidate/reference 缺失时仅保留可计算的字段。 */
export interface BlockEvaluation {
  index: number;
  kind: BlockKind;
  translatable: boolean;
  candidateFound: boolean;
  candidateKind?: BlockKind;
  kindMatches: boolean;
  empty: boolean;
  untranslated: boolean;
  copiedExactly: boolean;
  /** 源块中受保护片段的数量与候选中缺失的片段。 */
  protectedTokens: { total: number; missing: string[] };
  /** 源块中适用但候选未使用目标术语的 source 词条。 */
  glossaryMissing: string[];
  /** 标记结构（标题级别、列表项数、表格行数、引用行数）不一致的描述。 */
  structureIssues: string[];
  /** 候选长度 / 源长度；无候选或源为空时省略。 */
  lengthRatio?: number;
  /** 源文拉丁词在候选中的保留比例；用于发现“只加标记、未翻译”的输出。 */
  sourceWordRetention?: number;
  /** 与人工参考译文的字符 bigram Dice 相似度；仅辅助观察。 */
  referenceSimilarity?: number;
  issues: EvaluationIssue[];
}

/** 一份文档的完整评估指标。 */
export interface EvaluationMetrics {
  sourceBlocks: number;
  candidateBlocks: number;
  referenceBlocks?: number;
  missingBlocks: number;
  extraBlocks: number;
  kindMismatches: number;
  untranslatedBlocks: number;
  emptyBlocks: number;
  protectedTokenTotal: number;
  protectedTokenMissing: string[];
  glossaryChecks: number;
  glossaryAdhered: number;
  glossaryMissing: string[];
  structureIssueCount: number;
  frontmatter: {
    source: boolean;
    candidate: boolean;
    matches: boolean;
  };
  averageLengthRatio?: number;
  averageReferenceSimilarity?: number;
  blockResults: BlockEvaluation[];
  issues: EvaluationIssue[];
  pass: boolean;
}

/** 评估一个用例的输入。 */
export interface EvaluateCaseInput {
  id: string;
  sourceText: string;
  candidateText: string;
  referenceText?: string;
  glossary?: readonly GlossaryEntry[];
  tags?: readonly string[];
  sourceLanguage?: string;
  targetLanguage?: string;
}

/** 单个用例的评估结果。 */
export interface CaseEvaluation {
  id: string;
  tags: string[];
  sourceLanguage: string;
  targetLanguage: string;
  sourceBlocks: number;
  candidateBlocks: number;
  referenceProvided: boolean;
  metrics: EvaluationMetrics;
}

/** 聚合多个用例的结果。 */
export interface EvaluationAggregate {
  caseCount: number;
  passedCases: number;
  failedCases: number;
  sourceBlocks: number;
  candidateBlocks: number;
  missingBlocks: number;
  extraBlocks: number;
  kindMismatches: number;
  untranslatedBlocks: number;
  emptyBlocks: number;
  protectedTokenTotal: number;
  protectedTokenMissing: number;
  glossaryChecks: number;
  glossaryAdhered: number;
  glossaryMissing: number;
  structureIssueCount: number;
  averageLengthRatio?: number;
  averageReferenceSimilarity?: number;
}

// ---- 文本比较工具 ----
// 受保护片段的提取与去保护逻辑放在 util/protectedMarkdown，与 Provider 校验共用。

function normalizeForCompare(text: string): string {
  return normalizeBlockContent(text).toLowerCase().replace(/\s+/g, " ").trim();
}

/** 英文常用功能词；用于区分“整段照抄”和“保留专有名词的合法译文”。 */
const COMMON_ENGLISH_WORDS = new Set([
  "the",
  "and",
  "are",
  "is",
  "to",
  "of",
  "in",
  "for",
  "with",
  "that",
  "this",
  "on",
  "as",
  "by",
  "be",
  "it",
  "from",
  "at",
  "or",
  "if",
  "when",
  "not",
  "you",
  "your",
  "we",
  "can",
  "will",
  "should",
  "must",
  "has",
  "have",
  "was",
  "were",
]);

/** 提取长度 >=3 的拉丁词（去重），用于估计源文是否被整体保留。 */
function latinWords(text: string): string[] {
  const words = new Set<string>();
  for (const match of text.toLowerCase().matchAll(/[a-z][a-z0-9_-]{2,}/g)) {
    words.add(match[0]);
  }
  return [...words];
}

/** 字符 bigram Dice 相似度；仅作参考译文的辅助观察。 */
function bigramDice(a: string, b: string): number {
  const left = normalizeForCompare(a);
  const right = normalizeForCompare(b);
  if (!left && !right) return 1;
  if (!left || !right) return 0;
  const grams = (value: string): Map<string, number> => {
    const map = new Map<string, number>();
    for (let index = 0; index < value.length - 1; index += 1) {
      const gram = value.slice(index, index + 2);
      map.set(gram, (map.get(gram) ?? 0) + 1);
    }
    return map;
  };
  const aGrams = grams(left);
  const bGrams = grams(right);
  let intersection = 0;
  let aTotal = 0;
  let bTotal = 0;
  for (const count of aGrams.values()) aTotal += count;
  for (const count of bGrams.values()) bTotal += count;
  for (const [gram, count] of aGrams) {
    intersection += Math.min(count, bGrams.get(gram) ?? 0);
  }
  return aTotal + bTotal === 0
    ? 1
    : (2 * intersection) / (aTotal + bTotal);
}

// ---- 结构检查 ----

function headingLevel(raw: string): number | undefined {
  const match = /^\s{0,3}(#{1,6})[ \t]/.exec(raw);
  return match ? match[1].length : undefined;
}

function countBlockquoteLines(raw: string): number {
  return raw.split("\n").filter((line) => /^\s*>/.test(line)).length;
}

/** 列表形状：每项的缩进深度、无序/有序标记、任务复选框状态。 */
function listShape(raw: string): string {
  return raw
    .split("\n")
    .flatMap((line) => {
      const match = /^(\s*)([-*+]|\d+[.)])\s+(?:\[([ xX])\]\s+)?/.exec(
        line,
      );
      if (!match) return [];
      const indent = match[1].replace(/\t/g, "  ").length;
      const marker = /\d/.test(match[2]) ? "o" : "b";
      const task = match[3]
        ? match[3].toLowerCase() === "x"
          ? "x"
          : "u"
        : "-";
      return [`${indent}${marker}${task}`];
    })
    .join("|");
}

/** 表格行拆成单元格；仅用于形状比较，不解析转义管道。 */
function tableCells(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

/** 表格形状：行数、列数、分隔行对齐方式（left/center/right/none）。 */
function tableShape(raw: string): string {
  const rows = raw
    .split("\n")
    .filter((line) => line.includes("|") && line.trim().length > 0)
    .map(tableCells);
  const separatorIndex = rows.findIndex((cells) =>
    cells.length > 0 &&
    cells.every((cell) => /^:?-{3,}:?$/.test(cell)),
  );
  const alignment =
    separatorIndex >= 0
      ? rows[separatorIndex]
          .map((cell) =>
            cell.startsWith(":") && cell.endsWith(":")
              ? "center"
              : cell.endsWith(":")
                ? "right"
                : cell.startsWith(":")
                  ? "left"
                  : "none",
          )
          .join(",")
      : "";
  return `${rows.length}x${rows[0]?.length ?? 0}:${alignment}`;
}

/** 比较源/候选的块内 Markdown 结构；只返回硬结构差异。 */
function compareBlockStructure(
  source: MarkdownBlock,
  candidate: MarkdownBlock,
): string[] {
  const issues: string[] = [];
  if (source.kind === "heading") {
    const sourceLevel = headingLevel(source.raw);
    const candidateLevel = headingLevel(candidate.raw);
    if (sourceLevel !== candidateLevel) {
      issues.push(
        `heading level ${sourceLevel ?? "?"} -> ${candidateLevel ?? "?"}`,
      );
    }
  } else if (source.kind === "list") {
    const sourceShape = listShape(source.raw);
    const candidateShape = listShape(candidate.raw);
    if (sourceShape !== candidateShape) {
      issues.push(`list shape ${sourceShape || "-"} -> ${candidateShape || "-"}`);
    }
  } else if (source.kind === "table") {
    const sourceShape = tableShape(source.raw);
    const candidateShape = tableShape(candidate.raw);
    if (sourceShape !== candidateShape) {
      issues.push(`table shape ${sourceShape} -> ${candidateShape}`);
    }
  } else if (source.kind === "blockquote") {
    const sourceLines = countBlockquoteLines(source.raw);
    const candidateLines = countBlockquoteLines(candidate.raw);
    if (sourceLines !== candidateLines) {
      issues.push(`blockquote lines ${sourceLines} -> ${candidateLines}`);
    }
  }
  return issues;
}

/** 比较 frontmatter（忽略末尾空白），缺失与多余都算差异。 */
function frontmatterMatches(
  source: MarkdownBlock | undefined,
  candidate: MarkdownBlock | undefined,
): boolean {
  const left = source?.raw.trimEnd() ?? "";
  const right = candidate?.raw.trimEnd() ?? "";
  return left === right;
}

// ---- 主评估 ----

/** 评估按扩展当前的可翻译块类型判断；脚注定义已纳入翻译范围。 */
function isEvaluatedAsTranslatable(kind: BlockKind): boolean {
  return TRANSLATABLE_KINDS.has(kind);
}

/**
 * 评估一份候选译文。
 *
 * @param input 源文、候选译文、可选参考译文/术语表。
 * @returns 逐块指标、硬问题与汇总指标。候选为空时仍会返回完整结构。
 */
export function evaluateCase(input: EvaluateCaseInput): CaseEvaluation {
  const md = createMarkdownRuntime();
  const source = parseMarkdownDocumentSafe(input.sourceText, md);
  const candidate = parseMarkdownDocumentSafe(input.candidateText, md);
  const reference = input.referenceText
    ? parseMarkdownDocumentSafe(input.referenceText, md)
    : undefined;
  const glossary = input.glossary ?? [];
  const issues: EvaluationIssue[] = [];
  const blockResults: BlockEvaluation[] = [];

  if (!frontmatterMatches(source.frontmatter, candidate.frontmatter)) {
    issues.push({
      code: "candidate.frontmatter",
      message: "Candidate frontmatter differs from the source.",
    });
  }
  if (
    reference &&
    !frontmatterMatches(source.frontmatter, reference.frontmatter)
  ) {
    issues.push({
      code: "reference.frontmatter",
      message: "Reference frontmatter differs from the source.",
    });
  }

  const sourceBlocks = source.blocks;
  const candidateBlocks = candidate.blocks;
  const referenceBlocks = reference?.blocks ?? [];
  if (candidateBlocks.length > sourceBlocks.length) {
    issues.push({
      code: "candidate.extra",
      message: `Candidate has ${candidateBlocks.length - sourceBlocks.length} extra block(s).`,
    });
  }
  if (candidateBlocks.length < sourceBlocks.length) {
    issues.push({
      code: "candidate.missing",
      message: `Candidate is missing ${sourceBlocks.length - candidateBlocks.length} block(s).`,
    });
  }
  if (reference && referenceBlocks.length !== sourceBlocks.length) {
    issues.push({
      code: "reference.structure",
      message: `Reference has ${referenceBlocks.length} blocks; source has ${sourceBlocks.length}.`,
    });
  }

  let protectedTokenTotal = 0;
  const protectedTokenMissing: string[] = [];
  let glossaryChecks = 0;
  let glossaryAdhered = 0;
  const glossaryMissing: string[] = [];
  let structureIssueCount = 0;
  const lengthRatios: number[] = [];
  const referenceSimilarities: number[] = [];

  sourceBlocks.forEach((sourceBlock, index) => {
    const candidateBlock = candidateBlocks[index];
    const referenceBlock = referenceBlocks[index];
    const protectedTokens = extractProtectedTokens(sourceBlock.raw);
    const candidateTokens = countProtectedTokens(
      candidateBlock ? extractProtectedTokens(candidateBlock.raw) : [],
    );
    const missingTokens: string[] = [];
    for (const [token, count] of countProtectedTokens(protectedTokens)) {
      const found = candidateTokens.get(token) ?? 0;
      if (found < count) {
        missingTokens.push(
          found > 0 ? `${token} (${found}/${count})` : token,
        );
      }
    }
    protectedTokenTotal += protectedTokens.length;
    protectedTokenMissing.push(
      ...missingTokens.map((token) => `block ${index + 1}: ${token}`),
    );

    const blockIssues: EvaluationIssue[] = [];
    if (!candidateBlock) {
      blockIssues.push({
        code: "candidate.missing",
        message: `Block ${index + 1} is missing.`,
        blockIndex: index,
      });
    } else if (candidateBlock.kind !== sourceBlock.kind) {
      blockIssues.push({
        code: "candidate.kindMismatch",
        message: `Block ${index + 1}: expected ${sourceBlock.kind}, got ${candidateBlock.kind}.`,
        blockIndex: index,
      });
    }
    if (missingTokens.length > 0) {
      blockIssues.push({
        code: "candidate.protectedTokenMissing",
        message: `Block ${index + 1} is missing protected token(s): ${missingTokens.join(", ")}.`,
        blockIndex: index,
      });
    }

    const translatable = isEvaluatedAsTranslatable(sourceBlock.kind);
    let empty = false;
    let untranslated = false;
    let copiedExactly = false;
    let candidateKind: BlockKind | undefined;
    let lengthRatio: number | undefined;
    let sourceWordRetention: number | undefined;
    let referenceSimilarity: number | undefined;
    const blockGlossaryMissing: string[] = [];
    const structureIssues: string[] = [];

    if (candidateBlock) {
      candidateKind = candidateBlock.kind;
      empty = normalizeBlockContent(candidateBlock.raw).length === 0;
      if (empty) {
        blockIssues.push({
          code: "candidate.empty",
          message: `Block ${index + 1} is empty.`,
          blockIndex: index,
        });
      }

      if (!translatable) {
        copiedExactly =
          normalizeBlockContent(sourceBlock.raw) ===
          normalizeBlockContent(candidateBlock.raw);
        if (!copiedExactly) {
          blockIssues.push({
            code: "candidate.copyMismatch",
            message: `Block ${index + 1} is non-translatable but was modified.`,
            blockIndex: index,
          });
        }
      } else if (sourceBlock.raw.trim()) {
        lengthRatio =
          candidateBlock.raw.length / Math.max(1, sourceBlock.raw.length);
        lengthRatios.push(lengthRatio);
        const translatableText = stripProtectedForGlossary(sourceBlock.raw);
        const hasTranslatableText = /[\p{L}]/u.test(translatableText);
        const sourceNorm = normalizeForCompare(sourceBlock.raw);
        const candidateNorm = normalizeForCompare(candidateBlock.raw);
        if (hasTranslatableText && sourceNorm === candidateNorm) {
          untranslated = true;
        } else if (hasTranslatableText) {
          const sentences = translatableText
            .split(/(?<=[.!?])\s+|\n+/)
            .map((sentence) => normalizeForCompare(sentence))
            .filter(
              (sentence) =>
                sentence.length >= 20 && /[a-z]/i.test(sentence),
            );
          untranslated = sentences.some((sentence) =>
            candidateNorm.includes(sentence),
          );
        }
        if (untranslated) {
          blockIssues.push({
            code: "candidate.untranslated",
            message: `Block ${index + 1} still contains source text.`,
            blockIndex: index,
          });
        }

        const sourceWords = latinWords(translatableText);
        const candidateWords = new Set(latinWords(candidateBlock.raw));
        const retainedWords = sourceWords.filter((word) =>
          candidateWords.has(word),
        );
        sourceWordRetention =
          sourceWords.length > 0
            ? retainedWords.length / sourceWords.length
            : undefined;
        // 只加前缀/标记、正文基本照抄时，逐句匹配可能被新增文字绕过；用词保留率兜底。
        // 同时要求常用功能词也大量保留，避免专有名词很多但确实翻译过的段落被误判。
        const commonWords = sourceWords.filter((word) =>
          COMMON_ENGLISH_WORDS.has(word),
        );
        const retainedCommon = commonWords.filter((word) =>
          candidateWords.has(word),
        ).length;
        const commonRetention =
          commonWords.length > 0 ? retainedCommon / commonWords.length : 0;
        if (
          !untranslated &&
          sourceWords.length >= 8 &&
          sourceWordRetention !== undefined &&
          sourceWordRetention >= 0.85 &&
          commonWords.length >= 3 &&
          commonRetention >= 0.8
        ) {
          untranslated = true;
          blockIssues.push({
            code: "candidate.sourceEcho",
            message: `Block ${index + 1} retains ${Math.round(sourceWordRetention * 100)}% of source words; it looks untranslated.`,
            blockIndex: index,
          });
        }

        structureIssues.push(
          ...compareBlockStructure(sourceBlock, candidateBlock),
        );
        structureIssueCount += structureIssues.length;
        for (const structureIssue of structureIssues) {
          blockIssues.push({
            code: "candidate.structure",
            message: `Block ${index + 1}: ${structureIssue}.`,
            blockIndex: index,
          });
        }

        const glossarySourceText = stripProtectedForGlossary(sourceBlock.raw);
        for (const entry of glossary) {
          if (!containsTerm(glossarySourceText, entry.source)) {
            continue;
          }
          glossaryChecks += 1;
          if (containsTerm(candidateBlock.raw, entry.target)) {
            glossaryAdhered += 1;
          } else {
            blockGlossaryMissing.push(entry.source);
            glossaryMissing.push(
              `block ${index + 1}: ${entry.source} -> ${entry.target}`,
            );
            blockIssues.push({
              code: "candidate.glossaryMissing",
              message: `Block ${index + 1} does not use glossary term "${entry.source}" -> "${entry.target}".`,
              blockIndex: index,
            });
          }
        }
      }
    }

    if (referenceBlock && translatable && candidateBlock) {
      referenceSimilarity = bigramDice(
        candidateBlock.raw,
        referenceBlock.raw,
      );
      referenceSimilarities.push(referenceSimilarity);
    }

    if (referenceBlock) {
      if (referenceBlock.kind !== sourceBlock.kind) {
        issues.push({
          code: "reference.kindMismatch",
          message: `Reference block ${index + 1}: expected ${sourceBlock.kind}, got ${referenceBlock.kind}.`,
          blockIndex: index,
        });
      } else if (
        !isEvaluatedAsTranslatable(sourceBlock.kind) &&
        normalizeBlockContent(referenceBlock.raw) !==
          normalizeBlockContent(sourceBlock.raw)
      ) {
        issues.push({
          code: "reference.copyMismatch",
          message: `Reference block ${index + 1} modifies a non-translatable block.`,
          blockIndex: index,
        });
      }
    }

    issues.push(...blockIssues);
    blockResults.push({
      index,
      kind: sourceBlock.kind,
      translatable,
      candidateFound: Boolean(candidateBlock),
      candidateKind,
      kindMatches: candidateBlock?.kind === sourceBlock.kind,
      empty,
      untranslated,
      copiedExactly,
      protectedTokens: { total: protectedTokens.length, missing: missingTokens },
      glossaryMissing: blockGlossaryMissing,
      structureIssues,
      ...(lengthRatio !== undefined ? { lengthRatio } : {}),
      ...(sourceWordRetention !== undefined ? { sourceWordRetention } : {}),
      ...(referenceSimilarity !== undefined ? { referenceSimilarity } : {}),
      issues: blockIssues.map((issue) => ({ ...issue })),
    });
  });

  const average = (values: number[]): number | undefined =>
    values.length > 0
      ? values.reduce((sum, value) => sum + value, 0) / values.length
      : undefined;

  return {
    id: input.id,
    tags: [...(input.tags ?? [])],
    sourceLanguage: input.sourceLanguage ?? "en",
    targetLanguage: input.targetLanguage ?? "zh-CN",
    sourceBlocks: sourceBlocks.length,
    candidateBlocks: candidateBlocks.length,
    referenceProvided: Boolean(reference),
    metrics: {
      sourceBlocks: sourceBlocks.length,
      candidateBlocks: candidateBlocks.length,
      ...(reference ? { referenceBlocks: referenceBlocks.length } : {}),
      missingBlocks: Math.max(0, sourceBlocks.length - candidateBlocks.length),
      extraBlocks: Math.max(0, candidateBlocks.length - sourceBlocks.length),
      kindMismatches: blockResults.filter(
        (result) => result.candidateFound && !result.kindMatches,
      ).length,
      untranslatedBlocks: blockResults.filter((result) => result.untranslated)
        .length,
      emptyBlocks: blockResults.filter((result) => result.empty).length,
      protectedTokenTotal,
      protectedTokenMissing,
      glossaryChecks,
      glossaryAdhered,
      glossaryMissing,
      structureIssueCount,
      frontmatter: {
        source: Boolean(source.frontmatter),
        candidate: Boolean(candidate.frontmatter),
        matches: frontmatterMatches(
          source.frontmatter,
          candidate.frontmatter,
        ),
      },
      ...(average(lengthRatios) !== undefined
        ? { averageLengthRatio: average(lengthRatios) }
        : {}),
      ...(average(referenceSimilarities) !== undefined
        ? { averageReferenceSimilarity: average(referenceSimilarities) }
        : {}),
      blockResults,
      issues,
      pass: issues.length === 0,
    },
  };
}

/** 聚合多个用例，供报告头部展示。 */
export function aggregateEvaluations(
  cases: readonly CaseEvaluation[],
): EvaluationAggregate {
  const sum = (selector: (metrics: EvaluationMetrics) => number): number =>
    cases.reduce((total, item) => total + selector(item.metrics), 0);
  const averages = (selector: (metrics: EvaluationMetrics) => number | undefined): number | undefined => {
    const values = cases
      .map((item) => selector(item.metrics))
      .filter((value): value is number => value !== undefined);
    return values.length > 0
      ? values.reduce((total, value) => total + value, 0) / values.length
      : undefined;
  };
  return {
    caseCount: cases.length,
    passedCases: cases.filter((item) => item.metrics.pass).length,
    failedCases: cases.filter((item) => !item.metrics.pass).length,
    sourceBlocks: sum((metrics) => metrics.sourceBlocks),
    candidateBlocks: sum((metrics) => metrics.candidateBlocks),
    missingBlocks: sum((metrics) => metrics.missingBlocks),
    extraBlocks: sum((metrics) => metrics.extraBlocks),
    kindMismatches: sum((metrics) => metrics.kindMismatches),
    untranslatedBlocks: sum((metrics) => metrics.untranslatedBlocks),
    emptyBlocks: sum((metrics) => metrics.emptyBlocks),
    protectedTokenTotal: sum((metrics) => metrics.protectedTokenTotal),
    protectedTokenMissing: sum(
      (metrics) => metrics.protectedTokenMissing.length,
    ),
    glossaryChecks: sum((metrics) => metrics.glossaryChecks),
    glossaryAdhered: sum((metrics) => metrics.glossaryAdhered),
    glossaryMissing: sum((metrics) => metrics.glossaryMissing.length),
    structureIssueCount: sum((metrics) => metrics.structureIssueCount),
    ...(averages((metrics) => metrics.averageLengthRatio) !== undefined
      ? {
          averageLengthRatio: averages(
            (metrics) => metrics.averageLengthRatio,
          ),
        }
      : {}),
    ...(averages((metrics) => metrics.averageReferenceSimilarity) !==
    undefined
      ? {
          averageReferenceSimilarity: averages(
            (metrics) => metrics.averageReferenceSimilarity,
          ),
        }
      : {}),
  };
}

/** parseMarkdownDocument 的失败兜底；评估输入通常合法，这里避免抛错中断整批。 */
function parseMarkdownDocumentSafe(
  text: string,
  md: ReturnType<typeof createMarkdownRuntime>,
) {
  return parseMarkdownDocument(normalizeNewlines(text ?? ""), md);
}
