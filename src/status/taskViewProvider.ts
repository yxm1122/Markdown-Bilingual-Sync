/**
 * 翻译任务视图（原生 TreeView）。
 *
 * 职责：把 TranslationTaskMonitor 的快照映射成 TreeItem 树，并把视图标题/行内操作
 * 接到取消、清理、打开源文件/预览、语言切换等命令。
 *
 * 生命周期：随 activate 创建，订阅 monitor/limiter/config，100ms 去抖刷新；
 * TreeView 由扩展入口 createTreeView 后通过 setTreeView 注入。
 *
 * 关键不变量：
 * - 树节点只由 monitor.snapshot()、limiter 与配置派生，provider 不保存任务数据；
 * - 任务节点的 command 和 inline 命令都通过 node / TreeItem.id 解析任务，不依赖绝对路径；
 * - 语言更新串行化，失败只提示并刷新真实配置，不留下半交换状态。
 */
import * as vscode from "vscode";
import { formatText, UI_TEXT } from "../i18n";
import type {
  TaskOperation,
  TranslationTaskMonitor,
  TranslationTaskView,
  TranslationTaskStatus,
} from "./taskMonitor";
import type { ConcurrencyLimiter } from "../translation/concurrency";
import {
  buildTaskViewLanguages,
  selectLanguage,
  swapTaskViewLanguages,
  type TaskViewLanguages,
} from "./taskViewState";

type SectionId = "overview" | "active" | "history" | "system";

interface SectionNode {
  kind: "section";
  id: SectionId;
  label: string;
  icon: string;
  description?: string;
}

interface StatNode {
  kind: "stat";
  id: string;
  label: string;
  description?: string;
  icon: string;
  color?: vscode.ThemeColor;
}

interface DetailNode {
  kind: "detail";
  id: string;
  label: string;
  description?: string;
  icon: string;
  color?: vscode.ThemeColor;
}

interface TaskNode {
  kind: "task";
  id: string;
  task: TranslationTaskView;
  section: "active" | "finished";
  children: DetailNode[];
  /** 分组内的紧凑标签；为空时使用文件路径。 */
  compactLabel?: string;
}

interface TaskGroupNode {
  kind: "group";
  id: string;
  label: string;
  section: "active" | "finished";
  tasks: TranslationTaskView[];
  children: TaskNode[];
  /** 后面是否出现了大任务；用于默认折叠。 */
  hasLargeAfter: boolean;
}

export type TaskTreeNode =
  | SectionNode
  | StatNode
  | DetailNode
  | TaskNode
  | TaskGroupNode;

/** 视图配置：不包含 extensionUri，TreeView 不需要自行加载 Webview 资源。 */
export interface TaskViewProviderOptions {
  monitor: TranslationTaskMonitor;
  limiter: ConcurrencyLimiter;
  output: vscode.OutputChannel;
  /** 按任务元数据打开预览：块级任务定位到块，批量任务定位第一个块。 */
  openTask: (task: TranslationTaskView) => void;
  getSystemInfo: () => {
    provider: string;
    model: string;
    tokenBudget: number;
    batchSize: number;
  };
}

function statusIcon(status: TranslationTaskStatus): {
  icon: string;
  color: vscode.ThemeColor;
} {
  switch (status) {
    case "queued":
      return {
        icon: "clock",
        color: new vscode.ThemeColor("descriptionForeground"),
      };
    case "running":
      return {
        icon: "sync~spin",
        color: new vscode.ThemeColor("charts.blue"),
      };
    case "partial":
      return {
        icon: "warning",
        color: new vscode.ThemeColor("editorWarning.foreground"),
      };
    case "success":
      return {
        icon: "pass-filled",
        color: new vscode.ThemeColor("testing.iconPassed"),
      };
    case "failed":
      return {
        icon: "error",
        color: new vscode.ThemeColor("errorForeground"),
      };
    case "cancelled":
      return {
        icon: "circle-slash",
        color: new vscode.ThemeColor("disabledForeground"),
      };
  }
}

/** 任务图标按操作/作用域区分；状态颜色沿用任务状态。 */
function taskIcon(task: TranslationTaskView): {
  icon: string;
  color: vscode.ThemeColor;
} {
  const color = statusIcon(task.status).color;
  if (task.scope === "blocks") {
    return { icon: "layers", color };
  }
  if (task.scope === "fileBatch") {
    return { icon: "files", color };
  }
  switch (task.operation) {
    case "summary":
      return { icon: "book", color };
    case "review":
      return {
        icon: task.scope === "block" ? "comment" : "comment-discussion",
        color,
      };
    case "backtranslate":
      return { icon: "arrow-swap", color };
    case "markSynced":
      return { icon: "check", color };
    case "deleteTranslation":
      return { icon: "trash", color };
    case "retranslate":
      return {
        icon: task.scope === "block" ? "symbol-field" : "refresh",
        color,
      };
    case "sync":
      return { icon: "sync", color };
    default:
      return statusIcon(task.status);
  }
}

function groupColor(tasks: readonly TranslationTaskView[]): vscode.ThemeColor {
  if (tasks.some((task) => task.status === "failed" || task.status === "partial")) {
    return new vscode.ThemeColor("errorForeground");
  }
  if (tasks.some((task) => task.status === "running")) {
    return new vscode.ThemeColor("charts.blue");
  }
  if (tasks.some((task) => task.status === "queued")) {
    return new vscode.ThemeColor("descriptionForeground");
  }
  if (tasks.every((task) => task.status === "success")) {
    return new vscode.ThemeColor("testing.iconPassed");
  }
  return new vscode.ThemeColor("disabledForeground");
}

function statusLabel(status: TranslationTaskStatus): string {
  return UI_TEXT.taskPanel.statusLabels[status];
}

export function operationLabel(operation: TaskOperation | undefined): string {
  switch (operation) {
    case "sync":
      return UI_TEXT.taskPanel.operations.sync;
    case "retranslate":
      return UI_TEXT.taskPanel.operations.retranslate;
    case "review":
      return UI_TEXT.taskPanel.operations.review;
    case "backtranslate":
      return UI_TEXT.taskPanel.operations.backtranslate;
    case "summary":
      return UI_TEXT.taskPanel.operations.summary;
    case "markSynced":
      return UI_TEXT.taskPanel.operations.markSynced;
    case "deleteTranslation":
      return UI_TEXT.taskPanel.operations.deleteTranslation;
    default:
      return "";
  }
}

function durationText(startedAt?: number, finishedAt?: number): string {
  if (!startedAt) {
    return "";
  }
  const end = finishedAt ?? Date.now();
  const seconds = Math.max(0, (end - startedAt) / 1000);
  if (seconds < 60) {
    return `${seconds.toFixed(1)}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  return `${minutes}m ${rest}s`;
}

function taskProgress(task: TranslationTaskView): string {
  if (task.total > 0) {
    return formatText(UI_TEXT.taskPanel.progress, {
      completed: Math.min(task.completed, task.total),
      total: task.total,
    });
  }
  // 只有确实结束且没有任何块的终态才显示“无块”；queued/running/failed 的阶段
  // 由状态标签与 phase 表达，不能误报成 noBlocks。
  if (
    task.status === "success" ||
    task.status === "partial" ||
    task.status === "cancelled"
  ) {
    return UI_TEXT.taskPanel.noBlocks;
  }
  return "";
}

function taskDescription(
  task: TranslationTaskView,
  includeOperation = true,
): string {
  const parts: string[] = [];
  const operation = includeOperation ? operationLabel(task.operation) : "";
  if (operation) {
    parts.push(operation);
  }
  const progress = taskProgress(task);
  if (progress) {
    parts.push(progress);
  } else if (task.status === "running" && task.phase.trim()) {
    parts.push(task.phase);
  }
  parts.push(statusLabel(task.status));
  if (task.startedAt) {
    parts.push(
      formatText(UI_TEXT.taskPanel.elapsed, {
        duration: durationText(task.startedAt, task.finishedAt),
      }),
    );
  }
  if (task.failed > 0) {
    parts.push(
      formatText(UI_TEXT.taskPanel.failedSuffix, {
        failed: task.failed,
      }).replace(/^\s*·\s*/, ""),
    );
  }
  if ((task.retries ?? 0) > 0) {
    parts.push(
      formatText(UI_TEXT.taskPanel.retryCount, {
        count: task.retries ?? 0,
      }),
    );
  }
  return parts.join(" · ");
}

function taskTooltip(task: TranslationTaskView): vscode.MarkdownString {
  const tooltip = new vscode.MarkdownString();
  tooltip.appendText(task.label);
  tooltip.appendMarkdown("\n\n");
  const operation = operationLabel(task.operation);
  if (operation) {
    tooltip.appendText(operation);
    tooltip.appendMarkdown("  \n");
  }
  tooltip.appendText(statusLabel(task.status));
  tooltip.appendMarkdown("  \n");
  tooltip.appendText(taskProgress(task));
  if (task.phase.trim()) {
    tooltip.appendMarkdown("  \n");
    tooltip.appendText(task.phase);
  }
  if (task.error) {
    tooltip.appendMarkdown("  \n");
    tooltip.appendText(task.error);
  }
  if ((task.retries ?? 0) > 0) {
    tooltip.appendMarkdown("  \n");
    tooltip.appendText(
      formatText(UI_TEXT.taskPanel.retryCount, {
        count: task.retries ?? 0,
      }),
    );
  }
  if (task.startedAt) {
    tooltip.appendMarkdown("  \n");
    tooltip.appendText(
      formatText(UI_TEXT.taskPanel.elapsed, {
        duration: durationText(task.startedAt, task.finishedAt),
      }),
    );
  }
  return tooltip;
}

export class TaskViewProvider
  implements vscode.TreeDataProvider<TaskTreeNode>, vscode.Disposable
{
  private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<
    TaskTreeNode | undefined | void
  >();
  readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;
  private treeView?: vscode.TreeView<TaskTreeNode>;
  private updateTimer?: ReturnType<typeof setTimeout>;
  private readonly unsubscribers: Array<() => void> = [];
  private readonly commandDisposables: vscode.Disposable[] = [];
  private readonly expandedGroups = new Set<string>();
  private readonly collapsedGroups = new Set<string>();
  private languageUpdateQueue: Promise<void> = Promise.resolve();
  private readonly sections: SectionNode[] = [
    {
      kind: "section",
      id: "overview",
      label: UI_TEXT.taskPanel.overviewTitle,
      icon: "graph",
    },
    {
      kind: "section",
      id: "active",
      label: UI_TEXT.taskPanel.activeSection,
      icon: "sync",
    },
    {
      kind: "section",
      id: "history",
      label: UI_TEXT.taskPanel.historySection,
      icon: "history",
    },
    {
      kind: "section",
      id: "system",
      label: UI_TEXT.taskPanel.systemTitle,
      icon: "server-environment",
    },
  ];

  constructor(private readonly options: TaskViewProviderOptions) {
    this.unsubscribers.push(
      options.monitor.onDidChange(() => this.scheduleUpdate()),
      options.limiter.onDidChange(() => this.scheduleUpdate()),
    );
    const configListener = vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("markdownBilingualSync")) {
        this.scheduleUpdate();
      }
    });
    this.unsubscribers.push(() => configListener.dispose());
  }

  // ---- TreeDataProvider ----

  getTreeItem(node: TaskTreeNode): vscode.TreeItem {
    switch (node.kind) {
      case "section": {
        const item = new vscode.TreeItem(
          node.label,
          node.id === "system"
            ? vscode.TreeItemCollapsibleState.Collapsed
            : vscode.TreeItemCollapsibleState.Expanded,
        );
        item.id = `section:${node.id}`;
        item.description = node.description;
        item.iconPath = new vscode.ThemeIcon(node.icon);
        item.contextValue = "section";
        return item;
      }
      case "stat": {
        const item = new vscode.TreeItem(
          node.label,
          vscode.TreeItemCollapsibleState.None,
        );
        item.id = node.id;
        item.description = node.description;
        item.iconPath = new vscode.ThemeIcon(
          node.icon,
          node.color,
        );
        item.contextValue = "stat";
        return item;
      }
      case "detail": {
        const item = new vscode.TreeItem(
          node.label,
          vscode.TreeItemCollapsibleState.None,
        );
        item.id = node.id;
        item.description = node.description;
        item.iconPath = new vscode.ThemeIcon(node.icon, node.color);
        item.contextValue = "detail";
        return item;
      }
      case "task": {
        const icon = taskIcon(node.task);
        const item = new vscode.TreeItem(
          node.compactLabel ?? node.task.label,
          node.children.length > 0
            ? vscode.TreeItemCollapsibleState.Collapsed
            : vscode.TreeItemCollapsibleState.None,
        );
        item.id = node.id;
        item.description = taskDescription(
          node.task,
          !node.compactLabel,
        );
        item.tooltip = taskTooltip(node.task);
        item.iconPath = new vscode.ThemeIcon(icon.icon, icon.color);
        item.contextValue = node.section === "active" ? "taskActive" : "taskFinished";
        if (node.task.uri) {
          item.command = {
            command: "markdownBilingualSync.task.openPreview",
            title: UI_TEXT.taskPanel.openPreview,
            arguments: [node],
          };
        }
        return item;
      }
      case "group": {
        const auto = node.hasLargeAfter
          ? vscode.TreeItemCollapsibleState.Collapsed
          : vscode.TreeItemCollapsibleState.Expanded;
        const state = this.expandedGroups.has(node.id)
          ? vscode.TreeItemCollapsibleState.Expanded
          : this.collapsedGroups.has(node.id)
            ? vscode.TreeItemCollapsibleState.Collapsed
            : auto;
        const item = new vscode.TreeItem(node.label, state);
        item.id = node.id;
        const running = node.tasks.filter(
          (task) => task.status === "running",
        ).length;
        const queued = node.tasks.filter(
          (task) => task.status === "queued",
        ).length;
        item.description = [
          formatText(UI_TEXT.taskPanel.smallTaskGroup, {
            count: node.tasks.length,
          }),
          ...(running > 0
            ? [`${running} ${UI_TEXT.taskPanel.statusLabels.running}`]
            : []),
          ...(queued > 0
            ? [`${queued} ${UI_TEXT.taskPanel.statusLabels.queued}`]
            : []),
        ].join(" · ");
        const tooltip = new vscode.MarkdownString();
        tooltip.appendText(node.label);
        tooltip.appendMarkdown("\n\n");
        tooltip.appendText(
          formatText(UI_TEXT.taskPanel.smallTaskGroup, {
            count: node.tasks.length,
          }),
        );
        tooltip.appendMarkdown("  \n");
        tooltip.appendText(UI_TEXT.taskPanel.smallTaskGroupHint);
        for (const child of node.children.slice(0, 8)) {
          tooltip.appendMarkdown("\n- ");
          tooltip.appendText(child.compactLabel ?? child.task.label);
          tooltip.appendText(" · ");
          tooltip.appendText(
            taskDescription(child.task, !child.compactLabel),
          );
        }
        if (node.children.length > 8) {
          tooltip.appendMarkdown("\n");
          tooltip.appendText(
            formatText(UI_TEXT.statusBar.moreTasks, {
              count: node.children.length - 8,
            }),
          );
        }
        item.tooltip = tooltip;
        item.iconPath = new vscode.ThemeIcon(
          "list-selection",
          groupColor(node.tasks),
        );
        item.contextValue = "taskGroup";
        return item;
      }
    }
  }

  getChildren(node?: TaskTreeNode): TaskTreeNode[] {
    if (!node) {
      const snapshot = this.options.monitor.snapshot();
      const activeCount = snapshot.activeCount;
      this.setSectionDescription(
        "overview",
        formatText(UI_TEXT.taskPanel.activeTaskCount, { count: activeCount }),
      );
      this.setSectionDescription(
        "active",
        formatText(UI_TEXT.taskPanel.activeTaskCount, { count: activeCount }),
      );
      this.setSectionDescription(
        "history",
        formatText(UI_TEXT.taskPanel.activeTaskCount, {
          count: snapshot.finished.length,
        }),
      );
      const info = this.options.getSystemInfo();
      this.setSectionDescription(
        "system",
        `${info.provider} · ${info.model}`,
      );
      return this.sections;
    }
    switch (node.kind) {
      case "section":
        return this.sectionChildren(node.id);
      case "task":
      case "group":
        return node.children;
      default:
        return [];
    }
  }

  private setSectionDescription(id: SectionId, description: string): void {
    const section = this.sections.find((item) => item.id === id);
    if (section) {
      section.description = description;
    }
  }

  private sectionChildren(id: SectionId): TaskTreeNode[] {
    const snapshot = this.options.monitor.snapshot();
    switch (id) {
      case "overview": {
        const totalCompleted = snapshot.active.reduce(
          (sum, task) => sum + task.completed,
          0,
        );
        const totalBlocks = snapshot.active.reduce(
          (sum, task) => sum + task.total,
          0,
        );
        const failed = snapshot.active.reduce(
          (sum, task) => sum + task.failed,
          0,
        );
        return [
          {
            kind: "stat",
            id: "overview:files",
            label: UI_TEXT.taskPanel.activeTasksLabel,
            description: String(snapshot.activeCount),
            icon: "files",
          },
          {
            kind: "stat",
            id: "overview:queued",
            label: UI_TEXT.taskPanel.queuedTasksLabel,
            description: String(
              snapshot.active.filter((task) => task.status === "queued")
                .length,
            ),
            icon: "clock",
          },
          {
            kind: "stat",
            id: "overview:concurrency",
            label: UI_TEXT.taskPanel.concurrencyLabel,
            description: formatText(UI_TEXT.taskPanel.concurrency, {
              active: this.options.limiter.activeCount,
              limit: this.options.limiter.limit,
              waiting: this.options.limiter.waitingCount,
            }),
            icon: "dashboard",
          },
          {
            kind: "stat",
            id: "overview:blocks",
            label: UI_TEXT.taskPanel.activeBlocksLabel,
            description: totalBlocks > 0 ? `${totalCompleted}/${totalBlocks}` : "—",
            icon: "layers",
          },
          {
            kind: "stat",
            id: "overview:failed",
            label: UI_TEXT.taskPanel.failedBlocksLabel,
            description: String(failed),
            icon: "error",
            color: new vscode.ThemeColor("errorForeground"),
          },
        ];
      }
      case "active":
        if (snapshot.active.length === 0) {
          return [
            {
              kind: "detail",
              id: "active:empty",
              label: UI_TEXT.taskPanel.noActive,
              description: UI_TEXT.taskPanel.emptyHint,
              icon: "info",
              color: new vscode.ThemeColor("descriptionForeground"),
            },
          ];
        }
        return this.groupTaskNodes(snapshot.active, "active");
      case "history":
        if (snapshot.finished.length === 0) {
          return [
            {
              kind: "detail",
              id: "history:empty",
              label: UI_TEXT.taskPanel.empty,
              description: UI_TEXT.taskPanel.emptyHint,
              icon: "info",
              color: new vscode.ThemeColor("descriptionForeground"),
            },
          ];
        }
        return this.groupTaskNodes(snapshot.finished, "finished");
      case "system": {
        const info = this.options.getSystemInfo();
        return [
          {
            kind: "stat",
            id: "system:provider",
            label: UI_TEXT.taskPanel.providerLabel,
            description: info.provider,
            icon: "server",
          },
          {
            kind: "stat",
            id: "system:model",
            label: UI_TEXT.taskPanel.modelLabel,
            description: info.model,
            icon: "symbol-method",
          },
          {
            kind: "stat",
            id: "system:budget",
            label: UI_TEXT.taskPanel.tokenBudgetLabel,
            description: String(info.tokenBudget),
            icon: "dashboard",
          },
          {
            kind: "stat",
            id: "system:batch",
            label: UI_TEXT.taskPanel.batchLimitLabel,
            description: String(info.batchSize),
            icon: "layers",
          },
        ];
      }
      default:
        return [];
    }
  }

  /** 连续的同文件块级小任务合并为可折叠组；大任务出现后默认折叠。 */
  private groupTaskNodes(
    tasks: readonly TranslationTaskView[],
    section: "active" | "finished",
  ): TaskTreeNode[] {
    const nodes: TaskTreeNode[] = [];
    let run: TranslationTaskView[] = [];
    const flush = () => {
      if (run.length === 0) {
        return;
      }
      if (run.length === 1) {
        nodes.push(this.taskNode(run[0], section));
      } else {
        const first = run[0];
        const last = run[run.length - 1];
        nodes.push({
          kind: "group",
          id: `group:${section}:${first.label}:${first.id}-${last.id}`,
          label: first.label,
          section,
          tasks: [...run],
          children: run.map((task) => this.taskNode(task, section, true)),
          hasLargeAfter: false,
        });
      }
      run = [];
    };
    for (const task of tasks) {
      if (task.scope === "block") {
        if (run.length > 0 && run[0].label !== task.label) {
          flush();
        }
        run.push(task);
      } else {
        flush();
        nodes.push(this.taskNode(task, section));
      }
    }
    flush();

    let largeAfter = false;
    for (let index = nodes.length - 1; index >= 0; index -= 1) {
      const node = nodes[index];
      if (node.kind === "group") {
        node.hasLargeAfter = largeAfter;
        // 大任务出现/消失时换一个 TreeItem id，让 VS Code 重新采用默认折叠状态。
        node.id = `${node.id}:${largeAfter ? "folded" : "open"}`;
      } else if (node.kind === "task" && node.task.scope !== "block") {
        largeAfter = true;
      }
    }
    return nodes;
  }

  private taskNode(
    task: TranslationTaskView,
    section: "active" | "finished",
    compact = false,
  ): TaskNode {
    const children: DetailNode[] = [];
    if (task.error) {
      children.push({
        kind: "detail",
        id: `task:${task.id}:error`,
        label: task.error,
        icon: "error",
        color: new vscode.ThemeColor("errorForeground"),
      });
    } else if (section === "active" && task.phase.trim()) {
      children.push({
        kind: "detail",
        id: `task:${task.id}:phase`,
        label: task.phase,
        icon: "sync",
        color: new vscode.ThemeColor("descriptionForeground"),
      });
    }
    return {
      kind: "task",
      id: `task:${task.id}`,
      task,
      section,
      children,
      ...(compact
        ? {
            compactLabel:
              [
                operationLabel(task.operation),
                ...(task.blockKey && /^\d+$/.test(task.blockKey)
                  ? [
                      formatText(UI_TEXT.taskPanel.blockLabel, {
                        index: Number(task.blockKey) + 1,
                      }),
                    ]
                  : []),
              ]
                .filter(Boolean)
                .join(" · ") || task.label,
          }
        : {}),
    };
  }

  // ---- 视图生命周期 ----

  setTreeView(view: vscode.TreeView<TaskTreeNode>): void {
    this.treeView = view;
    this.commandDisposables.push(
      view.onDidExpandElement((event) => {
        if (event.element.kind === "group") {
          this.expandedGroups.add(event.element.id);
          this.collapsedGroups.delete(event.element.id);
        }
      }),
      view.onDidCollapseElement((event) => {
        if (event.element.kind === "group") {
          this.collapsedGroups.add(event.element.id);
          this.expandedGroups.delete(event.element.id);
        }
      }),
    );
    this.updateViewMeta();
  }

  /**
   * 状态栏命令入口：可见则收起，已解析但隐藏则显示，未解析则打开容器。
   */
  async toggle(): Promise<void> {
    const view = this.treeView;
    // 与状态栏文案一致：可见时收起所在侧栏，隐藏时打开容器并 reveal。
    if (view?.visible) {
      await vscode.commands.executeCommand("workbench.action.closeAuxiliaryBar");
      setTimeout(() => {
        if (view.visible) {
          void vscode.commands.executeCommand("workbench.action.closeSidebar");
        }
      }, 80);
      return;
    }
    await vscode.commands.executeCommand(
      "workbench.view.extension.markdownBilingualSyncTasks",
    );
    if (view) {
      try {
        await view.reveal(this.sections[1], {
          expand: true,
          select: false,
          focus: true,
        });
      } catch {
        /* 视图尚未渲染时忽略 */
      }
    }
  }

  dispose(): void {
    if (this.updateTimer) {
      clearTimeout(this.updateTimer);
      this.updateTimer = undefined;
    }
    for (const disposable of this.commandDisposables.splice(0)) {
      disposable.dispose();
    }
    for (const unsubscribe of this.unsubscribers.splice(0)) {
      unsubscribe();
    }
    this.onDidChangeTreeDataEmitter.dispose();
  }

  // ---- 刷新 ----

  private scheduleUpdate(): void {
    if (this.updateTimer) {
      return;
    }
    this.updateTimer = setTimeout(() => {
      this.updateTimer = undefined;
      this.refresh();
    }, 100);
  }

  refresh(): void {
    this.onDidChangeTreeDataEmitter.fire();
    this.updateViewMeta();
  }

  private updateViewMeta(): void {
    const view = this.treeView;
    if (!view) {
      return;
    }
    const snapshot = this.options.monitor.snapshot();
    view.description =
      snapshot.activeCount > 0
        ? formatText(UI_TEXT.taskPanel.activeTaskCount, {
            count: snapshot.activeCount,
          })
        : undefined;
    view.badge =
      snapshot.activeCount > 0
        ? {
            value: snapshot.activeCount,
            tooltip: UI_TEXT.taskPanel.activeTaskBadgeTooltip,
          }
        : undefined;
  }

  // ---- 命令 ----

  /**
   * 注册视图标题与行内操作命令。
   * @returns 无；disposable 由 provider 的 dispose 统一释放。
   */
  registerCommands(): void {
    const register = (
      id: string,
      handler: (...args: unknown[]) => unknown,
    ): void => {
      this.commandDisposables.push(
        vscode.commands.registerCommand(id, handler),
      );
    };
    register("markdownBilingualSync.task.cancelAll", () => {
      this.options.monitor.cancelAll();
    });
    register("markdownBilingualSync.task.clearFinished", () => {
      this.options.monitor.clearFinished();
    });
    register("markdownBilingualSync.task.openOutput", () => {
      this.options.output.show(true);
    });
    register("markdownBilingualSync.task.languages", () => {
      void this.showLanguagePicker();
    });
    register("markdownBilingualSync.task.openSource", (arg) => {
      const task = this.resolveTask(arg);
      if (task?.uri) {
        void this.openSource(task.uri);
      }
    });
    register("markdownBilingualSync.task.openPreview", (arg) => {
      const task = this.resolveTask(arg);
      if (task?.uri) {
        this.options.openTask(task);
      }
    });
    register("markdownBilingualSync.task.cancel", (arg) => {
      const task = this.resolveTask(arg);
      if (task) {
        this.options.monitor.cancel(task.id);
      }
    });
  }

  private async openSource(uri: vscode.Uri): Promise<void> {
    try {
      const document = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(document, { preview: false });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.options.output.appendLine(
        `[${new Date().toISOString()}] task open source failed: ${message}`,
      );
      void vscode.window.showErrorMessage(
        `${UI_TEXT.extension.messagePrefix}${message}`,
      );
    }
  }

  /**
   * 从 TreeItem 的 command arguments、element 或 id 中解析任务。
   * VS Code 在行内命令中可能传 element 或 TreeItem，两种都兼容。
   */
  private resolveTask(arg: unknown): TranslationTaskView | undefined {
    if (Array.isArray(arg)) {
      return this.resolveTask(arg[0]);
    }
    if (!arg || typeof arg !== "object") {
      return undefined;
    }
    const node = arg as {
      kind?: string;
      task?: TranslationTaskView;
      id?: unknown;
      command?: { arguments?: unknown[] };
      status?: string;
      label?: string;
    };
    if (node.kind === "task" && node.task) {
      return node.task;
    }
    if (Array.isArray(node.command?.arguments)) {
      return this.resolveTask(node.command.arguments[0]);
    }
    if (typeof node.id === "number") {
      return this.options.monitor.getTask(node.id);
    }
    if (typeof node.id === "string" && node.id.startsWith("task:")) {
      const id = Number(node.id.slice("task:".length).split(":")[0]);
      if (Number.isInteger(id)) {
        return this.options.monitor.getTask(id);
      }
    }
    if (
      typeof node.id === "number" &&
      typeof node.status === "string" &&
      typeof node.label === "string"
    ) {
      return this.options.monitor.getTask(node.id);
    }
    return undefined;
  }

  // ---- 语言 ----

  private getLanguages(): TaskViewLanguages {
    const config = vscode.workspace.getConfiguration("markdownBilingualSync");
    return buildTaskViewLanguages(
      config.get<unknown>("sourceLanguage", "en"),
      config.get<unknown>("targetLanguage", "zh-CN"),
      config.get<unknown>("supportedLanguages", ["zh-CN"]),
    );
  }

  private async showLanguagePicker(): Promise<void> {
    const languages = this.getLanguages();
    const pick = await vscode.window.showQuickPick(
      [
        {
          label: `$(globe) ${UI_TEXT.taskPanel.sourceLanguageLabel}`,
          description: languages.sourceLanguage,
          detail: UI_TEXT.taskPanel.sourceLanguageTitle,
          role: "source" as const,
        },
        {
          label: `$(globe) ${UI_TEXT.taskPanel.targetLanguageLabel}`,
          description: languages.targetLanguage,
          detail: UI_TEXT.taskPanel.targetLanguageTitle,
          role: "target" as const,
        },
        {
          label: `$(arrow-swap) ${UI_TEXT.taskPanel.swapLanguagesTitle}`,
          description: `${languages.sourceLanguage} ↔ ${languages.targetLanguage}`,
          role: "swap" as const,
        },
      ],
      { title: UI_TEXT.taskPanel.languageSection },
    );
    if (!pick) {
      return;
    }
    if (pick.role === "swap") {
      await this.swapLanguages();
      return;
    }
    const role = pick.role;
    const current =
      role === "source" ? languages.sourceLanguage : languages.targetLanguage;
    const options = languages.supportedLanguages.map((language) => ({
      label: language,
      description: language === current ? "✓" : undefined,
    }));
    const selected = await vscode.window.showQuickPick(options, {
      title:
        role === "source"
          ? UI_TEXT.taskPanel.sourceLanguageLabel
          : UI_TEXT.taskPanel.targetLanguageLabel,
    });
    if (selected) {
      await this.setLanguage(role, selected.label);
    }
  }

  private enqueueLanguageUpdate(action: () => Promise<void>): Promise<void> {
    const next = this.languageUpdateQueue.then(action);
    this.languageUpdateQueue = next.catch(() => {
      /* 具体错误已在内部处理 */
    });
    return next;
  }

  /** 校验并写回单侧语言；串行化避免快速选择乱序。 */
  setLanguage(
    role: "source" | "target",
    requested: unknown,
  ): Promise<void> {
    return this.enqueueLanguageUpdate(() => this.applyLanguage(role, requested));
  }

  /** 交换原文/译文语言；串行化并提供半交换回滚。 */
  swapLanguages(): Promise<void> {
    return this.enqueueLanguageUpdate(() => this.applySwap());
  }

  private async applyLanguage(
    role: "source" | "target",
    requested: unknown,
  ): Promise<void> {
    const languages = this.getLanguages();
    const other =
      role === "source" ? languages.targetLanguage : languages.sourceLanguage;
    const selection = selectLanguage(
      requested,
      languages.supportedLanguages,
      other,
    );
    if (selection.status !== "ok") {
      const template =
        selection.status === "invalid"
          ? role === "source"
            ? UI_TEXT.taskPanel.sourceLanguageInvalid
            : UI_TEXT.taskPanel.targetLanguageInvalid
          : role === "source"
            ? UI_TEXT.taskPanel.sourceLanguageSameAsTarget
            : UI_TEXT.taskPanel.targetLanguageSameAsSource;
      void vscode.window.showErrorMessage(
        `${UI_TEXT.extension.messagePrefix}${formatText(template, {
          language: selection.language || "-",
        })}`,
      );
      this.refresh();
      return;
    }
    try {
      await this.writeLanguageSetting(
        role === "source" ? "sourceLanguage" : "targetLanguage",
        selection.language,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.options.output.appendLine(
        `[${new Date().toISOString()}] set ${role} language failed: ${message}`,
      );
      const template =
        role === "source"
          ? UI_TEXT.taskPanel.sourceLanguageUpdateFailed
          : UI_TEXT.taskPanel.targetLanguageUpdateFailed;
      void vscode.window.showErrorMessage(
        `${UI_TEXT.extension.messagePrefix}${formatText(template, { message })}`,
      );
    }
    this.refresh();
  }

  private async applySwap(): Promise<void> {
    const languages = this.getLanguages();
    const swapped = swapTaskViewLanguages(
      languages.sourceLanguage,
      languages.targetLanguage,
      languages.supportedLanguages,
    );
    if (swapped.status !== "ok") {
      void vscode.window.showErrorMessage(
        `${UI_TEXT.extension.messagePrefix}${UI_TEXT.taskPanel.swapLanguagesUnavailable}`,
      );
      this.refresh();
      return;
    }
    const applied: Array<{
      key: "sourceLanguage" | "targetLanguage";
      previous: string;
      target: vscode.ConfigurationTarget;
    }> = [];
    try {
      const sourceTarget = await this.writeLanguageSetting(
        "sourceLanguage",
        swapped.sourceLanguage,
      );
      applied.push({
        key: "sourceLanguage",
        previous: languages.sourceLanguage,
        target: sourceTarget,
      });
      const targetTarget = await this.writeLanguageSetting(
        "targetLanguage",
        swapped.targetLanguage,
      );
      applied.push({
        key: "targetLanguage",
        previous: languages.targetLanguage,
        target: targetTarget,
      });
    } catch (error) {
      const config = vscode.workspace.getConfiguration("markdownBilingualSync");
      for (const entry of applied.reverse()) {
        try {
          await config.update(entry.key, entry.previous, entry.target);
        } catch (rollbackError) {
          const detail =
            rollbackError instanceof Error
              ? rollbackError.message
              : String(rollbackError);
          this.options.output.appendLine(
            `[${new Date().toISOString()}] rollback ${entry.key} failed: ${detail}`,
          );
        }
      }
      const message = error instanceof Error ? error.message : String(error);
      void vscode.window.showErrorMessage(
        `${UI_TEXT.extension.messagePrefix}${formatText(
          UI_TEXT.taskPanel.languageUpdateFailed,
          { message },
        )}`,
      );
    }
    this.refresh();
  }

  private async writeLanguageSetting(
    key: "sourceLanguage" | "targetLanguage",
    value: string,
  ): Promise<vscode.ConfigurationTarget> {
    const config = vscode.workspace.getConfiguration("markdownBilingualSync");
    const inspected = config.inspect<string>(key);
    const target =
      inspected?.workspaceValue !== undefined
        ? vscode.ConfigurationTarget.Workspace
        : vscode.ConfigurationTarget.Global;
    await config.update(key, value, target);
    return target;
  }
}
