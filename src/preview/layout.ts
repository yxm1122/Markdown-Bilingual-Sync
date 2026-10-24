/**
 * 预览布局与只读状态的最小描述模块。
 *
 * 职责：
 * - 定义双语预览的三种布局（并排 columns / 交错 stacked / 分栏 split）；
 * - 定义分栏时左右栏的只读开关；
 * - 提供布局值的运行时归一化，并暴露持久化到 globalState 的键名。
 *
 * 数据流：Webview 的 `setLayout` 消息 -> PreviewManager.onMessage -> 本模块的
 * `normalizePreviewLayout` -> PreviewManager.setPreviewLayout 写入 globalState
 * -> 逐个预览面板重新渲染 HTML。
 *
 * 关键不变量：
 * - 布局值只能是 columns / stacked / split 之一，非法值统一回退；
 * - 只读状态按面板保存在内存中，不持久化，且只影响分栏（split）渲染；
 *   columns / stacked 布局忽略只读标记。
 */

/** 预览布局：并排（columns）、交错（stacked）、分栏（split）。 */
export type PreviewLayout = "columns" | "stacked" | "split";

/**
 * 分栏布局下左右栏的只读状态。
 * 为 `true` 时该栏按连续文档整体渲染，隐藏块级操作按钮与内联编辑。
 */
export interface PreviewReadonlyState {
  /** 原文栏是否只读。 */
  source: boolean;
  /** 译文栏是否只读。 */
  target: boolean;
}

/** `ExtensionContext.globalState` 中保存预览布局偏好的键名。 */
export const PREVIEW_LAYOUT_STATE_KEY = "markdownBilingualSync.previewLayout";

/**
 * 将任意输入归一化为合法布局。
 *
 * @param value 可能来自 Webview 消息或 globalState，类型不可信。
 * @param fallback 输入非法时返回的布局，默认 `columns`；由调用方保证其自身合法。
 * @returns 合法布局值。纯函数，不抛错、不产生副作用。
 */
export function normalizePreviewLayout(
  value: unknown,
  fallback: PreviewLayout = "columns",
): PreviewLayout {
  return value === "columns" || value === "stacked" || value === "split"
    ? value
    : fallback;
}
