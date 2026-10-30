// @vitest-environment jsdom
/** 测试：块级批注标记、popover、生效状态、编辑与建议回答。 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/preact";
import {
  actions,
  loadHarness,
  postHostMessage,
  resetHarness,
  type WebviewHarness,
} from "./harness";
import { MAX_ANNOTATION_MESSAGE } from "../../src/annotations/types";
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
  blockOverrides: Parameters<typeof makeBlock>[0] = {},
) {
  const model = makeModel({
    blocks: [
      makeBlock({
        annotations,
        ...blockOverrides,
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

  it("groups AI and user annotations and keeps the popover open on scroll", () => {
    const text = harness.text.preview.annotations;
    const { container } = renderWithAnnotation([
      annotation(),
      annotation({
        id: "u1",
        author: "user",
        kind: "request-change",
        message: "My note",
      }),
    ]);
    fireEvent.click(
      within(container).getByLabelText(
        fmt(text.openCount, { count: 2 }),
      ) as HTMLElement,
    );
    const dialog = screen.getByRole("dialog", { name: text.title });
    const meta = dialog.querySelector(".pv-annotation-meta") as HTMLElement;
    expect(meta.querySelector(".pv-annotation-tags")).toBeTruthy();
    expect(
      meta.querySelector(".pv-annotation-side-label")?.textContent,
    ).toContain("译文");
    expect(
      dialog.querySelector(".pv-annotation-meta .pv-annotation-side"),
    ).toBeNull();
    const aiHead = within(dialog).getByText(text.ai).closest(
      "button",
    ) as HTMLButtonElement;
    const userHead = within(dialog).getByText(text.user).closest(
      "button",
    ) as HTMLButtonElement;
    expect(aiHead.getAttribute("aria-expanded")).toBe("true");
    expect(userHead.getAttribute("aria-expanded")).toBe("true");

    fireEvent.click(aiHead);
    expect(aiHead.getAttribute("aria-expanded")).toBe("false");
    expect(
      within(dialog).queryByText(
        "Verify whether “bite” means business impact.",
      ),
    ).toBeNull();
    expect(within(dialog).getByText("My note")).toBeTruthy();

    fireEvent.scroll(window);
    expect(screen.getByRole("dialog", { name: text.title })).toBeTruthy();
  });

  it("focuses the composer and returns focus to the badge on close", async () => {
    const text = harness.text.preview.annotations;
    const { container } = renderWithAnnotation();
    const badge = within(container).getByLabelText(
      fmt(text.openCount, { count: 1 }),
    ) as HTMLElement;
    fireEvent.click(badge);
    const dialog = screen.getByRole("dialog", { name: text.title });
    expect(document.activeElement).toBe(
      within(dialog).getByLabelText(text.add),
    );
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => {
      expect(
        screen.queryByRole("dialog", { name: text.title }),
      ).toBeNull();
    });
    await waitFor(() => {
      expect(document.activeElement).toBe(badge);
    });
  });

  it("keeps the annotation draft until the host confirms it", async () => {
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
    const compose = within(dialog).getByLabelText(
      text.add,
    ) as HTMLTextAreaElement;
    expect(document.activeElement).toBe(compose);
    expect(compose.maxLength).toBe(MAX_ANNOTATION_MESSAGE);
    fireEvent.input(compose, {
      target: { value: "Use the business sense." },
    });
    fireEvent.click(
      within(dialog).getByRole("button", { name: text.save }),
    );
    expect(actions(harness)).toContainEqual({
      type: "saveAnnotation",
      blockIndex: 0,
      side: "target",
      mode: "once",
      message: "Use the business sense.",
      sourceHash: "source-hash-0",
      cacheId: "cache-0",
    });
    expect(compose.value).toBe("Use the business sense.");

    postHostMessage({
      type: "state",
      state: makeBoot(
        makeModel({
          blocks: [
            makeBlock({
              annotations: [
                annotation({
                  id: "u1",
                  author: "user",
                  kind: "request-change",
                  mode: "once",
                  status: "pending",
                  message: "Use the business sense.",
                }),
              ],
            }),
          ],
        }),
      ).state,
    });
    await waitFor(() => {
      const current = within(
        screen.getByRole("dialog", { name: text.title }),
      ).getByLabelText(text.add) as HTMLTextAreaElement;
      expect(current.value).toBe("");
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

  it("triggers a file-level review from the toolbar", () => {
    const { container } = renderWithAnnotation([]);
    const toolbar = container.querySelector(".pv-toolbar") as HTMLElement;
    fireEvent.click(
      within(toolbar).getByRole("button", {
        name: harness.text.preview.toolbar.reviewMachine,
      }),
    );
    expect(actions(harness)).toContainEqual({
      type: "reviewMachineBlocks",
    });
  });

  it("shows user annotation state and retries ineffective annotations", () => {
    const text = harness.text.preview.annotations;
    const { container } = renderWithAnnotation([
      annotation({
        id: "u1",
        author: "user",
        kind: "request-change",
        mode: "once",
        status: "ineffective",
        message: "Apply this change.",
      }),
    ]);
    fireEvent.click(
      within(container).getByLabelText(
        fmt(text.openCount, { count: 1 }),
      ) as HTMLElement,
    );
    const dialog = screen.getByRole("dialog", { name: text.title });
    expect(within(dialog).getByText(text.statusIneffective)).toBeTruthy();
    expect(
      within(dialog).queryByRole("button", { name: text.resolve }),
    ).toBeNull();
    fireEvent.click(
      within(dialog).getByRole("button", { name: text.retry }),
    );
    expect(actions(harness)).toContainEqual({
      type: "updateAnnotation",
      annotationId: "u1",
      reactivate: true,
    });
  });

  it("adopts an AI handling option with its proposed mode", () => {
    const text = harness.text.preview.annotations;
    const { container } = renderWithAnnotation([
      annotation({
        options: [
          {
            kind: "instruction",
            text: "Use the business sense.",
            mode: "once",
          },
          {
            kind: "instruction",
            text: "Use a formal register.",
            mode: "persistent",
          },
        ],
        question: "Which sense is intended?",
      }),
    ]);
    fireEvent.click(
      within(container).getByLabelText(
        fmt(text.openCount, { count: 1 }),
      ) as HTMLElement,
    );
    const dialog = screen.getByRole("dialog", { name: text.title });
    fireEvent.click(within(dialog).getByText(text.details));
    expect(
      within(dialog).getByText("Use the business sense."),
    ).toBeTruthy();
    expect(
      within(dialog).getByText("Use a formal register."),
    ).toBeTruthy();
    fireEvent.click(
      within(dialog).getByRole("button", {
        name: new RegExp(`^${text.adoptAnswer} 2`),
      }),
    );
    expect(actions(harness)).toContainEqual({
      type: "saveAnnotation",
      blockIndex: 0,
      side: "target",
      mode: "persistent",
      message: "Use a formal register.",
      originAnnotationId: "a1",
      resolveAnnotationId: "a1",
      sourceHash: "source-hash-0",
      cacheId: "cache-0",
    });
  });

  it("renders advice as a non-adoptable note", () => {
    const text = harness.text.preview.annotations;
    const { container } = renderWithAnnotation([
      annotation({
        options: [
          {
            kind: "instruction",
            text: "将“bite”改为“业务影响”。",
            mode: "once",
          },
          {
            kind: "advice",
            text: "请确认“bite”在这里的实际含义。",
          },
        ],
        question: "Which sense is intended?",
      }),
    ]);
    fireEvent.click(
      within(container).getByLabelText(
        fmt(text.openCount, { count: 1 }),
      ) as HTMLElement,
    );
    const dialog = screen.getByRole("dialog", { name: text.title });
    fireEvent.click(within(dialog).getByText(text.details));
    expect(within(dialog).getByText(text.optionsLabel)).toBeTruthy();
    expect(within(dialog).getByText(text.adviceLabel)).toBeTruthy();
    expect(
      within(dialog).getByText("请确认“bite”在这里的实际含义。"),
    ).toBeTruthy();
    expect(within(dialog).getByText(text.modeOnceBadge)).toBeTruthy();
    expect(
      within(dialog).queryByRole("button", {
        name: new RegExp(`^${text.adoptAnswer} 2`),
      }),
    ).toBeNull();
    expect(
      within(dialog).getByRole("button", {
        name: new RegExp(`^${text.adoptAnswer} 1`),
      }),
    ).toBeTruthy();
  });

  it("prepares an edited instruction in the composer", () => {
    const text = harness.text.preview.annotations;
    const { container } = renderWithAnnotation([
      annotation({
        options: [
          {
            kind: "instruction",
            text: "Use the business sense.",
            mode: "once",
          },
          {
            kind: "instruction",
            text: "Use a formal register.",
            mode: "once",
          },
        ],
        question: "Which sense is intended?",
      }),
    ]);
    fireEvent.click(
      within(container).getByLabelText(
        fmt(text.openCount, { count: 1 }),
      ) as HTMLElement,
    );
    const dialog = screen.getByRole("dialog", { name: text.title });
    fireEvent.click(within(dialog).getByText(text.details));
    fireEvent.click(
      within(dialog).getByRole("button", {
        name: new RegExp(`^${text.editAnswer} 1`),
      }),
    );
    const compose = within(dialog).getByLabelText(
      text.add,
    ) as HTMLTextAreaElement;
    expect(compose.value).toBe("Use the business sense.");
    expect(
      dialog.querySelector(".pv-annotation-compose .pv-summary-note")
        ?.textContent,
    ).toContain(text.answeringQuestion);
    const onceBox = within(dialog).getByRole(
      "checkbox",
    ) as HTMLInputElement;
    expect(onceBox.checked).toBe(true);
    expect(onceBox.disabled).toBe(false);
    fireEvent.input(compose, {
      target: { value: "Use a formal register." },
    });
    fireEvent.click(
      within(dialog).getByRole("button", { name: text.save }),
    );
    expect(actions(harness)).toContainEqual({
      type: "saveAnnotation",
      blockIndex: 0,
      side: "target",
      mode: "once",
      message: "Use a formal register.",
      originAnnotationId: "a1",
      resolveAnnotationId: "a1",
      sourceHash: "source-hash-0",
      cacheId: "cache-0",
    });
  });

  it("edits a user annotation and its mode", () => {
    const text = harness.text.preview.annotations;
    const { container } = renderWithAnnotation([
      annotation({
        id: "u1",
        author: "user",
        kind: "request-change",
        mode: "once",
        status: "pending",
        message: "Old instruction.",
      }),
    ]);
    fireEvent.click(
      within(container).getByLabelText(
        fmt(text.openCount, { count: 1 }),
      ) as HTMLElement,
    );
    const dialog = screen.getByRole("dialog", { name: text.title });
    fireEvent.click(
      within(dialog).getByRole("button", { name: text.edit }),
    );
    const editor = within(dialog).getByRole("textbox", {
      name: text.edit,
    }) as HTMLTextAreaElement;
    fireEvent.input(editor, { target: { value: "New instruction." } });
    fireEvent.click(
      within(dialog).getAllByRole("checkbox")[0] as HTMLElement,
    );
    fireEvent.click(
      within(dialog).getByRole("button", { name: text.saveEdit }),
    );
    expect(actions(harness)).toContainEqual({
      type: "updateAnnotation",
      annotationId: "u1",
      message: "New instruction.",
      mode: "persistent",
      side: "target",
    });
  });

  it("disables annotation saving on untranslatable blocks", () => {
    const text = harness.text.preview.annotations;
    const { container } = renderWithAnnotation(
      [
        annotation({
          options: [
            {
              kind: "instruction",
              text: "Use this wording.",
              mode: "once",
            },
          ],
          question: "Which wording?",
        }),
      ],
      { status: "copy" },
    );
    fireEvent.click(
      within(container).getByLabelText(
        fmt(text.openCount, { count: 1 }),
      ) as HTMLElement,
    );
    const dialog = screen.getByRole("dialog", { name: text.title });
    expect(within(dialog).getByText(text.cannotAnnotate)).toBeTruthy();
    const compose = within(dialog).getByLabelText(
      text.add,
    ) as HTMLTextAreaElement;
    expect(compose.disabled).toBe(true);
    expect(
      within(dialog).queryByRole("button", {
        name: new RegExp(`^${text.adoptAnswer} 1`),
      }),
    ).toBeNull();
    const save = within(dialog).getByRole("button", {
      name: text.save,
    }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
  });

  it("shows the manual retranslation hint for locked blocks", () => {
    const text = harness.text.preview.annotations;
    const { container } = renderWithAnnotation([annotation()], {
      status: "human",
      human: true,
    });
    fireEvent.click(
      within(container).getByLabelText(
        fmt(text.openCount, { count: 1 }),
      ) as HTMLElement,
    );
    const dialog = screen.getByRole("dialog", { name: text.title });
    expect(within(dialog).getByText(text.humanPendingHint)).toBeTruthy();
    const compose = within(dialog).getByLabelText(
      text.add,
    ) as HTMLTextAreaElement;
    expect(compose.disabled).toBe(false);
  });
});
