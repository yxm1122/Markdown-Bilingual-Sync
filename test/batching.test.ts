/** 测试：按 token 预算与并发约束的动态分批。 */
import { describe, expect, it } from "vitest";
import {
  estimateItemTokens,
  estimateTokenCount,
  planTranslationBatches,
} from "../src/translation/batching";
import type { TranslationItem } from "../src/translation/types";

function item(id: string, text: string): TranslationItem {
  return { id, text, kind: "paragraph", headingPath: [] };
}

describe("dynamic translation batching", () => {
  it("estimates CJK text more densely than ASCII", () => {
    expect(estimateTokenCount("")).toBe(0);
    expect(estimateTokenCount("你好世界")).toBeGreaterThan(
      estimateTokenCount("abcdefgh"),
    );
  });

  it("packs small items up to the hard item limit", () => {
    const items = [item("a", "one"), item("b", "two"), item("c", "three")];
    expect(
      planTranslationBatches(items, {
        maxItems: 50,
        tokenBudget: 6000,
      }),
    ).toHaveLength(1);
    expect(
      planTranslationBatches(items, {
        maxItems: 2,
        tokenBudget: 6000,
      }).map((batch) => batch.map((entry) => entry.id)),
    ).toEqual([["a", "b"], ["c"]]);
  });

  it("splits when the token budget is reached", () => {
    const first = item("a", "a".repeat(100));
    const second = item("b", "b".repeat(100));
    const third = item("c", "c".repeat(100));
    const budget = estimateItemTokens(first) + estimateItemTokens(second);

    expect(
      planTranslationBatches([first, second, third], {
        maxItems: 50,
        tokenBudget: budget,
      }).map((batch) => batch.map((entry) => entry.id)),
    ).toEqual([["a", "b"], ["c"]]);
  });

  it("sends an oversized item alone and preserves order", () => {
    const huge = item("huge", "x".repeat(5000));
    const small = item("small", "small");
    const batches = planTranslationBatches([huge, small], {
      maxItems: 50,
      tokenBudget: 500,
    });
    expect(batches.map((batch) => batch.map((entry) => entry.id))).toEqual([
      ["huge"],
      ["small"],
    ]);
  });

  it("uses the concurrency budget to create more balanced batches", () => {
    const items = Array.from({ length: 8 }, (_, index) =>
      item(String(index), "x".repeat(1000)),
    );
    const low = planTranslationBatches(items, {
      maxItems: 50,
      tokenBudget: 2000,
      concurrency: 2,
    });
    const high = planTranslationBatches(items, {
      maxItems: 50,
      tokenBudget: 2000,
      concurrency: 4,
    });

    expect(low).toHaveLength(2);
    expect(high.length).toBeGreaterThan(low.length);
    expect(high.every((batch) => batch.length > 0)).toBe(true);
  });

  it("fills concurrency with batches that meet the minimum size", () => {
    const items = Array.from({ length: 10 }, (_, index) =>
      item(String(index), "x".repeat(1700)),
    );
    const batches = planTranslationBatches(items, {
      maxItems: 50,
      tokenBudget: 2000,
      concurrency: 8,
    });
    expect(batches).toHaveLength(8);
  });

  it("merges a tiny trailing batch instead of wasting a request", () => {
    const large = item("large", "x".repeat(6200));
    const tiny = item("tiny", "y".repeat(250));
    const batches = planTranslationBatches([large, tiny], {
      maxItems: 50,
      tokenBudget: 2000,
      concurrency: 8,
    });
    expect(batches).toHaveLength(1);
  });

  it("handles an empty item list", () => {
    expect(
      planTranslationBatches([], { maxItems: 50, tokenBudget: 6000 }),
    ).toEqual([]);
  });
});
