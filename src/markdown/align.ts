/**
 * 原文块与缓存块的对齐与状态推导。
 *
 * 职责：先按 `hash` 做最长公共子序列（LCS）匹配精确相同的块，再在两次精确匹配之间
 * 按块类型做一次兜底 LCS，使“原文小改”或“插入/删除相邻块”时仍能复用译文；最后为
 * 每个原文块推导状态（已翻译、过期、人工、复制、删除等）。
 *
 * 关键不变量：
 * - 匹配单调递增：原文与缓存中的匹配下标都严格递增，缓存块最多使用一次；
 * - `source.index` 必须等于它在 `sourceBlocks` 中的下标（内部按下标建立映射）；
 * - 只有 `src` 与当前原文哈希一致的缓存才算“不过期”；`dst` 与实际块哈希不一致时
 *   视为人工内容，在普通同步中受保护（`retranslateAll` 目前不看该标记，是已知边界）。
 *
 * 与其他模块的关系：`sync.syncDocument` 在同步开始时以及每次生成缓存草案后调用，
 * `syncService` 用它定位单块、`previewModel` / `exportMarkdown` 用它生成状态；本模块
 * 不读写文件、不产生副作用。
 */
import type {
  AlignedBlock,
  AlignmentResult,
  AnchoredBlock,
  BlockStatus,
  CacheDocument,
  MarkdownBlock,
} from "./types";
import { tError } from "../i18n/errors";

type Pair = [number, number];

/**
 * 动态规划单元格上限（约 32 MB 的 Uint32Array）。
 * 超过后改用线性贪心匹配，避免大文档把扩展宿主内存打满。
 */
const MAX_LCS_CELLS = 8_000_000;

/**
 * 线性时间的兜底匹配：按出现顺序为每个原文值寻找缓存中“尚未用过且位于上一个匹配
 * 之后”的同值项。
 *
 * 结果是合法但不一定最优的单调匹配；用于超大文档，避免 O(n*m) 的动态规划。
 */
function greedyPairs(a: readonly string[], b: readonly string[]): Pair[] {
  const positions = new Map<string, number[]>();
  for (let j = 0; j < b.length; j += 1) {
    const list = positions.get(b[j]);
    if (list) {
      list.push(j);
    } else {
      positions.set(b[j], [j]);
    }
  }
  const cursors = new Map<string, number>();
  const pairs: Pair[] = [];
  let lastJ = -1;
  for (let i = 0; i < a.length; i += 1) {
    const list = positions.get(a[i]);
    if (!list) {
      continue;
    }
    let cursor = cursors.get(a[i]) ?? 0;
    while (cursor < list.length && list[cursor] <= lastJ) {
      cursor += 1;
    }
    if (cursor >= list.length) {
      continue;
    }
    const j = list[cursor];
    cursors.set(a[i], cursor + 1);
    pairs.push([i, j]);
    lastJ = j;
  }
  return pairs;
}

/**
 * 计算最长公共子序列的匹配下标对。
 *
 * 使用从右下角向左上角填表的 `Uint32Array`，回溯时在长度相等的情况下优先跳过原文，
 * 保证结果单调且不会重复使用缓存块。任意一边为空时返回空数组；规模超限时退回
 * `greedyPairs`。
 */
function lcsPairs(a: readonly string[], b: readonly string[]): Pair[] {
  if (a.length === 0 || b.length === 0) {
    return [];
  }
  if ((a.length + 1) * (b.length + 1) > MAX_LCS_CELLS) {
    return greedyPairs(a, b);
  }
  const width = b.length + 1;
  const dp = new Uint32Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i -= 1) {
    const row = i * width;
    const nextRow = (i + 1) * width;
    for (let j = b.length - 1; j >= 0; j -= 1) {
      if (a[i] === b[j]) {
        dp[row + j] = dp[nextRow + j + 1] + 1;
      } else {
        dp[row + j] = Math.max(dp[nextRow + j], dp[row + j + 1]);
      }
    }
  }
  const pairs: Pair[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      pairs.push([i, j]);
      i += 1;
      j += 1;
    } else if (dp[(i + 1) * width + j] >= dp[i * width + j + 1]) {
      i += 1;
    } else {
      j += 1;
    }
  }
  return pairs;
}

/**
 * 判断缓存块是否应视为“人工内容”而受保护。
 *
 * 除了显式的 `human` 模式，`dst` 与当前块哈希不一致也视为人工改写（例如用户直接编辑
 * 了缓存文件但没更新锚点），避免普通同步把它当机器译文覆盖。
 */
function isHumanAnchoredBlock(cached: AnchoredBlock): boolean {
  return (
    cached.anchor.mode === "human" || cached.block.hash !== cached.anchor.dst
  );
}

/** 结合原文可翻译性与缓存锚点，推导块状态及人工/过期标记。无副作用。 */
function deriveStatus(
  source: MarkdownBlock,
  cached: AnchoredBlock | undefined,
): { status: BlockStatus; human: boolean; stale: boolean } {
  if (!cached) {
    return {
      status: source.translatable ? "untranslated" : "copy-pending",
      human: false,
      stale: false,
    };
  }
  // 只有 src 记录了当前原文哈希，才能认为译文与原文同步。
  const stale = cached.anchor.src !== source.hash;
  // 删除墓碑是用户的显式决策，即使原文已变更也不重新翻译。
  if (cached.anchor.mode === "deleted") {
    return { status: "deleted", human: true, stale };
  }
  if (!source.translatable) {
    return {
      status: stale ? "copy-stale" : "copy",
      human: false,
      stale,
    };
  }
  const human = isHumanAnchoredBlock(cached);
  if (human) {
    return { status: stale ? "human-stale" : "human", human: true, stale };
  }
  return { status: stale ? "stale" : "translated", human: false, stale };
}

/**
 * 将一份原文与一份缓存对齐。
 *
 * 参数 `sourceBlocks` 必须来自同一次 `parseMarkdownDocument` 且 `index` 与数组下标
 * 一致；`cache` 由 `parseCacheDocument` 产出。返回的 `blocks` 与 `sourceBlocks` 等长、
 * 同序，未匹配的原文块 `cache` 为 `undefined`。
 *
 * 纯函数，无副作用；缓存中的结构告警会复制到返回值，无法匹配的缓存块放入
 * `orphanCaches`，由调用方决定阻断还是丢弃。
 */
export function alignDocument(
  sourceBlocks: readonly MarkdownBlock[],
  cache: CacheDocument,
): AlignmentResult {
  const cacheBlocks = cache.blocks;
  const warnings = [...cache.warnings];
  const srcToCache = new Map<number, number>();
  const usedCache = new Set<number>();

  // 第一轮：按哈希精确匹配，保证完全未变的块不会错位。
  const exactPairs = lcsPairs(
    sourceBlocks.map((block) => block.hash),
    cacheBlocks.map((cached) => cached.anchor.src),
  );

  /**
   * 第二轮：在相邻精确匹配（含首尾）之间，按块类型为剩余项做兜底匹配。
   *
   * 这样原文被改写（哈希变化）但结构未变时，旧译文会以 stale 状态保留，而不是被
   * 当作全新块丢弃；代价是同类型的相邻替换可能被误配，因此仅限“缺口”内部。
   */
  const pairGap = (srcStart: number, srcEnd: number, cacheStart: number, cacheEnd: number) => {
    const sourceIndices: number[] = [];
    for (let i = srcStart; i < srcEnd; i += 1) {
      if (!srcToCache.has(i)) {
        sourceIndices.push(i);
      }
    }
    const cacheIndices: number[] = [];
    for (let j = cacheStart; j < cacheEnd; j += 1) {
      if (!usedCache.has(j)) {
        cacheIndices.push(j);
      }
    }
    if (sourceIndices.length === 0 || cacheIndices.length === 0) {
      return;
    }
    const kindPairs = lcsPairs(
      sourceIndices.map((i) => sourceBlocks[i].kind),
      cacheIndices.map((j) => cacheBlocks[j].block.kind),
    );
    for (const [sourceOffset, cacheOffset] of kindPairs) {
      const sourceIndex = sourceIndices[sourceOffset];
      const cacheIndex = cacheIndices[cacheOffset];
      srcToCache.set(sourceIndex, cacheIndex);
      usedCache.add(cacheIndex);
    }
  };

  let previousSource = 0;
  let previousCache = 0;
  // 末尾哨兵 [len, len] 用于处理最后一个精确匹配之后的剩余块。
  const boundaries: Pair[] = [...exactPairs, [sourceBlocks.length, cacheBlocks.length]];
  for (const [sourceIndex, cacheIndex] of boundaries) {
    pairGap(previousSource, sourceIndex, previousCache, cacheIndex);
    if (sourceIndex < sourceBlocks.length && cacheIndex < cacheBlocks.length) {
      srcToCache.set(sourceIndex, cacheIndex);
      usedCache.add(cacheIndex);
    }
    previousSource = sourceIndex + 1;
    previousCache = cacheIndex + 1;
  }

  const blocks: AlignedBlock[] = sourceBlocks.map((source) => {
    const cacheIndex = srcToCache.get(source.index);
    const cached = cacheIndex === undefined ? undefined : cacheBlocks[cacheIndex];
    const { status, human, stale } = deriveStatus(source, cached);
    return {
      key: String(source.index),
      source,
      cache: cached,
      status,
      human,
      stale,
      translatable: source.translatable,
    };
  });

  // 未被任何原文块使用的缓存即为孤儿；机器孤儿可在同步时丢弃，人工孤儿会被上层阻断。
  const orphanCaches: AnchoredBlock[] = [];
  cacheBlocks.forEach((cached, index) => {
    if (!usedCache.has(index)) {
      orphanCaches.push(cached);
    }
  });

  if (orphanCaches.length > 0) {
    warnings.push(
      tError("sync.alignOrphanCaches", { count: orphanCaches.length }),
    );
  }
  if (cache.untracked.length > 0) {
    warnings.push(
      tError("sync.alignUntrackedCache", { count: cache.untracked.length }),
    );
  }

  return {
    blocks,
    orphanCaches,
    untrackedCaches: cache.untracked,
    warnings,
  };
}

export { isHumanAnchoredBlock };
