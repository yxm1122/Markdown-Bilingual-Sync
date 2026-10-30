# 翻译质量评估

本项目包含一套可重复运行的翻译质量评估集与自动指标，用于回答两个问题：

1. 换模型、改提示词、加上下文后，译文是否真的变好？
2. 失败集中在哪类问题：漏译、术语、结构、受保护片段，还是语义/语气？

数据集约定、用例列表与参考译文说明见 [`eval/README.md`](../eval/README.md)。AI 批注质量（问题发现、候选处理项、独立执行性）使用独立数据集与流程，见 [`annotation-evaluation.md`](annotation-evaluation.md)。

## 1. 数据集

- `eval/manifest.json`：语言对、全局术语表和 17 个用例（新增 `heading-idiom`，覆盖标题习语与单块上下文回归）。
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
| `--glossary <path>` | 用 JSON 数组或摘要 candidate JSON 覆盖 manifest 术语表，用于测试 AI 术语对译文与重试的影响 |
| `--model <name>` / `--base-url <url>` | 覆盖 OpenAI 兼容配置 |
| `--api-key-env <name>` | 读取 Key 的环境变量名，默认 `MBS_API_KEY` |
| `--case-concurrency <n>` | 同时评估的用例数，默认 4；设为 1 可复现旧的串行耗时 |
| `--concurrency <n>` | Provider 请求并发上限，默认 `MBS_CONCURRENCY` 或 8 |
| `--thinking <on\|off\|default>` | 显式思考模式：on 发送 `enable_thinking:true`，off 发送 false，default 省略字段 |
| `--disable-thinking` / `--enable-thinking` | `--thinking off` / `--thinking on` 的简写 |
| `--batch-size <n>` / `--batch-token-budget <n>` / `--timeout <ms>` | 覆盖分批与超时参数 |
| `--help` | 查看完整帮助 |

其他环境变量：`MBS_API_BASE_URL`、`MBS_API_MODEL`、`MBS_BATCH_SIZE`、`MBS_BATCH_TOKEN_BUDGET`、`MBS_TIMEOUT_MS`、`MBS_CONCURRENCY`、`MBS_THINKING=enabled|disabled|default`、旧版 `MBS_DISABLE_THINKING=1`。

### 摘要/术语表生成评估

`eval:summary` 复用 `eval/manifest.json` 的 source 文档与用户术语表，直接调用 `Provider.summarize`，不进入翻译流程：

```bash
MBS_API_KEY=... npm run eval:summary -- \
  --provider openai \
  --model deepseek-ai/DeepSeek-V3.2 \
  --base-url https://api.siliconflow.cn/v1 \
  --out eval/reports/summary/current
```

报告同时记录模型原始输出（raw）与产品确定性过滤后的结果（filtered）：

- 条目数、平均每篇条数、原文中不存在的 source；
- source 与 target 相同、target 含 `/`/`、`/`or`/`或` 并列、含代码/URL/HTML；
- 与用户术语表冲突的条目；
- 只出现一次的条目（提示性指标）；
- 摘要词数、brief 字段与人工评分表。

默认应用产品过滤：source 至少出现两次、不重复用户术语，并丢弃并列译法/代码/原文=译文等条目；`--no-filter` 关闭过滤，`--min-occurrences 1` 只关闭频率门槛。摘要生成本身没有自动重试；runner error 用例保留在逐篇报告中，但不计入聚合平均值。

## 3. 速度与思考模式

用例默认 **并行 4 个**，所有用例共享同一个 Provider 请求并发上限（默认 8）。报告新增 `timing` 字段：`wallDurationMs` 是实际墙钟时间，`totalCaseDurationMs` 是各用例耗时之和；并行后前者通常明显小于后者。

```bash
# 显式开启思考，并行 4 个用例
MBS_API_KEY=... npm run eval:translation -- \
  --provider openai --model deepseek-ai/DeepSeek-V3.2 \
  --case-concurrency 4 --thinking on

# 显式关闭思考
MBS_API_KEY=... npm run eval:translation -- \
  --provider openai --model deepseek-ai/DeepSeek-V3.2 \
  --case-concurrency 4 --thinking off

# 服务端默认（不发送 enable_thinking）
npm run eval:translation -- --provider openai --model deepseek-ai/DeepSeek-V3.2 \
  --case-concurrency 4 --thinking default
```

注意：

- **default 不等于开启**：default 会省略 `enable_thinking`，由服务端决定；如果服务端默认非思考，这一组也不会思考。要确认是否真的思考，看报告里的 `Reasoning responses`（`responseCount` 中有多少响应包含 reasoning 内容或 reasoning token）。为 0 就说明模型从未思考。
- `on` 会显式发送 `enable_thinking:true`；部分服务不支持该字段或会忽略它，可能报错或仍不思考。
- `off` 发送 `enable_thinking:false`；同样取决于服务端是否支持。
- 请以报告中的 `thinkingMode`、`Reasoning responses`、耗时和候选质量为准，不要只看命令行参数。
- 用例并行会同时产生多个文件任务；如果服务端限流，降低 `--case-concurrency` 或 `--concurrency`。
- 评估保留成功批次：单个 Provider 批次超时/失败时，已完成块仍会写入候选并参与指标，缺失块按 `candidate.missing` 报出，整篇候选不会因为一个批次失败而被清空。
- 长文档或思考模型建议留出更长的 `--timeout`（例如 `180000`），并适当降低 `--case-concurrency`，避免并发拥塞把单批推过超时线。
- 只改评估指标/报告格式、不改翻译逻辑时，用 `--candidate-dir` 复用旧候选，评估本身几乎不耗时。

## 4. 输出

默认写入 `eval/reports/<timestamp>/`（gitignored）：

- `report.md`：总体指标、逐用例硬问题、逐块明细、人工评分表。
- `report.json`：机器可读结果，便于比较模型/版本。
- `human-review.md`：单独的人工评分表。
- `candidates/<case-id>.md`：生成的候选译文，便于人工对照。

翻译报告还会记录 `timing.retry`：自动重试事件数以及 `http`/`validation`/`protected`/`glossary` 比例。它只用于诊断，不参与 pass/fail；`0 event(s)` 表示这一轮没有触发任何请求级重试。摘要报告写入 `eval/reports/summary/<label>/`，包含 `prompt.txt`、逐篇 `candidates/<case-id>.json`（raw/filtered 术语与丢弃原因）和人工评分表。

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

## 5. 已知边界

- 评估集当前是 **en → zh-CN**，其他语言对需要新增对应参考译文；源词保留率等启发式依赖英文源文。
- 脚注定义现在参与翻译，但只覆盖同一段连续行；跨空行的多段脚注只有第一段会被翻译。预览仍把脚注区单独渲染，不提供逐块编辑入口。
- 文档术语表由摘要生成，只存在于缓存；翻译评估 CLI 默认直接使用 `eval/manifest.json` 的术语表，不读取文档术语表；需要测试 AI 术语时用 `--glossary` 传入 candidate JSON。摘要评估只检查生成质量，不验证译文质量。
- 链接 title 视为可翻译正文，不作为受保护片段；评估只检查链接目标地址是否保留。行内代码按 CommonMark 反引号规则识别，支持双反引号片段；代码片段内反斜杠没有转义含义。
- 源词保留率用于识别“只加标记、正文照抄”的输出，对大量保留英文专有名词的技术文本可能偏严；报告会给出具体块和比例。
- 参考相似度是字符 bigram Dice，适合发现大幅偏离，不适合判定“哪种译法更好”。
- `--provider mock` 的通过/失败只说明管线是否工作，不能作为翻译质量结论。
- 真实 Provider 的评估是手动步骤，不进入 CI；CI 只运行评估指标与数据集的单元测试。

## 6. 建议流程

1. 固定数据集、模型、参数，先跑一次基线。
2. 阅读 `report.md` 的硬问题和人工评分，记录主要错误类型。
3. 一次只改一个变量（提示词、批次策略、术语表、模型），重跑并对比 `report.json`。
4. 改摘要/术语表提示词时先跑 `eval:summary` 的 raw 指标，再跑默认 filtered 指标，分别判断提示词与确定性过滤的贡献。
5. 自动指标改善但人工评分不升，说明指标被“技巧性输出”误导，应优先看人工结果。
6. 新用例先过数据集自检测试，再纳入基线。
