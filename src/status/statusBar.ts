/**
 * 状态栏模块（status/statusBar）。
 *
 * 职责：把任务快照与并发计数渲染为右侧 StatusBarItem 的文本、tooltip 与失败高亮，
 * 点击后执行打开任务面板的命令。
 *
 * 生命周期：构造函数内创建并显示状态栏项，同时把自身登记到 context.subscriptions；
 * dispose 清理去抖定时器、监听与状态栏项。
 *
 * 关键不变量：
 * - 监听回调只调度 100ms 去抖刷新，不在回调中直接渲染；
 * - tooltip 中的动态文本一律使用 appendText 追加，避免 Markdown 注入；
 * - 并发上限来自 ConcurrencyLimiter，不在此重复解析配置。
 */
import * as vscode from "vscode";
import { formatText, UI_TEXT } from "../i18n";
import type { ConcurrencyLimiter } from "../translation/concurrency";
import type {
  TranslationTaskView,
  TranslationTaskMonitor,
} from "./taskMonitor";

const T = UI_TEXT.statusBar;
const PANEL = UI_TEXT.taskPanel;

/**
 * 单个任务的状态栏提示行：`文件：状态 · 进度[ · N 块失败]`。
 * 有总数时显示块进度，否则回退到当前阶段文案。
 */
function taskLine(task: TranslationTaskView): string {
  const status = PANEL.statusLabels[task.status];
  const progress =
    task.total > 0
      ? formatText(PANEL.progress, {
          completed: task.completed,
          total: task.total,
        })
      : task.phase;
  const failed =
    task.failed > 0
      ? formatText(PANEL.failedSuffix, { failed: task.failed })
      : "";
  return formatText(T.taskLine, {
    label: task.label,
    status,
    progress,
    failed,
  });
}

/**
 * 右侧状态栏任务指示器。
 *
 * 职责：
 * - 汇总展示活动任务数、当前请求并发与失败提示；
 * - tooltip 列出最多 8 个活动任务及并发占用，点击执行 openTaskPanel 命令；
 * - 监听任务监控器、并发限制器与扩展配置，100ms 去抖刷新。
 *
 * 生命周期：
 * - 构造函数内创建 StatusBarItem 并把自身注册进 context.subscriptions，
 *   因此调用方不需要保存引用；dispose 时移除定时器、监听并销毁 item。
 *
 * 关键不变量：
 * - 任务与并发文案全部来自 UI_TEXT，不在本文件拼接中文；
 * - tooltip 中的任务标签/阶段一律用 appendText 追加，避免 Markdown 注入；
 * - 失败数统计 failed 与 partial（partial 表示有块失败），只统计任务监控器仍保留的历史（最多 40 条），不是全局累计。
 */
export class TranslationStatusBar implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  /** 监听退订函数集合（monitor/limiter/config）。 */
  private readonly disposables: Array<() => void> = [];
  /** 刷新去抖定时器。 */
  private updateTimer?: ReturnType<typeof setTimeout>;

  /** 创建状态栏项并订阅任务/并发/配置变化；实例自行登记到 context.subscriptions。 */
  constructor(
    context: vscode.ExtensionContext,
    private readonly monitor: TranslationTaskMonitor,
    private readonly limiter: ConcurrencyLimiter,
    command: string,
  ) {
    // 右侧高优先级（100），始终可见；点击后由 command 打开任务面板。
    this.item = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      100,
    );
    this.item.name = "Markdown Bilingual Sync";
    this.item.command = command;
    this.item.show();
    // 自行登记到扩展订阅，dispose 由 VS Code 在停用时统一调用。
    context.subscriptions.push(this);

    // 任务与并发变化只调度刷新，真正渲染合并到一次 update。
    this.disposables.push(
      monitor.onDidChange(() => this.scheduleUpdate()),
      limiter.onDidChange(() => this.scheduleUpdate()),
    );
    // 配置变化会影响并发上限等展示（无需重新读取 provider）。
    const configListener = vscode.workspace.onDidChangeConfiguration(
      (event) => {
        if (event.affectsConfiguration("markdownBilingualSync")) {
          this.scheduleUpdate();
        }
      },
    );
    this.disposables.push(() => configListener.dispose());
    this.update();
  }

  /** 100ms 去抖；已有待执行定时器时不重复调度。 */
  private scheduleUpdate(): void {
    if (this.updateTimer) {
      return;
    }
    this.updateTimer = setTimeout(() => {
      this.updateTimer = undefined;
      this.update();
    }, 100);
  }

  /**
   * 重新渲染状态栏文本与 tooltip。
   *
   * 优先级：有活动任务 → 有失败记录 → 空闲。
   * @sideeffect 修改 StatusBarItem 的 text/tooltip/backgroundColor
   */
  update(): void {
    const snapshot = this.monitor.snapshot();
    const activeRequests = this.limiter.activeCount;
    const waiting = this.limiter.waitingCount;
    const limit = this.limiter.limit;
    // 只有真正运行中的任务才显示旋转图标；全部排队时用时钟图标。
    const running = snapshot.active.some(
      (task) => task.status === "running",
    );
    // 失败数来自保留的历史记录（见类注释），partial 同样计为失败；清除历史后归零。
    const failedCount = snapshot.finished.filter(
      (task) => task.status === "failed" || task.status === "partial",
    ).length;

    if (snapshot.activeCount > 0) {
      this.item.text = `${running ? "$(sync~spin)" : "$(clock)"} ${formatText(
        T.active,
        {
          tasks: snapshot.activeCount,
          active: activeRequests,
          limit,
        },
      )}`;
      this.item.backgroundColor = undefined;
    } else if (failedCount > 0) {
      this.item.text = `$(warning) ${formatText(T.failed, {
        failed: failedCount,
      })}`;
      this.item.backgroundColor = new vscode.ThemeColor(
        "statusBarItem.warningBackground",
      );
    } else {
      this.item.text = `$(list-unordered) ${T.idle}`;
      this.item.backgroundColor = undefined;
    }

    const tooltip = new vscode.MarkdownString();
    tooltip.appendMarkdown(`**${T.tooltipTitle}**\n\n`);
    if (snapshot.active.length === 0) {
      tooltip.appendText(PANEL.emptyHint);
    } else {
      // 最多列出 8 条，超出部分只显示数量，避免 tooltip 过长。
      for (const task of snapshot.active.slice(0, 8)) {
        tooltip.appendMarkdown("- ");
        tooltip.appendText(taskLine(task));
        tooltip.appendMarkdown("\n");
      }
      if (snapshot.active.length > 8) {
        tooltip.appendText(
          formatText(T.moreTasks, {
            count: snapshot.active.length - 8,
          }),
        );
        tooltip.appendMarkdown("\n");
      }
    }
    tooltip.appendMarkdown("\n");
    tooltip.appendText(
      formatText(PANEL.concurrency, {
        active: activeRequests,
        limit,
        waiting,
      }),
    );
    tooltip.appendMarkdown("\n\n");
    tooltip.appendText(T.tooltipHint);
    this.item.tooltip = tooltip;
  }

  /** 清理去抖定时器、所有监听并销毁状态栏项；可安全重复调用。 */
  dispose(): void {
    if (this.updateTimer) {
      clearTimeout(this.updateTimer);
      this.updateTimer = undefined;
    }
    for (const dispose of this.disposables) {
      dispose();
    }
    this.item.dispose();
  }
}
