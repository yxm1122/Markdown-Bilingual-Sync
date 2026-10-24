/**
 * 译文缓存锚点的序列化、校验与解析。
 *
 * 职责：
 * - 生成/识别形如 `<!-- mbs:{"id":…,"kind":…,"src":…,"dst":…,"mode":…} -->` 的单行锚点；
 * - 把缓存文本解析为 `CacheDocument`，并按“锚点行之后最近的块”完成归属。
 *
 * 关键不变量：
 * - 合法锚点行必须独占一行，id 在单个缓存内唯一，字段经过长度与字符集校验；
 * - 解析时把合法锚点行替换为空串而不是删除，`cleanedText` 与原始文本行数完全一致，
 *   因此 `anchorLine` 与块 `startLine` 可以直接交回 `editCache` 做行级替换；
 * - 重复或格式错误的锚点不会被信任，会按普通内容保留并写入 `warnings`，避免静默丢内容。
 *
 * 与其他模块的关系：`segmenter` 负责解析清理后的正文；`align` 依赖 `src`/`dst` 判断
 * 过期与人工锁定；`editCache`、`syncService` 依赖 `anchorLine` 精确改写缓存。
 */
import type { MarkdownIt } from "markdown-it";
import { normalizeNewlines } from "../util/hash";
import { parseMarkdownDocument } from "./segmenter";
import {
  BLOCK_KINDS,
  type AnchoredBlock,
  type AnchorMode,
  type BlockAnchor,
  type CacheDocument,
  type MarkdownBlock,
} from "./types";

const ANCHOR_LINE = /^\s*<!--\s*mbs:(\{.*\})\s*-->\s*$/;
const ANCHOR_PREFIX = /^\s*<!--\s*mbs:/;
const ANCHOR_MODES: ReadonlySet<AnchorMode> = new Set<AnchorMode>([
  "auto",
  "human",
  "copy",
  "target",
  "deleted",
]);

/** 校验字符串字段：限制长度与字符集，避免锚点把任意或超长内容带进缓存。 */
function isField(value: unknown, pattern: RegExp, maxLength: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maxLength &&
    pattern.test(value)
  );
}

/** 判断任意值是否为合法锚点模式。 */
export function isAnchorMode(value: unknown): value is AnchorMode {
  return typeof value === "string" && ANCHOR_MODES.has(value as AnchorMode);
}

/**
 * 校验从 JSON 解析出的对象是否为可信锚点。
 *
 * `id` 限制 64 字符、`src`/`dst` 限制 128 字符，字符集只允许字母数字和 `-_`，
 * 这样锚点可以安全地写回单行注释，也不会携带换行等破坏结构的字符。
 */
export function isBlockAnchor(value: unknown): value is BlockAnchor {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const anchor = value as Record<string, unknown>;
  return (
    isField(anchor.id, /^[A-Za-z0-9_-]+$/, 64) &&
    typeof anchor.kind === "string" &&
    BLOCK_KINDS.has(anchor.kind as BlockAnchor["kind"]) &&
    isField(anchor.src, /^[A-Za-z0-9_-]+$/, 128) &&
    isField(anchor.dst, /^[A-Za-z0-9_-]+$/, 128) &&
    isAnchorMode(anchor.mode)
  );
}

/**
 * 解析一行锚点注释。
 *
 * 只接受完整合法的单行 JSON；JSON 损坏或字段校验失败时返回 `null`，由调用方决定
 * 是按普通内容保留还是告警。无副作用。
 */
export function parseAnchorLine(line: string): BlockAnchor | null {
  const match = ANCHOR_LINE.exec(line);
  if (!match) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(match[1]);
  } catch {
    return null;
  }
  return isBlockAnchor(parsed) ? parsed : null;
}

/** 判断一行是否“看起来像”锚点（前缀匹配），用于区分格式损坏的锚点与普通内容。 */
export function looksLikeAnchorLine(line: string): boolean {
  return ANCHOR_PREFIX.test(line);
}

/**
 * 把锚点序列化为单行 HTML 注释。
 *
 * 字段顺序固定，便于 diff；只输出已知字段，忽略对象上的额外属性。
 */
export function serializeAnchor(anchor: BlockAnchor): string {
  const payload = JSON.stringify({
    id: anchor.id,
    kind: anchor.kind,
    src: anchor.src,
    dst: anchor.dst,
    mode: anchor.mode,
  });
  return `<!-- mbs:${payload} -->`;
}

/**
 * 去掉所有合法锚点行。
 *
 * 注意：行数会减少，仅适合展示/导出等不依赖行号的场景；需要保持行号时必须使用
 * `parseCacheDocument` 的 `cleanedText`。
 */
export function stripAnchorLines(text: string): string {
  const lines = normalizeNewlines(text).split("\n");
  return lines.filter((line) => parseAnchorLine(line) === null).join("\n");
}

/**
 * 解析译文缓存文本。
 *
 * 处理流程：
 * 1. 扫描物理行，收集合法锚点并把对应行置空，保证后续块行号与原始文本一致；
 * 2. 用 markdown-it 解析清理后的文本；
 * 3. 把每个锚点分配给其后方最近的块：同一块前有多个锚点时只保留最后一个，其余记为
 *    orphan；块后没有锚点的进入 `untracked`；末尾多余的锚点同样记为 orphan；
 * 4. `mode: target` 的块进入 `targetBlocks`，不参与原文对齐。
 *
 * 副作用：无。结构异常会写入返回值的 `warnings`，不会抛错，调用方必须检查
 * `untracked` / `orphanAnchors` 后再决定是否写回。
 */
export function parseCacheDocument(
  text: string,
  md: MarkdownIt,
): CacheDocument {
  const normalized = normalizeNewlines(text);
  const lines = normalized.split("\n");
  const warnings: string[] = [];
  const cleanedLines = [...lines];
  const anchors: Array<{ line: number; anchor: BlockAnchor }> = [];
  const seenIds = new Set<string>();

  for (let i = 0; i < lines.length; i += 1) {
    const anchor = parseAnchorLine(lines[i]);
    if (anchor) {
      // id 重复说明缓存被手工复制/拼接；第二条不能再参与归属，否则会指向同一个块。
      if (seenIds.has(anchor.id)) {
        warnings.push(
          `第 ${i + 1} 行出现重复的锚点 id（${anchor.id}），该行已按普通内容保留。`,
        );
        continue;
      }
      seenIds.add(anchor.id);
      anchors.push({ line: i, anchor });
      cleanedLines[i] = "";
      continue;
    }
    if (looksLikeAnchorLine(lines[i])) {
      warnings.push(
        `第 ${i + 1} 行的锚点格式无效，该行已按普通内容保留。`,
      );
    }
  }

  const cleanedText = cleanedLines.join("\n");
  const parsed = parseMarkdownDocument(cleanedText, md);
  const blocks: AnchoredBlock[] = [];
  const targetBlocks: AnchoredBlock[] = [];
  const untracked: MarkdownBlock[] = [];
  const orphanAnchors: BlockAnchor[] = [];

  let anchorIndex = 0;
  let pending: Array<{ line: number; anchor: BlockAnchor }> = [];

  for (const block of parsed.blocks) {
    // 收集所有位于该块之前的锚点；正常情况下只应有一个。
    while (
      anchorIndex < anchors.length &&
      anchors[anchorIndex].line < block.startLine
    ) {
      pending.push(anchors[anchorIndex]);
      anchorIndex += 1;
    }
    if (pending.length === 0) {
      untracked.push(block);
      continue;
    }
    const chosen = pending[pending.length - 1];
    for (const extra of pending.slice(0, -1)) {
      orphanAnchors.push(extra.anchor);
    }
    pending = [];
    if (
      chosen.anchor.kind !== block.kind &&
      chosen.anchor.mode !== "deleted"
    ) {
      // 墓碑内容是标记文本，解析出的块类型与原文无关，故豁免类型一致性检查。
      warnings.push(
        `锚点 ${chosen.anchor.id} 记录的类型为 ${chosen.anchor.kind}，实际译文块为 ${block.kind}。`,
      );
    }
    const entry = {
      block,
      anchor: chosen.anchor,
      anchorLine: chosen.line,
    };
    if (chosen.anchor.mode === "target") {
      targetBlocks.push(entry);
    } else {
      blocks.push(entry);
    }
  }

  // 文末没有后续块的锚点全部视为孤立锚点，写回时会被丢弃。
  for (const leftover of pending) {
    orphanAnchors.push(leftover.anchor);
  }
  for (let i = anchorIndex; i < anchors.length; i += 1) {
    orphanAnchors.push(anchors[i].anchor);
  }

  if (untracked.length > 0) {
    warnings.push(
      `译文缓存中有 ${untracked.length} 个未带锚点的块，已标记为未跟踪内容。`,
    );
  }
  if (orphanAnchors.length > 0) {
    warnings.push(
      `译文缓存中有 ${orphanAnchors.length} 个锚点找不到对应译文块。`,
    );
  }

  return {
    frontmatter: parsed.frontmatter,
    blocks,
    targetBlocks,
    untracked,
    orphanAnchors,
    cleanedText,
    warnings,
  };
}
