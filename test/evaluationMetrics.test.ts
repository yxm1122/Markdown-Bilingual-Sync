/** 测试：翻译质量自动指标与聚合。 */
import { describe, expect, it } from "vitest";
import {
  aggregateEvaluations,
  evaluateCase,
} from "../src/evaluation/metrics";

function evaluate(
  sourceText: string,
  candidateText: string,
  options: {
    referenceText?: string;
    glossary?: Array<{ source: string; target: string }>;
  } = {},
) {
  return evaluateCase({
    id: "case",
    sourceText,
    candidateText,
    ...options,
  });
}

describe("translation evaluation metrics", () => {
  it("passes a complete translation with protected tokens and glossary", () => {
    const source = "# Heading\n\nA block with `code` and [link](https://example.com).\n";
    const translation =
      "# 标题\n\n一个包含 `code` 和 [链接](https://example.com) 的块。\n";
    const result = evaluate(source, translation, {
      referenceText: translation,
      glossary: [{ source: "block", target: "块" }],
    });

    expect(result.metrics.pass).toBe(true);
    expect(result.metrics.protectedTokenTotal).toBe(2);
    expect(result.metrics.protectedTokenMissing).toEqual([]);
    expect(result.metrics.glossaryChecks).toBe(1);
    expect(result.metrics.glossaryAdhered).toBe(1);
    expect(result.metrics.averageReferenceSimilarity).toBe(1);
    expect(result.referenceProvided).toBe(true);
  });

  it("reports missing and extra blocks", () => {
    const missing = evaluate("# Heading\n\nParagraph.\n", "# 标题\n");
    expect(missing.metrics.pass).toBe(false);
    expect(missing.metrics.missingBlocks).toBe(1);
    expect(missing.metrics.issues.some((issue) => issue.code === "candidate.missing")).toBe(true);

    const extra = evaluate("Paragraph.\n", "段落。\n\nExtra block.\n");
    expect(extra.metrics.pass).toBe(false);
    expect(extra.metrics.extraBlocks).toBe(1);
    expect(extra.metrics.issues.some((issue) => issue.code === "candidate.extra")).toBe(true);
  });

  it("flags a block that still contains the source text", () => {
    const source =
      "This is a sufficiently long English paragraph that should be translated.";
    const result = evaluate(source, source);
    expect(result.metrics.pass).toBe(false);
    expect(result.metrics.untranslatedBlocks).toBe(1);
    expect(
      result.metrics.issues.some(
        (issue) => issue.code === "candidate.untranslated",
      ),
    ).toBe(true);
  });

  it("flags high source-word retention even when extra words hide exact echoes", () => {
    const source =
      "This is a long technical paragraph with many English words that should be translated for the reader.";
    const candidate =
      "This is a long technical paragraph with many English words that should be translated for the reader, honestly.";
    const result = evaluate(source, candidate);
    expect(result.metrics.pass).toBe(false);
    expect(result.metrics.untranslatedBlocks).toBe(1);
    expect(result.metrics.blockResults[0]?.sourceWordRetention).toBe(1);
    expect(
      result.metrics.issues.some(
        (issue) => issue.code === "candidate.sourceEcho",
      ),
    ).toBe(true);
  });

  it("flags missing inline code and link destinations", () => {
    const source = "Use `npm ci` and see [docs](https://example.com/docs).";
    const result = evaluate(source, "使用 npm ci 并查看文档。");
    expect(result.metrics.pass).toBe(false);
    expect(result.metrics.protectedTokenMissing).toHaveLength(2);
    expect(
      result.metrics.issues.some(
        (issue) => issue.code === "candidate.protectedTokenMissing",
      ),
    ).toBe(true);
  });

  it("does not treat a translated link title as a protected token", () => {
    const source = '[link](https://example.com/docs "Documentation")';
    const candidate = '[链接](https://example.com/docs "文档")';
    const result = evaluate(source, candidate);
    expect(result.metrics.protectedTokenMissing).toEqual([]);
    expect(result.metrics.pass).toBe(true);
  });

  it("recognizes double-backtick code spans", () => {
    const source = "Use ``double `backticks` here`` now.";
    const candidate = "现在使用 ``double `backticks` here``。";
    const result = evaluate(source, candidate);
    expect(result.metrics.protectedTokenTotal).toBe(1);
    expect(result.metrics.protectedTokenMissing).toEqual([]);
    expect(result.metrics.pass).toBe(true);
  });

  it("checks glossary adherence per block", () => {
    const result = evaluate("The block is cached.", "该内容已缓存。", {
      glossary: [
        { source: "block", target: "块" },
        { source: "cache", target: "缓存" },
      ],
    });
    expect(result.metrics.glossaryChecks).toBe(2);
    expect(result.metrics.glossaryAdhered).toBe(1);
    expect(result.metrics.glossaryMissing).toContain(
      "block 1: block -> 块",
    );
    expect(result.metrics.pass).toBe(false);
  });

  it("flags list structure drift", () => {
    const source = "- one\n- two\n- three\n";
    const result = evaluate(source, "- 一\n- 二\n");
    expect(result.metrics.pass).toBe(false);
    expect(result.metrics.structureIssueCount).toBe(1);
    expect(
      result.metrics.issues.some((issue) => issue.code === "candidate.structure"),
    ).toBe(true);
  });

  it("flags flipped task checkboxes and changed table alignment", () => {
    const task = evaluate("- [x] One\n- [ ] Two\n", "- [ ] 一\n- [ ] 二\n");
    expect(task.metrics.pass).toBe(false);
    expect(task.metrics.structureIssueCount).toBe(1);

    const tableSource = "| A | B |\n| :--- | ---: |\n| 1 | 2 |\n";
    const tableCandidate = "| 甲 | 乙 |\n| --- | --- |\n| 1 | 2 |\n";
    const table = evaluate(tableSource, tableCandidate);
    expect(table.metrics.pass).toBe(false);
    expect(table.metrics.structureIssueCount).toBe(1);
  });

  it("requires duplicate protected tokens to appear the same number of times", () => {
    const source =
      "[A](https://example.com) and [B](https://example.com).\n";
    const candidate = "[甲](https://example.com) 和乙。\n";
    const result = evaluate(source, candidate);
    expect(result.metrics.pass).toBe(false);
    expect(
      result.metrics.protectedTokenMissing.some((token) =>
        token.includes("https://example.com (1/2)"),
      ),
    ).toBe(true);
  });

  it("does not flag a proper-noun-heavy but translated paragraph as source echo", () => {
    const source =
      "OpenAI Anthropic DeepMind Mistral Cohere Perplexity Groq Together Replicate HuggingFace provide models.";
    const candidate =
      "OpenAI、Anthropic、DeepMind、Mistral、Cohere、Perplexity、Groq、Together、Replicate 和 HuggingFace 提供模型。";
    const result = evaluate(source, candidate);
    expect(result.metrics.pass).toBe(true);
    expect(result.metrics.untranslatedBlocks).toBe(0);
  });

  it("flags modified non-translatable code blocks", () => {
    const source = "```ts\nconst value = 1;\n```\n";
    const result = evaluate(
      source,
      "```ts\nconst value = 2;\n```\n",
    );
    expect(result.metrics.pass).toBe(false);
    expect(
      result.metrics.issues.some(
        (issue) => issue.code === "candidate.copyMismatch",
      ),
    ).toBe(true);
  });

  it("flags frontmatter drift", () => {
    const source = "---\ntitle: A\n---\n\nBody.\n";
    const result = evaluate(
      source,
      "---\ntitle: B\n---\n\n正文。\n",
    );
    expect(result.metrics.pass).toBe(false);
    expect(result.metrics.frontmatter.matches).toBe(false);
    expect(
      result.metrics.issues.some((issue) => issue.code === "candidate.frontmatter"),
    ).toBe(true);
  });

  it("does not treat preserved Chinese as untranslated source text", () => {
    const result = evaluate(
      "Existing Chinese 保持不变。 New English sentence should be translated.",
      "已有中文保持不变。新的英文句子应被翻译。",
    );
    expect(result.metrics.pass).toBe(true);
    expect(result.metrics.untranslatedBlocks).toBe(0);
  });

  it("treats footnote definitions as translatable prose and flags copied source", () => {
    const source =
      "A decision was recorded.[^decision]\n\n[^decision]: The decision is final.\n";
    const copied =
      "已记录一项决定。[^decision]\n\n[^decision]: The decision is final.\n";
    const result = evaluate(source, copied);
    expect(result.metrics.pass).toBe(false);
    expect(result.metrics.untranslatedBlocks).toBe(1);
    expect(result.metrics.blockResults[1]?.translatable).toBe(true);
  });

  it("flags an invalid reference structure even when the candidate is fine", () => {
    const result = evaluate("# Heading\n\nParagraph.\n", "# 标题\n\n段落。\n", {
      referenceText: "段落。\n",
    });
    expect(result.metrics.pass).toBe(false);
    expect(
      result.metrics.issues.some((issue) => issue.code === "reference.structure"),
    ).toBe(true);
  });

  it("aggregates case metrics", () => {
    const pass = evaluate("Paragraph.\n", "段落。\n");
    const fail = evaluate("Paragraph.\n", "Paragraph.\n");
    const aggregate = aggregateEvaluations([pass, fail]);
    expect(aggregate.caseCount).toBe(2);
    expect(aggregate.passedCases).toBe(1);
    expect(aggregate.failedCases).toBe(1);
    expect(aggregate.untranslatedBlocks).toBe(1);
  });
});
