/**
 * 缓存内全文摘要标记（cache/summaryMarker）。
 *
 * 摘要属于缓存元数据，不是翻译块。它被编码成单行 HTML 注释放在缓存顶部，
 * 解析缓存时剥离，序列化时写回；这样摘要随缓存文件一起保存/删除，
 * 又不会参与块对齐、译文统计或导出。
 */
import type { CacheSummary } from "../markdown/types";
import { normalizeNewlines, sha256 } from "../util/hash";

const PREFIX = "<!-- mbs-summary:";
const SUFFIX = " -->";
export const MAX_SUMMARY_CHARS = 50_000;

/** 计算整篇原文的摘要关联哈希；换行统一后再哈希，避免 CRLF 造成误判。 */
export function summarySourceHash(text: string): string {
  return sha256(normalizeNewlines(text));
}

/** 判断一行是否看起来像摘要标记（用于对损坏标记给出告警）。 */
export function looksLikeSummaryMarker(line: string): boolean {
  return line.trimStart().startsWith(PREFIX);
}

/**
 * 把摘要序列化为单行标记。内容使用 base64url JSON，避免摘要中的换行、
 * `-->` 或 Markdown 结构破坏缓存文件。
 */
export function createSummaryMarker(summary: CacheSummary): string {
  const payload = JSON.stringify({
    text: summary.text,
    sourceHash: summary.sourceHash,
    updatedAt: summary.updatedAt,
    ...(summary.model ? { model: summary.model } : {}),
  });
  return `${PREFIX}${Buffer.from(payload, "utf8").toString("base64url")}${SUFFIX}`;
}

/**
 * 解析摘要标记行；不是标记、Base64/JSON 损坏、字段缺失或摘要过长时返回 undefined。
 * 返回的文本已经去掉首尾空白，但保留内部换行。
 */
export function parseSummaryMarker(line: string): CacheSummary | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith(PREFIX) || !trimmed.endsWith(SUFFIX)) {
    return undefined;
  }
  const encoded = trimmed.slice(PREFIX.length, -SUFFIX.length).trim();
  if (!encoded) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(encoded, "base64url").toString("utf8"),
    );
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return undefined;
    }
    const record = parsed as Record<string, unknown>;
    const text = typeof record.text === "string" ? record.text.trim() : "";
    const sourceHash =
      typeof record.sourceHash === "string" ? record.sourceHash : "";
    const updatedAt =
      typeof record.updatedAt === "string" ? record.updatedAt : "";
    if (
      !text ||
      text.length > MAX_SUMMARY_CHARS ||
      !sourceHash ||
      !updatedAt
    ) {
      return undefined;
    }
    return {
      text,
      sourceHash,
      updatedAt,
      ...(typeof record.model === "string" && record.model
        ? { model: record.model }
        : {}),
    };
  } catch {
    return undefined;
  }
}
