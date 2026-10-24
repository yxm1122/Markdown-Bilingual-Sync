/** 测试：通用 HTTP Provider 的模板、脱敏与错误处理。 */
import { describe, expect, it } from "vitest";
import {
  GenericHttpTranslationProvider,
  type GenericHttpProviderConfig,
} from "../src/translation/genericHttpProvider";
import type {
  TranslationItem,
  TranslationRequest,
} from "../src/translation/types";
import {
  ConcurrencyLimiter,
  type RequestLimiter,
} from "../src/translation/concurrency";

const BASE_CONFIG: GenericHttpProviderConfig = {
  endpoint: "https://api.example.com/translate",
  method: "POST",
  headersTemplate: JSON.stringify({
    "Content-Type": "application/json",
    Authorization: "Bearer {{apiKey}}",
  }),
  bodyTemplate: JSON.stringify({
    q: "{{text}}",
    source: "{{sourceLanguage}}",
    target: "{{targetLanguage}}",
  }),
  responseType: "json",
  responsePath: "translation",
  apiKey: "secret-key-123",
  timeoutMs: 10_000,
};

interface FetchCall {
  url: string;
  init?: RequestInit;
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

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function createProvider(
  handler: (url: string, init?: RequestInit) => Promise<Response>,
  overrides: Partial<GenericHttpProviderConfig> = {},
  retryDelayMs = 0,
  limiter?: RequestLimiter,
) {
  const calls: FetchCall[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const text = String(url);
    calls.push({ url: text, init });
    return handler(text, init);
  }) as typeof fetch;
  const provider = new GenericHttpTranslationProvider({
    getConfig: () => ({ ...BASE_CONFIG, ...overrides }),
    fetchImpl,
    retryDelayMs,
    limiter,
  });
  return { provider, calls };
}

describe("GenericHttpTranslationProvider", () => {
  it("renders headers and a JSON body template and reads the response path", async () => {
    const { provider, calls } = createProvider(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      return jsonResponse({ translation: `译文：${body.q}` });
    });
    const sourceText = 'Line "one"\nLine two';
    const progress: Array<[number, number]> = [];

    const results = await provider.translate(
      request([item("a", sourceText)]),
      undefined,
      (completed, total) => progress.push([completed, total]),
    );

    expect(results).toEqual([{ id: "a", text: `译文：${sourceText}` }]);
    expect(progress).toEqual([[1, 1]]);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.example.com/translate");
    expect(calls[0].init?.method).toBe("POST");
    expect(calls[0].init?.headers).toMatchObject({
      "Content-Type": "application/json",
      Authorization: "Bearer secret-key-123",
    });
    const body = JSON.parse(String(calls[0].init?.body));
    expect(body).toEqual({
      q: sourceText,
      source: "en",
      target: "zh-CN",
    });
  });

  it("passes reference and summary template variables", async () => {
    const { provider, calls } = createProvider(
      async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        return jsonResponse({ translation: `译：${body.q}` });
      },
      {
        bodyTemplate: JSON.stringify({
          q: "{{text}}",
          reference: "{{referenceText}}",
          role: "{{referenceRole}}",
          summary: "{{summary}}",
        }),
      },
    );
    const sourceItem = {
      ...item("a", "Hello."),
      reference: {
        text: "旧译文",
        role: "previous-target" as const,
      },
    };
    await provider.translate({
      ...request([sourceItem]),
      summary: "全文摘要",
    });

    expect(JSON.parse(String(calls[0].init?.body))).toEqual({
      q: "Hello.",
      reference: "旧译文",
      role: "previous-target",
      summary: "全文摘要",
    });
  });

  it("sends one request per item and reports progress", async () => {
    const { provider, calls } = createProvider(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      return jsonResponse({ translation: `译：${body.q}` });
    });
    const progress: Array<[number, number]> = [];
    const chunks: string[][] = [];

    const results = await provider.translate(
      request([item("a", "First paragraph."), item("b", "Second paragraph.")]),
      undefined,
      (completed, total) => progress.push([completed, total]),
      (items) => {
        chunks.push(items.map((entry) => entry.id));
      },
    );

    expect(results.map((entry) => entry.id)).toEqual(["a", "b"]);
    expect(calls).toHaveLength(2);
    expect(chunks).toEqual([["a"], ["b"]]);
    expect(progress).toEqual([
      [1, 2],
      [2, 2],
    ]);
  });

  it("supports nested response paths and plain-text responses", async () => {
    const nested = createProvider(
      async () => jsonResponse({ data: { translations: [{ text: "嵌套译文" }] } }),
      { responsePath: "data.translations.0.text" },
    );
    await expect(
      nested.provider.translate(request([item("a", "Hello.")])),
    ).resolves.toEqual([{ id: "a", text: "嵌套译文" }]);

    const plain = createProvider(async () => new Response("纯文本译文"), {
      responseType: "text",
    });
    await expect(
      plain.provider.translate(request([item("a", "Hello.")])),
    ).resolves.toEqual([{ id: "a", text: "纯文本译文" }]);
  });

  it("runs per-item requests concurrently under the shared limiter", async () => {
    const limiter = new ConcurrencyLimiter(() => 2);
    let active = 0;
    let maximum = 0;
    const { provider, calls } = createProvider(
      async (_url, init) => {
        active += 1;
        maximum = Math.max(maximum, active);
        await new Promise((resolve) => setTimeout(resolve, 10));
        active -= 1;
        const body = JSON.parse(String(init?.body));
        return jsonResponse({ translation: `译:${body.q}` });
      },
      {},
      0,
      limiter,
    );
    const items = Array.from({ length: 4 }, (_, index) =>
      item(String(index), `text ${index}`),
    );

    const results = await provider.translate(request(items));

    expect(calls).toHaveLength(4);
    expect(maximum).toBe(2);
    expect(results.map((entry) => entry.id).sort()).toEqual([
      "0",
      "1",
      "2",
      "3",
    ]);
  });

  it("can omit the API key when no template references it", async () => {
    const { provider } = createProvider(
      async () => jsonResponse({ translation: "无密钥译文" }),
      {
        apiKey: "",
        headersTemplate: "{}",
        bodyTemplate: JSON.stringify({ text: "{{text}}" }),
      },
    );
    await expect(
      provider.translate(request([item("a", "Hello.")])),
    ).resolves.toEqual([{ id: "a", text: "无密钥译文" }]);
  });

  it("requires an API key when the template references it", async () => {
    const { provider } = createProvider(
      async () => jsonResponse({ translation: "不会调用" }),
      { apiKey: "" },
    );
    await expect(
      provider.translate(request([item("a", "Hello.")])),
    ).rejects.toThrow(/apiKey/);
  });

  it("rejects unknown template variables", async () => {
    const { provider } = createProvider(
      async () => jsonResponse({ translation: "不会调用" }),
      {
        bodyTemplate: JSON.stringify({ text: "{{unknownVariable}}" }),
      },
    );
    await expect(
      provider.translate(request([item("a", "Hello.")])),
    ).rejects.toThrow(/未知模板变量/);
  });

  it("rejects header values containing newlines", async () => {
    const { provider } = createProvider(
      async () => jsonResponse({ translation: "不会调用" }),
      {
        headersTemplate: JSON.stringify({ "X-Test": "{{text}}" }),
      },
    );
    await expect(
      provider.translate(request([item("a", "line one\nline two")])),
    ).rejects.toThrow(/换行符/);
  });

  it("surfaces HTTP errors without leaking the API key", async () => {
    const { provider, calls } = createProvider(async () =>
      jsonResponse(
        { error: { message: "bad key secret-key-123" } },
        401,
      ),
    );
    const failure = provider.translate(request([item("a", "Hello.")]));
    await expect(failure).rejects.toThrow(/HTTP 401/);
    await expect(failure).rejects.not.toThrow(/secret-key-123/);
    expect(calls).toHaveLength(1);
  });

  it("retries a retryable HTTP status once", async () => {
    let attempts = 0;
    const { provider, calls } = createProvider(async () => {
      attempts += 1;
      return attempts === 1
        ? jsonResponse({ error: "busy" }, 429)
        : jsonResponse({ translation: "重试成功" });
    });

    await expect(
      provider.translate(request([item("a", "Hello.")])),
    ).resolves.toEqual([{ id: "a", text: "重试成功" }]);
    expect(calls).toHaveLength(2);
  });

  it("rejects non-JSON responses in json mode", async () => {
    const { provider } = createProvider(
      async () => new Response("not json"),
    );
    await expect(
      provider.translate(request([item("a", "Hello.")])),
    ).rejects.toThrow(/非 JSON/);
  });

  it("rejects plain HTTP for remote hosts but allows loopback", async () => {
    const remote = createProvider(
      async () => jsonResponse({ translation: "不会调用" }),
      { endpoint: "http://api.example.com/translate" },
    );
    await expect(
      remote.provider.translate(request([item("a", "Hello.")])),
    ).rejects.toThrow(/HTTPS/);

    const local = createProvider(
      async () => jsonResponse({ translation: "本地译文" }),
      { endpoint: "http://127.0.0.1:8080/translate" },
    );
    await expect(
      local.provider.translate(request([item("a", "Hello.")])),
    ).resolves.toEqual([{ id: "a", text: "本地译文" }]);
  });

  it("reports a connection test result with a redacted endpoint", async () => {
    const { provider, calls } = createProvider(async () =>
      jsonResponse({ translation: "你好，连接成功。" }),
    );
    const result = await provider.testConnection("en", "zh-CN");
    expect(result.model).toBe("自定义 HTTP");
    expect(result.sample).toBe("你好，连接成功。");
    expect(result.endpoint).toBe("https://api.example.com/translate");
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(calls).toHaveLength(1);
  });
});
