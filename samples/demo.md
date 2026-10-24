---
title: Bilingual preview demo
description: Phase 1 sample for Markdown Bilingual Sync
tags:
  - markdown
  - translation
---

# Markdown Bilingual


The quick brown fox jumps over the lazy dog. This paragraph keeps a short English text next to its Chinese translation.


## Automatic incremental sync

- Translate only the blocks that changed.
- Keep human edits locked and visible.
- Mark stale blocks after the source file is updated.

1. Translate the document with the Mock provider.
2. Edit one paragraph in the source file and save.
3. Run **Sync translation** to refresh only the stale blocks.

> [!NOTE]
> GitHub Alerts stay visible in the bilingual preview.

> Blockquote blocks are translated as a whole unit.

| Feature | Status | Note |
| --- | --- | --- |
| Bilingual preview | Ready | Side by side and interleaved |
| Manual sync | Ready | Stale blocks are marked |
| AI provider | Ready | OpenAI-compatible Chat Completions |
| Glossary and export | Ready | Global glossary, diff export |

### Code, math and tasks

```ts
const mode: "bilingual" | "source" | "target" = "bilingual";
```

Inline math $E = mc^2$ is rendered by KaTeX.

$$
\int_0^1 x^2\,dx = \frac{1}{3}
$$

- [x] Parse Markdown blocks
- [x] Align source and translation
- [x] Add a real AI provider

![Preview diagram](assets/demo.svg)

A footnote reference keeps the document connected.[^1]

---

[^1]: Footnote definitions are copied unchanged across languages.
