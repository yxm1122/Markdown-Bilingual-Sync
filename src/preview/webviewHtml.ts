/**
 * Webview 外壳组装模块：把预览模型转换成最终注入 `<webview>.html` 的页面。
 *
 * 职责：
 * - 把扩展安装目录下的 media 资源（preview.css / preview.js / KaTeX 样式）解析成
 *   Webview 可访问的 URI；
 * - 依据 `webview.cspSource` 生成内容安全策略（CSP）并注入每次渲染唯一的 nonce；
 * - 其余 DOM 结构、文案与转义全部交给 `./html` 的 `buildPreviewHtml`。
 *
 * 数据流（与 preview 模块整体一致）：
 * source 文本 + cache 文本 --PreviewManager.loadPreviewState--> `buildPreviewModel`
 * --(PreviewModel)--> 本模块补 URI/CSP/nonce --> `buildPreviewHtml` 字符串
 * --> `panel.webview.html` --> Webview 脚本通过 `postMessage` 回传动作
 * --> PreviewManager.onMessage 处理后再回到本流程重新渲染。
 *
 * 关键不变量：
 * - 每次渲染都使用新的 nonce，且 CSP 只允许该 nonce 的脚本执行；
 * - CSP 不允许 connect/frame/object，因此 Webview 内无法发起网络请求；
 * - media 目录必须包含在面板的 `localResourceRoots` 中（由 PreviewManager 配置），
 *   否则 CSS/脚本/KaTeX 字体加载失败；
 * - 本模块不做文本转义，所有动态文本的转义责任在 `./html`。
 */
import * as vscode from "vscode";
import type {
  ExportConfirmationView,
  SourceConfirmationView,
} from "../export/diffPreview";
import type { PreviewModel } from "./previewModel";
import type {
  PreviewLayout,
  PreviewReadonlyState,
} from "./layout";
import { buildPreviewHtml } from "./html";

/** `buildWebviewHtml` 的输入：已构建好的模型 + 面板级渲染参数。 */
export interface WebviewHtmlInput {
  /** 目标面板，用于 `asWebviewUri` 与 `cspSource`。 */
  webview: vscode.Webview;
  /** 扩展安装目录，media 资源位于其下。 */
  extensionUri: vscode.Uri;
  /** 预览模型（区块、统计、警告、脚注等）。 */
  model: PreviewModel;
  /** 当前布局；影响是否走分栏渲染。 */
  layout: PreviewLayout;
  /** 分栏左右栏只读状态；非分栏布局忽略。 */
  readonly: PreviewReadonlyState;
  /** 本次渲染的 CSP nonce，由调用方用 `randomBytes` 生成。 */
  nonce: string;
  /** 初始提示（渲染进 toast 的 data 属性，由脚本消费一次）。 */
  notice?: { text: string; kind: "info" | "success" | "error" };
  /** 非空时把导出确认数据内联进页面，脚本加载后自动弹出导出对话框。 */
  exportConfirmation?: ExportConfirmationView;
  /** 非空时把原文写回确认数据内联进页面，脚本加载后自动弹出原文对话框。 */
  sourceConfirmation?: SourceConfirmationView;
}

/**
 * 生成完整预览页面 HTML。
 *
 * @param input 见 {@link WebviewHtmlInput}。
 * @returns 可直接赋给 `WebviewPanel.webview.html` 的完整文档字符串。
 * @remarks
 * - 纯函数（只做 URI 解析与字符串拼接），不写文件、不改模型；
 * - `asWebviewUri` 在面板已销毁等异常情况下可能抛错，由 PreviewManager.update 捕获；
 * - API Key、Provider 密钥等敏感信息不会进入此页面。
 */
export function buildWebviewHtml(input: WebviewHtmlInput): string {
  const {
    webview,
    extensionUri,
    model,
    layout,
    readonly,
    nonce,
    notice,
    exportConfirmation,
    sourceConfirmation,
  } = input;
  // ---- 资源 URI：统一走 asWebviewUri，保证 Webview 内可加载 ----
  const mediaRoot = vscode.Uri.joinPath(extensionUri, "media");
  const cssUri = webview.asWebviewUri(
    vscode.Uri.joinPath(mediaRoot, "preview.css"),
  );
  const scriptUri = webview.asWebviewUri(
    vscode.Uri.joinPath(mediaRoot, "preview.js"),
  );
  const katexUri = webview.asWebviewUri(
    vscode.Uri.joinPath(mediaRoot, "katex", "katex.min.css"),
  );
  // ---- CSP ----
  // style-src 必须保留 'unsafe-inline'：KaTeX 与分栏表格依赖 style 属性；
  // img-src 允许 data: 与 https:，用于 Markdown 中的内嵌/远程图片；
  // connect-src 'none' 让 Webview 无法自行发请求，所有动作只能回到扩展进程。
  const csp = [
    "default-src 'none'",
    `img-src ${webview.cspSource} https: data:`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `font-src ${webview.cspSource}`,
    `script-src 'nonce-${nonce}'`,
    "connect-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
  ].join("; ");

  return buildPreviewHtml({
    model,
    layout,
    readonly,
    nonce,
    csp,
    cssHref: cssUri.toString(),
    scriptHref: scriptUri.toString(),
    katexHref: katexUri.toString(),
    notice,
    exportConfirmation,
    sourceConfirmation,
  });
}
