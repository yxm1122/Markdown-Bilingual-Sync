/**
 * 任务视图语言状态（纯逻辑）。
 *
 * 职责：把设置中的语言值转换为任务视图 state 的字段，并校验 webview 发来的原文/译文
 * 语言切换请求。TaskViewProvider 只负责读取配置、展示错误与写回设置，判定规则集中
 * 在这里，便于在 Node/Vitest 中覆盖非法值与大小写边界。
 *
 * 关键不变量：
 * - supportedLanguages 先经 normalizeSupportedLanguages 规范化；当前 sourceLanguage 与
 *   targetLanguage 合法且不在列表中（大小写不敏感）时追加到末尾，保证两个下拉框始终
 *   能显示当前值；
 * - 切换值必须位于 supportedLanguages，且不能与另一侧语言相同；
 * - 成功返回的 language 采用选项中的原始拼写，保证能与 <option> 精确匹配；
 * - 交换只在两侧都有效、都受支持且互不相同时成功。
 *
 * 与其他模块的关系：本模块不导入 vscode/DOM；language.ts 提供共享的 BCP-47 校验与
 * supportedLanguages 规范化。
 */
import { LANGUAGE_TAG, normalizeSupportedLanguages } from "../util/language";

/** 任务视图语言区展示与切换所需的字段。 */
export interface TaskViewLanguages {
  /** 当前原文语言；作为左侧下拉框选中值。 */
  sourceLanguage: string;
  /** 当前译文语言；作为右侧下拉框选中值。 */
  targetLanguage: string;
  /** 两个下拉框共用的选项，已完成规范化并包含当前原文/译文语言。 */
  supportedLanguages: string[];
}

/** 单侧语言切换请求的校验结果。 */
export type LanguageSelection =
  | { status: "ok"; language: string }
  | { status: "invalid"; language: string }
  | { status: "sameAsOther"; language: string };

/** 交换原文/译文语言的结果。 */
export type SwapLanguagesResult =
  | { status: "ok"; sourceLanguage: string; targetLanguage: string }
  | { status: "invalid" };

/** 把未知的设置值转成用于展示的字符串；非字符串与空值统一为空串。 */
function toText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * 构造任务视图的语言字段。
 *
 * sourceLanguage/targetLanguage 只做 trim，不在展示层修正用户配置；真正的合法性由
 * SyncService 在翻译前校验并给出既有错误文案。supportedLanguages 会兜底加入当前
 * sourceLanguage 与 targetLanguage，避免设置列表遗漏当前值时下拉框显示空白。
 *
 * @param sourceLanguage 设置中的原文语言原始值。
 * @param targetLanguage 设置中的译文语言原始值。
 * @param supportedLanguages 设置中的支持语言原始值。
 * @returns 可直接放入 state 的三个语言字段。
 */
export function buildTaskViewLanguages(
  sourceLanguage: unknown,
  targetLanguage: unknown,
  supportedLanguages: unknown,
): TaskViewLanguages {
  const source = toText(sourceLanguage);
  const target = toText(targetLanguage);
  const options = normalizeSupportedLanguages(supportedLanguages);
  const appendCurrent = (tag: string): void => {
    if (
      LANGUAGE_TAG.test(tag) &&
      !options.some((language) => language.toLowerCase() === tag.toLowerCase())
    ) {
      options.push(tag);
    }
  };
  appendCurrent(source);
  appendCurrent(target);
  return {
    sourceLanguage: source,
    targetLanguage: target,
    supportedLanguages: options,
  };
}

/**
 * 校验一次语言切换。
 *
 * 选项列表来自当前设置（已含当前原文/译文），因此先做大小写不敏感的选项匹配；
 * 命中后返回选项中的原始拼写，避免把页面传入的任意大小写写回设置。与另一侧语言
 * 相同（大小写不敏感）时拒绝，与 SyncService.getSettings 的约束保持一致。
 *
 * @param requested webview 消息中的 language 值（不可信）。
 * @param supportedLanguages 当前下拉框选项。
 * @param otherLanguage 另一侧的语言（切换原文时传译文，反之亦然）。
 * @returns 校验结果；invalid/sameAsOther 时 language 为便于提示的展示值。
 */
export function selectLanguage(
  requested: unknown,
  supportedLanguages: readonly string[],
  otherLanguage: string,
): LanguageSelection {
  const requestedTag = toText(requested);
  if (!requestedTag) {
    return { status: "invalid", language: "" };
  }
  const option = supportedLanguages.find(
    (language) => language.toLowerCase() === requestedTag.toLowerCase(),
  );
  if (!option) {
    return { status: "invalid", language: requestedTag };
  }
  if (option.toLowerCase() === otherLanguage.trim().toLowerCase()) {
    return { status: "sameAsOther", language: option };
  }
  return { status: "ok", language: option };
}

/**
 * 计算交换后的原文/译文语言。
 *
 * 交换后原文取旧译文、译文取旧原文；两侧都必须仍在当前选项中，且互不相同。任一侧
 * 缺失/非法或相同都会返回 invalid，由调用方提示并保持原配置。
 */
export function swapTaskViewLanguages(
  sourceLanguage: string,
  targetLanguage: string,
  supportedLanguages: readonly string[],
): SwapLanguagesResult {
  const nextSource = selectLanguage(
    targetLanguage,
    supportedLanguages,
    sourceLanguage,
  );
  if (nextSource.status !== "ok") {
    return { status: "invalid" };
  }
  const nextTarget = selectLanguage(
    sourceLanguage,
    supportedLanguages,
    targetLanguage,
  );
  if (nextTarget.status !== "ok") {
    return { status: "invalid" };
  }
  return {
    status: "ok",
    sourceLanguage: nextSource.language,
    targetLanguage: nextTarget.language,
  };
}
