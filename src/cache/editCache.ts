/**
 * 单块缓存编辑。
 *
 * 职责：在不动其他块的前提下，替换/标记某个译文块的正文或锚点，并返回重新解析后的
 * 缓存文本。所有修改都基于行号直接拼接，不做整篇重新序列化，以保留用户对缓存的
 * 手工排版与 target-only 块。
 *
 * 关键不变量：
 * - 传入的 `anchorLine` 与块 `startLine/endLine` 必须来自同一份 `cacheText` 的解析；
 * - 锚点行位于块之前，替换块正文不会移动锚点行，因此两步（写正文、回填 dst）都能
 *   继续使用同一个 `anchorLine`；
 * - 写回前必须重新解析并确认没有产生未跟踪块、目标块仍可定位、块类型未被改变。
 *
 * 与其他模块的关系：`syncService` 的所有单块操作都经过这里；`anchors` 提供解析与
 * 序列化，`deletedMarker` 提供删除墓碑内容。
 */
import type { MarkdownIt } from "markdown-it";
import { parseCacheDocument, serializeAnchor } from "../markdown/anchors";
import type {
  AnchorMode,
  AnchoredBlock,
  BlockAnchor,
  BlockKind,
  CacheDocument,
  MarkdownBlock,
} from "../markdown/types";
import { normalizeNewlines } from "../util/hash";
import { normalizeBlockContent } from "../util/text";

/** 编辑成功后的缓存文本、最终锚点与重新解析得到的块。 */
export interface EditedCache {
  /** 完整缓存文本，可直接交给 `CacheStore.write`。 */
  text: string;
  /** 写入的最终锚点（`dst` 已按实际块哈希修正）。 */
  anchor: BlockAnchor;
  /** 重新解析得到的译文块。 */
  block: MarkdownBlock;
}

/**
 * 拒绝在存在未跟踪内容的缓存上做单块编辑。
 *
 * 未跟踪内容意味着锚点归属不可靠，此时按行号替换可能误伤其他块，因此要求用户先清理。
 */
function assertEditable(cache: CacheDocument): void {
  if (cache.untracked.length > 0) {
    throw new Error(
      "译文缓存中存在未加锚点的内容。请先清理缓存，再执行单块操作。",
    );
  }
}

/** 用序列化后的锚点覆盖指定行；行号越界说明缓存已被外部修改，直接抛错。 */
function replaceAnchorLine(
  lines: string[],
  lineIndex: number,
  anchor: BlockAnchor,
): void {
  if (lineIndex < 0 || lineIndex >= lines.length) {
    throw new Error("无法定位译文锚点所在的行。");
  }
  lines[lineIndex] = serializeAnchor(anchor);
}

/** `replaceCachedBlock` 的输入；`target` 必须来自当前 `cache`。 */
export interface ReplaceCachedBlockInput {
  cacheText: string;
  cache: CacheDocument;
  target: AnchoredBlock;
  content: string;
  /** 当前原文哈希，写入新锚点的 `src`。 */
  sourceHash: string;
  sourceKind: BlockKind;
  mode: AnchorMode;
  md: MarkdownIt;
}

/**
 * 替换指定缓存块的正文并重写锚点。
 *
 * 流程：
 * 1. 校验缓存可编辑、正文非空；
 * 2. 先写入带旧 `dst` 的锚点与正文；
 * 3. 重新解析，确认正文没有裂成多个块、仍能按 id 找到、类型未变；
 * 4. 用实际解析出的块哈希回填 `dst`，再解析一次确认结果可解析。
 *
 * 不写文件；失败时抛中文错误，调用方（`SyncService`）负责持久化。
 */
export function replaceCachedBlock(input: ReplaceCachedBlockInput): EditedCache {
  assertEditable(input.cache);
  const content = normalizeBlockContent(input.content);
  if (!content.trim()) {
    throw new Error("译文为空，已拒绝写入。");
  }

  const lines = normalizeNewlines(input.cacheText).split("\n");
  const draftAnchor: BlockAnchor = {
    id: input.target.anchor.id,
    kind: input.sourceKind,
    src: input.sourceHash,
    dst: input.target.anchor.dst,
    mode: input.mode,
  };
  replaceAnchorLine(lines, input.target.anchorLine, draftAnchor);
  // 替换块覆盖的行；内容行数可变，但锚点位于其上方，行号不受影响。
  lines.splice(
    input.target.block.startLine,
    input.target.block.endLine - input.target.block.startLine,
    ...content.split("\n"),
  );

  const draftText = lines.join("\n");
  const draft = parseCacheDocument(draftText, input.md);
  // 正常译文应当仍是一个带锚点的块；出现未跟踪块通常意味着译文里混入了空行或块结构。
  if (draft.untracked.length > 0) {
    throw new Error(
      "译文被解析成了多个块。请检查译文中是否出现了多余的空行或块级结构。",
    );
  }
  const draftBlock = draft.blocks.find(
    (item) => item.anchor.id === input.target.anchor.id,
  );
  if (!draftBlock) {
    throw new Error("无法在修改后的缓存中定位该译文块。");
  }
  // 墓碑内容会被解析成普通块，类型可能与原文不同，因此仅对删除模式放行。
  if (
    draftBlock.block.kind !== input.sourceKind &&
    input.mode !== "deleted"
  ) {
    throw new Error(
      `译文结构从 ${input.sourceKind} 变成了 ${draftBlock.block.kind}，已拒绝写入。`,
    );
  }

  // dst 必须等于实际解析出的块哈希，否则下次读取会被误判为“人工改写”。
  const finalAnchor: BlockAnchor = {
    ...draftAnchor,
    dst: draftBlock.block.hash,
  };
  replaceAnchorLine(lines, input.target.anchorLine, finalAnchor);
  const finalText = lines.join("\n");
  const final = parseCacheDocument(finalText, input.md);
  const finalBlock = final.blocks.find(
    (item) => item.anchor.id === finalAnchor.id,
  );
  if (!finalBlock) {
    throw new Error("写入后的译文块无法重新解析。");
  }
  return { text: finalText, anchor: finalAnchor, block: finalBlock.block };
}

/** `markCachedBlockSynced` 的输入；`target` 必须来自当前 `cache`。 */
export interface MarkSyncedInput {
  cacheText: string;
  cache: CacheDocument;
  target: AnchoredBlock;
  sourceHash: string;
  md: MarkdownIt;
}

/**
 * 把缓存块标记为“已与当前原文同步”的人工译文。
 *
 * 仅改写锚点：`src` 更新为当前原文哈希、`dst` 取当前块哈希、`mode` 置为 `human`，
 * 正文保持不变。用于人工确认旧译文仍然适用于新原文，从而解除 `stale` 状态并锁定块。
 * 失败条件：缓存含未跟踪内容、锚点行失效、写回后无法重新解析。
 */
export function markCachedBlockSynced(input: MarkSyncedInput): EditedCache {
  assertEditable(input.cache);
  const lines = normalizeNewlines(input.cacheText).split("\n");
  const anchor: BlockAnchor = {
    ...input.target.anchor,
    src: input.sourceHash,
    dst: input.target.block.hash,
    mode: "human",
  };
  replaceAnchorLine(lines, input.target.anchorLine, anchor);
  const text = lines.join("\n");
  const final = parseCacheDocument(text, input.md);
  const finalBlock = final.blocks.find((item) => item.anchor.id === anchor.id);
  if (!finalBlock) {
    throw new Error("标记已同步后无法重新解析该译文块。");
  }
  return { text, anchor, block: finalBlock.block };
}
