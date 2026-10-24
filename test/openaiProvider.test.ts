/** 测试：OpenAI 兼容 Provider 的请求、解析与防护。 */
import { describe, expect, it } from "vitest";
import {
  OpenAITranslationProvider,
  resolveChatCompletionsUrl,
  sanitizeRemoteMessage,
  selectGlossary,
  type OpenAIProviderConfig,
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
) {
  const calls: FetchCall[] = [];
  const provider = new OpenAITranslationProvider({
    getConfig: () => ({ ...BASE_CONFIG, ...config }),
    retryDelayMs: 0,
    limiter,
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

    expect(summary).toBe(
      "This document explains the translation workflow.",
    );
    expect(calls).toHaveLength(1);
    const body = JSON.parse(String(calls[0].init.body)) as {
      messages: Array<{ role: string; content: string }>;
    };
    expect(body.messages[0].content).toContain("reference summary");
    expect(JSON.parse(body.messages[1].content).text).toBe(
      "# Workflow\n\nSteps.",
    );
  });

  it("sends enable_thinking only when thinking is disabled", async () => {
    const handler = async () =>
      completion('{"items":[{"id":"b1","text":"你好。"}]}');

    const { provider: thinkingProvider, calls: thinkingCalls } =
      configuredProvider(handler);
    await thinkingProvider.translate(request([item("b1", "Hello.")]));
    const thinkingBody = JSON.parse(String(thinkingCalls[0].init.body)) as {
      enable_thinking?: boolean;
    };
    expect(thinkingBody.enable_thinking).toBeUndefined();

    const { provider: noThinkingProvider, calls: noThinkingCalls } =
      configuredProvider(handler, { disableThinking: true });
    await noThinkingProvider.translate(request([item("b1", "Hello.")]));
    const noThinkingBody = JSON.parse(
      String(noThinkingCalls[0].init.body),
    ) as { enable_thinking?: boolean };
    expect(noThinkingBody.enable_thinking).toBe(false);
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
