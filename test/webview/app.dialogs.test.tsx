// @vitest-environment jsdom
/**
 * 导出与原文写回弹窗：diff 渲染、写入态、失败恢复、取消与关闭。
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
import {
  makeBoot,
  makeExportConfirmation,
  makeModel,
  makeSourceConfirmation,
} from "./fixtures";
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

function renderExport(
  confirmation = makeExportConfirmation(),
) {
  return render(
    <harness.App
      boot={makeBoot(makeModel(), { exportConfirmation: confirmation })}
      text={harness.text}
    />,
  );
}

describe("export dialog", () => {
  it("renders the destination, summary and split diff", () => {
    const text = harness.text.preview;
    const confirmation = makeExportConfirmation({ warningCount: 2 });
    renderExport(confirmation);

    const dialog = screen.getByRole("dialog", { name: text.modal.title });
    expect(within(dialog).getByText(confirmation.destination)).toBeTruthy();
    expect(within(dialog).getByText(confirmation.summary)).toBeTruthy();
    expect(
      within(dialog).getByText(fmt(text.modal.warning, { count: 2 })),
    ).toBeTruthy();
    expect(dialog.querySelectorAll(".diff-row.is-change")).toHaveLength(1);
    expect(within(dialog).getByText("Hello world.")).toBeTruthy();
    expect(within(dialog).getByText("你好，世界。")).toBeTruthy();
    expect(within(dialog).getByText(text.modal.currentFile)).toBeTruthy();
    expect(within(dialog).getByText(text.modal.exportContent)).toBeTruthy();
    expect(document.activeElement).toBe(
      within(dialog).getByRole("button", { name: text.modal.write }),
    );
  });

  it("writes after confirmation and keeps the dialog open while writing", () => {
    const text = harness.text.preview;
    renderExport();
    const dialog = screen.getByRole("dialog", { name: text.modal.title });
    fireEvent.click(
      within(dialog).getByRole("button", { name: text.modal.write }),
    );

    expect(actions(harness)).toContainEqual({ type: "exportWrite" });
    const writing = within(dialog).getByRole("button", {
      name: text.modal.writing,
    }) as HTMLButtonElement;
    expect(writing.disabled).toBe(true);

    // 写入过程中排队的刷新不能关闭弹窗。
    postHostMessage({
      type: "state",
      state: makeBoot(makeModel()).state,
    });
    expect(screen.getByRole("dialog", { name: text.modal.title })).toBeTruthy();
  });

  it("surfaces a write error and allows retrying", () => {
    const text = harness.text.preview;
    renderExport();
    const dialog = screen.getByRole("dialog", { name: text.modal.title });
    fireEvent.click(
      within(dialog).getByRole("button", { name: text.modal.write }),
    );
    postHostMessage({ type: "exportError", message: "Disk is full" });

    expect(within(dialog).getByRole("alert").textContent).toBe("Disk is full");
    expect(
      screen.getByText("Disk is full", { selector: ".toast-text" }),
    ).toBeTruthy();
    const retry = within(dialog).getByRole("button", {
      name: text.modal.write,
    }) as HTMLButtonElement;
    expect(retry.disabled).toBe(false);
  });

  it("closes after the host settles the write", () => {
    const text = harness.text.preview;
    renderExport();
    fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: text.modal.write,
      }),
    );
    postHostMessage({ type: "exportSettled", action: "write" });

    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("cancels through the footer button and sends exportCancel", () => {
    const text = harness.text.preview;
    renderExport();
    fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: text.modal.cancel,
      }),
    );

    expect(actions(harness)).toContainEqual({ type: "exportCancel" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("cancels on backdrop click but not on inner content", () => {
    const text = harness.text.preview;
    const { container } = renderExport();
    const dialog = container.querySelector("dialog.diff-dialog") as HTMLDialogElement;

    fireEvent.click(within(dialog).getByText(text.modal.title));
    expect(screen.queryByRole("dialog")).toBeTruthy();

    fireEvent.click(dialog);
    expect(actions(harness)).toContainEqual({ type: "exportCancel" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("handles the native cancel event without closing while writing", () => {
    const text = harness.text.preview;
    const { container } = renderExport();
    const dialog = container.querySelector("dialog.diff-dialog") as HTMLDialogElement;

    fireEvent(dialog, new Event("cancel", { bubbles: true, cancelable: true }));
    expect(actions(harness)).toContainEqual({ type: "exportCancel" });
    expect(screen.queryByRole("dialog")).toBeNull();

    cleanup();
    resetHarness();
    renderExport();
    const second = container.ownerDocument.querySelector(
      "dialog.diff-dialog",
    ) as HTMLDialogElement;
    fireEvent.click(
      within(second).getByRole("button", { name: text.modal.write }),
    );
    fireEvent(second, new Event("cancel", { bubbles: true, cancelable: true }));
    expect(screen.queryByRole("dialog")).toBeTruthy();
  });

  it("renders an empty diff message", () => {
    const text = harness.text.preview;
    renderExport(
      makeExportConfirmation({
        existing: false,
        diff: {
          rows: [],
          added: 0,
          removed: 0,
          unchanged: 0,
          coarse: false,
          truncated: 0,
        },
      }),
    );
    expect(screen.getByText(text.modal.emptyDiff)).toBeTruthy();
    expect(screen.getByText(text.modal.newFile)).toBeTruthy();
  });
});

describe("source confirmation dialog", () => {
  it("writes staged source changes after confirmation", () => {
    const text = harness.text.preview;
    const confirmation = makeSourceConfirmation();
    render(<harness.App boot={makeBoot(makeModel())} text={harness.text} />);
    postHostMessage({ type: "sourceConfirm", data: confirmation });

    const dialog = screen.getByRole("dialog", { name: text.sourceModal.title });
    expect(within(dialog).getByText(confirmation.destination)).toBeTruthy();
    expect(
      within(dialog).getByText(
        fmt(text.sourceModal.summary, { count: confirmation.count }),
      ),
    ).toBeTruthy();
    expect(within(dialog).getByText(text.sourceModal.note)).toBeTruthy();

    fireEvent.click(
      within(dialog).getByRole("button", { name: text.sourceModal.write }),
    );
    expect(actions(harness)).toContainEqual({ type: "writeSourceEdits" });
  });

  it("shows a source write error and closes when settled", () => {
    const text = harness.text.preview;
    render(<harness.App boot={makeBoot(makeModel())} text={harness.text} />);
    postHostMessage({ type: "sourceConfirm", data: makeSourceConfirmation() });
    const dialog = screen.getByRole("dialog", { name: text.sourceModal.title });

    postHostMessage({ type: "sourceError", message: "Source is busy" });
    expect(within(dialog).getByRole("alert").textContent).toBe("Source is busy");
    expect(
      (within(dialog).getByRole("button", {
        name: text.sourceModal.write,
      }) as HTMLButtonElement).disabled,
    ).toBe(false);

    postHostMessage({ type: "sourceSettled" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("closes without writing when cancelled", () => {
    const text = harness.text.preview;
    render(<harness.App boot={makeBoot(makeModel())} text={harness.text} />);
    postHostMessage({ type: "sourceConfirm", data: makeSourceConfirmation() });
    fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: text.sourceModal.cancel,
      }),
    );

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(actions(harness)).toContainEqual({ type: "cancelSourceWrite" });
  });
});
