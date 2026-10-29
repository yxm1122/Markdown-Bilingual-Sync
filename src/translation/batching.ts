/**
 * 翻译批次规划（translation/batching）
 *
 * 职责：在保持输入顺序的前提下，把待翻译块切成满足“块数上限 + token 预算”的批次；
 * 并发 > 1 时尽量把总量均衡到足够多的批次，避免一个超大批次拖慢整体。
 *
 * 关键不变量：
 * - 所有批次按输入顺序连续切分，拼接后必须等于原 items（不丢、不重、不乱序）；
 * - 单个块即使超过 token 预算也会独占一批（无法再切），调用方需自行处理超长块；
 * - 返回的批次数可能少于请求的并发度（块太小或不可再分时），这是有意的。
 *
 * 外部依赖：仅 types 的 TranslationItem；纯函数、无 I/O、无随机性。
 *
 * 安全边界：token 数是启发式估算（CJK 约 1.1 token/字，其他约 1/3.5），
 * 只用于控制请求大小，不用于计费或安全判断。
 */
import { translationBriefText } from "./types";
import type {
  TranslationAnnotationInput,
  TranslationBrief,
  TranslationContext,
  TranslationItem,
} from "./types";

/** 分批参数；数值会经 normalizeOptions 取整并裁剪。 */
export interface TranslationBatchOptions {
  /** 单批最大块数（至少 1）。 */
  maxItems: number;
  /** 单批 token 预算（至少 100）。 */
  tokenBudget: number;
  /** 期望的并行度；<=1 时走简单贪心，不追求批次均衡。 */
  concurrency?: number;
  /** 每批固定上下文（全文摘要等）的估算 token；会从每批预算中扣除。 */
  contextTokens?: number;
}

const ITEM_OVERHEAD_TOKENS = 24;
const MIN_BATCH_RATIO = 0.25;
const MIN_BATCH_TOKENS_FLOOR = 200;

// ---- token 估算 ----

/**
 * 估算文本 token 数：CJK/韩文等宽字符按 1.1 token/字，其余按 1/3.5 token/字符，
 * 向上取整。按 Unicode 码点遍历，代理对计为一个字符。纯函数。
 */
export function estimateTokenCount(text: string): number {
  let wide = 0;
  let other = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (
      (code >= 0x1100 && code <= 0x11ff) ||
      (code >= 0x2e80 && code <= 0x9fff) ||
      (code >= 0xac00 && code <= 0xd7af) ||
      (code >= 0xf900 && code <= 0xfaff)
    ) {
      wide += 1;
    } else {
      other += 1;
    }
  }
  return Math.ceil(wide * 1.1 + other / 3.5);
}

/**
 * 估算单块成本：固定开销（JSON 字段/引号等）+ 正文 + 标题路径 + 该块的批注。
 * 纯函数，结果仅用于分批，不保证与真实分词器一致。
 */
export function estimateItemTokens(item: TranslationItem): number {
  return (
    ITEM_OVERHEAD_TOKENS +
    estimateTokenCount(item.text) +
    estimateTokenCount(item.headingPath.join(" > ")) +
    (item.reference
      ? estimateTokenCount(item.reference.text) + 12
      : 0) +
    estimateTranslationAnnotationTokens(item.annotations)
  );
}

/** 估算每批固定上下文（全文摘要）的 token；无摘要时为 0。纯函数。 */
export function estimateSummaryContextTokens(summary?: string): number {
  return summary?.trim() ? estimateTokenCount(summary) + 24 : 0;
}

/** 估算文档简报额外字段的 token；无内容时为 0。纯函数。 */
export function estimateTranslationBriefTokens(
  brief?: TranslationBrief,
): number {
  const text = translationBriefText(brief);
  return text ? estimateTokenCount(text) + 64 : 0;
}

/** 估算只读邻块上下文的 token；无内容时为 0。纯函数。 */
export function estimateTranslationContextTokens(
  context?: TranslationContext,
): number {
  if (!context) {
    return 0;
  }
  const text = [...(context.before ?? []), ...(context.after ?? [])]
    .map((block) => block.text.trim())
    .filter(Boolean)
    .join("\n");
  return text ? estimateTokenCount(text) + 32 : 0;
}

/** 估算用户批注指令的 token；无内容时为 0。纯函数。 */
export function estimateTranslationAnnotationTokens(
  annotations: readonly TranslationAnnotationInput[] | undefined,
): number {
  if (!annotations || annotations.length === 0) {
    return 0;
  }
  const text = annotations
    .map((annotation) => annotation.text.trim())
    .filter(Boolean)
    .join("\n");
  return text ? estimateTokenCount(text) + 32 : 0;
}

/** 规范化分批参数：取整并保证下界，非法数值回退到默认值。纯函数。 */
function normalizeOptions(options: TranslationBatchOptions): {
  maxItems: number;
  tokenBudget: number;
  concurrency: number;
  contextTokens: number;
} {
  const maxItems = Number.isFinite(options.maxItems)
    ? Math.max(1, Math.floor(options.maxItems))
    : 1;
  const tokenBudget = Number.isFinite(options.tokenBudget)
    ? Math.max(100, Math.floor(options.tokenBudget))
    : 2_000;
  const concurrency = Number.isFinite(options.concurrency)
    ? Math.max(1, Math.floor(options.concurrency ?? 1))
    : 1;
  const contextTokens = Number.isFinite(options.contextTokens)
    ? Math.max(0, Math.floor(options.contextTokens ?? 0))
    : 0;
  return { maxItems, tokenBudget, concurrency, contextTokens };
}

// ---- 基础贪心打包 ----

/**
 * 顺序贪心：累计块数或 token 超过上限就落一批，保证输出连续且顺序不变。
 * 单块超过 limit 时仍会独占一批（可能超预算，但不会丢块）。纯函数。
 */
function greedyPack(
  items: readonly TranslationItem[],
  estimates: readonly number[],
  maxItems: number,
  limit: number,
): TranslationItem[][] {
  const batches: TranslationItem[][] = [];
  let current: TranslationItem[] = [];
  let currentTokens = 0;

  const flush = () => {
    if (current.length > 0) {
      batches.push(current);
      current = [];
      currentTokens = 0;
    }
  };

  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    const tokens = estimates[index];
    if (current.length > 0) {
      if (current.length >= maxItems || currentTokens + tokens > limit) {
        flush();
      }
    }
    current.push(item);
    currentTokens += tokens;
  }
  flush();
  return batches;
}

/** 计算一批的估算 token 总和；按对象引用查表，缺失按 0 计。纯函数。 */
function batchTokens(
  batch: readonly TranslationItem[],
  estimates: ReadonlyMap<TranslationItem, number>,
): number {
  let total = 0;
  for (const item of batch) {
    total += estimates.get(item) ?? 0;
  }
  return total;
}

/**
 * 尝试把一批按顺序一分为二，选左右 token 最接近且两边都不低于 minimumTokens 的切点。
 * 批太小（<2）或过大（> maxItems*2）时放弃。返回 undefined 表示不可再分。纯函数。
 */
function splitBatch(
  batch: readonly TranslationItem[],
  estimates: ReadonlyMap<TranslationItem, number>,
  maxItems: number,
  minimumTokens: number,
): [TranslationItem[], TranslationItem[]] | undefined {
  if (batch.length < 2 || batch.length > maxItems * 2) {
    return undefined;
  }
  let total = 0;
  for (const item of batch) {
    total += estimates.get(item) ?? 0;
  }
  let leftTokens = 0;
  let best: [TranslationItem[], TranslationItem[]] | undefined;
  let bestScore = Number.POSITIVE_INFINITY;
  for (let index = 1; index < batch.length; index += 1) {
    leftTokens += estimates.get(batch[index - 1]) ?? 0;
    const rightTokens = total - leftTokens;
    if (
      leftTokens < minimumTokens ||
      rightTokens < minimumTokens ||
      index > maxItems ||
      batch.length - index > maxItems
    ) {
      continue;
    }
    const score = Math.abs(leftTokens - rightTokens);
    if (score < bestScore) {
      bestScore = score;
      best = [batch.slice(0, index), batch.slice(index)];
    }
  }
  return best;
}

/**
 * 合并相邻的“小批次”：任一边低于 minimumTokens 且合并后不超块数/token 上限就合并；
 * 最后再尝试把队尾小批并入前一批。保持顺序与不超预算。纯函数。
 */
function mergeSmallBatches(
  batches: TranslationItem[][],
  estimates: ReadonlyMap<TranslationItem, number>,
  maxItems: number,
  tokenBudget: number,
  minimumTokens: number,
): TranslationItem[][] {
  const merged: TranslationItem[][] = [];
  for (const batch of batches) {
    const previous = merged[merged.length - 1];
    if (previous) {
      const previousTokens = batchTokens(previous, estimates);
      const currentTokens = batchTokens(batch, estimates);
      if (
        (previousTokens < minimumTokens || currentTokens < minimumTokens) &&
        previous.length + batch.length <= maxItems &&
        previousTokens + currentTokens <= tokenBudget
      ) {
        merged[merged.length - 1] = [...previous, ...batch];
        continue;
      }
    }
    merged.push([...batch]);
  }
  if (merged.length > 1) {
    const last = merged[merged.length - 1];
    const previous = merged[merged.length - 2];
    const lastTokens = batchTokens(last, estimates);
    const previousTokens = batchTokens(previous, estimates);
    if (
      lastTokens < minimumTokens &&
      previous.length + last.length <= maxItems &&
      previousTokens + lastTokens <= tokenBudget
    ) {
      merged.splice(merged.length - 2, 2, [...previous, ...last]);
    }
  }
  return merged;
}

// ---- 均衡分批（并发 > 1） ----

/**
 * 均衡打包：
 * 1) 先按预算贪心得到基线批次数，并结合块数/并发度算出“期望批次数”；
 * 2) 二分搜索最小的 token 上限，使批次数不超过期望值；
 * 3) 若仍不足，则反复把最合适的大批一分为二；
 * 4) 最后合并过小批次，避免并发槽位被碎片占满。
 * 所有步骤都保持顺序且不丢块。纯函数。
 */
function balancedPack(
  items: readonly TranslationItem[],
  estimates: readonly number[],
  options: { maxItems: number; tokenBudget: number; concurrency: number },
): TranslationItem[][] {
  const { maxItems, tokenBudget, concurrency } = options;
  // “小批”阈值：预算的 25%，且不低于 200 token。低于它的批次不值得独占一个并发槽。
  const minimumTokens = Math.max(
    MIN_BATCH_TOKENS_FLOOR,
    Math.floor(tokenBudget * MIN_BATCH_RATIO),
  );
  const estimatesByItem = new Map<TranslationItem, number>();
  for (let index = 0; index < items.length; index += 1) {
    estimatesByItem.set(items[index], estimates[index]);
  }
  // 期望批次数：至少要覆盖预算切分结果、块数上限切分结果，以及“每个并发槽
  // 都能拿到一个不小于 minimumTokens 的批次”三者中的最大值。
  const totalTokens = estimates.reduce((sum, value) => sum + value, 0);
  const budgetBatches = greedyPack(
    items,
    estimates,
    maxItems,
    tokenBudget,
  ).length;
  const itemLimitBatches = Math.ceil(items.length / maxItems);
  const usefulConcurrentBatches = Math.min(
    concurrency,
    items.length,
    Math.max(1, Math.floor(totalTokens / minimumTokens)),
  );
  const desiredBatches = Math.min(
    items.length,
    Math.max(
      1,
      budgetBatches,
      itemLimitBatches,
      usefulConcurrentBatches,
    ),
  );

  // 二分搜索“能产生不超过 desiredBatches 批的最小 token 上限”：
  // 上限越小批次越多；上限为 1 时每块一批（最细），为 max(单项, 预算) 时最粗。

  const countWithLimit = (limit: number): number =>
    greedyPack(items, estimates, maxItems, limit).length;

  let low = 1;
  let high = estimates.reduce(
    (maximum, value) => Math.max(maximum, value),
    tokenBudget,
  );
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (countWithLimit(middle) <= desiredBatches) {
      high = middle;
    } else {
      low = middle + 1;
    }
  }

  // 二分结果可能仍少于期望批次数（受 maxItems/最小批限制），继续按顺序二分最大的可切批次。
  let batches = greedyPack(items, estimates, maxItems, low);
  while (batches.length < desiredBatches) {
    let splitIndex = -1;
    let splitParts:
      | [TranslationItem[], TranslationItem[]]
      | undefined;
    for (let index = 0; index < batches.length; index += 1) {
      const parts = splitBatch(
        batches[index],
        estimatesByItem,
        maxItems,
        minimumTokens,
      );
      if (parts) {
        splitIndex = index;
        splitParts = parts;
        break;
      }
    }
    if (!splitParts || splitIndex < 0) {
      break;
    }
    batches.splice(splitIndex, 1, splitParts[0], splitParts[1]);
  }

  return mergeSmallBatches(
    batches,
    estimatesByItem,
    maxItems,
    tokenBudget,
    minimumTokens,
  );
}

// ---- 文档 / 小节感知分批 ----

/**
 * 一个不可再优先切分的打包单元：同一文档、同一小节的连续块。
 * 小节超过块数或 token 上限时会先被拆成多个同 key 的 unit。
 */
interface BatchingUnit {
  items: TranslationItem[];
  tokens: number;
  documentId: string;
  sectionId: string;
}

/** 取块的文档/小节 key；未提供时回退为空串，让旧调用方保持原有行为。 */
function unitKey(item: TranslationItem): {
  documentId: string;
  sectionId: string;
} {
  return {
    documentId: item.documentId ?? "",
    sectionId: item.sectionId ?? "",
  };
}

/** 计算一组块的估算 token 总和。纯函数。 */
function sumTokens(
  items: readonly TranslationItem[],
  estimates: ReadonlyMap<TranslationItem, number>,
): number {
  let total = 0;
  for (const item of items) {
    total += estimates.get(item) ?? 0;
  }
  return total;
}

/**
 * 把块按文档/小节分组为 unit；超限的小节再用 greedyPack 内部拆分。
 * 分组只按输入顺序切连续段，保证输出顺序与原文一致。纯函数。
 */
function buildUnits(
  items: readonly TranslationItem[],
  estimates: ReadonlyMap<TranslationItem, number>,
  maxItems: number,
  tokenBudget: number,
): BatchingUnit[] {
  const units: BatchingUnit[] = [];
  let start = 0;
  while (start < items.length) {
    const key = unitKey(items[start]);
    let end = start + 1;
    while (end < items.length) {
      const next = unitKey(items[end]);
      if (
        next.documentId !== key.documentId ||
        next.sectionId !== key.sectionId
      ) {
        break;
      }
      end += 1;
    }
    const sectionItems = items.slice(start, end);
    const tokens = sumTokens(sectionItems, estimates);
    if (sectionItems.length <= maxItems && tokens <= tokenBudget) {
      units.push({ items: sectionItems, tokens, ...key });
    } else {
      const sectionEstimates = sectionItems.map(
        (item) => estimates.get(item) ?? 0,
      );
      for (const part of greedyPack(
        sectionItems,
        sectionEstimates,
        maxItems,
        tokenBudget,
      )) {
        units.push({
          items: part,
          tokens: sumTokens(part, estimates),
          ...key,
        });
      }
    }
    start = end;
  }
  return units;
}

/**
 * 把 unit 顺序装入批次：文档变化、块数或 token 超限时落批。
 * 同一文档的相邻小节可以共享一批，但绝不会跨文档混批。纯函数。
 */
function packUnits(
  units: readonly BatchingUnit[],
  maxItems: number,
  tokenBudget: number,
): BatchingUnit[][] {
  const batches: BatchingUnit[][] = [];
  let current: BatchingUnit[] = [];
  let count = 0;
  let tokens = 0;
  let documentId: string | undefined;

  const flush = () => {
    if (current.length > 0) {
      batches.push(current);
      current = [];
      count = 0;
      tokens = 0;
      documentId = undefined;
    }
  };

  for (const unit of units) {
    if (current.length > 0) {
      if (
        documentId !== unit.documentId ||
        count + unit.items.length > maxItems ||
        tokens + unit.tokens > tokenBudget
      ) {
        flush();
      }
    }
    if (current.length === 0) {
      documentId = unit.documentId;
    }
    current.push(unit);
    count += unit.items.length;
    tokens += unit.tokens;
  }
  flush();
  return batches;
}

/**
 * 在 unit 边界找一个均衡切点。优先切在不同小节之间；没有跨小节边界时
 * 允许切在同小节的多个 unit 之间（通常来自超大小节的内部拆分）。纯函数。
 */
function splitUnitBatch(
  batch: readonly BatchingUnit[],
  maxItems: number,
  minimumTokens: number,
): [BatchingUnit[], BatchingUnit[]] | undefined {
  if (batch.length < 2) {
    return undefined;
  }
  const totalTokens = batch.reduce((sum, unit) => sum + unit.tokens, 0);
  const totalItems = batch.reduce((sum, unit) => sum + unit.items.length, 0);
  let leftTokens = 0;
  let leftItems = 0;
  let crossSection: [BatchingUnit[], BatchingUnit[]] | undefined;
  let crossScore = Number.POSITIVE_INFINITY;
  let sameSection: [BatchingUnit[], BatchingUnit[]] | undefined;
  let sameScore = Number.POSITIVE_INFINITY;

  for (let index = 1; index < batch.length; index += 1) {
    leftTokens += batch[index - 1].tokens;
    leftItems += batch[index - 1].items.length;
    const rightTokens = totalTokens - leftTokens;
    const rightItems = totalItems - leftItems;
    if (
      leftTokens < minimumTokens ||
      rightTokens < minimumTokens ||
      leftItems > maxItems ||
      rightItems > maxItems
    ) {
      continue;
    }
    const parts: [BatchingUnit[], BatchingUnit[]] = [
      batch.slice(0, index),
      batch.slice(index),
    ];
    const score = Math.abs(leftTokens - rightTokens);
    const previous = batch[index - 1];
    const next = batch[index];
    if (
      previous.documentId === next.documentId &&
      previous.sectionId === next.sectionId
    ) {
      if (score < sameScore) {
        sameScore = score;
        sameSection = parts;
      }
    } else if (score < crossScore) {
      crossScore = score;
      crossSection = parts;
    }
  }
  return crossSection ?? sameSection;
}

/** 把一个超限 unit 的内部按 splitBatch 再拆成两个 unit。纯函数。 */
function splitLargeUnit(
  unit: BatchingUnit,
  estimates: ReadonlyMap<TranslationItem, number>,
  maxItems: number,
  minimumTokens: number,
): [BatchingUnit, BatchingUnit] | undefined {
  const parts = splitBatch(
    unit.items,
    estimates,
    maxItems,
    minimumTokens,
  );
  if (!parts) {
    return undefined;
  }
  return [
    {
      ...unit,
      items: parts[0],
      tokens: sumTokens(parts[0], estimates),
    },
    {
      ...unit,
      items: parts[1],
      tokens: sumTokens(parts[1], estimates),
    },
  ];
}

/** 取一批的文档 id；空批返回空串。 */
function batchDocumentId(batch: readonly TranslationItem[]): string {
  return batch[0]?.documentId ?? "";
}

/**
 * 合并相邻的小批，但只允许同一文档内合并。
 * 这是文档感知版本的 mergeSmallBatches，避免把不同文件的小文件硬塞进一批。纯函数。
 */
function mergeSmallBatchesSameDocument(
  batches: TranslationItem[][],
  estimates: ReadonlyMap<TranslationItem, number>,
  maxItems: number,
  tokenBudget: number,
  minimumTokens: number,
): TranslationItem[][] {
  const merged: TranslationItem[][] = [];
  for (const batch of batches) {
    const previous = merged[merged.length - 1];
    if (previous && batchDocumentId(previous) === batchDocumentId(batch)) {
      const previousTokens = sumTokens(previous, estimates);
      const currentTokens = sumTokens(batch, estimates);
      if (
        (previousTokens < minimumTokens || currentTokens < minimumTokens) &&
        previous.length + batch.length <= maxItems &&
        previousTokens + currentTokens <= tokenBudget
      ) {
        merged[merged.length - 1] = [...previous, ...batch];
        continue;
      }
    }
    merged.push([...batch]);
  }
  if (merged.length > 1) {
    const last = merged[merged.length - 1];
    const previous = merged[merged.length - 2];
    const lastTokens = sumTokens(last, estimates);
    const previousTokens = sumTokens(previous, estimates);
    if (
      batchDocumentId(previous) === batchDocumentId(last) &&
      lastTokens < minimumTokens &&
      previous.length + last.length <= maxItems &&
      previousTokens + lastTokens <= tokenBudget
    ) {
      merged.splice(merged.length - 2, 2, [...previous, ...last]);
    }
  }
  return merged;
}

/**
 * 文档/小节感知的均衡分批。
 *
 * 先按文档和小节组成 unit，再顺序装批；并发不足时优先在跨小节边界拆分，
 * 其次才拆大 unit 内部。这样既保留小节内的连贯性，也不会浪费并发槽位。
 */
function groupedBalancedPack(
  items: readonly TranslationItem[],
  estimates: readonly number[],
  options: { maxItems: number; tokenBudget: number; concurrency: number },
): TranslationItem[][] {
  const { maxItems, tokenBudget, concurrency } = options;
  const minimumTokens = Math.max(
    MIN_BATCH_TOKENS_FLOOR,
    Math.floor(tokenBudget * MIN_BATCH_RATIO),
  );
  const estimatesByItem = new Map<TranslationItem, number>();
  for (let index = 0; index < items.length; index += 1) {
    estimatesByItem.set(items[index], estimates[index]);
  }

  const units = buildUnits(items, estimatesByItem, maxItems, tokenBudget);
  const unitBatches = packUnits(units, maxItems, tokenBudget);
  const totalTokens = estimates.reduce((sum, value) => sum + value, 0);
  const usefulConcurrentBatches = Math.min(
    concurrency,
    items.length,
    Math.max(1, Math.floor(totalTokens / minimumTokens)),
  );
  const desiredBatches = Math.min(
    items.length,
    Math.max(
      1,
      unitBatches.length,
      Math.ceil(items.length / maxItems),
      usefulConcurrentBatches,
    ),
  );

  while (unitBatches.length < desiredBatches) {
    // 先找跨小节/unit 边界；选 token 最大的批来拆，尽快缩小最大批。
    let target = -1;
    let targetParts: [BatchingUnit[], BatchingUnit[]] | undefined;
    for (let index = 0; index < unitBatches.length; index += 1) {
      const parts = splitUnitBatch(
        unitBatches[index],
        maxItems,
        minimumTokens,
      );
      if (
        parts &&
        (target < 0 ||
          unitBatches[index].reduce((sum, unit) => sum + unit.tokens, 0) >
            unitBatches[target].reduce((sum, unit) => sum + unit.tokens, 0))
      ) {
        target = index;
        targetParts = parts;
      }
    }
    if (targetParts) {
      unitBatches.splice(target, 1, targetParts[0], targetParts[1]);
      continue;
    }

    // 没有 unit 边界可拆时，拆分最大的单个 unit（通常是一个超大章节）。
    let splitBatchIndex = -1;
    let splitUnitIndex = -1;
    let splitParts: [BatchingUnit, BatchingUnit] | undefined;
    for (let batchIndex = 0; batchIndex < unitBatches.length; batchIndex += 1) {
      const batch = unitBatches[batchIndex];
      for (let unitIndex = 0; unitIndex < batch.length; unitIndex += 1) {
        const unit = batch[unitIndex];
        const parts = splitLargeUnit(
          unit,
          estimatesByItem,
          maxItems,
          minimumTokens,
        );
        if (
          parts &&
          (splitBatchIndex < 0 ||
            unit.tokens > unitBatches[splitBatchIndex][splitUnitIndex].tokens)
        ) {
          splitBatchIndex = batchIndex;
          splitUnitIndex = unitIndex;
          splitParts = parts;
        }
      }
    }
    if (splitBatchIndex < 0 || !splitParts) {
      break;
    }
    const [left, right] = splitParts;
    const batch = unitBatches[splitBatchIndex];
    // 只拆目标 unit，保留同批其他 unit；直接用 [left],[right] 替换整批会丢块。
    unitBatches.splice(
      splitBatchIndex,
      1,
      [...batch.slice(0, splitUnitIndex), left],
      [right, ...batch.slice(splitUnitIndex + 1)],
    );
  }

  const itemBatches = unitBatches.map((batch) =>
    batch.flatMap((unit) => unit.items),
  );
  return mergeSmallBatchesSameDocument(
    itemBatches,
    estimatesByItem,
    maxItems,
    tokenBudget,
    minimumTokens,
  );
}

// ---- 入口 ----

/**
 * 规划批次。空输入返回空数组；并发 <=1 时只做顺序贪心（不额外均衡），
 * 否则走 balancedPack。返回的批次按原顺序连续覆盖全部块。
 * @param items 待翻译块（只读，不修改）。
 * @param rawOptions 块数/token 预算/并发度；非法值会被裁剪或回退默认。纯函数。
 */
export function planTranslationBatches(
  items: readonly TranslationItem[],
  rawOptions: TranslationBatchOptions,
): TranslationItem[][] {
  if (items.length === 0) {
    return [];
  }
  const options = normalizeOptions(rawOptions);
  // 摘要等固定上下文会随每个请求发送，因此从每批可用预算中扣除；
  // 即使上下文本身超过预算，仍允许单块成批，不能丢块。
  const effectiveBudget = Math.max(1, options.tokenBudget - options.contextTokens);
  const effective = { ...options, tokenBudget: effectiveBudget };
  const estimates = items.map(estimateItemTokens);
  const grouped = items.some(
    (item) => item.documentId !== undefined || item.sectionId !== undefined,
  );
  if (grouped) {
    if (effective.concurrency <= 1) {
      const estimatesByItem = new Map<TranslationItem, number>();
      for (let index = 0; index < items.length; index += 1) {
        estimatesByItem.set(items[index], estimates[index]);
      }
      const units = buildUnits(
        items,
        estimatesByItem,
        effective.maxItems,
        effectiveBudget,
      );
      return packUnits(units, effective.maxItems, effectiveBudget).map(
        (batch) => batch.flatMap((unit) => unit.items),
      );
    }
    return groupedBalancedPack(items, estimates, effective);
  }
  if (effective.concurrency <= 1) {
    return greedyPack(items, estimates, effective.maxItems, effectiveBudget);
  }
  return balancedPack(items, estimates, effective);
}
