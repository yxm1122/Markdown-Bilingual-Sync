/**
 * 生成摘要/brief 边界提示词的评估候选（开发者工具，不进入 VSIX）。
 *
 * 当前生产提示词是 V3：新 coverage + boundary + no-repeat。
 * 本脚本从生产提示词出发，生成可回放的对照版本，写入 tmp/summary-prompts/：
 * - production.txt：当前生产提示词；
 * - v2-boundary.txt：移除 no-repeat（V2）；
 * - v1-coverage.txt：再移除 boundary（V1）；
 * - v0-legacy.txt：恢复旧的 coverage（旧基线）；
 * - v4-strong-boundary.txt：把 boundary 换成更强的“不要提及本地化说明”版本。
 *
 * 评估时配合 evaluate-summary --system-prompt-file 使用，避免改生产代码。
 */
import { mkdir, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { buildSummarySystemPrompt } from "../src/translation/openaiProvider";

const NEW_COVERAGE =
  "Cover the document's purpose and scope, its outline, and the key concepts or terminology a translator needs to understand it; keep the summary between 120 and 250 words.";

const OLD_COVERAGE =
  "Cover purpose and audience, document outline, key terminology, tone/style, and translation constraints; keep the summary between 120 and 250 words.";

const BOUNDARY =
  "The summary describes the document itself. Do not include audience targeting, tone or style guidance, terminology decisions, do-not-translate lists, or formatting rules; those belong only to brief.";

const STRONG_BOUNDARY =
  "The summary describes the document itself. Do not include or mention audience targeting, tone or style guidance, terminology decisions, do-not-translate lists, formatting rules, localization notes, or translation guidance; those belong only to brief, even if the document contains such a section.";

const NO_REPEAT =
  "Do not repeat the brief in the summary; if a sentence reads like an instruction to the translator, omit it from the summary.";

function withoutRule(prompt: string, rule: string): string {
  const lines = prompt.split("\n");
  const index = lines.indexOf(rule);
  if (index < 0) {
    throw new Error(`Prompt rule not found: ${rule}`);
  }
  lines.splice(index, 1);
  return lines.join("\n");
}

async function main(): Promise<void> {
  const production = buildSummarySystemPrompt("en", "zh-CN", "zh-CN");
  if (!production.includes(NEW_COVERAGE) || !production.includes(NO_REPEAT)) {
    throw new Error("Production summary prompt does not match the V3 layout.");
  }
  const v2 = withoutRule(production, NO_REPEAT);
  const v1 = withoutRule(v2, BOUNDARY);
  const v0 = v1.replace(NEW_COVERAGE, OLD_COVERAGE);
  const v4 = production.replace(BOUNDARY, STRONG_BOUNDARY);

  const outputDir = path.resolve("tmp/summary-prompts");
  await mkdir(outputDir, { recursive: true });
  const variants: Array<[string, string]> = [
    ["v0-legacy.txt", v0],
    ["v1-coverage.txt", v1],
    ["v2-boundary.txt", v2],
    ["production.txt", production],
    ["v4-strong-boundary.txt", v4],
  ];
  for (const [name, content] of variants) {
    const file = path.join(outputDir, name);
    await writeFile(file, `${content}\n`, "utf8");
    console.log(file);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
