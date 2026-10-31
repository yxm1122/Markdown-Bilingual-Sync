/**
 * 扩展入口：注册命令、装配服务与状态 UI、维护文档/配置监听。
 *
 * 职责：
 * - 创建输出通道与各服务（缓存、术语表、翻译 Provider、同步、导出、预览、任务监控）；
 * - 注册 package.json 中声明的全部 markdownBilingualSync.* 命令（每个命令只注册一次）；
 * - 统一包装命令错误：CancelledError 静默，其余写输出并弹出错误提示；
 * - 维护任务监控器与状态栏/任务视图的联动；
 * - 监听文档保存/关闭与配置变化，驱动预览刷新；
 * - API Key 只存放在 SecretStorage，按 Provider 使用独立键（OpenAI/HTTP，旧共用键仅作迁移回退），不写入 settings。
 *
 * 命令/视图生命周期：
 * - activate 每次扩展主机启动时调用一次；命令注册与监听都 push 到 context.subscriptions，
 *   由 VS Code 在停用/卸载时统一释放（状态栏在构造时自行登记）；
 * - 任务视图使用原生 TreeView，provider 自带 dispose；
 * - 单文件同步每次运行创建独立的 AbortController 与任务；
 *   批量翻译为每个文件创建独立 AbortController：取消单个任务只中止该文件，
 *   “取消全部”会逐一中止所有文件（未开始的文件在 worker 领取时跳过）。
 *
 * 关键不变量：
 * - 同步/导出/批量操作都要求源文件已保存到磁盘（file scheme）；
 * - 同一文件由 SyncService 内部的 inFlight 锁串行化，重复命令会失败而不是并发写缓存；
 * - 用户可见文案统一来自 i18n（en/zh 经 vscode.l10n.t 本地化）；
 * - SecretStorage 中的 Key 只在 API Key 命令与读取 Provider 配置时使用，绝不写入日志或设置。
 */
import * as vscode from "vscode";
import { filterBatchMarkdownFiles, isFileInsideFolder } from "./batch/batchFiles";
import { CacheStore } from "./cache/cacheStore";
import { ExportService, type PreparedExport } from "./export/exportService";
import {
  GlossaryStore,
  type GlossaryScope,
} from "./glossary/glossaryStore";
import { formatText, UI_TEXT } from "./i18n";
import { PreviewManager } from "./preview/previewManager";
import { SyncBlockedError } from "./sync/sync";
import {
  CancelledError,
  SyncService,
} from "./sync/syncService";
import { formatSyncSummary } from "./sync/summary";
import { isSupportedLanguageId } from "./util/language";
import { MockTranslationProvider } from "./translation/mockProvider";
import {
  GenericHttpTranslationProvider,
  type GenericHttpProviderConfig,
} from "./translation/genericHttpProvider";
import {
  OpenAITranslationProvider,
  type OpenAIProviderConfig,
} from "./translation/openaiProvider";
import {
  TranslationProviderRouter,
  type ProviderKind,
} from "./translation/providerRouter";
import { PROVIDER_PRESETS } from "./translation/presets";
import { ConcurrencyLimiter } from "./translation/concurrency";
import { BatchTranslationCoordinator } from "./translation/batchCoordinator";
import { OperationScheduler } from "./status/operationScheduler";
import { TranslationTaskMonitor } from "./status/taskMonitor";
import { TranslationStatusBar } from "./status/statusBar";
import { TaskViewProvider } from "./status/taskViewProvider";
import { tError } from "./i18n/errors";

// ---- 常量与小工具 ----

/** SecretStorage 中 OpenAI Provider 专用的 API Key 键名。 */
const OPENAI_API_KEY_SECRET = "markdownBilingualSync.apiKey.openai";
/** SecretStorage 中自定义 HTTP Provider 专用的 API Key 键名。 */
const HTTP_API_KEY_SECRET = "markdownBilingualSync.apiKey.http";
/** 旧版共用的 API Key 键名：读取时作为迁移回退，Mock 模式写入该键。 */
const LEGACY_API_KEY_SECRET = "markdownBilingualSync.apiKey";
/** API Key 长度上限，与输入框校验、Provider 内部校验保持一致。 */
const MAX_API_KEY_LENGTH = 20_000;

/**
 * 读取指定 Provider 的 API Key；专用键缺失时回退到旧版共用键，
 * 保证升级用户无需重新输入 Key。
 *
 * @param context 扩展上下文（提供 secrets）
 * @param secretKey Provider 专用键名
 * @returns 已存储的 Key；三个键都不存在时返回空字符串
 * @failure SecretStorage 读取失败时向上抛出
 */
async function readApiKeyWithLegacyFallback(
  context: vscode.ExtensionContext,
  secretKey: string,
): Promise<string> {
  const scoped = await context.secrets.get(secretKey);
  if (scoped) {
    return scoped;
  }
  return (await context.secrets.get(LEGACY_API_KEY_SECRET)) ?? "";
}

/**
 * 把 Provider 预设的展示文案本地化。
 *
 * presets.ts 保持纯数据（品牌名、接口地址与 provider 类型），这里只替换含自然语言的
 * 字段；deepseek/siliconflow 等纯地址描述沿用原始值。
 */
function localizedPresetText(preset: {
  id: string;
  label: string;
  description: string;
}): { label: string; description: string } {
  switch (preset.id) {
    case "openai":
      return {
        label: preset.label,
        description: UI_TEXT.presets.openaiDescription,
      };
    case "ollama":
      return {
        label: UI_TEXT.presets.ollamaLabel,
        description: UI_TEXT.presets.ollamaDescription,
      };
    case "lmstudio":
      return {
        label: UI_TEXT.presets.lmStudioLabel,
        description: UI_TEXT.presets.lmStudioDescription,
      };
    case "http":
      return {
        label: UI_TEXT.presets.customHttpLabel,
        description: UI_TEXT.presets.customHttpDescription,
      };
    case "mock":
      return {
        label: UI_TEXT.presets.mockLabel,
        description: UI_TEXT.presets.mockDescription,
      };
    default:
      return { label: preset.label, description: preset.description };
  }
}

/**
 * 把任意异常转换为可展示的文本。
 * SyncBlockedError 会展开为多条阻塞原因；其余取 message 或 String。
 */
function formatError(error: unknown): string {
  if (error instanceof SyncBlockedError) {
    return error.reasons.join("\n");
  }
  return error instanceof Error ? error.message : String(error);
}

/**
 * 取当前活动编辑器对应的 Markdown / Skill 文档。
 * @returns 文档 URI；不支持的语言或没有活动编辑器时返回 undefined
 * @sideeffect 非支持语言场景会弹出警告提示（命令入口共用）
 */
function activeMarkdownUri(): vscode.Uri | undefined {
  const editor = vscode.window.activeTextEditor;
  if (!editor || !isSupportedLanguageId(editor.document.languageId)) {
    void vscode.window.showWarningMessage(
      UI_TEXT.extension.openMarkdownFirst,
    );
    return undefined;
  }
  return editor.document.uri;
}

// ---- 配置读取 ----

/**
 * 读取翻译服务类型（markdownBilingualSync.provider）。
 * 非法值回退为 mock，避免未知配置导致 Provider 路由失败。
 */
function getProviderKind(): ProviderKind {
  const value = vscode.workspace
    .getConfiguration("markdownBilingualSync")
    .get<string>("provider", "mock");
  return value === "openai" || value === "http" ? value : "mock";
}

/**
 * 读取并发上限（markdownBilingualSync.translationConcurrency）。
 * 钳制到 1..100，非法/NaN 回退默认值 8。
 */
function getTranslationConcurrency(): number {
  const raw = Number(
    vscode.workspace
      .getConfiguration("markdownBilingualSync")
      .get<number>("translationConcurrency", 8),
  );
  return Math.min(100, Math.max(1, Math.round(raw) || 8));
}

/**
 * 组装 OpenAI 兼容 Provider 配置。
 * 每次翻译调用都会重新读取配置与 SecretStorage，保证修改设置后无需重载窗口。
 * API Key 优先读取 OpenAI 专用键，缺失时回退到旧版共用键。
 *
 * @param context 扩展上下文（提供 secrets）
 * @returns 不含日志输出的配置对象
 * @failure SecretStorage 读取失败时由调用方的 Provider 请求链向上抛出
 */
async function loadOpenAIConfig(
  context: vscode.ExtensionContext,
): Promise<OpenAIProviderConfig> {
  const config = vscode.workspace.getConfiguration("markdownBilingualSync");
  const model = String(config.get<string>("apiModel", "gpt-4o-mini"));
  const rawThinking = String(config.get<string>("apiThinkingMode", "default"));
  const thinking =
    rawThinking === "enabled" || rawThinking === "disabled"
      ? rawThinking
      : "default";
  return {
    baseUrl: String(
      config.get<string>("apiBaseUrl", "https://api.openai.com/v1"),
    ),
    model,
    batchSize: Number(config.get<number>("apiBatchSize", 50)),
    tokenBudget: Number(config.get<number>("apiBatchTokenBudget", 2_000)),
    timeoutMs: Number(config.get<number>("apiTimeoutMs", 120_000)),
    thinking,
    // 旧开关只在新的三态设置为 default 时作为兼容回退。
    disableThinking:
      thinking === "default" &&
      config.get<boolean>("apiDisableThinking", false) === true,
    apiKey: await readApiKeyWithLegacyFallback(context, OPENAI_API_KEY_SECRET),
  };
}

/**
 * 组装自定义 HTTP Provider 配置。
 * 模板在 Provider 内部渲染，API Key 只通过 {{apiKey}} 变量注入，不写回设置。
 * API Key 优先读取 HTTP 专用键，缺失时回退到旧版共用键。
 *
 * @param context 扩展上下文（提供 secrets）
 * @returns HTTP 模板配置
 * @failure SecretStorage 读取失败时向上抛出；模板合法性由 Provider 校验
 */
async function loadGenericHttpConfig(
  context: vscode.ExtensionContext,
): Promise<GenericHttpProviderConfig> {
  const config = vscode.workspace.getConfiguration("markdownBilingualSync");
  return {
    endpoint: String(config.get<string>("httpEndpoint", "")),
    method: String(config.get<string>("httpMethod", "POST")),
    headersTemplate: String(config.get<string>("httpHeaders", "{}")),
    bodyTemplate: String(config.get<string>("httpBody", "{}")),
    responseType: String(config.get<string>("httpResponseType", "json")),
    responsePath: String(config.get<string>("httpResponsePath", "translation")),
    timeoutMs: Number(config.get<number>("apiTimeoutMs", 120_000)),
    apiKey: await readApiKeyWithLegacyFallback(context, HTTP_API_KEY_SECRET),
  };
}

// ---- 批量目录辅助 ----

/**
 * 弹出系统目录选择框，供批量翻译/导出使用。
 * 默认定位到当前文件所在目录，否则回退到第一个工作区根目录。
 *
 * @returns 选中的目录；用户取消时 undefined
 * @sideeffect 打开 VS Code 原生选择对话框
 */
async function pickBatchFolder(): Promise<vscode.Uri | undefined> {
  const activeUri = vscode.window.activeTextEditor?.document.uri;
  const defaultUri =
    activeUri?.scheme === "file"
      ? vscode.Uri.joinPath(activeUri, "..")
      : vscode.workspace.workspaceFolders?.[0]?.uri;
  const selected = await vscode.window.showOpenDialog({
    title: UI_TEXT.extension.batchPickTitle,
    openLabel: UI_TEXT.extension.batchPickLabel,
    defaultUri,
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
  });
  return selected?.[0];
}

/**
 * 递归收集目录下的 Markdown 文件，并过滤掉目标语言导出文件。
 *
 * @param folder 起始目录
 * @param targetLanguage 目标语言，用于 filterBatchMarkdownFiles 的排除规则
 * @returns 待处理的文件 URI 列表（顺序取决于文件系统遍历顺序）
 * @failure 任一子目录不可读时向上抛出（批量命令整体失败）
 */
async function collectMarkdownFiles(
  folder: vscode.Uri,
  targetLanguage: string,
): Promise<vscode.Uri[]> {
  const files: vscode.Uri[] = [];
  const walk = async (directory: vscode.Uri): Promise<void> => {
    const entries = await vscode.workspace.fs.readDirectory(directory);
    for (const [name, type] of entries) {
      if ((type & vscode.FileType.Directory) !== 0) {
        // 跳过超大依赖目录，避免批量操作扫描 node_modules/.git。
        if (name === "node_modules" || name === ".git") {
          continue;
        }
        await walk(vscode.Uri.joinPath(directory, name));
      } else if (
        (type & vscode.FileType.File) !== 0 &&
        /\.md$/i.test(name)
      ) {
        files.push(vscode.Uri.joinPath(directory, name));
      }
    }
  };
  await walk(folder);
  return filterBatchMarkdownFiles(files, targetLanguage);
}

/**
 * 保存目录内所有未保存的 Markdown 文档，保证批量操作读取磁盘最新内容。
 *
 * @param folder 用户选择的目录
 * @failure 任一文档保存失败时抛出，调用方应中止整批操作
 * @sideeffect 会触发 onDidSaveTextDocument 监听（预览刷新）
 */
async function saveDirtyMarkdownInFolder(
  folder: vscode.Uri,
): Promise<void> {
  for (const document of vscode.workspace.textDocuments) {
    if (!document.isDirty || !isSupportedLanguageId(document.languageId)) {
      continue;
    }
    if (!isFileInsideFolder(folder.fsPath, document.uri.fsPath)) {
      continue;
    }
    const saved = await document.save();
    if (!saved) {
      throw new Error(
        tError("commands.saveDirtyFailed", { file: vscode.workspace.asRelativePath(document.uri, false) }),
      );
    }
  }
}

// ---- 激活入口 ----

/**
 * 扩展激活入口：装配依赖、注册全部命令与全局监听。
 *
 * @param context 扩展上下文；所有 Disposable 都挂到 context.subscriptions
 * @sideeffect 创建输出通道、后台服务、状态栏与任务视图，并注册命令与监听
 * @failure 初始化阶段的异常由 VS Code 记录并阻止扩展激活；命令内部异常由 handleErrors 兜底
 */
export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel("Markdown Bilingual Sync");
  context.subscriptions.push(output);

  // 缓存与术语表都使用 context.globalStorageUri，跨工作区共享。
  const cacheStore = new CacheStore(context);
  const glossaryStore = new GlossaryStore(context);
  // 全局请求并发上限：文件级并发与单文件内批次请求共用同一个限制器。
  const translationLimiter = new ConcurrencyLimiter(
    getTranslationConcurrency,
  );
  const taskMonitor = new TranslationTaskMonitor();
  // 所有长操作统一排队：同文件串行、不同文件并行；任务级并发复用请求并发设置。
  const operationScheduler = new OperationScheduler(
    taskMonitor,
    getTranslationConcurrency,
  );
  context.subscriptions.push({
    dispose: () => operationScheduler.dispose(),
  });
  // Provider 采用惰性配置：每次请求时才读取设置与 SecretStorage。
  const openAIProvider = new OpenAITranslationProvider({
    getConfig: () => loadOpenAIConfig(context),
    limiter: translationLimiter,
  });
  const genericHttpProvider = new GenericHttpTranslationProvider({
    getConfig: () => loadGenericHttpConfig(context),
    limiter: translationLimiter,
  });
  // 按 provider 设置路由到 mock/openai/http；BatchTranslationCoordinator 负责合并短时间内的批次请求。
  const providerRouter = new TranslationProviderRouter(
    getProviderKind,
    new MockTranslationProvider(),
    openAIProvider,
    genericHttpProvider,
  );
  const translationProvider = new BatchTranslationCoordinator(
    providerRouter,
  );
  const syncService = new SyncService(
    cacheStore,
    glossaryStore,
    translationProvider,
    output,
  );
  const exportService = new ExportService(
    syncService,
    output,
  );
  const previewManager = new PreviewManager(
    context,
    syncService,
    exportService,
    output,
    taskMonitor,
    operationScheduler,
  );
  context.subscriptions.push(previewManager);
  // 任务视图只依赖快照与命令回调，不直接访问同步服务。
  const taskViewProvider = new TaskViewProvider({
    monitor: taskMonitor,
    limiter: translationLimiter,
    output,
    openPreview: (uri) => previewManager.open(uri),
    // 每次推送状态时重新读取设置，保证“运行状态”区与当前配置一致。
    getSystemInfo: () => {
      const config = vscode.workspace.getConfiguration(
        "markdownBilingualSync",
      );
      const kind = getProviderKind();
      return {
        provider: syncService.providerLabel,
        model:
          kind === "openai"
            ? String(config.get<string>("apiModel", "gpt-4o-mini"))
            : kind === "http"
              ? UI_TEXT.providers.customHttpModel
              : UI_TEXT.providers.mockDemo,
        tokenBudget: Number(
          config.get<number>("apiBatchTokenBudget", 2_000),
        ),
        batchSize: Number(config.get<number>("apiBatchSize", 50)),
      };
    },
  });
  const taskTreeView = vscode.window.createTreeView(
    "markdownBilingualSync.tasksView",
    {
      treeDataProvider: taskViewProvider,
      showCollapseAll: true,
    },
  );
  taskViewProvider.setTreeView(taskTreeView);
  taskViewProvider.registerCommands();
  context.subscriptions.push(taskViewProvider, taskTreeView);
  // 状态栏在构造时自行注册到 context.subscriptions，无需保存引用。
  new TranslationStatusBar(
    context,
    taskMonitor,
    translationLimiter,
    "markdownBilingualSync.openTaskPanel",
  );

  // ---- 任务执行与命令包装 ----

  /**
   * 命令统一错误边界：执行异步动作，并把异常转换为输出日志 + 错误弹窗。
   * CancelledError 视为用户主动取消，静默返回。
   *
   * @param action 命令实际逻辑
   * @sideeffect 失败时写输出通道并弹出错误提示
   */
  const handleErrors = async (
    action: () => Promise<void>,
  ): Promise<void> => {
    try {
      await action();
    } catch (error) {
      // 取消不是错误：同步流程已自行更新任务状态，这里不再打扰用户。
      if (error instanceof CancelledError) {
        return;
      }
      const message = formatError(error);
      const stack =
        error instanceof Error ? (error.stack ?? error.message) : String(error);
      output.appendLine(
        `[${new Date().toISOString()}] command failed: ${stack}`,
      );
      void vscode.window.showErrorMessage(
        `${UI_TEXT.extension.messagePrefix}${message}`,
      );
    }
  };

  /**
   * 执行单文件同步（sync / stale / all），并同步任务监控器与预览。
   *
   * @param sourceUri 源 Markdown 文件
   * @param mode sync=只补缺失，stale=重译过期块，all=重译全部机器译文
   * @param openPreview 成功后是否新建/显示预览（否则只刷新已打开的预览）
   * @sideeffect 向调度器入队；写缓存、刷新预览、写输出日志在任务执行时发生
   * @failure 同步异常由调度器写入任务终态；预览打开失败只记录日志，不改变翻译结果
   */
  const runSync = (
    sourceUri: vscode.Uri,
    mode: "sync" | "stale" | "all",
    openPreview: boolean,
  ): void => {
    const relative = vscode.workspace.asRelativePath(sourceUri, false);
    operationScheduler.enqueue({
      label: relative,
      operation: mode === "sync" ? "sync" : "retranslate",
      uri: sourceUri,
      run: async ({ signal, report }) => {
        report({ phase: UI_TEXT.extension.syncPreparing });
        try {
          const outcome =
            mode === "all"
              ? await syncService.retranslateAll(
                  sourceUri,
                  (message, detail) => {
                    report({ phase: message, ...(detail ?? {}) });
                  },
                  signal,
                )
              : await syncService.sync(
                  sourceUri,
                  mode === "stale",
                  (message, detail) => {
                    report({ phase: message, ...(detail ?? {}) });
                  },
                  signal,
                  true,
                );
          const { result } = outcome;
          try {
            if (openPreview) {
              previewManager.open(sourceUri);
            } else {
              previewManager.refresh(sourceUri);
            }
          } catch (error) {
            output.appendLine(
              `[${new Date().toISOString()}] sync preview failed ${relative}: ${formatError(error)}`,
            );
          }
          // 摘要与警告只写输出通道，避免翻译完成时弹出过多通知。
          const title =
            mode === "all"
              ? UI_TEXT.extension.syncTitleAll
              : mode === "stale"
                ? UI_TEXT.extension.syncTitleStale
                : UI_TEXT.extension.syncTitleSync;
          output.appendLine(
            `[${new Date().toISOString()}] ${formatSyncSummary(result, title)}`,
          );
          for (const warning of result.warnings) {
            output.appendLine(
              `[${new Date().toISOString()}] sync warning: ${warning}`,
            );
          }
          return {
            status: result.partial ? "partial" : "success",
            phase: result.partial
              ? UI_TEXT.taskPanel.phases.partial
              : UI_TEXT.taskPanel.phases.completed,
            completed: result.translatedCount,
            total: result.translatedCount + result.failedTaskCount,
            failed: result.failedTaskCount,
            ...(result.partial && result.failures.length > 0
              ? { error: result.failures.join("\n") }
              : {}),
          };
        } catch (error) {
          if (error instanceof CancelledError) {
            previewManager.refresh(sourceUri);
          } else {
            output.appendLine(
              `[${new Date().toISOString()}] sync failed ${relative}: ${formatError(error)}`,
            );
          }
          throw error;
        }
      },
    });
  };

  /**
   * 注册命令并挂到 context.subscriptions。
   * 所有命令在 activate 中只注册一次，重复激活会导致 VS Code 报重复注册错误。
   */
  const register = (
    command: string,
    action: (...args: never[]) => unknown,
  ): void => {
    context.subscriptions.push(
      vscode.commands.registerCommand(command, action),
    );
  };

  // ---- 命令注册 ----

  /**
   * 单文件翻译/同步的共享实现：翻译当前活动 Markdown 文件并打开预览。
   * translateFile 与 syncFile 行为完全一致，保留两个命令 ID 仅为兼容既有菜单/键位。
   */
  const translateActiveMarkdown = (): Promise<void> =>
    handleErrors(async () => {
      const uri = activeMarkdownUri();
      if (uri) {
        await runSync(uri, "sync", true);
      }
    });

  register("markdownBilingualSync.translateFile", () =>
    translateActiveMarkdown(),
  );

  // 只打开预览，不触发翻译；预览面板按源文件 URI 复用。
  register("markdownBilingualSync.openPreview", () =>
    handleErrors(async () => {
      const uri = activeMarkdownUri();
      if (uri) {
        previewManager.open(uri);
      }
    }),
  );

  // 任务面板开关：未包 handleErrors，toggle 内部命令失败不会转成用户提示。
  register("markdownBilingualSync.openTaskPanel", () => {
    void taskViewProvider.toggle();
  });

  // 与 translateFile 共用同一实现，保留独立命令 ID。
  register("markdownBilingualSync.syncFile", () =>
    translateActiveMarkdown(),
  );

  // 重译过期块：命令入口先做全量确认，预览面板内则按过期数量确认。
  register("markdownBilingualSync.retranslateStale", () =>
    handleErrors(async () => {
      const uri = activeMarkdownUri();
      if (!uri) {
        return;
      }
      const choice = await vscode.window.showWarningMessage(
        UI_TEXT.extension.confirmRetranslateStaleAll,
        { modal: true },
        UI_TEXT.extension.confirmRetranslateStaleAction,
      );
      if (choice === UI_TEXT.extension.confirmRetranslateStaleAction) {
        await runSync(uri, "stale", true);
      }
    }),
  );

  // 全部重译：译文锁定（human）块不会被覆盖，由 SyncService 保证。
  register("markdownBilingualSync.retranslateAll", () =>
    handleErrors(async () => {
      const uri = activeMarkdownUri();
      if (!uri) {
        return;
      }
      const choice = await vscode.window.showWarningMessage(
        UI_TEXT.extension.confirmRetranslateAll,
        { modal: true },
        UI_TEXT.extension.confirmRetranslateAllAction,
      );
      if (choice === UI_TEXT.extension.confirmRetranslateAllAction) {
        await runSync(uri, "all", true);
      }
    }),
  );

  // 导出：由预览面板展示 diff 并确认写入，命令本身只负责打开准备流程。
  register("markdownBilingualSync.exportTranslation", () =>
    handleErrors(async () => {
      const uri = activeMarkdownUri();
      if (uri) {
        await previewManager.beginExport(uri);
      }
    }),
  );

  // 直接打开缓存 Markdown，便于高级用户手工检查/编辑。
  register("markdownBilingualSync.editTranslation", () =>
    handleErrors(async () => {
      const uri = activeMarkdownUri();
      if (uri) {
        await syncService.openCacheFile(uri);
      }
    }),
  );

  // 已打开则刷新，未打开则创建；区别于 openPreview 的“只打开”。
  register("markdownBilingualSync.refreshPreview", () =>
    handleErrors(async () => {
      const uri = activeMarkdownUri();
      if (uri) {
        if (previewManager.has(uri)) {
          previewManager.refresh(uri);
        } else {
          previewManager.open(uri);
        }
      }
    }),
  );

  // 缓存目录：Markdown 活动编辑器按文件定位，否则打开全局缓存根目录。
  register("markdownBilingualSync.openCacheFolder", () =>
    handleErrors(async () => {
      const editor = vscode.window.activeTextEditor;
      if (editor && isSupportedLanguageId(editor.document.languageId)) {
        await syncService.openCacheFolder(editor.document.uri);
      } else {
        await syncService.openGlobalCacheFolder();
      }
    }),
  );

  // 清理当前文件缓存：不可撤销，需二次确认；删除后刷新预览为空译文状态。
  register("markdownBilingualSync.clearCache", () =>
    handleErrors(async () => {
      const uri = activeMarkdownUri();
      if (!uri) {
        return;
      }
      const choice = await vscode.window.showWarningMessage(
        UI_TEXT.extension.confirmClearCache,
        { modal: true },
        UI_TEXT.extension.clearCacheAction,
      );
      if (choice !== UI_TEXT.extension.clearCacheAction) {
        return;
      }
      const removed = await syncService.clearCache(uri);
      if (!removed) {
        void vscode.window.showInformationMessage(
          UI_TEXT.extension.clearCacheMissing,
        );
        return;
      }
      previewManager.refresh(uri);
      void vscode.window.showInformationMessage(
        UI_TEXT.extension.clearCacheDone,
      );
    }),
  );

  // 清理全部缓存：SyncService 会拒绝在有同步任务进行时执行；刷新所有已打开预览。
  register("markdownBilingualSync.clearAllCaches", () =>
    handleErrors(async () => {
      const choice = await vscode.window.showWarningMessage(
        UI_TEXT.extension.confirmClearAllCaches,
        { modal: true },
        UI_TEXT.extension.clearAllCachesAction,
      );
      if (choice !== UI_TEXT.extension.clearAllCachesAction) {
        return;
      }
      const removed = await syncService.clearAllCaches();
      if (removed === 0) {
        void vscode.window.showInformationMessage(
          UI_TEXT.extension.clearAllCachesNone,
        );
        return;
      }
      previewManager.refreshAll();
      void vscode.window.showInformationMessage(
        formatText(UI_TEXT.extension.clearAllCachesDone, { count: removed }),
      );
    }),
  );

  // 导入已有译文：选择文件、确认覆盖等交互都在预览面板会话中完成。
  register("markdownBilingualSync.importTranslation", () =>
    handleErrors(async () => {
      const sourceUri = activeMarkdownUri();
      if (sourceUri) {
        await previewManager.beginImport(sourceUri);
      }
    }),
  );

  // ---- 批量命令 ----

  // 批量翻译：扫描目录 → 确认 → 保存脏文档 → 文件级并发同步。
  register("markdownBilingualSync.batchTranslateFolder", () =>
    handleErrors(async () => {
      const folder = await pickBatchFolder();
      if (!folder) {
        return;
      }
      // 语言设置在操作开始时读取一次，扫描期间改设置不会影响本次批量。
      const settings = syncService.getSettings();
      const files = await collectMarkdownFiles(
        folder,
        settings.targetLanguage,
      );
      if (files.length === 0) {
        void vscode.window.showInformationMessage(
          UI_TEXT.extension.batchTranslateEmpty,
        );
        return;
      }
      const choice = await vscode.window.showWarningMessage(
        formatText(UI_TEXT.extension.confirmBatchTranslate, {
          count: files.length,
        }),
        { modal: true },
        UI_TEXT.extension.batchTranslateAction,
      );
      if (choice !== UI_TEXT.extension.batchTranslateAction) {
        return;
      }
      // 先把目录内未保存的 Markdown 落盘，避免翻译旧内容。
      await saveDirtyMarkdownInFolder(folder);

      const concurrency = getTranslationConcurrency();
      output.appendLine(
        `[${new Date().toISOString()}] batch translate start: files=${files.length}, concurrency=${concurrency}`,
      );

      // 批量汇总只写输出日志，不逐文件弹通知（任务视图负责进度展示）。
      const summary = {
        processed: 0,
        partial: 0,
        translated: 0,
        copied: 0,
        human: 0,
        failed: 0,
        failedBlocks: 0,
      };
      const jobs = files.map((file) => {
        const relative = vscode.workspace.asRelativePath(file, false);
        return operationScheduler.enqueue<{
          translated: number;
          copied: number;
          human: number;
          failedBlocks: number;
          partial: boolean;
        }>({
          label: relative,
          operation: "sync",
          uri: file,
          run: async ({ signal, report }) => {
            try {
              // allowPartial=true：保留单文件内已成功的块，失败块计入 failedTaskCount。
              const outcome = await syncService.sync(
                file,
                false,
                (message, detail) => {
                  report({ phase: message, ...(detail ?? {}) });
                },
                signal,
                true,
              );
              const result = outcome.result;
              output.appendLine(
                `[${new Date().toISOString()}] batch translate ${relative}: translated=${result.translatedCount}, failed=${result.failedTaskCount}, partial=${result.partial}, copied=${result.copiedCount}, human=${result.humanLockedCount}`,
              );
              return {
                status: result.partial ? "partial" : "success",
                phase: result.partial
                  ? UI_TEXT.taskPanel.phases.partial
                  : UI_TEXT.taskPanel.phases.completed,
                completed: result.translatedCount,
                total: result.translatedCount + result.failedTaskCount,
                failed: result.failedTaskCount,
                ...(result.partial && result.failures.length > 0
                  ? { error: result.failures.join("\n") }
                  : {}),
                result: {
                  translated: result.translatedCount,
                  copied: result.copiedCount,
                  human: result.humanLockedCount,
                  failedBlocks: result.failedTaskCount,
                  partial: result.partial,
                },
              };
            } catch (error) {
              if (!(error instanceof CancelledError) && !signal.aborted) {
                output.appendLine(
                  `[${new Date().toISOString()}] batch translate failed ${relative}: ${formatError(error)}`,
                );
              }
              throw error;
            }
          },
        });
      });

      const settlements = await Promise.all(
        jobs.map((job) => job.done),
      );
      previewManager.refreshAll();
      let cancelled = false;
      for (const settlement of settlements) {
        if (
          (settlement.status === "success" ||
            settlement.status === "partial") &&
          settlement.result
        ) {
          summary.processed += 1;
          summary.translated += settlement.result.translated;
          summary.copied += settlement.result.copied;
          summary.human += settlement.result.human;
          summary.failedBlocks += settlement.result.failedBlocks;
          if (settlement.result.partial) {
            summary.partial += 1;
          }
        } else if (settlement.status === "failed") {
          summary.failed += 1;
        } else if (settlement.status === "cancelled") {
          cancelled = true;
        }
      }

      // summary.processed 只统计成功完成的文件，日志字段沿用 processed 名称。
      output.appendLine(
        `[${new Date().toISOString()}] batch translate finished: files=${summary.processed}, partial=${summary.partial}, failed=${summary.failed}, translated=${summary.translated}, failedBlocks=${summary.failedBlocks}, cancelled=${cancelled}`,
      );
    }),
  );

  // 批量导出：先 prepare 收集可写文件，再统一确认并 commit（两阶段写入）。
  register("markdownBilingualSync.batchExportFolder", () =>
    handleErrors(async () => {
      const folder = await pickBatchFolder();
      if (!folder) {
        return;
      }
      const settings = syncService.getSettings();
      const files = await collectMarkdownFiles(
        folder,
        settings.targetLanguage,
      );
      if (files.length === 0) {
        void vscode.window.showInformationMessage(
          UI_TEXT.extension.batchExportEmpty,
        );
        return;
      }
      await saveDirtyMarkdownInFolder(folder);

      // prepared 中保存了 prepare 阶段的快照，确认后直接写入，避免二次读取。
      const prepared: PreparedExport[] = [];
      let unchanged = 0;
      let skipped = 0;
      let failed = 0;
      // 该阶段只读不写，禁用取消以免留下半准备状态；真正写入在确认之后。
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: UI_TEXT.extension.batchExportTitle,
          cancellable: false,
        },
        async (progress) => {
          for (let index = 0; index < files.length; index += 1) {
            const file = files[index];
            const relative = vscode.workspace.asRelativePath(file, false);
            progress.report({
              message: formatText(
                UI_TEXT.extension.batchExportProgress,
                {
                  current: index + 1,
                  total: files.length,
                  file: relative,
                },
              ),
            });
            // 没有译文缓存的文件没有可导出内容，直接跳过。
            if (!(await syncService.hasCache(file))) {
              skipped += 1;
              continue;
            }
            try {
              const preparation = await exportService.prepare(file);
              if (preparation.status === "unchanged") {
                unchanged += 1;
                continue;
              }
              prepared.push(preparation.prepared);
            } catch (error) {
              failed += 1;
              output.appendLine(
                `[${new Date().toISOString()}] batch export prepare failed ${relative}: ${formatError(error)}`,
              );
            }
          }
        },
      );

      // 没有任何可写文件：只显示统计信息，不进入覆盖确认。
      if (prepared.length === 0) {
        const message = formatText(UI_TEXT.extension.batchExportNone, {
          unchanged,
          skipped,
          failed,
        });
        const action =
          failed > 0
            ? await vscode.window.showWarningMessage(
                message,
                UI_TEXT.extension.batchOpenOutput,
              )
            : await vscode.window.showInformationMessage(message);
        if (action === UI_TEXT.extension.batchOpenOutput) {
          output.show(true);
        }
        return;
      }

      const choice = await vscode.window.showWarningMessage(
        formatText(UI_TEXT.extension.confirmBatchExport, {
          count: prepared.length,
          overwrite: prepared.filter(
            (item) => item.existingText !== undefined,
          ).length,
          unchanged,
          skipped,
          failed,
        }),
        { modal: true },
        UI_TEXT.extension.batchExportAction,
      );
      if (choice !== UI_TEXT.extension.batchExportAction) {
        return;
      }

      // 逐个 commit；单个文件失败不中断整批，失败数累加到最终提示。
      let exported = 0;
      for (const item of prepared) {
        try {
          await exportService.commit(item);
          exported += 1;
          output.appendLine(
            `[${new Date().toISOString()}] batch exported ${item.destination}`,
          );
        } catch (error) {
          failed += 1;
          output.appendLine(
            `[${new Date().toISOString()}] batch export commit failed ${item.destination}: ${formatError(error)}`,
          );
        }
      }

      const message =
        failed > 0
          ? formatText(UI_TEXT.extension.batchExportPartial, {
              count: exported,
              failed,
            })
          : formatText(UI_TEXT.extension.batchExportDone, {
              count: exported,
            });
      const action =
        failed > 0
          ? await vscode.window.showWarningMessage(
              message,
              UI_TEXT.extension.batchOpenOutput,
            )
          : await vscode.window.showInformationMessage(
              message,
              UI_TEXT.extension.batchOpenOutput,
            );
      if (action === UI_TEXT.extension.batchOpenOutput) {
        output.show(true);
      }
    }),
  );

  // ---- 术语表、Provider 与密钥命令 ----

  // 全局术语表：由 GlossaryStore 负责创建/定位文件，与工作区无关。
  register("markdownBilingualSync.editGlossary", () =>
    handleErrors(async () => {
      await glossaryStore.open();
    }),
  );

  // 用户术语表：全局或工作区；文档术语表随全文摘要保存在缓存中，在预览里编辑。
  register("markdownBilingualSync.editScopedGlossary", () =>
    handleErrors(async () => {
      // 不强制要求活动编辑器是 Markdown：从命令面板打开全局/工作区术语表也应可用。
      const activeUri = vscode.window.activeTextEditor?.document.uri;
      const items: Array<vscode.QuickPickItem & { scope: GlossaryScope }> = [
        {
          label: UI_TEXT.extension.glossaryGlobal,
          description: UI_TEXT.extension.glossaryGlobalDescription,
          scope: "global",
        },
      ];
      if (vscode.workspace.workspaceFolders?.length) {
        items.push({
          label: UI_TEXT.extension.glossaryWorkspace,
          description: UI_TEXT.extension.glossaryWorkspaceDescription,
          scope: "workspace",
        });
      }
      const picked = await vscode.window.showQuickPick(items, {
        title: UI_TEXT.extension.editScopedGlossaryTitle,
        placeHolder: UI_TEXT.extension.editScopedGlossaryTitle,
      });
      if (!picked) {
        return;
      }
      if (picked.scope === "global") {
        await glossaryStore.open();
        return;
      }
      const opened = await glossaryStore.openWorkspaceGlossary(activeUri);
      if (!opened) {
        void vscode.window.showWarningMessage(
          UI_TEXT.extension.glossaryNoWorkspace,
        );
      }
    }),
  );

  // 应用翻译服务预设：provider 与预设设置都写入用户（Global）设置。
  register("markdownBilingualSync.applyProviderPreset", () =>
    handleErrors(async () => {
      const picked = await vscode.window.showQuickPick(
        PROVIDER_PRESETS.map((preset) => {
          const text = localizedPresetText(preset);
          return {
            label: text.label,
            description: text.description,
            detail: `provider: ${preset.provider}`,
            preset,
          };
        }),
        {
          title: UI_TEXT.extension.providerPresetTitle,
          placeHolder: UI_TEXT.extension.providerPresetPlaceholder,
          ignoreFocusOut: true,
        },
      );
      if (!picked) {
        return;
      }
      const config = vscode.workspace.getConfiguration(
        "markdownBilingualSync",
      );
      // 先切 provider 再写接口设置；逐项 update，非原子操作。
      await config.update(
        "provider",
        picked.preset.provider,
        vscode.ConfigurationTarget.Global,
      );
      for (const [key, value] of Object.entries(
        picked.preset.settings ?? {},
      )) {
        await config.update(key, value, vscode.ConfigurationTarget.Global);
      }
      // Mock 不需要连接测试；其余 Provider 提供“测试连接”快捷动作。
      const actions =
        picked.preset.provider === "mock"
          ? []
          : [UI_TEXT.extension.providerPresetTestAction];
      const choice = await vscode.window.showInformationMessage(
        formatText(UI_TEXT.extension.providerPresetApplied, {
          name: picked.label,
        }),
        ...actions,
      );
      if (choice === UI_TEXT.extension.providerPresetTestAction) {
        await vscode.commands.executeCommand(
          "markdownBilingualSync.testApiConnection",
        );
      }
    }),
  );

  // 设置 API Key：密码框输入，按当前 Provider 写入 SecretStorage 的独立键（不写入 settings/工作区/缓存）。
  register("markdownBilingualSync.setApiKey", () =>
    handleErrors(async () => {
      const value = await vscode.window.showInputBox({
        title: UI_TEXT.extension.apiKeyInputTitle,
        prompt: UI_TEXT.extension.apiKeyInputPrompt,
        password: true,
        ignoreFocusOut: true,
        validateInput: (input) =>
          !input.trim()
            ? UI_TEXT.extension.apiKeyEmpty
            : input.trim().length > MAX_API_KEY_LENGTH
              ? UI_TEXT.extension.apiKeyTooLong
              : undefined,
      });
      // undefined = 用户按 Esc；空字符串由 validateInput 拦截。
      if (value === undefined) {
        return;
      }
      const apiKey = value.trim();
      if (!apiKey) {
        return;
      }
      // openai/http 写入各自专用键；mock 沿用旧共用键，保持“先设 Key 再切换 Provider”的流程。
      const providerKind = getProviderKind();
      const secretKey =
        providerKind === "openai"
          ? OPENAI_API_KEY_SECRET
          : providerKind === "http"
            ? HTTP_API_KEY_SECRET
            : LEGACY_API_KEY_SECRET;
      await context.secrets.store(secretKey, apiKey);
      // 专用键写入成功后清理旧共用键，避免回退读取到过期 Key。
      if (providerKind !== "mock") {
        await context.secrets.delete(LEGACY_API_KEY_SECRET);
      }
      // 提示文案与测试动作取决于当前 provider（Mock 下仅提醒切换服务）。
      const hint =
        providerKind === "mock"
          ? UI_TEXT.extension.apiKeyHintMock
          : providerKind === "http"
            ? UI_TEXT.extension.apiKeyHintHTTP
            : UI_TEXT.extension.apiKeyHintOpenAI;
      const actions =
        providerKind === "openai" || providerKind === "http"
          ? [UI_TEXT.extension.apiKeyTestAction]
          : [];
      const choice = await vscode.window.showInformationMessage(
        formatText(UI_TEXT.extension.apiKeySaved, { hint }),
        ...actions,
      );
      if (choice === UI_TEXT.extension.apiKeyTestAction) {
        await vscode.commands.executeCommand(
          "markdownBilingualSync.testApiConnection",
        );
      }
    }),
  );

  // 测试连接：发一个极小的翻译请求；Mock 下直接提示切换 Provider。
  register("markdownBilingualSync.testApiConnection", () =>
    handleErrors(async () => {
      if (getProviderKind() === "mock") {
        void vscode.window.showWarningMessage(
          UI_TEXT.extension.testRequiresProvider,
        );
        return;
      }

      const config = vscode.workspace.getConfiguration("markdownBilingualSync");
      const sourceLanguage = String(config.get<string>("sourceLanguage", "en"));
      let targetLanguage = String(config.get<string>("targetLanguage", "zh-CN"));
      // 源/目标语言相同时临时换成另一种语言，仅用于本次测试，不写回设置。
      if (sourceLanguage.toLowerCase() === targetLanguage.toLowerCase()) {
        targetLanguage = sourceLanguage.toLowerCase().startsWith("zh")
          ? "en"
          : "zh-CN";
      }

      // 可取消的进度通知；取消后 Provider 抛出取消错误，这里转为静默返回。
      const result = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: UI_TEXT.extension.testProgressTitle,
          cancellable: true,
        },
        async (progress, token) => {
          const controller = new AbortController();
          token.onCancellationRequested(() => controller.abort());
          progress.report({
            message: UI_TEXT.extension.testProgressMessage,
          });
          try {
            return await providerRouter.testConnection(
              sourceLanguage,
              targetLanguage,
              controller.signal,
            );
          } catch (error) {
            if (controller.signal.aborted) {
              return undefined;
            }
            throw error;
          }
        },
      );

      // undefined 表示用户取消，不弹结果。
      if (!result) {
        return;
      }
      // endpoint 由 Provider 返回（自定义 HTTP 会对 Key 脱敏）；日志不包含 SecretStorage 中的 Key。
      output.appendLine(
        `[${new Date().toISOString()}] connection test ok: model=${result.model}, latency=${result.latencyMs}ms, thinking=${result.thinkingMode}, endpoint=${result.endpoint}, sample=${JSON.stringify(result.sample)}`,
      );
      void vscode.window.showInformationMessage(
        formatText(UI_TEXT.extension.testSuccess, {
          model: result.model,
          latency: result.latencyMs,
          thinking:
            result.thinkingMode === "enabled"
              ? UI_TEXT.extension.testThinkingEnabled
              : result.thinkingMode === "disabled"
                ? UI_TEXT.extension.testThinkingDisabled
                : "",
          sample: result.sample,
        }),
      );
    }),
  );

  // 清除 API Key：需二次确认；三个键（OpenAI/HTTP/旧共用）存在任意一个即全部删除。
  register("markdownBilingualSync.clearApiKey", () =>
    handleErrors(async () => {
      const secretKeys = [
        OPENAI_API_KEY_SECRET,
        HTTP_API_KEY_SECRET,
        LEGACY_API_KEY_SECRET,
      ];
      const existing = await Promise.all(
        secretKeys.map((key) => context.secrets.get(key)),
      );
      if (!existing.some((value) => Boolean(value))) {
        void vscode.window.showInformationMessage(
          UI_TEXT.extension.noApiKey,
        );
        return;
      }
      const choice = await vscode.window.showWarningMessage(
        UI_TEXT.extension.confirmClearApiKey,
        { modal: true },
        UI_TEXT.extension.clearApiKeyAction,
      );
      if (choice !== UI_TEXT.extension.clearApiKeyAction) {
        return;
      }
      await Promise.all(
        secretKeys.map((key) => context.secrets.delete(key)),
      );
      void vscode.window.showInformationMessage(
        UI_TEXT.extension.apiKeyCleared,
      );
    }),
  );

  // ---- 文档与配置监听 ----

  // 所有监听都注册一次并随 context.subscriptions 释放，避免重载后重复触发。
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument((document) => {
      // 缓存文件没有与预览一一对应的映射，保存缓存时刷新全部已打开预览。
      if (cacheStore.isCacheUri(document.uri)) {
        previewManager.refreshAll();
        return;
      }
      // 原文保存：只刷新对应文件的预览（预览更新会重新读取磁盘内容）。
      if (isSupportedLanguageId(document.languageId)) {
        previewManager.refresh(document.uri);
      }
    }),
    vscode.workspace.onDidCloseTextDocument((document) => {
      // 关闭 Markdown/Skill 文档时同时关闭其预览面板，避免留下无源文件的窗口。
      if (isSupportedLanguageId(document.languageId)) {
        previewManager.close(document.uri);
      }
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      // 语言、Provider、布局等设置都会影响预览展示，统一全量刷新。
      if (event.affectsConfiguration("markdownBilingualSync")) {
        previewManager.refreshAll();
      }
    }),
  );
}
