/**
 * 缓存读写、单块编辑与清理相关错误文案。
 */
import type { ErrorMessage } from "./types";

export const CACHE_ERRORS = [
  {
    key: "cache.localFileOnly",
    en: "Bilingual cache is only supported for files saved to disk.",
    zh: "双语缓存仅支持已保存到磁盘的文件。",
  },
  {
    key: "cache.unsafePath",
    en: "A safe cache path cannot be generated for a file outside the workspace.",
    zh: "无法为工作区之外的文件生成安全的缓存路径。",
  },
  {
    key: "cache.pathEscaped",
    en: "The cache path escaped the extension storage directory.",
    zh: "缓存路径越出了扩展存储目录。",
  },
  {
    key: "cache.dirty",
    en: "The translation cache is being edited with unsaved changes. Save or revert it before syncing.",
    zh: "译文缓存正在编辑且有未保存修改。请先保存或撤销缓存编辑，再执行同步。",
  },
  {
    key: "cache.updateOpenFailed",
    en: "Could not update the open translation cache.",
    zh: "无法更新已打开的译文缓存。",
  },
  {
    key: "cache.saveFailed",
    en: "Failed to save the translation cache.",
    zh: "译文缓存保存失败。",
  },
  {
    key: "cache.openDocuments",
    en: "{count} translation caches are open in editors. Close all cache tabs before clearing.",
    zh: "有 {count} 个译文缓存正在编辑器中打开，请先关闭所有缓存标签页再清除。",
  },
  {
    key: "cache.openBeforeClear",
    en: "The translation cache is open in an editor. Close the cache tab before clearing it.",
    zh: "译文缓存正在编辑器中打开，请先关闭缓存标签页再清理。",
  },
  {
    key: "cache.notGenerated",
    en: "The translation cache has not been generated. Run “Translate Current File” or “Sync Translation” first.",
    zh: "译文缓存尚未生成，请先运行“翻译当前文件”或“同步译文”。",
  },
  {
    key: "cache.untrackedContent",
    en: "The translation cache contains unanchored content. Clean the cache before editing a single block.",
    zh: "译文缓存中存在未加锚点的内容。请先清理缓存，再执行单块操作。",
  },
  {
    key: "cache.anchorLineMissing",
    en: "Could not locate the line containing the translation anchor.",
    zh: "无法定位译文锚点所在的行。",
  },
  {
    key: "cache.emptyTarget",
    en: "The translation is empty and was rejected.",
    zh: "译文为空，已拒绝写入。",
  },
  {
    key: "cache.targetMultiBlock",
    en: "The translation was parsed into multiple blocks. Check for extra blank lines or block structures.",
    zh: "译文被解析成了多个块。请检查译文中是否出现了多余的空行或块级结构。",
  },
  {
    key: "cache.targetMissing",
    en: "Could not locate the translation block in the modified cache.",
    zh: "无法在修改后的缓存中定位该译文块。",
  },
  {
    key: "cache.kindChanged",
    en: "The translation structure changed from {from} to {to}; the write was rejected.",
    zh: "译文结构从 {from} 变成了 {to}，已拒绝写入。",
  },
  {
    key: "cache.unparsable",
    en: "The written translation block could not be parsed again.",
    zh: "写入后的译文块无法重新解析。",
  },
  {
    key: "cache.markSyncedUnparsable",
    en: "The translation block could not be parsed again after marking it synchronized.",
    zh: "标记已同步后无法重新解析该译文块。",
  },
  {
    key: "cache.summaryDuplicate",
    en: "Line {line} contains a duplicate full-document summary marker; the last one was used.",
    zh: "第 {line} 行出现了重复的全文摘要标记，已采用最后一条。",
  },
  {
    key: "cache.summaryInvalid",
    en: "Line {line} contains an invalid full-document summary marker; the line was ignored.",
    zh: "第 {line} 行的全文摘要标记格式无效，已忽略该行。",
  },
  {
    key: "cache.duplicateAnchorId",
    en: "Line {line} contains a duplicate anchor id ({id}); the line was kept as regular content.",
    zh: "第 {line} 行出现重复的锚点 id（{id}），该行已按普通内容保留。",
  },
  {
    key: "cache.invalidAnchorLine",
    en: "Line {line} contains an invalid anchor format; the line was kept as regular content.",
    zh: "第 {line} 行的锚点格式无效，该行已按普通内容保留。",
  },
  {
    key: "cache.anchorKindMismatch",
    en: "Anchor {id} records kind {anchorKind}, but the actual translation block is {blockKind}.",
    zh: "锚点 {id} 记录的类型为 {anchorKind}，实际译文块为 {blockKind}。",
  },
  {
    key: "cache.untrackedBlocks",
    en: "The translation cache has {count} blocks without anchors, marked as untracked content.",
    zh: "译文缓存中有 {count} 个未带锚点的块，已标记为未跟踪内容。",
  },
  {
    key: "cache.orphanAnchors",
    en: "The translation cache has {count} anchors without matching translation blocks.",
    zh: "译文缓存中有 {count} 个锚点找不到对应译文块。",
  },
] as const satisfies readonly ErrorMessage[];
