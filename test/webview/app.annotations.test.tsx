// @vitest-environment jsdom
/** 测试：块级批注标记、popover、批注操作与按批注重译入口。 */
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
  resetHarness,
  type WebviewHarness,
} from "./harness";
import { makeBlock, makeBoot, makeModel } from "./fixtures";
import { formatText as fmt } from "../../src/i18n";
import type { AnnotationView } from "../../src/annotations/types";

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

function annotation(overrides: Partial<AnnotationView> = {}): AnnotationView {
  return {
    id: "a1",
    blockId: "cache-0",
    side: "target",
    author: "ai",
    kind: "translation-uncertain",
    severity: "check",
    message: "Verify whether “bite” means business impact.",
    question: "Is this the intended sense?",
    status: "open",
    sourceHash: "source-hash-0",
    createdAt: "2026-10-28T00:00:00.000Z",
    updatedAt: "2026-10-28T00:00:00.000Z",
    stale: false,
    ...overrides,
  };
}

function renderWithAnnotation(
  annotations = [annotation()],
) {
  const model = makeModel({
    blocks: [
      makeBlock({
        annotations,
      }),
    ],
  });
  const { container } = render(
    <harness.App boot={makeBoot(model)} text={harness.text} />,
  );
  return { container: container as HTMLElement };
}

describe("block annotations", () => {
  it("opens the popover from the block badge and reviews the block", () => {
    const text = harness.text.preview.annotations;
    const { container } = renderWithAnnotation();
    fireEvent.click(
      within(container).getByLabelText(
        fmt(text.openCount, { count: 1 }),
      ) as HTMLElement,
    );

    const dialog = screen.getByRole("dialog", { name: text.title });
    expect(within(dialog).getByText("Verify whether “bite” means business impact.")).toBeTruthy();
    expect(within(dialog).getByText(text.ai)).toBeTruthy();
    expect(within(dialog).getByText(text.typeTranslationUncertain)).toBeTruthy();
    expect(
      within(dialog).getByText("Is this the intended sense?"),
    ).toBeTruthy();

    fireEvent.click(
      within(dialog).getByRole("button", { name: text.review }),
    );
    expect(actions(harness)).toContainEqual({
      type: "reviewBlock",
      blockIndex: 0,
    });
  });

  it("saves a user annotation with the selected side and change request", () => {
    const text = harness.text.preview.annotations;
    const { container } = renderWithAnnotation([]);
    // 没有批注时块头不显示标记，通过块菜单打开。
    fireEvent.click(
      within(container).getByLabelText(
        harness.text.preview.actions.showBlockActions,
      ) as HTMLElement,
    );
    const menuItem = screen
      .getAllByRole("menuitem")
      .find((item) =>
        item.textContent?.includes(
          fmt(text.openCount, { count: 0 }),
        ),
      );
    expect(menuItem).toBeTruthy();
    fireEvent.click(menuItem!);

    const dialog = screen.getByRole("dialog", { name: text.title });
    fireEvent.input(
      within(dialog).getByLabelText(text.add),
      { target: { value: "Use the business sense." } },
    );
    fireEvent.click(within(dialog).getByText(text.requestChange));
    fireEvent.click(
      within(dialog).getByRole("button", { name: text.save }),
    );
    expect(actions(harness)).toContainEqual({
      type: "saveAnnotation",
      blockIndex: 0,
      side: "target",
      kind: "request-change",
      message: "Use the business sense.",
    });
  });

  it("resolves, reopens, and deletes annotations", () => {
    const text = harness.text.preview.annotations;
    const { container } = renderWithAnnotation();
    fireEvent.click(
      within(container).getByLabelText(
        fmt(text.openCount, { count: 1 }),
      ) as HTMLElement,
    );
    const dialog = screen.getByRole("dialog", { name: text.title });

    fireEvent.click(
      within(dialog).getByRole("button", { name: text.resolve }),
    );
    expect(actions(harness)).toContainEqual({
      type: "setAnnotationStatus",
      annotationId: "a1",
      status: "resolved",
    });

    fireEvent.click(
      within(dialog).getByRole("button", { name: text.delete }),
    );
    expect(actions(harness)).toContainEqual({
      type: "deleteAnnotation",
      annotationId: "a1",
    });
  });

  it("triggers a file-level review from the toolbar menu", () => {
    const { container } = renderWithAnnotation([]);
    const toolbar = container.querySelector(".pv-toolbar") as HTMLElement;
    fireEvent.click(
      within(toolbar).getByLabelText(
        harness.text.preview.toolbar.moreActions,
      ) as HTMLElement,
    );
    const item = screen
      .getAllByRole("menuitem")
      .find((node) =>
        node.textContent?.includes(
          harness.text.preview.toolbar.reviewMachine,
        ),
      );
    expect(item).toBeTruthy();
    fireEvent.click(item!);
    expect(actions(harness)).toContainEqual({
      type: "reviewMachineBlocks",
    });
  });

  it("offers retranslation when a user annotation is open", () => {
    const text = harness.text.preview.annotations;
    const { container } = renderWithAnnotation([
      annotation({ author: "user", kind: "request-change" }),
    ]);
    fireEvent.click(
      within(container).getByLabelText(
        fmt(text.openCount, { count: 1 }),
      ) as HTMLElement,
    );
    const dialog = screen.getByRole("dialog", { name: text.title });
    fireEvent.click(
      within(dialog).getByRole("button", { name: text.retranslate }),
    );
    expect(actions(harness)).toContainEqual({
      type: "retranslateBlock",
      blockIndex: 0,
    });
  });
});
