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
import { ConcurrencyLimiter } from "../src/translation/concurrency";
import type { GlossaryEntry, TranslationProvider } from "../src/translation/types";
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
  model?: string;
  baseUrl?: string;
  apiKeyEnv: string;
}

const USAGE = `Usage: npm run eval:translation -- [options]

Options:
  --manifest <path>       Dataset manifest (default: eval/manifest.json)
  --provider <name>       mock | openai (default: mock)
  --candidate-dir <dir>   Evaluate <id>.md files instead of calling a provider
  --out <dir>             Report output directory (default: eval/reports/<timestamp>)
  --filter <text>         Only run cases whose id or tags contain text
  --model <name>          Override model (openai provider)
  --base-url <url>        Override base URL (openai provider)
  --api-key-env <name>    Environment variable containing the API key (default: MBS_API_KEY)
  --help                  Show this help

Environment for openai provider:
  MBS_API_KEY, MBS_API_BASE_URL, MBS_API_MODEL, MBS_BATCH_SIZE,
  MBS_BATCH_TOKEN_BUDGET, MBS_TIMEOUT_MS, MBS_CONCURRENCY, MBS_DISABLE_THINKING=1
`;

function parseCli(): CliOptions | undefined {
  const { values } = parseArgs({
    options: {
      manifest: { type: "string" },
      provider: { type: "string" },
      "candidate-dir": { type: "string" },
      out: { type: "string" },
      filter: { type: "string" },
      model: { type: "string" },
      "base-url": { type: "string" },
      "api-key-env": { type: "string" },
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
    ...(values.model ? { model: String(values.model) } : {}),
    ...(values["base-url"] ? { baseUrl: String(values["base-url"]) } : {}),
    apiKeyEnv: String(values["api-key-env"] ?? "MBS_API_KEY"),
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
  const concurrency = Number(process.env.MBS_CONCURRENCY ?? 8);
  const batchSize = Number(process.env.MBS_BATCH_SIZE ?? 50);
  const tokenBudget = Number(process.env.MBS_BATCH_TOKEN_BUDGET ?? 2_000);
  const timeoutMs = Number(process.env.MBS_TIMEOUT_MS ?? 120_000);
  const provider = new OpenAITranslationProvider({
    getConfig: () => ({
      baseUrl,
      model,
      apiKey,
      batchSize,
      tokenBudget,
      timeoutMs,
      disableThinking: process.env.MBS_DISABLE_THINKING === "1",
    }),
    limiter: new ConcurrencyLimiter(() => concurrency),
  });
  return { provider, label: "openai", model };
}

function matchesFilter(item: EvalCaseRef, filter: string | undefined): boolean {
  if (!filter) return true;
  const needle = filter.toLowerCase();
  return (
    item.id.toLowerCase().includes(needle) ||
    (item.tags ?? []).some((tag) => tag.toLowerCase().includes(needle))
  );
}

async function translateCase(
  sourceText: string,
  provider: TranslationProvider,
  manifest: EvalManifest,
): Promise<string> {
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
  });
  return buildExportMarkdown({
    md,
    sourceText,
    cacheText: result.cacheText,
  }).text;
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

  const reports: EvaluationCaseReport[] = [];
  for (let index = 0; index < selected.length; index += 1) {
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
        candidateText = await translateCase(
          sourceText,
          providerInfo.provider,
          manifest,
        );
        candidatePath = path.join(options.outDir, "candidates", `${item.id}.md`);
        await writeFile(candidatePath, candidateText, "utf8");
      }
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
      console.error(`[${index + 1}/${selected.length}] ${item.id}: ${error}`);
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
    reports.push({
      ...evaluation,
      durationMs: Date.now() - startedAt,
      ...(candidatePath ? { candidatePath } : {}),
      ...(referencePath ? { referencePath } : {}),
      ...(error ? { error } : {}),
    });
    const status = evaluation.metrics.pass ? "PASS" : "FAIL";
    console.log(
      `[${index + 1}/${selected.length}] ${item.id}: ${status} (${evaluation.metrics.issues.length} hard issue(s)${error ? ", runner error" : ""})`,
    );
  }

  const report = createEvaluationReport({
    provider: options.candidateDir ? "candidate-dir" : providerInfo!.label,
    ...(providerInfo?.model ? { model: providerInfo.model } : {}),
    sourceLanguage: manifest.sourceLanguage,
    targetLanguage: manifest.targetLanguage,
    cases: reports,
    notes: [
      ...(options.provider === "mock" && !options.candidateDir
        ? [
            "Mock provider output is a deterministic pipeline smoke test, not a translation-quality signal.",
          ]
        : []),
      ...(options.candidateDir
        ? ["Candidates were read from --candidate-dir; no provider was called."]
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
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
