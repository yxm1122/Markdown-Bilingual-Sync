/**
 * 同步服务的 VS Code 适配层。
 *
 * 职责：把命令/预览请求转换为对 `syncDocument`、`editCache` 与 `CacheStore` 的调用；
 * 负责读取工作区配置、确保原文已保存、读写术语表、维护每个文件的互斥锁，并在写缓存
 * 前重新解析校验。
 *
 * 关键不变量：
 * - 所有缓存写入都经 `CacheStore.write`；同步与整块替换等高风险路径会在写入前后
 *   重新解析校验；
 * - 带 `withLock` 的操作对同一文件互斥；清空全部缓存期间拒绝任何带锁操作；
 * - 预览内联编辑会重新读取原文与缓存，并通过 `expected` 哈希/id 做乐观并发校验，
 *   防止把编辑应用到已经变化的块上；
 * - 删除原文块的译文时写入 `mbs-deleted` 墓碑而不是直接删块，保证可撤销。
 *
 * 与其他模块的关系：`extension.ts` 与 `previewManager` 只调用本类；纯同步逻辑在
 * `./sync`，缓存文本的局部改写规则在 `../cache/editCache`。
 */
import * as path from "node:path";
import * as vscode from "vscode";
import { CacheStore } from "../cache/cacheStore";
import { buildImportedCache } from "../import/importTranslation";
import {
  MAX_DOCUMENT_GLOSSARY_ENTRIES,
  mergeGlossaryEntries,
  normalizeGlossaryEntries,
  prioritizeGlossaryEntries,
  type GlossaryLoadResult,
} from "../glossary/glossary";
import { filterGeneratedGlossary } from "../glossary/generatedGlossary";
import type { GlossaryStore } from "../glossary/glossaryStore";
import {
  markCachedBlockSynced,
  replaceCachedBlock,
} from "../cache/editCache";
import { alignDocument } from "../markdown/align";
import { parseCacheDocument } from "../markdown/anchors";
import {
  buildDocumentMetadata,
  stripFrontmatterText,
} from "../markdown/documentMetadata";
import { buildHeadingPaths } from "../markdown/headings";
import { buildBlockContext } from "./blockContext";
import { AnnotationStore } from "../annotations/annotationStore";
import {
  isUserAnnotationActive,
  isUserAnnotationPending,
  MAX_ANNOTATION_EXCERPT,
  MAX_ANNOTATION_MESSAGE,
  MAX_ANNOTATIONS_PER_BLOCK,
  normalizeAnnotationText,
  normalizeReviewOptions,
  type AnnotationMode,
  type AnnotationRecord,
  type AnnotationView,
} from "../annotations/types";
import { createMarkdownRuntime } from "../markdown/markdown";
import { parseMarkdownDocument } from "../markdown/segmenter";
import type { BlockKind, CacheSummary } from "../markdown/types";
import {
  createDeletedMarker,
  parseDeletedMarker,
} from "../cache/deletedMarker";
import {
  MAX_SUMMARY_CHARS,
  summarySourceHash,
} from "../cache/summaryMarker";
import {
  syncDocument,
  serializeCacheDocument,
  type CacheEntry,
  type SyncProgressReporter,
  type SyncResult,
  type TranslationAssistOptions,
} from "./sync";
import type { CacheDocument } from "../markdown/types";
import {
  hasTranslationBrief,
  normalizeTranslationBrief,
  validateTranslationResult,
  type GlossaryEntry,
  type ReviewAnnotationDraft,
  type ReviewItem,
  type TranslationBrief,
  type TranslationProvider,
  type TranslationRetryReporter,
} from "../translation/types";
import { estimateTokenCount } from "../translation/batching";
import {
  checkDocumentConsistency,
  type ConsistencyReport,
} from "../quality/consistency";
import { blockHash, newBlockId } from "../util/hash";
import {
  LANGUAGE_TAG,
  resolveAssistantLanguage,
} from "../util/language";
import { restoreProtectedSyntax } from "../util/protectedSyntax";
import { tError } from "../i18n/errors";

/** 摘要是一个手动触发的单次请求；超过该输入规模时提示手动填写，避免超出模型上下文。 */
const SUMMARY_MAX_INPUT_TOKENS = 12_000;
const REVIEW_BATCH_SIZE = 6;
const REVIEW_TOKEN_BUDGET = 6_000;
const REVIEW_ITEM_OVERHEAD = 24;

/** 按块数与 token 预算切分审校批次；单片超预算时仍独占一批。 */
export function planReviewChunks(
  items: readonly ReviewItem[],
  maxItems: number,
  tokenBudget: number,
): ReviewItem[][] {
  const chunks: ReviewItem[][] = [];
  let current: ReviewItem[] = [];
  let tokens = 0;
  for (const item of items) {
    const cost =
      REVIEW_ITEM_OVERHEAD +
      estimateTokenCount(item.sourceText) +
      estimateTokenCount(item.targetText) +
      estimateTokenCount(item.headingPath.join(" > "));
    if (
      current.length > 0 &&
      (current.length >= maxItems || tokens + cost > tokenBudget)
    ) {
      chunks.push(current);
      current = [];
      tokens = 0;
    }
    current.push(item);
    tokens += cost;
  }
  if (current.length > 0) {
    chunks.push(current);
  }
  return chunks;
}

// ---- 公共类型 ----

/** 原文与目标语言（BCP-47 标签），来自工作区配置。 */
export interface LanguageSettings {
  sourceLanguage: string;
  targetLanguage: string;
}

/** 一次操作所需的全部已加载状态。 */
export interface LoadedState extends LanguageSettings {
  sourceUri: vscode.Uri;
  /** 打开文档的当前文本（可能包含未保存内容，是否保存由调用方决定）。 */
  sourceText: string;
  cacheUri: vscode.Uri;
  /** 缓存不存在时为 `undefined`。 */
  cacheText?: string;
}

/** 同步完成后的返回值，供 UI 展示摘要与打开缓存。 */
export interface SyncOutcome {
  result: SyncResult;
  cacheUri: vscode.Uri;
  settings: LanguageSettings;
}

/** 预览所需的轻量状态，不包含源文件 URI。 */
export interface PreviewState extends LanguageSettings {
  sourceText: string;
  cacheText?: string;
  cacheUri: vscode.Uri;
  /** 缓存中的全文摘要（若存在）；由 parseCacheDocument 剥离读取。 */
  summary?: CacheSummary;
  /** 本机批注（含 AI 审校与用户批注）。 */
  annotations?: AnnotationRecord[];
}

/** 设置页提供的稳定翻译/摘要上下文默认值。 */
export interface TranslationAssistSettings {
  stableTranslation: boolean;
  summaryContext: boolean;
}

/** 块级回译结果；`line` 为原文行号（1 基），供预览定位。 */
export interface BackTranslationResult extends LanguageSettings {
  sourceText: string;
  backText: string;
  line: number;
  kind: BlockKind;
  headingPath: string[];
  sourceHash: string;
  cacheId: string;
}

/** 批量块级操作的定位信息；用于排队期间内容变化后的乐观校验。 */
export interface BlockOperationTarget {
  blockIndex: number;
  sourceHash?: string;
  cacheId?: string;
  cacheDst?: string;
  human?: boolean;
}

/** 批量重译结果：除同步结果外，报告因内容变化或状态不适用而跳过的块。 */
export interface RetranslateBlocksOutcome {
  outcome: SyncOutcome;
  skipped: string[];
}

/** 用户取消操作（关闭保存提示、取消同步等）时抛出的可识别错误。 */
export class CancelledError extends Error {
  /** @param message 展示给用户的取消说明，默认“操作已取消”。 */
  constructor(message = tError("common.operationCancelled")) {
    super(message);
    this.name = "CancelledError";
  }
}

// ---- 服务实现 ----

/** 面向扩展命令与预览的同步/编辑服务。 */
export class SyncService {
  /** 共享的 markdown-it 实例；解析是同步的，可安全复用。 */
  private readonly md = createMarkdownRuntime();
  /** 正在执行带锁操作的文件 URI 集合，用于拒绝同文件的并发写。 */
  private readonly inFlight = new Set<string>();
  /** 审校模型调用不占文件锁，但仍需阻止同一文件的并发审校。 */
  private readonly reviewInFlight = new Set<string>();
  /** 清空全部缓存期间为 true，阻止新的带锁操作与并发清空。 */
  private clearingAllCaches = false;
  /** 本机批注 sidecar 读写。 */
  private readonly annotationStore: AnnotationStore;

  /**
   * @param cacheStore 缓存读写与路径解析
   * @param glossaryStore 术语表加载
   * @param provider 翻译服务
   * @param output 扩展输出通道，用于记录审计日志
   */
  constructor(
    private readonly cacheStore: CacheStore,
    private readonly glossaryStore: GlossaryStore,
    private readonly provider: TranslationProvider,
    private readonly output: vscode.OutputChannel,
  ) {
    this.annotationStore = new AnnotationStore(cacheStore);
  }

  /** 当前 Provider 的展示名，用于状态栏与提示文案。 */
  get providerLabel(): string {
    return this.provider.label;
  }

  // ---- 配置与状态加载 ----

  /**
   * 读取并校验语言配置。
   *
   * 要求两侧都是形如 `en` / `zh-CN` 的标签，且原文语言与译文语言不同。
   * 配置非法时抛出本地化错误；无副作用。
   */
  getSettings(): LanguageSettings {
    const config = vscode.workspace.getConfiguration("markdownBilingualSync");
    const sourceLanguage = String(
      config.get<string>("sourceLanguage", "en"),
    ).trim();
    const targetLanguage = String(
      config.get<string>("targetLanguage", "zh-CN"),
    ).trim();
    if (!LANGUAGE_TAG.test(sourceLanguage)) {
      throw new Error(
        tError("sync.invalidSourceLanguage", { language: sourceLanguage }),
      );
    }
    if (!LANGUAGE_TAG.test(targetLanguage)) {
      throw new Error(
        tError("sync.invalidTargetLanguage", { language: targetLanguage }),
      );
    }
    if (sourceLanguage.toLowerCase() === targetLanguage.toLowerCase()) {
      throw new Error(tError("sync.sameLanguage"));
    }
    return { sourceLanguage, targetLanguage };
  }

  /** 读取稳定翻译/摘要上下文的默认开关（预览会话与命令入口共用）。 */
  getAssistSettings(): TranslationAssistSettings {
    const config = vscode.workspace.getConfiguration("markdownBilingualSync");
    return {
      stableTranslation: config.get<boolean>("stableTranslation", true),
      summaryContext: config.get<boolean>("summaryContext", true),
    };
  }

  /** 解析文档简报与审校批注的输出语言；不合法时抛本地化错误。 */
  private assistantLanguageFor(
    sourceLanguage: string,
    targetLanguage: string,
  ): string {
    const config = vscode.workspace.getConfiguration("markdownBilingualSync");
    return resolveAssistantLanguage(
      config.get<string>("assistantLanguage", "target"),
      sourceLanguage,
      targetLanguage,
    );
  }

  /**
   * 取用于摘要上下文的相对路径；不在工作区时只给 basename，避免绝对路径。
   */
  private relativeDocumentPath(sourceUri: vscode.Uri): string | undefined {
    const folder = vscode.workspace.getWorkspaceFolder(sourceUri);
    if (!folder) {
      return sourceUri.path.split("/").filter(Boolean).pop();
    }
    const relative = vscode.workspace
      .asRelativePath(sourceUri, false)
      .replace(/\\/g, "/");
    const folders = vscode.workspace.workspaceFolders;
    return folders && folders.length > 1
      ? `${folder.name}/${relative}`
      : relative;
  }

  /** 当前 Provider 是否支持自动生成全文摘要。 */
  get summarySupported(): boolean {
    return this.provider.supportsSummary === true;
  }

  /** 合并显式开关与设置默认值；显式值来自预览会话。 */
  private resolveAssist(
    assist?: Partial<TranslationAssistSettings>,
  ): TranslationAssistSettings {
    const defaults = this.getAssistSettings();
    return {
      stableTranslation:
        assist?.stableTranslation ?? defaults.stableTranslation,
      summaryContext: assist?.summaryContext ?? defaults.summaryContext,
    };
  }

  /** 从缓存文档中取摘要文本；摘要上下文关闭时返回 undefined。 */
  private summaryForCache(
    cache: CacheDocument | undefined,
    assist: TranslationAssistSettings,
  ): string | undefined {
    if (!assist.summaryContext) {
      return undefined;
    }
    return cache?.summary?.text.trim() || undefined;
  }

  /** 从缓存文档中取文档简报要求；摘要上下文关闭或没有有效字段时返回 undefined。 */
  private briefForCache(
    cache: CacheDocument | undefined,
    assist: TranslationAssistSettings,
  ): TranslationBrief | undefined {
    if (!assist.summaryContext) {
      return undefined;
    }
    const brief = cache?.summary?.brief;
    return brief && hasTranslationBrief(brief) ? brief : undefined;
  }

  /**
   * 加载某个原文的操作状态。
   *
   * `ensureSaved` 为 true 时，若文档有未保存修改会弹出模态确认并尝试保存；用户拒绝
   * 或保存失败则抛 `CancelledError` / 本地化错误。`purpose` 仅用于提示文案。随后计算
   * 缓存路径并读取缓存文本（不存在时为 `undefined`）。除可选的原文保存外，不写缓存。
   */
  async loadState(
    sourceUri: vscode.Uri,
    ensureSaved: boolean,
    purpose = tError("sync.purposeSync"),
  ): Promise<LoadedState> {
    if (sourceUri.scheme !== "file") {
      throw new Error(tError("sync.localFileOnly"));
    }
    const settings = this.getSettings();
    const document = await vscode.workspace.openTextDocument(sourceUri);
    if (ensureSaved && document.isDirty) {
      const saveLabel = tError("sync.saveAndPurpose", { purpose });
      const choice = await vscode.window.showWarningMessage(
        tError("sync.savePrompt", {
          file: path.basename(sourceUri.fsPath),
          purpose,
        }),
        { modal: true },
        saveLabel,
      );
      if (choice !== saveLabel) {
        throw new CancelledError();
      }
      const saved = await document.save();
      if (!saved) {
        throw new Error(tError("sync.saveSourceFailed", { purpose }));
      }
    }
    const cacheUri = this.cacheStore.getCacheUri(
      sourceUri,
      settings.targetLanguage,
    );
    const cacheText = await this.cacheStore.read(cacheUri);
    return {
      ...settings,
      sourceUri,
      sourceText: document.getText(),
      cacheUri,
      cacheText,
    };
  }

  /**
   * 加载预览状态：不强制保存原文，也不弹出保存提示。
   *
   * 预览可以基于未保存的原文显示，但写回/同步前仍会再次校验。
   */
  async loadPreviewState(sourceUri: vscode.Uri): Promise<PreviewState> {
    const state = await this.loadState(sourceUri, false);
    const summary = state.cacheText?.trim()
      ? parseCacheDocument(state.cacheText, this.md).summary
      : undefined;
    const annotations = await this.annotationStore.read(
      sourceUri,
      state.targetLanguage,
    );
    if (annotations.warning) {
      this.log(annotations.warning);
    }
    return {
      sourceText: state.sourceText,
      cacheText: state.cacheText,
      cacheUri: state.cacheUri,
      sourceLanguage: state.sourceLanguage,
      targetLanguage: state.targetLanguage,
      summary,
      annotations: annotations.annotations,
    };
  }

  /** 当前 Provider 是否支持语义审校。 */
  get reviewSupported(): boolean {
    return (
      this.provider.supportsReview === true &&
      typeof this.provider.review === "function"
    );
  }

  /** 当前 Provider 是否会把用户批注发送给模型。 */
  get annotationsSupported(): boolean {
    return this.provider.supportsAnnotations === true;
  }

  /**
   * 把无缓存块上的 `src-<hash>` 批注迁移到新生成的缓存锚点。
   * 优先用保存批注时的 sourceIndex 区分同内容块；旧数据仅在同哈希唯一时迁移。
   */
  private async migrateSourceAnnotations(
    sourceUri: vscode.Uri,
    targetLanguage: string,
    sourceText: string,
    cacheText: string,
  ): Promise<void> {
    const existing = await this.annotationStore.read(sourceUri, targetLanguage);
    if (existing.warning) {
      this.log(existing.warning);
    }
    if (!existing.annotations.some((entry) => entry.blockId.startsWith("src-"))) {
      return;
    }
    const source = parseMarkdownDocument(sourceText, this.md);
    const cache = parseCacheDocument(cacheText, this.md);
    const alignment = alignDocument(source.blocks, cache);
    const byHash = new Map<
      string,
      Array<{ id: string; index: number }>
    >();
    for (const aligned of alignment.blocks) {
      if (!aligned.cache) {
        continue;
      }
      const list = byHash.get(aligned.source.hash) ?? [];
      list.push({
        id: aligned.cache.anchor.id,
        index: aligned.source.index,
      });
      byHash.set(aligned.source.hash, list);
    }
    let migrated = 0;
    const next = existing.annotations.map((entry) => {
      if (!entry.blockId.startsWith("src-")) {
        return entry;
      }
      const hash = entry.blockId.slice(4).trim();
      const candidates = byHash.get(hash) ?? [];
      let target =
        entry.sourceIndex !== undefined
          ? candidates.find((item) => item.index === entry.sourceIndex)
          : undefined;
      if (!target && candidates.length === 1) {
        target = candidates[0];
      }
      if (!target) {
        return entry;
      }
      migrated += 1;
      return { ...entry, blockId: target.id };
    });
    if (migrated > 0) {
      await this.annotationStore.write(sourceUri, targetLanguage, next);
      this.log(
        `migrated ${migrated} annotation(s) to cache anchors of ${path.basename(sourceUri.fsPath)}`,
      );
    }
  }

  /** 读取某个块的批注；sidecar 损坏时只记录不阻断。 */
  private async readAnnotationsForBlock(
    sourceUri: vscode.Uri,
    targetLanguage: string,
    blockId: string,
  ): Promise<AnnotationRecord[]> {
    const result = await this.annotationStore.read(sourceUri, targetLanguage);
    if (result.warning) {
      this.log(result.warning);
    }
    return result.annotations.filter((entry) => entry.blockId === blockId);
  }

  /**
   * 翻译成功后更新批注结果：译文有变化记 applied，没有变化记 ineffective；
   * 一次性批注依赖状态自然失效，持续批注保持 active。翻译期间被编辑/删除的批注跳过。
   */
  private async applyAnnotationOutcomes(
    sourceUri: vscode.Uri,
    targetLanguage: string,
    sent: readonly AnnotationRecord[],
    outcomes: ReadonlyMap<string, boolean>,
  ): Promise<void> {
    if (outcomes.size === 0) {
      return;
    }
    const existing = await this.annotationStore.read(sourceUri, targetLanguage);
    const originals = new Map(sent.map((entry) => [entry.id, entry]));
    const now = new Date().toISOString();
    let touched = false;
    const next = existing.annotations.map((entry) => {
      const original = originals.get(entry.id);
      const changed = outcomes.get(entry.id);
      if (
        !original ||
        changed === undefined ||
        entry.author !== "user" ||
        entry.updatedAt !== original.updatedAt
      ) {
        return entry;
      }
      touched = true;
      return {
        ...entry,
        status: changed ? ("applied" as const) : ("ineffective" as const),
        lastAppliedAt: now,
        updatedAt: now,
      };
    });
    if (touched) {
      await this.annotationStore.write(sourceUri, targetLanguage, next);
    }
  }

  /** 把模型返回的批注草稿转成可落库记录；未知块 id 直接丢弃。 */
  private annotationRecordsFromDrafts(
    drafts: readonly ReviewAnnotationDraft[],
    sourceHashById: ReadonlyMap<string, string>,
    now: string,
  ): AnnotationRecord[] {
    const records: AnnotationRecord[] = [];
    const counts = new Map<string, number>();
    for (const draft of drafts) {
      const sourceHash = sourceHashById.get(draft.id);
      if (!sourceHash) {
        continue;
      }
      const count = counts.get(draft.id) ?? 0;
      if (count >= MAX_ANNOTATIONS_PER_BLOCK) {
        continue;
      }
      counts.set(draft.id, count + 1);
      const message = normalizeAnnotationText(
        draft.message,
        MAX_ANNOTATION_MESSAGE,
      );
      if (!message) {
        continue;
      }
      const question = normalizeAnnotationText(
        draft.question,
        MAX_ANNOTATION_MESSAGE,
      );
      const sourceExcerpt = normalizeAnnotationText(
        draft.sourceExcerpt,
        MAX_ANNOTATION_EXCERPT,
      );
      const targetExcerpt = normalizeAnnotationText(
        draft.targetExcerpt,
        MAX_ANNOTATION_EXCERPT,
      );
      const normalizedOptions = normalizeReviewOptions(draft.options);
      const instructions = normalizedOptions.filter(
        (option) => option.kind === "instruction",
      );
      const advice = normalizedOptions.find(
        (option) => option.kind === "advice",
      );
      // 指令和只读建议不应同时出现；有可执行指令时以指令为准。
      const options = instructions.length
        ? instructions
        : advice
          ? [advice]
          : [];
      records.push({
        id: `ai-${newBlockId()}`,
        blockId: draft.id,
        side: draft.side,
        author: "ai",
        kind: draft.type,
        severity: draft.severity,
        message,
        ...(question ? { question } : {}),
        ...(options.length ? { options } : {}),
        ...(sourceExcerpt ? { sourceExcerpt } : {}),
        ...(targetExcerpt ? { targetExcerpt } : {}),
        status: "open",
        sourceHash,
        createdAt: now,
        updatedAt: now,
      });
    }
    return records;
  }

  /**
   * 审校单个块：模型只返回批注，不返回译文。新的 AI 批注替换该块旧的 AI 批注，
   * 用户批注保留；结果写入本机 sidecar。
   */
  async reviewBlock(
    sourceUri: vscode.Uri,
    blockIndex: number,
    signal?: AbortSignal,
    onRetry?: TranslationRetryReporter,
  ): Promise<{ annotations: AnnotationRecord[]; added: number }> {
    const release = this.beginReview(sourceUri);
    try {
      return await this.reviewBlockInternal(
        sourceUri,
        blockIndex,
        signal,
        onRetry,
      );
    } finally {
      release();
    }
  }

  private async reviewBlockInternal(
    sourceUri: vscode.Uri,
    blockIndex: number,
    signal?: AbortSignal,
    onRetry?: TranslationRetryReporter,
  ): Promise<{ annotations: AnnotationRecord[]; added: number }> {
    if (signal?.aborted) {
      throw new CancelledError();
    }
    if (!this.reviewSupported) {
      throw new Error(tError("translation.routerReviewUnsupported"));
    }
    const state = await this.loadState(
      sourceUri,
      true,
      tError("sync.purposeReview"),
    );
    const source = parseMarkdownDocument(state.sourceText, this.md);
    const cache = parseCacheDocument(state.cacheText ?? "", this.md);
    const alignment = alignDocument(source.blocks, cache);
    const aligned = alignment.blocks.find(
      (item) => item.source.index === blockIndex,
    );
    if (!aligned) {
      throw new Error(tError("common.missingSourceBlock", { index: blockIndex + 1 }));
    }
    if (!aligned.source.translatable) {
      throw new Error(tError("sync.blockNotTranslatable"));
    }
    if (
      !aligned.cache ||
      aligned.status === "deleted" ||
      aligned.status === "copy" ||
      !aligned.cache.block.raw.trim()
    ) {
      throw new Error(tError("sync.noTranslationReview"));
    }
    const reviewedTarget = aligned.cache.block.raw;
    const headingPaths = buildHeadingPaths(source.blocks);
    const assistSettings = this.resolveAssist();
    const summary = this.summaryForCache(cache, assistSettings);
    const brief = this.briefForCache(cache, assistSettings);
    const context = buildBlockContext({
      blocks: source.blocks,
      index: aligned.source.index,
      itemText: aligned.source.raw,
      textOf: (block) => block.raw,
    });
    const glossary = await this.loadGlossary(sourceUri);
    const blockId = aligned.cache.anchor.id;
    const outputLanguage = this.assistantLanguageFor(
      state.sourceLanguage,
      state.targetLanguage,
    );
    const drafts = await this.provider.review!(
      {
        sourceLanguage: state.sourceLanguage,
        targetLanguage: state.targetLanguage,
        outputLanguage,
        ...(summary ? { summary } : {}),
        ...(brief ? { brief } : {}),
        glossary: this.requestGlossary(glossary.entries, cache),
        items: [
          {
            id: blockId,
            kind: aligned.source.kind,
            headingPath: headingPaths.get(aligned.source.index) ?? [],
            sourceText: aligned.source.raw,
            targetText: aligned.cache.block.raw,
            ...(context ? { context } : {}),
          },
        ],
        ...(onRetry ? { onRetry } : {}),
      },
      signal,
    );
    if (signal?.aborted) {
      throw new CancelledError();
    }
    const now = new Date().toISOString();
    const result = await this.withLock(sourceUri, async () => {
      const current = await this.loadState(sourceUri, false);
      if (
        current.sourceLanguage !== state.sourceLanguage ||
        current.targetLanguage !== state.targetLanguage
      ) {
        throw new Error(tError("sync.translationChangedRefresh"));
      }
      const currentSource = parseMarkdownDocument(current.sourceText, this.md);
      const currentCache = parseCacheDocument(current.cacheText ?? "", this.md);
      const currentAlignment = alignDocument(currentSource.blocks, currentCache);
      const currentBlock = currentAlignment.blocks.find(
        (item) => item.cache?.anchor.id === blockId,
      );
      if (
        !currentBlock ||
        currentBlock.source.hash !== aligned.source.hash ||
        currentBlock.cache?.block.raw !== reviewedTarget ||
        currentBlock.status === "deleted" ||
        currentBlock.status === "copy"
      ) {
        throw new Error(tError("sync.translationChangedRefresh"));
      }
      const records = this.annotationRecordsFromDrafts(
        drafts,
        new Map([[blockId, aligned.source.hash]]),
        now,
      );
      const existing = await this.annotationStore.read(
        sourceUri,
        state.targetLanguage,
      );
      const next = [
        ...existing.annotations.filter(
          (entry) => !(entry.author === "ai" && entry.blockId === blockId),
        ),
        ...records,
      ];
      await this.annotationStore.write(
        sourceUri,
        state.targetLanguage,
        next,
      );
      return { annotations: next, added: records.length };
    });
    this.log(
      `review block ${blockIndex} of ${path.basename(sourceUri.fsPath)}: ${result.added} annotation(s)`,
    );
    return result;
  }

  /**
   * 审校全部机器译文：跳过 human/deleted/未翻译块，按 6 块一批请求模型。
   * 只替换这些块的 AI 批注，用户批注保留；任一批失败则不写入新结果。
   *
   * `options.blockIds` 用于只审校预览中选中的块；`onProgress` 按已处理块数上报。
   */
  async reviewBlocks(
    sourceUri: vscode.Uri,
    signal?: AbortSignal,
    options: {
      blockIds?: ReadonlySet<string>;
      onProgress?: (completed: number, total: number) => void;
      onRetry?: TranslationRetryReporter;
    } = {},
  ): Promise<{
    annotations: AnnotationRecord[];
    added: number;
    reviewed: number;
  }> {
    const release = this.beginReview(sourceUri);
    try {
      return await this.reviewBlocksInternal(sourceUri, signal, options);
    } finally {
      release();
    }
  }

  private async reviewBlocksInternal(
    sourceUri: vscode.Uri,
    signal?: AbortSignal,
    options: {
      blockIds?: ReadonlySet<string>;
      onProgress?: (completed: number, total: number) => void;
      onRetry?: TranslationRetryReporter;
    } = {},
  ): Promise<{
    annotations: AnnotationRecord[];
    added: number;
    reviewed: number;
  }> {
    if (signal?.aborted) {
      throw new CancelledError();
    }
    if (!this.reviewSupported) {
      throw new Error(tError("translation.routerReviewUnsupported"));
    }
    const state = await this.loadState(
      sourceUri,
      true,
      tError("sync.purposeReview"),
    );
    const source = parseMarkdownDocument(state.sourceText, this.md);
    const cache = parseCacheDocument(state.cacheText ?? "", this.md);
    const alignment = alignDocument(source.blocks, cache);
    const candidates = alignment.blocks.filter(
      (aligned) =>
        Boolean(aligned.cache) &&
        aligned.source.translatable &&
        !aligned.human &&
        aligned.status !== "deleted" &&
        aligned.status !== "untranslated" &&
        Boolean(aligned.cache?.block.raw.trim()) &&
        (!options.blockIds || options.blockIds.has(aligned.cache!.anchor.id)),
    );
    const existing = await this.annotationStore.read(
      sourceUri,
      state.targetLanguage,
    );
    if (candidates.length === 0) {
      return {
        annotations: existing.annotations,
        added: 0,
        reviewed: 0,
      };
    }
    const headingPaths = buildHeadingPaths(source.blocks);
    const assistSettings = this.resolveAssist();
    const summary = this.summaryForCache(cache, assistSettings);
    const brief = this.briefForCache(cache, assistSettings);
    const glossary = await this.loadGlossary(sourceUri);
    const outputLanguage = this.assistantLanguageFor(
      state.sourceLanguage,
      state.targetLanguage,
    );
    const sourceHashById = new Map(
      candidates.map((aligned) => [
        aligned.cache!.anchor.id,
        aligned.source.hash,
      ]),
    );
    const targetTextById = new Map(
      candidates.map((aligned) => [
        aligned.cache!.anchor.id,
        aligned.cache!.block.raw,
      ]),
    );
    const items = candidates.map((aligned) => {
      const context = buildBlockContext({
        blocks: source.blocks,
        index: aligned.source.index,
        itemText: aligned.source.raw,
        textOf: (block) => block.raw,
      });
      return {
        id: aligned.cache!.anchor.id,
        kind: aligned.source.kind,
        headingPath: headingPaths.get(aligned.source.index) ?? [],
        sourceText: aligned.source.raw,
        targetText: aligned.cache!.block.raw,
        ...(context ? { context } : {}),
      };
    });
    const now = new Date().toISOString();
    const records: AnnotationRecord[] = [];
    const chunks = planReviewChunks(
      items,
      REVIEW_BATCH_SIZE,
      REVIEW_TOKEN_BUDGET,
    );
    if (signal?.aborted) {
      throw new CancelledError();
    }
    let completed = 0;
    options.onProgress?.(0, items.length);
    const settled = await Promise.allSettled(
      chunks.map(async (chunk) => {
        try {
          const drafts = await this.provider.review!(
            {
              sourceLanguage: state.sourceLanguage,
              targetLanguage: state.targetLanguage,
              outputLanguage,
              ...(summary ? { summary } : {}),
              ...(brief ? { brief } : {}),
              glossary: this.requestGlossary(glossary.entries, cache),
              items: chunk,
              ...(options.onRetry
                ? { onRetry: options.onRetry }
                : {}),
            },
            signal,
          );
          const chunkHashes = new Map(
            chunk.map((item) => [item.id, sourceHashById.get(item.id) ?? ""]),
          );
          return this.annotationRecordsFromDrafts(drafts, chunkHashes, now);
        } finally {
          completed += chunk.length;
          options.onProgress?.(completed, items.length);
        }
      }),
    );
    if (signal?.aborted) {
      throw new CancelledError();
    }
    const failure = settled.find(
      (entry): entry is PromiseRejectedResult => entry.status === "rejected",
    );
    if (failure) {
      throw failure.reason;
    }
    for (const entry of settled) {
      if (entry.status === "fulfilled") {
        records.push(...entry.value);
      }
    }
    const reviewedIds = new Set(sourceHashById.keys());
    return this.withLock(sourceUri, async () => {
      const current = await this.loadState(sourceUri, false);
      if (
        current.sourceLanguage !== state.sourceLanguage ||
        current.targetLanguage !== state.targetLanguage
      ) {
        const existingNow = await this.annotationStore.read(
          sourceUri,
          current.targetLanguage,
        );
        return {
          annotations: existingNow.annotations,
          added: 0,
          reviewed: 0,
        };
      }
      const currentSource = parseMarkdownDocument(current.sourceText, this.md);
      const currentCache = parseCacheDocument(current.cacheText ?? "", this.md);
      const currentAlignment = alignDocument(currentSource.blocks, currentCache);
      const currentById = new Map(
        currentAlignment.blocks
          .filter((aligned) => aligned.cache)
          .map((aligned) => [aligned.cache!.anchor.id, aligned]),
      );
      const validIds = new Set<string>();
      for (const [id, sourceHash] of sourceHashById) {
        const aligned = currentById.get(id);
        if (
          !aligned ||
          aligned.source.hash !== sourceHash ||
          aligned.cache!.block.raw !== targetTextById.get(id) ||
          aligned.status === "deleted" ||
          aligned.status === "copy" ||
          aligned.human
        ) {
          continue;
        }
        validIds.add(id);
      }
      const existingNow = await this.annotationStore.read(
        sourceUri,
        state.targetLanguage,
      );
      if (validIds.size === 0) {
        return {
          annotations: existingNow.annotations,
          added: 0,
          reviewed: 0,
        };
      }
      const next = [
        ...existingNow.annotations.filter(
          (entry) =>
            !(entry.author === "ai" && reviewedIds.has(entry.blockId)),
        ),
        ...records.filter((entry) => validIds.has(entry.blockId)),
      ];
      await this.annotationStore.write(
        sourceUri,
        state.targetLanguage,
        next,
      );
      const validRecords = records.filter((entry) =>
        validIds.has(entry.blockId),
      );
      this.log(
        `review ${validIds.size} block(s) of ${path.basename(sourceUri.fsPath)}: ${validRecords.length} annotation(s)`,
      );
      return {
        annotations: next,
        added: validRecords.length,
        reviewed: validIds.size,
      };
    });
  }

  /**
   * 添加用户批注；所有用户批注都是翻译修改指令。
   *
   * `resolveAnnotationId` 用于采纳 AI 处理项：同一把锁里创建用户批注并把对应
   * AI 批注标为已核对，避免两次写 sidecar。
   */
  async saveUserAnnotation(
    sourceUri: vscode.Uri,
    blockIndex: number,
    input: {
      side: "source" | "target";
      message: string;
      /** 生效方式；缺省仅一次。 */
      mode?: AnnotationMode;
      /** 关联的 AI 批注；采纳处理项时使用。 */
      originAnnotationId?: string;
      /** 采纳回答时一并标记已核对的 AI 批注。 */
      resolveAnnotationId?: string;
      /** 旧调用兼容；新调用不需要。 */
      kind?: "note" | "request-change";
      expected?: { sourceHash?: string; cacheId?: string };
    },
  ): Promise<AnnotationRecord[]> {
    return this.withLock(sourceUri, async () => {
      const state = await this.loadState(sourceUri, false);
      const source = parseMarkdownDocument(state.sourceText, this.md);
      const cache = parseCacheDocument(state.cacheText ?? "", this.md);
      const alignment = alignDocument(source.blocks, cache);
      const aligned = alignment.blocks.find(
        (item) => item.source.index === blockIndex,
      );
      if (!aligned) {
        throw new Error(
          tError("common.missingSourceBlock", { index: blockIndex + 1 }),
        );
      }
      if (!aligned.source.translatable || aligned.status === "deleted") {
        throw new Error(tError("sync.blockNotTranslatable"));
      }
      if (
        input.expected?.sourceHash &&
        aligned.source.hash !== input.expected.sourceHash
      ) {
        throw new Error(tError("sync.sourceUpdatedRefresh"));
      }
      if (
        input.expected?.cacheId &&
        aligned.cache?.anchor.id !== input.expected.cacheId
      ) {
        throw new Error(tError("sync.translationChangedRefresh"));
      }
      const message = normalizeAnnotationText(
        input.message,
        MAX_ANNOTATION_MESSAGE,
      );
      if (!message) {
        throw new Error(tError("sync.annotationEmpty"));
      }
      const blockId =
        aligned.cache?.anchor.id ?? `src-${aligned.source.hash}`;
      const now = new Date().toISOString();
      const existing = await this.annotationStore.read(
        sourceUri,
        state.targetLanguage,
      );
      if (input.resolveAnnotationId) {
        const target = existing.annotations.find(
          (entry) => entry.id === input.resolveAnnotationId,
        );
        if (
          !target ||
          target.author !== "ai" ||
          target.status !== "open" ||
          target.blockId !== blockId
        ) {
          throw new Error(tError("sync.annotationNotFound"));
        }
      }
      const record: AnnotationRecord = {
        id: `user-${newBlockId()}`,
        blockId,
        side: input.side,
        author: "user",
        kind: "request-change",
        severity: "info",
        message,
        mode: input.mode ?? "once",
        status: "pending",
        sourceHash: aligned.source.hash,
        sourceIndex: aligned.source.index,
        ...(input.originAnnotationId ?? input.resolveAnnotationId
          ? {
              originAnnotationId:
                input.originAnnotationId ?? input.resolveAnnotationId,
            }
          : {}),
        createdAt: now,
        updatedAt: now,
      };
      const next = input.resolveAnnotationId
        ? existing.annotations
            .map((entry) =>
              entry.id === input.resolveAnnotationId
                ? {
                    ...entry,
                    status: "resolved" as const,
                    answeredBy: record.id,
                    updatedAt: now,
                  }
                : entry,
            )
            .concat(record)
        : [...existing.annotations, record];
      await this.annotationStore.write(
        sourceUri,
        state.targetLanguage,
        next,
      );
      this.log(
        `save annotation on block ${blockIndex} of ${path.basename(sourceUri.fsPath)}`,
      );
      return next;
    });
  }

  /** 编辑用户批注正文/生效方式/本地分类；编辑后重新进入待生效。 */
  async updateUserAnnotation(
    sourceUri: vscode.Uri,
    annotationId: string,
    input: {
      message?: string;
      mode?: AnnotationMode;
      side?: "source" | "target";
      /** 重试已失效的一次性批注。 */
      reactivate?: boolean;
    },
  ): Promise<AnnotationRecord[]> {
    return this.withLock(sourceUri, async () => {
      const state = await this.loadState(sourceUri, false);
      const existing = await this.annotationStore.read(
        sourceUri,
        state.targetLanguage,
      );
      const target = existing.annotations.find(
        (entry) => entry.id === annotationId,
      );
      if (!target || target.author !== "user") {
        throw new Error(tError("sync.annotationNotFound"));
      }
      // 编辑时尝试重新绑定当前源块，避免 stale 批注编辑后仍然无法生效。
      const source = parseMarkdownDocument(state.sourceText, this.md);
      const cache = parseCacheDocument(state.cacheText ?? "", this.md);
      const alignment = alignDocument(source.blocks, cache);
      const legacyHash = target.blockId.startsWith("src-")
        ? target.blockId.slice(4).trim()
        : undefined;
      // 先按缓存锚点精确匹配；只有找不到锚点时，才用 sourceIndex + 原文哈希回退，
      // 避免源文前插/删除后旧 sourceIndex 先命中另一块。
      let aligned = alignment.blocks.find(
        (item) => item.cache?.anchor.id === target.blockId,
      );
      if (!aligned) {
        const expectedHash = target.sourceHash ?? legacyHash;
        if (target.sourceIndex !== undefined) {
          aligned = alignment.blocks.find(
            (item) =>
              item.source.index === target.sourceIndex &&
              (expectedHash === undefined ||
                item.source.hash === expectedHash),
          );
        } else if (expectedHash !== undefined) {
          const candidates = alignment.blocks.filter(
            (item) => item.source.hash === expectedHash,
          );
          if (candidates.length === 1) {
            aligned = candidates[0];
          }
        }
      }
      const currentHash = aligned?.source.hash;
      const currentIndex = aligned?.source.index;
      const currentBlockId =
        aligned?.cache?.anchor.id ??
        (aligned ? `src-${aligned.source.hash}` : undefined);
      const rebound =
        currentHash !== undefined && currentHash !== target.sourceHash;
      const message =
        input.message !== undefined
          ? normalizeAnnotationText(input.message, MAX_ANNOTATION_MESSAGE)
          : undefined;
      if (input.message !== undefined && !message) {
        throw new Error(tError("sync.annotationEmpty"));
      }
      const mode = input.mode ?? target.mode ?? "once";
      const textChanged =
        message !== undefined && message !== target.message;
      const modeChanged =
        input.mode !== undefined && input.mode !== target.mode;
      const rearm =
        textChanged || modeChanged || rebound || input.reactivate === true;
      const now = new Date().toISOString();
      const next = existing.annotations.map((entry) =>
        entry.id === annotationId
          ? {
              ...entry,
              ...(message !== undefined ? { message } : {}),
              ...(input.side !== undefined ? { side: input.side } : {}),
              ...(currentHash ? { sourceHash: currentHash } : {}),
              ...(currentIndex !== undefined
                ? { sourceIndex: currentIndex }
                : {}),
              ...(currentBlockId ? { blockId: currentBlockId } : {}),
              mode,
              ...(rearm ? { status: "pending" as const } : {}),
              updatedAt: now,
            }
          : entry,
      );
      await this.annotationStore.write(
        sourceUri,
        state.targetLanguage,
        next,
      );
      this.log(
        `update annotation ${annotationId} of ${path.basename(sourceUri.fsPath)}`,
      );
      return next;
    });
  }

  /** 更新批注状态（已核对/忽略/重新打开）。 */
  async setAnnotationStatus(
    sourceUri: vscode.Uri,
    annotationId: string,
    status: AnnotationRecord["status"],
  ): Promise<AnnotationRecord[]> {
    return this.withLock(sourceUri, async () => {
      const state = await this.loadState(sourceUri, false);
      const existing = await this.annotationStore.read(
        sourceUri,
        state.targetLanguage,
      );
      let found = false;
      const now = new Date().toISOString();
      const next = existing.annotations.map((entry) => {
        if (entry.id !== annotationId) {
          return entry;
        }
        found = true;
        const updated = {
          ...entry,
          status,
          updatedAt: now,
        };
        if (status === "open") {
          delete updated.answeredBy;
        }
        return updated;
      });
      if (!found) {
        throw new Error(tError("sync.annotationNotFound"));
      }
      await this.annotationStore.write(
        sourceUri,
        state.targetLanguage,
        next,
      );
      return next;
    });
  }

  /** 删除批注。 */
  async deleteAnnotation(
    sourceUri: vscode.Uri,
    annotationId: string,
  ): Promise<AnnotationRecord[]> {
    return this.withLock(sourceUri, async () => {
      const state = await this.loadState(sourceUri, false);
      const existing = await this.annotationStore.read(
        sourceUri,
        state.targetLanguage,
      );
      const next = existing.annotations.filter(
        (entry) => entry.id !== annotationId,
      );
      if (next.length === existing.annotations.length) {
        throw new Error(tError("sync.annotationNotFound"));
      }
      await this.annotationStore.write(
        sourceUri,
        state.targetLanguage,
        next,
      );
      return next;
    });
  }

  /**
   * 检查当前文件的机器译文是否满足术语表与受保护 Markdown 约束。
   *
   * 使用与同步相同的合并术语表；人工锁定块不会出现在结果中，避免一键重译覆盖
   * 手工成果。无缓存时返回 `cacheExists: false`，由调用方提示先同步。
   */
  async checkConsistency(sourceUri: vscode.Uri): Promise<ConsistencyReport> {
    const state = await this.loadPreviewState(sourceUri);
    const glossary = await this.loadGlossary(sourceUri);
    return checkDocumentConsistency({
      md: this.md,
      sourceText: state.sourceText,
      cacheText: state.cacheText,
      glossary: mergeGlossaryEntries([
        glossary.entries,
        state.summary?.glossary ?? [],
      ]),
    });
  }

  // ---- 同步与重译 ----

  /**
   * 同步当前文件：保存原文、翻译缺失/过期块并写缓存。
   *
   * `allowPartial` 为 true 时，Provider 分批成功的结果会边翻译边落盘；任一阶段失败且
   * 已有结果时返回部分成功。`signal` 取消时统一转换为 `CancelledError`。
   * 同一文件已有任务时抛错；缓存写入失败会向上抛出。
   */
  async sync(
    sourceUri: vscode.Uri,
    retranslateStale: boolean,
    onProgress?: SyncProgressReporter,
    signal?: AbortSignal,
    allowPartial = false,
    assist?: Partial<TranslationAssistSettings>,
    onRetry?: TranslationRetryReporter,
  ): Promise<SyncOutcome> {
    try {
      return await this.withLock(sourceUri, async () => {
        const state = await this.loadState(sourceUri, true);
        return this.syncInternal(
          state,
          retranslateStale,
          onProgress,
          signal,
          false,
          allowPartial,
          assist,
          onRetry,
        );
      });
    } catch (error) {
      if (signal?.aborted) {
        throw new CancelledError();
      }
      throw error;
    }
  }

  /**
   * 重译所有过期（`stale`）的机器译文；人工块不受影响。
   *
   * 内部走部分模式，因此部分失败时也能保留已成功的结果。
   */
  async retranslateStale(
    sourceUri: vscode.Uri,
    onProgress?: SyncProgressReporter,
    signal?: AbortSignal,
    assist?: Partial<TranslationAssistSettings>,
    onRetry?: TranslationRetryReporter,
  ): Promise<SyncOutcome> {
    return this.sync(
      sourceUri,
      true,
      onProgress,
      signal,
      true,
      assist,
      onRetry,
    );
  }

  /**
   * 重译所有机器译文（`auto`），不区分是否过期；显式 `human` 块与删除墓碑不会被覆盖。
   *
   * 使用部分模式写回，失败时保留旧译文并返回 `partial`。注意：仅手工改过缓存、锚点
   * 模式仍为 `auto` 的块也会被命中。
   */
  async retranslateAll(
    sourceUri: vscode.Uri,
    onProgress?: SyncProgressReporter,
    signal?: AbortSignal,
    assist?: Partial<TranslationAssistSettings>,
    onRetry?: TranslationRetryReporter,
  ): Promise<SyncOutcome> {
    try {
      return await this.withLock(sourceUri, async () => {
        const state = await this.loadState(sourceUri, true);
        return this.syncInternal(
          state,
          true,
          onProgress,
          signal,
          true,
          true,
          assist,
          onRetry,
        );
      });
    } catch (error) {
      if (signal?.aborted) {
        throw new CancelledError();
      }
      throw error;
    }
  }

  /**
   * 批量重译预览中选中的块。
   *
   * 与全量重译不同：只处理选中的块，未选中的块（包括缺失块）保持不变；显式
   * `human` 块也会被重译并改回 `auto`，与单块重译行为一致。排队期间原文或译文
   * 发生变化的块会被跳过并返回原因。
   */
  async retranslateBlocks(
    sourceUri: vscode.Uri,
    targets: readonly BlockOperationTarget[],
    onProgress?: SyncProgressReporter,
    signal?: AbortSignal,
    assist?: Partial<TranslationAssistSettings>,
    onRetry?: TranslationRetryReporter,
  ): Promise<RetranslateBlocksOutcome> {
    try {
      return await this.withLock(sourceUri, async () => {
        const state = await this.loadState(sourceUri, true);
        const source = parseMarkdownDocument(state.sourceText, this.md);
        const cache = parseCacheDocument(state.cacheText ?? "", this.md);
        const alignment = alignDocument(source.blocks, cache);
        const byIndex = new Map(
          alignment.blocks.map((item) => [item.source.index, item]),
        );
        const onlySourceIndexes = new Set<number>();
        const skipped: string[] = [];
        const seen = new Set<number>();
        for (const target of targets) {
          if (seen.has(target.blockIndex)) {
            continue;
          }
          seen.add(target.blockIndex);
          const aligned = byIndex.get(target.blockIndex);
          if (!aligned) {
            skipped.push(
              tError("common.missingSourceBlock", {
                index: target.blockIndex + 1,
              }),
            );
            continue;
          }
          if (!aligned.source.translatable) {
            skipped.push(tError("sync.blockNotTranslatable"));
            continue;
          }
          if (aligned.cache?.anchor.mode === "deleted") {
            skipped.push(
              tError("sync.deletedBlockRetranslate", {
                index: target.blockIndex + 1,
              }),
            );
            continue;
          }
          if (
            target.sourceHash &&
            aligned.source.hash !== target.sourceHash
          ) {
            skipped.push(
              tError("sync.sourceUpdatedRefresh"),
            );
            continue;
          }
          if (
            target.cacheDst &&
            aligned.cache?.anchor.dst !== target.cacheDst
          ) {
            skipped.push(
              tError("sync.translationChangedRefresh"),
            );
            continue;
          }
          if (
            target.human !== undefined &&
            aligned.human !== target.human
          ) {
            skipped.push(
              tError("sync.translationChangedRefresh"),
            );
            continue;
          }
          if (
            target.cacheId &&
            aligned.cache?.anchor.id !== target.cacheId
          ) {
            skipped.push(
              tError("sync.translationChangedRefresh"),
            );
            continue;
          }
          onlySourceIndexes.add(target.blockIndex);
        }
        if (onlySourceIndexes.size === 0) {
          throw new Error(tError("sync.noSelectedBlocks"));
        }
        return {
          outcome: await this.syncInternal(
            state,
            true,
            onProgress,
            signal,
            true,
            true,
            assist,
            onRetry,
            { onlySourceIndexes, includeHuman: true },
          ),
          skipped,
        };
      });
    } catch (error) {
      if (signal?.aborted) {
        throw new CancelledError();
      }
      throw error;
    }
  }

  /**
   * 只重译一个可翻译块。
   *
   * 没有缓存或该块尚未对齐到缓存时，退化为普通全量同步并返回 `mode: "sync"`；
   * 成功单块重译后直接改写缓存并返回 `mode: "block"`。译文结构校验失败会抛错且
   * 不写入。调用方无需处理加锁，本方法内部持有文件锁。
   */
  async retranslateBlock(
    sourceUri: vscode.Uri,
    blockIndex: number,
    signal?: AbortSignal,
    assist?: Partial<TranslationAssistSettings>,
    expected?: {
      sourceHash?: string;
      cacheId?: string;
      cacheDst?: string;
      human?: boolean;
      /** 质检/一致性检查使用：禁止覆盖人工译文，也不允许退化为全量同步。 */
      requireMachine?: boolean;
    },
    onRetry?: TranslationRetryReporter,
  ): Promise<{ mode: "sync" | "block"; outcome?: SyncOutcome }> {
    return this.withLock(sourceUri, async () => {
      const state = await this.loadState(sourceUri, true);
      if (!state.cacheText || !state.cacheText.trim()) {
        if (expected?.requireMachine) {
          throw new Error(tError("sync.noTranslationSyncFirst"));
        }
        return {
          mode: "sync",
          outcome: await this.syncInternal(
            state,
            false,
            undefined,
            signal,
            false,
            false,
            assist,
            onRetry,
          ),
        };
      }
      const source = parseMarkdownDocument(state.sourceText, this.md);
      const cache = parseCacheDocument(state.cacheText, this.md);
      const alignment = alignDocument(source.blocks, cache);
      const aligned = alignment.blocks.find(
        (item) => item.source.index === blockIndex,
      );
      if (!aligned) {
        throw new Error(tError("common.missingSourceBlock", { index: blockIndex + 1 }));
      }
      if (!aligned.source.translatable) {
        throw new Error(tError("sync.blockNotTranslatable"));
      }
      if (expected?.requireMachine && aligned.human) {
        throw new Error(tError("sync.blockLockedRetranslate"));
      }
      if (expected?.sourceHash && aligned.source.hash !== expected.sourceHash) {
        throw new Error(tError("sync.sourceUpdatedRefresh"));
      }
      if (expected?.cacheId && aligned.cache?.anchor.id !== expected.cacheId) {
        throw new Error(tError("sync.translationChangedRefresh"));
      }
      if (expected?.cacheDst && aligned.cache?.anchor.dst !== expected.cacheDst) {
        throw new Error(tError("sync.translationChangedRefresh"));
      }
      if (
        expected?.human !== undefined &&
        aligned.human !== expected.human
      ) {
        throw new Error(tError("sync.translationChangedRefresh"));
      }
      if (expected?.requireMachine && !aligned.cache) {
        throw new Error(tError("sync.noTranslationSyncFirst"));
      }
      if (!aligned.cache) {
        return {
          mode: "sync",
          outcome: await this.syncInternal(
            state,
            false,
            undefined,
            signal,
            false,
            false,
            assist,
            onRetry,
          ),
        };
      }

      const previousTarget = aligned.cache.block.raw;
      const headingPaths = buildHeadingPaths(source.blocks);
      const assistSettings = this.resolveAssist(assist);
      const summary = this.summaryForCache(cache, assistSettings);
      const brief = this.briefForCache(cache, assistSettings);
      const glossary = await this.loadGlossary(sourceUri);
      const annotationRecords = this.annotationsSupported
        ? (
            await this.readAnnotationsForBlock(
              sourceUri,
              state.targetLanguage,
              aligned.cache.anchor.id,
            )
          ).filter(
            (entry) =>
              isUserAnnotationActive(entry) &&
              (!entry.sourceHash ||
                entry.sourceHash === aligned.source.hash),
          )
        : [];
      const annotations = annotationRecords.map((entry) => ({
        author: "user" as const,
        kind: entry.kind as "note" | "request-change",
        text: entry.message,
      }));
      // 批注与旧译文可能冲突时，由 system prompt 明确批注优先；reference 仍按稳定翻译发送。
      const reference =
        assistSettings.stableTranslation &&
        aligned.cache.anchor.mode !== "deleted" &&
        aligned.cache.anchor.mode !== "copy" &&
        aligned.cache.block.raw.trim()
          ? {
              text: aligned.cache.block.raw,
              role: "previous-target" as const,
            }
          : undefined;
      const item = {
        id: aligned.cache.anchor.id,
        text: aligned.source.raw,
        kind: aligned.source.kind,
        headingPath: headingPaths.get(aligned.source.index) ?? [],
        ...(reference ? { reference } : {}),
        ...(annotations.length ? { annotations } : {}),
      };
      const context = buildBlockContext({
        blocks: source.blocks,
        index: aligned.source.index,
        itemText: aligned.source.raw,
        textOf: (block) => block.raw,
      });
      this.log(
        `retranslate block ${blockIndex} of ${path.basename(sourceUri.fsPath)} (${aligned.source.kind}, ${annotations.length} annotation(s))`,
      );
      const rawResult = await this.provider.translate(
        {
          sourceLanguage: state.sourceLanguage,
          targetLanguage: state.targetLanguage,
          items: [item],
          glossary: this.requestGlossary(glossary.entries, cache),
          ...(summary ? { summary } : {}),
          ...(brief ? { brief } : {}),
          ...(context ? { context } : {}),
          ...(onRetry ? { onRetry } : {}),
        },
        signal,
      );
      if (signal?.aborted) {
        throw new CancelledError();
      }
      const outputs = validateTranslationResult([item], rawResult);
      const content = restoreProtectedSyntax(
        item.text,
        outputs.get(item.id) ?? "",
        item.kind,
      );
      const edited = replaceCachedBlock({
        cacheText: state.cacheText,
        cache,
        target: aligned.cache,
        content,
        sourceHash: aligned.source.hash,
        sourceKind: aligned.source.kind,
        mode: "auto",
        md: this.md,
      });
      await this.cacheStore.write(state.cacheUri, edited.text);
      if (annotationRecords.length > 0) {
        try {
          await this.applyAnnotationOutcomes(
            sourceUri,
            state.targetLanguage,
            annotationRecords,
            new Map(
              annotationRecords.map((entry) => [
                entry.id,
                content !== previousTarget,
              ]),
            ),
          );
        } catch (error) {
          this.log(
            `update annotation outcome failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
      return { mode: "block" };
    });
  }

  // ---- 缓存块的单块编辑 ----

  /**
   * 保存预览中的译文编辑，并把该块锁定为人工译文。
   *
   * `expected` 用于乐观并发校验：原文哈希、缓存 id、编辑前的块文本任一与当前不一致
   * 都会拒绝写入，提示用户刷新预览。返回写入后的缓存文本，便于预览立即重渲染。
   * 失败条件：块不存在/不可翻译/无译文、校验不通过、结构改变、缓存不可写。
   */
  async saveTargetEdit(
    sourceUri: vscode.Uri,
    blockIndex: number,
    content: string,
    expected?: {
      baseText?: string;
      sourceHash?: string;
      cacheId?: string;
    },
  ): Promise<string> {
    return this.withLock(sourceUri, async () => {
      const state = await this.loadState(sourceUri, true);
      const source = parseMarkdownDocument(state.sourceText, this.md);
      const cache = parseCacheDocument(state.cacheText ?? "", this.md);
      const alignment = alignDocument(source.blocks, cache);
      const aligned = alignment.blocks.find(
        (item) => item.source.index === blockIndex,
      );
      if (!aligned) {
        throw new Error(tError("common.missingSourceBlock", { index: blockIndex + 1 }));
      }
      if (!aligned.source.translatable) {
        throw new Error(tError("sync.blockNotTranslatable"));
      }
      if (!aligned.cache) {
        throw new Error(tError("sync.noTranslationSyncFirst"));
      }
      if (
        expected?.sourceHash &&
        aligned.source.hash !== expected.sourceHash
      ) {
        throw new Error(tError("sync.sourceUpdatedRefresh"));
      }
      if (
        expected?.cacheId &&
        aligned.cache.anchor.id !== expected.cacheId
      ) {
        throw new Error(tError("sync.translationChangedRefresh"));
      }
      if (
        expected?.baseText !== undefined &&
        aligned.cache.block.raw !== expected.baseText
      ) {
        throw new Error(tError("sync.translationUpdatedRefresh"));
      }
      const edited = replaceCachedBlock({
        cacheText: state.cacheText ?? "",
        cache,
        target: aligned.cache,
        content,
        sourceHash: aligned.source.hash,
        sourceKind: aligned.source.kind,
        mode: "human",
        md: this.md,
      });
      await this.cacheStore.write(state.cacheUri, edited.text);
      this.log(`edit target block ${blockIndex} of ${path.basename(sourceUri.fsPath)} (human)`);
      return edited.text;
    });
  }

  /**
   * 删除某个原文块的译文，但保留锚点与墓碑。
   *
   * 已有缓存：把块内容替换为携带原文/备份的 `mbs-deleted` 标记，模式改为 `deleted`，
   * 之后同步不会重新翻译；尚未翻译：插入一个无备份的墓碑条目来抑制翻译。再次删除
   * 已删除块是幂等的。返回最新缓存文本；失败时不写入。
   */
  async deleteTargetBlock(
    sourceUri: vscode.Uri,
    blockIndex: number,
    expected?: {
      sourceHash?: string;
      cacheId?: string;
      cacheDst?: string;
      human?: boolean;
    },
  ): Promise<string> {
    return this.withLock(sourceUri, async () => {
      const state = await this.loadState(sourceUri, true);
      const source = parseMarkdownDocument(state.sourceText, this.md);
      const cache = parseCacheDocument(state.cacheText ?? "", this.md);
      const alignment = alignDocument(source.blocks, cache);
      const aligned = alignment.blocks.find(
        (item) => item.source.index === blockIndex,
      );
      if (!aligned) {
        throw new Error(tError("common.missingSourceBlock", { index: blockIndex + 1 }));
      }
      if (
        expected?.sourceHash &&
        aligned.source.hash !== expected.sourceHash
      ) {
        throw new Error(tError("sync.sourceUpdatedRefresh"));
      }
      if (
        expected?.cacheId &&
        aligned.cache?.anchor.id !== expected.cacheId
      ) {
        throw new Error(tError("sync.translationChangedRefresh"));
      }
      if (
        expected?.cacheDst &&
        aligned.cache?.anchor.dst !== expected.cacheDst
      ) {
        throw new Error(tError("sync.translationChangedRefresh"));
      }
      if (
        expected?.human !== undefined &&
        aligned.human !== expected.human
      ) {
        throw new Error(tError("sync.translationChangedRefresh"));
      }
      if (aligned.cache?.anchor.mode === "deleted") {
        return state.cacheText ?? "";
      }
      if (aligned.cache) {
        const marker = createDeletedMarker({
          mode:
            aligned.cache.anchor.mode === "target"
              ? "target"
              : aligned.cache.anchor.mode,
          content: aligned.cache.block.raw,
          sourceHash: aligned.cache.anchor.src,
        });
        const edited = replaceCachedBlock({
          cacheText: state.cacheText ?? "",
          cache,
          target: aligned.cache,
          content: marker,
          sourceHash: aligned.source.hash,
          sourceKind: aligned.source.kind,
          mode: "deleted",
          md: this.md,
        });
        await this.cacheStore.write(state.cacheUri, edited.text);
        this.log(`delete target block ${blockIndex} of ${path.basename(sourceUri.fsPath)}`);
        return edited.text;
      }

      const marker = createDeletedMarker();
      // 无缓存时没有可复用的行号，只能按相邻缓存块的位置插入墓碑。
      const entries = this.orderedCacheEntries(cache);
      const insertAt = this.cacheInsertionIndex(
        source,
        cache,
        alignment,
        blockIndex,
      );
      entries.splice(insertAt, 0, {
        anchor: {
          id: newBlockId(),
          kind: aligned.source.kind,
          src: aligned.source.hash,
          dst: blockHash(aligned.source.kind, marker),
          mode: "deleted",
        },
        content: marker,
      });
      const nextText = serializeCacheDocument(
        cache.frontmatter ?? source.frontmatter,
        entries,
        cache.summary,
      );
      await this.cacheStore.write(state.cacheUri, nextText);
      this.log(`delete untranslated block ${blockIndex} of ${path.basename(sourceUri.fsPath)}`);
      return nextText;
    });
  }

  /**
   * 撤销删除：恢复墓碑中备份的译文，或移除无备份的墓碑条目。
   *
   * 恢复时优先使用备份中的原文哈希，使“删除后原文又改过”的译文以过期状态保留而不是
   * 被误认为最新；备份模式非法时回退为 `human`。返回最新缓存文本。
   */
  async undoDeleteTargetBlock(
    sourceUri: vscode.Uri,
    blockIndex: number,
  ): Promise<string> {
    return this.withLock(sourceUri, async () => {
      const state = await this.loadState(sourceUri, true);
      const source = parseMarkdownDocument(state.sourceText, this.md);
      const cache = parseCacheDocument(state.cacheText ?? "", this.md);
      const alignment = alignDocument(source.blocks, cache);
      const aligned = alignment.blocks.find(
        (item) => item.source.index === blockIndex,
      );
      if (!aligned?.cache || aligned.cache.anchor.mode !== "deleted") {
        return state.cacheText ?? "";
      }
      const backup = parseDeletedMarker(aligned.cache.block.raw);
      if (!backup || backup.none || !backup.content) {
        const entries = this.orderedCacheEntries(cache).filter(
          (entry) => entry.anchor.id !== aligned.cache!.anchor.id,
        );
        const nextText = serializeCacheDocument(cache.frontmatter, entries, cache.summary);
        await this.cacheStore.write(state.cacheUri, nextText);
        this.log(`undo delete (remove marker) ${blockIndex}`);
        return nextText;
      }
      const mode =
        backup.mode === "human" ||
        backup.mode === "auto" ||
        backup.mode === "copy"
          ? backup.mode
          : "human";
      const edited = replaceCachedBlock({
        cacheText: state.cacheText ?? "",
        cache,
        target: aligned.cache,
        content: backup.content,
        sourceHash: backup.sourceHash ?? aligned.source.hash,
        sourceKind: aligned.source.kind,
        mode,
        md: this.md,
      });
      await this.cacheStore.write(state.cacheUri, edited.text);
      this.log(`undo delete target block ${blockIndex}`);
      return edited.text;
    });
  }

  /**
   * 计算“在某个原文块之后”对应的缓存插入下标。
   *
   * 优先插到该块缓存之后；该块尚未翻译时，向后找到最近一个有缓存的原文块并插到它
   * 之前；都找不到则插到末尾。`afterIndex < 0` 表示插到最前。
   */
  private cacheInsertionIndex(
    source: ReturnType<typeof parseMarkdownDocument>,
    cache: CacheDocument,
    alignment: ReturnType<typeof alignDocument>,
    afterIndex: number,
  ): number {
    const entries = this.orderedCacheEntries(cache);
    if (afterIndex < 0) {
      return 0;
    }
    const aligned = alignment.blocks.find(
      (item) => item.source.index === afterIndex,
    );
    if (aligned?.cache) {
      const position = entries.findIndex(
        (entry) => entry.anchor.id === aligned.cache!.anchor.id,
      );
      if (position >= 0) {
        return position + 1;
      }
    }
    for (let index = afterIndex + 1; index < source.blocks.length; index += 1) {
      const next = alignment.blocks.find(
        (item) => item.source.index === index,
      );
      if (!next?.cache) {
        continue;
      }
      const position = entries.findIndex(
        (entry) => entry.anchor.id === next.cache!.anchor.id,
      );
      if (position >= 0) {
        return position;
      }
    }
    return entries.length;
  }

  // ---- 回译 ----

  /**
   * 把一个缓存块回译成原文语言，用于人工校对译文是否忠实。
   *
   * 只读操作：不写缓存、不加文件锁。要求缓存存在且该块可翻译；返回原文、回译文本、
   * 行号与锚点信息。Provider 失败或空结果会抛错。
   */
  async backTranslateBlock(
    sourceUri: vscode.Uri,
    blockIndex: number,
    signal?: AbortSignal,
    assist?: Partial<TranslationAssistSettings>,
    expected?: {
      sourceHash?: string;
      cacheId?: string;
      cacheDst?: string;
      human?: boolean;
    },
    onRetry?: TranslationRetryReporter,
  ): Promise<BackTranslationResult> {
    if (signal?.aborted) {
      throw new CancelledError();
    }
    const state = await this.loadState(sourceUri, true);
    if (!state.cacheText?.trim()) {
      throw new Error(tError("sync.cacheMissingBackTranslate"));
    }
    if (
      state.sourceLanguage.toLowerCase() === state.targetLanguage.toLowerCase()
    ) {
      throw new Error(tError("sync.sameLanguageBack"));
    }
    const source = parseMarkdownDocument(state.sourceText, this.md);
    const cache = parseCacheDocument(state.cacheText, this.md);
    const alignment = alignDocument(source.blocks, cache);
    const aligned = alignment.blocks.find(
      (item) => item.source.index === blockIndex,
    );
    if (!aligned) {
      throw new Error(tError("common.missingSourceBlock", { index: blockIndex + 1 }));
    }
    if (!aligned.source.translatable) {
      throw new Error(tError("sync.blockNotTranslatable"));
    }
    if (!aligned.cache) {
      throw new Error(tError("sync.noTranslationBack"));
    }
    if (
      expected?.sourceHash &&
      aligned.source.hash !== expected.sourceHash
    ) {
      throw new Error(tError("sync.sourceUpdatedRefresh"));
    }
    if (
      expected?.cacheId &&
      aligned.cache.anchor.id !== expected.cacheId
    ) {
      throw new Error(tError("sync.translationChangedRefresh"));
    }
    if (
      expected?.cacheDst &&
      aligned.cache.anchor.dst !== expected.cacheDst
    ) {
      throw new Error(tError("sync.translationChangedRefresh"));
    }
    if (
      expected?.human !== undefined &&
      aligned.human !== expected.human
    ) {
      throw new Error(tError("sync.translationChangedRefresh"));
    }
    const headingPaths = buildHeadingPaths(source.blocks);
    const assistSettings = this.resolveAssist(assist);
    const summary = this.summaryForCache(cache, assistSettings);
    const brief = this.briefForCache(cache, assistSettings);
    const item = {
      id: `back-${aligned.cache.anchor.id}`,
      text: aligned.cache.block.raw,
      kind: aligned.source.kind,
      headingPath: headingPaths.get(aligned.source.index) ?? [],
      ...(assistSettings.stableTranslation && aligned.source.raw.trim()
        ? {
            reference: {
              text: aligned.source.raw,
              role: "previous-source" as const,
            },
          }
        : {}),
    };
    // 回译的邻块上下文来自目标语言缓存；缺少译文的块跳过。
    const targetByIndex = new Map<number, string>();
    for (const row of alignment.blocks) {
      if (row.cache?.block.raw.trim()) {
        targetByIndex.set(row.source.index, row.cache.block.raw);
      }
    }
    const context = buildBlockContext({
      blocks: source.blocks,
      index: aligned.source.index,
      itemText: aligned.cache.block.raw,
      textOf: (block) => targetByIndex.get(block.index),
    });
    const rawResult = await this.provider.translate(
      {
        sourceLanguage: state.targetLanguage,
        targetLanguage: state.sourceLanguage,
        items: [item],
        glossary: [],
        ...(summary ? { summary } : {}),
        ...(brief ? { brief } : {}),
        ...(context ? { context } : {}),
        ...(onRetry ? { onRetry } : {}),
      },
      signal,
    );
    if (signal?.aborted) {
      throw new CancelledError();
    }
    const outputs = validateTranslationResult([item], rawResult);
    const backText = restoreProtectedSyntax(
      item.text,
      outputs.get(item.id) ?? "",
      item.kind,
    ).trim();
    if (!backText) {
      throw new Error(tError("sync.backEmpty"));
    }
    return {
      sourceText: aligned.source.raw,
      backText,
      line: aligned.source.startLine + 1,
      kind: aligned.source.kind,
      headingPath: item.headingPath,
      sourceHash: aligned.source.hash,
      cacheId: aligned.cache.anchor.id,
      sourceLanguage: state.sourceLanguage,
      targetLanguage: state.targetLanguage,
    };
  }

  /**
   * 回译一段任意译文草稿（不要求已写入缓存）。
   *
   * 只用于预览校验：把草稿按 `paragraph` 处理，不使用缓存内容，也不写任何文件。
   * 返回空结果或 Provider 失败时抛错；`signal` 取消抛 `CancelledError`。
   */
  async backTranslateTargetText(
    sourceUri: vscode.Uri,
    text: string,
    signal?: AbortSignal,
    summary?: string,
    onRetry?: TranslationRetryReporter,
  ): Promise<string> {
    if (signal?.aborted) {
      throw new CancelledError();
    }
    const state = await this.loadState(sourceUri, false);
    if (
      state.sourceLanguage.toLowerCase() === state.targetLanguage.toLowerCase()
    ) {
      throw new Error(tError("sync.sameLanguageBack"));
    }
    const item = {
      id: "mbs-target-draft",
      text,
      kind: "paragraph" as const,
      headingPath: [],
    };
    const rawResult = await this.provider.translate(
      {
        sourceLanguage: state.targetLanguage,
        targetLanguage: state.sourceLanguage,
        items: [item],
        glossary: [],
        ...(summary?.trim() ? { summary } : {}),
        ...(onRetry ? { onRetry } : {}),
      },
      signal,
    );
    if (signal?.aborted) {
      throw new CancelledError();
    }
    const outputs = validateTranslationResult([item], rawResult);
    const result = restoreProtectedSyntax(
      item.text,
      outputs.get(item.id) ?? "",
      item.kind,
    ).trim();
    if (!result) {
      throw new Error(tError("sync.backEmpty"));
    }
    return result;
  }

  // ---- 全文摘要 ----

  /**
   * 读取当前缓存的全文摘要；缓存不存在或没有摘要时返回 undefined。
   * 只读，不触发翻译。
   */
  async loadSummary(sourceUri: vscode.Uri): Promise<CacheSummary | undefined> {
    const state = await this.loadPreviewState(sourceUri);
    return state.summary;
  }

  /**
   * 手动生成全文摘要。只接受已保存的原文，超过输入上限时拒绝并提示手动填写。
   * 成功后把摘要写入译文缓存并返回最新缓存文本。
   */
  async generateSummary(
    sourceUri: vscode.Uri,
    signal?: AbortSignal,
  ): Promise<string> {
    return this.withLock(sourceUri, () =>
      this.generateSummaryUnlocked(sourceUri, signal),
    );
  }

  private async generateSummaryUnlocked(
    sourceUri: vscode.Uri,
    signal?: AbortSignal,
  ): Promise<string> {
    if (signal?.aborted) {
      throw new CancelledError();
    }
    if (!this.provider.supportsSummary || !this.provider.summarize) {
      throw new Error(
        tError("sync.summaryUnsupported"),
      );
    }
    const state = await this.loadState(
      sourceUri,
      true,
      tError("sync.purposeGenerateSummary"),
    );
    if (!state.sourceText.trim()) {
      throw new Error(tError("sync.sourceEmptySummary"));
    }
    const sourceDocument = parseMarkdownDocument(state.sourceText, this.md);
    const documentMetadata = buildDocumentMetadata(
      sourceDocument.frontmatter?.raw,
      this.relativeDocumentPath(sourceUri),
    );
    const summaryText = stripFrontmatterText(
      state.sourceText,
      sourceDocument.frontmatter?.raw,
    );
    if (!summaryText.trim()) {
      throw new Error(tError("sync.sourceEmptySummary"));
    }
    const metadataTokens = documentMetadata
      ? estimateTokenCount(JSON.stringify(documentMetadata))
      : 0;
    if (
      estimateTokenCount(summaryText) + metadataTokens >
      SUMMARY_MAX_INPUT_TOKENS
    ) {
      throw new Error(
        tError("sync.summaryTooLongInput", { tokens: SUMMARY_MAX_INPUT_TOKENS }),
      );
    }
    const scopedGlossary = await this.loadGlossary(sourceUri);
    // 重新生成摘要时保留已有文档术语条目，避免覆盖用户在预览中的修改；
    // 需要彻底重建时先清除摘要（会同时清除术语表）再生成。
    const existingCache = parseCacheDocument(state.cacheText ?? "", this.md);
    const existingGlossary = existingCache.summary?.glossary ?? [];
    const result = await this.provider.summarize(
      {
        text: summaryText,
        sourceLanguage: state.sourceLanguage,
        targetLanguage: state.targetLanguage,
        outputLanguage: this.assistantLanguageFor(
          state.sourceLanguage,
          state.targetLanguage,
        ),
        title:
          documentMetadata?.title ??
          documentMetadata?.name ??
          path.basename(sourceUri.fsPath),
        ...(documentMetadata ? { documentMetadata } : {}),
        glossary: mergeGlossaryEntries([
          scopedGlossary.entries,
          existingGlossary,
        ]),
      },
      signal,
    );
    if (signal?.aborted) {
      throw new CancelledError();
    }
    const text = result.summary.trim();
    if (!text) {
      throw new Error(tError("sync.aiEmptySummary"));
    }
    const generatedGlossary = filterGeneratedGlossary(
      result.glossary,
      summaryText,
      {
        // 文档术语表用于跨块一致性：只出现一次的词不需要一致性约束；
        // 用户术语表已覆盖的 source 也不重复收录，避免覆盖用户选择。
        minOccurrences: 2,
        reservedSources: scopedGlossary.entries.map((entry) => entry.source),
      },
    );
    if (generatedGlossary.dropped.length > 0) {
      this.log(
        `summary glossary: dropped ${generatedGlossary.dropped.length} generated entries (${[
          ...new Set(generatedGlossary.dropped.map((entry) => entry.reason)),
        ].join(", ")})`,
      );
    }
    // 持久化稳定 provider id（mock/openai/http），显示名在渲染时按当前 locale 映射，
    // 避免缓存内容随界面语言变化。BatchTranslationCoordinator 的 id 带 batch: 前缀，
    // 只用于运行时路由，不写入缓存。
    const generatedBrief = normalizeTranslationBrief(result.brief);
    return this.writeSummary(state, {
      text,
      model: this.provider.id.replace(/^batch:/, ""),
      glossary: this.mergeGeneratedGlossary(
        existingGlossary,
        generatedGlossary.entries,
      ),
      brief: hasTranslationBrief(generatedBrief)
        ? generatedBrief
        : existingCache.summary?.brief,
    });
  }

  /** 合并生成术语：已有条目优先保留，生成条目只填剩余槽位。 */
  private mergeGeneratedGlossary(
    existing: readonly GlossaryEntry[],
    generated: readonly GlossaryEntry[],
  ): GlossaryEntry[] {
    const existingSources = new Set(
      existing.map((entry) => entry.source.toLowerCase()),
    );
    const capacity = Math.max(
      0,
      MAX_DOCUMENT_GLOSSARY_ENTRIES - existing.length,
    );
    const additions = generated
      .filter((entry) => !existingSources.has(entry.source.toLowerCase()))
      .slice(0, capacity);
    return [...existing, ...additions];
  }

  /** 保存用户在预览中编辑的摘要；保留随摘要生成的文档术语表。 */
  async saveSummary(sourceUri: vscode.Uri, text: string): Promise<string> {
    return this.withLock(sourceUri, () =>
      this.saveSummaryUnlocked(sourceUri, text),
    );
  }

  private async saveSummaryUnlocked(
    sourceUri: vscode.Uri,
    text: string,
  ): Promise<string> {
    if (!text.trim()) {
      throw new Error(tError("sync.summaryEmpty"));
    }
    const state = await this.loadState(
      sourceUri,
      true,
      tError("sync.purposeSaveSummary"),
    );
    const cache = parseCacheDocument(state.cacheText ?? "", this.md);
    return this.writeSummary(state, {
      text,
      model: "manual",
      glossary: cache.summary?.glossary ?? [],
      brief: cache.summary?.brief,
    });
  }

  /**
   * 保存整份文档简报：摘要正文 + brief + 术语表一次写入。
   * 只改摘要/ brief 时刷新 updatedAt/sourceHash；只改术语表时保留原有时间与哈希。
   */
  async saveBrief(
    sourceUri: vscode.Uri,
    input: {
      text: string;
      brief?: TranslationBrief;
      glossary?: readonly GlossaryEntry[];
    },
  ): Promise<string> {
    return this.withLock(sourceUri, () =>
      this.saveBriefUnlocked(sourceUri, input),
    );
  }

  private async saveBriefUnlocked(
    sourceUri: vscode.Uri,
    input: {
      text: string;
      brief?: TranslationBrief;
      glossary?: readonly GlossaryEntry[];
    },
  ): Promise<string> {
    const text = input.text.trim();
    if (!text) {
      throw new Error(tError("sync.summaryEmpty"));
    }
    const state = await this.loadState(
      sourceUri,
      true,
      tError("sync.purposeSaveSummary"),
    );
    const cache = parseCacheDocument(state.cacheText ?? "", this.md);
    const previous = cache.summary;
    const brief =
      input.brief !== undefined
        ? normalizeTranslationBrief(input.brief)
        : previous?.brief;
    const glossary =
      input.glossary !== undefined
        ? [...input.glossary]
        : previous?.glossary ?? [];
    const briefChanged =
      input.brief !== undefined &&
      JSON.stringify(previous?.brief ?? {}) !== JSON.stringify(brief);
    const textChanged = !previous || previous.text.trim() !== text;
    const detailsChanged = textChanged || briefChanged;
    return this.writeSummary(state, {
      text,
      model: detailsChanged ? "manual" : previous?.model,
      glossary,
      updatedAt: detailsChanged
        ? new Date().toISOString()
        : previous?.updatedAt,
      // brief/术语表改动不代表摘要正文已跟上新原文。
      sourceHash: textChanged
        ? summarySourceHash(state.sourceText)
        : previous?.sourceHash,
      brief,
    });
  }

  /**
   * 保存预览中编辑的文档术语表；必须已有全文摘要（术语表属于摘要元数据）。
   * 空数组表示只清空术语表，保留摘要。
   */
  async saveDocumentGlossary(
    sourceUri: vscode.Uri,
    entries: readonly GlossaryEntry[],
  ): Promise<string> {
    return this.withLock(sourceUri, () =>
      this.saveDocumentGlossaryUnlocked(sourceUri, entries),
    );
  }

  private async saveDocumentGlossaryUnlocked(
    sourceUri: vscode.Uri,
    entries: readonly GlossaryEntry[],
  ): Promise<string> {
    const state = await this.loadState(
      sourceUri,
      true,
      tError("sync.purposeSaveGlossary"),
    );
    const cache = parseCacheDocument(state.cacheText ?? "", this.md);
    if (!cache.summary?.text.trim()) {
      throw new Error(tError("sync.glossaryNoSummary"));
    }
    return this.writeSummary(state, {
      text: cache.summary.text,
      model: cache.summary.model,
      glossary: entries,
      updatedAt: cache.summary.updatedAt,
      sourceHash: cache.summary.sourceHash,
      brief: cache.summary.brief,
    });
  }

  /**
   * 删除缓存中的摘要，保留译文块；若缓存只剩空文件则删除文件。
   * 返回最新缓存文本（缓存文件被删除时为 undefined）。
   */
  async clearSummary(
    sourceUri: vscode.Uri,
  ): Promise<string | undefined> {
    return this.withLock(sourceUri, () =>
      this.clearSummaryUnlocked(sourceUri),
    );
  }

  private async clearSummaryUnlocked(
    sourceUri: vscode.Uri,
  ): Promise<string | undefined> {
    const state = await this.loadState(sourceUri, false);
    if (!state.cacheText?.trim()) {
      return undefined;
    }
    const cache = parseCacheDocument(state.cacheText, this.md);
    if (!cache.summary) {
      return state.cacheText;
    }
    const entries = this.orderedCacheEntries(cache);
    const nextText = serializeCacheDocument(cache.frontmatter, entries);
    if (!nextText.trim()) {
      await this.cacheStore.delete(state.cacheUri);
      this.log(`clear summary and empty cache of ${path.basename(sourceUri.fsPath)}`);
      return undefined;
    }
    await this.cacheStore.write(state.cacheUri, nextText);
    this.log(`clear summary of ${path.basename(sourceUri.fsPath)}`);
    return nextText;
  }

  /** 摘要写入会重排缓存条目，存在未跟踪/孤儿锚点时拒绝，避免静默丢失内容。 */
  private assertCacheSummaryWritable(cache: CacheDocument): void {
    if (cache.untracked.length > 0) {
      throw new Error(
        tError("sync.summaryUntrackedCache"),
      );
    }
    if (cache.orphanAnchors.length > 0) {
      throw new Error(
        tError("sync.summaryOrphanAnchor"),
      );
    }
  }

  /** 把摘要、brief 与文档术语表写入缓存；没有缓存文件时创建只含元数据的缓存。 */
  private async writeSummary(
    state: LoadedState,
    input: {
      text: string;
      model?: string;
      glossary?: readonly GlossaryEntry[];
      updatedAt?: string;
      sourceHash?: string;
      brief?: TranslationBrief;
    },
  ): Promise<string> {
    const summaryText = input.text.trim();
    if (summaryText.length > MAX_SUMMARY_CHARS) {
      throw new Error(
        tError("sync.summaryTooLong", { chars: MAX_SUMMARY_CHARS }),
      );
    }
    const normalizedGlossary = normalizeGlossaryEntries(
      input.glossary ?? [],
      MAX_DOCUMENT_GLOSSARY_ENTRIES,
    );
    const normalizedBrief = normalizeTranslationBrief(input.brief);
    const cache = parseCacheDocument(state.cacheText ?? "", this.md);
    this.assertCacheSummaryWritable(cache);
    const entries = this.orderedCacheEntries(cache);
    const nextText = serializeCacheDocument(
      cache.frontmatter ?? parseMarkdownDocument(state.sourceText, this.md).frontmatter,
      entries,
      {
        text: summaryText,
        sourceHash: input.sourceHash ?? summarySourceHash(state.sourceText),
        updatedAt: input.updatedAt ?? new Date().toISOString(),
        ...(input.model ? { model: input.model } : {}),
        ...(normalizedGlossary.length > 0
          ? { glossary: normalizedGlossary }
          : {}),
        ...(hasTranslationBrief(normalizedBrief)
          ? { brief: normalizedBrief }
          : {}),
      },
    );
    await this.cacheStore.write(state.cacheUri, nextText);
    this.log(`write summary of ${path.basename(state.sourceUri.fsPath)}`);
    return nextText;
  }

  // ---- target-only 块与原文插入联动 ----

  /**
   * 把预览中暂存的“新增译文”关联到刚插入原文的新块。
   *
   * 每次根据回译文本重新解析原文，要求恰好是一个块且能在当前原文中按哈希找到，然后
   * 以 `human` 模式插入缓存。多个 draft 依次处理，每次都重新解析缓存以保证位置正确。
   *
   * 返回 `undefined` 表示没有 draft；失败时抛错且不写入。内部持有文件锁。
   */
  async attachTargetDrafts(
    sourceUri: vscode.Uri,
    drafts: readonly {
      targetText: string;
      generatedSourceText: string;
    }[],
  ): Promise<string | undefined> {
    if (drafts.length === 0) {
      return undefined;
    }
    return this.withLock(sourceUri, async () => {
      const state = await this.loadState(sourceUri, false);
      if (!state.cacheText?.trim()) {
        throw new Error(tError("sync.cacheMissingLink"));
      }
      let cacheText = state.cacheText;
      const usedIds = new Set<string>();

      for (const draft of drafts) {
        const source = parseMarkdownDocument(state.sourceText, this.md);
        const generated = parseMarkdownDocument(
          draft.generatedSourceText,
          this.md,
        );
        if (generated.blocks.length !== 1) {
          throw new Error(
            tError("sync.backMultiBlock"),
          );
        }
        const generatedBlock = generated.blocks[0];
        const target = source.blocks.find(
          (block) => block.hash === generatedBlock.hash,
        );
        if (!target) {
          throw new Error(tError("sync.backSourceMissingLink"));
        }
        const cache = parseCacheDocument(cacheText, this.md);
        const alignment = alignDocument(source.blocks, cache);
        const byIndex = new Map(
          alignment.blocks.map((block) => [block.source.index, block]),
        );
        if (byIndex.get(target.index)?.cache) {
          throw new Error(tError("sync.backSourceAlreadyTranslated"));
        }

        const entries = cache.blocks.map((block) => ({
          anchor: block.anchor,
          content: block.block.raw,
        }));
        for (const block of cache.blocks) {
          usedIds.add(block.anchor.id);
        }
        let insertAt = entries.length;
        for (let index = target.index - 1; index >= 0; index -= 1) {
          const previous = byIndex.get(index);
          if (!previous?.cache) {
            continue;
          }
          const position = cache.blocks.indexOf(previous.cache);
          if (position >= 0) {
            insertAt = position + 1;
            break;
          }
        }
        if (insertAt === entries.length) {
          for (let index = target.index + 1; index < source.blocks.length; index += 1) {
            const next = byIndex.get(index);
            if (!next?.cache) {
              continue;
            }
            const position = cache.blocks.indexOf(next.cache);
            if (position >= 0) {
              insertAt = position;
              break;
            }
          }
        }

        let id: string;
        do {
          id = newBlockId();
        } while (usedIds.has(id));
        usedIds.add(id);
        entries.splice(insertAt, 0, {
          anchor: {
            id,
            kind: target.kind,
            src: target.hash,
            dst: blockHash(target.kind, draft.targetText),
            mode: "human",
          },
          content: draft.targetText,
        });
        cacheText = serializeCacheDocument(cache.frontmatter, entries, cache.summary);
      }

      await this.cacheStore.write(state.cacheUri, cacheText);
      this.log(
        `attach ${drafts.length} target insertion(s) to ${path.basename(sourceUri.fsPath)}`,
      );
      return cacheText;
    });
  }

  /**
   * 在某个原文块之后插入一个只有译文的 target 块。
   *
   * `afterIndex === -1` 表示插到最前；新块的 `src` 记录 `t-<锚定原文哈希>` 或 `start`，
   * 供后续重排/回译定位。要求缓存无未跟踪内容、目标原文块存在、文本非空。
   * 写入后返回最新缓存文本；不进入 `withLock`，调用方需自行避免并发写同一缓存。
   */
  async insertTargetBlock(
    sourceUri: vscode.Uri,
    afterIndex: number,
    text: string,
  ): Promise<string> {
    if (!text.trim()) {
      throw new Error(tError("sync.emptyTargetBlock"));
    }
    const state = await this.loadState(sourceUri, false);
    const source = parseMarkdownDocument(state.sourceText, this.md);
    const cache = parseCacheDocument(state.cacheText ?? "", this.md);
    if (cache.untracked.length > 0) {
      throw new Error(tError("sync.cacheUntrackedForTargetInsert"));
    }
    if (afterIndex !== -1 && !source.blocks.some((item) => item.index === afterIndex)) {
      throw new Error(tError("common.missingInsertedSourceBlock", { index: afterIndex + 1 }));
    }
    const alignment = alignDocument(source.blocks, cache);
    const entries = this.orderedCacheEntries(cache);
    let insertAt = entries.length;
    let sourceAnchor = "start";
    if (afterIndex !== -1) {
      sourceAnchor = `t-${source.blocks.find((item) => item.index === afterIndex)!.hash}`;
      const aligned = alignment.blocks.find(
        (item) => item.source.index === afterIndex,
      );
      if (aligned?.cache) {
        const position = entries.findIndex(
          (entry) => entry.anchor.id === aligned.cache!.anchor.id,
        );
        if (position >= 0) {
          insertAt = position + 1;
        }
      } else {
        for (
          let index = afterIndex + 1;
          index < source.blocks.length;
          index += 1
        ) {
          const next = alignment.blocks.find(
            (item) => item.source.index === index,
          );
          if (!next?.cache) {
            continue;
          }
          const position = entries.findIndex(
            (entry) => entry.anchor.id === next.cache!.anchor.id,
          );
          if (position >= 0) {
            insertAt = position;
            break;
          }
        }
      }
    } else {
      insertAt = 0;
    }
    const parsed = parseMarkdownDocument(text, this.md);
    const kind = parsed.blocks[0]?.kind ?? "other";
    entries.splice(insertAt, 0, {
      anchor: {
        id: newBlockId(),
        kind,
        src: sourceAnchor,
        dst: blockHash(kind, text),
        mode: "target",
      },
      content: text,
    });
    const nextText = serializeCacheDocument(
      cache.frontmatter ?? source.frontmatter,
      entries,
      cache.summary,
    );
    await this.cacheStore.write(state.cacheUri, nextText);
    this.log(`insert target block after ${afterIndex} of ${path.basename(sourceUri.fsPath)}`);
    return nextText;
  }

  /**
   * 修改 target 块的正文，并按新正文重新解析块类型与 `dst`。
   *
   * 只允许修改已存在的 target 块；`src` 定位信息保持不变。写入后返回最新缓存文本。
   */
  async updateTargetBlock(
    sourceUri: vscode.Uri,
    targetId: string,
    text: string,
  ): Promise<string> {
    if (!text.trim()) {
      throw new Error(tError("sync.emptyTargetBlock"));
    }
    const state = await this.loadState(sourceUri, false);
    const cache = parseCacheDocument(state.cacheText ?? "", this.md);
    const target = cache.targetBlocks.find(
      (item) => item.anchor.id === targetId,
    );
    if (!target) {
      throw new Error(tError("sync.targetMissing"));
    }
    const parsed = parseMarkdownDocument(text, this.md);
    const kind = parsed.blocks[0]?.kind ?? "other";
    const entries = this.orderedCacheEntries(cache).map((entry) =>
      entry.anchor.id === targetId
        ? {
            anchor: {
              ...entry.anchor,
              kind,
              dst: blockHash(kind, text),
            },
            content: text,
          }
        : entry,
    );
    const nextText = serializeCacheDocument(cache.frontmatter, entries, cache.summary);
    await this.cacheStore.write(state.cacheUri, nextText);
    this.log(`update target block ${targetId}`);
    return nextText;
  }

  /**
   * 移除一个 target 块（不写删除墓碑），返回最新缓存文本。
   *
   * 与 `deleteTargetOnlyBlock` 实现相同：直接过滤掉条目并整体重写缓存。
   */
  async removeTargetBlock(
    sourceUri: vscode.Uri,
    targetId: string,
  ): Promise<string> {
    const state = await this.loadState(sourceUri, false);
    const cache = parseCacheDocument(state.cacheText ?? "", this.md);
    const entries = this.orderedCacheEntries(cache).filter(
      (entry) => entry.anchor.id !== targetId,
    );
    const nextText = serializeCacheDocument(cache.frontmatter, entries, cache.summary);
    await this.cacheStore.write(state.cacheUri, nextText);
    this.log(`remove target block ${targetId}`);
    return nextText;
  }

  /**
   * 永久删除一个 target 块（不保留墓碑、不可撤销）。
   *
   * 仅用于“用户明确不再需要这条无原文译文”的场景；块不存在时静默忽略。
   */
  async deleteTargetOnlyBlock(
    sourceUri: vscode.Uri,
    targetId: string,
  ): Promise<string> {
    const state = await this.loadState(sourceUri, false);
    const cache = parseCacheDocument(state.cacheText ?? "", this.md);
    const entries = this.orderedCacheEntries(cache).filter(
      (entry) => entry.anchor.id !== targetId,
    );
    const nextText = serializeCacheDocument(cache.frontmatter, entries, cache.summary);
    await this.cacheStore.write(state.cacheUri, nextText);
    this.log(`delete target-only block ${targetId}`);
    return nextText;
  }

  /**
   * 回译一个 target 块，并推算它对应到原文的插入位置。
   *
   * 锚点为 `start` 时插到最前；`t-<hash>` 能在原文中找到时先取该块位置，否则或结果
   * 落在末尾时，再按 target 与相邻 source 块的相对顺序推断 `afterIndex`。回译文本必须
   * 恰好是一个块。只读，不写缓存；Provider 失败或结构不符会抛错。
   */
  async backTranslateTargetBlock(
    sourceUri: vscode.Uri,
    targetId: string,
    signal?: AbortSignal,
    assist?: Partial<TranslationAssistSettings>,
    onRetry?: TranslationRetryReporter,
  ): Promise<{ text: string; afterIndex: number }> {
    const state = await this.loadState(sourceUri, false);
    const source = parseMarkdownDocument(state.sourceText, this.md);
    const cache = parseCacheDocument(state.cacheText ?? "", this.md);
    const target = cache.targetBlocks.find(
      (item) => item.anchor.id === targetId,
    );
    if (!target) {
      throw new Error(tError("sync.targetMissing"));
    }
    const assistSettings = this.resolveAssist(assist);
    const summary = this.summaryForCache(cache, assistSettings);
    const generated = await this.backTranslateTargetText(
      sourceUri,
      target.block.raw,
      signal,
      summary,
      onRetry,
    );
    const parsed = parseMarkdownDocument(generated, this.md);
    if (parsed.blocks.length !== 1) {
      throw new Error(
        tError("sync.backMultiBlock"),
      );
    }
    const ordered = [...cache.blocks, ...cache.targetBlocks].sort(
      (a, b) => a.anchorLine - b.anchorLine,
    );
    const targetIndex = ordered.findIndex(
      (item) => item.anchor.id === targetId,
    );
    const sourceAnchorIds = new Set(cache.blocks.map((item) => item.anchor.id));
    let afterIndex = source.blocks.length - 1;
    if (target.anchor.src === "start") {
      afterIndex = -1;
    } else if (target.anchor.src.startsWith("t-")) {
      const anchored = source.blocks.find(
        (item) => item.hash === target.anchor.src.slice(2),
      );
      if (anchored) {
        afterIndex = anchored.index;
      }
    }
    if (afterIndex === source.blocks.length - 1) {
      for (let index = targetIndex - 1; index >= 0; index -= 1) {
        if (!sourceAnchorIds.has(ordered[index].anchor.id)) {
          continue;
        }
        const aligned = alignDocument(source.blocks, cache).blocks.find(
          (item) => item.cache?.anchor.id === ordered[index].anchor.id,
        );
        if (aligned) {
          afterIndex = aligned.source.index;
        }
        break;
      }
    }
    if (afterIndex === source.blocks.length - 1) {
      for (let index = targetIndex + 1; index < ordered.length; index += 1) {
        if (!sourceAnchorIds.has(ordered[index].anchor.id)) {
          continue;
        }
        const aligned = alignDocument(source.blocks, cache).blocks.find(
          (item) => item.cache?.anchor.id === ordered[index].anchor.id,
        );
        if (aligned) {
          afterIndex = aligned.source.index - 1;
        }
        break;
      }
    }
    return { text: generated, afterIndex };
  }

  /**
   * 把 target 块关联到一条已存在的原文块，转为 `human` 译文。
   *
   * 回译生成的原文必须恰好一个块且能在原文中找到；只更新锚点（kind/src/mode），
   * 译文内容不变。写入后返回最新缓存文本。不进入 `withLock`。
   */
  async promoteTargetBlock(
    sourceUri: vscode.Uri,
    targetId: string,
    generatedSourceText: string,
  ): Promise<string> {
    const state = await this.loadState(sourceUri, false);
    const source = parseMarkdownDocument(state.sourceText, this.md);
    const cache = parseCacheDocument(state.cacheText ?? "", this.md);
    const target = cache.targetBlocks.find(
      (item) => item.anchor.id === targetId,
    );
    if (!target) {
      throw new Error(tError("sync.targetMissingOrLinked"));
    }
    const generated = parseMarkdownDocument(generatedSourceText, this.md);
    if (generated.blocks.length !== 1) {
      throw new Error(tError("sync.backNotSingleBlock"));
    }
    const sourceBlock = source.blocks.find(
      (item) => item.hash === generated.blocks[0].hash,
    );
    if (!sourceBlock) {
      throw new Error(tError("sync.backSourceMissing"));
    }
    const entries = this.orderedCacheEntries(cache).map((entry) =>
      entry.anchor.id === targetId
        ? {
            anchor: {
              ...entry.anchor,
              kind: sourceBlock.kind,
              src: sourceBlock.hash,
              mode: "human" as const,
            },
            content: entry.content,
          }
        : entry,
    );
    const nextText = serializeCacheDocument(cache.frontmatter, entries, cache.summary);
    await this.cacheStore.write(state.cacheUri, nextText);
    this.log(`promote target block ${targetId} to source ${sourceBlock.hash}`);
    return nextText;
  }

  /**
   * 在原文被改写后，把已有缓存块重新锚定到新原文块并锁定为人工译文。
   *
   * 回译生成的原文必须恰好一个块；若原文中哈希相同的块不止一个，用 `previousBlockIndex`
   * 选择距离最近的。找不到对应原文或缓存不存在时返回 `undefined`（不写缓存）；块已
   * 删除时原样返回缓存文本。默认内部持有文件锁；`lockHeld` 用于外层的整段写回锁。
   */
  async lockCachedBlockToSource(
    sourceUri: vscode.Uri,
    cacheId: string,
    generatedSourceText: string,
    previousBlockIndex?: number,
    lockHeld = false,
  ): Promise<string | undefined> {
    // `lockHeld` 仅由 runWithSourceLock 的写回序列传入，避免同一操作重复加锁。
    const action = async (): Promise<string | undefined> => {
      const state = await this.loadState(sourceUri, false);
      if (!state.cacheText?.trim()) {
        return undefined;
      }
      const cache = parseCacheDocument(state.cacheText, this.md);
      const entries = this.orderedCacheEntries(cache);
      const entry = entries.find((item) => item.anchor.id === cacheId);
      if (!entry || entry.anchor.mode === "deleted") {
        return state.cacheText;
      }
      const generated = parseMarkdownDocument(generatedSourceText, this.md);
      if (generated.blocks.length !== 1) {
        throw new Error(tError("sync.backNotSingleBlockForTarget"));
      }
      const source = parseMarkdownDocument(state.sourceText, this.md);
      const matched = source.blocks.filter(
        (item) => item.hash === generated.blocks[0].hash,
      );
      if (matched.length === 0) {
        return undefined;
      }
      const sourceBlock =
        previousBlockIndex === undefined
          ? matched[0]
          : matched.reduce((best, candidate) =>
              Math.abs(candidate.index - previousBlockIndex) <
              Math.abs(best.index - previousBlockIndex)
                ? candidate
                : best,
            );
      const nextEntries = entries.map((item) =>
        item.anchor.id === cacheId
          ? {
              anchor: {
                ...item.anchor,
                kind: sourceBlock.kind,
                src: sourceBlock.hash,
                dst: blockHash(sourceBlock.kind, item.content),
                mode: "human" as const,
              },
              content: item.content,
            }
          : item,
      );
      const nextText = serializeCacheDocument(cache.frontmatter, nextEntries, cache.summary);
      await this.cacheStore.write(state.cacheUri, nextText);
      this.log(
        `lock block ${cacheId} to source ${sourceBlock.hash} of ${path.basename(sourceUri.fsPath)}`,
      );
      return nextText;
    };
    return lockHeld ? action() : this.withLock(sourceUri, action);
  }

  /**
   * 原文块被删除后，处理其对应缓存，避免留下人工孤儿。
   *
   * `deletedIndices` 基于 `previousSourceText` 的切块结果：`copy`/`deleted` 条目直接
   * 移除；人工或机器译文若仍有内容，则把锚点改为 `target`（`src` 指向前一个未删除
   * 的原文块或 `start`），保留译文作为 target-only 块。没有变化时返回 `undefined`。
   * 默认内部持有文件锁；`lockHeld` 用于外层的整段写回锁。
   */
  async detachDeletedSourceBlocks(
    sourceUri: vscode.Uri,
    previousSourceText: string,
    deletedIndices: readonly number[],
    lockHeld = false,
  ): Promise<string | undefined> {
    if (deletedIndices.length === 0) {
      return undefined;
    }
    const action = async (): Promise<string | undefined> => {
      const state = await this.loadState(sourceUri, false);
      if (!state.cacheText?.trim()) {
        return undefined;
      }
      const cache = parseCacheDocument(state.cacheText, this.md);
      const previous = parseMarkdownDocument(previousSourceText, this.md);
      const alignment = alignDocument(previous.blocks, cache);
      const deleted = new Set(deletedIndices);
      const entries = this.orderedCacheEntries(cache);
      let changed = false;
      for (const index of deletedIndices) {
        const aligned = alignment.blocks.find(
          (item) => item.source.index === index,
        );
        if (!aligned?.cache) {
          continue;
        }
        const position = entries.findIndex(
          (entry) => entry.anchor.id === aligned.cache!.anchor.id,
        );
        if (position < 0) {
          continue;
        }
        const entry = entries[position];
        if (entry.anchor.mode === "deleted" || entry.anchor.mode === "copy") {
          entries.splice(position, 1);
          changed = true;
          continue;
        }
        let sourceAnchor = "start";
        for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
          if (deleted.has(cursor)) {
            continue;
          }
          const prior = previous.blocks.find((item) => item.index === cursor);
          if (prior) {
            sourceAnchor = `t-${prior.hash}`;
          }
          break;
        }
        entries[position] = {
          anchor: {
            ...entry.anchor,
            src: sourceAnchor,
            dst: blockHash(entry.anchor.kind, entry.content),
            mode: "target",
          },
          content: entry.content,
        };
        changed = true;
      }
      if (!changed) {
        return state.cacheText;
      }
      const nextText = serializeCacheDocument(cache.frontmatter, entries, cache.summary);
      await this.cacheStore.write(state.cacheUri, nextText);
      this.log(
        `detach ${deletedIndices.length} deleted source block(s) from ${path.basename(sourceUri.fsPath)}`,
      );
      return nextText;
    };
    return lockHeld ? action() : this.withLock(sourceUri, action);
  }

  /**
   * 把 source 块与 target 块按锚点行号合并为一条有序列表，供整体重写缓存使用。
   *
   * 返回的是新对象，正文取解析后的 `raw`，可直接交给 `serializeCacheDocument`。
   */
  private orderedCacheEntries(cache: CacheDocument): CacheEntry[] {
    return [...cache.blocks, ...cache.targetBlocks]
      .sort((a, b) => a.anchorLine - b.anchorLine)
      .map((item) => ({
        anchor: item.anchor,
        content: item.block.raw,
      }));
  }

  /**
   * 人工确认译文仍适用：把缓存块的 `src` 更新为当前原文哈希并锁定为 `human`。
   *
   * 缓存不存在或该块没有译文时抛错；写入失败向上抛出。内部持有文件锁。
   */
  async markSynced(
    sourceUri: vscode.Uri,
    blockIndex: number,
    expected?: {
      sourceHash?: string;
      cacheId?: string;
      cacheDst?: string;
      human?: boolean;
    },
  ): Promise<void> {
    return this.withLock(sourceUri, async () => {
      const state = await this.loadState(sourceUri, true);
      if (!state.cacheText || !state.cacheText.trim()) {
        throw new Error(tError("sync.cacheMissingMarkSynced"));
      }
      const source = parseMarkdownDocument(state.sourceText, this.md);
      const cache = parseCacheDocument(state.cacheText, this.md);
      const alignment = alignDocument(source.blocks, cache);
      const aligned = alignment.blocks.find(
        (item) => item.source.index === blockIndex,
      );
      if (!aligned?.cache) {
        throw new Error(tError("sync.noTranslationMarkSynced"));
      }
      if (
        expected?.sourceHash &&
        aligned.source.hash !== expected.sourceHash
      ) {
        throw new Error(tError("sync.sourceUpdatedRefresh"));
      }
      if (
        expected?.cacheId &&
        aligned.cache.anchor.id !== expected.cacheId
      ) {
        throw new Error(tError("sync.translationChangedRefresh"));
      }
      if (
        expected?.cacheDst &&
        aligned.cache.anchor.dst !== expected.cacheDst
      ) {
        throw new Error(tError("sync.translationChangedRefresh"));
      }
      if (
        expected?.human !== undefined &&
        aligned.human !== expected.human
      ) {
        throw new Error(tError("sync.translationChangedRefresh"));
      }
      const edited = markCachedBlockSynced({
        cacheText: state.cacheText,
        cache,
        target: aligned.cache,
        sourceHash: aligned.source.hash,
        md: this.md,
      });
      await this.cacheStore.write(state.cacheUri, edited.text);
      this.log(
        `mark synced block ${blockIndex} of ${path.basename(sourceUri.fsPath)}`,
      );
    });
  }

  // ---- 缓存文件与导入 ----

  /** 在编辑器中打开当前原文对应的缓存文件。 */
  async openCacheFile(sourceUri: vscode.Uri): Promise<void> {
    const settings = this.getSettings();
    const cacheUri = this.cacheStore.getCacheUri(
      sourceUri,
      settings.targetLanguage,
    );
    await this.cacheStore.openFile(cacheUri);
  }

  /** 在系统文件管理器中定位当前原文对应的缓存目录。 */
  async openCacheFolder(sourceUri: vscode.Uri): Promise<void> {
    const settings = this.getSettings();
    await this.cacheStore.openFolder(sourceUri, settings.targetLanguage);
  }

  /** 在系统文件管理器中打开全局缓存根目录。 */
  async openGlobalCacheFolder(): Promise<void> {
    await this.cacheStore.openGlobalFolder();
  }

  /**
   * 导入一份已有译文 Markdown，按块结构校验后生成全新缓存并覆盖写入。
   *
   * 译文文件不能是原文本身，且限制 10 MB；结构必须与原文逐块一致。失败时不会写入
   * 任何内容。返回缓存位置与统计。内部持有文件锁。
   */
  async importTranslation(
    sourceUri: vscode.Uri,
    translationUri: vscode.Uri,
  ): Promise<{
    cacheUri: vscode.Uri;
    translatedCount: number;
    copiedCount: number;
  }> {
    if (translationUri.toString() === sourceUri.toString()) {
      throw new Error(tError("sync.importSameFile"));
    }
    return this.withLock(sourceUri, async () => {
      const state = await this.loadState(
        sourceUri,
        true,
        tError("sync.purposeImport"),
      );
      const bytes = await vscode.workspace.fs.readFile(translationUri);
      if (bytes.byteLength > 10_000_000) {
        throw new Error(tError("sync.importTooLarge"));
      }
      const translationText = new TextDecoder("utf-8").decode(bytes);
      const imported = buildImportedCache(
        state.sourceText,
        translationText,
        this.md,
      );
      await this.cacheStore.write(state.cacheUri, imported.cacheText);
      this.log(
        `import translation into ${path.basename(sourceUri.fsPath)}: translated=${imported.translatedCount}, copied=${imported.copiedCount}`,
      );
      return {
        cacheUri: state.cacheUri,
        translatedCount: imported.translatedCount,
        copiedCount: imported.copiedCount,
      };
    });
  }

  /** 判断当前原文是否已有缓存文件（不读取内容）。 */
  async hasCache(sourceUri: vscode.Uri): Promise<boolean> {
    const settings = this.getSettings();
    const cacheUri = this.cacheStore.getCacheUri(
      sourceUri,
      settings.targetLanguage,
    );
    return this.cacheStore.exists(cacheUri);
  }

  /**
   * 删除当前原文的缓存文件；返回是否真的删除了文件。
   *
   * 缓存正在编辑器中打开时删除会失败（由 `CacheStore` 拒绝）。内部持有文件锁。
   */
  async clearCache(sourceUri: vscode.Uri): Promise<boolean> {
    return this.withLock(sourceUri, async () => {
      const settings = this.getSettings();
      const cacheUri = this.cacheStore.getCacheUri(
        sourceUri,
        settings.targetLanguage,
      );
      const removed = await this.cacheStore.delete(cacheUri);
      if (removed) {
        await this.annotationStore.delete(
          sourceUri,
          settings.targetLanguage,
        );
        this.log(`clear cache of ${path.basename(sourceUri.fsPath)}`);
      }
      return removed;
    });
  }

  /**
   * 删除所有文件的缓存，返回删除的文件数。
   *
   * 有同步/导入任务进行中或已有清空任务时拒绝执行；清空期间通过 `clearingAllCaches`
   * 阻止新的带锁操作，避免删除与写入互相踩踏。
   */
  async clearAllCaches(): Promise<number> {
    if (this.inFlight.size > 0 || this.reviewInFlight.size > 0) {
      throw new Error(tError("sync.clearAllBusy"));
    }
    if (this.clearingAllCaches) {
      throw new Error(tError("sync.clearingCacheBusy"));
    }
    this.clearingAllCaches = true;
    try {
      const removed = await this.cacheStore.clearAll();
      this.log(`clear all caches: ${removed} files`);
      return removed;
    } finally {
      this.clearingAllCaches = false;
    }
  }

  // ---- 预览辅助 ----

  /**
   * 在编辑器中打开原文并选中指定块，滚动到可视区域中央。
   *
   * 使用文档当前文本切块，因此未保存的修改也会反映在定位结果中；块不存在时抛错。
   */
  async revealSource(sourceUri: vscode.Uri, blockIndex: number): Promise<void> {
    const document = await vscode.workspace.openTextDocument(sourceUri);
    const source = parseMarkdownDocument(document.getText(), this.md);
    const block = source.blocks.find((item) => item.index === blockIndex);
    if (!block) {
      throw new Error(tError("common.missingSourceBlock", { index: blockIndex + 1 }));
    }
    const endLine = Math.max(block.startLine, block.endLine - 1);
    const selection = new vscode.Range(
      block.startLine,
      0,
      endLine,
      document.lineAt(endLine).text.length,
    );
    const editor = await vscode.window.showTextDocument(document, {
      preview: false,
      selection,
    });
    editor.revealRange(selection, vscode.TextEditorRevealType.InCenter);
  }

  /**
   * 打开预览中的链接。
   *
   * 安全约束：拒绝协议相对地址（`//`、`\\`）；外部地址只允许 http/https/mailto；
   * 页内锚点直接忽略；相对路径按原文目录解析，Markdown 文件用编辑器打开，其他文件
   * 交给 `vscode.open`。无法解析或协议不受支持时抛出本地化错误。
   */
  async openLink(sourceUri: vscode.Uri, rawHref: string): Promise<void> {
    const href = rawHref.trim();
    if (!href) {
      return;
    }
    // 协议相对地址会被解析成当前页面协议，可能指向不可信网络位置，直接拒绝。
    if (/^[\\/]{2}/.test(href)) {
      throw new Error(tError("sync.protocolRelativeLink"));
    }
    let parsed: vscode.Uri;
    try {
      parsed = vscode.Uri.parse(href, true);
    } catch {
      throw new Error(tError("sync.invalidLink"));
    }
    const scheme = parsed.scheme.toLowerCase();
    if (scheme) {
      // 只允许显式的外链协议；其余（file、command、vscode 等）一律拒绝。
      if (scheme === "http" || scheme === "https" || scheme === "mailto") {
        await vscode.env.openExternal(parsed);
        return;
      }
      throw new Error(tError("sync.unsupportedLinkScheme", { scheme: scheme }));
    }
    // 纯页内锚点无需打开任何文件。
    if (parsed.fragment && !parsed.path) {
      return;
    }
    const withoutFragment = href.split("#")[0]?.split("?")[0] ?? "";
    if (!withoutFragment) {
      return;
    }
    let relative = withoutFragment;
    try {
      relative = decodeURIComponent(withoutFragment);
    } catch {
      /* 保留原始路径 */
    }
    // 以 `/` 开头的路径按文件系统绝对路径处理，其余相对于原文所在目录解析。
    const target = relative.startsWith("/")
      ? vscode.Uri.file(relative)
      : vscode.Uri.joinPath(
          vscode.Uri.joinPath(sourceUri, ".."),
          relative,
        );
    if (target.scheme !== "file") {
      throw new Error(tError("sync.linkNotLocalFile"));
    }
    const extension = path.extname(target.fsPath).toLowerCase();
    if (extension === ".md" || extension === ".markdown" || extension === ".mdx") {
      const document = await vscode.workspace.openTextDocument(target);
      await vscode.window.showTextDocument(document, { preview: false });
      return;
    }
    await vscode.commands.executeCommand("vscode.open", target);
  }

  // ---- 内部工具 ----

  /**
   * 真正执行同步并写缓存的内部入口。
   *
   * 调用方必须已经持有文件锁。部分模式时把 `onCacheCommit` 接到 `CacheStore.write`，
   * 使流式结果可以边翻译边落盘；同步结束后再完整写入一次最终结果。术语表告警会合并
   * 进结果告警。
   */
  private async syncInternal(
    state: LoadedState,
    retranslateStale: boolean,
    onProgress?: SyncProgressReporter,
    signal?: AbortSignal,
    retranslateAll = false,
    allowPartial = false,
    assist?: Partial<TranslationAssistSettings>,
    onRetry?: TranslationRetryReporter,
    selective?: {
      onlySourceIndexes: ReadonlySet<number>;
      includeHuman?: boolean;
    },
  ): Promise<SyncOutcome> {
    this.log(
      `sync ${path.basename(state.sourceUri.fsPath)} (${retranslateAll ? "all" : retranslateStale ? "stale" : "missing"}, partial=${allowPartial})`,
    );
    const glossary = await this.loadGlossary(state.sourceUri);
    const assistSettings = this.resolveAssist(assist);
    // 摘要上下文由缓存中的元数据提供；过期摘要仍按用户选择继续使用。
    const cache = state.cacheText?.trim()
      ? parseCacheDocument(state.cacheText, this.md)
      : undefined;
    const summary = this.summaryForCache(cache, assistSettings);
    const brief = this.briefForCache(cache, assistSettings);
    const annotationsSupported = this.annotationsSupported;
    const annotationRead: {
      annotations: AnnotationRecord[];
      warning?: string;
    } = annotationsSupported
      ? await this.annotationStore.read(
          state.sourceUri,
          state.targetLanguage,
        )
      : { annotations: [] };
    if (annotationRead.warning) {
      this.log(annotationRead.warning);
    }
    const activeAnnotations = annotationRead.annotations.filter(
      (entry) => entry.author === "user" && isUserAnnotationActive(entry),
    );
    const syncAnnotations = activeAnnotations.map((entry) => ({
      id: entry.id,
      blockId: entry.blockId,
      ...(entry.sourceIndex !== undefined
        ? { sourceIndex: entry.sourceIndex }
        : {}),
      ...(entry.sourceHash ? { sourceHash: entry.sourceHash } : {}),
      kind:
        entry.kind === "note" || entry.kind === "request-change"
          ? entry.kind
          : ("request-change" as const),
      text: entry.message,
      pending: isUserAnnotationPending(entry),
    }));
    const result = await syncDocument({
      md: this.md,
      sourceText: state.sourceText,
      cacheText: state.cacheText,
      provider: this.provider,
      sourceLanguage: state.sourceLanguage,
      targetLanguage: state.targetLanguage,
      retranslateStale,
      retranslateAll,
      ...(selective
        ? {
            onlySourceIndexes: selective.onlySourceIndexes,
            includeHuman: selective.includeHuman === true,
          }
        : {}),
      glossary: this.requestGlossary(glossary.entries, cache),
      annotations: syncAnnotations,
      assist: {
        stableTranslation: assistSettings.stableTranslation,
        ...(summary ? { summary } : {}),
        ...(brief ? { brief } : {}),
      },
      signal,
      onProgress,
      ...(onRetry ? { onRetry } : {}),
      allowPartial,
      // 只有部分模式需要中间落盘；失败错误会由 syncDocument 回传给调用方。
      onCacheCommit: allowPartial
        ? async (cacheText) => {
            await this.cacheStore.write(state.cacheUri, cacheText);
          }
        : undefined,
    });
    result.warnings.push(...glossary.warnings);
    await this.cacheStore.write(state.cacheUri, result.cacheText);
    try {
      await this.migrateSourceAnnotations(
        state.sourceUri,
        state.targetLanguage,
        state.sourceText,
        result.cacheText,
      );
    } catch (error) {
      this.log(
        `annotation migration failed for ${path.basename(state.sourceUri.fsPath)}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    if (result.annotationOutcomes.length > 0 && activeAnnotations.length > 0) {
      const records = new Map(
        activeAnnotations.map((entry) => [entry.id, entry]),
      );
      const outcomes = new Map<string, boolean>();
      for (const outcome of result.annotationOutcomes) {
        if (records.has(outcome.annotationId)) {
          outcomes.set(outcome.annotationId, outcome.changed);
        }
      }
      if (outcomes.size > 0) {
        try {
          await this.applyAnnotationOutcomes(
            state.sourceUri,
            state.targetLanguage,
            activeAnnotations.filter((entry) => outcomes.has(entry.id)),
            outcomes,
          );
        } catch (error) {
          this.log(
            `update annotation outcomes failed for ${path.basename(state.sourceUri.fsPath)}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
    }
    this.log(
      `sync done: translated=${result.translatedCount}, failed=${result.failedTaskCount}, partial=${result.partial}, copied=${result.copiedCount}, human=${result.humanLockedCount}, annotations=${result.annotationOutcomes.length}, warnings=${result.warnings.length}`,
    );
    return {
      result,
      cacheUri: state.cacheUri,
      settings: {
        sourceLanguage: state.sourceLanguage,
        targetLanguage: state.targetLanguage,
      },
    };
  }

  /** 合并用户术语与文档术语，并把文档条目排在前面，避免请求配额优先截掉它们。 */
  private requestGlossary(
    scoped: readonly GlossaryEntry[],
    cache?: CacheDocument,
  ): GlossaryEntry[] {
    const documentGlossary = cache?.summary?.glossary ?? [];
    return prioritizeGlossaryEntries(
      mergeGlossaryEntries([scoped, documentGlossary]),
      documentGlossary.map((entry) => entry.source),
    );
  }

  /** 加载适用于指定文件的合并术语表；告警写入输出通道但不阻断同步。 */
  private async loadGlossary(
    sourceUri?: vscode.Uri,
  ): Promise<GlossaryLoadResult> {
    const glossary = sourceUri
      ? await this.glossaryStore.loadFor(sourceUri)
      : await this.glossaryStore.load();
    for (const warning of glossary.warnings) {
      this.log(`glossary: ${warning}`);
    }
    return glossary;
  }

  /** 向输出通道追加带 ISO 时间戳的一行日志。 */
  private log(message: string): void {
    this.output.appendLine(
      `[${new Date().toISOString()}] ${message}`,
    );
  }

  /**
   * 在指定源文件的同步锁内执行一段自定义操作。
   *
   * 预览的原文写回需要把「文档替换 + 保存 + 缓存对账」合并为一个临界区，
   * 期间同步命令会因同一文件锁被拒绝。回调内必须调用带 `lockHeld=true` 的
   * detach/lock 方法，避免重复加锁；`promoteTargetBlock` 本身不再加锁。
   *
   * @param sourceUri 源 Markdown 文件。
   * @param action 已持锁时执行的操作。
   * @returns action 的返回值。
   * @throws 清空缓存进行中或同文件已有任务时抛出本地化错误。
   */
  async runWithSourceLock<T>(
    sourceUri: vscode.Uri,
    action: () => Promise<T>,
  ): Promise<T> {
    return this.withLock(sourceUri, action);
  }

  /**
   * 以原文 URI 字符串为键的进程内互斥锁。
   *
   * 进入前检查“正在清空全部缓存”，并拒绝同文件的并发操作；无论成功失败都会释放。
   * 注意该锁只覆盖本进程内调用同一 URI 字符串的操作。
   */
  /** 标记同一文件的审校任务；模型调用期间不占文件锁。 */
  private beginReview(sourceUri: vscode.Uri): () => void {
    const key = sourceUri.toString();
    if (this.clearingAllCaches) {
      throw new Error(tError("sync.clearingCacheBusyOp"));
    }
    if (this.reviewInFlight.has(key)) {
      throw new Error(tError("sync.fileSyncBusy"));
    }
    this.reviewInFlight.add(key);
    return () => {
      this.reviewInFlight.delete(key);
    };
  }

  private async withLock<T>(
    sourceUri: vscode.Uri,
    action: () => Promise<T>,
  ): Promise<T> {
    const key = sourceUri.toString();
    // 清空缓存与写缓存不能交错，否则可能把文件写回正在删除的目录。
    if (this.clearingAllCaches) {
      throw new Error(tError("sync.clearingCacheBusyOp"));
    }
    if (this.inFlight.has(key)) {
      throw new Error(tError("sync.fileSyncBusy"));
    }
    this.inFlight.add(key);
    try {
      return await action();
    } finally {
      this.inFlight.delete(key);
    }
  }
}
