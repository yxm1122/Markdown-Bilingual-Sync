/**
 * l10n 目录校验与 bundle 构建（纯模块，不依赖 vscode）。
 *
 * 输入：en.ts / zh.ts 的 UI 目录与 errors/*.ts 的错误目录。
 * 输出：bundle.l10n.json（source）与 bundle.l10n.zh-cn.json 的键值对。
 *
 * 校验规则：
 * - en/zh UI 目录的嵌套 key 必须完全一致，所有叶子必须是字符串；
 * - 每条文案的 en/zh `{name}` 占位符集合必须一致；
 * - 错误目录的 key 不得重复；
 * - 同一英文模板只允许对应同一条中文译文，避免 l10n bundle 键冲突。
 *
 * scripts/build-l10n.ts 与测试复用本模块，保证生成逻辑只有一份。
 */
import { UI_TEXT as EN_TEXT } from "./en";
import { ERROR_MESSAGES } from "./errors/catalog";
import type { ErrorMessage } from "./errors/types";
import { UI_TEXT as ZH_TEXT } from "./zh";

/** 一条目录校验问题；code 供测试断言，message 供构建日志展示。 */
export interface L10nIssue {
  code:
    | "invalid-value"
    | "missing-translation"
    | "extra-translation"
    | "placeholder-mismatch"
    | "duplicate-error-key"
    | "duplicate-english";
  message: string;
}

/** 生成结果；messageCount 为去重后的英文模板数量。 */
export interface L10nBundles {
  en: Record<string, string>;
  zh: Record<string, string>;
  messageCount: number;
}

interface CatalogLeaf {
  path: string;
  value: string;
}

interface MessagePair {
  en: string;
  zh: string;
  origin: string;
}

/** 提取模板中的 `{name}` 占位符（去重并按字典序排列，便于稳定比较）。 */
export function extractPlaceholders(template: string): string[] {
  const names = new Set<string>();
  for (const match of template.matchAll(/\{(\w+)\}/g)) {
    names.add(match[1]);
  }
  return [...names].sort();
}

/** 递归收集字符串叶子；路径用点号连接，便于错误定位。 */
function collectLeaves(
  value: unknown,
  prefix: string,
  leaves: CatalogLeaf[],
  issues: L10nIssue[],
  language: "en" | "zh",
): void {
  if (typeof value === "string") {
    leaves.push({ path: prefix, value });
    return;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    issues.push({
      code: "invalid-value",
      message: `${language} catalog value at "${prefix}" must be a string or object.`,
    });
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    collectLeaves(
      child,
      prefix ? `${prefix}.${key}` : key,
      leaves,
      issues,
      language,
    );
  }
}

/**
 * 校验 en/zh UI 目录与错误目录。
 *
 * @param en 英文 UI 目录（en.ts 的 UI_TEXT）。
 * @param zh 中文 UI 目录（zh.ts 的 UI_TEXT）。
 * @param errors 错误目录条目。
 * @returns 所有发现的问题；空数组表示通过。
 */
export function collectCatalogIssues(
  en: unknown,
  zh: unknown,
  errors: readonly ErrorMessage[],
): L10nIssue[] {
  const issues: L10nIssue[] = [];
  const enLeaves: CatalogLeaf[] = [];
  const zhLeaves: CatalogLeaf[] = [];
  collectLeaves(en, "", enLeaves, issues, "en");
  collectLeaves(zh, "", zhLeaves, issues, "zh");

  const enByPath = new Map(enLeaves.map((leaf) => [leaf.path, leaf.value]));
  const zhByPath = new Map(zhLeaves.map((leaf) => [leaf.path, leaf.value]));

  for (const [path, value] of enByPath) {
    const translation = zhByPath.get(path);
    if (translation === undefined) {
      issues.push({
        code: "missing-translation",
        message: `zh catalog is missing "${path}".`,
      });
      continue;
    }
    const enPlaceholders = extractPlaceholders(value);
    const zhPlaceholders = extractPlaceholders(translation);
    if (enPlaceholders.join(",") !== zhPlaceholders.join(",")) {
      issues.push({
        code: "placeholder-mismatch",
        message: `Placeholders differ at "${path}": en {${enPlaceholders.join(", ")}} vs zh {${zhPlaceholders.join(", ")}}.`,
      });
    }
  }
  for (const path of zhByPath.keys()) {
    if (!enByPath.has(path)) {
      issues.push({
        code: "extra-translation",
        message: `zh catalog has an extra key "${path}".`,
      });
    }
  }

  const errorKeys = new Set<string>();
  for (const error of errors) {
    if (errorKeys.has(error.key)) {
      issues.push({
        code: "duplicate-error-key",
        message: `Duplicate error key "${error.key}".`,
      });
    }
    errorKeys.add(error.key);
    const enPlaceholders = extractPlaceholders(error.en);
    const zhPlaceholders = extractPlaceholders(error.zh);
    if (enPlaceholders.join(",") !== zhPlaceholders.join(",")) {
      issues.push({
        code: "placeholder-mismatch",
        message: `Error "${error.key}" placeholders differ: en {${enPlaceholders.join(", ")}} vs zh {${zhPlaceholders.join(", ")}}.`,
      });
    }
  }

  return issues;
}

/** 收集所有 en -> zh 文案对，用于重复英文检测与 bundle 生成。 */
function collectMessagePairs(
  en: unknown,
  zh: unknown,
  errors: readonly ErrorMessage[],
): MessagePair[] {
  const pairs: MessagePair[] = [];
  const enLeaves: CatalogLeaf[] = [];
  const zhLeaves: CatalogLeaf[] = [];
  const ignored: L10nIssue[] = [];
  collectLeaves(en, "", enLeaves, ignored, "en");
  collectLeaves(zh, "", zhLeaves, ignored, "zh");
  const zhByPath = new Map(zhLeaves.map((leaf) => [leaf.path, leaf.value]));
  for (const leaf of enLeaves) {
    const translation = zhByPath.get(leaf.path);
    if (translation !== undefined) {
      pairs.push({ en: leaf.value, zh: translation, origin: leaf.path });
    }
  }
  for (const error of errors) {
    pairs.push({ en: error.en, zh: error.zh, origin: `errors.${error.key}` });
  }
  return pairs;
}

/** 检查同一英文模板是否被映射到不同中文；返回按 origin 描述的问题。 */
function collectDuplicateEnglishIssues(
  pairs: readonly MessagePair[],
): L10nIssue[] {
  const issues: L10nIssue[] = [];
  const byEnglish = new Map<string, MessagePair>();
  for (const pair of pairs) {
    const existing = byEnglish.get(pair.en);
    if (!existing) {
      byEnglish.set(pair.en, pair);
      continue;
    }
    if (existing.zh !== pair.zh) {
      issues.push({
        code: "duplicate-english",
        message: `English template "${pair.en}" maps to different Chinese text at "${existing.origin}" and "${pair.origin}".`,
      });
    }
  }
  return issues;
}

/**
 * 校验目录并生成两份 bundle。
 *
 * @throws Error 汇总后的目录问题；调用方（构建脚本/测试）直接展示消息。
 */
export function buildL10nBundles(): L10nBundles {
  const issues = [
    ...collectCatalogIssues(EN_TEXT, ZH_TEXT, ERROR_MESSAGES),
    ...collectDuplicateEnglishIssues(
      collectMessagePairs(EN_TEXT, ZH_TEXT, ERROR_MESSAGES),
    ),
  ];
  if (issues.length > 0) {
    throw new Error(
      `l10n catalog validation failed:\n${issues
        .map((issue) => `- [${issue.code}] ${issue.message}`)
        .join("\n")}`,
    );
  }

  const pairs = collectMessagePairs(EN_TEXT, ZH_TEXT, ERROR_MESSAGES);
  const en: Record<string, string> = {};
  const zh: Record<string, string> = {};
  for (const pair of pairs) {
    en[pair.en] = pair.en;
    zh[pair.en] = pair.zh;
  }
  // 稳定输出顺序，避免每次构建产生无意义 diff。
  const sortedEn = Object.fromEntries(
    Object.keys(en)
      .sort()
      .map((key) => [key, en[key]]),
  );
  const sortedZh = Object.fromEntries(
    Object.keys(zh)
      .sort()
      .map((key) => [key, zh[key]]),
  );
  return {
    en: sortedEn,
    zh: sortedZh,
    messageCount: Object.keys(en).length,
  };
}
