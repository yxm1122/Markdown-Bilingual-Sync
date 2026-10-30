/**
 * AI 批注质量评估报告（纯逻辑）。
 *
 * 输出 report.json / report.md / human-review.md；自动指标用于发现结构性问题，
 * 语义准确性、候选回答是否真的有用仍由人工评分表判断。
 *
 * 外部依赖：reviewMetrics 的类型与聚合；不读写文件、不依赖 vscode。
 */
import {
  aggregateReviewEvaluations,
  type NormalizedReviewAnnotation,
  type ReviewCaseEvaluation,
  type ReviewEvaluationAggregate,
} from "./reviewMetrics";

/** 单个用例的报告数据。 */
export interface ReviewCaseReport extends ReviewCaseEvaluation {
  sourcePath?: string;
  targetPath?: string;
}

/** 一次批注评测的完整报告。 */
export interface ReviewReport {
  generatedAt: string;
  provider: string;
  model?: string;
  label: string;
  sourceLanguage: string;
  targetLanguage: string;
  outputLanguage: string;
  promptChars: number;
  promptLines: number;
  systemPrompt: string;
  cases: ReviewCaseReport[];
  aggregate: ReviewEvaluationAggregate;
  notes: string[];
}

/** 构造报告并聚合用例。 */
export function createReviewReport(input: {
  provider: string;
  model?: string;
  label: string;
  sourceLanguage: string;
  targetLanguage: string;
  outputLanguage: string;
  systemPrompt: string;
  cases: readonly ReviewCaseReport[];
  notes?: readonly string[];
}): ReviewReport {
  return {
    generatedAt: new Date().toISOString(),
    provider: input.provider,
    ...(input.model ? { model: input.model } : {}),
    label: input.label,
    sourceLanguage: input.sourceLanguage,
    targetLanguage: input.targetLanguage,
    outputLanguage: input.outputLanguage,
    promptChars: input.systemPrompt.length,
    promptLines: input.systemPrompt.split("\n").length,
    systemPrompt: input.systemPrompt,
    cases: [...input.cases],
    aggregate: aggregateReviewEvaluations(input.cases),
    notes: [...(input.notes ?? [])],
  };
}

export function formatReviewJson(report: ReviewReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

function cell(value: unknown): string {
  return String(value ?? "")
    .replace(/\|/g, "\\|")
    .replace(/\r?\n/g, " ");
}

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function number(value: number): string {
  return Number.isFinite(value) ? value.toFixed(2) : "-";
}

function signed(value: number): string {
  return value > 0 ? `+${value}` : String(value);
}

function caseStatus(item: ReviewCaseReport): string {
  if (item.error) return "ERROR";
  if (item.cleanCase) return item.cleanPassed ? "CLEAN" : "REVIEW";
  if (
    item.falseNegatives > 0 ||
    item.falsePositiveCount > 0 ||
    (item.optionSpecifiedCount > 0 &&
      item.optionPassedCount < item.optionSpecifiedCount)
  ) {
    return "REVIEW";
  }
  return "OK";
}

function formatAnnotation(
  annotation: NormalizedReviewAnnotation,
): string {
  const lines = [
    `- **${annotation.id} / ${annotation.side} / ${annotation.type} / ${annotation.severity}**: ${cell(annotation.message)}`,
  ];
  if (annotation.question) {
    lines.push(`  - Question: ${cell(annotation.question)}`);
  }
  if (annotation.sourceExcerpt) {
    lines.push(`  - Source excerpt: \`${cell(annotation.sourceExcerpt)}\``);
  }
  if (annotation.targetExcerpt) {
    lines.push(`  - Target excerpt: \`${cell(annotation.targetExcerpt)}\``);
  }
  if (annotation.options.length === 0) {
    lines.push("  - Options: none");
  } else {
    for (const option of annotation.options) {
      const mode = option.mode ? ` / ${option.mode}` : "";
      const standalone =
        option.kind === "instruction"
          ? ` / standalone=${option.standalone ? "yes" : "no"}`
          : "";
      lines.push(
        `  - Option: \`${option.kind}${mode}${standalone}\` ${cell(option.text)}`,
      );
    }
  }
  return lines.join("\n");
}

function formatMatch(item: ReviewCaseReport["matches"][number]): string {
  const label = item.expected.description ?? item.expected.blockId;
  if (!item.matched) {
    return `- **MISS** ${cell(label)} (${item.expected.side}/${item.expected.type})`;
  }
  const taxonomy = `${item.typeMatched === false ? "; type mismatch" : ""}${
    item.severityMatched === false ? "; severity mismatch" : ""
  }`;
  const option =
    item.expected.option === undefined
      ? ""
      : `; option ${item.optionMatched ? "PASS" : "FAIL"}${
          item.standalonePassed === undefined
            ? ""
            : `; standalone=${item.standalonePassed ? "yes" : "no"}`
        }${
          item.modePassed === undefined
            ? ""
            : `; mode=${item.modePassed ? "yes" : "no"}`
        }`;
  return `- **HIT** ${cell(label)} -> ${item.matched.id}${taxonomy}${option}`;
}

/** Markdown 报告：自动指标 + 逐用例原始批注，便于人工对照。 */
export function formatReviewMarkdown(report: ReviewReport): string {
  const aggregate = report.aggregate;
  const lines: string[] = [
    "# AI annotation quality evaluation",
    "",
    `- Generated: ${report.generatedAt}`,
    `- Label: ${report.label}`,
    `- Provider: \`${report.provider}\`${report.model ? ` / \`${report.model}\`` : ""}`,
    `- Language pair: \`${report.sourceLanguage}\` -> \`${report.targetLanguage}\``,
    `- Output language: \`${report.outputLanguage}\``,
    `- Cases: ${aggregate.caseCount} (${aggregate.cleanCases} clean)`,
    `- Prompt: ${report.promptChars} chars / ${report.promptLines} lines`,
    "",
    "## Summary",
    "",
    "| Metric | Value |",
    "| --- | --- |",
    `| Expected issues | ${aggregate.expectedIssues} |`,
    `| True positives / false negatives / false positives | ${aggregate.truePositives} / ${aggregate.falseNegatives} / ${aggregate.falsePositives} |`,
    `| Precision / recall | ${percent(aggregate.precision)} / ${percent(aggregate.recall)} |`,
    `| Clean case pass rate | ${percent(aggregate.cleanCasePassRate)} (${aggregate.cleanFalsePositiveCases} failed) |`,
    `| Clean false positive annotations | ${aggregate.cleanFalsePositiveAnnotations} |`,
    `| Option coverage | ${percent(aggregate.optionCoverage)} (${aggregate.optionPassedCount}/${aggregate.optionSpecifiedCount}) |`,
    `| Type accuracy | ${percent(aggregate.typeAccuracy)} (${aggregate.typeMatchedCount}/${aggregate.typeSpecifiedCount}) |`,
    `| Severity accuracy | ${percent(aggregate.severityAccuracy)} (${aggregate.severityMatchedCount}/${aggregate.severitySpecifiedCount}) |`,
    `| Standalone instruction rate | ${percent(aggregate.standaloneRate)} (${aggregate.standaloneCount}/${aggregate.instructionCount}) |`,
    `| Mode accuracy | ${percent(aggregate.modeAccuracy)} (${aggregate.modePassedCount}/${aggregate.modeSpecifiedCount}) |`,
    `| Advice fallback | ${percent(aggregate.adviceFallbackRate)} (${aggregate.advicePassedCount}/${aggregate.adviceSpecifiedCount}) |`,
    `| Mixed option annotations | ${aggregate.mixedOptionAnnotations} |`,
    `| Total annotations | ${aggregate.totalAnnotations} |`,
    `| Avg message chars / max | ${number(aggregate.averageMessageChars)} / ${aggregate.maxMessageChars} |`,
    `| Avg annotation chars | ${number(aggregate.averageAnnotationChars)} |`,
    `| Multi-instruction annotations | ${aggregate.multiInstructionAnnotations} |`,
    `| Advice-only annotations | ${aggregate.adviceOnlyAnnotations} |`,
    `| Procedural instructions | ${aggregate.proceduralInstructions} |`,
    `| Unsupported punctuation claims | ${aggregate.unsupportedPunctuationClaims} |`,
    `| Duplicate-field annotations | ${aggregate.duplicateFieldAnnotations} |`,
    `| Format errors | ${aggregate.formatErrors} |`,
    `| Average latency | ${number(aggregate.averageDurationMs)} ms |`,
    "",
  ];

  if (report.notes.length > 0) {
    lines.push("## Notes", "");
    for (const note of report.notes) {
      lines.push(`- ${note}`);
    }
    lines.push("");
  }

  lines.push("## Cases", "");

  for (const item of report.cases) {
    lines.push(
      `### ${item.id} — ${caseStatus(item)}`,
      "",
      `- Tags: ${item.tags.length ? item.tags.join(", ") : "-"}`,
      `- Expected: ${item.matches.length}; TP ${item.truePositives}; FN ${item.falseNegatives}; FP ${item.falsePositiveCount}`,
      `- Options: ${item.optionPassedCount}/${item.optionSpecifiedCount}; standalone ${item.standaloneCount}/${item.instructionCount}; mode ${item.modePassedCount}/${item.modeSpecifiedCount}`,
      `- Duration: ${item.durationMs} ms`,
    );
    if (item.sourcePath) {
      lines.push(`- Source: \`${item.sourcePath}\``);
    }
    if (item.targetPath) {
      lines.push(`- Target: \`${item.targetPath}\``);
    }
    if (item.error) {
      lines.push(`- Error: ${cell(item.error)}`);
    }
    lines.push("", "Expected checks:", "");
    if (item.matches.length === 0) {
      lines.push("- No issues expected (clean case).");
    } else {
      for (const match of item.matches) {
        lines.push(formatMatch(match));
      }
    }
    lines.push("", "Actual annotations:", "");
    if (item.annotations.length === 0) {
      lines.push("- None.");
    } else {
      for (const annotation of item.annotations) {
        lines.push(formatAnnotation(annotation));
      }
    }
    lines.push("");
  }

  lines.push(
    "## Interpretation",
    "",
    "- **Precision/recall** only count keyword-matched expected issues; unmatched valid observations still need human review.",
    "- **Standalone** is a heuristic for instructions that do not depend on the question; it is not a semantic correctness check.",
    "- **Mode accuracy** checks whether instructions that need to persist across future translations use `persistent`; use human review for judgment calls.",
    "- **Clean false positives** are the primary guard against making the reviewer noisier.",
    "",
  );
  return lines.join("\n");
}

/** 单独的人工评分表；不改自动结果。 */
export function formatReviewHumanReview(report: ReviewReport): string {
  const lines = [
    "# AI annotation human review",
    "",
    "Score each case from 0 (bad) to 2 (good). Automatic checks are only a guide.",
    "",
    "- Issue accuracy: Did the reviewer find the real issue and avoid false alarms?",
    "- Option usefulness: Could the instruction/advice be adopted directly, and is the mode sensible?",
    "- Standalone: Does the instruction still make sense without the question?",
    "",
    "| Case | Issue accuracy (0-2) | Option usefulness (0-2) | Standalone (0-2) | Notes |",
    "| --- | --- | --- | --- | --- |",
  ];
  for (const item of report.cases) {
    lines.push(`| ${cell(item.id)} |  |  |  |  |`);
  }
  lines.push("");
  return lines.join("\n");
}

function metricDelta(
  baseline: number,
  current: number,
  asPercent = false,
): string {
  const delta = current - baseline;
  return asPercent
    ? `${delta > 0 ? "+" : ""}${(delta * 100).toFixed(1)} pp`
    : signed(Number(delta.toFixed(2)));
}

/** 对比两次运行；用于确认提示词改动没有用噪声换召回。 */
export function formatReviewComparison(
  current: ReviewReport,
  baseline: ReviewReport,
): string {
  const a = baseline.aggregate;
  const b = current.aggregate;
  const optionalNumber = (value: number | undefined, digits = 1): string =>
    value === undefined ? "-" : value.toFixed(digits);
  const optionalDelta = (
    before: number | undefined,
    after: number | undefined,
    digits = 1,
  ): string =>
    before === undefined || after === undefined
      ? "-"
      : signed(Number((after - before).toFixed(digits)));
  const optionalCount = (value: number | undefined): string =>
    value === undefined ? "-" : String(value);
  const rows: string[][] = [
    ["Precision", percent(a.precision), percent(b.precision), metricDelta(a.precision, b.precision, true)],
    ["Recall", percent(a.recall), percent(b.recall), metricDelta(a.recall, b.recall, true)],
    ["Clean false positive cases", String(a.cleanFalsePositiveCases), String(b.cleanFalsePositiveCases), signed(b.cleanFalsePositiveCases - a.cleanFalsePositiveCases)],
    ["Clean false positive annotations", String(a.cleanFalsePositiveAnnotations), String(b.cleanFalsePositiveAnnotations), signed(b.cleanFalsePositiveAnnotations - a.cleanFalsePositiveAnnotations)],
    ["Option coverage", percent(a.optionCoverage), percent(b.optionCoverage), metricDelta(a.optionCoverage, b.optionCoverage, true)],
    ["Type accuracy", percent(a.typeAccuracy), percent(b.typeAccuracy), metricDelta(a.typeAccuracy, b.typeAccuracy, true)],
    ["Severity accuracy", percent(a.severityAccuracy), percent(b.severityAccuracy), metricDelta(a.severityAccuracy, b.severityAccuracy, true)],
    ["Standalone rate", percent(a.standaloneRate), percent(b.standaloneRate), metricDelta(a.standaloneRate, b.standaloneRate, true)],
    ["Mode accuracy", percent(a.modeAccuracy), percent(b.modeAccuracy), metricDelta(a.modeAccuracy, b.modeAccuracy, true)],
    ["Advice fallback", percent(a.adviceFallbackRate), percent(b.adviceFallbackRate), metricDelta(a.adviceFallbackRate, b.adviceFallbackRate, true)],
    ["Mixed option annotations", String(a.mixedOptionAnnotations), String(b.mixedOptionAnnotations), signed(b.mixedOptionAnnotations - a.mixedOptionAnnotations)],
    ["Avg message chars", optionalNumber(a.averageMessageChars), optionalNumber(b.averageMessageChars), optionalDelta(a.averageMessageChars, b.averageMessageChars)],
    ["Avg annotation chars", optionalNumber(a.averageAnnotationChars), optionalNumber(b.averageAnnotationChars), optionalDelta(a.averageAnnotationChars, b.averageAnnotationChars)],
    ["Multi-instruction annotations", optionalCount(a.multiInstructionAnnotations), optionalCount(b.multiInstructionAnnotations), optionalDelta(a.multiInstructionAnnotations, b.multiInstructionAnnotations, 0)],
    ["Advice-only annotations", optionalCount(a.adviceOnlyAnnotations), optionalCount(b.adviceOnlyAnnotations), optionalDelta(a.adviceOnlyAnnotations, b.adviceOnlyAnnotations, 0)],
    ["Procedural instructions", optionalCount(a.proceduralInstructions), optionalCount(b.proceduralInstructions), optionalDelta(a.proceduralInstructions, b.proceduralInstructions, 0)],
    ["Unsupported punctuation claims", optionalCount(a.unsupportedPunctuationClaims), optionalCount(b.unsupportedPunctuationClaims), optionalDelta(a.unsupportedPunctuationClaims, b.unsupportedPunctuationClaims, 0)],
    ["Duplicate-field annotations", optionalCount(a.duplicateFieldAnnotations), optionalCount(b.duplicateFieldAnnotations), optionalDelta(a.duplicateFieldAnnotations, b.duplicateFieldAnnotations, 0)],
    ["Format errors", String(a.formatErrors), String(b.formatErrors), signed(b.formatErrors - a.formatErrors)],
    ["Prompt chars", String(baseline.promptChars), String(current.promptChars), signed(current.promptChars - baseline.promptChars)],
  ];
  const lines = [
    "# Prompt comparison",
    "",
    `- Baseline: \`${baseline.label}\` (${baseline.generatedAt})`,
    `- Current: \`${current.label}\` (${current.generatedAt})`,
    "",
    "| Metric | Baseline | Current | Delta |",
    "| --- | --- | --- | --- |",
    ...rows.map((row) => `| ${row.map(cell).join(" | ")} |`),
    "",
    "## Cases",
    "",
    "| Case | Baseline TP/FN/FP | Current TP/FN/FP | Baseline options | Current options |",
    "| --- | --- | --- | --- | --- |",
  ];
  const baselineById = new Map(baseline.cases.map((item) => [item.id, item]));
  for (const item of current.cases) {
    const previous = baselineById.get(item.id);
    lines.push(
      `| ${cell(item.id)} | ${
        previous
          ? `${previous.truePositives}/${previous.falseNegatives}/${previous.falsePositiveCount}`
          : "-"
      } | ${item.truePositives}/${item.falseNegatives}/${item.falsePositiveCount} | ${
        previous
          ? `${previous.optionPassedCount}/${previous.optionSpecifiedCount}`
          : "-"
      } | ${item.optionPassedCount}/${item.optionSpecifiedCount} |`,
    );
  }
  lines.push("");
  return lines.join("\n");
}
