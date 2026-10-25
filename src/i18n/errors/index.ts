/**
 * 运行时错误翻译 API。
 *
 * 用法：`throw new Error(tError("sync.missingBlock", { index: 3 }))`。
 * 先用 vscode.l10n.t 把英文模板翻译为当前 locale，再用 formatText 填充 `{name}`
 * 占位符。纯逻辑模块通过本 API 间接使用 vscode，避免在各处散落 vscode 调用。
 *
 * 内部日志（output.appendLine 的审计/诊断行）保持英文，不要经过本 API。
 */
import * as vscode from "vscode";
import { formatText } from "../format";
import { ERROR_MESSAGES, type ErrorKey } from "./catalog";

const MESSAGE_BY_KEY = new Map(
  ERROR_MESSAGES.map((message) => [message.key, message]),
);

/**
 * 翻译一条错误文案并填充占位符。
 *
 * @param key catalog 中登记的稳定 key。
 * @param values `{name}` 占位符取值；未提供的占位符原样保留。
 * @returns 当前 locale 下的错误文本。
 */
export function tError(
  key: ErrorKey,
  values: Record<string, string | number> = {},
): string {
  const message = MESSAGE_BY_KEY.get(key);
  // 类型上不可达；保留兜底以兼容热更新/构建产物不同步时的运行时调用。
  if (!message) {
    return formatText(String(key), values);
  }
  return formatText(
    vscode.l10n?.t(message.en) ?? message.en,
    values,
  );
}

export type { ErrorKey } from "./catalog";
