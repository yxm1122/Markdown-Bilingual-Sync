# 翻译质量评估

本项目包含一套可重复运行的翻译质量评估集与自动指标，用于回答两个问题：

1. 换模型、改提示词、加上下文后，译文是否真的变好？
2. 失败集中在哪类问题：漏译、术语、结构、受保护片段，还是语义/语气？

数据集约定、用例列表与参考译文说明见 [`eval/README.md`](../eval/README.md)。

## 1. 数据集

- `eval/manifest.json`：语言对、全局术语表和 16 个用例。
- `eval/cases/<id>/source.md`：英文原文。
- `eval/cases/<id>/reference.zh.md`：人工中文参考译文。
- 用例覆盖标题、段落、嵌套列表、表格、代码/公式、链接/图片/脚注、GitHub Alerts、跨段指代、术语、混合语言、长段落、frontmatter、中文标点、内联 HTML/转义、否定/数量表达，以及两篇完整的真实风格文档（项目 README 和运维 Runbook）。
- 参考译文是“高质量基线”，不是逐字匹配目标；报告中的参考相似度只是辅助信号。

新增用例时保持源文与参考译文的顶层块数量/类型一致，并复用全局术语表。

## 2. 运行

Mock Provider（离线，只验证评估管线；不代表翻译质量）：

```bash
npm run eval:translation -- --provider mock
```

OpenAI 兼容 Provider（Key 只从环境变量读取，不写入报告）：

```bash
MBS_API_KEY="..." npm run eval:translation -- \
  --provider openai \
  --model gpt-4o-mini \
  --base-url https://api.openai.com/v1
```

评估已有候选译文（不调用 Provider）：

```bash
npm run eval:translation -- \
  --candidate-dir tmp/my-candidates \
  --out tmp/eval-my-candidates
```

候选用例文件名必须为 `<case-id>.md`。

常用参数：

| 参数 | 说明 |
| --- | --- |
| `--manifest <path>` | 数据集清单，默认 `eval/manifest.json` |
| `--provider mock\|openai` | 生成候选译文的方式 |
| `--candidate-dir <dir>` | 直接评估已有候选文件 |
| `--out <dir>` | 报告目录，默认 `eval/reports/<timestamp>` |
| `--filter <text>` | 只运行 id/tag 包含该文本的用例 |
| `--model <name>` / `--base-url <url>` | 覆盖 OpenAI 兼容配置 |
| `--api-key-env <name>` | 读取 Key 的环境变量名，默认 `MBS_API_KEY` |
| `--help` | 查看完整帮助 |

其他环境变量：`MBS_API_BASE_URL`、`MBS_API_MODEL`、`MBS_BATCH_SIZE`、`MBS_BATCH_TOKEN_BUDGET`、`MBS_TIMEOUT_MS`、`MBS_CONCURRENCY`、`MBS_DISABLE_THINKING=1`。

## 3. 输出

默认写入 `eval/reports/<timestamp>/`（gitignored）：

- `report.md`：总体指标、逐用例硬问题、逐块明细、人工评分表。
- `report.json`：机器可读结果，便于比较模型/版本。
- `human-review.md`：单独的人工评分表。
- `candidates/<case-id>.md`：生成的候选译文，便于人工对照。

自动指标：

| 类别 | 指标 |
| --- | --- |
| 块完整性 | 缺失块、额外块、块类型不一致、空块 |
| 漏译/回显 | 源文整块/整句残留、源词保留率过高 |
| 受保护片段 | 代码、行内代码、URL、图片/链接目标、脚注 id、公式、HTML、Alert 标记 |
| 术语 | 源文出现的术语是否使用目标术语，按块统计 |
| 结构 | 标题级别、列表项数、任务项数、表格行/分隔行、引用行数、frontmatter |
| 参考 | 人工参考结构一致性；参考相似度（辅助） |
| 长度 | 候选/源长度比（辅助） |

**Pass/fail 只由硬问题决定。** 参考相似度和长度比例不参与 pass/fail；机器指标也不能判断语义准确性和自然度，必须结合 `human-review.md` 的人工评分。

## 4. 已知边界

- 评估集当前是 **en → zh-CN**，其他语言对需要新增对应参考译文；源词保留率等启发式依赖英文源文。
- **脚注定义目前不参与扩展翻译**：切块器把 `[^id]: ...` 识别为 `footnote` 并原样复制。评估故意把脚注定义视为可翻译正文，因此真实 Provider 的候选会在 `links-images-footnotes` 上暴露该质量差距。这是有意设计，不是评估误报；修复扩展切块语义后再复查。
- 源词保留率用于识别“只加标记、正文照抄”的输出，对大量保留英文专有名词的技术文本可能偏严；报告会给出具体块和比例。
- 参考相似度是字符 bigram Dice，适合发现大幅偏离，不适合判定“哪种译法更好”。
- `--provider mock` 的通过/失败只说明管线是否工作，不能作为翻译质量结论。
- 真实 Provider 的评估是手动步骤，不进入 CI；CI 只运行评估指标与数据集的单元测试。

## 5. 建议流程

1. 固定数据集、模型、参数，先跑一次基线。
2. 阅读 `report.md` 的硬问题和人工评分，记录主要错误类型。
3. 一次只改一个变量（提示词、批次策略、术语表、模型），重跑并对比 `report.json`。
4. 自动指标改善但人工评分不升，说明指标被“技巧性输出”误导，应优先看人工结果。
5. 新用例先过数据集自检测试，再纳入基线。
