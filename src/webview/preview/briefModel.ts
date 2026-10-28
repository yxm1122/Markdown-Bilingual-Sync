/**
 * 预览文档简报的纯模型：字段裁剪、已填计数与保存签名。
 *
 * 与宿主 `normalizeTranslationBrief` 保持同一上限；Webview 不能直接引用宿主值函数，
 * 因为那会通过 i18n 间接拉入 VS Code API。这里只做 UI 侧的保守归一化，宿主仍是权威。
 */
import type { TranslationBrief } from "../../translation/types";
import { canonicalGlossaryText } from "./glossaryModel";

export const BRIEF_FIELD_LIMIT = 400;

function normalizeField(value: string | undefined): string | undefined {
  const text = value?.trim();
  return text ? text.slice(0, BRIEF_FIELD_LIMIT).trim() : undefined;
}

/** trim、限长并丢弃空字段。 */
export function normalizeBriefDraft(
  raw: Partial<TranslationBrief> | undefined,
): TranslationBrief {
  if (!raw) {
    return {};
  }
  const audience = normalizeField(raw.audience);
  const toneAndStyle = normalizeField(raw.toneAndStyle);
  const ambiguities = normalizeField(raw.ambiguities);
  const doNotTranslate = normalizeField(raw.doNotTranslate);
  return {
    ...(audience ? { audience } : {}),
    ...(toneAndStyle ? { toneAndStyle } : {}),
    ...(ambiguities ? { ambiguities } : {}),
    ...(doNotTranslate ? { doNotTranslate } : {}),
  };
}

/** 已填写的字段数。 */
export function briefFilledCount(
  brief: Partial<TranslationBrief> | undefined,
): number {
  return Object.values(normalizeBriefDraft(brief)).filter(Boolean).length;
}

/** 保存后比较宿主回写与本地草稿是否一致。 */
export function briefSaveSignature(
  summaryText: string,
  brief: Partial<TranslationBrief> | undefined,
  glossaryText: string,
): string {
  return JSON.stringify({
    summary: summaryText.trim(),
    brief: normalizeBriefDraft(brief),
    glossary: canonicalGlossaryText(glossaryText),
  });
}
