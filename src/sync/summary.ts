/**
 * 同步结果的摘要文案。
 *
 * 职责：把 `SyncResult` 的计数套进 i18n 模板，生成一行可直接展示的中文摘要。
 * 不变量：所有占位符都在 `UI_TEXT.extension.syncSummary` 中定义；没有保留过期块时
 * 不追加后缀。纯函数、无副作用；模板缺失占位符时由 `formatText` 原样保留。
 *
 * 与其他模块的关系：`extension.ts` 在同步成功后调用，预览/任务视图不依赖它。
 */
import { formatText, UI_TEXT } from "../i18n/zh";
import type { SyncResult } from "./sync";

/**
 * 生成“翻译 N 块，复制 N 块，保留译文 N 块（，保留过期 N 块）”摘要。
 *
 * `prefix` 默认“同步完成”，批量/重译场景可传入更具体的标题；仅统计本次结果，
 * 不包含失败详情（失败信息由调用方另行提示）。
 */
export function formatSyncSummary(
  result: SyncResult,
  prefix: string = UI_TEXT.extension.syncTitleSync,
): string {
  const stale =
    result.keptMachineStaleCount > 0
      ? formatText(UI_TEXT.extension.syncSummaryStaleSuffix, {
          count: result.keptMachineStaleCount,
        })
      : "";
  return formatText(UI_TEXT.extension.syncSummary, {
    prefix,
    translated: result.translatedCount,
    copied: result.copiedCount,
    human: result.humanLockedCount,
    stale,
  });
}
