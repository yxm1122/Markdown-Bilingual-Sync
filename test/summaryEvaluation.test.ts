/** 测试：摘要/术语表质量指标与报告。 */
import { describe, expect, it } from "vitest";
import {
  aggregateSummaryEvaluations,
  countSummaryWords,
  evaluateSummaryCase,
} from "../src/evaluation/summaryMetrics";
import {
  createSummaryReport,
  formatSummaryHumanReview,
  formatSummaryJson,
  formatSummaryMarkdown,
  type SummaryCaseReport,
} from "../src/evaluation/summaryReport";

const SOURCE =
  "The cache stores data. The cache is fast. Use the I/O layer.";

function evaluate(
  result: {
    summary: string;
    glossary: Array<{ source: string; target: string }>;
    brief?: Record<string, string>;
  },
  userGlossary?: Array<{ source: string; target: string }>,
) {
  return evaluateSummaryCase({
    id: "demo",
    tags: ["cache"],
    sourceText: SOURCE,
    result,
    userGlossary,
  });
}

describe("summary evaluation metrics", () => {
  it("counts words and flags deterministic glossary problems", () => {
    const evaluation = evaluate(
      {
        summary: "word ".repeat(130),
        glossary: [
          { source: "cache", target: "缓存" },
          { source: "missing", target: "缺失" },
          { source: "data", target: "data" },
          { source: "I/O", target: "输入/输出" },
          { source: "cache", target: "缓存 / 快取" },
        ],
      },
      [{ source: "cache", target: "高速缓存" }],
    );

    expect(evaluation.summaryWithinRange).toBe(true);
    expect(evaluation.glossaryCount).toBe(5);
    expect(evaluation.invalidGlossaryCount).toBe(4);
    expect(evaluation.singleOccurrenceCount).toBe(2);
    expect(evaluation.userGlossaryConflictCount).toBe(2);
    expect(evaluation.issues.map((issue) => issue.code)).toEqual([
      "user-glossary-conflict",
      "source-missing",
      "source-equals-target",
      "target-alternatives",
      "user-glossary-conflict",
    ]);
    expect(countSummaryWords("word ".repeat(130))).toBe(130);
  });

  it("flags audience and tone guidance copied into the summary", () => {
    const evaluation = evaluate({
      summary: "本文档面向软件开发者与运维工程师，语气直接、专业、信息密集。",
      glossary: [],
      brief: {
        audience: "软件开发者、运维工程师、技术团队负责人",
        toneAndStyle: "技术文档风格，直接、专业、信息密集。",
        ambiguities: "parked 译为搁置。",
        doNotTranslate: "Signal Relay",
      },
    });
    expect(evaluation.guidanceLeaks.map((leak) => leak.field)).toEqual([
      "audience",
      "toneAndStyle",
    ]);
    expect(evaluation.briefOverlapFields).toContain("audience");
    expect(evaluation.guidancePhrases).toEqual(["audience", "tone"]);
    expect(evaluation.briefOverlapRatio).toBeGreaterThan(0);
  });

  it("does not flag a document summary that stays out of the brief", () => {
    const evaluation = evaluate({
      summary: "本文介绍缓存与 I/O 层的工作方式。",
      glossary: [],
      brief: {
        audience: "软件开发者",
        toneAndStyle: "直接、专业",
      },
    });
    expect(evaluation.guidanceLeaks).toEqual([]);
    expect(evaluation.briefOverlapFields).toEqual([]);
    expect(evaluation.guidancePhrases).toEqual([]);
  });

  it("aggregates raw and filtered metrics", () => {
    const first = evaluate({
      summary: "short",
      glossary: [{ source: "cache", target: "缓存" }],
    });
    const second = evaluate({
      summary: "short",
      glossary: [{ source: "missing", target: "缺失" }],
    });
    const aggregate = aggregateSummaryEvaluations([first, second]);
    expect(aggregate.caseCount).toBe(2);
    expect(aggregate.totalGlossaryEntries).toBe(2);
    expect(aggregate.totalInvalidEntries).toBe(1);
    expect(aggregate.casesWithInvalidEntries).toBe(1);
    expect(aggregate.issueCounts["source-missing"]).toBe(1);
    expect(aggregate.summariesWithinRange).toBe(0);
  });
});

function caseReport(): SummaryCaseReport {
  const raw = evaluate(
    {
      summary: "short summary",
      glossary: [
        { source: "cache", target: "缓存 / 快取" },
        { source: "data", target: "数据" },
      ],
    },
    [{ source: "cache", target: "缓存" }],
  );
  const filtered = evaluate({
    summary: "short summary",
    glossary: [{ source: "data", target: "数据" }],
  });
  return {
    id: "demo",
    tags: ["cache"],
    sourcePath: "eval/cases/demo/source.md",
    durationMs: 12,
    raw,
    filtered,
    dropped: [
      {
        entry: { source: "cache", target: "缓存 / 快取" },
        reason: "alternative-target",
      },
    ],
  };
}

describe("summary evaluation report", () => {
  it("formats raw/filtered aggregates and dropped entries", () => {
    const report = createSummaryReport({
      provider: "test",
      model: "test-model",
      filterGenerated: true,
      sourceLanguage: "en",
      targetLanguage: "zh-CN",
      cases: [caseReport()],
      notes: ["Synthetic summary report."],
    });
    const markdown = formatSummaryMarkdown(report);
    expect(markdown).toContain("# Summary and glossary evaluation");
    expect(markdown).toContain("### Provider output (raw)");
    expect(markdown).toContain("### Production output (filtered)");
    expect(markdown).toContain("### demo");
    expect(markdown).toContain("Dropped by deterministic filter");
    expect(markdown).toContain("Synthetic summary report.");
    expect(report.aggregate.raw.totalGlossaryEntries).toBe(2);
    expect(report.aggregate.filtered.totalGlossaryEntries).toBe(1);
  });

  it("excludes failed cases from aggregates", () => {
    const failed = { ...caseReport(), id: "failed", error: "timeout" };
    const report = createSummaryReport({
      provider: "test",
      filterGenerated: true,
      sourceLanguage: "en",
      targetLanguage: "zh-CN",
      cases: [caseReport(), failed],
    });
    expect(report.failedCases).toBe(1);
    expect(report.aggregate.filtered.caseCount).toBe(1);
    expect(formatSummaryMarkdown(report)).toContain(
      "(1 failed, excluded from aggregates)",
    );
  });

  it("serializes JSON and a standalone human review table", () => {
    const report = createSummaryReport({
      provider: "test",
      filterGenerated: true,
      sourceLanguage: "en",
      targetLanguage: "zh-CN",
      cases: [caseReport()],
    });
    const json = JSON.parse(formatSummaryJson(report)) as {
      aggregate: { filtered: { totalGlossaryEntries: number } };
      cases: Array<{ id: string }>;
    };
    expect(json.aggregate.filtered.totalGlossaryEntries).toBe(1);
    expect(json.cases[0]?.id).toBe("demo");
    expect(formatSummaryHumanReview(report)).toContain("| demo |");
  });
});
