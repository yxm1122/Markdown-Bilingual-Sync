/**
 * 单块请求的只读邻块上下文（sync/blockContext）。
 *
 * 单块重译/回译只有目标块本身，短标题或短段落容易丢失局部语义。这里从同一
 * section 取少量邻块作为只读上下文：标题优先取后一块正文，其他块取前后各一块；
 * 大块或超出 token 上限时不加，避免上下文挤占正文预算。
 */
import { buildSectionIds } from "../markdown/headings";
import type { MarkdownBlock } from "../markdown/types";
import { estimateTokenCount } from "../translation/batching";
import type {
  TranslationContext,
  TranslationContextBlock,
} from "../translation/types";

/** 单个上下文请求的软上限；provider 还会把它计入批预算。 */
export const MAX_CONTEXT_TOKENS = 600;

export interface BlockContextInput {
  /** 文档的全部顶层块。 */
  blocks: readonly MarkdownBlock[];
  /** 目标块索引。 */
  index: number;
  /** 目标块正文，用于判断是否为大块。 */
  itemText: string;
  /** 取邻块文本；返回 undefined 表示该块没有可用上下文（如回译时缺少译文）。 */
  textOf: (block: MarkdownBlock) => string | undefined;
  maxTokens?: number;
}

function contextBlock(
  block: MarkdownBlock,
  text: string | undefined,
): TranslationContextBlock | undefined {
  const trimmed = text?.trim();
  return trimmed ? { kind: block.kind, text: trimmed } : undefined;
}

/** 构造单块请求的上下文；没有可用邻块或目标块过大时返回 undefined。纯函数。 */
export function buildBlockContext(
  input: BlockContextInput,
): TranslationContext | undefined {
  const maxTokens = input.maxTokens ?? MAX_CONTEXT_TOKENS;
  if (estimateTokenCount(input.itemText) > maxTokens) {
    return undefined;
  }
  const target = input.blocks[input.index];
  if (!target) {
    return undefined;
  }
  const sectionIds = buildSectionIds(input.blocks);
  const sectionId = sectionIds.get(input.index);
  if (!sectionId) {
    return undefined;
  }
  const candidates: Array<{
    side: "before" | "after";
    block: TranslationContextBlock;
  }> = [];

  const collectForward = (limit: number): void => {
    for (
      let index = input.index + 1;
      index < input.blocks.length && sectionIds.get(index) === sectionId;
      index += 1
    ) {
      const block = input.blocks[index];
      if (block.kind === "heading") {
        break;
      }
      const candidate = contextBlock(block, input.textOf(block));
      if (!candidate) {
        continue;
      }
      candidates.push({ side: "after", block: candidate });
      if (
        candidates.filter((entry) => entry.side === "after").length >= limit
      ) {
        break;
      }
    }
  };

  if (target.kind === "heading") {
    // 标题本身通常很短，后一块正文最能说明它指什么。
    collectForward(1);
  } else {
    for (
      let index = input.index - 1;
      index >= 0 && sectionIds.get(index) === sectionId;
      index -= 1
    ) {
      const block = input.blocks[index];
      const candidate = contextBlock(block, input.textOf(block));
      if (!candidate) {
        continue;
      }
      candidates.push({ side: "before", block: candidate });
      break;
    }
    collectForward(1);
  }

  const context: TranslationContext = {};
  let used = 0;
  for (const candidate of candidates) {
    const cost = estimateTokenCount(candidate.block.text) + 16;
    if (used + cost > maxTokens) {
      continue;
    }
    used += cost;
    const list =
      candidate.side === "before"
        ? (context.before ??= [])
        : (context.after ??= []);
    list.push(candidate.block);
  }
  return context.before?.length || context.after?.length
    ? context
    : undefined;
}
