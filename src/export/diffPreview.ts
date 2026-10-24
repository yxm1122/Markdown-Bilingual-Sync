/**
 * 行级 Diff 预览（export/diffPreview）
 *
 * 职责：为“导出确认”“原文写回确认”生成左右并排的行级差异：
 * 先裁掉公共前后缀，再对中间部分做 LCS/DP，随后把删除/新增配对成并排行、
 * 折叠长上下文，并对超长结果截断。
 *
 * 关键不变量：
 * - 输出行数不超过 MAX_RENDER_ROWS + 1（额外的 truncated 标记行）；
 * - added/removed/unchanged 统计的是完整 diff，不受展示截断影响；
 * - 同一行文本（含空白）完全相等才算未变；换行统一为 \n；
 * - 所有函数纯函数，不读文件、不写日志，输入输出都是内存字符串。
 *
 * 外部依赖：无（仅标准库）；调用方负责读取文件内容与展示。
 *
 * 安全边界：行文本按纯文本渲染，不做 Markdown 解析；本模块不处理路径/网络。
 * 复杂度保护：中间区域面积超过 MAX_MATRIX_CELLS 时退化为“全删全增”的粗粒度 diff。
 */

// ---- 展示与复杂度上限 ----
const MAX_MATRIX_CELLS = 400_000;
const MAX_RENDER_ROWS = 1_200;
const CONTEXT_LINES = 3;

// ---- 数据结构 ----

/** 一侧的单元格；lineNumber 从 1 开始，对应原文/新文行号。 */
export interface DiffCell {
  lineNumber: number;
  text: string;
}

/**
 * 展示行。kind=context 两侧同文本；change 至少一侧有内容；
 * collapsed 表示折叠的上下文，hidden 为隐藏行数；truncated 为总截断标记行。
 */
export interface DiffRow {
  kind: "context" | "change" | "collapsed" | "truncated";
  left: DiffCell | null;
  right: DiffCell | null;
  hidden: number;
}

/** 一次 diff 的结果；统计值基于完整 diff，rows 可能已被折叠/截断。 */
export interface ExportDiff {
  rows: DiffRow[];
  added: number;
  removed: number;
  unchanged: number;
  /** 中间区域过大，退化为粗粒度“全删全增”。 */
  coarse: boolean;
  /** 因 MAX_RENDER_ROWS 未展示的行数（0 表示未截断）。 */
  truncated: number;
}

/** 导出确认视图所需数据；existing 表示目标文件已存在。 */
export interface ExportConfirmationView {
  destination: string;
  summary: string;
  warningCount: number;
  existing: boolean;
  diff: ExportDiff;
}

/** 原文写回确认视图所需数据；count 为待写回块数。 */
export interface SourceConfirmationView {
  destination: string;
  count: number;
  diff: ExportDiff;
}

/** 内部 diff 操作：逐行删除/新增/未变，带两侧行号（缺失侧为 null）。 */
interface DiffOp {
  kind: "context" | "removed" | "added";
  leftLineNumber: number | null;
  rightLineNumber: number | null;
  text: string;
}

/** 配对后的行（尚未折叠/截断），只有 context/change 两种。 */
interface DraftRow {
  kind: "context" | "change";
  left: DiffCell | null;
  right: DiffCell | null;
}

// ---- 行切分与 LCS ----

/**
 * 按行切分：统一 CRLF/CR 为 \n，空文本返回空数组，并丢弃末尾单个空行
 * （文件末尾换行不算一行内容）。纯函数。
 */
function splitLines(text: string): string[] {
  if (text.length === 0) {
    return [];
  }
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  if (lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines;
}

/**
 * 对中间区域做经典 LCS DP（从后向前填表），再正向回溯生成操作序列。
 * 表格面积已由调用方限制；相等时优先匹配，删除/新增在 DP 值相同时优先删除。
 * @param leftStart/rightStart 该区域第一行在原文件中的行号（1 基）。纯函数。
 */
function diffMiddle(
  left: string[],
  right: string[],
  leftStart: number,
  rightStart: number,
): DiffOp[] {
  if (left.length === 0) {
    return right.map((text, index) => ({
      kind: "added",
      leftLineNumber: null,
      rightLineNumber: rightStart + index,
      text,
    }));
  }
  if (right.length === 0) {
    return left.map((text, index) => ({
      kind: "removed",
      leftLineNumber: leftStart + index,
      rightLineNumber: null,
      text,
    }));
  }

  const width = right.length + 1;
  const table = new Uint32Array((left.length + 1) * width);
  for (let i = left.length - 1; i >= 0; i -= 1) {
    for (let j = right.length - 1; j >= 0; j -= 1) {
      table[i * width + j] =
        left[i] === right[j]
          ? table[(i + 1) * width + j + 1] + 1
          : Math.max(
              table[(i + 1) * width + j],
              table[i * width + j + 1],
            );
    }
  }

  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < left.length && j < right.length) {
    if (left[i] === right[j]) {
      ops.push({
        kind: "context",
        leftLineNumber: leftStart + i,
        rightLineNumber: rightStart + j,
        text: left[i],
      });
      i += 1;
      j += 1;
    } else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) {
      ops.push({
        kind: "removed",
        leftLineNumber: leftStart + i,
        rightLineNumber: null,
        text: left[i],
      });
      i += 1;
    } else {
      ops.push({
        kind: "added",
        leftLineNumber: null,
        rightLineNumber: rightStart + j,
        text: right[j],
      });
      j += 1;
    }
  }
  while (i < left.length) {
    ops.push({
      kind: "removed",
      leftLineNumber: leftStart + i,
      rightLineNumber: null,
      text: left[i],
    });
    i += 1;
  }
  while (j < right.length) {
    ops.push({
      kind: "added",
      leftLineNumber: null,
      rightLineNumber: rightStart + j,
      text: right[j],
    });
    j += 1;
  }
  return ops;
}

/**
 * 生成完整操作序列：先剥离公共前缀/后缀（大幅缩小 DP），剩余区域在预算内做精确 diff；
 * 超过 MAX_MATRIX_CELLS 时置 coarse=true，把中间区域视为“先全删、再全增”。
 * 返回的行号均为 1 基，且已包含前后缀上下文。纯函数。
 */
function buildOps(
  left: string[],
  right: string[],
): { ops: DiffOp[]; coarse: boolean } {
  let prefix = 0;
  while (
    prefix < left.length &&
    prefix < right.length &&
    left[prefix] === right[prefix]
  ) {
    prefix += 1;
  }

  let leftEnd = left.length;
  let rightEnd = right.length;
  while (
    leftEnd > prefix &&
    rightEnd > prefix &&
    left[leftEnd - 1] === right[rightEnd - 1]
  ) {
    leftEnd -= 1;
    rightEnd -= 1;
  }

  const leftMiddle = left.slice(prefix, leftEnd);
  const rightMiddle = right.slice(prefix, rightEnd);
  const ops: DiffOp[] = [];

  for (let index = 0; index < prefix; index += 1) {
    ops.push({
      kind: "context",
      leftLineNumber: index + 1,
      rightLineNumber: index + 1,
      text: left[index],
    });
  }

  let coarse = false;
  if (leftMiddle.length * rightMiddle.length <= MAX_MATRIX_CELLS) {
    ops.push(...diffMiddle(leftMiddle, rightMiddle, prefix + 1, prefix + 1));
  } else {
    coarse = true;
    leftMiddle.forEach((text, index) => {
      ops.push({
        kind: "removed",
        leftLineNumber: prefix + index + 1,
        rightLineNumber: null,
        text,
      });
    });
    rightMiddle.forEach((text, index) => {
      ops.push({
        kind: "added",
        leftLineNumber: null,
        rightLineNumber: prefix + index + 1,
        text,
      });
    });
  }

  for (let offset = 0; leftEnd + offset < left.length; offset += 1) {
    ops.push({
      kind: "context",
      leftLineNumber: leftEnd + offset + 1,
      rightLineNumber: rightEnd + offset + 1,
      text: left[leftEnd + offset],
    });
  }

  return { ops, coarse };
}

/**
 * 把操作序列转换为并排展示行：连续的删除/新增按位置一一配对（多出的一侧为 null），
 * 遇到 context 结束一个变更块。纯函数。
 */
function pairRows(ops: DiffOp[]): DraftRow[] {
  const rows: DraftRow[] = [];
  let index = 0;
  while (index < ops.length) {
    const op = ops[index];
    if (op.kind === "context") {
      rows.push({
        kind: "context",
        left: { lineNumber: op.leftLineNumber!, text: op.text },
        right: { lineNumber: op.rightLineNumber!, text: op.text },
      });
      index += 1;
      continue;
    }

    const removed: DiffOp[] = [];
    const added: DiffOp[] = [];
    while (index < ops.length && ops[index].kind !== "context") {
      const change = ops[index];
      (change.kind === "removed" ? removed : added).push(change);
      index += 1;
    }
    const count = Math.max(removed.length, added.length);
    for (let offset = 0; offset < count; offset += 1) {
      const left = removed[offset];
      const right = added[offset];
      rows.push({
        kind: "change",
        left: left
          ? { lineNumber: left.leftLineNumber!, text: left.text }
          : null,
        right: right
          ? { lineNumber: right.rightLineNumber!, text: right.text }
          : null,
      });
    }
  }
  return rows;
}

/**
 * 折叠长上下文：连续未变行超过 7 行时，只保留首 3 行 + 末 3 行，中间用 collapsed 行表示，
 * hidden = 总行数 - 6（至少 2）。变更行与短上下文原样输出。纯函数。
 */
function collapseContext(rows: DraftRow[]): DiffRow[] {
  const output: DiffRow[] = [];
  let index = 0;
  while (index < rows.length) {
    if (rows[index].kind !== "context") {
      output.push({ ...rows[index], hidden: 0 });
      index += 1;
      continue;
    }

    let end = index;
    while (end < rows.length && rows[end].kind === "context") {
      end += 1;
    }
    const run = rows.slice(index, end);
    if (run.length > CONTEXT_LINES * 2 + 1) {
      for (const row of run.slice(0, CONTEXT_LINES)) {
        output.push({ ...row, hidden: 0 });
      }
      output.push({
        kind: "collapsed",
        left: null,
        right: null,
        hidden: run.length - CONTEXT_LINES * 2,
      });
      for (const row of run.slice(-CONTEXT_LINES)) {
        output.push({ ...row, hidden: 0 });
      }
    } else {
      for (const row of run) {
        output.push({ ...row, hidden: 0 });
      }
    }
    index = end;
  }
  return output;
}

// ---- 对外入口 ----

/**
 * 生成导出/写回确认所需的差异。
 *
 * 步骤：切行 -> 前后缀裁剪 + LCS/粗粒度 -> 删除/新增配对 -> 折叠上下文 -> 按行数截断。
 * 统计值在截断前计算；截断时在末尾追加 truncated 行，hidden 为被隐藏的行数。
 *
 * @param before 旧文本（可为空，表示新建文件）。
 * @param after 新文本。
 * @returns 可直接交给 Webview 渲染的纯数据。失败：不抛错（除内存不足等运行时异常）。
 */
export function buildExportDiff(before: string, after: string): ExportDiff {
  const left = splitLines(before);
  const right = splitLines(after);
  const { ops, coarse } = buildOps(left, right);
  const rows = collapseContext(pairRows(ops));
  // 统计基于完整 ops（含折叠掉的行），因此可能大于 rows 中可见的变更行数。
  const added = ops.filter((op) => op.kind === "added").length;
  const removed = ops.filter((op) => op.kind === "removed").length;
  const unchanged = ops.filter((op) => op.kind === "context").length;

  // 展示上限：超出部分丢弃，并追加一行 truncated 说明隐藏了多少行。
  let truncated = 0;
  if (rows.length > MAX_RENDER_ROWS) {
    truncated = rows.length - MAX_RENDER_ROWS;
    rows.length = MAX_RENDER_ROWS;
    rows.push({
      kind: "truncated",
      left: null,
      right: null,
      hidden: truncated,
    });
  }

  return {
    rows,
    added,
    removed,
    unchanged,
    coarse,
    truncated,
  };
}
