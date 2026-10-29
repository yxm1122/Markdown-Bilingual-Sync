/** 测试：摘要上下文的 frontmatter 白名单与相对路径。 */
import { describe, expect, it } from "vitest";
import {
  buildDocumentMetadata,
  parseFrontmatterMetadata,
  stripFrontmatterText,
} from "../src/markdown/documentMetadata";

describe("document metadata", () => {
  it("extracts whitelisted scalar, list, and block values", () => {
    const raw = [
      "---",
      'title: "Auth Guide"',
      "name: auth-api",
      "description: >",
      "  How API keys",
      "  and sessions work.",
      "tags: [api, \"security\", api]",
      "keywords:",
      "  - login",
      "  - token",
      "categories: [guide]",
      "audience: backend developers # client developers",
      "product: Acme API",
      "project: Atlas",
      "version: v2",
      "locale: en-US",
      "lang: en",
      "type: guide",
      "doctype: api",
      "nested:",
      "  title: Ignored",
      "  tags: [ignored]",
      "ignored: value",
      "---",
    ].join("\n");

    expect(parseFrontmatterMetadata(raw)).toEqual({
      title: "Auth Guide",
      name: "auth-api",
      description: "How API keys and sessions work.",
      tags: ["api", "security"],
      keywords: ["login", "token"],
      categories: ["guide"],
      audience: "backend developers",
      product: "Acme API",
      project: "Atlas",
      version: "v2",
      locale: "en-US",
      lang: "en",
      type: "guide",
      docType: "api",
    });
  });

  it("caps values, drops unsupported nested data, and normalizes paths", () => {
    const raw = [
      "---",
      `description: ${"x".repeat(400)}`,
      `tags: [${Array.from({ length: 12 }, (_, index) => `tag-${index}`).join(", ")}]`,
      "---",
    ].join("\n");
    const metadata = buildDocumentMetadata(
      raw,
      "docs\\guide\\auth.md",
    )!;

    expect(metadata.description).toHaveLength(300);
    expect(metadata.tags).toHaveLength(10);
    expect(metadata.relativePath).toBe("docs/guide/auth.md");
    expect(metadata).not.toHaveProperty("nested");
  });

  it("returns path-only metadata and strips frontmatter from summary text", () => {
    expect(buildDocumentMetadata(undefined, "demo.md")).toEqual({
      relativePath: "demo.md",
    });
    expect(buildDocumentMetadata(undefined, undefined)).toBeUndefined();

    const source = "---\ntitle: Demo\n---\n\n# Heading\n\nBody.";
    expect(
      stripFrontmatterText(source, "---\ntitle: Demo\n---"),
    ).toBe("# Heading\n\nBody.");
    expect(
      stripFrontmatterText(
        "---\r\ntitle: Demo\r\n---\r\n\r\n# Heading\r\n\r\nBody.",
        "---\ntitle: Demo\n---",
      ),
    ).toBe("# Heading\n\nBody.");
  });
});
