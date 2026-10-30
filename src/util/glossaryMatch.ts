/**
 * 术语匹配（纯函数）。
 *
 * 供评估指标与译后一致性检查共用：拉丁术语按词边界和常见词形匹配，
 * 中文/混排术语按子串匹配。术语只作为纯文本处理，不解析 Markdown。
 */
import type { GlossaryEntry } from "../translation/types";

/** 转义正则元字符，确保术语按字面量匹配。 */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 生成拉丁术语的常见词形（复数、过去式、进行时等）。
 *
 * 只做轻量词形覆盖，不引入词干分析器；目的是让 "blocks" 能命中 "block"、
 * "cached" 能命中 "cache"，而不是把术语限制为精确单数形式。
 */
function termForms(term: string): string[] {
  const clean = term.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9 _-]*$/.test(clean)) {
    return [];
  }
  const space = clean.lastIndexOf(" ");
  const head = space >= 0 ? clean.slice(0, space + 1) : "";
  const last = space >= 0 ? clean.slice(space + 1) : clean;
  const forms = new Set<string>([clean]);
  const add = (value: string): void => {
    forms.add(`${head}${value}`);
  };
  if (/[^aeiou]y$/i.test(last)) {
    const stem = last.slice(0, -1);
    add(`${stem}ies`);
    add(`${stem}ied`);
    add(`${last}ing`);
  } else {
    if (/(?:s|x|z|ch|sh)$/i.test(last)) {
      add(`${last}es`);
    } else {
      add(`${last}s`);
    }
    if (/e$/i.test(last)) {
      add(`${last}d`);
      add(`${last.slice(0, -1)}ing`);
    } else {
      add(`${last}ed`);
      add(`${last}ing`);
    }
  }
  return [...forms];
}

/** 判断是否为可用词边界/词形匹配的拉丁术语。 */
function isLatinTerm(term: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9 _-]*$/.test(term);
}

/** 拉丁术语按词边界和常见词形匹配；其他（含中文/混排）按子串匹配。 */
export function containsTerm(text: string, term: string): boolean {
  const clean = term.trim();
  if (!clean) return false;
  if (isLatinTerm(clean)) {
    return termForms(clean).some((form) =>
      new RegExp(
        `(?<![A-Za-z0-9_])${escapeRegExp(form)}(?![A-Za-z0-9_])`,
        "iu",
      ).test(text),
    );
  }
  return text.toLowerCase().includes(clean.toLowerCase());
}

/**
 * 统计术语在文本中出现的次数，供评估判断“只出现一次”的生成条目。
 * 拉丁术语按词边界和常见词形统计；其他按不重叠子串统计。
 */
export function countTermOccurrences(text: string, term: string): number {
  const clean = term.trim();
  if (!clean) return 0;
  if (isLatinTerm(clean)) {
    const pattern = termForms(clean).map(escapeRegExp).join("|");
    return (
      text.match(
        new RegExp(
          `(?<![A-Za-z0-9_])(?:${pattern})(?![A-Za-z0-9_])`,
          "giu",
        ),
      ) ?? []
    ).length;
  }
  const haystack = text.toLowerCase();
  const needle = clean.toLowerCase();
  let count = 0;
  let index = 0;
  while (index < haystack.length) {
    const found = haystack.indexOf(needle, index);
    if (found < 0) break;
    count += 1;
    index = found + needle.length;
  }
  return count;
}

/**
 * 找出目标文本中缺失的术语目标词。
 *
 * @param sourceText 已去掉受保护 Markdown 的源文。
 * @param targetText 译文（保留 Markdown 也可以；这里只做术语子串/词形匹配）。
 * @param glossary 需要检查的术语条目。
 * @returns 源文出现但译文未使用目标词的条目，按 glossary 顺序。
 */
export function findMissingGlossaryTerms(
  sourceText: string,
  targetText: string,
  glossary: readonly GlossaryEntry[],
): GlossaryEntry[] {
  const missing: GlossaryEntry[] = [];
  for (const entry of glossary) {
    if (!entry.source || !entry.target) {
      continue;
    }
    if (!containsTerm(sourceText, entry.source)) {
      continue;
    }
    if (!containsTerm(targetText, entry.target)) {
      missing.push(entry);
    }
  }
  return missing;
}
