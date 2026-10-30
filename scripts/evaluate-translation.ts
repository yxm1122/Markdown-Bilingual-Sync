/**
 * 翻译质量评估 CLI（开发者工具，不进入 VSIX）。
 *
 * 用法：
 *   npm run eval:translation -- --provider mock
 *   MBS_API_KEY=... npm run eval:translation -- --provider openai --model gpt-4o-mini
 *   npm run eval:translation -- --candidate-dir ./candidate-output
 *
 * 默认从 eval/manifest.json 读取用例，逐篇生成候选译文，计算自动指标并写出
 * report.md / report.json / human-review.md。API Key 只从环境变量读取，不写入报告。
 * Mock Provider 只用于验证评估管线，不代表真实翻译质量。
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { parseArgs } from "node:util";
import { buildExportMarkdown } from "../src/export/exportMarkdown";
import { createMarkdownRuntime } from "../src/markdown/markdown";
import { evaluateCase } from "../src/evaluation/metrics";
import {
  createEvaluationReport,
  formatEvaluationJson,
  formatEvaluationMarkdown,
  formatHumanReviewMarkdown,
  type EvaluationCaseReport,
} from "../src/evaluation/report";
import { syncDocument } from "../src/sync/sync";
import { normalizeGlossaryEntries } from "../src/glossary/glossary";
import { ConcurrencyLimiter } from "../src/translation/concurrency";
import type {
  GlossaryEntry,
  ThinkingMode,
  TranslationProvider,
} from "../src/translation/types";
import { MockTranslationProvider } from "../src/translation/mockProvider";
import { OpenAITranslationProvider } from "../src/translation/openaiProvider";

interface EvalCaseRef {
  id: string;
  source: string;
  reference?: string;
  tags?: string[];
  notes?: string;
}

interface EvalManifest {
  sourceLanguage: string;
  targetLanguage: string;
  glossary?: GlossaryEntry[];
  cases: EvalCaseRef[];
}

interface CliOptions {
  manifest: string;
  provider: "mock" | "openai";
  candidateDir?: string;
  outDir: string;
  filter?: string;
  glossary?: string;
  model?: string;
  baseUrl?: string;
  apiKeyEnv: string;
  caseConcurrency: number;
  concurrency: number;
  thinking: ThinkingMode;
  batchSize: number;
  tokenBudget: number;
  timeoutMs: number;
}

const USAGE = `Usage: npm run eval:translation -- [options]

Options:
  --manifest <path>       Dataset manifest (default: eval/manifest.json)
  --provider <name>       mock | openai (default: mock)
  --candidate-dir <dir>   Evaluate <id>.md files instead of calling a provider
  --out <dir>             Report output directory (default: eval/reports/<timestamp>)
  --filter <text>         Only run cases whose id or tags contain text
  --glossary <path>       Override the manifest glossary with a JSON array or a summary candidate JSON
  --model <name>          Override model (openai provider)
  --base-url <url>        Override base URL (openai provider)
  --api-key-env <name>    Environment variable containing the API key (default: MBS_API_KEY)
  --case-concurrency <n>  Cases to evaluate in parallel (default: 4)
  --concurrency <n>       Provider request concurrency (default: MBS_CONCURRENCY or 8)
  --thinking <mode>       on | off | default (default: MBS_THINKING or disabled env)
  --disable-thinking      Alias for --thinking off (enable_thinking:false)
  --enable-thinking       Alias for --thinking on (enable_thinking:true)
  --batch-size <n>        Max blocks per provider request (default: MBS_BATCH_SIZE or 50)
  --batch-token-budget <n> Estimated token budget per request (default: MBS_BATCH_TOKEN_BUDGET or 2000)
  --timeout <ms>          Per-request timeout (default: MBS_TIMEOUT_MS or 120000)
  --help                  Show this help

Environment for openai provider:
  MBS_API_KEY, MBS_API_BASE_URL, MBS_API_MODEL, MBS_BATCH_SIZE,
  MBS_BATCH_TOKEN_BUDGET, MBS_TIMEOUT_MS, MBS_CONCURRENCY,
  MBS_THINKING=enabled|disabled|default, MBS_DISABLE_THINKING=1 (legacy)
`;

/** 解析 --thinking / MBS_THINKING 的取值；未知值直接报错。 */
function resolveThinking(
  value: string | boolean | undefined,
  disableFlag: boolean,
  enableFlag: boolean,
): ThinkingMode {
  const normalize = (raw: string): ThinkingMode | undefined => {
    const clean = raw.trim().toLowerCase();
    if (clean === "on" || clean === "enabled" || clean === "true" || clean === "1") {
      return "enabled";
    }
    if (clean === "off" || clean === "disabled" || clean === "false" || clean === "0") {
      return "disabled";
    }
    if (clean === "default") {
      return "default";
    }
    return undefined;
  };

  if (typeof value === "string" && value.trim()) {
    const mode = normalize(value);
    if (!mode) {
      throw new Error(
        `Unknown --thinking value "${value}". Use on, off, or default.`,
      );
    }
    return mode;
  }
  if (disableFlag) {
    return "disabled";
  }
  if (enableFlag) {
    return "enabled";
  }
  const envRaw = (process.env.MBS_THINKING ?? "").trim();
  if (envRaw) {
    const mode = normalize(envRaw);
    if (mode) {
      return mode;
    }
    throw new Error(
      `Unknown MBS_THINKING value "${envRaw}". Use enabled, disabled, or default.`,
    );
  }
  return process.env.MBS_DISABLE_THINKING === "1" ? "disabled" : "default";
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

/** 读取数值型环境变量；缺失或非法时使用 fallback。 */
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
      "candidate-dir": { type: "string" },
      out: { type: "string" },
      filter: { type: "string" },
      glossary: { type: "string" },
      model: { type: "string" },
      "base-url": { type: "string" },
      "api-key-env": { type: "string" },
      "case-concurrency": { type: "string" },
      concurrency: { type: "string" },
      thinking: { type: "string" },
      "disable-thinking": { type: "boolean" },
      "enable-thinking": { type: "boolean" },
      "batch-size": { type: "string" },
      "batch-token-budget": { type: "string" },
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
  const thinking = resolveThinking(
    values.thinking,
    values["disable-thinking"] === true,
    values["enable-thinking"] === true,
  );
  return {
    manifest: path.resolve(String(values.manifest ?? "eval/manifest.json")),
    provider,
    ...(values["candidate-dir"]
      ? { candidateDir: path.resolve(String(values["candidate-dir"])) }
      : {}),
    outDir: path.resolve(
      String(
        values.out ??
          path.join(
            "eval",
            "reports",
            new Date().toISOString().replace(/[:.]/g, "-"),
          ),
      ),
    ),
    ...(values.filter ? { filter: String(values.filter) } : {}),
    ...(values.glossary
      ? { glossary: path.resolve(String(values.glossary)) }
      : {}),
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
      envNumber("MBS_CONCURRENCY", 8),
      1,
      100,
    ),
    thinking,
    batchSize: numberOption(
      values["batch-size"],
      envNumber("MBS_BATCH_SIZE", 50),
      1,
      50,
    ),
    tokenBudget: numberOption(
      values["batch-token-budget"],
      envNumber("MBS_BATCH_TOKEN_BUDGET", 2_000),
      500,
      32_000,
    ),
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

interface ProviderDiagnostics {
  responseCount: number;
  reasoningResponses: number;
  retryEvents: number;
  retryByReason: Record<string, number>;
}

function createProvider(options: CliOptions): {
  provider: TranslationProvider;
  label: string;
  model: string;
  diagnostics?: ProviderDiagnostics;
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
  const diagnostics: ProviderDiagnostics = {
    responseCount: 0,
    reasoningResponses: 0,
    retryEvents: 0,
    retryByReason: {},
  };
  const provider = new OpenAITranslationProvider({
    getConfig: () => ({
      baseUrl,
      model,
      apiKey,
      batchSize: options.batchSize,
      tokenBudget: options.tokenBudget,
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
    onRetry: (info) => {
      diagnostics.retryEvents += 1;
      for (const reason of info.reasons) {
        diagnostics.retryByReason[reason] =
          (diagnostics.retryByReason[reason] ?? 0) + 1;
      }
    },
  });
  return { provider, label: "openai", model, diagnostics };
}

function matchesFilter(item: EvalCaseRef, filter: string | undefined): boolean {
  if (!filter) return true;
  const needle = filter.toLowerCase();
  return (
    item.id.toLowerCase().includes(needle) ||
    (item.tags ?? []).some((tag) => tag.toLowerCase().includes(needle))
  );
}

interface TranslatedCase {
  text: string;
  partial: boolean;
  failures: string[];
}

async function translateCase(
  sourceText: string,
  provider: TranslationProvider,
  manifest: EvalManifest,
): Promise<TranslatedCase> {
  const md = createMarkdownRuntime();
  const result = await syncDocument({
    md,
    sourceText,
    provider,
    sourceLanguage: manifest.sourceLanguage,
    targetLanguage: manifest.targetLanguage,
    retranslateStale: true,
    retranslateAll: true,
    glossary: manifest.glossary ?? [],
    assist: { stableTranslation: false },
    // 评估保留成功的批次：单个批次超时/失败时仍能评估已完成部分，
    // 而不是丢掉整篇候选；缺失块会由指标正常报出。
    allowPartial: true,
  });
  return {
    text: buildExportMarkdown({
      md,
      sourceText,
      cacheText: result.cacheText,
    }).text,
    partial: result.partial,
    failures: result.failures,
  };
}

async function main(): Promise<void> {
  const options = parseCli();
  if (!options) return;

  const manifest = await readJson<EvalManifest>(options.manifest);
  if (options.glossary) {
    const raw = await readJson<unknown>(options.glossary);
    let entries: unknown;
    if (Array.isArray(raw)) {
      entries = raw;
    } else if (raw && typeof raw === "object") {
      const record = raw as Record<string, unknown>;
      entries =
        record.filteredGlossary ??
        record.rawGlossary ??
        record.glossary;
    }
    if (!Array.isArray(entries)) {
      throw new Error(
        "--glossary must point to a JSON array or a summary candidate JSON with a glossary array.",
      );
    }
    manifest.glossary = normalizeGlossaryEntries(entries);
  }
  if (!manifest.sourceLanguage || !manifest.targetLanguage) {
    throw new Error("Manifest must define sourceLanguage and targetLanguage.");
  }
  if (!Array.isArray(manifest.cases) || manifest.cases.length === 0) {
    throw new Error("Manifest must contain at least one case.");
  }
  const ids = new Set<string>();
  for (const item of manifest.cases) {
    if (!item.id || ids.has(item.id)) {
      throw new Error(`Manifest contains an empty or duplicate case id: "${item.id}".`);
    }
    ids.add(item.id);
  }

  const providerInfo = options.candidateDir
    ? undefined
    : createProvider(options);
  await mkdir(path.join(options.outDir, "candidates"), { recursive: true });

  const manifestDir = path.dirname(options.manifest);
  const selected = manifest.cases.filter((item) =>
    matchesFilter(item, options.filter),
  );
  if (selected.length === 0) {
    throw new Error("No cases matched --filter.");
  }

  const caseStartedAt = Date.now();
  const reportsByIndex = new Array<EvaluationCaseReport | undefined>(
    selected.length,
  );
  let completed = 0;
  let nextIndex = 0;

  const runCase = async (index: number): Promise<void> => {
    const item = selected[index];
    const sourcePath = path.resolve(manifestDir, item.source);
    const referencePath = item.reference
      ? path.resolve(manifestDir, item.reference)
      : undefined;
    const sourceText = await readFile(sourcePath, "utf8");
    const referenceText = referencePath
      ? await readFile(referencePath, "utf8")
      : undefined;
    const startedAt = Date.now();
    let candidateText = "";
    let error: string | undefined;
    let candidatePath: string | undefined;

    try {
      if (options.candidateDir) {
        candidatePath = path.resolve(options.candidateDir, `${item.id}.md`);
        candidateText = await readFile(candidatePath, "utf8");
      } else if (providerInfo) {
        const translated = await translateCase(
          sourceText,
          providerInfo.provider,
          manifest,
        );
        candidateText = translated.text;
        candidatePath = path.join(options.outDir, "candidates", `${item.id}.md`);
        await writeFile(candidatePath, candidateText, "utf8");
        if (translated.partial || translated.failures.length > 0) {
          error =
            translated.failures.join("\n") ||
            "Provider returned a partial translation.";
        }
      }
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
      console.error(`[${item.id}] ${error}`);
    }

    const evaluation = evaluateCase({
      id: item.id,
      sourceText,
      candidateText,
      referenceText,
      glossary: manifest.glossary ?? [],
      tags: item.tags ?? [],
      sourceLanguage: manifest.sourceLanguage,
      targetLanguage: manifest.targetLanguage,
    });
    const durationMs = Date.now() - startedAt;
    reportsByIndex[index] = {
      ...evaluation,
      durationMs,
      ...(candidatePath ? { candidatePath } : {}),
      ...(referencePath ? { referencePath } : {}),
      ...(error ? { error } : {}),
    };
    completed += 1;
    const status = evaluation.metrics.pass ? "PASS" : "FAIL";
    console.log(
      `[${completed}/${selected.length}] ${item.id}: ${status} (${evaluation.metrics.issues.length} hard issue(s)${error ? ", runner error" : ""}, ${durationMs} ms)`,
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

  const reports = reportsByIndex.filter(
    (item): item is EvaluationCaseReport => item !== undefined,
  );
  if (reports.length !== selected.length) {
    throw new Error(
      `Expected ${selected.length} case reports, got ${reports.length}.`,
    );
  }
  const totalCaseDurationMs = reports.reduce(
    (sum, item) => sum + item.durationMs,
    0,
  );
  const wallDurationMs = Date.now() - caseStartedAt;
  const usesProvider = !options.candidateDir && options.provider === "openai";

  const report = createEvaluationReport({
    provider: options.candidateDir ? "candidate-dir" : providerInfo!.label,
    ...(providerInfo?.model ? { model: providerInfo.model } : {}),
    sourceLanguage: manifest.sourceLanguage,
    targetLanguage: manifest.targetLanguage,
    cases: reports,
    timing: {
      caseConcurrency: options.caseConcurrency,
      ...(usesProvider
        ? {
            requestConcurrency: options.concurrency,
            thinkingMode: options.thinking,
            ...(providerInfo?.diagnostics
              ? {
                  responseCount: providerInfo.diagnostics.responseCount,
                  reasoningResponses:
                    providerInfo.diagnostics.reasoningResponses,
                  retry: {
                    events: providerInfo.diagnostics.retryEvents,
                    byReason: providerInfo.diagnostics.retryByReason,
                  },
                }
              : {}),
          }
        : {}),
      totalCaseDurationMs,
      wallDurationMs,
    },
    notes: [
      ...(options.provider === "mock" && !options.candidateDir
        ? [
            "Mock provider output is a deterministic pipeline smoke test, not a translation-quality signal.",
          ]
        : []),
      ...(options.candidateDir
        ? ["Candidates were read from --candidate-dir; no provider was called."]
        : []),
      usesProvider
        ? `Thinking mode: ${options.thinking} (enabled sends enable_thinking:true, disabled sends false, default omits it).`
        : "Thinking/concurrency settings do not apply to this run.",
      ...(providerInfo?.diagnostics
        ? [
            `Reasoning responses: ${providerInfo.diagnostics.reasoningResponses}/${providerInfo.diagnostics.responseCount} (responses containing reasoning content or reasoning tokens).`,
          ]
        : []),
      "Reference similarity and length ratio are advisory only.",
      "Human scores are required for semantic accuracy and naturalness.",
    ],
  });

  await writeFile(
    path.join(options.outDir, "report.json"),
    formatEvaluationJson(report),
    "utf8",
  );
  await writeFile(
    path.join(options.outDir, "report.md"),
    formatEvaluationMarkdown(report),
    "utf8",
  );
  await writeFile(
    path.join(options.outDir, "human-review.md"),
    formatHumanReviewMarkdown(report),
    "utf8",
  );

  console.log(
    `Reports: ${path.join(options.outDir, "report.md")} (JSON + human review alongside)`,
  );
  console.log(
    `Cases: ${report.aggregate.caseCount}; passed: ${report.aggregate.passedCases}; failed: ${report.aggregate.failedCases}`,
  );
  console.log(
    `Wall time: ${(wallDurationMs / 1000).toFixed(1)}s; case time: ${(totalCaseDurationMs / 1000).toFixed(1)}s; case concurrency: ${options.caseConcurrency}`,
  );
  if (usesProvider && providerInfo?.diagnostics) {
    console.log(
      `Thinking: ${options.thinking}; reasoning responses: ${providerInfo.diagnostics.reasoningResponses}/${providerInfo.diagnostics.responseCount}`,
    );
    console.log(
      `Automatic retries: ${providerInfo.diagnostics.retryEvents} event(s)${
        Object.keys(providerInfo.diagnostics.retryByReason).length > 0
          ? ` (${Object.entries(providerInfo.diagnostics.retryByReason)
              .map(([reason, count]) => `${reason} ${count}`)
              .join(", ")})`
          : ""
      }`,
    );
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
