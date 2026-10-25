/**
 * 语言标签与文件后缀相关错误文案。
 */
import type { ErrorMessage } from "./types";

export const LANGUAGE_ERRORS = [
  {
    key: "language.invalidSuffix",
    en: "Cannot generate a file suffix from target language “{language}”. Check the targetLanguage setting.",
    zh: "无法从译文语言“{language}”生成文件后缀，请检查 targetLanguage 设置。",
  },
] as const satisfies readonly ErrorMessage[];
