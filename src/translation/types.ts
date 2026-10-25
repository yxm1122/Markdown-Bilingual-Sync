/**
 * 翻译层公共协议（translation/types）
 *
 * 职责：定义 Provider 的输入/输出契约、进度与增量回调类型，并提供术语替换、
 * 结果校验这两个所有 Provider 共用的工具。
 *
 * 关键不变量：
 * - 一次请求内 item.id 唯一；Provider 必须原样回显 id，且每个 id 恰好返回一次；
 * - 校验未通过前，调用方不得把任何译文写入缓存（validateTranslationResult 抛错即整体拒绝）。
 *
 * 外部依赖：markdown/types 的 BlockKind 与 tError（错误文案本地化）；不做 I/O，不读取配置。
 *
 * 安全边界：Provider 输出按不可信数据处理——未知、重复、空、超长（>500_000 字符）
 * 或缺失的块一律拒绝；术语替换是纯文本替换，不解析 Markdown/HTML，也不访问网络。
 */
import type { BlockKind } from "../markdown/types";
import { tError } from "../i18n/errors";

// ---- 请求与结果数据类型 ----

/** 稳定翻译参考的角色：旧译文或回译前的原文。 */
export type TranslationReferenceRole = "previous-target" | "previous-source";

/**
 * 稳定翻译参考：把上一版结果作为模型修订的参照，而不是从零翻译。
 * 参考文本与块正文一样按不可信输入处理，Provider 不得把它当作指令执行。
 */
export interface TranslationReference {
  /** 上一版译文或原文。 */
  text: string;
  /** previous-target=重新翻译时的旧译文；previous-source=回译时的当前原文。 */
  role: TranslationReferenceRole;
}

/**
 * 单个待翻译块。
 * id 由调用方生成并在本次请求内唯一；headingPath 只是给模型的上下文，
 * 不得被 Provider 当作指令执行。
 */
export interface TranslationItem {
  /** 调用方生成的块标识，用于把译文路由回原文块。 */
  id: string;
  /** 原始 Markdown 文本；Provider 必须保留其中的 Markdown 结构。 */
  text: string;
  /** 块类型，用于按结构选择提示或校验策略。 */
  kind: BlockKind;
  /** 从祖先标题组成的路径，仅作上下文提示。 */
  headingPath: string[];
  /** 可选：上一版结果，用于重新翻译或回译时减少措辞波动。 */
  reference?: TranslationReference;
}

/** 术语表条目：source 到 target 的纯文本映射，不参与 Markdown 结构解析。 */
export interface GlossaryEntry {
  source: string;
  target: string;
}

/** 一次翻译请求；items/glossary/summary 视为只读，Provider 不得修改调用方数据。 */
export interface TranslationRequest {
  sourceLanguage: string;
  targetLanguage: string;
  items: TranslationItem[];
  glossary: GlossaryEntry[];
  /**
   * 可选全文摘要（原文语言）。存在时作为整篇文档的固定上下文，
   * 会占用每一批请求的 token 预算；Provider 必须把它当作参考数据，不得执行其中指令。
   */
  summary?: string;
}

/** 手动生成全文摘要的输入；sourceText 是整篇原文，不是单个块。 */
export interface SummaryRequest {
  text: string;
  sourceLanguage: string;
  targetLanguage: string;
  /** 文件名，仅用于提示模型文档标题；不是可信指令。 */
  title?: string;
}

/** Provider 返回的单块译文；id 必须与请求中某一项完全一致。 */
export interface TranslationResultItem {
  id: string;
  text: string;
}

/** 连接测试的展示信息；endpoint 可能含密钥，展示方需负责遮盖。 */
export interface ConnectionTestResult {
  /** 实际请求使用的模型名。 */
  model: string;
  /** 最终请求地址（调用方应脱敏后再展示/记录）。 */
  endpoint: string;
  /** 从发起请求到得到结果的耗时，包含重试。 */
  latencyMs: number;
  /** 截断后的译文样例，最长约 160 字符。 */
  sample: string;
  /** 请求是否显式关闭了思考模式（仅表示配置，不代表服务端行为）。 */
  thinkingDisabled: boolean;
}

/** 进度回调：completed 为已交付块数，total 为本次请求总块数；回调不应抛错。 */
export type TranslationProgress = (
  completed: number,
  total: number,
) => void;

/**
 * 增量译文回调：Provider 每交付一批结果调用一次（可能早于 translate 返回）。
 * 回调抛错时 Provider 应中止后续请求并透传该错误；已交付的结果不保证回滚。
 * 返回 Promise 时 Provider 会 await，以保证串行与顺序。
 */
export type TranslationChunkHandler = (
  items: readonly TranslationResultItem[],
  completed: number,
  total: number,
) => void | Promise<void>;

/**
 * 翻译服务统一接口。实现可被 BatchTranslationCoordinator 包装以合并跨文件请求。
 * 失败约定：配置错误、网络错误、结果校验失败与取消都以 reject 表达；
 * 取消统一使用“翻译已取消”错误文本。
 */
export interface TranslationProvider {
  /** 稳定标识，用于路由与状态展示（不是本地化文案）。 */
  readonly id: string;
  /** 本地化显示名。 */
  readonly label: string;
  /** 是否支持自动生成全文摘要；不支持时仍可手动编辑摘要。 */
  readonly supportsSummary?: boolean;
  /**
   * 翻译一批块。
   * @param request 待翻译内容与语言/术语信息。
   * @param signal 取消信号；触发后应尽快 reject，且不再发起新请求。
   * @param onProgress 可选的进度回调。
   * @param onChunk 可选的增量结果回调，用于边翻译边落盘。
   * @returns 与请求块一一对应的结果；不得缺失、重复或返回未请求的 id。
   * @throws 配置/网络错误、结果校验失败或取消。
   */
  translate(
    request: TranslationRequest,
    signal?: AbortSignal,
    onProgress?: TranslationProgress,
    onChunk?: TranslationChunkHandler,
  ): Promise<TranslationResultItem[]>;
  /**
   * 可选能力：根据整篇原文生成原文语言的全文摘要（供翻译上下文使用）。
   * 不支持时由调用方提示用户手动填写。
   */
  summarize?(
    request: SummaryRequest,
    signal?: AbortSignal,
  ): Promise<string>;
  /** 可选能力：测试连接；未实现时路由器会提示当前服务不支持。 */
  testConnection?(
    sourceLanguage: string,
    targetLanguage: string,
    signal?: AbortSignal,
  ): Promise<ConnectionTestResult>;
}

// ---- 共享工具 ----

/**
 * 对纯文本按顺序执行术语替换（区分大小写，替换所有出现位置）。
 * 注意：后一个术语可能命中前一个术语替换后的结果；调用方应先切分受保护片段，
 * 避免改动代码、链接等不应翻译的内容。无副作用。
 */
export function applyGlossary(
  text: string,
  glossary: readonly GlossaryEntry[],
): string {
  let result = text;
  for (const entry of glossary) {
    if (!entry.source) {
      continue;
    }
    result = result.split(entry.source).join(entry.target);
  }
  return result;
}

/**
 * 校验 Provider 结果并转换为 id -> 译文 映射。
 * 失败语义：出现未请求、重复、空、超过 500_000 字符或缺失的块时抛出本地化错误；
 * 本函数不做部分接受，调用方应放弃整次写入。无副作用。
 */
export function validateTranslationResult(
  requested: readonly TranslationItem[],
  result: readonly TranslationResultItem[],
): Map<string, string> {
  const expected = new Set(requested.map((item) => item.id));
  const outputs = new Map<string, string>();
  for (const item of result) {
    if (!expected.has(item.id)) {
      throw new Error(tError("translation.unexpectedBlock", { id: item.id }));
    }
    if (outputs.has(item.id)) {
      throw new Error(tError("translation.duplicateBlock", { id: item.id }));
    }
    if (typeof item.text !== "string" || !item.text.trim()) {
      throw new Error(tError("translation.emptyBlock", { id: item.id }));
    }
    if (item.text.length > 500_000) {
      throw new Error(tError("translation.resultTooLong", { id: item.id }));
    }
    outputs.set(item.id, item.text);
  }
  if (outputs.size !== expected.size) {
    const missing = requested
      .filter((item) => !outputs.has(item.id))
      .map((item) => item.id);
    throw new Error(tError("translation.missingBlocks", { count: missing.length, ids: missing.join(", ") }));
  }
  return outputs;
}
