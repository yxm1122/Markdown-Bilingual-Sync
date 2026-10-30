# AI Annotation Quality Evaluation

Small en → zh-CN cases for the AI review prompt. Each case is an original block plus an existing translation with deliberately planted issues (or a clean control). The runner calls `Provider.review`, normalizes the returned annotations to the handling-option model, and checks issue detection, clean-case noise, and whether instructions can stand alone.

The suite evaluates the reviewer prompt and annotation shape, not the Markdown translator. Translation quality has its own dataset in [`eval/`](../README.md).

## Layout

```
manifest.json
cases/<case-id>/source.md
cases/<case-id>/target.md
```

`expected` lives in the manifest. Block IDs are `b1`, `b2`, … in body order; source and target must contain the same body blocks and kinds. Non-translatable blocks are skipped.

## Cases

| Id | Focus | Expectation |
| --- | --- | --- |
| `clean-save` | Clean translation, glossary `preview` → `预览` | No annotation |
| `clean-paraphrase` | Valid paraphrase with glossary term | No annotation |
| `omission-scope` | Missing `only in the desktop app` | One target issue + one-shot instruction |
| `number-timeout` | 60 seconds translated as 30 | One target issue + one-shot instruction |
| `term-cache` | Glossary `cache` → `缓存` not followed | One term issue + instruction |
| `source-contradiction` | Source says fixed 30 seconds, then 60 | Source issue + advice only |
| `broken-link` | Target Markdown link misses `)` | One structure issue + instruction |
| `recurring-cache` | Repeated `cache` translated inconsistently | One term issue + persistent instruction |
| `multi-block` | Wrong number in block 2; blocks 1/3 are clean | One issue in `b2` only |

## Expected issue shape

```json
{
  "blockId": "b1",
  "side": "target",
  "type": "translation-uncertain",
  "severity": "check",
  "match": ["60", "30", "秒"],
  "option": {
    "kind": "instruction",
    "mode": "once",
    "mustInclude": ["60"],
    "minCount": 1
  },
  "description": "Human-readable intent"
}
```

- `match` is any-of against the annotation message, question, excerpts, and option texts.
- `option` is optional. `kind: "advice"` must not declare `mode`.
- An instruction only counts as covered when its text matches `mustInclude` and it passes the standalone heuristic (action word, no bare yes/no reply, no unresolved “first option” reference). `mode` is scored separately; a once/persistent mismatch does not hide an otherwise usable instruction.

## Run

```bash
npm run eval:annotations -- --provider mock
MBS_API_KEY=... npm run eval:annotations -- \
  --provider openai \
  --base-url https://api.siliconflow.cn/v1 \
  --model deepseek-ai/DeepSeek-V3.2 \
  --label my-prompt \
  --out eval/reports/annotations/my-prompt
```

Re-evaluate saved annotations without calling the provider:

```bash
npm run eval:annotations -- \
  --annotations-dir eval/reports/annotations/baseline/annotations \
  --out eval/reports/annotations/rechecked
```

Compare prompt runs:

```bash
npm run eval:annotations -- ... \
  --baseline eval/reports/annotations/baseline-current/report.json
```

Useful options: `--filter <id-or-tag>`, `--case-concurrency`, `--concurrency`, `--thinking`, `--timeout`, `--api-key-env`. Keys are read from the environment only and never written to reports.

## Output

Reports are gitignored under `eval/reports/annotations/<label-or-time>/`:

- `report.md`: aggregate metrics, per-case expected/actual annotations, option checks.
- `report.json`: machine-readable results for comparison.
- `human-review.md`: 0–2 scoring table for issue accuracy, option usefulness, and standalone quality.
- `annotations/<case-id>.json`: raw provider annotations.
- `prompt.txt`: exact system prompt used for the run.
- `comparison.md`: present when `--baseline` is supplied.

## Metrics

| Metric | Meaning |
| --- | --- |
| Precision / recall | Keyword-matched expected issues; unmatched annotations count as false positives. |
| Clean false positives | Annotations on cases that should produce none. |
| Option coverage | Expected issues that received a satisfying instruction/advice. Instructions must also pass the standalone check; mode is scored separately. |
| Standalone rate | Share of all instructions that can be sent without the question. |
| Mode accuracy | Among matched instructions, whether `once`/`persistent` matches the dataset expectation; the user can override it at adoption. |
| Advice fallback | Expected advice cases that produced advice instead of an invented instruction. |
| Type / severity accuracy | Taxonomy agreement among matched issues; a taxonomy mismatch is reported but does not hide a found issue. |
| Format errors | Provider parse failures after the built-in retry. |

Automatic checks are discovery aids. Read `human-review.md` before deciding that a prompt is better.

## Baseline notes

On 2026-10-30 with `deepseek-ai/DeepSeek-V3.2` (SiliconFlow, thinking default):

| Run | Precision | Recall | Clean FP | Option coverage | Standalone | Mode | Format errors |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Current prompt before merge | 60.0% | 85.7% | 2/2 cases | 28.6% | 57.1% | 100%* | 1 |
| Merged options, v1 | 87.5% | 100.0% | 1/2 cases | 100.0% | 100.0% | 100% | 0 |
| Final, v3 run 1 | 87.5% | 100.0% | 1/2 cases | 100.0% | 100.0% | 100% | 0 |
| Final, v3 run 2 | 100.0% | 100.0% | 0/2 cases | 100.0% | 100.0% | 80% | 0 |

\* Baseline had fewer usable instructions, so mode accuracy is only computed over the instructions it did produce.

These are small samples and model output varies. Earlier repeats showed `clean-save` producing a false positive in 1 of 3 runs and `recurring-cache` failing to detect or match in 1 of 3 runs. The v3 prompt added two evidence-driven changes after v1: an explicit `side` rule (use target when the translation needs changing; source only when the source itself is wrong) and a clean glossary example (never flag a term whose target already uses the glossary target). Focused repeats after those changes produced 0 clean false positives in 6 runs and target-side detection in 3/3 number cases. Treat small differences as noise; run repeats before attributing them to a prompt edit.
