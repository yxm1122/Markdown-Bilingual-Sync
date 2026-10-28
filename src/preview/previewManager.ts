/**
 * 预览面板管理模块：扩展进程侧的「控制器」，负责面板生命周期、原文/译文编辑的暂存与写回、
 * 导出/导入确认，以及 Webview 消息的路由。
 *
 * 职责：
 * - `PreviewManager`：按源文件 URI 维护面板注册表（一个文件一个面板），并持久化布局偏好；
 * - `PreviewPanelSession`：单个面板的状态机——模型刷新、原文暂存、回译、导出、忙碌/取消；
 * - 与 `SyncService`（读状态/同步/回译/缓存写）、`ExportService`（导出准备/提交）、
 *   `TranslationTaskMonitor`（状态栏任务）协作：用户触发的写盘动作都由本层发起，
 *   具体写入委托给上述服务。
 *
 * 数据流：
 * source/cache 文本（SyncService.loadPreviewState）
 * --> buildPreviewModel
 * --> 首次：buildPreviewAppShell --> panel.webview.html；脚本 ready 后：
 *     postMessage({ type: "state", state })
 * --> 用户操作 postMessage --> onMessage 校验并按 type 分发
 * --> SyncService/ExportService 写盘 --> 重新 update() 局部渲染；
 * 原文编辑采用「先暂存、再确认、最后统一写回」，暂存状态只存在本类内存中。
 *
 * 关键不变量：
 * - 原文暂存以 `pendingSourceBase`（暂存时的源文件全文）为基准；源文件一旦变化，
 *   暂存整体失效并提示，绝不把基于旧文本的编辑写回；
 * - 写回顺序固定为：应用 WorkspaceEdit -> 保存源文件 -> 解除被删源块的缓存锚点
 *   -> 提升（promote）译文独占块 -> 锁定（lock）回译块；后三步失败只告警不中断；
 * - `sourceWriteInFlight` 期间跳过一切刷新，避免读到写回中途的中间态；
 * - `updateVersion` 递增用于丢弃过期的异步渲染结果，只有最后一次 update 能落地；
 * - `webviewReady` 之前只写完整壳，之后只发 state 消息，绝不再重载页面；
 * - 每个消息都按字段做运行时校验，未知 type 静默忽略，业务错误统一走 toast/错误弹窗。
 */
import { randomBytes } from "node:crypto";
import * as path from "node:path";
import * as vscode from "vscode";
import {
  buildExportDiff,
  type ExportConfirmationView,
} from "../export/diffPreview";
import type {
  ExportService,
  PreparedExport,
} from "../export/exportService";
import { summarySourceHash } from "../cache/summaryMarker";
import { MAX_DOCUMENT_GLOSSARY_ENTRIES } from "../glossary/glossary";
import {
  formatDocumentGlossary,
  parseDocumentGlossaryText,
} from "../glossary/documentGlossary";
import { formatText, getLocale, UI_TEXT } from "../i18n";
import { createMarkdownRuntime } from "../markdown/markdown";
import { parseMarkdownDocument } from "../markdown/segmenter";
import {
  buildProposedSource,
  type SourceEdit,
  type SourceInsertion,
  type SourceStage,
} from "../source/editSource";
import { CancelledError, SyncService } from "../sync/syncService";
import { SyncBlockedError } from "../sync/sync";
import type { ConsistencyIssue } from "../quality/consistency";
import { estimateTokenCount } from "../translation/batching";
import {
  normalizeTranslationBrief,
  translationBriefText,
} from "../translation/types";
import { languageSuffix } from "../util/language";
import { buildPreviewModel, type PreviewModel } from "./previewModel";
import {
  normalizePreviewLayout,
  PREVIEW_LAYOUT_STATE_KEY,
  type PreviewLayout,
} from "./layout";
import { buildPreviewAppShell } from "./appShell";
import type { PreviewHostMessage, PreviewNotice } from "./protocol";
import { failedTaskPatch, type TranslationTaskMonitor } from "../status/taskMonitor";
import { tError } from "../i18n/errors";

// ---- 模块级辅助 ----

/**
 * 生成 CSP nonce。
 * @returns 18 字节随机数的 base64 文本，每次渲染重新生成，不复用。
 */
function getNonce(): string {
  return randomBytes(18).toString("base64");
}

/** 译文独占块回译后、等待随原文一起写回时建立的映射。 */
interface PendingTargetPromotion {
  /** 暂存到原文插入列表中的临时 id；取消提升时按它移除对应插入项。 */
  sourceInsertId: string;
  /** 回译生成的原文 Markdown；写回后用于把缓存锚点提升为 human。 */
  generatedSourceText: string;
}

/** 回译块暂存后、等待写回时锁定的缓存锚点信息。 */
interface PendingPairedLock {
  /** 需要从 auto 锁定为 human 的缓存锚点 id。 */
  cacheId: string;
  /** 回译生成、即将写入源文件的文本（用于重新计算哈希）。 */
  generatedSourceText: string;
}

/**
 * 错误页文本转义。
 * @param value 动态文本。
 * @returns 转义 `& < > "` 的字符串。
 * @remarks 仅用于错误页的文本节点（`<title>` / `<pre>` / `<p>`），未转义单引号，
 * 不可直接用于属性上下文；常规预览的转义在 `./html` 中完成。
 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * 把任意异常转换为可展示文本。
 * @param error 捕获到的异常。
 * @returns 同步阻塞错误返回全部原因（按行拼接），其余返回 message 或字符串化结果。
 */
/** 把可能跨行的检查项压成单行，避免破坏 QuickPick 的 description。 */
function singleLine(value: string, maxLength = 100): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > maxLength
    ? `${normalized.slice(0, maxLength)}…`
    : normalized;
}

function formatError(error: unknown): string {
  if (error instanceof SyncBlockedError) {
    return error.reasons.join("\n");
  }
  return error instanceof Error ? error.message : String(error);
}

// ---- PreviewManager：面板注册表与布局偏好 ----

/**
 * 预览面板管理器（扩展级单例，注册在 `context.subscriptions` 中）。
 *
 * 用源文件 URI 作为键保存会话，保证同一文件只开一个面板；布局偏好写入
 * `globalState`，切换布局时通知所有已打开面板重渲染。
 */
export class PreviewManager implements vscode.Disposable {
  /** 源文件 URI 字符串 -> 面板会话；面板关闭时移除。 */
  private readonly panels = new Map<string, PreviewPanelSession>();
  private layout: PreviewLayout;

  /**
   * @param context 扩展上下文，提供 globalState 与 extensionUri。
   * @param syncService 同步/回译/缓存写入服务。
   * @param exportService 导出准备与提交服务。
   * @param output 扩展输出通道，用于记录错误与导出审计日志。
   * @param taskMonitor 状态栏任务监视器。
   * @remarks 构造函数只读取布局偏好，不创建任何面板。
   */
  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly syncService: SyncService,
    private readonly exportService: ExportService,
    private readonly output: vscode.OutputChannel,
    private readonly taskMonitor: TranslationTaskMonitor,
  ) {
    this.layout = normalizePreviewLayout(
      context.globalState.get(PREVIEW_LAYOUT_STATE_KEY),
    );
  }

  /** 当前全局预览布局。 */
  get previewLayout(): PreviewLayout {
    return this.layout;
  }

  /**
   * 切换全局预览布局并持久化。
   * @param layout 新布局（调用方已归一化）。
   * @returns 持久化完成；所有已打开面板并行重渲染（不等待结果）。
   * @remarks 布局相同时直接返回，避免无谓的整页重渲染。
   */
  async setPreviewLayout(layout: PreviewLayout): Promise<void> {
    if (layout === this.layout) {
      return;
    }
    this.layout = layout;
    await this.context.globalState.update(PREVIEW_LAYOUT_STATE_KEY, layout);
    for (const session of this.panels.values()) {
      void session.update();
    }
  }

  /**
   * 打开（或复用）指定源文件的预览面板。
   * @param sourceUri 源 Markdown 文件。
   * @remarks 已存在时只 reveal 并刷新；新面板首次渲染由会话构造函数触发。
   */
  open(sourceUri: vscode.Uri): void {
    const existing = this.panels.get(sourceUri.toString());
    if (existing) {
      existing.panel.reveal(undefined, true);
      void existing.update();
      return;
    }

    const session = this.ensureSession(sourceUri);
    session.panel.reveal(undefined, true);
  }

  /**
   * 打开面板并直接进入导出确认流程。
   * @param sourceUri 源文件。
   * @returns 导出准备与渲染完成；准备失败时由会话内部提示。
   */
  async beginExport(sourceUri: vscode.Uri): Promise<void> {
    const session = this.ensureSession(sourceUri);
    session.panel.reveal(undefined, true);
    await session.beginExport();
  }

  /**
   * 打开面板并直接进入译文导入流程。
   * @param sourceUri 源文件。
   * @returns 选择文件、确认覆盖与导入完成；用户取消时静默返回。
   */
  async beginImport(sourceUri: vscode.Uri): Promise<void> {
    const session = this.ensureSession(sourceUri);
    session.panel.reveal(undefined, true);
    await session.beginImport();
  }

  /**
   * 获取或创建会话。
   * @param sourceUri 源文件。
   * @returns 会话实例。
   * @remarks 创建时会配置 `localResourceRoots`（media、源文件目录、所有工作区根），
   * 面板销毁时自动从注册表移除并释放会话。
   */
  private ensureSession(sourceUri: vscode.Uri): PreviewPanelSession {
    const key = sourceUri.toString();
    const existing = this.panels.get(key);
    if (existing) {
      return existing;
    }

    const localRoots = new Set<string>();
    // Webview 只能加载这些根下的资源：扩展 media、构建后的 Webview 脚本、当前文件目录、
    // 以及所有工作区根。
    localRoots.add(vscode.Uri.joinPath(this.context.extensionUri, "media").toString());
    localRoots.add(
      vscode.Uri.joinPath(this.context.extensionUri, "dist", "webview").toString(),
    );
    localRoots.add(vscode.Uri.joinPath(sourceUri, "..").toString());
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      localRoots.add(folder.uri.toString());
    }

    const panel = vscode.window.createWebviewPanel(
      "markdownBilingualSync.preview",
      `${path.basename(sourceUri.fsPath)} · ${UI_TEXT.preview.titleSuffix}`,
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        enableFindWidget: true,
        localResourceRoots: [...localRoots].map((uri) => vscode.Uri.parse(uri)),
      },
    );

    const session = new PreviewPanelSession(
      this,
      panel,
      sourceUri,
      this.context,
      this.syncService,
      this.exportService,
      this.output,
      this.taskMonitor,
    );
    this.panels.set(key, session);
    panel.onDidDispose(() => {
      this.panels.delete(key);
      session.dispose();
    });
    return session;
  }

  /**
   * 刷新单个文件的预览（文件保存时由扩展调用）。
   * @param sourceUri 源文件；未打开预览时静默忽略。
   */
  refresh(sourceUri: vscode.Uri): void {
    void this.panels.get(sourceUri.toString())?.update();
  }

  /** 刷新所有已打开面板（缓存保存、配置变化时调用）。 */
  refreshAll(): void {
    for (const session of this.panels.values()) {
      void session.update();
    }
  }

  /** 指定文件是否已有预览面板。 */
  has(sourceUri: vscode.Uri): boolean {
    return this.panels.has(sourceUri.toString());
  }

  /**
   * 关闭指定文件的预览面板。
   * @param sourceUri 源文件。
   * @remarks 面板 dispose 会触发 onDidDispose 再删除一次，此处删除是幂等的。
   */
  close(sourceUri: vscode.Uri): void {
    const session = this.panels.get(sourceUri.toString());
    if (session) {
      session.panel.dispose();
      this.panels.delete(sourceUri.toString());
    }
  }

  /**
   * 记录错误到输出通道。
   * @param context 出错场景（用于日志前缀）。
   * @param error 异常对象；优先记录堆栈。
   */
  logError(context: string, error: unknown): void {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    this.output.appendLine(`[${new Date().toISOString()}] ${context}: ${message}`);
  }

  /** 释放所有面板；会话清理由面板 dispose 回调完成。 */
  dispose(): void {
    for (const session of [...this.panels.values()]) {
      session.panel.dispose();
    }
    this.panels.clear();
  }
}

// ---- PreviewPanelSession：单个面板的渲染与编辑状态机 ----

/** 单块重译的可选并发校验/限制。 */
interface RetranslateExpectation {
  sourceHash?: string;
  cacheId?: string;
  requireMachine?: boolean;
}

/** 等待原文写回确认后再执行的重译动作。 */
type PendingRetranslateAction =
  | {
      kind: "block";
      blockIndex: number;
      expected?: RetranslateExpectation;
      /** 写回前块的源文哈希；写回可能移动块索引，用于重新定位。 */
      sourceHash?: string;
      /** 该块暂存后的原文；写回后按内容匹配新索引。 */
      stagedText?: string;
    }
  | { kind: "stale" }
  | { kind: "all" };

/**
 * 一个预览面板的全部运行时状态。
 *
 * 生命周期：构造函数发起首次 `update()` 并把 Promise 存为 `ready`；后续所有外部入口
 * （导出、导入、刷新）都先 `await ready`，保证面板已渲染过一次。
 * 面板销毁时 `dispose()` 只标记状态，不再向 Webview 发消息。
 */
class PreviewPanelSession implements vscode.Disposable {
  /** 面板已销毁；为 true 时所有回调直接返回，避免向已释放的 Webview 发消息。 */
  private disposed = false;
  /** 渲染版本号；异步 load/build 结束后比对，只有最新一次能写 HTML。 */
  private updateVersion = 0;
  /** update 串行队列：避免 beginExport 的确认渲染被并发刷新按版本号丢弃。 */
  private updateQueue: Promise<void> = Promise.resolve();
  /** 导出确认框正在等待首次渲染；此前的后台刷新不得取消 pendingExport。 */
  private exportConfirmPending = false;
  /** 最近一次成功构建的模型；用于按块索引查找 human 状态等。 */
  private lastModel?: PreviewModel;
  /** Webview 脚本已完成首次挂载；之后的刷新走 state 消息，不再整页替换。 */
  private webviewReady = false;
  /** Webview 尚未 ready 时暂存的控制消息，避免首次加载期间丢失。 */
  private pendingMessages: PreviewHostMessage[] = [];
  /** 首次渲染完成的信号；所有外部入口先等待它。 */
  private readonly ready: Promise<void>;
  /** 已准备但尚未确认的导出（提交/取消后清空）。 */
  private pendingExport:
    | {
        prepared: PreparedExport;
        confirmation: ExportConfirmationView;
      }
    | undefined;
  /** 导出正在写盘；期间禁止重复提交、取消与重新准备。 */
  private exportCommitting = false;
  /** 复用的 markdown-it 实例，仅用于解析块边界与哈希（不渲染页面）。 */
  private readonly md = createMarkdownRuntime();
  /** 原文暂存：块索引 -> 新文本 + 原块哈希。 */
  private pendingSourceEdits = new Map<number, SourceEdit>();
  /** 原文暂存：待删除的块索引。 */
  private pendingSourceDeletions = new Set<number>();
  /** 原文暂存：待插入块（含回译生成的块）。 */
  private pendingSourceInsertions: SourceInsertion[] = [];
  /** 译文独占块 id -> 待提升信息（回译生成原文后建立关联）。 */
  private pendingTargetPromotions = new Map<string, PendingTargetPromotion>();
  /** 块索引 -> 回译后待锁定的缓存锚点。 */
  private pendingPairedLocks = new Map<number, PendingPairedLock>();
  /** 暂存所基于的源文件全文；源文件变化时暂存失效。 */
  private pendingSourceBase?: string;
  /** 原文写回确认后再执行的重译动作；取消写回或暂存失效时清除。 */
  private pendingRetranslate: PendingRetranslateAction | null = null;
  /** 原文写回进行中；期间跳过所有刷新，防止读到中间态。 */
  private sourceWriteInFlight = false;
  /** 左栏只读（面板级、内存态，不持久化）。 */
  private sourceReadonly = false;
  /** 右栏只读（面板级、内存态，不持久化）。 */
  private targetReadonly = false;
  /** 稳定翻译开关（会话级；初始值来自设置）。 */
  private stableTranslation: boolean;
  /** 摘要上下文开关（会话级；初始值来自设置）。 */
  private summaryContext: boolean;
  /** 摘要生成进行中；防止重复请求。 */
  private summaryGenerating = false;

  /**
   * 注册消息监听并触发首次渲染（不等待）。
   * @param manager 用于布局、日志与全局刷新。
   * @param panel 已创建的 Webview 面板。
   * @param sourceUri 源 Markdown 文件。
   * @param context 扩展上下文（extensionUri、globalState）。
   * @param syncService 同步/回译/缓存服务。
   * @param exportService 导出服务。
   * @param output 输出通道。
   * @param taskMonitor 任务监视器。
   */
  constructor(
    private readonly manager: PreviewManager,
    readonly panel: vscode.WebviewPanel,
    private readonly sourceUri: vscode.Uri,
    private readonly context: vscode.ExtensionContext,
    private readonly syncService: SyncService,
    private readonly exportService: ExportService,
    private readonly output: vscode.OutputChannel,
    private readonly taskMonitor: TranslationTaskMonitor,
  ) {
    const assistDefaults = syncService.getAssistSettings();
    this.stableTranslation = assistDefaults.stableTranslation;
    this.summaryContext = assistDefaults.summaryContext;
    // Webview 消息可能乱序/恶意：统一交给 onMessage 做形状校验后再分发。
    this.panel.webview.onDidReceiveMessage((message: unknown) => {
      void this.onMessage(message);
    });
    // 首次渲染不阻塞构造函数；后续动作通过 await ready 等待这次渲染结束。
    this.ready = this.update();
  }

  /**
   * 准备导出并弹出确认对话框。
   * @returns 准备与渲染完成；内容未变化/面板已销毁时直接返回。
   * @remarks
   * - 准备阶段处于忙碌态，失败异常向上抛给 onMessage 统一提示；
   * - 确认数据随本次 HTML 内联，脚本加载后自动打开模态框；
   * - 准备结果暂存在 `pendingExport`，直到 commitExport / cancelExport / 任意刷新。
   */
  async beginExport(): Promise<void> {
    await this.ready;
    if (this.disposed || this.exportCommitting) {
      return;
    }

    this.setBusy(true, UI_TEXT.notifications.exportPreparing);
    try {
      const preparation = await this.exportService.prepare(this.sourceUri);
      if (this.disposed) {
        return;
      }
      // 目标文件已是最新：不弹确认框，仅提示。
      if (preparation.status === "unchanged") {
        this.showToast(
          formatText(UI_TEXT.notifications.exportUnchanged, {
            destination: preparation.destination,
          }),
          "info",
        );
        return;
      }

      const { prepared } = preparation;
      // 差异 = 目标文件现有内容（不存在则为空串）vs 本次待写入内容。
      const confirmation: ExportConfirmationView = {
        destination: prepared.destination,
        summary: prepared.summary,
        warningCount: prepared.warningCount,
        existing: prepared.existingText !== undefined,
        diff: buildExportDiff(
          prepared.existingText ?? "",
          prepared.text,
        ),
      };
      this.pendingExport = { prepared, confirmation };
      // 标记确认框正在等待渲染：期间排队的后台刷新不得把 pendingExport 清空。
      this.exportConfirmPending = true;
      try {
        await this.update(undefined, confirmation);
      } finally {
        this.exportConfirmPending = false;
      }
    } finally {
      this.setBusy(false);
    }
  }

  /**
   * 选择译文文件并导入为译文锁定。
   * @returns 导入与刷新完成；用户取消、面板销毁或覆盖确认被拒时静默返回。
   * @remarks
   * 已有缓存时必须二次确认（会覆盖全部缓存）；导入期间保持忙碌态，
   * 取消（CancelledError）不提示错误。
   */
  async beginImport(): Promise<void> {
    await this.ready;
    if (this.disposed) {
      return;
    }
    try {
      const settings = this.syncService.getSettings();
      const parsed = path.parse(this.sourceUri.fsPath);
      // 默认选中「同目录 + 目标语言后缀」的文件，符合导出约定。
      const defaultUri = vscode.Uri.file(
        path.join(
          parsed.dir,
          `${parsed.name}.${languageSuffix(settings.targetLanguage)}${parsed.ext || ".md"}`,
        ),
      );
      const selected = await vscode.window.showOpenDialog({
        title: UI_TEXT.extension.importPickTitle,
        openLabel: UI_TEXT.extension.importPickLabel,
        defaultUri,
        canSelectMany: false,
        filters: { Markdown: ["md", "markdown"] },
      });
      const translationUri = selected?.[0];
      if (!translationUri || this.disposed) {
        return;
      }
      // 导入会覆盖已有缓存的全部内容，存在缓存时必须二次确认。
      if (await this.syncService.hasCache(this.sourceUri)) {
        const choice = await vscode.window.showWarningMessage(
          UI_TEXT.extension.confirmImportOverwrite,
          { modal: true },
          UI_TEXT.extension.confirmImportOverwriteAction,
        );
        if (
          choice !== UI_TEXT.extension.confirmImportOverwriteAction ||
          this.disposed
        ) {
          return;
        }
      }

      this.setBusy(true, UI_TEXT.notifications.importing);
      try {
        const result = await this.syncService.importTranslation(
          this.sourceUri,
          translationUri,
        );
        if (this.disposed) {
          return;
        }
        await this.update({
          text: formatText(UI_TEXT.notifications.importDone, {
            translated: result.translatedCount,
            copied: result.copiedCount,
          }),
          kind: "success",
        });
      } catch (error) {
        if (this.disposed || error instanceof CancelledError) {
          return;
        }
        this.manager.logError(
          `import translation ${this.sourceUri.fsPath}`,
          error,
        );
        this.showToast(formatError(error), "error");
      } finally {
        this.setBusy(false);
      }
    } catch (error) {
      if (this.disposed || error instanceof CancelledError) {
        return;
      }
      this.manager.logError(
        `import translation ${this.sourceUri.fsPath}`,
        error,
      );
      this.showToast(formatError(error), "error");
    }
  }

  // ---- 原文暂存：基础访问与失效 ----

  /**
   * 是否存在任何未写回的原文暂存（编辑、删除或插入）。
   * @returns 有暂存时为 true。
   */
  private hasPendingSource(): boolean {
    return (
      this.pendingSourceEdits.size > 0 ||
      this.pendingSourceDeletions.size > 0 ||
      this.pendingSourceInsertions.length > 0
    );
  }

  /**
   * 清空全部原文暂存及派生的回译/提升映射，并释放基准文本。
   * @remarks 不刷新界面、不提示，调用方决定后续 notice。
   */
  private clearStagedSource(): void {
    this.pendingSourceEdits.clear();
    this.pendingSourceDeletions.clear();
    this.pendingSourceInsertions = [];
    this.pendingTargetPromotions.clear();
    this.pendingPairedLocks.clear();
    this.pendingSourceBase = undefined;
    this.pendingRetranslate = null;
  }

  /**
   * 生成传给模型/写回逻辑的暂存快照。
   * @returns 指向当前内存容器的只读视图（非拷贝，调用期间不要并发修改）。
   */
  private pendingSourceStage(): SourceStage {
    return {
      edits: this.pendingSourceEdits,
      deletions: this.pendingSourceDeletions,
      insertions: this.pendingSourceInsertions,
    };
  }

  /**
   * 建立或校验暂存基准。
   * @param sourceText 当前磁盘上的源文件全文。
   * @throws 当已有暂存且基准文本不一致时：先清空暂存，再抛出「暂存已失效」错误。
   * @remarks 只在没有暂存时设置基准；有暂存时不改变任何状态（除失效清空）。
   */
  private ensureSourceBase(sourceText: string): void {
    if (!this.hasPendingSource()) {
      this.pendingSourceBase = sourceText;
      return;
    }
    if (this.pendingSourceBase !== sourceText) {
      this.clearStagedSource();
      this.pendingSourceBase = sourceText;
      throw new Error(UI_TEXT.notifications.sourceStagedInvalidated);
    }
  }

  // ---- 渲染：模型构建与整页刷新 ----

  /**
   * 重新加载状态、重建模型并下发 Webview 状态。
   *
   * @param notice 初始提示（渲染进 toast 的 data 属性）。
   * @param exportConfirmation 非空表示本次渲染要弹出导出确认框。
   * @param cacheTextOverride 写缓存后直接传入最新缓存文本，避免立刻回读。
   * @returns 渲染完成；面板已销毁、写回进行中或版本过期时提前返回。
   * @remarks
   * - 首次写入壳后不再整页替换；Preact 按块 key 复用 DOM，滚动与草稿由页面自行保持；
   * - 更新串行执行；不带 exportConfirmation 的刷新会取消已展示的导出确认，
   *   但 beginExport 的确认框尚未渲染完成时不会被后台刷新提前清空；
   * - 源文件与暂存基准不一致时清空暂存并提示，绝不渲染过期暂存；
   * - 构建失败时渲染错误页，错误同时写入输出通道。
   */
  async update(
    notice?: PreviewNotice,
    exportConfirmation?: ExportConfirmationView,
    cacheTextOverride?: string,
  ): Promise<void> {
    // 串行化渲染：避免并发的 loadPreviewState 用版本号互相丢弃，
    // 尤其是 beginExport 的确认框不能被稍后启动的后台刷新吞掉。
    const task = this.updateQueue.then(() =>
      this.performUpdate(notice, exportConfirmation, cacheTextOverride),
    );
    this.updateQueue = task.catch(() => undefined);
    return task;
  }

  /**
   * 向 Webview 发送控制消息。
   *
   * Webview 脚本尚未完成首次挂载时先入队，ready 后按顺序补发，避免首次加载期间
   * 「忙碌 / 提示 / 确认结果」丢失。完整壳只由 {@link performUpdate} 在未 ready 时
   * 写入一次，之后一律走本方法与 `state` 消息。
   */
  private postToWebview(message: PreviewHostMessage): void {
    if (this.disposed) {
      return;
    }
    if (!this.webviewReady) {
      this.pendingMessages.push(message);
      return;
    }
    void this.panel.webview.postMessage(message);
  }

  /** ready 后按顺序补发首次加载期间排队的控制消息。 */
  private flushPendingMessages(): void {
    if (this.disposed) {
      return;
    }
    const messages = this.pendingMessages.splice(0);
    for (const message of messages) {
      void this.panel.webview.postMessage(message);
    }
  }

  /**
   * 真正执行一次预览刷新；只由 {@link update} 串行调用。
   * 行为约定见 update 的 JSDoc。
   */
  private async performUpdate(
    notice?: PreviewNotice,
    exportConfirmation?: ExportConfirmationView,
    cacheTextOverride?: string,
  ): Promise<void> {
    if (this.disposed) {
      return;
    }
    // 写回过程中磁盘内容处于中间态，任何刷新都跳过；写回结束会自行调用 update。
    if (this.sourceWriteInFlight) {
      return;
    }
    // 普通刷新会让已展示的导出确认失效，主动取消待提交的导出；
    // 但 beginExport 的确认框尚未渲染完成时（exportConfirmPending），
    // 允许先前排队的后台刷新先跑，不得提前清空 pendingExport。
    if (!exportConfirmation && this.pendingExport) {
      if (!this.exportConfirmPending) {
        this.pendingExport = undefined;
        this.exportConfirmPending = false;
        notice ??= {
          text: UI_TEXT.notifications.exportConfirmCancelled,
          kind: "info",
        };
      }
    }
    // 版本号在 await 之前自增；只有最后发起的 update 才能落地，避免旧结果覆盖新结果。
    const version = ++this.updateVersion;
    try {
      const state = await this.syncService.loadPreviewState(this.sourceUri);
      if (this.disposed || version !== this.updateVersion) {
        return;
      }
      // 外部保存/切换分支导致源文件变化：暂存失效，提示用户重新编辑。
      if (
        !this.sourceWriteInFlight &&
        this.hasPendingSource() &&
        this.pendingSourceBase !== undefined &&
        state.sourceText !== this.pendingSourceBase
      ) {
        this.clearStagedSource();
        notice ??= {
          text: UI_TEXT.notifications.sourceStagedInvalidated,
          kind: "info",
        };
      }
      const sourceDirectory = vscode.Uri.joinPath(this.sourceUri, "..");
      // 摘要上下文由缓存元数据提供；源文变化只标记过期，仍按用户选择继续使用。
      const summary = state.summary;
      const summaryText = summary?.text ?? "";
      const summaryStale = summary
        ? summary.sourceHash !== summarySourceHash(state.sourceText)
        : false;
      const model = buildPreviewModel({
        sourceText: state.sourceText,
        cacheText: cacheTextOverride ?? state.cacheText,
        sourceLanguage: state.sourceLanguage,
        targetLanguage: state.targetLanguage,
        providerLabel: this.syncService.providerLabel,
        fileLabel: path.basename(this.sourceUri.fsPath),
        resolveImage: (src) => this.resolveImage(src, sourceDirectory),
        pendingSource: this.pendingSourceStage(),
        annotations: state.annotations,
        reviewSupported: this.syncService.reviewSupported,
        assist: {
          stableTranslation: this.stableTranslation,
          summaryContext: this.summaryContext,
          summary: {
            text: summaryText,
            stale: summaryStale,
            ...(summary?.updatedAt ? { updatedAt: summary.updatedAt } : {}),
            ...(summary?.model ? { model: summary.model } : {}),
            tokens: estimateTokenCount(summaryText),
            brief: summary?.brief ?? {},
            briefTokens: estimateTokenCount(
              translationBriefText(summary?.brief),
            ),
            briefFilledCount: Object.values(summary?.brief ?? {}).filter(
              (value) => typeof value === "string" && value.trim(),
            ).length,
            canGenerate: this.syncService.summarySupported,
            glossaryText: formatDocumentGlossary(summary?.glossary ?? []),
            glossaryCount: summary?.glossary?.length ?? 0,
          },
        },
      });
      if (this.disposed || version !== this.updateVersion) {
        return;
      }
      this.lastModel = model;
      const layout = this.manager.previewLayout;
      const readonly = {
        source: this.sourceReadonly,
        target: this.targetReadonly,
      };
      const appState = { model, layout, readonly };
      if (!this.webviewReady) {
        // 首次加载（或脚本尚未 ready）才写入完整壳；之后只发 state 消息。
        this.panel.webview.html = buildPreviewAppShell({
          webview: this.panel.webview,
          extensionUri: this.context.extensionUri,
          nonce: getNonce(),
          state: appState,
          notice,
          exportConfirmation,
        });
      } else {
        // 模型 + 面板状态整体下发，Preact 按 key 复用 DOM。
        this.postToWebview({
          type: "state",
          state: appState,
          notice,
          exportConfirmation,
        });
      }
    } catch (error) {
      if (this.disposed || version !== this.updateVersion) {
        return;
      }
      this.manager.logError(`update preview ${this.sourceUri.fsPath}`, error);
      this.renderError(formatError(error));
    }
  }

  /** 标记销毁并清空导出/暂存状态；之后不再向 Webview 发送任何消息。 */
  dispose(): void {
    this.disposed = true;
    this.pendingExport = undefined;
    this.exportConfirmPending = false;
    this.clearStagedSource();
  }

  /**
   * 把 Markdown 图片路径解析为 Webview 可加载 URI。
   *
   * @param source 图片原始 src（相对路径、绝对路径或已编码 URL）。
   * @param sourceDirectory 源文件所在目录，相对路径以此为基准。
   * @returns Webview URI；解析失败或非法编码时返回原字符串（由 CSP 拒绝加载）。
   * @remarks 以 `/` 开头按文件系统绝对路径处理；`#`/`?` 片段会被去掉。
   */
  private resolveImage(source: string, sourceDirectory: vscode.Uri): string {
    try {
      // 协议相对地址（//host/path）在 Windows 上会被 Uri.file 当作 UNC 共享，
      // 这里保持原样交给 Webview/CSP 处理，避免把文档内容映射成本地网络路径。
      if (/^[\\/]{2}/.test(source)) {
        return source;
      }
      if (source.startsWith("/")) {
        return this.panel.webview
          .asWebviewUri(vscode.Uri.file(source))
          .toString();
      }
      let decoded = source;
      try {
        decoded = decodeURIComponent(source);
      } catch {
        /* 保留原始路径 */
      }
      const cleaned = decoded.split("#")[0]?.split("?")[0] ?? decoded;
      return this.panel.webview
        .asWebviewUri(vscode.Uri.joinPath(sourceDirectory, cleaned))
        .toString();
    } catch {
      return source;
    }
  }

  // ---- Webview 消息路由 ----

  /**
   * 处理 Webview 发来的消息。
   *
   * @param raw 未信任的任意值；必须是带 `type` 字符串的对象。
   * @returns 处理完成；未知 type 与字段不合法时静默忽略。
   * @remarks
   * - 所有字段在此做形状/类型校验（整数索引、字符串 id、文本），数值范围与业务存在性
   *   交由 SyncService/本地解析再次校验；
   * - 每个动作的异常统一记录日志并提示；用户取消（CancelledError）只清忙碌态；
   * - 该方法是并发的（多条消息可交错），共享状态（暂存、只读标记）按「最后写入生效」处理。
   */
  private async onMessage(raw: unknown): Promise<void> {
    if (!raw || typeof raw !== "object" || this.disposed) {
      return;
    }
    const message = raw as Record<string, unknown>;
    // ---- 字段校验：类型不符一律视为缺失，避免把任意 JSON 传进下游 ----
    const type = typeof message.type === "string" ? message.type : "";
    const blockIndex =
      typeof message.blockIndex === "number" && Number.isInteger(message.blockIndex)
        ? message.blockIndex
        : undefined;
    const afterBlockIndex =
      typeof message.afterBlockIndex === "number" &&
      Number.isInteger(message.afterBlockIndex)
        ? message.afterBlockIndex
        : undefined;
    const pendingId =
      typeof message.pendingId === "string" ? message.pendingId : undefined;
    const baseText =
      typeof message.baseText === "string" ? message.baseText : undefined;
    const sourceHash =
      typeof message.sourceHash === "string" ? message.sourceHash : undefined;
    const cacheId =
      typeof message.cacheId === "string" ? message.cacheId : undefined;
    const standaloneId =
      typeof message.standaloneId === "string"
        ? message.standaloneId
        : undefined;
    const requestedLayout =
      typeof message.layout === "string" ? message.layout : undefined;
    const pane = typeof message.pane === "string" ? message.pane : undefined;
    const summaryText =
      typeof message.summaryText === "string"
        ? message.summaryText
        : undefined;
    const glossaryText =
      typeof message.glossaryText === "string"
        ? message.glossaryText
        : undefined;
    const brief =
      message.brief &&
      typeof message.brief === "object" &&
      !Array.isArray(message.brief)
        ? normalizeTranslationBrief(message.brief)
        : undefined;
    const annotationId =
      typeof message.annotationId === "string"
        ? message.annotationId
        : undefined;
    const annotationMessage =
      typeof message.message === "string" ? message.message : undefined;
    const annotationSide =
      message.side === "source" || message.side === "target"
        ? message.side
        : undefined;
    const annotationKind =
      message.kind === "note" || message.kind === "request-change"
        ? message.kind
        : undefined;
    const annotationStatus =
      message.status === "open" ||
      message.status === "resolved" ||
      message.status === "dismissed"
        ? message.status
        : undefined;
    const assistKey =
      message.key === "stableTranslation" ||
      message.key === "summaryContext"
        ? message.key
        : undefined;
    const assistValue = message.value === true;
    try {
      switch (type) {
        // ---- 原生预览握手：脚本完成首次挂载后，后续刷新改走 state 消息 ----
        case "ready":
          this.webviewReady = true;
          this.flushPendingMessages();
          // Webview 可能被重新加载；用当前模型/待确认导出重新同步，避免旧快照。
          void this.update(undefined, this.pendingExport?.confirmation);
          break;
        // ---- 布局与只读：只影响当前面板的渲染参数 ----
        case "setLayout": {
          const layout = normalizePreviewLayout(
            requestedLayout,
            this.manager.previewLayout,
          );
          await this.manager.setPreviewLayout(layout);
          break;
        }
        case "togglePaneReadonly":
          if (pane === "source") {
            this.sourceReadonly = !this.sourceReadonly;
            await this.update();
          } else if (pane === "target") {
            this.targetReadonly = !this.targetReadonly;
            await this.update();
          }
          break;
        // ---- 同步 / 重译 / 导入：长任务，均有忙碌态或进度通知 ----
        case "sync":
          await this.runSync("sync");
          break;
        case "importTranslation":
          await this.beginImport();
          break;
        case "checkConsistency":
          await this.checkConsistency();
          break;
        case "retranslateStale":
          await this.retranslateStale();
          break;
        case "retranslateAll":
          await this.retranslateAll();
          break;
        // ---- 原文暂存：编辑 / 删除 / 插入 / 撤销，均只改内存，不发请求 ----
        case "stageSourceEdit":
          if (blockIndex !== undefined && typeof message.text === "string") {
            await this.stageSourceEdit(
              blockIndex,
              message.text,
              sourceHash,
            );
          }
          break;
        case "deleteSourceBlock":
          if (blockIndex !== undefined) {
            await this.deleteSourceBlock(blockIndex);
          }
          break;
        case "deleteTargetBlock":
          if (blockIndex !== undefined) {
            await this.deleteTargetBlock(blockIndex);
          }
          break;
        case "undoDeleteTargetBlock":
          if (blockIndex !== undefined) {
            await this.undoDeleteTargetBlock(blockIndex);
          }
          break;
        case "undoDeleteSourceBlock":
          if (blockIndex !== undefined) {
            await this.undoDeleteSourceBlock(blockIndex);
          }
          break;
        case "insertSourceBlock":
          if (
            afterBlockIndex !== undefined &&
            typeof message.text === "string"
          ) {
            await this.insertSourceBlock(
              afterBlockIndex,
              message.text,
            );
          }
          break;
        case "insertTargetBlock":
          if (
            afterBlockIndex !== undefined &&
            typeof message.text === "string"
          ) {
            await this.insertTargetBlock(
              afterBlockIndex,
              message.text,
            );
          }
          break;
        // ---- 译文独占块与待插入块：直接写缓存，不涉及源文件 ----
        case "updateStandaloneTarget":
          if (standaloneId && typeof message.text === "string") {
            await this.updateTargetBlock(standaloneId, message.text);
          }
          break;
        case "deleteTargetOnlyBlock":
          if (standaloneId) {
            await this.deleteTargetOnlyBlock(standaloneId);
          }
          break;
        case "backTranslateTargetOnly":
          if (standaloneId) {
            await this.backTranslateTargetOnly(standaloneId);
          }
          break;
        case "updateSourceInsert":
          if (pendingId && typeof message.text === "string") {
            await this.updateSourceInsert(pendingId, message.text);
          }
          break;
        case "removeSourceInsert":
          if (pendingId) {
            await this.removeSourceInsert(pendingId);
          }
          break;
        // ---- 译文编辑：携带 baseText/sourceHash/cacheId 做乐观并发校验 ----
        case "saveTargetEdit":
          if (blockIndex !== undefined && typeof message.text === "string") {
            await this.saveTargetEdit(blockIndex, message.text, {
              baseText,
              sourceHash,
              cacheId,
            });
          }
          break;
        // ---- 原文写回：先出差异确认，再执行统一写回 ----
        case "applySourceEdits":
          await this.applySourceEdits();
          break;
        case "discardSourceEdits":
          await this.discardSourceEdits();
          break;
        case "writeSourceEdits":
          await this.writeSourceEdits();
          break;
        case "cancelSourceWrite":
          this.pendingRetranslate = null;
          break;
        case "backTranslate":
          if (blockIndex !== undefined) {
            await this.backTranslateBlock(blockIndex);
          }
          break;
        // ---- 全文摘要与稳定翻译开关 ----
        case "generateSummary":
          await this.generateSummary();
          break;
        case "saveSummary":
          if (summaryText !== undefined) {
            await this.saveSummary(summaryText);
          }
          break;
        case "saveBrief":
          if (summaryText !== undefined) {
            await this.saveBrief(summaryText, brief, glossaryText);
          }
          break;
        case "saveGlossary":
          if (glossaryText !== undefined) {
            await this.saveGlossary(glossaryText);
          }
          break;
        case "reviewBlock":
          if (blockIndex !== undefined) {
            await this.reviewBlock(blockIndex);
          }
          break;
        case "reviewMachineBlocks":
          await this.reviewMachineBlocks();
          break;
        case "saveAnnotation":
          if (
            blockIndex !== undefined &&
            annotationSide &&
            annotationKind &&
            annotationMessage !== undefined
          ) {
            await this.saveAnnotation(blockIndex, {
              side: annotationSide,
              kind: annotationKind,
              message: annotationMessage,
            });
          }
          break;
        case "setAnnotationStatus":
          if (annotationId && annotationStatus) {
            await this.setAnnotationStatus(annotationId, annotationStatus);
          }
          break;
        case "deleteAnnotation":
          if (annotationId) {
            await this.deleteAnnotation(annotationId);
          }
          break;
        case "clearSummary":
          await this.clearSummary();
          break;
        case "setAssistToggle":
          if (assistKey) {
            if (assistKey === "stableTranslation") {
              this.stableTranslation = assistValue;
            } else {
              this.summaryContext = assistValue;
            }
            // 开关只影响后续请求；不重绘页面，避免丢失摘要文本框中未保存的编辑。
          }
          break;
        // ---- 导出确认：打开 / 写入 / 取消 ----
        case "export":
          await this.beginExport();
          break;
        case "exportWrite":
          await this.commitExport();
          break;
        case "exportCancel":
          this.cancelExport();
          break;
        // ---- 工具与导航：刷新、打开缓存、定位原文、打开链接 ----
        case "refresh":
          await this.update();
          break;
        case "editCache":
          await this.syncService.openCacheFile(this.sourceUri);
          break;
        case "openCacheFolder":
          await this.syncService.openCacheFolder(this.sourceUri);
          break;
        case "retranslateBlock":
          if (blockIndex !== undefined) {
            await this.retranslateBlock(blockIndex);
          }
          break;
        case "markSynced":
          if (blockIndex !== undefined) {
            await this.markSynced(blockIndex);
          }
          break;
        case "revealSource":
          if (blockIndex !== undefined) {
            await this.syncService.revealSource(this.sourceUri, blockIndex);
          }
          break;
        case "openLink":
          if (typeof message.href === "string") {
            await this.syncService.openLink(this.sourceUri, message.href);
          }
          break;
        default:
          break;
      }
    } catch (error) {
      // 用户主动取消不算失败：只解除忙碌态，不弹错误。
      if (error instanceof CancelledError) {
        this.setBusy(false);
        return;
      }
      // 统一兜底：输出通道留痕 + 面板内 toast + 全局错误弹窗。
      this.manager.logError(`preview action ${type}`, error);
      this.setBusy(false);
      this.showToast(formatError(error), "error");
      await vscode.window.showErrorMessage(
        `${UI_TEXT.extension.messagePrefix}${formatError(error)}`,
      );
    }
  }

  // ---- 同步与重译入口 ----

  /**
   * 重译所有过期块（先确认）。
   * @returns 确认并同步完成；无过期块或用户取消时只提示。
   */
  private async retranslateStale(): Promise<void> {
    if (this.hasPendingSource()) {
      this.pendingRetranslate = { kind: "stale" };
      this.showToast(UI_TEXT.notifications.pendingSourceBeforeRetranslate, "info");
      await this.applySourceEdits();
      return;
    }
    // 使用最近一次模型里的计数，避免为一次确认再读盘。
    const stale = this.lastModel?.counts.stale ?? 0;
    if (stale === 0) {
      this.showToast(UI_TEXT.notifications.noStaleTranslations, "info");
      return;
    }
    const choice = await vscode.window.showWarningMessage(
      formatText(UI_TEXT.extension.confirmRetranslateStale, { count: stale }),
      { modal: true },
      UI_TEXT.extension.confirmRetranslateStaleAction,
    );
    if (choice !== UI_TEXT.extension.confirmRetranslateStaleAction) {
      return;
    }
    await this.runSync("stale");
  }

  /**
   * 全量重译（先确认；译文锁定块不会被覆盖）。
   * @returns 确认并同步完成；用户取消时返回。
   */
  private async retranslateAll(): Promise<void> {
    if (this.hasPendingSource()) {
      this.pendingRetranslate = { kind: "all" };
      this.showToast(UI_TEXT.notifications.pendingSourceBeforeRetranslate, "info");
      await this.applySourceEdits();
      return;
    }
    const choice = await vscode.window.showWarningMessage(
      UI_TEXT.extension.confirmRetranslateAll,
      { modal: true },
      UI_TEXT.extension.confirmRetranslateAllAction,
    );
    if (choice !== UI_TEXT.extension.confirmRetranslateAllAction) {
      return;
    }
    await this.runSync("all");
  }

  /**
   * 暂存一次原文块编辑（不写盘）。
   *
   * @param blockIndex 源块索引。
   * @param text 编辑后的 Markdown。
   * @returns 刷新完成。
   * @throws 文本为空、暂存基准失效、块已被暂存删除或块不存在。
   * @remarks 手动编辑会取消该块由回译产生的「锁定」意图；与原文一致的编辑视为撤销。
   */
  private async stageSourceEdit(
    blockIndex: number,
    text: string,
    expectedSourceHash?: string,
  ): Promise<void> {
    if (!text.trim()) {
      throw new Error(UI_TEXT.notifications.sourceEditEmpty);
    }
    const state = await this.syncService.loadPreviewState(this.sourceUri);
    this.ensureSourceBase(state.sourceText);
    // 同一块既删除又编辑会造成写回顺序歧义，直接拒绝。
    if (this.pendingSourceDeletions.has(blockIndex)) {
      throw new Error(UI_TEXT.notifications.sourceBlockDeletedConflict);
    }
    const parsed = parseMarkdownDocument(state.sourceText, this.md);
    const block = parsed.blocks.find((item) => item.index === blockIndex);
    if (!block) {
      throw new Error(tError("common.missingSourceBlock", { index: blockIndex + 1 }));
    }
    if (expectedSourceHash && block.hash !== expectedSourceHash) {
      throw new Error(UI_TEXT.notifications.sourceBlockChanged);
    }
    const normalized = text.replace(/\r\n?/g, "\n");
    // 用户手动改写后不再沿用回译锁：避免写回时把译文锁到用户改过的文本上。
    this.pendingPairedLocks.delete(blockIndex);
    if (normalized === block.raw) {
      // 改回原文等价于撤销该块的暂存。
      this.pendingSourceEdits.delete(blockIndex);
      if (!this.hasPendingSource()) {
        this.pendingSourceBase = undefined;
      }
    } else {
      this.pendingSourceEdits.set(blockIndex, {
        text: normalized,
        sourceHash: block.hash,
      });
    }
    await this.update({
      text: UI_TEXT.notifications.sourceEditStaged,
      kind: "info",
    });
  }

  // ---- 译文独占块：插入 / 编辑 / 删除 / 回译生成原文 ----

  /**
   * 在指定源块之后插入一个译文独占块（直接写缓存）。
   * @param afterBlockIndex 源块索引；-1 表示文档开头。
   * @param text 译文 Markdown。
   * @returns 刷新完成；插入失败抛出业务错误。
   */
  private async insertTargetBlock(
    afterBlockIndex: number,
    text: string,
  ): Promise<void> {
    if (!text.trim()) {
      throw new Error(UI_TEXT.notifications.targetEditEmpty);
    }
    this.setBusy(true, UI_TEXT.notifications.targetInserting);
    try {
      const cacheText = await this.syncService.insertTargetBlock(
        this.sourceUri,
        afterBlockIndex,
        text,
      );
      // 用返回的最新缓存文本直接渲染，省一次读盘。
      await this.update(
        {
          text: UI_TEXT.notifications.standaloneAdded,
          kind: "success",
        },
        undefined,
        cacheText,
      );
    } finally {
      this.setBusy(false);
    }
  }

  /**
   * 更新译文独占块的正文（直接写缓存）。
   * @param targetId 缓存锚点 id。
   * @param text 新译文。
   * @returns 刷新完成。
   * @remarks 编辑后该块不再处于「回译已暂存」状态，先清除对应的提升映射。
   */
  private async updateTargetBlock(
    targetId: string,
    text: string,
  ): Promise<void> {
    if (!text.trim()) {
      throw new Error(UI_TEXT.notifications.targetEditEmpty);
    }
    this.clearTargetPromotion(targetId);
    const cacheText = await this.syncService.updateTargetBlock(
      this.sourceUri,
      targetId,
      text,
    );
    await this.update(
      {
        text: UI_TEXT.notifications.standaloneUpdated,
        kind: "success",
      },
      undefined,
      cacheText,
    );
  }

  /**
   * 删除一个译文独占块。
   * @param targetId 缓存锚点 id。
   * @returns 刷新完成。
   */
  private async deleteTargetOnlyBlock(targetId: string): Promise<void> {
    this.clearTargetPromotion(targetId);
    const cacheText = await this.syncService.deleteTargetOnlyBlock(
      this.sourceUri,
      targetId,
    );
    await this.update(
      {
        text: UI_TEXT.notifications.standaloneRemoved,
        kind: "info",
      },
      undefined,
      cacheText,
    );
  }

  /**
   * 撤销某个译文独占块的回译暂存：移除对应的原文插入项并解除映射。
   * @param targetId 缓存锚点 id。
   * @remarks 不刷新界面；调用方随后会覆盖内容（编辑/删除/回译）。
   */
  private clearTargetPromotion(targetId: string): void {
    const promotion = this.pendingTargetPromotions.get(targetId);
    if (!promotion) {
      return;
    }
    this.pendingSourceInsertions = this.pendingSourceInsertions.filter(
      (item) => item.id !== promotion.sourceInsertId,
    );
    this.pendingTargetPromotions.delete(targetId);
    if (!this.hasPendingSource()) {
      this.pendingSourceBase = undefined;
    }
  }

  /**
   * 回译一个译文独占块，把生成的原文暂存为「待插入原文块」。
   *
   * @param targetId 缓存锚点 id。
   * @returns 暂存并刷新完成；用户取消时提示后返回。
   * @throws 回译结果不是单个 Markdown 块、接口失败等（交由 onMessage 统一提示）。
   * @remarks
   * - 回译在带取消按钮的通知进度中执行，取消会 abort 请求；
   * - 结果只暂存，用户在「应用原文修改」确认后才会写回源文件并建立关联；
   * - 同一独占块重复回译会替换旧的暂存插入项。
   */
  private async backTranslateTargetOnly(targetId: string): Promise<void> {
    const controller = new AbortController();
    let cancelled = false;
    this.setBusy(true, UI_TEXT.notifications.targetInsertBackTranslating);
    try {
      const result = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "Markdown Bilingual Sync",
          cancellable: true,
        },
        async (progress, token) => {
          token.onCancellationRequested(() => {
            cancelled = true;
            controller.abort();
          });
          progress.report({
            message: UI_TEXT.notifications.targetInsertBackTranslating,
          });
          return this.syncService.backTranslateTargetBlock(
            this.sourceUri,
            targetId,
            controller.signal,
            {
              stableTranslation: this.stableTranslation,
              summaryContext: this.summaryContext,
            },
          );
        },
      );
      if (this.disposed) {
        return;
      }
      // 暂存到原文前先确认回译结果确实只有一个块，避免破坏块级锚点。
      const parsed = parseMarkdownDocument(result.text, this.md);
      if (parsed.blocks.length !== 1) {
        throw new Error(UI_TEXT.notifications.targetInsertMultiBlock);
      }
      const state = await this.syncService.loadPreviewState(this.sourceUri);
      this.ensureSourceBase(state.sourceText);
      // 同一独占块再次回译：先移除旧插入项，保持一一对应。
      const existing = this.pendingTargetPromotions.get(targetId);
      if (existing) {
        this.pendingSourceInsertions = this.pendingSourceInsertions.filter(
          (item) => item.id !== existing.sourceInsertId,
        );
      }
      const sourceInsertId = randomBytes(6).toString("hex");
      this.pendingSourceInsertions.push({
        id: sourceInsertId,
        afterIndex: result.afterIndex,
        text: result.text,
      });
      this.pendingTargetPromotions.set(targetId, {
        sourceInsertId,
        generatedSourceText: result.text,
      });
      await this.update({
        text: UI_TEXT.notifications.targetInsertSourceStaged,
        kind: "info",
      });
    } catch (error) {
      // 取消不是错误：给出提示并清掉可能残留的忙碌态。
      if (cancelled || error instanceof CancelledError) {
        this.showToast(UI_TEXT.notifications.backCancelled, "info");
        return;
      }
      throw error;
    } finally {
      this.setBusy(false);
    }
  }

  // ---- 块删除 / 插入 / 撤销（原文侧只暂存，译文侧直接写缓存） ----

  /**
   * 标记删除某块的译文（保留锚点），人工锁定块需二次确认。
   * @param blockIndex 源块索引。
   * @returns 刷新完成；用户取消时返回。
   */
  private async deleteTargetBlock(blockIndex: number): Promise<void> {
    const view = this.lastModel?.blocks.find(
      (block) => block.blockIndex === blockIndex,
    );
    // 人工锁定的译文删除后难以恢复，必须显式确认。
    if (view?.human) {
      const choice = await vscode.window.showWarningMessage(
        UI_TEXT.notifications.confirmSkipHuman,
        { modal: true },
        UI_TEXT.notifications.confirmSkipHumanAction,
      );
      if (choice !== UI_TEXT.notifications.confirmSkipHumanAction) {
        return;
      }
    }
    this.setBusy(true, UI_TEXT.notifications.targetSkipping);
    try {
      const cacheText = await this.syncService.deleteTargetBlock(
        this.sourceUri,
        blockIndex,
      );
      await this.update(
        {
          text: UI_TEXT.notifications.targetSkipped,
          kind: "info",
        },
        undefined,
        cacheText,
      );
    } finally {
      this.setBusy(false);
    }
  }

  /**
   * 暂存删除一个原文块（不写盘）。
   * @param blockIndex 源块索引。
   * @returns 刷新完成。
   * @throws 暂存基准失效或块不存在。
   * @remarks
   * - 删除会撤销同块编辑/回译锁，并移除「插在该块之后」的待插入项；
   * - 与被移除插入项关联的译文提升映射同步解除，避免写回时提升不到原文。
   */
  private async deleteSourceBlock(blockIndex: number): Promise<void> {
    const state = await this.syncService.loadPreviewState(this.sourceUri);
    this.ensureSourceBase(state.sourceText);
    const parsed = parseMarkdownDocument(state.sourceText, this.md);
    const block = parsed.blocks.find((item) => item.index === blockIndex);
    if (!block) {
      throw new Error(tError("common.missingSourceBlock", { index: blockIndex + 1 }));
    }
    this.pendingSourceEdits.delete(blockIndex);
    this.pendingPairedLocks.delete(blockIndex);
    this.pendingSourceDeletions.add(blockIndex);
    // 插在已删除块之后的待插入项失去锚点，一并移除。
    this.pendingSourceInsertions = this.pendingSourceInsertions.filter(
      (item) => item.afterIndex !== blockIndex,
    );
    const remainingInsertIds = new Set(
      this.pendingSourceInsertions.map((item) => item.id),
    );
    for (const [targetId, promotion] of this.pendingTargetPromotions) {
      if (!remainingInsertIds.has(promotion.sourceInsertId)) {
        this.pendingTargetPromotions.delete(targetId);
      }
    }
    await this.update({
      text: UI_TEXT.notifications.sourceDeleted,
      kind: "info",
    });
  }

  /**
   * 撤销原文块的删除标记。
   * @param blockIndex 源块索引。
   * @returns 刷新完成；该块本就不在删除集合中时静默返回。
   */
  private async undoDeleteSourceBlock(blockIndex: number): Promise<void> {
    if (!this.pendingSourceDeletions.delete(blockIndex)) {
      return;
    }
    if (!this.hasPendingSource()) {
      this.pendingSourceBase = undefined;
    }
    await this.update({
      text: UI_TEXT.notifications.sourceDeleteUndone,
      kind: "info",
    });
  }

  /**
   * 暂存一个待插入的原文块（不写盘）。
   * @param afterBlockIndex 插入位置的前一个源块索引；-1 表示文档开头。
   * @param text 新块的 Markdown。
   * @returns 刷新完成。
   * @throws 文本为空、基准失效、锚点块不存在或已被暂存删除。
   */
  private async insertSourceBlock(
    afterBlockIndex: number,
    text: string,
  ): Promise<void> {
    if (!text.trim()) {
      throw new Error(UI_TEXT.notifications.sourceEditEmpty);
    }
    const state = await this.syncService.loadPreviewState(this.sourceUri);
    this.ensureSourceBase(state.sourceText);
    if (afterBlockIndex !== -1) {
      const parsed = parseMarkdownDocument(state.sourceText, this.md);
      if (!parsed.blocks.some((item) => item.index === afterBlockIndex)) {
        throw new Error(
          tError("common.missingInsertedSourceBlock", { index: afterBlockIndex + 1 }),
        );
      }
      // 向已删除块之后插入会造成写回顺序歧义。
      if (this.pendingSourceDeletions.has(afterBlockIndex)) {
        throw new Error(UI_TEXT.notifications.sourceBlockDeletedConflict);
      }
    }
    this.pendingSourceInsertions.push({
      id: randomBytes(6).toString("hex"),
      afterIndex: afterBlockIndex,
      text,
    });
    await this.update({
      text: UI_TEXT.notifications.sourceInserted,
      kind: "info",
    });
  }

  /**
   * 更新一个待插入原文块的文本。
   * @param pendingId 暂存插入 id。
   * @param text 新文本。
   * @returns 刷新完成。
   * @throws 文本为空、插入项已不存在或暂存基准失效。
   */
  private async updateSourceInsert(
    pendingId: string,
    text: string,
  ): Promise<void> {
    if (!text.trim()) {
      throw new Error(UI_TEXT.notifications.sourceEditEmpty);
    }
    const insertion = this.pendingSourceInsertions.find(
      (item) => item.id === pendingId,
    );
    if (!insertion) {
      throw new Error(tError("preview.pendingInsertMissing"));
    }
    const state = await this.syncService.loadPreviewState(this.sourceUri);
    this.ensureSourceBase(state.sourceText);
    insertion.text = text;
    await this.update({
      text: UI_TEXT.notifications.sourceInsertUpdated,
      kind: "info",
    });
  }

  /**
   * 移除一个待插入原文块，并解除其关联的译文提升映射。
   * @param pendingId 暂存插入 id。
   * @returns 刷新完成；插入项不存在时静默返回。
   */
  private async removeSourceInsert(pendingId: string): Promise<void> {
    const before = this.pendingSourceInsertions.length;
    this.pendingSourceInsertions = this.pendingSourceInsertions.filter(
      (item) => item.id !== pendingId,
    );
    if (this.pendingSourceInsertions.length === before) {
      return;
    }
    for (const [targetId, promotion] of this.pendingTargetPromotions) {
      if (promotion.sourceInsertId === pendingId) {
        this.pendingTargetPromotions.delete(targetId);
      }
    }
    if (!this.hasPendingSource()) {
      this.pendingSourceBase = undefined;
    }
    await this.update({
      text: UI_TEXT.notifications.sourceInsertRemoved,
      kind: "info",
    });
  }

  /**
   * 丢弃全部原文暂存并刷新。
   * @returns 刷新完成；无暂存时也会刷新（等价于一次普通刷新）。
   */
  private async discardSourceEdits(): Promise<void> {
    this.clearStagedSource();
    await this.update({
      text: UI_TEXT.notifications.sourceEditsDiscarded,
      kind: "info",
    });
  }

  /**
   * 生成原文写回差异并把确认数据推送给 Webview（不写盘）。
   * @returns 消息发送完成；无暂存时静默返回。
   * @remarks 基准文本已变化时清空暂存并提示，避免基于旧文本生成差异。
   */
  private async applySourceEdits(): Promise<void> {
    if (!this.hasPendingSource()) {
      return;
    }
    const state = await this.syncService.loadPreviewState(this.sourceUri);
    if (this.pendingSourceBase !== state.sourceText) {
      this.clearStagedSource();
      await this.update({
        text: UI_TEXT.notifications.sourceStagedInvalidated,
        kind: "info",
      });
      return;
    }
    // 差异基于「当前磁盘源文件」vs「应用暂存后的文本」。
    const proposed = buildProposedSource(
      state.sourceText,
      this.pendingSourceStage(),
      this.md,
    );
    const diff = buildExportDiff(state.sourceText, proposed.text);
    this.postToWebview({
      type: "sourceConfirm",
      data: {
        destination: path.basename(this.sourceUri.fsPath),
        count: proposed.changedBlocks,
        diff,
      },
    });
  }

  // ---- 原文写回：唯一会修改源文件的路径 ----

  /**
   * 执行原文写回：把暂存统一写入源文件，并同步缓存中的删除/提升/锁定。
   *
   * @returns 写回与刷新完成；无暂存时只通知 Webview 关闭确认框。
   * @remarks
   * 顺序不可调换：
   * 1. 校验基准文本与打开后的文档内容，防止覆盖外部修改；
   * 2. 在 SyncService 的整段文件锁内：用一次 WorkspaceEdit 整篇替换并保存
   *    （保持用户 EOL）；保存失败先恢复内存文档再抛错；
   * 3. 解除被删源块在缓存中的锚点（detach，基于写回前的旧文本索引）；
   * 4. 提升（promote）回译后已暂存原文的译文独占块；
   * 5. 锁定（lock）回译块对应的缓存锚点。
   * 第 3-5 步任何一步失败都只记录并在最后弹出警告，不中断其余步骤；
   * 整段锁阻止同步命令插入中间步骤。写回期间 `sourceWriteInFlight` 阻止刷新，
   * 结束后自行触发一次 update。
   */
  private async writeSourceEdits(): Promise<void> {
    if (!this.hasPendingSource()) {
      this.postToWebview({ type: "sourceSettled" });
      return;
    }
    // 从这一刻到 finally 之间，源文件/缓存都处于中间态，禁止刷新。
    this.sourceWriteInFlight = true;
    this.setBusy(true, UI_TEXT.notifications.sourceWriting);
    let pendingAction: PendingRetranslateAction | null = null;
    try {
      const state = await this.syncService.loadPreviewState(this.sourceUri);
      // 确认框打开后源文件可能被外部修改：基准不一致就放弃写回。
      if (this.pendingSourceBase !== state.sourceText) {
        this.clearStagedSource();
        this.sourceWriteInFlight = false;
        await this.update({
          text: UI_TEXT.notifications.sourceStagedInvalidated,
          kind: "info",
        });
        return;
      }
      const proposed = buildProposedSource(
        state.sourceText,
        this.pendingSourceStage(),
        this.md,
      );
      const document = await vscode.workspace.openTextDocument(this.sourceUri);
      // 二次确认：读取状态后、打开文档前若内容又被改动，则放弃整篇替换。
      if (document.getText() !== state.sourceText) {
        throw new Error(UI_TEXT.notifications.sourceStagedInvalidated);
      }
      // 保留文档原有换行风格，避免整篇 diff。
      const eol =
        document.eol === vscode.EndOfLine.CRLF ? "\r\n" : "\n";
      const nextText = proposed.text.split("\n").join(eol);
      // 暂存应用后与原文完全一致：无实际变化，清空暂存即可。
      if (nextText === document.getText()) {
        pendingAction = this.pendingRetranslate;
        this.clearStagedSource();
        this.postToWebview({ type: "sourceSettled" });
        this.sourceWriteInFlight = false;
        await this.update();
        return;
      }
      const edit = new vscode.WorkspaceEdit();
      edit.replace(
        this.sourceUri,
        new vscode.Range(
          document.positionAt(0),
          document.positionAt(document.getText().length),
        ),
        nextText,
      );
      // 先快照待处理项：后续 clearStagedSource 会清空这些 Map。
      const promotions = new Map(this.pendingTargetPromotions);
      const pairedLocks = new Map(this.pendingPairedLocks);
      const deletedSourceIndices = [...this.pendingSourceDeletions];
      let cacheText: string | undefined;
      let attachError: string | undefined;
      // 文档替换、保存与缓存对账必须处于同一个文件锁临界区：
      // 同步命令不能插入到中间步骤；保存失败时先恢复内存文档再向上抛错。
      await this.syncService.runWithSourceLock(this.sourceUri, async () => {
        if (document.getText() !== state.sourceText) {
          throw new Error(UI_TEXT.notifications.sourceStagedInvalidated);
        }
        if (!(await vscode.workspace.applyEdit(edit))) {
          throw new Error(UI_TEXT.notifications.sourceWriteFailed);
        }
        try {
          if (!(await document.save())) {
            throw new Error(UI_TEXT.notifications.sourceWriteFailed);
          }
        } catch (error) {
          await this.restoreDocumentText(document, state.sourceText);
          throw error;
        }
        // ① 解除被删源块的缓存锚点；失败不阻断后续步骤。
        if (deletedSourceIndices.length > 0) {
          try {
            cacheText =
              (await this.syncService.detachDeletedSourceBlocks(
                this.sourceUri,
                state.sourceText,
                deletedSourceIndices,
                true,
              )) ?? cacheText;
          } catch (error) {
            attachError = formatError(error);
            this.manager.logError(
              `detach deleted source blocks ${this.sourceUri.fsPath}`,
              error,
            );
          }
        }
        // ② 把「回译出原文」的译文独占块提升为普通译文（按哈希找新原文块）。
        for (const [targetId, promotion] of promotions) {
          try {
            cacheText = await this.syncService.promoteTargetBlock(
              this.sourceUri,
              targetId,
              promotion.generatedSourceText,
            );
          } catch (error) {
            attachError = formatError(error);
            this.manager.logError(
              `promote target block ${this.sourceUri.fsPath}`,
              error,
            );
          }
        }
        // ③ 把回译块对应的缓存锚点锁定为 human；索引偏移由 SyncService 取最近匹配。
        for (const [blockIndex, lock] of pairedLocks) {
          try {
            const locked = await this.syncService.lockCachedBlockToSource(
              this.sourceUri,
              lock.cacheId,
              lock.generatedSourceText,
              blockIndex,
              true,
            );
            if (locked === undefined) {
              throw new Error(UI_TEXT.notifications.pairedLockFailed);
            }
            cacheText = locked;
          } catch (error) {
            attachError = formatError(error);
            this.manager.logError(
              `lock back-translated source ${this.sourceUri.fsPath}`,
              error,
            );
          }
        }
      });
      // 写回成功后清空暂存，并通知 Webview 关闭原文确认框。
      pendingAction = this.pendingRetranslate;
      this.clearStagedSource();
      this.postToWebview({ type: "sourceSettled" });
      this.showToast(UI_TEXT.notifications.sourceApplied, "success");
      // 缓存后处理失败：源文件已经写入，只能告警并保留日志，不能回滚。
      if (attachError) {
        void vscode.window.showWarningMessage(
          formatText(UI_TEXT.notifications.targetInsertAttachFailed, {
            message: attachError,
          }),
        );
      }
      // 先解除写回标记，update 才不会被自身的守卫跳过。
      this.sourceWriteInFlight = false;
      await this.update(undefined, undefined, cacheText);
    } catch (error) {
      if (this.disposed) {
        return;
      }
      this.manager.logError(
        `write source ${this.sourceUri.fsPath}`,
        error,
      );
      // 保留原文确认框并展示错误，用户可修正后重试。
      this.postToWebview({
        type: "sourceError",
        message: formatError(error),
      });
    } finally {
      this.sourceWriteInFlight = false;
      this.setBusy(false);
      if (pendingAction && !this.disposed) {
        void this.runPendingRetranslate(pendingAction);
      }
    }
  }

  /** 原文写回成功后继续用户先前请求的重译。 */
  private async runPendingRetranslate(
    action: PendingRetranslateAction,
  ): Promise<void> {
    if (this.disposed) {
      return;
    }
    try {
      switch (action.kind) {
        case "block": {
          const blockIndex = await this.resolveBlockIndexAfterWrite(action);
          // 用户已经在写回前确认过重译意图，不再弹第二次覆盖确认。
          await this.retranslateBlock(blockIndex, false, action.expected);
          break;
        }
        case "stale":
          await this.runSync("stale");
          break;
        case "all":
          await this.runSync("all");
          break;
        default:
          break;
      }
    } catch (error) {
      if (this.disposed) {
        return;
      }
      this.manager.logError(
        `continue retranslate after source write ${this.sourceUri.fsPath}`,
        error,
      );
      this.showToast(formatError(error), "error");
    }
  }

  /** 写回可能插入/删除块导致索引移动；按暂存文本或源哈希重新定位。 */
  private async resolveBlockIndexAfterWrite(
    action: Extract<PendingRetranslateAction, { kind: "block" }>,
  ): Promise<number> {
    if (action.stagedText === undefined && !action.sourceHash) {
      return action.blockIndex;
    }
    const state = await this.syncService.loadPreviewState(this.sourceUri);
    const parsed = parseMarkdownDocument(state.sourceText, this.md);
    const matches = parsed.blocks.filter(
      (block) =>
        block.translatable &&
        (action.stagedText !== undefined
          ? block.raw === action.stagedText
          : block.hash === action.sourceHash),
    );
    if (!matches.length) {
      throw new Error(tError("sync.sourceUpdatedRefresh"));
    }
    matches.sort(
      (left, right) =>
        Math.abs(left.index - action.blockIndex) -
        Math.abs(right.index - action.blockIndex),
    );
    return matches[0].index;
  }

  /**
   * 保存失败后的内存回滚：把文档内容恢复为写回前的基准文本。
   *
   * 只修改编辑器缓冲区，不再次写盘；这样即使保存失败，用户也不会看到源文档
   * 停留在“整篇替换后但未保存”的中间态。回滚本身失败只记日志，由上层继续
   * 展示原始保存错误。
   */
  private async restoreDocumentText(
    document: vscode.TextDocument,
    text: string,
  ): Promise<void> {
    try {
      const restore = new vscode.WorkspaceEdit();
      restore.replace(
        document.uri,
        new vscode.Range(
          document.positionAt(0),
          document.positionAt(document.getText().length),
        ),
        text,
      );
      if (!(await vscode.workspace.applyEdit(restore))) {
        this.manager.logError(
          `restore source after failed save ${this.sourceUri.fsPath}`,
          new Error(tError("preview.restoreBufferRejected")),
        );
      }
    } catch (error) {
      this.manager.logError(
        `restore source after failed save ${this.sourceUri.fsPath}`,
        error,
      );
    }
  }

  // ---- 译文保存 / 回译 / 撤销 ----

  /**
   * 保存译文编辑并锁定该块（写缓存）。
   * @param blockIndex 源块索引。
   * @param text 新译文。
   * @param expected 乐观并发参数：baseText/sourceHash/cacheId，任一不匹配则拒绝保存。
   * @returns 刷新完成。
   * @throws 文本为空或 SyncService 校验失败。
   */
  private async saveTargetEdit(
    blockIndex: number,
    text: string,
    expected?: {
      baseText?: string;
      sourceHash?: string;
      cacheId?: string;
    },
  ): Promise<void> {
    if (!text.trim()) {
      throw new Error(UI_TEXT.notifications.targetEditEmpty);
    }
    this.setBusy(true, UI_TEXT.notifications.targetSaving);
    try {
      const cacheText = await this.syncService.saveTargetEdit(
        this.sourceUri,
        blockIndex,
        text,
        expected,
      );
      await this.update(
        {
          text: UI_TEXT.notifications.targetSaved,
          kind: "success",
        },
        undefined,
        cacheText,
      );
    } finally {
      this.setBusy(false);
    }
  }

  /**
   * 撤销「译文已删除」标记（写缓存）。
   * @param blockIndex 源块索引。
   * @returns 刷新完成。
   */
  private async undoDeleteTargetBlock(blockIndex: number): Promise<void> {
    this.setBusy(true, UI_TEXT.notifications.undoDeleting);
    try {
      const cacheText = await this.syncService.undoDeleteTargetBlock(
        this.sourceUri,
        blockIndex,
      );
      await this.update(
        {
          text: UI_TEXT.notifications.undoDeleteDone,
          kind: "info",
        },
        undefined,
        cacheText,
      );
    } finally {
      this.setBusy(false);
    }
  }

  /**
   * 回译指定块，并把结果暂存为该块的原文修改（同时登记「写回后锁定」）。
   *
   * @param blockIndex 源块索引。
   * @returns 暂存并刷新完成；用户取消时提示后返回。
   * @throws 回译结果不是单块、块不存在或接口失败（交给 onMessage 提示）。
   * @remarks
   * - 回译不写源文件，只写暂存；用户点「应用原文修改」后才写回并锁定缓存；
   * - 回译文本与当前原文一致时视为无变化，不产生暂存；
   * - 暂存该块会取消它已有的「删除」标记，避免同一块既删又改。
   */
  // ---- 审校批注 ----

  /** 审校单个块；只写本机 sidecar，不改缓存 Markdown。 */
  private async reviewBlock(blockIndex: number): Promise<void> {
    this.setBusy(true, UI_TEXT.notifications.reviewingBlock);
    const controller = new AbortController();
    let cancelled = false;
    try {
      const result = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "Markdown Bilingual Sync",
          cancellable: true,
        },
        async (progress, token) => {
          token.onCancellationRequested(() => {
            cancelled = true;
            controller.abort();
          });
          progress.report({
            message: UI_TEXT.notifications.reviewingBlock,
          });
          return this.syncService.reviewBlock(
            this.sourceUri,
            blockIndex,
            controller.signal,
          );
        },
      );
      await this.update({
        text:
          result.added > 0
            ? formatText(UI_TEXT.notifications.reviewDone, {
                count: result.added,
              })
            : UI_TEXT.notifications.reviewNoIssues,
        kind: result.added > 0 ? "info" : "success",
      });
    } catch (error) {
      if (cancelled || error instanceof CancelledError) {
        this.showToast(UI_TEXT.notifications.reviewCancelled, "info");
        return;
      }
      throw error;
    } finally {
      this.setBusy(false);
    }
  }

  /** 审校全部机器译文；只写本机 sidecar。 */
  private async reviewMachineBlocks(): Promise<void> {
    this.setBusy(true, UI_TEXT.notifications.reviewingBlock);
    const controller = new AbortController();
    let cancelled = false;
    try {
      const result = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "Markdown Bilingual Sync",
          cancellable: true,
        },
        async (progress, token) => {
          token.onCancellationRequested(() => {
            cancelled = true;
            controller.abort();
          });
          progress.report({
            message: UI_TEXT.notifications.reviewingBlock,
          });
          return this.syncService.reviewBlocks(
            this.sourceUri,
            controller.signal,
          );
        },
      );
      await this.update({
        text:
          result.added > 0
            ? formatText(UI_TEXT.notifications.reviewDone, {
                count: result.added,
              })
            : UI_TEXT.notifications.reviewNoIssues,
        kind: result.added > 0 ? "info" : "success",
      });
    } catch (error) {
      if (cancelled || error instanceof CancelledError) {
        this.showToast(UI_TEXT.notifications.reviewCancelled, "info");
        return;
      }
      throw error;
    } finally {
      this.setBusy(false);
    }
  }

  /** 保存用户批注。 */
  private async saveAnnotation(
    blockIndex: number,
    input: {
      side: "source" | "target";
      kind: "note" | "request-change";
      message: string;
    },
  ): Promise<void> {
    this.setBusy(true, UI_TEXT.notifications.annotationSaving);
    try {
      await this.syncService.saveUserAnnotation(
        this.sourceUri,
        blockIndex,
        input,
      );
      await this.update({
        text: UI_TEXT.notifications.annotationSaved,
        kind: "success",
      });
    } finally {
      this.setBusy(false);
    }
  }

  /** 更新批注状态。 */
  private async setAnnotationStatus(
    annotationId: string,
    status: "open" | "resolved" | "dismissed",
  ): Promise<void> {
    this.setBusy(true, UI_TEXT.notifications.annotationSaving);
    try {
      await this.syncService.setAnnotationStatus(
        this.sourceUri,
        annotationId,
        status,
      );
      await this.update({
        text: UI_TEXT.notifications.annotationUpdated,
        kind: "success",
      });
    } finally {
      this.setBusy(false);
    }
  }

  /** 删除批注。 */
  private async deleteAnnotation(annotationId: string): Promise<void> {
    this.setBusy(true, UI_TEXT.notifications.annotationSaving);
    try {
      await this.syncService.deleteAnnotation(
        this.sourceUri,
        annotationId,
      );
      await this.update({
        text: UI_TEXT.notifications.annotationDeleted,
        kind: "info",
      });
    } finally {
      this.setBusy(false);
    }
  }

  // ---- 全文摘要 ----

  /**
   * 手动生成全文摘要。只由预览按钮触发，不会在打开/保存/同步时自动调用。
   * 使用通知进度条支持取消；完成后把最新缓存文本交给 update。
   */
  private async generateSummary(): Promise<void> {
    if (this.summaryGenerating) {
      return;
    }
    this.summaryGenerating = true;
    const controller = new AbortController();
    let cancelled = false;
    this.setBusy(true, UI_TEXT.notifications.summaryGenerating);
    try {
      const cacheText = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "Markdown Bilingual Sync",
          cancellable: true,
        },
        async (progress, token) => {
          token.onCancellationRequested(() => {
            cancelled = true;
            controller.abort();
          });
          progress.report({
            message: UI_TEXT.notifications.summaryGenerating,
          });
          return this.syncService.generateSummary(
            this.sourceUri,
            controller.signal,
          );
        },
      );
      if (this.disposed) {
        return;
      }
      await this.update(
        {
          text: UI_TEXT.notifications.summaryGenerated,
          kind: "success",
        },
        undefined,
        cacheText,
      );
    } catch (error) {
      if (cancelled || error instanceof CancelledError) {
        this.showToast(UI_TEXT.notifications.summaryCancelled, "info");
        return;
      }
      throw error;
    } finally {
      this.summaryGenerating = false;
      this.setBusy(false);
    }
  }

  /** 保存用户编辑后的摘要；空文本由服务层拒绝。 */
  private async saveSummary(text: string): Promise<void> {
    if (!text.trim()) {
      throw new Error(UI_TEXT.notifications.summaryEmpty);
    }
    this.setBusy(true, UI_TEXT.notifications.summarySaving);
    try {
      const cacheText = await this.syncService.saveSummary(
        this.sourceUri,
        text,
      );
      await this.update(
        {
          text: UI_TEXT.notifications.summarySaved,
          kind: "success",
        },
        undefined,
        cacheText,
      );
    } finally {
      this.setBusy(false);
    }
  }

  /**
   * 一次保存文档简报：摘要 + brief + 术语表。
   * 术语表逐行格式错误时不写盘，直接提示行号，保留用户输入。
   */
  private async saveBrief(
    summaryText: string,
    brief: ReturnType<typeof normalizeTranslationBrief> | undefined,
    glossaryText: string | undefined,
  ): Promise<void> {
    if (!summaryText.trim()) {
      throw new Error(UI_TEXT.preview.summary.empty);
    }
    const parsed = parseDocumentGlossaryText(glossaryText ?? "");
    if (parsed.errorLines.length > 0) {
      throw new Error(
        formatText(UI_TEXT.notifications.glossaryInvalidLines, {
          lines: parsed.errorLines.join(", "),
        }),
      );
    }
    if (parsed.overflow) {
      throw new Error(
        formatText(UI_TEXT.notifications.glossaryTooMany, {
          max: MAX_DOCUMENT_GLOSSARY_ENTRIES,
        }),
      );
    }
    this.setBusy(true, UI_TEXT.notifications.summarySaving);
    try {
      const cacheText = await this.syncService.saveBrief(this.sourceUri, {
        text: summaryText,
        brief,
        glossary: parsed.entries,
      });
      await this.update(
        {
          text: UI_TEXT.notifications.summarySaved,
          kind: "success",
        },
        undefined,
        cacheText,
      );
    } finally {
      this.setBusy(false);
    }
  }

  /**
   * 保存文档术语表编辑；空文本表示清空术语表但保留摘要。
   * 逐行格式错误时不写盘，直接提示行号，保留用户输入。
   */
  private async saveGlossary(text: string): Promise<void> {
    const parsed = parseDocumentGlossaryText(text);
    if (parsed.errorLines.length > 0) {
      throw new Error(
        formatText(UI_TEXT.notifications.glossaryInvalidLines, {
          lines: parsed.errorLines.join(", "),
        }),
      );
    }
    if (parsed.overflow) {
      throw new Error(
        formatText(UI_TEXT.notifications.glossaryTooMany, {
          max: MAX_DOCUMENT_GLOSSARY_ENTRIES,
        }),
      );
    }
    this.setBusy(true, UI_TEXT.notifications.glossarySaving);
    try {
      const cacheText = await this.syncService.saveDocumentGlossary(
        this.sourceUri,
        parsed.entries,
      );
      await this.update(
        {
          text: UI_TEXT.notifications.glossarySaved,
          kind: "success",
        },
        undefined,
        cacheText,
      );
    } finally {
      this.setBusy(false);
    }
  }

  /** 清除摘要；若缓存只剩摘要，则缓存文件也会被删除。 */
  private async clearSummary(): Promise<void> {
    this.setBusy(true, UI_TEXT.notifications.summarySaving);
    try {
      const cacheText = await this.syncService.clearSummary(this.sourceUri);
      await this.update(
        {
          text: UI_TEXT.notifications.summaryCleared,
          kind: "info",
        },
        undefined,
        cacheText,
      );
    } finally {
      this.setBusy(false);
    }
  }

  private async backTranslateBlock(blockIndex: number): Promise<void> {
    const controller = new AbortController();
    let cancelled = false;
    this.setBusy(true, UI_TEXT.notifications.backTranslating);
    try {
      const result = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "Markdown Bilingual Sync",
          cancellable: true,
        },
        async (progress, token) => {
          token.onCancellationRequested(() => {
            cancelled = true;
            controller.abort();
          });
          progress.report({
            message: UI_TEXT.notifications.backTranslating,
          });
          return this.syncService.backTranslateBlock(
            this.sourceUri,
            blockIndex,
            controller.signal,
            {
              stableTranslation: this.stableTranslation,
              summaryContext: this.summaryContext,
            },
          );
        },
      );
      if (this.disposed) {
        return;
      }
      const generated = parseMarkdownDocument(result.backText, this.md);
      if (generated.blocks.length !== 1) {
        throw new Error(UI_TEXT.notifications.backMultiBlock);
      }
      const state = await this.syncService.loadPreviewState(this.sourceUri);
      this.ensureSourceBase(state.sourceText);
      const source = parseMarkdownDocument(state.sourceText, this.md);
      const block = source.blocks.find((item) => item.index === blockIndex);
      if (!block) {
        throw new Error(tError("common.missingSourceBlock", { index: blockIndex + 1 }));
      }
      const normalized = result.backText.replace(/\r\n?/g, "\n").trimEnd();
      // 回译结果与原文相同：视为无需修改，清掉该块的暂存与锁定。
      if (normalized === block.raw.trimEnd()) {
        this.pendingSourceEdits.delete(blockIndex);
        this.pendingPairedLocks.delete(blockIndex);
        if (!this.hasPendingSource()) {
          this.pendingSourceBase = undefined;
        }
        await this.update({
          text: UI_TEXT.notifications.backSame,
          kind: "info",
        });
        return;
      }
      // 同一块不能既删除又改写：先撤销删除标记。
      this.pendingSourceDeletions.delete(blockIndex);
      this.pendingSourceEdits.set(blockIndex, {
        text: normalized,
        sourceHash: block.hash,
      });
      // 记录待锁定锚点：写回成功后把该译文标记为 human，避免下次同步覆盖。
      this.pendingPairedLocks.set(blockIndex, {
        cacheId: result.cacheId,
        generatedSourceText: normalized,
      });
      await this.update({
        text: UI_TEXT.notifications.backStaged,
        kind: "info",
      });
    } catch (error) {
      if (cancelled || error instanceof CancelledError) {
        this.showToast(UI_TEXT.notifications.backCancelled, "info");
        return;
      }
      throw error;
    } finally {
      this.setBusy(false);
    }
  }

  // ---- 导出提交 / 取消 ----

  /**
   * 提交待确认的导出（写目标文件）。
   * @returns 提交与提示完成；无待确认导出时只提示。
   * @remarks
   * - `exportCommitting` 防重入，期间 cancelExport 无效；
   * - 成功后清空待确认数据并通知 Webview 关闭对话框；
   * - 失败只在对话框内展示错误（等待用户重试或取消），不关闭模态框。
   */
  private async commitExport(): Promise<void> {
    if (this.exportCommitting) {
      return;
    }
    const pending = this.pendingExport;
    if (!pending) {
      this.postToWebview({ type: "exportSettled", action: "cancel" });
      this.showToast(UI_TEXT.notifications.noPendingExport, "info");
      return;
    }

    this.setBusy(true, UI_TEXT.notifications.exportWriting);
    this.exportCommitting = true;
    try {
      await this.exportService.commit(pending.prepared);
      this.pendingExport = undefined;
      this.exportConfirmPending = false;
      this.output.appendLine(
        `[${new Date().toISOString()}] export confirmed: ${pending.prepared.target.fsPath}`,
      );
      if (!this.disposed) {
        this.postToWebview({
          type: "exportSettled",
          action: "write",
        });
        this.showToast(
          formatText(UI_TEXT.notifications.exportWritten, {
            destination: pending.prepared.destination,
          }),
          "success",
        );
      }
    } catch (error) {
      this.manager.logError(
        `export ${this.sourceUri.fsPath}`,
        error,
      );
      if (!this.disposed) {
        this.postToWebview({
          type: "exportError",
          message: formatError(error),
        });
      }
    } finally {
      this.exportCommitting = false;
      this.setBusy(false);
    }
  }

  /**
   * 取消待确认的导出（不写盘）。
   * @remarks 导出正在提交时忽略；取消只丢弃已准备的数据并通知 Webview 关闭对话框。
   */
  private cancelExport(): void {
    if (this.exportCommitting) {
      return;
    }
    const pending = this.pendingExport;
    if (!pending) {
      return;
    }
    this.pendingExport = undefined;
    this.exportConfirmPending = false;
    this.output.appendLine(
      `[${new Date().toISOString()}] export cancelled: ${pending.prepared.target.fsPath}`,
    );
    if (!this.disposed) {
      this.postToWebview({
        type: "exportSettled",
        action: "cancel",
      });
      this.showToast(UI_TEXT.notifications.exportCancelled, "info");
    }
  }

  // ---- 同步任务与忙碌状态 ----

  /**
   * 启动一次同步/重译/全量重译，并接入状态栏任务与取消信号。
   *
   * @param mode `sync` 补全缺失译文、`stale` 重译过期、`all` 全量重译。
   * @returns 任务结束（成功、部分成功或取消）；刷新与提示在内部完成。
   * @remarks
   * - 任务监视器记录阶段/进度/失败原因，取消会 abort 请求；
   * - 同步失败只写输出通道与任务面板，不再弹全局错误（catch 内不 rethrow）；
   * - `finally` 总会解除忙碌态。
   */
  private async runSync(mode: "sync" | "stale" | "all"): Promise<void> {
    const controller = new AbortController();
    const taskId = this.taskMonitor.create(
      vscode.workspace.asRelativePath(this.sourceUri, false),
      this.sourceUri,
    );
    this.taskMonitor.start(taskId);
    this.taskMonitor.registerCancel(taskId, () => controller.abort());
    this.setBusy(true, UI_TEXT.notifications.syncBusy);
    try {
      const report = (
        message: string,
        detail?: { completed: number; total: number },
      ) => {
        this.setBusy(true, message);
        this.taskMonitor.update(taskId, {
          phase: message,
          ...(detail ?? {}),
        });
      };
      const outcome =
        mode === "all"
          ? await this.syncService.retranslateAll(
              this.sourceUri,
              report,
              controller.signal,
              {
                stableTranslation: this.stableTranslation,
                summaryContext: this.summaryContext,
              },
            )
          : await this.syncService.sync(
              this.sourceUri,
              mode === "stale",
              report,
              controller.signal,
              true,
              {
                stableTranslation: this.stableTranslation,
                summaryContext: this.summaryContext,
              },
            );
      const { result } = outcome;
      this.taskMonitor.finish(
        taskId,
        result.partial ? "partial" : "success",
        {
          completed: result.translatedCount,
          total: result.translatedCount + result.failedTaskCount,
          failed: result.failedTaskCount,
          phase: result.partial
            ? UI_TEXT.taskPanel.phases.partial
            : UI_TEXT.taskPanel.phases.completed,
          error:
            result.partial && result.failures.length > 0
              ? result.failures.join("\n")
              : undefined,
        },
      );
      await this.update();
      for (const warning of result.warnings) {
        this.output.appendLine(
          `[${new Date().toISOString()}] sync warning: ${warning}`,
        );
      }
    } catch (error) {
      if (error instanceof CancelledError) {
        this.taskMonitor.finish(taskId, "cancelled", {
          phase: UI_TEXT.taskPanel.phases.cancelled,
        });
        return;
      }
      const message = formatError(error);
      this.taskMonitor.finish(taskId, "failed", failedTaskPatch(message));
      this.output.appendLine(
        `[${new Date().toISOString()}] sync failed ${this.sourceUri.fsPath}: ${message}`,
      );
    } finally {
      this.setBusy(false);
    }
  }

  /**
   * 译后一致性检查：按块汇总术语/受保护 Markdown 问题，选中即重译该块。
   *
   * 只检查机器译文；人工锁定块由 SyncService.checkConsistency 跳过，
   * 避免一键重译覆盖手工成果。
   */
  private async checkConsistency(): Promise<void> {
    const report = await this.syncService.checkConsistency(this.sourceUri);
    if (!report.cacheExists) {
      this.showToast(UI_TEXT.consistency.noCache, "info");
      return;
    }
    if (report.issues.length === 0) {
      this.showToast(
        report.skippedHumanBlocks > 0
          ? formatText(UI_TEXT.consistency.okWithSkipped, {
              count: report.skippedHumanBlocks,
            })
          : UI_TEXT.consistency.ok,
        "success",
      );
      return;
    }

    const byBlock = new Map<number, ConsistencyIssue[]>();
    for (const issue of report.issues) {
      const list = byBlock.get(issue.blockIndex) ?? [];
      list.push(issue);
      byBlock.set(issue.blockIndex, list);
    }
    const items: Array<
      vscode.QuickPickItem & {
        blockIndex: number;
        sourceHash: string;
        cacheId: string;
      }
    > = [];
    for (const [blockIndex, issues] of byBlock) {
      const first = issues[0];
      if (!first) {
        continue;
      }
      const summaries = issues.map((issue) =>
        issue.kind === "glossary"
          ? formatText(UI_TEXT.consistency.glossaryIssue, {
              source: singleLine(issue.source),
              target: singleLine(issue.target),
            })
          : formatText(UI_TEXT.consistency.protectedIssue, {
              token: singleLine(issue.token, 80),
            }),
      );
      const location = [
        formatText(UI_TEXT.consistency.location, { line: first.sourceLine }),
        first.headingPath,
      ]
        .filter((part) => part.trim())
        .join(" · ");
      items.push({
        label: `$(warning) ${formatText(UI_TEXT.consistency.blockItem, {
          index: blockIndex + 1,
          count: issues.length,
        })}`,
        description: summaries.join("; "),
        detail: `${location}\n${first.currentText}`,
        blockIndex,
        sourceHash: first.sourceHash,
        cacheId: first.cacheId,
      });
    }

    const picked = await vscode.window.showQuickPick(items, {
      title: UI_TEXT.consistency.title,
      placeHolder: UI_TEXT.consistency.retranslateNote,
      matchOnDescription: true,
      matchOnDetail: true,
    });
    if (!picked) {
      return;
    }
    // 一致性检查只覆盖机器译文，且用户已在问题列表里明确选择，直接重译即可；
    // 传入检查时的哈希/id，防止等待期间块被锁定或缓存被清后误覆盖。
    await this.retranslateBlock(picked.blockIndex, false, {
      sourceHash: picked.sourceHash,
      cacheId: picked.cacheId,
      requireMachine: true,
    });
  }

  /**
   * 单块重译（有缓存/已删除时先确认）。
   * @param blockIndex 源块索引。
   * @param confirm 是否对已有译文弹出覆盖确认；一致性检查传入 false。
   * @param expected 可选的乐观并发校验/仅机器译文限制。
   * @returns 重译并刷新完成；用户取消时返回。
   * @remarks 已删除的译文对应「恢复翻译」，有缓存的块默认会二次确认。
   */
  private async retranslateBlock(
    blockIndex: number,
    confirm = true,
    expected?: RetranslateExpectation,
  ): Promise<void> {
    const view = this.lastModel?.blocks.find(
      (block) => block.blockIndex === blockIndex,
    );
    if (this.hasPendingSource()) {
      this.pendingRetranslate = {
        kind: "block",
        blockIndex,
        expected,
        sourceHash: view?.sourceHash,
        stagedText: this.pendingSourceEdits.get(blockIndex)?.text,
      };
      this.showToast(UI_TEXT.notifications.pendingSourceBeforeRetranslate, "info");
      await this.applySourceEdits();
      return;
    }
    if (confirm && view?.hasCache) {
      const deleted = view.status === "deleted";
      const message = deleted
        ? UI_TEXT.notifications.confirmResumeBlock
        : UI_TEXT.notifications.confirmRetranslateBlock;
      const action = deleted
        ? UI_TEXT.notifications.confirmResumeBlockAction
        : UI_TEXT.notifications.confirmRetranslateBlockAction;
      const choice = await vscode.window.showWarningMessage(
        message,
        { modal: true },
        action,
      );
      if (choice !== action) {
        return;
      }
    }
    this.setBusy(true, UI_TEXT.notifications.retranslateBlockBusy);
    const controller = new AbortController();
    let cancelled = false;
    try {
      const result = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "Markdown Bilingual Sync",
          cancellable: true,
        },
        async (progress, token) => {
          token.onCancellationRequested(() => {
            cancelled = true;
            controller.abort();
          });
          progress.report({ message: UI_TEXT.notifications.retranslateBlockBusy });
          return this.syncService.retranslateBlock(
            this.sourceUri,
            blockIndex,
            controller.signal,
            {
              stableTranslation: this.stableTranslation,
              summaryContext: this.summaryContext,
            },
            expected,
          );
        },
      );
      await this.update({
        text:
          result.mode === "sync"
            ? UI_TEXT.notifications.retranslateBlockSynced
            : UI_TEXT.notifications.retranslateBlockDone,
        kind: result.mode === "sync" ? "info" : "success",
      });
    } catch (error) {
      if (cancelled || error instanceof CancelledError) {
        this.showToast(UI_TEXT.notifications.retranslateCancelled, "info");
        return;
      }
      throw error;
    } finally {
      this.setBusy(false);
    }
  }

  /**
   * 「标记已同步」：接受当前译文并锁定，使块不再是过期状态（写缓存）。
   * @param blockIndex 源块索引。
   * @returns 刷新完成；用户取消时返回。
   */
  private async markSynced(blockIndex: number): Promise<void> {
    const choice = await vscode.window.showInformationMessage(
      UI_TEXT.notifications.confirmMarkSynced,
      { modal: true },
      UI_TEXT.notifications.confirmMarkSyncedAction,
    );
    if (choice !== UI_TEXT.notifications.confirmMarkSyncedAction) {
      return;
    }
    this.setBusy(true, UI_TEXT.notifications.markSyncedBusy);
    try {
      await this.syncService.markSynced(this.sourceUri, blockIndex);
      await this.update({
        text: UI_TEXT.notifications.markSyncedDone,
        kind: "success",
      });
    } finally {
      this.setBusy(false);
    }
  }

  // ---- 向 Webview 推送的 UI 状态 ----

  /**
   * 切换 Webview 的忙碌态（禁用交互 + 可选提示）。
   * @param busy 是否忙碌。
   * @param message 忙碌时展示的提示文案。
   * @remarks 面板已销毁时静默忽略；该状态是「最后一次写入生效」，不支持嵌套计数，
   * 并发操作可能提前解除忙碌。
   */
  private setBusy(busy: boolean, message?: string): void {
    if (this.disposed) {
      return;
    }
    this.postToWebview({ type: "busy", busy, message });
  }

  /**
   * 在 Webview 内弹 toast，并写入输出通道留痕。
   * @param text 文案。
   * @param kind 类型（info/success/error）。
   */
  private showToast(text: string, kind: "info" | "success" | "error"): void {
    if (this.disposed) {
      return;
    }
    this.postToWebview({ type: "toast", text, kind });
    this.output.appendLine(
      `[${new Date().toISOString()}] toast(${kind}): ${text}`,
    );
  }

  /**
   * 用最小错误页替换整个 Webview（渲染/读取状态失败时的兜底）。
   * @param message 错误详情，已转义。
   * @remarks 该页面不加载脚本，用户需手动「刷新」或用命令重新打开预览。
   */
  private renderError(message: string): void {
    const text = UI_TEXT.preview.errorPage;
    // 错误页不加载预览脚本：停止走 state 消息，并丢弃尚未来得及补发的控制消息。
    this.webviewReady = false;
    this.pendingMessages.length = 0;
    this.panel.webview.html = `<!DOCTYPE html>
<html lang="${escapeHtml(getLocale())}">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
<title>${escapeHtml(text.title)}</title>
<style>
body { margin: 0; padding: 36px; background: var(--vscode-editor-background, #1e1e1e); color: var(--vscode-foreground, #d4d4d4); font-family: var(--vscode-font-family, sans-serif); }
h1 { font-size: 18px; }
pre { white-space: pre-wrap; padding: 14px; border: 1px solid var(--vscode-panel-border, #444); border-radius: 8px; background: rgba(128,128,128,.1); }
p { color: var(--vscode-descriptionForeground, #999); }
</style>
</head>
<body>
<h1>${escapeHtml(text.heading)}</h1>
<pre>${escapeHtml(message)}</pre>
<p>${escapeHtml(text.hint)}</p>
</body>
</html>`;
  }
}
