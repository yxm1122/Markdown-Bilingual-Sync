/**
 * 预览 HTML 生成模块：把 `PreviewModel` 渲染成完整的双语文档字符串。
 *
 * 职责：
 * - 渲染「交错（columns / stacked）」布局：每个源块与其译文成对出现，带状态徽标与块级操作；
 * - 渲染「分栏（split）」布局：左右两栏按 `data-sync-key` 对齐成单元格，支持单栏只读；
 * - 组装工具栏、统计、警告、脚注、导出/原文确认对话框，以及内联 JSON 数据；
 * - 负责所有动态文本的 HTML 转义与 `<script type="application/json">` 数据的安全编码。
 *
 * 数据流：
 * PreviewModel（source/cache -> 对齐后的块）--> 本模块拼接 HTML
 * --> `webviewHtml.buildWebviewHtml` 补上资源 URI/CSP/nonce --> Webview
 * --> 用户点击 `data-action` 按钮 --> `postMessage` --> PreviewManager.onMessage。
 *
 * 关键不变量：
 * - 除 markdown-it 渲染出的受信 HTML（`sourceHtml` / `targetHtml` / 脚注）外，
 *   所有插值都必须经过 `escapeHtml`，尤其是属性值；
 * - 操作按钮的可用性完全由模型字段（`can*`、`pending*`、`sourceDeleted`）决定，
 *   本模块不推断业务状态，只做展示；
 * - 分栏左右单元格必须使用相同的 `data-sync-key`，否则媒体脚本无法做滚动同步；
 * - 只读状态只影响分栏布局；columns / stacked 忽略 `readonly`。
 */
import type {
  ExportConfirmationView,
  SourceConfirmationView,
} from "../export/diffPreview";
import { formatText, UI_TEXT } from "../i18n/zh";
import type { BlockKind } from "../markdown/types";
import type {
  PreviewLayout,
  PreviewReadonlyState,
} from "./layout";
import type { PreviewBlockView, PreviewModel } from "./previewModel";

// ---- 常量与基础工具 ----

const T = UI_TEXT.preview;
const KIND_LABELS: Record<BlockKind, string> = T.kindLabels;

/**
 * 转义插入到文本或属性中的动态字符串。
 * @param value 任意用户可见文本（文件名、标题路径、原始 Markdown、id 等）。
 * @returns 已转义 `& < > " '` 的字符串；不做 URL/JSON 编码。
 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ---- 交错布局（columns / stacked）：源块 + 译文成对渲染 ----

/**
 * 渲染一个双语块（原文与译文上下/并排成对）。
 *
 * @param block 块视图；虚拟块与真实块共用本函数。
 * @returns `<section class="mbs-block">` 片段。
 * @remarks
 * - 操作区按状态互斥生成，优先级：译文独占 > 正常块 > 源块已删除 > 待插入原文；
 * - `data-block` 承载真实块索引（虚拟块为负数），`data-pending-*` / `data-standalone-*`
 *   让媒体脚本知道编辑时该发哪条消息；
 * - 源侧仅在可编辑时输出 `data-edit-content`；译文侧始终带该标记，但没有对应
 *   `<textarea>` 时媒体脚本会忽略点击（译文删除/独占即属此情况）。
 */
function renderBlock(block: PreviewBlockView): string {
  const isPendingInsert = Boolean(block.pendingInsertId);
  const isStandalone = Boolean(block.standaloneTargetId);
  const isDeleted = block.sourceDeleted;
  const actions: string[] = [];

  // ---- 块级操作按钮：按状态选择唯一一组语义 ----
  if (isStandalone) {
    // 译文独占块：可回译生成新原文，或直接删除该译文。
    actions.push(
      `<button type="button" class="mbs-action" data-action="backTranslateTargetOnly" data-standalone-id="${escapeHtml(block.standaloneTargetId ?? "")}" title="${escapeHtml(T.actions.backTranslateTargetTitle)}">${T.actions.backTranslateTarget}</button>`,
      `<button type="button" class="mbs-action mbs-action-quiet" data-action="deleteTargetOnlyBlock" data-standalone-id="${escapeHtml(block.standaloneTargetId ?? "")}" title="${escapeHtml(T.actions.removeStandaloneTitle)}">${T.actions.removeStandalone}</button>`,
    );
  } else if (!isPendingInsert && !isDeleted) {
    // 正常双语块：撤销译文删除 / 重译 / 标记已同步 / 回译 / 定位原文 / 插入删除。
    if (block.status === "deleted") {
      actions.push(
        `<button type="button" class="mbs-action" data-action="undoDeleteTargetBlock" data-block="${block.blockIndex}" title="${escapeHtml(T.actions.undoDeleteTitle)}">${T.actions.undoDelete}</button>`,
      );
    } else if (block.canRetranslate) {
      actions.push(
        `<button type="button" class="mbs-action" data-action="retranslateBlock" data-block="${block.blockIndex}" title="${escapeHtml(T.actions.retranslateTitle)}">${block.hasCache ? T.actions.retranslate : T.actions.translate}</button>`,
      );
    }
    if (block.canMarkSynced) {
      actions.push(
        `<button type="button" class="mbs-action" data-action="markSynced" data-block="${block.blockIndex}" title="${escapeHtml(T.actions.markSyncedTitle)}">${T.actions.markSynced}</button>`,
      );
    }
    if (block.canBackTranslate) {
      actions.push(
        `<button type="button" class="mbs-action" data-action="backTranslate" data-block="${block.blockIndex}" title="${escapeHtml(T.actions.backTranslateTitle)}">${T.actions.backTranslate}</button>`,
      );
    }
    actions.push(
      `<button type="button" class="mbs-action mbs-action-quiet" data-action="revealSource" data-block="${block.blockIndex}" title="${escapeHtml(T.actions.revealSourceTitle)}">${T.actions.revealSource}</button>`,
      ...insertDeleteActions(block),
    );
  } else if (isDeleted) {
    // 源块已暂存删除：只能撤销删除或定位原文，等写回后再同步缓存。
    actions.push(
      `<button type="button" class="mbs-action" data-action="undoDeleteSourceBlock" data-block="${block.blockIndex}" title="${escapeHtml(T.actions.undoDeleteTitle)}">${T.actions.undoDelete}</button>`,
      `<button type="button" class="mbs-action mbs-action-quiet" data-action="revealSource" data-block="${block.blockIndex}" title="${escapeHtml(T.actions.revealSourceTitle)}">${T.actions.revealSource}</button>`,
    );
  } else {
    // 待插入的原文块：只允许移除。
    actions.push(
      `<button type="button" class="mbs-action" data-action="removeSourceInsert" data-pending-id="${escapeHtml(block.pendingInsertId ?? "")}" title="${escapeHtml(T.actions.removeInsertTitle)}">${T.actions.removeInsert}</button>`,
    );
  }

  // ---- 标题上下文、占位文案与内联编辑入口 ----
  const headingPath = block.headingPath
    ? `<span class="mbs-heading-path" title="${escapeHtml(T.actions.headingPathTitle)}">${escapeHtml(block.headingPath)}</span>`
    : "";
  // 译文为空时按状态给出不同占位：已删除 / 有缓存但空 / 待复制 / 未翻译。
  const placeholder =
    block.status === "deleted"
      ? `<div class="mbs-placeholder">${T.placeholders.skipped}</div>`
      : block.hasCache
        ? `<div class="mbs-placeholder">${T.placeholders.targetEmpty}</div>`
        : block.status === "copy-pending"
          ? `<div class="mbs-placeholder">${T.placeholders.copyPending}</div>`
          : `<div class="mbs-placeholder">${T.placeholders.untranslated}</div>`;
  // 源块可编辑的前提：既不是删除标记，也不是独占块。
  const sourceEdit =
    isDeleted || isStandalone
      ? ""
      : `<button type="button" class="mbs-pane-edit" data-edit-pane="source" data-block="${block.blockIndex}" title="${escapeHtml(T.actions.editSourceTitle)}">${T.actions.editSource}</button>`;
  const targetEdit =
    block.canEditTarget && !isDeleted
      ? `<button type="button" class="mbs-pane-edit" data-edit-pane="target" data-block="${block.blockIndex}" title="${escapeHtml(T.actions.editTargetTitle)}">${T.actions.editTarget}</button>`
      : "";
  // 「原文待应用 / 原文待删除」徽标；与 renderSplitCellHeader 共用同一规则。
  const pendingBadge = isDeleted
    ? `<span class="mbs-badge mbs-badge-pending-delete">${T.actions.sourceDeletePendingLabel}</span>`
    : block.sourcePending && !isPendingInsert
      ? `<span class="mbs-badge mbs-badge-pending-source">${T.actions.sourcePendingBadge}</span>`
      : "";
  // 把虚拟块身份写进 section，媒体脚本据此回传 pendingId / standaloneId。
  const pendingAttributes = block.pendingInsertId
    ? ` data-pending-id="${escapeHtml(block.pendingInsertId)}" data-pending-insert="true"`
    : block.standaloneTargetId
      ? ` data-standalone-id="${escapeHtml(block.standaloneTargetId)}" data-standalone="true"`
      : "";
  const deletedAttribute = isDeleted ? ' data-source-deleted="true"' : "";
  // 源侧占位：独占块没有真实原文可显示。
  const sourcePlaceholder = isStandalone
    ? T.actions.standaloneSourceEmpty
    : T.placeholders.sourceEmpty;

  return `<section class="mbs-block${isPendingInsert ? " mbs-block-pending-insert" : ""}${isDeleted ? " mbs-block-pending-delete" : ""}${isStandalone ? " mbs-block-standalone" : ""}" data-status="${block.status}" data-block="${block.blockIndex}" data-source-hash="${escapeHtml(block.sourceHash)}"${block.cacheId ? ` data-cache-id="${escapeHtml(block.cacheId)}"` : ""}${block.sourcePending ? ' data-source-pending="true"' : ""}${deletedAttribute}${pendingAttributes}>
  <header class="mbs-block-head">
    <span class="mbs-kind">${KIND_LABELS[block.kind]}</span>
    <span class="mbs-badge mbs-badge-${block.status}">${escapeHtml(block.statusLabel)}</span>
    ${pendingBadge}
    ${headingPath}
    <span class="mbs-line">${isPendingInsert ? "" : `L${block.sourceLine}`}</span>
    <span class="mbs-actions">${actions.join("")}</span>
  </header>
  <div class="mbs-pair">
    <div class="mbs-pane mbs-pane-source" data-pane="source">
      <div class="mbs-pane-label">${T.panes.source}${sourceEdit}</div>
      <div class="mbs-markdown"${isDeleted || isStandalone ? "" : ' data-edit-content="source"'} title="${isDeleted || isStandalone ? "" : escapeHtml(T.actions.editHint)}">${block.sourceHtml || `<div class="mbs-placeholder">${sourcePlaceholder}</div>`}</div>
      ${isStandalone ? "" : `<textarea class="mbs-raw" data-raw="source" hidden>${escapeHtml(block.sourceRaw)}</textarea>`}
    </div>
    <div class="mbs-pane mbs-pane-target" data-pane="target">
      <div class="mbs-pane-label">${T.panes.target}${targetEdit}</div>
      <div class="mbs-markdown" data-edit-content="target"${block.canEditTarget && !isDeleted ? ` title="${escapeHtml(T.actions.editHint)}"` : ""}>${block.targetHtml || placeholder}</div>
      ${block.canEditTarget && !isDeleted ? `<textarea class="mbs-raw" data-raw="target" hidden>${escapeHtml(block.targetRaw)}</textarea>` : ""}
    </div>
  </div>
</section>`;
}

// ---- 分栏（split）单元格渲染 ----

/**
 * 生成「待应用/待删除」徽标（分栏单元格复用）。
 * @param block 块视图。
 * @returns 徽标 HTML；无待应用状态时为空串。
 */
function renderPendingBadge(block: PreviewBlockView): string {
  const isDeleted = block.sourceDeleted;
  const isPendingInsert = Boolean(block.pendingInsertId);
  if (isDeleted) {
    return `<span class="mbs-badge mbs-badge-pending-delete">${T.actions.sourceDeletePendingLabel}</span>`;
  }
  if (block.sourcePending && !isPendingInsert) {
    return `<span class="mbs-badge mbs-badge-pending-source">${T.actions.sourcePendingBadge}</span>`;
  }
  return "";
}

/**
 * 生成「插入 / 删除」两个可展开的按钮组。
 *
 * 每组先渲染一个触发按钮（`data-split-toggle`），再渲染默认隐藏的选项容器
 * （`.mbs-split-options`），由媒体脚本按 `data-open` 展开；因此此处不使用 select。
 *
 * @param block 块视图。
 * @returns 两个 `.mbs-split-action` 片段的数组。
 * @remarks 当译文已被删除或源块已被暂存删除时，禁用「删除译文」选项。
 */
function insertDeleteActions(block: PreviewBlockView): string[] {
  const targetDeleteDisabled =
    block.status === "deleted" || block.sourceDeleted;
  return [
    `<span class="mbs-split-action" data-split="insert">
      <button type="button" class="mbs-action mbs-action-quiet" data-split-toggle="insert" title="${escapeHtml(T.actions.insertBlockTitle)}">${T.actions.insertBlock}</button>
      <span class="mbs-split-options" hidden>
        <button type="button" class="mbs-action" data-action="insertSourceBlock" data-block="${block.blockIndex}">${T.actions.sourceChoice}</button>
        <button type="button" class="mbs-action" data-action="insertTargetBlock" data-block="${block.blockIndex}" title="${escapeHtml(T.actions.insertTargetTitle)}">${T.actions.targetChoice}</button>
      </span>
    </span>`,
    `<span class="mbs-split-action" data-split="delete">
      <button type="button" class="mbs-action mbs-action-quiet" data-split-toggle="delete" title="${escapeHtml(T.actions.deleteBlockTitle)}">${T.actions.deleteBlock}</button>
      <span class="mbs-split-options" hidden>
        <button type="button" class="mbs-action" data-action="deleteSourceBlock" data-block="${block.blockIndex}">${T.actions.sourceChoice}</button>
        <button type="button" class="mbs-action" data-action="deleteTargetBlock" data-block="${block.blockIndex}" title="${escapeHtml(T.actions.deleteTargetTitle)}"${targetDeleteDisabled ? " disabled" : ""}>${T.actions.targetChoice}</button>
      </span>
    </span>`,
  ];
}

/**
 * 渲染分栏单元格的头部：块类型、状态、待应用徽标、标题路径、行号与操作区。
 *
 * 分栏里操作按钮较多，因此收起为一个「⋯」按钮：点击由媒体脚本切换
 * `.mbs-cell-actions` 的可见性（`data-actions-open`），不往返扩展进程。
 *
 * @param block 块视图。
 * @param actions 已生成的按钮 HTML 列表；为空时不渲染「⋯」。
 * @param isPendingInsert 待插入块不显示行号。
 * @returns `<header class="mbs-split-cell-head">` 片段。
 */
function renderSplitCellHeader(
  block: PreviewBlockView,
  actions: readonly string[],
  isPendingInsert: boolean,
): string {
  const headingPath = block.headingPath
    ? `<span class="mbs-heading-path" title="${escapeHtml(T.actions.headingPathTitle)}">${escapeHtml(block.headingPath)}</span>`
    : "";
  // 三点按钮：aria-expanded 由脚本维护，初始收起。
  const controls =
    actions.length > 0
      ? `<button type="button" class="mbs-actions-toggle" data-action="toggleCellActions" aria-expanded="false" title="${escapeHtml(T.actions.showBlockActions)}" aria-label="${escapeHtml(T.actions.showBlockActions)}">⋯</button>
    <span class="mbs-cell-actions">${actions.join("")}</span>`
      : "";
  return `<header class="mbs-block-head mbs-split-cell-head">
    <span class="mbs-cell-meta">
      <span class="mbs-kind">${KIND_LABELS[block.kind]}</span>
      <span class="mbs-badge mbs-badge-${block.status}">${escapeHtml(block.statusLabel)}</span>
      ${renderPendingBadge(block)}
      ${headingPath}
      <span class="mbs-line">${isPendingInsert ? "" : `L${block.sourceLine}`}</span>
    </span>
    ${controls}
  </header>`;
}

/**
 * 渲染分栏中的「空占位」单元格：另一栏有内容而本栏没有对应块时，
 * 仍输出一个带相同 `data-sync-key` 的单元格，保证两栏行数与滚动锚点对齐。
 *
 * @param kind 该单元格所在的栏位。
 * @param block 块视图。
 * @returns 只含占位文案、无块级操作的单元格。
 */
function renderSplitPlaceholderCell(
  kind: "source" | "target",
  block: PreviewBlockView,
): string {
  // 源栏与译文栏的占位语义不同：源栏强调「无对应原文」，译文栏强调同步状态。
  const placeholder =
    kind === "source"
      ? block.standaloneTargetId
        ? T.actions.standaloneSourceEmpty
        : T.placeholders.sourceEmpty
      : block.hasCache
        ? T.placeholders.targetEmpty
        : block.status === "copy-pending"
          ? T.placeholders.copyPending
          : T.placeholders.untranslated;
  // 仍然带虚拟块身份，便于右侧栏的编辑/回译按钮定位。
  const pendingAttributes = block.standaloneTargetId
    ? ` data-standalone-id="${escapeHtml(block.standaloneTargetId)}" data-standalone="true"`
    : "";
  return `<section class="mbs-block mbs-split-cell mbs-split-cell-${kind} mbs-split-cell-placeholder" data-status="${block.status}" data-block="${block.blockIndex}"${pendingAttributes} data-sync-key="${escapeHtml(block.key)}">
  ${renderSplitCellHeader(block, [], false)}
  <div class="mbs-pane mbs-pane-${kind}" data-pane="${kind}">
    <div class="mbs-pane-label">${kind === "source" ? T.panes.source : T.panes.target}</div>
    <div class="mbs-markdown"><div class="mbs-placeholder">${placeholder}</div></div>
  </div>
</section>`;
}

/**
 * 渲染分栏的原文单元格。
 *
 * @param block 块视图（调用方保证不是译文独占块）。
 * @returns 带原文内容、编辑入口与块操作的单元格。
 * @remarks 待插入块只给「移除插入」；源块已删除时只给「撤销删除」；其余块给重译 + 插入/删除。
 */
function renderSplitSourceCell(block: PreviewBlockView): string {
  const isPendingInsert = Boolean(block.pendingInsertId);
  const isDeleted = block.sourceDeleted;
  const actions: string[] = [];
  if (isPendingInsert) {
    actions.push(
      `<button type="button" class="mbs-action" data-action="removeSourceInsert" data-pending-id="${escapeHtml(block.pendingInsertId ?? "")}" title="${escapeHtml(T.actions.removeInsertTitle)}">${T.actions.removeInsert}</button>`,
    );
  } else if (isDeleted) {
    actions.push(
      `<button type="button" class="mbs-action" data-action="undoDeleteSourceBlock" data-block="${block.blockIndex}" title="${escapeHtml(T.actions.undoDeleteTitle)}">${T.actions.undoDelete}</button>`,
    );
  } else {
    // 有缓存时是「重新翻译」，无缓存时是「翻译此块」，已删除译文时是「恢复翻译」。
    if (block.canRetranslate) {
      const label =
        block.status === "deleted"
          ? T.actions.resumeTranslate
          : block.hasCache
            ? T.actions.retranslate
            : T.actions.translate;
      actions.push(
        `<button type="button" class="mbs-action" data-action="retranslateBlock" data-block="${block.blockIndex}" title="${escapeHtml(T.actions.retranslateTitle)}">${label}</button>`,
      );
    }
    actions.push(...insertDeleteActions(block));
  }

  const sourceEdit = isDeleted
    ? ""
    : `<button type="button" class="mbs-pane-edit" data-edit-pane="source" data-block="${block.blockIndex}" title="${escapeHtml(T.actions.editSourceTitle)}">${T.actions.editSource}</button>`;
  // 待插入块用 pendingId 标识；真实块靠 data-block。
  const pendingAttributes = block.pendingInsertId
    ? ` data-pending-id="${escapeHtml(block.pendingInsertId)}" data-pending-insert="true"`
    : "";

  return `<section class="mbs-block mbs-split-cell mbs-split-cell-source${isPendingInsert ? " mbs-block-pending-insert" : ""}${isDeleted ? " mbs-block-pending-delete" : ""}" data-status="${block.status}" data-block="${block.blockIndex}" data-source-hash="${escapeHtml(block.sourceHash)}"${block.cacheId ? ` data-cache-id="${escapeHtml(block.cacheId)}"` : ""}${block.sourcePending ? ' data-source-pending="true"' : ""}${isDeleted ? ' data-source-deleted="true"' : ""}${pendingAttributes} data-sync-key="${escapeHtml(block.key)}">
  ${renderSplitCellHeader(block, actions, isPendingInsert)}
  <div class="mbs-pane mbs-pane-source" data-pane="source">
    <div class="mbs-pane-label">${T.panes.source}${sourceEdit}</div>
    <div class="mbs-markdown"${isDeleted ? "" : ' data-edit-content="source"'} title="${isDeleted ? "" : escapeHtml(T.actions.editHint)}">${block.sourceHtml || `<div class="mbs-placeholder">${T.placeholders.sourceEmpty}</div>`}</div>
    ${isDeleted ? "" : `<textarea class="mbs-raw" data-raw="source" hidden>${escapeHtml(block.sourceRaw)}</textarea>`}
  </div>
</section>`;
}

/**
 * 渲染分栏的译文单元格。
 *
 * @param block 块视图（调用方保证不是待插入的原文块）。
 * @returns 带译文内容、编辑入口与块操作的单元格。
 * @remarks 操作优先级：译文独占 > 源块已删除（仅定位）> 正常（撤销删除、标记同步、回译、插入删除）。
 */
function renderSplitTargetCell(block: PreviewBlockView): string {
  const isStandalone = Boolean(block.standaloneTargetId);
  const isSourceDeleted = block.sourceDeleted;
  const isTargetDeleted = block.status === "deleted";
  const actions: string[] = [];
  if (isStandalone) {
    actions.push(
      `<button type="button" class="mbs-action" data-action="backTranslateTargetOnly" data-standalone-id="${escapeHtml(block.standaloneTargetId ?? "")}" title="${escapeHtml(T.actions.backTranslateTargetTitle)}">${T.actions.backTranslateTarget}</button>`,
      `<button type="button" class="mbs-action mbs-action-quiet" data-action="deleteTargetOnlyBlock" data-standalone-id="${escapeHtml(block.standaloneTargetId ?? "")}" title="${escapeHtml(T.actions.removeStandaloneTitle)}">${T.actions.removeStandalone}</button>`,
    );
  } else if (isSourceDeleted) {
    // 源块待删除：译文只能定位原文或撤销源块删除，避免同时暂存两侧修改。
    actions.push(
      `<button type="button" class="mbs-action mbs-action-quiet" data-action="revealSource" data-block="${block.blockIndex}" title="${escapeHtml(T.actions.revealSourceTitle)}">${T.actions.revealSource}</button>`,
    );
  } else {
    actions.push(
      `<button type="button" class="mbs-action mbs-action-quiet" data-action="revealSource" data-block="${block.blockIndex}" title="${escapeHtml(T.actions.revealSourceTitle)}">${T.actions.revealSource}</button>`,
    );
    if (isTargetDeleted) {
      actions.push(
        `<button type="button" class="mbs-action" data-action="undoDeleteTargetBlock" data-block="${block.blockIndex}" title="${escapeHtml(T.actions.undoDeleteTitle)}">${T.actions.undoDelete}</button>`,
      );
    } else {
      if (block.canMarkSynced) {
        actions.push(
          `<button type="button" class="mbs-action" data-action="markSynced" data-block="${block.blockIndex}" title="${escapeHtml(T.actions.markSyncedTitle)}">${T.actions.markSynced}</button>`,
        );
      }
      if (block.canBackTranslate) {
        actions.push(
          `<button type="button" class="mbs-action" data-action="backTranslate" data-block="${block.blockIndex}" title="${escapeHtml(T.actions.backTranslateTitle)}">${T.actions.backTranslate}</button>`,
        );
      }
    }
    actions.push(...insertDeleteActions(block));
  }

  const canEditTarget = block.canEditTarget && !isSourceDeleted;
  const targetEdit = canEditTarget
    ? `<button type="button" class="mbs-pane-edit" data-edit-pane="target" data-block="${block.blockIndex}" title="${escapeHtml(T.actions.editTargetTitle)}">${T.actions.editTarget}</button>`
    : "";
  const placeholder =
    block.status === "deleted"
      ? `<div class="mbs-placeholder">${T.placeholders.skipped}</div>`
      : block.hasCache
        ? `<div class="mbs-placeholder">${T.placeholders.targetEmpty}</div>`
        : block.status === "copy-pending"
          ? `<div class="mbs-placeholder">${T.placeholders.copyPending}</div>`
          : `<div class="mbs-placeholder">${T.placeholders.untranslated}</div>`;
  const pendingAttributes = isStandalone
    ? ` data-standalone-id="${escapeHtml(block.standaloneTargetId ?? "")}" data-standalone="true"`
    : "";

  return `<section class="mbs-block mbs-split-cell mbs-split-cell-target${isStandalone ? " mbs-block-standalone" : ""}${isSourceDeleted ? " mbs-block-pending-delete" : ""}" data-status="${block.status}" data-block="${block.blockIndex}"${block.sourceHash ? ` data-source-hash="${escapeHtml(block.sourceHash)}"` : ""}${block.cacheId ? ` data-cache-id="${escapeHtml(block.cacheId)}"` : ""}${block.sourcePending ? ' data-source-pending="true"' : ""}${isSourceDeleted ? ' data-source-deleted="true"' : ""}${pendingAttributes} data-sync-key="${escapeHtml(block.key)}">
  ${renderSplitCellHeader(block, actions, false)}
  <div class="mbs-pane mbs-pane-target" data-pane="target">
    <div class="mbs-pane-label">${T.panes.target}${targetEdit}</div>
    <div class="mbs-markdown" data-edit-content="target"${canEditTarget ? ` title="${escapeHtml(T.actions.editHint)}"` : ""}>${block.targetHtml || placeholder}</div>
    ${canEditTarget ? `<textarea class="mbs-raw" data-raw="target" hidden>${escapeHtml(block.targetRaw)}</textarea>` : ""}
  </div>
</section>`;
}

/**
 * 渲染分栏的脚注单元格（脚注不参与逐块对齐，单独占一行）。
 * @param html 已渲染的脚注 HTML。
 * @param label 栏位标签。
 * @returns 脚注单元格；无脚注时显示占位。
 */
function renderSplitFootnoteCell(html: string, label: string): string {
  return `<section class="mbs-block mbs-split-cell mbs-split-cell-footnotes">
  <div class="mbs-pane">
    <div class="mbs-pane-label">${label}</div>
    <div class="mbs-markdown">${html || `<div class="mbs-placeholder">${T.placeholders.noFootnotes}</div>`}</div>
  </div>
</section>`;
}

// ---- 只读连续文档渲染（分栏只读模式） ----

/**
 * 渲染只读模式下的单个块内容（不含状态徽标、操作按钮与内联编辑入口）。
 *
 * @param block 块视图。
 * @param pane 目标栏位。
 * @returns 块 HTML 包装；该栏没有对应内容（独占/空 HTML）时返回空串。
 */
function renderReadonlyBlock(
  block: PreviewBlockView,
  pane: "source" | "target",
): string {
  // 独占块在原文栏没有内容，只读时直接跳过，避免出现空白段。
  const targetOnly = Boolean(block.standaloneTargetId);
  const sourceOnly = Boolean(block.pendingInsertId);
  const html = pane === "source" ? block.sourceHtml : block.targetHtml;
  if (
    (pane === "source" && targetOnly) ||
    (pane === "target" && sourceOnly) ||
    !html
  ) {
    return "";
  }
  // 保留 data-sync-key：只读栏仍可与另一栏按块做滚动联动，只是没有块级操作。
  return `<div class="mbs-readonly-block" data-sync-key="${escapeHtml(block.key)}">${html}</div>`;
}

/**
 * 把整栏块拼成只读文档，并附加脚注区。
 *
 * @param model 预览模型。
 * @param pane 栏位。
 * @returns `.mbs-readonly-document` 片段；该栏没有可见块且无脚注时返回空占位。
 */
function renderReadonlyDocument(
  model: PreviewModel,
  pane: "source" | "target",
): string {
  const blocks = model.blocks
    .map((block) => renderReadonlyBlock(block, pane))
    .filter(Boolean);
  const footnotes =
    pane === "source"
      ? model.sourceFootnotesHtml
      : model.targetFootnotesHtml;
  if (blocks.length === 0 && !footnotes) {
    return `<div class="mbs-empty">${
      pane === "target"
        ? T.placeholders.untranslated
        : T.placeholders.emptyDocument
    }</div>`;
  }
  return `<div class="mbs-readonly-document mbs-markdown">${blocks.join("\n")}${
    footnotes
      ? `<div class="mbs-readonly-footnotes">${footnotes}</div>`
      : ""
  }</div>`;
}

// ---- 分栏栏位与整体布局 ----

/**
 * 渲染分栏中的一栏外壳：标题、语言、只读切换按钮与内容容器。
 *
 * @param kind 栏位（source / target），同时作为 `data-split-content` 的钩子。
 * @param label 栏位标题。
 * @param language 该栏语言名称。
 * @param content 已渲染的单元格或只读文档。
 * @param readonly 是否只读；影响标题按钮文案与内容容器类名。
 * @returns `<section class="mbs-split-pane">` 片段。
 */
function renderSplitPane(
  kind: "source" | "target",
  label: string,
  language: string,
  content: string,
  readonly: boolean,
): string {
  const labelText = readonly ? T.actions.exitReadonly : T.actions.readonlyPreview;
  const title = readonly
    ? T.actions.exitReadonlyTitle
    : T.actions.readonlyPreviewTitle;
  return `<section class="mbs-split-pane${readonly ? " mbs-split-pane-readonly" : ""}" data-split-pane="${kind}" data-readonly="${readonly}">
    <header class="mbs-split-head">
      <span>${label}</span>
      <span class="mbs-split-tools">
        <span class="mbs-split-lang">${escapeHtml(language)}</span>
        <button type="button" class="mbs-pane-mode${readonly ? " is-active" : ""}" data-action="togglePaneReadonly" data-pane="${kind}" aria-pressed="${readonly}" title="${escapeHtml(title)}">${escapeHtml(labelText)}</button>
      </span>
    </header>
    <div class="mbs-split-content mbs-blocks${readonly ? " mbs-readonly-content" : ""}" data-split-content="${kind}">${content}</div>
  </section>`;
}

/**
 * 渲染完整的分栏布局（左右两栏）。
 *
 * @param model 预览模型。
 * @param readonly 左右栏只读状态；只读栏渲染连续文档，可编辑栏渲染逐块单元格。
 * @returns `<main class="mbs-split">` 片段。
 * @remarks
 * - 非只读栏为每个块输出一个单元格：有对应内容的块渲染真实单元格，
 *   缺内容的块渲染同 key 的占位单元格，从而保证两栏一一对应、滚动可同步；
 * - 只读栏把这些块拼成连续文档，但仍保留 `data-sync-key`，所以仍可参与滚动联动；
 * - 脚注作为额外的单元格追加在两栏末尾。
 */
function renderSplitLayout(
  model: PreviewModel,
  readonly: PreviewReadonlyState,
): string {
  const sourceCells: string[] = [];
  const targetCells: string[] = [];
  for (const block of model.blocks) {
    const targetOnly = Boolean(block.standaloneTargetId);
    const sourceOnly = Boolean(block.pendingInsertId);
    if (!readonly.source) {
      sourceCells.push(
        targetOnly
          ? renderSplitPlaceholderCell("source", block)
          : renderSplitSourceCell(block),
      );
    }
    if (!readonly.target) {
      targetCells.push(
        sourceOnly
          ? renderSplitPlaceholderCell("target", block)
          : renderSplitTargetCell(block),
      );
    }
  }
  // 空文档：两栏各给一个空占位（只读栏由 renderReadonlyDocument 自行处理）。
  if (model.blocks.length === 0) {
    const empty = `<div class="mbs-empty">${T.placeholders.emptyDocument}</div>`;
    if (!readonly.source) {
      sourceCells.push(empty);
    }
    if (!readonly.target) {
      targetCells.push(empty);
    }
  }
  // 脚注单独成行，避免混进块级对齐。
  if (model.sourceFootnotesHtml || model.targetFootnotesHtml) {
    if (!readonly.source) {
      sourceCells.push(
        renderSplitFootnoteCell(
          model.sourceFootnotesHtml,
          T.panes.sourceFootnotes,
        ),
      );
    }
    if (!readonly.target) {
      targetCells.push(
        renderSplitFootnoteCell(
          model.targetFootnotesHtml,
          T.panes.targetFootnotes,
        ),
      );
    }
  }
  return `<main class="mbs-split">
  ${renderSplitPane(
    "source",
    T.panes.source,
    model.sourceLanguage,
    readonly.source
      ? renderReadonlyDocument(model, "source")
      : sourceCells.join("\n"),
    readonly.source,
  )}
  ${renderSplitPane(
    "target",
    T.panes.target,
    model.targetLanguage,
    readonly.target
      ? renderReadonlyDocument(model, "target")
      : targetCells.join("\n"),
    readonly.target,
  )}
</main>`;
}

// ---- 统计、警告与脚注 ----

/**
 * 渲染底部统计条：只展示计数大于 0 的分类，末尾始终显示总数。
 * @param model 预览模型。
 * @returns `.mbs-stats` 片段。
 */
function renderStats(model: PreviewModel): string {  const items: string[] = [];
  const add = (label: string, value: number, className: string) => {
    if (value > 0) {
      items.push(
        `<span class="mbs-stat ${className}"><strong>${value}</strong> ${label}</span>`,
      );
    }
  };
  add(T.stats.translated, model.counts.translated, "mbs-stat-ok");
  add(T.stats.stale, model.counts.stale, "mbs-stat-warn");
  add(T.stats.human, model.counts.human, "mbs-stat-human");
  add(T.stats.untranslated, model.counts.untranslated, "mbs-stat-missing");
  add(T.stats.copy, model.counts.copy, "mbs-stat-copy");
  if (items.length === 0) {
    items.push(`<span class="mbs-stat">${T.stats.empty}</span>`);
  }
  return `<div class="mbs-stats">${items.join("")}<span class="mbs-stat mbs-stat-total">${formatText(T.stats.total, { count: model.counts.total })}</span></div>`;
}

/**
 * 渲染同步提示折叠区（默认展开）。
 * @param model 预览模型；无警告时返回空串。
 * @returns `<details class="mbs-warnings">` 片段。
 */
function renderWarnings(model: PreviewModel): string {
  if (model.warnings.length === 0) {
    return "";
  }
  return `<details class="mbs-warnings" open>
  <summary>${formatText(T.warnings.summary, { count: model.warnings.length })}</summary>
  <ul>${model.warnings.map((warning) => `<li>${escapeHtml(warning)}</li>`).join("")}</ul>
</details>`;
}

/**
 * 渲染 columns / stacked 布局下的脚注区（原文/译文并排）。
 * @param model 预览模型；两侧都没有脚注时返回空串。
 * @returns `<section class="mbs-footnotes">` 片段。
 */
function renderFootnotes(model: PreviewModel): string {
  if (!model.sourceFootnotesHtml && !model.targetFootnotesHtml) {
    return "";
  }
  return `<section class="mbs-footnotes">
  <div class="mbs-pane mbs-pane-source">
    <div class="mbs-pane-label">${T.panes.sourceFootnotes}</div>
    <div class="mbs-markdown">${model.sourceFootnotesHtml || `<div class="mbs-placeholder">${T.placeholders.noFootnotes}</div>`}</div>
  </div>
  <div class="mbs-pane mbs-pane-target">
    <div class="mbs-pane-label">${T.panes.targetFootnotes}</div>
    <div class="mbs-markdown">${model.targetFootnotesHtml || `<div class="mbs-placeholder">${T.placeholders.noFootnotes}</div>`}</div>
  </div>
</section>`;
}

// ---- 页面组装 ----

/** `buildPreviewHtml` 的输入：模型 + 已解析的资源 URI/CSP + 可选确认弹窗数据。 */
export interface PreviewHtmlInput {
  model: PreviewModel;
  /** 布局，默认 columns；split 走分栏渲染。 */
  layout?: PreviewLayout;
  /** 分栏只读状态，默认两栏都可编辑；非 split 布局忽略。 */
  readonly?: PreviewReadonlyState;
  /** CSP nonce，必须与脚本标签上的 nonce 相同。 */
  nonce: string;
  /** 由 webviewHtml 生成的完整 CSP 字符串。 */
  csp: string;
  cssHref: string;
  scriptHref: string;
  katexHref: string;
  /** 初始 toast 内容（写入 data 属性，由脚本消费一次）。 */
  notice?: { text: string; kind: "info" | "success" | "error" };
  /** 导出确认数据；存在时页面加载后自动打开导出对话框。 */
  exportConfirmation?: ExportConfirmationView;
  /** 原文写回确认数据；存在时页面加载后自动打开原文对话框。 */
  sourceConfirmation?: SourceConfirmationView;
}

/**
 * 组装完整预览页面。
 *
 * @param input 见 {@link PreviewHtmlInput}。
 * @returns 包含 head/CSP/工具栏/正文/两个模态框/内联数据脚本的 HTML 文档。
 * @remarks
 * - 本函数只做字符串拼接，不写文件、不发消息；
 * - `model` 中的 markdown HTML 视为受信内容（markdown-it 已关闭原始 HTML），
 *   其余字段一律经 `escapeHtml`；
 * - 内联 JSON 会把 `<` 转成 `\u003c`，避免 `</script>` 截断脚本标签。
 */
/**
 * 渲染全文摘要面板：手动生成/保存/清除、编辑文本与两个会话级开关。
 * 摘要位于文档级，不随分栏/只读状态变化。
 */
function renderSummaryPanel(model: PreviewModel): string {
  const assist = model.assist;
  const summary = assist.summary;
  const hasSummary = Boolean(summary.text.trim());
  const status = hasSummary
    ? summary.stale
      ? T.summary.stale
      : T.summary.generated
    : T.summary.noSummary;
  const meta: string[] = [];
  if (hasSummary) {
    meta.push(formatText(T.summary.tokens, { count: summary.tokens }));
    if (summary.updatedAt) {
      meta.push(
        formatText(T.summary.generatedAt, {
          time: summary.updatedAt,
        }),
      );
    }
    if (summary.model) {
      meta.push(
        `${T.summary.manual === summary.model ? T.summary.manual : summary.model}`,
      );
    }
  }
  return `<details class="mbs-summary-panel" data-summary-panel${hasSummary ? " open" : ""}>
  <summary>
    <span class="mbs-summary-title">${T.summary.title}</span>
    <span class="mbs-summary-state${summary.stale ? " is-stale" : ""}">${escapeHtml(status)}</span>
  </summary>
  <div class="mbs-summary-body">
    <div class="mbs-summary-actions">
      <button type="button" class="mbs-button mbs-button-primary" data-action="generateSummary"${summary.canGenerate ? "" : ` disabled title="${escapeHtml(T.summary.unsupported)}"`}>${T.summary.generate}</button>
      <button type="button" class="mbs-button" data-action="saveSummary">${T.summary.save}</button>
      <button type="button" class="mbs-button" data-action="clearSummary"${hasSummary ? "" : " disabled"}>${T.summary.clear}</button>
      <label class="mbs-assist-toggle"><input type="checkbox" data-assist-toggle="stableTranslation"${assist.stableTranslation ? " checked" : ""}> ${T.summary.stableTranslation}</label>
      <label class="mbs-assist-toggle"><input type="checkbox" data-assist-toggle="summaryContext"${assist.summaryContext ? " checked" : ""}${hasSummary ? "" : " disabled"}> ${T.summary.useSummary}</label>
    </div>
    <textarea class="mbs-summary-text" data-summary-text spellcheck="false" rows="8" placeholder="${escapeHtml(T.summary.placeholder)}">${escapeHtml(summary.text)}</textarea>
    <p class="mbs-summary-meta">${escapeHtml(meta.join(" · "))}${summary.stale ? ` · ${escapeHtml(T.summary.staleHint)}` : ""}</p>
  </div>
</details>`;
}

export function buildPreviewHtml(input: PreviewHtmlInput): string {
  const {
    model,
    layout = "columns",
    readonly = { source: false, target: false },
    nonce,
    csp,
    cssHref,
    scriptHref,
    katexHref,
    notice,
    exportConfirmation,
    sourceConfirmation,
  } = input;
  // 初始提示走 data 属性而不是 postMessage：页面重载后脚本仍能读到并展示一次。
  const noticeAttrs = notice
    ? ` data-initial-text="${escapeHtml(notice.text)}" data-initial-kind="${notice.kind}"`
    : "";
  // 确认弹窗数据内联为 JSON 脚本，仅转义 `<` 即可阻断 `</script>` 注入。
  const exportData = exportConfirmation
    ? JSON.stringify(exportConfirmation).replaceAll("<", "\\u003c")
    : "";
  const sourceData = sourceConfirmation
    ? JSON.stringify(sourceConfirmation).replaceAll("<", "\\u003c")
    : "";
  // 模态框使用的静态文案集中注入，媒体脚本通过 key 取用，避免在 JS 里硬编码中文。
  const webviewText = JSON.stringify({
    staticPreview: T.modal.staticPreview,
    destination: T.modal.destination,
    summary: T.modal.summary,
    currentFile: T.modal.currentFile,
    newFile: T.modal.newFile,
    exportContent: T.modal.exportContent,
    warning: T.modal.warning,
    noteCoarse: T.modal.noteCoarse,
    noteTruncated: T.modal.noteTruncated,
    emptyDiff: T.modal.emptyDiff,
    collapsed: T.modal.collapsed,
    truncated: T.modal.truncated,
    write: T.modal.write,
    writing: T.modal.writing,
    exportFailed: T.modal.exportFailed,
    sourceDestination: T.sourceModal.destination,
    sourceSummary: T.sourceModal.summary,
    sourceWrite: T.sourceModal.write,
    sourceWriting: T.modal.writing,
    sourceWriteFailed: T.sourceModal.writeFailed,
    sourceEditHint: T.actions.sourceEditHint,
    targetEditHint: T.actions.targetEditHint,
    targetInsertHint: T.actions.targetInsertHint,
    saveStandaloneTarget: T.actions.saveStandaloneTarget,
    standaloneEditHint: T.actions.standaloneEditHint,
    emptyEdit: T.actions.emptyEdit,
    summaryEmpty: T.summary.empty,
    cancelEdit: T.actions.cancelEdit,
    saveSourceStage: T.actions.saveSourceStage,
    saveTarget: T.actions.saveTarget,
    insertPlaceholder: T.actions.insertPlaceholder,
    stageInsert: T.actions.stageInsert,
    addStandaloneTarget: T.actions.addStandaloneTarget,
  }).replaceAll("<", "\\u003c");
  // 交错布局正文：逐块输出成对 section；空文档给占位。
  const body =
    model.blocks.length > 0
      ? model.blocks.map(renderBlock).join("\n")
      : `<div class="mbs-empty">${T.placeholders.emptyDocument}</div>`;
  // split 走左右双栏；columns / stacked 走「正文 + 脚注区」。
  const content =
    layout === "split"
      ? renderSplitLayout(model, readonly)
      : `<main class="mbs-blocks">
    ${body}
  </main>
  ${renderFootnotes(model)}`;

  // 页面骨架：CSP 通过 meta 注入，样式/脚本均带 nonce 或来自 webview 资源根。
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<title>${escapeHtml(model.fileLabel)} · ${T.titleSuffix}</title>
<link rel="stylesheet" href="${katexHref}">
<link rel="stylesheet" href="${cssHref}">
</head>
<body>
<div class="mbs-root" data-mode="bilingual" data-layout="${layout}">
  <header class="mbs-toolbar">
    <div class="mbs-title-group">
      <div class="mbs-mark">${T.mark}</div>
      <div class="mbs-title-text">
        <h1>${escapeHtml(model.fileLabel)}</h1>
        <p>${escapeHtml(model.sourceLanguage)} → ${escapeHtml(model.targetLanguage)} · ${escapeHtml(model.providerLabel)}</p>
      </div>
    </div>
    <div class="mbs-mode-switch" role="group" aria-label="${escapeHtml(T.toolbar.previewMode)}">
      <button type="button" data-mode="bilingual" aria-pressed="true">${T.toolbar.bilingual}</button>
      <button type="button" data-mode="source" aria-pressed="false">${T.toolbar.sourceOnly}</button>
      <button type="button" data-mode="target" aria-pressed="false">${T.toolbar.targetOnly}</button>
    </div>
    <div class="mbs-toolbar-actions">
      <button type="button" class="mbs-button mbs-button-primary" data-action="sync">${T.toolbar.sync}</button>
      <button type="button" class="mbs-button" data-action="importTranslation" title="${escapeHtml(T.toolbar.importTranslationTitle)}">${T.toolbar.importTranslation}</button>
      <button type="button" class="mbs-button" data-action="refresh">${T.toolbar.refresh}</button>
      <button type="button" class="mbs-button" data-action="editCache">${T.toolbar.editCache}</button>
      <button type="button" class="mbs-button" data-action="export"${model.cacheExists ? "" : ` disabled title="${escapeHtml(T.toolbar.exportDisabledTitle)}"`}>${T.toolbar.export}</button>
      <button type="button" class="mbs-icon-button" data-action="openCacheFolder" title="${escapeHtml(T.toolbar.openCacheFolder)}" aria-label="${escapeHtml(T.toolbar.openCacheFolder)}">⋯</button>
    </div>
  </header>
  <div class="mbs-subbar">
    ${renderStats(model)}
    ${
      model.pendingSourceCount > 0
        ? `<button type="button" class="mbs-inline-action mbs-inline-action-primary" data-action="applySourceEdits" title="${escapeHtml(T.actions.applySourceTitle)}">${formatText(T.actions.applySource, { count: model.pendingSourceCount })}</button>
    <button type="button" class="mbs-inline-action" data-action="discardSourceEdits" title="${escapeHtml(T.actions.resetSourceTitle)}">${T.actions.resetSource}</button>`
        : ""
    }
    <button type="button" class="mbs-inline-action" data-action="insertSourceBlockStart" title="${escapeHtml(T.actions.insertAtStartTitle)}">${T.actions.insertAtStart}</button>
    ${
      model.cacheExists
        ? `<button type="button" class="mbs-inline-action" data-action="retranslateAll" title="${escapeHtml(T.subbar.retranslateAllTitle)}">${T.subbar.retranslateAll}</button>`
        : ""
    }
    ${
      model.counts.stale > 0
        ? `<button type="button" class="mbs-inline-action" data-action="retranslateStale" title="${escapeHtml(T.subbar.retranslateStaleTitle)}">${formatText(T.subbar.retranslateStale, { count: model.counts.stale })}</button>`
        : ""
    }
    <div class="mbs-layout-switch" role="group" aria-label="${escapeHtml(T.subbar.layout)}">
      <button type="button" data-layout="columns" aria-pressed="${layout === "columns"}">${T.subbar.columns}</button>
      <button type="button" data-layout="stacked" aria-pressed="${layout === "stacked"}">${T.subbar.stacked}</button>
      <button type="button" data-layout="split" aria-pressed="${layout === "split"}">${T.subbar.split}</button>
    </div>
    <span class="mbs-hint">${T.subbar.hint}</span>
  </div>
  ${renderWarnings(model)}
  ${renderSummaryPanel(model)}
  ${content}
  <footer class="mbs-footer">
    <span>${T.footer.phase}</span>
    <span>${T.footer.note}</span>
  </footer>
  <div class="mbs-toast" role="status" aria-live="polite"${noticeAttrs}></div>
</div>
<div class="mbs-modal" data-modal="export" hidden>
  <div class="mbs-modal-backdrop" data-export-dismiss></div>
  <div class="mbs-modal-dialog" role="dialog" aria-modal="true" aria-labelledby="mbs-export-title">
    <header class="mbs-modal-head">
      <div>
        <p class="mbs-modal-eyebrow">${T.modal.eyebrow}</p>
        <h2 id="mbs-export-title">${T.modal.title}</h2>
      </div>
      <button type="button" class="mbs-icon-button" data-export-dismiss aria-label="${escapeHtml(T.modal.close)}">×</button>
    </header>
    <div class="mbs-export-meta" id="mbs-export-meta"></div>
    <p class="mbs-export-warning" id="mbs-export-warning" hidden></p>
    <p class="mbs-export-error" id="mbs-export-error" role="alert" hidden></p>
    <div class="mbs-diff">
      <div class="mbs-diff-head">
        <span></span>
        <span id="mbs-diff-left-label">${T.modal.currentFile}</span>
        <span></span>
        <span id="mbs-diff-right-label">${T.modal.exportContent}</span>
      </div>
      <div class="mbs-diff-scroll">
        <div class="mbs-diff-table" id="mbs-diff-table"></div>
      </div>
    </div>
    <p class="mbs-export-note" id="mbs-export-note" hidden></p>
    <footer class="mbs-modal-actions">
      <button type="button" class="mbs-button" data-export-cancel>${T.modal.cancel}</button>
      <button type="button" class="mbs-button mbs-button-primary" data-export-write>${T.modal.write}</button>
    </footer>
  </div>
</div>
<div class="mbs-modal" data-modal="source" hidden>
  <div class="mbs-modal-backdrop" data-source-dismiss></div>
  <div class="mbs-modal-dialog" role="dialog" aria-modal="true" aria-labelledby="mbs-source-title">
    <header class="mbs-modal-head">
      <div>
        <p class="mbs-modal-eyebrow">${T.sourceModal.eyebrow}</p>
        <h2 id="mbs-source-title">${T.sourceModal.title}</h2>
      </div>
      <button type="button" class="mbs-icon-button" data-source-dismiss aria-label="${escapeHtml(T.sourceModal.close)}">×</button>
    </header>
    <div class="mbs-export-meta" id="mbs-source-meta"></div>
    <p class="mbs-export-error" id="mbs-source-error" role="alert" hidden></p>
    <div class="mbs-diff">
      <div class="mbs-diff-head">
        <span></span>
        <span id="mbs-source-diff-left-label">${T.sourceModal.currentFile}</span>
        <span></span>
        <span id="mbs-source-diff-right-label">${T.sourceModal.updatedFile}</span>
      </div>
      <div class="mbs-diff-scroll">
        <div class="mbs-diff-table" id="mbs-source-diff-table"></div>
      </div>
    </div>
    <p class="mbs-export-note">${T.sourceModal.note}</p>
    <footer class="mbs-modal-actions">
      <button type="button" class="mbs-button" data-source-cancel>${T.sourceModal.cancel}</button>
      <button type="button" class="mbs-button mbs-button-primary" data-source-write>${T.sourceModal.write}</button>
    </footer>
  </div>
</div>
<script type="application/json" nonce="${nonce}" id="mbs-ui-text">${webviewText}</script>
<script type="application/json" nonce="${nonce}" id="mbs-source-data">${sourceData}</script>
<script type="application/json" nonce="${nonce}" id="mbs-export-data">${exportData}</script>
<script nonce="${nonce}" src="${scriptHref}"></script>
</body>
</html>`;
}
