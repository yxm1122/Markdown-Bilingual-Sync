/**
 * 跨领域通用错误文案。
 *
 * 这里只放确实被多个模块复用的条目；领域专属文案放到同目录的 sync/cache/export/
 * import/translation 等文件中，由 catalog.ts 汇总。
 */
import type { ErrorMessage } from "./types";

export const COMMON_ERRORS = [
  {
    key: "common.operationCancelled",
    en: "Operation cancelled",
    zh: "操作已取消",
  },
  {
    key: "common.translationCancelled",
    en: "Translation cancelled",
    zh: "翻译已取消",
  },
  {
    key: "common.missingSourceBlock",
    en: "Source block {index} was not found.",
    zh: "找不到第 {index} 个原文块。",
  },
  {
    key: "common.missingInsertedSourceBlock",
    en: "The source block to insert after was not found: {index}.",
    zh: "找不到要插入到的原文块：{index}。",
  },
] as const satisfies readonly ErrorMessage[];
