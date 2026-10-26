/**
 * Markdown 切块器。
 *
 * 职责：先用 markdown-it 解析出顶层 token，再按 token 的行范围切出带类型、哈希与
 * 可翻译标记的块；未被 token 覆盖的残行单独收集为 `other` / `footnote` / `math`，
 * 保证原文内容不会在同步过程中凭空消失。
 *
 * 关键不变量：
 * - 块 `index` 按 `startLine` 升序连续编号，`startLine` / `endLine` 为 0 基半开区间；
 * - `raw` 已去掉末尾空行并统一换行符，因此 `hash` 不受空行数量影响；
 * - frontmatter 单独返回，`index` 为 -1，且不占用正文块编号。
 *
 * 与其他模块的关系：`anchors` 用它解析去掉锚点后的缓存文本，`sync` / `syncService`
 * 用它解析原文，`editSource` 依赖它给出的行范围做行级写回。
 */
import type { MarkdownIt } from "markdown-it";
import { blockHash, normalizeNewlines } from "../util/hash";
import { createMarkdownRuntime } from "./markdown";
import {
  TRANSLATABLE_KINDS,
  type BlockKind,
  type MarkdownBlock,
  type ParsedMarkdown,
} from "./types";

/**
 * markdown-it 顶层 token 类型到块类型的映射。
 *
 * 只登记“块开始”类 token（带 `map`）；嵌套 token 由外层块整体承载。`alert_open`
 * 与 `blockquote_open` 可能指向同一行，后续会按起始行去重。
 */
const BLOCK_TOKEN_KINDS: Record<string, BlockKind> = {
  heading_open: "heading",
  paragraph_open: "paragraph",
  bullet_list_open: "list",
  ordered_list_open: "list",
  table_open: "table",
  blockquote_open: "blockquote",
  alert_open: "blockquote",
  fence: "code",
  code_block: "code",
  html_block: "html",
  hr: "hr",
  math_block: "math",
};

interface Frontmatter {
  startLine: number;
  endLine: number;
  raw: string;
}

interface Candidate {
  startLine: number;
  endLine: number;
  kind: BlockKind;
}

/**
 * 识别文档开头的 YAML frontmatter（`---` … `---` 或 `...`）。
 *
 * 仅识别第一行就是 `---` 的情况；未闭合时返回 `null`，让这些行按普通正文处理，
 * 避免把整篇文档误吞进 frontmatter。`endLine` 为开区间。
 */
function extractFrontmatter(lines: string[]): Frontmatter | null {
  if (lines[0]?.trim() !== "---") {
    return null;
  }
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (line === "---" || line === "...") {
      return {
        startLine: 0,
        endLine: i + 1,
        raw: lines.slice(0, i + 1).join("\n"),
      };
    }
  }
  return null;
}

/**
 * 判断块是否整体是一个独立公式。
 *
 * 某些独立公式（`$$…$$` / `\[…\]`）会被 markdown-it 解析成段落，这里再提升为
 * `math`，避免把公式送去翻译。
 */
function isStandaloneMath(raw: string): boolean {
  return (
    /^\s*\$\$[\s\S]*\$\$\s*$/.test(raw) ||
    /^\s*\\\[[\s\S]*\\\]\s*$/.test(raw)
  );
}

/** 构造块对象；集中处理尾随空行清理与哈希/可翻译标记。 */
function createBlock(
  kind: BlockKind,
  startLine: number,
  endLine: number,
  raw: string,
  index: number,
): MarkdownBlock {
  const normalizedRaw = raw.replace(/\n+$/g, "");
  const translatable = TRANSLATABLE_KINDS.has(kind);
  return {
    index,
    kind,
    startLine,
    endLine,
    raw: normalizedRaw,
    hash: blockHash(kind, normalizedRaw),
    translatable,
  };
}

/**
 * 把 Markdown 文本切分为 frontmatter 与顶层块列表。
 *
 * 输入会先统一换行符；`md` 可注入以复用已配置的 markdown-it 实例。函数本身无副作用，
 * 但会调用 markdown-it 解析，插件异常会向上抛出。未被任何 token 覆盖的非空连续行会
 * 作为 `other` / `footnote` / `math` 块保留，确保后续写回不会丢失内容。
 */
export function parseMarkdownDocument(
  text: string,
  md: MarkdownIt = createMarkdownRuntime(),
): ParsedMarkdown {
  const normalized = normalizeNewlines(text);
  const lines = normalized.split("\n");
  const frontmatter = extractFrontmatter(lines);
  const offset = frontmatter?.endLine ?? 0;
  const body = lines.slice(offset).join("\n");
  const tokens = md.parse(body, {});

  const candidates: Candidate[] = [];
  for (const token of tokens) {
    // 只取顶层块 token：嵌套的段落/列表项已包含在外层块的原始行里。
    if (token.level !== 0 || !token.map) {
      continue;
    }
    const kind = BLOCK_TOKEN_KINDS[token.type];
    if (!kind) {
      continue;
    }
    const [start, end] = token.map;
    if (end <= start) {
      continue;
    }
    // 多个 token 可能共享起始行（例如 alert_open 与 blockquote_open），保留第一个即可。
    if (candidates.some((candidate) => candidate.startLine === start)) {
      continue;
    }
    candidates.push({ startLine: start, endLine: end, kind });
  }

  candidates.sort((a, b) => a.startLine - b.startLine);

  const covered = new Array<boolean>(lines.length).fill(false);
  if (frontmatter) {
    for (let i = frontmatter.startLine; i < frontmatter.endLine; i += 1) {
      covered[i] = true;
    }
  }

  const rawBlocks: Array<Omit<MarkdownBlock, "index">> = [];
  for (const candidate of candidates) {
    const start = offset + candidate.startLine;
    let end = offset + candidate.endLine;
    // token.map 会把块后的空行算进来；裁掉后哈希才不会因空行数量变化而失效。
    while (end > start && !lines[end - 1]?.trim()) {
      end -= 1;
    }
    let kind = candidate.kind;
    const raw = lines.slice(start, end).join("\n").replace(/\n+$/g, "");
    if (!raw.trim()) {
      continue;
    }
    // markdown-it 把独立公式解析为段落时，在这里纠正为 math。
    if (kind === "paragraph" && isStandaloneMath(raw)) {
      kind = "math";
    }
    const translatable = TRANSLATABLE_KINDS.has(kind);
    rawBlocks.push({
      kind,
      startLine: start,
      endLine: end,
      raw,
      hash: blockHash(kind, raw),
      translatable,
    });
    for (let i = start; i < end; i += 1) {
      covered[i] = true;
    }
  }

  let runStart = -1;
  /** 收尾一段未被 token 覆盖的连续非空行，并归类为脚注/公式/其他。 */
  const flushRun = (endLine: number) => {
    if (runStart < 0) {
      return;
    }
    const raw = lines.slice(runStart, endLine).join("\n").replace(/\n+$/g, "");
    if (raw.trim()) {
      const kind: BlockKind = /^\[\^[^\]]+\]:/.test(raw)
        ? "footnote"
        : isStandaloneMath(raw)
          ? "math"
          : "other";
      rawBlocks.push({
        kind,
        startLine: runStart,
        endLine,
        raw,
        hash: blockHash(kind, raw),
        translatable: TRANSLATABLE_KINDS.has(kind),
      });
    }
    runStart = -1;
  };

  for (let i = offset; i < lines.length; i += 1) {
    if (covered[i] || !lines[i].trim()) {
      flushRun(i);
      continue;
    }
    if (runStart < 0) {
      runStart = i;
    }
  }
  flushRun(lines.length);

  rawBlocks.sort((a, b) => a.startLine - b.startLine);

  let index = 0;
  const blocks: MarkdownBlock[] = rawBlocks.map((block) => ({
    ...block,
    index: index++,
  }));

  return {
    // frontmatter 保留为 index -1 的块，便于统一序列化，但不参与正文对齐。
    frontmatter: frontmatter
      ? createBlock("other", 0, frontmatter.endLine, frontmatter.raw, -1)
      : undefined,
    blocks,
  };
}
