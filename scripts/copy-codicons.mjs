/**
 * Codicon 静态资源复制脚本（Node ESM，`npm run compile` 的一环）。
 *
 * 把 @vscode/codicons 的 CSS、字体与许可证复制到 media/codicons，供 Webview 使用。
 * 只复制渲染需要的文件，避免把整个包带进 VSIX。
 */
import { copyFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const source = path.join(root, "node_modules", "@vscode", "codicons", "dist");
const target = path.join(root, "media", "codicons");

if (!existsSync(source)) {
  console.error("@vscode/codicons dist not found. Run npm install first.");
  process.exit(1);
}

await mkdir(target, { recursive: true });
for (const file of ["codicon.css", "codicon.ttf"]) {
  await copyFile(path.join(source, file), path.join(target, file));
}
const license = path.join(root, "node_modules", "@vscode", "codicons", "LICENSE");
if (existsSync(license)) {
  await copyFile(license, path.join(target, "LICENSE"));
}

console.log("Codicon assets copied to media/codicons");
