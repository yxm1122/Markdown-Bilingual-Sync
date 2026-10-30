/**
 * 摘要/术语表生成质量报告（纯逻辑）。
 *
 * 报告同时保留 provider 原始输出（raw）和经过产品过滤后的结果（filtered），
 * 便于区分“提示词改善”和“确定性过滤”的贡献。是否必要仍由人工评分。
 */
import type { DroppedGeneratedGlossaryEntry } from "../glossary/generatedGlossary";
import type { ThinkingMode } from "../translation/types";
import type {
  SummaryCaseEvaluation,
  SummaryEvaluationAggregate,
} from "./summaryMetrics";
import {
  aggregateSummaryEvaluations,
} from "./summaryMetrics";

export interface SummaryCaseReport {
  id: string;
  tags: string[];
  sourcePath: string;
  candidatePath?: string;
  durationMs: number;
  error?: string;
  /** 模型直接返回的术语表评估。 */
  raw: SummaryCaseEvaluation;
  /** 产品确定性过滤后的术语表评估；未启用过滤时与 raw 相同。 */
  filtered: SummaryCaseEvaluation;
  dropped: DroppedGeneratedGlossaryEntry[];
}

export interface SummaryTiming {
  caseConcurrency: number;
  requestConcurrency?: number;
  thinkingMode?: ThinkingMode;
  responseCount?: number;
  reasoningResponses?: number;
  totalCaseDurationMs: number;
  wallDurationMs: number;
}

export interface SummaryReport {
  generatedAt: string;
  provider: string;
  model?: string;
  /** 是否对模型输出应用了产品过滤。 */
  filterGenerated: boolean;
  sourceLanguage: string;
  targetLanguage: string;
  cases: SummaryCaseReport[];
  /** 请求失败的用例数；这些用例不进入聚合，避免 0 条/0 词拉低平均值。 */
  failedCases: number;
  aggregate: {
    raw: SummaryEvaluationAggregate;
    filtered: SummaryEvaluationAggregate;
  };
  timing?: SummaryTiming;
  notes: string[];
}

export function createSummaryReport(input: {
  provider: string;
  model?: string;
  filterGenerated: boolean;
  sourceLanguage: string;
  targetLanguage: string;
  cases: readonly SummaryCaseReport[];
  timing?: SummaryTiming;
  notes?: readonly string[];
}): SummaryReport {
  const validCases = input.cases.filter((item) => !item.error);
  return {
    generatedAt: new Date().toISOString(),
    provider: input.provider,
    ...(input.model ? { model: input.model } : {}),
    filterGenerated: input.filterGenerated,
    sourceLanguage: input.sourceLanguage,
    targetLanguage: input.targetLanguage,
    cases: [...input.cases],
    failedCases: input.cases.length - validCases.length,
    aggregate: {
      raw: aggregateSummaryEvaluations(validCases.map((item) => item.raw)),
      filtered: aggregateSummaryEvaluations(
        validCases.map((item) => item.filtered),
      ),
    },
    ...(input.timing ? { timing: input.timing } : {}),
    notes: [...(input.notes ?? [])],
  };
}

export function formatSummaryJson(report: SummaryReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

function cell(value: unknown): string {
  return String(value ?? "")
    .replace(/\|/g, "\\|")
    .replace(/\r?\n/g, " ");
}

function number(value: number, digits = 2): string {
  return Number.isFinite(value) ? value.toFixed(digits) : "-";
}

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function aggregateTable(
  label: string,
  aggregate: SummaryEvaluationAggregate,
): string[] {
  return [
    `### ${label}`,
    "",
    "| Metric | Value |",
    "| --- | --- |",
    `| Cases | ${aggregate.caseCount} |`,
    `| Glossary entries | ${aggregate.totalGlossaryEntries} (${number(aggregate.averageGlossaryEntries)} per case) |`,
    `| Invalid entries | ${aggregate.totalInvalidEntries} (${percent(aggregate.invalidEntryRate)}) |`,
    `| Single-occurrence entries | ${aggregate.totalSingleOccurrenceEntries} (${percent(aggregate.singleOccurrenceRate)}) |`,
    `| User-glossary conflicts | ${aggregate.totalUserGlossaryConflicts} |`,
    `| Cases with invalid entries | ${aggregate.casesWithInvalidEntries} |`,
    `| Summary words (average) | ${number(aggregate.averageSummaryWords)} |`,
    `| Summaries within 120–250 words | ${aggregate.summariesWithinRange}/${aggregate.caseCount} |`,
    "",
    "| Issue | Count |",
    "| --- | --- |",
    ...Object.entries(aggregate.issueCounts).map(
      ([code, count]) => `| \`${code}\` | ${count} |`,
    ),
    "",
  ];
}

function formatCase(item: SummaryCaseReport): string {
  const filtered = item.filtered;
  const lines: string[] = [
    `### ${item.id}`,
    "",
    `- Tags: ${item.tags.length > 0 ? item.tags.join(", ") : "-"}`,
    `- Summary words: ${filtered.summaryWords}${filtered.summaryWithinRange ? "" : " (outside 120–250)"}`,
    `- Glossary: raw ${item.raw.glossaryCount}, filtered ${filtered.glossaryCount}, dropped ${item.dropped.length}`,
    `- Invalid: raw ${item.raw.invalidGlossaryCount}, filtered ${filtered.invalidGlossaryCount}`,
    `- Single occurrence: raw ${item.raw.singleOccurrenceCount}, filtered ${filtered.singleOccurrenceCount}`,
    `- Duration: ${item.durationMs} ms`,
    `- Source: \`${item.sourcePath}\``,
  ];
  if (item.candidatePath) {
    lines.push(`- Candidate: \`${item.candidatePath}\``);
  }
  if (item.error) {
    lines.push(`- Error: ${item.error}`);
  }
  lines.push("", "#### Summary", "", filtered.summary || "(empty)", "");
  if (filtered.brief) {
    lines.push("#### Brief", "");
    for (const [field, value] of Object.entries(filtered.brief)) {
      if (value) lines.push(`- **${field}**: ${value}`);
    }
    lines.push("");
  }

  if (filtered.entries.length > 0) {
    lines.push(
      "#### Generated glossary",
      "",
      "| Source | Target | Occurrences | Flags |",
      "| --- | --- | --- | --- |",
      ...filtered.entries.map(
        (entry) =>
          `| ${cell(entry.entry.source)} | ${cell(entry.entry.target)} | ${entry.occurrences} | ${cell(
            [
              ...entry.issues.map((issue) => issue.code),
              ...(entry.singleOccurrence ? ["single-occurrence"] : []),
            ].join(", ") || "-",
          )} |`,
      ),
      "",
    );
  } else {
    lines.push("#### Generated glossary", "", "No entries.", "");
  }

  if (item.dropped.length > 0) {
    lines.push(
      "#### Dropped by deterministic filter",
      "",
      "| Source | Target | Reason |",
      "| --- | --- | --- |",
      ...item.dropped.map(
        (dropped) =>
          `| ${cell(dropped.entry.source)} | ${cell(dropped.entry.target)} | \`${dropped.reason}\` |`,
      ),
      "",
    );
  }

  if (filtered.issues.length > 0) {
    lines.push(
      "#### Issues",
      "",
      ...filtered.issues.map(
        (issue) =>
          `- \`${issue.code}\`: ${cell(issue.source)} → ${cell(issue.target)} — ${issue.message}`,
      ),
      "",
    );
  }
  return lines.join("\n");
}

export function formatSummaryMarkdown(report: SummaryReport): string {
  const lines: string[] = [
    "# Summary and glossary evaluation",
    "",
    `- Generated: ${report.generatedAt}`,
    `- Provider: \`${report.provider}\`${report.model ? ` / \`${report.model}\`` : ""}`,
    `- Language pair: \`${report.sourceLanguage}\` → \`${report.targetLanguage}\``,
    `- Deterministic glossary filter: ${report.filterGenerated ? "enabled" : "disabled"}`,
    `- Cases: ${report.cases.length}${report.failedCases > 0 ? ` (${report.failedCases} failed, excluded from aggregates)` : ""}`,
    ...(report.timing
      ? [
          `- Timing: ${(report.timing.wallDurationMs / 1000).toFixed(1)}s wall, ${(report.timing.totalCaseDurationMs / 1000).toFixed(1)}s across cases`,
          `- Concurrency: ${report.timing.caseConcurrency} case(s), ${report.timing.requestConcurrency ?? "-"} request(s); thinking: ${report.timing.thinkingMode ?? "n/a"}`,
          ...(report.timing.responseCount !== undefined
            ? [
                `- Reasoning responses: ${report.timing.reasoningResponses ?? 0}/${report.timing.responseCount}`,
              ]
            : []),
        ]
      : []),
    "",
    "## Aggregates",
    "",
    ...aggregateTable("Provider output (raw)", report.aggregate.raw),
    ...aggregateTable("Production output (filtered)", report.aggregate.filtered),
    "## Cases",
    "",
    report.cases.length > 0
      ? report.cases.map((item) => formatCase(item)).join("\n")
      : "No cases were evaluated.\n",
    "## Human review",
    "",
    "Mark each case: useful entries (1–5), unnecessary entries (1–5), missing critical terms (yes/no), and notes. Automatic metrics only flag deterministic problems; they do not judge whether an entry is worth keeping.",
    "",
    "| Case | Useful entries | Unnecessary entries | Missing critical terms | Notes |",
    "| --- | --- | --- | --- | --- |",
    ...report.cases.map((item) => `| ${cell(item.id)} |  |  |  |  |`),
    "",
    "## Metric notes",
    "",
    "- `source-missing`: the source term does not appear in the stripped document body.",
    "- `source-equals-target`: the entry does not describe a translation decision.",
    "- `target-alternatives`: the target contains `/`, `、`, `or`, or `或` alternatives; such entries cannot be used as exact mandatory terms.",
    "- `target-protected-syntax`: the term contains code, URL, HTML, footnote syntax, or a newline.",
    "- `user-glossary-conflict`: the generated target differs from the user glossary for the same source.",
    "- `single-occurrence` is advisory: a term used once does not need cross-document consistency, but it may still be a key term.",
    "",
  ];
  if (report.notes.length > 0) {
    lines.push("## Notes", "", ...report.notes.map((note) => `- ${note}`), "");
  }
  return lines.join("\n");
}

export function formatSummaryHumanReview(report: SummaryReport): string {
  return [
    "# Summary/glossary human review",
    "",
    `- Generated: ${report.generatedAt}`,
    `- Provider: \`${report.provider}\`${report.model ? ` / \`${report.model}\`` : ""}`,
    "",
    "| Case | Useful entries | Unnecessary entries | Missing critical terms | Notes |",
    "| --- | --- | --- | --- | --- |",
    ...report.cases.map((item) => `| ${cell(item.id)} |  |  |  |  |`),
    "",
  ].join("\n");
}
