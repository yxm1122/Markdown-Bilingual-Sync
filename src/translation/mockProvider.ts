/**
 * 演示用翻译 Provider（translation/mockProvider）
 *
 * 职责：不发起任何网络请求，用内置英中词典对文本做近似替换，并按块类型加“【译】”
 * 标记，供离线演示、单测和无密钥环境跑通全链路。
 *
 * 关键不变量：
 * - 返回的块数量与 id 必须与请求完全一致（最后统一走 validateTranslationResult）；
 * - 代码、链接、数学、HTML 等受保护片段原样保留，术语替换只在片段之外进行；
 * - 纯符号或空文本不加任何标记，避免破坏 Markdown 结构。
 *
 * 外部依赖：translation/types 的共享工具与静态词典；不读 VS Code 配置、不写文件。
 *
 * 安全边界：无网络、无密钥；所有正则来自静态词典并经过转义，不把用户文本拼进正则。
 */
import type { BlockKind } from "../markdown/types";
import {
  applyGlossary,
  validateTranslationResult,
  type ReviewAnnotationDraft,
  type ReviewRequest,
  type SummaryRequest,
  type SummaryResult,
  type TranslationChunkHandler,
  type TranslationItem,
  type TranslationProgress,
  type TranslationProvider,
  type TranslationRequest,
  type TranslationResultItem,
} from "./types";
import { tError } from "../i18n/errors";
import { UI_TEXT } from "../i18n";

// ---- 静态词典 ----
// 词组优先于单词，且都按源词长度降序，减少“短词先替换掉长词的一部分”的几率。
const PHRASES = (
  [
    ["The quick brown fox jumps over the lazy dog.", "敏捷的棕色狐狸跃过懒狗。"],
    ["Markdown Bilingual Sync", "Markdown 双语同步"],
    ["manual incremental sync", "手动增量同步"],
    ["bilingual preview", "双语预览"],
    ["source language", "原文语言"],
    ["target language", "译文语言"],
    ["translation cache", "译文缓存"],
    ["human locked block", "译文锁定块"],
    ["heading context", "标题上下文"],
    ["code block", "代码块"],
    ["features", "功能"],
    ["feature", "功能"],
    ["status", "状态"],
    ["ready", "就绪"],
    ["fast", "快速"],
    ["human", "人工"],
    ["locked", "锁定"],
  ] satisfies Array<readonly [string, string]>
).sort((a, b) => b[0].length - a[0].length);

const WORDS = (
  [
    ["translation", "译文"],
    ["translate", "翻译"],
    ["bilingual", "双语"],
    ["preview", "预览"],
    ["document", "文档"],
    ["paragraph", "段落"],
    ["heading", "标题"],
    ["section", "章节"],
    ["language", "语言"],
    ["source", "原文"],
    ["target", "译文"],
    ["cache", "缓存"],
    ["block", "块"],
    ["sync", "同步"],
    ["manual", "手动"],
    ["incremental", "增量"],
    ["file", "文件"],
    ["table", "表格"],
    ["list", "列表"],
    ["quote", "引用"],
    ["note", "备注"],
    ["warning", "警告"],
    ["important", "重要"],
    ["tip", "提示"],
    ["example", "示例"],
    ["code", "代码"],
    ["image", "图片"],
    ["footnote", "脚注"],
    ["math", "数学"],
    ["formula", "公式"],
    ["hello", "你好"],
    ["world", "世界"],
    ["quick", "敏捷"],
    ["brown", "棕色"],
    ["fox", "狐狸"],
    ["jumps", "跃过"],
    ["lazy", "懒"],
    ["dog", "狗"],
  ] satisfies Array<readonly [string, string]>
).sort((a, b) => b[0].length - a[0].length);

// 受保护片段：图片/链接、行内代码、脚注、数学公式、裸 URL、HTML 标签。
// 这些内容在演示翻译中必须原样保留，否则会破坏 Markdown 语义。
const PROTECTED =
  /(\[![A-Za-z]+\]|`[^`\n]*`|!?\[[^\]]*\]\([^)]*\)|\[[^\]]*\]\[[^\]]*\]|\[\^[^\]]+\]|\$\$[\s\S]*?\$\$|\$[^$\n]+\$|<https?:\/\/[^>\s]+>|https?:\/\/[^\s<>)]+|<[^>\n]+>)/g;

// ---- 文本替换与受保护片段 ----

/** 转义正则元字符，确保词典中的源词按字面量匹配。纯函数。 */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 按“完整单词”替换一个词（大小写不敏感），避免命中其他单词的前后缀。
 * 纯函数，不修改入参。
 */
function replaceTerm(text: string, source: string, target: string): string {
  const pattern = new RegExp(
    `(?<![\\p{L}\\p{N}_])${escapeRegExp(source)}(?![\\p{L}\\p{N}_])`,
    "giu",
  );
  return text.replace(pattern, target);
}

/**
 * 对不含受保护片段的文本套用词组与单词词典，返回近似译文。
 * 只是演示级替换，不保证语序与语义；纯函数。
 */
function translatePlain(text: string): string {
  let result = text;
  for (const [source, target] of PHRASES) {
    result = replaceTerm(result, source, target);
  }
  for (const [source, target] of WORDS) {
    result = replaceTerm(result, source, target);
  }
  return result;
}

/**
 * 切分文本：受保护片段原样保留，其余片段先套术语表再套词典。
 * 这样术语与词典都不会改动代码/链接/公式。纯函数。
 */
function translateOutsideProtected(
  text: string,
  glossary: TranslationRequest["glossary"],
): string {
  const pieces: string[] = [];
  let last = 0;
  for (const match of text.matchAll(PROTECTED)) {
    const index = match.index ?? 0;
    pieces.push(translatePlain(applyGlossary(text.slice(last, index), glossary)));
    pieces.push(match[0]);
    last = index + match[0].length;
  }
  pieces.push(translatePlain(applyGlossary(text.slice(last), glossary)));
  return pieces.join("");
}

// ---- 块结构标记（词典未命中时的降级方案） ----

/** 在段落首个非空字符前加“【译】”，保留缩进。纯函数。 */
function prefixParagraph(text: string): string {
  return text.replace(/^( {0,3})(?=\S)/, "$1【译】");
}

/** 标题在 # 标记后加“【译】”；非标准标题降级为段落处理。纯函数。 */
function prefixHeading(text: string): string {
  if (/^ {0,3}#{1,6}[ \t]+/.test(text)) {
    return text.replace(/^( {0,3}#{1,6}[ \t]+)/, "$1【译】");
  }
  return prefixParagraph(text);
}

/** 列表中每个条目（含任务复选框）的正文前加“【译】”，保留缩进与标记。纯函数。 */
function prefixListItems(text: string): string {
  return text
    .split("\n")
    .map((line) => {
      const match = /^(\s*(?:[-*+]|\d+[.)])[ \t]+(?:\[[ xX]\][ \t]+)?)(\S.*)$/.exec(
        line,
      );
      return match ? `${match[1]}【译】${match[2]}` : line;
    })
    .join("\n");
}

/** 表格每个非分隔行、非空单元格内容的末尾加“（译）”，保留对齐与空白。纯函数。 */
function prefixTableCells(text: string): string {
  return text
    .split("\n")
    .map((line) => {
      if (!line.includes("|") || /^\s*\|?[\s:|-]+\|?\s*$/.test(line)) {
        return line;
      }
      return line
        .split("|")
        .map((cell) => {
          if (!cell.trim() || /^\s*[-:]+\s*$/.test(cell)) {
            return cell;
          }
          const leading = /^\s*/.exec(cell)?.[0] ?? "";
          const trailing = /\s*$/.exec(cell)?.[0] ?? "";
          const core = cell.slice(
            leading.length,
            cell.length - trailing.length,
          );
          return core ? `${leading}${core}（译）${trailing}` : cell;
        })
        .join("|");
    })
    .join("\n");
}

/** 只在引用块的第一行非空内容前加“【译】”，避免多行引用重复标记。纯函数。 */
function prefixBlockquote(text: string): string {
  let prefixed = false;
  return text
    .split("\n")
    .map((line) => {
      if (prefixed) {
        return line;
      }
      const match = /^(\s*>\s?)(.*)$/.exec(line);
      if (match && match[2].trim()) {
        prefixed = true;
        return `${match[1]}【译】${match[2]}`;
      }
      return line;
    })
    .join("\n");
}

/** 按块类型选择降级标记；未知类型按普通段落处理。纯函数。 */
function addFallbackMarker(text: string, kind: BlockKind): string {
  switch (kind) {
    case "heading":
      return prefixHeading(text);
    case "list":
      return prefixListItems(text);
    case "table":
      return prefixTableCells(text);
    case "blockquote":
      return prefixBlockquote(text);
    default:
      return prefixParagraph(text);
  }
}

/**
 * 演示翻译主入口：先做词典/术语替换；若完全没变化且文本含字母，
 * 则退化为结构标记，确保调用方能观察到“已翻译”的差异。纯函数。
 */
function mockTranslate(
  text: string,
  kind: BlockKind,
  glossary: TranslationRequest["glossary"] = [],
): string {
  const translated = translateOutsideProtected(text, glossary);
  if (translated !== text) {
    return translated;
  }
  if (!/[\p{L}]/u.test(text.replace(PROTECTED, ""))) {
    return text;
  }
  return addFallbackMarker(text, kind);
}

// ---- Provider 实现 ----

/**
 * 演示 Provider：同步生成全部译文，不读写外部状态。
 * 始终以一次 onChunk 交付全部结果；onProgress 不触发（参数保留以符合接口）。
 */
export class MockTranslationProvider implements TranslationProvider {
  readonly id = "mock";
  get label(): string {
    return UI_TEXT.providers.mockTranslation;
  }
  readonly supportsSummary = true;
  readonly supportsReview = true;

  /**
   * 生成固定的演示摘要：取前几个非空段落/标题，便于离线验证摘要 UI 与上下文链路。
   * 不调用网络、不执行文档内容。
   */
  async summarize(
    request: SummaryRequest,
    signal?: AbortSignal,
  ): Promise<SummaryResult> {
    if (signal?.aborted) {
      throw new Error(tError("common.translationCancelled"));
    }
    const lines = request.text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(0, 6);
    const summary = [
      "Mock document summary",
      request.title ? `Title: ${request.title}` : "",
      ...lines.map((line) => `- ${line.slice(0, 120)}`),
    ]
      .filter(Boolean)
      .join("\n");
    // 演示术语表：只挑文档中出现的静态词条，便于离线验证“摘要 + 术语表”链路。
    const lower = request.text.toLowerCase();
    const glossary: SummaryResult["glossary"] = [];
    const seen = new Set<string>();
    for (const [source, target] of [...PHRASES, ...WORDS]) {
      if (glossary.length >= 12) {
        break;
      }
      const key = source.toLowerCase();
      if (seen.has(key) || !lower.includes(key)) {
        continue;
      }
      seen.add(key);
      glossary.push({ source, target });
    }
    return {
      summary,
      glossary,
      brief: {
        audience: "Developers and technical writers",
        toneAndStyle: "Concise technical prose with consistent terminology",
        ambiguities: "",
        doNotTranslate: "Keep commands, code, URLs, and file paths unchanged.",
      },
    };
  }

  /** 演示审校：对第一个块返回一条“请人工核对”的批注，不联网。 */
  async review(
    request: ReviewRequest,
    signal?: AbortSignal,
  ): Promise<ReviewAnnotationDraft[]> {
    if (signal?.aborted) {
      throw new Error(tError("common.translationCancelled"));
    }
    const first = request.items[0];
    if (!first) {
      return [];
    }
    return [
      {
        id: first.id,
        side: "target",
        type: "translation-uncertain",
        severity: "check",
        message:
          "Mock review: verify that this wording matches the document brief.",
        question: "Is the register appropriate for the intended audience?",
      },
    ];
  }

  /**
   * 同步生成全部译文并校验。
   * @param signal 已取消时立即 reject；生成过程本身不做中途取消。
   * @param _onProgress 未使用，仅为满足接口。
   * @param onChunk 结果生成后一次性调用；回调抛错会向外 reject。
   * @throws 取消或结果校验失败。
   */
  async translate(
    request: TranslationRequest,
    signal?: AbortSignal,
    _onProgress?: TranslationProgress,
    onChunk?: TranslationChunkHandler,
  ): Promise<TranslationResultItem[]> {
    if (signal?.aborted) {
      throw new Error(tError("common.translationCancelled"));
    }
    const results: TranslationResultItem[] = request.items.map((item) => ({
      id: item.id,
      text: mockTranslate(item.text, item.kind, request.glossary),
    }));
    validateTranslationResult(request.items, results);
    await onChunk?.(results, results.length, request.items.length);
    return results;
  }
}

/** 兼容性类型再导出：允许调用方从本模块取得 TranslationItem。 */
export type { TranslationItem };
