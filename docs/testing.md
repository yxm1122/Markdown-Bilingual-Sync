# 测试指南

测试目标：在不启动真实 VS Code、不访问真实 Provider 的前提下，覆盖切块、缓存、对齐、同步、编辑、导出、导入、分批与预览 HTML；真实 Extension Host 与 Webview 行为用隔离 profile 手动 E2E 补足。

## 1. 命令

```bash
npm run typecheck     # TypeScript strict 检查
npm test              # Vitest 全量运行
npm run test:watch    # 监听模式
npm run preview:sample  # 生成静态预览 HTML
npm run package       # 构建 + 打包 VSIX
```

CI 会依次执行 `npm ci`、`typecheck`、`test`、`package`。本地提交前至少执行前三项。

## 2. 测试栈

- **Vitest 3**：测试运行在 Node 中，不启动 VS Code。
- **VS Code API mock**：依赖 `vscode` 的适配层测试使用 `vi.mock("vscode")` / `vi.hoisted` 提供最小桩（见 `test/cacheStore.test.ts`、`test/syncEditing.test.ts`、`test/exportService.test.ts`）。
- **共享样例**：`test/helpers.ts` 提供 `SOURCE`、`makeMd()`、`translate()`（Mock Provider 同步）和 `inspect()`（解析 + 对齐）。
- **无真实网络**：Provider 测试使用假响应或注入配置；不要调用真实 API。

## 3. 测试文件分工

| 文件 | 覆盖内容 |
| --- | --- |
| `anchors.test.ts` | 锚点解析/序列化、摘要标记、损坏/重复锚点、未跟踪内容 |
| `segmenter.test.ts` | 顶层块切分、frontmatter、残行保留、块类型 |
| `sync.test.ts` | 同步主流程、人工/复制/删除、缓存重建；对齐状态也在这里间接覆盖 |
| `syncEditing.test.ts` | 译文编辑/删除/撤销、回译、摘要生成/保存/清除、assist 开关、锁定 |
| `syncPartial.test.ts` | 部分成功、渐进式落盘、取消、失败保留 |
| `editCache.test.ts` | 单块缓存替换、`markSynced`、结构校验 |
| `editSource.test.ts` | 原文编辑/删除/插入的行级合成 |
| `cacheStore.test.ts` | 缓存路径安全、读写、删除、清空 |
| `summaryMarker.test.ts` | 摘要标记往返、源文哈希、非法/重复标记 |
| `export.test.ts` | 导出块顺序、target-only、删除墓碑、复制、统计 |
| `exportService.test.ts` | 导出准备、覆盖确认、写盘、未保存文档 |
| `diffPreview.test.ts` | 行级 diff、截断、新建文件 |
| `importTranslation.test.ts` | 导入结构校验、human 锁定、锚点拒绝 |
| `batching.test.ts` | token 估算、块数/预算、并发均衡、摘要上下文 |
| `batchCoordinator.test.ts` | 跨文件合并、复合 id 路由、摘要隔离、单调用取消 |
| `concurrency.test.ts` | 全局限制器 FIFO/取消/计数、文件 worker |
| `batchFiles.test.ts` | 目录扫描、导出文件过滤、路径边界 |
| `openaiProvider.test.ts` | 请求体、JSON 校验、重试、提示词/回声拒绝、脱敏、摘要、连接测试 |
| `genericHttpProvider.test.ts` | 模板变量、响应路径/纯文本、脱敏、错误处理 |
| `mockProvider.test.ts` | 演示 Provider 输出契约 |
| `presets.test.ts` | Provider 预设唯一性与合法值 |
| `previewModel.test.ts` | 块状态、统计、分栏/只读/占位、摘要面板、HTML 转义、悬停提示 |
| `taskMonitor.test.ts` | 任务状态机、取消、历史快照 |
| `language.test.ts` | markdown/skill 支持、manifest 激活与菜单条件 |

`align.ts` 没有独立测试文件，对齐逻辑通过 `sync`、`previewModel`、`export` 和 `syncEditing` 测试间接覆盖。修改对齐算法时应主动补充直接用例。

## 4. 写测试的约定

### 4.1 纯逻辑

直接导入函数，构造最小输入。示例：

```ts
import { parseMarkdownDocument } from "../src/markdown/segmenter";
import { createMarkdownRuntime } from "../src/markdown/markdown";

const source = parseMarkdownDocument("# Title\n\nBody", createMarkdownRuntime());
```

### 4.2 缓存/锚点

优先使用真实序列化函数构造测试缓存，而不是手写字符串：

```ts
import { serializeAnchor } from "../src/markdown/anchors";
import { blockHash } from "../src/util/hash";

const anchor = serializeAnchor({
  id: "block1",
  kind: "paragraph",
  src: blockHash("paragraph", "Source."),
  dst: blockHash("paragraph", "译文。"),
  mode: "auto",
});
```

这样可以保证测试数据与解析器同步演进；只有测试“损坏缓存”时才手写坏字符串。

### 4.3 VS Code 适配层

对 `vscode` 的依赖用 `vi.mock("vscode")` 提供最小桩。常见需要：

- `workspace.getConfiguration`
- `workspace.fs.readFile/writeFile/stat/delete`
- `workspace.openTextDocument`
- `window.showWarningMessage/showErrorMessage`
- `WorkspaceEdit` / `workspace.applyEdit`
- `Uri.joinPath` / `with` / `toString`

不要试图在 Vitest 中加载真实 `vscode` 模块；它只在 Extension Host 中存在。

### 4.4 Provider

- 用假 `fetch` 或注入配置测试请求构造、响应解析、错误脱敏、重试和取消。
- 用 Mock Provider 测试同步/预览，不要依赖网络。
- 新增 Provider 时至少覆盖：成功、缺块/重复/空结果、HTTP 错误、取消、密钥不出现在错误文本。

### 4.5 预览 HTML

`buildPreviewHtml` / `buildPreviewModel` 是纯函数，可以断言：

- 动态文本被转义；
- 按钮带正确的 `data-action` / `data-*`；
- 只读/占位/摘要面板状态；
- 两个 assist 开关的 `title` 提示存在。

这类测试不能替代真实浏览器渲染；CSS 布局、滚动同步、拖拽、焦点陷阱仍需手动 E2E。

## 5. CI

`.github/workflows/ci.yml`：

1. Ubuntu + Node 20；
2. `npm ci`；
3. `npm run typecheck`；
4. `npm test`；
5. `npm run package`；
6. 上传 `artifacts/vsix/markdown-bilingual-sync.vsix`。

CI 不启动 Extension Host、不运行 Webview、不访问 Marketplace。CI 通过只代表静态检查、单元测试与打包成功。

## 6. 手动 E2E（隔离 profile）

使用独立的用户数据目录与扩展目录，避免污染日常 profile：

```bash
code --install-extension "<repo>/artifacts/vsix/markdown-bilingual-sync.vsix" --force \
  --extensions-dir "<repo>/tmp/dev-ext" \
  --user-data-dir "<repo>/tmp/dev-user"

code --user-data-dir "<repo>/tmp/dev-user" \
  --extensions-dir "<repo>/tmp/dev-ext" \
  --new-window "<repo>/samples"
```

在 `<repo>/tmp/dev-user/User/settings.json` 设置：

```json
{
  "markdownBilingualSync.provider": "mock"
}
```

建议验证：

1. **入口**：Markdown 与 `languageId=skill` 的文件都能看到命令/标题栏入口。
2. **同步**：Mock 同步生成缓存；块状态、统计、警告正确。
3. **摘要**：生成、编辑、保存、清除；源文修改后显示过期但仍参与上下文；两个 assist 开关有悬停说明。
4. **分栏**：只读切换、滚动同步、滚动位置保持、块级 ⋯ 菜单。
5. **编辑**：译文编辑锁定；译文删除/撤销；target-only 插入/删除/回译。
6. **原文写回**：暂存编辑/删除/插入 → diff 确认 → 写回；源文变化后暂存失效。
7. **导出/导入**：导出 diff modal、批量导出确认、结构不一致的导入被拒绝。
8. **批量与任务**：目录批量翻译、单文件取消、取消全部、任务面板与状态栏。
9. **重启**：布局偏好保留；只读状态重置。

测试结束后关闭窗口；`tmp/` 与 `artifacts/` 已被 `.gitignore` 忽略，不要提交。

## 7. 覆盖缺口

以下行为目前没有自动化覆盖，修改相关代码时必须手动验证：

- 真实 VS Code 激活事件、菜单条件、标题栏按钮。
- Webview 的 CSS 布局、滚动同步、焦点管理、modal 交互。
- CSP 与 `localResourceRoots` 在真实 Webview 中的加载行为。
- 真实 Provider 的网络、鉴权、模型输出差异。
- 跨窗口/多进程并发；`withLock` 只保证本进程内互斥。
- 大文档性能、极端 Markdown 结构、真实用户缓存的历史兼容。
- 打包后的 VSIX 在干净 profile 中的安装/升级行为。

如果修改涉及这些区域，请在 PR/提交说明中写清手动验证步骤与结果。
