# 预览与 Webview

双语预览是扩展最复杂的 UI：它把原文、译文缓存、未应用的原文暂存和导出确认合并到一个 Webview 中，并允许用户通过消息驱动写盘操作。

实现文件：

- 布局状态：[`src/preview/layout.ts`](../src/preview/layout.ts)
- 纯视图模型：[`src/preview/previewModel.ts`](../src/preview/previewModel.ts)
- HTML 生成：[`src/preview/html.ts`](../src/preview/html.ts)
- CSP/资源外壳：[`src/preview/webviewHtml.ts`](../src/preview/webviewHtml.ts)
- 面板控制器与消息路由：[`src/preview/previewManager.ts`](../src/preview/previewManager.ts)
- 浏览器侧脚本与样式：[`media/preview.js`](../media/preview.js)、[`media/preview.css`](../media/preview.css)

## 1. 渲染管线

```text
SyncService.loadPreviewState(sourceUri)
  → sourceText + cacheText + summary + 语言/Provider 标签
  → buildPreviewModel
       ├─ parseMarkdownDocument / parseCacheDocument
       ├─ alignDocument（块状态）
       ├─ 合并原文暂存与 target-only 块
       └─ 统计、警告、脚注 HTML、assist 状态
  → buildWebviewHtml
       ├─ 生成 nonce / CSP
       ├─ asWebviewUri 解析 media 资源
       └─ buildPreviewHtml（完整 HTML）
  → panel.webview.html
```

`PreviewManager` 每个源文件维护一个 `PreviewPanelSession`。刷新不是直接写 HTML，而是进入 `updateQueue` 串行执行；`updateVersion` 递增，只有最后一次异步更新可以写入页面。

## 2. 布局与只读

三种布局：

| 布局 | 说明 |
| --- | --- |
| `columns` | 原文与译文并排，按块成对显示 |
| `stacked` | 原文/译文交错堆叠 |
| `split` | 左右独立滚动栏，支持逐栏只读与块级滚动同步 |

- 布局值持久化在 `globalState` 的 `markdownBilingualSync.previewLayout`。
- 只读状态是**会话级**，不持久化；只影响 `split` 布局。
- 只读栏渲染为连续文档，隐藏块级操作与内联编辑；另一栏仍可编辑。
- 布局/只读切换不改变滚动位置，Webview 侧会捕获并恢复。
- 分栏下同一块的两侧使用相同的 `data-sync-key` 做滚动同步。

## 3. 视图模型

`PreviewBlockView` 是 Webview 的只读快照，关键字段：

- `key`：块唯一键；真实块为源块索引字符串，虚拟块带 `pending:` / `target:` 前缀。分栏滚动同步依赖它。
- `blockIndex`：真实块为非负索引；原文待插入为 `-1000 - n`，译文独占块为 `-3000 - n`。
- `sourceHtml` / `targetHtml`：已渲染的 HTML。
- `sourceRaw` / `targetRaw`：供内联编辑器回填。
- `sourceHash` / `cacheId`：保存译文时做乐观并发校验。
- `pendingInsertId` / `standaloneTargetId`：虚拟块标识，互斥。
- `human` / `stale` / `hasCache` / `canRetranslate` / `canMarkSynced` / `canEditTarget` / `canBackTranslate`：操作可用性。

`PreviewModel` 还包含：

- `counts`：total / translated / stale / human / untranslated / copy。
- `assist`：稳定翻译、摘要上下文、摘要面板状态。
- `warnings`：缓存/对齐/缺缓存等提示。
- `pendingSourceCount`：暂存修改/删除/插入总数。

模型是只读快照。任何写操作都必须回到 `PreviewManager`，不能在 Webview 内直接改数据。

## 4. 消息协议

Webview 只通过 `vscode.postMessage` 与宿主通信。宿主在 `PreviewManager.onMessage` 中按 `type` 白名单路由，并对字段做最小类型/整数校验；未知类型静默忽略。

### 4.1 Webview → 宿主

| type | 关键字段 | 作用 |
| --- | --- | --- |
| `setLayout` | `layout` | 切换布局并持久化 |
| `togglePaneReadonly` | `pane: source\|target` | 切换分栏只读 |
| `sync` | — | 同步译文 |
| `importTranslation` | — | 导入已有译文 |
| `retranslateStale` | — | 重译过期块 |
| `retranslateAll` | — | 重译全部机器译文 |
| `stageSourceEdit` | `blockIndex`, `text` | 暂存原文编辑 |
| `deleteSourceBlock` | `blockIndex` | 暂存删除原文块 |
| `undoDeleteSourceBlock` | `blockIndex` | 撤销暂存删除 |
| `insertSourceBlock` | `afterBlockIndex`, `text` | 暂存插入原文块；`-1` 表示文档开头 |
| `insertTargetBlock` | `afterBlockIndex`, `text` | 插入 target-only 译文块 |
| `updateStandaloneTarget` | `standaloneId`, `text` | 编辑 target-only 块 |
| `deleteTargetOnlyBlock` | `standaloneId` | 永久删除 target-only 块 |
| `backTranslateTargetOnly` | `standaloneId` | 回译 target-only 块并暂存原文插入 |
| `updateSourceInsert` | `pendingId`, `text` | 编辑待插入原文 |
| `removeSourceInsert` | `pendingId` | 移除待插入原文 |
| `saveTargetEdit` | `blockIndex`, `text`, `baseText`, `sourceHash`, `cacheId` | 保存译文编辑并锁定 |
| `deleteTargetBlock` | `blockIndex` | 删除译文（写墓碑） |
| `undoDeleteTargetBlock` | `blockIndex` | 撤销删除译文 |
| `backTranslate` | `blockIndex` | 回译成对块 |
| `applySourceEdits` | — | 生成原文 diff 并弹出确认 |
| `discardSourceEdits` | — | 丢弃全部原文暂存 |
| `writeSourceEdits` | — | 确认写回原文 |
| `generateSummary` | — | AI 生成摘要 |
| `saveSummary` | `summaryText` | 保存手动编辑的摘要 |
| `clearSummary` | — | 清除摘要 |
| `setAssistToggle` | `key`, `value` | 切换会话级稳定翻译/摘要上下文 |
| `export` | — | 打开导出确认 |
| `exportWrite` | — | 确认写入导出文件 |
| `exportCancel` | — | 取消导出 |
| `refresh` | — | 重新加载预览 |
| `editCache` | — | 打开缓存文件 |
| `openCacheFolder` | — | 在系统文件管理器中打开缓存目录 |
| `retranslateBlock` | `blockIndex` | 重译单块 |
| `markSynced` | `blockIndex` | 标记为已同步 |
| `revealSource` | `blockIndex` | 在编辑器中定位原文 |
| `openLink` | `href` | 打开外部链接 |

说明：

- “文档开头插入”在 Webview 内部转换为 `insertSourceBlock` + `afterBlockIndex = -1`；不是独立消息。
- `saveTargetEdit` 的三个并发字段由 Webview 从块数据属性带回，宿主会校验；任一不一致会拒绝写入，避免覆盖编辑期间的其他修改。
- `setAssistToggle` 只更新会话状态，不重绘页面，避免丢失摘要 textarea 的未保存内容。

### 4.2 宿主 → Webview

| type | 关键字段 | 作用 |
| --- | --- | --- |
| `busy` | `busy`, `message?` | 显示/解除忙碌态 |
| `toast` | `text`, `kind` | 面板内提示 |
| `sourceConfirm` | `data.destination`, `count`, `diff` | 打开原文写回确认框 |
| `sourceSettled` | — | 原文写回成功，关闭确认框 |
| `sourceError` | `message` | 写回失败，保留确认框展示错误 |
| `exportSettled` | `action: write\|cancel` | 导出写入/取消完成 |
| `exportError` | `message` | 导出写入失败 |

初始的导出/原文确认数据也会被序列化进页面（`application/json` 脚本标签），页面加载后自动打开对应 modal，保证刷新后仍能看到待确认状态。

## 5. 原文暂存与写回

原文暂存只存在于 `PreviewPanelSession` 内存中：

- `pendingSourceEdits: Map<blockIndex, {text, sourceHash}>`
- `pendingSourceDeletions: Set<blockIndex>`
- `pendingSourceInsertions: SourceInsertion[]`
- `pendingSourceBase`：暂存时的源文全文

流程：

1. 编辑/删除/插入只改暂存，不写文件。
2. `buildProposedSource` 按行号从下往上应用修改/删除/插入，生成新全文。
3. 比较当前磁盘文本与 proposed 文本，生成 diff。
4. 用户确认后 `writeSourceEdits`：
   - `WorkspaceEdit` 替换文档；
   - 保存源文件；
   - 解除被删源块的缓存锚点；
   - 提升 target-only 回译块；
   - 锁定成对回译块到新原文哈希。
5. 保存失败时用内存快照恢复文档；后续缓存对账失败只告警。

关键保护：

- 若 `pendingSourceBase` 与当前源文不一致，暂存失效，拒绝写回。
- 写回期间 `sourceWriteInFlight = true`，跳过刷新，避免读到中间态。
- 写回整体在 `SyncService.runWithSourceLock` 内，和同步互斥。
- 原文暂存会立即反映在预览中，但只有确认写回才改变源文件。

## 6. 译文编辑、插入、删除

- **编辑**：Webview 内联编辑器回填 `targetRaw`；保存时发 `saveTargetEdit`，宿主用 `baseText` / `sourceHash` / `cacheId` 做乐观校验，然后 `replaceCachedBlock` 写入缓存并把模式置为 `human`。
- **插入**：`insertTargetBlock` 在缓存中创建 `mode=target` 的独立块，锚点 `src` 为 `start` 或 `t-<hash>`；立即参与导出，不改原文。
- **删除**：`deleteTargetBlock` 写 `deleted` 墓碑并保留备份，可撤销；target-only 块用 `deleteTargetOnlyBlock` 永久删除。
- **回译**：成对块回译后进入原文暂存，写回时锁定缓存；target-only 块回译后生成原文插入，写回时提升为 `human`。

## 7. 摘要面板与 assist 开关

摘要面板位于预览正文上方：

- `<details>` 展开/收起；有摘要时默认展开。
- 显示状态（已生成/可能过期/未生成）、token 估算、生成时间、模型。
- 操作：AI 生成、保存摘要、清除摘要。
- 两个会话级开关：
  - `稳定翻译：参考上一版译文`：提示说明重译参考旧译文、回译参考当前原文，并明确与摘要生成无关。
  - `使用全文摘要上下文`：仅在已有摘要时可用；摘要计入每批 token 预算。

摘要内容是 `textarea`。切换 assist 开关不会重绘页面，避免丢失未保存的摘要编辑；切换只影响后续请求。

## 8. 导出与原文确认 modal

- 导出：宿主 `prepare` 生成内容与 diff，内联数据或 `sourceConfirm`/导出数据传给 Webview；modal 内分栏展示差异。确认发 `exportWrite`，取消发 `exportCancel`。
- 原文写回：`applySourceEdits` 后宿主发送 `sourceConfirm`；确认发 `writeSourceEdits`，取消只关闭 modal。
- 导出确认与刷新有竞态保护：`exportConfirmPending` 阻止队列中的刷新覆盖待确认状态；导出提交期间 `exportCommitting` 阻止重复提交。
- 确认框关闭/写入完成后必须清理待确认数据。

## 9. 安全与 CSP

`buildWebviewHtml`：

- 每次渲染生成新的 18 字节随机 nonce。
- `default-src 'none'`；脚本只允许 `nonce-...`。
- `connect-src 'none'`：Webview 不能自行发网络请求。
- `object-src 'none'`、`base-uri 'none'`。
- `img-src` 允许 `webview.cspSource`、`https:`、`data:`；`font-src` 只允许扩展资源。
- `style-src` 允许 `unsafe-inline`，因为 KaTeX 与分栏表格使用 style 属性。

其他规则：

- Markdown 运行时 `html: false`，原文中的原始 HTML 不渲染。
- 所有动态文本经 `escapeHtml`；JSON 内联时把 `<` 转成 `\u003c`，防止 `</script>` 截断。
- 外链改写为 `href="#" + data-mbs-href`，由宿主校验后打开。
- 图片相对路径经 `resolveImage` / `asWebviewUri` 转换为可加载 URI。
- 密钥不会进入预览 HTML 或 Webview 消息。

## 10. 新增一个 UI 动作的清单

1. 同时修改 `src/i18n/en.ts` 与 `src/i18n/zh.ts` 增加文案（按钮、title、toast），保持 key 与占位符一致，然后运行 `npm run l10n:build`。
2. 在 `src/preview/html.ts` 渲染按钮，设置唯一的 `data-action` 和必要的数据属性。
3. 如果动作需要先就地编辑/特殊交互，在 `media/preview.js` 处理；否则点击事件会按 `data-action` 自动构造 `{ type }` 消息。
4. 在 `src/preview/previewManager.ts` 的 `onMessage` 增加 `case`，校验字段，调用对应服务。
5. 在 `SyncService` / `ExportService` 实现业务逻辑；写盘前遵守锁、并发校验和缓存写入规则。
6. 更新 `test/previewModel.test.ts`，断言 HTML 中包含按钮/文案/转义；必要时增加服务层测试。
7. 手动在隔离 profile 中验证布局、只读、滚动、刷新和取消路径。

## 11. 静态预览

`npm run preview:sample` 用 Mock Provider 生成：

- `tmp/preview.html`：双语视图
- `tmp/preview-split.html`：分栏
- `tmp/preview-export.html`：导出确认
- `tmp/preview-states.html`：原文变更 + 译文锁定
- `tmp/demo.zh.md` 等缓存文件

生成的 HTML 直接引用 `media/` 资源，可在浏览器中打开；`media/preview.js` 检测不到 `acquireVsCodeApi` 时会用 localStorage 和 `window.__mbsMessages` 模拟宿主。它只用于本地检查布局/HTML，不替代真实 Webview 测试。
