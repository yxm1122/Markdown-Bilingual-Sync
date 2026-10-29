# Markdown Bilingual Sync

[![CI](https://github.com/yxm1122/Markdown-Bilingual-Sync/actions/workflows/ci.yml/badge.svg)](https://github.com/yxm1122/Markdown-Bilingual-Sync/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://github.com/yxm1122/Markdown-Bilingual-Sync/blob/main/LICENSE)

[English](README.en.md) | 中文

在 VS Code 中翻译 Markdown，并以双语预览阅读；原文是唯一事实源，手动修改的译文会自动锁定，不会被静默覆盖。

当前版本 **0.14.1**：新增文档简报（摘要、翻译要求与文档术语表）、单块重译/回译的邻块上下文、AI 审校与用户批注（共享可配置输出语言、可拖动分组面板）、按批注重译，以及 17 例翻译质量评测；术语表支持内容自适应卡片、分侧悬停揭示和内联编辑。批注保存在本机 sidecar，审校写入前会重新校验，过期批注不会作为重译指令。延续 0.12.0 的全插件本地化（英文默认、内置 zh-cn）。

## 功能

- 以顶层语义块为翻译单元：标题、段落、整段列表、整张表格、整段引用与脚注定义。
- 受保护语法兜底：行内代码、URL 与脚注标签若被模型改写，会在写入缓存前自动还原；脚注定义翻译正文并保留 `[^id]` 标签。
- 双语 Webview 预览：并排、交错与真正的左右分栏布局，分栏模式支持两个独立滚动窗格和块级滚动同步；支持 GFM、代码高亮、KaTeX、脚注和 GitHub Alerts。
- 同时支持 Markdown 与 Qoder 等环境提供的 `skill` 语言 ID（文件内容仍为 Markdown）。
- 可切换的 OpenAI 兼容或通用 HTTP 翻译服务，API Key 只保存在 VS Code SecretStorage；内置常用服务预设。
- 导入已有译文：按顶层块结构校验并对齐，全部标记为译文锁定；预览工具栏和命令面板都可发起导入。
- 缓存清理：可清理当前文件缓存，或一键清除扩展存储中的所有译文缓存。
- 批量处理：目录批量翻译按 token 预算动态分批，文件级与文件内批次共享并发上限；批次按文档与小节边界组织，不同文件不会混批；失败时保留已成功译文，也可批量导出已有缓存。
- 翻译任务视图：状态栏右侧按钮切换原生 TreeView，展示批量总览、活动任务、最近完成和运行状态；任务行可打开源文件/预览/取消，视图标题的“切换语言”用原生 QuickPick 修改原文/译文语言或交换。
- 批量翻译与增量同步：保存原文只标记过期，只有手动命令才请求翻译 API。
- 译文锁定：编辑译文缓存并保存后，该块不会被自动重译覆盖。
- 预览内编辑：点击原文或译文内容即可就地编辑原始 Markdown；译文保存后立即锁定，原文修改暂存后可先查看差异再写回源文件。
- 回译改写原文：对已有译文的块执行反向翻译，结果直接进入原文暂存；写回后该块译文锁定到新的原文，不会被同步覆盖。
- 稳定翻译：重新翻译参考旧译文，回译参考当前原文，减少细微修改造成的措辞波动；设置与预览开关均可控制。
- 文档简报与术语表：手动生成原文语言摘要、翻译要求（受众/语气/歧义决策/禁译项）和本文档术语表；随译文缓存保存，可在预览中编辑、清除。
- 块级批注与审校：AI 审校只返回可能需要人工核对的批注，不直接改写译文；用户可以补充信息、勾选“要求修改”，再按批注重译。批注保存在本机 sidecar，不进入缓存 Markdown 或导出。
- 单块重译、过期块重译、全部机器译文重译。
- 两层用户术语表（全局/工作区）+ 随摘要生成的文档术语表；预览内可检查机器译文的术语与受保护 Markdown，并逐块一键重译。
- 导出到同目录语言后缀文件，写入前显示分栏差异确认。
- 导出/重译前可发现结构问题；AI 返回提示词、请求回显或未翻译原文时拒绝写入缓存；缺失行内代码或术语目标时先带明确提示重试一次。
- 全插件本地化：英文为默认 source，VS Code 显示语言为 `zh-cn` 时加载中文；命令/设置清单与运行时文案同步切换。

## 安装

```bash
code --install-extension artifacts/vsix/markdown-bilingual-sync.vsix
```

需要 VS Code 1.90 或更高版本（扩展使用 Webview、SecretStorage 与 WorkspaceEdit）。

### 从源码构建

需要 Node.js 20 或更高版本：

```bash
git clone https://github.com/yxm1122/Markdown-Bilingual-Sync.git
cd Markdown-Bilingual-Sync
npm ci
npm run package
```

构建产物位于 `artifacts/vsix/markdown-bilingual-sync.vsix`，可按上面的安装命令安装。开发调试可直接在 VS Code 中按 F5 启动扩展开发主机；详细命令见“开发”一节。

## 快速开始

1. 打开一个已保存到磁盘的 `.md` 文件。
2. 在设置中确认语言对，默认 `en` → `zh-CN`。
3. 执行命令 **Markdown 双语同步: 设置 AI 翻译 API Key**，粘贴密钥。
4. 在设置中选择翻译服务，或执行 **应用翻译服务预设…**：
   - `markdownBilingualSync.provider` 设为 `openai`
   - `markdownBilingualSync.apiBaseUrl` 如 `https://api.openai.com/v1`
   - `markdownBilingualSync.apiModel` 如 `gpt-4o-mini`
   - 或设为 `http`，配置 `httpEndpoint`、`httpHeaders`、`httpBody`、`httpResponsePath`
5. 执行 **Markdown 双语同步: 测试 AI 翻译连接**，确认接口、模型/模板和密钥可用。
6. 执行 **翻译当前文件**，双语预览会在当前编辑器组中以新标签页打开，不会自动切开编辑器窗口。
7. 之后修改原文并保存，执行 **同步译文** 只翻译缺失或过期块。
8. 已有译稿可点击预览工具栏 **导入译文**（或命令面板 **导入已有译文…**）导入为译文锁定块。

## 工作流与语义

### 原文为准

- 原文默认不会被自动改写；只有显式执行原文编辑、删除原文或“回译”并确认写回后，才会修改源文件。
- 保存原文只更新过期状态并刷新预览，不会自动请求翻译 API。
- **同步译文** 只处理缺失块和过期块。
- 同步、重译和批量翻译按批次写入缓存；中途失败或取消时，已经成功写入的批次会保留，缺失块下次同步重试。
- 更换模型或需要刷新已有机器译文时，使用 **全部重译**；译文锁定块不会被覆盖。

### 译文锁定与预览内编辑

- 点击预览中的译文内容，会就地显示该块的原始 Markdown；点击 **保存并锁定** 后写入全局缓存，并标记为译文锁定。
- 也可以执行 **编辑缓存** 直接编辑缓存文件；修改并保存后同样会锁定该块。
- 点击原文内容可就地修改原始 Markdown；点击 **暂存修改** 后，预览会立即渲染暂存的原文结果，顶部会出现 **应用原文修改**。点击后会显示“当前原文 / 修改后原文”的分栏差异，确认后写回源 `.md` 并保存。
- 每个块有 **插入** 和 **删除** 按钮；点击后按钮展开为 **原文 / 译文** 两个选择，鼠标移出块后恢复：
  - **插入 → 原文**：在该块后打开内联编辑器，点击 **暂存新块** 后立即出现在预览中；顶部 **开头插入** 可在文档开头插入。
  - **插入 → 译文**：直接写入译文缓存的新译文块，立即进入导出，但不修改原文；可点击该块的 **回译** 生成原文候选，暂存后随原文修改一起写回并建立对应关系。
  - **删除 → 原文**：把块标记为“原文待删除”，预览中变暗；可点击 **撤销删除** 恢复。应用写回后，该块已有的机器译文或锁定译文会降级为独立的译文锁定块（target 锚点），继续保留在导出中；原样复制块和已删除译文的标记会一并移除。
  - **删除 → 译文**：在该块缓存中写入带备份的“已删除”标记，保留锚点；后续同步不会重译，导出的译文中也不包含该块内容；点击 **撤销删除** 直接恢复原译文或原复制/未翻译状态，不需要重新调用 AI。代码、公式等复制块和从未翻译的块同样可以删除。
  - 译文插入块可以直接删除，删除后从缓存中彻底移除，不提供撤销。
  - 所有暂存的原文修改、插入、删除都在同一份差异确认中写回，或点击 **重置暂存** 全部清除。
- 暂存修改按块记录；源文件在此期间被外部修改时，暂存会被清空并提示重新编辑。
- 原文再次变化时，译文锁定块进入“译文锁定 · 原文已更新”，不会被自动覆盖。
- 需要接受当前原文时，使用 **标记已同步**。
- 需要重译单个块时，使用该块上的 **重新翻译**。
- 每个已有译文的可翻译块都有 **回译** 按钮：把译文翻回原文语言，结果直接进入原文暂存，不弹出额外窗口；点击 **应用原文修改** 后写回源文件，并把这一个译文块锁定到新的原文。回译结果与当前原文一致时不会产生暂存修改。
- **稳定翻译** 默认开启：重新翻译（单块/过期/全部）会把旧译文作为参考，回译会把当前原文作为参考；显式重译 human 块时也会参考旧译文。预览中的“参考上一版译文”开关只影响当前会话，设置页 `stableTranslation` 控制默认值。
- **文档简报** 只能手动生成（OpenAI 兼容/Mock），HTTP Provider 可手动填写。生成时会同时生成摘要、翻译要求（brief）和文档术语表；“文档简报”面板显示状态、总 token 估算、过期提示；摘要常驻，翻译要求与术语表是互斥折叠区（初始都收起），术语表用单行流式卡片（`原文 | 译文`，短卡贴合内容；超长省略、悬停哪侧就滚动哪侧）；点击原文或译文分别进入该侧的内联编辑。默认一个“保存简报”动作一次写回摘要、brief 和术语表；摘要与 brief 的输出语言由 `assistantLanguage` 控制（默认跟随译文，也可跟随原文或指定 BCP-47）。预览中的“使用文档简报上下文”开关只影响当前会话，设置页 `summaryContext` 控制默认值。
- 简报写入缓存内的专用标记，不参与块对齐和导出；源文变化后显示“可能过期”但仍会作为上下文使用；清除缓存时简报一起删除。简报生成输入上限约 12k tokens，超出时请手动填写。单块重译/回译会额外携带同 section 的只读邻块上下文，帮助短标题和短段落保持语义。

### 块状态与缓存标记

缓存锚点（`<!-- mbs:... -->`）共有五种模式：

| 模式 | 所在集合 | 含义 |
| --- | --- | --- |
| `auto` | 普通块 | 机器译文，`src` 记录上次翻译时的原文哈希，原文变化后变过期 |
| `human` | 普通块 | 译文锁定；导入、手动编辑、标记已同步或回译写回后使用 |
| `copy` | 普通块 | 代码、公式等不翻译、按原文原样复制 |
| `target` | 独立译文块 | 没有对应原文的译文，始终显示为译文锁定；删除原文后由普通译文降级而来 |
| `deleted` | 普通块 | 译文删除标记，内容为带备份的 `mbs-deleted` 标记；不参与同步和导出 |

对齐后的块状态：`untranslated`、`copy-pending`、`translated`、`stale`、`human`、`human-stale`、`copy`、`copy-stale`、`deleted`。另外有三种暂存态：原文待插入、原文待删除、待生成的译文块。

| 操作 | 缓存 | 原文 | 说明 |
| --- | --- | --- | --- |
| 同步 / 过期重译 / 全部重译 | 写入 `auto` 或 `copy` | 不改 | 跳过 `human`、`deleted` 和正常的 `copy`；失败保留已成功批次 |
| 重译此块 | 写入 `auto` | 不改 | 无缓存时退化为整文件同步；`deleted` 状态时相当于恢复翻译 |
| 编辑/保存译文 | 写入 `human` | 不改 | 保存前校验原文哈希、缓存 id 与基线文本 |
| 标记已同步 | 写入 `human` | 不改 | 接受当前原文，锁定该块 |
| 删除译文 / 撤销删除 | 写入或移除 `deleted` | 不改 | 有译文时保留备份；无译文时写空标记 |
| 插入译文 | 写入 `target` | 不改 | 直接进入导出，可回译生成原文后转成 `human` |
| 删除独立译文 | 移除锚点 | 不改 | 不可撤销 |
| 暂存原文编辑 | 不改 | 应用后写入 | 写回后普通译文按 `src` 变为过期 |
| 暂存原文删除 | 应用后降级 | 应用后写入 | 普通译文转为 `target`；`copy` 与 `deleted` 条目移除 |
| 回译（已有译文） | 应用后写入 `human` | 应用后写入 | 回译结果进入原文暂存，不自动弹窗 |
| 暂存原文插入 | 不改 | 应用后写入 | 新原文块在下次同步时翻译 |

### 分栏视图与滚动同步

- 预览顶部可在 **并排 / 交错 / 分栏** 三种布局间切换；布局会跨会话记住。
- **分栏** 会创建原文、译文两个独立滚动窗格，而不是把每块的双语内容并排塞在一起。
- 滚动任一窗格时，另一侧会以对应块为锚点，并按块内滚动进度插值同步；长块滚动时不会卡在块顶。插入/删除造成的单侧块在缺失的一栏显示与并排/交错模式一致的普通块头和占位说明，两边仍保持一一对应的块行。
- 分栏中仍可执行原文/译文编辑、插入、删除、重译、回译与撤销删除；**重新翻译** 位于原文块，**定位原文** 位于译文块，插入和删除按钮在两栏都可用。
- 每个块标题栏右上角有 **⋯** 按钮，默认隐藏该块的全部操作；点击后操作按钮在标题下方换行展开，鼠标离开块时自动收起。仅原文/仅译文模式不显示 ⋯，操作按钮直接内联在块头右侧。
- **仅原文 / 仅译文** 模式与分栏兼容，会保留对应窗格并占满宽度。
- 分栏的原文/译文标题右侧各有 **只读预览** 按钮。开启后该栏隐藏块级标题、状态和全部操作，连续渲染整栏 Markdown；另一栏可以继续编辑，也可以独立进入只读。切换只读或布局时会保留两栏滚动位置，不会跳回顶部。
- 只读状态按栏独立，只在当前预览会话内有效；关闭预览后恢复为可编辑。
- 只读模式仅影响显示与编辑入口，不改变同步、导出或缓存语义；单侧块在缺失的一栏不会生成占位块，只渲染实际存在的内容。

### 导入已有译文

- 可以在预览工具栏点击 **导入译文**，或从命令面板执行 **导入已有译文…**。
- 选择一份现有译文 `.md`，例如 `guide.zh.md`。
- 导入按顶层块逐一校验：原文与译文的块数量和块类型必须一致，避免段落错位。
- 所有可翻译块写入缓存并标记为 **译文锁定**；代码、公式等结构块按原文复制。
- 已有缓存会被覆盖，覆盖前会弹出确认；不提供缓存备份。
- 导入文件不能包含扩展锚点；如果你选择的是缓存文件，会提示改用无锚点的译文 Markdown。
- 导入不调用 AI，也不会修改源文件。

### 通用 HTTP Provider

- `markdownBilingualSync.provider` 设为 `http` 后启用。
- 请求方法支持 `POST`、`PUT`、`PATCH`；`httpHeaders` 与 `httpBody` 都是 JSON 模板。
- 模板变量：`{{text}}`、`{{id}}`、`{{kind}}`、`{{headingPath}}`、`{{sourceLanguage}}`、`{{targetLanguage}}`、`{{apiKey}}`、`{{referenceText}}`、`{{referenceRole}}`、`{{summary}}`。
- 通用 Provider 每个翻译块发送一次请求；`httpResponseType` 为 `json` 时按 `httpResponsePath` 提取文本，为 `text` 时直接把响应体作为译文。
- 稳定翻译参考和文档简报中的摘要只有模板显式引用 `{{referenceText}}`/`{{summary}}` 时才会发送；`{{referenceRole}}` 为 `previous-target` 或 `previous-source`。自定义 HTTP 模板不包含 brief、邻块 context 或批注字段。
- 示例 `httpBody`：
  ```json
  {"text":"{{text}}","source_language":"{{sourceLanguage}}","target_language":"{{targetLanguage}}"}
  ```
- 示例 `httpHeaders`：
  ```json
  {"Content-Type":"application/json","Authorization":"Bearer {{apiKey}}"}
  ```
- `httpResponsePath` 可设为 `translation`、`data.translations.0.text` 或 `result[0].text`。
- 接口地址除 localhost/127.0.0.1/[::1] 外必须使用 HTTPS；`{{apiKey}}` 只在请求时替换，不会写入设置或日志。

### 缓存清理

- **清理当前译文缓存** 会删除当前文件的缓存，之后可重新翻译或重新导入；此操作不可撤销。
- **清除所有译文缓存** 会递归删除扩展 `globalStorageUri/cache` 下的全部缓存文件，适合彻底重置；此操作不可撤销。
- 有缓存正在编辑器中打开时，清理命令会要求先关闭缓存标签页，避免编辑器继续持有已删除内容。
- 有同步或导入任务进行时，清除所有缓存会被拒绝，避免写入与删除交叉。
- **打开译文缓存目录** 仍可直接查看所有缓存文件。

### 批量翻译与导出

- **批量翻译目录…** 选择目录后递归查找 `.md` 文件，跳过当前目标语言的导出文件（如 `*.zh.md`），逐文件执行增量翻译。
- 批次按估算 token 预算动态打包，`apiBatchSize` 只是块数硬上限；会跨文件合并待翻译块，优先填满并发，同时避免低于预算约 25% 的过小批次。
- 文件级并发、同一文件内批次和手动同步请求共享 `translationConcurrency` 上限（默认 8，最大 100）。
- 每完成一个翻译批次就把成功结果写入缓存；某个文件后续批次失败时，已成功的块会保留，失败块留在未翻译状态，下次同步只补缺失部分。
- 批量翻译开始前会保存该目录下已打开的 Markdown 文件；进度通知可取消。单个文件失败不会中断其余文件，详情写入“输出”面板。
- **批量导出目录…** 先扫描目录中已有缓存的 Markdown 并准备导出队列；内容未变化和无缓存的文件会跳过。
- 批量导出只显示一次汇总确认，不会逐个文件显示差异弹窗；确认后按队列写入语言后缀文件，并记录每个目标路径。

### 任务面板

- 状态栏右侧的 **翻译任务** 按钮在有任务时显示运行图标和 `并发 x/y`；点击可显示/收起任务视图。
- 任务面板是 VS Code 原生 **TreeView**，位于活动栏的 **翻译任务** 容器中。首次使用时可以把视图拖到右侧辅助侧边栏，之后 VS Code 会记住位置；状态栏按钮仍可直接显示/收起。
- **升级提示**：视图容器 ID 已从不允许点号的旧值改为 `markdownBilingualSyncTasks`。升级后如果原来的任务视图不见了，请从活动栏重新拖一次。
- 面板包含：
  - **批量总览**：活动文件数、活动块进度、失败块、并发占用和等待请求。
  - **活动任务**：文件、阶段、块进度、失败数、耗时和错误；行内可打开源文件、打开预览或取消任务。
  - **最近完成**：最近结束的任务及耗时/失败信息，可清除历史。
  - **运行状态**：翻译服务、模型/模板、批次预算和块数上限。
- 视图标题提供取消全部、清空历史、打开输出日志和“切换语言”。语言切换使用原生 QuickPick，支持源语言、目标语言和交换；选项来自 `markdownBilingualSync.supportedLanguages`，写回作用域沿用现有设置，只影响之后的翻译与导出。
- 批量翻译和命令/预览触发的整文件同步不再弹 VS Code 进度通知或完成/失败通知，进度与结果统一进入该视图；取消确认、导入/导出确认和 API 配置提示仍保留。
- 任务行按文件级批量/同步统计；预览内单块重译、回译仍保留原有短操作反馈，不单独成行。
- 状态栏按钮不自动打开任务视图，按你的选择手动切换。

### Provider 预设

- 执行 **应用翻译服务预设…**，可一键切换 OpenAI、DeepSeek、SiliconFlow、Ollama、LM Studio、自定义 HTTP 或 Mock。
- 预设只写入 `provider`、`apiBaseUrl`、`apiModel` 等接口设置，不写入 API Key。
- 本机服务预设使用 `127.0.0.1` 的 HTTP 地址；其余地址必须使用 HTTPS。
- 预设会覆盖当前接口与模型设置；API Key 仍需通过 **设置 AI 翻译 API Key** 单独保存。

### 导出

- **导出译文…** 会生成同目录语言后缀文件，例如 `docs/guide.zh.md`。
- 导出前显示分栏差异；取消或写入后弹窗关闭，不保留独立 diff 标签页。
- 写入前会再次检查目标文件，确认期间被外部修改时拒绝覆盖。
- 导出去除内部锚点，是跨设备/跨项目的持久资产。

## 命令

> 命令标题随 VS Code 显示语言变化；下表为 zh-cn 文案，英文界面会显示对应英文标题。

| 命令 | 说明 |
| --- | --- |
| 翻译当前文件 | 首次翻译缺失块并打开预览 |
| 打开双语预览 | 在当前编辑器组以新标签页打开或显示预览 |
| 同步译文 | 只翻译缺失块和过期块 |
| 重译过期译文 | 重译全部过期的机器译文 |
| 重新翻译全部机器译文 | 强制重译所有 `auto` 块，译文锁定块保留 |
| 导出译文… | 生成语言后缀文件，显示分栏差异确认 |
| 编辑译文缓存 | 打开当前文件的全局译文缓存 |
| 刷新双语预览 | 手动刷新预览 |
| 打开翻译任务面板 | 显示或收起翻译任务 TreeView，查看进度或取消任务 |
| 打开译文缓存目录 | 打开全局缓存目录 |
| 清理当前译文缓存 | 删除当前文件缓存，不可撤销 |
| 清除所有译文缓存 | 递归删除扩展存储中的全部缓存，不可撤销 |
| 导入已有译文… | 选择现有译文 Markdown，按块导入并标记译文锁定 |
| 批量翻译目录… | 递归翻译目录中的 Markdown，跳过目标语言导出文件 |
| 批量导出目录… | 为目录中已有缓存的 Markdown 排队导出 |
| 编辑全局术语表 | 打开用户级 `glossary.json` |
| 编辑术语表（全局或工作区） | 选择全局术语表或工作区根目录的 `.mbs-glossary.json` |
| 设置 AI 翻译 API Key | 将密钥写入 SecretStorage |
| 应用翻译服务预设… | 切换 OpenAI/DeepSeek/SiliconFlow/Ollama/LM Studio/HTTP/Mock |
| 测试 AI 翻译连接 | 发送一条短测试请求，显示模型/模板、延迟和示例译文 |
| 清除 AI 翻译 API Key | 删除 SecretStorage 中的密钥 |

### 术语表与一致性检查

- **全局术语表**：`globalStorage/glossary.json`，所有工作区共用。
- **工作区术语表**：工作区根目录的 `.mbs-glossary.json`，可随仓库共享。“工作区”指 VS Code 当前打开的文件夹/工作区；多根工作区使用源文件所在的那个根目录。没有打开工作区时只加载全局术语表。
- **文档术语表**：生成文档简报时由 AI 同时产出，和摘要/brief 一起保存在译文缓存的 `mbs-summary` 元数据中；预览的“文档简报”面板用流式卡片显示，点击卡片即可修改，支持添加/删除，或切到批量编辑粘贴 `source => target`。HTTP Provider 不能自动生成，但手动填写摘要后仍可在预览中编辑术语表。清空简报会同时清空文档术语表。
- 合并顺序为 **全局 → 工作区 → 文档**；同名 `source` 以文档术语表为准。生成文档术语表时会把全局/工作区术语作为约束发给 AI，尽量减少冲突。重新生成摘要会保留已有文档术语条目；要彻底重建，先清除摘要再生成。
- 预览工具栏的 **检查** 会在机器译文中查找未遵循的术语目标词和缺失的受保护 Markdown；结果按块汇总，选中一项会重译该块。译文锁定块不参与检查，避免覆盖手工成果。

## 设置

| 设置 | 默认值 | 说明 |
| --- | --- | --- |
| `markdownBilingualSync.provider` | `mock` | `mock`、`openai` 或 `http` |
| `markdownBilingualSync.apiBaseUrl` | `https://api.openai.com/v1` | OpenAI 兼容接口，自动追加 `/chat/completions`；本机 HTTP 仅允许 localhost/127.0.0.1/[::1] |
| `markdownBilingualSync.apiModel` | `gpt-4o-mini` | 服务端支持的模型名 |
| `markdownBilingualSync.apiThinkingMode` | `default` | `default` 不发送 `enable_thinking`，由服务端决定；`enabled` 发送 true；`disabled` 发送 false。仅部分服务支持显式模式 |
| `markdownBilingualSync.apiDisableThinking` | `false` | 旧版开关，仅在 `apiThinkingMode` 为 `default` 时生效；建议改用 `apiThinkingMode` |
| `markdownBilingualSync.apiBatchSize` | `50` | 单批块数硬上限；实际批次由 token 预算动态决定 |
| `markdownBilingualSync.apiBatchTokenBudget` | `2000` | 每批输入内容的估算 token 预算；会避免过小批次，摘要/brief、邻块 context、用户批注、参考译文与术语表计入，输出另计 |
| `markdownBilingualSync.translationConcurrency` | `8` | 文件级、文件内批次和手动请求共享的并发上限（1–100） |
| `markdownBilingualSync.stableTranslation` | `true` | 重新翻译参考旧译文、回译参考当前原文，减少措辞波动；预览内可临时切换 |
| `markdownBilingualSync.summaryContext` | `true` | 默认把手动生成的文档简报（摘要 + brief）作为同步/重译/回译上下文；预览内可临时切换 |
| `markdownBilingualSync.apiTimeoutMs` | `120000` | 单次请求超时（毫秒），OpenAI 兼容与通用 HTTP 共用 |
| `markdownBilingualSync.httpEndpoint` | 空 | 通用 HTTP 接口完整 URL，可含模板变量 |
| `markdownBilingualSync.httpMethod` | `POST` | 通用 HTTP 请求方法：`POST`、`PUT`、`PATCH` |
| `markdownBilingualSync.httpHeaders` | 默认 Bearer 模板 | 请求头 JSON 模板 |
| `markdownBilingualSync.httpBody` | 默认文本模板 | 请求体 JSON 模板，每块一次请求 |
| `markdownBilingualSync.httpResponseType` | `json` | `json` 或 `text` |
| `markdownBilingualSync.httpResponsePath` | `translation` | JSON 译文字段路径 |
| `markdownBilingualSync.sourceLanguage` | `en` | 原文语言 |
| `markdownBilingualSync.targetLanguage` | `zh-CN` | 译文语言；每个文件一个目标语言 |
| `markdownBilingualSync.supportedLanguages` | `["zh-CN"]` | 任务面板原文/译文语言快捷切换列表；按数组顺序展示，非法/空白项与大小写重复项会被忽略，当前 `sourceLanguage` 与 `targetLanguage` 始终包含在选项中 |
| `markdownBilingualSync.assistantLanguage` | `target` | 文档简报（摘要、翻译要求）与审校批注的输出语言；`target` 跟随译文（默认）、`source` 跟随原文，或填 `zh-CN` 等 BCP-47 标签。文档术语表仍使用翻译语言对 |

`provider`、接口、模型、HTTP 模板、批量设置和 `assistantLanguage` 是应用级设置，工作区不能覆盖。

## 安全与隐私

- API Key 只存入 VS Code SecretStorage，不写入设置、工作区、日志、提示词或缓存。通用 HTTP 模板中的 `{{apiKey}}` 只在发起请求时替换。
- OpenAI 兼容与通用 HTTP Provider 使用独立的 SecretStorage Key；旧版共用 Key 仅作为升级迁移回退。切换 Provider 或 endpoint 后请重新执行 **测试 AI 翻译连接**，确认 Key 与目标服务匹配。
- 原文写回（文档替换、保存、缓存对账）与同步任务共享同一文件锁；写回失败时会恢复内存文档，不会留下未保存的中间态。
- HTTP 模板中的未知变量、非法请求头、换行注入和远程明文 HTTP 会被拒绝；错误信息会遮盖密钥。
- 文档文本会发送到配置的翻译服务；请确认服务端的数据处理策略。
- 原始 HTML 不渲染；Webview 使用 CSP 和 nonce 限制脚本与资源。
- 译文缓存位于扩展的 `globalStorageUri`，不在项目目录中。
- 项目移动、清理扩展存储或卸载扩展会丢失缓存与锁定状态；需要长期保留的内容请导出。
- 全局术语表是用户级资源，不随仓库共享；工作区术语表位于项目目录中，会随仓库共享；文档术语表只存在于本机译文缓存。

## 本地化

- **英文是默认/source 语言**；当 VS Code 显示语言为 `zh-cn` 时加载中文翻译，其他语言回退英文。
- 清单（扩展显示名/描述、命令标题与 category、视图名、设置描述与 enum 描述）使用 `package.nls.json` / `package.nls.zh-cn.json`；运行时文案使用 `l10n/bundle.l10n.json` / `l10n/bundle.l10n.zh-cn.json`。
- 运行时文案目录：`src/i18n/en.ts`（英文 source）与 `src/i18n/zh.ts`（中文）；错误/警告按领域放在 `src/i18n/errors/*.ts`，通过 `tError()` 取当前 locale 文案。
- Webview 文案由宿主把本地化后的 `UI_TEXT` 注入页面；`<html lang>`、语言名与日期/耗时格式使用 `vscode.env.language` 与 `Intl`。
- 新增或修改文案后运行 `npm run l10n:build`（`npm run compile`、`vscode:prepublish`、`typecheck`、`test` 与 `test:watch` 会自动执行），再运行 `npm run typecheck` 与 `npm test`。
- `npm run watch` 启动前会生成一次 bundle，但不会监听 `en.ts` / `zh.ts` / `errors/*` 的变化；修改文案后需手动重跑 `npm run l10n:build` 并重新加载扩展宿主。

## 已知限制

- 仅支持本地文件流程；没有云端任务队列或多用户协作。
- 代码块、数学公式、HTML 和 frontmatter 按设计原样复制，不参与 AI 翻译。
- 预览内编辑按块进行，不支持跨块拖选或大范围结构重排；复杂结构调整建议直接编辑源文件。
- 分栏滚动同步以块为锚点，并按块内滚动进度比例映射；块高差异很大时仍可能与源栏的视觉位置不完全一致，但不会在长块内卡住。
- 导入已有译文要求原文与译文顶层块数量和类型逐块一致；结构不同会拒绝导入。
- Provider 请求共享 `translationConcurrency` 并发上限（默认 8）；限流明显时调低，单文件块很多时可适当调高 `apiBatchTokenBudget`。
- 批量导出只提供一次汇总确认，不逐个文件显示差异预览；需要逐文件确认时使用普通导出。
- Provider 预设会覆盖当前接口与模型设置，但不会写入或清除 API Key。
- 通用 HTTP Provider 每个块发送一次请求，不支持批量 `items` 协议；需要批量的服务可先使用 OpenAI 兼容适配层。
- 插入/删除的“原文”操作修改源文件；“删除译文”在缓存中写入删除标记并保留锚点，不删除源块；无原文的译文插入块删除后直接从缓存移除，不可撤销。
- 译文插入块直接写入缓存，不修改原文；如果其锚定的原文块被删除，译文块会按前一个仍然存在的原文块或目标末尾排序。
- 删除原文块并写回后，对应译文会自动降级为独立译文块（target 锚点），不会产生孤立锚点或阻止后续同步。
- 清理当前缓存或清除所有缓存后无法在扩展内恢复；需要长期保留的译文请先导出。
- 回译按块执行，不会自动批量回译整个文档。
- 文档简报与文档术语表只能手动触发生成；HTTP Provider 不支持自动生成，只能手动填写；超大文档（超过约 12k tokens）目前不自动分段生成。
- 摘要、brief、只读邻块上下文、用户批注和稳定参考会增加每次翻译的输入 token；这些固定上下文都计入每批预算。
- 不支持 Mermaid、原始 HTML、自定义提示词和流式输出。
- 术语表按全局 → 工作区 → 文档合并；文档术语表由 AI 随简报生成，需要人工检查后再依赖；清除简报会一起清除文档术语表。
- AI 审校目前手动触发（块级“审校此块”或同步译文右侧的“审校全文”），只返回批注，不自动改写译文；批注按“我 / AI 审校”两个可折叠分区展示，面板可拖动且页面滚动不关闭。批注保存在本机 sidecar，不随工作区共享。
- UI 提供英文（默认 source）与 zh-cn 两种语言；其他 VS Code 语言回退英文。界面、预览与通知文案来自 `src/i18n/en.ts` / `src/i18n/zh.ts`，错误与警告来自 `src/i18n/errors/*`，清单文案来自 `package.nls*.json`。
- GitHub 默认 README 为中文，`README.en.md` 作为 Marketplace 英文 README 由打包脚本使用；两者同步维护。
- 非实时同步：保存只标记状态，翻译由手动命令触发。

## 许可证

本项目采用 MIT License（见仓库根目录的 LICENSE 文件）。你可以自由使用、修改和分发，但需保留版权与许可声明。

## 开发

```bash
npm ci
npm run typecheck
npm test
npm run compile
npm run preview:sample
npm run ui:matrix
npm run ui:perf
npm run package
```

`typecheck`、`test`、`compile`、`test:watch` 和 `package` 会自动生成 l10n bundle；只修改文案时可单独运行 `npm run l10n:build`。`watch` 启动前生成一次 bundle，但不会监听文案目录变化。

`ui:matrix` 用 headless Edge 生成三主题 × 三布局 × 三模式的截图矩阵（含摘要、弹窗、编辑、只读、忙碌、窄窗口与空状态），`ui:perf` 生成 320 块文档的首屏、输入与滚动性能基线；产物分别在 `artifacts/ui-matrix/` 与 `artifacts/ui-perf/`。两者需要本机 Edge，可用 `EDGE_PATH` 指定路径，CI 不运行。

打包产物位于 `artifacts/vsix/markdown-bilingual-sync.vsix`。示例文档为 `samples/demo.md`。

架构、缓存格式、预览协议、开发流程与测试指南见 [`docs/`](docs/README.md)。翻译质量评估见 [`docs/evaluation.md`](docs/evaluation.md)；可用 `npm run eval:translation -- --provider mock` 跑离线管线烟测。

CI 配置位于 `.github/workflows/ci.yml`：每次推送和拉取请求会执行 `npm ci`、类型检查、全量测试，并打包 VSIX 作为构建产物。
