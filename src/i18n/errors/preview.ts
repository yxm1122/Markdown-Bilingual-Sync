/**
 * 双语预览宿主侧（preview/previewManager）错误文案。
 */
import type { ErrorMessage } from "./types";

export const PREVIEW_ERRORS = [
  {
    key: "preview.pendingInsertMissing",
    en: "This pending insert block no longer exists.",
    zh: "这个待插入块已不存在。",
  },
  {
    key: "preview.restoreBufferRejected",
    en: "The workspace rejected restoring the source buffer.",
    zh: "工作区拒绝恢复原文缓冲区",
  },
] as const satisfies readonly ErrorMessage[];
