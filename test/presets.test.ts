/** 测试：翻译服务预设与配置写入。 */
import { describe, expect, it } from "vitest";
import { PROVIDER_PRESETS } from "../src/translation/presets";

describe("provider presets", () => {
  it("has unique ids and known providers", () => {
    const ids = PROVIDER_PRESETS.map((preset) => preset.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const preset of PROVIDER_PRESETS) {
      expect(["mock", "openai", "http"]).toContain(preset.provider);
    }
  });

  it("never embeds secrets in preset settings", () => {
    for (const preset of PROVIDER_PRESETS) {
      const settings = JSON.stringify(preset.settings ?? {});
      expect(settings).not.toMatch(/apiKey|Authorization|Bearer|sk-/i);
    }
  });

  it("includes OpenAI-compatible endpoint presets", () => {
    const deepseek = PROVIDER_PRESETS.find((preset) => preset.id === "deepseek");
    expect(deepseek?.provider).toBe("openai");
    expect(deepseek?.settings?.apiBaseUrl).toBe(
      "https://api.deepseek.com/v1",
    );
    expect(deepseek?.settings?.apiModel).toBe("deepseek-chat");
  });
});
