/**
 * KaTeX 静态资源复制脚本（Node ESM，`npm run compile` 的一环）。
 *
 * 把 node_modules/katex/dist 中的 katex.min.css、fonts 与 LICENSE 复制到 media/katex，
 * 让 Webview 能通过 localResourceRoots 内的相对路径加载公式样式与字体，同时避免把整个
 * katex 包（含未使用的 JS）打进 vsix。
 *
 * 运行环境：Node（建议 20.11+，用到了 import.meta.dirname）。与扩展主进程无通信，
 * 只读写仓库文件；失败时以非零退出码结束，阻断后续打包。
 */
import { cp, mkdir, copyFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

// 以脚本所在目录定位仓库根，保证从任意工作目录运行 `node scripts/copy-katex.mjs` 都正确。
const root = path.resolve(import.meta.dirname, "..");
const katexDist = path.join(root, "node_modules", "katex", "dist");
const target = path.join(root, "media", "katex");

// 未安装依赖时给出可操作的提示，而不是让 cp 抛出 ENOENT 堆栈。
if (!existsSync(katexDist)) {
  console.error("katex dist not found. Run npm install first.");
  process.exit(1);
}

// mkdir(recursive) 负责创建 media/katex，cp 会自行创建目标 fonts 子目录。
await mkdir(target, { recursive: true });
await cp(path.join(katexDist, "fonts"), path.join(target, "fonts"), {
  recursive: true,
});
await copyFile(
  path.join(katexDist, "katex.min.css"),
  path.join(target, "katex.min.css"),
);

// KaTeX 为 MIT 许可，发布物中包含其字体与 CSS 时需要一并携带 LICENSE。
const license = path.join(root, "node_modules", "katex", "LICENSE");
if (existsSync(license)) {
  await copyFile(license, path.join(target, "LICENSE"));
}

console.log("KaTeX assets copied to media/katex");
