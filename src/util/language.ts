/**
 * 语言标签工具（Node / 扩展主进程，供缓存、导出、设置与任务面板复用）。
 *
 * 缓存文件与导出文件都按 `<文件名>.<主语言标签><扩展名>` 命名（缓存固定 .md，导出沿用
 * 原文扩展名），因此这里既决定产物路径，也是“如何识别目标语言导出文件”的唯一规则。
 * 另外集中提供 BCP-47 基础校验与“支持的语言”设置规范化，保证同步服务与任务面板对
 * 语言标签的判定一致。本模块为纯函数，不直接调用 vscode/DOM；错误文案通过 tError
 * 本地化，也不参与消息通信。
 */
import { tError } from "../i18n/errors";

/**
 * BCP-47 语言标签的基础校验规则。
 *
 * 只接受 `en`、`zh-CN`、`zh-Hans-CN` 这类由字母主语言标签和 1–8 位字母数字子标签
 * 组成的值；不追求完整的 BCP-47 语法，也不做 extlang/private-use 等扩展校验。
 * 同步服务与 supportedLanguages 共用该规则，避免两处判定漂移。
 */
export const LANGUAGE_TAG = /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/;

/**
 * 规范化 markdownBilingualSync.supportedLanguages 设置值。
 *
 * 规则：只保留字符串项，逐项 trim；忽略空值、非字符串与不符合 BCP-47 基础规则的项；
 * 按转小写后的标签去重（大小写不敏感，保留首次出现的拼写与顺序）。输入不是数组时
 * 返回空数组，调用方负责再把当前 targetLanguage 兜底加入选项。
 *
 * @param value 来自 VS Code 设置的原始值（可能被用户改成任意类型）。
 * @returns 去重后的合法语言标签，保持设置中的相对顺序。
 */
export function normalizeSupportedLanguages(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const result: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string") {
      continue;
    }
    const tag = item.trim();
    if (!tag || !LANGUAGE_TAG.test(tag)) {
      continue;
    }
    const key = tag.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(tag);
  }
  return result;
}

/**
 * 扩展支持的编辑器语言 ID。
 *
 * `skill` 是 Qoder 等环境为部分 Markdown 文件提供的语言 ID；文件内容仍是 Markdown，
 * 因此缓存、导出与切块逻辑无需区分，只在激活事件、菜单与活动编辑器判断中放行。
 */
export const SUPPORTED_LANGUAGE_IDS = ["markdown", "skill"] as const;

/** 判断语言 ID 是否属于扩展支持的范围。纯函数。 */
export function isSupportedLanguageId(languageId: string): boolean {
  return (SUPPORTED_LANGUAGE_IDS as readonly string[]).includes(languageId);
}

/**
 * 取 BCP-47 标签的主语言子标签并转小写，作为文件后缀。
 *
 * 例如 zh-CN → zh、ja-JP → ja、en → en。只允许 1–8 位字母数字，避免把用户设置原样
 * 拼进文件名而引入 `/`、`..` 等路径字符。设置值不合法时抛出本地化错误，交由命令层提示。
 * 注意：zh-CN 与 zh-TW 会得到同一个后缀，切换地区变体会复用/覆盖同一个缓存与导出文件。
 *
 * @param targetLanguage 译文语言标签（如 zh-CN；通常已通过 BCP-47 校验）。
 * @returns 小写的主语言标签（不含地区/文字子标签）。
 * @throws 无法得到合法的 [a-z0-9]{1,8} 后缀时抛出。
 */
export function languageSuffix(targetLanguage: string): string {
  const suffix = targetLanguage.split("-")[0]?.toLowerCase() ?? "";
  if (!/^[a-z0-9]{1,8}$/.test(suffix)) {
    throw new Error(
      tError("language.invalidSuffix", { language: targetLanguage }),
    );
  }
  return suffix;
}
