/**
 * 生成 README 宣传截图使用的静态预览页面。
 *
 * 与 render-sample 分离：这里使用 docs/assets/readme 下的人工译文，避免 Mock 译文
 * 进入宣传图；同时构造译文锁定、原文已更新、简报/术语表与批注状态。
 *
 * 输出：tmp/readme-hero.html、readme-edit.html、readme-brief.html、
 * readme-annotations.html、readme-selection.html（英文界面，深色主题）。
 */
import "./readme-locale";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import * as vscode from "vscode";
import { alignDocument } from "../src/markdown/align";
import { parseCacheDocument } from "../src/markdown/anchors";
import { createMarkdownRuntime } from "../src/markdown/markdown";
import { parseMarkdownDocument } from "../src/markdown/segmenter";
import { replaceCachedBlock } from "../src/cache/editCache";
import { buildPreviewAppShell } from "../src/preview/appShell";
import {
  buildPreviewModel,
  type PreviewModel,
} from "../src/preview/previewModel";
import { syncDocument } from "../src/sync/sync";
import {
  validateTranslationResult,
  type TranslationProvider,
  type TranslationRequest,
  type TranslationResultItem,
} from "../src/translation/types";
import { STATIC_THEMES } from "./static-themes";

const projectRoot = process.cwd();
const assetDir = path.join(projectRoot, "docs", "assets", "readme");
const outputDir = path.join(projectRoot, "tmp");
const settings = {
  sourceLanguage: "en",
  targetLanguage: "zh-CN",
};
const providerLabel = "OpenAI-compatible";
const fileLabel = "payments-api.md";

/** 把示例 Markdown 中的图片相对路径解析为 file:// URL。 */
function resolveImage(source: string): string {
  return pathToFileURL(path.resolve(projectRoot, "samples", source)).href;
}

/** 基于原文/译文块顺序建立逐块映射，保证两块结构完全一致。 */
function buildTranslationMap(
  sourceText: string,
  targetText: string,
): Map<string, string> {
  const md = createMarkdownRuntime();
  const source = parseMarkdownDocument(sourceText, md);
  const target = parseMarkdownDocument(targetText, md);
  if (source.blocks.length !== target.blocks.length) {
    throw new Error(
      `演示稿块数不一致：${source.blocks.length} vs ${target.blocks.length}`,
    );
  }
  const map = new Map<string, string>();
  for (let index = 0; index < source.blocks.length; index += 1) {
    const left = source.blocks[index];
    const right = target.blocks[index];
    if (left.kind !== right.kind) {
      throw new Error(`演示稿第 ${index} 块类型不一致：${left.kind} vs ${right.kind}`);
    }
    map.set(left.raw, right.raw);
  }
  return map;
}

class ShowcaseProvider implements TranslationProvider {
  readonly id = "showcase";
  readonly label = providerLabel;
  readonly supportsSummary = true;
  readonly supportsReview = true;
  readonly supportsAnnotations = true;

  constructor(private readonly translations: Map<string, string>) {}

  async translate(request: TranslationRequest): Promise<TranslationResultItem[]> {
    const results = request.items.map((item) => {
      const text =
        this.translations.get(item.text) ?? this.translations.get(item.text.trim());
      if (!text) {
        throw new Error(
          `缺少演示译文（${item.kind}）：${item.text.slice(0, 120)}`,
        );
      }
      return { id: item.id, text };
    });
    validateTranslationResult(request.items, results);
    return results;
  }
}

/** 把一个已有的机器译文块标记为 human（译文锁定）。 */
function markHuman(input: {
  cacheText: string;
  sourceText: string;
  sourcePrefix: string;
  content: string;
}): string {
  const md = createMarkdownRuntime();
  const cache = parseCacheDocument(input.cacheText, md);
  const source = parseMarkdownDocument(input.sourceText, md);
  const alignment = alignDocument(source.blocks, cache);
  const block = alignment.blocks.find(
    (item) => item.cache && item.source.raw.startsWith(input.sourcePrefix),
  );
  if (!block?.cache) {
    throw new Error(`找不到用于锁定的块：${input.sourcePrefix}`);
  }
  return replaceCachedBlock({
    cacheText: input.cacheText,
    cache,
    target: block.cache,
    content: input.content,
    sourceHash: block.source.hash,
    sourceKind: block.source.kind,
    mode: "human",
    md,
  }).text;
}

function renderHtml(
  model: PreviewModel,
  options?: {
    layout?: "columns" | "split";
  },
): string {
  const nonce = randomBytes(18).toString("base64");
  const webview = {
    cspSource: "file:",
    asWebviewUri: (uri: { fsPath: string }) => pathToFileURL(uri.fsPath).href,
  };
  const html = buildPreviewAppShell({
    webview: webview as never,
    extensionUri: vscode.Uri.file(projectRoot),
    nonce,
    state: {
      model,
      layout: options?.layout ?? "columns",
      readonly: { source: false, target: false },
    },
  });
  return html.replace(
    "</head>",
    `<style id="static-theme">${STATIC_THEMES.dark}</style></head>`,
  );
}

function summaryAssist() {
  return {
    stableTranslation: true,
    summaryContext: true,
    summary: {
      text:
        "A server-side integration guide for the Payments API. It covers authentication, payment intent creation, error handling, and webhook verification, and fixes the Chinese terms for payment intent, idempotency key, and capture method.",
      stale: false,
      updatedAt: "2026-11-01T08:00:00.000Z",
      model: "gpt-4.1",
      tokens: 386,
      brief: {
        audience: "Server-side developers integrating payments for the first time.",
        toneAndStyle:
          "Concise, neutral technical prose. Keep commands and API names unchanged.",
        ambiguities:
          "“Capture” means collecting an authorized payment, not taking a screenshot. “Settle” is not used in this guide.",
        doNotTranslate:
          "Keep endpoint paths, header names, error codes, and code samples in English.",
      },
      briefTokens: 118,
      briefFilledCount: 4,
      locks: {
        summary: true,
        glossary: true,
        brief: {
          audience: true,
          ambiguities: true,
        },
      },
      canGenerate: true,
      glossaryText: [
        "payment intent => 支付意图",
        "idempotency key => 幂等键",
        "capture method => 捕获方式",
        "rate limit => 速率限制",
        "webhook => Webhook",
      ].join("\n"),
      glossaryCount: 5,
    },
  };
}

async function main(): Promise<void> {
  const [sourceText, targetText] = await Promise.all([
    readFile(path.join(assetDir, "showcase.md"), "utf8"),
    readFile(path.join(assetDir, "showcase.zh.md"), "utf8"),
  ]);
  const translations = buildTranslationMap(sourceText, targetText);
  const md = createMarkdownRuntime();
  const provider = new ShowcaseProvider(translations);
  const result = await syncDocument({
    md,
    sourceText,
    provider,
    ...settings,
    retranslateStale: false,
  });

  // 锁定开篇段落与准备工作列表，后者随后通过修改原文变成“译文锁定 · 原文已更新”。
  let cacheText = markHuman({
    cacheText: result.cacheText,
    sourceText,
    sourcePrefix: "This guide walks you through",
    content: translations.get(
      parseMarkdownDocument(sourceText, md).blocks.find((block) =>
        block.raw.startsWith("This guide walks you through"),
      )!.raw,
    )!,
  });
  cacheText = markHuman({
    cacheText,
    sourceText,
    sourcePrefix: "- A sandbox account",
    content: translations.get(
      parseMarkdownDocument(sourceText, md).blocks.find((block) =>
        block.raw.startsWith("- A sandbox account"),
      )!.raw,
    )!,
  });

  const editedSource = sourceText
    .replace(
      "Send your secret key in the `Authorization` header. Never expose this key in browser code.",
      "Send your secret key in the `Authorization` header. Never expose this key in client-side code.",
    )
    .replace(
      "- A server that can make HTTPS requests.",
      "- A server that can make HTTPS requests.\n- A public endpoint for webhook delivery.",
    );
  if (editedSource === sourceText) {
    throw new Error("演示稿原文修改未生效，请检查字面量。");
  }

  await writeFile(path.join(outputDir, "readme-showcase.zh.md"), cacheText, "utf8");
  await writeFile(path.join(outputDir, "readme-showcase.source.md"), editedSource, "utf8");

  const baseModel = buildPreviewModel({
    sourceText: editedSource,
    cacheText,
    ...settings,
    providerLabel,
    fileLabel,
    resolveImage,
    reviewSupported: true,
    assist: summaryAssist(),
  });

  const annotationModel = buildPreviewModel({
    sourceText: editedSource,
    cacheText,
    ...settings,
    providerLabel,
    fileLabel,
    resolveImage,
    reviewSupported: true,
    assist: summaryAssist(),
  });
  const annotatedBlock = annotationModel.blocks.find(
    (block) =>
      block.kind === "paragraph" &&
      block.sourceRaw.startsWith("This guide walks you through"),
  );
  if (!annotatedBlock) {
    throw new Error("找不到用于批注演示的段落。");
  }
  const blockId =
    annotatedBlock.cacheId ?? `src-${annotatedBlock.sourceHash}`;
  annotatedBlock.annotations = [
    {
      id: "showcase-ai",
      blockId,
      side: "target",
      author: "ai",
      kind: "translation-uncertain",
      severity: "check",
      message:
        "“walks you through” reads as a tutorial. Confirm whether this guide should use a more formal reference tone.",
      question:
        "Is the audience reading this as a tutorial or as an API reference?",
      options: [
        {
          kind: "instruction",
          text: "Use a neutral, concise tone and avoid colloquial phrasing in the opening paragraph.",
          mode: "persistent",
        },
        {
          kind: "advice",
          text: "Confirm whether the guide targets first-time integrators or experienced developers.",
        },
      ],
      status: "open",
      sourceHash: annotatedBlock.sourceHash,
      createdAt: "2026-11-01T08:10:00.000Z",
      updatedAt: "2026-11-01T08:10:00.000Z",
      stale: false,
    },
    {
      id: "showcase-ai-checked",
      blockId,
      side: "target",
      author: "ai",
      kind: "term",
      severity: "check",
      message: "Terminology is consistent: payment intent → 支付意图.",
      status: "resolved",
      sourceHash: annotatedBlock.sourceHash,
      createdAt: "2026-11-01T08:11:00.000Z",
      updatedAt: "2026-11-01T08:11:00.000Z",
      stale: false,
    },
    {
      id: "showcase-user",
      blockId,
      side: "target",
      author: "user",
      kind: "request-change",
      severity: "info",
      message: "Keep the opening neutral; frame this as an API reference, not a tutorial.",
      mode: "once",
      status: "pending",
      sourceHash: annotatedBlock.sourceHash,
      createdAt: "2026-11-01T08:12:00.000Z",
      updatedAt: "2026-11-01T08:12:00.000Z",
      stale: false,
    },
  ];
  annotationModel.counts.pendingAnnotations = 1;

  await mkdir(outputDir, { recursive: true });
  await writeFile(
    path.join(outputDir, "readme-hero.html"),
    renderHtml(baseModel, { layout: "split" }),
    "utf8",
  );
  await writeFile(
    path.join(outputDir, "readme-edit.html"),
    renderHtml(baseModel),
    "utf8",
  );
  await writeFile(
    path.join(outputDir, "readme-brief.html"),
    renderHtml(baseModel),
    "utf8",
  );
  await writeFile(
    path.join(outputDir, "readme-annotations.html"),
    renderHtml(annotationModel),
    "utf8",
  );
  await writeFile(
    path.join(outputDir, "readme-selection.html"),
    renderHtml(baseModel),
    "utf8",
  );

  console.log(
    `Showcase: ${baseModel.counts.total} blocks · translated ${baseModel.counts.translated} · stale ${baseModel.counts.stale} · locked ${baseModel.counts.human}`,
  );
  console.log(`Output: ${outputDir}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
