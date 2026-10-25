/** 测试：翻译任务状态机、取消与历史快照。 */
import { describe, expect, it } from "vitest";
import { TranslationTaskMonitor, failedTaskPatch } from "../src/status/taskMonitor";

describe("TranslationTaskMonitor", () => {
  it("tracks queued, running and finished tasks", () => {
    const monitor = new TranslationTaskMonitor();
    const id = monitor.create("docs/a.md");

    let snapshot = monitor.snapshot();
    expect(snapshot.active).toHaveLength(1);
    expect(snapshot.active[0].status).toBe("queued");

    monitor.start(id);
    monitor.update(id, { phase: "正在翻译 2/5 个块…", completed: 2, total: 5 });
    snapshot = monitor.snapshot();
    expect(snapshot.active[0].status).toBe("running");
    expect(snapshot.active[0].completed).toBe(2);
    expect(snapshot.active[0].total).toBe(5);

    monitor.finish(id, "success", {
      completed: 5,
      total: 5,
      failed: 0,
      phase: "完成",
    });
    snapshot = monitor.snapshot();
    expect(snapshot.activeCount).toBe(0);
    expect(snapshot.finished[0].status).toBe("success");
    expect(snapshot.finished[0].finishedAt).toBeTypeOf("number");
  });

  it("keeps failure detail only in error, not phase", () => {
    const monitor = new TranslationTaskMonitor();
    const id = monitor.create("docs/a.md");
    monitor.start(id);
    monitor.finish(id, "failed", failedTaskPatch("boom"));

    const task = monitor.snapshot().finished[0];
    expect(task.status).toBe("failed");
    expect(task.error).toBe("boom");
    expect(task.phase).toBe("");
  });

  it("cancels active tasks and ignores duplicate finish", () => {
    const monitor = new TranslationTaskMonitor();
    const id = monitor.create("docs/a.md");
    monitor.start(id);
    let cancelled = 0;
    monitor.registerCancel(id, () => {
      cancelled += 1;
    });

    expect(monitor.cancelAll()).toBe(1);
    expect(cancelled).toBe(1);
    monitor.finish(id, "cancelled", { phase: "已取消" });
    monitor.finish(id, "success");

    const snapshot = monitor.snapshot();
    expect(snapshot.finished[0].status).toBe("cancelled");
    expect(snapshot.recentFailure).toBe(false);
  });

  it("treats partial as a terminal state", () => {
    const monitor = new TranslationTaskMonitor();
    const id = monitor.create("docs/partial.md");
    monitor.start(id);
    monitor.finish(id, "partial", {
      completed: 1,
      total: 2,
      phase: "部分成功",
      error: "one block failed",
    });

    let cancelled = 0;
    monitor.registerCancel(id, () => {
      cancelled += 1;
    });
    monitor.update(id, { phase: "迟到进度", completed: 2, total: 2 });

    const snapshot = monitor.snapshot();
    expect(snapshot.finished[0].status).toBe("partial");
    expect(snapshot.finished[0].phase).toBe("部分成功");
    expect(snapshot.finished[0].completed).toBe(1);
    expect(monitor.cancelAll()).toBe(0);
    expect(cancelled).toBe(0);
  });

  it("clears finished tasks while keeping active ones", () => {
    const monitor = new TranslationTaskMonitor();
    const active = monitor.create("docs/active.md");
    const finished = monitor.create("docs/finished.md");
    monitor.start(active);
    monitor.start(finished);
    monitor.finish(finished, "failed", { error: "boom" });

    expect(monitor.snapshot().recentFailure).toBe(true);
    monitor.clearFinished();
    const snapshot = monitor.snapshot();
    expect(snapshot.finished).toHaveLength(0);
    expect(snapshot.activeCount).toBe(1);
    expect(monitor.isActive(active)).toBe(true);
    expect(monitor.isActive(finished)).toBe(false);
  });

  it("notifies listeners on changes", () => {
    const monitor = new TranslationTaskMonitor();
    let changes = 0;
    const unsubscribe = monitor.onDidChange(() => {
      changes += 1;
    });
    const id = monitor.create("docs/a.md");
    monitor.start(id);
    monitor.finish(id, "success");
    unsubscribe();
    monitor.create("docs/b.md");

    expect(changes).toBe(3);
  });
});
