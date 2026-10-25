/**
 * 运行时本地化入口（扩展宿主侧）。
 *
 * 职责：以 en.ts 为 source 目录，用 vscode.l10n.t 逐条翻译后导出 UI_TEXT，使现有
 * 调用方继续使用 `UI_TEXT.preview.actions.sync` 这类嵌套访问，无需感知 locale。
 * 同时提供 formatText 与当前界面 locale，供宿主渲染 Webview 使用。
 *
 * 数据来源：运行时翻译来自 l10n/bundle.l10n.<locale>.json（由 scripts/build-l10n.ts
 * 根据 en.ts / zh.ts 生成）；本模块不直接读取 zh.ts。测试通过 vitest alias 把
 * vscode 替换为 test/vscodeStub.ts，其 l10n.t 从 zh-cn bundle 取译文。
 *
 * 关键不变量：
 * - UI_TEXT 的 key 结构与 en.ts 完全一致，调用方不要修改返回值；
 * - 只在模块初始化时翻译一次，locale 变化需要重载窗口（VS Code l10n 的既有语义）；
 * - Webview 不能 import 本模块，文案仍由宿主序列化后注入。
 */
import * as vscode from "vscode";
import { UI_TEXT as EN_TEXT } from "./en";

/** 把英文字面量目录映射为同结构的 string 类型（保留只读修饰符）。 */
type Localized<T> = {
  [K in keyof T]: T[K] extends string ? string : Localized<T[K]>;
};

/**
 * 递归翻译文案目录。
 *
 * @param value en.ts 的嵌套字面量目录。
 * @returns 同结构、所有叶子替换为当前 locale 文案的对象。
 */
function localize<T>(value: T): Localized<T> {
  if (typeof value === "string") {
    // 理论上 VS Code 1.90+ 始终提供 l10n；保留回退便于旧宿主/测试桩直接加载。
    return (vscode.l10n?.t(value) ?? value) as Localized<T>;
  }
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(
    value as Record<string, unknown>,
  )) {
    result[key] = localize(item);
  }
  return result as Localized<T>;
}

/** 当前界面文案目录（英文 source 经 vscode.l10n.t 本地化）。 */
export const UI_TEXT: Localized<typeof EN_TEXT> = localize(EN_TEXT);

/** 当前 VS Code 显示语言（如 en、zh-cn），供 `<html lang>` 与 Intl 格式化使用。 */
export function getLocale(): string {
  return vscode.env?.language || "en";
}

export { formatDateTime, formatText } from "./format";
export type PreviewText = typeof UI_TEXT.preview;
