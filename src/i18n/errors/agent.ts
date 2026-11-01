/**
 * Agent 工具（Language Model Tools）错误文案。
 *
 * 这些错误会作为工具结果返回给模型，因此 message 要具体、可操作；hint 由
 * AgentService 从 UI_TEXT.agent 中补充。
 */
import type { ErrorMessage } from "./types";

export const AGENT_ERRORS = [
  {
    key: "agent.noActiveEditor",
    en: "Open a Markdown or Skill file, or pass the file path explicitly.",
    zh: "请先打开一个 Markdown 或 Skill 文件，或显式传入 file 路径。",
  },
  {
    key: "agent.fileNotFound",
    en: "File “{file}” does not exist or cannot be opened.",
    zh: "文件“{file}”不存在或无法打开。",
  },
  {
    key: "agent.ambiguousFile",
    en: "The relative path “{file}” matches more than one workspace file: {matches}.",
    zh: "相对路径“{file}”匹配到多个工作区文件：{matches}。",
  },
  {
    key: "agent.notMarkdown",
    en: "File “{file}” is not a Markdown or Skill document.",
    zh: "文件“{file}”不是 Markdown 或 Skill 文档。",
  },
  {
    key: "agent.notLocalFile",
    en: "Only local files are supported.",
    zh: "仅支持本地文件。",
  },
  {
    key: "agent.cachePath",
    en: "The path points to an extension cache file. Pass the source Markdown file instead.",
    zh: "该路径指向扩展的译文缓存文件。请传入源 Markdown 文件。",
  },
  {
    key: "agent.glossaryPath",
    en: "The path points to a glossary file. Use the glossary tools instead.",
    zh: "该路径指向术语表文件。请改用术语表工具。",
  },
  {
    key: "agent.noWorkspace",
    en: "No workspace folder is open, so the workspace glossary and relative paths are unavailable.",
    zh: "当前没有打开工作区，无法使用工作区术语表或相对路径。",
  },
  {
    key: "agent.summaryRequired",
    en: "A document brief needs a non-empty summary. Provide summary in this request, or generate the brief in the preview first.",
    zh: "文档简报需要一份非空摘要。请在同一次请求中提供 summary，或先在预览中生成文档简报。",
  },
  {
    key: "agent.invalidFileInput",
    en: "file must be a string path.",
    zh: "file 必须是字符串路径。",
  },
  {
    key: "agent.invalidRelativePath",
    en: "The relative path “{file}” is empty, escapes the workspace, or is absolute.",
    zh: "相对路径“{file}”为空、越出工作区或为绝对路径。",
  },
  {
    key: "agent.noChanges",
    en: "No changes were requested. Provide summary, brief, entries, or remove.",
    zh: "没有请求任何修改。请提供 summary、brief、entries 或 remove。",
  },
  {
    key: "agent.invalidScope",
    en: "scope must be global, workspace, or effective.",
    zh: "scope 必须是 global、workspace 或 effective。",
  },
  {
    key: "agent.unexpected",
    en: "The tool failed: {message}",
    zh: "工具执行失败：{message}",
  },
] as const satisfies readonly ErrorMessage[];
