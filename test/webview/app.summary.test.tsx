// @vitest-environment jsdom
/**
 * 摘要/术语表、提示条、toast 以及宿主刷新时的草稿与焦点保持。
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
import { formatText as fmt } from "../../src/i18n";

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

function renderPreview(model = makeModel()) {
  const result = render(
    <harness.App boot={makeBoot(model)} text={harness.text} />,
  );
  fireEvent.click(result.container.querySelector(".pv-summary-toggle") as HTMLElement);
  return result;
}

describe("summary and glossary", () => {
  it("opens the summary panel and sends edited text", () => {
    const text = harness.text.preview;
    const model = makeModel({
      summary: {
        text: "Server summary",
        tokens: 1200,
        updatedAt: "2026-10-26T08:00:00.000Z",
        model: "mock",
      },
    });
    const { container } = renderPreview(model);
    const body = container.querySelector(".pv-summary-body") as HTMLElement;

    expect(container.querySelector(".pv-summary.is-open")).toBeTruthy();
    const textarea = within(body).getByPlaceholderText(
      text.summary.placeholder,
    ) as HTMLTextAreaElement;
    expect(textarea.value).toBe("Server summary");
    expect(
      body.querySelector(":scope > .pv-summary-note")?.textContent,
    ).toContain(fmt(text.summary.tokens, { count: 1200 }));

    fireEvent.input(textarea, { target: { value: "Edited summary" } });
    fireEvent.click(
      within(body).getByRole("button", { name: text.summary.save }),
    );
    expect(actions(harness)).toContainEqual({
      type: "saveSummary",
      summaryText: "Edited summary",
    });
  });

  it("does not save an empty summary", () => {
    const text = harness.text.preview;
    const { container } = renderPreview(makeModel());
    const body = container.querySelector(".pv-summary-body") as HTMLElement;
    const textarea = within(body).getByPlaceholderText(
      text.summary.placeholder,
    ) as HTMLTextAreaElement;

    fireEvent.input(textarea, { target: { value: "   " } });
    fireEvent.click(
      within(body).getByRole("button", { name: text.summary.save }),
    );

    expect(screen.getByText(text.summary.empty)).toBeTruthy();
    expect(actions(harness)).toEqual([]);
  });

  it("keeps an unsaved draft across host state updates and clears it only after the host echoes the saved value", () => {
    const text = harness.text.preview;
    const { container } = renderPreview(makeModel());
    const textarea = within(container.querySelector(".pv-summary-body") as HTMLElement).getByPlaceholderText(
      text.summary.placeholder,
    ) as HTMLTextAreaElement;

    fireEvent.input(textarea, { target: { value: "local draft" } });
    postHostMessage({
      type: "state",
      state: makeBoot(makeModel({ summary: { text: "server draft" } })).state,
    });
    expect(textarea.value).toBe("local draft");

    fireEvent.click(
      within(container.querySelector(".pv-summary-body") as HTMLElement).getByRole(
        "button",
        { name: text.summary.save },
      ),
    );
    // 宿主回写相同内容：dirty 清除，草稿保持一致。
    postHostMessage({
      type: "state",
      state: makeBoot(makeModel({ summary: { text: "local draft" } })).state,
    });
    expect(textarea.value).toBe("local draft");

    // 再次刷新时新内容可以覆盖已保存的草稿。
    postHostMessage({
      type: "state",
      state: makeBoot(makeModel({ summary: { text: "new server value" } })).state,
    });
    expect(textarea.value).toBe("new server value");
  });

  it("generates summaries and disables clear without content", () => {
    const text = harness.text.preview;
    const { container } = renderPreview(makeModel());
    const body = container.querySelector(".pv-summary-body") as HTMLElement;

    fireEvent.click(
      within(body).getByRole("button", { name: text.summary.generate }),
    );
    expect(actions(harness)).toContainEqual({ type: "generateSummary" });

    const clear = within(body).getByRole("button", {
      name: text.summary.clear,
    }) as HTMLButtonElement;
    expect(clear.disabled).toBe(true);
    expect(
      (within(body).getByRole("button", {
        name: text.summary.save,
      }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it("clears an existing summary through the host", () => {
    const text = harness.text.preview;
    const { container } = renderPreview(
      makeModel({ summary: { text: "Existing summary" } }),
    );
    const body = container.querySelector(".pv-summary-body") as HTMLElement;
    const clear = within(body).getByRole("button", {
      name: text.summary.clear,
    }) as HTMLButtonElement;

    expect(clear.disabled).toBe(false);
    fireEvent.click(clear);
    expect(actions(harness)).toContainEqual({ type: "clearSummary" });
  });

  it("disables unsupported generation and allows manual saving", () => {
    const text = harness.text.preview;
    const { container } = renderPreview(
      makeModel({ summary: { canGenerate: false } }),
    );
    const body = container.querySelector(".pv-summary-body") as HTMLElement;
    const generate = within(body).getByRole("button", {
      name: text.summary.generate,
    }) as HTMLButtonElement;

    expect(generate.disabled).toBe(true);
    expect(generate.title).toBe(text.summary.unsupported);
    expect(
      (within(body).getByRole("button", { name: text.summary.save }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
  });

  it("saves a normalized-glossary draft and preserves it while dirty", () => {
    const text = harness.text.preview;
    const model = makeModel({
      summary: {
        text: "Summary",
        glossaryText: "table => 表格",
        glossaryCount: 1,
      },
    });
    const { container } = renderPreview(model);
    const body = container.querySelector(".pv-summary-body") as HTMLElement;
    const glossary = within(body).getByPlaceholderText(
      text.summary.glossaryPlaceholder,
    ) as HTMLTextAreaElement;
    expect(glossary.value).toBe("table => 表格");

    fireEvent.input(glossary, { target: { value: "table=>表格\ncode=>代码" } });
    // 未保存时，宿主刷新不能覆盖用户草稿。
    postHostMessage({
      type: "state",
      state: makeBoot(
        makeModel({
          summary: {
            text: "Summary",
            glossaryText: "other => 其他",
            glossaryCount: 1,
          },
        }),
      ).state,
    });
    expect(glossary.value).toBe("table=>表格\ncode=>代码");

    fireEvent.click(
      within(body).getByRole("button", { name: text.summary.saveGlossary }),
    );
    expect(actions(harness)).toContainEqual({
      type: "saveGlossary",
      glossaryText: "table=>表格\ncode=>代码",
    });

    // 保存成功后接受宿主的规范化结果（空白样式以宿主为准）。
    postHostMessage({
      type: "state",
      state: makeBoot(
        makeModel({
          summary: {
            text: "Summary",
            glossaryText: "table => 表格\ncode => 代码",
            glossaryCount: 2,
          },
        }),
      ).state,
    });
    expect(glossary.value).toBe("table => 表格\ncode => 代码");

    postHostMessage({
      type: "state",
      state: makeBoot(
        makeModel({
          summary: {
            text: "Summary",
            glossaryText: "new => 新",
            glossaryCount: 1,
          },
        }),
      ).state,
    });
    expect(glossary.value).toBe("new => 新");
  });

  it("explains that a glossary requires a summary", () => {
    const text = harness.text.preview;
    const { container } = renderPreview(makeModel());
    expect(
      within(container.querySelector(".pv-summary-body") as HTMLElement).getByText(
        text.summary.glossaryNeedsSummary,
      ),
    ).toBeTruthy();
  });

  it("sends both assist toggles with tooltips", () => {
    const text = harness.text.preview;
    const { container } = renderPreview(
      makeModel({ summary: { text: "Summary" } }),
    );
    const body = container.querySelector(".pv-summary-body") as HTMLElement;
    const stable = within(body).getByLabelText(
      text.summary.stableTranslation,
    ) as HTMLInputElement;
    const context = within(body).getByLabelText(
      text.summary.useSummary,
    ) as HTMLInputElement;

    expect(stable.checked).toBe(true);
    expect(stable.closest("label")?.title).toBe(
      text.summary.stableTranslationTitle,
    );
    expect(context.checked).toBe(false);
    expect(context.closest("label")?.title).toBe(text.summary.useSummaryTitle);

    fireEvent.click(stable);
    fireEvent.click(context);
    expect(actions(harness)).toContainEqual({
      type: "setAssistToggle",
      key: "stableTranslation",
      value: false,
    });
    expect(actions(harness)).toContainEqual({
      type: "setAssistToggle",
      key: "summaryContext",
      value: true,
    });
  });
});

describe("notices and toasts", () => {
  it("applies or discards staged source changes from the notice", () => {
    const text = harness.text.preview;
    const model = makeModel({ pendingSourceCount: 2, counts: { stale: 1 } });
    render(<harness.App boot={makeBoot(model)} text={harness.text} />);

    const pending = screen.getByText(
      `${2} · ${text.actions.sourcePendingBadge}`,
    ).closest(".pv-notice") as HTMLElement;
    fireEvent.click(
      within(pending).getByRole("button", {
        name: fmt(text.actions.applySource, { count: 2 }),
      }),
    );
    fireEvent.click(
      within(pending).getByRole("button", { name: text.actions.resetSource }),
    );

    expect(actions(harness)).toContainEqual({ type: "applySourceEdits" });
    expect(actions(harness)).toContainEqual({ type: "discardSourceEdits" });
  });

  it("retranslates stale blocks from the notice", () => {
    const text = harness.text.preview;
    render(
      <harness.App
        boot={makeBoot(makeModel({ counts: { stale: 3 } }))}
        text={harness.text}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: fmt(text.subbar.retranslateStale, { count: 3 }),
      }),
    );
    expect(actions(harness)).toContainEqual({ type: "retranslateStale" });
  });

  it("shows warnings and the initial notice, and dismisses toasts", () => {
    const model = makeModel({ warnings: ["first warning", "second warning"] });
    render(
      <harness.App
        boot={makeBoot(model, { notice: { text: "Loaded from disk", kind: "info" } })}
        text={harness.text}
      />,
    );

    expect(screen.getByText("first warning · second warning")).toBeTruthy();
    expect(screen.getByText("Loaded from disk")).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: harness.text.preview.modal.close }),
    );
    expect(screen.queryByText("Loaded from disk")).toBeNull();
  });

  it("renders host toasts with their tone", () => {
    render(<harness.App boot={makeBoot(makeModel())} text={harness.text} />);
    postHostMessage({ type: "toast", text: "Export failed", kind: "error" });

    const toast = screen.getByText("Export failed").closest(".toast") as HTMLElement;
    expect(toast.getAttribute("data-tone")).toBe("error");
  });
});

describe("state refresh", () => {
  it("keeps the inline editor, its draft and focus across a state update", () => {
    const { container } = render(
      <harness.App boot={makeBoot(makeModel())} text={harness.text} />,
    );
    const block = container.querySelector(".pv-block") as HTMLElement;
    fireEvent.click(block.querySelector(".pv-pane-target .pv-md") as HTMLElement);
    const textarea = within(block).getByRole("textbox") as HTMLTextAreaElement;
    fireEvent.input(textarea, { target: { value: "typing..." } });
    expect(document.activeElement).toBe(textarea);

    postHostMessage({
      type: "state",
      state: makeBoot(makeModel({ counts: { translated: 1, stale: 1 } })).state,
    });

    const refreshed = container.querySelector(".pv-block textarea") as HTMLTextAreaElement;
    expect(refreshed).toBe(textarea);
    expect(refreshed.value).toBe("typing...");
    expect(document.activeElement).toBe(textarea);
  });

  it("closes the editor when its block disappears", () => {
    const { container } = render(
      <harness.App boot={makeBoot(makeModel())} text={harness.text} />,
    );
    const block = container.querySelector(".pv-block") as HTMLElement;
    fireEvent.click(block.querySelector(".pv-pane-target .pv-md") as HTMLElement);
    expect(screen.getByRole("textbox")).toBeTruthy();

    postHostMessage({
      type: "state",
      state: makeBoot(
        makeModel({
          blocks: [
            makeBlock({
              key: "replacement",
              blockIndex: 0,
              sourceLine: 9,
            }),
          ],
        }),
      ).state,
    });
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("shows a host notice carried by a state message", () => {
    render(<harness.App boot={makeBoot(makeModel())} text={harness.text} />);
    postHostMessage({
      type: "state",
      state: makeBoot(makeModel()).state,
      notice: { text: "Synced just now", kind: "success" },
    });
    expect(screen.getByText("Synced just now")).toBeTruthy();
  });
});

describe("busy state", () => {
  it("disables mutating controls and block menus", () => {
    const text = harness.text.preview;
    const { container } = render(
      <harness.App boot={makeBoot(makeModel())} text={harness.text} />,
    );
    postHostMessage({ type: "busy", busy: true, message: "Translating…" });

    expect(screen.getByText("Translating…")).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: text.toolbar.sync }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(
      (screen.getByRole("button", { name: text.toolbar.bilingual }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(
      (screen.getByRole("button", { name: text.subbar.split }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);

    const block = container.querySelector(".pv-block") as HTMLElement;
    fireEvent.click(block.querySelector(".pv-block-actions .pv-action") as HTMLElement);
    expect(screen.queryByRole("menu")).toBeNull();

    fireEvent.click(block.querySelector(".pv-pane-target .pv-md") as HTMLElement);
    expect(screen.queryByRole("textbox")).toBeNull();

    postHostMessage({ type: "busy", busy: false });
    expect(
      (screen.getByRole("button", { name: text.toolbar.sync }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
  });
});

describe("footnotes", () => {
  it("renders paired source and target footnotes", () => {
    const model = makeModel({
      sourceFootnotesHtml: "<div>source note</div>",
      targetFootnotesHtml: "<div>target note</div>",
    });
    const { container } = render(
      <harness.App boot={makeBoot(model)} text={harness.text} />,
    );
    const footnotes = container.querySelector(".pv-footnotes") as HTMLElement;

    expect(within(footnotes).getByText("source note")).toBeTruthy();
    expect(within(footnotes).getByText("target note")).toBeTruthy();
    expect(
      within(footnotes).getAllByText(harness.text.preview.panes.sourceFootnotes),
    ).toHaveLength(1);
  });

  it("shows a placeholder for the missing side", () => {
    const model = makeModel({ sourceFootnotesHtml: "<div>source note</div>" });
    const { container } = render(
      <harness.App boot={makeBoot(model)} text={harness.text} />,
    );
    expect(
      within(container.querySelector(".pv-footnotes") as HTMLElement).getByText(
        harness.text.preview.placeholders.noFootnotes,
      ),
    ).toBeTruthy();
  });
});
