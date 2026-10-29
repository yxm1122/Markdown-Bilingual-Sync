/**
 * Webview 组件测试夹具：构造真实结构的 PreviewModel / BootData。
 *
 * 不经过 Markdown 解析，直接给出块视图字段，便于精确覆盖状态组合、编辑分支
 * 与弹窗数据；字段语义仍以 src/preview/previewModel.ts 的类型为准。
 */
import type {
  PreviewAssistView,
  PreviewBlockView,
  PreviewCounts,
  PreviewModel,
  PreviewSummaryView,
} from "../../src/preview/previewModel";
import type { PreviewReadonlyState } from "../../src/preview/layout";
import type {
  DiffRow,
  ExportConfirmationView,
  SourceConfirmationView,
} from "../../src/export/diffPreview";
import type { BootData } from "../../src/webview/preview/types";
import { UI_TEXT } from "../../src/i18n";

const text = UI_TEXT.preview;

/** 单个预览块的默认值；只需覆写与用例相关的字段。 */
export function makeBlock(overrides: Partial<PreviewBlockView> = {}): PreviewBlockView {
  const block: PreviewBlockView = {
    key: "0",
    blockIndex: 0,
    kind: "paragraph",
    status: "translated",
    statusLabel: text.statusLabels.translated,
    headingPath: "",
    sourceLine: 1,
    sourceHtml: "<p>Hello world.</p>",
    targetHtml: "<p>你好，世界。</p>",
    sourceRaw: "Hello world.",
    targetRaw: "你好，世界。",
    sourceHash: "source-hash-0",
    cacheId: "cache-0",
    sourcePending: false,
    sourceDeleted: false,
    human: false,
    stale: false,
    hasCache: true,
    canRetranslate: true,
    canMarkSynced: false,
    canEditTarget: true,
    canBackTranslate: true,
  };
  const merged = { ...block, ...overrides };
  // 状态文案跟随状态，除非用例显式覆盖（例如模拟宿主自定义文案）。
  if (!overrides.statusLabel) {
    merged.statusLabel = text.statusLabels[merged.status];
  }
  return merged;
}

/** 默认摘要视图。 */
export function makeSummary(
  overrides: Partial<PreviewSummaryView> = {},
): PreviewSummaryView {
  return {
    text: "",
    stale: false,
    tokens: 0,
    brief: {},
    briefTokens: 0,
    briefFilledCount: 0,
    canGenerate: true,
    glossaryText: "",
    glossaryCount: 0,
    ...overrides,
  };
}

/** 默认辅助状态（稳定翻译开启、摘要上下文关闭）。 */
export function makeAssist(
  overrides: Partial<PreviewAssistView> = {},
): PreviewAssistView {
  return {
    stableTranslation: true,
    summaryContext: false,
    summary: makeSummary(),
    ...overrides,
  };
}

/** 默认两个块：一段正文 + 一个列表。 */
export function defaultBlocks(): PreviewBlockView[] {
  return [
    makeBlock(),
    makeBlock({
      key: "1",
      blockIndex: 1,
      kind: "list",
      sourceLine: 3,
      sourceHtml: "<ul><li>One</li><li>Two</li></ul>",
      targetHtml: "<ul><li>一</li><li>二</li></ul>",
      sourceRaw: "- One\n- Two",
      targetRaw: "- 一\n- 二",
      sourceHash: "source-hash-1",
      cacheId: "cache-1",
    }),
  ];
}

/** `makeModel` 的覆写项：计数、辅助状态与摘要允许部分字段。 */
type ModelOverrides = Omit<Partial<PreviewModel>, "counts" | "assist"> & {
  counts?: Partial<PreviewCounts>;
  assist?: Partial<PreviewAssistView>;
  summary?: Partial<PreviewSummaryView>;
};

/** 构造完整的模型；所有顶层字段都可覆写。 */
export function makeModel(overrides: ModelOverrides = {}): PreviewModel {
  const {
    blocks: blockOverrides,
    counts: countOverrides,
    assist: assistOverrides = {},
    summary: summaryOverrides = {},
    ...rest
  } = overrides;
  const blocks = blockOverrides ?? defaultBlocks();
  const counts: PreviewCounts = {
    total: blocks.filter((block) => !block.pendingInsertId).length,
    translated: blocks.filter((block) => block.status === "translated").length,
    stale: 0,
    human: blocks.filter((block) => block.status === "human" || block.status === "deleted").length,
    untranslated: 0,
    copy: 0,
    pendingAnnotations: 0,
    ...countOverrides,
  };
  const assist: PreviewAssistView = makeAssist({
    ...assistOverrides,
    summary: makeSummary({
      ...summaryOverrides,
      ...(assistOverrides.summary ?? {}),
    }),
  });
  return {
    fileLabel: "demo.md",
    sourceLanguage: "en",
    targetLanguage: "zh-CN",
    providerLabel: "Mock Provider",
    cacheExists: true,
    blocks,
    sourceFootnotesHtml: "",
    targetFootnotesHtml: "",
    counts,
    warnings: [],
    pendingSourceCount: 0,
    reviewSupported: true,
    annotationsSupported: true,
    ...rest,
    assist,
  };
}

/** 构造首屏状态；默认并排布局、两侧可编辑。 */
export function makeState(
  model: PreviewModel = makeModel(),
  overrides: Partial<{
    layout: BootData["state"]["layout"];
    readonly: PreviewReadonlyState;
  }> = {},
): BootData["state"] {
  return {
    model,
    layout: overrides.layout ?? "columns",
    readonly: overrides.readonly ?? { source: false, target: false },
  };
}

/** 构造 BootData；可附带首次提示或导出确认。 */
export function makeBoot(
  model: PreviewModel = makeModel(),
  overrides: Partial<Omit<BootData, "state">> & {
    layout?: BootData["state"]["layout"];
    readonly?: PreviewReadonlyState;
  } = {},
): BootData {
  const { layout, readonly, ...rest } = overrides;
  return {
    state: makeState(model, { layout, readonly }),
    ...rest,
  };
}

/** 一行变更 diff，左右两侧都有行号与文本。 */
export function changedRow(
  leftLine: number,
  rightLine: number,
  leftText: string,
  rightText: string,
): DiffRow {
  return {
    kind: "change",
    left: { lineNumber: leftLine, text: leftText },
    right: { lineNumber: rightLine, text: rightText },
    hidden: 0,
  };
}

/** 一行未变 diff。 */
export function contextRow(
  leftLine: number,
  rightLine: number,
  rowText: string,
): DiffRow {
  return {
    kind: "context",
    left: { lineNumber: leftLine, text: rowText },
    right: { lineNumber: rightLine, text: rowText },
    hidden: 0,
  };
}

/** 导出确认视图。 */
export function makeExportConfirmation(
  overrides: Partial<ExportConfirmationView> = {},
): ExportConfirmationView {
  return {
    destination: "demo.zh-CN.md",
    summary: "2 blocks",
    warningCount: 0,
    existing: true,
    diff: {
      rows: [
        contextRow(1, 1, "# Demo"),
        changedRow(2, 2, "Hello world.", "你好，世界。"),
      ],
      added: 1,
      removed: 1,
      unchanged: 1,
      coarse: false,
      truncated: 0,
    },
    ...overrides,
  };
}

/** 原文写回确认视图。 */
export function makeSourceConfirmation(
  overrides: Partial<SourceConfirmationView> = {},
): SourceConfirmationView {
  return {
    destination: "demo.md",
    count: 1,
    diff: {
      rows: [changedRow(2, 2, "Hello world.", "Hello, world!")],
      added: 1,
      removed: 1,
      unchanged: 0,
      coarse: false,
      truncated: 0,
    },
    ...overrides,
  };
}
