/**
 * 术语表解析（glossary/glossary）
 *
 * 职责：把用户编辑的 glossary.json 解析为去重后的术语条目，并收集可展示的警告。
 * 术语只会作为提示词上下文与纯文本替换使用，不参与 Markdown 结构解析。
 *
 * 关键不变量：
 * - 最多保留 MAX_ENTRIES 条；source 不区分大小写去重，后出现的条目覆盖先出现的；
 * - 单项 source/target 去除首尾空白，超过 MAX_TERM_LENGTH 或缺失时忽略并警告；
 * - 解析失败抛本地化错误；可恢复问题通过 warnings 返回，不中断翻译。
 *
 * 外部依赖：仅 translation/types 的 GlossaryEntry；不做 I/O。
 */
import type { GlossaryEntry } from "../translation/types";
import { tError } from "../i18n/errors";

const MAX_ENTRIES = 1000;
const MAX_TERM_LENGTH = 200;

/** 解析结果：有效条目 + 可展示警告（不会包含重复项）。 */
export interface GlossaryLoadResult {
  entries: GlossaryEntry[];
  warnings: string[];
}

/** 判断值是否为普通对象（排除 null 与数组）。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** 读取术语字符串：trim 后非空且不超过长度上限，否则返回 undefined。 */
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
 * @throws JSON 语法错误或顶层结构不合法时抛出本地化错误。
 */
export function parseGlossaryText(text: string): GlossaryLoadResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(
      tError("glossary.invalidJson"),
    );
  }

  const rawEntries = Array.isArray(parsed)
    ? parsed
    : isRecord(parsed) && Array.isArray(parsed.entries)
      ? parsed.entries
      : undefined;
  if (!rawEntries) {
    throw new Error(
      tError("glossary.notArray"),
    );
  }

  const entries = new Map<string, GlossaryEntry>();
  const warnings: string[] = [];
  for (let index = 0; index < rawEntries.length; index += 1) {
    const raw = rawEntries[index];
    if (!isRecord(raw)) {
      warnings.push(tError("glossary.nonObject", { index: index + 1 }));
      continue;
    }
    const source = readTerm(raw.source);
    const target = readTerm(raw.target);
    if (!source || !target) {
      warnings.push(
        tError("glossary.invalidEntry", { index: index + 1, max: MAX_TERM_LENGTH }),
      );
      continue;
    }
    const key = source.toLowerCase();
    if (entries.has(key)) {
      warnings.push(
        tError("glossary.duplicateEntry", { index: index + 1, source: source }),
      );
    }
    if (!entries.has(key) && entries.size >= MAX_ENTRIES) {
      warnings.push(tError("glossary.limit", { max: MAX_ENTRIES }));
      break;
    }
    entries.set(key, { source, target });
  }

  return { entries: [...entries.values()], warnings };
}
