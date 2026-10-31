/**
 * 操作调度器（status/operationScheduler）。
 *
 * 职责：把翻译、审校、回译、摘要等长操作统一排队，并按「同文件串行、不同文件并行」
 * 的规则启动；任务本身仍由 TranslationTaskMonitor 记录，供任务面板与状态栏展示。
 *
 * 关键不变量：
 * - 同一 URI 同时最多只有一个任务处于 running，避免 SyncService.withLock 冲突；
 * - 无 URI 的任务使用唯一 key，不与文件任务互相阻塞；
 * - 任务级并发读取 translationConcurrency，HTTP 请求级并发仍由 ConcurrencyLimiter 管理；
 * - done 永不 reject：取消、失败都通过 OperationSettlement.status 返回；
 * - 取消排队任务立即出队并结束；取消运行中任务只 abort，最终状态由 runner 结束。
 */
import type * as vscode from "vscode";
import { UI_TEXT } from "../i18n";
import {
  failedTaskPatch,
  type TaskOperation,
  type TaskTarget,
  type TranslationTaskMonitor,
  type TranslationTaskStatus,
} from "./taskMonitor";

/** runner 可上报的进度字段，直接映射到任务视图。 */
export interface OperationReport {
  phase?: string;
  completed?: number;
  total?: number;
  failed?: number;
}

/** runner 执行上下文：取消信号 + 进度上报。 */
export interface OperationRunContext {
  readonly signal: AbortSignal;
  report(patch: OperationReport): void;
  /** 记录一次 Provider 自动重试；用于任务悬浮详情。 */
  recordRetry(count?: number): void;
}

/** 任务最终状态（不含活动态）。 */
export type OperationSettlementStatus = Exclude<
  TranslationTaskStatus,
  "queued" | "running"
>;

/**
 * runner 的返回值：用于提交终态文案、进度与结果对象。
 * status 省略时按 success 处理；带 error 且未指定 status 时按 partial 处理。
 */
export interface OperationOutcome<T = unknown> {
  status?: "success" | "partial";
  phase?: string;
  completed?: number;
  total?: number;
  failed?: number;
  error?: string;
  result?: T;
}

/** 入队参数。 */
export interface OperationRequest<T = unknown> {
  label: string;
  operation: TaskOperation;
  /** 文件 URI；同一 URI 的任务串行执行。省略时任务不参与文件互斥。 */
  uri?: vscode.Uri;
  /** 任务作用域与预览跳转目标。 */
  target?: TaskTarget;
  run(context: OperationRunContext): Promise<OperationOutcome<T> | void>;
}

/** 任务结清信息；done 永不 reject，调用方按 status 分支处理。 */
export interface OperationSettlement<T = unknown> {
  status: OperationSettlementStatus;
  result?: T;
  error?: string;
}

/** enqueue 的返回值：任务 ID 与结清 Promise。 */
export interface EnqueuedOperation<T = unknown> {
  taskId: number;
  done: Promise<OperationSettlement<T>>;
}

/** 内部调度项；runner 的泛型在入队时擦除，结清时由外部 Promise 还原。 */
interface ScheduledTask {
  taskId: number;
  key: string;
  controller: AbortController;
  run: (context: OperationRunContext) => Promise<OperationOutcome<unknown> | void>;
  resolve: (settlement: OperationSettlement<unknown>) => void;
  cancelled: boolean;
}

/** 判定来自 SyncService 的取消错误，避免 status 模块直接依赖 sync 模块。 */
function isCancelledError(error: unknown): boolean {
  return error instanceof Error && error.name === "CancelledError";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * FIFO 操作调度器。
 *
 * 调度策略是 work-conserving：按入队顺序寻找第一个「文件未被占用」的任务启动，
 * 因此一个大文件排队时，其他文件的任务仍可继续占用空闲槽位。
 */
export class OperationScheduler {
  private readonly pending: ScheduledTask[] = [];
  private readonly running = new Map<number, ScheduledTask>();
  private readonly runningKeys = new Set<string>();
  private disposed = false;

  /**
   * @param monitor 任务状态表
   * @param getLimit 任务级并发上限读取器；非有限值回退 8
   */
  constructor(
    private readonly monitor: TranslationTaskMonitor,
    private readonly getLimit: () => number,
  ) {}

  /**
   * 入队一个操作。
   * @returns 任务 ID 与结清 Promise；任务可能在返回前已经启动。
   */
  enqueue<T>(request: OperationRequest<T>): EnqueuedOperation<T> {
    const taskId = this.monitor.create(
      request.label,
      request.uri,
      request.operation,
      request.target,
    );
    const controller = new AbortController();
    let resolve!: (settlement: OperationSettlement<unknown>) => void;
    const done = new Promise<OperationSettlement<unknown>>((innerResolve) => {
      resolve = innerResolve;
    });
    const item: ScheduledTask = {
      taskId,
      key: request.uri ? request.uri.toString() : `operation:${taskId}`,
      controller,
      run: request.run as (
        context: OperationRunContext,
      ) => Promise<OperationOutcome<unknown> | void>,
      resolve,
      cancelled: false,
    };
    this.monitor.registerCancel(taskId, () => this.handleCancel(item));
    if (this.disposed) {
      item.resolve(this.settleCancelled(item, "cancelled"));
    } else {
      this.pending.push(item);
    }
    this.pump();
    return {
      taskId,
      done: done as Promise<OperationSettlement<T>>,
    };
  }

  /**
   * 取消单个任务。排队任务立即结束；运行中任务只 abort，等待 runner 收尾。
   * 由任务面板的取消命令或面板销毁时调用。
   */
  cancelTask(taskId: number): void {
    this.monitor.cancel(taskId);
  }

  /**
   * 停用调度器：所有任务立即标记取消并 abort，之后不再启动新任务。
   * runner 迟到的 finish 由 TranslationTaskMonitor 幂等忽略。
   */
  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    for (const item of [...this.pending, ...this.running.values()]) {
      item.cancelled = true;
      item.controller.abort();
      this.monitor.finish(item.taskId, "cancelled", {
        phase: UI_TEXT.taskPanel.phases.cancelled,
      });
      item.resolve({ status: "cancelled" });
    }
    this.pending.length = 0;
    this.running.clear();
    this.runningKeys.clear();
  }

  // ---- 调度 ----

  /** 在并发上限内启动可执行任务；被占用的文件跳过，保持后续任务可插队。 */
  private pump(): void {
    if (this.disposed) {
      return;
    }
    const limit = this.resolveLimit();
    while (this.running.size < limit) {
      const index = this.pending.findIndex(
        (item) => !item.cancelled && !this.runningKeys.has(item.key),
      );
      if (index < 0) {
        return;
      }
      const item = this.pending.splice(index, 1)[0];
      this.start(item);
    }
  }

  private resolveLimit(): number {
    const value = Number(this.getLimit());
    return Number.isFinite(value)
      ? Math.max(1, Math.floor(value))
      : 8;
  }

  /** 标记任务开始并异步执行；结束时统一 finish、resolve 并继续调度。 */
  private start(item: ScheduledTask): void {
    if (item.cancelled || item.controller.signal.aborted) {
      item.resolve(this.settleCancelled(item, "cancelled"));
      return;
    }
    this.running.set(item.taskId, item);
    this.runningKeys.add(item.key);
    this.monitor.start(item.taskId);

    const context: OperationRunContext = {
      signal: item.controller.signal,
      report: (patch) => this.monitor.update(item.taskId, patch),
      recordRetry: (count = 1) =>
        this.monitor.recordRetry(item.taskId, count),
    };

    void (async () => {
      let settlement: OperationSettlement<unknown> = {
        status: "cancelled",
      };
      try {
        const outcome = await item.run(context);
        if (item.cancelled || context.signal.aborted) {
          settlement = this.settleCancelled(item, "cancelled");
        } else {
          settlement = this.settleFromOutcome(item, outcome);
        }
      } catch (error) {
        if (item.cancelled || context.signal.aborted || isCancelledError(error)) {
          settlement = this.settleCancelled(item, "cancelled");
        } else {
          settlement = this.settleFailed(item, errorMessage(error));
        }
      } finally {
        this.running.delete(item.taskId);
        this.runningKeys.delete(item.key);
        item.resolve(settlement);
        this.pump();
      }
    })();
  }

  // ---- 结清 ----

  private settleFromOutcome(
    item: ScheduledTask,
    outcome: OperationOutcome<unknown> | void,
  ): OperationSettlement<unknown> {
    const status =
      outcome?.status ?? (outcome?.error ? "partial" : "success");
    const patch = {
      phase: outcome?.phase ?? UI_TEXT.taskPanel.phases.completed,
      ...(outcome?.completed !== undefined
        ? { completed: outcome.completed }
        : {}),
      ...(outcome?.total !== undefined ? { total: outcome.total } : {}),
      ...(outcome?.failed !== undefined ? { failed: outcome.failed } : {}),
      ...(outcome?.error ? { error: outcome.error } : {}),
    };
    this.monitor.finish(item.taskId, status, patch);
    return {
      status,
      ...(outcome?.result !== undefined ? { result: outcome.result } : {}),
      ...(outcome?.error ? { error: outcome.error } : {}),
    };
  }

  private settleFailed(
    item: ScheduledTask,
    message: string,
  ): OperationSettlement<unknown> {
    this.monitor.finish(item.taskId, "failed", failedTaskPatch(message));
    return { status: "failed", error: message };
  }

  private settleCancelled(
    item: ScheduledTask,
    status: "cancelled",
  ): OperationSettlement<unknown> {
    item.cancelled = true;
    item.controller.abort();
    this.monitor.finish(item.taskId, status, {
      phase: UI_TEXT.taskPanel.phases.cancelled,
    });
    return { status };
  }

  /** 任务面板取消回调：排队任务立即出队；运行中任务只 abort。 */
  private handleCancel(item: ScheduledTask): void {
    item.cancelled = true;
    item.controller.abort();
    if (this.running.has(item.taskId)) {
      return;
    }
    const index = this.pending.indexOf(item);
    if (index >= 0) {
      this.pending.splice(index, 1);
      item.resolve({ status: "cancelled" });
    }
    this.monitor.finish(item.taskId, "cancelled", {
      phase: UI_TEXT.taskPanel.phases.cancelled,
    });
  }
}
