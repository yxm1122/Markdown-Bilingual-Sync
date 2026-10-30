/**
 * 本地批注的数据模型。
 *
 * AI 审校批注和用户批注共用同一份 sidecar；`author` 区分来源。
 * AI 批注是观察，用户批注是修改指令。
 *
 * 用户批注有两种生效方式：
 * - once：参与一次翻译后自动失效；
 * - persistent：持续参与后续翻译，直到删除或停用。
 *
 * 用户批注状态：
 * - pending：待生效；
 * - applied：上次参与翻译后译文有变化；
 * - ineffective：上次参与翻译后译文没有变化；
 * - resolved/dismissed：旧数据或人工归档，不参与翻译。
 * AI 批注仍使用 open/resolved/dismissed。
 */
import type {
  AnnotationSide,
  ReviewAnnotationType,
  ReviewOption,
  ReviewSeverity,
} from "../translation/types";

export type AnnotationAuthor = "ai" | "user";

export type AnnotationKind =
  | ReviewAnnotationType
  | "note"
  | "request-change";

export type AnnotationMode = "once" | "persistent";

export type AnnotationStatus =
  | "open"
  | "resolved"
  | "dismissed"
  | "pending"
  | "applied"
  | "ineffective";

/** 一条持久化批注。 */
export interface AnnotationRecord {
  /** 本地唯一 id（随机或时间戳）。 */
  id: string;
  /** 缓存锚点 id；无缓存块使用 `src-<sourceHash>`。 */
  blockId: string;
  side: AnnotationSide;
  author: AnnotationAuthor;
  kind: AnnotationKind;
  severity: ReviewSeverity;
  message: string;
  question?: string;
  /** AI 批注的可采纳指令或只读建议。 */
  options?: ReviewOption[];
  sourceExcerpt?: string;
  targetExcerpt?: string;
  /** 用户批注的生效方式；AI 批注无此字段。 */
  mode?: AnnotationMode;
  status: AnnotationStatus;
  /** 创建批注时的原文哈希，用于判断是否过期。 */
  sourceHash?: string;
  /** 创建时的源块序号；用于无缓存批注在首次翻译后迁移到锚点。 */
  sourceIndex?: number;
  /** 用户批注：采纳 AI 处理项时关联的 AI 批注 id。 */
  originAnnotationId?: string;
  /** AI 批注：被哪条用户批注处理。 */
  answeredBy?: string;
  /** 用户批注：最近一次参与翻译的时间。 */
  lastAppliedAt?: string;
  createdAt: string;
  updatedAt: string;
}

/** 预览视图中的批注，附带是否已过期。 */
export interface AnnotationView extends AnnotationRecord {
  stale: boolean;
}

/** 单个字段上限；防止模型/用户输入撑爆 sidecar。 */
export const MAX_ANNOTATION_MESSAGE = 2_000;
export const MAX_ANNOTATION_EXCERPT = 1_000;
export const MAX_ANNOTATION_OPTION = 2_000;
export const MAX_REVIEW_OPTIONS = 3;
export const MAX_ANNOTATIONS_PER_BLOCK = 6;

/** 归一化并去重模型返回的处理项；无效项直接丢弃。 */
export function normalizeReviewOptions(
  value: unknown,
  max = MAX_REVIEW_OPTIONS,
): ReviewOption[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const options: ReviewOption[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const record = item as Record<string, unknown>;
    const kind =
      record.kind === "instruction" || record.kind === "advice"
        ? record.kind
        : undefined;
    const text = normalizeAnnotationText(record.text, MAX_ANNOTATION_OPTION);
    if (!kind || !text) {
      continue;
    }
    const option: ReviewOption =
      kind === "advice"
        ? { kind, text }
        : {
            kind,
            text,
            ...(record.mode === "once" || record.mode === "persistent"
              ? { mode: record.mode }
              : { mode: "once" }),
          };
    const key = `${option.kind}\u0000${option.text}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    options.push(option);
    if (options.length >= max) {
      break;
    }
  }
  return options;
}

/** 归一化不可信字符串字段。 */
export function normalizeAnnotationText(
  value: unknown,
  max: number,
): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const text = value.trim();
  return text ? text.slice(0, max).trim() : undefined;
}

/** 用户批注是否参与下一次翻译。 */
export function isUserAnnotationActive(
  annotation: AnnotationRecord,
): boolean {
  if (annotation.author !== "user") {
    return false;
  }
  if (annotation.status === "pending" || annotation.status === "open") {
    return true;
  }
  return (
    annotation.mode === "persistent" &&
    (annotation.status === "applied" || annotation.status === "ineffective")
  );
}

/** 用户批注是否待生效（同步队列、徽标与统计使用）。 */
export function isUserAnnotationPending(
  annotation: AnnotationRecord,
): boolean {
  return (
    annotation.author === "user" &&
    (annotation.status === "pending" || annotation.status === "open")
  );
}

/** 一次性用户批注是否已经消费完。 */
export function isUserAnnotationExpired(
  annotation: AnnotationRecord,
): boolean {
  return (
    annotation.author === "user" &&
    annotation.mode === "once" &&
    (annotation.status === "applied" || annotation.status === "ineffective")
  );
}

/** AI 批注是否待核对。 */
export function isAiAnnotationOpen(annotation: AnnotationRecord): boolean {
  return annotation.author === "ai" && annotation.status === "open";
}
