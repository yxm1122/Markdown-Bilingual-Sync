/**
 * 受保护 Markdown 片段的提取与比较（纯函数）。
 *
 * 供评估指标与 Provider 输出校验共用：代码、URL、公式、HTML、脚注引用与
 * GitHub Alert 标记必须在译文中原样保留；链接文字、图片 alt 与链接 title 属于
 * 可翻译正文。统一在这里维护规则，避免评估与运行时校验口径不一致。
 *
 * 不依赖 vscode / DOM / 文件系统。
 */
import { findInlineCodeSpans } from "./protectedSyntax";

const FENCED_CODE = /```[\s\S]*?```|~~~[\s\S]*?~~~/g;
// 只捕获目标地址，不把可翻译的链接 title 当成受保护片段。
const LINK_DESTINATION =
  /!?\[[^\]]*\]\(\s*(<[^>\n]*>|[^)\s]+)(?:\s+(?:"[^"\n]*"|'[^'\n]*'|\([^)\n]*\)))?\s*\)/g;
const REFERENCE_DEFINITION = /^ {0,3}\[(?!\^)[^\]]+\]:\s*(\S+)/gm;
const BARE_URL = /https?:\/\/[^\s<>)]+/g;
const FOOTNOTE_REF = /\[\^[^\]]+\]/g;
const MATH_BLOCK = /\$\$[\s\S]*?\$\$/g;
const MATH_INLINE = /\$[^$\n]+\$/g;
const HTML_TAG = /<[^>\n]+>/g;
const ALERT_MARKER = /\[!(?:NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]/g;

/** 把行内代码片段替换为空格，供后续 URL/术语扫描跳过这些内容。 */
export function removeInlineCode(text: string): string {
  const spans = findInlineCodeSpans(text);
  let result = text;
  for (let index = spans.length - 1; index >= 0; index -= 1) {
    result = `${result.slice(0, spans[index].start)} ${result.slice(spans[index].end)}`;
  }
  return result;
}

/**
 * 提取需要在译文中原样保留的片段。
 *
 * 覆盖围栏代码、行内代码、链接/图片目标、引用式链接目标、裸 URL、脚注引用、
 * 块级/行内公式、HTML 标签与 GitHub Alert 标记。链接文字、图片 alt 和链接 title
 * 不在此列，它们应随正文翻译。返回按出现次数记录的片段（不去重），便于发现重复
 * 片段丢失。
 */
export function extractProtectedTokens(text: string): string[] {
  const tokens: string[] = [];
  let remaining = text;
  // 先取围栏代码并从后续扫描中移除，避免把代码内的反引号/URL 重复计数。
  for (const match of remaining.matchAll(FENCED_CODE)) {
    tokens.push(match[0]);
  }
  remaining = remaining.replace(FENCED_CODE, " ");
  for (const span of findInlineCodeSpans(remaining)) {
    tokens.push(span.raw);
  }
  remaining = removeInlineCode(remaining);
  for (const match of remaining.matchAll(LINK_DESTINATION)) {
    const destination = match[1]?.trim();
    if (destination) tokens.push(destination);
  }
  remaining = remaining.replace(LINK_DESTINATION, " ");
  for (const match of remaining.matchAll(REFERENCE_DEFINITION)) {
    const destination = match[1]?.trim();
    if (destination) tokens.push(destination);
  }
  remaining = remaining.replace(REFERENCE_DEFINITION, " ");
  for (const match of remaining.matchAll(BARE_URL)) {
    // 句末标点不属于 URL；否则中英混排时源/候选会因标点差异产生假缺失。
    const url = match[0].replace(/[.,;:!?，。；：！？]+$/u, "");
    if (url) tokens.push(url);
  }
  remaining = remaining.replace(BARE_URL, " ");
  for (const match of remaining.matchAll(FOOTNOTE_REF)) {
    tokens.push(match[0]);
  }
  remaining = remaining.replace(FOOTNOTE_REF, " ");
  for (const match of remaining.matchAll(MATH_BLOCK)) {
    tokens.push(match[0]);
  }
  remaining = remaining.replace(MATH_BLOCK, " ");
  for (const match of remaining.matchAll(MATH_INLINE)) {
    tokens.push(match[0]);
  }
  remaining = remaining.replace(MATH_INLINE, " ");
  for (const match of remaining.matchAll(HTML_TAG)) {
    tokens.push(match[0]);
  }
  remaining = remaining.replace(HTML_TAG, " ");
  for (const match of remaining.matchAll(ALERT_MARKER)) {
    tokens.push(match[0]);
  }
  return tokens;
}

/** 统计片段出现次数，供多重出现检查。 */
export function countProtectedTokens(
  tokens: readonly string[],
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const token of tokens) {
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }
  return counts;
}

/**
 * 找出源文有、译文缺失或次数不足的受保护片段。
 *
 * 返回可直接拼进错误/重试提示的文本；同一片段出现多次时会带上 `(found/expected)`
 * 计数，方便模型和用户定位。
 */
export function findMissingProtectedTokens(
  source: string,
  translated: string,
): string[] {
  const sourceCounts = countProtectedTokens(extractProtectedTokens(source));
  if (sourceCounts.size === 0) {
    return [];
  }
  const translatedCounts = countProtectedTokens(
    extractProtectedTokens(translated),
  );
  const missing: string[] = [];
  for (const [token, count] of sourceCounts) {
    const found = translatedCounts.get(token) ?? 0;
    if (found < count) {
      missing.push(found > 0 ? `${token} (${found}/${count})` : token);
    }
  }
  return missing;
}

/** 去掉受保护片段后的正文，用于术语出现位置判断。 */
export function stripProtectedForGlossary(text: string): string {
  return removeInlineCode(
    text
      .replace(FENCED_CODE, " ")
      .replace(LINK_DESTINATION, (match, destination: string) =>
        destination ? match.replace(destination, () => " ") : match,
      ),
  )
    .replace(REFERENCE_DEFINITION, " ")
    .replace(BARE_URL, " ")
    .replace(FOOTNOTE_REF, " ")
    .replace(MATH_BLOCK, " ")
    .replace(MATH_INLINE, " ")
    .replace(HTML_TAG, " ")
    .replace(ALERT_MARKER, " ");
}
