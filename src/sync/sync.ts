/**
 * 同步核心（纯逻辑层，不直接依赖 `vscode` 命名空间）。
 *
 * 职责：解析原文与缓存、对齐块、决定哪些块需要翻译、收集/校验 Provider 输出，并在
 * 保留人工译文、删除墓碑、复制块与 target-only 块的前提下，重新生成整篇缓存文本。
 *
 * 关键不变量：
 * - 缓存文本只由 `serializeCacheDocument` 生成：frontmatter 在最前，每个块按
 *   “锚点行 + 空行 + 正文”排列；锚点 id 在缓存内唯一且尽量复用旧 id；
 * - 锚点模式为 `human` 的译文与 `deleted` 墓碑不会被机器输出覆盖；仅内容被手工改过、
 *   模式仍为 `auto` 的块在 `retranslateAll` 下会被重译（已知边界）；
 * - 缺失译文只在 `allowPartial` 模式下跳过，否则整次同步失败；
 * - 生成后必须重新解析草稿缓存，确认没有产生未跟踪块，再用实际块哈希回填 `dst`；
 * - target-only 块不参与对齐，但要按原相对位置合并回新缓存。
 *
 * 与其他模块的关系：`SyncService.syncInternal` 是唯一调用方；块级编辑走
 * `cache/editCache`，Provider 合约见 `translation/types`。
 */
import type { MarkdownIt } from "markdown-it";
import { isDeletedMarker } from "../cache/deletedMarker";
import { createSummaryMarker } from "../cache/summaryMarker";
import { alignDocument, isHumanAnchoredBlock } from "../markdown/align";
import {
  parseCacheDocument,
  serializeAnchor,
} from "../markdown/anchors";
import { buildHeadingPaths, buildSectionIds } from "../markdown/headings";
import { parseMarkdownDocument } from "../markdown/segmenter";
import {
  type AlignmentResult,
  type AnchoredBlock,
  type BlockAnchor,
  type BlockKind,
  type CacheDocument,
  type CacheSummary,
  type MarkdownBlock,
  type ParsedMarkdown,
} from "../markdown/types";
import {
  newBlockId,
  blockHash,
} from "../util/hash";
import { normalizeBlockContent } from "../util/text";
import {
  validateTranslationResult,
  type GlossaryEntry,
  type TranslationBrief,
  type TranslationChunkHandler,
  type TranslationItem,
  type TranslationProvider,
  type TranslationResultItem,
} from "../translation/types";
import { restoreProtectedSyntax } from "../util/protectedSyntax";
import { tError } from "../i18n/errors";
import { formatText, UI_TEXT } from "../i18n";

// ---- 公共类型 ----

/** 缓存中的一条记录：锚点元数据 + 正文（正文不含锚点行）。 */
export interface CacheEntry {
  anchor: BlockAnchor;
  /** 译文正文；序列化时会与锚点之间补一个空行。 */
  content: string;
}

/** 进度回调中的完成量：`completed/total` 均以“块”为单位。 */
export interface SyncProgressDetail {
  completed: number;
  total: number;
}

/** 同步进度上报函数；UI 用它更新状态栏/任务视图，实现方不应抛错。 */
export type SyncProgressReporter = (
  message: string,
  detail?: SyncProgressDetail,
) => void;

/** 稳定翻译与全文摘要的运行时选项（由设置/预览开关解析后传入）。 */
export interface TranslationAssistOptions {
  /** 重新翻译时是否把旧译文作为参考；缺省 false，由 SyncService 按设置解析。 */
  stableTranslation?: boolean;
  /** 全文摘要（原文语言）；存在时作为每批固定上下文，并计入预算。 */
  summary?: string;
  /** 文档简报的用户翻译要求；存在时随每批请求发送。 */
  brief?: TranslationBrief;
}

/** 同步时附带的用户批注快照；只挂到对应块并参与该块的翻译。 */
export interface SyncAnnotationInput {
  id: string;
  blockId: string;
  sourceIndex?: number;
  sourceHash?: string;
  kind: "note" | "request-change";
  text: string;
  /** 新建/编辑后尚未参与翻译；用于把已翻译块纳入本次同步。 */
  pending: boolean;
}

/** `syncDocument` 的输入。 */
export interface SyncOptions {
  /** 与切块、缓存解析共享的 markdown-it 实例。 */
  md: MarkdownIt;
  sourceText: string;
  /** 为空/缺省时视为空缓存，从头生成。 */
  cacheText?: string;
  provider: TranslationProvider;
  sourceLanguage: string;
  targetLanguage: string;
  /** 是否允许机器重译 `stale` 块。 */
  retranslateStale: boolean;
  /** 是否重译所有 `auto` 块（不影响人工块）。 */
  retranslateAll?: boolean;
  glossary?: readonly GlossaryEntry[];
  /** 稳定翻译参考与全文摘要上下文。 */
  assist?: TranslationAssistOptions;
  /** 当前文件所有生效中的用户批注；由 SyncService 从 sidecar 读取。 */
  annotations?: readonly SyncAnnotationInput[];
  signal?: AbortSignal;
  onProgress?: SyncProgressReporter;
  /**
   * 允许 Provider 分批返回并保留成功部分；此模式下缺失块的旧译文（若有）会保留。
   */
  allowPartial?: boolean;
  /**
   * 部分结果落盘回调；仅在 `allowPartial` 时按阈值调用，失败会中断当前批次。
   */
  onCacheCommit?: (cacheText: string) => Promise<void>;
}

/** `syncDocument` 的结果；`cacheText` 是最终应持久化的完整缓存。 */
export interface SyncResult {
  cacheText: string;
  cache: CacheDocument;
  source: ParsedMarkdown;
  /** 最终缓存与原文的对齐结果。 */
  alignment: AlignmentResult;
  /** 同步前的对齐结果，用于统计保留的过期块。 */
  initialAlignment: AlignmentResult;
  warnings: string[];
  /** 本次真正获得新机器译文的块数。 */
  translatedCount: number;
  /** 本次重新复制的非翻译块数。 */
  copiedCount: number;
  /** 保留下来的人工锁定块数。 */
  humanLockedCount: number;
  /** 因设置而保留旧译文的过期块数。 */
  keptMachineStaleCount: number;
  /** Provider 的展示名，供 UI 标注翻译来源。 */
  providerLabel: string;
  /** 是否存在未完成的翻译任务。 */
  partial: boolean;
  /** 未获得机器译文的块数。 */
  failedTaskCount: number;
  /** Provider / 部分写入的失败原因，按发生顺序排列。 */
  failures: string[];
  /** 本次真正参与翻译的批注结果；changed 表示该块译文是否发生变化。 */
  annotationOutcomes: Array<{ annotationId: string; changed: boolean }>;
}

/**
 * 同步被结构性风险阻断时抛出的错误。
 *
 * `reasons` 是逐条中文原因，UI 会完整展示；抛出时不会写入任何缓存。
 */
export class SyncBlockedError extends Error {
  readonly reasons: string[];

  /** @param reasons 逐条中文原因；同时作为 `message` 的换行拼接结果。 */
  constructor(reasons: string[]) {
    super(reasons.join("\n"));
    this.name = "SyncBlockedError";
    this.reasons = reasons;
  }
}

// ---- 序列化与安全校验 ----

/** 统一清洗 Provider 输出：去首尾空行、行尾空白与 CRLF。 */
function normalizeContent(text: string): string {
  return normalizeBlockContent(text);
}

/**
 * 序列化整篇缓存。
 *
 * 有 frontmatter 时置于最前，随后是可选摘要标记；每个条目之间用空行分隔，
 * 并在末尾补一个换行。返回空串表示没有任何内容。正文按原样写入，调用方需保证
 * 其已被规范化且不含锚点行。
 */
export function serializeCacheDocument(
  frontmatter: MarkdownBlock | undefined,
  entries: readonly CacheEntry[],
  summary?: CacheSummary,
): string {
  const parts: string[] = [];
  if (frontmatter?.raw.trim()) {
    parts.push(frontmatter.raw.trimEnd());
  }
  if (summary?.text.trim()) {
    parts.push(createSummaryMarker(summary));
  }
  for (const entry of entries) {
    parts.push(serializeAnchor(entry.anchor));
    parts.push(entry.content);
  }
  return parts.length > 0 ? `${parts.join("\n\n")}\n` : "";
}

/**
 * 写缓存前的安全检查。
 *
 * 阻断条件：缓存含未跟踪块（无法判断归属），或存在找不到原文的人工锁定块（重写会
 * 丢失用户成果）。机器孤儿与孤立锚点不阻断，仅通过告警暴露。
 */
function assertCacheWritable(alignment: AlignmentResult, cache: CacheDocument): void {
  const reasons: string[] = [];
  if (cache.untracked.length > 0) {
    reasons.push(
      tError("sync.untrackedCacheWarning", { count: cache.untracked.length }),
    );
  }
  const humanOrphans = alignment.orphanCaches.filter(isHumanAnchoredBlock);
  if (humanOrphans.length > 0) {
    reasons.push(
      tError("sync.humanOrphanWarning", { count: humanOrphans.length, ids: humanOrphans
        .map((item) => item.anchor.id)
        .join(", ") }),
    );
  }
  if (reasons.length > 0) {
    throw new SyncBlockedError(reasons);
  }
}

// ---- 条目收集与合并 ----

/**
 * 按原文顺序生成新的缓存条目。
 *
 * 分支优先级（决定内容来源与模式）：
 * 1. 缓存是删除墓碑：原样保留墓碑，`src` 跟随当前原文（备份中仍记录删除时的哈希）；
 * 2. 原文块不可翻译：始终用原文覆盖，模式 `copy`；
 * 3. 本次有机器输出：使用清洗后的输出，模式 `auto`；
 * 4. 复用旧缓存：内容与 `src` 保持原样，人工块标记 `human`；
 * 5. 无缓存且允许缺失：跳过；否则抛错。
 *
 * 返回的 `copiedCount` / `humanLockedCount` 供汇总使用。`allowMissing` 为 false 时
 * 还会校验条目数与原文块数一致，防止漏块写坏缓存。
 */
function collectEntries(
  alignment: AlignmentResult,
  outputs: Map<string, string>,
  finalIds: Map<number, string>,
  sourceBlocks: readonly MarkdownBlock[],
  allowMissing = false,
): { entries: CacheEntry[]; copiedCount: number; humanLockedCount: number } {
  const entries: CacheEntry[] = [];
  let copiedCount = 0;
  let humanLockedCount = 0;

  for (const aligned of alignment.blocks) {
    const source = aligned.source;
    const cached = aligned.cache;
    const id = finalIds.get(source.index);
    if (!id) {
      throw new Error(tError("sync.missingStableAnchor", { index: source.index + 1 }));
    }
    let content: string;
    let mode: BlockAnchor["mode"];
    let src: string;

    if (cached?.anchor.mode === "deleted") {
      // 墓碑必须保留：否则下次同步会把用户明确删除的块重新翻译出来。
      content = cached.block.raw;
      mode = "deleted";
      src = source.hash;
    } else if (!source.translatable) {
      content = source.raw;
      mode = "copy";
      src = source.hash;
      copiedCount += 1;
    } else if (outputs.has(id)) {
      content = normalizeContent(outputs.get(id) ?? "");
      mode = "auto";
      src = source.hash;
    } else if (cached) {
      // 复用旧译文时保留旧 src：这样过期状态不会被意外清除，人工块也继续受保护。
      content = cached.block.raw;
      mode = aligned.human ? "human" : "auto";
      src = cached.anchor.src;
      if (aligned.human) {
        humanLockedCount += 1;
      }
    } else {
      if (allowMissing) {
        continue;
      }
      throw new Error(tError("sync.missingTranslationTask", { index: source.index }));
    }

    const anchor: BlockAnchor = {
      id,
      kind: source.kind,
      src,
      dst: blockHash(source.kind, content),
      mode,
    };
    entries.push({ anchor, content });
  }

  if (!allowMissing && entries.length !== sourceBlocks.length) {
    throw new Error(tError("sync.blockCountMismatch"));
  }
  return { entries, copiedCount, humanLockedCount };
}

/**
 * 把 target-only 块按原有相对位置合并回新缓存。
 *
 * target 块没有对应原文，无法参与对齐；这里以“前一个/后一个 source 锚点”为参照：
 * 优先挂到前面最近的 source 块之后，没有前驱则挂到后面最近的 source 块之前，都没
 * 有则放到文末。删除墓碑形式的 target 块会被丢弃（见 `isDeletedMarker`）。
 */
function mergeTargetEntries(
  entries: readonly CacheEntry[],
  cache: CacheDocument,
): CacheEntry[] {
  // 旧的 target 删除墓碑不再保留，避免每次同步都重复写入。
  const targetBlocks = cache.targetBlocks.filter(
    (item) => !isDeletedMarker(item.block.raw),
  );
  if (targetBlocks.length === 0) {
    return [...entries];
  }
  // 按锚点行号排序，得到 source 与 target 的真实交错顺序。
  const ordered = [...cache.blocks, ...targetBlocks].sort(
    (a, b) => a.anchorLine - b.anchorLine,
  );
  const sourceAnchorIds = new Set(cache.blocks.map((item) => item.anchor.id));
  const targetEntries = new Map(
    targetBlocks.map((item) => [
      item.anchor.id,
      { anchor: item.anchor, content: item.block.raw } satisfies CacheEntry,
    ]),
  );
  const before = new Map<string, CacheEntry[]>();
  const after = new Map<string, CacheEntry[]>();
  const trailing: CacheEntry[] = [];

  for (let index = 0; index < ordered.length; index += 1) {
    const item = ordered[index];
    if (item.anchor.mode !== "target") {
      continue;
    }
    const entry = targetEntries.get(item.anchor.id);
    if (!entry) {
      continue;
    }
    let previous: AnchoredBlock | undefined;
    for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
      if (sourceAnchorIds.has(ordered[cursor].anchor.id)) {
        previous = ordered[cursor];
        break;
      }
    }
    if (previous) {
      // 紧跟在某个 source 块之后的 target（含连续多个）保持原有先后顺序。
      const list = after.get(previous.anchor.id) ?? [];
      list.push(entry);
      after.set(previous.anchor.id, list);
      continue;
    }
    let next: AnchoredBlock | undefined;
    for (let cursor = index + 1; cursor < ordered.length; cursor += 1) {
      if (sourceAnchorIds.has(ordered[cursor].anchor.id)) {
        next = ordered[cursor];
        break;
      }
    }
    if (next) {
      const list = before.get(next.anchor.id) ?? [];
      list.push(entry);
      before.set(next.anchor.id, list);
      continue;
    }
    trailing.push(entry);
  }

  const merged: CacheEntry[] = [];
  for (const entry of entries) {
    const leading = before.get(entry.anchor.id);
    if (leading) {
      merged.push(...leading);
    }
    merged.push(entry);
    const following = after.get(entry.anchor.id);
    if (following) {
      merged.push(...following);
    }
  }
  merged.push(...trailing);
  return merged;
}

// ---- 主流程 ----

/**
 * 执行一次同步：对齐 -> 选任务 -> 调用 Provider -> 重新生成缓存。
 *
 * 行为要点：
 * - 同步前若发现未跟踪内容或人工锁定块成为孤儿，抛 `SyncBlockedError`，缓存不变；
 * - 只翻译缺失、`copy`、按设置需要重译的 `auto` 块；人工块与墓碑永不翻译；
 * - `allowPartial` 时通过 `onChunk` 流式接收结果，并按块数/时间阈值调用
 *   `onCacheCommit` 落盘；Provider 抛错但已有成功结果时保留部分译文并返回；
 * - `signal` 取消时先尝试提交已有部分结果（仅 `allowPartial`）再抛出取消错误；
 * - 返回的 `cacheText` 由调用方决定是否最终持久化；部分模式下可能已有中间结果
 *   通过 `onCacheCommit` 落盘。
 *
 * 无文件系统副作用，除了通过 `onCacheCommit` 回调以及 Provider 的进度回调产生的外部
 * 影响。翻译任务为空时不会调用 Provider。
 */
export async function syncDocument(options: SyncOptions): Promise<SyncResult> {
  const {
    md,
    sourceText,
    cacheText,
    provider,
    sourceLanguage,
    targetLanguage,
    retranslateStale,
    retranslateAll = false,
    glossary = [],
    signal,
    onProgress,
    allowPartial = false,
    onCacheCommit,
  } = options;

  const source = parseMarkdownDocument(sourceText, md);
  const cache = cacheText
    ? parseCacheDocument(cacheText, md)
    : {
        blocks: [],
        targetBlocks: [],
        untracked: [],
        orphanAnchors: [],
        cleanedText: "",
        warnings: [],
        frontmatter: undefined,
      };
  const initialAlignment = alignDocument(source.blocks, cache);
  assertCacheWritable(initialAlignment, cache);

  const warnings: string[] = [...initialAlignment.warnings];
  if (initialAlignment.orphanCaches.length > 0) {
    // 机器孤儿没有人工成果，允许丢弃以保持缓存干净；人工孤儿已在上面阻断。
    warnings.push(
      tError("sync.droppedOrphanAnchors", { count: initialAlignment.orphanCaches.length }),
    );
  }

  const headingPaths = buildHeadingPaths(source.blocks);
  const sectionIds = buildSectionIds(source.blocks);
  // 只用于分批的文档标识：内容哈希相同视为同一文档；不发送给模型。
  const documentId = blockHash("document", sourceText);
  const usedIds = new Set<string>();
  for (const cached of cache.blocks) {
    usedIds.add(cached.anchor.id);
  }
  for (const anchor of cache.orphanAnchors) {
    usedIds.add(anchor.id);
  }
  const finalIds = new Map<number, string>();
  for (const aligned of initialAlignment.blocks) {
    // 尽量复用旧锚点 id，使缓存 diff 稳定；新块才生成随机 id。
    let id = aligned.cache?.anchor.id;
    if (!id) {
      do {
        id = newBlockId();
      } while (usedIds.has(id));
      usedIds.add(id);
    }
    finalIds.set(aligned.source.index, id);
  }

  // 把批注按源块归位：已有缓存优先按锚点 id，无缓存批注按 sourceIndex，
  // 旧数据只有在同哈希唯一时才按哈希匹配。源文已变化（sourceHash 不一致）的批注跳过。
  const annotationsBySourceIndex = new Map<number, SyncAnnotationInput[]>();
  if (options.annotations?.length) {
    const anchorToSourceIndex = new Map<string, number>();
    for (const aligned of initialAlignment.blocks) {
      if (aligned.cache) {
        anchorToSourceIndex.set(
          aligned.cache.anchor.id,
          aligned.source.index,
        );
      }
    }
    for (const annotation of options.annotations) {
      let index = anchorToSourceIndex.get(annotation.blockId);
      if (index === undefined && annotation.blockId.startsWith("src-")) {
        const hash = annotation.blockId.slice(4).trim();
        const candidates = initialAlignment.blocks.filter(
          (aligned) => aligned.source.hash === hash,
        );
        if (annotation.sourceIndex !== undefined) {
          index = candidates.find(
            (aligned) => aligned.source.index === annotation.sourceIndex,
          )?.source.index;
        }
        if (index === undefined && candidates.length === 1) {
          index = candidates[0].source.index;
        }
      }
      if (index === undefined) {
        continue;
      }
      const aligned = initialAlignment.blocks.find(
        (item) => item.source.index === index,
      );
      if (
        !aligned ||
        (annotation.sourceHash !== undefined &&
          annotation.sourceHash !== aligned.source.hash)
      ) {
        continue;
      }
      const list = annotationsBySourceIndex.get(index) ?? [];
      list.push(annotation);
      annotationsBySourceIndex.set(index, list);
    }
  }

  const tasks: Array<{
    item: TranslationItem;
    anchorId: string;
    annotations: SyncAnnotationInput[];
  }> = [];

  for (const aligned of initialAlignment.blocks) {
    const sourceBlock = aligned.source;
    if (!sourceBlock.translatable) {
      continue;
    }
    const cached = aligned.cache;
    const cacheIsCopy = cached?.anchor.mode === "copy";
    const cacheIsDeleted = cached?.anchor.mode === "deleted";
    const sourceAnnotations =
      annotationsBySourceIndex.get(sourceBlock.index) ?? [];
    const hasPendingAnnotations = sourceAnnotations.some(
      (annotation) => annotation.pending,
    );
    // 显式 human / deleted 模式不会被选中；待生效批注可把已翻译块拉进本次同步。
    // 注意 dst 不一致的 auto 块（手工改过缓存）在 retranslateAll 下仍会命中最后的 auto 条件。
    const needsTranslation =
      !cacheIsDeleted &&
      !aligned.human &&
      (!cached ||
        cacheIsCopy ||
        (retranslateAll && cached.anchor.mode === "auto") ||
        (aligned.status === "stale" && retranslateStale) ||
        hasPendingAnnotations);
    if (!needsTranslation) {
      if (aligned.status === "stale") {
        warnings.push(
          tError("sync.staleKept", { index: sourceBlock.index + 1 }),
        );
      }
      continue;
    }
    const anchorId = finalIds.get(sourceBlock.index);
    if (!anchorId) {
      throw new Error(tError("sync.missingAnchor", { index: sourceBlock.index + 1 }));
    }
    const itemAnnotations = sourceAnnotations.map((annotation) => ({
      author: "user" as const,
      kind: annotation.kind,
      text: annotation.text,
    }));
    // 批注与旧译文可能冲突时，由 system prompt 明确批注优先；reference 仍按稳定翻译发送。
    const reference =
      options.assist?.stableTranslation === true &&
      cached &&
      cached.anchor.mode !== "deleted" &&
      cached.anchor.mode !== "copy" &&
      cached.block.raw.trim()
        ? {
            text: cached.block.raw,
            role: "previous-target" as const,
          }
        : undefined;
    tasks.push({
      anchorId,
      annotations: sourceAnnotations,
      item: {
        id: anchorId,
        text: sourceBlock.raw,
        kind: sourceBlock.kind,
        headingPath: headingPaths.get(sourceBlock.index) ?? [],
        documentId,
        sectionId: sectionIds.get(sourceBlock.index) ?? "section-0",
        ...(reference ? { reference } : {}),
        ...(itemAnnotations.length
          ? { annotations: itemAnnotations }
          : {}),
      },
    });
  }

  const taskById = new Map(tasks.map((task) => [task.item.id, task.item]));

  /** 把模型改写过的行内代码与脚注标签还原为源文内容。 */
  const restoreResult = (item: TranslationResultItem): TranslationResultItem => {
    const source = taskById.get(item.id);
    if (!source) {
      return item;
    }
    const text = restoreProtectedSyntax(source.text, item.text, source.kind);
    return text === item.text ? item : { ...item, text };
  };

  /**
   * 根据当前已有的机器输出重新生成缓存草案。
   *
   * 这是“解析-序列化-再解析”的闭环：先组装条目并序列化，再解析草稿校验结构，
   * 然后用实际解析出的块哈希修正每个 `dst`，最后再序列化/解析一次得到稳定结果。
   * 草稿结构异常会转成 `SyncBlockedError`，避免把坏缓存交给调用方。
   */
  const buildCache = (candidate: Map<string, string>) => {
    const prepared = collectEntries(
      initialAlignment,
      candidate,
      finalIds,
      source.blocks,
      allowPartial,
    );

    let entries = mergeTargetEntries(prepared.entries, cache);
    const draftText = serializeCacheDocument(
      source.frontmatter,
      entries,
      cache.summary,
    );
    const draft = parseCacheDocument(draftText, md);
    // 译文正文若意外包含块级结构或空行，会在这里裂出未跟踪块。
    if (draft.untracked.length > 0) {
      throw new SyncBlockedError([
        tError("sync.draftUntrackedBlocks", {
          count: draft.untracked.length,
        }),
      ]);
    }
    const parsedById = new Map(
      [...draft.blocks, ...draft.targetBlocks].map((item) => [
        item.anchor.id,
        item.block,
      ]),
    );
    const entryWarnings: string[] = [];
    entries = entries.map((entry, index) => {
      const parsed = parsedById.get(entry.anchor.id);
      if (!parsed) {
        throw new SyncBlockedError([
          tError("sync.draftAnchorMissing", { id: entry.anchor.id }),
        ]);
      }
      if (parsed.kind !== entry.anchor.kind) {
        entryWarnings.push(
          tError("sync.kindChangedWarning", { index: index + 1, from: entry.anchor.kind, to: parsed.kind }),
        );
      }
      return {
        ...entry,
        // dst 以重新解析的结果为准，保证与块实际哈希严格一致。
        anchor: { ...entry.anchor, dst: parsed.hash },
      };
    });

    const cacheText = serializeCacheDocument(
      source.frontmatter,
      entries,
      cache.summary,
    );
    const finalCache = parseCacheDocument(cacheText, md);
    const alignment = alignDocument(source.blocks, finalCache);
    return {
      cacheText,
      cache: finalCache,
      alignment,
      prepared,
      entryWarnings,
    };
  };

  signal?.throwIfAborted();
  let outputs = new Map<string, string>();
  const failures: string[] = [];
  const taskIds = new Set(tasks.map((task) => task.item.id));
  let providerFailure: string | undefined;
  let pendingSinceCommit = 0;
  let lastCommitAt = Date.now();
  // 部分结果落盘阈值：达到任一条即提交，避免频繁写盘，又能在长时间翻译中保留进度。
  const PARTIAL_COMMIT_BLOCKS = 4;
  const PARTIAL_COMMIT_INTERVAL_MS = 2_000;

  /** 需要时把当前 outputs 生成缓存并通过回调落盘；仅部分模式且提供了回调时生效。 */
  const commitIfNeeded = async (force: boolean): Promise<void> => {
    if (!allowPartial || !onCacheCommit || outputs.size === 0) {
      return;
    }
    const now = Date.now();
    if (
      !force &&
      pendingSinceCommit < PARTIAL_COMMIT_BLOCKS &&
      now - lastCommitAt < PARTIAL_COMMIT_INTERVAL_MS
    ) {
      return;
    }
    const built = buildCache(outputs);
    await onCacheCommit(built.cacheText);
    pendingSinceCommit = 0;
    lastCommitAt = Date.now();
  };

  /**
   * 处理一批 Provider 返回的译文。
   *
   * 先在副本上校验再整体替换 `outputs`，任何非法批次都不会污染已接受的结果；
   * 部分模式下先完整构建一次缓存以确认可写，再更新 outputs。
   */
  const processChunk = async (
    items: Parameters<TranslationChunkHandler>[0],
  ): Promise<void> => {
    if (items.length === 0) {
      return;
    }
    const candidate = new Map(outputs);
    for (const item of items) {
      if (!taskIds.has(item.id)) {
        throw new Error(tError("translation.unexpectedBlock", { id: item.id }));
      }
      if (candidate.has(item.id)) {
        throw new Error(tError("translation.duplicateBlock", { id: item.id }));
      }
      if (typeof item.text !== "string" || !item.text.trim()) {
        throw new Error(tError("translation.emptyBlock", { id: item.id }));
      }
      const restored = restoreResult(item);
      candidate.set(restored.id, restored.text);
    }
    if (allowPartial) {
      buildCache(candidate);
    }
    outputs = candidate;
    pendingSinceCommit += items.length;
    await commitIfNeeded(false);
  };

  // Provider 可能并发回调 onChunk；用 Promise 链把处理与提交串行化，保证 outputs 顺序一致。
  let chunkQueue: Promise<void> = Promise.resolve();
  const handleChunk: TranslationChunkHandler = (items) => {
    const next = chunkQueue.then(() => processChunk(items));
    chunkQueue = next.catch(() => {
      /* 让后续批次仍可排队；错误会返回给 Provider */
    });
    return next;
  };

  if (tasks.length > 0) {
    onProgress?.(
      formatText(UI_TEXT.taskPanel.phases.translatingBlocks, {
        count: tasks.length,
      }),
      {
        completed: 0,
        total: tasks.length,
      },
    );
    try {
      const rawResult = await provider.translate(
        {
          sourceLanguage,
          targetLanguage,
          items: tasks.map((task) => task.item),
          glossary: [...glossary],
          ...(options.assist?.summary?.trim()
            ? { summary: options.assist.summary }
            : {}),
          ...(options.assist?.brief
            ? { brief: options.assist.brief }
            : {}),
        },
        signal,
        (completed, total) => {
          onProgress?.(
            formatText(UI_TEXT.taskPanel.phases.translatingProgress, {
              completed,
              total,
            }),
            {
              completed,
              total,
            },
          );
        },
        handleChunk,
      );
      // 返回值必须覆盖全部任务；校验失败时保留之前已接收的流式结果。
      outputs = validateTranslationResult(
        tasks.map((task) => task.item),
        rawResult.map(restoreResult),
      );
    } catch (error) {
      if (signal?.aborted) {
        if (allowPartial && outputs.size > 0) {
          try {
            await commitIfNeeded(true);
          } catch {
            /* 取消时保留最后一次成功提交 */
          }
        }
        throw error;
      }
      if (!allowPartial) {
        throw error;
      }
      // 部分模式：记录失败原因，尽量保留已成功的批次；完全无结果时仍然失败。
      const message = error instanceof Error ? error.message : String(error);
      providerFailure = message;
      failures.push(message);
      if (outputs.size === 0) {
        throw error;
      }
      try {
        await commitIfNeeded(true);
      } catch (commitError) {
        failures.push(
          tError("sync.partialWriteFailed", { message: commitError instanceof Error ? commitError.message : String(commitError) }),
        );
      }
    }
  }
  if (signal?.aborted) {
    if (allowPartial && outputs.size > 0) {
      try {
        await commitIfNeeded(true);
      } catch {
        /* 取消时保留最后一次成功提交 */
      }
    }
    signal.throwIfAborted();
  }

  const built = buildCache(outputs);
  warnings.push(...built.entryWarnings);
  if (providerFailure) {
    warnings.push(tError("sync.providerIncomplete", { message: providerFailure }));
  }
  // 只统计本次任务；复用的旧译文不计入 translatedCount。
  const translatedCount = tasks.reduce(
    (count, task) => (outputs.has(task.item.id) ? count + 1 : count),
    0,
  );
  const failedTaskCount = tasks.length - translatedCount;
  if (failedTaskCount > 0) {
    warnings.push(
      tError("sync.blocksFailed", { count: failedTaskCount }),
    );
  }
  const annotationOutcomes: SyncResult["annotationOutcomes"] = [];
  for (const task of tasks) {
    if (task.annotations.length === 0 || !outputs.has(task.item.id)) {
      continue;
    }
    const oldTarget = initialAlignment.blocks.find(
      (aligned) => aligned.cache?.anchor.id === task.item.id,
    )?.cache?.block.raw;
    const newTarget = outputs.get(task.item.id) ?? "";
    const changed =
      oldTarget === undefined
        ? normalizeContent(newTarget).length > 0
        : normalizeContent(newTarget) !== normalizeContent(oldTarget);
    for (const annotation of task.annotations) {
      annotationOutcomes.push({
        annotationId: annotation.id,
        changed,
      });
    }
  }

  return {
    cacheText: built.cacheText,
    cache: built.cache,
    source,
    alignment: built.alignment,
    initialAlignment,
    warnings,
    translatedCount,
    copiedCount: built.prepared.copiedCount,
    humanLockedCount: built.prepared.humanLockedCount,
    keptMachineStaleCount:
      initialAlignment.blocks.filter(
        (block) =>
          block.status === "stale" &&
          !retranslateStale &&
          !retranslateAll &&
          block.translatable,
      ).length,
    providerLabel: provider.label,
    partial: failedTaskCount > 0,
    failedTaskCount,
    failures,
    annotationOutcomes,
  };
}
