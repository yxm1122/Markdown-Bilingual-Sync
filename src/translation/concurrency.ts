/**
 * 全局请求并发限制器（translation/concurrency）
 *
 * 职责：为所有 Provider 的 HTTP 请求提供统一的并发槽，限制同一时刻进行中的请求数；
 * 限制值从 getLimit 动态读取（跟随用户设置），并对外暴露运行/等待数量供状态栏展示。
 *
 * 关键不变量：
 * - active 只由 acquire/drain 增加、由 release 减少，且永不为负；
 * - 等待者按 FIFO 唤醒；被取消的等待者会被移出队列且不占用槽位；
 * - 限制器只负责“准入”，不负责中止正在运行的任务——任务自身必须监听 signal。
 *
 * 外部依赖：仅 AbortSignal（无 VS Code 依赖）；不发请求、不写日志。
 *
 * 安全边界：不接触任务内容或密钥；取消错误统一为“翻译已取消”。
 */
export interface RequestLimiter {
  /** 当前并发上限（动态读取，可能随设置变化）。 */
  readonly limit: number;
  /**
   * 获取一个并发槽后执行任务，完成后（含抛错）自动释放。
   * @param signal 排队期间取消会立即 reject，不占用槽位；运行期间需由任务自行响应。
   */
  run<T>(
    task: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T>;
}

/** 排队中的请求：resolve 表示拿到槽位，reject 表示被取消；onAbort 用于摘下监听器。 */
interface Waiter {
  resolve: () => void;
  reject: (error: unknown) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

// ---- 限制器实现 ----

/**
 * FIFO 并发限制器。limit 每次读取都重新计算，因此修改设置无需重建实例；
 * 注意：提高 limit 不会主动唤醒已有等待者，它们会在下一次 release 时被 drain。
 */
export class ConcurrencyLimiter implements RequestLimiter {
  private active = 0;
  private readonly waiters: Waiter[] = [];
  private readonly listeners = new Set<() => void>();

  /**
   * @param getLimit 读取当前并发上限；非有限值回退到 fallbackLimit。
   * @param fallbackLimit getLimit 返回非法值时的兜底上限。
   */
  constructor(
    private readonly getLimit: () => number,
    private readonly fallbackLimit = 8,
  ) {}

  /** 当前占用槽位的任务数。 */
  get activeCount(): number {
    return this.active;
  }

  /** 当前排队等待槽位的任务数。 */
  get waitingCount(): number {
    return this.waiters.length;
  }

  /** 解析后的并发上限：取整并保证 >=1；非法值回退到 fallbackLimit。 */
  get limit(): number {
    const value = Number(this.getLimit());
    return Number.isFinite(value)
      ? Math.max(1, Math.floor(value))
      : Math.max(1, this.fallbackLimit);
  }

  /**
   * 注册状态变化监听（acquire/release/取消时触发），用于刷新状态栏与任务面板。
   * @returns 取消监听的函数；调用方应在 dispose 时执行，避免泄漏。
   */
  onDidChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * 获取槽位 -> 执行任务 -> 无论成功失败都释放槽位。
   * 任务抛错会原样透传；排队期间取消则直接以“翻译已取消”reject。
   */
  async run<T>(
    task: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    await this.acquire(signal);
    try {
      return await task();
    } finally {
      this.release();
    }
  }

  /**
   * 申请槽位：有空位立即占用；否则入队等待。
   * signal 在排队时触发会移除等待者并 reject；已获得槽位后不再监听 signal。
   */
  private acquire(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) {
      return Promise.reject(new Error("翻译已取消"));
    }
    if (this.active < this.limit) {
      this.active += 1;
      this.notify();
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = { resolve, reject, signal };
      if (signal) {
        waiter.onAbort = () => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) {
            this.waiters.splice(index, 1);
            this.notify();
          }
          reject(new Error("翻译已取消"));
        };
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      this.waiters.push(waiter);
      this.notify();
    });
  }

  /** 释放槽位（防负数），随后按 FIFO 唤醒等待者并通知监听器。 */
  private release(): void {
    this.active = Math.max(0, this.active - 1);
    this.drain();
    this.notify();
  }

  /** 同步通知所有 onDidChange 监听器；监听器抛错会向上传播。 */
  private notify(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }

  /**
   * 在有空位时按 FIFO 唤醒等待者：已取消的直接 reject 并跳过，正常者移除监听后占槽。
   * 同步执行，保证一次 release 唤醒的数量不超过新空出的槽位。
   */
  private drain(): void {
    while (this.waiters.length > 0 && this.active < this.limit) {
      const waiter = this.waiters.shift();
      if (!waiter) {
        return;
      }
      if (waiter.signal?.aborted) {
        waiter.reject(new Error("翻译已取消"));
        continue;
      }
      if (waiter.signal && waiter.onAbort) {
        waiter.signal.removeEventListener("abort", waiter.onAbort);
      }
      this.active += 1;
      waiter.resolve();
    }
  }
}
