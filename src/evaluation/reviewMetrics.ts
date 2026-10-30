/**
 * AI 批注质量评估指标（纯逻辑）。
 *
 * 职责：把 Provider 返回的审校批注归一化为统一的处理项模型，按人工标注的预期问题
 * 计算问题召回/误报，并检查处理项是否可独立执行、是否选择了合理的生效方式。
 *
 * 关键约定：
 * - 同时兼容当前 options 与旧 suggestion/suggestedAnswers 基线输出，旧字段映射为 advice/instruction；
 * - 问题匹配按 block id、side、type/severity 和关键词匹配，避免依赖模型措辞完全一致；
 * - 自动指标只判断结构与可执行性，语义质量仍需 human-review.md 人工评分；
 * - 独立执行检查是启发式，低分项必须人工复核，不能直接当作唯一的 pass/fail 依据。
 *
 * 外部依赖：translation 的批注类型；不依赖 vscode、不读写文件。
 */
import type {
  AnnotationSide,
  GlossaryEntry,
  ReviewAnnotationDraft,
  ReviewAnnotationType,
  ReviewSeverity,
} from "../translation/types";

export type ReviewOptionKind = "instruction" | "advice";
export type ReviewOptionMode = "once" | "persistent";

/** 归一化后的处理项；instruction 进入翻译上下文，advice 只给人看。 */
export interface NormalizedReviewOption {
  kind: ReviewOptionKind;
  text: string;
  mode?: ReviewOptionMode;
  /** 仅对 instruction 计算：脱离问题后是否仍能独立执行。 */
  standalone?: boolean;
}

/** 归一化后的审校批注。 */
export interface NormalizedReviewAnnotation {
  id: string;
  side: AnnotationSide;
  type: ReviewAnnotationType;
  severity: ReviewSeverity;
  message: string;
  question?: string;
  sourceExcerpt?: string;
  targetExcerpt?: string;
  options: NormalizedReviewOption[];
}

/** 单个用例中人工标注的预期问题。 */
export interface ExpectedReviewIssue {
  blockId: string;
  side: AnnotationSide;
  type: ReviewAnnotationType | "any";
  severity?: ReviewSeverity | "any";
  /** 批注正文、问题、摘录或处理项中至少命中一个关键词。 */
  match: string[];
  /** 对处理项的期望；省略时不检查处理项。 */
  option?: {
    kind: ReviewOptionKind;
    mode?: ReviewOptionMode | "any";
    /** 处理项文本中至少命中一个词；省略时不限制。 */
    mustInclude?: string[];
    /** 至少需要多少个满足条件的处理项，默认 1。 */
    minCount?: number;
  };
  /** 用于报告的人读说明。 */
  description?: string;
}

/** 单个预期问题与模型批注的匹配结果。 */
export interface ReviewIssueMatch {
  expected: ExpectedReviewIssue;
  matched?: NormalizedReviewAnnotation;
  /** 实际批注类型是否命中预期；预期 type 为 any 或未匹配时为 undefined。 */
  typeMatched?: boolean;
  /** 实际严重级别是否命中预期；未声明 severity 或未匹配时为 undefined。 */
  severityMatched?: boolean;
  /** 期望处理项是否满足；未声明 option 时为 undefined。 */
  optionMatched?: boolean;
  /** 选中的 instruction 是否都通过独立执行检查；无 instruction 时为 undefined。 */
  standalonePassed?: boolean;
  /** 实际 instruction 是否包含期望的生效方式；无 instruction 时为 undefined。 */
  modePassed?: boolean;
  optionText?: string;
}

/** 单个用例的评估结果。 */
export interface ReviewCaseEvaluation {
  id: string;
  tags: string[];
  cleanCase: boolean;
  cleanPassed: boolean;
  annotations: NormalizedReviewAnnotation[];
  matches: ReviewIssueMatch[];
  falsePositives: NormalizedReviewAnnotation[];
  truePositives: number;
  falseNegatives: number;
  falsePositiveCount: number;
  precision: number;
  recall: number;
  optionSpecifiedCount: number;
  optionPassedCount: number;
  optionCoverage: number;
  typeSpecifiedCount: number;
  typeMatchedCount: number;
  typeAccuracy: number;
  severitySpecifiedCount: number;
  severityMatchedCount: number;
  severityAccuracy: number;
  instructionCount: number;
  standaloneCount: number;
  standaloneRate: number;
  modeSpecifiedCount: number;
  modePassedCount: number;
  modeAccuracy: number;
  adviceSpecifiedCount: number;
  advicePassedCount: number;
  adviceFallbackRate: number;
  mixedOptionAnnotations: number;
  durationMs: number;
  error?: string;
}

/** 多个用例的聚合指标。 */
export interface ReviewEvaluationAggregate {
  caseCount: number;
  cleanCases: number;
  cleanFalsePositiveCases: number;
  cleanFalsePositiveAnnotations: number;
  expectedIssues: number;
  truePositives: number;
  falseNegatives: number;
  falsePositives: number;
  precision: number;
  recall: number;
  optionSpecifiedCount: number;
  optionPassedCount: number;
  optionCoverage: number;
  typeSpecifiedCount: number;
  typeMatchedCount: number;
  typeAccuracy: number;
  severitySpecifiedCount: number;
  severityMatchedCount: number;
  severityAccuracy: number;
  instructionCount: number;
  standaloneCount: number;
  standaloneRate: number;
  modeSpecifiedCount: number;
  modePassedCount: number;
  modeAccuracy: number;
  adviceSpecifiedCount: number;
  advicePassedCount: number;
  adviceFallbackRate: number;
  mixedOptionAnnotations: number;
  totalAnnotations: number;
  formatErrors: number;
  cleanCasePassRate: number;
  averageDurationMs: number;
}

/** 评估一个用例的输入。 */
export interface EvaluateReviewCaseInput {
  id: string;
  tags?: readonly string[];
  annotations: readonly ReviewAnnotationDraft[];
  expected: readonly ExpectedReviewIssue[];
  /** 每个块的可用于独立执行检查的锚点文本。 */
  blockTexts: Readonly<
    Record<string, { sourceText: string; targetText: string }>
  >;
  glossary?: readonly GlossaryEntry[];
  durationMs?: number;
  error?: string;
}

const BARE_REPLY =
  /^(?:yes|no|ok|okay|sure|correct|right|是(?:的)?|对(?:的)?|否|可以|好的?|行|不用|不需要)(?:[\s,，。.!！?？]|$)/i;
const DEICTIC =
  /(?:\b(?:the above|the issue|it|the first (?:one|option|answer)|the second (?:one|option|answer)|the third (?:one|option|answer)|option \d+|option (?:one|two|three))\b|(?:这个|它|上面|上述|该问题|此处|这里|前面提到|第一种|第二种|第三种|前者|后者))/i;
const QUOTE =
  /[`"'“”‘’「」『』]/;
const INSTRUCTION_VERB =
  /(?:\b(?:change|replace|remove|delete|add|insert|use|set|update|translate|keep|match|apply|restore|reword|rewrite|fix|correct|ensure|preserve|clarify)\b|将|把|改为|改成|替换|删除|删去|补上|补充|保留|统一|使用|译为|写成|添加|增加|移除|修正|调整|设置|确保|保持|重译|翻译|标注|注明|禁止|避免)/i;

function normalizeText(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const text = value.trim();
  return text || undefined;
}

/**
 * 判断一条 instruction 是否脱离问题仍可执行。
 *
 * 只做启发式：拒绝明显的是/否回答、依赖“上述/第一个/它”的指代，以及过短且没有
 * 具体锚点的文本。内容是否真的正确由人工评分补充。
 */
export function isStandaloneInstruction(
  text: string,
  anchors: readonly string[] = [],
): boolean {
  const value = text.trim();
  if (value.length < 6 || !INSTRUCTION_VERB.test(value)) {
    return false;
  }
  const hasAnchor =
    QUOTE.test(value) ||
    /\d{2,}/.test(value) ||
    anchors.some(
      (anchor) => anchor.trim().length >= 2 && value.includes(anchor.trim()),
    );
  if (BARE_REPLY.test(value) && !hasAnchor) {
    return false;
  }
  if (DEICTIC.test(value) && !hasAnchor) {
    return false;
  }
  return true;
}

function readRawOptions(draft: ReviewAnnotationDraft): NormalizedReviewOption[] {
  const raw: unknown = draft.options;
  if (!Array.isArray(raw)) {
    return [];
  }
  const options: NormalizedReviewOption[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const record = item as unknown as Record<string, unknown>;
    const kind =
      record.kind === "instruction" || record.kind === "advice"
        ? record.kind
        : undefined;
    const text = normalizeText(record.text);
    if (!kind || !text) {
      continue;
    }
    if (kind === "advice") {
      options.push({ kind, text });
      continue;
    }
    const mode =
      record.mode === "once" || record.mode === "persistent"
        ? record.mode
        : undefined;
    options.push({ kind, text, ...(mode ? { mode } : {}) });
  }
  return options;
}

function legacyOptions(
  draft: ReviewAnnotationDraft,
): NormalizedReviewOption[] {
  const legacy = draft as ReviewAnnotationDraft & {
    suggestion?: unknown;
    suggestedAnswers?: unknown;
  };
  const options: NormalizedReviewOption[] = [];
  const suggestion = normalizeText(legacy.suggestion);
  if (suggestion) {
    options.push({ kind: "advice", text: suggestion });
  }
  const answers = Array.isArray(legacy.suggestedAnswers)
    ? legacy.suggestedAnswers
    : [];
  for (const answer of answers) {
    const text = normalizeText(answer);
    if (text) {
      options.push({ kind: "instruction", text, mode: "once" });
    }
  }
  return options;
}

function dedupeOptions(
  options: readonly NormalizedReviewOption[],
): NormalizedReviewOption[] {
  const seen = new Set<string>();
  const result: NormalizedReviewOption[] = [];
  for (const option of options) {
    const key = `${option.kind}\u0000${option.text}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(option);
    if (result.length >= 3) {
      break;
    }
  }
  return result;
}

/** 把一条 Provider 批注归一化为统一模型；旧字段映射为 advice / 一次性 instruction。 */
export function normalizeReviewAnnotation(
  draft: ReviewAnnotationDraft,
  anchors: readonly string[] = [],
): NormalizedReviewAnnotation {
  const rawOptions = dedupeOptions(readRawOptions(draft));
  const options = rawOptions.length > 0 ? rawOptions : dedupeOptions(legacyOptions(draft));
  return {
    id: draft.id,
    side: draft.side,
    type: draft.type,
    severity: draft.severity,
    message: draft.message,
    ...(draft.question ? { question: draft.question } : {}),
    ...(draft.sourceExcerpt ? { sourceExcerpt: draft.sourceExcerpt } : {}),
    ...(draft.targetExcerpt ? { targetExcerpt: draft.targetExcerpt } : {}),
    options: options.map((option) =>
      option.kind === "instruction"
        ? {
            ...option,
            standalone: isStandaloneInstruction(option.text, anchors),
          }
        : option,
    ),
  };
}

/** 把一批 Provider 批注归一化；锚点包含块原文、译文和术语表。 */
export function normalizeReviewAnnotations(
  drafts: readonly ReviewAnnotationDraft[],
  blockTexts: EvaluateReviewCaseInput["blockTexts"],
  glossary: readonly GlossaryEntry[] = [],
): NormalizedReviewAnnotation[] {
  const glossaryAnchors = glossary.flatMap((entry) => [
    entry.source,
    entry.target,
  ]);
  return drafts.map((draft) => {
    const block = blockTexts[draft.id];
    const anchors = [
      ...(block ? [block.sourceText, block.targetText] : []),
      ...glossaryAnchors,
    ];
    return normalizeReviewAnnotation(draft, anchors);
  });
}

function combinedText(annotation: NormalizedReviewAnnotation): string {
  return [
    annotation.message,
    annotation.question ?? "",
    annotation.sourceExcerpt ?? "",
    annotation.targetExcerpt ?? "",
    ...annotation.options.map((option) => option.text),
  ].join("\n");
}

function countMatches(
  terms: readonly string[],
  haystack: string,
): number {
  const text = haystack.toLowerCase();
  let count = 0;
  for (const term of terms) {
    const needle = term.trim().toLowerCase();
    if (needle && text.includes(needle)) {
      count += 1;
    }
  }
  return count;
}

function optionMatches(
  option: NormalizedReviewOption,
  spec: NonNullable<ExpectedReviewIssue["option"]>,
): boolean {
  if (option.kind !== spec.kind) {
    return false;
  }
  // mode 是独立维度：用户可在采纳时切换，不应让整个处理项算作未覆盖。
  if (spec.mustInclude?.length) {
    return countMatches(spec.mustInclude, option.text) > 0;
  }
  return true;
}

function ratio(numerator: number, denominator: number): number {
  return denominator > 0 ? numerator / denominator : 1;
}

/** 评估一个用例的批注质量。 */
export function evaluateReviewCase(
  input: EvaluateReviewCaseInput,
): ReviewCaseEvaluation {
  const annotations = normalizeReviewAnnotations(
    input.annotations,
    input.blockTexts,
    input.glossary,
  );
  const used = new Set<number>();
  const matches: ReviewIssueMatch[] = [];

  for (const expected of input.expected) {
    let best:
      | { index: number; annotation: NormalizedReviewAnnotation; score: number }
      | undefined;
    for (const [index, annotation] of annotations.entries()) {
      if (used.has(index) || annotation.id !== expected.blockId) {
        continue;
      }
      if (annotation.side !== expected.side) {
        continue;
      }
      const score = countMatches(expected.match, combinedText(annotation));
      if (score === 0) {
        continue;
      }
      if (!best || score > best.score) {
        best = { index, annotation, score };
      }
    }

    if (!best) {
      matches.push({ expected });
      continue;
    }
    used.add(best.index);
    const typeMatched =
      expected.type === "any"
        ? undefined
        : best.annotation.type === expected.type;
    const severityMatched =
      expected.severity === undefined || expected.severity === "any"
        ? undefined
        : best.annotation.severity === expected.severity;
    const option = expected.option;
    if (!option) {
      matches.push({
        expected,
        matched: best.annotation,
        ...(typeMatched !== undefined ? { typeMatched } : {}),
        ...(severityMatched !== undefined ? { severityMatched } : {}),
      });
      continue;
    }
    const minCount = Math.max(1, option.minCount ?? 1);
    const optionCandidates = best.annotation.options.filter((item) =>
      optionMatches(item, option),
    );
    const candidates = optionCandidates
      .filter(
        (item) => item.kind !== "instruction" || item.standalone === true,
      )
      .slice(0, minCount);
    const optionMatched = candidates.length >= minCount;
    const standalonePassed =
      option.kind === "instruction" && optionCandidates.length >= minCount
        ? optionCandidates
            .slice(0, minCount)
            .every((item) => item.standalone === true)
        : undefined;
    const hasInstruction = best.annotation.options.some(
      (item) => item.kind === "instruction",
    );
    const modePassed =
      option.kind === "instruction" &&
      option.mode !== undefined &&
      option.mode !== "any" &&
      hasInstruction
        ? best.annotation.options.some(
            (item) => item.kind === "instruction" && item.mode === option.mode,
          )
        : undefined;
    matches.push({
      expected,
      matched: best.annotation,
      ...(typeMatched !== undefined ? { typeMatched } : {}),
      ...(severityMatched !== undefined ? { severityMatched } : {}),
      optionMatched,
      ...(standalonePassed !== undefined ? { standalonePassed } : {}),
      ...(modePassed !== undefined ? { modePassed } : {}),
      ...(candidates[0] ? { optionText: candidates[0].text } : {}),
    });
  }

  const falsePositives = annotations.filter((_, index) => !used.has(index));
  const matched = matches.filter((item) => item.matched);
  const truePositives = matched.length;
  const falseNegatives = matches.length - truePositives;
  const optionSpecifiedCount = matches.filter((item) => item.expected.option)
    .length;
  const optionPassedCount = matches.filter(
    (item) => item.expected.option && item.optionMatched,
  ).length;
  const typeSpecifiedCount = matched.filter(
    (item) => item.expected.type !== "any",
  ).length;
  const typeMatchedCount = matched.filter(
    (item) => item.typeMatched === true,
  ).length;
  const severitySpecifiedCount = matched.filter(
    (item) =>
      item.expected.severity !== undefined &&
      item.expected.severity !== "any",
  ).length;
  const severityMatchedCount = matched.filter(
    (item) => item.severityMatched === true,
  ).length;
  const modeSpecifiedCount = matched.filter(
    (item) =>
      item.expected.option?.kind === "instruction" &&
      item.expected.option.mode !== undefined &&
      item.expected.option.mode !== "any" &&
      (item.matched?.options.some((option) => option.kind === "instruction") ??
        false),
  ).length;
  const modePassedCount = matched.filter(
    (item) => item.modePassed === true,
  ).length;
  const adviceSpecifiedCount = matched.filter(
    (item) => item.expected.option?.kind === "advice",
  ).length;
  const advicePassedCount = matched.filter(
    (item) =>
      item.expected.option?.kind === "advice" && item.optionMatched === true,
  ).length;
  const instructionOptions = annotations.flatMap((annotation) =>
    annotation.options.filter((option) => option.kind === "instruction"),
  );
  const standaloneCount = instructionOptions.filter(
    (option) => option.standalone === true,
  ).length;

  return {
    id: input.id,
    tags: [...(input.tags ?? [])],
    cleanCase: input.expected.length === 0,
    cleanPassed:
      input.expected.length === 0 &&
      annotations.length === 0 &&
      !input.error,
    annotations,
    matches,
    falsePositives,
    truePositives,
    falseNegatives,
    falsePositiveCount: falsePositives.length,
    precision: ratio(truePositives, truePositives + falsePositives.length),
    recall: ratio(truePositives, input.expected.length),
    optionSpecifiedCount,
    optionPassedCount,
    optionCoverage: ratio(optionPassedCount, optionSpecifiedCount),
    typeSpecifiedCount,
    typeMatchedCount,
    typeAccuracy: ratio(typeMatchedCount, typeSpecifiedCount),
    severitySpecifiedCount,
    severityMatchedCount,
    severityAccuracy: ratio(severityMatchedCount, severitySpecifiedCount),
    instructionCount: instructionOptions.length,
    standaloneCount,
    standaloneRate: ratio(standaloneCount, instructionOptions.length),
    modeSpecifiedCount,
    modePassedCount,
    modeAccuracy: ratio(modePassedCount, modeSpecifiedCount),
    adviceSpecifiedCount,
    advicePassedCount,
    adviceFallbackRate: ratio(advicePassedCount, adviceSpecifiedCount),
    mixedOptionAnnotations: annotations.filter((annotation) => {
      const kinds = new Set(annotation.options.map((option) => option.kind));
      return kinds.size > 1;
    }).length,
    durationMs: input.durationMs ?? 0,
    ...(input.error ? { error: input.error } : {}),
  };
}

/** 聚合多个用例。 */
export function aggregateReviewEvaluations(
  cases: readonly ReviewCaseEvaluation[],
): ReviewEvaluationAggregate {
  const sum = (select: (item: ReviewCaseEvaluation) => number) =>
    cases.reduce((total, item) => total + select(item), 0);
  const cleanCases = cases.filter((item) => item.cleanCase);
  const cleanFalsePositiveCases = cleanCases.filter(
    (item) => item.falsePositiveCount > 0 || item.error,
  ).length;
  const expectedIssues = sum((item) => item.matches.length);
  const truePositives = sum((item) => item.truePositives);
  const falseNegatives = sum((item) => item.falseNegatives);
  const falsePositives = sum((item) => item.falsePositiveCount);
  const optionSpecifiedCount = sum((item) => item.optionSpecifiedCount);
  const optionPassedCount = sum((item) => item.optionPassedCount);
  const typeSpecifiedCount = sum((item) => item.typeSpecifiedCount);
  const typeMatchedCount = sum((item) => item.typeMatchedCount);
  const severitySpecifiedCount = sum((item) => item.severitySpecifiedCount);
  const severityMatchedCount = sum((item) => item.severityMatchedCount);
  const instructionCount = sum((item) => item.instructionCount);
  const standaloneCount = sum((item) => item.standaloneCount);
  const modeSpecifiedCount = sum((item) => item.modeSpecifiedCount);
  const modePassedCount = sum((item) => item.modePassedCount);
  const adviceSpecifiedCount = sum((item) => item.adviceSpecifiedCount);
  const advicePassedCount = sum((item) => item.advicePassedCount);

  return {
    caseCount: cases.length,
    cleanCases: cleanCases.length,
    cleanFalsePositiveCases,
    cleanFalsePositiveAnnotations: cleanCases.reduce(
      (total, item) => total + item.falsePositiveCount,
      0,
    ),
    expectedIssues,
    truePositives,
    falseNegatives,
    falsePositives,
    precision: ratio(truePositives, truePositives + falsePositives),
    recall: ratio(truePositives, expectedIssues),
    optionSpecifiedCount,
    optionPassedCount,
    optionCoverage: ratio(optionPassedCount, optionSpecifiedCount),
    typeSpecifiedCount,
    typeMatchedCount,
    typeAccuracy: ratio(typeMatchedCount, typeSpecifiedCount),
    severitySpecifiedCount,
    severityMatchedCount,
    severityAccuracy: ratio(severityMatchedCount, severitySpecifiedCount),
    instructionCount,
    standaloneCount,
    standaloneRate: ratio(standaloneCount, instructionCount),
    modeSpecifiedCount,
    modePassedCount,
    modeAccuracy: ratio(modePassedCount, modeSpecifiedCount),
    adviceSpecifiedCount,
    advicePassedCount,
    adviceFallbackRate: ratio(advicePassedCount, adviceSpecifiedCount),
    mixedOptionAnnotations: sum((item) => item.mixedOptionAnnotations),
    totalAnnotations: sum((item) => item.annotations.length),
    formatErrors: cases.filter((item) => item.error).length,
    cleanCasePassRate: ratio(
      cleanCases.length - cleanFalsePositiveCases,
      cleanCases.length,
    ),
    averageDurationMs:
      cases.length > 0
        ? sum((item) => item.durationMs) / cases.length
        : 0,
  };
}
