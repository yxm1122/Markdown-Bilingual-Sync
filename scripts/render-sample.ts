/**
 * 静态预览生成脚本（Node + tsx，`npm run preview:sample`）。
 *
 * 使用 Mock Provider 同步 samples/demo.md，把译文缓存和多种状态的 HTML 输出到 tmp/：
 * preview.html（双语）、preview-split.html（左右分栏）、preview-export.html（导出确认）、
 * preview-states.html（原文变更 + 译文锁定）以及两份 .zh.md 缓存。
 *
 * 运行环境：Node / 本地开发脚本，不启动 VS Code。生成的 HTML 直接引用 ../media 下的
 * preview.js、preview.css 与 KaTeX，因此在浏览器里以 standalone 模式运行：
 * media/preview.js 检测不到 acquireVsCodeApi 时会改用 localStorage 保存状态，并把
 * postMessage 记录到 window.__mbsMessages，同时用 toast 显示动作类型。
 *
 * 与扩展主进程的通信：无。这里只调用 src 下的纯逻辑（syncDocument、buildPreviewModel、
 * buildPreviewHtml），模拟扩展宿主生成的页面结构与 CSP。
 *
 * 前提：从仓库根目录运行（projectRoot 取 process.cwd()），samples/demo.md 存在。
 */
import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { alignDocument } from "../src/markdown/align";
import { parseCacheDocument } from "../src/markdown/anchors";
import { createMarkdownRuntime } from "../src/markdown/markdown";
import { parseMarkdownDocument } from "../src/markdown/segmenter";
import { replaceCachedBlock } from "../src/cache/editCache";
import {
  buildExportDiff,
  type ExportConfirmationView,
} from "../src/export/diffPreview";
import { buildPreviewHtml } from "../src/preview/html";
import {
  buildPreviewModel,
  type PreviewModel,
} from "../src/preview/previewModel";
import { syncDocument } from "../src/sync/sync";
import { MockTranslationProvider } from "../src/translation/mockProvider";

// 输出固定写到仓库的 tmp/，方便直接双击打开或交给本地静态服务器。
const projectRoot = process.cwd();
const outputDir = path.join(projectRoot, "tmp");
const settings = {
  sourceLanguage: "en",
  targetLanguage: "zh-CN",
};
const providerLabel = "演示翻译（Mock）";

/**
 * 把示例 Markdown 中的图片相对路径解析为 file:// URL。
 * 静态预览没有 Webview 的 asWebviewUri，必须使用绝对 file URL 才能通过 CSP 的 img-src。
 * @param source 相对 samples/ 的图片路径。
 * @returns file: 协议 URL。
 */
function resolveImage(source: string): string {
  return pathToFileURL(path.resolve(projectRoot, "samples", source)).href;
}

/**
 * 生成 standalone 预览使用的 CSP。
 *
 * 与真实 Webview 的 nonce CSP 不同：页面从 file:// 打开，脚本、样式与字体都必须显式允许
 * file: 来源；script-src 里的 file: 同时意味着任意本地脚本都能执行，因此此 CSP 仅用于
 * 本机演示，不应照搬到扩展（扩展 Webview 只允许带 nonce 的脚本）。
 * @param nonce 本次 HTML 的脚本 nonce。
 * @returns 可直接写入 meta 标签的 CSP 字符串。
 */
function standaloneCsp(nonce: string): string {
  return [
    "default-src 'none'",
    "img-src file: data: https:",
    "style-src file: 'unsafe-inline'",
    "font-src file: data:",
    `script-src 'nonce-${nonce}' file:`,
  ].join("; ");
}

/**
 * 构建一份静态预览 HTML。
 * @param model 预览模型（块、统计、脚注等）。
 * @param exportConfirmation 可选的导出确认弹窗数据，用于预置导出 diff。
 * @param layout 默认使用 columns，另可生成 split 分栏预览。
 * @returns 完整 HTML 字符串。
 */
function renderHtml(
  model: PreviewModel,
  exportConfirmation?: ExportConfirmationView,
  layout: "columns" | "stacked" | "split" = "columns",
): string {
  const nonce = randomBytes(18).toString("base64");
  return buildPreviewHtml({
    model,
    layout,
    nonce,
    csp: standaloneCsp(nonce),
    cssHref: "../media/preview.css",
    scriptHref: "../media/preview.js",
    katexHref: "../media/katex/katex.min.css",
    exportConfirmation,
  });
}

/**
 * 在终端输出一份预览的块统计与警告，便于对比不同状态下的生成结果。
 * @param label 输出文件名。
 * @param model 已构建的预览模型。
 */
function summarize(label: string, model: PreviewModel): void {
  const parts = [
    `已翻译 ${model.counts.translated}`,
    `原文已更新 ${model.counts.stale}`,
    `译文锁定 ${model.counts.human}`,
    `未翻译 ${model.counts.untranslated}`,
    `复制/公式 ${model.counts.copy}`,
  ];
  console.log(
    `${label}: ${parts.join(", ")} · 共 ${model.counts.total} 块 · 警告 ${model.warnings.length}`,
  );
  for (const warning of model.warnings) {
    console.log(`  ! ${warning}`);
  }
}

/**
 * 生成全部示例产物。
 *
 * 流程：
 * 1. 读取 demo.md，用 Mock Provider 同步出译文缓存；
 * 2. 生成基础双语预览、分栏预览和带导出确认弹窗的预览；
 * 3. 基于“手改原文 + 锁定一段译文”的状态再生成一份预览，覆盖过期/译文锁定样式。
 */
async function main(): Promise<void> {
  const sourceText = await readFile(
    path.join(projectRoot, "samples", "demo.md"),
    "utf8",
  );
  const md = createMarkdownRuntime();
  const provider = new MockTranslationProvider();
  const result = await syncDocument({
    md,
    sourceText,
    provider,
    ...settings,
    retranslateStale: false,
  });

  await mkdir(outputDir, { recursive: true });
  await writeFile(
    path.join(outputDir, "demo.zh.md"),
    result.cacheText,
    "utf8",
  );

  const baseModel = buildPreviewModel({
    sourceText,
    cacheText: result.cacheText,
    ...settings,
    providerLabel,
    fileLabel: "demo.md",
    resolveImage,
  });
  await writeFile(
    path.join(outputDir, "preview.html"),
    renderHtml(baseModel),
    "utf8",
  );
  summarize("preview.html", baseModel);
  await writeFile(
    path.join(outputDir, "preview-split.html"),
    renderHtml(baseModel, undefined, "split"),
    "utf8",
  );
  summarize("preview-split.html", baseModel);

  // 下面通过替换译文内容构造“上一版缓存”，让导出弹窗能显示真实的增删 diff。
  // 这些 replace 依赖 demo.md 与 Mock 译文的原文措辞；修改示例后若不再命中，
  // 对应差异会静默消失，需同步调整这里的字面量。
  const previousCacheText = result.cacheText
    .replace("敏捷的棕色狐狸跃过懒狗。", "敏捷的棕色狐狸跳过那只懒狗。")
    .replace("## 手动增量同步", "## 手动同步")
    .replace("- Keep 人工 edits 锁定 and visible.\n", "")
    .replace(
      "| Glossary and export | 就绪 | Global glossary, diff export |",
      "| Glossary and export | 就绪 | Global glossary |",
    );
  const exportConfirmation: ExportConfirmationView = {
    destination: "demo.zh.md",
    summary: `共 ${baseModel.counts.total} 块：已翻译 ${baseModel.counts.translated}，译文锁定 ${baseModel.counts.human}，复制/公式 ${baseModel.counts.copy}`,
    warningCount: baseModel.warnings.length,
    existing: true,
    diff: buildExportDiff(previousCacheText, result.cacheText),
  };
  await writeFile(
    path.join(outputDir, "preview-export.html"),
    renderHtml(baseModel, exportConfirmation),
    "utf8",
  );
  summarize("preview-export.html", baseModel);

  // 模拟用户改写原文：一段正文与一段列表需要重新翻译。
  const editedSource = sourceText
    .replace(
      "This paragraph keeps a short English text next to its Chinese translation.",
      "This paragraph was edited after the first sync, so its translation is now stale.",
    )
    .replace(
      "- Translate only the blocks that changed.",
      "- Translate only the blocks that changed.\n- A new source item was added after the sync.",
    );

  const targetMd = createMarkdownRuntime();
  const parsedCache = parseCacheDocument(result.cacheText, targetMd);
  const parsedSource = parseMarkdownDocument(sourceText, md);
  const alignment = alignDocument(parsedSource.blocks, parsedCache);
  const list = alignment.blocks.find(
    (item) => item.source.kind === "list" && item.cache,
  );
  if (!list?.cache) {
    throw new Error("示例文档中找不到用于演示译文锁定的列表块。");
  }
  // 把列表块写成 human 模式（译文锁定），演示人工修改不会被自动覆盖的样式。
  const humanCache = replaceCachedBlock({
    cacheText: result.cacheText,
    cache: parsedCache,
    target: list.cache,
    content: [
      "- 这是译文锁定的列表项。",
      "- 人工修改会保留，不会被自动覆盖。",
      "- 标记已同步后会接受当前原文。",
    ].join("\n"),
    sourceHash: list.source.hash,
    sourceKind: list.source.kind,
    mode: "human",
    md: targetMd,
  });
  await writeFile(
    path.join(outputDir, "demo.states.zh.md"),
    humanCache.text,
    "utf8",
  );

  const stateModel = buildPreviewModel({
    sourceText: editedSource,
    cacheText: humanCache.text,
    ...settings,
    providerLabel,
    fileLabel: "demo.md（含过期与译文锁定）",
    resolveImage,
  });
  await writeFile(
    path.join(outputDir, "preview-states.html"),
    renderHtml(stateModel),
    "utf8",
  );
  summarize("preview-states.html", stateModel);

  console.log(`\n输出目录：${outputDir}`);
  console.log(`- preview.html        翻译完成后的双语预览`);
  console.log(`- preview-split.html  左右分栏预览（含块级滚动同步）`);
  console.log(`- preview-export.html 带分栏差异的导出确认弹窗`);
  console.log(`- preview-states.html 修改原文并锁定列表译文后的状态预览`);
  console.log(`- demo.zh.md          Mock 生成的译文缓存`);
  console.log(`- demo.states.zh.md   锁定后的译文缓存`);
}

// 脚本失败时以非零退出码结束，便于 CI 或本地命令发现样例回归。
main().catch((error) => {
  console.error(error);
  process.exit(1);
});
