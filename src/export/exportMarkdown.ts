/**
 * 导出 Markdown 构建（export/exportMarkdown）
 *
 * 职责：把“原文 + 译文缓存”合成为单语译文文档：按原文块顺序输出，
 * 机器/人工译文取缓存对应块，不可翻译块复制原文，译文锁定块（target）按锚点插到
 * 对应原文之后（`t-<hash>`）、文档开头（`start`）或末尾（找不到原文时）。
 *
 * 关键不变量：
 * - 纯函数：不读写文件、不打日志，所有内容通过 input 传入、通过 result 返回；
 * - 输出顺序稳定：frontmatter -> 开头 target -> 原文块（+ 紧随的 target）-> 末尾 target；
 * - 缓存若含未加锚点的块则整体拒绝（无法确定位置），不做猜测；
 * - 所有统计与警告基于同一次对齐结果，彼此不重复计数。
 *
 * 外部依赖：markdown-it 解析器、segmenter/anchors/align、删除标记与语言/换行工具。
 *
 * 安全边界：输出内容来自本地原文与缓存，按纯文本拼接，不做 HTML/脚本执行；
 * 文件名仅使用 path.basename，避免路径穿越；本模块不负责目标路径选择（在 exportService）。
 */
import * as path from "node:path";
import type { MarkdownIt } from "markdown-it";
import { alignDocument, isHumanAnchoredBlock } from "../markdown/align";
import { parseCacheDocument } from "../markdown/anchors";
import { parseMarkdownDocument } from "../markdown/segmenter";
import type { AnchoredBlock, CacheDocument } from "../markdown/types";
import { normalizeNewlines } from "../util/hash";
import { languageSuffix } from "../util/language";
import { isDeletedMarker } from "../cache/deletedMarker";
import { tError } from "../i18n/errors";

/**
 * 导出统计。各项互斥计数（同一块只归入一类）：
 * translated=最新机器译文，stale=过期机器译文，human=人工/锁定译文，
 * humanStale=原文已变的人工译文，copied=不可翻译块复制，missing=缺译文回退原文，
 * deleted=译文已删除（不写入文件）。
 */
export interface ExportStats {
  translated: number;
  stale: number;
  human: number;
  humanStale: number;
  copied: number;
  missing: number;
  deleted: number;
}

/** 构建输入；cacheText 为空/未提供时输出原文并给出警告。 */
export interface ExportBuildInput {
  md: MarkdownIt;
  sourceText: string;
  cacheText?: string;
}

/** 构建结果；text 以单个 \n 结尾，空文档返回空串。 */
export interface ExportBuildResult {
  text: string;
  stats: ExportStats;
  warnings: string[];
}

// ---- 文件名与空缓存 ----

/**
 * 生成导出文件名：`<原名>.<语言后缀><扩展名>`。
 * 仅保留 .md/.markdown/.mdx 扩展名（大小写不敏感），其他扩展名统一用 .md；
 * 去掉目录部分防止路径穿越。纯函数。
 */
export function buildExportFileName(
  sourcePath: string,
  targetLanguage: string,
): string {
  const suffix = languageSuffix(targetLanguage);
  const extension = path.extname(sourcePath);
  const base = path.basename(sourcePath, extension);
  const safeBase = base && base !== "." && base !== ".." ? base : "document";
  const outputExtension = /^\.(?:md|markdown|mdx)$/i.test(extension)
    ? extension
    : ".md";
  return `${safeBase}.${suffix}${outputExtension}`;
}

/** 无缓存时用于对齐的空缓存文档；字段与 parseCacheDocument 的返回结构一致。纯函数。 */
function emptyCache(): CacheDocument {
  return {
    blocks: [],
    targetBlocks: [],
    untracked: [],
    orphanAnchors: [],
    cleanedText: "",
    warnings: [],
    frontmatter: undefined,
  };
}

// ---- 导出构建 ----

/**
 * 构建单语导出文档。
 *
 * 流程：解析原文/缓存 -> 拒绝未跟踪缓存 -> 对齐 -> 建立 target 锚点索引 ->
 * 顺序输出原文块与对应 target -> 汇总统计与警告。
 *
 * 失败语义：
 * - 缓存含未加锚点的块（untracked）时抛错，避免导出错位；
 * - 其他异常状（孤儿锚点/孤儿译文、过期译文、缺译文、删除块）不阻断导出，
 *   只计入 warnings 并尽量输出可用内容。
 *
 * 副作用：无（纯函数，不读写文件）。@returns 文本、统计与去重后的警告列表。
 */
export function buildExportMarkdown(
  input: ExportBuildInput,
): ExportBuildResult {
  const source = parseMarkdownDocument(input.sourceText, input.md);
  const cache =
    input.cacheText && input.cacheText.trim()
      ? parseCacheDocument(input.cacheText, input.md)
      : undefined;

  if (cache && cache.untracked.length > 0) {
    throw new Error(
      tError("export.untrackedCache"),
    );
  }

  const alignment = alignDocument(source.blocks, cache ?? emptyCache());
  const stats: ExportStats = {
    translated: 0,
    stale: 0,
    human: 0,
    humanStale: 0,
    copied: 0,
    missing: 0,
    deleted: 0,
  };
  const warnings = new Set<string>();

  if (!cache) {
    warnings.add(tError("export.noCacheSameAsSource"));
  } else {
    for (const warning of cache.warnings) {
      warnings.add(warning);
    }
    const humanOrphans = alignment.orphanCaches.filter(
      isHumanAnchoredBlock,
    ).length;
    const machineOrphans = alignment.orphanCaches.length - humanOrphans;
    if (humanOrphans > 0) {
      warnings.add(
        tError("export.humanOrphansWarning", { count: humanOrphans }),
      );
    }
    if (machineOrphans > 0) {
      warnings.add(
        tError("export.machineOrphansWarning", { count: machineOrphans }),
      );
    }
    if (cache.orphanAnchors.length > 0) {
      warnings.add(
        tError("export.orphanAnchorsWarning", { count: cache.orphanAnchors.length }),
      );
    }
  }

  const parts: string[] = [];
  if (source.frontmatter?.raw.trim()) {
    parts.push(source.frontmatter.raw.trim());
  }

  // 译文锁定块（mode=target）按“它锚定在哪段原文之后”建索引：
  // t-<hash> -> 该原文块之后；start（以及无法识别的锚点）-> ""，在文档开头统一输出。
  // 同一 hash 的 target 保持缓存中的相对顺序。
  const targetByHash = new Map<string, AnchoredBlock[]>();
  for (const target of cache?.targetBlocks ?? []) {
    const hash = target.anchor.src.startsWith("t-")
      ? target.anchor.src.slice(2)
      : "";
    const list = targetByHash.get(hash) ?? [];
    list.push(target);
    targetByHash.set(hash, list);
  }
  // 输出某段原文后的 target 并移除桶，保证每批 target 只输出一次；
  // 删除标记只计数不输出。
  const emitTargets = (hash: string): void => {
    const list = targetByHash.get(hash);
    if (!list) {
      return;
    }
    targetByHash.delete(hash);
    for (const target of list) {
      if (isDeletedMarker(target.block.raw)) {
        stats.deleted += 1;
        continue;
      }
      const content = normalizeNewlines(target.block.raw).trim();
      if (content) {
        parts.push(content);
        stats.human += 1;
      }
    }
  };

  // start 锚点的 target 永远在最前面（frontmatter 之后）。
  emitTargets("");
  for (const aligned of alignment.blocks) {
    // 按状态选择输出内容：删除块不输出；不可翻译块复制原文；其余取缓存译文。
    let content = "";
    if (aligned.cache && aligned.status === "deleted") {
      stats.deleted += 1;
    } else if (!aligned.source.translatable) {
      content = aligned.source.raw;
      stats.copied += 1;
    } else if (aligned.cache) {
      content = aligned.cache.block.raw;
      switch (aligned.status) {
        case "translated":
          stats.translated += 1;
          break;
        case "stale":
          stats.stale += 1;
          break;
        case "human":
          stats.human += 1;
          break;
        case "human-stale":
          stats.humanStale += 1;
          break;
        case "untranslated":
          stats.missing += 1;
          break;
        default:
          stats.copied += 1;
          break;
      }
    } else {
      content = aligned.source.raw;
      stats.missing += 1;
    }

    // 块之间统一用两个换行分隔；空内容（删除块）不产生空段落。
    const normalized = normalizeNewlines(content).trim();
    if (normalized) {
      parts.push(normalized);
    }
    // 输出锚定在这段原文之后的 target（同一 hash 只消费一次）。
    emitTargets(aligned.source.hash);
  }

  // 剩余 target 找不到锚定原文：尽量输出到末尾，并给出警告。
  for (const list of targetByHash.values()) {
    for (const target of list) {
      if (isDeletedMarker(target.block.raw)) {
        stats.deleted += 1;
        continue;
      }
      const content = normalizeNewlines(target.block.raw).trim();
      if (content) {
        parts.push(content);
        stats.human += 1;
        warnings.add(
          tError("export.unmatchedTargetAtEnd"),
        );
      }
    }
  }

  // 最终警告汇总：这些状态不阻断导出，但必须让用户在确认页看到。
  if (stats.stale > 0) {
    warnings.add(tError("export.staleWarning", { count: stats.stale }));
  }
  if (stats.humanStale > 0) {
    warnings.add(
      tError("export.humanStaleWarning", { count: stats.humanStale }),
    );
  }
  if (stats.missing > 0 && cache) {
    warnings.add(
      tError("export.missingWarning", { count: stats.missing }),
    );
  }
  if (stats.deleted > 0) {
    warnings.add(
      tError("export.deletedWarning", { count: stats.deleted }),
    );
  }

  return {
    text: parts.length > 0 ? `${parts.join("\n\n")}\n` : "",
    stats,
    warnings: [...warnings],
  };
}
