/**
 * 预览模型构建模块：把「原文 + 译文缓存 + 未应用的原文暂存」折叠成 Webview 可渲染的纯数据。
 *
 * 职责：
 * - 用 markdown-it 分别渲染原文与缓存译文，按块建立 HTML 索引；
 * - 用 `alignDocument` 对齐原文块与缓存锚点，得到块状态（已翻译 / 过期 / 锁定 / 未翻译 / 复制 / 已删除）；
 * - 把原文暂存（编辑、删除、插入）以及缓存中的「译文独占块」合成为虚拟块；
 * - 输出统计计数、警告、脚注 HTML 与待应用原文修改数量。
 *
 * 数据流：
 * sourceText / cacheText（来自 SyncService.loadPreviewState）
 * --> `parseMarkdownDocument` / `parseCacheDocument`
 * --> `renderParsedDocument`（按 markdown-it token 分组渲染）
 * --> `alignDocument`（块状态）
 * --> `PreviewModel.blocks` --> `./html` 生成 HTML --> Webview
 * 原文暂存（PreviewManager 内存中的 edits / deletions / insertions）只影响本模型的展示，
 * 不会在此模块落盘。
 *
 * 关键不变量：
 * - `PreviewBlockView.blockIndex`：真实块使用解析出的非负索引；虚拟块使用负索引区间，
 *   原文待插入为 `-1000 - n`、译文独占块为 `-3000 - n`，
 *   两段区间互不重叠，便于 Webview 用 `data-block` 回传定位；
 * - `key` 在模型内唯一（真实块为源块索引字符串，虚拟块带 pending/standalone 前缀）；
 * - 每个 Webview 只读不写：模型是快照，任何写操作都必须回到 PreviewManager；
 * - `counts.total` 为对齐块数 + 译文独占块数，与渲染出的块数可能因空 HTML 跳块而略有差异。
 */
import type { MarkdownIt } from "markdown-it";
import { UI_TEXT } from "../i18n/zh";
import { alignDocument } from "../markdown/align";
import { parseCacheDocument } from "../markdown/anchors";
import { buildHeadingPaths } from "../markdown/headings";
import { createMarkdownRuntime } from "../markdown/markdown";
import { parseMarkdownDocument } from "../markdown/segmenter";
import type { SourceStage } from "../source/editSource";
import { isDeletedMarker } from "../cache/deletedMarker";

/** 缓存中「没有对应原文」的译文独占块（视图侧裁剪后的最小字段集）。 */
interface TargetOnlyView {
  /** 缓存锚点 id，删除/回译/编辑都以此定位。 */
  id: string;
  /** 锚点 `src` 去掉 `t-` 前缀后的原文哈希；仅作记录，分组匹配使用局部变量。 */
  afterSourceHash: string;
  /** 预留的原文块索引；当前恒为 -1，仅用于兜底块的展示行号。 */
  afterSourceIndex: number;
  kind: BlockKind;
  /** 译文原始 Markdown。 */
  text: string;
}
import {
  type BlockKind,
  type BlockStatus,
  type MarkdownBlock,
  type ParsedMarkdown,
} from "../markdown/types";
import { normalizeNewlines } from "../util/hash";

/**
 * 单个预览块的视图数据（Webview 只读快照）。
 *
 * 渲染策略由字段组合决定：`pendingInsertId` 表示原文待插入，`standaloneTargetId`
 * 表示缓存里的译文独占块；两者互斥。
 * `sourceDeleted` 表示原文块已被暂存删除（尚未写回文件）。
 */
export interface PreviewBlockView {
  /** 块唯一键；真实块为源块索引字符串，虚拟块形如 `pending:xxx`。原文与译文分栏用它对滚动。 */
  key: string;
  /** 真实块索引（非负）；虚拟块使用负数区间（-1000/-3000 起）。 */
  blockIndex: number;
  kind: BlockKind;
  status: BlockStatus;
  /** 本地化状态文案，直接展示。 */
  statusLabel: string;
  /** 标题上下文（` › ` 连接），仅标题路径非空时有值。 */
  headingPath: string;
  /** 展示用行号：真实块为 1-based 起始行；虚拟块取相邻行。 */
  sourceLine: number;
  /** 原文块 HTML；原文待编辑时来自暂存文本。 */
  sourceHtml: string;
  /** 译文块 HTML；译文已删除或未生成时为空串（由渲染层补占位）。 */
  targetHtml: string;
  /** 原文原始 Markdown，供内联编辑器回填。 */
  sourceRaw: string;
  /** 译文原始 Markdown，供内联编辑器回填。 */
  targetRaw: string;
  /** 原文内容哈希，保存译文时用于乐观并发校验。 */
  sourceHash: string;
  /** 对应缓存锚点 id；无缓存时为空。 */
  cacheId?: string;
  /** 原文存在未应用的暂存修改（编辑或删除）。 */
  sourcePending: boolean;
  /** 原文块已被暂存删除（尚未写回源文件）。 */
  sourceDeleted: boolean;
  /** 原文待插入块 id。 */
  pendingInsertId?: string;
  /** 译文独占块 id。 */
  standaloneTargetId?: string;
  /** 是否为人工锁定译文（含已删除标记）。 */
  human: boolean;
  /** 原文相对缓存是否过期；生产代码当前不读取该字段（统计走 counts）。 */
  stale: boolean;
  /** 是否存在缓存锚点（决定是否可编辑/回译/导出）。 */
  hasCache: boolean;
  /** 是否可重译：源块可翻译。 */
  canRetranslate: boolean;
  /** 是否可「标记已同步」：有缓存且状态为过期或锁定过期。 */
  canMarkSynced: boolean;
  /** 是否可编辑译文：有缓存、源块可翻译且译文未被删除。 */
  canEditTarget: boolean;
  /** 是否可回译：有缓存、可翻译且译文非空。 */
  canBackTranslate: boolean;
}

/** 底部统计计数；「已删除」与译文独占块计入 human（译文锁定）。 */
export interface PreviewCounts {
  /** 对齐块数 + 译文独占块数（不含待插入块）。 */
  total: number;
  translated: number;
  stale: number;
  human: number;
  untranslated: number;
  /** 复制类状态（copy / copy-stale / copy-pending）。 */
  copy: number;
}

/** 一次预览渲染所需的全部数据；由 PreviewManager 在每次刷新时重建。 */
export interface PreviewModel {
  /** 文件名（basename），用于标题与页面 `<title>`。 */
  fileLabel: string;
  sourceLanguage: string;
  targetLanguage: string;
  /** 当前 Provider 展示名，仅用于标题栏展示。 */
  providerLabel: string;
  /** 缓存中是否已有锚点块；为 false 时禁用导出按钮。 */
  cacheExists: boolean;
  blocks: PreviewBlockView[];
  sourceFootnotesHtml: string;
  targetFootnotesHtml: string;
  counts: PreviewCounts;
  /** 对齐/缓存/缺缓存等提示，去重后展示。 */
  warnings: string[];
  /** 当前暂存的原文修改、删除、插入总数，用于「应用原文修改 N」按钮。 */
  pendingSourceCount: number;
}

/** `buildPreviewModel` 的输入；除文本外均为展示或暂存信息。 */
export interface PreviewModelInput {
  sourceText: string;
  /** 译文缓存原文；缺省或空串表示尚无缓存。 */
  cacheText?: string;
  sourceLanguage: string;
  targetLanguage: string;
  providerLabel: string;
  fileLabel: string;
  /** 把 Markdown 图片相对路径转换为 Webview 可加载 URI；抛错不应影响渲染。 */
  resolveImage?: (src: string) => string;
  /** 尚未写回的原文暂存，用于渲染「待应用」状态。 */
  pendingSource?: SourceStage;
}

/** 块状态到中文文案的映射；文案来自 i18n，避免在渲染层散落字符串。 */
export const STATUS_LABELS: Record<BlockStatus, string> =
  UI_TEXT.preview.statusLabels;

/** 一个顶层 token 分组的起止下标（含闭标记）。 */
interface TokenGroup {
  start: number;
  end: number;
}

// ---- markdown-it 渲染：frontmatter 剥离与顶层 token 分组 ----

/**
 * 去掉 YAML frontmatter 并统一换行，得到供 markdown-it 解析的正文。
 * @param text 原始文本（原文或缓存清洗文本）。
 * @param parsed 已解析结果，只用其 `frontmatter.endLine`（相对完整文本的行数）。
 * @returns 去 frontmatter 后的文本；无 frontmatter 时只做换行归一化。
 */
function stripFrontmatter(text: string, parsed: ParsedMarkdown): string {
  const normalized = normalizeNewlines(text);
  const offset = parsed.frontmatter?.endLine ?? 0;
  return normalized.split("\n").slice(offset).join("\n");
}

/**
 * 找出以 `start` 起始的顶层 token 的闭合 token 下标。
 *
 * @param tokens markdown-it 顶层 token 列表。
 * @param start 起始 `*_open` token 下标。
 * @param bodyEnd 正文 token 上界（脚注区之前）。
 * @param type 起始 token 类型，必须以 `_open` 结尾。
 * @returns 闭合 token 下标；非 `_open` 类型或找不到闭合时返回 `start`。
 * @remarks 找不到闭合时只渲染开标记，HTML 可能不闭合，属已知降级路径。
 */
function findGroupEnd(
  tokens: ReturnType<MarkdownIt["parse"]>,
  start: number,
  bodyEnd: number,
  type: string,
): number {
  if (!type.endsWith("_open")) {
    return start;
  }
  const closeType = `${type.slice(0, -"_open".length)}_close`;
  for (let i = start + 1; i < bodyEnd; i += 1) {
    if (tokens[i].type === closeType && tokens[i].level === 0) {
      return i;
    }
  }
  return start;
}

/** 一次文档渲染的结果：按块索引的 HTML + 脚注区 HTML。 */
interface RenderedDocument {
  htmlByIndex: Map<number, string>;
  footnoteHtml: string;
}

/**
 * 渲染整篇文档，并把 HTML 按块索引切开。
 *
 * @param md 该文档专用的 markdown-it 实例（原文/译文使用不同 id 前缀）。
 * @param text 完整文本（含可选的 frontmatter）。
 * @param parsed 块解析结果，用于把 token 起始行映射回块索引。
 * @param docId 预留的文档标识，目前仅放入 `env`，供未来插件区分原文/译文。
 * @returns 块索引 -> HTML 的映射与脚注 HTML。
 * @remarks
 * - 只按顶层（level 0）token 归组，嵌套结构随其开标记一起渲染；
 * - 未匹配到块（例如未覆盖行合并出的 "other" 运行块）不会出现在映射里，
 *   调用方会把它当作空 HTML 处理；
 * - 脚注定义被 markdown-it-footnote 收集到文末，单独渲染一次。
 */
function renderParsedDocument(
  md: MarkdownIt,
  text: string,
  parsed: ParsedMarkdown,
  docId: string,
): RenderedDocument {
  const body = stripFrontmatter(text, parsed);
  const offset = parsed.frontmatter?.endLine ?? 0;
  const env: Record<string, unknown> = { docId };
  // 使用与解析时相同的 env，保证脚注引用/定义编号一致。
  const tokens = md.parse(body, env);
  // 脚注区起点：之后的 token 不再归属任何正文块。
  let footnoteStart = tokens.findIndex(
    (token) => token.type === "footnote_block_open" && token.level === 0,
  );
  const bodyEnd = footnoteStart >= 0 ? footnoteStart : tokens.length;

  // 块行号是「整篇文本」坐标，token.map 是「去 frontmatter 后正文」坐标，需要减 offset。
  const blockByLine = new Map<number, MarkdownBlock>();
  for (const block of parsed.blocks) {
    blockByLine.set(block.startLine - offset, block);
  }

  // 把顶层 token 归入其起始行对应的块；同一块只取第一个顶层 token。
  const groups = new Map<number, TokenGroup>();
  for (let i = 0; i < bodyEnd; i += 1) {
    const token = tokens[i];
    if (token.level !== 0 || !token.map) {
      continue;
    }
    const block = blockByLine.get(token.map[0]);
    if (!block || groups.has(block.index)) {
      continue;
    }
    groups.set(block.index, {
      start: i,
      end: findGroupEnd(tokens, i, bodyEnd, token.type),
    });
  }

  // 逐块渲染 token 片段；env 复用解析结果，脚注引用可正常解析。
  const htmlByIndex = new Map<number, string>();
  for (const [index, group] of groups) {
    htmlByIndex.set(
      index,
      md.renderer.render(tokens.slice(group.start, group.end + 1), md.options, env),
    );
  }

  if (footnoteStart < 0) {
    footnoteStart = tokens.length;
  }
  const footnoteHtml =
    footnoteStart < tokens.length
      ? md.renderer.render(tokens.slice(footnoteStart), md.options, env)
      : "";

  return { htmlByIndex, footnoteHtml };
}

// ---- 虚拟块视图：原文待插入 / 译文独占 ----
// 虚拟块不参与对齐，只用于把「尚未落盘」的内容预览出来；它们的 blockIndex 由调用方
// 传入负数区间（-1000 / -3000 起），避免与真实块索引冲突。

/**
 * 构造「原文待插入」虚拟块。
 *
 * @param sourceMd 原文渲染实例。
 * @param insertion 暂存插入（id + Markdown 文本）。
 * @param blockIndex 负数虚拟索引（`-1000 - n`）。
 * @param sourceLine 展示行号（通常为前一源块的结束行）。
 * @returns 只读的待插入块视图：仅可移除或再次编辑，不参与译文操作。
 */
function renderPendingInsertion(
  sourceMd: MarkdownIt,
  insertion: { id: string; text: string },
  blockIndex: number,
  sourceLine: number,
): PreviewBlockView {
  // 只取第一个块的 kind 作为图标/标签；实际渲染仍是整段插入文本。
  const parsed = parseMarkdownDocument(insertion.text, sourceMd);
  return {
    key: `pending:${insertion.id}`,
    blockIndex,
    kind: parsed.blocks[0]?.kind ?? "other",
    status: "untranslated",
    statusLabel: UI_TEXT.preview.actions.sourceInsertPendingLabel,
    headingPath: "",
    sourceLine,
    sourceHtml: sourceMd.render(insertion.text, { docId: "src" }),
    targetHtml: "",
    sourceRaw: insertion.text,
    targetRaw: "",
    sourceHash: "",
    cacheId: undefined,
    sourcePending: true,
    sourceDeleted: false,
    pendingInsertId: insertion.id,
    human: false,
    stale: false,
    hasCache: false,
    canRetranslate: false,
    canMarkSynced: false,
    canEditTarget: false,
    canBackTranslate: false,
  };
}

/**
 * 构造「译文独占块」视图（缓存中锚点指向不存在的原文）。
 *
 * @param targetMd 译文渲染实例。
 * @param target 从缓存锚点裁剪出的独占块。
 * @param blockIndex 负数虚拟索引（`-3000 - n`）。
 * @param sourceLine 展示行号（跟随匹配到的原文块或兜底为 1）。
 * @returns 状态恒为 human/译文锁定、可编辑可回译的视图。
 */
function renderStandaloneTarget(
  targetMd: MarkdownIt,
  target: TargetOnlyView,
  blockIndex: number,
  sourceLine: number,
): PreviewBlockView {
  return {
    key: `standalone:${target.id}`,
    blockIndex,
    kind: target.kind,
    status: "human",
    statusLabel: UI_TEXT.preview.actions.targetOnlyLabel,
    headingPath: "",
    sourceLine,
    sourceHtml: "",
    targetHtml: targetMd.render(target.text, { docId: "tgt" }),
    sourceRaw: "",
    targetRaw: target.text,
    sourceHash: "",
    cacheId: target.id,
    sourcePending: false,
    sourceDeleted: false,
    standaloneTargetId: target.id,
    human: true,
    stale: false,
    hasCache: true,
    canRetranslate: false,
    canMarkSynced: false,
    canEditTarget: true,
    canBackTranslate: true,
  };
}

// ---- 模型组装 ----

/**
 * 由原文、译文缓存与未应用的原文暂存构建预览模型。
 *
 * @param input 见 {@link PreviewModelInput}。
 * @returns 纯数据快照：区块视图、脚注、计数、警告与待应用数量。
 * @remarks
 * - 无副作用：不写文件、不改缓存、不发起翻译；
 * - `resolveImage` 的异常会向上抛给 PreviewManager，由它记日志并渲染错误页；
 * - 缓存缺失、解析告警会并入 `warnings`，但不会阻止模型生成。
 */
export function buildPreviewModel(input: PreviewModelInput): PreviewModel {
  // 原文与译文使用带前缀的 id（src-/tgt-），避免两栏标题锚点冲突。
  const sourceMd = createMarkdownRuntime({
    resolveImage: input.resolveImage,
    idPrefix: "src-",
  });
  const targetMd = createMarkdownRuntime({
    resolveImage: input.resolveImage,
    idPrefix: "tgt-",
  });

  // ---- 原文与译文渲染 ----
  const source = parseMarkdownDocument(input.sourceText, sourceMd);
  const sourceRendered = renderParsedDocument(
    sourceMd,
    input.sourceText,
    source,
    "src",
  );

  const cache = input.cacheText
    ? parseCacheDocument(input.cacheText, targetMd)
    : undefined;
  // 译文按「清洗掉锚点行」的文本渲染，行号仍与缓存文件一致。
  const targetRendered = cache
    ? renderParsedDocument(targetMd, cache.cleanedText, {
        frontmatter: cache.frontmatter,
        blocks: cache.blocks.map((item) => item.block),
      }, "tgt")
    : { htmlByIndex: new Map<number, string>(), footnoteHtml: "" };

  // ---- 对齐与块状态 ----
  // 无缓存时用一个空文档参与对齐，得到全部「未翻译 / 待复制」的状态。
  const alignment = alignDocument(
    source.blocks,
    cache ?? {
      blocks: [],
      targetBlocks: [],
      untracked: [],
      orphanAnchors: [],
      cleanedText: "",
      warnings: [],
      frontmatter: undefined,
    },
  );
  const headingPaths = buildHeadingPaths(source.blocks);
  const warnings = new Set(alignment.warnings);

  // ---- 状态计数：与 align.ts 的 deriveStatus 一一对应 ----
  // 状态推导规则（由缓存锚点与源块哈希决定）：
  // - 无缓存：可翻译块 -> untranslated，不可翻译块 -> copy-pending；
  // - 有缓存且 anchor.mode === "deleted" -> deleted；
  // - 不可翻译块：anchor.src 与源块哈希不一致 -> copy-stale，否则 copy；
  // - 可翻译块：mode 为 human 或 anchor.dst 与缓存内容哈希不一致 -> human / human-stale；
  //   其余按 anchor.src 是否等于源块哈希得到 translated / stale。
  // 统计口径：deleted 与 human-stale 都计入 human（译文锁定），
  // copy / copy-stale / copy-pending 计入 copy。
  let untranslated = 0;
  let translated = 0;
  let stale = 0;
  let human = 0;
  let copy = 0;
  const pending = input.pendingSource;
  const pendingSourceCount = pending
    ? pending.edits.size +
      pending.deletions.size +
      pending.insertions.length
    : 0;
  // 插入项按「插到哪个源块之后」分组，渲染时随源块一起输出，保持文档顺序。
  const insertionsByAfter = new Map<
    number,
    Array<{ id: string; afterIndex: number; text: string }>
  >();
  for (const insertion of pending?.insertions ?? []) {
    const list = insertionsByAfter.get(insertion.afterIndex) ?? [];
    list.push(insertion);
    insertionsByAfter.set(insertion.afterIndex, list);
  }
  // ---- 译文独占块：按锚点哈希挂到对应原文块之后 ----
  // 锚点 mode=target 时 src 形如 `t-<hash>`，去掉前缀即可与原文块哈希匹配。
  const standaloneByHash = new Map<string, TargetOnlyView[]>();
  let standaloneTargetCount = 0;
  for (const target of cache?.targetBlocks ?? []) {
    if (isDeletedMarker(target.block.raw)) {
      continue;
    }
    const sourceHash = target.anchor.src.startsWith("t-")
      ? target.anchor.src.slice(2)
      : "";
    const list = standaloneByHash.get(sourceHash) ?? [];
    list.push({
      id: target.anchor.id,
      afterSourceHash: sourceHash,
      afterSourceIndex: -1,
      kind: target.anchor.kind,
      text: target.block.raw,
    });
    standaloneByHash.set(sourceHash, list);
    standaloneTargetCount += 1;
  }
  // 两组虚拟块各自维护计数器，用于生成互不重叠的负数 blockIndex。
  let pendingInsertIndex = 0;
  let standaloneIndex = 0;

  const blocks: PreviewBlockView[] = [];
  /**
   * 把哈希匹配到的译文独占块追加到当前源块之后，并从待处理表中移除。
   * @param hash 源块哈希（空串表示无匹配）。
   * @param line 跟随源块的展示行号。
   */
  const appendStandalone = (hash: string, line: number): void => {
    const list = standaloneByHash.get(hash);
    if (!list) {
      return;
    }
    standaloneByHash.delete(hash);
    for (const target of list) {
      blocks.push(
        renderStandaloneTarget(
          targetMd,
          target,
          -3000 - standaloneIndex,
          line,
        ),
      );
      standaloneIndex += 1;
      human += 1;
    }
  };
  /**
   * 在指定源块之后依次追加：原文待插入块 -> 匹配的译文独占块。
   * @param afterIndex 源块索引；-1 表示文档开头。
   * @param sourceHash 源块哈希，用于匹配译文独占块。
   * @param line 后续虚拟块的展示行号。
   */
  const appendInsertions = (
    afterIndex: number,
    sourceHash: string,
    line: number,
  ): void => {
    const list = insertionsByAfter.get(afterIndex);
    if (list) {
      insertionsByAfter.delete(afterIndex);
      for (const insertion of list) {
        blocks.push(
          renderPendingInsertion(
            sourceMd,
            insertion,
            -1000 - pendingInsertIndex,
            line,
          ),
        );
        pendingInsertIndex += 1;
      }
    }
    appendStandalone(sourceHash, line);
  };

  // 文档开头（afterIndex = -1）的插入与独占块先渲染。
  appendInsertions(-1, "", 1);
  // ---- 真实块：按对齐结果逐块生成视图 ----
  for (const aligned of alignment.blocks) {
    const status = aligned.status;
    if (status === "untranslated") {
      untranslated += 1;
    } else if (status === "stale") {
      stale += 1;
    } else if (status === "human" || status === "human-stale") {
      human += 1;
    } else if (status === "translated") {
      translated += 1;
    } else if (status === "deleted") {
      human += 1;
    } else {
      copy += 1;
    }

    // 暂存编辑优先于磁盘内容渲染；暂存删除则只影响徽标与可用操作。
    const pendingEdit = pending?.edits.get(aligned.source.index);
    const sourceDeleted =
      pending?.deletions.has(aligned.source.index) ?? false;
    const sourcePending = Boolean(pendingEdit) || sourceDeleted;
    const sourceHtml = pendingEdit
      ? sourceMd.render(pendingEdit.text, { docId: "src" })
      : sourceRendered.htmlByIndex.get(aligned.source.index) ?? "";
    const deletedBlock = status === "deleted";
    // 译文已标记删除时不渲染缓存正文（缓存里是删除标记，不应展示）。
    const targetHtml =
      !deletedBlock && aligned.cache
        ? targetRendered.htmlByIndex.get(aligned.cache.block.index) ?? ""
        : "";
    // 两侧都没有 HTML 的块（例如未被 token 覆盖的合并块）直接跳过；
    // 注意统计计数已在上面累加，因此 counts.total 可能略大于可见块数。
    if (!sourceHtml && !targetHtml) {
      continue;
    }
    const path = headingPaths.get(aligned.source.index) ?? [];
    blocks.push({
      key: aligned.key,
      blockIndex: aligned.source.index,
      kind: aligned.source.kind,
      status,
      statusLabel: STATUS_LABELS[status],
      headingPath: path.join(" › "),
      sourceLine: aligned.source.startLine + 1,
      sourceHtml,
      targetHtml,
      sourceRaw: pendingEdit?.text ?? aligned.source.raw,
      targetRaw: deletedBlock ? "" : aligned.cache?.block.raw ?? "",
      sourceHash: aligned.source.hash,
      cacheId: aligned.cache?.anchor.id,
      sourcePending,
      sourceDeleted,
      human: aligned.human,
      stale: aligned.stale,
      hasCache: Boolean(aligned.cache),
      canRetranslate: aligned.source.translatable,
      // 仅「有缓存且原文已变化」的块允许直接接受当前译文。
      canMarkSynced:
        Boolean(aligned.cache) &&
        (status === "stale" || status === "human-stale"),
      canEditTarget:
        !deletedBlock &&
        Boolean(aligned.cache) &&
        aligned.source.translatable,
      canBackTranslate:
        !deletedBlock &&
        Boolean(aligned.cache) &&
        aligned.source.translatable &&
        Boolean(aligned.cache?.block.raw.trim()),
    });
    // 源块之后的插入与独占块紧跟在它后面，保证阅读顺序。
    appendInsertions(
      aligned.source.index,
      aligned.source.hash,
      aligned.source.endLine + 1,
    );
  }

  // ---- 兜底：未匹配到任何源块的虚拟块追加到文档末尾 ----
  // 正常情况下这些 Map 已被清空；仅在暂存引用了已不存在的源块时走到这里。
  for (const [afterIndex, list] of insertionsByAfter) {
    for (const insertion of list) {
      blocks.push(
        renderPendingInsertion(
          sourceMd,
          insertion,
          -1000 - pendingInsertIndex,
          Math.max(1, afterIndex + 1),
        ),
      );
      pendingInsertIndex += 1;
    }
  }
  for (const list of standaloneByHash.values()) {
    for (const target of list) {
      blocks.push(
        renderStandaloneTarget(
          targetMd,
          target,
          -3000 - standaloneIndex,
          Math.max(1, target.afterSourceIndex + 1),
        ),
      );
      standaloneIndex += 1;
    }
  }

  // 缓存只有译文独占块、没有锚点块时也视为「无缓存」，导出按钮会被禁用。
  // 译文独占块（targetBlocks）同样是有效缓存内容：删除全部原文后只剩它们时，
  // 导出仍然可用，不应提示“尚未生成缓存”。
  const cacheExists = Boolean(
    cache && (cache.blocks.length > 0 || cache.targetBlocks.length > 0),
  );
  if (!cacheExists) {
    warnings.add(UI_TEXT.preview.warnings.noCache);
  }

  return {
    fileLabel: input.fileLabel,
    sourceLanguage: input.sourceLanguage,
    targetLanguage: input.targetLanguage,
    providerLabel: input.providerLabel,
    cacheExists,
    blocks,
    sourceFootnotesHtml: sourceRendered.footnoteHtml,
    targetFootnotesHtml: targetRendered.footnoteHtml,
    // total 只统计对齐块 + 译文独占块；待插入块仅出现在正文。
    counts: {
      total: alignment.blocks.length + standaloneTargetCount,
      translated,
      stale,
      human,
      untranslated,
      copy,
    },
    warnings: [...warnings],
    pendingSourceCount,
  };
}
