/** 测试：英文 locale 下的预览 Webview 与日期/耗时格式。 */
import { describe, expect, it, vi } from "vitest";
import { formatDateTime } from "../src/i18n/format";

describe("locale-aware formatting helpers", () => {
  it("formats dates with the given locale", () => {
    const value = "2026-10-24T00:00:00.000Z";
    const expectedEn = new Intl.DateTimeFormat("en", {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date(value));
    const expectedZh = new Intl.DateTimeFormat("zh-cn", {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date(value));
    expect(formatDateTime(value, "en")).toBe(expectedEn);
    expect(formatDateTime(value, "zh-cn")).toBe(expectedZh);
    expect(formatDateTime("not-a-date", "en")).toBe("not-a-date");
  });

  it("renders an English preview Webview using English UI and provider label", async () => {
    vi.resetModules();
    const stub = await import("./vscodeStub");
    const previousLocale = stub.env.language;
    try {
      stub.env.language = "en";
      const { buildPreviewModel } = await import("../src/preview/previewModel");
      const { buildPreviewHtml } = await import("../src/preview/html");
      const model = buildPreviewModel({
        sourceText: "Hello",
        sourceLanguage: "en",
        targetLanguage: "zh-CN",
        providerLabel: "Mock",
        fileLabel: "demo.md",
        assist: {
          stableTranslation: true,
          summaryContext: true,
          summary: {
            text: "English summary",
            stale: false,
            updatedAt: "2026-10-24T00:00:00.000Z",
            model: "openai",
            tokens: 12,
            canGenerate: true,
          },
        },
      });
      const html = buildPreviewHtml({
        model,
        nonce: "test-nonce",
        csp: "default-src 'none'",
        cssHref: "preview.css",
        scriptHref: "preview.js",
        katexHref: "katex.css",
      });
      const expectedTime = new Intl.DateTimeFormat("en", {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(new Date("2026-10-24T00:00:00.000Z"));

      expect(html).toContain('<html lang="en">');
      expect(html).toContain("Bilingual Preview");
      expect(html).toContain("AI translation (OpenAI compatible)");
      expect(html).toContain(expectedTime);
      expect(html).not.toContain("双语预览");
    } finally {
      stub.env.language = previousLocale;
      vi.resetModules();
    }
  });
});
