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
] as const satisfies readonly ErrorMessage[];
