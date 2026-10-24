/**
 * 中文 UI 文案表（扩展主进程与 Webview 共用的文案来源）。
 *
 * 运行环境：Node / 扩展宿主。本文件被打包进 dist/extension.js；Webview 不能直接 import，
 * 而是由 src/preview/html.ts 与 src/status/taskViewHtml.ts 取出需要的子集，序列化为
 * `<script type="application/json">` 注入页面（见 media/preview.js、media/taskView.js）。
 * 因此这些值必须是纯文本：不含 HTML 标签，也不依赖运行环境。
 *
 * 与扩展主进程的通信：无。本模块只导出常量与纯函数，不调用 vscode API、不访问 DOM。
 *
 * 文本分类：
 * - extension：命令、输入框、确认框、批量操作等扩展宿主侧文案；
 * - preview：双语预览页（工具栏、块操作、占位符、预览内确认弹窗、错误页）；
 * - notifications：同步、编辑、回译、导入导出等异步操作的结果提示；
 * - taskPanel：任务侧边栏视图与状态栏共用的任务相关文案；
 * - statusBar：状态栏条目文案。
 *
 * 插值规则：使用 `{name}` 占位符（只匹配 \w+），由 formatText() 在宿主侧替换，
 * Webview 侧由 media 中同名的 text()/format() 替换。只替换 values 中真实存在的键，
 * 未提供的占位符原样保留；值按 String() 输出且不做 HTML 转义，含用户内容的文案
 * 必须在渲染处单独转义。
 */

/**
 * 按 `{name}` 占位符替换模板中的值。
 *
 * 使用函数式 replace，避免值中的 `$&`、`$1` 等被当作替换模式解释。
 * 未在 values 中提供的占位符保持原样，便于发现漏传参数。
 *
 * @param template 含 `{name}` 占位符的文案。
 * @param values 占位符到字符串/数字的映射。
 * @returns 替换后的文案。
 */
export function formatText(
  template: string,
  values: Record<string, string | number>,
): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) =>
    Object.hasOwn(values, key) ? String(values[key]) : match,
  );
}

/**
 * 全量中文文案。`as const` 让键与值保持只读字面量类型，便于类型推导和防止误赋值；
 * 它只作用于编译期，不会冻结运行时对象，因此仍约定不要修改这个常量。
 */
export const UI_TEXT = {
  // 扩展宿主侧：命令、输入框、确认对话框与批量处理提示。
  extension: {
    openMarkdownFirst:
      "请先打开一个 Markdown 文件，再运行 Markdown Bilingual Sync 命令。",
    syncPreparing: "正在准备同步…",
    syncTitleAll: "全部重译完成",
    syncTitleStale: "批量重译完成",
    syncTitleSync: "同步完成",
    syncSummary:
      "{prefix}：翻译 {translated} 块，复制 {copied} 块，保留译文 {human} 块{stale}。",
    syncSummaryStaleSuffix: "，保留过期 {count} 块",
    confirmRetranslateStale:
      "重新翻译 {count} 个过期的机器译文？译文锁定块不会被覆盖。",
    confirmRetranslateStaleAll:
      "重新翻译所有过期的机器译文？译文锁定块不会被覆盖。",
    confirmRetranslateStaleAction: "重译过期块",
    confirmRetranslateAll:
      "重新翻译当前文件的所有机器译文？译文锁定块不会被覆盖。",
    confirmRetranslateAllAction: "全部重译",
    apiKeyInputTitle: "设置 AI 翻译 API Key",
    apiKeyInputPrompt:
      "密钥按当前 Provider 单独保存在 VS Code SecretStorage 中，不会写入设置、工作区或缓存。",
    apiKeyEmpty: "API Key 不能为空。",
    apiKeyTooLong: "API Key 过长。",
    apiKeyHintMock:
      "当前翻译服务为 Mock，请在设置中将 markdownBilingualSync.provider 改为 openai 或 http。",
    apiKeyHintOpenAI: "建议运行“测试 AI 翻译连接”验证接口、模型与密钥。",
    apiKeyHintHTTP:
      "请确认 httpEndpoint、httpHeaders、httpBody 与 httpResponsePath 已配置，再运行“测试连接”。",
    apiKeySaved: "API Key 已保存。{hint}",
    apiKeyTestAction: "测试连接",
    testRequiresProvider:
      "当前翻译服务为 Mock。请先在设置中将 markdownBilingualSync.provider 改为 openai 或 http。",
    testProgressTitle: "测试 AI 翻译连接",
    testProgressMessage: "正在发送测试请求…",
    testSuccess: "翻译连接成功：{model} · {latency} ms{thinking} · 示例译文：{sample}",
    testThinkingDisabled: " · 已关闭思考模式",
    noApiKey: "尚未保存 AI 翻译 API Key。",
    confirmClearApiKey: "清除已保存的 AI 翻译 API Key？",
    clearApiKeyAction: "清除密钥",
    apiKeyCleared: "已清除 AI 翻译 API Key。",
    confirmClearCache:
      "清理当前文件的译文缓存？清理后译文锁定内容也会从缓存移除，此操作不可撤销。",
    clearCacheAction: "清理缓存",
    clearCacheMissing: "当前文件没有可清理的译文缓存。",
    clearCacheDone: "已清理当前译文缓存。",
    confirmClearAllCaches:
      "清除扩展中的所有译文缓存？所有文件的双语译文和译文锁定内容都会被删除，此操作不可撤销。",
    clearAllCachesAction: "全部清除",
    clearAllCachesNone: "扩展存储中没有可清除的译文缓存。",
    clearAllCachesDone: "已清除 {count} 个译文缓存文件。",
    importPickTitle: "选择要导入的译文 Markdown",
    importPickLabel: "导入为译文锁定",
    confirmImportOverwrite:
      "当前文件已有译文缓存。导入会覆盖全部现有缓存，确定继续？",
    confirmImportOverwriteAction: "覆盖并导入",
    batchPickTitle: "选择要批量处理的目录",
    batchPickLabel: "选择目录",
    batchTranslateEmpty: "目录中没有可翻译的 Markdown 文件。",
    confirmBatchTranslate:
      "将翻译目录中的 {count} 个 Markdown 文件。目标语言导出文件会被跳过，未保存的原文会先保存。继续？",
    batchTranslateAction: "开始批量翻译",
    batchExportEmpty: "目录中没有可处理的 Markdown 文件。",
    confirmBatchExport:
      "将导出 {count} 个文件（其中 {overwrite} 个目标文件已存在，将被覆盖）；{unchanged} 个内容未变化、{skipped} 个无缓存、{failed} 个准备失败会被跳过。批量导出不会逐个显示差异预览。继续？",
    batchExportAction: "开始批量导出",
    batchExportTitle: "批量导出译文",
    batchExportProgress: "正在导出 {current}/{total}：{file}",
    batchExportDone: "批量导出完成：写入 {count} 个文件。",
    batchExportPartial: "批量导出完成：成功 {count} 个，失败 {failed} 个。",
    batchExportNone:
      "没有需要写入的文件：{unchanged} 个未变化，{skipped} 个无缓存，{failed} 个准备失败。",
    batchOpenOutput: "查看输出",
    providerPresetTitle: "选择翻译服务预设",
    providerPresetPlaceholder: "选择后会把 provider 与接口设置写入用户设置",
    providerPresetApplied: "已应用 {name} 预设。",
    providerPresetTestAction: "测试连接",
  },
  // 双语预览页：结构由 src/preview/html.ts 渲染，部分弹窗/编辑器字段再注入 media/preview.js。
  preview: {
    titleSuffix: "双语预览",
    mark: "译",
    // 块类型徽标，键与 markdown/types.ts 的 BlockKind 对齐，通过查表使用。
    kindLabels: {
      heading: "标题",
      paragraph: "段落",
      list: "列表",
      table: "表格",
      blockquote: "引用",
      code: "代码",
      html: "HTML",
      hr: "分隔线",
      math: "公式",
      footnote: "脚注",
      other: "其他",
    },
    // 块级同步状态徽标。键与缓存锚点状态一致；带连字符的键用引号保留。
    statusLabels: {
      translated: "已翻译",
      stale: "原文已更新",
      human: "译文锁定",
      "human-stale": "译文锁定 · 原文已更新",
      untranslated: "未翻译",
      copy: "原样复制",
      "copy-stale": "待重新复制",
      "copy-pending": "待复制",
      deleted: "译文锁定",
    },
    // 块操作、内联编辑器与只读模式的按钮/提示文案（html.ts 与注入 JSON 共同使用）。
    actions: {
      retranslate: "重新翻译",
      resumeTranslate: "恢复翻译",
      translate: "翻译此块",
      retranslateTitle: "仅重新翻译这个块",
      markSynced: "标记已同步",
      markSyncedTitle: "按当前译文接受原文变更，并锁定该块",
      revealSource: "定位原文",
      revealSourceTitle: "在编辑器中定位原文",
      headingPathTitle: "标题上下文",
      editSource: "编辑原文",
      editTarget: "编辑译文",
      editSourceTitle: "点击编辑该块的原始 Markdown",
      editTargetTitle: "点击编辑译文，保存后锁定该块",
      readonlyPreview: "只读预览",
      exitReadonly: "退出只读",
      readonlyPreviewTitle: "隐藏编辑与块级操作，连续渲染整栏 Markdown",
      exitReadonlyTitle: "恢复分块编辑与操作",
      saveSourceStage: "暂存修改",
      saveTarget: "保存并锁定",
      cancelEdit: "取消",
      sourcePendingBadge: "原文待应用",
      applySource: "应用原文修改 {count}",
      applySourceTitle: "查看差异并写回原文文件",
      backTranslate: "回译",
      backTranslateTitle: "把译文翻回原文语言，并暂存为原文修改",
      editHint: "点击内容可编辑原始 Markdown",
      sourceEditHint: "暂存后点击“应用原文修改”写回文件",
      targetEditHint: "保存后锁定该块",
      emptyEdit: "内容不能为空。",
      sourceInsertPendingLabel: "原文待插入",
      sourceDeletePendingLabel: "原文待删除",
      standaloneSourceEmpty: "无对应原文（译文锁定块）。",
      targetOnlyLabel: "译文锁定",
      removeStandalone: "删除译文",
      removeStandaloneTitle: "删除这个译文块",
      saveStandaloneTarget: "保存译文",
      standaloneEditHint: "保存后仅影响导出，不修改原文",
      targetInsertHint: "保存后会立即进入导出，不修改原文",
      addStandaloneTarget: "加入导出",
      backTranslateTarget: "回译生成原文",
      backTranslateTargetTitle: "把该译文翻回原文语言，并暂存为新的原文块",
      insertBlock: "插入",
      insertBlockTitle: "在该块后插入新的块",
      showBlockActions: "显示或隐藏该块的操作按钮",
      insertAtStart: "开头插入",
      insertAtStartTitle: "在文档开头插入新的原文块",
      sourceChoice: "原文",
      targetChoice: "译文",
      insertTargetTitle: "在该块后插入一个新的译文块",
      deleteTargetTitle: "删除该译文，保留锚点并标记为已删除",
      deleteBlock: "删除",
      deleteBlockTitle: "标记删除该原文块，应用后写回文件",
      undoDelete: "撤销删除",
      undoDeleteTitle: "撤销该块的删除标记",
      removeInsert: "移除插入",
      removeInsertTitle: "移除这个待插入的原文块",
      insertPlaceholder: "输入新的 Markdown 块…",
      stageInsert: "暂存新块",
      resetSource: "重置暂存",
      resetSourceTitle: "清除所有暂存的原文修改、插入和删除",
    },
    // 翻译态占位文本：目标块无内容、未翻译、已删除等场景。
    placeholders: {
      targetEmpty: "译文块没有产生可见内容。",
      copyPending: "尚未同步，将按原文原样复制。",
      untranslated: "尚未翻译。点击“同步译文”生成。",
      skipped: "译文已删除，不会参与同步或导出。点击“恢复翻译”可恢复。",
      sourceEmpty: "该块不产生可见内容。",
      noFootnotes: "无脚注",
      emptyDocument: "文档中没有可显示的块。保存文件后点击“刷新”。",
    },
    // 双栏标题与脚注区标题。
    panes: {
      source: "原文",
      target: "译文",
      sourceFootnotes: "原文脚注",
      targetFootnotes: "译文脚注",
    },
    // 顶部统计条；{count} 为块总数。
    stats: {
      translated: "已翻译",
      stale: "原文已更新",
      human: "译文锁定",
      untranslated: "未翻译",
      copy: "复制/公式",
      empty: "空文档",
      total: "共 {count} 块",
    },
    // 同步提示折叠区；noCache 在尚未生成缓存时显示。
    warnings: {
      summary: "{count} 条同步提示",
      noCache: "尚未生成译文缓存。运行“翻译当前文件”开始。",
    },
    // 预览页顶部工具栏与副栏（布局切换、重译入口）。
    toolbar: {
      previewMode: "预览模式",
      bilingual: "双语",
      sourceOnly: "仅原文",
      targetOnly: "仅译文",
      sync: "同步译文",
      importTranslation: "导入译文",
      importTranslationTitle: "导入已有译文并标记为译文锁定",
      refresh: "刷新",
      editCache: "编辑缓存",
      export: "导出",
      exportDisabledTitle: "需要先生成译文缓存",
      openCacheFolder: "打开缓存目录",
    },
    subbar: {
      retranslateAll: "全部重译",
      retranslateAllTitle: "重新翻译所有机器译文，译文锁定块不会被覆盖",
      retranslateStale: "重译过期 {count}",
      retranslateStaleTitle: "重译全部过期的机器译文，译文锁定块不会被覆盖",
      layout: "对照布局",
      columns: "并排",
      stacked: "交错",
      split: "分栏",
      hint: "保存原文或缓存后自动刷新 · 修改译文缓存会在保存后锁定该块 · 更换模型后请点“全部重译”",
    },
    footer: {
      phase: "Markdown Bilingual Sync · Phase 3",
      note: "机器译文保存在扩展全局存储；导出会生成同目录语言后缀文件。",
    },
    // 导出确认模态框；其中静态字段会注入 media/preview.js 的 #mbs-ui-text。
    modal: {
      eyebrow: "Markdown Bilingual Sync",
      title: "确认导出译文？",
      close: "关闭导出确认",
      destination: "目标文件",
      summary: "内容统计",
      currentFile: "当前文件",
      newFile: "目标文件（尚不存在）",
      exportContent: "导出内容",
      warning:
        "有 {count} 条提示，详见“输出”面板中的 Markdown Bilingual Sync 日志。",
      noteCoarse: "文件较大，差异按整段变化显示。",
      noteTruncated: "差异过长，仅显示前 1200 行。",
      emptyDiff: "没有可显示的差异行。",
      collapsed: "… {count} 行未变更",
      truncated: "差异过长，已省略 {count} 行",
      cancel: "取消",
      write: "写入文件",
      writing: "正在写入…",
      exportFailed: "导出失败。",
      staticPreview: "静态预览：已记录动作 {type}",
    },
    // 预览加载失败时替换整页的错误页（renderError 使用）。
    errorPage: {
      title: "预览加载失败",
      heading: "无法加载双语预览",
      hint: "请检查文件是否已保存、语言设置是否正确，或打开输出面板查看详细日志。",
    },
    // 写回原文确认模态框；summary 使用 {count} 处修改。
    sourceModal: {
      eyebrow: "Markdown Bilingual Sync",
      title: "确认写回原文？",
      close: "关闭原文修改确认",
      destination: "目标文件",
      summary: "{count} 处原文修改",
      currentFile: "当前原文",
      updatedFile: "修改后原文",
      cancel: "暂不写入",
      write: "写入原文",
      writeFailed: "写回原文失败。",
      note: "写入后会保存源文件；机器译文按原文变更规则标记为过期，回译对应的译文会锁定到新原文。",
    },
  },
  // 异步操作结果提示：由扩展宿主通过 showToast / showInformationMessage 展示。
  notifications: {
    exportPreparing: "正在准备导出预览…",
    exportUnchanged: "导出内容与 {destination} 一致，未写入文件。",
    exportConfirmCancelled: "内容已刷新，导出确认已取消，请重新执行导出。",
    exportWriting: "正在写入导出文件…",
    exportWritten: "已导出到 {destination}。",
    exportCancelled: "已取消导出。",
    noPendingExport: "没有待确认的导出。",
    noStaleTranslations: "没有过期的机器译文。",
    syncBusy: "正在同步译文…",
    retranslateBlockBusy: "正在重新翻译该块…",
    markSyncedBusy: "正在更新同步状态…",
    retranslateCancelled: "已取消重新翻译。",
    confirmRetranslateBlock:
      "重新翻译这个块？该块已有译文，若包含译文修改将被覆盖。",
    confirmRetranslateBlockAction: "重新翻译",
    confirmResumeBlock: "恢复这个块的翻译？",
    confirmResumeBlockAction: "恢复翻译",
    retranslateBlockDone: "该块已重新翻译。",
    retranslateBlockSynced: "已翻译缓存中缺失的块。",
    confirmMarkSynced: "按当前译文接受原文变更，并将该块标记为译文锁定？",
    confirmMarkSyncedAction: "标记已同步",
    markSyncedDone: "该块已标记为译文锁定，并接受当前原文。",
    targetSaving: "正在保存译文修改…",
    targetSaved: "译文已保存并锁定该块。",
    importing: "正在导入译文…",
    importDone:
      "已导入 {translated} 个译文块并标记为译文锁定，复制 {copied} 个块。",
    targetInserting: "正在写入译文块…",
    targetSkipping: "正在标记锁定…",
    targetSkipped: "已删除译文，可撤销。",
    undoDeleting: "正在撤销删除…",
    undoDeleteDone: "已撤销删除。",
    targetEditEmpty: "译文不能为空。",
    standaloneAdded: "已新增译文块，会立即进入导出。",
    standaloneUpdated: "已更新译文块。",
    standaloneRemoved: "已删除译文块。",
    targetInsertBackTranslating: "正在回译生成原文…",
    targetInsertSourceStaged:
      "原文已暂存，点击“应用原文修改”写回文件。",
    targetInsertAttachFailed:
      "原文已写入，但译文插入块关联失败：{message}",
    targetInsertMultiBlock:
      "回译结果包含多个 Markdown 块，无法自动关联到单个译文块。",
    confirmSkipHuman:
      "该块包含锁定译文。删除译文并锁定后，锁定内容会从缓存中移除，确定继续？",
    confirmSkipHumanAction: "删除并锁定",
    sourceEditEmpty: "原文块不能为空。",
    sourceEditStaged: "原文修改已暂存，点击“应用原文修改”写回文件。",
    sourceDeleted: "已标记删除该原文块。",
    sourceDeleteUndone: "已撤销该块的删除标记。",
    sourceInserted: "已暂存新的原文块。",
    sourceInsertUpdated: "已更新待插入的原文块。",
    sourceInsertRemoved: "已移除待插入的原文块。",
    sourceBlockDeletedConflict: "该块已标记删除，请先撤销删除。",
    sourceStagedInvalidated:
      "源文件已发生变化，暂存的原文修改已清空，请重新编辑。",
    sourceEditsDiscarded: "已放弃暂存的原文修改。",
    sourceWriting: "正在写回原文…",
    sourceApplied: "原文修改已写入并保存。",
    sourceWriteFailed: "写回原文失败。",
    backTranslating: "正在回译该块…",
    backCancelled: "已取消回译。",
    backStaged: "回译结果已暂存为原文修改，点击“应用原文修改”写回文件。",
    backSame: "回译结果与当前原文一致，未暂存修改。",
    backMultiBlock: "回译结果包含多个 Markdown 块，无法暂存为单个原文块。",
    pairedLockFailed: "原文已写入，但无法把译文锁定到新的原文块。",
  },
  // 翻译任务侧边栏与状态栏共用；statusLabels 供任务视图按状态动态查表。
  taskPanel: {
    title: "翻译任务",
    placeholder: "选择任务可打开源文件；使用右上角按钮管理任务",
    empty: "暂无翻译任务",
    emptyHint: "运行批量翻译或同步后会显示在这里。",
    activeSection: "活动任务",
    historySection: "最近完成",
    overviewTitle: "批量总览",
    systemTitle: "运行状态",
    concurrency: "并发 {active}/{limit} · 等待 {waiting}",
    concurrencyLabel: "并发占用",
    activeTasksLabel: "活动文件",
    activeBlocksLabel: "活动块",
    failedBlocksLabel: "失败块",
    providerLabel: "翻译服务",
    modelLabel: "模型 / 模板",
    tokenBudgetLabel: "批次预算",
    batchLimitLabel: "块数上限",
    openOutput: "打开输出日志",
    clearFinished: "清除任务历史",
    cancelAll: "取消全部任务",
    cancelTask: "取消",
    cancelRequested: "已请求取消所有翻译任务。",
    cleared: "已清除完成记录。",
    noTasksToCancel: "没有可取消的任务。",
    openSource: "打开源文件",
    openPreview: "打开双语预览",
    progress: "{completed}/{total} 块",
    noBlocks: "无待翻译块",
    failedSuffix: " · {failed} 块失败",
    elapsed: "耗时 {seconds}s",
    noActive: "当前没有运行中的任务",
    historyEmpty: "暂无历史任务",
    moveHint: "如果视图在左侧，可将“翻译任务”拖到右侧辅助侧边栏，之后会保留布局。",
    statusLabels: {
      queued: "排队中",
      running: "运行中",
      partial: "部分成功",
      success: "完成",
      failed: "失败",
      cancelled: "已取消",
    },
  },
  // 状态栏条目：active 使用 {tasks}/{active}/{limit}，failed 使用 {failed}。
  statusBar: {
    idle: "翻译任务",
    active: "翻译 {tasks} 项 · {active}/{limit}",
    waiting: "翻译任务 · 等待 {waiting}",
    failed: "翻译任务 · {failed} 失败",
    tooltipTitle: "翻译任务",
    tooltipHint: "点击打开任务面板",
  },
} as const;

/**
 * 预览页文案子树的只读类型别名。
 * 当前没有模块引用，保留为预览文案的公共类型出口。
 */
export type PreviewText = typeof UI_TEXT.preview;
