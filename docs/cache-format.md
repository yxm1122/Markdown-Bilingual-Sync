# 缓存格式

译文缓存是扩展的持久化协议。它不是用户原文的副本，而是“原文块 ↔ 译文块”的可编辑映射。改动锚点、摘要或删除标记时必须考虑旧缓存兼容。

实现位置：

- 路径与读写：[`src/cache/cacheStore.ts`](../src/cache/cacheStore.ts)
- 锚点解析/序列化：[`src/markdown/anchors.ts`](../src/markdown/anchors.ts)
- 摘要标记：[`src/cache/summaryMarker.ts`](../src/cache/summaryMarker.ts)
- 删除标记：[`src/cache/deletedMarker.ts`](../src/cache/deletedMarker.ts)
- 单块编辑：[`src/cache/editCache.ts`](../src/cache/editCache.ts)

## 1. 文件位置与命名

缓存位于扩展的 `globalStorageUri` 下：

```text
<globalStorage>/cache/<projectKey>/<relative-path>.<language>.md
```

- 工作区内文件：`projectKey = shortHash(工作区目录 URI)`，`relative-path` 是工作区相对路径，保留子目录。
- 工作区外文件：`projectKey = shortHash(文件所在目录)`，文件名取 basename。
- `<language>` 是 `targetLanguage` 的主语言子标签，小写。例如 `zh-CN` → `zh`。
- 源扩展名被替换：`docs/a.md` → `docs/a.zh.md`；无扩展名也会追加后缀。
- 缓存只支持本地 `file:` URI；路径计算会拒绝 `..`、绝对路径、盘符和越出项目目录的结果。

注意：`zh-CN` 与 `zh-TW` 都会得到 `zh` 后缀，因此会复用同一个缓存/导出文件。这是已知设计限制。

## 2. 文件布局

一个缓存文件由以下部分组成，各部分之间用空行分隔：

```markdown
---
title: Demo
---

<!-- mbs-summary:<base64url(JSON)> -->

<!-- mbs:{"id":"...","kind":"heading","src":"...","dst":"...","mode":"auto"} -->

# 标题译文

<!-- mbs:{"id":"...","kind":"paragraph","src":"...","dst":"...","mode":"human"} -->

段落译文
```

规则：

1. frontmatter（如有）放在最前；序列化时会去掉末尾空白。
2. 可选摘要标记放在 frontmatter 之后、第一个块之前。
3. 每个块先写锚点行，再空一行，再写译文正文。
4. `target` 块按相对位置穿插在普通块之间或文末。
5. `deleted` 墓碑仍是一个带锚点的块，正文是删除标记。
6. 文件以换行结尾；空缓存可以是空字符串。

`serializeCacheDocument` 是唯一的整篇序列化入口。单块编辑使用行级替换，以避免破坏用户手工排版与 target-only 块。

## 3. 锚点行

### 3.1 格式

```html
<!-- mbs:{"id":"a1b2c3d4e5f6","kind":"paragraph","src":"abc123","dst":"def456","mode":"auto"} -->
```

- 必须是独占一行的 HTML 注释；允许注释前后有空白。
- JSON 字段顺序固定为 `id`、`kind`、`src`、`dst`、`mode`。
- 解析只接受完整合法的 JSON；损坏的锚点行不会被信任。

### 3.2 字段与校验

| 字段 | 规则 |
| --- | --- |
| `id` | 1–64 字符，`[A-Za-z0-9_-]`；单个缓存内唯一 |
| `kind` | `BLOCK_KINDS` 之一：heading/paragraph/list/table/blockquote/code/html/hr/math/footnote/other |
| `src` | 1–128 字符，`[A-Za-z0-9_-]`；普通块为原文哈希 |
| `dst` | 1–128 字符，`[A-Za-z0-9_-]`；译文块内容哈希 |
| `mode` | `auto` / `human` / `copy` / `target` / `deleted` |

哈希使用 20 位短哈希（`blockHash(kind, raw)`），不含行号，因此移动块或增删空行不会使锚点失配。

### 3.3 模式语义

| 模式 | 含义 | 同步行为 |
| --- | --- | --- |
| `auto` | 机器译文 | 缺失/过期/`retranslateAll` 时可重新翻译 |
| `human` | 人工译文（或在缓存中手工改过） | 普通同步保护；只有用户显式重译才可能覆盖 |
| `copy` | 不可翻译块的原样复制 | 不送 Provider；下次同步按原文重新复制 |
| `target` | 没有对应原文的译文独占块 | 不参与对齐；同步时按相对位置合并回去 |
| `deleted` | 用户删除译文留下的墓碑 | 不重新翻译；保留删除决策 |

`dst` 与当前译文块实际哈希不一致时，`alignDocument` 会把它视为人工内容（即使模式仍是 `auto`）。这就是“直接编辑缓存也能被识别为人工修改”的机制。

### 3.4 `src` 的特殊值

普通块：`src` 是最近一次确认的原文块哈希。

`target` 块没有对应原文，使用：

- `start`：导出时放在文档开头（frontmatter 之后）。
- `t-<hash>`：按该原文哈希定位，导出时插到对应原文块之后。

### 3.5 锚点归属

解析时：

- 锚点归属于它后面最近的块。
- 同一块前有多个锚点时，只保留最后一个，其余进入 `orphanAnchors`。
- 找不到后续块的锚点（包括文末多余锚点）进入 `orphanAnchors`。
- 没有前置锚点的块进入 `untracked`。
- 重复 `id` 的第二个锚点不会被信任，该行按普通内容保留并产生 warning；通常会形成未跟踪内容，写回前需要用户清理。
- 锚点 `kind` 与实际块类型不一致会产生 warning；`deleted` 墓碑豁免（墓碑正文是标记文本，不是原文结构）。

## 4. 摘要标记

格式：

```html
<!-- mbs-summary:<base64url(JSON)> -->
```

JSON 载荷：

```json
{
  "text": "摘要正文",
  "sourceHash": "整篇原文的 sha256",
  "updatedAt": "2026-10-25T00:00:00.000Z",
  "model": "可选：生成模型或 Provider 标签",
  "glossary": [{ "source": "table", "target": "表格" }],
  "brief": {
    "audience": "可选：目标读者",
    "toneAndStyle": "可选：语气与风格",
    "ambiguities": "可选：歧义与决策",
    "doNotTranslate": "可选：禁译项"
  }
}
```

规则：

- 摘要正文 trim 后非空，最长 50,000 字符。
- `sourceHash` 与 `updatedAt` 必填。
- 使用 base64url 编码，保证摘要中的换行、`-->` 等不会破坏注释。
- 摘要不属于翻译块，不参与对齐、统计或导出。
- 重复的合法摘要标记：采用最后一条，其余告警。
- 看起来像摘要标记但格式无效：整行剥离并告警，避免变成未跟踪内容阻断写回。
- `sourceHash` 与当前原文不一致时，预览提示“可能过期”，但仍作为上下文使用。
- `glossary` 是随摘要生成的文档术语表；`brief` 是可选翻译要求，每个字段 trim 后最多 400 字符，空字段不写入。
- 旧缓存没有 `glossary`/`brief` 时按空处理，兼容读取。
- 清除缓存会删除摘要；清除摘要但保留译文时，缓存会重新序列化。

实现：`summarySourceHash` 会先统一换行再计算 SHA-256，避免 CRLF 造成误判。

## 4.1 本机批注 sidecar

批注不写入缓存 Markdown，也不进入导出；它存放在与缓存同目录的 sidecar：

```text
<cache>.annotations.json
```

例如 `demo.zh.md` 对应 `demo.zh.annotations.json`。结构：

```json
{
  "version": 1,
  "annotations": [
    {
      "id": "user-a1b2c3d4e5f6",
      "blockId": "缓存锚点 id 或 src-<sourceHash>",
      "side": "source|target",
      "author": "ai|user",
      "kind": "source-issue|translation-uncertain|term|structure|note|request-change",
      "severity": "info|check",
      "message": "批注正文",
      "question": "可选",
      "sourceExcerpt": "可选",
      "targetExcerpt": "可选",
      "suggestion": "可选",
      "status": "open|resolved|dismissed",
      "sourceHash": "可选：写入时的原文哈希",
      "createdAt": "ISO 时间",
      "updatedAt": "ISO 时间"
    }
  ]
}
```

规则：

- 写入使用临时文件 + rename；损坏 JSON 读取为空白批注并记录告警，不阻断预览。
- 按 `blockId` 关联块；`sourceHash` 与当前块不同标记 stale，缓存重建后找不到则视为 orphan。
- AI 批注重跑会替换该块旧的 AI 批注，用户批注保留。
- 删除单个缓存会同时删除 sidecar；清空全部缓存会递归删除缓存根目录（含 sidecar）。

## 5. 删除墓碑

删除译文时，缓存块正文写成：

```html
<!-- mbs-deleted:<base64url(JSON)> -->
```

兼容旧格式：

```html
<!-- mbs-deleted -->
```

备份 JSON 字段：

| 字段 | 含义 |
| --- | --- |
| `none` | 无备份（旧墓碑或从未翻译过） |
| `mode` | 删除前的模式，仅允许 human/auto/copy/target |
| `content` | 删除前的译文正文，最长 500,000 字符 |
| `kind` | 删除前的块类型，仅供参考；恢复流程当前不读取 |
| `sourceHash` | 删除时的原文哈希，用于恢复“基于旧原文”的过期状态 |

解析要求：

- 标记必须独占一行。
- 不是标记、Base64/JSON 损坏、缺少正文、正文超限、模式非法时返回 `null`。
- 不允许嵌套 `deleted` 模式。
- 删除标记不是普通 Markdown，恢复时由 `undoDeleteTargetBlock` 解析备份并写回。

## 6. 解析与写回安全规则

### 6.1 行号保持

`parseCacheDocument` 把合法锚点行替换为空串而不是删除，所以 `cleanedText` 与原始缓存行数一致。这样：

- `anchorLine` 指向原始缓存中的锚点行；
- 块 `startLine` / `endLine` 可直接用于行级替换；
- 单块编辑不需要重新序列化整篇缓存。

### 6.2 写回阻断

同步/整篇重写前，`assertCacheWritable` 会阻断：

- 缓存含 `untracked` 块（无法判断归属）；
- 存在找不到原文的人工锁定块（`human` 孤儿），重写会丢用户成果。

机器孤儿和孤立锚点不会阻断，但会通过 warning 暴露，写回时丢弃。

单块编辑 `replaceCachedBlock` 也要求缓存没有 `untracked` 内容，否则无法安全按行号定位。

### 6.3 序列化后的闭环校验

`syncDocument` 生成缓存草案后会：

1. 重新解析草案；
2. 拒绝产生 `untracked` 块的结果；
3. 确认每个锚点仍能定位到对应块；
4. 用实际解析出的块哈希回填 `dst`；
5. 再序列化/解析一次，得到最终文本。

这能捕获“译文正文意外引入块级结构或空行”的问题，避免把坏缓存交给用户。

### 6.4 缓存文件写入

`CacheStore.write`：

- 缓存文件已在编辑器中打开且有未保存修改：拒绝写入；
- 已打开但未脏：通过 `WorkspaceEdit` 整体替换并保存，让标签页立即看到新内容；
- 未打开：直接写文件。

写文件不是事务；进程崩溃可能留下截断缓存。源文件写回有文件锁与内存回滚，但缓存没有事务日志。

### 6.5 删除

- 删除单个缓存时，若缓存正在编辑器中打开，拒绝删除。
- 清除所有缓存时，若有任意缓存标签页打开，拒绝执行。
- 删除优先使用系统回收站，失败再永久删除。

## 7. 兼容性要求

修改缓存格式时：

1. 不要重命名字段或改变字段语义；旧缓存没有版本号，只能靠宽容解析。
2. 新增字段必须是可选的，并让旧缓存缺少字段时仍可工作。
3. 继续使用 base64url，不要直接写原始 JSON 或含换行的内容。
4. 保持锚点行独占一行、字段字符集受限。
5. 更新 `anchor`、`summaryMarker`、`deletedMarker`、`sync`、`editCache` 相关测试。
6. 手工构造的坏例（重复 id、损坏锚点、未跟踪块）必须继续产生 warning/阻断，而不是被静默接受。

相关测试：

- [`test/anchors.test.ts`](../test/anchors.test.ts)
- [`test/summaryMarker.test.ts`](../test/summaryMarker.test.ts)
- [`test/editCache.test.ts`](../test/editCache.test.ts)
- [`test/sync.test.ts`](../test/sync.test.ts)
- [`test/syncEditing.test.ts`](../test/syncEditing.test.ts)
