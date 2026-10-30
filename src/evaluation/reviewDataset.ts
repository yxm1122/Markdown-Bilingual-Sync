/**
 * AI 批注评测数据集解析（纯逻辑）。
 *
 * 数据集由原文 + 已有译文组成，按顶层块对齐；每个用例在 manifest 中声明预期的
 * 批注问题。这里只负责把文本转成审校请求的 items，并报告块结构不一致。
 *
 * 外部依赖：Markdown 切块/标题路径、单块上下文；不依赖 vscode、不读写文件。
 */
import { buildHeadingPaths } from "../markdown/headings";
import { createMarkdownRuntime } from "../markdown/markdown";
import { parseMarkdownDocument } from "../markdown/segmenter";
import { buildBlockContext } from "../sync/blockContext";
import type {
  GlossaryEntry,
  ReviewItem,
  TranslationBrief,
} from "../translation/types";
import type { ExpectedReviewIssue } from "./reviewMetrics";

/** manifest 中的一个批注评测用例。 */
export interface ReviewEvalCase {
  id: string;
  source: string;
  target: string;
  tags?: string[];
  summary?: string;
  brief?: TranslationBrief;
  glossary?: GlossaryEntry[];
  expected: ExpectedReviewIssue[];
}

/** 批注评测 manifest。 */
export interface ReviewEvalManifest {
  sourceLanguage: string;
  targetLanguage: string;
  outputLanguage?: string;
  summary?: string;
  brief?: TranslationBrief;
  glossary?: GlossaryEntry[];
  cases: ReviewEvalCase[];
}

export interface ReviewCaseContent {
  items: ReviewItem[];
  blockTexts: Record<string, { sourceText: string; targetText: string }>;
  issues: string[];
}

/**
 * 把原文和已有译文按顶层块对齐，生成审校 items。
 *
 * 原文和译文必须拥有相同数量、相同类型的正文块；不满足时只生成可对齐的部分，
 * 同时返回 issue 供调用方把该用例标记为无效，避免指标悄悄错位。
 */
export function buildReviewCaseContent(
  sourceText: string,
  targetText: string,
): ReviewCaseContent {
  const md = createMarkdownRuntime();
  const source = parseMarkdownDocument(sourceText, md);
  const target = parseMarkdownDocument(targetText, md);
  const issues: string[] = [];
  if (Boolean(source.frontmatter) !== Boolean(target.frontmatter)) {
    issues.push("source and target frontmatter presence differ");
  }
  if (source.blocks.length !== target.blocks.length) {
    issues.push(
      `source has ${source.blocks.length} body blocks, target has ${target.blocks.length}`,
    );
  }
  const headingPaths = buildHeadingPaths(source.blocks);
  const items: ReviewItem[] = [];
  const blockTexts: Record<
    string,
    { sourceText: string; targetText: string }
  > = {};

  for (const block of source.blocks) {
    const counterpart = target.blocks[block.index];
    if (!counterpart) {
      issues.push(`target is missing block ${block.index + 1}`);
      continue;
    }
    if (counterpart.kind !== block.kind) {
      issues.push(
        `block ${block.index + 1} kind differs: ${block.kind} vs ${counterpart.kind}`,
      );
      continue;
    }
    if (!block.translatable) {
      continue;
    }
    const id = `b${block.index + 1}`;
    const context = buildBlockContext({
      blocks: source.blocks,
      index: block.index,
      itemText: block.raw,
      textOf: (item) => item.raw,
    });
    items.push({
      id,
      kind: block.kind,
      headingPath: headingPaths.get(block.index) ?? [],
      sourceText: block.raw,
      targetText: counterpart.raw,
      ...(context ? { context } : {}),
    });
    blockTexts[id] = {
      sourceText: block.raw,
      targetText: counterpart.raw,
    };
  }

  return { items, blockTexts, issues };
}
