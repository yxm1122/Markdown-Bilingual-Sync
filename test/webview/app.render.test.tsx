// @vitest-environment jsdom
/**
 * 预览界面基础渲染：工具栏、统计、块列表、布局切换、只读、空状态。
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/preact";
import {
  actions,
  loadHarness,
  resetHarness,
  type WebviewHarness,
} from "./harness";
import { makeBoot, makeModel } from "./fixtures";

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

describe("preview rendering", () => {
  it("renders the file, counts, blocks and native toolbar", () => {
    const boot = makeBoot(makeModel());
    const { container } = render(<harness.App boot={boot} text={harness.text} />);
    const text = harness.text.preview;

    expect(screen.getByRole("heading", { level: 1, name: "demo.md" })).toBeTruthy();
    expect(screen.getByText(/en → zh-CN · Mock Provider/)).toBeTruthy();
    expect(screen.getByRole("button", { name: text.toolbar.sync })).toBeTruthy();
    expect(screen.getByRole("button", { name: text.toolbar.export })).toBeTruthy();
    expect(screen.getByTitle(text.toolbar.refresh)).toBeTruthy();
    expect(screen.getByTitle(text.toolbar.moreActions)).toBeTruthy();

    expect(container.querySelectorAll(".pv-block")).toHaveLength(2);
    expect(container.querySelectorAll(".pv-pane-source")).toHaveLength(2);
    expect(container.querySelectorAll(".pv-pane-target")).toHaveLength(2);
    expect(screen.getAllByText(text.statusLabels.translated)).toHaveLength(3);
    expect(
      Array.from(container.querySelectorAll(".pv-block .pv-status strong")).every(
        (node) => node.textContent === text.statusLabels.translated,
      ),
    ).toBe(true);

    const translated = container.querySelector(".pv-stat.is-ok");
    expect(translated?.textContent).toContain("2");
    expect(screen.getByText(text.stats.total.replace("{count}", "2"))).toBeTruthy();

    const bilingual = screen.getByRole("button", { name: text.toolbar.bilingual });
    expect(bilingual.getAttribute("aria-pressed")).toBe("true");
    const columns = screen.getByRole("button", { name: text.subbar.columns });
    expect(columns.getAttribute("aria-pressed")).toBe("true");
  });

  it("keeps export disabled until a cache exists", () => {
    const boot = makeBoot(makeModel({ cacheExists: false }));
    render(<harness.App boot={boot} text={harness.text} />);

    const exportButton = screen.getByRole("button", {
      name: harness.text.preview.toolbar.export,
    }) as HTMLButtonElement;
    expect(exportButton.disabled).toBe(true);
    expect(exportButton.title).toBe(harness.text.preview.toolbar.exportDisabledTitle);
  });

  it("switches mode locally and persists it", () => {
    const boot = makeBoot(makeModel());
    const { container } = render(<harness.App boot={boot} text={harness.text} />);
    const text = harness.text.preview;

    fireEvent.click(screen.getByRole("button", { name: text.toolbar.sourceOnly }));

    const app = container.querySelector(".pv-app");
    expect(app?.getAttribute("data-mode")).toBe("source");
    expect(
      screen
        .getByRole("button", { name: text.toolbar.sourceOnly })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    expect(harness.apiState.mode).toBe("source");
    // 模式是 Webview 本地状态，不向宿主发送消息。
    expect(actions(harness)).toEqual([]);
  });

  it("switches to split layout through the host protocol", () => {
    const boot = makeBoot(makeModel());
    const { container } = render(<harness.App boot={boot} text={harness.text} />);
    const text = harness.text.preview;

    fireEvent.click(screen.getByRole("button", { name: text.subbar.split }));

    expect(actions(harness)).toContainEqual({ type: "setLayout", layout: "split" });
    expect(container.querySelector(".pv-app")?.getAttribute("data-layout")).toBe("split");
    expect(container.querySelector(".pv-split")).toBeTruthy();
    expect(container.querySelectorAll(".pv-cell")).toHaveLength(4);
    expect(container.querySelectorAll(".pv-split-pane")).toHaveLength(2);
    expect(screen.getAllByTitle(text.actions.readonlyPreviewTitle)).toHaveLength(2);
  });

  it("toggles split-pane read-only through the host and hides editing", () => {
    const boot = makeBoot(makeModel(), { layout: "split" });
    const { container } = render(<harness.App boot={boot} text={harness.text} />);
    const text = harness.text.preview;

    const sourcePane = container.querySelector(
      '.pv-split-pane[data-pane="source"]',
    ) as HTMLElement;
    const toggle = within(sourcePane).getByTitle(text.actions.readonlyPreviewTitle);
    fireEvent.click(toggle);

    expect(actions(harness)).toContainEqual({
      type: "togglePaneReadonly",
      pane: "source",
    });
    expect(sourcePane.className).toContain("is-readonly");
    expect(
      within(sourcePane).getByTitle(text.actions.exitReadonlyTitle).getAttribute(
        "aria-pressed",
      ),
    ).toBe("true");

    // 只读侧点击内容不再进入编辑。
    const md = sourcePane.querySelector(".pv-md") as HTMLElement;
    fireEvent.click(md);
    expect(sourcePane.querySelector("textarea")).toBeNull();

    // 目标侧仍可编辑。
    const targetPane = container.querySelector(
      '.pv-split-pane[data-pane="target"]',
    ) as HTMLElement;
    fireEvent.click(targetPane.querySelector(".pv-md") as HTMLElement);
    expect(targetPane.querySelector("textarea")).toBeTruthy();
  });

  it("renders an empty state with a sync action", () => {
    const boot = makeBoot(
      makeModel({
        blocks: [],
        counts: { total: 0, translated: 0, stale: 0, human: 0, untranslated: 0, copy: 0 },
      }),
    );
    const { container } = render(<harness.App boot={boot} text={harness.text} />);
    const empty = container.querySelector(".pv-empty") as HTMLElement;

    expect(within(empty).getByText(harness.text.preview.placeholders.emptyDocument)).toBeTruthy();
    // 没有块时不渲染摘要面板。
    expect(container.querySelector(".pv-summary")).toBeNull();

    fireEvent.click(
      within(empty).getByRole("button", { name: harness.text.preview.toolbar.sync }),
    );
    expect(actions(harness)).toContainEqual({ type: "sync" });
  });

  it("gives every control an accessible name and exposes toggle state", () => {
    const boot = makeBoot(
      makeModel({ summary: { text: "Summary", glossaryText: "table => 表格" } }),
      { layout: "split" },
    );
    const { container } = render(<harness.App boot={boot} text={harness.text} />);
    const text = harness.text.preview;
    fireEvent.click(container.querySelector(".pv-summary-toggle") as HTMLElement);

    for (const control of Array.from(
      container.querySelectorAll<HTMLElement>("button, input, textarea"),
    )) {
      const name =
        control.getAttribute("aria-label") ||
        control.textContent?.trim() ||
        control.closest("label")?.textContent?.trim() ||
        "";
      expect(
        name,
        `control without accessible name: ${control.outerHTML.slice(0, 160)}`,
      ).not.toBe("");
    }

    expect(
      screen.getByRole("group", { name: text.toolbar.previewMode }),
    ).toBeTruthy();
    expect(screen.getByRole("group", { name: text.subbar.layout })).toBeTruthy();
    expect(
      screen.getByRole("button", { name: text.toolbar.bilingual }).getAttribute(
        "aria-pressed",
      ),
    ).toBe("true");
    expect(
      screen.getByRole("button", { name: text.subbar.split }).getAttribute(
        "aria-pressed",
      ),
    ).toBe("true");
    expect(
      container.querySelector(".pv-summary-toggle")?.getAttribute("aria-expanded"),
    ).toBe("true");
    expect(
      container.querySelector(".pv-summary-head")?.getAttribute("aria-expanded"),
    ).toBe("true");
  });

  it("names every control inside the export dialog", () => {
    render(
      <harness.App
        boot={makeBoot(makeModel(), {
          exportConfirmation: {
            destination: "demo.zh-CN.md",
            summary: "2 blocks",
            warningCount: 0,
            existing: true,
            diff: {
              rows: [],
              added: 0,
              removed: 0,
              unchanged: 0,
              coarse: false,
              truncated: 0,
            },
          },
        })}
        text={harness.text}
      />,
    );
    const dialog = screen.getByRole("dialog");

    for (const control of Array.from(
      dialog.querySelectorAll<HTMLElement>("button, input, textarea"),
    )) {
      const name =
        control.getAttribute("aria-label") ||
        control.textContent?.trim() ||
        control.closest("label")?.textContent?.trim() ||
        "";
      expect(
        name,
        `dialog control without accessible name: ${control.outerHTML.slice(0, 160)}`,
      ).not.toBe("");
    }
  });
});
