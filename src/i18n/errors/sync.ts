/**
 * 同步、回译、摘要与原文编辑相关错误/警告文案。
 */
import type { ErrorMessage } from "./types";

export const SYNC_ERRORS = [
  {
    key: "sync.missingStableAnchor",
    en: "Block {index} is missing a stable anchor id.",
    zh: "块 {index} 缺少稳定的锚点 id。",
  },
  {
    key: "sync.missingTranslationTask",
    en: "Block {index} has no translation and no translation task was generated.",
    zh: "块 {index} 缺少译文，且未生成翻译任务。",
  },
  {
    key: "sync.blockCountMismatch",
    en: "The number of translation blocks does not match the source; writing stopped.",
    zh: "译文块数量与原文不一致，已停止写入。",
  },
  {
    key: "sync.draftUntrackedBlocks",
    en: "The translation result was parsed as {count} extra blocks. The translation may contain extra blank lines or Markdown structure changes.",
    zh: "翻译结果被解析为 {count} 个额外块。可能是译文中出现了多余的空行或 Markdown 结构变化。",
  },
  {
    key: "sync.draftAnchorMissing",
    en: "Could not locate the translation block for anchor {id} in the draft cache.",
    zh: "无法在草稿缓存中定位锚点 {id} 对应的译文块。",
  },
  {
    key: "sync.missingAnchor",
    en: "Block {index} is missing an anchor id.",
    zh: "块 {index} 缺少锚点 id。",
  },
  {
    key: "sync.invalidSourceLanguage",
    en: "Source language setting “{language}” is not a valid BCP-47 tag (e.g. en, zh-CN).",
    zh: "原文语言设置“{language}”不是有效的 BCP-47 标签（如 en、zh-CN）。",
  },
  {
    key: "sync.invalidTargetLanguage",
    en: "Target language setting “{language}” is not a valid BCP-47 tag (e.g. zh-CN, ja-JP).",
    zh: "译文语言设置“{language}”不是有效的 BCP-47 标签（如 zh-CN、ja-JP）。",
  },
  {
    key: "sync.sameLanguage",
    en: "Source and target languages are the same. Update the targetLanguage setting.",
    zh: "原文语言与译文语言相同，请修改 targetLanguage 设置。",
  },
  {
    key: "sync.localFileOnly",
    en: "Only local Markdown / Skill files are supported. Save the file to disk first.",
    zh: "仅支持本地的 Markdown / Skill 文件。请先保存文件到磁盘。",
  },
  {
    key: "sync.savePrompt",
    en: "“{file}” has unsaved changes. The source must be saved before {purpose}.",
    zh: "“{file}”有未保存的修改。{purpose}前需要先保存原文。",
  },
  {
    key: "sync.saveAndPurpose",
    en: "Save and start {purpose}",
    zh: "保存并{purpose}",
  },
  {
    key: "sync.saveSourceFailed",
    en: "The source could not be saved; {purpose} was skipped.",
    zh: "保存原文失败，未执行{purpose}。",
  },
  {
    key: "sync.purposeSync",
    en: "syncing",
    zh: "同步",
  },
  {
    key: "sync.purposeExport",
    en: "exporting",
    zh: "导出",
  },
  {
    key: "sync.purposeGenerateSummary",
    en: "generating a summary",
    zh: "生成摘要",
  },
  {
    key: "sync.purposeSaveSummary",
    en: "saving the summary",
    zh: "保存摘要",
  },
  {
    key: "sync.purposeSaveGlossary",
    en: "saving the document glossary",
    zh: "保存文档术语表",
  },
  {
    key: "sync.purposeReview",
    en: "reviewing this block",
    zh: "审校该块",
  },
  {
    key: "sync.purposeImport",
    en: "importing the translation",
    zh: "导入译文",
  },
  {
    key: "sync.blockNotTranslatable",
    en: "This block is not translated (code, math, footnote, or structural block).",
    zh: "这个块不参与翻译（代码、公式、脚注或结构块）。",
  },
  {
    key: "sync.blockLockedRetranslate",
    en: "This translation is locked and was not retranslated. Edit it manually instead.",
    zh: "该译文已锁定，未执行重译。请手动编辑该块。",
  },
  {
    key: "sync.noTranslationSyncFirst",
    en: "This block has no translation yet. Sync the translation first.",
    zh: "这个块还没有译文，请先同步译文。",
  },
  {
    key: "sync.noTranslationReview",
    en: "Sync this block before reviewing it.",
    zh: "请先生成该块的译文，再审校。",
  },
  {
    key: "sync.annotationNotFound",
    en: "The annotation no longer exists. Refresh the preview.",
    zh: "批注已不存在，请刷新预览。",
  },
  {
    key: "sync.annotationEmpty",
    en: "The annotation cannot be empty.",
    zh: "批注不能为空。",
  },
  {
    key: "sync.sourceUpdatedRefresh",
    en: "The source has been updated. Refresh the preview and edit the translation again.",
    zh: "原文已更新，请刷新预览后重新编辑译文。",
  },
  {
    key: "sync.translationChangedRefresh",
    en: "The translation block has changed. Refresh the preview and edit again.",
    zh: "译文块已变化，请刷新预览后重新编辑。",
  },
  {
    key: "sync.translationUpdatedRefresh",
    en: "This block's translation has been updated. Refresh the preview and edit again.",
    zh: "该块译文已更新，请刷新预览后重新编辑。",
  },
  {
    key: "sync.cacheMissingBackTranslate",
    en: "The translation cache does not exist, so it cannot be back-translated.",
    zh: "译文缓存不存在，无法回译。",
  },
  {
    key: "sync.sameLanguageBack",
    en: "Source and target languages are the same, so back-translation is unavailable.",
    zh: "原文语言与译文语言相同，无法回译。",
  },
  {
    key: "sync.noTranslationBack",
    en: "This block has no translation yet, so it cannot be back-translated.",
    zh: "这个块还没有译文，无法回译。",
  },
  {
    key: "sync.backEmpty",
    en: "The back-translation is empty.",
    zh: "回译结果为空。",
  },
  {
    key: "sync.summaryUnsupported",
    en: "The current provider does not support automatic full-document summaries. Enter a summary manually in the preview, or switch to an OpenAI-compatible provider.",
    zh: "当前翻译服务不支持自动生成全文摘要，请在预览中手动填写，或切换到 OpenAI 兼容服务。",
  },
  {
    key: "sync.sourceEmptySummary",
    en: "The source is empty, so a summary cannot be generated.",
    zh: "原文为空，无法生成摘要。",
  },
  {
    key: "sync.summaryTooLongInput",
    en: "The source exceeds the summary input limit (about {tokens} tokens). Enter a summary manually or split the document.",
    zh: "原文超过摘要输入上限（约 {tokens} tokens），请手动填写摘要或拆分文档。",
  },
  {
    key: "sync.aiEmptySummary",
    en: "The AI returned an empty summary. Retry or fill it in manually.",
    zh: "AI 返回了空摘要，请重试或手动填写。",
  },
  {
    key: "sync.summaryEmpty",
    en: "The summary cannot be empty.",
    zh: "摘要不能为空。",
  },
  {
    key: "sync.summaryUntrackedCache",
    en: "The translation cache contains unanchored content. Clean it up before saving a summary.",
    zh: "译文缓存中存在未加锚点的内容，请先清理后再保存摘要。",
  },
  {
    key: "sync.summaryOrphanAnchor",
    en: "The translation cache contains anchors without matching translation blocks. Clean it up before saving a summary.",
    zh: "译文缓存中存在找不到译文块的锚点，请先清理后再保存摘要。",
  },
  {
    key: "sync.summaryTooLong",
    en: "The summary is too long (over {chars} characters). Shorten it before saving.",
    zh: "摘要过长（超过 {chars} 字符），请精简后再保存。",
  },
  {
    key: "sync.glossaryNoSummary",
    en: "Generate the full-document summary before editing its glossary.",
    zh: "请先生成全文摘要，再编辑文档术语表。",
  },
  {
    key: "sync.cacheMissingLink",
    en: "The translation cache does not exist, so the translation insert cannot be linked.",
    zh: "译文缓存不存在，无法关联译文插入块。",
  },
  {
    key: "sync.backMultiBlock",
    en: "The back-translation contains multiple Markdown blocks and cannot be linked to a single translation block.",
    zh: "回译结果包含多个 Markdown 块，无法自动关联到单个译文块。",
  },
  {
    key: "sync.backSourceMissingLink",
    en: "The source block generated by back-translation was not found, so the translation insert cannot be linked.",
    zh: "找不到回译生成的原文块，无法关联译文插入块。",
  },
  {
    key: "sync.backSourceAlreadyTranslated",
    en: "The source block generated by back-translation already has a translation and cannot be linked again.",
    zh: "回译生成的原文块已经有译文，无法重复关联。",
  },
  {
    key: "sync.emptyTargetBlock",
    en: "The translation block cannot be empty.",
    zh: "译文块不能为空。",
  },
  {
    key: "sync.cacheUntrackedForTargetInsert",
    en: "The translation cache contains unanchored content, so a translation block cannot be inserted.",
    zh: "译文缓存中存在未加锚点的内容，无法插入译文块。",
  },
  {
    key: "sync.targetMissing",
    en: "This translation block no longer exists.",
    zh: "这个译文块已不存在。",
  },
  {
    key: "sync.targetMissingOrLinked",
    en: "This translation block no longer exists or is already linked to a source.",
    zh: "这个译文块已不存在或已经关联原文。",
  },
  {
    key: "sync.backNotSingleBlock",
    en: "The source generated by back-translation is not a single Markdown block and cannot be linked.",
    zh: "回译生成的原文不是单个 Markdown 块，无法关联。",
  },
  {
    key: "sync.backSourceMissing",
    en: "The source block generated by back-translation was not found, so the translation cannot be linked.",
    zh: "找不到回译生成的原文块，无法关联译文。",
  },
  {
    key: "sync.backNotSingleBlockForTarget",
    en: "The source generated by back-translation is not a single Markdown block and cannot be linked to the translation.",
    zh: "回译生成的原文不是单个 Markdown 块，无法关联译文。",
  },
  {
    key: "sync.cacheMissingMarkSynced",
    en: "The translation cache does not exist, so the block cannot be marked synchronized.",
    zh: "译文缓存不存在，无法标记已同步。",
  },
  {
    key: "sync.noTranslationMarkSynced",
    en: "This block has no translation, so it cannot be marked synchronized.",
    zh: "这个块还没有译文，无法标记已同步。",
  },
  {
    key: "sync.importSameFile",
    en: "The source file itself cannot be imported as a translation.",
    zh: "不能把原文文件本身导入为译文。",
  },
  {
    key: "sync.importTooLarge",
    en: "The translation file exceeds 10 MB and was rejected.",
    zh: "译文文件超过 10 MB，已拒绝导入。",
  },
  {
    key: "sync.clearAllBusy",
    en: "A sync or import task is running. Try clearing all caches again later.",
    zh: "有同步或导入任务正在进行，请稍后再清除所有缓存。",
  },
  {
    key: "sync.clearingCacheBusy",
    en: "All caches are being cleared. Try again shortly.",
    zh: "正在清除所有缓存，请稍候。",
  },
  {
    key: "sync.clearingCacheBusyOp",
    en: "All caches are being cleared. Try this operation again later.",
    zh: "正在清除所有缓存，请稍后再执行此操作。",
  },
  {
    key: "sync.fileSyncBusy",
    en: "A sync task is already running for this file. Try again shortly.",
    zh: "这个文件已有同步任务正在进行，请稍候。",
  },
  {
    key: "sync.protocolRelativeLink",
    en: "Protocol-relative and network-share links are not supported for security reasons.",
    zh: "出于安全考虑，不支持协议相对或网络共享链接。",
  },
  {
    key: "sync.invalidLink",
    en: "This link cannot be parsed.",
    zh: "无法解析这个链接。",
  },
  {
    key: "sync.unsupportedLinkScheme",
    en: "Opening {scheme}: links is not supported for security reasons.",
    zh: "出于安全考虑，不支持打开 {scheme}: 链接。",
  },
  {
    key: "sync.linkNotLocalFile",
    en: "The link target is not a local file.",
    zh: "链接目标不是本地文件。",
  },
  {
    key: "sync.alignOrphanCaches",
    en: "{count} translation blocks could not be matched to the current source.",
    zh: "有 {count} 个译文块无法对应到当前原文。",
  },
  {
    key: "sync.alignUntrackedCache",
    en: "The translation cache has {count} untracked blocks; resolve them before a full sync.",
    zh: "译文缓存中有 {count} 个未跟踪块，全量同步前需要先处理。",
  },
  {
    key: "sync.untrackedCacheWarning",
    en: "The translation cache contains {count} unanchored blocks. Remove them from the cache or confirm their origin, then retry.",
    zh: "译文缓存中有 {count} 个未加锚点的块。请先在缓存中删除这些内容或确认来源后重试。",
  },
  {
    key: "sync.humanOrphanWarning",
    en: "There are {count} locked translation blocks without matching sources (anchors: {ids}). To avoid losing locked translations, sync was stopped.",
    zh: "有 {count} 个译文锁定块找不到对应原文（锚点：{ids}）。为避免丢失锁定译文内容，已停止同步。",
  },
  {
    key: "sync.droppedOrphanAnchors",
    en: "Dropped {count} machine-translation anchors that could not be matched.",
    zh: "已丢弃 {count} 个无法对应的机器译文锚点。",
  },
  {
    key: "sync.staleKept",
    en: "The source of block {index} changed; the old machine translation was kept according to the current settings.",
    zh: "块 {index} 的原文已变更，按当前设置保留了旧机器译文。",
  },
  {
    key: "sync.kindChangedWarning",
    en: "The Markdown type of block {index} changed from {from} to {to}. Check the translation structure.",
    zh: "块 {index} 的 Markdown 类型从 {from} 变为 {to}，请检查译文结构。",
  },
  {
    key: "sync.partialWriteFailed",
    en: "Failed to write some translations: {message}",
    zh: "写入部分译文失败：{message}",
  },
  {
    key: "sync.providerIncomplete",
    en: "Translation did not complete: {message}",
    zh: "翻译未全部完成：{message}",
  },
  {
    key: "sync.blocksFailed",
    en: "{count} blocks failed to translate; other translations were kept, and missing blocks will be retried on the next sync.",
    zh: "有 {count} 个块翻译失败，已保留其余译文；下次同步会重试缺失块。",
  },
] as const satisfies readonly ErrorMessage[];
