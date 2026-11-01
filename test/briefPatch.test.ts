/** 测试：文档简报字段补丁的合并、清除与超长校验。 */
import { describe, expect, it } from "vitest";
import {
  applyBriefPatch,
  BriefPatchError,
  briefPatchMessage,
} from "../src/translation/briefPatch";

describe("applyBriefPatch", () => {
  it("returns the current brief when the patch is undefined", () => {
    const result = applyBriefPatch(
      { audience: "Developers", toneAndStyle: "Concise" },
      undefined,
    );
    expect(result.brief).toEqual({
      audience: "Developers",
      toneAndStyle: "Concise",
    });
    expect(result.changed).toEqual([]);
    expect(result.cleared).toEqual([]);
    expect(result.issues).toEqual([]);
  });

  it("merges only provided fields and preserves the rest", () => {
    const result = applyBriefPatch(
      { audience: "Developers", toneAndStyle: "Concise", ambiguities: "bite" },
      { doNotTranslate: "API, CLI" },
    );
    expect(result.brief).toEqual({
      audience: "Developers",
      toneAndStyle: "Concise",
      ambiguities: "bite",
      doNotTranslate: "API, CLI",
    });
    expect(result.changed).toEqual(["doNotTranslate"]);
  });

  it("clears a field with an empty string", () => {
    const result = applyBriefPatch(
      { audience: "Developers", toneAndStyle: "Concise" },
      { audience: "   " },
    );
    expect(result.brief).toEqual({ toneAndStyle: "Concise" });
    expect(result.changed).toEqual(["audience"]);
    expect(result.cleared).toEqual(["audience"]);
  });

  it("does not report unchanged values as changes", () => {
    const result = applyBriefPatch(
      { audience: "Developers" },
      { audience: " Developers " },
    );
    expect(result.changed).toEqual([]);
    expect(result.cleared).toEqual([]);
  });

  it("rejects a field over the 400-character limit without truncating", () => {
    const value = "x".repeat(401);
    const result = applyBriefPatch({ audience: "Developers" }, { audience: value });
    expect(result.issues).toEqual([
      { code: "too-long", field: "audience", length: 401, max: 400 },
    ]);
    expect(result.brief.audience).toBe("Developers");
  });

  it("rejects unknown fields and non-string values", () => {
    const result = applyBriefPatch(
      {},
      { audience: "Developers", extra: "no", toneAndStyle: 42 },
    );
    expect(result.issues).toEqual([
      { code: "unknown-field", field: "extra" },
      { code: "invalid-value", field: "toneAndStyle" },
    ]);
    expect(result.brief).toEqual({ audience: "Developers" });
  });

  it("rejects non-object patches", () => {
    expect(applyBriefPatch({}, [])).toMatchObject({
      issues: [{ code: "not-object" }],
    });
    expect(applyBriefPatch({}, null)).toMatchObject({
      issues: [{ code: "not-object" }],
    });
  });

  it("produces localized messages", () => {
    expect(briefPatchMessage({ code: "not-object" })).toContain("brief");
    expect(
      new BriefPatchError([
        { code: "unknown-field", field: "extra" },
      ]).message,
    ).toContain("extra");
  });
});
