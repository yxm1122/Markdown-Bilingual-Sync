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
| Format errors | 重试后仍无法解析的响应数。 |

`standalone` 是启发式：检查动作词、是否只是“是/否/第一种”、是否缺少具体词句锚点。它不能判断语义是否正确；最终仍需 `human-review.md` 的 0–2 评分。

## 3. 基线

2026-10-30，`deepseek-ai/DeepSeek-V3.2`（SiliconFlow，thinking default），9 个用例：

| 运行 | Precision | Recall | Clean FP | Option coverage | Standalone | Mode | Format errors | Prompt |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 合并前提示词 | 60.0% | 85.7% | 2/2 | 28.6% | 57.1% | 100%* | 1 | 1635 chars |
| 合并后 v1 | 87.5% | 100.0% | 1/2 | 100.0% | 100.0% | 100% | 0 | 2887 chars |
| 最终 v3 第 1 次 | 87.5% | 100.0% | 1/2 | 100.0% | 100.0% | 100% | 0 | 3304 chars |
| 最终 v3 第 2 次 | 100.0% | 100.0% | 0/2 | 100.0% | 100.0% | 80% | 0 | 3304 chars |
| 压缩版 2 次 | 77.8–100.0% | 100.0% | 0/2 | 100.0% | 100.0% | 100% | 0 | 2689 chars |

\* 合并前可用 instruction 较少，mode 只统计实际存在的指令。

完整结果保存在本机 `eval/reports/annotations/`（gitignored）。主要变化来自：把 `suggestion`/`suggestedAnswers` 合并为带类型的 `options`，明确 instruction 必须自包含、advice 只给人看，并要求对明确修法直接给一条指令。v3 在复评后又加了两个由失败样本驱动的改动：`side` 语义（需要改译文时用 target，只有原文本身错误且译文忠实时才用 source）和干净术语示例（译文已使用术语表目标时不要报该术语）。压缩版把过长的 options 段落拆成三条短句、去掉重复表达，字符数从 3304 降到 2689（-18.6%）；最终压缩版两次整集中召回、处理项覆盖、独立执行和 mode 保持 100%，格式错误为 0。precision 和干净误报仍有波动：主要剩余噪声是原文矛盾时重复在 target 侧再报一次，以及干净块上偶发的语气建议；这两类不通过继续堆提示词解决。

## 4. 波动与判定

单次 9 个用例的样本很小，模型输出有波动。重复抽样观察到：

- `clean-save` 在 3 次中 1 次产生误报；
- `recurring-cache` 在 3 次中 1 次未检出/未匹配；
- `term-cache` 的模式选择在 `once`/`persistent` 之间波动；
- `multi-block` 偶尔同时给出 instruction 和 advice。

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
