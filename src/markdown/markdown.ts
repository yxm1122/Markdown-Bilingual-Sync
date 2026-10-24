/**
 * 共享的 markdown-it 运行时工厂。
 *
 * 职责：统一启用脚注、任务列表、GitHub 提示块、KaTeX、标题锚点与代码高亮，并把
 * 预览需要的链接/图片改写成 Webview 可处理的属性。
 *
 * 关键不变量：
 * - `html: false`：原文中的内联 HTML 不会被渲染，避免 Webview 注入；
 * - 非 `#` 链接统一改写为 `href="#"` + `data-mbs-href`，由 Webview 通过消息回传打开；
 * - 标题与脚注的 id/href 可加前缀，避免原文/译文两栏渲染时 id 冲突。
 *
 * 与其他模块的关系：`segmenter` 用它的 token 结果切块，预览用它的 render 结果，
 * 因此插件配置的变化会同时影响切块与渲染。
 */
import MarkdownIt from "markdown-it";
import type { MarkdownIt as MarkdownItInstance } from "markdown-it";
import anchor from "markdown-it-anchor";
import footnote from "markdown-it-footnote";
import githubAlerts from "markdown-it-github-alerts";
import katex from "@traptitech/markdown-it-katex";
import taskLists from "markdown-it-task-lists";
import hljs from "highlight.js";

/** 创建运行时时的可选行为。 */
export interface MarkdownRuntimeOptions {
  /** 把相对图片路径解析为 Webview 可访问地址；返回 `file:`/`http:` 等绝对地址。 */
  resolveImage?: (src: string) => string;
  /** 标题 id 前缀，用于同一页面渲染两份文档时避免重复 id。 */
  idPrefix?: string;
}

/** 判断 URL 是否自带协议或为页内锚点；这类图片地址不做本地路径解析。 */
const LINK_SCHEME = /^(?:[a-z][a-z0-9+.-]*:|#)/i;

/**
 * 生成标题锚点 slug：保留 Unicode 字母/数字，空白转连字符。
 * 结果为空时回退为 `section`，保证 `id` 非空。
 */
function slugifyHeading(input: string): string {
  const slug = input
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return slug || "section";
}

/**
 * 给脚注渲染结果中的 `id`/`href` 属性加前缀。
 *
 * markdown-it-footnote 的三个渲染规则直接返回 HTML 字符串（没有可写的 token 属性），
 * 因此只能在规则输出上改写；`href="#..."` 保留 `#` 在属性值首位，否则会被当作外部链接。
 */
function prefixFootnoteAttributes(html: string, prefix: string): string {
  return html.replace(
    /(\s)(id|href)="([^"]*)"/g,
    (match, space: string, name: string, value: string) => {
      if (!value) {
        return match;
      }
      const prefixed =
        name === "href" && value.startsWith("#")
          ? `#${prefix}${value.slice(1)}`
          : `${prefix}${value}`;
      return `${space}${name}="${prefixed}"`;
    },
  );
}

/**
 * 创建并配置一个新的 markdown-it 实例。
 *
 * 每次调用都会注册全套插件并覆盖 fence/image/link_open 渲染规则，返回的实例可安全
 * 复用于多次同步解析（每次 `parse` 传入独立 env）。不会抛错；插件本身解析异常由
 * markdown-it 自行处理。
 */
export function createMarkdownRuntime(
  options: MarkdownRuntimeOptions = {},
): MarkdownItInstance {
  const md = new MarkdownIt({
    html: false,
    linkify: true,
    typographer: false,
    breaks: false,
  });

  md.use(footnote);
  md.use(taskLists, { enabled: false, label: true });
  md.use(githubAlerts);
  md.use(katex, { throwOnError: false, strict: "ignore", output: "html" });
  const idPrefix = options.idPrefix ?? "";
  md.use(anchor, {
    level: [1, 2, 3, 4, 5, 6],
    slugify: slugifyHeading,
    // 锚点插件生成 id 后再统一加前缀；空字符串时保持默认行为。
    callback: idPrefix
      ? (token) => {
          const id = String(token.attrGet("id") ?? "");
          if (id) {
            token.attrSet("id", `${idPrefix}${id}`);
          }
        }
      : undefined,
  });

  if (idPrefix) {
    // 包装脚注的三个渲染规则，把插件生成的 fn/fnref 锚点纳入同一前缀命名空间。
    // 渲染时移除 env.docId：脚注插件会用它再生成 `fn-${docId}-1`，与 idPrefix
    // 叠加会得到 `src-fn-src-1`；两栏的唯一性已由 idPrefix 保证。
    const footnoteRules = [
      "footnote_ref",
      "footnote_open",
      "footnote_anchor",
    ] as const;
    for (const ruleName of footnoteRules) {
      const renderFootnote = md.renderer.rules[ruleName];
      if (!renderFootnote) {
        continue;
      }
      md.renderer.rules[ruleName] = (tokens, idx, opts, env, self) =>
        prefixFootnoteAttributes(
          renderFootnote(tokens, idx, opts, { ...env, docId: undefined }, self),
          idPrefix,
        );
    }
  }

  md.renderer.rules.fence = (tokens, idx, opts, env, self) => {
    const token = tokens[idx];
    const info = token.info.trim().split(/\s+/)[0] ?? "";
    const language = info ? hljs.getLanguage(info) : undefined;
    let highlighted: string;
    // 未知语言或高亮器异常时退回纯转义文本，保证预览不中断。
    try {
      highlighted = language
        ? hljs.highlight(token.content, {
            language: info,
            ignoreIllegals: true,
          }).value
        : md.utils.escapeHtml(token.content);
    } catch {
      highlighted = md.utils.escapeHtml(token.content);
    }
    const languageClass = info
      ? ` language-${md.utils.escapeHtml(info)}`
      : "";
    return `<pre class="mbs-code-block"><code class="hljs${languageClass}">${highlighted}</code></pre>\n`;
  };

  const defaultImage =
    md.renderer.rules.image ??
    ((tokens, idx, opts, env, self) =>
      self.renderToken(tokens, idx, opts));

  md.renderer.rules.image = (tokens, idx, opts, env, self) => {
    const token = tokens[idx];
    const src = String(token.attrGet("src") ?? "");
    // 只解析相对路径；带协议或页内锚点的地址保持原样。
    if (options.resolveImage && src && !LINK_SCHEME.test(src)) {
      token.attrSet("src", options.resolveImage(src));
    }
    token.attrSet("loading", "lazy");
    return defaultImage(tokens, idx, opts, env, self);
  };

  const defaultLinkOpen =
    md.renderer.rules.link_open ??
    ((tokens, idx, opts, env, self) =>
      self.renderToken(tokens, idx, opts));

  md.renderer.rules.link_open = (tokens, idx, opts, env, self) => {
    const token = tokens[idx];
    const href = String(token.attrGet("href") ?? "");
    if (href.startsWith("#")) {
      // 页内锚点需要跟随标题 id 前缀，否则译文栏跳转失效。
      if (idPrefix) {
        token.attrSet("href", `#${idPrefix}${href.slice(1)}`);
      }
    } else if (href) {
      // 外部链接交给 Webview 的点击拦截逻辑，避免在预览 iframe 内直接跳转。
      token.attrSet("data-mbs-href", href);
      token.attrSet("href", "#");
    }
    return defaultLinkOpen(tokens, idx, opts, env, self);
  };

  return md;
}

/** 对任意文本做 Markdown 安全转义；供需要复用同一实例转义规则的调用方使用。 */
export function markdownItEscape(
  md: MarkdownItInstance,
  value: string,
): string {
  return md.utils.escapeHtml(value);
}
