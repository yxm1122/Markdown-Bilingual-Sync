/** 测试：OpenAI 兼容 Provider 的请求、解析与防护。 */
import { describe, expect, it } from "vitest";
import {
  OpenAITranslationProvider,
  buildReviewSystemPrompt,
  buildSummarySystemPrompt,
  buildTranslationSystemPrompt,
  resolveChatCompletionsUrl,
  sanitizeRemoteMessage,
  selectGlossary,
  type OpenAIRetryInfo,
  type OpenAIProviderConfig,
  type OpenAIProviderOptions,
} from "../src/translation/openaiProvider";
import type {
  TranslationItem,
  TranslationRequest,
} from "../src/translation/types";
import {
  ConcurrencyLimiter,
  type RequestLimiter,
} from "../src/translation/concurrency";
import { MAX_ANNOTATIONS_PER_BLOCK } from "../src/annotations/types";
import { MAX_DOCUMENT_GLOSSARY_ENTRIES } from "../src/glossary/glossary";

const BASE_CONFIG: OpenAIProviderConfig = {
  baseUrl: "https://api.example.com/v1",
  model: "test-model",
  apiKey: "sk-test-secret",
  batchSize: 12,
  timeoutMs: 10_000,
};

interface FetchCall {
  url: string;
  init: RequestInit;
}

function item(id: string, text: string): TranslationItem {
  return { id, text, kind: "paragraph", headingPath: ["Intro"] };
}

function request(items: TranslationItem[]): TranslationRequest {
  return {
    sourceLanguage: "en",
    targetLanguage: "zh-CN",
    items,
    glossary: [],
  };
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function completion(content: string, status = 200): Response {
  return new Response(
    JSON.stringify({
      choices: [{ message: { role: "assistant", content } }],
    }),
    {
      status,
      headers: { "Content-Type": "application/json" },
    },
  );
}

function configuredProvider(
  handler: (call: FetchCall) => Promise<Response>,
  config: Partial<OpenAIProviderConfig> = {},
  limiter?: RequestLimiter,
  onResponse?: OpenAIProviderOptions["onResponse"],
  onRetry?: OpenAIProviderOptions["onRetry"],
) {
  const calls: FetchCall[] = [];
  const provider = new OpenAITranslationProvider({
    getConfig: () => ({ ...BASE_CONFIG, ...config }),
    retryDelayMs: 0,
    limiter,
    onResponse,
    onRetry,
    fetchImpl: (async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const call = { url: String(input), init: init ?? {} };
      calls.push(call);
      return handler(call);
    }) as typeof fetch,
  });
  return { provider, calls };
}

function userPayload(call: FetchCall): {
  sourceLanguage: string;
  targetLanguage: string;
  summary?: string;
  glossary: Array<{ source: string; target: string }>;
  items: Array<{
    id: string;
    text: string;
    headingPath: string[];
    reference?: { role: string; text: string };
    annotations?: Array<{
      author: string;
      kind: string;
      text: string;
    }>;
  }>;
} {
  const body = JSON.parse(String(call.init.body)) as {
    messages: Array<{ role: string; content: string }>;
  };
  return JSON.parse(body.messages[1].content);
}

describe("resolveChatCompletionsUrl", () => {
  it("appends the chat completions path once", () => {
    expect(
      resolveChatCompletionsUrl("https://api.openai.com/v1"),
    ).toBe("https://api.openai.com/v1/chat/completions");
    expect(
      resolveChatCompletionsUrl(
        "https://api.openai.com/v1/chat/completions/",
      ),
    ).toBe("https://api.openai.com/v1/chat/completions");
  });

  it("allows HTTP only for loopback hosts", () => {
    expect(
      resolveChatCompletionsUrl("http://127.0.0.1:11434/v1"),
    ).toBe("http://127.0.0.1:11434/v1/chat/completions");
    expect(() =>
      resolveChatCompletionsUrl("http://api.example.com/v1"),
    ).toThrow(/HTTPS/);
  });

  it("rejects credentials, query strings and invalid URLs", () => {
    expect(() =>
      resolveChatCompletionsUrl("https://user:pass@api.example.com/v1"),
    ).toThrow(/用户名或密码/);
    expect(() =>
      resolveChatCompletionsUrl("https://api.example.com/v1?key=x"),
    ).toThrow(/查询参数/);
    expect(() => resolveChatCompletionsUrl("not a url")).toThrow(/有效/);
  });
});

describe("OpenAITranslationProvider", () => {
  it("builds chat requests and parses fenced JSON responses", async () => {
    const { provider, calls } = configuredProvider(async () =>
      completion(
        '```json\n{"items":[{"id":"b1","text":"你好，世界。"}]}\n```',
      ),
    );

    const results = await provider.translate(request([item("b1", "Hello world.")]));

    expect(results).toEqual([{ id: "b1", text: "你好，世界。" }]);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(
      "https://api.example.com/v1/chat/completions",
    );
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer sk-test-secret");
    const body = JSON.parse(String(calls[0].init.body)) as {
      model: string;
      stream: boolean;
    };
    expect(body.model).toBe("test-model");
    expect(body.stream).toBe(false);
    expect(userPayload(calls[0]).items[0]).toMatchObject({
      id: "b1",
      text: "Hello world.",
      headingPath: ["Intro"],
    });
    const system = (JSON.parse(String(calls[0].init.body)) as {
      messages: Array<{ role: string; content: string }>;
    }).messages[0].content;
    expect(system).toContain(
      "Source language: en. Target language: zh-CN.",
    );
    expect(system).toContain("The kind field is the block type");
    expect(system.trim().endsWith("Do not wrap it in Markdown fences.")).toBe(
      true,
    );
  });

  it("allows neighbor context but requires independent item output", async () => {
    const { provider, calls } = configuredProvider(async () =>
      completion('{"items":[{"id":"b1","text":"你好。"}]}'),
    );

    await provider.translate(request([item("b1", "Hello.")]));

    const body = JSON.parse(String(calls[0].init.body)) as {
      messages: Array<{ role: string; content: string }>;
    };
    expect(body.messages[0].content).toContain(
      "may come from the same document or section",
    );
    expect(body.messages[0].content).toContain(
      "translate each item independently",
    );
  });

  it("sends stable reference and full-document summary in the request", async () => {
    const { provider, calls } = configuredProvider(async () =>
      completion('{"items":[{"id":"b1","text":"你好，世界。"}]}'),
    );
    const sourceItem = {
      ...item("b1", "Hello world."),
      reference: {
        text: "你好，世界。",
        role: "previous-target" as const,
      },
    };
    const sourceRequest: TranslationRequest = {
      ...request([sourceItem]),
      summary: "本文介绍扩展的翻译流程。",
    };

    await provider.translate(sourceRequest);

    const payload = userPayload(calls[0]);
    expect(payload.summary).toBe("本文介绍扩展的翻译流程。");
    expect(payload.items[0].reference).toEqual({
      role: "previous-target",
      text: "你好，世界。",
    });
  });

  it("sends the document brief with translation requests", async () => {
    const { provider, calls } = configuredProvider(async () =>
      completion('{"items":[{"id":"b1","text":"你好，世界。"}]}'),
    );

    await provider.translate({
      ...request([item("b1", "Hello world.")]),
      brief: {
        audience: "Developers",
        toneAndStyle: "Concise",
        doNotTranslate: "Payments API",
      },
    });

    const payload = JSON.parse(
      (JSON.parse(String(calls[0].init.body)) as {
        messages: Array<{ role: string; content: string }>;
      }).messages[1].content,
    ) as { brief?: unknown };
    expect(payload.brief).toEqual({
      audience: "Developers",
      toneAndStyle: "Concise",
      doNotTranslate: "Payments API",
    });
  });

  it("sends read-only neighbor context with single-block requests", async () => {
    const { provider, calls } = configuredProvider(async () =>
      completion('{"items":[{"id":"b1","text":"# 真正有影响力的指标"}]}'),
    );

    await provider.translate({
      ...request([item("b1", "# Text metrics that bite")]),
      context: {
        before: [{ kind: "heading", text: "# Metrics" }],
        after: [{ kind: "paragraph", text: "The numbers that matter." }],
      },
    });

    const payload = JSON.parse(
      (JSON.parse(String(calls[0].init.body)) as {
        messages: Array<{ role: string; content: string }>;
      }).messages[1].content,
    ) as { context?: unknown };
    expect(payload.context).toEqual({
      before: [{ kind: "heading", text: "# Metrics" }],
      after: [{ kind: "paragraph", text: "The numbers that matter." }],
    });
  });

  it("generates a plain-text source-language summary without translation JSON", async () => {
    const { provider, calls } = configuredProvider(async () =>
      completion("This document explains the translation workflow."),
    );

    const summary = await provider.summarize({
      text: "# Workflow\n\nSteps.",
      sourceLanguage: "en",
      targetLanguage: "zh-CN",
      title: "demo.md",
      documentMetadata: {
        relativePath: "docs/auth.md",
        title: "Auth Guide",
        name: "auth-api",
        tags: ["api"],
      },
    });

    expect(summary).toEqual({
      summary: "This document explains the translation workflow.",
      glossary: [],
    });
    expect(calls).toHaveLength(1);
    const body = JSON.parse(String(calls[0].init.body)) as {
      messages: Array<{ role: string; content: string }>;
    };
    expect(body.messages[0].content).toContain("reference summary");
    expect(body.messages[0].content).toContain(
      "Source language: en. Target language: zh-CN.",
    );
    expect(body.messages[0].content).toContain("read-only facts");
    expect(body.messages[0].content).not.toContain("Auth Guide");
    expect(JSON.parse(body.messages[1].content)).toMatchObject({
      text: "# Workflow\n\nSteps.",
      documentMetadata: {
        relativePath: "docs/auth.md",
        title: "Auth Guide",
        name: "auth-api",
        tags: ["api"],
      },
    });
  });

  it("parses a summary JSON and a document glossary", async () => {
    const { provider, calls } = configuredProvider(async () =>
      completion(
        JSON.stringify({
          summary: "本文介绍翻译流程。",
          glossary: [
            { source: "table", target: "表格" },
            { source: "table", target: "数据表" },
            { source: "", target: "无效" },
          ],
          brief: {
            audience: " Developers ",
            toneAndStyle: "   ",
            ambiguities: "Use the business sense.",
            doNotTranslate: "Payments API",
          },
        }),
      ),
    );

    const summary = await provider.summarize({
      text: "# Workflow\n\nSteps.",
      sourceLanguage: "en",
      targetLanguage: "zh-CN",
      glossary: [{ source: "cache", target: "缓存" }],
    });

    expect(summary).toEqual({
      summary: "本文介绍翻译流程。",
      glossary: [{ source: "table", target: "数据表" }],
      brief: {
        audience: "Developers",
        ambiguities: "Use the business sense.",
        doNotTranslate: "Payments API",
      },
    });
    const body = JSON.parse(String(calls[0].init.body)) as {
      messages: Array<{ role: string; content: string }>;
    };
    expect(JSON.parse(body.messages[1].content).glossary).toEqual([
      { source: "cache", target: "缓存" },
    ]);
  });

  it("returns validated review annotations without rewriting text", async () => {
    const { provider, calls } = configuredProvider(async () =>
      completion(
        JSON.stringify({
          annotations: [
            {
              id: "b1",
              side: "target",
              type: "translation-uncertain",
              severity: "check",
              message: "  Verify whether “bite” means business impact.  ",
              question: "Is this the intended sense?",
              suggestion: "Use the business sense.",
            },
            {
              id: "unknown",
              side: "target",
              type: "term",
              severity: "info",
              message: "Ignored.",
            },
          ],
        }),
      ),
    );

    const annotations = await provider.review({
      sourceLanguage: "en",
      targetLanguage: "zh-CN",
      glossary: [],
      items: [
        {
          id: "b1",
          kind: "heading",
          headingPath: [],
          sourceText: "# Text metrics that bite",
          targetText: "# 文本指标",
        },
      ],
    });

    expect(annotations).toEqual([
      {
        id: "b1",
        side: "target",
        type: "translation-uncertain",
        severity: "check",
        message: "Verify whether “bite” means business impact.",
        question: "Is this the intended sense?",
        options: [{ kind: "advice", text: "Use the business sense." }],
      },
    ]);
    const body = JSON.parse(String(calls[0].init.body)) as {
      messages: Array<{ role: string; content: string }>;
    };
    expect(body.messages[0].content).toContain(
      "You are a bilingual reviewer",
    );
    expect(body.messages[0].content).toContain(
      "Flag only material problems",
    );
    expect(body.messages[0].content).toContain("never rewrite");
    expect(body.messages[0].content).toContain("options");
  });

  it("normalizes new options and legacy answer fields", async () => {
    const { provider } = configuredProvider(async () =>
      completion(
        JSON.stringify({
          annotations: [
            {
              id: "b1",
              side: "target",
              type: "translation-uncertain",
              severity: "check",
              message: "Both fields.",
              question: "Which sense?",
              suggestion: "Use the business sense.",
              suggestedAnswers: [
                "Use the business sense here.",
                "Use a more formal alternative.",
                "Use the business sense here.",
                "Third distinct candidate.",
                "Fourth candidate is dropped.",
              ],
            },
            {
              id: "b1",
              side: "target",
              type: "term",
              severity: "info",
              message: "Answer without a question.",
              suggestedAnswers: ["Ignored."],
            },
            {
              id: "b1",
              side: "target",
              type: "term",
              severity: "info",
              message: "Suggestion only.",
              suggestion: "Use the glossary term.",
            },
          ],
        }),
      ),
    );

    const annotations = await provider.review({
      sourceLanguage: "en",
      targetLanguage: "zh-CN",
      glossary: [],
      items: [
        {
          id: "b1",
          kind: "paragraph",
          headingPath: [],
          sourceText: "Text that bites.",
          targetText: "会咬人的文本。",
        },
      ],
    });

    expect(annotations).toEqual([
      {
        id: "b1",
        side: "target",
        type: "translation-uncertain",
        severity: "check",
        message: "Both fields.",
        question: "Which sense?",
        options: [
          {
            kind: "instruction",
            text: "Use the business sense here.",
            mode: "once",
          },
          {
            kind: "instruction",
            text: "Use a more formal alternative.",
            mode: "once",
          },
          {
            kind: "instruction",
            text: "Third distinct candidate.",
            mode: "once",
          },
        ],
      },
      {
        id: "b1",
        side: "target",
        type: "term",
        severity: "info",
        message: "Answer without a question.",
      },
      {
        id: "b1",
        side: "target",
        type: "term",
        severity: "info",
        message: "Suggestion only.",
        options: [{ kind: "advice", text: "Use the glossary term." }],
      },
    ]);
  });

  it("parses typed options without requiring a question", async () => {
    const { provider } = configuredProvider(async () =>
      completion(
        JSON.stringify({
          annotations: [
            {
              id: "b1",
              side: "target",
              type: "translation-uncertain",
              severity: "check",
              message: "The options are typed.",
              options: [
                {
                  kind: "instruction",
                  text: "将“30 秒”改为“60 秒”。",
                  mode: "persistent",
                },
                {
                  kind: "advice",
                  text: "请确认超时时间。",
                },
                {
                  kind: "instruction",
                  text: "将“预览”改为“预览视图”。",
                },
                {
                  kind: "instruction",
                  text: "第四个处理项应被丢弃。",
                },
                {
                  kind: "unknown",
                  text: "Invalid kind.",
                },
              ],
            },
          ],
        }),
      ),
    );

    const annotations = await provider.review({
      sourceLanguage: "en",
      targetLanguage: "zh-CN",
      glossary: [],
      items: [
        {
          id: "b1",
          kind: "paragraph",
          headingPath: [],
          sourceText: "Set the timeout to 60 seconds.",
          targetText: "将超时设置为 30 秒。",
        },
      ],
    });

    expect(annotations).toEqual([
      {
        id: "b1",
        side: "target",
        type: "translation-uncertain",
        severity: "check",
        message: "The options are typed.",
        options: [
          {
            kind: "instruction",
            text: "将“30 秒”改为“60 秒”。",
            mode: "persistent",
          },
          { kind: "advice", text: "请确认超时时间。" },
          {
            kind: "instruction",
            text: "将“预览”改为“预览视图”。",
            mode: "once",
          },
        ],
      },
    ]);
  });

  it("retries a malformed review response once", async () => {
    let attempt = 0;
    const { provider, calls } = configuredProvider(async () => {
      attempt += 1;
      return completion(
        attempt === 1
          ? "This is not JSON."
          : '{"annotations":[]}',
      );
    });

    const annotations = await provider.review({
      sourceLanguage: "en",
      targetLanguage: "zh-CN",
      glossary: [],
      items: [
        {
          id: "b1",
          kind: "paragraph",
          headingPath: [],
          sourceText: "Hello.",
          targetText: "你好。",
        },
      ],
    });

    expect(annotations).toEqual([]);
    expect(calls).toHaveLength(2);
    const body = JSON.parse(String(calls[1].init.body)) as {
      messages: Array<{ role: string; content: string }>;
    };
    expect(body.messages[0].content).toContain(
      "not a valid annotation list",
    );
  });

  it("sends explicit enable_thinking for enabled and disabled modes", async () => {
    const handler = async () =>
      completion('{"items":[{"id":"b1","text":"你好。"}]}');

    const bodyFor = async (
      config: Partial<OpenAIProviderConfig>,
    ): Promise<{ enable_thinking?: boolean }> => {
      const { provider, calls } = configuredProvider(handler, config);
      await provider.translate(request([item("b1", "Hello.")]));
      return JSON.parse(String(calls[0].init.body)) as {
        enable_thinking?: boolean;
      };
    };

    expect((await bodyFor({})).enable_thinking).toBeUndefined();
    expect(
      (await bodyFor({ thinking: "default" })).enable_thinking,
    ).toBeUndefined();
    expect(
      (await bodyFor({ thinking: "enabled" })).enable_thinking,
    ).toBe(true);
    expect(
      (await bodyFor({ thinking: "disabled" })).enable_thinking,
    ).toBe(false);
    expect(
      (await bodyFor({ disableThinking: true })).enable_thinking,
    ).toBe(false);
    // 扩展同时传 thinking:"default" 和旧 disableThinking:true 时必须仍然关闭。
    expect(
      (
        await bodyFor({
          thinking: "default",
          disableThinking: true,
        })
      ).enable_thinking,
    ).toBe(false);
    expect(
      (
        await bodyFor({
          thinking: "enabled",
          disableThinking: true,
        })
      ).enable_thinking,
    ).toBe(true);
  });

  it("reports whether a response contains reasoning", async () => {
    const seen: boolean[] = [];
    const { provider } = configuredProvider(
      async () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  role: "assistant",
                  content: '{"items":[{"id":"b1","text":"你好。"}]}',
                  reasoning_content: "先分析再翻译。",
                },
              },
            ],
            usage: {
              completion_tokens_details: { reasoning_tokens: 12 },
            },
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
      {},
      undefined,
      (info) => seen.push(info.hasReasoning),
    );

    await provider.translate(request([item("b1", "Hello.")]));

    expect(seen).toEqual([true]);
  });

  it("splits requests into batches and reports progress", async () => {
    const { provider, calls } = configuredProvider(async (call) => {
      const payload = userPayload(call);
      return completion(
        JSON.stringify({
          items: payload.items.map((entry) => ({
            id: entry.id,
            text: `译:${entry.text}`,
          })),
        }),
      );
    }, { batchSize: 2 });
    const progress: Array<[number, number]> = [];
    const chunks: Array<[string[], number]> = [];

    const results = await provider.translate(
      request([item("b1", "one"), item("b2", "two"), item("b3", "three")]),
      undefined,
      (completed, total) => progress.push([completed, total]),
      (items, completed) => {
        chunks.push([items.map((entry) => entry.id), completed]);
      },
    );

    expect(calls).toHaveLength(2);
    expect(calls.map((call) => userPayload(call).items.length)).toEqual([
      2, 1,
    ]);
    expect(results.map((entry) => entry.id)).toEqual(["b1", "b2", "b3"]);
    expect(chunks).toEqual([
      [["b1", "b2"], 2],
      [["b3"], 3],
    ]);
    expect(progress).toEqual([
      [2, 3],
      [3, 3],
    ]);
  });

  it("packs batches by token budget instead of a fixed block count", async () => {
    const { provider, calls } = configuredProvider(
      async (call) => {
        const payload = userPayload(call);
        return completion(
          JSON.stringify({
            items: payload.items.map((entry) => ({
              id: entry.id,
              text: `译:${entry.text.slice(0, 8)}`,
            })),
          }),
        );
      },
      { batchSize: 50, tokenBudget: 500 },
    );
    const items = [
      item("b1", "x".repeat(2500)),
      item("b2", "y".repeat(2500)),
      item("b3", "z".repeat(2500)),
    ];

    const results = await provider.translate(request(items));

    expect(calls).toHaveLength(3);
    expect(calls.map((call) => userPayload(call).items.length)).toEqual([
      1, 1, 1,
    ]);
    expect(results).toHaveLength(3);
  });

  it("runs batches concurrently under the shared limiter", async () => {
    const limiter = new ConcurrencyLimiter(() => 2);
    let active = 0;
    let maximum = 0;
    const { provider, calls } = configuredProvider(
      async (call) => {
        active += 1;
        maximum = Math.max(maximum, active);
        await delay(10);
        active -= 1;
        const payload = userPayload(call);
        return completion(
          JSON.stringify({
            items: payload.items.map((entry) => ({
              id: entry.id,
              text: `译:${entry.text}`,
            })),
          }),
        );
      },
      { batchSize: 1, tokenBudget: 6000 },
      limiter,
    );
    const items = Array.from({ length: 6 }, (_, index) =>
      item(`b${index}`, `text ${index}`),
    );

    const results = await provider.translate(request(items));

    expect(calls).toHaveLength(6);
    expect(maximum).toBe(2);
    expect(results.map((entry) => entry.id).sort()).toEqual([
      "b0",
      "b1",
      "b2",
      "b3",
      "b4",
      "b5",
    ]);
  });

  it("sends only glossary terms relevant to the current batch", async () => {
    const { provider, calls } = configuredProvider(async (call) => {
      const payload = userPayload(call);
      return completion(
        JSON.stringify({
          items: payload.items.map((entry) => ({
            id: entry.id,
            text: "使用 API。",
          })),
        }),
      );
    });

    await provider.translate({
      ...request([item("b1", "Use the API.")]),
      glossary: [
        { source: "API", target: "接口" },
        { source: "unrelated", target: "无关" },
      ],
    });

    expect(userPayload(calls[0]).glossary).toEqual([
      { source: "API", target: "接口" },
    ]);
  });

  it("retries once with missing glossary targets and uses the corrected result", async () => {
    let attempt = 0;
    const { provider, calls } = configuredProvider(async () => {
      attempt += 1;
      return completion(
        JSON.stringify({
          items: [
            {
              id: "b1",
              text:
                attempt === 1
                  ? "下表汇总状态。"
                  : "下面的表格汇总了状态。",
            },
          ],
        }),
      );
    });

    const results = await provider.translate({
      ...request([item("b1", "The table below summarizes the state.")]),
      glossary: [{ source: "table", target: "表格" }],
    });

    expect(results).toEqual([
      { id: "b1", text: "下面的表格汇总了状态。" },
    ]);
    expect(calls).toHaveLength(2);
    const body = JSON.parse(String(calls[1].init.body)) as {
      messages: Array<{ role: string; content: string }>;
    };
    expect(body.messages[0].content).toContain(
      'required glossary targets: [{"source":"table","target":"表格"}]',
    );
  });

  it("accepts a result after one glossary retry still misses the target", async () => {
    const { provider, calls } = configuredProvider(async () =>
      completion('{"items":[{"id":"b1","text":"下表汇总状态。"}]}'),
    );

    const results = await provider.translate({
      ...request([item("b1", "The table below summarizes the state.")]),
      glossary: [{ source: "table", target: "表格" }],
    });

    expect(results).toEqual([{ id: "b1", text: "下表汇总状态。" }]);
    expect(calls).toHaveLength(2);
  });

  it("reports glossary retry diagnostics without changing the result", async () => {
    let attempt = 0;
    const retries: OpenAIRetryInfo[] = [];
    const { provider } = configuredProvider(
      async () => {
        attempt += 1;
        return completion(
          JSON.stringify({
            items: [
              {
                id: "b1",
                text: attempt === 1 ? "下表汇总状态。" : "下面的表格汇总了状态。",
              },
            ],
          }),
        );
      },
      {},
      undefined,
      undefined,
      (info) => retries.push(info),
    );

    const results = await provider.translate({
      ...request([item("b1", "The table below summarizes the state.")]),
      glossary: [{ source: "table", target: "表格" }],
    });

    expect(results).toEqual([
      { id: "b1", text: "下面的表格汇总了状态。" },
    ]);
    expect(retries).toEqual([
      { reasons: ["glossary"], attempt: 2, batchSize: 1, itemIds: ["b1"] },
    ]);
  });

  it("reports review parse retry diagnostics", async () => {
    let attempt = 0;
    const retries: OpenAIRetryInfo[] = [];
    const { provider } = configuredProvider(
      async () => {
        attempt += 1;
        return completion(
          attempt === 1
            ? '{"annotations":[{"id":"b1"}]}'
            : '{"annotations":[{"id":"b1","side":"target","type":"term","severity":"check","message":"请核对术语。"}]}',
        );
      },
      {},
      undefined,
      undefined,
      (info) => retries.push(info),
    );

    const annotations = await provider.review({
      sourceLanguage: "en",
      targetLanguage: "zh-CN",
      glossary: [],
      items: [
        {
          id: "b1",
          kind: "paragraph",
          headingPath: [],
          sourceText: "Use the cache.",
          targetText: "使用快取。",
        },
      ],
    });

    expect(annotations).toHaveLength(1);
    expect(annotations[0]?.id).toBe("b1");
    expect(retries).toEqual([
      { reasons: ["review-parse"], attempt: 2, batchSize: 1, itemIds: ["b1"] },
    ]);
  });

  it("reports HTTP and validation retry diagnostics", async () => {
    const httpRetries: OpenAIRetryInfo[] = [];
    let httpAttempt = 0;
    const httpProvider = configuredProvider(
      async () => {
        httpAttempt += 1;
        if (httpAttempt === 1) {
          return completion("temporary failure", 500);
        }
        return completion('{"items":[{"id":"b1","text":"已翻译。"}]}');
      },
      {},
      undefined,
      undefined,
      (info) => httpRetries.push(info),
    ).provider;

    await httpProvider.translate(request([item("b1", "Translate this.")]));
    expect(httpRetries).toEqual([
      {
        reasons: ["http"],
        attempt: 2,
        batchSize: 1,
        itemIds: ["b1"],
        delayMs: 0,
        status: 500,
      },
    ]);

    const validationRetries: OpenAIRetryInfo[] = [];
    let validationAttempt = 0;
    const validationProvider = configuredProvider(
      async () => {
        validationAttempt += 1;
        return completion(
          validationAttempt === 1
            ? '{"items":[]}'
            : '{"items":[{"id":"b1","text":"已翻译。"}]}',
        );
      },
      {},
      undefined,
      undefined,
      (info) => validationRetries.push(info),
    ).provider;

    await validationProvider.translate(
      request([item("b1", "Translate this.")]),
    );
    expect(validationRetries).toEqual([
      { reasons: ["validation"], attempt: 2, batchSize: 1, itemIds: ["b1"] },
    ]);
  });

  it("retries once when inline code is replaced by quoted prose", async () => {
    const source =
      "Use `Translate Current File` to create a translation.";
    let attempt = 0;
    const { provider, calls } = configuredProvider(async () => {
      attempt += 1;
      return completion(
        JSON.stringify({
          items: [
            {
              id: "b1",
              text:
                attempt === 1
                  ? "使用“翻译当前文件”功能创建译稿。"
                  : "使用 `Translate Current File` 功能创建译稿。",
            },
          ],
        }),
      );
    });

    const results = await provider.translate(request([item("b1", source)]));

    expect(results).toEqual([
      { id: "b1", text: "使用 `Translate Current File` 功能创建译稿。" },
    ]);
    expect(calls).toHaveLength(2);
    const body = JSON.parse(String(calls[1].init.body)) as {
      messages: Array<{ role: string; content: string }>;
    };
    expect(body.messages[0].content).toContain(
      "removed or changed protected Markdown",
    );
    expect(body.messages[0].content).toContain("`Translate Current File`");
  });

  it("accepts a result after one inline-code retry still misses the span", async () => {
    const { provider, calls } = configuredProvider(async () =>
      completion(
        '{"items":[{"id":"b1","text":"使用“翻译当前文件”功能创建译稿。"}]}',
      ),
    );

    const results = await provider.translate(
      request([item("b1", "Use `Translate Current File` to create a translation.")]),
    );

    expect(results).toEqual([
      { id: "b1", text: "使用“翻译当前文件”功能创建译稿。" },
    ]);
    expect(calls).toHaveLength(2);
  });

  it("retries once when an alert marker is translated", async () => {
    const source = "> [!WARNING]\n> Do not deploy during the freeze.";
    let attempt = 0;
    const { provider, calls } = configuredProvider(async () => {
      attempt += 1;
      return completion(
        JSON.stringify({
          items: [
            {
              id: "b1",
              text:
                attempt === 1
                  ? "> [!警告]\n> 冻结期间请勿部署。"
                  : "> [!WARNING]\n> 冻结期间请勿部署。",
            },
          ],
        }),
      );
    });

    const results = await provider.translate(request([item("b1", source)]));

    expect(results).toEqual([
      { id: "b1", text: "> [!WARNING]\n> 冻结期间请勿部署。" },
    ]);
    expect(calls).toHaveLength(2);
    const body = JSON.parse(String(calls[1].init.body)) as {
      messages: Array<{ role: string; content: string }>;
    };
    expect(body.messages[0].content).toContain("[!WARNING]");
    expect(body.messages[0].content).toContain("protected Markdown");
  });

  it("lists batch glossary terms in the system prompt", async () => {
    const { provider, calls } = configuredProvider(async () =>
      completion(
        '{"items":[{"id":"b1","text":"下面的表格汇总了状态。"}]}',
      ),
    );

    await provider.translate({
      ...request([item("b1", "The table below summarizes the state.")]),
      glossary: [{ source: "table", target: "表格" }],
    });

    const body = JSON.parse(String(calls[0].init.body)) as {
      messages: Array<{ role: string; content: string }>;
    };
    expect(body.messages[0].content).toContain(
      "Required glossary for this batch",
    );
    expect(body.messages[0].content).toContain(
      '{"source":"table","target":"表格"}',
    );
  });

  it("does not match a glossary term inside a longer word", async () => {
    let calls = 0;
    const { provider } = configuredProvider(async () => {
      calls += 1;
      return completion(
        '{"items":[{"id":"b1","text":"这篇文章解释了流程。"}]}',
      );
    });

    await provider.translate({
      ...request([item("b1", "This article explains the process.")]),
      glossary: [{ source: "art", target: "艺术" }],
    });

    expect(calls).toBe(1);
  });

  it("requires an API key before making a request", async () => {
    const { provider, calls } = configuredProvider(
      async () => completion('{"items":[]}'),
      { apiKey: "" },
    );

    await expect(
      provider.translate(request([item("b1", "Hello")])),
    ).rejects.toThrow(/API Key/);
    expect(calls).toHaveLength(0);
  });

  it("retries a rate-limited request once", async () => {
    let attempts = 0;
    const { provider, calls } = configuredProvider(async () => {
      attempts += 1;
      if (attempts === 1) {
        return new Response(
          JSON.stringify({ error: { message: "rate limit" } }),
          { status: 429 },
        );
      }
      return completion('{"items":[{"id":"b1","text":"你好。"}]}');
    });

    const results = await provider.translate(request([item("b1", "Hello")]));
    expect(results).toEqual([{ id: "b1", text: "你好。" }]);
    expect(calls).toHaveLength(2);
  });

  it("retries invalid model output once with a corrective hint", async () => {
    const { provider, calls } = configuredProvider(async () =>
      completion("This is not JSON."),
    );

    await expect(
      provider.translate(request([item("b1", "Hello")])),
    ).rejects.toThrow(/不是有效 JSON/);
    expect(calls).toHaveLength(2);
    const body = JSON.parse(String(calls[1].init.body)) as {
      messages: Array<{ role: string; content: string }>;
    };
    expect(body.messages[0].content).toContain(
      "previous response was rejected",
    );
  });

  it("adds specific id hints and keeps the output contract last", async () => {
    let attempt = 0;
    const { provider, calls } = configuredProvider(async () => {
      attempt += 1;
      return completion(
        attempt === 1
          ? '{"items":[]}'
          : '{"items":[{"id":"b1","text":"你好。"}]}',
      );
    });

    await provider.translate(request([item("b1", "Hello.")]));

    expect(calls).toHaveLength(2);
    const body = JSON.parse(String(calls[1].init.body)) as {
      messages: Array<{ role: string; content: string }>;
    };
    expect(body.messages[0].content).toContain("missing ids");
    expect(body.messages[0].content).toContain("b1");
    expect(
      body.messages[0].content.trim().endsWith(
        "Do not wrap it in Markdown fences.",
      ),
    ).toBe(true);
  });

  it("recovers when the corrected retry returns valid translations", async () => {
    const source =
      "This paragraph is long enough to require an actual translation.";
    let attempt = 0;
    const { provider, calls } = configuredProvider(async () => {
      attempt += 1;
      return completion(
        JSON.stringify({
          items: [
            {
              id: "b1",
              text: attempt === 1 ? source : "这段文字足够长，需要实际翻译。",
            },
          ],
        }),
      );
    });

    const results = await provider.translate(request([item("b1", source)]));

    expect(results).toEqual([
      { id: "b1", text: "这段文字足够长，需要实际翻译。" },
    ]);
    expect(calls).toHaveLength(2);
  });

  it("rejects prompt text returned as translations", async () => {
    const { provider, calls } = configuredProvider(async () =>
      completion(
        'You are a professional Markdown translator.\nReturn only a JSON object in this exact shape: {"items":[{"id":"b1","text":"Hello"}]}',
      ),
    );

    await expect(
      provider.translate(request([item("b1", "Hello world.")])),
    ).rejects.toThrow(/提示词/);
    expect(calls).toHaveLength(2);
  });

  it("rejects an echoed request payload", async () => {
    const { provider } = configuredProvider(async (call) => {
      const payload = userPayload(call);
      return completion(
        JSON.stringify({
          sourceLanguage: "en",
          targetLanguage: "zh-CN",
          glossary: [],
          items: payload.items.map((entry) => ({
            id: entry.id,
            text: entry.text,
          })),
        }),
      );
    });

    await expect(
      provider.translate(request([item("b1", "Hello world.")])),
    ).rejects.toThrow(/请求内容/);
  });

  it("rejects a batch that returns every item unchanged", async () => {
    const source =
      "This paragraph is long enough to require an actual translation.";
    const { provider } = configuredProvider(async () =>
      completion(
        JSON.stringify({ items: [{ id: "b1", text: source }] }),
      ),
    );

    await expect(
      provider.translate(request([item("b1", source)])),
    ).rejects.toThrow(/原文/);
  });

  it("rejects unchanged CJK source text when the target is not CJK", async () => {
    const source = "这是一段足够长的中文句子，应该被翻译成英文而不是原样返回。";
    const { provider } = configuredProvider(async () =>
      completion(JSON.stringify({ items: [{ id: "b1", text: source }] })),
    );

    await expect(
      provider.translate({
        ...request([item("b1", source)]),
        sourceLanguage: "zh-CN",
        targetLanguage: "en",
      }),
    ).rejects.toThrow(/原文/);
  });

  it("rejects a substantial item returned unchanged alongside translated items", async () => {
    const source =
      "This paragraph is long enough to require an actual translation.";
    const { provider } = configuredProvider(async () =>
      completion(
        JSON.stringify({
          items: [
            { id: "b1", text: source },
            { id: "b2", text: "译文" },
          ],
        }),
      ),
    );

    await expect(
      provider.translate(
        request([item("b1", source), item("b2", "Translation")]),
      ),
    ).rejects.toThrow(/原文/);
  });

  it("allows short unchanged items alongside translated ones", async () => {
    const { provider } = configuredProvider(async () =>
      completion(
        JSON.stringify({
          items: [
            { id: "b1", text: "GitHub Actions" },
            { id: "b2", text: "译文" },
          ],
        }),
      ),
    );

    const results = await provider.translate(
      request([item("b1", "GitHub Actions"), item("b2", "Translation")]),
    );
    expect(results).toHaveLength(2);
  });

  it("allows short CJK, link-only, and code-only items to stay unchanged", async () => {
    const items = [
      item("b1", "产品名称"),
      item("b2", "[Architecture](/架构/设计.md)"),
      item("b3", "`pnpm install --filter @scope/app --frozen-lockfile`"),
    ];
    const { provider } = configuredProvider(async () =>
      completion(
        JSON.stringify({
          items: items.map((entry) => ({ id: entry.id, text: entry.text })),
        }),
      ),
    );

    const results = await provider.translate({
      ...request(items),
      sourceLanguage: "zh-CN",
      targetLanguage: "en",
    });
    expect(results).toHaveLength(3);
  });

  it("rejects partial translations that keep a long source sentence", async () => {
    const source =
      "The quick brown fox jumps over the lazy dog. This paragraph keeps a short English text next to its Chinese translation.";
    const translated =
      "The quick brown fox jumps over the lazy dog. 这段文字在其中文译文旁保留了一段简短的英文。";
    const { provider } = configuredProvider(async () =>
      completion(
        JSON.stringify({ items: [{ id: "b1", text: translated }] }),
      ),
    );

    await expect(
      provider.translate(request([item("b1", source)])),
    ).rejects.toThrow(/未翻译的原文句子/);
  });

  it("redacts key-like values from remote error messages", async () => {
    const { provider } = configuredProvider(async () =>
      new Response(
        JSON.stringify({
          error: {
            message: "Incorrect API key provided: sk-supersecret123",
          },
        }),
        { status: 401 },
      ),
    );

    let message = "";
    try {
      await provider.translate(request([item("b1", "Hello")]));
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("HTTP 401");
    expect(message).toContain("sk-***");
    expect(message).not.toContain("sk-supersecret123");
  });

  it("honors a pre-aborted signal", async () => {
    const { provider, calls } = configuredProvider(async () =>
      completion('{"items":[]}'),
    );
    const controller = new AbortController();
    controller.abort();

    await expect(
      provider.translate(
        request([item("b1", "Hello")]),
        controller.signal,
      ),
    ).rejects.toThrow(/已取消/);
    expect(calls).toHaveLength(0);
  });

  it("sends user annotations on the item, not at the request root", async () => {
    const { provider, calls } = configuredProvider(async (call) => {
      const payload = userPayload(call);
      return completion(
        JSON.stringify({
          items: payload.items.map((entry) => ({
            id: entry.id,
            text: "你好。",
          })),
        }),
      );
    });
    const annotated: TranslationItem = {
      ...item("b1", "Hello."),
      annotations: [
        {
          author: "user",
          kind: "request-change",
          text: "Use a formal tone.",
        },
      ],
    };

    await provider.translate(request([annotated]));

    const payload = userPayload(calls[0]);
    expect(payload.items[0].annotations).toEqual([
      {
        author: "user",
        kind: "request-change",
        text: "Use a formal tone.",
      },
    ]);
    expect(
      Object.prototype.hasOwnProperty.call(payload, "annotations"),
    ).toBe(false);
  });
});

describe("testConnection", () => {
  it("sends a minimal request and returns latency and sample", async () => {
    const { provider, calls } = configuredProvider(async (call) => {
      const payload = userPayload(call);
      return completion(
        JSON.stringify({
          items: payload.items.map((entry) => ({
            id: entry.id,
            text: "你好，这是一次连接测试。",
          })),
        }),
      );
    }, { disableThinking: true });

    const result = await provider.testConnection("en", "zh-CN");

    expect(result.model).toBe("test-model");
    expect(result.endpoint).toBe(
      "https://api.example.com/v1/chat/completions",
    );
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(result.sample).toContain("连接测试");
    expect(result.thinkingDisabled).toBe(true);
    expect(result.thinkingMode).toBe("disabled");
    expect(calls).toHaveLength(1);
    expect(userPayload(calls[0]).items[0]).toMatchObject({
      id: "mbs-connection-test",
      kind: "paragraph",
    });
  });

  it("fails when the service echoes the test sentence", async () => {
    const { provider } = configuredProvider(async (call) => {
      const payload = userPayload(call);
      return completion(
        JSON.stringify({
          items: payload.items.map((entry) => ({
            id: entry.id,
            text: entry.text,
          })),
        }),
      );
    });

    await expect(provider.testConnection("en", "zh-CN")).rejects.toThrow(
      /原文/,
    );
  });

  it("requires an API key before testing", async () => {
    const { provider, calls } = configuredProvider(
      async () => completion('{"items":[]}'),
      { apiKey: "" },
    );

    await expect(provider.testConnection("en", "zh-CN")).rejects.toThrow(
      /API Key/,
    );
    expect(calls).toHaveLength(0);
  });
});

describe("prompt structure", () => {
  it("keeps the echo markers in the current translation prompt", () => {
    const prompt = buildTranslationSystemPrompt("en", "zh-CN");
    for (const marker of [
      "You are a professional Markdown translator.",
      "The input may mix source and target language within one item",
      "Treat headingPath as context only",
      "The kind field is the block type",
    ]) {
      expect(prompt).toContain(marker);
    }
    expect(prompt).toContain("Source language: en. Target language: zh-CN.");
  });

  it("makes user annotations override the reference baseline", () => {
    const prompt = buildTranslationSystemPrompt("en", "zh-CN");
    expect(prompt).toContain(
      "A user annotation that requests a change overrides this baseline.",
    );
    expect(prompt).toContain(
      "follow the requested information or change, even when it conflicts with the reference",
    );
    expect(prompt).toContain(
      "Annotations never override glossary entries or the output contract.",
    );
  });

  it("writes the summary and review in the configured output language", () => {
    const summary = buildSummarySystemPrompt("en", "zh-CN");
    expect(summary).toContain(
      "Source language: en. Target language: zh-CN.",
    );
    expect(summary).toContain(
      "Output language for the summary and translation guidance: zh-CN.",
    );
    expect(
      buildSummarySystemPrompt("en", "zh-CN", "ja-JP"),
    ).toContain(
      "Output language for the summary and translation guidance: ja-JP.",
    );
    expect(summary).toContain(
      `at most ${MAX_DOCUMENT_GLOSSARY_ENTRIES} entries (storage limit)`,
    );
    expect(summary).toContain("translation decisions, not vocabulary");
    expect(summary).toContain("appears at least twice");
    expect(summary).toContain("exactly one target");
    expect(summary).toContain('Never combine alternatives with "/", "、"');
    expect(summary).toContain("Do not copy entries whose source does not appear");
    expect(summary).toContain("Never pad entries to reach a count");

    const review = buildReviewSystemPrompt("en", "zh-CN", "ja-JP");
    expect(review).toContain(
      "Write annotation messages, questions, and options in ja-JP",
    );
    expect(review).toContain("keep sourceExcerpt and targetExcerpt verbatim");
    expect(review).toContain(
      `Max ${MAX_ANNOTATIONS_PER_BLOCK} per id`,
    );
  });
});

describe("glossary and response helpers", () => {
  it("filters glossary entries case-insensitively", () => {
    expect(
      selectGlossary(
        [
          { source: "Markdown", target: "Markdown 标记" },
          { source: "absent", target: "缺失" },
        ],
        [item("b1", "Write markdown here.")],
      ),
    ).toEqual([{ source: "Markdown", target: "Markdown 标记" }]);
  });

  it("redacts bearer tokens and API keys", () => {
    const message = sanitizeRemoteMessage(
      "Authorization: Bearer abc.def.ghi api_key=plain-secret sk-project-abcdef123",
    );
    expect(message).not.toContain("abc.def.ghi");
    expect(message).not.toContain("plain-secret");
    expect(message).not.toContain("project-abcdef123");
    expect(message).toContain("Bearer ***");
  });
});
