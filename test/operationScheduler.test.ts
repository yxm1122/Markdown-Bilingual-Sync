/** 测试：操作调度器的同文件串行、跨文件并行、排队与取消语义。 */
import { describe, expect, it, vi } from "vitest";
import { OperationScheduler } from "../src/status/operationScheduler";
import { TranslationTaskMonitor } from "../src/status/taskMonitor";

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });
  return { promise, resolve, reject };
}

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function file(name: string) {
  return {
    toString: () => `file:///${name}`,
    fsPath: `/${name}`,
  } as never;
}

describe("OperationScheduler", () => {
  it("runs one task per file and lets other files use free slots", async () => {
    const monitor = new TranslationTaskMonitor();
    const scheduler = new OperationScheduler(monitor, () => 2);
    const started: string[] = [];
    const first = deferred();
    const second = deferred();
    const other = deferred();

    const a1 = scheduler.enqueue({
      label: "a1",
      operation: "sync",
      uri: file("a.md"),
      run: async () => {
        started.push("a1");
        await first.promise;
      },
    });
    const a2 = scheduler.enqueue({
      label: "a2",
      operation: "retranslate",
      uri: file("a.md"),
      run: async () => {
        started.push("a2");
        await second.promise;
      },
    });
    const b1 = scheduler.enqueue({
      label: "b1",
      operation: "sync",
      uri: file("b.md"),
      run: async () => {
        started.push("b1");
        await other.promise;
      },
    });

    await tick();
    expect(started).toEqual(["a1", "b1"]);
    expect(monitor.getTask(a1.taskId)?.status).toBe("running");
    expect(monitor.getTask(a2.taskId)?.status).toBe("queued");
    expect(monitor.getTask(b1.taskId)?.status).toBe("running");

    first.resolve();
    await a1.done;
    await tick();
    expect(started).toEqual(["a1", "b1", "a2"]);

    second.resolve();
    other.resolve();
    await Promise.all([a2.done, b1.done]);
    expect(monitor.snapshot().activeCount).toBe(0);
    scheduler.dispose();
  });

  it("cancels a queued task without running it", async () => {
    const monitor = new TranslationTaskMonitor();
    const scheduler = new OperationScheduler(monitor, () => 1);
    const first = deferred();
    const runQueued = vi.fn(async () => undefined);

    const running = scheduler.enqueue({
      label: "running",
      operation: "sync",
      uri: file("a.md"),
      run: async () => {
        await first.promise;
      },
    });
    const queued = scheduler.enqueue({
      label: "queued",
      operation: "review",
      uri: file("a.md"),
      run: runQueued,
    });

    await tick();
    scheduler.cancelTask(queued.taskId);
    const settlement = await queued.done;
    expect(settlement.status).toBe("cancelled");
    expect(runQueued).not.toHaveBeenCalled();
    expect(monitor.getTask(queued.taskId)?.status).toBe("cancelled");

    first.resolve();
    await running.done;
    scheduler.dispose();
  });

  it("aborts a running task and settles it as cancelled", async () => {
    const monitor = new TranslationTaskMonitor();
    const scheduler = new OperationScheduler(monitor, () => 1);
    const started = deferred();
    const job = scheduler.enqueue({
      label: "running",
      operation: "summary",
      uri: file("a.md"),
      run: ({ signal }) =>
        new Promise<never>((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            reject(new Error("aborted"));
          });
          started.resolve();
        }),
    });

    await started.promise;
    scheduler.cancelTask(job.taskId);
    const settlement = await job.done;
    expect(settlement.status).toBe("cancelled");
    expect(monitor.getTask(job.taskId)?.status).toBe("cancelled");
    scheduler.dispose();
  });

  it("records failures in the monitor", async () => {
    const monitor = new TranslationTaskMonitor();
    const scheduler = new OperationScheduler(monitor, () => 1);
    const job = scheduler.enqueue({
      label: "failed",
      operation: "backtranslate",
      uri: file("a.md"),
      run: async () => {
        throw new Error("boom");
      },
    });

    const settlement = await job.done;
    expect(settlement.status).toBe("failed");
    expect(settlement.error).toBe("boom");
    expect(monitor.getTask(job.taskId)?.error).toBe("boom");
    scheduler.dispose();
  });

  it("carries task target metadata", async () => {
    const monitor = new TranslationTaskMonitor();
    const scheduler = new OperationScheduler(monitor, () => 1);
    const job = scheduler.enqueue({
      label: "target",
      operation: "review",
      uri: file("a.md"),
      target: { scope: "block", blockKey: "3" },
      run: async () => undefined,
    });

    await job.done;
    expect(monitor.getTask(job.taskId)).toMatchObject({
      scope: "block",
      blockKey: "3",
    });
    scheduler.dispose();
  });

  it("records retry counts on the task", async () => {
    const monitor = new TranslationTaskMonitor();
    const scheduler = new OperationScheduler(monitor, () => 1);
    const job = scheduler.enqueue({
      label: "retry",
      operation: "retranslate",
      uri: file("a.md"),
      run: async ({ recordRetry }) => {
        recordRetry();
        recordRetry(2);
      },
    });

    await job.done;
    expect(monitor.getTask(job.taskId)?.retries).toBe(3);
    scheduler.dispose();
  });

  it("cancels queued and running tasks on dispose", async () => {
    const monitor = new TranslationTaskMonitor();
    const scheduler = new OperationScheduler(monitor, () => 1);
    const first = deferred();
    const running = scheduler.enqueue({
      label: "running",
      operation: "sync",
      uri: file("a.md"),
      run: async () => {
        await first.promise;
      },
    });
    const queuedRun = vi.fn(async () => undefined);
    const queued = scheduler.enqueue({
      label: "queued",
      operation: "sync",
      uri: file("a.md"),
      run: queuedRun,
    });

    await tick();
    scheduler.dispose();
    expect((await running.done).status).toBe("cancelled");
    expect((await queued.done).status).toBe("cancelled");
    expect(queuedRun).not.toHaveBeenCalled();
    expect(monitor.getTask(running.taskId)?.status).toBe("cancelled");
    expect(monitor.getTask(queued.taskId)?.status).toBe("cancelled");
  });
});
