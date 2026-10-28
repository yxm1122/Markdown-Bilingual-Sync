# 测试指南

测试目标：在不启动真实 VS Code、不访问真实 Provider 的前提下，覆盖切块、缓存、对齐、同步、编辑、导出、导入、分批与预览 HTML。Webview 另有 jsdom 组件测试、headless Edge 截图矩阵与 320 块性能基线；真实 Extension Host、真实主题注入与输入法仍需隔离 profile 手动 E2E 补足。

## 1. 命令

```bash
npm run typecheck     # TypeScript strict 检查
npm test              # Vitest 全量运行（含 jsdom Webview 组件测试）
npm run test:watch    # 监听模式（启动前自动生成 l10n bundle）
npm run preview:sample  # 生成静态预览 HTML
npm run ui:matrix     # 三主题 × 三布局 × 三模式 + 关键状态截图（需要 Edge）
npm run ui:perf       # 320 块性能基线（需要 Edge，含 4× CPU 降速）
npm run eval:translation -- --provider mock  # 翻译质量评估管线烟测
npm run package       # 构建 + 打包 VSIX
```

CI 会依次执行 `npm ci`、`typecheck`、`test`、`package`。本地提交前至少执行前三项；改 UI 时再跑 `ui:matrix` 与 `ui:perf`。

## 2. 测试栈

- **Vitest 3**：纯逻辑测试运行在 Node 中，不启动 VS Code；Webview 组件测试在文件头用 `@vitest-environment jsdom` 切换环境。
- **jsdom + Testing Library**：`@testing-library/preact` 挂载真实组件树；`test/webview/harness.ts` 负责注入文案、模拟 `acquireVsCodeApi`、记录上行消息，`test/webview/dom.ts` 补齐 jsdom 缺失的 `<dialog>`、`CSS.escape` 与 `localStorage`。jsdom 固定在 29.x：30.x 要求 Node ≥22.22，而 CI 使用 Node 20；升级 jsdom 前先同步提高 CI 的 Node 版本。
- **全局 `vscode` stub**：`vitest.config.ts` 把 `vscode` alias 到 `test/vscodeStub.ts`。stub 的 `l10n.t` 从 `l10n/bundle.l10n.zh-cn.json` 取译文，默认 locale 为 `zh-cn`，因此现有中文断言可直接保留；需要英文 locale 的用例在 `vi.resetModules()` 后修改 stub 的 `env.language`。
- **局部 mock**：需要断言 `vscode` 调用的测试仍用 `vi.mock("vscode")` / `vi.hoisted`，并展开 stub 以保留 `l10n`/`env`（见 `test/cacheStore.test.ts`、`test/syncEditing.test.ts`、`test/exportService.test.ts`）。
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
| `batching.test.ts` | token 估算、块数/预算、并发均衡、摘要上下文、文档/小节边界 |
| `batchCoordinator.test.ts` | 跨文件合并、复合 id 路由、摘要/brief/context/annotations 隔离、文档标识分配、单调用取消 |
| `concurrency.test.ts` | 全局限制器 FIFO/取消/计数、文件 worker |
| `batchFiles.test.ts` | 目录扫描、导出文件过滤、路径边界 |
| `openaiProvider.test.ts` | 请求体、JSON 校验、重试、提示词/回声拒绝、脱敏、摘要/brief、context、annotations、审校、连接测试 |
| `blockContext.test.ts` | 单块标题/段落/回译邻块上下文、section 边界、大块与 token 上限 |
| `genericHttpProvider.test.ts` | 模板变量、响应路径/纯文本、脱敏、错误处理 |
| `mockProvider.test.ts` | 演示 Provider 输出契约 |
| `presets.test.ts` | Provider 预设唯一性与合法值 |
| `previewModel.test.ts` | 块状态、统计、分栏/只读/占位、摘要面板、HTML 转义、悬停提示 |
| `taskMonitor.test.ts` | 任务状态机、取消、历史快照 |
| `language.test.ts` | markdown/skill 支持、manifest 激活与菜单条件 |
| `evaluationMetrics.test.ts` | 遗漏/回显、受保护片段、术语、结构、frontmatter、参考相似度等评估指标 |
| `evaluationDataset.test.ts` | 17 个评估用例的结构/术语/参考译文自洽性 |
| `consistency.test.ts` | 译后术语/受保护 Markdown 检查、人工锁定块跳过、无缓存处理 |
| `documentGlossary.test.ts` | 文档术语表文本格式解析、去重、行号错误与条数上限 |
| `i18nCatalog.test.ts` | en/zh key 与占位符一致性、bundle 新鲜度、中/英文 locale 行为 |
| `i18nErrors.test.ts` | 错误 key 唯一性、bundle 覆盖、中/英文 `tError` 行为 |
| `i18nFormat.test.ts` | 英文/中文日期格式、英文预览 Webview 与稳定 provider 显示名 |
| `i18nUnused.test.ts` | UI_TEXT 与错误目录的未引用 key 检查 |
| `htmlEscaping.test.ts` | 本地化文案含引号/尖括号时的 HTML 转义 |
| `packageNls.test.ts` | `%key%` 引用完整性、品牌字段/命令/设置与双语言 key 集合 |
| `taskViewProvider.test.ts` | 任务 TreeView 节点、状态图标/详情、语言切换作用域与交换回滚 |
| `appShell.test.ts` | 原生预览首屏 CSP、资源 URI、初始状态 JSON、文案注入与转义 |
| `webview/app.render.test.tsx` | 首屏、统计、模式/布局切换、分栏只读、空状态、控件无障碍名称 |
| `webview/app.scroll.test.tsx` | 虚拟块几何下的分栏双向同步、仅原文/仅译文切换位置还原、顶部/底部对齐 |
| `webview/app.editing.test.tsx` | 译文/原文编辑、待插入/独立译文、插入、删除/撤销、链接、菜单键盘导航、滚动关闭菜单、选择文本不误触编辑 |
| `webview/app.summary.test.tsx` | 文档简报/brief/术语卡内容自适应与分侧揭示、内联编辑/焦点恢复、assist 开关、提示条/toast、宿主刷新时草稿保持、忙碌、脚注 |
| `webview/app.annotations.test.tsx` | 批注标记、popover 焦点与草稿回显、保存/核对/删除/按批注重译 |
| `webview/glossaryModel.test.ts` | 术语表文本解析/序列化/校验/规范化 |
| `annotationStore.test.ts` | 本机批注 sidecar 往返/sourceIndex、损坏备份、字段裁剪、删除 |
| `syncAnnotations.test.ts` | 审校批注替换、用户批注保留、未翻译批注迁移、并发写、stale 过滤、token 分批、删除块拒绝、状态/删除 |
| `webview/app.dialogs.test.tsx` | 导出/原文 diff、写入态竞态、错误恢复、关闭与焦点 |
| `webview/bridge.test.ts` | 首屏 JSON、格式化、VS Code API 与静态预览 localStorage 回退 |

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

依赖 `vscode` 的适配层默认由全局 stub 提供；需要精确断言调用时，用 `vi.mock("vscode")` 覆盖并展开 `test/vscodeStub.ts` 的实现。常见需要：

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

### 4.5 预览壳、组件测试与视觉/性能脚本

生产预览由 `buildPreviewAppShell` + `src/webview/preview/app.tsx` 渲染：

- `appShell.test.ts` 断言 CSP、资源 URI、初始状态 JSON、文案注入和 `</script>` 转义；
- `test/webview/*.test.tsx` 在 jsdom 中挂载真实 Preact 组件，断言用户可见行为与上行消息，不读内部 state；
- `previewModel.test.ts` 仍用旧的字符串渲染器（`src/preview/html.ts`，仅测试/历史参考）断言模型字段、统计和 HTML 转义；
- 真实 Webview 的主题注入、IME、HiDPI 与窗口缩放仍需隔离 profile 手动 E2E。

#### 4.5.1 组件测试入口

`test/webview/harness.ts` 在动态 import `app.tsx` 之前完成三件事：

1. 往页面写入 `#mbs-ui-text`（真实 `UI_TEXT`），因为 `InlineEditor` 等组件仍从 bridge 的模块级 catalog 取取消按钮文案；
2. 安装 `acquireVsCodeApi`，把 `send()` 的上行消息收集到 `messages`，并让 `getState/setState` 使用内存对象；
3. 调用 `installDomPolyfills()` 补齐 jsdom 的 `<dialog>.showModal`、`CSS.escape` 与 Storage。

用法：

```ts
// @vitest-environment jsdom
const harness = await loadHarness();
beforeEach(() => resetHarness());
const { container } = render(<harness.App boot={makeBoot(makeModel())} text={harness.text} />);
fireEvent.input(within(block).getByRole("textbox"), { target: { value: "新译文" } });
expect(actions(harness)).toContainEqual({ type: "saveTargetEdit", text: "新译文", /* ... */ });
```

- 宿主消息用 `postHostMessage({ type: "state", state })` 模拟，内部会包 `act()`；
- 夹具在 `test/webview/fixtures.ts`：`makeBlock` / `makeModel` / `makeBoot` / `makeExportConfirmation`；
- 断言优先用角色、`aria-label`、标题和可见文本，避免绑定 class；结构性查询（如 `.pv-split`）只用于布局存在性。
- 内联编辑与插入的草稿现在由编辑器本地持有；状态更新时用 `textarea` 同一节点与 `document.activeElement` 验证焦点/草稿保持。
- 分栏滚动用 `app.scroll.test.tsx` 的虚拟几何（每块 50px、视口 300px）验证锚点映射；模式切换的真实重排另由 `ui:matrix` 的 split 截图与 headless 检查补充。

#### 4.5.2 截图矩阵

```bash
npm run ui:matrix
```

脚本先由 `render-sample` 生成 `tmp/preview-matrix-{dark,light,hc}.html` 与 `preview-empty-*.html`，再用 headless Edge 驱动生产 Webview 脚本，输出到 `artifacts/ui-matrix/`：

- 三主题 × 三布局（columns/stacked/split）× 三模式（bilingual/source/target）= 27 张；
- 每主题另拍 summary、brief、glossary、glossary-edit、annotations、export-dialog、source-dialog、editing、block-menu、split-readonly、busy、narrow(900×900)、empty，共 66 张；
- `manifest.json` 记录视口、实际 PNG 尺寸、布局/模式/只读状态、横向溢出与控制台错误；
- 每个主题还会验证分栏“仅原文 → 仅译文 → 仅原文 → 双语”的滚动落点，要求另一侧回到同一块；
- `index.html` 是联系表，`report.md` 是汇总；
- 任一状态出现横向溢出、运行时异常或尺寸不一致，脚本以非零退出。

静态主题是 VS Code 默认主题的令牌近似值，不是真实主题注入；它用于布局、对比度和状态色回归，不替代真实 Webview 检查。

#### 4.5.3 性能基线

```bash
npm run ui:perf
```

生成 320 个顶层块（约 550 KiB HTML、1.25 万 DOM 节点）的文档，在 headless Edge 中测量：

- 首屏挂载与首块绘制；
- 布局/模式切换、宿主 `state` 更新、100 次连续输入；
- 正文滚动与分栏滚动同步的帧间隔（p95/max）；
- 在 4× CPU 降速下复测布局、更新、输入与滚动。

产物在 `artifacts/ui-perf/`：`report.json`、`report.md`、`300-blocks.png`。预算失败会非零退出。当前基线（1440×960，本机）：

| 路径 | 1× CPU | 4× CPU |
| --- | --- | --- |
| 首屏挂载 | ~60–70ms | — |
| 布局切换（320 块） | ~130–150ms | ~1.0s |
| 模式切换 | ~40–75ms | ~0.4s |
| 宿主 state 更新 | ~32ms | ~50–100ms |
| 100 次输入 | ~600ms（含每次让出任务） | ~3.4s |
| 正文/分栏滚动帧 | 16.7–16.8ms | 33–50ms |

数字是本机基线，不是跨机器 SLA；4× 用于放大主线程问题。内联编辑草稿由编辑器局部持有、分栏同步只锁“回声侧”，这两条是保持大文档输入与滚动可用的关键。

### 4.6 本地化

- `src/i18n/catalog.ts` 的 `collectCatalogIssues` 校验 en/zh key、占位符与错误目录；`buildL10nBundles` 还会拒绝同一英文对应不同中文。
- `test/i18nCatalog.test.ts` 断言磁盘上的两份 bundle 与目录生成结果一致；修改文案后必须运行 `npm run l10n:build`。
- `test/packageNls.test.ts` 校验 `package.json` 中每个 `%key%` 在两个 `package.nls*.json` 中都存在且无未使用 key。
- 默认测试 locale 为 zh-cn；英文 locale 行为用 `vi.resetModules()` + 动态 import 覆盖，并在用例结束恢复 `env.language`。
- Webview 测试断言 `<html lang>`、本地化注入文案与 `Intl` 日期格式；真实 VS Code 语言切换仍需用 `--locale=zh-cn` / `--locale=en` 手动验证。

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
- 真实 Webview 注入的主题变量、`prefers-reduced-motion`、系统输入法候选框、HiDPI 与窗口拖拽缩放。截图矩阵使用静态主题近似值，且 headless 浏览器通常报告 reduced motion。
- 真实 Webview 的 CSP、`localResourceRoots`、消息时序与 Webview 生命周期；jsdom 不会执行 CSP。
- 真实 Provider 的网络、鉴权、模型输出差异。
- 跨窗口/多进程并发；`withLock` 只保证本进程内互斥。
- 极端 Markdown 结构、真实用户缓存的历史兼容；性能基线只覆盖合成的 320 块文档。
- 打包后的 VSIX 在干净 profile 中的安装/升级行为。

截图矩阵与性能基线依赖本机 Edge，CI 不运行；CI 通过只代表静态检查、单元/组件测试与打包成功。如果修改涉及上述区域，请在 PR/提交说明中写清手动验证步骤与结果。

## 8. 翻译质量评估

`npm run eval:translation` 会读取 `eval/` 的 17 个用例，生成候选译文、自动指标与人工评分表。`--provider mock` 只用于验证管线；真实质量评估需要手动配置 Provider Key 并运行，详见 [翻译质量评估](evaluation.md)。评估数据集本身由 `evaluationDataset.test.ts` 在 `npm test` 中校验。
