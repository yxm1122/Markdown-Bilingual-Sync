/**
 * 译文删除标记（`mbs-deleted`）的编码与解码。
 *
 * 职责：当用户删除某个块的译文、但希望保留“已删除”这一决策与可恢复的备份时，把
 * 备份信息压成单行 HTML 注释，作为该块的缓存内容。
 *
 * 关键不变量：
 * - 标记必须独占一行，格式为 `<!-- mbs-deleted:<base64url(JSON)> -->`；
 * - 兼容旧版无载荷的 `<!-- mbs-deleted -->`，解码为 `{ none: true }`；
 * - 载荷中的正文限制 500000 字符，模式只允许 human/auto/copy/target；任何不符合
 *   约束的标记都解码为 `null`，调用方按无效内容处理。
 *
 * 与其他模块的关系：`syncService.deleteTargetBlock` / `undoDeleteTargetBlock` 负责
 * 写入与恢复；`sync.mergeTargetEntries` 用 `isDeletedMarker` 丢弃已被删除的
 * target-only 块；`align` 仅依据锚点 `mode === "deleted"` 判断墓碑。
 */
import type { AnchorMode, BlockKind } from "../markdown/types";

/** 删除标记中携带的恢复信息；`none` 表示没有可恢复内容。 */
export interface DeletedBackup {
  /** 为 true 时表示旧式墓碑或“原文块从未翻译过”的删除。 */
  none?: boolean;
  /** 删除前的锚点模式，撤销时据此恢复。 */
  mode?: AnchorMode;
  /** 删除前的译文正文；撤销时原样写回。 */
  content?: string;
  /** 删除前的块类型，仅持久化备查；当前恢复流程不读取它。 */
  kind?: BlockKind;
  /** 删除时的原文哈希，撤销时用于保留“基于旧原文”的过期状态。 */
  sourceHash?: string;
}

const MARKER_PATTERN = /^<!-- mbs-deleted:([A-Za-z0-9_-]+) -->$/;
const LEGACY_MARKER = "<!-- mbs-deleted -->";
const MAX_CONTENT = 500_000;

/**
 * 生成删除标记。
 *
 * 使用 base64url 而不是原文 JSON，避免正文中的 `-->`、换行等破坏 HTML 注释结构，
 * 同时保证整个标记仍是一行。无备份时写入 `{ none: true }`。
 */
export function createDeletedMarker(backup?: DeletedBackup): string {
  const payload = JSON.stringify(backup ?? { none: true });
  return `<!-- mbs-deleted:${Buffer.from(payload, "utf8").toString("base64url")} -->`;
}

/** 判断一段文本（允许首尾空白）是否为删除标记，兼容旧版格式。 */
export function isDeletedMarker(text: string): boolean {
  const trimmed = text.trim();
  return trimmed === LEGACY_MARKER || MARKER_PATTERN.test(trimmed);
}

/**
 * 解析删除标记并校验载荷。
 *
 * 返回 `null` 表示不是标记或载荷不可信（非 JSON、缺少正文、正文超限、模式非法）。
 * 旧式标记返回 `{ none: true }`。不抛错、无副作用。
 */
export function parseDeletedMarker(text: string): DeletedBackup | null {
  const trimmed = text.trim();
  if (trimmed === LEGACY_MARKER) {
    return { none: true };
  }
  const match = MARKER_PATTERN.exec(trimmed);
  if (!match) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(match[1], "base64url").toString("utf8"),
    );
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    const record = parsed as Record<string, unknown>;
    if (record.none === true) {
      return { none: true };
    }
    // 没有可恢复正文的墓碑等价于“从未翻译”，撤销时只移除条目。
    if (typeof record.content !== "string" || !record.content.trim()) {
      return null;
    }
    if (record.content.length > MAX_CONTENT) {
      return null;
    }
    // 只允许可恢复的普通模式，禁止 deleted 嵌套（撤销会再次得到墓碑）。
    const mode =
      record.mode === "human" ||
      record.mode === "auto" ||
      record.mode === "copy" ||
      record.mode === "target"
        ? record.mode
        : undefined;
    if (!mode) {
      return null;
    }
    // kind 仅作展示提示，未做枚举校验；sourceHash 也只限制长度，调用方需自行兜底。
    const kind = typeof record.kind === "string" ? record.kind : undefined;
    return {
      mode,
      content: record.content,
      kind: kind as BlockKind | undefined,
      sourceHash:
        typeof record.sourceHash === "string" &&
        record.sourceHash.length <= 128
          ? record.sourceHash
          : undefined,
    };
  } catch {
    return null;
  }
}
