/**
 * Vitest 配置：把运行时 `vscode` 模块全局 alias 到 test/vscodeStub.ts。
 *
 * 这样纯逻辑模块可以安全地通过 src/i18n/index.ts 间接使用 vscode.l10n，
 * 而无需每个测试重复 mock；需要自定义行为的测试仍可用 vi.mock("vscode")。
 */
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      vscode: fileURLToPath(new URL("./test/vscodeStub.ts", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    // Webview 组件测试在文件头用 `@vitest-environment jsdom` 单独切换环境。
    include: ["test/**/*.test.ts", "test/**/*.test.tsx"],
  },
});
