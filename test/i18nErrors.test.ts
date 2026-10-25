/** 测试：错误目录的 key 唯一性、bundle 覆盖与中/英文 tError 行为。 */
import { describe, expect, it, vi } from "vitest";
import { tError } from "../src/i18n/errors";
import { ERROR_MESSAGES } from "../src/i18n/errors/catalog";

describe("runtime error localization", () => {
  it("uses the zh-cn bundle under the default test locale", () => {
    expect(tError("common.missingSourceBlock", { index: 2 })).toBe(
      "找不到第 2 个原文块。",
    );
    expect(tError("common.translationCancelled")).toBe("翻译已取消");
    expect(tError("cache.openBeforeClear")).toBe(
      "译文缓存正在编辑器中打开，请先关闭缓存标签页再清理。",
    );
  });

  it("keeps every catalog key unique and covered by the zh bundle", () => {
    const keys = ERROR_MESSAGES.map((message) => message.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const message of ERROR_MESSAGES) {
      expect(tError(message.key), message.key).toBe(message.zh);
    }
  });

  it("translates errors to English when the locale is English", async () => {
    vi.resetModules();
    const stub = await import("./vscodeStub");
    const previousLocale = stub.env.language;
    try {
      stub.env.language = "en";
      const errors = await import("../src/i18n/errors");
      expect(errors.tError("common.missingSourceBlock", { index: 2 })).toBe(
        "Source block 2 was not found.",
      );
      expect(errors.tError("common.translationCancelled")).toBe(
        "Translation cancelled",
      );
    } finally {
      stub.env.language = previousLocale;
      vi.resetModules();
    }
  });
});
