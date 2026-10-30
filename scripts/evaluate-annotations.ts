/**
 * AI 批注质量评估 CLI（开发者工具，不进入 VSIX）。
 *
 * 用法：
 *   npm run eval:annotations -- --provider mock
 *   MBS_API_KEY=... npm run eval:annotations -- --provider openai --model gpt-4o-mini \
 *     --label baseline-current --out eval/reports/annotations/baseline-current
 *
 * 默认从 eval/review/manifest.json 读取原文/已有译文/预期问题，调用 Provider.review，
 * 写出 report.md / report.json / human-review.md / prompt.txt 和原始批注 JSON。
 * 当前提示词的输出（suggestion/suggestedAnswers）会被归一化为 advice/instruction
 * 后参与指标，因此可以作为后续提示词改动的基线。
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { parseArgs } from "node:util";
import { buildReviewCaseContent } from "../src/evaluation/reviewDataset";
import type { ReviewEvalCase, ReviewEvalManifest } from "../src/evaluation/reviewDataset";
import {
  evaluateReviewCase,
  aggregateReviewEvaluations,
  type EvaluateReviewCaseInput,
  type ReviewCaseEvaluation,
} from "../src/evaluation/reviewMetrics";
import {
  createReviewReport,
  formatReviewComparison,
  formatReviewHumanReview,
  formatReviewJson,
  formatReviewMarkdown,
  type ReviewReport,
} from "../src/evaluation/reviewReport";
import { ConcurrencyLimiter } from "../src/translation/concurrency";
import { MockTranslationProvider } from "../src/translation/mockProvider";
import {
  buildReviewSystemPrompt,
  OpenAITranslationProvider,
} from "../src/translation/openaiProvider";
import type {
  GlossaryEntry,
  ReviewAnnotationDraft,
  ReviewRequest,
  ThinkingMode,
  TranslationProvider,
} from "../src/translation/types";

interface CliOptions {
  manifest: string;
  provider: "mock" | "openai";
  annotationsDir?: string;
  outDir: string;
  filter?: string;
  label: string;
  baseline?: string;
  model?: string;
  baseUrl?: string;
  apiKeyEnv: string;
  caseConcurrency: number;
  concurrency: number;
  thinking: ThinkingMode;
  timeoutMs: number;
}

const USAGE = `Usage: npm run eval:annotations -- [options]

Options:
  --manifest <path>       Dataset manifest (default: eval/review/manifest.json)
  --provider <name>       mock | openai (default: mock)
  --annotations-dir <dir> Re-evaluate saved <case-id>.json annotations without calling a provider
  --out <dir>             Report output directory (default: eval/reports/annotations/<timestamp>)
  --filter <text>         Only run cases whose id or tags contain text
  --label <name>          Label stored in the report (default: current)
  --baseline <report>     Compare with a previous report.json
  --model <name>          Override model (openai provider)
  --base-url <url>        Override base URL (openai provider)
  --api-key-env <name>    Environment variable containing the API key (default: MBS_API_KEY)
  --case-concurrency <n>  Cases to evaluate in parallel (default: 4)
  --concurrency <n>       Provider request concurrency (default: MBS_CONCURRENCY or 8)
  --thinking <mode>       on | off | default
  --timeout <ms>          Per-request timeout (default: MBS_TIMEOUT_MS or 120000)
  --help                  Show this help

Environment for openai provider:
  MBS_API_KEY, MBS_API_BASE_URL, MBS_API_MODEL, MBS_CONCURRENCY,
  MBS_TIMEOUT_MS, MBS_THINKING=enabled|disabled|default
`;

function resolveThinking(value: unknown): ThinkingMode {
  const raw = String(value ?? process.env.MBS_THINKING ?? "")
    .trim()
    .toLowerCase();
  if (raw === "on" || raw === "enabled" || raw === "true" || raw === "1") {
    return "enabled";
  }
  if (
    raw === "off" ||
    raw === "disabled" ||
    raw === "false" ||
    raw === "0"
  ) {
    return "disabled";
  }
  if (raw && raw !== "default") {
    throw new Error(
      `Unknown --thinking value "${raw}". Use on, off, or default.`,
    );
  }
  return "default";
}

function numberOption(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const numeric = Number(value ?? fallback);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }
  return Math.min(maximum, Math.max(minimum, Math.trunc(numeric)));
}

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") {
    return fallback;
  }
  const numeric = Number(raw);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function parseCli(): CliOptions | undefined {
  const { values } = parseArgs({
    options: {
      manifest: { type: "string" },
      provider: { type: "string" },
      "annotations-dir": { type: "string" },
      out: { type: "string" },
      filter: { type: "string" },
      label: { type: "string" },
      baseline: { type: "string" },
      model: { type: "string" },
      "base-url": { type: "string" },
      "api-key-env": { type: "string" },
      "case-concurrency": { type: "string" },
      concurrency: { type: "string" },
      thinking: { type: "string" },
      timeout: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: false,
  });
  if (values.help) {
    console.log(USAGE);
    return undefined;
  }
  const provider = String(values.provider ?? "mock");
  if (provider !== "mock" && provider !== "openai") {
    throw new Error(`Unknown provider "${provider}". Use mock or openai.`);
  }
  return {
    manifest: path.resolve(
      String(values.manifest ?? "eval/review/manifest.json"),
    ),
    provider,
    ...(values["annotations-dir"]
      ? { annotationsDir: path.resolve(String(values["annotations-dir"])) }
      : {}),
    outDir: path.resolve(
      String(
        values.out ??
          path.join(
            "eval",
            "reports",
            "annotations",
            new Date().toISOString().replace(/[:.]/g, "-"),
          ),
      ),
    ),
    ...(values.filter ? { filter: String(values.filter) } : {}),
    label: String(values.label ?? "current"),
    ...(values.baseline ? { baseline: path.resolve(String(values.baseline)) } : {}),
    ...(values.model ? { model: String(values.model) } : {}),
    ...(values["base-url"] ? { baseUrl: String(values["base-url"]) } : {}),
    apiKeyEnv: String(values["api-key-env"] ?? "MBS_API_KEY"),
    caseConcurrency: numberOption(values["case-concurrency"], 4, 1, 16),
    concurrency: numberOption(
      values.concurrency,
      envNumber("MBS_CONCURRENCY", 8),
      1,
      100,
    ),
    thinking: resolveThinking(values.thinking),
    timeoutMs: numberOption(
      values.timeout,
      envNumber("MBS_TIMEOUT_MS", 120_000),
      1_000,
      600_000,
    ),
  };
}

async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await readFile(file, "utf8")) as T;
}

function createProvider(options: CliOptions): {
  provider: TranslationProvider;
  label: string;
  model: string;
} {
  if (options.provider === "mock") {
    return {
      provider: new MockTranslationProvider(),
      label: "mock",
      model: "mock",
    };
  }
  const apiKey = process.env[options.apiKeyEnv]?.trim();
  if (!apiKey) {
    throw new Error(
      `Missing API key. Set ${options.apiKeyEnv} before running the openai provider.`,
    );
  }
  const baseUrl =
    options.baseUrl ??
    process.env.MBS_API_BASE_URL ??
    "https://api.openai.com/v1";
  const model = options.model ?? process.env.MBS_API_MODEL ?? "gpt-4o-mini";
  const provider = new OpenAITranslationProvider({
    getConfig: () => ({
      baseUrl,
      model,
      apiKey,
      batchSize: 50,
      tokenBudget: 2_000,
      timeoutMs: options.timeoutMs,
      thinking: options.thinking,
    }),
    limiter: new ConcurrencyLimiter(() => options.concurrency),
  });
  return { provider, label: "openai", model };
}

function matchesFilter(item: ReviewEvalCase, filter: string | undefined): boolean {
  if (!filter) return true;
  const needle = filter.toLowerCase();
  return (
    item.id.toLowerCase().includes(needle) ||
    (item.tags ?? []).some((tag) => tag.toLowerCase().includes(needle))
  );
}

function mergeGlossary(
  base: readonly GlossaryEntry[],
  extra: readonly GlossaryEntry[] | undefined,
): GlossaryEntry[] {
  const bySource = new Map<string, GlossaryEntry>();
  for (const entry of [...base, ...(extra ?? [])]) {
    bySource.set(entry.source.toLowerCase(), entry);
  }
  return [...bySource.values()];
}

function validateExpected(caseId: string, item: ReviewEvalCase): string[] {
  const issues: string[] = [];
  const ids = new Set<string>();
  for (const expected of item.expected) {
    if (!expected.blockId) {
      issues.push(`${caseId}: expected issue is missing blockId`);
    }
    if (ids.has(`${expected.blockId}/${expected.description ?? ""}`)) {
      issues.push(`${caseId}: duplicate expected issue for ${expected.blockId}`);
    }
    ids.add(`${expected.blockId}/${expected.description ?? ""}`);
    if (expected.match.length === 0) {
      issues.push(`${caseId}: expected issue has no match terms`);
    }
    if (!expected.option) continue;
    if (expected.option.kind === "advice" && expected.option.mode) {
      issues.push(`${caseId}: advice must not declare mode`);
    }
    if (
      expected.option.minCount !== undefined &&
      expected.option.minCount < 1
    ) {
      issues.push(`${caseId}: minCount must be at least 1`);
    }
  }
  return issues;
}

async function runPool<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const run = async (): Promise<void> => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) {
        return;
      }
      results[index] = await worker(items[index], index);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => run()),
  );
  return results;
}

async function main(): Promise<void> {
  const options = parseCli();
  if (!options) return;

  const manifest = await readJson<ReviewEvalManifest>(options.manifest);
  if (!manifest.sourceLanguage || !manifest.targetLanguage) {
    throw new Error("Manifest must define sourceLanguage and targetLanguage.");
  }
  if (!Array.isArray(manifest.cases) || manifest.cases.length === 0) {
    throw new Error("Manifest must contain at least one case.");
  }
  const manifestDir = path.dirname(options.manifest);
  const allIssues: string[] = [];
  const ids = new Set<string>();
  const selectedCases = manifest.cases.filter((item) =>
    matchesFilter(item, options.filter),
  );
  if (selectedCases.length === 0) {
    throw new Error("No cases matched --filter.");
  }

  const prepared = await Promise.all(
    selectedCases.map(async (item) => {
      if (!item.id || ids.has(item.id)) {
        allIssues.push(`Manifest contains an empty or duplicate case id: "${item.id}"`);
      }
      ids.add(item.id);
      const sourcePath = path.resolve(manifestDir, item.source);
      const targetPath = path.resolve(manifestDir, item.target);
      const sourceText = await readFile(sourcePath, "utf8");
      const targetText = await readFile(targetPath, "utf8");
      const content = buildReviewCaseContent(sourceText, targetText);
      const issues = [
        ...content.issues.map((issue) => `${item.id}: ${issue}`),
        ...validateExpected(item.id, item),
      ];
      for (const expected of item.expected) {
        if (!content.blockTexts[expected.blockId]) {
          issues.push(
            `${item.id}: expected block "${expected.blockId}" is not a translatable block`,
          );
        }
      }
      allIssues.push(...issues);
      return { item, sourcePath, targetPath, content };
    }),
  );
  if (allIssues.length > 0) {
    throw new Error(`Invalid review manifest:\n${allIssues.join("\n")}`);
  }

  const providerInfo = options.annotationsDir
    ? { provider: undefined, label: "annotations-dir", model: undefined }
    : createProvider(options);
  const prompt = buildReviewSystemPrompt(
    manifest.sourceLanguage,
    manifest.targetLanguage,
    manifest.outputLanguage ?? manifest.targetLanguage,
  );
  await mkdir(path.join(options.outDir, "annotations"), { recursive: true });
  await writeFile(path.join(options.outDir, "prompt.txt"), `${prompt}\n`, "utf8");

  const outputs = await runPool(
    prepared,
    options.caseConcurrency,
    async ({ item, sourcePath, targetPath, content }) => {
      const startedAt = Date.now();
      let annotations: EvaluateReviewCaseInput["annotations"] = [];
      let error: string | undefined;
      const glossary = mergeGlossary(manifest.glossary ?? [], item.glossary);
      const request: ReviewRequest = {
        sourceLanguage: manifest.sourceLanguage,
        targetLanguage: manifest.targetLanguage,
        outputLanguage: manifest.outputLanguage ?? manifest.targetLanguage,
        ...(item.summary ?? manifest.summary
          ? { summary: item.summary ?? manifest.summary }
          : {}),
        ...(item.brief ?? manifest.brief
          ? { brief: item.brief ?? manifest.brief }
          : {}),
        glossary,
        items: content.items,
      };
      try {
        if (options.annotationsDir) {
          annotations = await readJson<ReviewAnnotationDraft[]>(
            path.join(options.annotationsDir, `${item.id}.json`),
          );
        } else {
          if (!providerInfo.provider?.review) {
            throw new Error("Provider does not support review.");
          }
          annotations = await providerInfo.provider.review(request);
        }
        await writeFile(
          path.join(options.outDir, "annotations", `${item.id}.json`),
          `${JSON.stringify(annotations, null, 2)}\n`,
          "utf8",
        );
      } catch (caught) {
        error = caught instanceof Error ? caught.message : String(caught);
        console.error(`[${item.id}] ${error}`);
      }
      const evaluation = evaluateReviewCase({
        id: item.id,
        tags: item.tags,
        annotations,
        expected: item.expected,
        blockTexts: content.blockTexts,
        glossary,
        durationMs: Date.now() - startedAt,
        ...(error ? { error } : {}),
      });
      return {
        ...evaluation,
        sourcePath,
        targetPath,
      };
    },
  );

  const report = createReviewReport({
    provider: providerInfo.label,
    model: providerInfo.model,
    label: options.label,
    sourceLanguage: manifest.sourceLanguage,
    targetLanguage: manifest.targetLanguage,
    outputLanguage: manifest.outputLanguage ?? manifest.targetLanguage,
    systemPrompt: prompt,
    cases: outputs,
    notes: [
      "Automatic metrics are discovery aids; read human-review.md before judging quality.",
      "Legacy suggestion/suggestedAnswers outputs are normalized to advice/instruction for the baseline.",
    ],
  });

  const baseline = options.baseline
    ? await readJson<ReviewReport>(options.baseline)
    : undefined;
  const comparison = baseline
    ? formatReviewComparison(report, baseline)
    : undefined;
  if (comparison) {
    await writeFile(
      path.join(options.outDir, "comparison.md"),
      comparison,
      "utf8",
    );
  }
  await writeFile(
    path.join(options.outDir, "report.json"),
    formatReviewJson(report),
    "utf8",
  );
  await writeFile(
    path.join(options.outDir, "report.md"),
    formatReviewMarkdown(report),
    "utf8",
  );
  await writeFile(
    path.join(options.outDir, "human-review.md"),
    formatReviewHumanReview(report),
    "utf8",
  );

  const aggregate = aggregateReviewEvaluations(outputs);
  console.log(
    [
      `Cases: ${aggregate.caseCount}`,
      `Precision: ${(aggregate.precision * 100).toFixed(1)}%`,
      `Recall: ${(aggregate.recall * 100).toFixed(1)}%`,
      `Clean FP: ${aggregate.cleanFalsePositiveCases} case(s) / ${aggregate.cleanFalsePositiveAnnotations} annotation(s)`,
      `Option coverage: ${(aggregate.optionCoverage * 100).toFixed(1)}%`,
      `Standalone: ${(aggregate.standaloneRate * 100).toFixed(1)}%`,
      `Mode accuracy: ${(aggregate.modeAccuracy * 100).toFixed(1)}%`,
      `Prompt: ${report.promptChars} chars / ${report.promptLines} lines`,
      `Reports: ${options.outDir}`,
    ].join("\n"),
  );
  if (comparison) {
    console.log("\nComparison:\n" + comparison);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
