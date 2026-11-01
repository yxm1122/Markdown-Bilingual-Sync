/**
 * 文档简报生成锁定（summaryLocks）。
 *
 * 锁定只影响“AI 生成文档简报”：被锁定的摘要、brief 字段或术语表不再进入
 * 生成请求，生成结果也不会覆盖缓存中的原值。锁定内容仍正常参与翻译/审校。
 *
 * 本模块保持纯逻辑，供宿主、Webview 与评估脚本共用；不读取配置、不访问文件。
 */

/** brief 的字段顺序；同时用于 UI 渲染、提示词拼装与缓存归一化。 */
export const BRIEF_FIELD_KEYS = [
  "audience",
  "toneAndStyle",
  "ambiguities",
  "doNotTranslate",
] as const;

export type BriefField = (typeof BRIEF_FIELD_KEYS)[number];

/** 文档简报的逐项锁定状态；缺省表示未锁定。 */
export interface SummaryLocks {
  /** 锁定全文摘要正文。 */
  summary?: boolean;
  /** 锁定单个翻译要求字段。 */
  brief?: Partial<Record<BriefField, boolean>>;
  /** 锁定文档术语表。 */
  glossary?: boolean;
}

/** Webview 与宿主共用的锁定目标。 */
export type SummaryLockTarget = "summary" | "glossary" | BriefField;

/** 一次生成实际请求的字段；true 表示需要 AI 生成。 */
export interface SummaryTargets {
  summary: boolean;
  glossary: boolean;
  brief: Record<BriefField, boolean>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** 校验并归一化不可信锁定状态（缓存、Webview 消息）；只接受显式 true。 */
export function normalizeSummaryLocks(raw: unknown): SummaryLocks {
  if (!isRecord(raw)) {
    return {};
  }
  const briefRaw = isRecord(raw.brief) ? raw.brief : {};
  const brief: Partial<Record<BriefField, boolean>> = {};
  for (const field of BRIEF_FIELD_KEYS) {
    if (briefRaw[field] === true) {
      brief[field] = true;
    }
  }
  return {
    ...(raw.summary === true ? { summary: true } : {}),
    ...(Object.keys(brief).length > 0 ? { brief } : {}),
    ...(raw.glossary === true ? { glossary: true } : {}),
  };
}

/** 是否至少锁定了一项。 */
export function hasSummaryLocks(locks: SummaryLocks | undefined): boolean {
  return Boolean(
    locks &&
      (locks.summary === true ||
        locks.glossary === true ||
        BRIEF_FIELD_KEYS.some((field) => locks.brief?.[field] === true)),
  );
}

/** 全部解锁。 */
export function allSummaryTargets(): SummaryTargets {
  return {
    summary: true,
    glossary: true,
    brief: Object.fromEntries(
      BRIEF_FIELD_KEYS.map((field) => [field, true]),
    ) as Record<BriefField, boolean>,
  };
}

/** 由锁定状态推导本次生成需要请求的字段。 */
export function summaryTargets(
  locks: SummaryLocks | undefined,
): SummaryTargets {
  const normalized = normalizeSummaryLocks(locks);
  return {
    summary: normalized.summary !== true,
    glossary: normalized.glossary !== true,
    brief: Object.fromEntries(
      BRIEF_FIELD_KEYS.map((field) => [
        field,
        normalized.brief?.[field] !== true,
      ]),
    ) as Record<BriefField, boolean>,
  };
}

/** brief 是否还有未锁定字段。 */
export function hasAnyBriefTarget(targets: SummaryTargets): boolean {
  return BRIEF_FIELD_KEYS.some((field) => targets.brief[field]);
}

/** 是否还有任何需要生成的字段；false 时不应发送生成请求。 */
export function hasAnySummaryTarget(targets: SummaryTargets): boolean {
  return targets.summary || targets.glossary || hasAnyBriefTarget(targets);
}

/** 切换单项锁定，返回归一化后的新状态。 */
export function withSummaryLock(
  locks: SummaryLocks | undefined,
  target: SummaryLockTarget,
  locked: boolean,
): SummaryLocks {
  const current = normalizeSummaryLocks(locks);
  if (target === "summary" || target === "glossary") {
    const next: SummaryLocks = { ...current };
    if (locked) {
      next[target] = true;
    } else {
      delete next[target];
    }
    return normalizeSummaryLocks(next);
  }
  const brief = { ...(current.brief ?? {}) };
  if (locked) {
    brief[target] = true;
  } else {
    delete brief[target];
  }
  const next: SummaryLocks = { ...current };
  if (Object.keys(brief).length > 0) {
    next.brief = brief;
  } else {
    delete next.brief;
  }
  return normalizeSummaryLocks(next);
}
