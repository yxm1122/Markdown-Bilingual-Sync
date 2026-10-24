/** 测试：Mock Provider 的输出与调用约定。 */
import { describe, expect, it } from "vitest";
import { MockTranslationProvider } from "../src/translation/mockProvider";

async function translate(text: string, kind: Parameters<MockTranslationProvider["translate"]>[0]["items"][number]["kind"] = "paragraph") {
  const provider = new MockTranslationProvider();
  const [result] = await provider.translate({
    sourceLanguage: "en",
    targetLanguage: "zh-CN",
    items: [{ id: "b1", text, kind, headingPath: [] }],
    glossary: [],
  });
  return result.text;
}

describe("MockTranslationProvider", () => {
  it("uses the phrase dictionary", async () => {
    await expect(
      translate("The quick brown fox jumps over the lazy dog."),
    ).resolves.toBe("敏捷的棕色狐狸跃过懒狗。");
    await expect(
      translate("Markdown Bilingual Sync", "heading"),
    ).resolves.toBe("Markdown 双语同步");
  });

  it("protects inline code, links, URLs, math and alert markers", async () => {
    const text =
      "> [!NOTE]\n> Read `translate` at https://example.com and $E=mc^2$ with [the guide](https://example.com).";
    const result = await translate(text, "blockquote");
    expect(result).toContain("[!NOTE]");
    expect(result).toContain("`translate`");
    expect(result).toContain("https://example.com");
    expect(result).toContain("$E=mc^2$");
    expect(result).toContain("[the guide](https://example.com)");
  });

  it("adds a fallback marker while preserving block structure", async () => {
    await expect(translate("Zebra crossing.")).resolves.toBe(
      "【译】Zebra crossing.",
    );
    await expect(translate("- Zebra crossing.", "list")).resolves.toBe(
      "- 【译】Zebra crossing.",
    );
    await expect(translate("# Zebra crossing.", "heading")).resolves.toBe(
      "# 【译】Zebra crossing.",
    );
  });

  it("does not add a marker to image-only paragraphs", async () => {
    const text = "![Preview diagram](assets/demo.svg)";
    await expect(translate(text)).resolves.toBe(text);
  });

  it("applies glossary entries", async () => {
    const provider = new MockTranslationProvider();
    const [result] = await provider.translate({
      sourceLanguage: "en",
      targetLanguage: "zh-CN",
      items: [
        { id: "b1", text: "Bilingual preview", kind: "paragraph", headingPath: [] },
      ],
      glossary: [{ source: "Bilingual preview", target: "双语文稿预览" }],
    });
    expect(result.text).toBe("双语文稿预览");
  });
});
