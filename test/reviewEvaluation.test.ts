/** 测试：AI 批注评测的归一化、匹配与聚合。 */
import { describe, expect, it } from "vitest";
import {
  aggregateReviewEvaluations,
  evaluateReviewCase,
  isStandaloneInstruction,
  normalizeReviewAnnotation,
  type ExpectedReviewIssue,
} from "../src/evaluation/reviewMetrics";
import type { ReviewAnnotationDraft } from "../src/translation/types";

function draft(
  overrides: Partial<ReviewAnnotationDraft> = {},
): ReviewAnnotationDraft {
  return {
    id: "b1",
    side: "target",
    type: "translation-uncertain",
    severity: "check",
    message: "The translation needs review.",
    ...overrides,
  };
}

function legacyDraft(
  overrides: Partial<ReviewAnnotationDraft> & {
    suggestion?: string;
    suggestedAnswers?: string[];
  },
): ReviewAnnotationDraft {
  return { ...draft(), ...overrides } as unknown as ReviewAnnotationDraft;
}

const blockTexts = {
  b1: {
    sourceText: "You can export the document only in the desktop app.",
    targetText: "你可以导出文档。",
  },
};

function expected(
  overrides: Partial<ExpectedReviewIssue> = {},
): ExpectedReviewIssue {
  return {
    blockId: "b1",
    side: "target",
    type: "translation-uncertain",
    severity: "check",
    match: ["only", "桌面", "desktop"],
    option: {
      kind: "instruction",
      mode: "once",
      mustInclude: ["桌面", "desktop"],
    },
    ...overrides,
  };
}

describe("review evaluation", () => {
  it("normalizes legacy suggestion and suggestedAnswers", () => {
    const advice = normalizeReviewAnnotation(
      legacyDraft({ suggestion: "请确认原文中的数字。" }),
    );
    expect(advice.options).toEqual([
      { kind: "advice", text: "请确认原文中的数字。" },
    ]);

    const instructions = normalizeReviewAnnotation(
      legacyDraft({
        suggestedAnswers: [
          "将“你可以导出文档”改为“你只能在桌面应用中导出文档”。",
        ],
      }),
      [blockTexts.b1.sourceText, blockTexts.b1.targetText],
    );
    expect(instructions.options[0]).toMatchObject({
      kind: "instruction",
      mode: "once",
      standalone: true,
    });
  });

  it("rejects answer-like or deictic instructions without a concrete anchor", () => {
    expect(isStandaloneInstruction("Use the first option.")).toBe(false);
    expect(isStandaloneInstruction("是的，补上。")).toBe(false);
    expect(isStandaloneInstruction("第一种。")).toBe(false);
    expect(
      isStandaloneInstruction(
        "将“你可以导出文档”改为“你只能在桌面应用中导出文档”。",
      ),
    ).toBe(true);
    expect(isStandaloneInstruction("将超时从 30 秒改为 60 秒。")).toBe(true);
    expect(
      isStandaloneInstruction("不要翻译“token”，保持原文。"),
    ).toBe(true);
  });

  it("matches a target issue and checks the expected instruction", () => {
    const evaluation = evaluateReviewCase({
      id: "omission-scope",
      annotations: [
        draft({
          message: "The target omits the desktop-only restriction.",
          options: [
            {
              kind: "instruction",
              text: "将“你可以导出文档”改为“你只能在桌面应用中导出文档”。",
              mode: "once",
            },
          ],
        }),
      ],
      expected: [expected()],
      blockTexts,
    });
    expect(evaluation.truePositives).toBe(1);
    expect(evaluation.falseNegatives).toBe(0);
    expect(evaluation.falsePositiveCount).toBe(0);
    expect(evaluation.optionPassedCount).toBe(1);
    expect(evaluation.standaloneRate).toBe(1);
    expect(evaluation.modeAccuracy).toBe(1);
  });

  it("counts annotation on a clean case as a false positive", () => {
    const evaluation = evaluateReviewCase({
      id: "clean",
      annotations: [draft({ message: "Check the tone." })],
      expected: [],
      blockTexts,
    });
    expect(evaluation.cleanCase).toBe(true);
    expect(evaluation.cleanPassed).toBe(false);
    expect(evaluation.falsePositiveCount).toBe(1);
    expect(evaluation.precision).toBe(0);
    expect(evaluation.recall).toBe(1);
  });

  it("reports advice fallback and persistent-mode mismatches", () => {
    const advice = evaluateReviewCase({
      id: "advice",
      annotations: [
        draft({
          side: "source",
          type: "source-issue",
          message: "The source contradicts itself: 30 seconds vs 60 seconds.",
          options: [
            { kind: "advice", text: "请确认超时时间是 30 秒还是 60 秒。" },
          ],
        }),
      ],
      expected: [
        expected({
          side: "source",
          type: "source-issue",
          match: ["30", "60", "contradict"],
          option: { kind: "advice", mustInclude: ["30", "60"] },
        }),
      ],
      blockTexts,
    });
    expect(advice.truePositives).toBe(1);
    expect(advice.adviceFallbackRate).toBe(1);

    const persistent = evaluateReviewCase({
      id: "persistent",
      annotations: [
        draft({
          message: "The cache term is inconsistent.",
          options: [
            {
              kind: "instruction",
              text: "在本块中统一使用“缓存”。",
              mode: "once",
            },
          ],
        }),
      ],
      expected: [
        expected({
          match: ["缓存", "cache"],
          option: {
            kind: "instruction",
            mode: "persistent",
            mustInclude: ["缓存"],
          },
        }),
      ],
      blockTexts,
    });
    expect(persistent.optionPassedCount).toBe(1);
    expect(persistent.modeAccuracy).toBe(0);
  });

  it("supports new typed options and counts mixed annotations", () => {
    const annotation = {
      ...draft({ message: "Review the term." }),
      options: [
        { kind: "instruction", text: "将“快取”改为“缓存”。", mode: "persistent" },
        { kind: "advice", text: "请确认是否需要在全文统一术语。" },
      ],
    } as ReviewAnnotationDraft;
    const evaluation = evaluateReviewCase({
      id: "typed",
      annotations: [annotation],
      expected: [
        expected({
          match: ["缓存"],
          option: {
            kind: "instruction",
            mode: "persistent",
            mustInclude: ["缓存"],
          },
        }),
      ],
      blockTexts,
    });
    expect(evaluation.truePositives).toBe(1);
    expect(evaluation.modeAccuracy).toBe(1);
    expect(evaluation.mixedOptionAnnotations).toBe(1);
    expect(evaluation.annotations[0].options).toHaveLength(2);
  });

  it("does not match the wrong side or type and reports false positives", () => {
    const evaluation = evaluateReviewCase({
      id: "wrong-side",
      annotations: [
        draft({
          side: "source",
          type: "term",
          message: "Only in the desktop app.",
          options: [
            {
              kind: "instruction",
              text: "请补齐桌面端限制。",
              mode: "once",
            },
          ],
        }),
        draft({ id: "b2", message: "Unrelated note." }),
      ],
      expected: [expected()],
      blockTexts: {
        ...blockTexts,
        b2: { sourceText: "Preview.", targetText: "预览。" },
      },
    });
    expect(evaluation.truePositives).toBe(0);
    expect(evaluation.falseNegatives).toBe(1);
    expect(evaluation.falsePositiveCount).toBe(2);
    expect(evaluation.precision).toBe(0);
    expect(evaluation.recall).toBe(0);
  });

  it("aggregates clean and issue cases", () => {
    const issue = evaluateReviewCase({
      id: "issue",
      annotations: [
        draft({
          message: "Missing desktop-only scope.",
          options: [
            {
              kind: "instruction",
              text: "将“你可以导出文档”改为“你只能在桌面应用中导出文档”。",
              mode: "once",
            },
          ],
        }),
      ],
      expected: [expected()],
      blockTexts,
    });
    const clean = evaluateReviewCase({
      id: "clean",
      annotations: [],
      expected: [],
      blockTexts,
    });
    const aggregate = aggregateReviewEvaluations([issue, clean]);
    expect(aggregate.caseCount).toBe(2);
    expect(aggregate.cleanCases).toBe(1);
    expect(aggregate.cleanFalsePositiveCases).toBe(0);
    expect(aggregate.expectedIssues).toBe(1);
    expect(aggregate.truePositives).toBe(1);
    expect(aggregate.optionCoverage).toBe(1);
    expect(aggregate.standaloneRate).toBe(1);
    expect(aggregate.cleanCasePassRate).toBe(1);
  });
});
