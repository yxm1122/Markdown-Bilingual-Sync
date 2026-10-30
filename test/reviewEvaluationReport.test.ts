/** 测试：AI 批注评测报告格式与对比。 */
import { describe, expect, it } from "vitest";
import { evaluateReviewCase } from "../src/evaluation/reviewMetrics";
import {
  createReviewReport,
  formatReviewComparison,
  formatReviewHumanReview,
  formatReviewJson,
  formatReviewMarkdown,
} from "../src/evaluation/reviewReport";
import type { ReviewAnnotationDraft } from "../src/translation/types";

const blockTexts = {
  b1: {
    sourceText: "Set the timeout to 60 seconds.",
    targetText: "将超时设置为 30 秒。",
  },
};

function annotation(
  overrides: Partial<ReviewAnnotationDraft> = {},
): ReviewAnnotationDraft {
  return {
    id: "b1",
    side: "target",
    type: "translation-uncertain",
    severity: "check",
    message: "The number differs from the source.",
    options: [
      {
        kind: "instruction",
        text: "将“30 秒”改为“60 秒”。",
        mode: "once",
      },
    ],
    ...overrides,
  };
}

function caseReport() {
  return {
    ...evaluateReviewCase({
      id: "number",
      tags: ["numbers"],
      annotations: [annotation()],
      expected: [
        {
          blockId: "b1",
          side: "target",
          type: "translation-uncertain",
          severity: "check",
          match: ["60", "30"],
          option: {
            kind: "instruction" as const,
            mode: "once" as const,
            mustInclude: ["60"],
          },
        },
      ],
      blockTexts,
    }),
    sourcePath: "source.md",
    targetPath: "target.md",
  };
}

describe("review evaluation report", () => {
  it("renders summary, cases, and human review", () => {
    const report = createReviewReport({
      provider: "mock",
      model: "mock",
      label: "test",
      sourceLanguage: "en",
      targetLanguage: "zh-CN",
      outputLanguage: "zh-CN",
      systemPrompt: "review prompt",
      cases: [caseReport()],
    });
    const markdown = formatReviewMarkdown(report);
    expect(markdown).toContain("# AI annotation quality evaluation");
    expect(markdown).toContain("Clean case pass rate");
    expect(markdown).toContain("### number — OK");
    expect(markdown).toContain("**HIT**");
    expect(markdown).toContain("standalone=yes");
    const human = formatReviewHumanReview(report);
    expect(human).toContain("| number |");
    expect(JSON.parse(formatReviewJson(report)).cases[0].id).toBe("number");
  });

  it("compares aggregate and per-case metrics", () => {
    const baseline = createReviewReport({
      provider: "mock",
      model: "mock",
      label: "baseline",
      sourceLanguage: "en",
      targetLanguage: "zh-CN",
      outputLanguage: "zh-CN",
      systemPrompt: "old prompt",
      cases: [
        {
          ...evaluateReviewCase({
            id: "number",
            annotations: [],
            expected: [
              {
                blockId: "b1",
                side: "target",
                type: "translation-uncertain",
                match: ["60", "30"],
                option: { kind: "instruction", mustInclude: ["60"] },
              },
            ],
            blockTexts,
          }),
        },
      ],
    });
    const current = createReviewReport({
      provider: "mock",
      model: "mock",
      label: "current",
      sourceLanguage: "en",
      targetLanguage: "zh-CN",
      outputLanguage: "zh-CN",
      systemPrompt: "new prompt with one more line",
      cases: [caseReport()],
    });
    const comparison = formatReviewComparison(current, baseline);
    expect(comparison).toContain("| Recall | 0.0% | 100.0% | +100.0 pp |");
    expect(comparison).toContain("| number | 0/1/0 | 1/0/0 |");
    expect(comparison).toContain("Prompt chars");
  });
});
