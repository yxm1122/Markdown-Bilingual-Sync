/** 测试：AI 批注评测数据集的自洽性。 */
import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { buildReviewCaseContent } from "../src/evaluation/reviewDataset";
import type { ReviewEvalManifest } from "../src/evaluation/reviewDataset";

const root = process.cwd();
const manifestPath = path.join(root, "eval", "review", "manifest.json");
const manifest = JSON.parse(
  readFileSync(manifestPath, "utf8"),
) as ReviewEvalManifest;

describe("review evaluation dataset", () => {
  it("contains unique, aligned source/target cases", () => {
    expect(manifest.cases.length).toBeGreaterThanOrEqual(8);
    const ids = new Set<string>();
    for (const item of manifest.cases) {
      expect(item.id, "case id must be unique").not.toBe("");
      expect(ids.has(item.id)).toBe(false);
      ids.add(item.id);
      const sourcePath = path.join(root, "eval", "review", item.source);
      const targetPath = path.join(root, "eval", "review", item.target);
      expect(existsSync(sourcePath), `missing source for ${item.id}`).toBe(
        true,
      );
      expect(existsSync(targetPath), `missing target for ${item.id}`).toBe(
        true,
      );
      const content = buildReviewCaseContent(
        readFileSync(sourcePath, "utf8"),
        readFileSync(targetPath, "utf8"),
      );
      expect(content.issues, `${item.id}: ${content.issues.join("; ")}`).toEqual(
        [],
      );
      expect(content.items.length).toBeGreaterThan(0);
      for (const expected of item.expected) {
        if (expected.blockId !== "any") {
          expect(
            content.blockTexts[expected.blockId],
            `${item.id}: unknown block ${expected.blockId}`,
          ).toBeDefined();
        }
        expect(expected.match.length).toBeGreaterThan(0);
        if (expected.option?.mustInclude) {
          expect(expected.option.mustInclude.length).toBeGreaterThan(0);
        }
        if (expected.option?.mustIncludeAll) {
          expect(expected.option.mustIncludeAll.length).toBeGreaterThan(0);
        }
      }
    }
  });

  it("covers clean, instruction, advice, multi-option, and persistent cases", () => {
    const expected = manifest.cases.flatMap((item) => item.expected);
    const ids = new Set(manifest.cases.map((item) => item.id));
    expect(ids.has("clean-heading")).toBe(true);
    expect(ids.has("code-period")).toBe(true);
    expect(ids.has("heading-choice")).toBe(true);
    expect(manifest.cases.filter((item) => item.expected.length === 0).length).toBeGreaterThanOrEqual(3);
    expect(
      expected.filter((item) => item.option?.kind === "instruction").length,
    ).toBeGreaterThanOrEqual(3);
    expect(
      expected.filter((item) => item.option?.kind === "advice").length,
    ).toBeGreaterThanOrEqual(1);
    expect(
      expected.filter((item) => item.option?.mode === "persistent").length,
    ).toBeGreaterThanOrEqual(2);
    expect(
      expected.filter((item) => item.option?.mode === "once").length,
    ).toBeGreaterThanOrEqual(3);
    expect(
      expected.some((item) => (item.option?.minCount ?? 1) >= 2),
    ).toBe(true);
    expect(
      expected.some((item) => item.option?.maxChars !== undefined),
    ).toBe(true);
  });

  it("declares a glossary for the cache cases", () => {
    expect(manifest.glossary).toContainEqual({
      source: "cache",
      target: "缓存",
    });
  });
});
