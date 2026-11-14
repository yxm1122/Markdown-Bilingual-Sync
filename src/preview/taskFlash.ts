/**
 * 任务活动闪烁判定（纯逻辑，不依赖 vscode）。
 *
 * 规则：
 * - 第一次观察只建立基线，预览打开时已有任务不闪；
 * - 任务 ID 集合中出现新 ID 才算“新任务”（排队与运行都算）；
 * - 纯计数不变但“一个结束 + 一个开始”仍能识别；
 * - 1 秒窗口内的多个新任务只闪一次，后续新任务并入本次闪烁但不再重复触发。
 */
const DEFAULT_COALESCE_MS = 1000;

export class TaskFlashTracker {
  private previous?: Set<number>;
  private lastFlashAt = Number.NEGATIVE_INFINITY;

  constructor(private readonly coalesceMs = DEFAULT_COALESCE_MS) {}

  /**
   * 观察一次活动任务集合。
   * @param ids 当前属于该文件的活动任务 ID。
   * @param now 当前时间（测试可注入）。
   * @returns 本次是否需要播放闪烁。
   */
  observe(ids: Iterable<number>, now = Date.now()): boolean {
    const next = new Set(ids);
    const initialized = this.previous !== undefined;
    const hasNewTask =
      initialized && [...next].some((id) => !this.previous?.has(id));
    this.previous = next;
    if (!hasNewTask) {
      return false;
    }
    if (now - this.lastFlashAt < this.coalesceMs) {
      return false;
    }
    this.lastFlashAt = now;
    return true;
  }
}
