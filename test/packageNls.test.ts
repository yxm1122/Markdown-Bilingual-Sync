/** 测试：package.json 清单本地化（package.nls）与 l10n bundle 完整性。 */
import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const manifest = JSON.parse(
  readFileSync(path.join(root, "package.json"), "utf8"),
) as {
  displayName: string;
  description: string;
  l10n?: string;
  contributes: {
    commands: Array<{ command: string; title: string; category?: string }>;
    viewsContainers: { activitybar: Array<{ id: string; title: string }> };
    views: Record<string, Array<{ id: string; name: string }>>;
    configuration: {
      title?: string;
      properties: Record<
        string,
        { description?: string; enumDescriptions?: string[] }
      >;
    };
  };
};
const nlsEn = JSON.parse(
  readFileSync(path.join(root, "package.nls.json"), "utf8"),
) as Record<string, string>;
const nlsZh = JSON.parse(
  readFileSync(path.join(root, "package.nls.zh-cn.json"), "utf8"),
) as Record<string, string>;

/** 深度收集所有 `%key%` 引用，保持出现顺序去重。 */
function collectReferences(value: unknown, references: Set<string>): void {
  if (typeof value === "string") {
    for (const match of value.matchAll(/%([\w.]+)%/g)) {
      references.add(match[1]);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectReferences(item, references);
    return;
  }
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) collectReferences(item, references);
  }
}

const references = new Set<string>();
collectReferences(manifest, references);

describe("package manifest localization", () => {
  it("references every NLS key from both language files", () => {
    expect(references.size).toBeGreaterThan(0);
    for (const key of references) {
      expect(nlsEn[key], `package.nls.json missing ${key}`).toBeTruthy();
      expect(nlsZh[key], `package.nls.zh-cn.json missing ${key}`).toBeTruthy();
    }
  });

  it("keeps en/zh NLS key sets identical and fully used", () => {
    const enKeys = Object.keys(nlsEn).sort();
    const zhKeys = Object.keys(nlsZh).sort();
    expect(zhKeys).toEqual(enKeys);
    const unused = enKeys.filter((key) => !references.has(key));
    expect(unused).toEqual([]);
  });

  it("localizes brand fields, commands, views, setting descriptions and enum descriptions", () => {
    expect(manifest.displayName).toBe("%displayName%");
    expect(manifest.description).toBe("%description%");
    expect(manifest.contributes.configuration.title).toBe(
      "%configuration.title%",
    );
    const taskCommands = manifest.contributes.commands.filter((command) =>
      command.command.startsWith("markdownBilingualSync.task."),
    );
    const regularCommands = manifest.contributes.commands.filter(
      (command) => !command.command.startsWith("markdownBilingualSync.task."),
    );
    expect(regularCommands).toHaveLength(21);
    expect(taskCommands).toHaveLength(7);
    for (const command of regularCommands) {
      expect(command.title).toMatch(/^%command\.[\w]+\.title%$/);
      expect(command.category).toBe("%command.category%");
    }
    for (const command of taskCommands) {
      expect(command.title).toMatch(/^%task\.[\w]+\.title%$/);
      expect(command.category).toBeUndefined();
    }
    const container = manifest.contributes.viewsContainers.activitybar[0];
    expect(container.title).toBe("%viewContainer.tasks.title%");
    const view = manifest.contributes.views["markdownBilingualSyncTasks"][0];
    expect(view.name).toBe("%view.tasks.name%");
    const properties = Object.values(manifest.contributes.configuration.properties);
    expect(properties).toHaveLength(20);
    for (const property of properties) {
      expect(property.description).toMatch(/^%configuration\.[\w]+\.description%$/);
    }
    const provider = manifest.contributes.configuration.properties[
      "markdownBilingualSync.provider"
    ];
    expect(provider.enumDescriptions).toHaveLength(3);
    for (const description of provider.enumDescriptions ?? []) {
      expect(description).toMatch(
        /^%configuration\.provider\.enumDescription\.(mock|openai|http)%$/,
      );
    }
    expect(manifest.l10n).toBe("./l10n");
  });

  it("provides Chinese translations for the localized brand fields", () => {
    for (const key of [
      "displayName",
      "description",
      "configuration.title",
      "command.category",
    ]) {
      expect(nlsZh[key], `missing zh value for ${key}`).toMatch(
        /[\u4e00-\u9fff]/,
      );
    }
    expect(nlsZh["command.category"]).toBe("Markdown 双语同步");
    expect(nlsEn["command.category"]).toBe("Markdown Bilingual Sync");
  });

  it("provides English defaults and Chinese translations", () => {
    for (const [key, value] of Object.entries(nlsEn)) {
      expect(value, `${key} should not be empty`).toBeTruthy();
      expect(value, `${key} should not contain Chinese`).not.toMatch(
        /[\u4e00-\u9fff]/,
      );
    }
    for (const [key, value] of Object.entries(nlsZh)) {
      expect(value, `${key} should not be empty`).toBeTruthy();
    }
    expect(nlsZh["command.translateFile.title"]).toBe("翻译当前文件");
    expect(nlsEn["command.translateFile.title"]).toBe(
      "Translate Current File",
    );
  });

  it("ships both l10n bundles", () => {
    for (const file of ["bundle.l10n.json", "bundle.l10n.zh-cn.json"]) {
      const fullPath = path.join(root, "l10n", file);
      expect(existsSync(fullPath), `${file} missing`).toBe(true);
      const bundle = JSON.parse(readFileSync(fullPath, "utf8")) as Record<
        string,
        string
      >;
      expect(Object.keys(bundle).length).toBeGreaterThan(0);
    }
  });
});
