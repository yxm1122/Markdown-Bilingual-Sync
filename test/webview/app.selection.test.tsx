// @vitest-environment jsdom
/** 测试：块多选、批量动作、任务活动锁定与任务面板入口。 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/preact";
import {
  actions,
  loadHarness,
  postHostMessage,
  resetHarness,
  type WebviewHarness,
} from "./harness";
import { makeBlock, makeBoot, makeModel, makeState } from "./fixtures";

let harness: WebviewHarness;

beforeAll(async () => {
  harness = await loadHarness();
});

beforeEach(() => {
  resetHarness();
});

afterEach(() => {
  cleanup();
});

function selectionModel() {
  return makeModel({
    blocks: [
      makeBlock({
        key: "0",
        blockIndex: 0,
        sourceLine: 1,
        cacheId: "cache-0",
        sourceHash: "hash-0",
        canMarkSynced: true,
      }),
      makeBlock({
        key: "1",
        blockIndex: 1,
        sourceLine: 3,
        status: "human",
        human: true,
        cacheId: "cache-1",
        sourceHash: "hash-1",
      }),
      makeBlock({
        key: "2",
        blockIndex: 2,
        sourceLine: 5,
        status: "stale",
        cacheId: "cache-2",
        sourceHash: "hash-2",
        canMarkSynced: true,
      }),
    ],
  });
}

function enterSelection(container: Element): void {
  fireEvent.click(
    screen.getByTitle(harness.text.preview.toolbar.selectBlocksTitle),
  );
  expect(container.querySelector(".pv-selection-bar")).toBeTruthy();
}

describe("block multi-select", () => {
  it("selects blocks and sends one bulk retranslate selection including locked human blocks", () => {
    const { container } = render(
      <harness.App boot={makeBoot(selectionModel())} text={harness.text} />,
    );
    const text = harness.text.preview;
    enterSelection(container);

    const checkboxes = screen.getAllByRole("checkbox");
    fireEvent.click(checkboxes[0]);
    fireEvent.click(checkboxes[1]);
    expect(screen.getByText("已选 2 块")).toBeTruthy();

    fireEvent.click(screen.getByTitle(text.selection.retranslate));

    expect(actions(harness)).toContainEqual({
      type: "retranslateBlocks",
      blocks: [
        {
          blockIndex: 0,
          sourceHash: "hash-0",
          cacheId: "cache-0",
          human: false,
        },
        {
          blockIndex: 1,
          sourceHash: "hash-1",
          cacheId: "cache-1",
          human: true,
        },
      ],
    });
  });

  it("supports shift-click range selection", () => {
    const { container } = render(
      <harness.App boot={makeBoot(selectionModel())} text={harness.text} />,
    );
    enterSelection(container);

    fireEvent.click(screen.getAllByRole("checkbox")[0]);
    const thirdContent = container
      .querySelectorAll(".pv-block")[2]
      .querySelector(".pv-md");
    fireEvent.click(thirdContent as HTMLElement, { shiftKey: true });

    expect(screen.getByText("已选 3 块")).toBeTruthy();
  });

  it("sends each bulk action with the same selectors", () => {
    const { container } = render(
      <harness.App boot={makeBoot(selectionModel())} text={harness.text} />,
    );
    const text = harness.text.preview;
    enterSelection(container);
    fireEvent.click(screen.getAllByRole("checkbox")[0]);

    fireEvent.click(screen.getByTitle(text.selection.review));
    fireEvent.click(screen.getByTitle(text.selection.backTranslate));
    fireEvent.click(screen.getByTitle(text.selection.markSynced));
    fireEvent.click(screen.getByTitle(text.selection.deleteTranslation));

    const types = actions(harness).map((message) => message.type);
    expect(types).toEqual([
      "reviewBlocks",
      "backTranslateBlocks",
      "markSyncedBlocks",
      "deleteTargetBlocks",
    ]);
  });

  it("exits selection with Escape", () => {
    const { container } = render(
      <harness.App boot={makeBoot(selectionModel())} text={harness.text} />,
    );
    enterSelection(container);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(container.querySelector(".pv-selection-bar")).toBeNull();
  });

  it("drops a selection when the selected block changes", () => {
    const boot = makeBoot(selectionModel());
    const { container } = render(
      <harness.App boot={boot} text={harness.text} />,
    );
    enterSelection(container);
    fireEvent.click(screen.getAllByRole("checkbox")[0]);
    expect(screen.getByText("已选 1 块")).toBeTruthy();

    const blocks = boot.state.model.blocks.map((block, index) =>
      index === 0 ? { ...block, sourceHash: "hash-0-changed" } : block,
    );
    postHostMessage({
      type: "state",
      state: makeState({
        ...boot.state.model,
        blocks,
      }),
    });
    expect(screen.getByText("已选 0 块")).toBeTruthy();
  });

  it("keeps one selection checkbox per block in split view", () => {
    const { container } = render(
      <harness.App
        boot={makeBoot(selectionModel(), { layout: "split" })}
        text={harness.text}
      />,
    );
    enterSelection(container);
    expect(screen.getAllByRole("checkbox")).toHaveLength(3);

    const sourcePane = container.querySelector(
      '.pv-split-pane[data-pane="source"]',
    ) as HTMLElement;
    fireEvent.click(
      within(sourcePane).getByTitle(
        harness.text.preview.actions.readonlyPreviewTitle,
      ),
    );
    expect(sourcePane.className).toContain("is-readonly");
    expect(screen.getAllByRole("checkbox")).toHaveLength(3);
  });
});

describe("task activity in the preview", () => {
  it("locks editing but keeps enqueue actions available", () => {
    const { container } = render(
      <harness.App boot={makeBoot(selectionModel())} text={harness.text} />,
    );
    postHostMessage({ type: "taskActivity", running: 1, queued: 0 });

    const activity = screen.getByTitle(
      harness.text.preview.toolbar.taskActivityTitle,
    );
    expect(activity.textContent).toContain("1 运行 · 0 排队");

    fireEvent.click(container.querySelector(".pv-md") as HTMLElement);
    expect(container.querySelector("textarea")).toBeNull();

    const sync = screen.getByRole("button", {
      name: harness.text.preview.toolbar.sync,
    });
    expect((sync as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(sync);
    expect(actions(harness)).toContainEqual({ type: "sync" });

    fireEvent.click(
      screen.getByTitle(harness.text.preview.toolbar.selectBlocksTitle),
    );
    expect(container.querySelector(".pv-selection-bar")).toBeTruthy();
  });

  it("opens the task panel from the activity indicator", () => {
    render(
      <harness.App boot={makeBoot(selectionModel())} text={harness.text} />,
    );
    postHostMessage({ type: "taskActivity", running: 0, queued: 2 });
    fireEvent.click(
      screen.getByTitle(harness.text.preview.toolbar.taskActivityTitle),
    );
    expect(actions(harness)).toContainEqual({ type: "openTaskPanel" });
  });
});
