/**
 * 导入已有译文相关错误文案。
 */
import type { ErrorMessage } from "./types";

export const IMPORT_ERRORS = [
  {
    key: "import.cacheFile",
    en: "The selected file contains extension anchors and looks like a translation cache. Choose a translated Markdown file without anchors.",
    zh: "选择的文件包含扩展锚点，看起来是译文缓存文件。请选择不含锚点的译文 Markdown。",
  },
  {
    key: "import.noSourceBlocks",
    en: "The source has no blocks that can be imported.",
    zh: "原文没有可导入的块。",
  },
  {
    key: "import.blockCountMismatch",
    en: "The source has {sourceCount} top-level blocks and the translation file has {targetCount}. Import requires matching structures to avoid misalignment.",
    zh: "原文有 {sourceCount} 个顶层块，译文文件有 {targetCount} 个。导入要求两边结构一致，以避免译文错位。",
  },
  {
    key: "import.kindMismatch",
    en: "Block {index} has a different structure: source is {sourceKind}, translation is {targetKind}. Import requires matching structure for every block.",
    zh: "第 {index} 个块结构不一致：原文是{sourceKind}，译文是{targetKind}。导入要求结构逐块一致。",
  },
  {
    key: "import.emptyBlock",
    en: "The translation for block {index} is empty and cannot be imported.",
    zh: "第 {index} 个块的译文为空，无法导入。",
  },
  {
    key: "import.invalidCacheStructure",
    en: "The imported cache failed structural validation and nothing was written. Check the Markdown structure of the translation file.",
    zh: "导入后的缓存结构校验失败，未写入任何内容。请检查译文文件的 Markdown 结构。",
  },
] as const satisfies readonly ErrorMessage[];
