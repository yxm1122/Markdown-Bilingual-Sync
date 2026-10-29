# 架构

本文说明项目的分层、核心数据模型和主要数据流。持久化细节见 [缓存格式](cache-format.md)，预览消息协议见 [预览与 Webview](preview.md)。

## 1. 分层

```text
┌─────────────────────────────────────────────────────────────┐
│ VS Code 层                                                   │
│ extension.ts / PreviewManager / ExportService / TaskView     │
└──────────────────────────┬──────────────────────────────────┘
                           │ 调用
┌──────────────────────────▼──────────────────────────────────┐
│ 服务层                                                       │
│ SyncService（配置、文件锁、读写、编辑、摘要、回译）            │
└──────────────────────────┬──────────────────────────────────┘
                           │ 调用
┌──────────────────────────▼──────────────────────────────────┐
│ 纯逻辑层                                                     │
│ syncDocument / editCache / editSource / exportMarkdown       │
│ previewModel / batching / importTranslation                  │
└──────────────────────────┬──────────────────────────────────┘
                           │ 解析/生成
┌──────────────────────────▼──────────────────────────────────┐
│ 协议与持久化                                                 │
│ segmenter / anchors / align / cacheStore / summaryMarker     │
│ Provider 协议与实现                                           │
└─────────────────────────────────────────────────────────────┘
```

约束：

- `src/markdown/`、`src/sync/sync.ts`、`src/translation/batching.ts`、`src/export/exportMarkdown.ts` 等纯逻辑模块不应导入 `vscode`。
- 只有 `SyncService`、`PreviewManager`、`ExportService`、`CacheStore`、`extension.ts` 等适配层接触 VS Code API。
- Provider 通过 `getConfig` 惰性读取配置，因此修改设置无需重载窗口。

## 2. 数据模型

权威定义在 [`src/markdown/types.ts`](../src/markdown/types.ts)。核心对象：

### 2.1 `MarkdownBlock`

- `index`：文档内 0 基连续编号；frontmatter 为 `-1`。
- `kind`：heading / paragraph / list / table / blockquote / code / html / hr / math / footnote / other。
- `startLine` / `endLine`：0 基半开区间，可直接用于 `slice`。
- `raw`：去掉末尾空行、换行统一为 `\n` 的块正文。
- `hash`：`blockHash(kind, raw)`，不含行号。
- `translatable`：是否属于 `TRANSLATABLE_KINDS`（heading、paragraph、list、table、blockquote）；其他块在同步时复制原文。

### 2.2 `BlockAnchor` 与 `AnchorMode`

锚点是一行 HTML 注释，记录：

- `id`：缓存内唯一，用于跨解析定位。
- `kind`：块类型。
- `src`：最近一次确认的原文哈希；target 块使用 `start` 或 `t-<hash>`。
- `dst`：译文块内容哈希。
- `mode`：`auto` / `human` / `copy` / `target` / `deleted`。

`src` 与当前原文不一致表示过期；`dst` 与实际译文块哈希不一致表示缓存被手工改过，视为人工内容。具体校验规则见 [缓存格式](cache-format.md)。

### 2.3 `CacheDocument`

解析后的缓存由五部分组成：

- `blocks`：带锚点、可参与原文对齐的块（含 `deleted` 墓碑）。
- `targetBlocks`：`mode=target` 的译文独占块，不参与对齐。
- `untracked`：没有锚点的块，通常意味着缓存被手工破坏。
- `orphanAnchors`：没有对应内容块的锚点。
- `summary`：可选全文摘要元数据，不属于翻译块。

`cleanedText` 是移除锚点行后的文本，行数与原始缓存一致；`anchorLine` / `startLine` 可直接用于行级改写。

### 2.4 块状态

`BlockStatus`：`translated`、`stale`、`human`、`human-stale`、`untranslated`、`copy`、`copy-stale`、`copy-pending`、`deleted`。

状态由 `alignDocument` 根据锚点 `src`/`dst`、模式和当前原文哈希推导。预览统计与导出统计共享同一套对齐结果。

### 2.5 文档简报与批注

`CacheSummary`：`text`、`sourceHash`、`updatedAt`、可选 `model`、`glossary`、`brief`（`audience` / `toneAndStyle` / `ambiguities` / `doNotTranslate`）。摘要属于缓存元数据，不参与对齐与导出；源文变化后只标记过期，仍可作为上下文使用。brief 每个字段最多 400 字符，旧缓存缺失时按空处理。

批注不在缓存 Markdown 中，而存放在缓存同目录的 `<cache>.annotations.json` sidecar；`SyncService.loadPreviewState` 读取后在 `buildPreviewModel` 中按块 id 挂到视图。批注记录包含作者（AI/用户）、类型、严重度、状态、sourceHash 与可选 sourceIndex；源文变化标记 stale，过期用户批注不再作为重译指令。无缓存块的批注带 `src-<hash>` id 和 sourceIndex，首次同步生成锚点后迁移为锚点 id。所有批注读改写走同一文件锁；审校模型调用不占锁，但写入前重新读取并对齐校验原文、译文与锚点，用户批注在审校期间新增也会保留。摘要、brief 与批注文本共享 `assistantLanguage` 输出语言（默认跟随译文），术语表 source/target 不受影响。

## 3. 主要流程

### 3.1 翻译与同步

入口：`extension.ts` 的同步命令或 `PreviewManager.runSync`。

```text
SyncService.loadState
  ├─ 读取语言设置
  ├─ 必要时保存原文
  ├─ 计算缓存路径并读取缓存
  └─ 返回 sourceText / cacheText
SyncService.syncInternal
  ├─ 加载术语表
  ├─ 解析缓存中的摘要
  └─ syncDocument
       ├─ parseMarkdownDocument + parseCacheDocument
       ├─ alignDocument
       ├─ assertCacheWritable
       ├─ 选翻译任务（缺失 / copy / stale / auto）
       ├─ provider.translate（可流式 onChunk）
       ├─ validateTranslationResult
       ├─ 重建缓存草案并重新解析校验
       └─ 返回 cacheText
CacheStore.write
PreviewManager 刷新（由命令或保存事件触发）
```

关键点：

- `human` 与 `deleted` 不会被普通同步选中；`retranslateAll` 只覆盖 `auto`。
- 缓存序列化后必须重新解析，确认没有未跟踪块，并用实际块哈希回填 `dst`。
- `allowPartial` 模式按 4 块 / 2 秒阈值增量落盘；失败或取消时尽量保留已成功批次。
- 同步失败时不会写入半成品最终缓存（除部分模式已经提交的中间结果）。

### 3.2 预览

```text
SyncService.loadPreviewState（source + cache + summary）
  → buildPreviewModel（块视图、统计、警告、assist 状态）
  → 首次：buildPreviewAppShell（CSP、nonce、资源 URI、初始状态）→ panel.webview.html
  → 脚本 ready
  → 之后：postMessage({ type: "state", state })
  → Preact 按块 key 局部更新
  → 用户操作 postMessage
  → PreviewManager.onMessage
  → SyncService / ExportService
  → 重新 update()
```

`PreviewManager` 为每个源文件维护一个面板；`PreviewPanelSession` 保存布局、只读、原文暂存、摘要开关等会话状态。刷新通过 `updateQueue` 串行化，`updateVersion` 丢弃过期的异步渲染结果。首次加载写入完整壳，脚本发送 `ready` 后只发送模型/面板 state 消息；脚本、样式和稳定的 DOM 不再整页重建。内联编辑/插入草稿由编辑器组件本地持有，输入时不触发整棵块树 diff；分栏滚动同步只抑制对侧回声事件，避免连续滚动被节流。

### 3.3 原文编辑与写回

- 原文编辑/删除/插入先进入内存暂存，不立即写文件。
- 暂存以 `pendingSourceBase`（暂存时的源文全文）为基准；源文件变化会使暂存失效。
- “应用原文修改”调用 `buildProposedSource` 生成新文本，再显示 diff 确认。
- 确认写回时，`SyncService.runWithSourceLock` 把整个流程放入同一文件锁：
  1. `WorkspaceEdit` 替换文档；
  2. 保存源文件；
  3. 解除被删除源块对应的缓存锚点；
  4. 提升 target-only 回译块；
  5. 锁定成对回译块到新原文哈希。
  后三步失败只告警；保存失败时使用内存快照回滚文档。

### 3.4 译文编辑、插入与删除

- 编辑译文：`replaceCachedBlock` 重写正文与锚点，模式置为 `human`。
- 插入译文：在缓存中写 `mode=target` 的独立块，不改原文；导出时按 `t-<hash>` / `start` 插入。
- 删除译文：写 `deleted` 墓碑（可带备份），同步不会再翻译；可撤销。
- 删除 target-only 块：永久移除该条目，不保留墓碑。
- 回译：成对块把回译文本放入原文暂存；target-only 块生成原文插入，写回时提升为 `human`。

### 3.5 导出与导入

导出：

- `buildExportMarkdown` 是纯函数，按原文块顺序生成单语译文。
- 不可翻译块复制原文；删除墓碑不输出；target-only 块按锚点插入。
- 缓存含未跟踪块时整体拒绝，避免错位。
- `ExportService.prepare` 只读；`commit` 校验确认后磁盘内容未变，再写入。
- 批量导出先统一 prepare，一次总确认后逐个 commit；单文件失败不影响其他文件。

导入：

- `buildImportedCache` 要求译文与原文块数一致、逐块 `kind` 一致，且译文不含扩展锚点。
- 可翻译块写 `human`，不可翻译块写 `copy`。
- 生成后会重新解析验证结构；不校验更细的结构（列表项数、标题级别等）。

### 3.6 批量翻译与并发

```text
batchTranslateFolder
  ├─ 扫描目录（跳过 node_modules/.git，过滤目标语言导出文件）
  ├─ 保存目录内未保存文档
  ├─ 为每个文件创建任务与 AbortController
  └─ runWithConcurrency(worker)
       └─ SyncService.sync(file)
```

并发分三层：

1. 文件级：`runWithConcurrency`，并发数同样取自 `translationConcurrency`（默认 8，范围 1–100）。
2. 文件内批次：`planTranslationBatches` 按 token 预算与块数上限分批，并按并发度均衡；带文档/小节元数据时，同一批次只来自一个文档，并尽量保持小节完整（小节自身超限时才在内部拆分）。
3. 全局请求：`ConcurrencyLimiter` 限制同时进行的 Provider HTTP 请求（`translationConcurrency`，默认 8）。

跨文件合并：`BatchTranslationCoordinator` 在约 25ms 窗口内把同语言对、同摘要/brief/context/annotations 哈希的调用合并为一个请求，再按复合 id 路由回各文件。合并后的块仍按 `documentId` 分批，不同文件不会进入同一 HTTP 请求；单个文件取消不影响同组其他文件。

### 3.7 文档简报、单块上下文与稳定翻译

- 文档简报在预览中手动触发；OpenAI 兼容/Mock 支持 AI 生成摘要、术语表与 brief，HTTP 只支持手动编辑。
- 简报写入缓存 `mbs-summary` 元数据；清除缓存会一起删除简报与术语表。
- 简报过期（源文哈希变化）仍作为上下文使用，只提示用户。
- 同步/重译/全部重译/回译可以携带摘要与 brief；二者 token 从每批预算中扣除；不同摘要、brief、context 或 annotations 的请求不会被合并。
- 单块重译/回译由 `sync/blockContext` 从同一 section 取 1 个前块/后块（标题优先取后一块正文），作为只读 `context` 发送；大块或超过 600 token 时不加。回译的 adjacent context 来自目标语言缓存。
- 审校可手动按块或按文件触发；文件级审校跳过 human/deleted/copy/未翻译块，按块数（最多 6）和 token 预算分批并发调用 reviewer（共享 `translationConcurrency` 全局限流），只替换仍通过原文/译文校验的块的 AI 批注，用户批注保留。完成提示报告已审校块数和新增批注数。
- 稳定翻译仍由 `stableTranslation` 控制：重译参考旧译文，回译参考当前原文；单块上下文不会替代 reference。

### 3.8 术语表与译后一致性

- 用户术语表按 全局 `glossary.json` → 工作区根目录 `.mbs-glossary.json` 合并；同名 source 后加载的作用域为准。
- 全文摘要生成会同时产出摘要、brief 和文档术语表（目标语言），一起写入缓存 `mbs-summary` 元数据；摘要与 brief 的输出语言由 `assistantLanguage` 控制（默认跟随译文），都可在预览“文档简报”面板中编辑，清空简报会一起清空。生成请求额外携带从相对路径和白名单 frontmatter 提取的只读 `documentMetadata`；system prompt 只声明其为数据，原始 frontmatter 从摘要正文中剥离。
- 翻译请求使用“全局/工作区 → 文档”的合并术语表，文档术语表优先；生成文档术语表时会把用户术语表发给 AI 作为约束。
- 术语匹配与一致性检查共用 `util/glossaryMatch` 与 `util/protectedMarkdown`，避免评估与运行时口径不一致。
- 预览的“检查”动作通过 `SyncService.checkConsistency` 读取原文/缓存，只检查机器译文；人工锁定块跳过。问题按块汇总，选择后调用现有单块重译并刷新预览。
- 稳定翻译：普通同步/重译时把旧译文作为 `previous-target` reference；回译把当前原文作为 `previous-source`。显式 `human` 块通常不会被普通同步选中，但用户手动单块重译时可以带旧译文参考。

### 3.9 任务面板（TreeView）

- `TaskViewProvider` 实现 `TreeDataProvider`，由 `extension.ts` 创建 `TreeView` 并注入。
- 根节点为「批量概览 / 活动任务 / 最近完成 / 运行状态」四个稳定 section；任务行显示状态图标、进度、耗时和失败信息，失败/运行详情作为子节点。
- 行内操作和右键菜单通过 `view/item/context` 调用命令；视图标题提供取消全部、清空历史、打开输出和语言切换。
- 任务节点命令默认打开源文件；`task.openPreview` 打开双语预览；`task.cancel` 只对活动任务显示。
- 语言切换使用原生 QuickPick：选择源/目标语言或交换；选项来自 `supportedLanguages`，写回作用域沿用现有设置，交换失败会回滚。
- 视图 description/badge 由活动任务数驱动；monitor/limiter/config 变化 100ms 去抖刷新。

### 3.10 本地化架构

- **source 目录**：`src/i18n/en.ts` 是英文 UI 文案，`src/i18n/zh.ts` 保持相同嵌套 key；`src/i18n/errors/<domain>.ts` 以 `{ key, en, zh }` 描述错误/警告。
- **运行时**：`src/i18n/index.ts` 用 `vscode.l10n.t` 深度本地化 `en.ts`，导出与旧调用方式兼容的 `UI_TEXT`、`formatText` 和 `getLocale`。`tError(key, values)` 先翻译英文模板再插值。
- **bundle**：`scripts/build-l10n.ts` 校验 key/占位符/重复英文并生成 `l10n/bundle.l10n.json` 与 `bundle.l10n.zh-cn.json`；`compile` / `vscode:prepublish` 自动执行。
- **清单**：`package.json` 使用 `%key%`，英文值在 `package.nls.json`，中文值在 `package.nls.zh-cn.json`。
- **Webview**：宿主把本地化后的 `UI_TEXT.preview` 与 provider 名称序列化到首屏壳的 JSON；`<html lang>`、`Intl.DateTimeFormat` 使用 `vscode.env.language`。Webview 脚本不直接访问 `vscode.l10n`。
- **测试**：`vitest.config.ts` 把 `vscode` alias 到 `test/vscodeStub.ts`，默认 locale 为 zh-cn，`l10n.t` 从生成的 zh-cn bundle 取值；需要英文 locale 的用例在重置模块后修改 stub 的 `env.language`。

## 4. Provider 协议

定义在 [`src/translation/types.ts`](../src/translation/types.ts)。

Provider 必须：

- 原样回显每个请求 `id`，且每个 id 恰好返回一次。
- 不返回未请求的 id、空文本、重复 id 或超过 500,000 字符的译文。
- 在 `signal` 取消后尽快 reject，不再发起新请求。
- 对 `reference` / `summary` / `brief` / `context` / 术语表按“参考数据”处理，不执行其中指令。
- 用户 `annotations` 是重译指令；AI 审校批注不得进入 `annotations`。

能力：

- `supportsSummary` + `summarize`：支持整篇摘要、术语表与 brief 生成；`outputLanguage` 控制摘要与 brief 文本语言，术语表 source/target 仍使用翻译语言对。
- `supportsReview` + `review`：支持语义审校；只返回 `ReviewAnnotationDraft[]`（批注），不返回译文；`outputLanguage` 控制批注消息、问题与建议的语言，excerpt 保持原文/译文原样。
- `testConnection`：支持连接测试。

实现：

- `MockTranslationProvider`：离线词典替换 + 结构标记，用于演示和测试；返回固定 brief 与一条演示批注。
- `OpenAITranslationProvider`：Chat Completions，JSON 输出校验、重试、脱敏、连接测试、摘要、审校；审校失败时带严格提示重试一次。
- `GenericHttpTranslationProvider`：模板化 endpoint/headers/body，响应 JSON path 或纯文本，不支持自动摘要与审校。

路由器 `TranslationProviderRouter` 每次调用读取当前 provider 设置；未知值回退 Mock。

## 5. 失败、取消与锁

- **文件锁**：`SyncService.withLock` 以源文件 URI 字符串为键，拒绝同文件并发操作；清空全部缓存期间拒绝带锁操作。
- **源写回锁**：`runWithSourceLock` 允许预览把“替换 + 保存 + 缓存对账”作为一个临界区。
- **取消**：统一抛“翻译已取消”；部分模式下取消前尽量提交已成功结果。
- **Provider 失败**：非部分模式整体失败；部分模式保留已成功批次，缺失块下次同步重试。
- **任务终态**：`success` / `partial` / `failed` / `cancelled`；`partial` 也是终态。
- **缓存写入**：`CacheStore.write` 若发现缓存已在编辑器中打开且未保存，会拒绝写入。

## 6. 安全边界

- API Key 只从 SecretStorage 读取，Provider 配置每次调用重新加载。
- `apiBaseUrl`、`apiModel`、HTTP 模板等网络设置是 application-scoped，工作区不能覆盖。
- Webview 关闭原始 HTML，CSP 禁止网络请求与对象嵌入，脚本只用 nonce。
- 所有进入 HTML 的动态文本必须经过转义；外链通过 `data-mbs-href` 回传，由扩展进程打开。
- 错误信息与日志必须脱敏；不要记录请求体中的密钥。

## 7. 已知设计边界

- 锚点/缓存格式是持久化协议，修改要考虑旧缓存兼容。
- `retranslateAll` 会覆盖所有 `auto` 块，包括 `dst` 被手工改过但模式仍为 `auto` 的内容。
- 导入只校验块数与块类型，不校验更细的 Markdown 结构。
- `languageSuffix` 只取 BCP-47 主语言子标签，`zh-CN` 与 `zh-TW` 会共用同一个 `zh` 后缀。
- 缓存写入本身不是原子操作；进程崩溃可能留下截断文件。源写回有锁与内存回滚，但缓存没有事务日志。
- 单元测试不启动真实 VS Code；Webview 有 jsdom 组件测试与 headless Edge 截图/性能脚本，真实主题注入、IME、CSP 与安装流程仍需要隔离 profile 手动 E2E。

## 8. 推荐阅读顺序

1. [`src/markdown/types.ts`](../src/markdown/types.ts)
2. [`src/sync/sync.ts`](../src/sync/sync.ts) 文件头与 `syncDocument`
3. [`src/markdown/anchors.ts`](../src/markdown/anchors.ts) 与 [`src/markdown/align.ts`](../src/markdown/align.ts)
4. [`src/sync/syncService.ts`](../src/sync/syncService.ts) 文件头与公开方法
5. [`src/preview/previewManager.ts`](../src/preview/previewManager.ts) 文件头
6. 对应测试文件
