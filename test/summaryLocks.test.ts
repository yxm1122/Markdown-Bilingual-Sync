/** 测试：文档简报生成锁的归一化、目标推导与切换。 */
import { describe, expect, it } from "vitest";
import {
  BRIEF_FIELD_KEYS,
  allSummaryTargets,
  hasAnyBriefTarget,
  hasAnySummaryTarget,
  hasSummaryLocks,
  normalizeSummaryLocks,
  summaryTargets,
  withSummaryLock,
} from "../src/translation/summaryLocks";

describe("summary locks", () => {
  it("normalizes untrusted lock state", () => {
    expect(normalizeSummaryLocks(undefined)).toEqual({});
    expect(
      normalizeSummaryLocks({
        summary: true,
        glossary: false,
        brief: {
          audience: true,
          toneAndStyle: false,
          bogus: true,
        },
      }),
    ).toEqual({ summary: true, brief: { audience: true } });
    expect(normalizeSummaryLocks({ brief: {} })).toEqual({});
    expect(hasSummaryLocks({ summary: true })).toBe(true);
    expect(hasSummaryLocks({})).toBe(false);
  });

  it("derives generation targets from locks", () => {
    expect(allSummaryTargets()).toEqual({
      summary: true,
      glossary: true,
      brief: {
        audience: true,
        toneAndStyle: true,
        ambiguities: true,
        doNotTranslate: true,
      },
    });

    const targets = summaryTargets({
      summary: true,
      glossary: true,
      brief: { audience: true },
    });
    expect(targets).toEqual({
      summary: false,
      glossary: false,
      brief: {
        audience: false,
        toneAndStyle: true,
        ambiguities: true,
        doNotTranslate: true,
      },
    });
    expect(hasAnyBriefTarget(targets)).toBe(true);
    expect(hasAnySummaryTarget(targets)).toBe(true);

    const allBriefLocked = Object.fromEntries(
      BRIEF_FIELD_KEYS.map((field) => [field, true]),
    ) as Record<(typeof BRIEF_FIELD_KEYS)[number], boolean>;
    expect(
      hasAnySummaryTarget(
        summaryTargets({
          summary: true,
          glossary: true,
          brief: allBriefLocked,
        }),
      ),
    ).toBe(false);
  });

  it("toggles locks without dropping siblings", () => {
    let locks = withSummaryLock(undefined, "audience", true);
    expect(locks).toEqual({ brief: { audience: true } });

    locks = withSummaryLock(locks, "glossary", true);
    expect(locks).toEqual({
      glossary: true,
      brief: { audience: true },
    });

    locks = withSummaryLock(locks, "audience", false);
    expect(locks).toEqual({ glossary: true });

    locks = withSummaryLock(locks, "glossary", false);
    expect(locks).toEqual({});
  });
});
