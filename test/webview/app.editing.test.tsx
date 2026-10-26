// @vitest-environment jsdom
/**
 * 预览交互：译文/原文编辑、插入、删除与撤销、链接、菜单键盘行为。
 */
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
import { makeBlock, makeBoot, makeModel } from "./fixtures";

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

function firstBlock(container: Element): HTMLElement {
  return container.querySelector(".pv-block") as HTMLElement;
}

function openBlockMenu(block: HTMLElement): void {
  const button = block.querySelector(
    '.pv-block-head .pv-action[aria-label]',
  ) as HTMLElement;
  fireEvent.click(button);
}

describe("preview editing", () => {
  it("edits a target block and sends the full concurrency context", () => {
    const model = makeModel();
    const { container } = render(
      <harness.App boot={makeBoot(model)} text={harness.text} />,
    );
    const block = firstBlock(container);
    const textarea = (() => {
      fireEvent.click(block.querySelector(".pv-pane-target .pv-md") as HTMLElement);
      return within(block).getByRole("textbox", {
        name: harness.text.preview.actions.targetEditHint,
      }) as HTMLTextAreaElement;
    })();

    expect(textarea.value).toBe(model.blocks[0].targetRaw);
    expect(document.activeElement).toBe(textarea);

    fireEvent.input(textarea, { target: { value: "新的译文" } });
    fireEvent.click(
      within(block).getByRole("button", {
        name: harness.text.preview.actions.saveTarget,
      }),
    );

    expect(actions(harness)).toContainEqual({
      type: "saveTargetEdit",
      blockIndex: 0,
      text: "新的译文",
      baseText: "你好，世界。",
      sourceHash: "source-hash-0",
      cacheId: "cache-0",
    });
    expect(within(block).queryByRole("textbox")).toBeNull();
  });

  it("stages a source edit without writing the file", () => {
    const { container } = render(
      <harness.App boot={makeBoot(makeModel())} text={harness.text} />,
    );
    const block = firstBlock(container);

    fireEvent.click(block.querySelector(".pv-pane-source .pv-md") as HTMLElement);
    const textarea = within(block).getByRole("textbox", {
      name: harness.text.preview.actions.sourceEditHint,
    }) as HTMLTextAreaElement;
    fireEvent.input(textarea, { target: { value: "Hello edited." } });
    fireEvent.click(
      within(block).getByRole("button", {
        name: harness.text.preview.actions.saveSourceStage,
      }),
    );

    expect(actions(harness)).toContainEqual({
      type: "stageSourceEdit",
      blockIndex: 0,
      text: "Hello edited.",
      sourceHash: "source-hash-0",
    });
  });

  it("cancels with Escape and saves with Ctrl+Enter", () => {
    const { container } = render(
      <harness.App boot={makeBoot(makeModel())} text={harness.text} />,
    );
    const block = firstBlock(container);

    fireEvent.click(block.querySelector(".pv-pane-target .pv-md") as HTMLElement);
    let textarea = within(block).getByRole("textbox") as HTMLTextAreaElement;
    fireEvent.keyDown(textarea, { key: "Escape" });
    expect(within(block).queryByRole("textbox")).toBeNull();

    fireEvent.click(block.querySelector(".pv-pane-target .pv-md") as HTMLElement);
    textarea = within(block).getByRole("textbox") as HTMLTextAreaElement;
    fireEvent.input(textarea, { target: { value: "键盘保存" } });
    fireEvent.keyDown(textarea, { key: "Enter", ctrlKey: true });
    expect(actions(harness)).toContainEqual(
      expect.objectContaining({ type: "saveTargetEdit", text: "键盘保存" }),
    );
  });

  it("rejects an empty edit and keeps the editor open", () => {
    const { container } = render(
      <harness.App boot={makeBoot(makeModel())} text={harness.text} />,
    );
    const block = firstBlock(container);
    fireEvent.click(block.querySelector(".pv-pane-target .pv-md") as HTMLElement);
    const textarea = within(block).getByRole("textbox") as HTMLTextAreaElement;

    fireEvent.input(textarea, { target: { value: "   " } });
    fireEvent.click(
      within(block).getByRole("button", {
        name: harness.text.preview.actions.saveTarget,
      }),
    );

    expect(screen.getByText(harness.text.preview.actions.emptyEdit)).toBeTruthy();
    expect(within(block).getByRole("textbox")).toBeTruthy();
    expect(actions(harness)).toEqual([]);
  });

  it("does not edit blocks without a cache entry or while busy", () => {
    const locked = makeModel({
      blocks: [makeBlock({ canEditTarget: false, status: "copy", human: false })],
    });
    const { container, rerender } = render(
      <harness.App boot={makeBoot(locked)} text={harness.text} />,
    );
    fireEvent.click(firstBlock(container).querySelector(".pv-pane-target .pv-md") as HTMLElement);
    expect(screen.queryByRole("textbox")).toBeNull();

    rerender(
      <harness.App boot={makeBoot(makeModel())} text={harness.text} />,
    );
    postHostMessage({ type: "busy", busy: true });
    fireEvent.click(
      firstBlock(container).querySelector(".pv-pane-target .pv-md") as HTMLElement,
    );
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("edits a pending source insert through updateSourceInsert", () => {
    const model = makeModel({
      blocks: [
        makeBlock({
          key: "pending:p1",
          blockIndex: -1000,
          pendingInsertId: "p1",
          status: "untranslated",
          sourceRaw: "Inserted paragraph.",
          sourceHtml: "<p>Inserted paragraph.</p>",
          targetHtml: "",
          sourceHash: "",
          cacheId: undefined,
          canEditTarget: false,
          canBackTranslate: false,
        }),
      ],
    });
    const { container } = render(
      <harness.App boot={makeBoot(model)} text={harness.text} />,
    );
    const block = firstBlock(container);

    fireEvent.click(block.querySelector(".pv-pane-source .pv-md") as HTMLElement);
    const textarea = within(block).getByRole("textbox", {
      name: harness.text.preview.actions.sourceEditHint,
    }) as HTMLTextAreaElement;
    expect(textarea.value).toBe("Inserted paragraph.");
    fireEvent.input(textarea, { target: { value: "Updated insert." } });
    fireEvent.click(
      within(block).getByRole("button", {
        name: harness.text.preview.actions.saveSourceStage,
      }),
    );

    expect(actions(harness)).toContainEqual({
      type: "updateSourceInsert",
      pendingId: "p1",
      text: "Updated insert.",
    });
  });

  it("edits and deletes a standalone target block", () => {
    const model = makeModel({
      blocks: [
        makeBlock({
          key: "standalone:s1",
          blockIndex: -3000,
          standaloneTargetId: "s1",
          status: "human",
          human: true,
          sourceRaw: "",
          sourceHtml: "",
          targetRaw: "独立译文",
          targetHtml: "<p>独立译文</p>",
          sourceHash: "",
          cacheId: undefined,
          canEditTarget: true,
        }),
      ],
    });
    const { container } = render(
      <harness.App boot={makeBoot(model)} text={harness.text} />,
    );
    const block = firstBlock(container);

    expect(
      within(block).getByText(harness.text.preview.actions.standaloneSourceEmpty),
    ).toBeTruthy();
    fireEvent.click(block.querySelector(".pv-pane-target .pv-md") as HTMLElement);
    const textarea = within(block).getByRole("textbox", {
      name: harness.text.preview.actions.standaloneEditHint,
    }) as HTMLTextAreaElement;
    fireEvent.input(textarea, { target: { value: "更新后的独立译文" } });
    fireEvent.click(
      within(block).getByRole("button", {
        name: harness.text.preview.actions.saveStandaloneTarget,
      }),
    );
    expect(actions(harness)).toContainEqual({
      type: "updateStandaloneTarget",
      standaloneId: "s1",
      text: "更新后的独立译文",
    });

    openBlockMenu(block);
    fireEvent.click(
      screen.getByRole("menuitem", {
        name: harness.text.preview.actions.removeStandalone,
      }),
    );
    expect(actions(harness)).toContainEqual({
      type: "deleteTargetOnlyBlock",
      standaloneId: "s1",
    });
  });

  it("inserts a source block after the chosen block", () => {
    const { container } = render(
      <harness.App boot={makeBoot(makeModel())} text={harness.text} />,
    );
    const text = harness.text.preview;
    const block = firstBlock(container);
    openBlockMenu(block);
    fireEvent.click(
      screen.getByRole("menuitem", {
        name: `${text.actions.insertBlock}: ${text.actions.sourceChoice}`,
      }),
    );

    const textarea = screen.getByPlaceholderText(
      text.actions.insertPlaceholder,
    ) as HTMLTextAreaElement;
    expect(document.activeElement).toBe(textarea);
    fireEvent.input(textarea, { target: { value: "New paragraph." } });
    fireEvent.click(
      screen.getByRole("button", { name: text.actions.stageInsert }),
    );

    expect(actions(harness)).toContainEqual({
      type: "insertSourceBlock",
      afterBlockIndex: 0,
      text: "New paragraph.",
    });
    expect(screen.queryByPlaceholderText(text.actions.insertPlaceholder)).toBeNull();
  });

  it("inserts a source block at the start from the toolbar menu", () => {
    const { container } = render(
      <harness.App boot={makeBoot(makeModel())} text={harness.text} />,
    );
    const text = harness.text.preview;
    fireEvent.click(screen.getByTitle(text.toolbar.moreActions));
    fireEvent.click(
      screen.getByRole("menuitem", { name: text.actions.insertAtStart }),
    );

    const editor = container.querySelector(".pv-paired > .pv-editor");
    expect(editor).toBeTruthy();
    const textarea = within(editor as HTMLElement).getByRole("textbox");
    fireEvent.input(textarea, { target: { value: "First block." } });
    fireEvent.click(
      within(editor as HTMLElement).getByRole("button", {
        name: text.actions.stageInsert,
      }),
    );
    expect(actions(harness)).toContainEqual({
      type: "insertSourceBlock",
      afterBlockIndex: -1,
      text: "First block.",
    });
  });

  it("rejects an empty insert", () => {
    const { container } = render(
      <harness.App boot={makeBoot(makeModel())} text={harness.text} />,
    );
    const text = harness.text.preview;
    openBlockMenu(firstBlock(container));
    fireEvent.click(
      screen.getByRole("menuitem", {
        name: `${text.actions.insertBlock}: ${text.actions.sourceChoice}`,
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: text.actions.stageInsert }));

    expect(screen.getByText(text.actions.emptyEdit)).toBeTruthy();
    expect(actions(harness)).toEqual([]);
  });

  it("undoes target and source deletions from the block menu", () => {
    const model = makeModel({
      blocks: [
        makeBlock({ status: "deleted", human: true, targetHtml: "", canEditTarget: false }),
        makeBlock({
          key: "1",
          blockIndex: 1,
          sourceDeleted: true,
          sourcePending: true,
          sourceHtml: "<p>Original.</p>",
        }),
      ],
    });
    const { container } = render(
      <harness.App boot={makeBoot(model)} text={harness.text} />,
    );
    const blocks = container.querySelectorAll(".pv-block");
    const text = harness.text.preview;

    expect(
      within(blocks[0] as HTMLElement).getByText(text.placeholders.skipped),
    ).toBeTruthy();
    openBlockMenu(blocks[0] as HTMLElement);
    fireEvent.click(screen.getByRole("menuitem", { name: text.actions.undoDelete }));
    expect(actions(harness)).toContainEqual({ type: "undoDeleteTargetBlock", blockIndex: 0 });

    openBlockMenu(blocks[1] as HTMLElement);
    fireEvent.click(screen.getByRole("menuitem", { name: text.actions.undoDelete }));
    expect(actions(harness)).toContainEqual({ type: "undoDeleteSourceBlock", blockIndex: 1 });
  });

  it("removes a pending insert from the block menu", () => {
    const model = makeModel({
      blocks: [
        makeBlock({
          key: "pending:p1",
          blockIndex: -1000,
          pendingInsertId: "p1",
          status: "untranslated",
          sourceRaw: "Inserted.",
          sourceHtml: "<p>Inserted.</p>",
          targetHtml: "",
          sourceHash: "",
          cacheId: undefined,
        }),
      ],
    });
    const { container } = render(
      <harness.App boot={makeBoot(model)} text={harness.text} />,
    );
    openBlockMenu(firstBlock(container));
    fireEvent.click(
      screen.getByRole("menuitem", {
        name: harness.text.preview.actions.removeInsert,
      }),
    );
    expect(actions(harness)).toContainEqual({
      type: "removeSourceInsert",
      pendingId: "p1",
    });
  });

  it("opens Markdown links through the host", () => {
    const model = makeModel({
      blocks: [
        makeBlock({
          sourceHtml: '<p><a href="#" data-mbs-href="https://example.com/doc">Doc</a></p>',
        }),
      ],
    });
    const { container } = render(
      <harness.App boot={makeBoot(model)} text={harness.text} />,
    );
    fireEvent.click(within(container as HTMLElement).getByText("Doc"));
    expect(actions(harness)).toContainEqual({
      type: "openLink",
      href: "https://example.com/doc",
    });
    // 链接点击不应同时进入编辑。
    expect(container.querySelector("textarea")).toBeNull();
  });

  it("navigates the block menu with arrows, Home/End and Escape", () => {
    const { container } = render(
      <harness.App boot={makeBoot(makeModel())} text={harness.text} />,
    );
    openBlockMenu(firstBlock(container));
    const menu = screen.getByRole("menu");
    const items = within(menu).getAllByRole("menuitem");
    expect(document.activeElement).toBe(items[0]);

    fireEvent.keyDown(document, { key: "ArrowDown" });
    expect(document.activeElement).toBe(items[1]);
    fireEvent.keyDown(document, { key: "End" });
    expect(document.activeElement).toBe(items[items.length - 1]);
    fireEvent.keyDown(document, { key: "Home" });
    expect(document.activeElement).toBe(items[0]);
    fireEvent.keyDown(document, { key: "ArrowUp" });
    expect(document.activeElement).toBe(items[items.length - 1]);

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
  });
});
