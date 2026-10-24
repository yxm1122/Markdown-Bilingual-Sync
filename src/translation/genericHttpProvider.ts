/**
 * 自定义 HTTP 模板 Provider（translation/genericHttpProvider）
 *
 * 职责：把用户在设置里编写的 endpoint/headers/body JSON 模板渲染成请求，
 * 逐块发送，从 JSON（或纯文本）响应的指定路径取出译文。
 *
 * 关键不变量：
 * - 模板变量仅允许 {{text}}/{{id}}/{{kind}}/{{headingPath}}/{{sourceLanguage}}/
 *   {{targetLanguage}}/{{apiKey}}/{{referenceText}}/{{referenceRole}}/{{summary}}；
 *   未知变量在配置阶段直接拒绝；
 * - 每个待翻译块单独请求一次，结果必须非空、非原文（长句）、不超过 500k 字符；
 * - 请求 URL 与请求头在发送前重新校验，模板替换不会绕过 HTTPS/回环限制。
 *
 * 外部依赖：全局 fetch（可注入）、ConcurrencyLimiter、openaiProvider 的错误脱敏工具。
 *
 * 安全边界：
 * - 只允许 HTTPS，HTTP 仅限 localhost/127.0.0.1/[::1]；拒绝 URL 内嵌凭据与片段；
 * - 禁止模板设置 Host/Content-Length 与含换行的头值，防止请求头注入；
 * - API Key 只通过模板显式插入；所有对外错误文本都会遮盖密钥原文及其 URL 编码形式；
 * - 远端响应有 5MB 上限（读取后校验），JSON 路径读取只访问自有属性，避免原型链探测。
 */
import { sanitizeRemoteMessage } from "./openaiProvider";
import type { RequestLimiter } from "./concurrency";
import {
  validateTranslationResult,
  type ConnectionTestResult,
  type TranslationChunkHandler,
  type TranslationItem,
  type TranslationProgress,
  type TranslationProvider,
  type TranslationRequest,
  type TranslationResultItem,
} from "./types";

/** 原始 HTTP Provider 配置；模板字段均为用户设置中的字符串。 */
export interface GenericHttpProviderConfig {
  /** URL 模板，可包含允许的 {{变量}}。 */
  endpoint: string;
  /** HTTP 方法，仅 POST/PUT/PATCH。 */
  method: string;
  /** 请求头模板，必须是合法 JSON 对象。 */
  headersTemplate: string;
  /** 请求体模板，必须是合法 JSON。 */
  bodyTemplate: string;
  /** "json"（默认）或 "text"，决定响应解析方式。 */
  responseType: string;
  /** JSON 响应中译文的路径，如 choices[0].message.content。 */
  responsePath: string;
  /** API Key，仅在模板出现 {{apiKey}} 时使用。 */
  apiKey: string;
  /** 单请求超时毫秒数（会被裁剪到 1_000..600_000）。 */
  timeoutMs: number;
}

/** Provider 构造参数；getConfig 每次请求前调用。 */
export interface GenericHttpProviderOptions {
  /** 读取最新配置；可异步。 */
  getConfig: () =>
    | GenericHttpProviderConfig
    | Promise<GenericHttpProviderConfig>;
  /** 可注入 fetch，便于测试。 */
  fetchImpl?: typeof fetch;
  /** 可重试错误的首次重试等待毫秒数。 */
  retryDelayMs?: number;
  /** 全局请求并发限制器；缺省时逐块串行。 */
  limiter?: RequestLimiter;
}

/** 校验并解析后的配置；模板已解析为对象，但变量在每次请求时渲染。 */
interface NormalizedConfig {
  endpoint: string;
  method: "POST" | "PUT" | "PATCH";
  headers: Record<string, unknown>;
  body: unknown;
  responseType: "json" | "text";
  responsePath: string;
  apiKey: string;
  timeoutMs: number;
  /** 模板是否引用了 {{apiKey}}（当前仅用于配置期校验，运行时不再读取）。 */
  usesApiKey: boolean;
}

// ---- 常量与错误类型 ----
const DEFAULT_TIMEOUT_MS = 120_000;
const TEST_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 600_000;
const MAX_RESPONSE_BYTES = 5_000_000;
const MAX_TRANSLATION_LENGTH = 500_000;
const RETRYABLE_STATUS = new Set([408, 409, 429, 500, 502, 503, 504]);
const PLACEHOLDER = /\{\{([A-Za-z][A-Za-z0-9_]*)\}\}/g;
const ALLOWED_PLACEHOLDERS = new Set([
  "text",
  "id",
  "kind",
  "headingPath",
  "sourceLanguage",
  "targetLanguage",
  "apiKey",
  "referenceText",
  "referenceRole",
  "summary",
]);
const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/** 内部错误类型：retryable 决定是否在单块请求层重试一次。message 已脱敏。 */
class GenericHttpError extends Error {
  /** @param message 可直接展示的中文错误；@param retryable 是否可原样重试。 */
  constructor(
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "GenericHttpProviderError";
  }
}

// ---- 配置校验与归一化 ----

/** 判断是否为普通对象（排除 null、数组）；用于解析不可信 JSON。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** 把任意输入转为整数并裁剪到 [minimum, maximum]；不是有限数时返回 fallback。纯函数。 */
function clampInteger(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }
  return Math.min(maximum, Math.max(minimum, Math.trunc(numeric)));
}

/** 判断是否为回环主机（localhost、::1、127.0.0.0/8），仅用于放开本机 HTTP。纯函数。 */
function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return (
    host === "localhost" ||
    host === "::1" ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)
  );
}

/**
 * 校验模板只使用白名单变量；未知变量直接拒绝，避免把 `{{...}}` 原样发给服务。
 * 纯函数，错误信息中只包含变量名。
 */
function assertPlaceholders(template: string, setting: string): void {
  for (const match of template.matchAll(PLACEHOLDER)) {
    if (!ALLOWED_PLACEHOLDERS.has(match[1])) {
      throw new Error(
        `${setting} 包含未知模板变量 {{${match[1]}}}。允许的变量：${[...ALLOWED_PLACEHOLDERS].map((name) => `{{${name}}}`).join("、")}。`,
      );
    }
  }
}

/** 判断模板是否出现某个精确占位符（不做大小写或空格归一化）。纯函数。 */
function usesPlaceholder(template: string, name: string): boolean {
  return template.includes(`{{${name}}}`);
}

/** 把请求头模板解析为 JSON 对象；非法 JSON 或非对象时报错。纯函数。 */
function parseJsonObject(
  template: string,
  setting: string,
): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(template);
  } catch {
    throw new Error(`${setting} 必须是有效的 JSON 对象。`);
  }
  if (!isRecord(parsed)) {
    throw new Error(`${setting} 必须是 JSON 对象。`);
  }
  return parsed;
}

/** 解析请求体模板；允许任意 JSON 顶层类型（对象/数组/字符串），仅要求语法合法。纯函数。 */
function parseJsonBody(template: string): unknown {
  try {
    return JSON.parse(template);
  } catch {
    throw new Error("httpBody 必须是有效的 JSON。");
  }
}

/**
 * 校验并解析配置：端点/方法/模板必填，变量合法，模板可解析，密钥长度受限。
 * 若模板引用 {{apiKey}} 则密钥必填。纯函数，失败时抛出中文错误（不含密钥）。
 */
function normalizeConfig(config: GenericHttpProviderConfig): NormalizedConfig {
  const endpoint = String(config.endpoint ?? "").trim();
  if (!endpoint) {
    throw new Error("请设置 markdownBilingualSync.httpEndpoint。");
  }
  if (endpoint.length > 4096) {
    throw new Error("httpEndpoint 过长，请检查设置。");
  }
  const methodValue = String(config.method ?? "POST").trim().toUpperCase();
  if (
    methodValue !== "POST" &&
    methodValue !== "PUT" &&
    methodValue !== "PATCH"
  ) {
    throw new Error("httpMethod 仅支持 POST、PUT 或 PATCH。");
  }
  const headersTemplate = String(config.headersTemplate ?? "").trim();
  const bodyTemplate = String(config.bodyTemplate ?? "").trim();
  if (!headersTemplate) {
    throw new Error("请设置 markdownBilingualSync.httpHeaders（可为 {}）。");
  }
  if (!bodyTemplate) {
    throw new Error("请设置 markdownBilingualSync.httpBody。");
  }
  assertPlaceholders(endpoint, "httpEndpoint");
  assertPlaceholders(headersTemplate, "httpHeaders");
  assertPlaceholders(bodyTemplate, "httpBody");
  const headers = parseJsonObject(headersTemplate, "httpHeaders");
  const body = parseJsonBody(bodyTemplate);
  const apiKey = String(config.apiKey ?? "").trim();
  if (apiKey.length > 20_000) {
    throw new Error("API Key 过长，已拒绝使用。");
  }
  const usesApiKey =
    usesPlaceholder(endpoint, "apiKey") ||
    usesPlaceholder(headersTemplate, "apiKey") ||
    usesPlaceholder(bodyTemplate, "apiKey");
  if (usesApiKey && !apiKey) {
    throw new Error(
      "HTTP 模板使用了 {{apiKey}}，但尚未设置 API Key。请运行“设置 AI 翻译 API Key”。",
    );
  }

  return {
    endpoint,
    method: methodValue,
    headers,
    body,
    responseType: config.responseType === "text" ? "text" : "json",
    responsePath: String(config.responsePath ?? "").trim(),
    apiKey,
    timeoutMs: clampInteger(
      config.timeoutMs,
      DEFAULT_TIMEOUT_MS,
      1_000,
      MAX_TIMEOUT_MS,
    ),
    usesApiKey,
  };
}

// ---- 模板渲染与安全校验 ----

/**
 * 单次字符串替换：只替换 values 中存在的变量，未提供的占位符保持原样。
 * 不做递归替换，因此用户文本中即使包含 `{{apiKey}}` 也不会被二次展开。纯函数。
 */
function renderString(
  template: string,
  values: Record<string, string>,
): string {
  return template.replace(PLACEHOLDER, (match, name: string) =>
    Object.hasOwn(values, name) ? values[name] : match,
  );
}

/**
 * 递归渲染请求体模板：只处理字符串值，数组逐项、对象逐值处理，数字/布尔/null 原样保留。
 * 对象键不参与替换（避免通过键名注入）。纯函数。
 */
function renderJson(value: unknown, values: Record<string, string>): unknown {
  if (typeof value === "string") {
    return renderString(value, values);
  }
  if (Array.isArray(value)) {
    return value.map((item) => renderJson(item, values));
  }
  if (isRecord(value)) {
    const rendered: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      rendered[key] = renderJson(item, values);
    }
    return rendered;
  }
  return value;
}

/**
 * 遮盖文本中的密钥：同时替换原文与 encodeURIComponent 形式，再走通用错误脱敏。
 * 用于所有可能包含 URL/错误体的对外文本。纯函数。
 */
function redactKey(text: string, apiKey: string): string {
  let redacted = text;
  if (apiKey) {
    redacted = redacted.split(apiKey).join("***");
    const encoded = encodeURIComponent(apiKey);
    if (encoded !== apiKey) {
      redacted = redacted.split(encoded).join("***");
    }
  }
  return sanitizeRemoteMessage(redacted, 320);
}

/**
 * 渲染并校验最终 URL：apiKey 采用 URL 编码；渲染后再校验长度、协议、内嵌凭据与片段。
 * 必须在发送前调用，确保模板替换无法绕过 HTTPS/回环限制。纯函数。
 * @throws GenericHttpError（地址过长、非法、协议不允许或含凭据/片段）。
 */
function renderEndpoint(
  template: string,
  values: Record<string, string>,
  apiKey: string,
): string {
  const rendered = renderString(template, {
    ...values,
    apiKey: encodeURIComponent(apiKey),
  }).trim();
  if (rendered.length > 4096) {
    throw new GenericHttpError("HTTP 接口地址过长，请检查 httpEndpoint。");
  }
  let url: URL;
  try {
    url = new URL(rendered);
  } catch {
    throw new GenericHttpError("httpEndpoint 不是有效的 URL。");
  }
  const protocol = url.protocol.toLowerCase();
  if (
    protocol !== "https:" &&
    !(protocol === "http:" && isLoopbackHost(url.hostname))
  ) {
    throw new GenericHttpError(
      "HTTP 翻译接口必须使用 HTTPS；仅 localhost、127.0.0.1 或 [::1] 允许使用 HTTP。",
    );
  }
  if (url.username || url.password) {
    throw new GenericHttpError(
      "httpEndpoint 不能包含用户名或密码，请通过 {{apiKey}} 模板变量传递密钥。",
    );
  }
  if (url.hash) {
    throw new GenericHttpError("httpEndpoint 不能包含片段（#）。");
  }
  return url.toString();
}

/**
 * 渲染并校验请求头：名称必须符合 token 语法，禁止 Host/Content-Length，
 * 值必须是字符串且渲染后不能含 CR/LF，防止请求头注入。纯函数。
 * @throws GenericHttpError（非法名称、禁止的头或非字符串/含换行的值）。
 */
function renderHeaders(
  headers: Record<string, unknown>,
  values: Record<string, string>,
): Record<string, string> {
  const rendered: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!HEADER_NAME.test(name)) {
      throw new GenericHttpError(`httpHeaders 包含无效的请求头名称：${name}`);
    }
    if (/^(host|content-length)$/i.test(name)) {
      throw new GenericHttpError(`httpHeaders 不允许设置 ${name}。`);
    }
    if (typeof value !== "string") {
      throw new GenericHttpError(
        `httpHeaders 的 ${name} 必须是字符串。`,
      );
    }
    const renderedValue = renderString(value, values);
    if (/[\r\n]/.test(renderedValue)) {
      throw new GenericHttpError(
        `httpHeaders 的 ${name} 包含换行符，已拒绝发送。`,
      );
    }
    rendered[name] = renderedValue;
  }
  return rendered;
}

/**
 * 从错误响应中提取 detail：优先 error.message / message，否则整段文本，
 * 再经 redactKey 遮盖密钥。纯函数。
 */
function extractRemoteDetail(body: string, apiKey: string): string {
  try {
    const parsed: unknown = JSON.parse(body);
    if (isRecord(parsed)) {
      if (
        isRecord(parsed.error) &&
        typeof parsed.error.message === "string"
      ) {
        return redactKey(parsed.error.message, apiKey);
      }
      if (typeof parsed.message === "string") {
        return redactKey(parsed.message, apiKey);
      }
    }
  } catch {
    /* 非 JSON，按纯文本处理 */
  }
  return redactKey(body, apiKey);
}

/** 构造带状态提示的 HTTP 错误，仅 408/409/429/5xx 可重试；detail 会遮盖密钥。纯函数。 */
function createHttpError(
  status: number,
  body: string,
  apiKey: string,
): GenericHttpError {
  const detail = extractRemoteDetail(body, apiKey);
  const hint =
    status === 401 || status === 403
      ? "请检查 API Key、请求头模板与访问权限。"
      : status === 404
        ? "请检查 httpEndpoint 与请求方法。"
        : status === 429
          ? "请求过于频繁或额度不足，请稍后重试。"
          : "";
  const message = [
    `HTTP 翻译请求失败（HTTP ${status}）`,
    hint ? `：${hint}` : "",
    detail ? ` ${detail}` : "",
  ].join("");
  return new GenericHttpError(message, RETRYABLE_STATUS.has(status));
}

// ---- 响应读取与未翻译防护 ----

/**
 * 按点路径（支持 `a.b[0].c`）读取 JSON 值。
 * 只读取对象自有属性，数组下标必须是非负整数；任何一段不存在都返回 undefined。纯函数。
 */
function readPath(value: unknown, path: string): unknown {
  const trimmed = path.trim();
  if (!trimmed) {
    return value;
  }
  const tokens = trimmed
    .replace(/\[(\d+)\]/g, ".$1")
    .split(".")
    .filter(Boolean);
  let current = value;
  for (const token of tokens) {
    if (Array.isArray(current)) {
      const index = Number(token);
      if (!Number.isInteger(index) || index < 0) {
        return undefined;
      }
      current = current[index];
    } else if (isRecord(current)) {
      if (!Object.hasOwn(current, token)) {
        return undefined;
      }
      current = current[token];
    } else {
      return undefined;
    }
  }
  return current;
}

/** 比较用的归一化：折叠空白并去首尾。纯函数。 */
function normalizeForComparison(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * 未翻译防护：同语言直接放行；否则若长文本（≥40 字符且至少 4 个空格）
 * 的译文与原文归一化后完全相同，判定服务未翻译并拒绝该块。纯函数。
 */
function assertTranslated(
  source: string,
  target: string,
  sourceLanguage: string,
  targetLanguage: string,
): void {
  if (sourceLanguage.toLowerCase() === targetLanguage.toLowerCase()) {
    return;
  }
  const normalizedSource = normalizeForComparison(source);
  const normalizedTarget = normalizeForComparison(target);
  if (normalizedTarget !== normalizedSource) {
    return;
  }
  const spaces = (normalizedSource.match(/ /g) ?? []).length;
  if (normalizedSource.length >= 40 && spaces >= 4) {
    throw new GenericHttpError(
      "HTTP 翻译服务返回了原文，未执行翻译。请检查请求模板、响应路径与目标语言参数。",
    );
  }
}

/**
 * 可取消等待：ms<=0 立即完成；signal 触发时清除定时器并以“翻译已取消”拒绝。
 * 监听器只注册一次并在完成时移除。
 */
function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (milliseconds <= 0) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("翻译已取消"));
      return;
    }
    let timer: ReturnType<typeof setTimeout>;
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("翻译已取消"));
    };
    timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * 从响应体取译文：先做 5MB 上限检查；
 * - text 模式直接返回 trim 后文本；
 * - json 模式检测 error 对象，按 responsePath 取字符串（单元素字符串数组视作该字符串），
 *   并校验非空与 500k 长度上限。
 * @throws GenericHttpError（响应过大、非 JSON、路径不存在、空译文或错误对象）。
 */
function extractTranslation(
  body: string,
  config: NormalizedConfig,
): string {
  if (body.length > MAX_RESPONSE_BYTES) {
    throw new GenericHttpError("HTTP 翻译响应过大，已拒绝处理。");
  }
  if (config.responseType === "text") {
    const text = body.trim();
    if (!text) {
      throw new GenericHttpError("HTTP 翻译服务返回了空响应。");
    }
    return text;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new GenericHttpError(
      "HTTP 翻译服务返回了非 JSON 响应。可将 httpResponseType 设为 text，或用 httpResponsePath 指向文本字段。",
    );
  }
  if (isRecord(parsed) && isRecord(parsed.error)) {
    const message =
      typeof parsed.error.message === "string"
        ? redactKey(parsed.error.message, config.apiKey)
        : "";
    throw new GenericHttpError(
      `HTTP 翻译服务返回错误${message ? `：${message}` : "。"}`,
    );
  }
  let value = readPath(parsed, config.responsePath);
  if (
    Array.isArray(value) &&
    value.length === 1 &&
    typeof value[0] === "string"
  ) {
    value = value[0];
  }
  if (typeof value !== "string") {
    throw new GenericHttpError(
      config.responsePath
        ? `HTTP 翻译响应中找不到文本字段 httpResponsePath=${config.responsePath}。`
        : "HTTP 翻译响应不是文本。请设置 httpResponsePath。",
    );
  }
  const text = value.trim();
  if (!text) {
    throw new GenericHttpError("HTTP 翻译服务返回了空译文。");
  }
  if (text.length > MAX_TRANSLATION_LENGTH) {
    throw new GenericHttpError("HTTP 翻译结果过长，已拒绝写入。");
  }
  return text;
}

// ---- Provider 实现 ----

/**
 * 自定义 HTTP 实现：逐块请求，worker 池 + 全局限流器控制并发。
 * 每次 translate/testConnection 都重新读取配置并重新解析模板。
 */
export class GenericHttpTranslationProvider implements TranslationProvider {
  readonly id = "http";
  readonly label = "AI 翻译（自定义 HTTP）";

  private readonly fetchImpl: typeof fetch;
  private readonly retryDelayMs: number;
  private readonly limiter?: RequestLimiter;

  /** 注入 fetch（默认全局 fetch）与重试延迟；limiter 可选。无副作用。 */
  constructor(private readonly options: GenericHttpProviderOptions) {
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.retryDelayMs = Math.max(0, options.retryDelayMs ?? 700);
    this.limiter = options.limiter;
  }

  /**
   * 逐块翻译并增量交付。
   *
   * 并发模型：worker 数 = min(块数, limiter.limit)，共享递增下标；每个块再经 limiter.run
   * 获取全局并发槽。无 limiter 时串行。
   *
   * 失败与取消：任一块最终失败会置 stopped，不再取新块；signal 触发时停止取块并 abort
   * 正在进行的 fetch，最终以“翻译已取消” reject。onChunk 抛错同样会停止后续块。
   *
   * @returns 全部块的结果（顺序不保证，按 id 对应）。
   */
  async translate(
    request: TranslationRequest,
    signal?: AbortSignal,
    onProgress?: TranslationProgress,
    onChunk?: TranslationChunkHandler,
  ): Promise<TranslationResultItem[]> {
    if (signal?.aborted) {
      throw new Error("翻译已取消");
    }
    if (request.items.length === 0) {
      return [];
    }
    const config = normalizeConfig(await this.options.getConfig());
    const results: TranslationResultItem[] = [];
    let completed = 0;
    let nextItem = 0;
    let stopped = false;
    let failure: unknown;
    // worker 数不超过块数与全局并发上限；无 limiter 时退化为串行。
    const workerCount = Math.max(
      1,
      Math.min(request.items.length, this.limiter?.limit ?? 1),
    );

    // 共享递增下标派发块；单线程 JS 中 nextItem++ 足以保证每块只被取一次。
    const runWorker = async (): Promise<void> => {
      while (!stopped && !signal?.aborted) {
        const index = nextItem;
        nextItem += 1;
        if (index >= request.items.length) {
          return;
        }
        const item = request.items[index];
        try {
          const text = await this.translateItem(
            config,
            request,
            item,
            signal,
          );
          const result = { id: item.id, text };
          results.push(result);
          completed += 1;
          await onChunk?.([result], completed, request.items.length);
          onProgress?.(completed, request.items.length);
        } catch (error) {
          failure = error;
          stopped = true;
          return;
        }
      }
    };

    await Promise.all(
      Array.from({ length: workerCount }, () => runWorker()),
    );
    if (signal?.aborted) {
      throw new Error("翻译已取消");
    }
    if (failure) {
      throw failure;
    }
    validateTranslationResult(request.items, results);
    return results;
  }

  /**
   * 用一句测试文本验证模板、地址与密钥；超时限制为 TEST_TIMEOUT_MS。
   * endpoint 返回前会用 redactKey 遮盖密钥。不写入任何缓存。
   * @throws 配置/网络错误、未翻译或取消。
   */
  async testConnection(
    sourceLanguage: string,
    targetLanguage: string,
    signal?: AbortSignal,
  ): Promise<ConnectionTestResult> {
    if (signal?.aborted) {
      throw new Error("翻译已取消");
    }
    const config = normalizeConfig(await this.options.getConfig());
    const testItem: TranslationItem = {
      id: "mbs-connection-test",
      kind: "paragraph",
      headingPath: [],
      text: /^zh/i.test(sourceLanguage)
        ? "你好，这是一次连接测试。"
        : "Hello, this is a connection test.",
    };
    const testRequest: TranslationRequest = {
      sourceLanguage,
      targetLanguage,
      items: [testItem],
      glossary: [],
    };
    const started = Date.now();
    const text = await this.translateItem(
      { ...config, timeoutMs: Math.min(config.timeoutMs, TEST_TIMEOUT_MS) },
      testRequest,
      testItem,
      signal,
    );
    const endpoint = renderEndpoint(
      config.endpoint,
      this.templateValues(testRequest, testItem),
      config.apiKey,
    );
    return {
      model: "自定义 HTTP",
      endpoint: redactKey(endpoint, config.apiKey),
      latencyMs: Date.now() - started,
      sample: text.slice(0, 160),
      thinkingDisabled: false,
    };
  }

  // ---- 单块请求与重试 ----

  /**
   * 构造单个块的模板变量（不含 apiKey；由 requestOnce 追加）。
   * headingPath 用 " > " 连接，text 原样传入。纯函数。
   */
  private templateValues(
    request: TranslationRequest,
    item: TranslationItem,
  ): Record<string, string> {
    return {
      text: item.text,
      id: item.id,
      kind: item.kind,
      headingPath: item.headingPath.join(" > "),
      sourceLanguage: request.sourceLanguage,
      targetLanguage: request.targetLanguage,
      referenceText: item.reference?.text ?? "",
      referenceRole: item.reference?.role ?? "",
      summary: request.summary ?? "",
    };
  }

  /** 经全局限流器执行单个请求；无 limiter 时直接执行。 */
  private runLimited<T>(
    task: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    return this.limiter ? this.limiter.run(task, signal) : task();
  }

  /**
   * 翻译单个块：最多重试 1 次可重试错误（等待可被 signal 取消），
   * 然后执行未翻译防护。返回 trim 后的译文。
   * @throws GenericHttpError、配置错误或“翻译已取消”。
   */
  private async translateItem(
    config: NormalizedConfig,
    request: TranslationRequest,
    item: TranslationItem,
    signal?: AbortSignal,
  ): Promise<string> {
    let attempt = 0;
    for (;;) {
      try {
        const text = await this.runLimited(
          () => this.requestOnce(config, request, item, signal),
          signal,
        );
        assertTranslated(
          item.text,
          text,
          request.sourceLanguage,
          request.targetLanguage,
        );
        return text;
      } catch (error) {
        if (signal?.aborted) {
          throw new Error("翻译已取消");
        }
        if (
          error instanceof GenericHttpError &&
          error.retryable &&
          attempt < 1
        ) {
          attempt += 1;
          await delay(this.retryDelayMs, signal);
          continue;
        }
        throw error;
      }
    }
  }

  /**
   * 发送一次模板请求（不重试）。
   *
   * 渲染顺序：变量 -> endpoint（apiKey 做 URL 编码）-> headers -> body；
   * 内部 AbortController 同时响应外部 signal 与 timeoutMs，finally 负责清理定时器与监听器；
   * 外部取消优先于超时报告。
   *
   * @returns 原始响应文本经 extractTranslation 解析后的译文。
   * @throws GenericHttpError（已脱敏）、配置错误或“翻译已取消”。
   */
  private async requestOnce(
    config: NormalizedConfig,
    request: TranslationRequest,
    item: TranslationItem,
    signal?: AbortSignal,
  ): Promise<string> {
    const values = {
      ...this.templateValues(request, item),
      apiKey: config.apiKey,
    };
    const endpoint = renderEndpoint(config.endpoint, values, config.apiKey);
    const headers = renderHeaders(config.headers, values);
    const body = JSON.stringify(renderJson(config.body, values));

    const controller = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, config.timeoutMs);
    const onAbort = () => controller.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) {
      controller.abort();
    }

    try {
      const response = await this.fetchImpl(endpoint, {
        method: config.method,
        headers,
        body,
        signal: controller.signal,
      });
      const responseText = await response.text();
      if (!response.ok) {
        throw createHttpError(response.status, responseText, config.apiKey);
      }
      return extractTranslation(responseText, config);
    } catch (error) {
      if (signal?.aborted) {
        throw new Error("翻译已取消");
      }
      if (timedOut) {
        throw new GenericHttpError(
          `HTTP 翻译请求超时（${Math.round(config.timeoutMs / 1000)} 秒），请检查网络或在设置中增大 apiTimeoutMs。`,
          true,
        );
      }
      if (error instanceof GenericHttpError) {
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new GenericHttpError(
        `无法连接 HTTP 翻译服务：${redactKey(message, config.apiKey)}`,
        true,
      );
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
    }
  }
}
