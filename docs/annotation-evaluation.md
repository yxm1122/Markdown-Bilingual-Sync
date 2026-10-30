# AI 批注评估

批注评估用于回答两个问题：

1. 改审校提示词后，问题发现变好了，还是只是 reply 更长了？
2. AI 给出的处理方式能不能直接放进翻译上下文，还是仍然依赖它自己的问题？

数据集与字段说明见 [`eval/review/README.md`](../eval/review/README.md)。翻译质量评估见 [`evaluation.md`](evaluation.md)，两者不混用。

## 1. 运行

Mock 只验证管线，不代表批注质量：

```bash
npm run eval:annotations -- --provider mock
```

OpenAI 兼容 Provider（Key 只从环境变量读取）：

```bash
MBS_API_KEY=... npm run eval:annotations -- \
  --provider openai \
  --base-url https://api.siliconflow.cn/v1 \
  --model deepseek-ai/DeepSeek-V3.2 \
  --label merged-options-v1 \
  --out eval/reports/annotations/merged-options-v1
```

复用已保存的原始批注重新计算指标，不调用模型：

```bash
npm run eval:annotations -- \
  --annotations-dir eval/reports/annotations/baseline-current/annotations \
  --out eval/reports/annotations/rechecked
```

与旧运行对比：

```bash
npm run eval:annotations -- ... \
  --baseline eval/reports/annotations/baseline-current/report.json
```

报告写入 `eval/reports/annotations/<目录>`（gitignored）：`report.md`、`report.json`、`human-review.md`、`annotations/`、`prompt.txt`，对比时额外生成 `comparison.md`。

## 2. 指标口径

| 指标 | 用途 |
| --- | --- |
| Precision / recall | 人工预期问题是否被发现；未匹配批注算误报。 |
| Clean false positive | 干净译文是否被无故报错。 |
| Option coverage | 预期问题是否得到可满足要求的 instruction/advice；instruction 还必须脱离问题可执行。mode 单独统计，不因 once/persistent 不符而抹掉可用指令。 |
| Standalone rate | 所有 instruction 中，能单独发送给翻译器的比例。 |
| Mode accuracy | 已有 instruction 的 `once`/`persistent` 是否符合预期；采纳时用户仍可改。 |
| Advice fallback | 需要人工判断的问题是否退回 advice，而不是编造指令。 |
| Type / severity accuracy | 已发现问题上的分类一致性；分类错不抹掉“已发现”。 |
| Avg message / annotation chars | message 长度，以及 message + question + options 的总长度，用于衡量啰嗦程度。 |
| Multi-instruction / advice-only | 是否真的给出多分支，还是始终只有一条或只有 advice。 |
| Procedural instructions | 持续指令是否在列举例子/步骤，而不是一句规则。 |
| Unsupported punctuation claims | 批注提到的标点是否真的出现在摘录中。 |
| Duplicate-field annotations | question/option 是否重复了 message。 |
| Format errors | 重试后仍无法解析的响应数。 |

`standalone` 是启发式：检查动作词、是否只是“是/否/第一种”、是否缺少具体词句锚点。它不能判断语义是否正确；最终仍需 `human-review.md` 的 0–2 评分。

## 3. 基线

2026-10-30，`deepseek-ai/DeepSeek-V3.2`（SiliconFlow，thinking default）。早期 9 个用例：

| 运行 | Precision | Recall | Clean FP | Option coverage | Standalone | Mode | Format errors | Prompt |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 合并前提示词 | 60.0% | 85.7% | 2/2 | 28.6% | 57.1% | 100%* | 1 | 1635 chars |
| 合并后 v1 | 87.5% | 100.0% | 1/2 | 100.0% | 100.0% | 100% | 0 | 2887 chars |
| 最终 v3 第 1 次 | 87.5% | 100.0% | 1/2 | 100.0% | 100.0% | 100% | 0 | 3304 chars |
| 最终 v3 第 2 次 | 100.0% | 100.0% | 0/2 | 100.0% | 100.0% | 80% | 0 | 3304 chars |

当前 12 个用例（新增干净标题、代码块句号规则、开放双方案）：

| 提示词 | Precision | Recall | Clean FP | Option coverage | Standalone | Mode | Format | 平均 message | 平均 annotation |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 压缩版 2689，2 次 | 69.2–88.9% | 88.9–100.0% | 1/3 | 77.8–88.9% | 100.0% | 100% | 0 | 52.0 | 130.8–139.9 |
| Few-shot v11b，2 次 | 90.0–100.0% | 88.9–100.0% | 0–1/3 | 88.9–100.0% | 100.0% | 85.7–100% | 0 | 26.4–43.9 | 48.0–82.8 |

\* 合并前可用 instruction 较少，mode 只统计实际存在的指令。

完整结果保存在本机 `eval/reports/annotations/`（gitignored）。主要变化来自：把 `suggestion`/`suggestedAnswers` 合并为带类型的 `options`，明确 instruction 必须自包含、advice 只给人看。v11b 是 3608 字符、16 行的短规则 + 4 个 **与评测用例不重叠** 的 few-shot：默认端口数字修正、列表项英文句点规则、sidebar 术语双方案、计费标题干净示例。两次运行中代码块规则都收敛为一句 persistent，标题双方案都给出两条 persistent；截图标题一次通过、一次出现源语法 advice；source-contradiction 一次漏报。平均 message 从 52.0 降到 26.4–43.9 字符，平均批注从 130.8–139.9 降到 48.0–82.8。模型仍有采样波动，结论必须看多轮。

## 4. 波动与判定

单次 12 个用例的样本仍然很小，模型输出有波动。重复抽样观察到：

- `clean-save`、`clean-paraphrase` 偶发误报或 no-op 批注；
- `clean-heading` 在 v11b 中一次通过，一次出现源语法 advice；
- `recurring-cache` 偶尔未检出/未匹配；
- `source-contradiction` 在 v11b 一次漏报；
- `heading-choice` 偶尔只给一条或解析失败；v11b 的两次都给出了两条。

因此：

- 不要把 1–2 个百分点的变化当成提示词改进；
- 对关键用例做 3 次重复，或看 clean case 的通过率而不是单条批注；
- 优先看形态变化（instruction 是否自包含、advice 是否回退、格式错误是否消失），再看 precision/recall；
- 不为了“补齐”一个波动用例而堆规则。新增规则必须对应一个稳定的失败模式，并复跑同一套用例。

## 5. 提示词改动流程

1. 先跑当前提示词的基线，保存 `report.json` 和 `prompt.txt`。
2. 一次只改一个变量（规则、示例或输出形状），记录 `promptChars`。
3. 用同一数据集复跑，带 `--baseline` 生成对比。
4. 检查：问题召回不能下降；clean FP 不能上升；option coverage/standalone 应改善；格式错误不能增加。
5. 阅读 `human-review.md`，确认 instruction 语义正确、模式合理；自动指标通过但人工评分差，说明规则在“教模型写格式”，不是在解决问题。
6. 若新增规则没有稳定收益，撤回，而不是保留“可能有用”的句子。
