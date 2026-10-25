/**
 * 扩展命令层（extension.ts）错误文案。
 */
import type { ErrorMessage } from "./types";

export const COMMAND_ERRORS = [
  {
    key: "commands.saveDirtyFailed",
    en: "Could not save {file}; the batch operation stopped.",
    zh: "无法保存 {file}，批量操作已停止。",
  },
] as const satisfies readonly ErrorMessage[];
