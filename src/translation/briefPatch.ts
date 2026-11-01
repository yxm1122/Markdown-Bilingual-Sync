/**
 * 文档简报字段补丁（纯逻辑）。
 *
 * brief 是四个固定字段的可选文本；语言模型工具和后续编辑都按“只改传入字段”的
 * 方式合并：字段缺省表示保持，空字符串表示清除。超长字段直接报错，不静默截断。
 *
 * 本模块不读写缓存、不访问配置。
 */
import { tError } from "../i18n/errors";
import { BRIEF_FIELD_KEYS, type BriefField } from "./summaryLocks";
import { MAX_BRIEF_FIELD_CHARS, type TranslationBrief } from "./types";

/** 单个字段的校验问题。 */
export type BriefPatchIssue =
  | { code: "not-object" }
  | { code: "unknown-field"; field: string }
  | { code: "invalid-value"; field: string }
  | { code: "too-long"; field: string; length: number; max: number };

export interface BriefPatchResult {
  /** 合并后的完整 brief；issues 非空时不得写盘。 */
  brief: TranslationBrief;
  /** 实际发生变化的字段（按字段声明顺序）。 */
  changed: BriefField[];
  /** 被空字符串清除的字段。 */
  cleared: BriefField[];
  issues: BriefPatchIssue[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * 把补丁合并到现有 brief。
 *
 * @param current 当前缓存的 brief；缺省视为空。
 * @param patch 未校验的补丁；undefined 表示不修改。
 * @returns 合并结果与校验问题；出现问题时不保证 brief 反映全部输入。
 */
export function applyBriefPatch(
  current: TranslationBrief | undefined,
  patch: unknown,
): BriefPatchResult {
  const brief: TranslationBrief = { ...(current ?? {}) };
  const changed: BriefField[] = [];
  const cleared: BriefField[] = [];
  const issues: BriefPatchIssue[] = [];

  if (patch === undefined) {
    return { brief, changed, cleared, issues };
  }
  if (!isRecord(patch)) {
    return {
      brief,
      changed,
      cleared,
      issues: [{ code: "not-object" }],
    };
  }

  const knownFields = new Set<string>(BRIEF_FIELD_KEYS);
  for (const [field, rawValue] of Object.entries(patch)) {
    if (!knownFields.has(field)) {
      issues.push({ code: "unknown-field", field });
      continue;
    }
    const key = field as BriefField;
    if (typeof rawValue !== "string") {
      issues.push({ code: "invalid-value", field });
      continue;
    }
    const value = rawValue.trim();
    const previous = brief[key] ?? "";
    if (!value) {
      if (brief[key] !== undefined) {
        delete brief[key];
      }
      if (previous) {
        changed.push(key);
        cleared.push(key);
      }
      continue;
    }
    if (value.length > MAX_BRIEF_FIELD_CHARS) {
      issues.push({
        code: "too-long",
        field,
        length: value.length,
        max: MAX_BRIEF_FIELD_CHARS,
      });
      continue;
    }
    brief[key] = value;
    if (value !== previous) {
      changed.push(key);
    }
  }

  return {
    brief,
    changed: [...new Set(changed)],
    cleared: [...new Set(cleared)],
    issues,
  };
}

/** 把字段补丁问题转换为当前 locale 的错误文本。 */
export function briefPatchMessage(issue: BriefPatchIssue): string {
  switch (issue.code) {
    case "not-object":
      return tError("sync.briefNotObject");
    case "unknown-field":
      return tError("sync.briefUnknownField", { field: issue.field });
    case "invalid-value":
      return tError("sync.briefInvalidValue", { field: issue.field });
    case "too-long":
      return tError("sync.briefFieldTooLong", {
        field: issue.field,
        length: issue.length,
        max: issue.max,
      });
  }
}

/** brief 补丁校验失败；caller 应直接展示 message，不写缓存。 */
export class BriefPatchError extends Error {
  constructor(readonly issues: readonly BriefPatchIssue[]) {
    super(briefPatchMessage(issues[0] ?? { code: "not-object" }));
    this.name = "BriefPatchError";
  }
}
