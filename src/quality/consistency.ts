/**
 * 译后一致性检查（纯逻辑）。
 *
 * 职责：在已有译文缓存中检查两类可自动判断的问题：
 * - 源文出现了术语表条目，但机器译文没有使用对应目标词；
 * - 源文的受保护 Markdown 片段（行内代码、URL、HTML、公式、脚注引用、Alert 标记）
 *   在译文中缺失或被改写。
 *
 * 只检查机器译文；人工锁定块（human / dst 不一致）跳过，避免提示用户重译时覆盖
 * 手工成果。返回结构化 issue，由预览层本地化并展示为可一键重译的列表。
 */
import type { MarkdownIt } from "markdown-it";
import { alignDocument } from "../markdown/align";
import { parseCacheDocument } from "../markdown/anchors";
import { buildHeadingPaths } from "../markdown/headings";
import { parseMarkdownDocument } from "../markdown/segmenter";
import type { BlockKind } from "../markdown/types";
import type { GlossaryEntry } from "../translation/types";
import { findMissingGlossaryTerms } from "../util/glossaryMatch";
import {
  findMissingProtectedTokens,
  stripProtectedForGlossary,
} from "../util/protectedMarkdown";

/** 一条可定位到译文块的检查问题。 */
export type ConsistencyIssue =
  | {
      kind: "glossary";
      blockIndex: number;
      sourceLine: number;
      headingPath: string;
      blockKind: BlockKind;
      /** 源文出现但译文未遵循的术语源词。 */
      source: string;
      /** 术语表要求的目标词。 */
      target: string;
      /** 当前译文片段，供列表展示。 */
      currentText: string;
    }
  | {
      kind: "protected";
      blockIndex: number;
      sourceLine: number;
      headingPath: string;
      blockKind: BlockKind;
      /** 缺失/被改写的受保护片段，可能带 (found/expected) 计数。 */
      token: string;
      currentText: string;
    };

/** 一次一致性检查的结果。 */
export interface ConsistencyReport {
  /** 缓存是否存在；false 时 issues 为空。 */
  cacheExists: boolean;
  /** 实际检查的机器译文块数。 */
  checkedBlocks: number;
  /** 因人工锁定而跳过的块数。 */
  skippedHumanBlocks: number;
  issues: ConsistencyIssue[];
}

/** 截取当前译文的前若干个字符，避免把整块长文塞进 QuickPick。 */
function excerpt(text: string, maxLength = 180): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length > maxLength
    ? `${normalized.slice(0, maxLength)}…`
    : normalized;
}

/**
 * 检查一份原文/缓存中的机器译文。
 *
 * @param input.md 与切块、缓存解析共享的 markdown-it 实例。
 * @param input.sourceText 原文全文。
 * @param input.cacheText 译文缓存；空/缺省时 `cacheExists` 为 false。
 * @param input.glossary 已合并的术语表（全局 → 工作区 → 文件）。
 * @returns 按块顺序排列的问题列表；人工锁定块只计数、不检查。
 */
export function checkDocumentConsistency(input: {
  md: MarkdownIt;
  sourceText: string;
  cacheText?: string;
  glossary: readonly GlossaryEntry[];
}): ConsistencyReport {
  if (!input.cacheText?.trim()) {
    return {
      cacheExists: false,
      checkedBlocks: 0,
      skippedHumanBlocks: 0,
      issues: [],
    };
  }

  const source = parseMarkdownDocument(input.sourceText, input.md);
  const cache = parseCacheDocument(input.cacheText, input.md);
  const alignment = alignDocument(source.blocks, cache);
  const headingPaths = buildHeadingPaths(source.blocks);
  const issues: ConsistencyIssue[] = [];
  let checkedBlocks = 0;
  let skippedHumanBlocks = 0;

  for (const aligned of alignment.blocks) {
    if (!aligned.translatable || !aligned.cache) {
      continue;
    }
    if (aligned.status === "deleted") {
      continue;
    }
    if (aligned.human) {
      skippedHumanBlocks += 1;
      continue;
    }
    const targetText = aligned.cache.block.raw;
    if (!targetText.trim()) {
      continue;
    }
    checkedBlocks += 1;
    const base = {
      blockIndex: aligned.source.index,
      sourceLine: aligned.source.startLine + 1,
      headingPath: (headingPaths.get(aligned.source.index) ?? []).join(" › "),
      blockKind: aligned.source.kind,
      currentText: excerpt(targetText),
    };

    const glossarySource = stripProtectedForGlossary(aligned.source.raw);
    for (const entry of findMissingGlossaryTerms(
      glossarySource,
      targetText,
      input.glossary,
    )) {
      issues.push({
        ...base,
        kind: "glossary",
        source: entry.source,
        target: entry.target,
      });
    }

    for (const token of findMissingProtectedTokens(
      aligned.source.raw,
      targetText,
    )) {
      issues.push({
        ...base,
        kind: "protected",
        token,
      });
    }
  }

  return { cacheExists: true, checkedBlocks, skippedHumanBlocks, issues };
}
