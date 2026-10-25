/** 测试：任务视图静态骨架中的双语言选择器与交换按钮。 */
import { describe, expect, it, vi } from "vitest";
import { UI_TEXT } from "../src/i18n/zh";
import { buildTaskViewHtml } from "../src/status/taskViewHtml";

const mocks = vi.hoisted(() => {
  class FakeUri {
    readonly fsPath: string;

    constructor(fsPath: string) {
      this.fsPath = fsPath;
    }

    static joinPath(base: { fsPath: string }, ...parts: string[]): FakeUri {
      return new FakeUri([base.fsPath, ...parts].join("/"));
    }
  }

  return { FakeUri, vscode: { Uri: FakeUri } };
});

vi.mock("vscode", () => mocks.vscode);

function buildHtml(): string {
  const webview = {
    cspSource: "vscode-webview://test",
    asWebviewUri: (uri: { fsPath: string }) =>
      `https://webview.test${uri.fsPath}`,
  };
  return buildTaskViewHtml({
    webview: webview as never,
    extensionUri: new mocks.FakeUri("/extension") as never,
    nonce: "test-nonce",
  });
}

describe("task view language skeleton", () => {
  it("renders source/target selectors and a swap button before content", () => {
    const html = buildHtml();
    const sourceIndex = html.indexOf('id="task-source-language"');
    const targetIndex = html.indexOf('id="task-target-language"');
    const swapIndex = html.indexOf('data-action="swapLanguages"');
    const contentIndex = html.indexOf('id="task-content"');

    expect(sourceIndex).toBeGreaterThan(-1);
    expect(targetIndex).toBeGreaterThan(-1);
    expect(swapIndex).toBeGreaterThan(-1);
    expect(contentIndex).toBeGreaterThan(-1);
    expect(sourceIndex).toBeLessThan(swapIndex);
    expect(swapIndex).toBeLessThan(targetIndex);
    expect(targetIndex).toBeLessThan(contentIndex);
    expect(html).toContain(
      `aria-label="${UI_TEXT.taskPanel.sourceLanguageLabel}"`,
    );
    expect(html).toContain(
      `aria-label="${UI_TEXT.taskPanel.targetLanguageLabel}"`,
    );
    expect(html).toContain(
      `aria-label="${UI_TEXT.taskPanel.swapLanguagesTitle}"`,
    );
    expect(html).not.toContain('class="task-language-row"');
    expect(html).not.toContain('class="task-language-label"');
  });

  it("starts with empty disabled selectors and a disabled swap button", () => {
    const html = buildHtml();
    expect(html).not.toContain("<option");
    expect(html).toMatch(
      /<select id="task-source-language"[^>]*disabled><\/select>/,
    );
    expect(html).toMatch(
      /<select id="task-target-language"[^>]*disabled><\/select>/,
    );
    expect(html).toMatch(
      /<button[^>]*data-action="swapLanguages"[^>]*disabled/,
    );
  });

  it("injects UI text as JSON for the webview script", () => {
    const html = buildHtml();
    expect(html).toContain('type="application/json"');
    expect(html).toContain(UI_TEXT.taskPanel.targetLanguageTitle);
    expect(html).toContain(UI_TEXT.taskPanel.sourceLanguageTitle);
    expect(html).toContain(UI_TEXT.taskPanel.swapLanguagesTitle);
    expect(html).toContain(UI_TEXT.taskPanel.targetLanguageInvalid);
  });
});
