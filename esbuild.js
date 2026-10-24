/**
 * 扩展构建脚本（Node / CommonJS）。
 *
 * 由 `npm run compile` 与 `npm run watch` 调用，把 src/extension.ts 及其依赖打包为
 * dist/extension.js（CJS、Node 20、`vscode` 模块保持 external），并生成 sourcemap。
 * Webview 侧的 media/preview.js、media/taskView.js 是原生浏览器脚本，不经过 esbuild，
 * 由 VS Code 直接加载；本脚本只负责扩展主进程产物。
 *
 * 与扩展主进程的通信：不涉及运行时消息；这里只读写 dist 目录。
 */
const esbuild = require("esbuild");

/** --watch 时进入增量监听，否则执行一次构建。 */
const watch = process.argv.includes("--watch");

/**
 * 打包配置。
 *
 * - outfile 与 package.json 的 `main` 保持一致（入口为 src/extension.ts）；
 * - external: ["vscode"]：该模块由 VS Code 宿主注入，不能被打进 bundle；
 * - format: "cjs" + platform: "node" 匹配扩展宿主加载方式；
 * - sourcemap 仅用于本地调试，.vscodeignore 已把 dist 下的 .map 文件排除出 vsix。
 */
const options = {
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

/**
 * 根据命令行参数选择监听或单次构建。
 * 监听模式会保留 esbuild 的 watcher，因此进程持续存活直到手动结束。
 */
async function main() {
  if (watch) {
    const ctx = await esbuild.context(options);
    await ctx.watch();
    console.log("esbuild: watching");
    return;
  }
  await esbuild.build(options);
}

// 构建失败时以非零退出码结束，避免 CI / 打包脚本误用旧产物。
main().catch((error) => {
  console.error(error);
  process.exit(1);
});
