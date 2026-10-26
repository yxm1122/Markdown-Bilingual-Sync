/** 测试：按 token 预算与并发约束的动态分批。 */
import { describe, expect, it } from "vitest";
import {
  estimateItemTokens,
  estimateSummaryContextTokens,
  estimateTokenCount,
  planTranslationBatches,
} from "../src/translation/batching";
import type { TranslationItem } from "../src/translation/types";

function item(id: string, text: string): TranslationItem {
  return { id, text, kind: "paragraph", headingPath: [] };
}

function grouped(
  id: string,
  text: string,
  documentId: string,
  sectionId: string,
): TranslationItem {
  return { ...item(id, text), documentId, sectionId };
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

  it("never mixes blocks from different documents in one batch", () => {
    const items = [
      grouped("a1", "x".repeat(100), "doc-a", "s1"),
      grouped("a2", "x".repeat(100), "doc-a", "s1"),
      grouped("b1", "x".repeat(100), "doc-b", "s1"),
      grouped("b2", "x".repeat(100), "doc-b", "s1"),
    ];
    const batches = planTranslationBatches(items, {
      maxItems: 50,
      tokenBudget: 100_000,
      concurrency: 1,
    });
    expect(batches.map((batch) => batch.map((entry) => entry.id))).toEqual([
      ["a1", "a2"],
      ["b1", "b2"],
    ]);
  });

  it("keeps a section whole and packs adjacent small sections together", () => {
    const items = [
      grouped("a1", "x".repeat(100), "doc", "s1"),
      grouped("a2", "x".repeat(100), "doc", "s1"),
      grouped("b1", "x".repeat(100), "doc", "s2"),
      grouped("b2", "x".repeat(100), "doc", "s2"),
      grouped("c1", "x".repeat(100), "doc", "s3"),
      grouped("c2", "x".repeat(100), "doc", "s3"),
    ];
    const wide = planTranslationBatches(items, {
      maxItems: 50,
      tokenBudget: 100_000,
      concurrency: 1,
    });
    expect(wide).toHaveLength(1);

    const narrow = planTranslationBatches(items, {
      maxItems: 3,
      tokenBudget: 100_000,
      concurrency: 1,
    });
    expect(narrow.map((batch) => batch.map((entry) => entry.id))).toEqual([
      ["a1", "a2"],
      ["b1", "b2"],
      ["c1", "c2"],
    ]);
  });

  it("splits an oversized section internally without leaving its document", () => {
    const items = Array.from({ length: 6 }, (_, index) =>
      grouped(`s${index}`, "x".repeat(100), "doc", "section"),
    );
    const batches = planTranslationBatches(items, {
      maxItems: 2,
      tokenBudget: 100_000,
      concurrency: 1,
    });
    expect(batches.map((batch) => batch.map((entry) => entry.id))).toEqual([
      ["s0", "s1"],
      ["s2", "s3"],
      ["s4", "s5"],
    ]);
    expect(
      batches
        .flat()
        .every(
          (entry) =>
            entry.documentId === "doc" && entry.sectionId === "section",
        ),
    ).toBe(true);
  });

  it("uses concurrency by splitting at section boundaries", () => {
    const items = ["s1", "s2", "s3", "s4"].flatMap((section) =>
      [0, 1].map((index) =>
        grouped(`${section}-${index}`, "x".repeat(1000), "doc", section),
      ),
    );
    const batches = planTranslationBatches(items, {
      maxItems: 50,
      tokenBudget: 2000,
      concurrency: 4,
    });

    expect(batches).toHaveLength(4);
    for (const section of ["s1", "s2", "s3", "s4"]) {
      const containing = batches.filter((batch) =>
        batch.some((entry) => entry.sectionId === section),
      );
      expect(containing).toHaveLength(1);
      expect(
        containing[0].filter((entry) => entry.sectionId === section),
      ).toHaveLength(2);
    }
  });

  it("keeps every block when splitting a large unit inside a multi-unit batch", () => {
    const items = [
      ...Array.from({ length: 4 }, (_, index) =>
        grouped(`large-${index}`, "x".repeat(1000), "doc", "large"),
      ),
      grouped("small", "y".repeat(100), "doc", "small"),
    ];
    const batches = planTranslationBatches(items, {
      maxItems: 50,
      tokenBudget: 2000,
      concurrency: 4,
    });
    expect(batches.flat().map((entry) => entry.id)).toEqual(
      items.map((entry) => entry.id),
    );
  });

  it("handles an empty item list", () => {
    expect(
      planTranslationBatches([], { maxItems: 50, tokenBudget: 6000 }),
    ).toEqual([]);
  });

  it("counts reference text and summary context in the budget", () => {
    const plain = item("a", "x".repeat(1000));
    const withReference: TranslationItem = {
      ...plain,
      reference: { text: "旧译文".repeat(500), role: "previous-target" },
    };
    expect(estimateItemTokens(withReference)).toBeGreaterThan(
      estimateItemTokens(plain),
    );
    expect(estimateSummaryContextTokens(undefined)).toBe(0);
    expect(estimateSummaryContextTokens("摘要".repeat(500))).toBeGreaterThan(0);

    const items = Array.from({ length: 4 }, (_, index) =>
      item(String(index), "x".repeat(1000)),
    );
    const withoutContext = planTranslationBatches(items, {
      maxItems: 50,
      tokenBudget: 2200,
      concurrency: 1,
    });
    const withContext = planTranslationBatches(items, {
      maxItems: 50,
      tokenBudget: 2200,
      concurrency: 1,
      contextTokens: 1200,
    });
    expect(withContext.length).toBeGreaterThan(withoutContext.length);
  });
});
