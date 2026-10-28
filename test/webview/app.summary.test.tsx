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

function openGlossary(body: HTMLElement) {
  fireEvent.click(
    body.querySelector(".pv-glossary-section .pv-brief-toggle") as HTMLElement,
  );
}

function termSide(
  body: HTMLElement,
  position: number,
  side: "source" | "target",
): HTMLElement {
  const card = body.querySelectorAll(".pv-term-card")[position];
  return card.querySelector(`.pv-term-side.pv-term-${side}`) as HTMLElement;
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
      type: "saveBrief",
      summaryText: "Edited summary",
      brief: {},
      glossaryText: "",
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

  it("edits a glossary card and preserves a dirty draft", () => {
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
    openGlossary(body);
    expect(termSide(body, 0, "source").getAttribute("aria-label")).toContain(
      "table",
    );
    fireEvent.click(termSide(body, 0, "source"));
    const source = within(body).getByLabelText(
      text.summary.glossaryTableSource,
    ) as HTMLInputElement;
    expect(source.value).toBe("table");
    expect(
      within(body).queryByLabelText(text.summary.glossaryTableTarget),
    ).toBeNull();

    fireEvent.click(termSide(body, 0, "target"));
    const target = within(body).getByLabelText(
      text.summary.glossaryTableTarget,
    ) as HTMLInputElement;
    expect(target.value).toBe("表格");
    expect(
      within(body).queryByLabelText(text.summary.glossaryTableSource),
    ).toBeNull();
    expect(
      body.querySelectorAll(".pv-term-card.is-editing button"),
    ).toHaveLength(1);

    fireEvent.input(target, { target: { value: "数据表" } });
    fireEvent.keyDown(target, { key: "Enter" });
    expect(within(body).getByText("数据表")).toBeTruthy();

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
    expect(within(body).getByText("数据表")).toBeTruthy();

    fireEvent.click(
      within(body).getByRole("button", { name: text.summary.save }),
    );
    expect(actions(harness)).toContainEqual({
      type: "saveBrief",
      summaryText: "Summary",
      brief: {},
      glossaryText: "table => 数据表",
    });

    // 保存成功后接受宿主的规范化结果。
    postHostMessage({
      type: "state",
      state: makeBoot(
        makeModel({
          summary: {
            text: "Summary",
            glossaryText: "table => 数据表",
            glossaryCount: 1,
          },
        }),
      ).state,
    });
    expect(within(body).getByText("数据表")).toBeTruthy();

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
    expect(within(body).getByText("新")).toBeTruthy();
  });

  it("does not write an edit into a host-refreshed row", () => {
    const text = harness.text.preview;
    const { container } = renderPreview(
      makeModel({
        summary: {
          text: "Summary",
          glossaryText: "table => 表格",
          glossaryCount: 1,
        },
      }),
    );
    const body = container.querySelector(".pv-summary-body") as HTMLElement;
    openGlossary(body);
    fireEvent.click(termSide(body, 0, "source"));
    const input = within(body).getByLabelText(
      text.summary.glossaryTableSource,
    ) as HTMLInputElement;
    fireEvent.input(input, { target: { value: "数据表" } });

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
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.click(
      within(body).getByRole("button", { name: text.summary.save }),
    );
    expect(actions(harness)).toContainEqual({
      type: "saveBrief",
      summaryText: "Summary",
      brief: {},
      glossaryText: "other => 其他",
    });
  });

  it("commits an inline side on blur and cancels it on Escape", () => {
    const text = harness.text.preview;
    const { container } = renderPreview(
      makeModel({
        summary: {
          text: "Summary",
          glossaryText: "table => 表格",
          glossaryCount: 1,
        },
      }),
    );
    const body = container.querySelector(".pv-summary-body") as HTMLElement;
    openGlossary(body);

    fireEvent.click(termSide(body, 0, "source"));
    const source = within(body).getByLabelText(
      text.summary.glossaryTableSource,
    ) as HTMLInputElement;
    fireEvent.input(source, { target: { value: "数据表" } });
    fireEvent.blur(source);
    expect(body.querySelector(".pv-term-card.is-editing")).toBeNull();
    expect(within(body).getByText("数据表")).toBeTruthy();
    expect(
      (within(body).getByRole("button", {
        name: text.summary.save,
      }) as HTMLButtonElement).disabled,
    ).toBe(false);

    fireEvent.click(termSide(body, 0, "source"));
    const reopened = within(body).getByLabelText(
      text.summary.glossaryTableSource,
    ) as HTMLInputElement;
    expect(reopened.value).toBe("数据表");
    fireEvent.input(reopened, { target: { value: "不保存" } });
    fireEvent.keyDown(reopened, { key: "Escape" });
    expect(body.querySelector(".pv-term-card.is-editing")).toBeNull();
    expect(within(body).getByText("数据表")).toBeTruthy();
    expect(within(body).queryByText("不保存")).toBeNull();
  });

  it("restores focus after committing or cancelling an edit", async () => {
    const text = harness.text.preview;
    const { container } = renderPreview(
      makeModel({
        summary: {
          text: "Summary",
          glossaryText: "table => 表格",
          glossaryCount: 1,
        },
      }),
    );
    const body = container.querySelector(".pv-summary-body") as HTMLElement;
    openGlossary(body);

    fireEvent.click(termSide(body, 0, "source"));
    const input = within(body).getByLabelText(
      text.summary.glossaryTableSource,
    ) as HTMLInputElement;
    fireEvent.input(input, { target: { value: "数据表" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => {
      expect(document.activeElement).toBe(termSide(body, 0, "source"));
    });

    fireEvent.click(
      within(body).getByRole("button", {
        name: text.summary.glossaryAdd,
      }),
    );
    fireEvent.keyDown(
      within(body).getByLabelText(
        text.summary.glossaryTableSource,
      ) as HTMLInputElement,
      { key: "Escape" },
    );
    await waitFor(() => {
      expect(document.activeElement).toBe(
        within(body).getByRole("button", {
          name: text.summary.glossaryAdd,
        }),
      );
    });
  });

  it("adds, deletes, and validates glossary cards", () => {
    const text = harness.text.preview;
    const { container } = renderPreview(
      makeModel({
        summary: {
          text: "Summary",
          glossaryText: "table => 表格",
          glossaryCount: 1,
        },
      }),
    );
    const body = container.querySelector(".pv-summary-body") as HTMLElement;
    openGlossary(body);
    fireEvent.click(
      within(body).getByRole("button", { name: text.summary.glossaryAdd }),
    );
    const source = within(body).getByLabelText(
      text.summary.glossaryTableSource,
    ) as HTMLInputElement;
    expect(source.value).toBe("");
    expect(document.activeElement).toBe(source);

    const save = within(body).getByRole("button", {
      name: text.summary.save,
    }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.input(source, { target: { value: "Table" } });
    fireEvent.keyDown(source, { key: "Enter" });
    const nextTarget = within(body).getByLabelText(
      text.summary.glossaryTableTarget,
    ) as HTMLInputElement;
    expect(nextTarget.value).toBe("");
    expect(save.disabled).toBe(true);
    fireEvent.keyDown(nextTarget, { key: "Enter" });
    expect(
      within(body).getByLabelText(text.summary.glossaryTableTarget),
    ).toBeTruthy();

    fireEvent.input(nextTarget, { target: { value: "表格 2" } });
    fireEvent.keyDown(nextTarget, { key: "Enter" });
    expect(save.disabled).toBe(false);
    expect(within(body).getByText(text.summary.glossaryDuplicate)).toBeTruthy();

    fireEvent.click(
      within(body).getByRole("button", {
        name: `${text.summary.glossaryDelete} 2`,
      }),
    );
    expect(body.querySelectorAll(".pv-term-card")).toHaveLength(1);
  });

  it("cancels a new term without changing the draft", () => {
    const text = harness.text.preview;
    const { container } = renderPreview(
      makeModel({
        summary: {
          text: "Summary",
          glossaryText: "table => 表格",
          glossaryCount: 1,
        },
      }),
    );
    const body = container.querySelector(".pv-summary-body") as HTMLElement;
    openGlossary(body);
    fireEvent.click(
      within(body).getByRole("button", { name: text.summary.glossaryAdd }),
    );
    const source = within(body).getByLabelText(
      text.summary.glossaryTableSource,
    ) as HTMLInputElement;
    fireEvent.input(source, { target: { value: "ignored" } });
    fireEvent.keyDown(source, { key: "Escape" });
    fireEvent.click(
      within(body).getByRole("button", { name: text.summary.save }),
    );
    expect(actions(harness)).toContainEqual({
      type: "saveBrief",
      summaryText: "Summary",
      brief: {},
      glossaryText: "table => 表格",
    });
  });

  it("renders the maximum glossary size", () => {
    const text = harness.text.preview;
    const glossaryText = Array.from(
      { length: 200 },
      (_, index) => `term-${index + 1} => 术语-${index + 1}`,
    ).join("\n");
    const { container } = renderPreview(
      makeModel({
        summary: {
          text: "Summary",
          glossaryText,
          glossaryCount: 200,
        },
      }),
    );
    const body = container.querySelector(".pv-summary-body") as HTMLElement;
    openGlossary(body);
    expect(termSide(body, 199, "source")).toBeTruthy();
  });

  it("reveals only the hovered term side", () => {
    const { container } = renderPreview(
      makeModel({
        summary: {
          text: "Summary",
          glossaryText: `${"a".repeat(80)} => ${"译".repeat(80)}`,
          glossaryCount: 1,
        },
      }),
    );
    const body = container.querySelector(".pv-summary-body") as HTMLElement;
    openGlossary(body);
    const card = body.querySelector(".pv-term-card") as HTMLElement;
    const sides = card.querySelectorAll(".pv-term-side");
    const terms = card.querySelectorAll<HTMLElement>(".pv-term-text");
    const tracks = card.querySelectorAll<HTMLElement>(".pv-term-track");
    Object.defineProperty(tracks[0], "scrollWidth", {
      configurable: true,
      value: 300,
    });
    Object.defineProperty(terms[0], "clientWidth", {
      configurable: true,
      value: 100,
    });
    Object.defineProperty(tracks[1], "scrollWidth", {
      configurable: true,
      value: 260,
    });
    Object.defineProperty(terms[1], "clientWidth", {
      configurable: true,
      value: 100,
    });

    fireEvent.mouseEnter(sides[0]);
    expect(terms[0].className).toContain("is-revealing");
    expect(terms[0].getAttribute("style")).toContain("--term-shift: -200px");
    expect(terms[1].className).not.toContain("is-revealing");
    fireEvent.mouseLeave(sides[0]);
    expect(terms[0].className).not.toContain("is-revealing");

    fireEvent.mouseEnter(sides[1]);
    expect(terms[1].className).toContain("is-revealing");
    expect(terms[1].getAttribute("style")).toContain("--term-shift: -160px");
    expect(terms[0].className).not.toContain("is-revealing");
    fireEvent.mouseLeave(sides[1]);
    expect(terms[1].className).not.toContain("is-revealing");

    fireEvent.focus(sides[0]);
    expect(terms[0].className).toContain("is-revealing");
    expect(terms[1].className).not.toContain("is-revealing");
    fireEvent.blur(sides[0]);
    expect(terms[0].className).not.toContain("is-revealing");
  });

  it("fills only cards whose terms no longer fit", () => {
    const { container } = renderPreview(
      makeModel({
        summary: {
          text: "Summary",
          glossaryText: "short => 短\nlong => 长",
          glossaryCount: 2,
        },
      }),
    );
    const body = container.querySelector(".pv-summary-body") as HTMLElement;
    openGlossary(body);
    const flow = body.querySelector(".pv-term-flow") as HTMLElement;
    const cards = Array.from(
      body.querySelectorAll<HTMLElement>(".pv-term-card"),
    );
    const trackWidths = [
      [40, 30],
      [300, 200],
    ];
    cards.forEach((card, index) => {
      card
        .querySelectorAll<HTMLElement>(".pv-term-track")
        .forEach((track, side) => {
          Object.defineProperty(track, "getBoundingClientRect", {
            configurable: true,
            value: () => ({ width: trackWidths[index][side] }),
          });
        });
      Object.defineProperty(
        card.querySelector(".pv-term-separator") as HTMLElement,
        "getBoundingClientRect",
        { configurable: true, value: () => ({ width: 3 }) },
      );
    });
    Object.defineProperty(flow, "clientWidth", {
      configurable: true,
      value: 300,
    });
    fireEvent(window, new Event("resize"));
    expect(cards[0].className).not.toContain("is-filling");
    expect(cards[1].className).toContain("is-filling");

    Object.defineProperty(flow, "clientWidth", {
      configurable: true,
      value: 500,
    });
    fireEvent(window, new Event("resize"));
    expect(cards[1].className).not.toContain("is-filling");
  });

  it("filters a large glossary table", () => {
    const text = harness.text.preview;
    const glossaryText = Array.from(
      { length: 11 },
      (_, index) => `term-${index + 1} => 术语-${index + 1}`,
    ).join("\n");
    const { container } = renderPreview(
      makeModel({
        summary: {
          text: "Summary",
          glossaryText,
          glossaryCount: 11,
        },
      }),
    );
    const body = container.querySelector(".pv-summary-body") as HTMLElement;
    openGlossary(body);
    const filter = within(body).getByLabelText(
      text.summary.glossaryFilter,
    ) as HTMLInputElement;
    fireEvent.input(filter, { target: { value: "term-10" } });
    const cards = body.querySelectorAll(".pv-term-card");
    expect(cards).toHaveLength(1);
    expect(cards[0].textContent).toContain("term-10");
  });

  it("switches between table and bulk glossary editing", () => {
    const text = harness.text.preview;
    const { container } = renderPreview(
      makeModel({
        summary: {
          text: "Summary",
          glossaryText: "table => 表格",
          glossaryCount: 1,
        },
      }),
    );
    const body = container.querySelector(".pv-summary-body") as HTMLElement;
    openGlossary(body);
    fireEvent.click(
      within(body).getByRole("button", { name: text.summary.glossaryBulkEdit }),
    );
    const bulk = within(body).getByPlaceholderText(
      text.summary.glossaryPlaceholder,
    ) as HTMLTextAreaElement;
    fireEvent.input(bulk, {
      target: { value: "table=>表格\ncode=>代码" },
    });
    fireEvent.click(
      within(body).getByRole("button", { name: text.summary.glossaryTableEdit }),
    );
    expect(within(body).getByText("code")).toBeTruthy();
    expect(within(body).getByText("代码")).toBeTruthy();
  });

  it("edits optional brief fields and sends them with the summary", () => {
    const text = harness.text.preview;
    const model = makeModel({
      summary: {
        text: "Summary",
        brief: { audience: "Developers" },
        briefFilledCount: 1,
      },
    });
    const { container } = renderPreview(model);
    const body = container.querySelector(".pv-summary-body") as HTMLElement;
    const toggle = container.querySelector(".pv-brief-toggle") as HTMLElement;
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");

    const audience = within(body).getByLabelText(
      text.summary.briefAudience,
    ) as HTMLInputElement;
    expect(audience.value).toBe("Developers");
    fireEvent.input(audience, { target: { value: "Operators" } });
    fireEvent.input(
      within(body).getByLabelText(text.summary.briefTone) as HTMLTextAreaElement,
      { target: { value: "Formal" } },
    );
    fireEvent.click(
      within(body).getByRole("button", { name: text.summary.save }),
    );

    expect(actions(harness)).toContainEqual({
      type: "saveBrief",
      summaryText: "Summary",
      brief: { audience: "Operators", toneAndStyle: "Formal" },
      glossaryText: "",
    });
  });

  it("opens the brief and glossary exclusively and starts collapsed", () => {
    const { container } = renderPreview(
      makeModel({
        summary: {
          text: "Summary",
          glossaryText: "table => 表格",
          glossaryCount: 1,
        },
      }),
    );
    const brief = container.querySelector(
      ".pv-brief:not(.pv-glossary-section) .pv-brief-toggle",
    ) as HTMLElement;
    const glossary = container.querySelector(
      ".pv-glossary-section .pv-brief-toggle",
    ) as HTMLElement;
    expect(brief.getAttribute("aria-expanded")).toBe("false");
    expect(glossary.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(brief);
    expect(brief.getAttribute("aria-expanded")).toBe("true");
    expect(glossary.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(glossary);
    expect(brief.getAttribute("aria-expanded")).toBe("false");
    expect(glossary.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(glossary);
    expect(glossary.getAttribute("aria-expanded")).toBe("false");
  });

  it("explains that a glossary requires a summary", () => {
    const text = harness.text.preview;
    const { container } = renderPreview(makeModel());
    const body = container.querySelector(".pv-summary-body") as HTMLElement;
    openGlossary(body);
    expect(
      within(body).getByText(text.summary.glossaryNeedsSummary),
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
