// @vitest-environment jsdom
/**
 * 分栏滚动同步：双语双向同步，以及仅原文/仅译文切换时的位置还原。
 *
 * jsdom 没有布局，这里为两个滚动容器和所有块安装一个 50px/块的虚拟几何：
 * scrollTop 参与 rect.top 的计算，因此锚点与映射逻辑可以像真实浏览器一样运行。
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/preact";
import { loadHarness, resetHarness, type WebviewHarness } from "./harness";
import { makeBlock, makeBoot, makeModel } from "./fixtures";

let harness: WebviewHarness;
const cellHeight = 50;
const paneHeight = 300;

beforeAll(async () => {
  harness = await loadHarness();
});

beforeEach(() => {
  resetHarness();
});

afterEach(() => {
  cleanup();
});

function rect(top: number, left: number, width: number, height: number): DOMRect {
  return {
    top,
    bottom: top + height,
    left,
    right: left + width,
    width,
    height,
    x: left,
    y: top,
    toJSON: () => ({}),
  } as DOMRect;
}

/** 让一侧的 scrollTop 与块几何、clientHeight、scrollHeight 形成真实布局关系。 */
function installGeometry(pane: HTMLElement, cells: HTMLElement[]): void {
  Object.defineProperty(pane, "clientHeight", {
    configurable: true,
    value: paneHeight,
  });
  Object.defineProperty(pane, "scrollHeight", {
    configurable: true,
    value: cells.length * cellHeight,
  });
  pane.getBoundingClientRect = () => rect(0, 0, 800, paneHeight);
  cells.forEach((cell, index) => {
    Object.defineProperty(cell, "offsetHeight", {
      configurable: true,
      value: cellHeight,
    });
    cell.getBoundingClientRect = () =>
      rect(index * cellHeight - pane.scrollTop, 0, 800, cellHeight);
  });
}

function setupSplit() {
  const blocks = Array.from({ length: 12 }, (_, index) =>
    makeBlock({
      key: String(index),
      blockIndex: index,
      sourceLine: index * 2 + 1,
      sourceHtml: `<p>Source ${index}</p>`,
      targetHtml: `<p>译文 ${index}</p>`,
      sourceRaw: `Source ${index}`,
      targetRaw: `译文 ${index}`,
      sourceHash: `hash-${index}`,
      cacheId: `cache-${index}`,
    }),
  );
  const result = render(
    <harness.App
      boot={makeBoot(makeModel({ blocks }), { layout: "split" })}
      text={harness.text}
    />,
  );
  const sourcePane = result.container.querySelector(
    '.pv-split-pane[data-pane="source"] .pv-split-scroll',
  ) as HTMLElement;
  const targetPane = result.container.querySelector(
    '.pv-split-pane[data-pane="target"] .pv-split-scroll',
  ) as HTMLElement;
  const sourceCells = Array.from(
    sourcePane.querySelectorAll<HTMLElement>(".pv-cell[data-sync-key]"),
  );
  const targetCells = Array.from(
    targetPane.querySelectorAll<HTMLElement>(".pv-cell[data-sync-key]"),
  );
  installGeometry(sourcePane, sourceCells);
  installGeometry(targetPane, targetCells);
  return { ...result, sourcePane, targetPane };
}

function scroll(pane: HTMLElement, top: number): void {
  pane.scrollTop = top;
  fireEvent.scroll(pane);
}

describe("split scroll synchronization", () => {
  it("mirrors scrolling in bilingual mode", async () => {
    const { sourcePane, targetPane } = setupSplit();

    scroll(sourcePane, 120);
    expect(targetPane.scrollTop).toBe(120);
    // 等过程写入触发的 90ms 回声锁过期，模拟用户换手滚动另一侧。
    await new Promise((resolve) => setTimeout(resolve, 100));
    scroll(targetPane, 220);
    expect(sourcePane.scrollTop).toBe(220);
  });

  it("restores the source scroll position after switching to target-only", () => {
    const { sourcePane, targetPane } = setupSplit();
    const text = harness.text.preview;

    // 双语下先同步一次，再切到仅原文并滚动。
    scroll(sourcePane, 100);
    expect(targetPane.scrollTop).toBe(100);
    fireEvent.click(screen.getByRole("button", { name: text.toolbar.sourceOnly }));
    scroll(sourcePane, 200);

    fireEvent.click(screen.getByRole("button", { name: text.toolbar.targetOnly }));
    expect(targetPane.scrollTop).toBe(200);
  });

  it("restores the target scroll position after switching back to source-only", () => {
    const { sourcePane, targetPane } = setupSplit();
    const text = harness.text.preview;

    fireEvent.click(screen.getByRole("button", { name: text.toolbar.targetOnly }));
    scroll(targetPane, 260);

    fireEvent.click(screen.getByRole("button", { name: text.toolbar.sourceOnly }));
    expect(sourcePane.scrollTop).toBe(260);
  });

  it("keeps top and bottom alignment across mode switches", () => {
    const { sourcePane, targetPane } = setupSplit();
    const text = harness.text.preview;

    fireEvent.click(screen.getByRole("button", { name: text.toolbar.sourceOnly }));
    scroll(sourcePane, 300);
    fireEvent.click(screen.getByRole("button", { name: text.toolbar.targetOnly }));
    expect(targetPane.scrollTop).toBe(300);

    scroll(targetPane, 0);
    fireEvent.click(screen.getByRole("button", { name: text.toolbar.sourceOnly }));
    expect(sourcePane.scrollTop).toBe(0);
  });

  it("re-aligns both panes when returning to bilingual mode", () => {
    const { sourcePane, targetPane } = setupSplit();
    const text = harness.text.preview;

    fireEvent.click(screen.getByRole("button", { name: text.toolbar.sourceOnly }));
    scroll(sourcePane, 150);
    fireEvent.click(screen.getByRole("button", { name: text.toolbar.targetOnly }));
    expect(targetPane.scrollTop).toBe(150);

    fireEvent.click(screen.getByRole("button", { name: text.toolbar.bilingual }));
    expect(sourcePane.scrollTop).toBe(150);
    expect(targetPane.scrollTop).toBe(150);
  });
});
