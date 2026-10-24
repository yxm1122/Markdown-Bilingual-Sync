/**
 * 哈希与块 ID 工具（Node / 扩展主进程）。
 *
 * 译文缓存用“内容哈希”判断原文或译文是否变化，用块 ID 稳定标识一个译文块；两者都会写入
 * 缓存文件，属于持久化格式的一部分，改动算法或长度会让已有缓存无法与原文对齐。
 * 本模块是纯函数集合，不依赖 vscode、DOM 或扩展宿主，也不参与任何消息通信，因此同样可被
 * scripts 下的本地脚本复用。
 */
import { createHash, randomUUID } from "node:crypto";

/**
 * 把 CRLF 与单独 CR 统一为 LF。
 * 跨平台读写（Windows 检出、模型输出）都依赖它保证哈希与内容比较稳定。
 * @param value 原始文本。
 * @returns 仅含 LF 换行的文本。
 */
export function normalizeNewlines(value: string): string {
  return value.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

/**
 * 计算完整 SHA-256 十六进制摘要。
 * 注意：这里不做换行规范化，需要跨平台一致的调用方应先使用 normalizeNewlines()。
 * @param value 待哈希文本（按 UTF-8 编码）。
 * @returns 64 个字符的小写十六进制字符串。
 */
export function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * 取 SHA-256 前 20 个十六进制字符（80 bit），用于目录键与块哈希。
 * 长度是缓存格式的一部分，不能随意调整。
 * @param value 待哈希文本。
 * @returns 20 个字符的小写十六进制字符串。
 */
export function shortHash(value: string): string {
  return sha256(value).slice(0, 20);
}

/**
 * 生成块内容指纹：块类型 + 规范化换行并去掉首尾空白后的正文。
 * 忽略首尾空白可以避免编辑器补/删空行被误判为“原文已更新”；块类型参与哈希，
 * 使同样文本在不同块类型（段落与标题等）之间不会互相命中。
 * @param kind 块类型（heading、paragraph、list 等）。
 * @param raw 块的原始 Markdown。
 * @returns 20 个字符的内容哈希。
 */
export function blockHash(kind: string, raw: string): string {
  return shortHash(`${kind}\n${normalizeNewlines(raw).trim()}`);
}

/**
 * 生成新的译文块 ID（UUID 去掉连字符后取前 12 位，即 48 bit 随机值）。
 * 仅用于本地缓存内的块标识；碰撞概率极低，但不适合作为安全标识。
 * @returns 12 位小写十六进制字符串。
 */
export function newBlockId(): string {
  return randomUUID().replace(/-/g, "").slice(0, 12);
}
