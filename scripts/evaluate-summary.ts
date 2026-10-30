/**
 * 摘要/文档术语表生成质量评估 CLI（开发者工具，不进入 VSIX）。
 *
 * 用法：
 *   npm run eval:summary -- --provider mock
 *   MBS_API_KEY=... npm run eval:summary -- --provider openai \
 *     --model deepseek-ai/DeepSeek-V3.2 \
 *     --base-url https://api.siliconflow.cn/v1 \
 *     --out eval/reports/summary/baseline
 *
 * 默认复用 eval/manifest.json 的 source 文档和用户术语表，逐篇调用 Provider.summarize，
 * 同时记录模型原始术语表与产品过滤后的术语表。报告区分 raw/filtered 指标，便于判断
 * 提示词改善与确定性过滤各自的贡献。API Key 只从环境变量读取，不写入报告。
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { parseArgs } from "node:util";
import {
  buildDocumentMetadata,
  stripFrontmatterText,
} from "../src/markdown/documentMetadata";
import { createMarkdownRuntime } from "../src/markdown/markdown";
import { parseMarkdownDocument } from "../src/markdown/segmenter";
import {
  evaluateSummaryCase,
  type SummaryCaseEvaluation,
} from "../src/evaluation/summaryMetrics";
import {
  createSummaryReport,
  formatSummaryHumanReview,
  formatSummaryJson,
  formatSummaryMarkdown,
  type SummaryCaseReport,
} from "../src/evaluation/summaryReport";
import { filterGeneratedGlossary } from "../src/glossary/generatedGlossary";
import { ConcurrencyLimiter } from "../src/translation/concurrency";
import { MockTranslationProvider } from "../src/translation/mockProvider";
import {
  buildSummarySystemPrompt,
  OpenAITranslationProvider,
} from "../src/translation/openaiProvider";
import type {
  GlossaryEntry,
  SummaryResult,
  ThinkingMode,
  TranslationProvider,
} from "../src/translation/types";

interface EvalCaseRef {
  id: string;
  source: string;
  tags?: string[];
}

interface EvalManifest {
  sourceLanguage: string;
  targetLanguage: string;
  outputLanguage?: string;
  glossary?: GlossaryEntry[];
  cases: EvalCaseRef[];
}

interface CliOptions {
  manifest: string;
  provider: "mock" | "openai";
  outDir: string;
  filter?: string;
  model?: string;
  baseUrl?: string;
  apiKeyEnv: string;
  caseConcurrency: number;
  concurrency: number;
  thinking: ThinkingMode;
  timeoutMs: number;
  filterGenerated: boolean;
  minOccurrences: number;
}

const USAGE = `Usage: npm run eval:summary -- [options]

Options:
  --manifest <path>       Dataset manifest (default: eval/manifest.json)
  --provider <name>       mock | openai (default: mock)
  --out <dir>             Report output directory (default: eval/reports/summary/<timestamp>)
  --filter <text>         Only run cases whose id or tags contain text
  --model <name>          Override model (openai provider)
  --base-url <url>        Override base URL (openai provider)
  --api-key-env <name>    Environment variable containing the API key (default: MBS_API_KEY)
  --case-concurrency <n>  Cases to evaluate in parallel (default: 4)
  --concurrency <n>       Provider request concurrency (default: MBS_CONCURRENCY or 4)
  --thinking <mode>       on | off | default (default: MBS_THINKING or default)
  --timeout <ms>          Per-request timeout (default: MBS_TIMEOUT_MS or 180000)
  --min-occurrences <n>   Filter entries used fewer than n times (default: 2)
  --no-filter             Do not apply the deterministic generated-glossary filter
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
      out: { type: "string" },
      filter: { type: "string" },
      model: { type: "string" },
      "base-url": { type: "string" },
      "api-key-env": { type: "string" },
      "case-concurrency": { type: "string" },
      concurrency: { type: "string" },
      thinking: { type: "string" },
      timeout: { type: "string" },
      "min-occurrences": { type: "string" },
      "no-filter": { type: "boolean" },
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
    manifest: path.resolve(String(values.manifest ?? "eval/manifest.json")),
    provider,
    outDir: path.resolve(
      String(
        values.out ??
          path.join(
            "eval",
            "reports",
            "summary",
            new Date().toISOString().replace(/[:.]/g, "-"),
          ),
      ),
    ),
    ...(values.filter ? { filter: String(values.filter) } : {}),
    ...(values.model ? { model: String(values.model) } : {}),
    ...(values["base-url"] ? { baseUrl: String(values["base-url"]) } : {}),
    apiKeyEnv: String(values["api-key-env"] ?? "MBS_API_KEY"),
    caseConcurrency: numberOption(
      values["case-concurrency"],
      4,
      1,
      16,
    ),
    concurrency: numberOption(
      values.concurrency,
      envNumber("MBS_CONCURRENCY", 4),
      1,
      100,
    ),
    thinking: resolveThinking(values.thinking),
    timeoutMs: numberOption(
      values.timeout,
      envNumber("MBS_TIMEOUT_MS", 180_000),
      1_000,
      600_000,
    ),
    filterGenerated: values["no-filter"] !== true,
    minOccurrences: numberOption(values["min-occurrences"], 2, 1, 100),
  };
}

async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await readFile(file, "utf8")) as T;
}

function matchesFilter(item: EvalCaseRef, filter: string | undefined): boolean {
  if (!filter) return true;
  const needle = filter.toLowerCase();
  return (
    item.id.toLowerCase().includes(needle) ||
    (item.tags ?? []).some((tag) => tag.toLowerCase().includes(needle))
  );
}

interface ProviderBundle {
  provider: TranslationProvider;
  label: string;
  model?: string;
  diagnostics?: {
    responseCount: number;
    reasoningResponses: number;
  };
}

function createProvider(options: CliOptions): ProviderBundle {
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
    "https://api.siliconflow.cn/v1";
  const model =
    options.model ??
    process.env.MBS_API_MODEL ??
    "deepseek-ai/DeepSeek-V3.2";
  const diagnostics = { responseCount: 0, reasoningResponses: 0 };
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
    onResponse: (info) => {
      diagnostics.responseCount += 1;
      if (info.hasReasoning) {
        diagnostics.reasoningResponses += 1;
      }
    },
  });
  return { provider, label: "openai", model, diagnostics };
}

function emptyResult(): SummaryResult {
  return { summary: "", glossary: [] };
}

function summarizeWithFilter(
  result: SummaryResult,
  sourceText: string,
  options: {
    enabled: boolean;
    minOccurrences: number;
    reservedSources: readonly string[];
  },
): {
  filtered: SummaryResult;
  dropped: ReturnType<typeof filterGeneratedGlossary>["dropped"];
} {
  if (!options.enabled) {
    return { filtered: result, dropped: [] };
  }
  const filtered = filterGeneratedGlossary(result.glossary, sourceText, {
    minOccurrences: options.minOccurrences,
    reservedSources: options.reservedSources,
  });
  return {
    filtered: { ...result, glossary: filtered.entries },
    dropped: filtered.dropped,
  };
}

async function main(): Promise<void> {
  const options = parseCli();
  if (!options) return;

  const manifest = await readJson<EvalManifest>(options.manifest);
  if (!manifest.sourceLanguage || !manifest.targetLanguage) {
    throw new Error("Manifest must define sourceLanguage and targetLanguage.");
  }
  if (!Array.isArray(manifest.cases) || manifest.cases.length === 0) {
    throw new Error("Manifest must contain at least one case.");
  }
  const selected = manifest.cases.filter((item) =>
    matchesFilter(item, options.filter),
  );
  if (selected.length === 0) {
    throw new Error("No cases matched --filter.");
  }

  const providerInfo = createProvider(options);
  const summarize = providerInfo.provider.summarize?.bind(
    providerInfo.provider,
  );
  if (!summarize) {
    throw new Error("Selected provider does not support summary generation.");
  }
  const outputLanguage = manifest.outputLanguage ?? manifest.targetLanguage;
  const manifestDir = path.dirname(options.manifest);
  await mkdir(path.join(options.outDir, "candidates"), { recursive: true });

  const reports = new Array<SummaryCaseReport | undefined>(selected.length);
  let completed = 0;
  let nextIndex = 0;
  const startedAt = Date.now();

  const runCase = async (index: number): Promise<void> => {
    const item = selected[index];
    const sourcePath = path.resolve(manifestDir, item.source);
    const sourceText = await readFile(sourcePath, "utf8");
    const md = createMarkdownRuntime();
    const sourceDocument = parseMarkdownDocument(sourceText, md);
    const rawFrontmatter = sourceDocument.frontmatter?.raw;
    const bodyText = stripFrontmatterText(sourceText, rawFrontmatter);
    const relativePath = path
      .relative(process.cwd(), sourcePath)
      .split(path.sep)
      .join("/");
    const metadata = buildDocumentMetadata(rawFrontmatter, relativePath);
    const title = metadata?.title ?? metadata?.name ?? `${item.id}.md`;
    const caseStartedAt = Date.now();
    let result = emptyResult();
    let error: string | undefined;
    try {
      result = await summarize({
        text: bodyText,
        sourceLanguage: manifest.sourceLanguage,
        targetLanguage: manifest.targetLanguage,
        outputLanguage,
        title,
        ...(metadata ? { documentMetadata: metadata } : {}),
        ...(manifest.glossary ? { glossary: manifest.glossary } : {}),
      });
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
      console.error(`[${item.id}] ${error}`);
    }

    const summary = summarizeWithFilter(result, bodyText, {
      enabled: options.filterGenerated,
      minOccurrences: options.minOccurrences,
      reservedSources: (manifest.glossary ?? []).map((entry) => entry.source),
    });
    const evaluationInput = {
      id: item.id,
      tags: item.tags ?? [],
      sourceText: bodyText,
      userGlossary: manifest.glossary,
    };
    const raw: SummaryCaseEvaluation = evaluateSummaryCase({
      ...evaluationInput,
      result,
    });
    const filtered: SummaryCaseEvaluation = evaluateSummaryCase({
      ...evaluationInput,
      result: summary.filtered,
    });
    const candidatePath = path.join(
      options.outDir,
      "candidates",
      `${item.id}.json`,
    );
    await writeFile(
      candidatePath,
      `${JSON.stringify(
        {
          id: item.id,
          sourcePath: relativePath,
          title,
          ...(metadata ? { documentMetadata: metadata } : {}),
          rawGlossary: result.glossary,
          filteredGlossary: summary.filtered.glossary,
          dropped: summary.dropped,
          summary: result.summary,
          brief: result.brief,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    reports[index] = {
      id: item.id,
      tags: item.tags ?? [],
      sourcePath: relativePath,
      candidatePath,
      durationMs: Date.now() - caseStartedAt,
      ...(error ? { error } : {}),
      raw,
      filtered,
      dropped: summary.dropped,
    };
    completed += 1;
    console.log(
      `[${completed}/${selected.length}] ${item.id}: raw ${raw.glossaryCount}, filtered ${filtered.glossaryCount}, invalid ${filtered.invalidGlossaryCount}, words ${filtered.summaryWords}${error ? ", runner error" : ""}`,
    );
  };

  const workerCount = Math.min(options.caseConcurrency, selected.length);
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (true) {
        const index = nextIndex;
        nextIndex += 1;
        if (index >= selected.length) {
          return;
        }
        await runCase(index);
      }
    }),
  );

  const caseReports = reports.filter(
    (item): item is SummaryCaseReport => item !== undefined,
  );
  if (caseReports.length !== selected.length) {
    throw new Error(
      `Expected ${selected.length} case reports, got ${caseReports.length}.`,
    );
  }
  const totalCaseDurationMs = caseReports.reduce(
    (sum, item) => sum + item.durationMs,
    0,
  );
  const wallDurationMs = Date.now() - startedAt;
  const report = createSummaryReport({
    provider: providerInfo.label,
    ...(providerInfo.model ? { model: providerInfo.model } : {}),
    filterGenerated: options.filterGenerated,
    sourceLanguage: manifest.sourceLanguage,
    targetLanguage: manifest.targetLanguage,
    cases: caseReports,
    timing: {
      caseConcurrency: options.caseConcurrency,
      ...(options.provider === "openai"
        ? {
            requestConcurrency: options.concurrency,
            thinkingMode: options.thinking,
            ...(providerInfo.diagnostics
              ? {
                  responseCount: providerInfo.diagnostics.responseCount,
                  reasoningResponses:
                    providerInfo.diagnostics.reasoningResponses,
                }
              : {}),
          }
        : {}),
      totalCaseDurationMs,
      wallDurationMs,
    },
    notes: [
      options.filterGenerated
        ? `Filtered metrics apply the production deterministic filter (min occurrences: ${options.minOccurrences}; user glossary terms are reserved); raw metrics show the provider output before filtering.`
        : "Deterministic filtering was disabled; raw and filtered metrics are identical.",
      "Summary generation has no automatic retry; each case is a single provider request.",
      "Human review is required: automatic metrics cannot decide whether a term is worth keeping.",
    ],
  });

  await writeFile(
    path.join(options.outDir, "prompt.txt"),
    buildSummarySystemPrompt(
      manifest.sourceLanguage,
      manifest.targetLanguage,
      outputLanguage,
    ),
    "utf8",
  );
  await writeFile(
    path.join(options.outDir, "report.json"),
    formatSummaryJson(report),
    "utf8",
  );
  await writeFile(
    path.join(options.outDir, "report.md"),
    formatSummaryMarkdown(report),
    "utf8",
  );
  await writeFile(
    path.join(options.outDir, "human-review.md"),
    formatSummaryHumanReview(report),
    "utf8",
  );

  console.log(
    `Reports: ${path.join(options.outDir, "report.md")} (JSON + human review alongside)`,
  );
  console.log(
    `Filtered glossary: ${report.aggregate.filtered.totalGlossaryEntries} entries, ${report.aggregate.filtered.totalInvalidEntries} invalid, ${report.aggregate.filtered.totalSingleOccurrenceEntries} single-occurrence`,
  );
  console.log(
    `Raw glossary: ${report.aggregate.raw.totalGlossaryEntries} entries, ${report.aggregate.raw.totalInvalidEntries} invalid`,
  );
  if (report.failedCases > 0) {
    console.log(
      `Failed cases: ${report.failedCases} (excluded from aggregates)`,
    );
  }
  console.log(
    `Wall time: ${(wallDurationMs / 1000).toFixed(1)}s; case time: ${(totalCaseDurationMs / 1000).toFixed(1)}s; case concurrency: ${options.caseConcurrency}`,
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
