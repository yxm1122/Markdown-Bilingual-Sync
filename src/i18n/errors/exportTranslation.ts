/**
 * 导出预览、写入与文件状态相关错误文案。
 */
import type { ErrorMessage } from "./types";

export const EXPORT_ERRORS = [
  {
    key: "export.untrackedCache",
    en: "The translation cache contains unanchored content, so export positions cannot be determined. Fix the cache before exporting.",
    zh: "译文缓存中存在未加锚点的内容，无法确定导出位置。请先修复缓存后再导出。",
  },
  {
    key: "export.noCache",
    en: "No translation cache has been generated. Run “Translate Current File” or “Sync Translation” first.",
    zh: "尚未生成译文缓存，请先运行“翻译当前文件”或“同步译文”。",
  },
  {
    key: "export.empty",
    en: "The export content is empty; no file was written.",
    zh: "导出内容为空，未写入文件。",
  },
  {
    key: "export.sameAsSource",
    en: "The export path is the same as the current source; export stopped.",
    zh: "导出路径与当前原文相同，已停止导出。",
  },
  {
    key: "export.targetDirty",
    en: "The export target is open with unsaved changes. Save or close it before exporting.",
    zh: "导出目标正在编辑且有未保存修改。请先保存或关闭该文件，再执行导出。",
  },
  {
    key: "export.changedDuringConfirmation",
    en: "The export target changed while the confirmation was open. Cancel this export and generate the diff preview again.",
    zh: "导出目标在确认期间已被修改。请取消本次导出并重新生成差异预览。",
  },
  {
    key: "export.targetDirtyStop",
    en: "The export target is open with unsaved changes; writing stopped.",
    zh: "导出目标正在编辑且有未保存修改，已停止写入。",
  },
  {
    key: "export.updateOpenFailed",
    en: "Could not update the open export file.",
    zh: "无法更新已打开的导出文件。",
  },
  {
    key: "export.saveFailed",
    en: "Failed to save the export file.",
    zh: "导出文件保存失败。",
  },
  {
    key: "export.noCacheSameAsSource",
    en: "No translation cache has been generated; the export content is the same as the source.",
    zh: "尚未生成译文缓存，导出内容与原文相同。",
  },
  {
    key: "export.humanOrphansWarning",
    en: "{count} locked translation blocks have no matching source and were not included in the export.",
    zh: "有 {count} 个译文锁定块无法对应原文，未写入导出文件。",
  },
  {
    key: "export.machineOrphansWarning",
    en: "{count} machine-translation blocks have no matching source and were not included in the export.",
    zh: "有 {count} 个机器译文块无法对应原文，未写入导出文件。",
  },
  {
    key: "export.orphanAnchorsWarning",
    en: "{count} translation anchors have no matching content and were ignored.",
    zh: "有 {count} 个译文锚点没有对应内容，已忽略。",
  },
  {
    key: "export.unmatchedTargetAtEnd",
    en: "A translation block has no anchored source block and was placed at the end of the export.",
    zh: "有译文块找不到锚定的原文块，已放在导出文件末尾。",
  },
  {
    key: "export.staleWarning",
    en: "{count} blocks use stale machine translations.",
    zh: "有 {count} 个块使用过期的机器译文。",
  },
  {
    key: "export.humanStaleWarning",
    en: "{count} locked translation blocks have updated sources; the current translations were exported.",
    zh: "有 {count} 个译文锁定块对应的原文已更新，导出的是当前译文。",
  },
  {
    key: "export.missingWarning",
    en: "{count} blocks have no translation; the source text was kept.",
    zh: "有 {count} 个块缺少译文，已保留原文。",
  },
  {
    key: "export.deletedWarning",
    en: "The translations of {count} blocks were deleted and were not written to the export.",
    zh: "有 {count} 个块译文已删除，未写入导出文件。",
  },
] as const satisfies readonly ErrorMessage[];
