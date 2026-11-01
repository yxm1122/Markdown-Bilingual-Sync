/** 测试：languageModelTools 清单、激活事件与 NLS 文案保持一致。 */
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { AGENT_TOOL_NAMES } from "../src/agent/toolNames";

const root = process.cwd();
const manifest = JSON.parse(
  readFileSync(path.join(root, "package.json"), "utf8"),
) as {
  engines: { vscode: string };
  activationEvents: string[];
  contributes: {
    languageModelTools: Array<{
      name: string;
      tags: string[];
      toolReferenceName: string;
      displayName: string;
      userDescription: string;
      modelDescription: string;
      canBeReferencedInPrompt: boolean;
      icon: string;
      inputSchema: {
        type: string;
        properties: Record<string, unknown>;
        required?: string[];
        additionalProperties?: boolean;
      };
    }>;
  };
};
const nlsEn = JSON.parse(
  readFileSync(path.join(root, "package.nls.json"), "utf8"),
) as Record<string, string>;
const nlsZh = JSON.parse(
  readFileSync(path.join(root, "package.nls.zh-cn.json"), "utf8"),
) as Record<string, string>;

const tools = manifest.contributes.languageModelTools;

describe("language model tools manifest", () => {
  it("registers exactly the five stable tool names", () => {
    expect(tools.map((tool) => tool.name).sort()).toEqual(
      Object.values(AGENT_TOOL_NAMES).sort(),
    );
    expect(new Set(tools.map((tool) => tool.name)).size).toBe(tools.length);
  });

  it("activates the extension for every tool invocation", () => {
    for (const tool of tools) {
      expect(manifest.activationEvents).toContain(
        `onLanguageModelTool:${tool.name}`,
      );
    }
  });

  it("requires a VS Code version with the stable Language Model Tools API", () => {
    expect(manifest.engines.vscode).toBe("^1.95.0");
  });

  it("provides localized display names and user descriptions", () => {
    for (const tool of tools) {
      expect(tool.displayName).toMatch(/^%tool\.[\w]+\.displayName%$/);
      expect(tool.userDescription).toMatch(/^%tool\.[\w]+\.userDescription%$/);
      const displayKey = tool.displayName.slice(1, -1);
      const userKey = tool.userDescription.slice(1, -1);
      expect(nlsEn[displayKey], `missing ${displayKey}`).toBeTruthy();
      expect(nlsZh[displayKey], `missing zh ${displayKey}`).toBeTruthy();
      expect(nlsEn[userKey], `missing ${userKey}`).toBeTruthy();
      expect(nlsZh[userKey], `missing zh ${userKey}`).toBeTruthy();
      expect(nlsEn[displayKey]).not.toMatch(/[\u4e00-\u9fff]/);
    }
  });

  it("gives each tool a unique # reference and useful model description", () => {
    const references = tools.map((tool) => tool.toolReferenceName);
    expect(new Set(references).size).toBe(references.length);
    for (const tool of tools) {
      expect(tool.toolReferenceName).toMatch(/^mbs[A-Z][A-Za-z]+$/);
      expect(tool.modelDescription.length).toBeGreaterThan(80);
      expect(tool.modelDescription).not.toMatch(/[\u4e00-\u9fff]/);
      expect(tool.canBeReferencedInPrompt).toBe(true);
      expect(tool.icon).toMatch(/^\$\([a-z-]+\)$/);
      expect(tool.tags).toContain("markdown-bilingual-sync");
      expect(tool.tags).toContain("glossary");
    }
  });

  it("declares object input schemas with closed additional properties", () => {
    for (const tool of tools) {
      expect(tool.inputSchema.type).toBe("object");
      expect(tool.inputSchema.additionalProperties).toBe(false);
      expect(tool.inputSchema.properties).toBeTypeOf("object");
    }
    const updateGlossary = tools.find(
      (tool) => tool.name === AGENT_TOOL_NAMES.updateGlossary,
    );
    expect(updateGlossary?.inputSchema.required).toEqual(["scope"]);
  });

  it("declares glossary entry item schemas with required source and target", () => {
    const schemas = tools.flatMap((tool) => {
      const properties = tool.inputSchema.properties as Record<
        string,
        { items?: { type?: string; required?: string[] } }
      >;
      return Object.values(properties)
        .filter((property) => property.items?.type === "object")
        .map((property) => property.items!);
    });
    expect(schemas.length).toBeGreaterThan(0);
    for (const schema of schemas) {
      expect(schema.required).toEqual(["source", "target"]);
    }
  });
});
