/**
 * 原生预览 Webview 入口：读取宿主注入的初始状态与文案，挂载 Preact 应用。
 */
import { render } from "preact";
import { App } from "./app";
import { boot, catalog } from "./bridge";

const root = document.getElementById("mbs-app");
if (!root) {
  throw new Error("mbs-app container missing");
}

if (!boot || !catalog) {
  root.textContent = "Preview failed to load: initial state or UI text is missing.";
} else {
  render(<App boot={boot} text={catalog} />, root);
}
