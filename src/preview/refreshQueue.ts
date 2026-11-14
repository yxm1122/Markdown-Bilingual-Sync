/**
 * 预览自动刷新调度（纯逻辑，不依赖 vscode / DOM）。
 *
 * 三个来源共用一次渲染：
 * - 逐批译文快照：250ms 合并，后到的批次覆盖先到的；
 * - 源文变化：300ms 去抖，只允许按内容哈希跳过；
 * - 任务结束/落盘后的强制刷新：立即执行；被交互或写回阻塞时挂起，解除后补一次。
 *
 * 关键不变量：
 * - 阻塞期间不丢弃任何来源，只挂起；解除后按“强制 > 进度 > 仅源文”的优先级合并；
 * - 强制刷新永远读盘，不使用内存快照，避免任务结束后又被旧进度覆盖；
 * - 定时器与挂起状态在 cancel/dispose 后清空，不会在面板销毁后回调。
 *
 * 外部依赖：仅 setTimeout/clearTimeout；apply 由调用方负责串行化与实际渲染。
 */

/** 发给调用方的一次刷新请求。 */
export interface PreviewRefreshRequest {
  /** 有值时使用该内存缓存快照；缺省表示重新读取磁盘缓存。 */
  cacheText?: string;
  /** 仅源文刷新时为 true：内容哈希未变可以跳过渲染。 */
  skipIfUnchanged: boolean;
}

/** 刷新来源；不同来源可以有不同阻塞条件（如暂存只暂停进度）。 */
export type PreviewRefreshKind = "progress" | "source" | "final";

/** 调度参数；数值用于测试覆盖，生产调用使用默认值。 */
export interface PreviewRefreshQueueOptions {
  /** 当前是否应暂停指定来源的刷新（交互、导出确认、写回等）。 */
  isBlocked: (kind: PreviewRefreshKind) => boolean;
  /** 执行一次刷新；异常由 apply 自行处理，队列不会重试。 */
  apply: (request: PreviewRefreshRequest) => void | Promise<void>;
  /** 逐批译文的合并间隔。 */
  progressDelayMs?: number;
  /** 源文变化的去抖间隔。 */
  sourceDelayMs?: number;
  /** 阻塞期间的重试间隔。 */
  retryDelayMs?: number;
}

const DEFAULT_PROGRESS_DELAY_MS = 250;
const DEFAULT_SOURCE_DELAY_MS = 300;
const DEFAULT_RETRY_DELAY_MS = 400;

/** 一次刷新是否属于“源文未变可跳过”的场景。 */
export interface SourceRefreshSkipInput {
  /** 本次刷新由源文变化触发（允许跳过）。 */
  skipIfUnchanged: boolean;
  /** 是否携带用户可见提示；有提示时必须渲染。 */
  hasNotice: boolean;
  /** 是否附带导出确认框；必须渲染。 */
  hasExportConfirmation: boolean;
  /** 是否使用内存进度快照；有快照时不比较源文。 */
  hasCacheOverride: boolean;
  /** 当前源文哈希。 */
  sourceHash: string;
  /** 上一次成功渲染的源文哈希。 */
  lastRenderedSourceHash?: string;
}

/** 自动源文刷新在内容未变时跳过渲染，避免保存/外部事件的重复触发。 */
export function shouldSkipUnchangedSourceRefresh(
  input: SourceRefreshSkipInput,
): boolean {
  return (
    input.skipIfUnchanged &&
    !input.hasNotice &&
    !input.hasExportConfirmation &&
    !input.hasCacheOverride &&
    input.sourceHash === input.lastRenderedSourceHash
  );
}

/** 三个来源的合并/去抖/阻塞重试调度器。 */
export class PreviewRefreshQueue {
  private pendingProgress?: string;
  private pendingSource = false;
  private pendingFinal = false;
  private progressTimer?: ReturnType<typeof setTimeout>;
  private sourceTimer?: ReturnType<typeof setTimeout>;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private disposed = false;
  private readonly progressDelayMs: number;
  private readonly sourceDelayMs: number;
  private readonly retryDelayMs: number;

  constructor(private readonly options: PreviewRefreshQueueOptions) {
    this.progressDelayMs =
      options.progressDelayMs ?? DEFAULT_PROGRESS_DELAY_MS;
    this.sourceDelayMs = options.sourceDelayMs ?? DEFAULT_SOURCE_DELAY_MS;
    this.retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  }

  /** 记录一批译文快照；250ms 窗口内的多批合并为最后一次。 */
  requestProgress(cacheText: string): void {
    if (this.disposed) {
      return;
    }
    this.pendingProgress = cacheText;
    if (this.progressTimer) {
      return;
    }
    this.progressTimer = setTimeout(() => {
      this.progressTimer = undefined;
      void this.flush();
    }, this.progressDelayMs);
  }

  /** 标记源文已变化；每次变化都重置 300ms 去抖窗口。 */
  requestSource(): void {
    if (this.disposed) {
      return;
    }
    this.pendingSource = true;
    if (this.sourceTimer) {
      clearTimeout(this.sourceTimer);
    }
    this.sourceTimer = setTimeout(() => {
      this.sourceTimer = undefined;
      void this.flush();
    }, this.sourceDelayMs);
  }

  /**
   * 请求一次强制刷新（任务结束、缓存落盘、保存）。
   * 未被阻塞时立即执行并等待；被阻塞时挂起，解除后补一次。
   */
  async requestFinal(): Promise<void> {
    if (this.disposed) {
      return;
    }
    if (this.options.isBlocked("final")) {
      this.pendingFinal = true;
      this.scheduleRetry();
      return;
    }
    this.clearPending();
    await this.applySafely({ skipIfUnchanged: false });
  }

  /** 交互/写回解除后调用：立即合并应用所有挂起请求。 */
  notifyUnblocked(): void {
    if (this.disposed) {
      return;
    }
    void this.flush();
  }

  /** 丢弃全部挂起请求与定时器；之后的进度/源文请求仍可重新排队。 */
  cancel(): void {
    this.clearPending();
  }

  /** 永久停止调度；用于面板销毁。 */
  dispose(): void {
    this.disposed = true;
    this.clearPending();
  }

  /** 是否存在尚未应用的请求（测试与诊断用）。 */
  get hasPending(): boolean {
    return (
      this.pendingFinal ||
      this.pendingProgress !== undefined ||
      this.pendingSource
    );
  }

  private async flush(): Promise<void> {
    if (
      this.disposed ||
      (!this.pendingFinal &&
        this.pendingProgress === undefined &&
        !this.pendingSource)
    ) {
      return;
    }
    // 最终刷新读盘，优先级最高；被阻塞时保留它并继续尝试其他来源。
    if (this.pendingFinal && !this.options.isBlocked("final")) {
      this.clearPending();
      await this.applySafely({ skipIfUnchanged: false });
      return;
    }
    if (
      this.pendingProgress !== undefined &&
      !this.options.isBlocked("progress")
    ) {
      const cacheText = this.pendingProgress;
      this.pendingProgress = undefined;
      if (this.progressTimer) {
        clearTimeout(this.progressTimer);
        this.progressTimer = undefined;
      }
      // 进度快照会读取最新源文，源文请求被本次刷新覆盖；最终刷新仍保留。
      this.pendingSource = false;
      if (this.sourceTimer) {
        clearTimeout(this.sourceTimer);
        this.sourceTimer = undefined;
      }
      await this.applySafely({ cacheText, skipIfUnchanged: false });
      if (this.hasPending) {
        this.scheduleRetry();
      }
      return;
    }
    // 仅源文：必须等自己的去抖窗口结束，避免被进度定时器提前触发。
    if (
      this.pendingSource &&
      !this.sourceTimer &&
      !this.options.isBlocked("source")
    ) {
      this.pendingSource = false;
      await this.applySafely({ skipIfUnchanged: true });
      if (this.hasPending) {
        this.scheduleRetry();
      }
      return;
    }
    this.scheduleRetry();
  }

  private scheduleRetry(): void {
    if (this.retryTimer || this.disposed) {
      return;
    }
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      void this.flush();
    }, this.retryDelayMs);
  }

  private clearPending(): void {
    if (this.progressTimer) {
      clearTimeout(this.progressTimer);
      this.progressTimer = undefined;
    }
    if (this.sourceTimer) {
      clearTimeout(this.sourceTimer);
      this.sourceTimer = undefined;
    }
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
    }
    this.pendingProgress = undefined;
    this.pendingSource = false;
    this.pendingFinal = false;
  }

  private async applySafely(request: PreviewRefreshRequest): Promise<void> {
    try {
      await this.options.apply(request);
    } catch {
      /* 刷新失败由调用方记录；调度器不重试，避免阻塞后续请求 */
    }
  }
}
