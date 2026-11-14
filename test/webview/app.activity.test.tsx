// @vitest-environment jsdom
/**
 * 预览交互：新任务闪烁、交互锁上报与释放。
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/preact";
import {
  loadHarness,
  postHostMessage,
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
  vi.useRealTimers();
  cleanup();
});

function activityChip(): HTMLButtonElement | null {
  return document.querySelector(
    ".pv-task-activity",
  ) as HTMLButtonElement | null;
}

describe("task activity flash", () => {
  it("shows the chip without flashing when activity starts from zero", () => {
    render(<harness.App boot={makeBoot(makeModel())} text={harness.text} />);
    expect(activityChip()).toBeNull();

    postHostMessage({ type: "taskActivity", running: 1, queued: 0 });
    const chip = activityChip();
    expect(chip).toBeTruthy();
    expect(chip?.classList.contains("is-flashing")).toBe(false);
    expect(
      screen.getByTitle(harness.text.preview.toolbar.taskActivityTitle),
    ).toBe(chip);
  });

  it("adds the flashing class on taskFlash and removes it afterwards", () => {
    render(<harness.App boot={makeBoot(makeModel())} text={harness.text} />);
    postHostMessage({ type: "taskActivity", running: 1, queued: 0 });

    vi.useFakeTimers();
    postHostMessage({ type: "taskFlash" });
    const chip = activityChip();
    expect(chip?.classList.contains("is-flashing")).toBe(true);

    vi.advanceTimersByTime(1200);
    expect(chip?.classList.contains("is-flashing")).toBe(false);
  });

  it("restarts the animation when another flash arrives", () => {
    render(<harness.App boot={makeBoot(makeModel())} text={harness.text} />);
    postHostMessage({ type: "taskActivity", running: 1, queued: 0 });

    vi.useFakeTimers();
    postHostMessage({ type: "taskFlash" });
    const chip = activityChip();
    expect(chip?.classList.contains("is-flashing")).toBe(true);

    vi.advanceTimersByTime(600);
    postHostMessage({ type: "taskFlash" });
    expect(chip?.classList.contains("is-flashing")).toBe(true);

    vi.advanceTimersByTime(1199);
    expect(chip?.classList.contains("is-flashing")).toBe(true);
    vi.advanceTimersByTime(1);
    expect(chip?.classList.contains("is-flashing")).toBe(false);
  });
});

describe("interaction lock", () => {
  it("reports interaction while a block editor is open and clears on close", () => {
    const { container } = render(
      <harness.App boot={makeBoot(makeModel())} text={harness.text} />,
    );
    const block = container.querySelector(".pv-block") as HTMLElement;

    fireEvent.click(block.querySelector(".pv-pane-target .pv-md") as HTMLElement);
    expect(within(block).getByRole("textbox")).toBeTruthy();
    expect(harness.messages).toContainEqual({
      type: "interaction",
      active: true,
    });

    fireEvent.keyDown(within(block).getByRole("textbox"), { key: "Escape" });
    expect(harness.messages).toContainEqual({
      type: "interaction",
      active: false,
    });
  });

  it("does not report interaction for normal rendering", () => {
    render(<harness.App boot={makeBoot(makeModel())} text={harness.text} />);
    expect(
      harness.messages.some((message) => message.type === "interaction"),
    ).toBe(false);
  });
});
