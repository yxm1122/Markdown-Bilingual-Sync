# Markdown Bilingual Sync 开发文档

本目录面向贡献者与维护者，说明项目架构、持久化格式、预览协议、开发流程和测试方法。用户安装、功能、命令与设置说明请看根目录的 [README](../README.md)。

## 快速开始

环境要求：

- Node.js 20+
- VS Code 1.90+（`package.json` 的 `engines.vscode`）

```bash
npm ci
npm run typecheck
npm test
npm run compile
```

在 VS Code 中按 `F5` 使用 `.vscode/launch.json` 的 “Run Extension” 配置，会以 `samples/` 为工作区启动 Extension Development Host。

常用命令：

| 命令 | 作用 |
| --- | --- |
| `npm run compile` | esbuild 打包主进程 + 复制 KaTeX 资源 |
| `npm run watch` | esbuild 增量构建 |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | Vitest 全量单元测试 |
| `npm run test:watch` | Vitest 监听模式 |
| `npm run preview:sample` | 用 Mock 生成 `tmp/preview*.html` 静态预览 |
| `npm run eval:translation` | 运行翻译质量评估（默认 Mock，真实 Provider 需 API Key） |
| `npm run eval:annotations` | 运行 AI 批注质量评估（问题发现、候选处理项、独立执行性） |
| `npm run package` | 构建并生成 `artifacts/vsix/markdown-bilingual-sync.vsix` |

## 文档地图

| 文档 | 内容 |
| --- | --- |
| [架构](architecture.md) | 分层、模块职责、核心数据模型、同步/预览/编辑/导出/并发流程、失败语义、安全边界 |
| [缓存格式](cache-format.md) | 缓存路径、frontmatter、锚点、摘要标记、删除墓碑、解析与写入规则、兼容性要求 |
| [预览与 Webview](preview.md) | 预览渲染管线、布局/只读、消息协议、原文暂存与写回、摘要面板、CSP |
| [开发流程](development.md) | 本地调试、新增命令/设置/Provider/UI 动作、打包、发布检查清单、常见坑 |
| [测试指南](testing.md) | 测试栈、测试文件分工、VS Code mock、CI、隔离环境 E2E、覆盖缺口 |
| [翻译质量评估](evaluation.md) | 评估集、自动指标、Mock/真实 Provider 运行方式、报告与人工评分 |
| [AI 批注评估](annotation-evaluation.md) | 批注数据集、指标口径、基线与波动、提示词改动流程 |

## 架构速览

```text
VS Code 命令 / 预览 Webview 消息
        │
        ▼
extension.ts / PreviewManager / ExportService
        │
        ▼
SyncService（配置、锁、读写、编辑、摘要、回译）
        │
        ├── 纯逻辑：syncDocument / editCache / editSource / exportMarkdown / previewModel
        │        └── 解析与对齐：segmenter / anchors / align
        │
        ├── 持久化：CacheStore（globalStorage）
        │
        └── 翻译：BatchTranslationCoordinator → ProviderRouter → Mock / OpenAI / HTTP
```

设计原则：

- **原文是唯一事实来源**。预览和缓存都是派生数据；原文写回必须经过差异确认。
- **块是翻译与锁定的最小单位**。块身份由内容哈希 + 锚点维护，不依赖行号。
- **纯逻辑与 VS Code 适配层分离**。切块、对齐、同步、导出、分批等可在 Node 中直接测试；`SyncService` / `PreviewManager` 才接触 VS Code API。
- **人工内容优先**。`human` 译文与 `deleted` 墓碑不会被普通同步覆盖。
- **失败不写坏缓存**。Provider 输出先校验，缓存草案重新解析验证后才落盘。
- **密钥只进 SecretStorage**，不进入设置、日志、提示词或 Webview。

## 源码目录

```text
src/
  extension.ts          激活入口、命令注册、Provider 组装、监听
  markdown/             切块、锚点、对齐、标题上下文、markdown-it 运行时
  cache/                缓存路径/读写、单块编辑、删除墓碑、摘要标记
  sync/                 同步纯逻辑 + VS Code 适配层
  translation/          Provider 协议与实现、分批、跨文件合并、并发限制
  preview/              预览模型、HTML、Webview 外壳、面板控制器
  source/               原文暂存编辑的行级合成
  export/               导出构建、导出服务、diff 视图模型
  import/               已有译文导入
  glossary/             术语表解析与存储
  batch/                目录扫描、文件级并发
  status/               任务状态机、任务面板、状态栏
  i18n/                 英文/中文 UI 目录、领域错误目录、l10n 目录校验
  util/                 哈希、语言标签、文本规范化
media/                  预览/任务面板的浏览器侧 JS/CSS、图标、KaTeX
l10n/                   运行时 l10n bundle（构建生成，打进 VSIX）
test/                   Vitest 测试、vscode stub 与共享样例
scripts/                构建辅助、l10n 生成与静态预览脚本
samples/                示例 Markdown、译文与资源
```

## 安全底线

- API Key 只能通过 `SecretStorage` 读取；当前使用 `markdownBilingualSync.apiKey.openai`、`.http`，旧键 `markdownBilingualSync.apiKey` 仅作读取回退。
- 网络相关设置（base URL、模型、HTTP endpoint/headers/body）声明为 `scope: "application"`，防止工作区级设置重定向请求。
- Webview 关闭原始 HTML（`html: false`），CSP 禁止 `connect-src`，所有动态文本必须转义。
- 错误信息、日志、导出文件和测试中不得出现密钥。
- 不要用真实 API Key 跑自动化测试；使用 Mock 或测试桩。

## 贡献检查清单

提交前至少完成：

```bash
npm run typecheck
npm test
npm run package
```

并在隔离的 VS Code profile 中手动验证受影响的用户路径（见 [测试指南](testing.md#6-手动-e2e隔离-profile)）。不要修改用户工作区中的未提交文件；不要在没有明确要求时提交、推送或发布。
