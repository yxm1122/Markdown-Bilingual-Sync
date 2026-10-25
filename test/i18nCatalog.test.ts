/** 测试：en/zh 目录一致性、占位符、bundle 生成与 locale 行为。 */
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  buildL10nBundles,
  collectCatalogIssues,
  extractPlaceholders,
} from "../src/i18n/catalog";
import { UI_TEXT as EN_TEXT } from "../src/i18n/en";
import { ERROR_MESSAGES } from "../src/i18n/errors/catalog";
import { UI_TEXT as ZH_TEXT } from "../src/i18n/zh";
import { UI_TEXT } from "../src/i18n";

describe("i18n catalogs", () => {
  it("keeps en/zh keys and placeholders in sync", () => {
    expect(collectCatalogIssues(EN_TEXT, ZH_TEXT, ERROR_MESSAGES)).toEqual([]);
  });

  it("extracts named placeholders without duplicates", () => {
    expect(extractPlaceholders("{a} {b} {a}")).toEqual(["a", "b"]);
    expect(extractPlaceholders("no placeholders")).toEqual([]);
  });

  it("generates up-to-date l10n bundles on disk", () => {
    const bundles = buildL10nBundles();
    const diskEn = JSON.parse(
      readFileSync(
        path.join(process.cwd(), "l10n", "bundle.l10n.json"),
        "utf8",
      ),
    ) as Record<string, string>;
    const diskZh = JSON.parse(
      readFileSync(
        path.join(process.cwd(), "l10n", "bundle.l10n.zh-cn.json"),
        "utf8",
      ),
    ) as Record<string, string>;
    expect(diskEn).toEqual(bundles.en);
    expect(diskZh).toEqual(bundles.zh);
    expect(bundles.messageCount).toBeGreaterThan(0);
    expect(diskZh[EN_TEXT.taskPanel.title]).toBe(ZH_TEXT.taskPanel.title);
  });

  it("localizes UI_TEXT to Chinese under the default test locale", () => {
    expect(UI_TEXT.taskPanel.title).toBe("翻译任务");
    expect(UI_TEXT.preview.toolbar.sync).toBe("同步译文");
  });

  it("localizes UI_TEXT to English when the locale is English", async () => {
    vi.resetModules();
    const stub = await import("./vscodeStub");
    stub.env.language = "en";
    const english = await import("../src/i18n");
    expect(english.UI_TEXT.taskPanel.title).toBe("Translation Tasks");
    expect(english.UI_TEXT.preview.toolbar.sync).toBe("Sync translation");
    stub.env.language = "zh-cn";
    vi.resetModules();
  });
});
