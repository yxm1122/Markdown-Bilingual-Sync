/** 测试：评估数据集的自洽性（参考译文对参考自身应通过全部硬指标）。 */
import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  aggregateEvaluations,
  evaluateCase,
} from "../src/evaluation/metrics";

const root = process.cwd();
const manifestPath = path.join(root, "eval", "manifest.json");

interface ManifestCase {
  id: string;
  source: string;
  reference: string;
  tags?: string[];
}

interface Manifest {
  sourceLanguage: string;
  targetLanguage: string;
  glossary: Array<{ source: string; target: string }>;
  cases: ManifestCase[];
}

const manifest = JSON.parse(
  readFileSync(manifestPath, "utf8"),
) as Manifest;

describe("translation evaluation dataset", () => {
  it("contains unique cases and readable source/reference files", () => {
    expect(manifest.cases).toHaveLength(16);
    const ids = new Set<string>();
    for (const item of manifest.cases) {
      expect(item.id, "case id must be unique").not.toBe("");
      expect(ids.has(item.id)).toBe(false);
      ids.add(item.id);
      expect(
        existsSync(path.join(root, "eval", item.source)),
        `missing source for ${item.id}`,
      ).toBe(true);
      expect(
        existsSync(path.join(root, "eval", item.reference)),
        `missing reference for ${item.id}`,
      ).toBe(true);
    }
    expect(manifest.glossary.length).toBeGreaterThan(0);
  });

  it("passes every hard metric when the reference is evaluated against itself", () => {
    const evaluations = manifest.cases.map((item) => {
      const sourceText = readFileSync(
        path.join(root, "eval", item.source),
        "utf8",
      );
      const referenceText = readFileSync(
        path.join(root, "eval", item.reference),
        "utf8",
      );
      return evaluateCase({
        id: item.id,
        sourceText,
        candidateText: referenceText,
        referenceText,
        glossary: manifest.glossary,
        tags: item.tags,
        sourceLanguage: manifest.sourceLanguage,
        targetLanguage: manifest.targetLanguage,
      });
    });

    const failures = evaluations
      .filter((item) => !item.metrics.pass)
      .map((item) => ({
        id: item.id,
        issues: item.metrics.issues.map((issue) => `${issue.code}: ${issue.message}`),
      }));
    expect(failures, JSON.stringify(failures, null, 2)).toEqual([]);
    expect(
      evaluations.every((item) => item.referenceProvided),
    ).toBe(true);
    expect(
      evaluations.every(
        (item) => item.metrics.averageReferenceSimilarity === 1,
      ),
    ).toBe(true);

    const aggregate = aggregateEvaluations(evaluations);
    expect(aggregate.caseCount).toBe(16);
    expect(aggregate.passedCases).toBe(16);
    expect(aggregate.failedCases).toBe(0);
    expect(aggregate.missingBlocks).toBe(0);
    expect(aggregate.untranslatedBlocks).toBe(0);
    expect(aggregate.protectedTokenMissing).toBe(0);
    expect(aggregate.glossaryMissing).toBe(0);
    expect(aggregate.structureIssueCount).toBe(0);
  });
});
