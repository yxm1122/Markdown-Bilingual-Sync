/**
 * 翻译任务视图（Webview）HTML 生成器。
 *
 * 职责：
 * - 拼装任务面板的静态骨架（工具栏 + 内容占位 + 内联文案）；
 * - 收紧 CSP：禁止外部网络、禁止内联事件脚本，仅允许扩展 media 资源与本次 nonce；
 * - 把 UI 文案以 JSON 形式注入页面，供 taskView.js 使用。
 *
 * 生命周期：无状态纯函数，每次 resolveWebviewView 调用一次；
 * HTML 一旦写入 webview，后续状态全部通过 postMessage 推送，不再重建页面。
 *
 * 关键不变量：
 * - nonce 每次调用由调用方新生成，不能复用；
 * - 资源只从扩展 media 目录加载（与 provider 的 localResourceRoots 保持一致）；
 * - 所有插值都必须来自静态文案或已转义数据，避免 HTML 注入。
 */
import * as vscode from "vscode";
import { UI_TEXT } from "../i18n/zh";

/** buildTaskViewHtml 的输入参数。 */
export interface TaskViewHtmlInput {
  /** 目标 webview，用于把本地文件路径转换为可加载的 URI 并获取 cspSource。 */
  webview: vscode.Webview;
  /** 扩展根目录，media 资源位于其下。 */
  extensionUri: vscode.Uri;
  /** 本次页面的 CSP nonce（base64，建议每次新建）。 */
  nonce: string;
}

/**
 * 生成任务视图的完整 HTML。
 *
 * @param input webview、扩展根目录与 nonce
 * @returns 可直接赋给 webview.html 的字符串
 * @sideeffect 无（不写文件、不发消息）
 * @failure 仅在 extensionUri 非法等极端情况下由 Uri.joinPath 抛错
 */
export function buildTaskViewHtml(input: TaskViewHtmlInput): string {
  const { webview, extensionUri, nonce } = input;
  const mediaRoot = vscode.Uri.joinPath(extensionUri, "media");
  const cssUri = webview.asWebviewUri(
    vscode.Uri.joinPath(mediaRoot, "taskView.css"),
  );
  const scriptUri = webview.asWebviewUri(
    vscode.Uri.joinPath(mediaRoot, "taskView.js"),
  );
  // 最小权限：默认全禁；样式允许内联（组件状态需要），脚本仅允许扩展资源 + nonce。
  const csp = [
    "default-src 'none'",
    `img-src ${webview.cspSource} data:`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `font-src ${webview.cspSource}`,
    `script-src ${webview.cspSource} 'nonce-${nonce}'`,
    "connect-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
  ].join("; ");
  // 内联到 <script type="application/json"> 中：转义 "<" 防止提前闭合标签。
  const text = JSON.stringify(UI_TEXT.taskPanel).replaceAll("<", "\\u003c");

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<link rel="stylesheet" href="${cssUri}">
<title>${UI_TEXT.taskPanel.title}</title>
</head>
<body>
<div class="task-root">
  <div class="task-toolbar">
    <span class="task-toolbar-title">${UI_TEXT.taskPanel.title}</span>
    <span class="task-toolbar-actions">
      <button type="button" data-action="cancelAll" disabled>${UI_TEXT.taskPanel.cancelAll}</button>
      <button type="button" data-action="clearFinished" disabled>${UI_TEXT.taskPanel.clearFinished}</button>
      <button type="button" data-action="openOutput">${UI_TEXT.taskPanel.openOutput}</button>
    </span>
  </div>
  <div id="task-content" class="task-content" aria-live="polite"></div>
</div>
<script id="mbs-task-text" type="application/json">${text}</script>
<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}
