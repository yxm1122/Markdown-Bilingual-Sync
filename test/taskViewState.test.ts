/** 测试：支持语言规范化、单侧切换校验与原文/译文交换。 */
import { describe, expect, it } from "vitest";
import {
  buildTaskViewLanguages,
  selectLanguage,
  swapTaskViewLanguages,
} from "../src/status/taskViewState";
import { normalizeSupportedLanguages } from "../src/util/language";

describe("normalizeSupportedLanguages", () => {
  it("returns an empty list for non-array and wholly invalid input", () => {
    expect(normalizeSupportedLanguages(undefined)).toEqual([]);
    expect(normalizeSupportedLanguages("zh-CN")).toEqual([]);
    expect(
      normalizeSupportedLanguages([
        null,
        42,
        { tag: "zh-CN" },
        "",
        "   ",
        "zh_CN",
        "a",
        "zh-CN-",
        "-zh",
      ]),
    ).toEqual([]);
  });

  it("trims tags and preserves valid setting order", () => {
    expect(
      normalizeSupportedLanguages([" zh-CN ", "ja-JP", "zh-Hans-CN"]),
    ).toEqual(["zh-CN", "ja-JP", "zh-Hans-CN"]);
  });

  it("dedupes case-insensitively while keeping the first spelling", () => {
    expect(
      normalizeSupportedLanguages(["zh-CN", "ZH-cn", "ja-JP", "JA-jp"]),
    ).toEqual(["zh-CN", "ja-JP"]);
  });
});

describe("buildTaskViewLanguages", () => {
  it("appends the current source and target when the setting omits them", () => {
    expect(buildTaskViewLanguages("en", "ja-JP", ["zh-CN"])).toEqual({
      sourceLanguage: "en",
      targetLanguage: "ja-JP",
      supportedLanguages: ["zh-CN", "en", "ja-JP"],
    });
  });

  it("does not duplicate values that differ only by case", () => {
    expect(
      buildTaskViewLanguages(" en ", "ZH-cn", ["zh-CN", "bad_tag"])
        .supportedLanguages,
    ).toEqual(["zh-CN", "en"]);
  });

  it("keeps both current values when the setting is invalid", () => {
    expect(
      buildTaskViewLanguages("en", "zh-CN", "not-an-array").supportedLanguages,
    ).toEqual(["en", "zh-CN"]);
    expect(
      buildTaskViewLanguages("en", "invalid tag", undefined).supportedLanguages,
    ).toEqual(["en"]);
  });

  it("keeps non-string source/target values as empty display strings", () => {
    expect(buildTaskViewLanguages(1, ["zh-CN"], ["zh-CN"])).toEqual({
      sourceLanguage: "",
      targetLanguage: "",
      supportedLanguages: ["zh-CN"],
    });
  });
});

describe("selectLanguage", () => {
  it("accepts an option and returns its configured spelling", () => {
    expect(selectLanguage(" JA-jp ", ["zh-CN", "ja-JP"], "en")).toEqual({
      status: "ok",
      language: "ja-JP",
    });
  });

  it("rejects values outside the current options", () => {
    expect(selectLanguage("fr", ["zh-CN", "ja-JP"], "en")).toEqual({
      status: "invalid",
      language: "fr",
    });
    expect(selectLanguage("", ["zh-CN"], "en")).toEqual({
      status: "invalid",
      language: "",
    });
    expect(selectLanguage(undefined, ["zh-CN"], "en")).toEqual({
      status: "invalid",
      language: "",
    });
  });

  it("rejects a value equal to the other side case-insensitively", () => {
    expect(selectLanguage("EN", ["en", "zh-CN"], " en ")).toEqual({
      status: "sameAsOther",
      language: "en",
    });
  });
});

describe("swapTaskViewLanguages", () => {
  it("swaps source and target using the configured spelling", () => {
    expect(
      swapTaskViewLanguages("EN", "zh-cn", ["en", "zh-CN"]),
    ).toEqual({
      status: "ok",
      sourceLanguage: "zh-CN",
      targetLanguage: "en",
    });
  });

  it("rejects a swap when the two sides are the same", () => {
    expect(
      swapTaskViewLanguages("zh-CN", "ZH-cn", ["zh-CN", "en"]),
    ).toEqual({ status: "invalid" });
  });

  it("rejects a swap when either side is missing or unsupported", () => {
    expect(swapTaskViewLanguages("fr", "zh-CN", ["en", "zh-CN"])).toEqual({
      status: "invalid",
    });
    expect(swapTaskViewLanguages("", "zh-CN", ["en", "zh-CN"])).toEqual({
      status: "invalid",
    });
    expect(swapTaskViewLanguages("en", "ja-JP", ["en", "zh-CN"])).toEqual({
      status: "invalid",
    });
  });
});
