/**
 * Agent 工具输入/输出协议。
 *
 * 这些类型同时服务于 Language Model Tool 的 invoke 类型标注、AgentService 的返回值
 * 与测试断言。输入字段保持宽松（可选、可能来自模型的未校验 JSON），由服务层在运行时
 * 严格校验；输出统一带 `ok: true`，错误结果由工具层包装为 `ok: false`。
 */
import type { GlossaryPatchMode } from "../glossary/glossaryPatch";
import type { SummaryLocks } from "../translation/summaryLocks";
import type { GlossaryEntry, TranslationBrief } from "../translation/types";

export type GlossaryScopeName = "global" | "workspace" | "effective";
export type GlossaryWriteScope = "global" | "workspace";

export interface GetDocumentBriefInput {
  /** 源 Markdown/Skill 文件绝对路径；缺省使用活动编辑器。 */
  file?: string;
  includeSummary?: boolean;
  includeGlossary?: boolean;
}

export interface UpdateDocumentBriefInput {
  file?: string;
  /** 新摘要；创建文档简报时必填，更新时可省略。 */
  summary?: string;
  /** 部分更新；字段缺省保持，空字符串清除。 */
  brief?: Partial<TranslationBrief>;
  /** 文档术语表整体替换；省略时保持。 */
  glossary?: GlossaryEntry[];
}

export interface UpdateDocumentGlossaryInput {
  file?: string;
  mode?: GlossaryPatchMode;
  entries?: GlossaryEntry[];
  remove?: string[];
}

export interface GetGlossaryInput {
  scope?: GlossaryScopeName;
  file?: string;
  query?: string;
  limit?: number;
  offset?: number;
}

export interface UpdateGlossaryInput {
  scope?: GlossaryWriteScope;
  file?: string;
  mode?: GlossaryPatchMode;
  entries?: GlossaryEntry[];
  remove?: string[];
}

/** 术语表条目视图；effective 作用域标记最终生效的来源。 */
export interface GlossaryEntryView extends GlossaryEntry {
  from?: GlossaryWriteScope;
}

export interface AgentLimits {
  maxSummaryChars: number;
  maxBriefFieldChars: number;
  maxDocumentGlossaryEntries: number;
  maxTermLength: number;
  maxUserGlossaryEntries: number;
}

export interface DocumentBriefView {
  ok: true;
  file: string;
  relativePath: string;
  sourceLanguage: string;
  targetLanguage: string;
  hasCacheFile: boolean;
  documentBrief: {
    exists: boolean;
    stale: boolean;
    summary?: string;
    summaryChars: number;
    updatedAt?: string;
    model?: string;
    brief: TranslationBrief;
    briefFilledCount: number;
    locks: SummaryLocks;
    glossary?: GlossaryEntry[];
    glossaryCount: number;
  };
  limits: AgentLimits;
}

export interface DocumentBriefUpdateView {
  ok: true;
  file: string;
  relativePath: string;
  created: boolean;
  changes: {
    summary: "created" | "updated" | "unchanged";
    brief: string[];
    cleared: string[];
    glossary: { added: number; updated: number; removed: number };
  };
  brief: TranslationBrief;
  locks: SummaryLocks;
  updatedAt?: string;
  stale: boolean;
  summaryChars: number;
  glossaryCount: number;
  locksOverridden: string[];
}

export interface DocumentGlossaryUpdateView {
  ok: true;
  file: string;
  relativePath: string;
  mode: GlossaryPatchMode;
  total: number;
  counts: { added: number; updated: number; removed: number };
  changed: {
    added: GlossaryEntry[];
    updated: GlossaryEntry[];
    removed: GlossaryEntry[];
  };
  duplicates: string[];
  locksOverridden: string[];
  stale: boolean;
  summaryChars: number;
}

export interface GlossarySourceView {
  scope: GlossaryWriteScope;
  path: string;
  total: number;
  warnings: string[];
}

export interface GlossaryReadView {
  ok: true;
  scope: GlossaryScopeName;
  sources: GlossarySourceView[];
  workspaceAvailable: boolean;
  /** 某一作用域读取失败或被省略时为 true；entries 可能不完整。 */
  degraded: boolean;
  /** 降级原因；与 sources[].warnings 的解析警告不同。 */
  warnings: string[];
  /** 作用域内条目总数（筛选前）。 */
  total: number;
  /** 命中 query 的条目数（筛选后）。 */
  matched: number;
  offset: number;
  limit: number;
  hasMore: boolean;
  entries: GlossaryEntryView[];
}

export interface GlossaryUpdateView {
  ok: true;
  scope: GlossaryWriteScope;
  path: string;
  mode: GlossaryPatchMode;
  total: number;
  counts: { added: number; updated: number; removed: number };
  changed: {
    added: GlossaryEntry[];
    updated: GlossaryEntry[];
    removed: GlossaryEntry[];
  };
  duplicates: string[];
  /** 另一作用域中同名 source 的覆盖情况。 */
  shadowing: {
    scope: GlossaryWriteScope;
    count: number;
    sample: string[];
    /** 另一作用域无法读取时为 true；写入本身已经成功。 */
    unavailable?: boolean;
  };
}

/** 工具层返回给模型的错误结构。 */
export interface AgentToolErrorPayload {
  ok: false;
  code: string;
  message: string;
  hint?: string;
  details?: unknown;
}

/** 单次写操作在结果中返回的变更样本上限。 */
export const MAX_TOOL_SAMPLE_ENTRIES = 20;
/** 确认弹窗中展示的变更样本上限；完整列表可在结果/读取工具中查看。 */
export const MAX_CONFIRM_SAMPLE_ENTRIES = 10;
export const DEFAULT_GLOSSARY_PAGE_SIZE = 50;
export const MAX_GLOSSARY_PAGE_SIZE = 200;
