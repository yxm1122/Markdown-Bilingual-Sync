/**
 * 导入已有译文（import/importTranslation）
 *
 * 职责：把用户选择的“纯译文 Markdown”与当前原文按顶层块逐一对齐，
 * 生成带锚点的缓存文本；可翻译块标记为 human（锁定，后续同步不覆盖），
 * 不可翻译块标记为 copy 并保留原文。
 *
 * 关键不变量：
 * - 只接受结构完全一致的译文：顶层块数与每块 kind 必须一一对应，否则整体拒绝；
 * - 传入的译文文件不得含本扩展锚点（避免把缓存当译文重复导入）；
 * - 生成的缓存必须能被 parseCacheDocument 完整还原（无未跟踪块/孤儿锚点/额外 target），
 *   否则不返回任何内容；
 * - 纯函数：不读写文件、不修改输入，失败只抛 ImportTranslationError。
 *
 * 外部依赖：markdown-it 解析器、segmenter/anchors、sync 的缓存序列化、hash/text 工具。
 *
 * 安全边界：内容来自用户选择的本地文件；按纯文本写入缓存，不执行 HTML/脚本；
 * 不访问网络、不写磁盘（落盘由调用方完成）。
 */
import type { MarkdownIt } from "markdown-it";
import { UI_TEXT } from "../i18n/zh";
import { parseCacheDocument } from "../markdown/anchors";
import { parseMarkdownDocument } from "../markdown/segmenter";
import type { BlockAnchor } from "../markdown/types";
import {
  serializeCacheDocument,
  type CacheEntry,
} from "../sync/sync";
import { normalizeBlockContent } from "../util/text";
import { blockHash, newBlockId } from "../util/hash";

/** 导入结果：可直接写入缓存文件的文本与两类块计数（仅用于提示）。 */
export interface ImportTranslationResult {
  cacheText: string;
  /** 可翻译且已标记为 human 的块数。 */
  translatedCount: number;
  /** 不可翻译、按 copy 复制的块数。 */
  copiedCount: number;
}

/** 导入专用业务错误；消息可直接展示给用户。 */
export class ImportTranslationError extends Error {
  /** 构造可直接展示给用户的导入错误。 */
  constructor(message: string) {
    super(message);
    this.name = "ImportTranslationError";
  }
}

/** 把块类型转为中文标签，用于结构不一致的错误提示。纯函数。 */
function kindLabel(kind: BlockAnchor["kind"]): string {
  return UI_TEXT.preview.kindLabels[kind];
}

// ---- 构建导入缓存 ----

/**
 * 由原文与译文 Markdown 构建缓存文本。
 *
 * 结构校验：
 * 1) 译文不得含 `<!-- mbs:` 锚点；
 * 2) 原文至少有一个顶层块；
 * 3) 两边顶层块数量相等，且逐块 kind 相同。
 *
 * 对每个可翻译块：内容取译文（去掉首尾空行/尾随空白），锚点 mode="human"，
 * src=原文 hash、dst=译文内容 hash；不可翻译块复制原文，mode="copy"。
 * 最后重新解析生成的缓存，确认无未跟踪块、无孤儿锚点、无 target 块、块数一致。
 *
 * @returns 缓存文本与块计数。
 * @throws ImportTranslationError（含具体第几块）——此时不返回任何缓存内容。
 */
export function buildImportedCache(
  sourceText: string,
  translationText: string,
  md: MarkdownIt,
): ImportTranslationResult {
  if (translationText.includes("<!-- mbs:")) {
    throw new ImportTranslationError(
      "选择的文件包含扩展锚点，看起来是译文缓存文件。请选择不含锚点的译文 Markdown。",
    );
  }

  const source = parseMarkdownDocument(sourceText, md);
  const translation = parseMarkdownDocument(translationText, md);
  if (source.blocks.length === 0) {
    throw new ImportTranslationError("原文没有可导入的块。");
  }
  // 块数必须一致：少一块/多一块都会让后续按位置对齐发生错位。
  if (translation.blocks.length !== source.blocks.length) {
    throw new ImportTranslationError(
      `原文有 ${source.blocks.length} 个顶层块，译文文件有 ${translation.blocks.length} 个。导入要求两边结构一致，以避免译文错位。`,
    );
  }

  const entries: CacheEntry[] = [];
  let translatedCount = 0;
  let copiedCount = 0;
  for (let index = 0; index < source.blocks.length; index += 1) {
    const sourceBlock = source.blocks[index];
    const targetBlock = translation.blocks[index];
    // kind 一致是最低结构保证（标题级别、列表项数等更细的差异本函数不校验）。
    if (sourceBlock.kind !== targetBlock.kind) {
      throw new ImportTranslationError(
        `第 ${index + 1} 个块结构不一致：原文是${kindLabel(sourceBlock.kind)}，译文是${kindLabel(targetBlock.kind)}。导入要求结构逐块一致。`,
      );
    }

    // 可翻译块取译文；不可翻译块（代码/公式等）保留原文，避免把译文内容塞进代码块。
    const content = sourceBlock.translatable
      ? normalizeBlockContent(targetBlock.raw)
      : normalizeBlockContent(sourceBlock.raw);
    if (!content) {
      throw new ImportTranslationError(
        `第 ${index + 1} 个块的译文为空，无法导入。`,
      );
    }
    if (sourceBlock.translatable) {
      translatedCount += 1;
    } else {
      copiedCount += 1;
    }
    entries.push({
      anchor: {
        id: newBlockId(),
        kind: sourceBlock.kind,
        src: sourceBlock.hash,
        dst: blockHash(sourceBlock.kind, content),
        mode: sourceBlock.translatable ? "human" : "copy",
      },
      content,
    });
  }

  const cacheText = serializeCacheDocument(source.frontmatter, entries);
  const parsed = parseCacheDocument(cacheText, md);
  if (
    parsed.untracked.length > 0 ||
    parsed.orphanAnchors.length > 0 ||
    parsed.blocks.length !== source.blocks.length ||
    parsed.targetBlocks.length > 0
  ) {
    throw new ImportTranslationError(
      "导入后的缓存结构校验失败，未写入任何内容。请检查译文文件的 Markdown 结构。",
    );
  }

  return { cacheText, translatedCount, copiedCount };
}
