/** 测试：UI_TEXT 与错误目录不存在未引用 key。 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { UI_TEXT } from "../src/i18n/en";
import { ERROR_MESSAGES } from "../src/i18n/errors/catalog";

const root = process.cwd();

/** 收集源码、测试与 Webview 脚本内容，供引用扫描使用。 */
function collectCorpus(): string {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) {
        // i18n 目录是文案定义本身，不参与“是否被引用”的扫描。
        if (full.includes(path.join("src", "i18n"))) continue;
        walk(full);
      } else if (full.endsWith(".ts") || full.endsWith(".js")) {
        files.push(full);
      }
    }
  };
  walk(path.join(root, "src"));
  walk(path.join(root, "test"));
  walk(path.join(root, "media"));
  return files.map((file) => readFileSync(file, "utf8")).join("\n");
}

function flatten(value: unknown, prefix = "", out: string[] = []): string[] {
  if (typeof value === "string") {
    out.push(prefix);
    return out;
  }
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      flatten(child, prefix ? `${prefix}.${key}` : key, out);
    }
  }
  return out;
}

describe("localization key usage", () => {
  const corpus = collectCorpus();
  const html = readFileSync(path.join(root, "src/preview/html.ts"), "utf8");
  const exportService = readFileSync(
    path.join(root, "src/export/exportService.ts"),
    "utf8",
  );
  const taskViewJs = readFileSync(
    path.join(root, "media/taskView.js"),
    "utf8",
  );
  const previewManager = readFileSync(
    path.join(root, "src/preview/previewManager.ts"),
    "utf8",
  );

  /** 整体按对象使用（索引/遍历）的父级，其子 key 不再逐个扫描。 */
  const isDynamicallyUsed = (leaf: string): boolean => {
    if (
      leaf.startsWith("preview.kindLabels.") ||
      leaf.startsWith("preview.statusLabels.")
    ) {
      return (
        corpus.includes("UI_TEXT.preview.kindLabels") ||
        html.includes("T.kindLabels")
      );
    }
    if (leaf.startsWith("preview.exportStats.")) {
      return exportService.includes("UI_TEXT.preview.exportStats");
    }
    if (leaf.startsWith("taskPanel.statusLabels.")) {
      return (
        corpus.includes("UI_TEXT.taskPanel.statusLabels") ||
        taskViewJs.includes("TEXT.statusLabels")
      );
    }
    if (leaf.startsWith("preview.errorPage.")) {
      return previewManager.includes("UI_TEXT.preview.errorPage");
    }
    return false;
  };

  it("has no unreferenced UI_TEXT key", () => {
    const unused = flatten(UI_TEXT).filter((leaf) => {
      if (isDynamicallyUsed(leaf)) return false;
      const candidates = [
        `UI_TEXT.${leaf}`,
        leaf.startsWith("preview.")
          ? `T.${leaf.slice("preview.".length)}`
          : "",
        leaf.startsWith("statusBar.")
          ? `T.${leaf.slice("statusBar.".length)}`
          : "",
        leaf.startsWith("taskPanel.")
          ? `PANEL.${leaf.slice("taskPanel.".length)}`
          : "",
        leaf.startsWith("taskPanel.")
          ? `TEXT.${leaf.slice("taskPanel.".length)}`
          : "",
        leaf.startsWith("preview.exportStats.")
          ? `text.${leaf.slice("preview.exportStats.".length)}`
          : "",
      ].filter(Boolean);
      return !candidates.some((candidate) => corpus.includes(candidate));
    });
    expect(unused).toEqual([]);
  });

  it("has no unreferenced error key", () => {
    const unused = ERROR_MESSAGES.filter(
      (message) => !corpus.includes(`"${message.key}"`),
    ).map((message) => message.key);
    expect(unused).toEqual([]);
  });
});
