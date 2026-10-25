/** 测试：本地化文案含引号/尖括号时不得破坏 Webview HTML。 */
import { afterEach, describe, expect, it } from "vitest";
import * as vscode from "vscode";
import { UI_TEXT } from "../src/i18n";
import { buildPreviewHtml } from "../src/preview/html";
import { buildPreviewModel } from "../src/preview/previewModel";
import { buildTaskViewHtml } from "../src/status/taskViewHtml";

const MALICIOUS_TEXT = '<img src=x onerror="alert(1)">';
const MALICIOUS_ATTRIBUTE = '"><img src=x onerror="alert(1)">';
const restore: Array<() => void> = [];

function override(target: Record<string, unknown>, key: string, value: string): void {
  const previous = target[key];
  target[key] = value;
  restore.push(() => {
    target[key] = previous;
  });
}

afterEach(() => {
  while (restore.length > 0) restore.pop()?.();
});

describe("webview localization escaping", () => {
  it("escapes task view text and attribute interpolations", () => {
    override(
      UI_TEXT.taskPanel as unknown as Record<string, unknown>,
      "title",
      MALICIOUS_TEXT,
    );
    override(
      UI_TEXT.taskPanel as unknown as Record<string, unknown>,
      "sourceLanguageTitle",
      MALICIOUS_ATTRIBUTE,
    );

    const webview = {
      cspSource: "vscode-webview://test",
      asWebviewUri: (uri: { fsPath: string }) =>
        `https://webview.test${uri.fsPath}`,
    };
    const html = buildTaskViewHtml({
      webview: webview as never,
      extensionUri: vscode.Uri.file("/extension") as never,
      nonce: "test-nonce",
    });

    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
    expect(html).toContain(
      "&quot;&gt;&lt;img src=x onerror=&quot;alert(1)&quot;&gt;",
    );
    // JSON 注入路径也把 "<" 编码，避免提前闭合脚本标签。
    expect(html).not.toContain('<script type="application/json">{"title":"<');
  });

  it("escapes preview text and title attribute interpolations", () => {
    override(
      UI_TEXT.preview.toolbar as unknown as Record<string, unknown>,
      "sync",
      MALICIOUS_TEXT,
    );
    override(
      UI_TEXT.preview.toolbar as unknown as Record<string, unknown>,
      "openCacheFolder",
      MALICIOUS_ATTRIBUTE,
    );

    const model = buildPreviewModel({
      sourceText: "Hello",
      sourceLanguage: "en",
      targetLanguage: "zh-CN",
      providerLabel: "Mock",
      fileLabel: "demo.md",
    });
    const html = buildPreviewHtml({
      model,
      nonce: "test-nonce",
      csp: "default-src 'none'",
      cssHref: "preview.css",
      scriptHref: "preview.js",
      katexHref: "katex.css",
    });

    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
    expect(html).toContain(
      "&quot;&gt;&lt;img src=x onerror=&quot;alert(1)&quot;&gt;",
    );
  });
});
