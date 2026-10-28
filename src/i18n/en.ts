/**
 * English UI text catalog (source language for runtime localization).
 *
 * Runtime: src/i18n/index.ts deep-localizes this catalog with vscode.l10n.t. Webviews
 * never import this module directly; the host serializes the localized subsets into
 * `<script type="application/json">` blocks consumed by media/*.js.
 *
 * Structure: keys and `{name}` placeholders must exactly match src/i18n/zh.ts. The
 * build script (scripts/build-l10n.ts) validates both catalogs and generates the
 * l10n bundles used by VS Code.
 *
 * Categories:
 * - extension: commands, input boxes, confirmations, batch operations;
 * - preview: bilingual preview toolbar, block actions, placeholders, modals, error page;
 * - notifications: async operation results shown through messages/toasts;
 * - taskPanel: task view and status bar;
 * - statusBar: status bar entries;
 * - providers/presets: display names for translation services.
 */
export const UI_TEXT = {
  // Extension host: commands, prompts, confirmation dialogs, and batch hints.
  extension: {
    openMarkdownFirst:
      "Open a Markdown or Skill file before running a Markdown Bilingual Sync command.",
    messagePrefix: "Markdown Bilingual Sync: ",
    syncPreparing: "Preparing sync…",
    syncTitleAll: "All blocks retranslated",
    syncTitleStale: "Stale blocks retranslated",
    syncTitleSync: "Sync complete",
    syncSummary:
      "{prefix}: {translated} blocks translated, {copied} blocks copied, {human} blocks kept as locked translations{stale}.",
    syncSummaryStaleSuffix: ", {count} stale blocks kept",
    confirmRetranslateStale:
      "Retranslate {count} stale machine translations? Locked translations will not be overwritten.",
    confirmRetranslateStaleAll:
      "Retranslate all stale machine translations? Locked translations will not be overwritten.",
    confirmRetranslateStaleAction: "Retranslate stale",
    confirmRetranslateAll:
      "Retranslate all machine translations in this file? Locked translations will not be overwritten.",
    confirmRetranslateAllAction: "Retranslate all",
    apiKeyInputTitle: "Set AI translation API key",
    apiKeyInputPrompt:
      "The key is stored per provider in VS Code SecretStorage and is never written to settings, the workspace, or the cache.",
    apiKeyEmpty: "API key cannot be empty.",
    apiKeyTooLong: "API key is too long.",
    apiKeyHintMock:
      "The current provider is Mock. Set markdownBilingualSync.provider to openai or http in Settings.",
    apiKeyHintOpenAI:
      "Run “Test AI Translation Connection” to verify the endpoint, model, and key.",
    apiKeyHintHTTP:
      "Make sure httpEndpoint, httpHeaders, httpBody, and httpResponsePath are configured, then run “Test Connection”.",
    apiKeySaved: "API key saved. {hint}",
    apiKeyTestAction: "Test connection",
    testRequiresProvider:
      "The current provider is Mock. Set markdownBilingualSync.provider to openai or http in Settings first.",
    testProgressTitle: "Test AI translation connection",
    testProgressMessage: "Sending a test request…",
    testSuccess:
      "Translation connection succeeded: {model} · {latency} ms{thinking} · Sample translation: {sample}",
    testThinkingDisabled: " · thinking mode disabled",
    testThinkingEnabled: " · thinking mode enabled",
    noApiKey: "No AI translation API key has been saved.",
    confirmClearApiKey: "Clear the saved AI translation API key?",
    clearApiKeyAction: "Clear key",
    apiKeyCleared: "AI translation API key cleared.",
    confirmClearCache:
      "Clear the translation cache for the current file? Locked translations will also be removed from the cache. This cannot be undone.",
    clearCacheAction: "Clear cache",
    clearCacheMissing: "The current file has no translation cache to clear.",
    clearCacheDone: "Translation cache cleared for the current file.",
    confirmClearAllCaches:
      "Clear all translation caches in this extension? All bilingual translations and locked translations for every file will be deleted. This cannot be undone.",
    clearAllCachesAction: "Clear all",
    clearAllCachesNone:
      "There are no translation caches to clear in extension storage.",
    clearAllCachesDone: "Cleared {count} translation cache files.",
    importPickTitle: "Choose the translated Markdown to import",
    importPickLabel: "Import as locked translations",
    confirmImportOverwrite:
      "This file already has a translation cache. Importing will overwrite all existing cache entries. Continue?",
    confirmImportOverwriteAction: "Overwrite and import",
    batchPickTitle: "Choose a folder for batch processing",
    batchPickLabel: "Choose folder",
    batchTranslateEmpty: "The folder contains no Markdown files to translate.",
    confirmBatchTranslate:
      "Translate {count} Markdown files in the folder? Target-language exports will be skipped and unsaved source files will be saved first. Continue?",
    batchTranslateAction: "Start batch translation",
    batchExportEmpty: "The folder contains no Markdown files to process.",
    confirmBatchExport:
      "Export {count} files ({overwrite} existing target files will be overwritten); {unchanged} unchanged files, {skipped} files without cache, and {failed} files that failed preparation will be skipped. Batch export does not show a diff preview for each file. Continue?",
    batchExportAction: "Start batch export",
    batchExportTitle: "Batch export translations",
    batchExportProgress: "Exporting {current}/{total}: {file}",
    batchExportDone: "Batch export complete: wrote {count} files.",
    batchExportPartial:
      "Batch export complete: {count} succeeded, {failed} failed.",
    batchExportNone:
      "No files to write: {unchanged} unchanged, {skipped} without cache, {failed} failed preparation.",
    batchOpenOutput: "Show output",
    providerPresetTitle: "Choose a translation provider preset",
    providerPresetPlaceholder:
      "The selected provider and endpoint settings will be written to user settings",
    providerPresetApplied: "{name} preset applied.",
    providerPresetTestAction: "Test connection",
    editScopedGlossaryTitle: "Edit glossary",
    glossaryGlobal: "Global glossary",
    glossaryGlobalDescription: "Shared across all workspaces",
    glossaryWorkspace: "Workspace glossary",
    glossaryWorkspaceDescription:
      "Stored as .mbs-glossary.json in the workspace root",
    glossaryNoWorkspace: "Open a folder before editing a workspace glossary.",
  },
  // Bilingual preview: structure is rendered by src/webview/preview/app.tsx; the host
  // serializes this catalog into the Webview UI text JSON.
  preview: {
    titleSuffix: "Bilingual Preview",
    mark: "T",
    kindLabels: {
      heading: "Heading",
      paragraph: "Paragraph",
      list: "List",
      table: "Table",
      blockquote: "Blockquote",
      code: "Code",
      html: "HTML",
      hr: "Horizontal Rule",
      math: "Math",
      footnote: "Footnote",
      other: "Other",
    },
    statusLabels: {
      translated: "Translated",
      stale: "Source updated",
      human: "Translation locked",
      "human-stale": "Translation locked · source updated",
      untranslated: "Untranslated",
      copy: "Copied as-is",
      "copy-stale": "Needs re-copy",
      "copy-pending": "Copy pending",
      deleted: "Translation locked",
    },
    actions: {
      retranslate: "Retranslate",
      resumeTranslate: "Resume translation",
      translate: "Translate this block",
      retranslateTitle: "Retranslate only this block",
      markSynced: "Mark synchronized",
      markSyncedTitle:
        "Accept source changes with the current translation and lock this block",
      revealSource: "Go to source",
      revealSourceTitle: "Locate the source in the editor",
      headingPathTitle: "Heading context",
      editSource: "Edit source",
      editTarget: "Edit translation",
      editSourceTitle: "Click to edit this block's original Markdown",
      editTargetTitle: "Click to edit the translation; saving locks this block",
      readonlyPreview: "Read-only preview",
      exitReadonly: "Exit read-only",
      readonlyPreviewTitle:
        "Hide editing and block actions for a continuous Markdown view",
      exitReadonlyTitle: "Restore per-block editing and actions",
      saveSourceStage: "Stage changes",
      saveTarget: "Save and lock",
      cancelEdit: "Cancel",
      sourcePendingBadge: "Source changes pending",
      applySource: "Apply source changes {count}",
      applySourceTitle: "Review the diff and write back to the source file",
      backTranslate: "Back-translate",
      backTranslateTitle:
        "Translate the target back to the source language and stage it as source changes",
      editHint: "Click content to edit the original Markdown",
      sourceEditHint:
        "After staging, click “Apply source changes” to write the file",
      targetEditHint: "Saving locks this block",
      emptyEdit: "Content cannot be empty.",
      sourceInsertPendingLabel: "Source pending insert",
      sourceDeletePendingLabel: "Source pending delete",
      standaloneSourceEmpty: "No matching source (locked translation).",
      targetOnlyLabel: "Translation locked",
      removeStandalone: "Delete translation",
      removeStandaloneTitle: "Delete this translation block",
      saveStandaloneTarget: "Save translation",
      standaloneEditHint:
        "Saving only affects export and does not modify the source",
      targetInsertHint:
        "Saving adds it to export immediately without modifying the source",
      addStandaloneTarget: "Add to export",
      backTranslateTarget: "Back-translate to source",
      backTranslateTargetTitle:
        "Translate this target back to the source language and stage it as a new source block",
      insertBlock: "Insert",
      insertBlockTitle: "Insert a new block after this block",
      showBlockActions: "Show or hide this block's action buttons",
      insertAtStart: "Insert at start",
      insertAtStartTitle:
        "Insert a new source block at the beginning of the document",
      sourceChoice: "Source",
      targetChoice: "Translation",
      insertTargetTitle: "Insert a new translation block after this block",
      deleteTargetTitle:
        "Delete this translation, keep the anchor, and mark it deleted",
      deleteBlock: "Delete",
      deleteTranslation: "Delete translation",
      deleteSourceBlock: "Delete source block",
      deleteBlockTitle:
        "Mark this source block for deletion and write it back when applied",
      undoDelete: "Undo delete",
      undoDeleteTitle: "Undo the deletion mark on this block",
      removeInsert: "Remove insert",
      removeInsertTitle: "Remove this pending source block",
      insertPlaceholder: "Enter a new Markdown block…",
      stageInsert: "Stage new block",
      resetSource: "Reset staged changes",
      resetSourceTitle:
        "Clear all staged source edits, inserts, and deletions",
    },
    summary: {
      title: "Document brief",
      placeholder:
        "No document brief yet. Click “AI generate” to create a summary, glossary, and optional translation guidance, or write the summary manually.",
      generate: "AI generate",
      generateTitle:
        "Generate a document brief and its document glossary",
      save: "Save brief",
      clear: "Clear brief",
      clearTitle: "Clear the document brief and its glossary",
      glossaryTitle: "Document glossary",
      glossaryCount: "{count} terms",
      glossaryPlaceholder: "One term per line, for example: table => 表格",
      glossaryTableSource: "Source term",
      glossaryTableTarget: "Target term",
      glossaryEditTerm: "Edit term",
      glossaryEditHint:
        "Press Enter to commit this side, Escape to cancel; click the other side to switch.",
      glossaryAdd: "Add term",
      glossaryDelete: "Delete term",
      glossaryFilter: "Filter terms",
      glossaryBulkEdit: "Bulk edit",
      glossaryTableEdit: "Table edit",
      glossaryDuplicate:
        "Duplicate source term; the last entry wins when saved.",
      glossaryInvalid:
        "Each term needs both source and target, up to {max} characters.",
      glossaryTooMany: "At most {max} terms are allowed.",
      glossaryEmpty:
        "No terms yet. Generate a brief to extract terms, or add one manually.",
      glossaryInvalidLines: "Line {lines} is missing =>.",
      glossarySaveBlocked: "Fix the glossary errors before saving.",
      glossaryHint:
        "Generated with the document brief; existing entries are kept when you regenerate. A document term overrides a global/workspace term with the same source.",
      glossaryNeedsSummary:
        "Generate the document brief first to create a document glossary.",
      saveGlossary: "Save glossary",
      briefAdvanced: "Translation guidance (optional)",
      briefFilled: "{count} filled",
      briefAudience: "Audience",
      briefAudiencePlaceholder:
        "For example: backend developers, operators, or end users.",
      briefTone: "Tone and style",
      briefTonePlaceholder:
        "For example: concise technical prose, no marketing language.",
      briefAmbiguities: "Ambiguities and decisions",
      briefAmbiguitiesPlaceholder:
        "For example: “bite” means business impact here, not a literal bite.",
      briefDoNotTranslate: "Do not translate",
      briefDoNotTranslatePlaceholder:
        "For example: product names, commands, file paths, and placeholders.",
      briefHint:
        "This guidance is sent with every request and counts toward the token budget.",
      stale: "Possibly stale",
      tokens: "About {count} tokens",
      generatedAt: "Generated at {time}",
      manual: "Manually edited",
      staleHint:
        "The source has changed; the brief will still be used as context.",
      useSummary: "Use document brief context",
      useSummaryTitle:
        "Works only when a brief exists: the summary and guidance are sent to the AI as document-wide context and count toward each request's token budget.",
      stableTranslation: "Reference previous translation",
      stableTranslationTitle:
        "Stable translation: when retranslating, the block's previous translation is sent to the AI as a revision reference to reduce wording drift from small edits; back-translation references the current source instead. This toggle does not affect document brief generation.",
      unsupported:
        "The current provider does not support automatic generation. Enter a brief manually.",
      noSummary: "Not generated",
      generated: "Generated",
      empty: "Brief cannot be empty.",
    },
    annotations: {
      title: "Annotations",
      openCount: "Annotations ({count})",
      empty: "No annotations for this block yet.",
      review: "Review this block",
      add: "Add annotation",
      placeholder: "Add information or request a change…",
      requestChange: "Request a change",
      save: "Save annotation",
      resolve: "Mark checked",
      reopen: "Reopen",
      dismiss: "Dismiss",
      delete: "Delete",
      retranslate: "Retranslate with annotations",
      ai: "AI review",
      user: "My annotation",
      stale: "The source changed after this annotation was written.",
      reviewHint:
        "AI review only adds notes; it does not rewrite the translation.",
      kindNote: "Note",
      kindRequest: "Change request",
      typeSourceIssue: "Source",
      typeTranslationUncertain: "Uncertain",
      typeTerm: "Term",
      typeStructure: "Structure",
      severityCheck: "Verify",
      severityInfo: "Info",
    },
    placeholders: {
      targetEmpty: "The translation block produced no visible content.",
      copyPending: "Not synchronized yet; the source will be copied as-is.",
      untranslated:
        "Not translated yet. Click “Sync Translation” to generate.",
      skipped:
        "The translation was deleted and will be excluded from sync and export. Click “Resume translation” to restore.",
      sourceEmpty: "This block produces no visible content.",
      noFootnotes: "No footnotes",
      emptyDocument:
        "No blocks to display. Save the file and click “Refresh”.",
    },
    panes: {
      source: "Source",
      target: "Translation",
      sourceFootnotes: "Source footnotes",
      targetFootnotes: "Translation footnotes",
    },
    stats: {
      translated: "Translated",
      stale: "Source updated",
      human: "Translation locked",
      untranslated: "Untranslated",
      copy: "Copy/Math",
      empty: "Empty document",
      total: "{count} blocks total",
    },
    // Export confirmation summary built by ExportService.formatStats.
    exportStats: {
      translated: "Translated",
      stale: "Stale",
      human: "Translation locked",
      copied: "Copied",
      deleted: "Deleted",
      missing: "Missing translation",
      empty: "0 blocks total",
      separator: ", ",
    },
    warnings: {
      summary: "{count} sync notices",
      noCache:
        "No translation cache yet. Run “Translate Current File” to start.",
    },
    toolbar: {
      previewMode: "Preview mode",
      bilingual: "Bilingual",
      sourceOnly: "Source only",
      targetOnly: "Target only",
      sync: "Sync translation",
      importTranslation: "Import translation",
      importTranslationTitle:
        "Import an existing translation and mark it as locked",
      refresh: "Refresh",
      editCache: "Edit cache",
      checkConsistency: "Check",
      checkConsistencyTitle:
        "Check glossary terms and protected Markdown in machine translations",
      reviewMachine: "Review machine translations",
      export: "Export",
      exportDisabledTitle: "Generate a translation cache first",
      openCacheFolder: "Open cache folder",
    moreActions: "More actions",
    },
    subbar: {
      retranslateAll: "Retranslate all",
      retranslateAllTitle:
        "Retranslate all machine translations; locked translations will not be overwritten",
      retranslateStale: "Retranslate stale {count}",
      retranslateStaleTitle:
        "Retranslate all stale machine translations; locked translations will not be overwritten",
      layout: "Diff layout",
      columns: "Side by side",
      stacked: "Stacked",
      split: "Split",
      hint:
        "Changes to the source or cache refresh automatically · Saving a translation cache locks that block · After changing models, click “Retranslate all”",
    },
    footer: {
      phase: "Markdown Bilingual Sync · Phase 3",
      note: "Machine translations are stored in extension global storage; export creates a language-suffixed file next to the source.",
    },
    modal: {
      eyebrow: "Markdown Bilingual Sync",
      title: "Export translations?",
      close: "Close export confirmation",
      destination: "Destination file",
      summary: "Content summary",
      currentFile: "Current file",
      newFile: "Destination file (does not exist yet)",
      exportContent: "Export content",
      warning:
        "There are {count} notices; see the Markdown Bilingual Sync log in the “Output” panel.",
      noteCoarse: "The file is large; the diff is shown per whole block.",
      noteTruncated: "The diff is too long; only the first 1200 lines are shown.",
      emptyDiff: "No diff lines to display.",
      collapsed: "… {count} unchanged lines",
      truncated: "The diff is too long; {count} lines omitted",
      cancel: "Cancel",
      write: "Write file",
      writing: "Writing…",
      exportFailed: "Export failed.",
      staticPreview: "Static preview: action {type} recorded",
    },
    errorPage: {
      title: "Preview failed to load",
      heading: "Unable to load the bilingual preview",
      hint:
        "Check that the file is saved and the language settings are correct, or open the Output panel for details.",
    },
    sourceModal: {
      eyebrow: "Markdown Bilingual Sync",
      title: "Confirm source write-back?",
      close: "Close source confirmation",
      destination: "Destination file",
      summary: "{count} source changes",
      currentFile: "Current source",
      updatedFile: "Updated source",
      cancel: "Not now",
      write: "Write source",
      writeFailed: "Source write-back failed.",
      note:
        "The source file will be saved after writing; machine translations will be marked stale according to source-change rules, and translations corresponding to back-translation will be locked to the new source.",
    },
  },
  // Async operation results shown through toasts or message boxes.
  // Post-translation consistency check (preview toolbar action).
  consistency: {
    title: "Translation consistency check",
    blockItem: "Block {index} · {count} issue(s)",
    glossaryIssue: "Glossary: {source} → {target}",
    protectedIssue: "Protected Markdown: {token}",
    location: "Line {line}",
    noCache:
      "Generate a translation cache before running the consistency check.",
    ok: "No glossary or protected-Markdown issues found.",
    okWithSkipped:
      "No glossary or protected-Markdown issues found in machine translations; {count} locked translation(s) were skipped.",
    retranslateNote:
      "Selecting a block retranslates it. Locked translations are not checked.",
  },
  notifications: {
    exportPreparing: "Preparing export preview…",
    exportUnchanged:
      "Export content matches {destination}; no file was written.",
    exportConfirmCancelled:
      "Content was refreshed and the export confirmation was cancelled. Run export again.",
    exportWriting: "Writing export file…",
    exportWritten: "Exported to {destination}.",
    exportCancelled: "Export cancelled.",
    noPendingExport: "There is no export awaiting confirmation.",
    noStaleTranslations: "There are no stale machine translations.",
    syncBusy: "Syncing translations…",
    retranslateBlockBusy: "Retranslating this block…",
    markSyncedBusy: "Updating sync status…",
    retranslateCancelled: "Retranslation cancelled.",
    confirmRetranslateBlock:
      "Retranslate this block? It already has a translation; any edits to it will be overwritten.",
    confirmRetranslateBlockAction: "Retranslate",
    confirmResumeBlock: "Resume translation for this block?",
    confirmResumeBlockAction: "Resume translation",
    retranslateBlockDone: "This block was retranslated.",
    retranslateBlockSynced: "Translated blocks missing from the cache.",
    confirmMarkSynced:
      "Accept the source change with the current translation and mark this block's translation as locked?",
    confirmMarkSyncedAction: "Mark synchronized",
    markSyncedDone:
      "This block was marked as locked and the current source was accepted.",
    targetSaving: "Saving translation…",
    targetSaved: "Translation saved and this block locked.",
    importing: "Importing translations…",
    importDone:
      "Imported {translated} translation blocks as locked and copied {copied} blocks.",
    targetInserting: "Writing translation block…",
    targetSkipping: "Marking locked…",
    targetSkipped: "Translation deleted; you can undo this.",
    undoDeleting: "Undoing deletion…",
    undoDeleteDone: "Deletion undone.",
    targetEditEmpty: "Translation cannot be empty.",
    standaloneAdded:
      "Translation block added; it will be included in export immediately.",
    standaloneUpdated: "Translation block updated.",
    standaloneRemoved: "Translation block deleted.",
    targetInsertBackTranslating: "Back-translating to source…",
    targetInsertSourceStaged:
      "Source changes staged. Click “Apply source changes” to write the file.",
    targetInsertAttachFailed:
      "Source written, but linking the translation insert block failed: {message}",
    targetInsertMultiBlock:
      "The back-translation contains multiple Markdown blocks and cannot be linked to a single translation block.",
    confirmSkipHuman:
      "This block contains a locked translation. Deleting the translation and locking it will remove the locked content from the cache. Continue?",
    confirmSkipHumanAction: "Delete and lock",
    sourceEditEmpty: "Source block cannot be empty.",
    sourceEditStaged:
      "Source edit staged. Click “Apply source changes” to write the file.",
    sourceDeleted: "This source block was marked for deletion.",
    sourceDeleteUndone: "The deletion mark on this block was removed.",
    sourceInserted: "New source block staged.",
    sourceInsertUpdated: "Pending source block updated.",
    sourceInsertRemoved: "Pending source block removed.",
    sourceBlockDeletedConflict:
      "This block is marked for deletion. Undo the deletion first.",
    sourceBlockChanged:
      "The source block changed while you were editing. Please edit it again.",
    sourceStagedInvalidated:
      "The source file changed, so staged source edits were cleared. Please edit again.",
    pendingSourceBeforeRetranslate:
      "There are staged source changes. Confirm the source write-back first; retranslation continues automatically after it is applied.",
    sourceEditsDiscarded: "Staged source edits discarded.",
    sourceWriting: "Writing source…",
    sourceApplied: "Source changes written and saved.",
    sourceWriteFailed: "Source write-back failed.",
    backTranslating: "Back-translating this block…",
    backCancelled: "Back-translation cancelled.",
    summaryGenerating: "Generating full-document summary…",
    summaryGenerated: "Full-document summary generated.",
    reviewingBlock: "Reviewing this block…",
    reviewCancelled: "Review cancelled.",
    reviewDone: "Review complete: {count} annotation(s).",
    reviewNoIssues: "Review complete: no issues flagged.",
    annotationSaving: "Saving annotation…",
    annotationSaved: "Annotation saved.",
    annotationUpdated: "Annotation updated.",
    annotationDeleted: "Annotation deleted.",
    summaryCancelled: "Summary generation cancelled.",
    summarySaving: "Saving full-document summary…",
    summarySaved: "Full-document summary saved.",
    summaryCleared: "Full-document summary cleared.",
    summaryEmpty: "Summary cannot be empty.",
    glossarySaving: "Saving document glossary…",
    glossarySaved: "Document glossary saved.",
    glossaryInvalidLines:
      "Glossary lines {lines} are invalid. Use one “source => target” entry per line.",
    glossaryTooMany: "The document glossary supports at most {max} entries.",
    backStaged:
      "Back-translation staged as a source change. Click “Apply source changes” to write the file.",
    backSame:
      "The back-translation matches the current source; nothing was staged.",
    backMultiBlock:
      "The back-translation contains multiple Markdown blocks and cannot be staged as a single source block.",
    pairedLockFailed:
      "Source written, but the translation could not be locked to the new source block.",
  },
  // Task view and status bar.
  taskPanel: {
    title: "Translation Tasks",
    empty: "No translation tasks",
    emptyHint: "Tasks appear here after batch translation or sync.",
    activeSection: "Active tasks",
    historySection: "Recently completed",
    overviewTitle: "Batch overview",
    systemTitle: "Runtime status",
    concurrency: "Concurrency {active}/{limit} · waiting {waiting}",
    concurrencyLabel: "Concurrency",
    activeTasksLabel: "Active files",
    activeBlocksLabel: "Active blocks",
    failedBlocksLabel: "Failed blocks",
    providerLabel: "Provider",
    modelLabel: "Model / template",
    tokenBudgetLabel: "Batch budget",
    batchLimitLabel: "Block limit",
    languageSection: "Languages",
    targetLanguageLabel: "Target language",
    sourceLanguageLabel: "Source language",
    targetLanguageTitle:
      "Change the target language for future translations and exports; the options are controlled by the markdownBilingualSync.supportedLanguages setting.",
    sourceLanguageTitle:
      "Choose the source language; the options are controlled by the markdownBilingualSync.supportedLanguages setting.",
    targetLanguageInvalid:
      "Cannot change the target language: “{language}” is not in the supported languages list.",
    targetLanguageSameAsSource:
      "Cannot change the target language: it cannot be the same as the source language “{language}”.",
    targetLanguageUpdateFailed:
      "Failed to change the target language: {message}",
    sourceLanguageInvalid:
      "Cannot change the source language: “{language}” is not in the supported languages list.",
    sourceLanguageSameAsTarget:
      "Cannot change the source language: it cannot be the same as the target language “{language}”.",
    sourceLanguageUpdateFailed:
      "Failed to change the source language: {message}",
    swapLanguagesTitle: "Swap source and target languages",
    swapLanguagesUnavailable:
      "Source and target languages must be valid and different to swap.",
    activeTaskCount: "Tasks: {count}",
    activeTaskBadgeTooltip: "Active translation tasks",
    languageUpdateFailed: "Failed to change languages: {message}",
    openSource: "Open source file",
    progress: "{completed}/{total} blocks",
    noBlocks: "No blocks to translate",
    failedSuffix: " · {failed} blocks failed",
    elapsed: "{duration} elapsed",
    noActive: "No tasks are currently running",
    phases: {
      waiting: "Waiting to start",
      preparing: "Preparing translation…",
      cancelling: "Cancelling…",
      cancelled: "Cancelled",
      partial: "Partially completed",
      completed: "Completed",
      translatingBlocks: "Translating {count} blocks…",
      translatingProgress: "Translating {completed}/{total} blocks…",
    },
    statusLabels: {
      queued: "Queued",
      running: "Running",
      partial: "Partially succeeded",
      success: "Completed",
      failed: "Failed",
      cancelled: "Cancelled",
    },
  },
  statusBar: {
    idle: "Translation Tasks",
    active: "Translating {tasks} · {active}/{limit}",
    failed: "Translation tasks · {failed} failed",
    tooltipTitle: "Translation Tasks",
    tooltipHint: "Click to open the task panel",
    taskLine: "{label}: {status} · {progress}{failed}",
    moreTasks: "… {count} more",
  },
  // Translation service display names shared by providers and the task view.
  providers: {
    mockDemo: "Mock demo",
    mockTranslation: "Mock translation",
    openaiCompatible: "AI translation (OpenAI compatible)",
    customHttp: "AI translation (custom HTTP)",
    customHttpModel: "Custom HTTP",
  },
  // Provider preset quick-pick text; brand names and endpoint addresses stay as-is.
  presets: {
    openaiDescription: "Official API · gpt-4o-mini",
    ollamaLabel: "Ollama (local)",
    ollamaDescription: "127.0.0.1:11434 · qwen2.5:7b",
    lmStudioLabel: "LM Studio (local)",
    lmStudioDescription: "127.0.0.1:1234 · local-model",
    customHttpLabel: "Custom HTTP template",
    customHttpDescription:
      "Keep the current request templates and only switch provider",
    mockLabel: "Mock demo",
    mockDescription: "No network requests; for local demos only",
  },
} as const;

/**
 * 预览页文案子树的只读类型别名。
 * 当前没有模块引用，保留为预览文案的公共类型出口。
 */
export type PreviewText = typeof UI_TEXT.preview;
