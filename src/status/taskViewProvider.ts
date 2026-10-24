/**
 * 翻译任务视图模块（status/taskViewProvider）。
 *
 * 职责：解析 WebviewView、路由页面消息、把任务与并发快照推送到前端。
 *
 * 生命周期：每个视图实例对应一次 resolveWebviewView；clearView 释放当前视图的监听与
 * 去抖定时器；dispose 额外释放任务/并发/配置订阅。
 *
 * 关键不变量：
 * - 状态只由 monitor.snapshot() 派生，provider 不维护任务数据；
 * - webview 只收到展示字段与 hasUri，不包含本机绝对路径或密钥；
 * - 消息按 type 白名单路由，未知消息直接忽略。
 */
import { randomBytes } from "node:crypto";
import * as vscode from "vscode";
import { buildTaskViewHtml } from "./taskViewHtml";
import type {
  TranslationTaskMonitor,
  TranslationTaskView,
} from "./taskMonitor";
import type { ConcurrencyLimiter } from "../translation/concurrency";

// ---- 类型 ----

/** 任务视图“运行状态”区展示的系统信息（不含任何密钥）。 */
export interface TaskViewSystemInfo {
  /** 当前翻译服务展示名。 */
  provider: string;
  /** 模型名或模板说明。 */
  model: string;
  /** 单批 token 预算（仅 OpenAI 兼容服务使用）。 */
  tokenBudget: number;
  /** 单批块数上限（仅 OpenAI 兼容服务使用）。 */
  batchSize: number;
}

/** 构造 TaskViewProvider 所需依赖；全部由 activate 注入。 */
export interface TaskViewProviderOptions {
  extensionUri: vscode.Uri;
  monitor: TranslationTaskMonitor;
  /** 请求并发限制器，用于展示 active/waiting/limit。 */
  limiter: ConcurrencyLimiter;
  /** 输出通道，“打开输出日志”按钮使用。 */
  output: vscode.OutputChannel;
  /** 打开指定源文件的双语预览。 */
  openPreview: (uri: vscode.Uri) => void;
  /** 惰性读取系统信息，保证配置修改后立即生效。 */
  getSystemInfo: () => TaskViewSystemInfo;
}

/** 发送给 webview 的任务数据：去掉 URI，只保留是否有源文件。 */
interface TaskViewStateTask extends Omit<TranslationTaskView, "uri"> {
  hasUri: boolean;
}

/**
 * 把任务视图转换成可序列化的 webview 数据。
 * 不发送 uri，避免把本机绝对路径暴露给页面。
 */
function toStateTask(task: TranslationTaskView): TaskViewStateTask {
  const { uri, ...rest } = task;
  return { ...rest, hasUri: Boolean(uri) };
}

/**
 * 翻译任务视图 Provider（右侧/侧边栏 WebviewView）。
 *
 * 职责：
 * - 解析 webview（写入 HTML、设置资源根目录、注册消息与可见性监听）；
 * - 订阅任务监控器、并发限制器与扩展配置，100ms 去抖后推送完整快照；
 * - 处理页面按钮：取消全部/单个任务、清空历史、打开输出、打开源文件/预览。
 *
 * 生命周期：
 * - 随 activate 注册到 `markdownBilingualSync.tasksView`，并加入 context.subscriptions；
 * - resolveWebviewView 可被多次调用（视图被移动/重新打开时），每次都先 clearView；
 * - dispose 时清理去抖定时器、webview 监听与外部订阅。
 *
 * 关键不变量：
 * - state 只由 monitor.snapshot() 派生，provider 不自行维护任务状态；
 * - webview 消息里的 id 必须为整数，路由按 type 精确匹配，未知消息忽略；
 * - 不向 webview 传递 URI 或密钥，仅传 hasUri 与相对路径标签。
 */
export class TaskViewProvider
  implements vscode.WebviewViewProvider, vscode.Disposable
{
  /** 当前已解析的视图；不存在时 scheduleUpdate 直接跳过。 */
  private view?: vscode.WebviewView;
  /** 外部订阅（monitor/limiter/config）的退订函数。 */
  private readonly unsubscribers: Array<() => void> = [];
  /** 当前视图生命周期内的 webview 监听。 */
  private viewDisposables: vscode.Disposable[] = [];
  /** 状态推送去抖定时器；避免高频进度更新刷爆 postMessage。 */
  private updateTimer?: ReturnType<typeof setTimeout>;

  /** 订阅任务、并发与配置变化；实际推送由 scheduleUpdate 去抖。 */
  constructor(private readonly options: TaskViewProviderOptions) {
    // monitor 负责任务状态，limiter 负责并发计数，两者变化都只调度一次刷新。
    this.unsubscribers.push(
      options.monitor.onDidChange(() => this.scheduleUpdate()),
      options.limiter.onDidChange(() => this.scheduleUpdate()),
    );
    // 配置变化会影响“运行状态”区的模型/预算展示，同样触发刷新。
    const configListener = vscode.workspace.onDidChangeConfiguration(
      (event) => {
        if (event.affectsConfiguration("markdownBilingualSync")) {
          this.scheduleUpdate();
        }
      },
    );
    this.unsubscribers.push(() => configListener.dispose());
  }

  // ---- 视图生命周期 ----

  /**
   * VS Code 解析视图时调用：重建页面并推送首帧状态。
   *
   * @sideeffect 替换 webview HTML、注册消息/可见性/dispose 监听
   * @failure media 资源缺失表现为 webview 加载失败，不在此抛错；URI 构造异常会向上传播
   */
  resolveWebviewView(view: vscode.WebviewView): void {
    // 同一 provider 可能先后解析多个视图实例，先释放旧实例的监听与定时器。
    this.clearView();
    this.view = view;
    const mediaRoot = vscode.Uri.joinPath(
      this.options.extensionUri,
      "media",
    );
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [mediaRoot],
    };
    view.webview.html = buildTaskViewHtml({
      webview: view.webview,
      extensionUri: this.options.extensionUri,
      nonce: randomBytes(18).toString("base64"),
    });
    this.viewDisposables.push(
      // 页面脚本通过 postMessage 上报 ready / 按钮动作；这里异步处理，不阻塞消息通道。
      view.webview.onDidReceiveMessage((message: unknown) => {
        void this.onMessage(message);
      }),
      // 视图从隐藏变为可见时补发一次状态，避免隐藏期间丢失的进度。
      view.onDidChangeVisibility(() => {
        if (view.visible) {
          this.sendState();
        }
      }),
      // 视图销毁时只清理“当前”实例，防止旧实例的延迟事件误清新视图。
      view.onDidDispose(() => {
        if (this.view === view) {
          this.clearView();
        }
      }),
    );
    this.updateViewMeta();
    this.sendState();
  }

  /**
   * 状态栏命令入口：可见则收起，已解析但隐藏则显示，未解析则打开容器。
   *
   * 注意：收起逻辑依赖 VS Code 内置命令（辅助侧边栏/侧边栏），并延迟 80ms 兜底；
   * 该延迟定时器未纳入 dispose 管理。
   */
  async toggle(): Promise<void> {
    const view = this.view;
    if (view?.visible) {
      await vscode.commands.executeCommand(
        "workbench.action.closeAuxiliaryBar",
      );
      setTimeout(() => {
        if (this.view?.visible) {
          void vscode.commands.executeCommand(
            "workbench.action.closeSidebar",
          );
        }
      }, 80);
      return;
    }
    if (view) {
      view.show(false);
      return;
    }
    await vscode.commands.executeCommand(
      "workbench.view.extension.markdownBilingualSync.tasks",
    );
  }

  /** 释放定时器、当前视图监听与外部订阅；可安全重复调用。 */
  dispose(): void {
    this.clearView();
    for (const unsubscribe of this.unsubscribers.splice(0)) {
      unsubscribe();
    }
  }

  /** 清空去抖定时器、释放当前视图监听并重置 view 引用。 */
  private clearView(): void {
    if (this.updateTimer) {
      clearTimeout(this.updateTimer);
      this.updateTimer = undefined;
    }
    for (const disposable of this.viewDisposables.splice(0)) {
      disposable.dispose();
    }
    this.view = undefined;
  }

  // ---- 状态推送 ----

  /**
   * 100ms 去抖调度一次状态推送。
   * 视图不存在或已有待执行定时器时直接返回（合并高频事件）。
   */
  private scheduleUpdate(): void {
    if (!this.view || this.updateTimer) {
      return;
    }
    this.updateTimer = setTimeout(() => {
      this.updateTimer = undefined;
      this.sendState();
    }, 100);
  }

  /**
   * 推送完整状态快照（任务、并发、系统信息）。
   * @sideeffect postMessage；视图已销毁时静默返回
   */
  private sendState(): void {
    const view = this.view;
    if (!view) {
      return;
    }
    const snapshot = this.options.monitor.snapshot();
    view.webview.postMessage({
      type: "state",
      state: {
        generatedAt: Date.now(),
        active: snapshot.active.map(toStateTask),
        finished: snapshot.finished.map(toStateTask),
        activeRequests: this.options.limiter.activeCount,
        waiting: this.options.limiter.waitingCount,
        limit: this.options.limiter.limit,
        system: this.options.getSystemInfo(),
      },
    });
    this.updateViewMeta();
  }

  /** 同步视图标题描述与活动任务徽标；没有活动任务时清除。 */
  private updateViewMeta(): void {
    const view = this.view;
    if (!view) {
      return;
    }
    const snapshot = this.options.monitor.snapshot();
    view.description =
      snapshot.activeCount > 0 ? `${snapshot.activeCount} 个任务` : undefined;
    view.badge =
      snapshot.activeCount > 0
        ? {
            value: snapshot.activeCount,
            tooltip: "活动的翻译任务",
          }
        : undefined;
  }

  // ---- Webview 消息 ----

  /**
   * 路由 webview 消息。
   *
   * 支持：ready、cancelAll、clearFinished、openOutput、cancelTask、
   * openSource、openPreview；其余消息忽略。
   * 注意：本方法未捕获异常，失败会以未处理的 Promise 拒绝结束，
   * 页面不会收到错误提示。
   */
  private async onMessage(raw: unknown): Promise<void> {
    if (!raw || typeof raw !== "object") {
      return;
    }
    const message = raw as Record<string, unknown>;
    const type = typeof message.type === "string" ? message.type : "";
    // 只接受整数 id，避免页面传入任意对象/字符串触发非预期任务操作。
    const id =
      typeof message.id === "number" && Number.isInteger(message.id)
        ? message.id
        : undefined;
    switch (type) {
      case "ready":
        // 页面脚本就绪后主动拉取首帧，弥补 HTML 渲染与消息监听的时序差。
        this.sendState();
        return;
      case "cancelAll":
        this.options.monitor.cancelAll();
        this.sendState();
        return;
      case "clearFinished":
        this.options.monitor.clearFinished();
        this.sendState();
        return;
      case "openOutput":
        this.options.output.show(true);
        return;
      case "cancelTask":
        if (id !== undefined) {
          this.options.monitor.cancel(id);
          this.sendState();
        }
        return;
      case "openSource": {
        const task = id === undefined ? undefined : this.options.monitor.getTask(id);
        if (task?.uri) {
          // 源文件可能已被删除/重命名，openTextDocument 会抛错（未在此捕获）。
          const document = await vscode.workspace.openTextDocument(task.uri);
          await vscode.window.showTextDocument(document, { preview: false });
        }
        return;
      }
      case "openPreview": {
        const task = id === undefined ? undefined : this.options.monitor.getTask(id);
        if (task?.uri) {
          this.options.openPreview(task.uri);
        }
        return;
      }
      default:
        return;
    }
  }
}
