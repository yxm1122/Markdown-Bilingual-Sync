// @vitest-environment jsdom
/**
 * bridge.ts：首屏 JSON、文案格式化、VS Code API 与静态预览回退。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { installDomPolyfills } from "./dom";

installDomPolyfills();

function jsonScript(id: string, value: unknown): void {
  const node = document.createElement("script");
  node.type = "application/json";
  node.id = id;
  node.textContent = typeof value === "string" ? value : JSON.stringify(value);
  document.body.appendChild(node);
}

async function importBridge() {
  vi.resetModules();
  return import("../../src/webview/preview/bridge");
}

beforeEach(() => {
  document.body.innerHTML = "";
  window.localStorage.clear();
  delete (globalThis as unknown as { acquireVsCodeApi?: unknown }).acquireVsCodeApi;
  (window as unknown as { __mbsMessages?: unknown[] }).__mbsMessages = [];
  (globalThis as unknown as { __mbsMessages?: unknown[] }).__mbsMessages = [];
  vi.restoreAllMocks();
});

describe("standalone bridge", () => {
  it("reads boot state and UI text from JSON script nodes", async () => {
    jsonScript("mbs-ui-text", { preview: { toolbar: { sync: "Sync" } } });
    jsonScript("mbs-initial-state", {
      state: { layout: "columns" },
      notice: { text: "Hello", kind: "info" },
    });
    const bridge = await importBridge();

    expect(bridge.standaloneMode).toBe(true);
    expect(bridge.catalog?.preview.toolbar.sync).toBe("Sync");
    expect(bridge.boot?.state.layout).toBe("columns");
    expect(bridge.boot?.notice?.text).toBe("Hello");
  });

  it("returns undefined for missing or malformed JSON", async () => {
    const bridge = await importBridge();
    expect(bridge.readJson("missing")).toBeUndefined();

    jsonScript("broken", "{not json");
    expect(bridge.readJson("broken")).toBeUndefined();
  });

  it("formats placeholders and preserves unknown names", async () => {
    const bridge = await importBridge();
    expect(bridge.formatText("Hello {name}", { name: "Ada" })).toBe("Hello Ada");
    expect(bridge.formatText("{count} of {total}", { count: 2 })).toBe(
      "2 of {total}",
    );
    expect(bridge.formatText(undefined)).toBe("");
  });

  it("records outbound messages and persists state in localStorage", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const bridge = await importBridge();

    bridge.send({ type: "sync" });
    expect(
      (window as unknown as { __mbsMessages?: unknown[] }).__mbsMessages,
    ).toEqual([{ type: "sync" }]);

    bridge.saveState({ mode: "target" });
    bridge.saveState({ bodyScroll: 42 });
    expect(bridge.savedState()).toEqual({ mode: "target", bodyScroll: 42 });
    expect(JSON.parse(window.localStorage.getItem("mbs-preview-state") || "{}")).toEqual({
      mode: "target",
      bodyScroll: 42,
    });
  });

  it("swallows storage failures", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(window.localStorage, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    const bridge = await importBridge();

    expect(() => bridge.saveState({ mode: "source" })).not.toThrow();
    expect(bridge.savedState().mode).toBe("source");
  });
});

describe("VS Code bridge", () => {
  it("uses acquireVsCodeApi when present", async () => {
    const received: unknown[] = [];
    const stored: Record<string, unknown> = {};
    Object.defineProperty(globalThis, "acquireVsCodeApi", {
      configurable: true,
      value: () => ({
        postMessage(message: unknown) {
          received.push(message);
        },
        getState() {
          return stored;
        },
        setState(state: Record<string, unknown>) {
          Object.assign(stored, state);
        },
      }),
    });

    const bridge = await importBridge();
    expect(bridge.standaloneMode).toBe(false);

    bridge.send({ type: "refresh" });
    bridge.saveState({ mode: "source" });
    expect(received).toEqual([{ type: "refresh" }]);
    expect(stored.mode).toBe("source");
    expect(bridge.savedState().mode).toBe("source");
  });

  it("tolerates a throwing getState when loading", async () => {
    Object.defineProperty(globalThis, "acquireVsCodeApi", {
      configurable: true,
      value: () => ({
        postMessage() {},
        getState() {
          throw new Error("disposed");
        },
        setState() {},
      }),
    });

    const bridge = await importBridge();
    expect(bridge.savedState()).toEqual({});
  });
});
