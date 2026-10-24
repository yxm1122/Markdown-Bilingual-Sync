/**
 * 轻量并发执行器（batch/concurrency）
 *
 * 职责：在不超过 limit 的前提下并发消费 items，供目录批量导入导出等场景使用。
 * 与 translation/concurrency 的共享限流器不同，这里只约束一次调用的本地并发。
 *
 * 关键不变量：
 * - 每个 item 恰好被处理一次；
 * - 任意 worker 抛错时 Promise.all 会拒绝，但其他 worker 可能仍在执行（由调用方决定是否取消）；
 * - signal 中止后不再领取新 item，已在执行的 worker 不会被强制终止。
 */
export async function runWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  if (items.length === 0) {
    return;
  }
  // 非数字/NaN 时退化为串行；workerCount 同时受 item 数量约束。
  const normalizedLimit = Number.isFinite(limit) ? Math.floor(limit) : 1;
  const workerCount = Math.max(
    1,
    Math.min(items.length, normalizedLimit),
  );
  let nextIndex = 0;
  const run = async (): Promise<void> => {
    while (!signal?.aborted) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) {
        return;
      }
      await worker(items[index], index);
    }
  };
  await Promise.all(
    Array.from({ length: workerCount }, () => run()),
  );
}
