/**
 * 翻译任务监控模块（status/taskMonitor）。
 *
 * 职责：维护扩展会话内的任务表（排队/运行/结束）、终态与取消回调，
 * 向状态栏和任务视图提供只读快照与变更通知。
 *
 * 生命周期：随 activate 创建，不持有定时器或 VS Code 资源；
 * 订阅方通过 onDidChange 注册并在自身 dispose 时退订。
 *
 * 关键不变量：
 * - 对外快照不含 cancel 回调，避免调用方误触发取消；
 * - 历史任务最多保留 MAX_FINISHED_TASKS 条；
 * - 状态只能 queued → running → 终态，finish 幂等。
 */
import type * as vscode from "vscode";
import { UI_TEXT } from "../i18n";

// ---- 类型 ----

/** 翻译任务状态：queued/running 为活动态，其余为终态。 */
export type TranslationTaskStatus =
  | "queued"
  | "running"
  | "partial"
  | "success"
  | "failed"
  | "cancelled";

/** 判断任务是否已结束（partial 也是终态，不再接受进度或取消回调）。 */
function isTerminalStatus(status: TranslationTaskStatus): boolean {
  return (
    status === "partial" ||
    status === "success" ||
    status === "failed" ||
    status === "cancelled"
  );
}

/**
 * 构造失败任务的终态 patch。
 *
 * 任务卡片会同时渲染 phase（灰色阶段行）和 error（红色详情）；失败详情只放 error，
 * phase 留空，避免同一条错误消息在卡片里出现两次。
 */
export function failedTaskPatch(message: string): {
  phase: string;
  error: string;
} {
  return { phase: "", error: message };
}

/**
 * 任务对外快照（供状态栏与任务视图渲染）。
 * 这是副本，修改它不会影响监控器内部状态。
 */
export interface TranslationTaskView {
  /** 会话内单调递增的任务 ID。 */
  id: number;
  /** 展示用标签，通常是工作区相对路径。 */
  label: string;
  /** 源文件 URI；仅在主线程内部使用，不会原样发送到 webview。 */
  uri?: vscode.Uri;
  status: TranslationTaskStatus;
  /** 当前阶段文案（如“正在翻译 2/5 个块…”）。 */
  phase: string;
  /** 已完成块数（>= 0）。 */
  completed: number;
  /** 总块数（未知时为 0）。 */
  total: number;
  /** 失败块数（>= 0）。 */
  failed: number;
  /** 开始时间（毫秒时间戳），排队中的任务没有该值。 */
  startedAt?: number;
  /** 结束时间（毫秒时间戳），仅终态任务有值。 */
  finishedAt?: number;
  /** 失败原因，仅在 failed/partial 时可能设置。 */
  error?: string;
}

interface TranslationTask extends TranslationTaskView {
  /** 取消回调，由调用方注册（通常是 AbortController.abort）。 */
  cancel?: () => void;
}

/** 一次性导出的任务视图数据，active/finished 均已排好序。 */
export interface TaskSnapshot {
  /** 排队中或运行中的任务，按 startedAt 升序。 */
  active: TranslationTaskView[];
  /** 已结束的任务，按 finishedAt 降序。 */
  finished: TranslationTaskView[];
  /** 活动任务数，等价于 active.length。 */
  activeCount: number;
  /** 最近结束的任务中是否有 failed/partial（目前主要由测试消费）。 */
  recentFailure: boolean;
}

/** 历史任务上限，超出后按结束时间淘汰最旧的记录。 */
const MAX_FINISHED_TASKS = 40;

/**
 * 把内部任务对象转成对外视图：剥离 cancel 回调，避免调用方误触发取消。
 * 返回浅拷贝（基础字段均为值类型）。
 */
function toView(task: TranslationTask): TranslationTaskView {
  const { cancel: _cancel, ...view } = task;
  return { ...view };
}

/**
 * 翻译任务监控器。
 *
 * 只负责内存中的任务表与变更通知，不直接操作 VS Code UI；
 * 状态栏和任务视图监听 onDidChange 后自行节流刷新。
 */
export class TranslationTaskMonitor {
  /** 任务表；插入顺序即创建顺序，展示前会重新排序。 */
  private readonly tasks = new Map<number, TranslationTask>();
  /** 变更监听器集合；通过 onDidChange 返回的函数退订。 */
  private readonly listeners = new Set<() => void>();
  /** 下一个任务 ID，会话内不复用。 */
  private nextId = 1;

  // ---- 状态变更 ----

  /**
   * 创建排队中的任务。
   * @param label 展示标签（相对路径）
   * @param uri 源文件，可省略
   * @returns 新任务 ID
   * @sideeffect 立即 emit 一次，任务面板会显示排队条目
   */
  create(label: string, uri?: vscode.Uri): number {
    const id = this.nextId;
    this.nextId += 1;
    this.tasks.set(id, {
      id,
      label,
      uri,
      status: "queued",
      phase: UI_TEXT.taskPanel.phases.waiting,
      completed: 0,
      total: 0,
      failed: 0,
    });
    this.emit();
    return id;
  }

  /**
   * 将排队任务标记为运行中。
   * 仅 queued 状态有效，重复调用或任务已结束时忽略。
   */
  start(id: number): void {
    const task = this.tasks.get(id);
    if (!task || task.status !== "queued") {
      return;
    }
    task.status = "running";
    task.startedAt = Date.now();
    task.phase = UI_TEXT.taskPanel.phases.preparing;
    this.emit();
  }

  /**
   * 更新进度类字段（阶段、完成数、总数、失败数）。
   * 已进入终态（含 partial）的任务不可再更新；数值会被钳制为非负数。
   * @sideeffect 每次有效更新都会 emit
   */
  update(
    id: number,
    patch: {
      phase?: string;
      completed?: number;
      total?: number;
      failed?: number;
    },
  ): void {
    const task = this.tasks.get(id);
    // partial/success/failed/cancelled 都是终态，迟到进度一律忽略。
    if (!task || isTerminalStatus(task.status)) {
      return;
    }
    if (patch.phase !== undefined) {
      task.phase = patch.phase;
    }
    if (patch.completed !== undefined) {
      task.completed = Math.max(0, patch.completed);
    }
    if (patch.total !== undefined) {
      task.total = Math.max(0, patch.total);
    }
    if (patch.failed !== undefined) {
      task.failed = Math.max(0, patch.failed);
    }
    this.emit();
  }

  /**
   * 结束任务并写入终态。
   * 幂等：只有 queued/running 的任务能被结束，重复 finish 被忽略。
   * @param status 终态（partial/success/failed/cancelled）
   * @param patch 结束时的进度与错误信息
   * @sideeffect 清空 cancel 回调、裁剪历史记录并 emit
   */
  finish(
    id: number,
    status: Exclude<TranslationTaskStatus, "queued" | "running">,
    patch: {
      phase?: string;
      completed?: number;
      total?: number;
      failed?: number;
      error?: string;
    } = {},
  ): void {
    const task = this.tasks.get(id);
    if (
      !task ||
      (task.status !== "queued" && task.status !== "running")
    ) {
      return;
    }
    task.status = status;
    task.finishedAt = Date.now();
    task.phase = patch.phase ?? task.phase;
    if (patch.completed !== undefined) {
      task.completed = Math.max(0, patch.completed);
    }
    if (patch.total !== undefined) {
      task.total = Math.max(0, patch.total);
    }
    if (patch.failed !== undefined) {
      task.failed = Math.max(0, patch.failed);
    }
    if (patch.error !== undefined) {
      task.error = patch.error;
    }
    // 释放取消回调，避免闭包长期持有 AbortController 与同步上下文。
    task.cancel = undefined;
    this.prune();
    this.emit();
  }

  /**
   * 登记取消回调；重复登记会覆盖旧值。
   * 已进入终态（含 partial）的任务不接受登记。
   */
  registerCancel(id: number, cancel: () => void): void {
    const task = this.tasks.get(id);
    if (!task || isTerminalStatus(task.status)) {
      return;
    }
    task.cancel = cancel;
  }

  /**
   * 请求取消单个任务。
   * 只触发调用方登记的回调（通常 abort 共享的 AbortController），
   * 不直接把任务置为终态；终态由实际同步流程结束时的 finish 写入。
   */
  cancel(id: number): void {
    const task = this.tasks.get(id);
    if (!task || !task.cancel) {
      return;
    }
    task.phase = UI_TEXT.taskPanel.phases.cancelling;
    task.cancel();
    this.emit();
  }

  /**
   * 取消所有活动任务。
   * @returns 活动任务数量（包含未登记取消回调的任务）
   * @sideeffect 有活动任务时 emit 一次
   */
  cancelAll(): number {
    let count = 0;
    for (const task of this.tasks.values()) {
      if (task.status === "queued" || task.status === "running") {
        if (task.cancel) {
          task.phase = UI_TEXT.taskPanel.phases.cancelling;
          task.cancel();
        }
        count += 1;
      }
    }
    if (count > 0) {
      this.emit();
    }
    return count;
  }

  /** 清空所有已结束任务（保留活动任务），用于“清除任务历史”。 */
  clearFinished(): void {
    for (const [id, task] of this.tasks) {
      if (
        task.status === "success" ||
        task.status === "partial" ||
        task.status === "failed" ||
        task.status === "cancelled"
      ) {
        this.tasks.delete(id);
      }
    }
    this.emit();
  }

  // ---- 查询 ----

  /** 任务是否处于 queued/running；未知 ID 返回 false。 */
  isActive(id: number): boolean {
    const task = this.tasks.get(id);
    return Boolean(task && (task.status === "queued" || task.status === "running"));
  }

  /**
   * 按 ID 获取任务快照。
   * @returns 副本；任务不存在或被裁剪后返回 undefined
   */
  getTask(id: number): TranslationTaskView | undefined {
    const task = this.tasks.get(id);
    return task ? toView(task) : undefined;
  }

  /**
   * 生成当前任务快照供 UI 渲染。
   * 每次调用都会复制并排序任务数组，调用方不应缓存该对象。
   */
  snapshot(): TaskSnapshot {
    const active: TranslationTaskView[] = [];
    const finished: TranslationTaskView[] = [];
    for (const task of this.tasks.values()) {
      if (task.status === "queued" || task.status === "running") {
        active.push(toView(task));
      } else {
        finished.push(toView(task));
      }
    }
    // 活动任务按开始时间升序（尚未开始的排在最前），历史按结束时间倒序。
    active.sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0));
    finished.sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0));
    return {
      active,
      finished,
      activeCount: active.length,
      recentFailure: finished.some(
        (task) => task.status === "failed" || task.status === "partial",
      ),
    };
  }

  // ---- 通知与清理 ----

  /**
   * 订阅任务变更。
   * @returns 退订函数；调用方必须保存并在 dispose 时执行，否则监听器泄漏。
   */
  onDidChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** 只保留最近 MAX_FINISHED_TASKS 条历史，防止长时间运行后内存增长。 */
  private prune(): void {
    const finished = [...this.tasks.values()]
      .filter(
        (task) =>
          task.status !== "queued" && task.status !== "running",
      )
      .sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0));
    for (const task of finished.slice(MAX_FINISHED_TASKS)) {
      this.tasks.delete(task.id);
    }
  }

  /**
   * 同步通知所有监听器。
   * 注意：监听器抛错会中断后续通知并向上传播（当前监听器只做节流调度，不会抛错）。
   */
  private emit(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}
