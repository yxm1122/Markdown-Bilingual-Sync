/**
 * 术语表解析（glossary/glossary）
 *
 * 职责：把用户编辑的 glossary.json 解析为去重后的术语条目，并收集可展示的警告。
 * 术语只会作为提示词上下文与纯文本替换使用，不参与 Markdown 结构解析。
 *
 * 关键不变量：
 * - 最多保留 MAX_ENTRIES 条；source 不区分大小写去重，后出现的条目覆盖先出现的；
 * - 单项 source/target 去除首尾空白，超过 MAX_TERM_LENGTH 或缺失时忽略并警告；
 * - 解析失败抛中文错误；可恢复问题通过 warnings 返回，不中断翻译。
 *
 * 外部依赖：仅 translation/types 的 GlossaryEntry；不做 I/O。
 */
import type { GlossaryEntry } from "../translation/types";

const MAX_ENTRIES = 1000;
const MAX_TERM_LENGTH = 200;

/** 解析结果：有效条目 + 可展示警告（不会包含重复项）。 */
export interface GlossaryLoadResult {
  entries: GlossaryEntry[];
  warnings: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readTerm(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const term = value.trim();
  return term && term.length <= MAX_TERM_LENGTH ? term : undefined;
}

/**
 * 解析术语表 JSON。
 * 支持顶层数组或 `{ "entries": [...] }` 两种形式。
 * @throws JSON 语法错误或顶层结构不合法时抛出中文错误。
 */
export function parseGlossaryText(text: string): GlossaryLoadResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(
      "术语表 glossary.json 不是有效的 JSON。请修正语法后重试。",
    );
  }

  const rawEntries = Array.isArray(parsed)
    ? parsed
    : isRecord(parsed) && Array.isArray(parsed.entries)
      ? parsed.entries
      : undefined;
  if (!rawEntries) {
    throw new Error(
      "术语表必须是 JSON 数组，例如 [{\"source\":\"API\",\"target\":\"接口\"}]。",
    );
  }

  const entries = new Map<string, GlossaryEntry>();
  const warnings: string[] = [];
  for (let index = 0; index < rawEntries.length; index += 1) {
    const raw = rawEntries[index];
    if (!isRecord(raw)) {
      warnings.push(`术语表第 ${index + 1} 项不是对象，已忽略。`);
      continue;
    }
    const source = readTerm(raw.source);
    const target = readTerm(raw.target);
    if (!source || !target) {
      warnings.push(
        `术语表第 ${index + 1} 项的 source/target 缺失或超过 ${MAX_TERM_LENGTH} 个字符，已忽略。`,
      );
      continue;
    }
    const key = source.toLowerCase();
    if (entries.has(key)) {
      warnings.push(
        `术语表第 ${index + 1} 项与前面的“${source}”重复，已采用最后一条。`,
      );
    }
    if (!entries.has(key) && entries.size >= MAX_ENTRIES) {
      warnings.push(`术语表最多支持 ${MAX_ENTRIES} 条，额外的条目已忽略。`);
      break;
    }
    entries.set(key, { source, target });
  }

  return { entries: [...entries.values()], warnings };
}
