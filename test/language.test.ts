/** 测试：支持的编辑器语言与 package.json 贡献条件。 */
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { isSupportedLanguageId } from "../src/util/language";

describe("supported editor languages", () => {
  it("accepts Markdown and skill language IDs", () => {
    expect(isSupportedLanguageId("markdown")).toBe(true);
    expect(isSupportedLanguageId("skill")).toBe(true);
    expect(isSupportedLanguageId("plaintext")).toBe(false);
    expect(isSupportedLanguageId("")).toBe(false);
  });

  it("declares skill activation and menu conditions", () => {
    const manifest = JSON.parse(
      readFileSync(path.join(process.cwd(), "package.json"), "utf8"),
    ) as {
      activationEvents: string[];
      contributes: {
        menus: Record<string, Array<{ when?: string }>>;
      };
    };
    expect(manifest.activationEvents).toContain("onLanguage:skill");
    const conditions = Object.values(manifest.contributes.menus)
      .flat()
      .map((entry) => entry.when ?? "")
      .filter((when) => when.includes("editorLangId"));
    expect(conditions.length).toBeGreaterThan(0);
    for (const when of conditions) {
      expect(when).toContain("editorLangId == markdown");
      expect(when).toContain("editorLangId == skill");
    }
  });
});
