# Markdown Bilingual Sync

[![CI](https://github.com/yxm1122/Markdown-Bilingual-Sync/actions/workflows/ci.yml/badge.svg)](https://github.com/yxm1122/Markdown-Bilingual-Sync/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://github.com/yxm1122/Markdown-Bilingual-Sync/blob/main/LICENSE)

[中文](README.md) | English

Translate Markdown inside VS Code and read it as a bilingual preview. The source text stays the single source of truth, and translations you edit by hand are locked so they are never silently overwritten.

Current version **0.14.0** adds the document brief (summary, translation guidance, and document glossary), neighboring-block context for single-block retranslation/back-translation, AI review and user annotations, annotation-guided retranslation, and a 17-case translation-quality evaluation set. Glossary terms use content-sized cards with per-side hover reveal and inline editing. Annotations stay in a local sidecar, review results are revalidated before saving, and stale annotations are never sent as retranslation instructions. The 0.12.0 localization work (English by default, zh-cn built in) is included.

## Features

- **Blocks as translation units.** Translation works on top-level semantic blocks: headings, paragraphs, complete list sections, whole tables, whole blockquotes, and footnote definitions.
- **Protected syntax.** Inline code, URLs, and footnote labels are restored before a cache write if the model rewrites them. Footnote definitions are translated while keeping their `[^id]` labels.
- **Bilingual preview.** Side-by-side, stacked, and a true split layout. The split layout gives the source and the translation independent scrolling panes with block-level scroll sync. Renders GFM, syntax highlighting, KaTeX, footnotes, and GitHub Alerts.
- **Any Markdown-like language ID.** Works with the standard Markdown language ID and with environment-specific IDs such as `skill` from Qoder; the file content stays Markdown.
- **Swappable translation service.** OpenAI-compatible endpoints or any custom HTTP service, with built-in presets for common providers. API keys are stored only in VS Code SecretStorage.
- **Import existing translations.** Imports are validated and aligned against the top-level block structure and marked as locked translations. Start from the preview toolbar or the Command Palette.
- **Cache maintenance.** Clear the cache for the current file, or remove every translation cache from extension storage in one step.
- **Batch processing.** Folder translation packs blocks into batches by token budget, with one concurrency limit shared by files and in-file batches. Successful batches survive failures, and existing caches can be exported in bulk.
- **Translation Tasks view.** A status bar button toggles a native TreeView showing the batch overview, active tasks, recent completions, and runtime status. Task rows can open the source file, open the preview, or cancel; the view title's **Change Languages** action uses a native QuickPick to switch or swap source/target languages.
- **Batch translation and incremental sync.** Saving the source only marks translations as stale; translation requests are made only by explicit commands.
- **Translation lock.** After you edit and save a translation in the cache, that block is protected from automatic retranslation.
- **In-preview editing.** Click source or translation content to edit the underlying Markdown in place. A saved translation is locked immediately; source edits can be staged, reviewed as a diff, and then written back.
- **Back-translate to rewrite the source.** Back-translating a block sends the result straight to source staging. Writing it back locks the translation to the new source so sync cannot overwrite it.
- **Stable translation.** Retranslation references the previous translation and back-translation references the current source, which reduces wording drift after small edits. Controlled by a setting and a preview toggle.
- **Document brief and document glossary.** Manually generate a source-language summary, translation guidance (audience, tone, ambiguities, do-not-translate), and a document glossary. They are stored with the translation cache and can be edited or cleared in the preview.
- **Block annotations and review.** AI review returns notes that may need human verification; it never rewrites the translation. You can add notes, mark a change request, and retranslate with those annotations. Annotations live in a local sidecar, not in the cache Markdown or exports.
- Retranslate a single block, all stale blocks, or all machine translations.
- **Layered glossaries.** Global and workspace term lists plus an AI-generated document glossary stored with the summary. The preview toolbar can check machine translations for glossary and protected-Markdown issues and retranslate each affected block.
- Export to a language-suffixed file in the same folder, after confirming a split diff.
- Structural problems are reported before export or retranslation. The cache write is rejected when the model returns a system prompt, an echoed request, or untranslated source text. Missing inline code or glossary targets trigger one corrective retry first.
- Full localization of the extension: English is the source language, Chinese is loaded when VS Code's display language is `zh-cn`, and the command and settings manifests switch with it.

## Installation

```bash
code --install-extension artifacts/vsix/markdown-bilingual-sync.vsix
```

Requires VS Code 1.90 or later (the extension uses Webviews, SecretStorage, and WorkspaceEdit).

### Build from Source

Requires Node.js 20 or later:

```bash
git clone https://github.com/yxm1122/Markdown-Bilingual-Sync.git
cd Markdown-Bilingual-Sync
npm ci
npm run package
```

The build output is `artifacts/vsix/markdown-bilingual-sync.vsix`, which you can install with the command above. To debug, press F5 in VS Code to launch the Extension Development Host; see [Development](#development) for the full command list.

## Quick Start

1. Open a `.md` file that has been saved to disk.
2. Check the language pair in Settings; the default is `en` → `zh-CN`.
3. Run **Markdown Bilingual Sync: Set AI Translation API Key** and paste your key.
4. Choose a translation service in Settings, or run **Markdown Bilingual Sync: Apply Translation Provider Preset…**:
   - Set `markdownBilingualSync.provider` to `openai`.
   - Set `markdownBilingualSync.apiBaseUrl`, for example `https://api.openai.com/v1`.
   - Set `markdownBilingualSync.apiModel`, for example `gpt-4o-mini`.
   - Or set the provider to `http` and configure `httpEndpoint`, `httpHeaders`, `httpBody`, and `httpResponsePath`.
5. Run **Markdown Bilingual Sync: Test AI Translation Connection** to verify that the endpoint, model or template, and key work.
6. Run **Markdown Bilingual Sync: Translate Current File**. The bilingual preview opens in a new tab in the current editor group; the editor window is not split automatically.
7. Later, after you edit and save the source, run **Sync Translation** to translate only missing or stale blocks.
8. For an existing translation, click **Import translation** in the preview toolbar, or run **Import Existing Translation…** from the Command Palette, to import it as locked translations.

## Workflow & Semantics

### Source Text Is the Reference

- The source is never rewritten automatically. It changes only when you explicitly edit or delete source text, or confirm a back-translation write-back.
- Saving the source updates stale status and refreshes the preview. It does not call the translation API.
- **Sync Translation** processes only missing and stale blocks.
- Sync, retranslation, and batch translation write to the cache in batches. If a run fails or is cancelled midway, batches already written are kept and missing blocks are retried on the next sync.
- To switch models or refresh existing machine translations, use **Retranslate All**. Locked translations are never overwritten.

### Translation Lock and In-Preview Editing

- Click a translated block in the preview to show its original Markdown inline. **Save and lock** writes it to the global cache and marks the block as a locked translation.
- You can also run **Edit Cache** and edit the cache file directly; saving locks the block in the same way.
- Clicking source content lets you edit the original Markdown inline. **Stage changes** renders the staged source in the preview immediately and adds an **Apply source changes** button at the top. Clicking it shows a split diff of *Current source* and *Updated source*; confirm to write back to the `.md` file and save it.
- Every block has **Insert** and **Delete** buttons. Clicking one expands it into **Source** and **Translation** choices; the button collapses when the pointer leaves the block.
  - **Insert → Source** opens an inline editor after the block. **Stage new block** makes it appear in the preview immediately. **Insert at start** at the top inserts a block at the beginning of the document.
  - **Insert → Translation** writes a standalone translation block to the cache. It goes straight into export without touching the source. You can **Back-translate** that block to generate a source candidate, stage it, and write it back with your other source changes so the two become a pair.
  - **Delete → Source** marks the block as source pending delete and dims it in the preview; **Undo delete** restores it. After the write-back, any machine or locked translation for that block is demoted to a standalone locked translation (a `target` anchor) and kept in exports, while markers for copied blocks and deleted translations are removed.
  - **Delete → Translation** stores a deletion marker with a backup, keeping the anchor. Later syncs skip the block and exports exclude its content. **Undo delete** restores the original translation, or the original copied or untranslated state, without calling the AI again. Copied blocks such as code and math, and blocks that were never translated, can be deleted the same way.
  - A standalone inserted translation can be deleted directly. It is removed from the cache permanently, with no undo.
  - All staged source edits, insertions, and deletions are written back in one diff confirmation; **Reset staged changes** clears everything.
- Staged changes are tracked per block. If the source file is modified externally in the meantime, staging is cleared and you are asked to edit again.
- When the source changes again, locked translations enter the *Translation locked · source updated* state and are not overwritten automatically.
- To accept the current source, use **Mark synchronized**.
- To translate one block again, use **Retranslate** on that block.
- Every translated block has a **Back-translate** button: it translates the translation back into the source language and puts the result directly into source staging, with no extra dialog. **Apply source changes** writes it to the source file and locks that translation to the new source. If the result matches the current source, nothing is staged.
- **Stable translation** is on by default: retranslation (single block, stale blocks, or all) references the previous translation, back-translation references the current source, and explicitly retranslating a `human` block also references its previous translation. The *Reference previous translation* switch in the preview affects only the current session; the `stableTranslation` setting controls the default.
- **The document brief** can only be generated manually (OpenAI-compatible and Mock providers); with a custom HTTP provider you write it by hand. Generation produces a summary, translation guidance (brief), and a document glossary. The **Document brief** panel shows status, total token estimate, and staleness; the summary stays visible, while translation guidance and the glossary are mutually exclusive collapsed sections (both collapsed initially) and the glossary uses single-line flow cards (`source | target`; short cards fit their content, long text is ellipsized and scrolls on the hovered side), and clicking either side edits just that side inline. One **Save brief** action writes all three to the cache. The *Use document brief context* switch in the preview affects only the current session; the `summaryContext` setting controls the default.
- The brief is stored as a dedicated marker in the cache and takes no part in block alignment or export. It is shown as *Possibly stale* after the source changes but is still used as context, and clearing the cache removes it. Brief generation accepts about 12k input tokens; beyond that, write it manually. Single-block retranslation and back-translation also send read-only neighboring blocks from the same section, which helps short headings and paragraphs keep their local meaning.

### Block Status and Cache Markers

Cache anchors (`<!-- mbs:... -->`) have five modes:

| Mode | Used by | Meaning |
| --- | --- | --- |
| `auto` | Normal blocks | Machine translation. `src` records the source hash from the last translation, so the block becomes stale after the source changes. |
| `human` | Normal blocks | Locked translation, set by import, manual editing, marking synchronized, or back-translation write-back. |
| `copy` | Normal blocks | Not translated and copied verbatim from the source, such as code or math. |
| `target` | Standalone translation blocks | A translation with no matching source, always shown as a locked translation. Produced when a normal translation's source is deleted. |
| `deleted` | Normal blocks | Translation deletion marker; the content is an `mbs-deleted` marker with a backup. Excluded from sync and export. |

Block statuses after alignment: `untranslated`, `copy-pending`, `translated`, `stale`, `human`, `human-stale`, `copy`, `copy-stale`, `deleted`. There are also three staged states: source pending insert, source pending delete, and translation pending generation.

| Operation | Cache | Source | Description |
| --- | --- | --- | --- |
| Sync / retranslate stale / retranslate all | Writes `auto` or `copy` | Unchanged | Skips `human`, `deleted`, and normal `copy` blocks; keeps successful batches on failure |
| Retranslate this block | Writes `auto` | Unchanged | Falls back to a full-file sync when there is no cache; on a `deleted` block it restores the translation |
| Edit/save translation | Writes `human` | Unchanged | Validates the source hash, cache ID, and baseline text before saving |
| Mark synchronized | Writes `human` | Unchanged | Accepts the current source and locks the block |
| Delete translation / undo delete | Writes or removes `deleted` | Unchanged | Keeps a backup when a translation exists; writes an empty marker otherwise |
| Insert translation | Writes `target` | Unchanged | Goes straight into export; can be turned into `human` after back-translating a source |
| Delete standalone translation | Removes the anchor | Unchanged | Cannot be undone |
| Stage source edit | Unchanged | Applied, then written | After write-back, normal translations become stale according to `src` |
| Stage source deletion | Demoted after applying | Applied, then written | Normal translations become `target`; `copy` and `deleted` entries are removed |
| Back-translate (existing translation) | Writes `human` after applying | Applied, then written | The result goes to source staging; no dialog is shown automatically |
| Stage source insertion | Unchanged | Applied, then written | New source blocks are translated on the next sync |

### Split Layout and Scroll Sync

- The preview header switches between **Side by side**, **Stacked**, and **Split** layouts; the choice is remembered across sessions.
- **Split** creates two independent scrolling panes for source and translation instead of placing both languages side by side within each block.
- Scrolling either pane follows the matching block and interpolates by scroll progress within that block, so long blocks keep the other pane moving instead of pinning it to the block top. Blocks that exist on one side only, because of an insertion or deletion, show the same block header and placeholder note as the side-by-side and stacked layouts in the empty pane, so both sides keep a one-to-one row correspondence.
- Editing source or translation, inserting, deleting, retranslating, back-translating, and undoing deletions all still work in the split layout. **Retranslate** is on the source block and **Go to source** is on the translation block, while insert and delete buttons appear in both panes.
- Each block header has a **⋯** (more) button in its top-right corner that hides the block's action buttons by default. Clicking it expands them below the header, and they collapse when the pointer leaves the block. In **Source only** or **Target only** mode the ⋯ button is hidden and the actions sit inline on the right of the header.
- **Source only** and **Target only** modes work with the split layout: they keep the corresponding pane and let it fill the width.
- In the split layout, each pane header has a **Read-only preview** button. When enabled, that pane hides block headers, status, and actions and renders its Markdown continuously, while the other pane stays editable and can enter read-only mode independently. Switching read-only mode or layout preserves both scroll positions instead of jumping to the top.
- Read-only state is per pane and applies only to the current preview session; closing the preview restores editing.
- Read-only mode affects display and editing only. It does not change sync, export, or cache semantics, and blocks that exist on one side do not produce placeholders in the other pane; only content that actually exists is rendered.

### Importing Existing Translations

- Click **Import translation** in the preview toolbar, or run **Import Existing Translation…** from the Command Palette.
- Select an existing translation `.md` file, for example `guide.zh.md`.
- Each top-level block is validated: source and translation must have the same block count and block types, so paragraphs cannot drift out of alignment.
- All translatable blocks are written to the cache as **Translation locked**; structural blocks such as code and math are copied from the source.
- Existing cache entries are overwritten after a confirmation. No cache backup is provided.
- The imported file must not contain extension anchors. If you pick a cache file, the extension prompts you to use the anchor-free translation Markdown instead.
- Importing neither calls the AI nor modifies the source file.

### Custom HTTP Provider

- Enabled when `markdownBilingualSync.provider` is set to `http`.
- Supported request methods are `POST`, `PUT`, and `PATCH`; `httpHeaders` and `httpBody` are JSON templates.
- Template variables: `{{text}}`, `{{id}}`, `{{kind}}`, `{{headingPath}}`, `{{sourceLanguage}}`, `{{targetLanguage}}`, `{{apiKey}}`, `{{referenceText}}`, `{{referenceRole}}`, `{{summary}}`.
- The custom HTTP provider sends one request per block. With `httpResponseType` set to `json`, the text is extracted through `httpResponsePath`; with `text`, the response body is used as the translation directly.
- Reference translations and document summaries are sent only when the template explicitly references `{{referenceText}}` or `{{summary}}`. `{{referenceRole}}` is either `previous-target` or `previous-source`.
- Example `httpBody`:
  ```json
  {"text":"{{text}}","source_language":"{{sourceLanguage}}","target_language":"{{targetLanguage}}"}
  ```
- Example `httpHeaders`:
  ```json
  {"Content-Type":"application/json","Authorization":"Bearer {{apiKey}}"}
  ```
- `httpResponsePath` accepts values such as `translation`, `data.translations.0.text`, or `result[0].text`.
- Endpoint addresses must use HTTPS except for localhost/127.0.0.1/[::1]. `{{apiKey}}` is substituted only while a request is made and is never written to settings or logs.

### Clearing Caches

- **Clear Current Translation Cache** deletes the cache for the current file, so you can translate or import again. This cannot be undone.
- **Clear All Translation Caches** recursively deletes every cache file under the extension's `globalStorageUri/cache` and is meant for a full reset. This cannot be undone.
- If a cache file is open in an editor, the clear command asks you to close that tab first, so the editor cannot keep holding deleted content.
- While a sync or import is running, clearing all caches is rejected to avoid interleaving writes and deletions.
- **Open Translation Cache Folder** still lets you browse every cache file.

### Batch Translation and Export

- **Batch Translate Folder…** recursively finds `.md` files under the selected folder, skips exports for the current target language (for example `*.zh.md`), and translates each file incrementally.
- Batches are packed dynamically from the estimated token budget; `apiBatchSize` is only a hard limit on block count. Concurrent calls are still coalesced across files, but each batch stays within one document and keeps a section whole unless that section alone exceeds the limits.
- File-level concurrency, batches within one file, and manual sync requests all share the `translationConcurrency` limit (default 8, maximum 100).
- Each successful batch is written to the cache immediately. If later batches for a file fail, the successful blocks are kept and the failed ones stay untranslated; the next sync fills only the gaps.
- Before batch translation starts, open Markdown files in the folder are saved. The progress notification can be cancelled. One file failing does not stop the others, and details go to the **Output** panel.
- **Batch Export Folder…** first scans the folder for Markdown files with a cache and builds an export queue; files whose content is unchanged and files without a cache are skipped.
- Batch export shows a single summary confirmation and no per-file diff dialog. After you confirm, language-suffixed files are written in queue order and each target path is logged.

### Task Panel

- The **Translation Tasks** button in the status bar shows a running indicator and the active/limit concurrency while tasks are running; click it to show or hide the task view.
- The task panel is a native VS Code **TreeView** in the **Translation Tasks** activity-bar container. On first use, drag it to the right secondary sidebar if you prefer; VS Code remembers the location. The status bar button still toggles it directly.
- **Upgrade note:** the view container ID changed from the old dotted value to `markdownBilingualSyncTasks`. If the view disappears after upgrading, drag it from the activity bar once.
- The view contains:
  - **Batch overview**: active files, active block progress, failed blocks, concurrency usage, and waiting requests.
  - **Active tasks**: file, phase, block progress, failure count, elapsed time, and errors; inline actions open the source file, open the preview, or cancel.
  - **Recently completed**: recently finished tasks with elapsed/failure details, plus a command to clear history.
  - **Runtime status**: translation service, model or template, batch budget, and block limit.
- The view title provides cancel all, clear history, open output, and **Change Languages**. Language switching uses a native QuickPick for source, target, or swap; options come from `markdownBilingualSync.supportedLanguages` and writes keep the existing setting scope. Changes affect only later translations and exports.
- Batch translation and command- or preview-triggered full-file syncs no longer show VS Code progress or completion notifications; progress and results go to the view. Cancel confirmations, import/export confirmations, and API prompts are still shown.
- Task rows aggregate file-level batch and sync operations. Single-block retranslation or back-translation in the preview keeps its brief inline feedback and does not create its own row.
- The status bar button does not open the task view automatically; it toggles the view when clicked.

### Provider Presets

- Run **Apply Translation Provider Preset…** to switch in one step between OpenAI, DeepSeek, SiliconFlow, Ollama, LM Studio, custom HTTP, and Mock.
- Presets write only endpoint settings such as `provider`, `apiBaseUrl`, and `apiModel`, never the API key.
- Presets for local services use HTTP addresses on `127.0.0.1`; all other addresses must use HTTPS.
- Presets overwrite the current endpoint and model settings. The API key still has to be saved separately with **Set AI Translation API Key**.

### Export

- **Export Translations…** writes a language-suffixed file in the same folder, for example `docs/guide.zh.md`.
- A side-by-side diff is shown before writing; the dialog closes after you cancel or write, leaving no extra diff tab.
- The target file is checked again before writing and is not overwritten if it was modified externally during confirmation.
- Exported files have internal anchors stripped and are durable assets for use across devices and projects.

## Commands

> Command titles follow VS Code's display language. The table lists the English titles, which are shown when VS Code itself is in English; other display languages show localized titles.

| Command | Description |
| --- | --- |
| Translate Current File | Translates missing blocks for the first time and opens the preview |
| Open Bilingual Preview | Opens or shows the preview in a new tab in the current editor group |
| Sync Translation | Translates only missing and stale blocks |
| Retranslate Stale Translations | Retranslates all stale machine translations |
| Retranslate All Machine Translations | Forces retranslation of all `auto` blocks; locked translations are kept |
| Export Translations… | Writes a language-suffixed file after a side-by-side diff confirmation |
| Edit Translation Cache | Opens the global translation cache for the current file |
| Refresh Bilingual Preview | Refreshes the preview manually |
| Open Translation Tasks Panel | Shows or hides the Translation Tasks TreeView to check progress or cancel tasks |
| Open Translation Cache Folder | Opens the global cache folder |
| Clear Current Translation Cache | Deletes the cache for the current file (cannot be undone) |
| Clear All Translation Caches | Recursively deletes every cache in extension storage (cannot be undone) |
| Import Existing Translation… | Imports an existing translation Markdown file block by block and locks it |
| Batch Translate Folder… | Recursively translates Markdown files in a folder, skipping exports for the target language |
| Batch Export Folder… | Queues exports for Markdown files in a folder that already have a cache |
| Edit Global Glossary | Opens the user-level `glossary.json` |
| Edit Glossary (Global or Workspace) | Choose the global list or the workspace-root `.mbs-glossary.json` |
| Set AI Translation API Key | Writes the key to SecretStorage |
| Apply Translation Provider Preset… | Switches to OpenAI/DeepSeek/SiliconFlow/Ollama/LM Studio/HTTP/Mock |
| Test AI Translation Connection | Sends a short test request and reports the model or template, latency, and a sample translation |
| Clear AI Translation API Key | Deletes the key from SecretStorage |

### Glossaries and consistency check

- **Global:** `globalStorage/glossary.json`, shared across all workspaces.
- **Workspace:** `.mbs-glossary.json` in the workspace root; commit it with the project if the team should share terms. “Workspace” means the VS Code workspace folder; in a multi-root workspace the folder containing the source file is used. With no workspace open, only the global glossary applies.
- **Document:** generated by the AI together with the document brief and stored in the cache's `mbs-summary` metadata. The preview's **Document brief** panel shows the terms as flow cards; click a card to edit, add or delete terms, or switch to bulk `source => target` editing. With a custom HTTP provider the glossary cannot be generated automatically, but you can edit it after writing a brief manually. Clearing the brief also clears the document glossary.
- Merge order is **global → workspace → document**; a document entry overrides an earlier entry with the same `source`. The user glossaries are sent as constraints when the AI generates the document glossary to reduce conflicts. Regenerating the summary keeps existing document glossary entries; clear the summary first to rebuild from scratch.
- The preview's **Check** action scans machine translations for missing glossary targets and protected Markdown. Results are grouped by block; selecting one retranslates that block. Locked translations are skipped, so manual work is never overwritten.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `markdownBilingualSync.provider` | `mock` | `mock`, `openai`, or `http` |
| `markdownBilingualSync.apiBaseUrl` | `https://api.openai.com/v1` | OpenAI-compatible endpoint; `/chat/completions` is appended automatically; plain HTTP is allowed only for localhost/127.0.0.1/[::1] |
| `markdownBilingualSync.apiModel` | `gpt-4o-mini` | Model name supported by the server |
| `markdownBilingualSync.apiThinkingMode` | `default` | `default` omits `enable_thinking` and uses the provider default; `enabled` sends true; `disabled` sends false. Only some services support explicit modes |
| `markdownBilingualSync.apiDisableThinking` | `false` | Legacy switch used only when `apiThinkingMode` is `default`; prefer `apiThinkingMode` |
| `markdownBilingualSync.apiBatchSize` | `50` | Hard limit on blocks per batch; the actual batch size is determined by the token budget |
| `markdownBilingualSync.apiBatchTokenBudget` | `2000` | Estimated token budget for the input of each batch; overly small batches are avoided; summary/brief, neighbor context, user annotations, reference translations, and glossary count toward it, output is counted separately |
| `markdownBilingualSync.translationConcurrency` | `8` | Concurrency limit shared by file-level translation, in-file batches, and manual requests (1–100) |
| `markdownBilingualSync.stableTranslation` | `true` | Retranslation references the previous translation and back-translation references the current source, reducing wording drift; can be toggled temporarily in the preview |
| `markdownBilingualSync.summaryContext` | `true` | Uses the manually generated document brief (summary + brief) as context for sync, retranslation, and back-translation; can be toggled temporarily in the preview |
| `markdownBilingualSync.apiTimeoutMs` | `120000` | Timeout for a single request in milliseconds, shared by the OpenAI-compatible and custom HTTP providers |
| `markdownBilingualSync.httpEndpoint` | empty | Full URL of the custom HTTP endpoint; may contain template variables |
| `markdownBilingualSync.httpMethod` | `POST` | Request method for the custom HTTP endpoint: `POST`, `PUT`, `PATCH` |
| `markdownBilingualSync.httpHeaders` | Default Bearer template | Request header JSON template |
| `markdownBilingualSync.httpBody` | Default text template | Request body JSON template; one request per block |
| `markdownBilingualSync.httpResponseType` | `json` | `json` or `text` |
| `markdownBilingualSync.httpResponsePath` | `translation` | JSON path to the translation text |
| `markdownBilingualSync.sourceLanguage` | `en` | Source language |
| `markdownBilingualSync.targetLanguage` | `zh-CN` | Target language; one target language per file |
| `markdownBilingualSync.supportedLanguages` | `["zh-CN"]` | Languages offered by the source/target quick switches in the task panel, shown in array order. Invalid or blank entries and case-insensitive duplicates are ignored, and the current `sourceLanguage` and `targetLanguage` are always included |

`provider`, the endpoint, model, HTTP template, and batch settings are application-level settings and cannot be overridden by a workspace.

## Security & Privacy

- API keys are stored only in VS Code SecretStorage and never written to settings, workspaces, logs, prompts, or caches. The `{{apiKey}}` variable in custom HTTP templates is substituted only when a request is made.
- The OpenAI-compatible and custom HTTP providers use separate SecretStorage keys; the legacy shared key is only a fallback for upgrade migration. After switching provider or endpoint, run **Test AI Translation Connection** again to confirm the key matches the target service.
- Source write-backs (document replacement, saving, cache reconciliation) and sync tasks share one file lock. A failed write-back restores the in-memory document, so no unsaved intermediate state is left behind.
- Unknown variables in HTTP templates, invalid request headers, newline injection, and remote plain HTTP connections are rejected, and error messages mask keys.
- Document text is sent to the configured translation service; check the data handling policy of that service.
- Raw HTML is not rendered. The Webview restricts scripts and resources with CSP and a nonce.
- Translation caches live in the extension's `globalStorageUri`, not in the project folder.
- Moving a project, clearing extension storage, or uninstalling the extension loses caches and lock state. Export anything you need to keep.
- The global glossary is a user-level resource and is not shared through the repository. The workspace glossary lives in the project directory and is shared with the repository; the document glossary exists only in the local translation cache.

## Localization

- **English is the default and source language.** Chinese is loaded when the VS Code display language is `zh-cn`; other languages fall back to English.
- The manifest (extension display name and description, command titles and category, view names, setting descriptions, and enum descriptions) uses `package.nls.json` / `package.nls.zh-cn.json`; runtime strings use `l10n/bundle.l10n.json` / `l10n/bundle.l10n.zh-cn.json`.
- Runtime strings live in `src/i18n/en.ts` (English source) and `src/i18n/zh.ts`; errors and warnings are grouped by domain in `src/i18n/errors/*.ts` and resolved for the current locale through `tError()`.
- Webview strings are injected into the page by the host as localized `UI_TEXT`; `<html lang>`, language names, and date and duration formats use `vscode.env.language` and `Intl`.
- After adding or changing strings, run `npm run l10n:build` (it also runs as part of `npm run compile`, `vscode:prepublish`, `typecheck`, `test`, and `test:watch`), then `npm run typecheck` and `npm test`.
- `npm run watch` builds the bundle once before it starts but does not watch `en.ts`, `zh.ts`, or `errors/*`; after changing strings, run `npm run l10n:build` again and reload the extension host.

## Known Limitations

- Only local file workflows are supported; there are no cloud task queues or multi-user collaboration features.
- Code blocks, math, HTML, and frontmatter are copied as-is by design and never sent for AI translation.
- In-preview editing is per block; cross-block selection and large structural rearrangements are not supported. For complex restructuring, edit the source file directly.
- Scroll sync uses block anchors and proportional in-block interpolation; when block heights differ greatly, the panes may not align pixel-for-pixel, but the other pane keeps moving through long blocks.
- Importing a translation requires the source and translation to match one-to-one in top-level block count and type; structural mismatches reject the import.
- Provider requests share the `translationConcurrency` limit (default 8). Lower it when you hit rate limits; for files with many blocks, consider raising `apiBatchTokenBudget`.
- Batch export provides a single summary confirmation rather than a per-file diff; use the regular export when you need per-file confirmation.
- Provider presets overwrite the current endpoint and model settings but never write or clear the API key.
- The custom HTTP provider sends one request per block and does not support a batch `items` protocol; services that require batching need an OpenAI-compatible adapter in front.
- The *Source* insert and delete actions modify the source file, while *Delete → Translation* only writes a deletion marker and keeps the anchor; it does not delete the source block. Standalone translation blocks have no source and are removed from the cache immediately when deleted, with no undo.
- Standalone translation blocks are written straight to the cache and do not modify the source. If their anchor source block is deleted, they are placed after the preceding remaining source block or at the end of the translation.
- After a source block is deleted and written back, its translation is demoted to a standalone translation block (a `target` anchor), which avoids orphaned anchors and does not block later syncs.
- Caches cannot be recovered inside the extension after clearing the current cache or all caches; export translations you need to keep first.
- Back-translation runs per block and does not back-translate a whole document automatically.
- Document briefs and document glossaries are generated only on explicit request; the custom HTTP provider cannot generate them and requires manual input, and very large documents (over about 12k tokens) are not generated in segments.
- Summaries, briefs, read-only neighbor context, user annotations, and stable references increase input tokens for every translation; these fixed contexts count against each batch budget.
- Mermaid diagrams, raw HTML, custom prompts, and streaming output are not supported.
- Glossaries merge global → workspace → document. The document glossary is AI-generated with the brief and should be reviewed before relying on it; clearing the brief also clears it.
- AI review is triggered manually (per block, or **Review machine translations** in the toolbar menu) and only returns annotations, never automatic rewrites; annotations are stored in a local sidecar and are not shared through the workspace.
- The UI ships in English (the source language) and zh-cn, with other VS Code languages falling back to English. Interface, preview, and notification strings come from `src/i18n/en.ts` / `src/i18n/zh.ts`, errors and warnings from `src/i18n/errors/*`, and manifest strings from `package.nls*.json`.
- The GitHub README is in Chinese, while this English README is used for the Marketplace listing; both are maintained. The UI itself supports English and zh-cn.
- Sync is not real-time: saving only changes the state, and translation is triggered by explicit commands.

## License

This project is released under the MIT License (see the LICENSE file in the repository root). You may use, modify, and distribute it freely, provided you retain the copyright and license notice.

## Development

```bash
npm ci
npm run typecheck
npm test
npm run compile
npm run preview:sample
npm run ui:matrix
npm run ui:perf
npm run package
```

`typecheck`, `test`, `compile`, `test:watch`, and `package` generate the l10n bundle automatically; to change text only, run `npm run l10n:build` on its own. `watch` builds the bundle once at startup but does not watch the locale folders.

`ui:matrix` captures three themes × three layouts × three modes plus summary, dialogs, editing, read-only, busy, narrow, and empty states with headless Edge. `ui:perf` records a 320-block baseline for mount, input, and scrolling. Outputs go to `artifacts/ui-matrix/` and `artifacts/ui-perf/`. Both require a local Edge (set `EDGE_PATH` if needed) and do not run in CI.

The package output is `artifacts/vsix/markdown-bilingual-sync.vsix`, and the sample document is `samples/demo.md`.

See [`docs/`](docs/README.md) for architecture, cache format, the preview protocol, the development workflow, and testing guidance. Translation-quality evaluation is documented in [`docs/evaluation.md`](docs/evaluation.md); run `npm run eval:translation -- --provider mock` for an offline pipeline smoke test.

CI is configured in `.github/workflows/ci.yml`: every push and pull request runs `npm ci`, type checking, and the full test suite, then packages a VSIX as a build artifact.
