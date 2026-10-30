# Translation Quality Evaluation Dataset

Small English-to-Simplified-Chinese Markdown cases for the Markdown Bilingual Sync extension. Each case is a source file plus a human-written reference translation. The dataset targets translation quality, not extension behavior.

## Layout

```
manifest.json
cases/<case-id>/source.md
cases/<case-id>/reference.zh.md
```

`manifest.json` lists the language pair, the shared glossary, and every case with its tags and focus.

## Cases

| Id | Focus | Tags |
| --- | --- | --- |
| `basic-structure` | Heading hierarchy, paragraphs, emphasis, inline code | `headings`, `paragraphs`, `emphasis`, `inline-code` |
| `nested-lists` | Bullet, ordered, and task lists with nesting | `lists`, `nested-lists`, `task-lists`, `list-fragments` |
| `table-alignment` | Table rows, columns, alignment, inline code, links | `tables`, `alignment`, `inline-code`, `links` |
| `code-math` | Fenced code, inline code, display math | `code`, `math`, `inline-code`, `verbatim` |
| `links-images-footnotes` | Links, image alt text, footnote refs and definitions | `links`, `images`, `footnotes`, `alt-text` |
| `alerts-quotes` | Blockquotes and GitHub Alerts NOTE/WARNING | `blockquotes`, `github-alerts`, `note`, `warning` |
| `pronouns-ellipsis` | Cross-paragraph pronouns and ellipsis | `pronouns`, `ellipsis`, `cohesion`, `context` |
| `terminology` | Glossary terms in technical prose | `terminology`, `glossary`, `technical-prose` |
| `mixed-language` | English mixed with existing Chinese | `mixed-language`, `preserve-chinese`, `selective-translation` |
| `long-paragraph` | One 120-200 word paragraph with inline requirements | `long-paragraph`, `requirements-list`, `punctuation` |
| `frontmatter` | YAML frontmatter plus short body | `frontmatter`, `yaml`, `byte-preservation` |
| `cjk-punctuation` | Chinese punctuation and CJK/Latin spacing | `cjk-punctuation`, `spacing`, `links`, `inline-code` |
| `inline-html-escapes` | Inline HTML, escaped Markdown, double-backtick code, link title | `inline-html`, `escaped-markdown`, `double-backtick`, `link-title` |
| `negation-quantities` | Negation, quantities, and time conditions | `negation`, `quantities`, `dates`, `accuracy` |
| `heading-idiom` | A title whose idiom is clarified by the following paragraph; batch vs single-block context regression | `headings`, `idiom`, `tone`, `single-block-context` |
| `real-project-readme` | Full project README with tables, code, links, footnote | `real-document`, `readme`, `tables`, `code`, `links`, `footnotes` |
| `real-operations-runbook` | Deployment runbook with alert, JSON, error table, rollback | `real-document`, `runbook`, `github-alerts`, `code`, `tables`, `operations` |

## Conventions

- **Block parity.** Source and reference have the same top-level block count and block kinds, in the same order, because the runner aligns by block index. Frontmatter is a separate leading region and is not counted as a body block.
- **Glossary.** Use the targets in `manifest.json` wherever the source term appears in prose. `token` stays Latin and keeps its space in `token 预算`.
- **Verbatim content.** Code fences, inline code, math, URLs, HTML tags, footnote ids, and YAML frontmatter are unchanged between source and reference. Link titles are prose and may be translated, so the reference keeps or translates them freely.
- **Inline code.** Code spans follow CommonMark: a run of N backticks closes only at a run of N backticks, and backslashes do not escape backticks inside a code span. Use double-backtick delimiters when the code content contains a backtick.
- **Translated content.** Prose, link text, image alt text, table headers and cells, list items, and alert bodies are translated. Alert markers such as `[!NOTE]` and task checkboxes are preserved.
- **Chinese style.** References use natural Simplified Chinese, full-width punctuation, and a single space between CJK text and Latin words or code spans. They are not literal word-for-word renderings.
- **Mixed language.** In `mixed-language`, existing Chinese sentences are kept as-is; only English text is translated.
- **References are human baselines.** They show one high-quality rendering, not an exact-match target. The runner should score meaning, terminology, structure, and invariants rather than require character equality.

## Adding Cases

Create `cases/<id>/source.md` and `cases/<id>/reference.zh.md`, keep block parity, reuse the glossary, then add an entry to `manifest.json`. Keep each case small (roughly 2-5 blocks) except intentional long-form cases.

## Runner

Run `npm run eval:translation -- --provider mock` for an offline pipeline smoke test, or see [`docs/evaluation.md`](../docs/evaluation.md) for real Provider runs, environment variables, reports, metrics, and the known footnote-definition gap. `npm run eval:summary` reuses the same source documents to evaluate summary and document-glossary quality (raw vs deterministic filtered). Reports are written to `eval/reports/` and ignored by git.
