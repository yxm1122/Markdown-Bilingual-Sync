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
