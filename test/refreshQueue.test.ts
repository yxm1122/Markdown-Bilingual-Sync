/** 测试：预览自动刷新调度（合并、去抖、阻塞挂起与优先级）。 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PreviewRefreshQueue,
  shouldSkipUnchangedSourceRefresh,
  type PreviewRefreshRequest,
} from "../src/preview/refreshQueue";

interface Setup {
  queue: PreviewRefreshQueue;
  calls: PreviewRefreshRequest[];
  setBlocked(value: boolean): void;
}

function setup(blocked = false): Setup {
  let isBlocked = blocked;
  const calls: PreviewRefreshRequest[] = [];
  const queue = new PreviewRefreshQueue({
    isBlocked: () => isBlocked,
    apply: (request) => {
      calls.push({ ...request });
    },
  });
  return {
    queue,
    calls,
    setBlocked(value) {
      isBlocked = value;
    },
  };
}

describe("preview refresh queue", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("coalesces progress batches into one 250ms refresh", async () => {
    const { queue, calls } = setup();
    queue.requestProgress("first");
    await vi.advanceTimersByTimeAsync(100);
    queue.requestProgress("second");
    await vi.advanceTimersByTimeAsync(149);
    expect(calls).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toEqual([{ cacheText: "second", skipIfUnchanged: false }]);
  });

  it("debounces source changes until typing pauses", async () => {
    const { queue, calls } = setup();
    queue.requestSource();
    await vi.advanceTimersByTimeAsync(200);
    queue.requestSource();
    await vi.advanceTimersByTimeAsync(299);
    expect(calls).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toEqual([{ skipIfUnchanged: true }]);
  });

  it("merges progress and source into the progress snapshot", async () => {
    const { queue, calls } = setup();
    queue.requestProgress("snapshot");
    queue.requestSource();
    await vi.advanceTimersByTimeAsync(250);
    expect(calls).toEqual([{ cacheText: "snapshot", skipIfUnchanged: false }]);
    await vi.advanceTimersByTimeAsync(400);
    expect(calls).toHaveLength(1);
  });

  it("holds refreshes while blocked and flushes once after unblock", async () => {
    const { queue, calls, setBlocked } = setup(true);
    queue.requestProgress("latest");
    await vi.advanceTimersByTimeAsync(250);
    expect(calls).toEqual([]);
    setBlocked(false);
    queue.notifyUnblocked();
    await Promise.resolve();
    expect(calls).toEqual([{ cacheText: "latest", skipIfUnchanged: false }]);
  });

  it("retries after the blocked window without an explicit notify", async () => {
    const { queue, calls, setBlocked } = setup(true);
    queue.requestProgress("retry");
    await vi.advanceTimersByTimeAsync(250);
    await vi.advanceTimersByTimeAsync(100);
    setBlocked(false);
    await vi.advanceTimersByTimeAsync(400);
    expect(calls).toEqual([{ cacheText: "retry", skipIfUnchanged: false }]);
  });

  it("applies a final refresh immediately when not blocked", async () => {
    const { queue, calls } = setup();
    queue.requestProgress("stale");
    await queue.requestFinal();
    expect(calls).toEqual([{ skipIfUnchanged: false }]);
    await vi.advanceTimersByTimeAsync(500);
    expect(calls).toHaveLength(1);
  });

  it("gives the final refresh priority over pending progress", async () => {
    const { queue, calls, setBlocked } = setup(true);
    queue.requestProgress("stale");
    await queue.requestFinal();
    expect(calls).toEqual([]);
    setBlocked(false);
    queue.notifyUnblocked();
    await Promise.resolve();
    expect(calls).toEqual([{ skipIfUnchanged: false }]);
  });

  it("lets a final refresh proceed when only progress is blocked", async () => {
    const calls: PreviewRefreshRequest[] = [];
    const queue = new PreviewRefreshQueue({
      isBlocked: (kind) => kind === "progress",
      apply: (request) => {
        calls.push({ ...request });
      },
    });
    queue.requestProgress("stale");
    await queue.requestFinal();
    expect(calls).toEqual([{ skipIfUnchanged: false }]);
    await vi.advanceTimersByTimeAsync(500);
    expect(calls).toHaveLength(1);
  });

  it("keeps a blocked final refresh when a progress batch lands", async () => {
    const calls: PreviewRefreshRequest[] = [];
    let finalBlocked = true;
    const queue = new PreviewRefreshQueue({
      isBlocked: (kind) => kind === "final" && finalBlocked,
      apply: (request) => {
        calls.push({ ...request });
      },
    });
    await queue.requestFinal();
    queue.requestProgress("batch-1");
    await vi.advanceTimersByTimeAsync(250);
    expect(calls).toEqual([{ cacheText: "batch-1", skipIfUnchanged: false }]);
    finalBlocked = false;
    queue.notifyUnblocked();
    await Promise.resolve();
    expect(calls).toEqual([
      { cacheText: "batch-1", skipIfUnchanged: false },
      { skipIfUnchanged: false },
    ]);
  });

  it("still refreshes source while progress is blocked", async () => {
    const calls: PreviewRefreshRequest[] = [];
    const queue = new PreviewRefreshQueue({
      isBlocked: (kind) => kind === "progress",
      apply: (request) => {
        calls.push({ ...request });
      },
    });
    queue.requestProgress("blocked");
    queue.requestSource();
    await vi.advanceTimersByTimeAsync(300);
    expect(calls).toEqual([{ skipIfUnchanged: true }]);
  });

  it("skips source refresh only when the rendered source is unchanged", () => {
    const base = {
      skipIfUnchanged: true,
      hasNotice: false,
      hasExportConfirmation: false,
      hasCacheOverride: false,
      sourceHash: "hash-a",
      lastRenderedSourceHash: "hash-a",
    };
    expect(shouldSkipUnchangedSourceRefresh(base)).toBe(true);
    expect(
      shouldSkipUnchangedSourceRefresh({ ...base, sourceHash: "hash-b" }),
    ).toBe(false);
    expect(
      shouldSkipUnchangedSourceRefresh({ ...base, skipIfUnchanged: false }),
    ).toBe(false);
    expect(
      shouldSkipUnchangedSourceRefresh({ ...base, hasNotice: true }),
    ).toBe(false);
    expect(
      shouldSkipUnchangedSourceRefresh({ ...base, hasExportConfirmation: true }),
    ).toBe(false);
    expect(
      shouldSkipUnchangedSourceRefresh({ ...base, hasCacheOverride: true }),
    ).toBe(false);
    expect(
      shouldSkipUnchangedSourceRefresh({ ...base, lastRenderedSourceHash: undefined }),
    ).toBe(false);
  });

  it("drops pending work on cancel and stops after dispose", async () => {
    const { queue, calls } = setup();
    queue.requestProgress("cancelled");
    queue.cancel();
    await vi.advanceTimersByTimeAsync(500);
    expect(calls).toEqual([]);

    queue.requestSource();
    queue.dispose();
    await vi.advanceTimersByTimeAsync(500);
    expect(calls).toEqual([]);
    queue.requestProgress("ignored");
    await vi.advanceTimersByTimeAsync(500);
    expect(calls).toEqual([]);
  });
});
