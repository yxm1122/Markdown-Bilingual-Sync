/** 测试：评估报告聚合、Markdown/JSON 输出与人工评分表。 */
import { describe, expect, it } from "vitest";
import { evaluateCase } from "../src/evaluation/metrics";
import {
  createEvaluationReport,
  formatEvaluationJson,
  formatEvaluationMarkdown,
  formatHumanReviewMarkdown,
  type EvaluationCaseReport,
} from "../src/evaluation/report";

function caseReport(): EvaluationCaseReport {
  const evaluation = evaluateCase({
    id: "demo",
    sourceText: "# Heading\n\nParagraph.\n",
    candidateText: "# 标题\n\n段落。\n",
    referenceText: "# 标题\n\n段落。\n",
    tags: ["basic"],
  });
  return {
    ...evaluation,
    durationMs: 12,
    candidatePath: "tmp/demo.md",
    referencePath: "eval/demo.md",
  };
}

describe("translation evaluation report", () => {
  it("aggregates case metrics and formats a Markdown report", () => {
    const report = createEvaluationReport({
      provider: "test",
      model: "test-model",
      sourceLanguage: "en",
      targetLanguage: "zh-CN",
      cases: [caseReport()],
      notes: ["Synthetic test report."],
    });
    const markdown = formatEvaluationMarkdown(report);

    expect(report.aggregate.caseCount).toBe(1);
    expect(report.aggregate.passedCases).toBe(1);
    expect(markdown).toContain("# Translation quality evaluation");
    expect(markdown).toContain("### demo — PASS");
    expect(markdown).toContain("## Human review");
    expect(markdown).toContain("| demo |  |  |  |  |  |  |");
    expect(markdown).toContain("Synthetic test report.");
  });

  it("serializes JSON and a standalone human review table", () => {
    const report = createEvaluationReport({
      provider: "test",
      sourceLanguage: "en",
      targetLanguage: "zh-CN",
      cases: [caseReport()],
    });
    const json = JSON.parse(formatEvaluationJson(report)) as {
      aggregate: { caseCount: number };
      cases: Array<{ id: string }>;
    };
    expect(json.aggregate.caseCount).toBe(1);
    expect(json.cases[0]?.id).toBe("demo");
    expect(formatHumanReviewMarkdown(report)).toContain("| demo |");
  });

  it("includes timing and concurrency in Markdown and JSON", () => {
    const report = createEvaluationReport({
      provider: "test",
      sourceLanguage: "en",
      targetLanguage: "zh-CN",
      cases: [caseReport()],
      timing: {
        caseConcurrency: 4,
        requestConcurrency: 8,
        thinkingMode: "disabled",
        responseCount: 10,
        reasoningResponses: 5,
        retry: { events: 3, byReason: { http: 1, glossary: 2 } },
        totalCaseDurationMs: 10_000,
        wallDurationMs: 3_000,
      },
    });
    const markdown = formatEvaluationMarkdown(report);
    expect(markdown).toContain("- Timing: 3.0s wall, 10.0s across cases");
    expect(markdown).toContain(
      "- Concurrency: 4 case(s), 8 request(s); thinking: disabled",
    );
    expect(markdown).toContain("- Reasoning responses: 5/10");
    expect(markdown).toContain(
      "- Automatic retries: 3 event(s) across 10 response(s); http 1, glossary 2",
    );
    const json = JSON.parse(formatEvaluationJson(report)) as {
      timing: { wallDurationMs: number; retry: { events: number } };
    };
    expect(json.timing.wallDurationMs).toBe(3_000);
    expect(json.timing.retry.events).toBe(3);
  });

  it("escapes table separators in dynamic case ids", () => {
    const item = { ...caseReport(), id: "a|b" };
    const report = createEvaluationReport({
      provider: "test",
      sourceLanguage: "en",
      targetLanguage: "zh-CN",
      cases: [item],
    });
    expect(formatEvaluationMarkdown(report)).toContain("| a\\|b |");
  });
});
