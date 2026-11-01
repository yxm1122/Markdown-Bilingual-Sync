# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.17.0] - 2026-11-01

### Added

- Expose five native VS Code Language Model Tools so Copilot and VS Code agents can read, create, and update document briefs, document glossaries, and global or workspace glossaries.
- Agent writes show a confirmation, reuse the cache file lock, dirty-file protection, and preview refresh, override generation locks by default while keeping them set, and still require a non-empty summary for document briefs.

### Changed

- Refresh the Marketplace icon, bilingual preview screenshots, and README feature layout; add a block-state diagram and this changelog.

## [0.16.0] - 2026-11-01

### Added

- Add independent generation locks for the document summary, the four translation-brief fields, and the document glossary.
- Locked items are skipped by AI generation and never overwritten, but remain editable and continue to participate in translation and review.

## [0.15.1] - 2026-10-31

### Fixed

- Refine block selection and task panel behavior after the 0.15.0 multi-select release.

## [0.15.0] - 2026-10-31

### Added

- Add click, drag, and Shift-click block multi-select with a serial per-file operation queue and parallel execution across files.
- Add bulk retranslate, review, back-translate, mark-synchronized, and delete-translation actions with running and queued state in the task panel and status bar.

### Fixed

- Keep applied annotations accessible and dim only dismissed AI notes.

## [0.14.5] - 2026-10-31

### Fixed

- Tighten the quality of AI-generated document glossaries.
- Make review annotations concise and aware of the relevant Markdown branch.

## [0.14.4] - 2026-10-30

### Fixed

- Compact the review prompt and correct the checked state for AI annotations.

## [0.14.3] - 2026-10-30

### Added

- Apply pending user annotations during translation and expose candidate AI answers.
- Add annotation evaluation cases and merge AI handling options into the annotation workflow.

### Fixed

- Harden annotation rebinding and answer edge cases.

## [0.14.2] - 2026-10-29

### Added

- Add allowlisted document frontmatter metadata to brief generation input.

### Fixed

- Harden document metadata parsing and preserve glossary entries across regeneration.

## [0.14.1] - 2026-10-29

### Added

- Add assistant output language selection for summaries and briefs.
- Improve the annotation panel workflow.

## [0.14.0] - 2026-10-29

### Added

- Add document briefs, same-section block context for short headings and paragraphs, and block-level review annotations.
- Add a local annotation sidecar that stays out of the cache Markdown and exports.

### Fixed

- Harden annotation lifecycle and review flow edge cases.

## [0.13.2] - 2026-10-27

### Fixed

- Apply staged source edits before retranslation.

## [0.13.1] - 2026-10-26

### Fixed

- Preserve split-pane scroll position when switching through source-only or target-only modes.

## [0.13.0] - 2026-10-26

### Added

- Rebuild the preview and task panel with native VS Code UI components.
- Add a translation quality evaluation framework.
- Generate document glossaries and improve translation quality.
- Add native UI verification coverage for the preview matrix.

### Fixed

- Harden batching and glossary state handling.

## [0.12.0] - 2026-10-25

### Added

- Localize the extension for English and Simplified Chinese, including command and setting manifests.

## [0.11.0] - 2026-10-25

### Added

- Add source/target language switching to the task panel with a native QuickPick.

## [0.10.1] - 2026-10-25

### Added

- Add assist tooltips and developer documentation.

## [0.10.0] - 2026-10-24

### Added

- Support Markdown-like `skill` documents in addition to the standard Markdown language.
- Add stable translation references and document summary generation.

## [0.9.3] - 2026-10-24

### Fixed

- Harden writeback concurrency and release edge cases.

## [0.9.2] - 2026-10-24

### Added

- Initial release: block-level bilingual Markdown translation, cache, preview, and export.

[0.17.0]: https://github.com/yxm1122/Markdown-Bilingual-Sync/commit/329b2c4
[0.16.0]: https://github.com/yxm1122/Markdown-Bilingual-Sync/commit/7a0130b
[0.15.1]: https://github.com/yxm1122/Markdown-Bilingual-Sync/commit/b8c4a8a
[0.15.0]: https://github.com/yxm1122/Markdown-Bilingual-Sync/commit/92985fd
[0.14.5]: https://github.com/yxm1122/Markdown-Bilingual-Sync/commit/f4bdf29
[0.14.4]: https://github.com/yxm1122/Markdown-Bilingual-Sync/commit/9b01bea
[0.14.3]: https://github.com/yxm1122/Markdown-Bilingual-Sync/commit/489e8c3
[0.14.2]: https://github.com/yxm1122/Markdown-Bilingual-Sync/commit/e4c5d08
[0.14.1]: https://github.com/yxm1122/Markdown-Bilingual-Sync/commit/27983b1
[0.14.0]: https://github.com/yxm1122/Markdown-Bilingual-Sync/commit/4037687
[0.13.2]: https://github.com/yxm1122/Markdown-Bilingual-Sync/commit/550af05
[0.13.1]: https://github.com/yxm1122/Markdown-Bilingual-Sync/commit/cc0e845
[0.13.0]: https://github.com/yxm1122/Markdown-Bilingual-Sync/commit/e6a5ee3
[0.12.0]: https://github.com/yxm1122/Markdown-Bilingual-Sync/commit/0c712a0
[0.11.0]: https://github.com/yxm1122/Markdown-Bilingual-Sync/commit/bc239d9
[0.10.1]: https://github.com/yxm1122/Markdown-Bilingual-Sync/commit/7240aba
[0.10.0]: https://github.com/yxm1122/Markdown-Bilingual-Sync/commit/7371469
[0.9.3]: https://github.com/yxm1122/Markdown-Bilingual-Sync/commit/06936ac
[0.9.2]: https://github.com/yxm1122/Markdown-Bilingual-Sync/commit/54bec84
