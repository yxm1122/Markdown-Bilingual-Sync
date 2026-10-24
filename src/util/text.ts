/**
 * Markdown 块正文的空白规范化（Node / 扩展主进程）。
 *
 * 用于把模型输出或用户编辑写入译文缓存前做轻量清理，并在“译文是否真的变化”比较中
 * 消除换行/首尾空白差异。这里不解析 Markdown 语义，也不处理缩进与块内空行。
 * 纯函数，不依赖 vscode/DOM，不参与消息通信。
 */

/**
 * 统一换行并去掉块首的纯空行与块尾全部空白。
 *
 * - CRLF / CR → LF，避免 Windows 与模型输出的换行差异；
 * - 只移除开头的换行字符（带空格的行不会被当作空行移除）；
 * - 块尾空白（含空格、制表符、换行）全部移除，块尾的 Markdown 硬换行因此不再保留。
 *
 * @param text 待规范化的块正文。
 * @returns 规范化后的正文。
 */
export function normalizeBlockContent(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/^\n+/, "")
    .replace(/\s+$/, "");
}
