/**
 * Webview 组件测试运行器。
 *
 * bridge.ts 在模块加载时读取 `acquireVsCodeApi` 与页面里的文案脚本，因此测试必须
 * 先准备 DOM 和消息捕获器，再动态 import `app`。所有用例共用同一个模块实例，
 * 通过 `resetHarness()` 重置发送记录、持久化状态与挂载容器。
 */
import { act } from "@testing-library/preact";
import type { ComponentType } from "preact";
import type { PreviewHostMessage } from "../../src/preview/protocol";
import type {
  BootData,
  OutboundMessage,
  UiCatalog,
} from "../../src/webview/preview/types";
import { UI_TEXT } from "../../src/i18n";
import { installDomPolyfills } from "./dom";

interface WebviewApiState {
  mode?: "bilingual" | "source" | "target";
  bodyScroll?: number;
  sourceScroll?: number;
  targetScroll?: number;
}

interface WebviewApi {
  postMessage(message: unknown): void;
  getState(): WebviewApiState;
  setState(state: WebviewApiState): void;
}

export interface WebviewHarness {
  App: ComponentType<{ boot: BootData; text: UiCatalog }>;
  text: UiCatalog;
  messages: OutboundMessage[];
  apiState: WebviewApiState;
}

let harness: WebviewHarness | null = null;
let resetPersisted: ((state: WebviewApiState) => void) | null = null;

/**
 * 准备页面并加载 App；同一测试文件内只执行一次。
 */
export async function loadHarness(): Promise<WebviewHarness> {
  if (harness) {
    return harness;
  }
  installDomPolyfills();

  const apiState: WebviewApiState = {};
  const messages: OutboundMessage[] = [];
  const api: WebviewApi = {
    postMessage(message) {
      messages.push(message as OutboundMessage);
    },
    getState() {
      return apiState;
    },
    setState(state) {
      for (const key of Object.keys(apiState) as (keyof WebviewApiState)[]) {
        delete apiState[key];
      }
      Object.assign(apiState, state);
    },
  };
  Object.defineProperty(globalThis, "acquireVsCodeApi", {
    value: () => api,
    configurable: true,
  });

  // bridge 在加载时读取文案；App 的某些子组件仍通过模块级 catalog 取取消按钮文案。
  document.body.innerHTML = "";
  const textNode = document.createElement("script");
  textNode.type = "application/json";
  textNode.id = "mbs-ui-text";
  textNode.textContent = JSON.stringify(UI_TEXT);
  document.body.appendChild(textNode);

  const [appModule, bridgeModule] = await Promise.all([
    import("../../src/webview/preview/app"),
    import("../../src/webview/preview/bridge"),
  ]);
  resetPersisted = bridgeModule.saveState as unknown as (state: WebviewApiState) => void;

  harness = {
    App: appModule.App as ComponentType<{ boot: BootData; text: UiCatalog }>,
    text: UI_TEXT as UiCatalog,
    messages,
    apiState,
  };
  return harness;
}

/** 每个用例前清空消息、持久化状态和 DOM。 */
export function resetHarness(): void {
  if (!harness) {
    return;
  }
  harness.messages.length = 0;
  resetPersisted?.({
    mode: "bilingual",
    bodyScroll: 0,
    sourceScroll: 0,
    targetScroll: 0,
  });
}

/** 模拟宿主 → Webview 消息，并包一层 act 触发 Preact 更新。 */
export function postHostMessage(message: PreviewHostMessage): void {
  act(() => {
    window.dispatchEvent(new MessageEvent("message", { data: message }));
  });
}

/** 返回除 ready 握手以外的上行消息。 */
export function actions(harness: WebviewHarness): OutboundMessage[] {
  return harness.messages.filter((message) => message.type !== "ready");
}
