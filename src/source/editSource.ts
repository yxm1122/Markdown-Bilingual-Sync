/**
 * 原文暂存编辑的行级合成。
 *
 * 职责：把预览中暂存的“修改块 / 删除块 / 插入块”一次性应用到原文文本，生成待确认的
 * 新文本；真正写文件由预览层用 `WorkspaceEdit` 完成。
 *
 * 关键不变量：
 * - 所有块索引与行号都来自同一次 `parseMarkdownDocument`；
 * - 修改必须携带原块哈希，哈希不匹配说明原文已变化，整批拒绝；
 * - 所有操作按起始行从下往上应用，因此前面的行号不会因后面的增删而漂移；
 *   同一行位置上先替换/删除、后插入；
 * - 插入会根据相邻行是否为空自动补空行，保证新块与上下文分界清晰。
 *
 * 与其他模块的关系：`previewManager` 负责收集暂存并调用本模块，随后比较结果与
 * 当前文档、生成 diff 并写回；本模块是纯函数，不访问文件系统。
 */
import type { MarkdownIt } from "markdown-it";
import { parseMarkdownDocument } from "../markdown/segmenter";
import { tError } from "../i18n/errors";

/** 暂存的原文块修改；`sourceHash` 用于防止覆盖用户之后的手工改动。 */
export interface SourceEdit {
  /** 修改后的块全文（可包含多个 Markdown 行）。 */
  text: string;
  sourceHash: string;
}

/** 暂存的原文插入；`id` 用于预览层关联对应的译文草稿。 */
export interface SourceInsertion {
  id: string;
  /** 插入到该原文块之后；-1 表示文档开头（frontmatter 之后）。 */
  afterIndex: number;
  text: string;
}

/** 一次待应用的原文变更集合，键均为原文块 `index`。 */
export interface SourceStage {
  edits: ReadonlyMap<number, SourceEdit>;
  deletions: ReadonlySet<number>;
  insertions: readonly SourceInsertion[];
}

/** 合成结果：新文本与本次变更的块数。 */
export interface ProposedSource {
  /** 合成后的完整原文（换行统一为 `\n`）。 */
  text: string;
  /** 修改、删除、插入的条目总数（不一定是净变化块数）。 */
  changedBlocks: number;
}

/**
 * 行级操作描述。
 *
 * `start/end` 存在时为“替换/删除 `[start, end)`”；否则使用 `position` 做纯插入。
 * `priority` 只用于同一位置的排序：0 为替换/删除，1 为插入。
 */
type LineOp = {
  position: number;
  priority: number;
  start?: number;
  end?: number;
  lines?: string[];
};

/**
 * 生成插入行，并在需要时补空行。
 *
 * `beforeBlank` / `afterBlank` 基于插入点相邻的原始行判断；插入位置本身可能在文件
 * 开头、frontmatter 之后或文件末尾，因此两种越界都视为已有空行边界。
 */
function insertionLines(
  lines: readonly string[],
  position: number,
  text: string,
): string[] {
  const blockLines = text.split("\n");
  const beforeBlank =
    position === 0 || (lines[position - 1] ?? "").trim() === "";
  const afterBlank =
    position >= lines.length || (lines[position] ?? "").trim() === "";
  const output: string[] = [];
  if (!beforeBlank) {
    output.push("");
  }
  output.push(...blockLines);
  if (!afterBlank) {
    output.push("");
  }
  return output;
}

/**
 * 将暂存的原文变更合成为完整文本。
 *
 * 失败条件（抛本地化错误，不返回部分结果）：删除/修改的块不存在、同一块既改又删、
 * 修改的哈希与当前原文不符、修改或插入内容为空、插入锚点不存在或已被删除。
 * 无副作用；`changedBlocks` 为三类操作的条目总数。
 */
export function buildProposedSource(
  sourceText: string,
  stage: SourceStage,
  md: MarkdownIt,
): ProposedSource {
  // 先统一换行，保证后续行号与切块结果一致；输出统一使用 \n。
  const normalized = sourceText.replace(/\r\n?/g, "\n");
  const parsed = parseMarkdownDocument(normalized, md);
  const blocks = new Map(parsed.blocks.map((block) => [block.index, block]));
  const lines = normalized.split("\n");

  // 先整体校验删除目标，避免应用到一半才发现块不存在。
  for (const index of stage.deletions) {
    if (!blocks.has(index)) {
      throw new Error(tError("common.missingSourceBlock", { index: index + 1 }));
    }
    if (stage.edits.has(index)) {
      throw new Error(
        tError("source.editAndDeleteConflict", { index: index + 1 }),
      );
    }
  }

  const editOps: LineOp[] = [];
  for (const [index, edit] of stage.edits) {
    const block = blocks.get(index);
    if (!block) {
      throw new Error(tError("common.missingSourceBlock", { index: index + 1 }));
    }
    // 哈希不一致说明暂存基于旧原文，继续应用会覆盖用户之后的编辑。
    if (block.hash !== edit.sourceHash) {
      throw new Error(
        tError("source.changed", { index: index + 1 }),
      );
    }
    const text = edit.text.replace(/\r\n?/g, "\n").trimEnd();
    if (!text.trim()) {
      throw new Error(tError("source.emptyBlock", { index: index + 1 }));
    }
    editOps.push({
      position: block.startLine,
      priority: 0,
      start: block.startLine,
      end: block.endLine,
      lines: text.split("\n"),
    });
  }

  const deleteOps: LineOp[] = [];
  for (const index of stage.deletions) {
    const block = blocks.get(index);
    if (!block) {
      continue;
    }
    deleteOps.push({
      position: block.startLine,
      priority: 0,
      start: block.startLine,
      end: block.endLine,
      lines: [],
    });
  }

  const insertionsByAfter = new Map<number, SourceInsertion[]>();
  for (const insertion of stage.insertions) {
    if (insertion.afterIndex !== -1 && !blocks.has(insertion.afterIndex)) {
      throw new Error(tError("common.missingInsertedSourceBlock", { index: insertion.afterIndex + 1 }));
    }
    if (stage.deletions.has(insertion.afterIndex)) {
      throw new Error(
        tError("source.insertAfterDeleted", { index: insertion.afterIndex + 1 }),
      );
    }
    const text = insertion.text.replace(/\r\n?/g, "\n").trim();
    if (!text) {
      throw new Error(tError("source.emptyInsert"));
    }
    // 同一锚点的多次插入保持用户操作顺序。
    const list = insertionsByAfter.get(insertion.afterIndex) ?? [];
    list.push({ ...insertion, text });
    insertionsByAfter.set(insertion.afterIndex, list);
  }

  const insertOps: LineOp[] = [];
  for (const [afterIndex, insertions] of insertionsByAfter) {
    // 插入点在目标块的 endLine（半开区间末尾）：开头插入则位于 frontmatter 之后。
    const position =
      afterIndex === -1
        ? parsed.frontmatter?.endLine ?? 0
        : blocks.get(afterIndex)!.endLine;
    const text = insertions.map((item) => item.text).join("\n\n");
    insertOps.push({
      position,
      priority: 1,
      lines: insertionLines(lines, position, text),
    });
  }

  const ops = [...editOps, ...deleteOps, ...insertOps];
  // 从下往上应用，前面的行号不受影响；同一位置替换/删除先于插入。
  ops.sort((a, b) => b.position - a.position || a.priority - b.priority);
  for (const op of ops) {
    if (op.start !== undefined && op.end !== undefined) {
      lines.splice(
        op.start,
        op.end - op.start,
        ...(op.lines ?? []),
      );
    } else if (op.lines) {
      lines.splice(op.position, 0, ...op.lines);
    }
  }

  return {
    text: lines.join("\n"),
    changedBlocks:
      stage.edits.size + stage.deletions.size + stage.insertions.length,
  };
}
