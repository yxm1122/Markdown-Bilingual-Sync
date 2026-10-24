---
title: Bilingual preview demo
description: Phase 1 sample for Markdown Bilingual Sync
tags:
  - markdown
  - translation
---

# 双语 Markdown 同步

敏捷的棕色狐狸跳过了懒惰的狗。本段落保留了一段简短的英文文本及其对应的中文翻译。

## 手动增量同步

- 只翻译发生变化的块。
- 保持人工编辑的锁定与可见。
- 在源文件更新后标记过时的块。

1. 使用 Mock 提供商翻译文档。
2. 在源文件中编辑一个段落并保存。
3. 运行**同步翻译**以仅刷新过时的块。

> [!NOTE]
> GitHub 警示框在双语预览中保持可见。

> 引用块将作为一个整体单元进行翻译。

| 功能 | 状态 | 备注 |
| --- | --- | --- |
| 双语预览 | 就绪 | 并排与交错显示 |
| 手动同步 | 就绪 | 陈旧块将被标记 |
| AI 提供商 | 就绪 | OpenAI 兼容的聊天补全 |
| 术语表与导出 | 就绪 | 全局术语表，差异导出 |

### 代码、数学公式和任务列表

```ts
const mode: "bilingual" | "source" | "target" = "bilingual";
```

行内数学公式 $E = mc^2$ 由 KaTeX 渲染。

$$
\int_0^1 x^2\,dx = \frac{1}{3}
$$

- [x] 解析 Markdown 块
- [x] 对齐原文与译文
- [x] 添加真实的 AI 提供商

![预览图表](assets/demo.svg)

脚注引用保持了文档的连接性。[^1]

---

[^1]: Footnote definitions are copied unchanged across languages.
