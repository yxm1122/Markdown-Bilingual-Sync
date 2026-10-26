/** 测试：行内代码与脚注标签的识别和兜底还原。 */
import { describe, expect, it } from "vitest";
import {
  findInlineCodeSpans,
  restoreAlertMarkers,
  restoreFootnoteLabel,
  restoreInlineCode,
  restoreProtectedSyntax,
} from "../src/util/protectedSyntax";

describe("findInlineCodeSpans", () => {
  it("matches single- and double-backtick spans", () => {
    const text = "Use `a` and ``b ` c`` here.";
    expect(findInlineCodeSpans(text).map((span) => span.raw)).toEqual([
      "`a`",
      "``b ` c``",
    ]);
  });

  it("pairs across ordinary words and ignores an unmatched trailing run", () => {
    const text = "An unmatched ` runs into `unclosed text.";
    expect(findInlineCodeSpans(text).map((span) => span.raw)).toEqual([
      "` runs into `",
    ]);
    expect(findInlineCodeSpans("No closing ` here").map((span) => span.raw)).toEqual(
      [],
    );
  });
});

describe("restoreInlineCode", () => {
  it("restores translated code spans by position", () => {
    const source = "Use `Translate Current File` with `en`.";
    const translated = "使用 `翻译当前文件` 配合 `en`。";
    expect(restoreInlineCode(source, translated)).toBe(
      "使用 `Translate Current File` 配合 `en`。",
    );
  });

  it("keeps the translation when code span counts differ", () => {
    const source = "Use `preview` now.";
    const translated = "现在使用预览。";
    expect(restoreInlineCode(source, translated)).toBe(translated);
  });

  it("keeps the translation when a span crosses a line break", () => {
    const source = "`line one\nline two` end.";
    const translated = "`第一行\n第二行` 结束。";
    expect(restoreInlineCode(source, translated)).toBe(translated);
  });

  it("restores double-backtick spans containing a backtick", () => {
    const source = "Use ``double `backticks` here``.";
    const translated = "使用 ``双重`反引号``。";
    expect(restoreInlineCode(source, translated)).toBe(
      "使用 ``double `backticks` here``。",
    );
  });

  it("keeps the translation when the delimiter style changed", () => {
    const source = "Use ``double `backticks` here``.";
    const translated = "使用 `双重`。";
    expect(restoreInlineCode(source, translated)).toBe(translated);
  });
});

describe("restoreAlertMarkers", () => {
  it("restores translated alert markers by position", () => {
    expect(
      restoreAlertMarkers("> [!WARNING]\n> text", "> [!警告]\n> 文本"),
    ).toBe("> [!WARNING]\n> 文本");
    expect(
      restoreAlertMarkers(
        "> [!NOTE]\n> one\n\n> [!TIP]\n> two",
        "> [!注意]\n> 一\n\n> [!提示]\n> 二",
      ),
    ).toBe("> [!NOTE]\n> 一\n\n> [!TIP]\n> 二");
  });

  it("keeps the translation when marker counts differ", () => {
    expect(restoreAlertMarkers("> [!WARNING]\n> text", "> 文本")).toBe(
      "> 文本",
    );
  });
});

describe("restoreFootnoteLabel", () => {
  it("keeps an unchanged label", () => {
    expect(
      restoreFootnoteLabel("[^lock]: Locked.", "[^lock]: 已锁定。"),
    ).toBe("[^lock]: 已锁定。");
  });

  it("restores a translated label", () => {
    expect(
      restoreFootnoteLabel("[^lock]: Locked.", "[^锁定]: 已锁定。"),
    ).toBe("[^lock]: 已锁定。");
  });

  it("re-adds a missing label", () => {
    expect(restoreFootnoteLabel("[^lock]: Locked.", "已锁定。")).toBe(
      "[^lock]: 已锁定。",
    );
  });

  it("restores every footnote label in a block with multiple definitions", () => {
    expect(
      restoreFootnoteLabel(
        "[^a]: First.\n[^b]: Second.",
        "[^甲]: 第一。\n[^乙]: 第二。",
      ),
    ).toBe("[^a]: 第一。\n[^b]: 第二。");
  });

  it("only applies label restoration to footnote blocks", () => {
    const source = "[^lock]: Locked.";
    expect(restoreProtectedSyntax(source, "已锁定。", "footnote")).toBe(
      "[^lock]: 已锁定。",
    );
    expect(restoreProtectedSyntax(source, "已锁定。", "paragraph")).toBe(
      "已锁定。",
    );
  });
});
