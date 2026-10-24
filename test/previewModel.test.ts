/** 测试：预览模型、块状态与 Webview HTML 生成。 */
import { describe, expect, it } from "vitest";
import { replaceCachedBlock } from "../src/cache/editCache";
import { createDeletedMarker } from "../src/cache/deletedMarker";
import { buildExportDiff } from "../src/export/diffPreview";
import { serializeAnchor } from "../src/markdown/anchors";
import { buildPreviewHtml } from "../src/preview/html";
import { buildPreviewModel } from "../src/preview/previewModel";
import { blockHash } from "../src/util/hash";
import { SOURCE, inspect, translate } from "./helpers";

const LABELS = {
  sourceLanguage: "en",
  targetLanguage: "zh-CN",
  providerLabel: "Mock",
  fileLabel: "demo.md",
};

describe("buildPreviewModel", () => {
  it("maps translated and copied blocks with rendered HTML", async () => {
    const result = await translate();
    const model = buildPreviewModel({
      sourceText: SOURCE,
      cacheText: result.cacheText,
      ...LABELS,
    });

    expect(model.cacheExists).toBe(true);
    expect(model.counts).toEqual({
      total: 4,
      translated: 3,
      stale: 0,
      human: 0,
      untranslated: 0,
      copy: 1,
    });
    expect(model.blocks).toHaveLength(4);
    expect(model.blocks.map((block) => block.status)).toEqual([
      "translated",
      "translated",
      "translated",
      "copy",
    ]);
    expect(
      model.blocks.find((block) => block.kind === "heading")?.targetHtml,
    ).toContain("标题");
    expect(
      model.blocks.find((block) => block.kind === "code")?.targetHtml,
    ).toContain("hljs-keyword");
    expect(
      model.blocks.find((block) => block.kind === "code")?.targetHtml,
    ).toContain("value");
    expect(model.warnings).toEqual([]);
  });

  it("exposes raw text, editability and pending source edits", async () => {
    const result = await translate();
    const paragraph = inspect(
      SOURCE,
      result.cacheText,
    ).alignment.blocks.find((block) => block.source.kind === "paragraph");
    expect(paragraph).toBeTruthy();
    const model = buildPreviewModel({
      sourceText: SOURCE,
      cacheText: result.cacheText,
      ...LABELS,
      pendingSource: {
        edits: new Map([
          [
            paragraph!.source.index,
            {
              text: "Edited source paragraph.",
              sourceHash: paragraph!.source.hash,
            },
          ],
        ]),
        deletions: new Set(),
        insertions: [],
      },
    });

    expect(model.pendingSourceCount).toBe(1);
    const view = model.blocks.find(
      (block) => block.blockIndex === paragraph!.source.index,
    );
    expect(view?.sourceRaw).toBe("Edited source paragraph.");
    expect(view?.sourceHtml).toContain("Edited source paragraph.");
    expect(view?.sourcePending).toBe(true);
    expect(view?.targetRaw.length).toBeGreaterThan(0);
    expect(view?.canEditTarget).toBe(true);
    expect(view?.canBackTranslate).toBe(true);

    const code = model.blocks.find((block) => block.kind === "code");
    expect(code?.canEditTarget).toBe(false);
    expect(code?.canBackTranslate).toBe(false);
  });

  it("renders staged insertions and marks staged deletions", async () => {
    const result = await translate();
    const alignment = inspect(SOURCE, result.cacheText).alignment;
    const heading = alignment.blocks.find(
      (block) => block.source.kind === "heading",
    );
    const paragraph = alignment.blocks.find(
      (block) => block.source.kind === "paragraph",
    );

    const model = buildPreviewModel({
      sourceText: SOURCE,
      cacheText: result.cacheText,
      ...LABELS,
      pendingSource: {
        edits: new Map(),
        deletions: new Set([paragraph!.source.index]),
        insertions: [
          {
            id: "pending-1",
            afterIndex: heading!.source.index,
            text: "## Inserted heading",
          },
        ],
      },
    });

    expect(model.pendingSourceCount).toBe(2);
    const inserted = model.blocks.find(
      (block) => block.pendingInsertId === "pending-1",
    );
    expect(inserted?.statusLabel).toBe("原文待插入");
    expect(inserted?.sourceHtml).toContain("Inserted heading");
    expect(inserted?.sourceRaw).toBe("## Inserted heading");
    const deleted = model.blocks.find(
      (block) => block.blockIndex === paragraph!.source.index,
    );
    expect(deleted?.sourceDeleted).toBe(true);

    const html = buildPreviewHtml({
      model,
      nonce: "test-nonce",
      csp: "default-src 'none'",
      cssHref: "preview.css",
      scriptHref: "preview.js",
      katexHref: "katex.css",
    });
    expect(html).toContain("Inserted heading");
    expect(html).toContain('data-pending-id="pending-1"');
    expect(html).toContain('data-source-deleted="true"');
  });

  it("shows deleted target blocks as translation-locked", async () => {
    const result = await translate();
    const before = inspect(SOURCE, result.cacheText);
    const paragraph = before.alignment.blocks.find(
      (block) => block.source.kind === "paragraph" && block.cache,
    );
    const deleted = replaceCachedBlock({
      cacheText: result.cacheText,
      cache: before.cache,
      target: paragraph!.cache!,
      content: createDeletedMarker({
        mode: "auto",
        content: paragraph!.cache!.block.raw,
      }),
      sourceHash: paragraph!.source.hash,
      sourceKind: paragraph!.source.kind,
      mode: "deleted",
      md: before.md,
    });
    const model = buildPreviewModel({
      sourceText: SOURCE,
      cacheText: deleted.text,
      ...LABELS,
    });

    const view = model.blocks.find(
      (block) => block.blockIndex === paragraph!.source.index,
    );
    expect(view?.status).toBe("deleted");
    expect(view?.statusLabel).toBe("译文锁定");
    expect(view?.targetHtml).toBe("");
    expect(view?.targetRaw).toBe("");
    expect(view?.canEditTarget).toBe(false);
    expect(view?.canBackTranslate).toBe(false);
    expect(view?.canRetranslate).toBe(true);

    const html = buildPreviewHtml({
      model,
      nonce: "test-nonce",
      csp: "default-src 'none'",
      cssHref: "preview.css",
      scriptHref: "preview.js",
      katexHref: "katex.css",
    });
    expect(html).toContain("译文已删除");
    expect(html).toContain("恢复翻译");
  });

  it("renders a target-only cache block as translation-locked", async () => {
    const result = await translate();
    const heading = inspect(SOURCE, result.cacheText).alignment.blocks.find(
      (block) => block.source.kind === "heading",
    );
    const targetText = "译文锁定新增内容。";
    const anchor = serializeAnchor({
      id: "target-1",
      kind: "paragraph",
      src: `t-${heading!.source.hash}`,
      dst: blockHash("paragraph", targetText),
      mode: "target",
    });
    const model = buildPreviewModel({
      sourceText: SOURCE,
      cacheText: `${result.cacheText}\n\n${anchor}\n\n${targetText}\n`,
      ...LABELS,
    });

    const view = model.blocks.find(
      (block) => block.standaloneTargetId === "target-1",
    );
    expect(view?.statusLabel).toBe("译文锁定");
    expect(view?.targetRaw).toBe(targetText);
    expect(view?.targetHtml).toContain("译文锁定新增内容");
    expect(view?.sourceHtml).toBe("");
    expect(view?.canEditTarget).toBe(true);
    expect(view?.canBackTranslate).toBe(true);
    expect(model.counts.human).toBe(1);

    const html = buildPreviewHtml({
      model,
      nonce: "test-nonce",
      csp: "default-src 'none'",
      cssHref: "preview.css",
      scriptHref: "preview.js",
      katexHref: "katex.css",
    });
    expect(html).toContain('data-standalone-id="target-1"');
    expect(html).toContain("无对应原文");
  });

  it("treats a cache with only standalone targets as existing cache", () => {
    const targetText = "只有独立译文。";
    const anchor = serializeAnchor({
      id: "target-only-cache",
      kind: "paragraph",
      src: "start",
      dst: blockHash("paragraph", targetText),
      mode: "target",
    });
    const model = buildPreviewModel({
      sourceText: "# Title\n\nSource paragraph.",
      cacheText: `${anchor}\n\n${targetText}\n`,
      ...LABELS,
    });

    expect(model.cacheExists).toBe(true);
    expect(model.warnings).not.toContain("尚未生成译文缓存");
    expect(
      model.blocks.some((block) => block.standaloneTargetId === "target-only-cache"),
    ).toBe(true);
  });

  it("skips legacy deleted target-only cache blocks", async () => {
    const result = await translate();
    const heading = inspect(SOURCE, result.cacheText).alignment.blocks.find(
      (block) => block.source.kind === "heading",
    );
    const marker = createDeletedMarker({
      mode: "target",
      content: "原独立译文。",
      kind: "paragraph",
    });
    const anchor = serializeAnchor({
      id: "target-deleted",
      kind: "html",
      src: `t-${heading!.source.hash}`,
      dst: blockHash("html", marker),
      mode: "target",
    });
    const model = buildPreviewModel({
      sourceText: SOURCE,
      cacheText: `${result.cacheText}\n\n${anchor}\n\n${marker}\n`,
      ...LABELS,
    });

    const view = model.blocks.find(
      (block) => block.standaloneTargetId === "target-deleted",
    );
    expect(view).toBeUndefined();
    expect(model.counts.total).toBe(4);
    const html = buildPreviewHtml({
      model,
      nonce: "test-nonce",
      csp: "default-src 'none'",
      cssHref: "preview.css",
      scriptHref: "preview.js",
      katexHref: "katex.css",
    });
    expect(html).not.toContain('data-standalone-id="target-deleted"');
    expect(html).not.toContain("undoDeleteTargetOnlyBlock");
  });

  it("renders a split layout with independent panes and sync keys", async () => {
    const result = await translate();
    const model = buildPreviewModel({
      sourceText: SOURCE,
      cacheText: result.cacheText,
      ...LABELS,
    });
    const html = buildPreviewHtml({
      model,
      layout: "split",
      nonce: "test-nonce",
      csp: "default-src 'none'",
      cssHref: "preview.css",
      scriptHref: "preview.js",
      katexHref: "katex.css",
    });

    expect(html).toContain('data-layout="split"');
    expect(html).toContain('data-split-pane="source"');
    expect(html).toContain('data-split-pane="target"');
    expect(html).toContain('data-split-content="source"');
    expect(html).toContain('data-split-content="target"');
    expect(html.match(/mbs-split-cell-source/g)).toHaveLength(4);
    expect(html.match(/mbs-split-cell-target/g)).toHaveLength(4);
    expect(html.match(/data-sync-key=/g)).toHaveLength(8);
  });

  it("moves retranslate to the source column and adds direct actions to both columns", async () => {
    const result = await translate();
    const model = buildPreviewModel({
      sourceText: SOURCE,
      cacheText: result.cacheText,
      ...LABELS,
    });
    const html = buildPreviewHtml({
      model,
      layout: "split",
      nonce: "test-nonce",
      csp: "default-src 'none'",
      cssHref: "preview.css",
      scriptHref: "preview.js",
      katexHref: "katex.css",
    });
    const sourceStart = html.indexOf('data-split-pane="source"');
    const targetStart = html.indexOf('data-split-pane="target"');
    const sourcePane = html.slice(sourceStart, targetStart);
    const targetPane = html.slice(targetStart);

    expect(sourcePane).toContain('data-action="retranslateBlock"');
    expect(sourcePane).not.toContain('data-action="revealSource"');
    expect(sourcePane).toContain('data-action="insertSourceBlock"');
    expect(sourcePane).toContain('data-action="insertTargetBlock"');
    expect(sourcePane).toContain('data-action="deleteSourceBlock"');
    expect(sourcePane).toContain('data-action="deleteTargetBlock"');
    expect(sourcePane).toContain('data-split-toggle="insert"');
    expect(sourcePane).toContain('data-split-toggle="delete"');
    expect(sourcePane).toContain('data-action="toggleCellActions"');
    expect(sourcePane).toContain("mbs-cell-actions");

    expect(targetPane).toContain('data-action="revealSource"');
    expect(targetPane).not.toContain('data-action="retranslateBlock"');
    expect(targetPane).toContain('data-action="insertSourceBlock"');
    expect(targetPane).toContain('data-action="insertTargetBlock"');
    expect(targetPane).toContain('data-action="deleteSourceBlock"');
    expect(targetPane).toContain('data-action="deleteTargetBlock"');
    expect(targetPane).toContain('data-split-toggle="insert"');
    expect(targetPane).toContain('data-split-toggle="delete"');
    expect(targetPane).toContain('data-action="toggleCellActions"');
    expect(html).not.toContain("插入原文");
    expect(html).not.toContain("删除原文");
  });

  it("keeps a placeholder counterpart cell for target-only blocks in the split layout", async () => {
    const result = await translate();
    const heading = inspect(SOURCE, result.cacheText).alignment.blocks.find(
      (block) => block.source.kind === "heading",
    );
    const targetText = "译文锁定新增内容。";
    const anchor = serializeAnchor({
      id: "target-1",
      kind: "paragraph",
      src: `t-${heading!.source.hash}`,
      dst: blockHash("paragraph", targetText),
      mode: "target",
    });
    const model = buildPreviewModel({
      sourceText: SOURCE,
      cacheText: `${result.cacheText}\n\n${anchor}\n\n${targetText}\n`,
      ...LABELS,
    });
    const html = buildPreviewHtml({
      model,
      layout: "split",
      nonce: "test-nonce",
      csp: "default-src 'none'",
      cssHref: "preview.css",
      scriptHref: "preview.js",
      katexHref: "katex.css",
    });
    const sourceStart = html.indexOf('data-split-pane="source"');
    const targetStart = html.indexOf('data-split-pane="target"');
    const sourcePane = html.slice(sourceStart, targetStart);
    const targetPane = html.slice(targetStart);

    expect(sourcePane).toContain(
      "mbs-split-cell-source mbs-split-cell-placeholder",
    );
    expect(sourcePane).toContain('data-sync-key="standalone:target-1"');
    expect(sourcePane).toContain("mbs-split-cell-head");
    expect(sourcePane).toContain("无对应原文（译文锁定块）");
    expect(sourcePane).not.toContain("mbs-empty-slot");
    expect(targetPane).toContain('data-standalone-id="target-1"');
    expect(targetPane).toContain(
      'data-action="backTranslateTargetOnly"',
    );
    expect(sourcePane.match(/data-sync-key=/g)).toHaveLength(
      targetPane.match(/data-sync-key=/g)!.length,
    );
  });

  it("keeps a placeholder counterpart cell for pending source insertions", async () => {
    const result = await translate();
    const heading = inspect(SOURCE, result.cacheText).alignment.blocks.find(
      (block) => block.source.kind === "heading",
    );
    const model = buildPreviewModel({
      sourceText: SOURCE,
      cacheText: result.cacheText,
      ...LABELS,
      pendingSource: {
        edits: new Map(),
        deletions: new Set(),
        insertions: [
          {
            id: "pending-1",
            afterIndex: heading!.source.index,
            text: "## Inserted heading",
          },
        ],
      },
    });
    const html = buildPreviewHtml({
      model,
      layout: "split",
      nonce: "test-nonce",
      csp: "default-src 'none'",
      cssHref: "preview.css",
      scriptHref: "preview.js",
      katexHref: "katex.css",
    });
    const sourceStart = html.indexOf('data-split-pane="source"');
    const targetStart = html.indexOf('data-split-pane="target"');
    const sourcePane = html.slice(sourceStart, targetStart);
    const targetPane = html.slice(targetStart);

    expect(sourcePane).toContain('data-pending-id="pending-1"');
    expect(targetPane).toContain(
      "mbs-split-cell-target mbs-split-cell-placeholder",
    );
    expect(targetPane).toContain('data-sync-key="pending:pending-1"');
    expect(targetPane).toContain("尚未翻译");
  });

  it("places the import button right after sync in the toolbar", async () => {
    const result = await translate();
    const model = buildPreviewModel({
      sourceText: SOURCE,
      cacheText: result.cacheText,
      ...LABELS,
    });
    const html = buildPreviewHtml({
      model,
      nonce: "test-nonce",
      csp: "default-src 'none'",
      cssHref: "preview.css",
      scriptHref: "preview.js",
      katexHref: "katex.css",
    });

    const sync = html.indexOf('data-action="sync"');
    const importButton = html.indexOf('data-action="importTranslation"');
    const refresh = html.indexOf('data-action="refresh"');
    expect(sync).toBeGreaterThanOrEqual(0);
    expect(importButton).toBeGreaterThan(sync);
    expect(refresh).toBeGreaterThan(importButton);
    expect(html).toContain("导入译文");
  });

  it("renders independent read-only panes in the split layout", async () => {
    const result = await translate();
    const model = buildPreviewModel({
      sourceText: SOURCE,
      cacheText: result.cacheText,
      ...LABELS,
    });
    const html = buildPreviewHtml({
      model,
      layout: "split",
      readonly: { source: true, target: false },
      nonce: "test-nonce",
      csp: "default-src 'none'",
      cssHref: "preview.css",
      scriptHref: "preview.js",
      katexHref: "katex.css",
    });

    expect(html).toContain("mbs-readonly-document");
    expect(html).toContain("First paragraph.");
    expect(html).toContain(
      'data-action="togglePaneReadonly" data-pane="source" aria-pressed="true"',
    );
    expect(html).toContain(
      'data-action="togglePaneReadonly" data-pane="target" aria-pressed="false"',
    );
    expect(html).not.toContain("mbs-split-cell-source");
    expect(html.match(/mbs-split-cell-target/g)).toHaveLength(4);
  });

  it("renders both split panes as continuous documents in read-only mode", async () => {
    const result = await translate();
    const model = buildPreviewModel({
      sourceText: SOURCE,
      cacheText: result.cacheText,
      ...LABELS,
    });
    const html = buildPreviewHtml({
      model,
      layout: "split",
      readonly: { source: true, target: true },
      nonce: "test-nonce",
      csp: "default-src 'none'",
      cssHref: "preview.css",
      scriptHref: "preview.js",
      katexHref: "katex.css",
    });

    expect(html.match(/mbs-readonly-document/g)).toHaveLength(2);
    expect(html).not.toContain("mbs-split-cell-source");
    expect(html).not.toContain("mbs-split-cell-target");
  });

  it("does not render read-only placeholders for one-sided blocks", async () => {
    const result = await translate();
    const heading = inspect(SOURCE, result.cacheText).alignment.blocks.find(
      (block) => block.source.kind === "heading",
    );
    const targetText = "译文锁定新增内容。";
    const anchor = serializeAnchor({
      id: "target-1",
      kind: "paragraph",
      src: `t-${heading!.source.hash}`,
      dst: blockHash("paragraph", targetText),
      mode: "target",
    });
    const model = buildPreviewModel({
      sourceText: SOURCE,
      cacheText: `${result.cacheText}\n\n${anchor}\n\n${targetText}\n`,
      ...LABELS,
    });
    const html = buildPreviewHtml({
      model,
      layout: "split",
      readonly: { source: true, target: true },
      nonce: "test-nonce",
      csp: "default-src 'none'",
      cssHref: "preview.css",
      scriptHref: "preview.js",
      katexHref: "katex.css",
    });
    const sourceStart = html.indexOf('data-split-pane="source"');
    const targetStart = html.indexOf('data-split-pane="target"');
    const sourcePane = html.slice(sourceStart, targetStart);
    const targetPane = html.slice(targetStart);

    expect(sourcePane).not.toContain("mbs-readonly-empty");
    expect(sourcePane).not.toContain('data-sync-key="standalone:target-1"');
    expect(sourcePane).not.toContain("无对应原文");
    expect(sourcePane).toContain("First paragraph.");
    expect(targetPane).toContain("译文锁定新增内容");
    expect(targetPane).toContain('data-sync-key="standalone:target-1"');
  });

  it("does not render read-only target slots for pending source insertions", async () => {
    const result = await translate();
    const heading = inspect(SOURCE, result.cacheText).alignment.blocks.find(
      (block) => block.source.kind === "heading",
    );
    const model = buildPreviewModel({
      sourceText: SOURCE,
      cacheText: result.cacheText,
      ...LABELS,
      pendingSource: {
        edits: new Map(),
        deletions: new Set(),
        insertions: [
          {
            id: "pending-1",
            afterIndex: heading!.source.index,
            text: "## Inserted heading",
          },
        ],
      },
    });
    const html = buildPreviewHtml({
      model,
      layout: "split",
      readonly: { source: true, target: true },
      nonce: "test-nonce",
      csp: "default-src 'none'",
      cssHref: "preview.css",
      scriptHref: "preview.js",
      katexHref: "katex.css",
    });
    const targetStart = html.indexOf('data-split-pane="target"');
    const sourcePane = html.slice(0, targetStart);
    const targetPane = html.slice(targetStart);

    expect(targetPane).not.toContain("mbs-readonly-empty");
    expect(targetPane).not.toContain('data-sync-key="pending:pending-1"');
    expect(sourcePane).toContain("Inserted heading");
    expect(sourcePane).toContain('data-sync-key="pending:pending-1"');
  });

  it("does not render read-only controls outside the split layout", async () => {
    const result = await translate();
    const model = buildPreviewModel({
      sourceText: SOURCE,
      cacheText: result.cacheText,
      ...LABELS,
    });
    const html = buildPreviewHtml({
      model,
      layout: "columns",
      readonly: { source: true, target: true },
      nonce: "test-nonce",
      csp: "default-src 'none'",
      cssHref: "preview.css",
      scriptHref: "preview.js",
      katexHref: "katex.css",
    });

    expect(html).not.toContain("togglePaneReadonly");
    expect(html).not.toContain("mbs-readonly-document");
  });

  it("marks blocks as untranslated before the first sync", () => {
    const model = buildPreviewModel({ sourceText: SOURCE, ...LABELS });
    expect(model.cacheExists).toBe(false);
    expect(model.counts.untranslated).toBe(3);
    expect(model.counts.copy).toBe(1);
    expect(model.blocks.map((block) => block.status)).toContain(
      "copy-pending",
    );
    expect(model.warnings.join("\n")).toContain("尚未生成译文缓存");
  });

  it("exposes stale and human-stale states", async () => {
    const initial = await translate();
    const state = inspect(SOURCE, initial.cacheText);
    const paragraph = state.alignment.blocks.find(
      (block) => block.source.kind === "paragraph" && block.cache,
    );
    const edited = replaceCachedBlock({
      cacheText: initial.cacheText,
      cache: state.cache,
      target: paragraph!.cache!,
      content: "人工译文。",
      sourceHash: paragraph!.source.hash,
      sourceKind: paragraph!.source.kind,
      mode: "human",
      md: state.md,
    });
    const changed = SOURCE.replace(
      "First paragraph.",
      "First paragraph changed.",
    ).replace("- item one", "- item one changed");

    const model = buildPreviewModel({
      sourceText: changed,
      cacheText: edited.text,
      ...LABELS,
    });
    const statuses = model.blocks.map((block) => block.status);
    expect(statuses).toContain("human-stale");
    expect(statuses).toContain("stale");
    expect(model.counts.human).toBe(1);
    expect(model.counts.stale).toBe(1);
    const humanBlock = model.blocks.find(
      (block) => block.status === "human-stale",
    );
    expect(humanBlock?.canMarkSynced).toBe(true);
    expect(humanBlock?.human).toBe(true);
  });

  it("keeps footnote definitions out of block rows and renders them separately", async () => {
    const sourceText = [
      "# Notes",
      "",
      "Text with a footnote.[^1]",
      "",
      "[^1]: Footnote body.",
      "",
    ].join("\n");
    const result = await translate(sourceText);
    const model = buildPreviewModel({
      sourceText,
      cacheText: result.cacheText,
      ...LABELS,
    });
    expect(model.sourceFootnotesHtml).toContain("Footnote body.");
    expect(model.targetFootnotesHtml).toContain("Footnote body.");
    expect(model.blocks.some((block) => block.kind === "footnote")).toBe(
      false,
    );

    const paragraph = model.blocks.find((block) => block.kind === "paragraph");
    const sourceHtml =
      `${paragraph?.sourceHtml ?? ""}${model.sourceFootnotesHtml}`;
    const targetHtml =
      `${paragraph?.targetHtml ?? ""}${model.targetFootnotesHtml}`;
    // 引用锚点、脚注项与回链都应带各栏前缀。
    expect(sourceHtml).toContain('id="src-fn1"');
    expect(sourceHtml).toContain('href="#src-fn1"');
    expect(sourceHtml).toContain('id="src-fnref1"');
    expect(model.sourceFootnotesHtml).toContain('href="#src-fnref1"');
    expect(targetHtml).toContain('id="tgt-fn1"');
    expect(targetHtml).toContain('href="#tgt-fn1"');
    expect(targetHtml).toContain('id="tgt-fnref1"');
    expect(model.targetFootnotesHtml).toContain('href="#tgt-fnref1"');

    // 原文与译文不再共享同一个 fn id。
    const sourceIds = [...sourceHtml.matchAll(/id="([^"]+)"/g)].map(
      (match) => match[1],
    );
    const targetIds = [...targetHtml.matchAll(/id="([^"]+)"/g)].map(
      (match) => match[1],
    );
    expect(sourceIds.length).toBeGreaterThan(0);
    expect(targetIds.length).toBeGreaterThan(0);
    expect(sourceIds.some((id) => targetIds.includes(id))).toBe(false);
  });

  it("resolves relative images and external links", () => {
    const model = buildPreviewModel({
      sourceText:
        "![Diagram](assets/demo.svg)\n\n[Guide](https://example.com)",
      resolveImage: (source) => `resolved:${source}`,
      ...LABELS,
    });
    const html = model.blocks.map((block) => block.sourceHtml).join("\n");
    expect(html).toContain('src="resolved:assets/demo.svg"');
    expect(html).toContain('data-mbs-href="https://example.com"');
  });
});

describe("buildPreviewHtml", () => {
  it("escapes document metadata and warnings", () => {
    const html = buildPreviewHtml({
      model: {
        fileLabel: "<b>demo.md</b>",
        sourceLanguage: "en",
        targetLanguage: "zh-CN",
        providerLabel: "Mock",
        cacheExists: false,
        blocks: [],
        sourceFootnotesHtml: "",
        targetFootnotesHtml: "",
        counts: {
          total: 0,
          translated: 0,
          stale: 0,
          human: 0,
          untranslated: 0,
          copy: 0,
        },
        warnings: ["<script>alert(1)</script>"],
        pendingSourceCount: 0,
      },
      nonce: "test-nonce",
      csp: "default-src 'none'",
      cssHref: "preview.css",
      scriptHref: "preview.js",
      katexHref: "katex.css",
      notice: { text: "同步 <完成>", kind: "success" },
    });
    expect(html).not.toContain("<b>demo.md</b>");
    expect(html).toContain("&lt;b&gt;demo.md&lt;/b&gt;");
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain('data-initial-text="同步 &lt;完成&gt;"');
    expect(html).toContain('data-initial-kind="success"');
    expect(html).toContain('nonce="test-nonce"');
    expect(html).toContain('data-mode="bilingual"');
    expect(html).toContain('data-layout="columns"');
    expect(html).toContain('data-layout="stacked"');
  });

  it("exposes export and stale retranslation actions", async () => {
    const result = await translate();
    const model = buildPreviewModel({
      sourceText: SOURCE.replace(
        "First paragraph.",
        "First paragraph updated.",
      ),
      cacheText: result.cacheText,
      ...LABELS,
    });
    const html = buildPreviewHtml({
      model,
      nonce: "test-nonce",
      csp: "default-src 'none'",
      cssHref: "preview.css",
      scriptHref: "preview.js",
      katexHref: "katex.css",
    });

    expect(html).toContain('data-action="retranslateStale"');
    expect(html).toContain("重译过期 1");
    expect(html).toContain('data-action="retranslateAll"');
    expect(html).toContain("全部重译");
    expect(html).toContain('data-edit-pane="source"');
    expect(html).toContain('data-edit-pane="target"');
    expect(html).toContain('data-raw="source"');
    expect(html).toContain('data-modal="source"');
    expect(html).not.toContain('data-modal="back"');
    expect(html).toContain('id="mbs-ui-text"');
    expect(html).toContain('data-action="export"');
    expect(html).not.toContain('data-action="export" disabled');
  });

  it("disables export before a cache exists and hides stale retranslation", () => {
    const model = buildPreviewModel({ sourceText: SOURCE, ...LABELS });
    const html = buildPreviewHtml({
      model,
      nonce: "test-nonce",
      csp: "default-src 'none'",
      cssHref: "preview.css",
      scriptHref: "preview.js",
      katexHref: "katex.css",
    });

    expect(html).toContain(
      'data-action="export" disabled title="需要先生成译文缓存"',
    );
    expect(html).not.toContain('data-action="retranslateStale"');
    expect(html).not.toContain('data-action="retranslateAll"');
  });

  it("embeds a source writeback confirmation without breaking the CSP data block", () => {
    const model = buildPreviewModel({ sourceText: SOURCE, ...LABELS });
    const html = buildPreviewHtml({
      model,
      nonce: "test-nonce",
      csp: "default-src 'none'",
      cssHref: "preview.css",
      scriptHref: "preview.js",
      katexHref: "katex.css",
      sourceConfirmation: {
        destination: "demo</script><script>alert(1)</script>.md",
        count: 1,
        diff: buildExportDiff("old", "new"),
      },
    });

    expect(html).toContain('id="mbs-source-data"');
    expect(html).toContain("\\u003c/script>");
    expect(html).not.toContain("</script><script>alert(1)");
  });

  it("embeds the export confirmation modal and diff data", () => {
    const model = buildPreviewModel({
      sourceText: SOURCE,
      ...LABELS,
    });
    const html = buildPreviewHtml({
      model,
      nonce: "test-nonce",
      csp: "default-src 'none'",
      cssHref: "preview.css",
      scriptHref: "preview.js",
      katexHref: "katex.css",
      exportConfirmation: {
        destination: 'demo</script><script>alert(1)</script>.zh.md',
        summary: "已翻译 3",
        warningCount: 2,
        existing: true,
        diff: buildExportDiff("old\n", "new\n"),
      },
    });

    expect(html).toContain('data-modal="export" hidden');
    expect(html).toContain('id="mbs-export-data"');
    expect(html).toContain('"summary":"已翻译 3"');
    expect(html).toContain('"warningCount":2');
    expect(html).not.toContain("</script><script>alert(1)");
    expect(html).toContain("\\u003c/script>");
  });
});
