/**
 * 翻译质量评估报告格式化（纯逻辑）。
 *
 * 职责：把 metrics.ts 的逐用例结果聚合为 JSON / Markdown 报告，并生成人工评分表。
 * 报告面向开发者，默认英文；不读取文件、不依赖 vscode。
 *
 * 关键约定：
 * - 自动指标只能发现问题，不能替代人工判断；参考相似度是辅助信号；
 * - Markdown 表格中的动态文本必须转义 `|` 和换行，避免破坏表格；
 * - 通过/失败只由硬问题决定，长度比例与参考相似度不参与 pass/fail。
 */
import {
  aggregateEvaluations,
  type CaseEvaluation,
  type EvaluationAggregate,
  type EvaluationIssue,
} from "./metrics";

/** 单个用例的运行时信息（耗时、候选/参考路径）。 */
export interface EvaluationCaseReport extends CaseEvaluation {
  durationMs: number;
  candidatePath?: string;
  referencePath?: string;
  error?: string;
}

/** 一次完整评估的报告数据。 */
export interface EvaluationReport {
  generatedAt: string;
  provider: string;
  model?: string;
  sourceLanguage: string;
  targetLanguage: string;
  cases: EvaluationCaseReport[];
  aggregate: EvaluationAggregate;
  notes: string[];
}

/** 构造报告并聚合用例。 */
export function createEvaluationReport(input: {
  provider: string;
  model?: string;
  sourceLanguage: string;
  targetLanguage: string;
  cases: readonly EvaluationCaseReport[];
  notes?: readonly string[];
}): EvaluationReport {
  return {
    generatedAt: new Date().toISOString(),
    provider: input.provider,
    ...(input.model ? { model: input.model } : {}),
    sourceLanguage: input.sourceLanguage,
    targetLanguage: input.targetLanguage,
    cases: [...input.cases],
    aggregate: aggregateEvaluations(input.cases),
    notes: [...(input.notes ?? [])],
  };
}

/** 序列化为带缩进的 JSON，便于机器比较和归档。 */
export function formatEvaluationJson(report: EvaluationReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

/** Markdown 表格单元转义。 */
function cell(value: unknown): string {
  return String(value ?? "")
    .replace(/\|/g, "\\|")
    .replace(/\r?\n/g, " ");
}

/** 保留两位小数的可读数字。 */
function number(value: number | undefined, digits = 2): string {
  return value === undefined || !Number.isFinite(value)
    ? "-"
    : value.toFixed(digits);
}

/** 状态文案；仅用于报告，不是 UI 状态。 */
function blockStatus(block: EvaluationCaseReport["metrics"]["blockResults"][number]): string {
  if (!block.candidateFound) return "missing";
  if (block.empty) return "empty";
  if (!block.kindMatches) return "kind mismatch";
  if (block.untranslated) return "untranslated";
  if (!block.translatable) return block.copiedExactly ? "copied" : "copy modified";
  if (block.issues.length > 0) return "issues";
  return "ok";
}

/** 按问题代码列出硬问题。 */
function formatIssues(issues: readonly EvaluationIssue[]): string {
  if (issues.length === 0) return "- None";
  return issues
    .map((issue) => `- [\`${issue.code}\`] ${issue.message}`)
    .join("\n");
}

/** 用例的 Markdown 小节。 */
function formatCase(item: EvaluationCaseReport): string {
  const metrics = item.metrics;
  const status = metrics.pass ? "PASS" : "FAIL";
  const lines: string[] = [
    `### ${item.id} — ${status}`,
    "",
    `- Tags: ${item.tags.length > 0 ? item.tags.join(", ") : "-"}`,
    `- Blocks: ${metrics.candidateBlocks}/${metrics.sourceBlocks} (source/candidate)`,
    `- Missing: ${metrics.missingBlocks}; extra: ${metrics.extraBlocks}; kind mismatches: ${metrics.kindMismatches}`,
    `- Untranslated: ${metrics.untranslatedBlocks}; empty: ${metrics.emptyBlocks}; structure issues: ${metrics.structureIssueCount}`,
    `- Protected tokens: ${metrics.protectedTokenTotal - metrics.protectedTokenMissing.length}/${metrics.protectedTokenTotal} preserved`,
    `- Glossary: ${metrics.glossaryAdhered}/${metrics.glossaryChecks} adhered`,
    `- Avg length ratio: ${number(metrics.averageLengthRatio)}; avg reference similarity: ${number(metrics.averageReferenceSimilarity)}`,
    `- Duration: ${item.durationMs} ms`,
  ];
  if (item.candidatePath) lines.push(`- Candidate: \`${item.candidatePath}\``);
  if (item.referencePath) lines.push(`- Reference: \`${item.referencePath}\``);
  if (item.error) lines.push(`- Error: ${item.error}`);
  lines.push("");

  if (metrics.blockResults.length > 0) {
    lines.push(
      "| Block | Kind | Status | Protected | Glossary missing | Source retention | Ref. similarity |",
      "| --- | --- | --- | --- | --- | --- | --- |",
    );
    for (const block of metrics.blockResults) {
      lines.push(
        `| ${block.index + 1} | ${cell(block.kind)} | ${blockStatus(block)} | ${block.protectedTokens.total - block.protectedTokens.missing.length}/${block.protectedTokens.total} | ${cell(block.glossaryMissing.join(", ") || "-")} | ${number(block.sourceWordRetention)} | ${number(block.referenceSimilarity)} |`,
      );
    }
    lines.push("");
  }
  lines.push("#### Hard issues", "", formatIssues(metrics.issues), "");
  return lines.join("\n");
}

/**
 * 生成完整 Markdown 报告。
 *
 * 包含总体指标、逐用例指标/硬问题、人工评分表与指标说明。人工评分列留空，
 * 由审校者填写。
 */
export function formatEvaluationMarkdown(report: EvaluationReport): string {
  const aggregate = report.aggregate;
  const lines: string[] = [
    "# Translation quality evaluation",
    "",
    `- Generated: ${report.generatedAt}`,
    `- Provider: \`${report.provider}\`${report.model ? ` / \`${report.model}\`` : ""}`,
    `- Language pair: \`${report.sourceLanguage}\` → \`${report.targetLanguage}\``,
    `- Cases: ${aggregate.caseCount} (${aggregate.passedCases} passed, ${aggregate.failedCases} failed)`,
    "",
    "## Summary",
    "",
    "| Metric | Value |",
    "| --- | --- |",
    `| Blocks (source / candidate) | ${aggregate.sourceBlocks} / ${aggregate.candidateBlocks} |`,
    `| Missing / extra / kind mismatch | ${aggregate.missingBlocks} / ${aggregate.extraBlocks} / ${aggregate.kindMismatches} |`,
    `| Untranslated / empty / structure issues | ${aggregate.untranslatedBlocks} / ${aggregate.emptyBlocks} / ${aggregate.structureIssueCount} |`,
    `| Protected tokens preserved | ${aggregate.protectedTokenTotal - aggregate.protectedTokenMissing}/${aggregate.protectedTokenTotal} |`,
    `| Glossary adhered | ${aggregate.glossaryAdhered}/${aggregate.glossaryChecks} |`,
    `| Average length ratio | ${number(aggregate.averageLengthRatio)} |`,
    `| Average reference similarity | ${number(aggregate.averageReferenceSimilarity)} |`,
    "",
    "## Cases",
    "",
    report.cases.length > 0
      ? report.cases.map((item) => formatCase(item)).join("\n")
      : "No cases were evaluated.\n",
    "## Human review",
    "",
    "Score each dimension from 1 (poor) to 5 (excellent). Use the block table and hard issues above as evidence, but judge accuracy and fluency against the source and reference.",
    "",
    "| Case | Accuracy | Fluency | Terminology | Style | Structure | Notes |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    ...report.cases.map(
      (item) => `| ${cell(item.id)} |  |  |  |  |  |  |`,
    ),
    "",
    "## Metric notes",
    "",
    "- Hard failures cover missing/extra blocks, empty or source-echoed blocks, protected-token loss, glossary violations, structural drift, and frontmatter drift.",
    "- Source-word retention is a heuristic for outputs that keep most English source words and only add markup; it can be noisy for heavily technical text.",
    "- Reference similarity is character-bigram Dice and is advisory only; a different but valid wording can score low.",
    "- Length ratio is advisory only; language pairs and Markdown markup affect the expected range.",
    "- Machine checks cannot judge semantic accuracy or naturalness; human scores are required for those.",
    "",
  ];
  if (report.notes.length > 0) {
    lines.push("## Notes", "", ...report.notes.map((note) => `- ${note}`), "");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

/** 只生成人工评分表，便于单独打印或分发给审校者。 */
export function formatHumanReviewMarkdown(report: EvaluationReport): string {
  return [
    "# Translation quality — human review",
    "",
    `Generated: ${report.generatedAt}`,
    `Provider: \`${report.provider}\`${report.model ? ` / \`${report.model}\`` : ""}`,
    `Language pair: \`${report.sourceLanguage}\` → \`${report.targetLanguage}\``,
    "",
    "Score 1–5: Accuracy, Fluency, Terminology, Style, Structure.",
    "",
    "| Case | Accuracy | Fluency | Terminology | Style | Structure | Notes |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    ...report.cases.map(
      (item) => `| ${cell(item.id)} |  |  |  |  |  |  |`,
    ),
    "",
    "Use `report.md` for automatic issues and block-level evidence.",
    "",
  ].join("\n");
}

export type { CaseEvaluation, EvaluationAggregate, EvaluationIssue };
