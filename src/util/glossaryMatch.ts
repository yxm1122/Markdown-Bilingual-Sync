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
  for (const suffix of ["s", "es", "ed", "ing", "d"]) {
    forms.add(`${head}${last}${suffix}`);
  }
  if (/[^aeiou]y$/i.test(last)) {
    forms.add(`${head}${last.slice(0, -1)}ies`);
  }
  return [...forms];
}

/** 拉丁术语按词边界和常见词形匹配；其他（含中文/混排）按子串匹配。 */
export function containsTerm(text: string, term: string): boolean {
  const clean = term.trim();
  if (!clean) return false;
  if (/^[A-Za-z0-9][A-Za-z0-9 _-]*$/.test(clean)) {
    return termForms(clean).some((form) =>
      new RegExp(
        `(?<![\\p{L}\\p{N}_])${escapeRegExp(form)}(?![\\p{L}\\p{N}_])`,
        "iu",
      ).test(text),
    );
  }
  return text.toLowerCase().includes(clean.toLowerCase());
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
