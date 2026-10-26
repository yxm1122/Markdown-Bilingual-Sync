/** 测试：原生预览首屏壳的 CSP、资源、状态注入与转义。 */
import { describe, expect, it } from "vitest";
import * as vscode from "vscode";
import { UI_TEXT } from "../src/i18n";
import { buildPreviewAppShell } from "../src/preview/appShell";
import { buildPreviewModel } from "../src/preview/previewModel";

const webview = {
  cspSource: "vscode-webview://test",
  asWebviewUri: (uri: { fsPath: string }) => `https://webview.test${uri.fsPath}`,
};

function buildModel(fileLabel = "demo.md") {
  return buildPreviewModel({
    sourceText: "Hello\n\n<script>alert(1)</script> is text",
    sourceLanguage: "en",
    targetLanguage: "zh-CN",
    providerLabel: "Mock",
    fileLabel,
  });
}

describe("native preview shell", () => {
  it("builds a stable app shell with CSP, assets and initial state", () => {
    const model = buildModel();
    const html = buildPreviewAppShell({
      webview: webview as never,
      extensionUri: vscode.Uri.file("/extension") as never,
      nonce: "test-nonce",
      state: {
        model,
        layout: "columns",
        readonly: { source: false, target: false },
      },
      notice: { text: "Loaded", kind: "info" },
      exportConfirmation: {
        destination: "demo.zh-CN.md",
        summary: "new",
        warningCount: 0,
        existing: false,
        diff: { rows: [], added: 0, removed: 0, unchanged: 0, coarse: false, truncated: 0 },
      },
    });

    expect(html).toContain('<div id="mbs-app"></div>');
    expect(html).toContain('id="mbs-ui-text"');
    expect(html).toContain('id="mbs-initial-state"');
    expect(html).toContain("preview-native.css");
    expect(html).toContain("codicons/codicon.css");
    expect(html).toContain("katex.min.css");
    expect(html).toContain("dist/webview/preview.js");
    expect(html).toContain("script-src 'nonce-test-nonce'");
    expect(html).toContain("connect-src 'none'");
    expect(html).toContain("exportConfirmation");
    expect(html).toContain("Loaded");
    // 初始状态 JSON 里的 Markdown / 用户文本必须阻断 </script>。
    expect(html).not.toContain("</script><");
    expect(html).not.toContain("<!DOCTYPE html><script");
  });

  it("escapes the document title and state text into JSON", () => {
    const malicious = '</script><img src=x onerror="alert(1)">';
    const model = buildModel(malicious);
    const html = buildPreviewAppShell({
      webview: webview as never,
      extensionUri: vscode.Uri.file("/extension") as never,
      nonce: "n",
      state: {
        model,
        layout: "columns",
        readonly: { source: false, target: false },
      },
    });

    expect(html).not.toContain('<img src=x');
    expect(html).toContain("&lt;img src=x");
    // JSON 脚本里的 "<" 一律转义，防止提前闭合 script 标签。
    expect(html).toContain("\u003c/script>");
  });

  it("uses the localized title suffix and sends the text catalog", () => {
    const html = buildPreviewAppShell({
      webview: webview as never,
      extensionUri: vscode.Uri.file("/extension") as never,
      nonce: "n",
      state: {
        model: buildModel(),
        layout: "columns",
        readonly: { source: false, target: false },
      },
    });
    expect(html).toContain(UI_TEXT.preview.titleSuffix);
    expect(html).toContain("mockTranslation");
    expect(html).toContain("noCache");
  });
});
