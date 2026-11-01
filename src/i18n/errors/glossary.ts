/**
 * 术语表解析错误与警告文案。
 */
import type { ErrorMessage } from "./types";

export const GLOSSARY_ERRORS = [
  {
    key: "glossary.invalidJson",
    en: "The glossary file glossary.json is not valid JSON. Fix the syntax and retry.",
    zh: "术语表 glossary.json 不是有效的 JSON。请修正语法后重试。",
  },
  {
    key: "glossary.notArray",
    en: "The glossary must be a JSON array, for example [{\"source\":\"API\",\"target\":\"API endpoint\"}].",
    zh: "术语表必须是 JSON 数组，例如 [{\"source\":\"API\",\"target\":\"接口\"}]。",
  },
  {
    key: "glossary.nonObject",
    en: "Glossary entry {index} is not an object and was ignored.",
    zh: "术语表第 {index} 项不是对象，已忽略。",
  },
  {
    key: "glossary.invalidEntry",
    en: "Glossary entry {index} is missing source/target or exceeds {max} characters and was ignored.",
    zh: "术语表第 {index} 项的 source/target 缺失或超过 {max} 个字符，已忽略。",
  },
  {
    key: "glossary.duplicateEntry",
    en: "Glossary entry {index} duplicates “{source}”; the last entry was used.",
    zh: "术语表第 {index} 项与前面的“{source}”重复，已采用最后一条。",
  },
  {
    key: "glossary.limit",
    en: "The glossary supports at most {max} entries; extra entries were ignored.",
    zh: "术语表最多支持 {max} 条，额外的条目已忽略。",
  },
  {
    key: "glossary.fileError",
    en: "Glossary file “{file}” could not be loaded: {message}",
    zh: "术语表文件“{file}”加载失败：{message}",
  },
  {
    key: "glossary.writeError",
    en: "Glossary file “{file}” could not be written: {message}",
    zh: "术语表文件“{file}”写入失败：{message}",
  },
  {
    key: "glossary.noWorkspace",
    en: "No workspace folder is open, so the workspace glossary is unavailable. Open a folder or use the global glossary.",
    zh: "当前没有打开工作区，无法使用工作区术语表。请打开文件夹，或改用全局术语表。",
  },
  {
    key: "glossary.dirty",
    en: "The glossary file “{file}” has unsaved changes. Save or close it before updating the glossary.",
    zh: "术语表文件“{file}”有未保存的修改。请先保存或关闭文件，再更新术语表。",
  },
  {
    key: "glossary.invalidExisting",
    en: "The glossary file contains invalid entries or exceeds the {max}-entry limit (invalid items: {items}). Fix the file first, or use replace mode explicitly.",
    zh: "术语表文件包含无效条目或超过 {max} 条上限（无效项：{items}）。请先修正文件，或显式使用替换模式。",
  },
  {
    key: "glossary.updateFailed",
    en: "The glossary file could not be updated in the editor.",
    zh: "无法在编辑器中更新术语表文件。",
  },
  {
    key: "glossary.saveFailed",
    en: "The glossary file could not be saved.",
    zh: "术语表文件保存失败。",
  },
  {
    key: "glossary.patchNotArray",
    en: "Glossary entries must be a JSON array of objects with source and target strings.",
    zh: "术语表条目必须是包含 source 和 target 字符串的 JSON 数组。",
  },
  {
    key: "glossary.patchInvalidEntry",
    en: "Glossary entry {index} is invalid: source and target must be non-empty and no longer than {max} characters. Nothing was written.",
    zh: "术语表第 {index} 条无效：source/target 必须非空且不超过 {max} 个字符。未写入任何内容。",
  },
  {
    key: "glossary.patchTooMany",
    en: "The glossary would contain {count} entries, exceeding the {max}-entry limit. Nothing was written.",
    zh: "术语表将包含 {count} 条，超过 {max} 条上限。未写入任何内容。",
  },
  {
    key: "glossary.patchInvalidRemove",
    en: "remove item {index} must be a non-empty string no longer than {max} characters.",
    zh: "remove 第 {index} 项必须是非空且不超过 {max} 个字符的字符串。",
  },
  {
    key: "glossary.patchRemoveNotArray",
    en: "remove must be an array of source terms.",
    zh: "remove 必须是原文术语数组。",
  },
  {
    key: "glossary.patchRemoveWithReplace",
    en: "remove cannot be combined with replace mode; provide the complete list in entries instead.",
    zh: "remove 不能与替换模式同时使用；请直接在 entries 中提供完整列表。",
  },
  {
    key: "glossary.patchInvalidMode",
    en: "Glossary patch mode must be “merge” or “replace”.",
    zh: "术语表更新模式必须是“merge”或“replace”。",
  },
] as const satisfies readonly ErrorMessage[];
