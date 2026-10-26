/**
 * 文档术语表的文本编辑格式（纯函数）。
 *
 * 缓存中的文档术语表是结构化条目；预览用一个简单的“source => target”文本域
 * 让用户检查/修改。这里负责两种表示之间的转换与逐行校验。
 *
 * 约定：
 * - 每行一个条目，按第一个 `=>` 分割；空行与 `#` 开头的注释行忽略；
 * - source/target 去首尾空白后必须非空且不超过 MAX_TERM_LENGTH；
 * - 同名 source 不区分大小写去重，后出现的覆盖前面的；
 * - 最多保留 MAX_DOCUMENT_GLOSSARY_ENTRIES 条，超出部分跳过并标记 overflow。
 */
import type { GlossaryEntry } from "../translation/types";
import {
  MAX_DOCUMENT_GLOSSARY_ENTRIES,
  MAX_TERM_LENGTH,
} from "./glossary";

/** 文本域的解析结果；错误只记录行号，由 UI 统一本地化。 */
export interface DocumentGlossaryParseResult {
  entries: GlossaryEntry[];
  /** 分隔符缺失/字段为空/超长的行号（1 基）。 */
  errorLines: number[];
  /** 是否因超过条数上限而丢弃了额外条目。 */
  overflow: boolean;
}

/** 把文档术语表格式化为文本域内容；保持现有顺序。 */
export function formatDocumentGlossary(
  entries: readonly GlossaryEntry[],
): string {
  return entries
    .map((entry) => `${entry.source} => ${entry.target}`)
    .join("\n");
}

/** 解析文本域内容；不抛错，问题通过行号返回。 */
export function parseDocumentGlossaryText(
  text: string,
): DocumentGlossaryParseResult {
  const entries = new Map<string, GlossaryEntry>();
  const errorLines: number[] = [];
  let overflow = false;
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const separator = line.indexOf("=>");
    if (separator < 0) {
      errorLines.push(index + 1);
      continue;
    }
    const source = line.slice(0, separator).trim();
    const target = line.slice(separator + 2).trim();
    if (
      !source ||
      !target ||
      source.length > MAX_TERM_LENGTH ||
      target.length > MAX_TERM_LENGTH
    ) {
      errorLines.push(index + 1);
      continue;
    }
    const key = source.toLowerCase();
    if (!entries.has(key) && entries.size >= MAX_DOCUMENT_GLOSSARY_ENTRIES) {
      overflow = true;
      continue;
    }
    entries.set(key, { source, target });
  }
  return { entries: [...entries.values()], errorLines, overflow };
}
