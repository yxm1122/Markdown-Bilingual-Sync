/** 测试：预览顶部任务胶囊的新任务识别与 1 秒合并。 */
import { describe, expect, it } from "vitest";
import { TaskFlashTracker } from "../src/preview/taskFlash";

describe("task flash tracker", () => {
  it("does not flash when the preview opens with existing tasks", () => {
    const tracker = new TaskFlashTracker();
    expect(tracker.observe([1, 2], 1000)).toBe(false);
    expect(tracker.observe([1, 2], 1100)).toBe(false);
  });

  it("flashes when a new task id appears", () => {
    const tracker = new TaskFlashTracker();
    tracker.observe([1], 1000);
    expect(tracker.observe([1, 2], 1200)).toBe(true);
  });

  it("detects a new task even when the active count stays the same", () => {
    const tracker = new TaskFlashTracker();
    tracker.observe([1], 1000);
    // 任务 1 结束、任务 2 开始：数量相同但出现了新 ID。
    expect(tracker.observe([2], 1100)).toBe(true);
  });

  it("coalesces multiple new tasks inside one second", () => {
    const tracker = new TaskFlashTracker();
    tracker.observe([], 1000);
    expect(tracker.observe([1], 1100)).toBe(true);
    expect(tracker.observe([1, 2], 1500)).toBe(false);
    expect(tracker.observe([1, 2, 3], 1900)).toBe(false);
    // 窗口结束后的新任务再次触发。
    expect(tracker.observe([1, 2, 3, 4], 2200)).toBe(true);
  });

  it("treats queue to running as the same task", () => {
    const tracker = new TaskFlashTracker();
    tracker.observe([], 1000);
    expect(tracker.observe([7], 1100)).toBe(true);
    expect(tracker.observe([7], 1500)).toBe(false);
  });

  it("flashes when the first task appears after an empty baseline", () => {
    const tracker = new TaskFlashTracker();
    tracker.observe([], 1000);
    expect(tracker.observe([9], 1100)).toBe(true);
  });
});
