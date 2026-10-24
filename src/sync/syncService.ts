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
import type { GlossaryLoadResult } from "../glossary/glossary";
import type { GlossaryStore } from "../glossary/glossaryStore";
import {
  markCachedBlockSynced,
  replaceCachedBlock,
} from "../cache/editCache";
import { alignDocument } from "../markdown/align";
import { parseCacheDocument } from "../markdown/anchors";
import { buildHeadingPaths } from "../markdown/headings";
import { createMarkdownRuntime } from "../markdown/markdown";
import { parseMarkdownDocument } from "../markdown/segmenter";
import type { BlockKind } from "../markdown/types";
import {
  createDeletedMarker,
  parseDeletedMarker,
} from "../cache/deletedMarker";
import {
  syncDocument,
  serializeCacheDocument,
  type CacheEntry,
  type SyncProgressReporter,
  type SyncResult,
} from "./sync";
import type { CacheDocument } from "../markdown/types";
import type {
  TranslationProvider,
} from "../translation/types";
import {
  validateTranslationResult,
} from "../translation/types";
import { blockHash, newBlockId } from "../util/hash";

const LANGUAGE_TAG = /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/;

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

/** 用户取消操作（关闭保存提示、取消同步等）时抛出的可识别错误。 */
export class CancelledError extends Error {
  /** @param message 展示给用户的取消说明，默认“操作已取消”。 */
  constructor(message = "操作已取消") {
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
  /** 清空全部缓存期间为 true，阻止新的带锁操作与并发清空。 */
  private clearingAllCaches = false;

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
  ) {}

  /** 当前 Provider 的展示名，用于状态栏与提示文案。 */
  get providerLabel(): string {
    return this.provider.label;
  }

  // ---- 配置与状态加载 ----

  /**
   * 读取并校验语言配置。
   *
   * 要求两侧都是形如 `en` / `zh-CN` 的标签，且原文语言与译文语言不同。
   * 配置非法时抛出中文错误；无副作用。
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
        `原文语言设置“${sourceLanguage}”不是有效的 BCP-47 标签（如 en、zh-CN）。`,
      );
    }
    if (!LANGUAGE_TAG.test(targetLanguage)) {
      throw new Error(
        `译文语言设置“${targetLanguage}”不是有效的 BCP-47 标签（如 zh-CN、ja-JP）。`,
      );
    }
    if (sourceLanguage.toLowerCase() === targetLanguage.toLowerCase()) {
      throw new Error("原文语言与译文语言相同，请修改 targetLanguage 设置。");
    }
    return { sourceLanguage, targetLanguage };
  }

  /**
   * 加载某个原文的操作状态。
   *
   * `ensureSaved` 为 true 时，若文档有未保存修改会弹出模态确认并尝试保存；用户拒绝
   * 或保存失败则抛 `CancelledError` / 中文错误。`purpose` 仅用于提示文案。随后计算
   * 缓存路径并读取缓存文本（不存在时为 `undefined`）。除可选的原文保存外，不写缓存。
   */
  async loadState(
    sourceUri: vscode.Uri,
    ensureSaved: boolean,
    purpose = "同步",
  ): Promise<LoadedState> {
    if (sourceUri.scheme !== "file") {
      throw new Error("仅支持本地的 Markdown 文件。请先保存文件到磁盘。");
    }
    const settings = this.getSettings();
    const document = await vscode.workspace.openTextDocument(sourceUri);
    if (ensureSaved && document.isDirty) {
      const saveLabel = `保存并${purpose}`;
      const choice = await vscode.window.showWarningMessage(
        `“${path.basename(sourceUri.fsPath)}”有未保存的修改。${purpose}前需要先保存原文。`,
        { modal: true },
        saveLabel,
      );
      if (choice !== saveLabel) {
        throw new CancelledError();
      }
      const saved = await document.save();
      if (!saved) {
        throw new Error(`保存原文失败，未执行${purpose}。`);
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
    return {
      sourceText: state.sourceText,
      cacheText: state.cacheText,
      cacheUri: state.cacheUri,
      sourceLanguage: state.sourceLanguage,
      targetLanguage: state.targetLanguage,
    };
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
  ): Promise<SyncOutcome> {
    return this.sync(sourceUri, true, onProgress, signal, true);
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
  ): Promise<{ mode: "sync" | "block"; outcome?: SyncOutcome }> {
    return this.withLock(sourceUri, async () => {
      const state = await this.loadState(sourceUri, true);
      if (!state.cacheText || !state.cacheText.trim()) {
        return {
          mode: "sync",
          outcome: await this.syncInternal(
            state,
            false,
            undefined,
            signal,
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
        throw new Error(`找不到第 ${blockIndex + 1} 个原文块。`);
      }
      if (!aligned.source.translatable) {
        throw new Error("这个块不参与翻译（代码、公式、脚注或结构块）。");
      }
      if (!aligned.cache) {
        return {
          mode: "sync",
          outcome: await this.syncInternal(
            state,
            false,
            undefined,
            signal,
          ),
        };
      }

      const headingPaths = buildHeadingPaths(source.blocks);
      const item = {
        id: aligned.cache.anchor.id,
        text: aligned.source.raw,
        kind: aligned.source.kind,
        headingPath: headingPaths.get(aligned.source.index) ?? [],
      };
      this.log(
        `retranslate block ${blockIndex} of ${path.basename(sourceUri.fsPath)} (${aligned.source.kind})`,
      );
      const glossary = await this.loadGlossary();
      const rawResult = await this.provider.translate(
        {
          sourceLanguage: state.sourceLanguage,
          targetLanguage: state.targetLanguage,
          items: [item],
          glossary: glossary.entries,
        },
        signal,
      );
      if (signal?.aborted) {
        throw new CancelledError();
      }
      const outputs = validateTranslationResult([item], rawResult);
      const edited = replaceCachedBlock({
        cacheText: state.cacheText,
        cache,
        target: aligned.cache,
        content: outputs.get(item.id) ?? "",
        sourceHash: aligned.source.hash,
        sourceKind: aligned.source.kind,
        mode: "auto",
        md: this.md,
      });
      await this.cacheStore.write(state.cacheUri, edited.text);
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
        throw new Error(`找不到第 ${blockIndex + 1} 个原文块。`);
      }
      if (!aligned.source.translatable) {
        throw new Error("这个块不参与翻译（代码、公式、脚注或结构块）。");
      }
      if (!aligned.cache) {
        throw new Error("这个块还没有译文，请先同步译文。");
      }
      if (
        expected?.sourceHash &&
        aligned.source.hash !== expected.sourceHash
      ) {
        throw new Error("原文已更新，请刷新预览后重新编辑译文。");
      }
      if (
        expected?.cacheId &&
        aligned.cache.anchor.id !== expected.cacheId
      ) {
        throw new Error("译文块已变化，请刷新预览后重新编辑。");
      }
      if (
        expected?.baseText !== undefined &&
        aligned.cache.block.raw !== expected.baseText
      ) {
        throw new Error("该块译文已更新，请刷新预览后重新编辑。");
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
        throw new Error(`找不到第 ${blockIndex + 1} 个原文块。`);
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
        const nextText = serializeCacheDocument(cache.frontmatter, entries);
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
  ): Promise<BackTranslationResult> {
    if (signal?.aborted) {
      throw new CancelledError();
    }
    const state = await this.loadState(sourceUri, true);
    if (!state.cacheText?.trim()) {
      throw new Error("译文缓存不存在，无法回译。");
    }
    if (
      state.sourceLanguage.toLowerCase() === state.targetLanguage.toLowerCase()
    ) {
      throw new Error("原文语言与译文语言相同，无法回译。");
    }
    const source = parseMarkdownDocument(state.sourceText, this.md);
    const cache = parseCacheDocument(state.cacheText, this.md);
    const alignment = alignDocument(source.blocks, cache);
    const aligned = alignment.blocks.find(
      (item) => item.source.index === blockIndex,
    );
    if (!aligned) {
      throw new Error(`找不到第 ${blockIndex + 1} 个原文块。`);
    }
    if (!aligned.source.translatable) {
      throw new Error("这个块不参与翻译（代码、公式、脚注或结构块）。");
    }
    if (!aligned.cache) {
      throw new Error("这个块还没有译文，无法回译。");
    }
    const headingPaths = buildHeadingPaths(source.blocks);
    const item = {
      id: `back-${aligned.cache.anchor.id}`,
      text: aligned.cache.block.raw,
      kind: aligned.source.kind,
      headingPath: headingPaths.get(aligned.source.index) ?? [],
    };
    const rawResult = await this.provider.translate(
      {
        sourceLanguage: state.targetLanguage,
        targetLanguage: state.sourceLanguage,
        items: [item],
        glossary: [],
      },
      signal,
    );
    if (signal?.aborted) {
      throw new CancelledError();
    }
    const outputs = validateTranslationResult([item], rawResult);
    const backText = outputs.get(item.id)?.trim() ?? "";
    if (!backText) {
      throw new Error("回译结果为空。");
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
  ): Promise<string> {
    if (signal?.aborted) {
      throw new CancelledError();
    }
    const state = await this.loadState(sourceUri, false);
    if (
      state.sourceLanguage.toLowerCase() === state.targetLanguage.toLowerCase()
    ) {
      throw new Error("原文语言与译文语言相同，无法回译。");
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
      },
      signal,
    );
    if (signal?.aborted) {
      throw new CancelledError();
    }
    const outputs = validateTranslationResult([item], rawResult);
    const result = outputs.get(item.id)?.trim() ?? "";
    if (!result) {
      throw new Error("回译结果为空。");
    }
    return result;
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
        throw new Error("译文缓存不存在，无法关联译文插入块。");
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
            "回译结果包含多个 Markdown 块，无法自动关联到单个译文块。",
          );
        }
        const generatedBlock = generated.blocks[0];
        const target = source.blocks.find(
          (block) => block.hash === generatedBlock.hash,
        );
        if (!target) {
          throw new Error("找不到回译生成的原文块，无法关联译文插入块。");
        }
        const cache = parseCacheDocument(cacheText, this.md);
        const alignment = alignDocument(source.blocks, cache);
        const byIndex = new Map(
          alignment.blocks.map((block) => [block.source.index, block]),
        );
        if (byIndex.get(target.index)?.cache) {
          throw new Error("回译生成的原文块已经有译文，无法重复关联。");
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
        cacheText = serializeCacheDocument(cache.frontmatter, entries);
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
      throw new Error("译文块不能为空。");
    }
    const state = await this.loadState(sourceUri, false);
    const source = parseMarkdownDocument(state.sourceText, this.md);
    const cache = parseCacheDocument(state.cacheText ?? "", this.md);
    if (cache.untracked.length > 0) {
      throw new Error("译文缓存中存在未加锚点的内容，无法插入译文块。");
    }
    if (afterIndex !== -1 && !source.blocks.some((item) => item.index === afterIndex)) {
      throw new Error(`找不到要插入到的原文块：${afterIndex + 1}。`);
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
      throw new Error("译文块不能为空。");
    }
    const state = await this.loadState(sourceUri, false);
    const cache = parseCacheDocument(state.cacheText ?? "", this.md);
    const target = cache.targetBlocks.find(
      (item) => item.anchor.id === targetId,
    );
    if (!target) {
      throw new Error("这个译文块已不存在。");
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
    const nextText = serializeCacheDocument(cache.frontmatter, entries);
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
    const nextText = serializeCacheDocument(cache.frontmatter, entries);
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
    const nextText = serializeCacheDocument(cache.frontmatter, entries);
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
  ): Promise<{ text: string; afterIndex: number }> {
    const state = await this.loadState(sourceUri, false);
    const source = parseMarkdownDocument(state.sourceText, this.md);
    const cache = parseCacheDocument(state.cacheText ?? "", this.md);
    const target = cache.targetBlocks.find(
      (item) => item.anchor.id === targetId,
    );
    if (!target) {
      throw new Error("这个译文块已不存在。");
    }
    const generated = await this.backTranslateTargetText(
      sourceUri,
      target.block.raw,
      signal,
    );
    const parsed = parseMarkdownDocument(generated, this.md);
    if (parsed.blocks.length !== 1) {
      throw new Error(
        "回译结果包含多个 Markdown 块，无法自动关联到单个译文块。",
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
      throw new Error("这个译文块已不存在或已经关联原文。");
    }
    const generated = parseMarkdownDocument(generatedSourceText, this.md);
    if (generated.blocks.length !== 1) {
      throw new Error("回译生成的原文不是单个 Markdown 块，无法关联。");
    }
    const sourceBlock = source.blocks.find(
      (item) => item.hash === generated.blocks[0].hash,
    );
    if (!sourceBlock) {
      throw new Error("找不到回译生成的原文块，无法关联译文。");
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
    const nextText = serializeCacheDocument(cache.frontmatter, entries);
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
        throw new Error("回译生成的原文不是单个 Markdown 块，无法关联译文。");
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
      const nextText = serializeCacheDocument(cache.frontmatter, nextEntries);
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
      const nextText = serializeCacheDocument(cache.frontmatter, entries);
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
  async markSynced(sourceUri: vscode.Uri, blockIndex: number): Promise<void> {
    return this.withLock(sourceUri, async () => {
      const state = await this.loadState(sourceUri, true);
      if (!state.cacheText || !state.cacheText.trim()) {
        throw new Error("译文缓存不存在，无法标记已同步。");
      }
      const source = parseMarkdownDocument(state.sourceText, this.md);
      const cache = parseCacheDocument(state.cacheText, this.md);
      const alignment = alignDocument(source.blocks, cache);
      const aligned = alignment.blocks.find(
        (item) => item.source.index === blockIndex,
      );
      if (!aligned?.cache) {
        throw new Error("这个块还没有译文，无法标记已同步。");
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
      throw new Error("不能把原文文件本身导入为译文。");
    }
    return this.withLock(sourceUri, async () => {
      const state = await this.loadState(sourceUri, true, "导入译文");
      const bytes = await vscode.workspace.fs.readFile(translationUri);
      if (bytes.byteLength > 10_000_000) {
        throw new Error("译文文件超过 10 MB，已拒绝导入。");
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
    if (this.inFlight.size > 0) {
      throw new Error("有同步或导入任务正在进行，请稍后再清除所有缓存。");
    }
    if (this.clearingAllCaches) {
      throw new Error("正在清除所有缓存，请稍候。");
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
      throw new Error(`找不到第 ${blockIndex + 1} 个原文块。`);
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
   * 交给 `vscode.open`。无法解析或协议不受支持时抛出中文错误。
   */
  async openLink(sourceUri: vscode.Uri, rawHref: string): Promise<void> {
    const href = rawHref.trim();
    if (!href) {
      return;
    }
    // 协议相对地址会被解析成当前页面协议，可能指向不可信网络位置，直接拒绝。
    if (/^[\\/]{2}/.test(href)) {
      throw new Error("出于安全考虑，不支持协议相对或网络共享链接。");
    }
    let parsed: vscode.Uri;
    try {
      parsed = vscode.Uri.parse(href, true);
    } catch {
      throw new Error("无法解析这个链接。");
    }
    const scheme = parsed.scheme.toLowerCase();
    if (scheme) {
      // 只允许显式的外链协议；其余（file、command、vscode 等）一律拒绝。
      if (scheme === "http" || scheme === "https" || scheme === "mailto") {
        await vscode.env.openExternal(parsed);
        return;
      }
      throw new Error(`出于安全考虑，不支持打开 ${scheme}: 链接。`);
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
      throw new Error("链接目标不是本地文件。");
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
  ): Promise<SyncOutcome> {
    this.log(
      `sync ${path.basename(state.sourceUri.fsPath)} (${retranslateAll ? "all" : retranslateStale ? "stale" : "missing"}, partial=${allowPartial})`,
    );
    const glossary = await this.loadGlossary();
    const result = await syncDocument({
      md: this.md,
      sourceText: state.sourceText,
      cacheText: state.cacheText,
      provider: this.provider,
      sourceLanguage: state.sourceLanguage,
      targetLanguage: state.targetLanguage,
      retranslateStale,
      retranslateAll,
      glossary: glossary.entries,
      signal,
      onProgress,
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
    this.log(
      `sync done: translated=${result.translatedCount}, failed=${result.failedTaskCount}, partial=${result.partial}, copied=${result.copiedCount}, human=${result.humanLockedCount}, warnings=${result.warnings.length}`,
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

  /** 加载全局术语表；告警写入输出通道但不阻断同步。 */
  private async loadGlossary(): Promise<GlossaryLoadResult> {
    const glossary = await this.glossaryStore.load();
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
   * @throws 清空缓存进行中或同文件已有任务时抛出中文错误。
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
  private async withLock<T>(
    sourceUri: vscode.Uri,
    action: () => Promise<T>,
  ): Promise<T> {
    const key = sourceUri.toString();
    // 清空缓存与写缓存不能交错，否则可能把文件写回正在删除的目录。
    if (this.clearingAllCaches) {
      throw new Error("正在清除所有缓存，请稍后再执行此操作。");
    }
    if (this.inFlight.has(key)) {
      throw new Error("这个文件已有同步任务正在进行，请稍候。");
    }
    this.inFlight.add(key);
    try {
      return await action();
    } finally {
      this.inFlight.delete(key);
    }
  }
}
