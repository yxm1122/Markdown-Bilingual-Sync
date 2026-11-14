// @vitest-environment jsdom
/**
 * 预览交互：任务活动呼吸指示、交互锁上报与释放。
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
  cleanup();
});

function activityChip(): HTMLButtonElement | null {
  return document.querySelector(
    ".pv-task-activity",
  ) as HTMLButtonElement | null;
}

describe("task activity breathing", () => {
  it("breathes while tasks are active and starts from zero", () => {
    render(<harness.App boot={makeBoot(makeModel())} text={harness.text} />);
    expect(activityChip()).toBeNull();

    postHostMessage({ type: "taskActivity", running: 1, queued: 0 });
    const chip = activityChip();
    expect(chip).toBeTruthy();
    expect(chip?.classList.contains("is-breathing")).toBe(true);
    expect(
      screen.getByTitle(harness.text.preview.toolbar.taskActivityTitle),
    ).toBe(chip);
  });

  it("keeps a single breathing chip while counts change", () => {
    render(<harness.App boot={makeBoot(makeModel())} text={harness.text} />);
    postHostMessage({ type: "taskActivity", running: 2, queued: 1 });
    expect(activityChip()?.classList.contains("is-breathing")).toBe(true);

    postHostMessage({ type: "taskActivity", running: 1, queued: 3 });
    const chips = document.querySelectorAll(".pv-task-activity");
    expect(chips).toHaveLength(1);
    expect(chips[0]?.classList.contains("is-breathing")).toBe(true);
  });

  it("stops breathing when all tasks finish", () => {
    render(<harness.App boot={makeBoot(makeModel())} text={harness.text} />);
    postHostMessage({ type: "taskActivity", running: 1, queued: 1 });
    expect(activityChip()).toBeTruthy();

    postHostMessage({ type: "taskActivity", running: 0, queued: 0 });
    expect(activityChip()).toBeNull();
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
