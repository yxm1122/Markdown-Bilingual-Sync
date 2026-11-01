/**
 * 术语表补丁（纯逻辑）。
 *
 * 用户术语表与文档术语表共用同一套合并语义：
 * - merge：先按 source 大小写不敏感删除 remove，再按同一规则更新或追加 entries；
 * - replace：忽略现有条目，直接用 entries 替换；不能同时提供 remove；
 * - 所有条目先整体校验，任何无效项或超限都会让整次补丁失败，不会部分写入；
 * - 同名 source 在输入中重复时最后一条生效，并记录重复的 source。
 *
 * 本模块不做 I/O，也不读取配置；错误文案通过 tError 本地化。
 */
import { tError } from "../i18n/errors";
import type { GlossaryEntry } from "../translation/types";
import { MAX_TERM_LENGTH } from "./glossary";

/** 补丁模式；merge 适合增量修改，replace 用于整体替换。 */
export type GlossaryPatchMode = "merge" | "replace";

/** 未校验的补丁输入；entries/remove 可能来自 Webview 或 Language Model Tool。 */
export interface GlossaryPatch {
  mode: GlossaryPatchMode;
  entries?: unknown;
  remove?: unknown;
}

/** 补丁校验问题；index 统一为 1 基输入序号。 */
export type GlossaryPatchIssue =
  | { code: "not-array" }
  | { code: "invalid-entry"; index: number }
  | { code: "too-many"; count: number; max: number }
  | { code: "remove-not-array" }
  | { code: "invalid-remove"; index: number }
  | { code: "remove-with-replace" }
  | { code: "invalid-mode" };

/** 条目数组校验结果；issues 为空时才应使用 entries。 */
export interface GlossaryEntryValidation {
  entries: GlossaryEntry[];
  issues: GlossaryPatchIssue[];
  duplicates: string[];
}

/** 补丁成功结果；added/updated/removed 按 source 大小写不敏感比较。 */
export interface GlossaryPatchSuccess {
  ok: true;
  entries: GlossaryEntry[];
  added: GlossaryEntry[];
  updated: GlossaryEntry[];
  removed: GlossaryEntry[];
  duplicates: string[];
}

export interface GlossaryPatchFailure {
  ok: false;
  issues: GlossaryPatchIssue[];
}

export type GlossaryPatchResult = GlossaryPatchSuccess | GlossaryPatchFailure;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * 严格校验条目数组：不截断、不跳过，任何问题都记录在 issues 中。
 * 同名 source 以最后一条为准，重复的 source 会记录在 duplicates。
 */
export function validateGlossaryEntries(
  raw: unknown,
  maxEntries: number,
): GlossaryEntryValidation {
  if (!Array.isArray(raw)) {
    return { entries: [], issues: [{ code: "not-array" }], duplicates: [] };
  }
  const entries = new Map<string, GlossaryEntry>();
  const issues: GlossaryPatchIssue[] = [];
  const duplicates: string[] = [];
  for (let index = 0; index < raw.length; index += 1) {
    const item = raw[index];
    if (!isRecord(item)) {
      issues.push({ code: "invalid-entry", index: index + 1 });
      continue;
    }
    const source = typeof item.source === "string" ? item.source.trim() : "";
    const target = typeof item.target === "string" ? item.target.trim() : "";
    if (
      !source ||
      !target ||
      source.length > MAX_TERM_LENGTH ||
      target.length > MAX_TERM_LENGTH
    ) {
      issues.push({ code: "invalid-entry", index: index + 1 });
      continue;
    }
    const key = source.toLowerCase();
    if (entries.has(key)) {
      duplicates.push(source);
    }
    entries.set(key, { source, target });
  }
  if (entries.size > maxEntries) {
    issues.push({ code: "too-many", count: entries.size, max: maxEntries });
  }
  return { entries: [...entries.values()], issues, duplicates };
}

/** 校验 remove 数组；空字符串、非字符串和超长项都视为无效。 */
function validateRemove(raw: unknown): {
  terms: string[];
  issues: GlossaryPatchIssue[];
} {
  if (raw === undefined) {
    return { terms: [], issues: [] };
  }
  if (!Array.isArray(raw)) {
    return { terms: [], issues: [{ code: "remove-not-array" }] };
  }
  const terms: string[] = [];
  const issues: GlossaryPatchIssue[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < raw.length; index += 1) {
    const item = raw[index];
    const term = typeof item === "string" ? item.trim() : "";
    if (!term || term.length > MAX_TERM_LENGTH) {
      issues.push({ code: "invalid-remove", index: index + 1 });
      continue;
    }
    const key = term.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      terms.push(term);
    }
  }
  return { terms, issues };
}

/** 对比两个术语表，按 source 大小写不敏感找出新增、更新与删除。 */
export function diffGlossaryEntries(
  before: readonly GlossaryEntry[],
  after: readonly GlossaryEntry[],
): {
  added: GlossaryEntry[];
  updated: GlossaryEntry[];
  removed: GlossaryEntry[];
} {
  const beforeMap = new Map(
    before.map((entry) => [entry.source.toLowerCase(), entry]),
  );
  const afterMap = new Map(
    after.map((entry) => [entry.source.toLowerCase(), entry]),
  );
  return {
    added: after.filter((entry) => !beforeMap.has(entry.source.toLowerCase())),
    updated: after.filter((entry) => {
      const previous = beforeMap.get(entry.source.toLowerCase());
      return Boolean(
        previous &&
          (previous.source !== entry.source || previous.target !== entry.target),
      );
    }),
    removed: before.filter((entry) => !afterMap.has(entry.source.toLowerCase())),
  };
}

/**
 * 应用一次术语表补丁。
 *
 * 合并时保留现有条目的相对顺序：更新命中项留在原位置，新条目追加到末尾。
 * replace 模式要求 entries 是数组；remove 只能用于 merge。
 */
export function applyGlossaryPatch(
  current: readonly GlossaryEntry[],
  patch: GlossaryPatch,
  maxEntries: number,
): GlossaryPatchResult {
  if (patch.mode !== "merge" && patch.mode !== "replace") {
    return { ok: false, issues: [{ code: "invalid-mode" }] };
  }
  const remove = validateRemove(patch.remove);
  if (patch.mode === "replace" && remove.terms.length > 0) {
    return { ok: false, issues: [{ code: "remove-with-replace" }] };
  }
  const validated =
    patch.mode === "merge" && patch.entries === undefined
      ? { entries: [], issues: [], duplicates: [] }
      : validateGlossaryEntries(patch.entries, maxEntries);
  const issues = [...remove.issues, ...validated.issues];
  if (issues.length > 0) {
    return { ok: false, issues };
  }

  let entries: GlossaryEntry[];
  if (patch.mode === "replace") {
    entries = validated.entries;
  } else {
    const merged = new Map(
      current.map((entry) => [entry.source.toLowerCase(), entry]),
    );
    for (const term of remove.terms) {
      merged.delete(term.toLowerCase());
    }
    for (const entry of validated.entries) {
      // Map.set 更新已有键时保留原位置，符合“原地更新”的 UI 预期。
      merged.set(entry.source.toLowerCase(), entry);
    }
    entries = [...merged.values()];
  }

  if (entries.length > maxEntries) {
    return {
      ok: false,
      issues: [{ code: "too-many", count: entries.length, max: maxEntries }],
    };
  }

  return {
    ok: true,
    entries,
    ...diffGlossaryEntries(current, entries),
    duplicates: validated.duplicates,
  };
}

/** 序列化术语表文件；空表保持现有的 `[]\n` 形式。 */
export function serializeGlossaryFile(
  entries: readonly GlossaryEntry[],
): string {
  return entries.length > 0
    ? `${JSON.stringify(entries, null, 2)}\n`
    : "[]\n";
}

/** 把补丁问题转换为当前 locale 的错误文本。 */
export function glossaryPatchMessage(issue: GlossaryPatchIssue): string {
  switch (issue.code) {
    case "not-array":
      return tError("glossary.patchNotArray");
    case "invalid-entry":
      return tError("glossary.patchInvalidEntry", {
        index: issue.index,
        max: MAX_TERM_LENGTH,
      });
    case "too-many":
      return tError("glossary.patchTooMany", {
        count: issue.count,
        max: issue.max,
      });
    case "remove-not-array":
      return tError("glossary.patchRemoveNotArray");
    case "invalid-remove":
      return tError("glossary.patchInvalidRemove", {
        index: issue.index,
        max: MAX_TERM_LENGTH,
      });
    case "remove-with-replace":
      return tError("glossary.patchRemoveWithReplace");
    case "invalid-mode":
      return tError("glossary.patchInvalidMode");
  }
}

/** 补丁校验失败；caller 应直接展示 message，不写任何文件。 */
export class GlossaryPatchError extends Error {
  constructor(readonly issues: readonly GlossaryPatchIssue[]) {
    super(glossaryPatchMessage(issues[0] ?? { code: "not-array" }));
    this.name = "GlossaryPatchError";
  }
}

/** 断言补丁成功；失败时抛出带本地化文案的 GlossaryPatchError。 */
export function assertGlossaryPatch(
  result: GlossaryPatchResult,
): asserts result is GlossaryPatchSuccess {
  if (!result.ok) {
    throw new GlossaryPatchError(result.issues);
  }
}
