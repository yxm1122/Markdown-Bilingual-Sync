/**
 * l10n bundle 生成脚本（tsx）。
 *
 * 运行：`npm run l10n:build`（由 npm run compile / vscode:prepublish 触发）。
 *
 * 输入：src/i18n/en.ts、src/i18n/zh.ts 与 src/i18n/errors/*.ts。
 * 输出：
 * - l10n/bundle.l10n.json：source 英文键值（key 与 value 相同）；
 * - l10n/bundle.l10n.zh-cn.json：英文键 -> 中文模板。
 *
 * 任一项校验失败（key 不一致、占位符不一致、重复英文对应不同中文）时以非零退出码
 * 结束，避免把不完整的 bundle 打进 VSIX。本脚本只写 l10n 目录，不读写其他产物。
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildL10nBundles } from "../src/i18n/catalog";

/** 稳定序列化：两空格缩进并以换行结尾，便于审阅 bundle diff。 */
function serialize(messages: Record<string, string>): string {
  return `${JSON.stringify(messages, null, 2)}\n`;
}

function main(): void {
  const { en, zh, messageCount } = buildL10nBundles();
  const outputDir = join(process.cwd(), "l10n");
  mkdirSync(outputDir, { recursive: true });
  writeFileSync(join(outputDir, "bundle.l10n.json"), serialize(en), "utf8");
  writeFileSync(
    join(outputDir, "bundle.l10n.zh-cn.json"),
    serialize(zh),
    "utf8",
  );
  console.log(
    `l10n: wrote ${messageCount} messages to l10n/bundle.l10n.json and l10n/bundle.l10n.zh-cn.json`,
  );
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
