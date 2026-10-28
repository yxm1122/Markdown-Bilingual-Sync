/**
 * 本地批注的数据模型。
 *
 * AI 审校批注和用户批注共用同一份 sidecar；`author` 区分来源，`kind` 区分
 * 审校问题、补充信息和要求修改。用户批注进入重译 prompt 时是指令，AI 批注只是观察。
 */
import type {
  AnnotationSide,
  ReviewAnnotationType,
  ReviewSeverity,
} from "../translation/types";

export type AnnotationAuthor = "ai" | "user";

export type AnnotationKind =
  | ReviewAnnotationType
  | "note"
  | "request-change";

export type AnnotationStatus = "open" | "resolved" | "dismissed";

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
  sourceExcerpt?: string;
  targetExcerpt?: string;
  suggestion?: string;
  status: AnnotationStatus;
  /** 创建批注时的原文哈希，用于判断是否过期。 */
  sourceHash?: string;
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
export const MAX_ANNOTATION_SUGGESTION = 2_000;
export const MAX_ANNOTATIONS_PER_BLOCK = 6;

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
