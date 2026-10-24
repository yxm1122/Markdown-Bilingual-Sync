/**
 * Markdown 双语数据模型。
 *
 * 职责：定义切块、锚点、缓存文档与对齐结果在各层之间传递时共享的类型。
 *
 * 关键不变量：
 * - 行号全部为 0 基，`endLine` 为开区间（块覆盖 `[startLine, endLine)`），可直接用于
 *   `Array#slice`；`frontmatter` 的 `index` 固定为 -1。
 * - `hash` 由 `util/hash.blockHash` 生成，只覆盖块类型与规范化后的正文，不含行号，
 *   因此插入空行、移动块位置不会改变哈希。
 * - `BlockAnchor.src` / `dst` 分别记录锚定时原文块与译文块的哈希；两者与当前实际
 *   哈希不一致分别表示原文已变更、译文块被手工改写。
 *
 * 与其他模块的关系：`segmenter` 产出 `MarkdownBlock`，`anchors` 产出
 * `CacheDocument`，`align` 结合两者产出 `AlignmentResult`，`sync` 再据此生成新的
 * 缓存文本。
 */

/** 顶层 Markdown 块的语义类型，由 markdown-it 的 token 类型映射而来。 */
export type BlockKind =
  | "heading"
  | "paragraph"
  | "list"
  | "table"
  | "blockquote"
  | "code"
  | "html"
  | "hr"
  | "math"
  | "footnote"
  | "other";

/** 允许送去翻译的块类型；其余类型在同步时按原文原样复制。 */
export const TRANSLATABLE_KINDS: ReadonlySet<BlockKind> = new Set<BlockKind>([
  "heading",
  "paragraph",
  "list",
  "table",
  "blockquote",
]);

/** 所有合法的块类型，用于校验缓存锚点中记录的 `kind` 是否可信。 */
export const BLOCK_KINDS: ReadonlySet<BlockKind> = new Set<BlockKind>([
  "heading",
  "paragraph",
  "list",
  "table",
  "blockquote",
  "code",
  "html",
  "hr",
  "math",
  "footnote",
  "other",
]);

/**
 * 文档中的一个顶层块。
 *
 * `raw` 不含首尾空行；`hash` 即该块内容指纹，是跨版本对齐的主要依据。
 */
export interface MarkdownBlock {
  /** 文档内 0 基序号，按行号递增且连续；frontmatter 块为 -1。 */
  index: number;
  kind: BlockKind;
  /** 起始行号（0 基，含）。 */
  startLine: number;
  /** 结束行号（0 基，不含），等于最后一行行号 + 1。 */
  endLine: number;
  /** 块正文，已去掉行尾换行与末尾空行，行尾统一为 `\n`。 */
  raw: string;
  /** `blockHash(kind, raw)` 的结果。 */
  hash: string;
  /** 是否属于 `TRANSLATABLE_KINDS`，非翻译块按原文复制。 */
  translatable: boolean;
}

/** 一份原文的切块结果。`frontmatter` 不参与正文块编号，且永远排在最前。 */
export interface ParsedMarkdown {
  frontmatter?: MarkdownBlock;
  blocks: MarkdownBlock[];
}

/**
 * 锚点模式，决定块的状态与是否允许机器覆盖：
 * - `auto`：机器译文，可按设置重译；
 * - `human`：人工译文，同步时受保护；
 * - `copy`：非翻译块的原样复制；
 * - `target`：只有译文、没有对应原文的附加块；
 * - `deleted`：用户删除译文后留下的墓碑，内容为 `mbs-deleted` 标记。
 */
export type AnchorMode = "auto" | "human" | "copy" | "target" | "deleted";

/**
 * 写在译文块上一行的 HTML 注释锚点，是一条缓存的元数据。
 *
 * `src` / `dst` 使用 20 位短哈希而不是行号，使编辑缓存时不会因增删行而失配。
 */
export interface BlockAnchor {
  /** 缓存内唯一 id（12 位十六进制），用于跨解析定位同一个块。 */
  id: string;
  /** 锚点所属块的类型，用于校验译文结构未被改变。 */
  kind: BlockKind;
  /** 最近一次确认的原文块哈希，或 `target` 的定位标记（`start` / `t-<hash>`）。 */
  src: string;
  /** 译文块内容哈希；与实际块哈希不一致说明缓存被手工改过。 */
  dst: string;
  mode: AnchorMode;
}

/** 缓存中的“锚点 + 块”组合。 */
export interface AnchoredBlock {
  block: MarkdownBlock;
  anchor: BlockAnchor;
  /** 锚点所在行号（0 基，指原始缓存文本中的行，而非清理后的行）。 */
  anchorLine: number;
}

/**
 * 缓存文件中的全文摘要元数据。
 *
 * 摘要不属于翻译块，解析时从缓存文本中剥离，不参与对齐与导出；
 * `sourceHash` 用于判断摘要是否已经落后于当前原文。
 */
export interface CacheSummary {
  /** 摘要正文（原文语言）。 */
  text: string;
  /** 生成摘要时的整篇原文哈希；与当前原文不一致时仅提示过期，仍可继续使用。 */
  sourceHash: string;
  /** ISO 时间戳。 */
  updatedAt: string;
  /** 生成摘要的模型或 Provider 标签；手动编辑时可缺省。 */
  model?: string;
}

/**
 * 解析后的译文缓存文档。
 *
 * `blocks` 与 `targetBlocks` 分开保存，是因为只有前者能参与“原文-译文”对齐；
 * `untracked` 与 `orphanAnchors` 是结构异常的证据，任何写回操作都必须先处理它们。
 */
export interface CacheDocument {
  frontmatter?: MarkdownBlock;
  /** 可选的全文摘要元数据；解析时已从块文本中剥离。 */
  summary?: CacheSummary;
  /** 带锚点、可参与对齐的译文块（含 `deleted` 墓碑）。 */
  blocks: AnchoredBlock[];
  /** `mode` 为 `target` 的附加译文块，没有对应原文。 */
  targetBlocks: AnchoredBlock[];
  /** 没有锚点的块，通常来自手工编辑缓存或损坏的锚点。 */
  untracked: MarkdownBlock[];
  /** 找不到译文块的锚点；整篇重写缓存（如同步）时会被丢弃。 */
  orphanAnchors: BlockAnchor[];
  /** 移除合法锚点行后的文本；行数与原始文本一致，保证行号仍可复用。 */
  cleanedText: string;
  /** 解析阶段产生的中文告警，供 UI 提示。 */
  warnings: string[];
}

/**
 * 单个原文块的对齐状态。
 *
 * `human` / `stale` 是独立标记，与 `status` 组合表达“人工 + 过期”等情形；
 * `deleted` 也视为人工决策，同步时不会重新翻译。
 */
export type BlockStatus =
  | "translated"
  | "stale"
  | "human"
  | "human-stale"
  | "untranslated"
  | "copy"
  | "copy-stale"
  | "copy-pending"
  | "deleted";

/** 一个原文块与缓存块的匹配结果。 */
export interface AlignedBlock {
  /** 稳定键，当前取原文块 `index` 的字符串形式。 */
  key: string;
  source: MarkdownBlock;
  /** 未匹配到缓存时为 `undefined`。 */
  cache?: AnchoredBlock;
  status: BlockStatus;
  /** 是否为受保护的人工译文（含 dst 不一致的缓存）。 */
  human: boolean;
  /** 缓存的 `src` 是否仍等于当前原文哈希。 */
  stale: boolean;
  translatable: boolean;
}

/** 整篇文档的对齐结果，包含无法归属的缓存，供上层决定阻断或丢弃。 */
export interface AlignmentResult {
  blocks: AlignedBlock[];
  /** 没有匹配到任何原文的缓存块。 */
  orphanCaches: AnchoredBlock[];
  /** 原样透传缓存中的未跟踪块，供上层阻断。 */
  untrackedCaches: MarkdownBlock[];
  /** 缓存解析告警 + 对齐阶段新增告警。 */
  warnings: string[];
}
