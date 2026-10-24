/** 测试：共享并发限制器的计数与等待队列。 */
import { describe, expect, it } from "vitest";
import { runWithConcurrency } from "../src/batch/concurrency";
import { ConcurrencyLimiter } from "../src/translation/concurrency";

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

describe("runWithConcurrency", () => {
  it("processes every item with a bounded number of workers", async () => {
    const processed: number[] = [];
    let active = 0;
    let maximum = 0;

    await runWithConcurrency(Array.from({ length: 8 }, (_, i) => i), 3, async (item) => {
      active += 1;
      maximum = Math.max(maximum, active);
      await delay(5);
      processed.push(item);
      active -= 1;
    });

    expect(processed).toHaveLength(8);
    expect(new Set(processed).size).toBe(8);
    expect(maximum).toBeLessThanOrEqual(3);
    expect(maximum).toBeGreaterThan(1);
  });

  it("stops scheduling new items after cancellation", async () => {
    const controller = new AbortController();
    const processed: number[] = [];

    await runWithConcurrency(
      Array.from({ length: 10 }, (_, i) => i),
      2,
      async (item) => {
        processed.push(item);
        if (processed.length === 2) {
          controller.abort();
        }
        await delay(5);
      },
      controller.signal,
    );

    expect(processed.length).toBeLessThan(10);
  });

  it("handles an empty list and invalid limits", async () => {
    let calls = 0;
    await runWithConcurrency([], 2, async () => {
      calls += 1;
    });
    expect(calls).toBe(0);

    await runWithConcurrency([1], Number.NaN, async () => {
      calls += 1;
    });
    expect(calls).toBe(1);
  });
});

describe("ConcurrencyLimiter", () => {
  it("caps concurrent tasks at the shared limit", async () => {
    const limiter = new ConcurrencyLimiter(() => 2);
    let active = 0;
    let maximum = 0;

    await Promise.all(
      Array.from({ length: 6 }, () =>
        limiter.run(async () => {
          active += 1;
          maximum = Math.max(maximum, active);
          await delay(5);
          active -= 1;
        }),
      ),
    );

    expect(maximum).toBe(2);
  });

  it("rejects queued tasks when their signal aborts", async () => {
    const limiter = new ConcurrencyLimiter(() => 1);
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = limiter.run(async () => {
      await gate;
    });
    const controller = new AbortController();
    const second = limiter.run(async () => {}, controller.signal);

    controller.abort();
    await expect(second).rejects.toThrow(/已取消/);
    release();
    await first;
  });
});
