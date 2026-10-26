/**
 * 原生预览的浏览器桥：VS Code API、初始 JSON、状态持久化与文案格式化。
 *
 * 静态预览（无 acquireVsCodeApi）退化为 localStorage + window.__mbsMessages，
 * 便于直接用浏览器打开生成的页面检查布局。
 */
import type { BootData, OutboundMessage, UiCatalog } from "./types";

interface WebviewState {
  mode?: "bilingual" | "source" | "target";
  bodyScroll?: number;
  sourceScroll?: number;
  targetScroll?: number;
}

const api = (globalThis as unknown as {
  acquireVsCodeApi?: () => {
    postMessage(message: unknown): void;
    getState(): WebviewState | undefined;
    setState(state: WebviewState): void;
  };
}).acquireVsCodeApi;

export const standaloneMode = typeof api !== "function";

const stub = {
  postMessage(message: unknown) {
    const target = window as unknown as {
      __mbsMessages?: unknown[];
    };
    target.__mbsMessages = (target.__mbsMessages ?? []).concat([message]);
    console.log("[mbs-v2] message", message);
  },
  getState(): WebviewState | undefined {
    try {
      return JSON.parse(localStorage.getItem("mbs-preview-state") || "{}");
    } catch {
      return undefined;
    }
  },
  setState(state: WebviewState) {
    try {
      localStorage.setItem("mbs-preview-state", JSON.stringify(state));
    } catch {
      /* ignore */
    }
  },
};

export const vscode = api ? api() : stub;

let persisted: WebviewState = (() => {
  try {
    return vscode.getState() ?? {};
  } catch {
    return {};
  }
})();

export function readJson<T>(id: string): T | undefined {
  const node = document.getElementById(id);
  if (!node) {
    return undefined;
  }
  try {
    return JSON.parse(node.textContent || "") as T;
  } catch {
    return undefined;
  }
}

export const boot = readJson<BootData>("mbs-initial-state");
export const catalog = readJson<UiCatalog>("mbs-ui-text");

export function saveState(patch: Partial<WebviewState>): void {
  persisted = { ...persisted, ...patch };
  try {
    vscode.setState(persisted);
  } catch {
    /* ignore */
  }
}

export function savedState(): WebviewState {
  return persisted;
}

export function send(message: OutboundMessage): void {
  try {
    vscode.postMessage(message);
  } catch {
    /* ignore */
  }
}

export function formatText(
  template: string | undefined,
  values?: Record<string, string | number>,
): string {
  if (!template) {
    return "";
  }
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    values && Object.prototype.hasOwnProperty.call(values, name)
      ? String(values[name])
      : match,
  );
}
