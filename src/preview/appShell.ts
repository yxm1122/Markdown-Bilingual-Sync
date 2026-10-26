/**
 * 原生预览（Preact）首次加载的静态壳。
 *
 * 页面只包含 CSP、主题样式、KaTeX/codicon、脚本和两份 JSON：
 * - `mbs-ui-text`：宿主已本地化的预览文案目录；
 * - `mbs-initial-state`：PreviewModel + 布局 + 只读状态 + 初始提示/导出确认。
 *
 * 之后宿主只发送 `state` 消息；本文件生成的 HTML 不会在每次刷新时重写。
 */
import * as vscode from "vscode";
import { getLocale, UI_TEXT } from "../i18n";
import type {
  ExportConfirmationView,
} from "../export/diffPreview";
import type { PreviewAppState, PreviewNotice } from "./protocol";

export interface PreviewAppShellInput {
  webview: vscode.Webview;
  extensionUri: vscode.Uri;
  nonce: string;
  state: PreviewAppState;
  notice?: PreviewNotice;
  exportConfirmation?: ExportConfirmationView;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function jsonForScript(value: unknown): string {
  return JSON.stringify(value).replaceAll("<", "\\u003c");
}

export function buildPreviewAppShell(input: PreviewAppShellInput): string {
  const { webview, extensionUri, nonce, state, notice, exportConfirmation } =
    input;
  const mediaRoot = vscode.Uri.joinPath(extensionUri, "media");
  const webviewRoot = vscode.Uri.joinPath(extensionUri, "dist", "webview");
  const cssUri = webview.asWebviewUri(
    vscode.Uri.joinPath(mediaRoot, "preview-native.css"),
  );
  const codiconUri = webview.asWebviewUri(
    vscode.Uri.joinPath(mediaRoot, "codicons", "codicon.css"),
  );
  const katexUri = webview.asWebviewUri(
    vscode.Uri.joinPath(mediaRoot, "katex", "katex.min.css"),
  );
  const scriptUri = webview.asWebviewUri(
    vscode.Uri.joinPath(webviewRoot, "preview.js"),
  );

  const csp = [
    "default-src 'none'",
    `img-src ${webview.cspSource} https: data:`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `font-src ${webview.cspSource}`,
    `script-src 'nonce-${nonce}'`,
    "connect-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
  ].join("; ");

  const uiText = jsonForScript({
    preview: UI_TEXT.preview,
    providers: UI_TEXT.providers,
    consistency: { noCache: UI_TEXT.consistency.noCache },
  });
  const initial = jsonForScript({ state, notice, exportConfirmation });

  return `<!DOCTYPE html>
<html lang="${escapeHtml(getLocale())}">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="color-scheme" content="light dark">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<title>${escapeHtml(state.model.fileLabel)} · ${escapeHtml(UI_TEXT.preview.titleSuffix)}</title>
<link rel="stylesheet" href="${katexUri}">
<link rel="stylesheet" href="${codiconUri}">
<link rel="stylesheet" href="${cssUri}">
</head>
<body>
<div id="mbs-app"></div>
<script type="application/json" nonce="${nonce}" id="mbs-ui-text">${uiText}</script>
<script type="application/json" nonce="${nonce}" id="mbs-initial-state">${initial}</script>
<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}
