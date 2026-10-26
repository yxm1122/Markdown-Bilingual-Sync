/** 测试：OpenAI 兼容 Provider 的请求、解析与防护。 */
import { describe, expect, it } from "vitest";
import {
  OpenAITranslationProvider,
  resolveChatCompletionsUrl,
  sanitizeRemoteMessage,
  selectGlossary,
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
) {
  const calls: FetchCall[] = [];
  const provider = new OpenAITranslationProvider({
    getConfig: () => ({ ...BASE_CONFIG, ...config }),
    retryDelayMs: 0,
    limiter,
    onResponse,
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

  it("generates a plain-text source-language summary without translation JSON", async () => {
    const { provider, calls } = configuredProvider(async () =>
      completion("This document explains the translation workflow."),
    );

    const summary = await provider.summarize({
      text: "# Workflow\n\nSteps.",
      sourceLanguage: "en",
      targetLanguage: "zh-CN",
      title: "demo.md",
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
    expect(JSON.parse(body.messages[1].content).text).toBe(
      "# Workflow\n\nSteps.",
    );
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
    });
    const body = JSON.parse(String(calls[0].init.body)) as {
      messages: Array<{ role: string; content: string }>;
    };
    expect(JSON.parse(body.messages[1].content).glossary).toEqual([
      { source: "cache", target: "缓存" },
    ]);
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
      'required glossary targets: "table" -> "表格"',
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
    expect(body.messages[0].content).toContain('"table" -> "表格"');
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
