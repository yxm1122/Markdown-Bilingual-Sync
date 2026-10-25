# 开发流程

本文说明本地开发、调试、扩展功能、打包和发布。架构与数据模型见 [架构](architecture.md)，测试细节见 [测试指南](testing.md)。

## 1. 环境与安装

- Node.js 20+
- VS Code 1.90+
- 推荐使用仓库自带的 `.vscode/launch.json` 与 `.vscode/tasks.json`

```bash
npm ci
npm run typecheck
npm test
```

`npm ci` 使用 `package-lock.json`；如果本地没有锁文件变更需求，不要用 `npm install` 重新生成锁文件。

## 2. 构建与调试

```bash
npm run compile   # 单次构建
npm run watch     # 增量构建，适合 F5 调试
```

构建流程：

1. `esbuild.js` 把 `src/extension.ts` 及其依赖打包为 `dist/extension.js`（CJS、Node 20、`vscode` external）。
2. `scripts/copy-katex.mjs` 把 KaTeX 样式与字体复制到 `media/katex/`。
3. `media/preview.js`、`media/taskView.js` 是浏览器原生脚本，不经过 esbuild。

调试：

1. 在 VS Code 打开本仓库。
2. 运行 “Run Extension”（F5）。它会以 `samples/` 为工作区启动 Extension Development Host。
3. 在 Extension Development Host 中打开 `samples/demo.md`，通过命令面板或标题栏打开双语预览。
4. 主进程日志在 “输出 → Markdown Bilingual Sync” 通道；Webview 侧错误在 “帮助 → 切换开发人员工具” 中查看。

常用辅助：

```bash
npm run preview:sample
```

用 Mock 生成 `tmp/preview*.html`，可直接在浏览器打开检查布局与 HTML。它不启动 VS Code，也不验证真实 Webview 的消息/权限。

## 3. 代码约定

- 使用 TypeScript strict 模式；`npm run typecheck` 必须通过。
- 纯逻辑模块不要导入 `vscode`，以便在 Node/Vitest 中直接测试。
- 每个核心模块顶部保留“职责 / 关键不变量 / 与其他模块关系”的 JSDoc；修改语义时同步更新。
- 不要写复述代码的注释；只在隐藏约束、非显然的边界或安全原因处注释。
- 用户可见文案放在 `src/i18n/zh.ts`；`package.json` 的设置描述也属于用户文案。
- 新增/修改 HTML 时必须转义动态文本；不要关闭 Webview 的 CSP 或 `html: false`。
- 不要在日志、错误信息、测试夹具中写入 API Key 或完整请求头。

## 4. 常见扩展任务

### 4.1 新增命令

1. 在 `package.json` 的 `contributes.commands` 增加命令 ID、标题、图标/分类。
2. 如需菜单/标题栏入口，更新 `contributes.menus`；注意 Markdown/Skill 条件：
   ```json
   "(editorLangId == markdown || editorLangId == skill)"
   ```
3. 在 `src/extension.ts` 的 `activate` 中用 `register("命令 ID", handler)` 注册；统一错误边界使用 `handleErrors`。
4. 文案放入 `src/i18n/zh.ts` 的 `extension` 区域。
5. 更新 `README.md` 的命令表。
6. 如果涉及清单条件，扩展 `test/language.test.ts` 的 manifest 断言。

### 4.2 新增设置

1. 在 `package.json` 的 `contributes.configuration.properties` 增加：
   - `type`、`default`
   - `scope`（网络/密钥相关必须 `application`）
   - `order`（设置页排序）
   - 中文 `markdownDescription`
2. 在读取处使用 `vscode.workspace.getConfiguration("markdownBilingualSync")`，不要缓存配置对象。
3. 如影响预览/任务面板，确认 `onDidChangeConfiguration` 会刷新（当前扩展对任意 `markdownBilingualSync` 变更全量刷新预览）。
4. 更新 `README.md` 的设置表。
5. 为行为变化增加单元测试；设置范围/清单条件可在 `test/language.test.ts` 中断言。

### 4.3 新增 Provider

1. 在 `src/translation/` 实现 `TranslationProvider`（`translate`，可选 `summarize` / `testConnection`）。
2. 遵守结果契约：id 一一对应、不重复、不空、不超长；取消时 reject“翻译已取消”。
3. 如需密钥，只从 `SecretStorage` 读取；错误/日志必须脱敏。
4. 更新 `ProviderKind`、`TranslationProviderRouter` 和 `extension.ts` 的 Provider 组装。
5. 如需配置，增加 `package.json` 设置与配置读取函数（参考 `loadOpenAIConfig` / `loadGenericHttpConfig`）。
6. 更新 Provider 预设 `src/translation/presets.ts` 和 README。
7. 增加单元测试，覆盖成功、校验失败、HTTP 错误、取消、脱敏。
8. 若支持摘要，设置 `supportsSummary = true` 并实现 `summarize`；否则预览会让用户手动填写。

### 4.4 新增预览动作

见 [预览与 Webview](preview.md#10-新增一个-ui-动作的清单)。

### 4.5 修改缓存/锚点语义

先读 [缓存格式](cache-format.md)。锚点是持久化协议，修改时必须：

- 保持旧缓存的宽容解析；
- 新增字段可选；
- 更新 `anchors`、`summaryMarker`、`deletedMarker`、`sync`、`editCache`、`export` 相关测试；
- 在隔离 profile 中验证旧缓存升级路径。

## 5. 隔离 profile 手动测试

不要在日常使用的 VS Code profile 中反复安装/卸载开发版。使用独立的 `--user-data-dir` 与 `--extensions-dir`：

```bash
code --install-extension "<repo>/artifacts/vsix/markdown-bilingual-sync.vsix" --force \
  --extensions-dir "<repo>/tmp/dev-ext" \
  --user-data-dir "<repo>/tmp/dev-user"

code --user-data-dir "<repo>/tmp/dev-user" \
  --extensions-dir "<repo>/tmp/dev-ext" \
  --new-window "<repo>/samples"
```

建议：

- 在隔离 profile 的 `User/settings.json` 中设置 `"markdownBilingualSync.provider": "mock"`，避免真实网络与密钥。
- 用独立临时目录保存测试文档，避免修改仓库中的 `samples/demo.md`。
- 测试完成后关闭窗口，再删除/重建 `tmp/dev-*`；这些目录在 `.gitignore` 中。
- 若要验证真实 Provider，使用单独的测试 Key，并确认它不会出现在日志/缓存/提交中。

手动验证路径：

1. 打开 Markdown / Skill 文件，确认扩展入口出现。
2. 同步、预览、块状态与统计。
3. 摘要生成/编辑/保存/清除；assist 开关悬停提示。
4. 分栏只读、滚动同步、块级 ⋯ 菜单。
5. 译文编辑/插入/删除/撤销、回译、原文暂存与写回 diff。
6. 导入、导出确认 modal、批量翻译/导出。
7. 重新加载窗口，确认布局偏好保留、只读状态重置。

## 6. 打包与发布

### 6.1 本地打包

```bash
npm run typecheck
npm test
npm run package
```

产物：`artifacts/vsix/markdown-bilingual-sync.vsix`（gitignored）。`vsce` 会使用 `package.json` 的 `publisher`、`version`、`repository` 等字段；打包前确认版本号。

安装到隔离 profile：

```bash
code --install-extension artifacts/vsix/markdown-bilingual-sync.vsix --force \
  --extensions-dir "<repo>/tmp/dev-ext" \
  --user-data-dir "<repo>/tmp/dev-user"
```

### 6.2 版本号

项目按语义化版本发布。只改文档/测试通常不需要版本号；用户可见的修复或功能需要：

```bash
npm version <patch|minor|major> --no-git-tag-version
```

这会同时更新 `package.json` 与 `package-lock.json`。提交前检查 `git diff`，不要把 `artifacts/`、`tmp/`、`dist/` 带进提交。

### 6.3 发布前检查

- [ ] `npm run typecheck` 通过
- [ ] `npm test` 全量通过
- [ ] `npm run package` 成功
- [ ] VSIX 的 `extension/package.json` 版本与预期一致
- [ ] 在隔离 profile 完成受影响路径的手动 E2E
- [ ] 确认 `README.md` 的功能/命令/设置已同步
- [ ] 确认没有密钥、临时路径、调试日志进入提交
- [ ] 用户明确同意提交/推送/发布

### 6.4 Marketplace

当前 `publisher` 为 `yxm1122`。项目采用网页手动上传 VSIX 的方式发布，不要求 Azure DevOps PAT；上传前确认 Publisher 与版本号。具体上传入口与权限由发布者控制，不要在仓库中记录凭据。

## 7. 常见坑

- **锚点行不能删**：解析时锚点行被替换为空串以保持行号；删除会破坏 `anchorLine` 与行级编辑。
- **缓存格式是持久化协议**：改字段/编码前先考虑旧缓存；不要假设用户可以清空缓存。
- **`human` / `deleted` 保护**：普通同步不应覆盖它们；`retranslateAll` 只覆盖 `auto`。改选任务逻辑前先看 `syncDocument` 与测试。
- **target-only 块的位置**：没有原文，必须用 `start` / `t-<hash>` 锚定；同步时按相对位置合并，否则导出会错位。
- **Provider 输出是不可信数据**：必须经过 `validateTranslationResult`；不要直接写缓存。
- **Webview 转义**：任何动态文本进入 HTML 都要转义；JSON 内联要处理 `<`。
- **CSS/JS 资源**：新增媒体文件必须位于 `media/` 并确保 `localResourceRoots` 覆盖；否则 Webview 加载失败。
- **语言后缀**：`languageSuffix` 只取主语言子标签，`zh-CN` 与 `zh-TW` 共用 `zh`。
- **锁的作用域**：`withLock` 是进程内、按 URI 字符串的互斥，不是跨窗口文件锁。
- **缓存写入非原子**：源写回有内存回滚，缓存没有事务日志；不要把“写入成功”当成强一致保证。
- **测试不启动 VS Code**：与真实 Extension Host/Webview 相关的行为必须手动 E2E。
