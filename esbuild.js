/**
 * 扩展构建脚本（Node / CommonJS）。
 *
 * 由 `npm run compile` 与 `npm run watch` 调用：
 * - `src/extension.ts` → `dist/extension.js`（CJS、Node 20、vscode external）；
 * - `src/webview/preview/index.tsx` → `dist/webview/preview.js`（浏览器 IIFE + Preact）；
 * - 其余媒体资源（CSS、Codicon、KaTeX）由 scripts/copy-*.mjs 复制。
 *
 * 与扩展主进程的通信：不涉及运行时消息；这里只读写 dist 目录。
 */
const esbuild = require("esbuild");

/** --watch 时进入增量监听，否则执行一次构建。 */
const watch = process.argv.includes("--watch");

/** 扩展宿主入口。 */
const extensionOptions = {
  entryPoints: ["src/extension.ts"],
  bundle: true,
  outfile: "dist/extension.js",
  external: ["vscode"],
  platform: "node",
  format: "cjs",
  target: "node20",
  sourcemap: true,
  logLevel: "info",
};

/** Webview 预览入口；Preact 由 esbuild 打进同一个 IIFE。 */
const webviewOptions = {
  entryPoints: ["src/webview/preview/index.tsx"],
  bundle: true,
  outfile: "dist/webview/preview.js",
  platform: "browser",
  format: "iife",
  target: "chrome120",
  sourcemap: true,
  logLevel: "info",
  jsx: "automatic",
  jsxImportSource: "preact",
};

async function main() {
  if (watch) {
    const contexts = await Promise.all([
      esbuild.context(extensionOptions),
      esbuild.context(webviewOptions),
    ]);
    await Promise.all(contexts.map((context) => context.watch()));
    console.log("esbuild: watching extension + webview");
    return;
  }
  await Promise.all([
    esbuild.build(extensionOptions),
    esbuild.build(webviewOptions),
  ]);
}

// 构建失败时以非零退出码结束，避免 CI / 打包脚本误用旧产物。
main().catch((error) => {
  console.error(error);
  process.exit(1);
});
