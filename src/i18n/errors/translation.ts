/**
 * 翻译 Provider、路由器、批处理与结果校验相关错误文案。
 */
import type { ErrorMessage } from "./types";

export const TRANSLATION_ERRORS = [
  // ---- OpenAI 兼容 Provider：配置 ----
  {
    key: "translation.missingApiKey",
    en: "No AI translation API key is set. Run “Markdown Bilingual Sync: Set AI Translation API Key”.",
    zh: "尚未设置 AI 翻译 API Key。请运行“Markdown Bilingual Sync: 设置 AI 翻译 API Key”。",
  },
  {
    key: "translation.apiKeyTooLong",
    en: "The AI translation API key is too long and was rejected.",
    zh: "AI 翻译 API Key 过长，已拒绝使用。",
  },
  {
    key: "translation.missingModel",
    en: "Set markdownBilingualSync.apiModel (for example gpt-4o-mini).",
    zh: "请设置 markdownBilingualSync.apiModel（例如 gpt-4o-mini）。",
  },
  {
    key: "translation.modelTooLong",
    en: "apiModel is too long. Check the setting.",
    zh: "apiModel 过长，请检查设置。",
  },
  {
    key: "translation.baseUrlTooLong",
    en: "apiBaseUrl is too long. Check the setting.",
    zh: "apiBaseUrl 过长，请检查设置。",
  },
  {
    key: "translation.missingBaseUrl",
    en: "Set markdownBilingualSync.apiBaseUrl.",
    zh: "请设置 markdownBilingualSync.apiBaseUrl。",
  },
  {
    key: "translation.invalidBaseUrl",
    en: "apiBaseUrl is not a valid URL.",
    zh: "apiBaseUrl 不是有效的 URL。",
  },
  {
    key: "translation.httpsRequired",
    en: "The AI translation endpoint must use HTTPS; only localhost, 127.0.0.1, or [::1] may use HTTP.",
    zh: "AI 翻译接口必须使用 HTTPS；仅 localhost、127.0.0.1 或 [::1] 允许使用 HTTP。",
  },
  {
    key: "translation.baseUrlCredentials",
    en: "apiBaseUrl must not contain a username or password. Use the “Set AI Translation API Key” command to store the key.",
    zh: "apiBaseUrl 不能包含用户名或密码，请使用“设置 AI 翻译 API Key”命令保存密钥。",
  },
  {
    key: "translation.baseUrlQuery",
    en: "apiBaseUrl must not contain query parameters or a fragment.",
    zh: "apiBaseUrl 不能包含查询参数或片段。",
  },
  // ---- OpenAI 兼容 Provider：响应与请求 ----
  {
    key: "translation.nonJsonResponse",
    en: "The AI translation service returned a non-JSON response. Check that apiBaseUrl points to a Chat Completions endpoint.",
    zh: "AI 翻译服务返回了非 JSON 响应，请检查 apiBaseUrl 是否指向 Chat Completions 接口。",
  },
  {
    key: "translation.invalidResponseStructure",
    en: "The AI translation service returned an invalid structure.",
    zh: "AI 翻译服务返回的结构无效。",
  },
  {
    key: "translation.remoteError",
    en: "The AI service returned an error: {message}",
    zh: "AI 服务返回错误：{message}",
  },
  {
    key: "translation.noChoices",
    en: "The AI translation service returned no choices. Check the model and endpoint configuration.",
    zh: "AI 翻译服务没有返回 choices，请检查模型与接口配置。",
  },
  {
    key: "translation.invalidChoices",
    en: "The AI translation service returned an invalid choices structure.",
    zh: "AI 翻译服务返回的 choices 结构无效。",
  },
  {
    key: "translation.emptyContent",
    en: "The AI translation service returned empty content. Check the model configuration.",
    zh: "AI 翻译服务返回了空内容，请检查模型配置。",
  },
  {
    key: "translation.invalidJsonContent",
    en: "The AI response was not valid JSON; no translation was written.",
    zh: "AI 返回的内容不是有效 JSON，未写入任何译文。",
  },
  {
    key: "translation.untranslatedSentences",
    en: "The AI translation still contains untranslated source sentences and was rejected. Change models or retry; if a sentence should stay in the source language, edit the block manually and lock it.",
    zh: "AI 译文仍包含未翻译的原文句子，已拒绝写入。请更换模型或重试；若该句本应保留原文，请手动编辑并锁定该块。",
  },
  {
    key: "translation.missingItems",
    en: "The AI response JSON has no items array; expected {\"items\":[...]}.",
    zh: "AI 返回的 JSON 缺少 items 数组，期望 {\"items\":[...]}。",
  },
  {
    key: "translation.invalidItems",
    en: "The AI response items structure is invalid; every item needs string id and text fields.",
    zh: "AI 返回的 items 结构无效，每一项都需要 id 和 text 字符串。",
  },
  {
    key: "translation.echoedSource",
    en: "The AI returned the source text for {count} long blocks without translating (or only echoed the request). No translation was written. Change models or adjust the prompt, then run “Retranslate All”.",
    zh: "AI 对 {count} 个长文本块返回了原文，未执行翻译或只回显了请求内容。未写入任何译文，请更换模型或调整提示，再运行“全部重译”。",
  },
  {
    key: "translation.echoedRequest",
    en: "The AI returned the request content instead of a translation; nothing was written. Check the endpoint and model output, or run “Test AI Translation Connection” first.",
    zh: "AI 返回了请求内容而不是译文，未写入任何译文。请检查接口地址、模型输出，或先运行“测试 AI 翻译连接”。",
  },
  {
    key: "translation.echoedPrompt",
    en: "The AI returned the translation prompt instead of a translation; nothing was written. Check that apiBaseUrl points to a Chat Completions endpoint and that the model follows instructions.",
    zh: "AI 返回了翻译提示词而不是译文，未写入任何译文。请检查 apiBaseUrl 是否指向 Chat Completions 接口，并确认模型支持指令跟随。",
  },
  // ---- OpenAI 兼容 Provider：摘要与连接测试 ----
  {
    key: "translation.summaryTooLong",
    en: "The AI summary is too long (over {max} characters). Change models or fill it in manually.",
    zh: "AI 摘要过长（超过 {max} 字符），请更换模型或手动填写。",
  },
  {
    key: "translation.summaryTimeout",
    en: "The AI summary request timed out ({seconds} seconds). Check the network or increase apiTimeoutMs.",
    zh: "AI 摘要请求超时（{seconds} 秒），请检查网络或增大 apiTimeoutMs。",
  },
  {
    key: "translation.summaryConnectionFailed",
    en: "Could not connect to the AI translation service to generate a summary: {message}",
    zh: "无法连接 AI 翻译服务生成摘要：{message}",
  },
  {
    key: "translation.testEchoedSource",
    en: "The test request returned the source text; the service may not have translated it. Check the endpoint and model configuration.",
    zh: "测试请求返回了原文，服务可能没有执行翻译。请检查接口地址和模型配置。",
  },
  {
    key: "translation.requestTimeout",
    en: "The AI translation request timed out ({seconds} seconds). Check the network or increase apiTimeoutMs in Settings.",
    zh: "AI 翻译请求超时（{seconds} 秒），请检查网络或在设置中增大 apiTimeoutMs。",
  },
  {
    key: "translation.connectionFailed",
    en: "Could not connect to the AI translation service: {message}",
    zh: "无法连接 AI 翻译服务：{message}",
  },
  // ---- 通用 HTTP Provider ----
  {
    key: "translation.unknownPlaceholder",
    en: "{setting} contains an unknown template variable {{{variable}}}. Allowed variables: {allowed}.",
    zh: "{setting} 包含未知模板变量 {{{variable}}}。允许的变量：{allowed}。",
  },
  {
    key: "translation.invalidJsonObject",
    en: "{setting} must be a valid JSON object.",
    zh: "{setting} 必须是有效的 JSON 对象。",
  },
  {
    key: "translation.jsonObjectExpected",
    en: "{setting} must be a JSON object.",
    zh: "{setting} 必须是 JSON 对象。",
  },
  {
    key: "translation.invalidJsonBody",
    en: "httpBody must be valid JSON.",
    zh: "httpBody 必须是有效的 JSON。",
  },
  {
    key: "translation.missingHttpEndpoint",
    en: "Set markdownBilingualSync.httpEndpoint.",
    zh: "请设置 markdownBilingualSync.httpEndpoint。",
  },
  {
    key: "translation.httpEndpointTooLong",
    en: "httpEndpoint is too long. Check the setting.",
    zh: "httpEndpoint 过长，请检查设置。",
  },
  {
    key: "translation.invalidHttpMethod",
    en: "httpMethod supports only POST, PUT, or PATCH.",
    zh: "httpMethod 仅支持 POST、PUT 或 PATCH。",
  },
  {
    key: "translation.missingHttpHeaders",
    en: "Set markdownBilingualSync.httpHeaders ({} is allowed).",
    zh: "请设置 markdownBilingualSync.httpHeaders（可为 {}）。",
  },
  {
    key: "translation.missingHttpBody",
    en: "Set markdownBilingualSync.httpBody.",
    zh: "请设置 markdownBilingualSync.httpBody。",
  },
  {
    key: "translation.genericApiKeyTooLong",
    en: "The API key is too long and was rejected.",
    zh: "API Key 过长，已拒绝使用。",
  },
  {
    key: "translation.apiKeyRequired",
    en: "The HTTP template uses {{apiKey}}, but no API key is set. Run “Set AI Translation API Key”.",
    zh: "HTTP 模板使用了 {{apiKey}}，但尚未设置 API Key。请运行“设置 AI 翻译 API Key”。",
  },
  {
    key: "translation.renderedEndpointTooLong",
    en: "The HTTP endpoint URL is too long. Check httpEndpoint.",
    zh: "HTTP 接口地址过长，请检查 httpEndpoint。",
  },
  {
    key: "translation.httpEndpointInvalid",
    en: "httpEndpoint is not a valid URL.",
    zh: "httpEndpoint 不是有效的 URL。",
  },
  {
    key: "translation.httpHttpsRequired",
    en: "The HTTP translation endpoint must use HTTPS; only localhost, 127.0.0.1, or [::1] may use HTTP.",
    zh: "HTTP 翻译接口必须使用 HTTPS；仅 localhost、127.0.0.1 或 [::1] 允许使用 HTTP。",
  },
  {
    key: "translation.httpCredentials",
    en: "httpEndpoint must not contain a username or password. Pass the key through the {{apiKey}} template variable.",
    zh: "httpEndpoint 不能包含用户名或密码，请通过 {{apiKey}} 模板变量传递密钥。",
  },
  {
    key: "translation.httpFragment",
    en: "httpEndpoint must not contain a fragment (#).",
    zh: "httpEndpoint 不能包含片段（#）。",
  },
  {
    key: "translation.invalidHeaderName",
    en: "httpHeaders contains an invalid header name: {name}",
    zh: "httpHeaders 包含无效的请求头名称：{name}",
  },
  {
    key: "translation.forbiddenHeader",
    en: "httpHeaders must not set {name}.",
    zh: "httpHeaders 不允许设置 {name}。",
  },
  {
    key: "translation.headerNotString",
    en: "The httpHeaders value for {name} must be a string.",
    zh: "httpHeaders 的 {name} 必须是字符串。",
  },
  {
    key: "translation.headerNewline",
    en: "The httpHeaders value for {name} contains a newline and was rejected.",
    zh: "httpHeaders 的 {name} 包含换行符，已拒绝发送。",
  },
  {
    key: "translation.httpEchoedSource",
    en: "The HTTP translation service returned the source text without translating. Check the request template, response path, and target language parameters.",
    zh: "HTTP 翻译服务返回了原文，未执行翻译。请检查请求模板、响应路径与目标语言参数。",
  },
  {
    key: "translation.responseTooLarge",
    en: "The HTTP translation response is too large and was rejected.",
    zh: "HTTP 翻译响应过大，已拒绝处理。",
  },
  {
    key: "translation.emptyResponse",
    en: "The HTTP translation service returned an empty response.",
    zh: "HTTP 翻译服务返回了空响应。",
  },
  {
    key: "translation.nonJsonHttpResponse",
    en: "The HTTP translation service returned a non-JSON response. Set httpResponseType to text, or point httpResponsePath at a text field.",
    zh: "HTTP 翻译服务返回了非 JSON 响应。可将 httpResponseType 设为 text，或用 httpResponsePath 指向文本字段。",
  },
  {
    key: "translation.httpRemoteErrorWithDetail",
    en: "The HTTP translation service returned an error: {message}",
    zh: "HTTP 翻译服务返回错误：{message}",
  },
  {
    key: "translation.httpRemoteError",
    en: "The HTTP translation service returned an error.",
    zh: "HTTP 翻译服务返回错误。",
  },
  {
    key: "translation.responsePathMissing",
    en: "No text field was found in the HTTP translation response for httpResponsePath={path}.",
    zh: "HTTP 翻译响应中找不到文本字段 httpResponsePath={path}。",
  },
  {
    key: "translation.responseNotText",
    en: "The HTTP translation response is not text. Set httpResponsePath.",
    zh: "HTTP 翻译响应不是文本。请设置 httpResponsePath。",
  },
  {
    key: "translation.emptyTranslation",
    en: "The HTTP translation service returned an empty translation.",
    zh: "HTTP 翻译服务返回了空译文。",
  },
  {
    key: "translation.translationTooLong",
    en: "The HTTP translation result is too long and was rejected.",
    zh: "HTTP 翻译结果过长，已拒绝写入。",
  },
  {
    key: "translation.httpTimeout",
    en: "The HTTP translation request timed out ({seconds} seconds). Check the network or increase apiTimeoutMs in Settings.",
    zh: "HTTP 翻译请求超时（{seconds} 秒），请检查网络或在设置中增大 apiTimeoutMs。",
  },
  {
    key: "translation.httpConnectionFailed",
    en: "Could not connect to the HTTP translation service: {message}",
    zh: "无法连接 HTTP 翻译服务：{message}",
  },
  {
    key: "translation.httpErrorBase",
    en: "HTTP translation request failed (HTTP {status})",
    zh: "HTTP 翻译请求失败（HTTP {status}）",
  },
  {
    key: "translation.openAiErrorBase",
    en: "AI translation request failed (HTTP {status})",
    zh: "AI 翻译请求失败（HTTP {status}）",
  },
  {
    key: "translation.httpErrorWithHint",
    en: "{base}: {hint}",
    zh: "{base}：{hint}",
  },
  {
    key: "translation.httpErrorWithDetail",
    en: "{base} {detail}",
    zh: "{base} {detail}",
  },
  {
    key: "translation.httpHintAuth",
    en: "Check the API key and access permissions.",
    zh: "请检查 API Key 与访问权限。",
  },
  {
    key: "translation.httpHintOpenAiNotFound",
    en: "Check apiBaseUrl and apiModel.",
    zh: "请检查 apiBaseUrl 和 apiModel。",
  },
  {
    key: "translation.httpHintGenericNotFound",
    en: "Check httpEndpoint and the request method.",
    zh: "请检查 httpEndpoint 与请求方法。",
  },
  {
    key: "translation.httpHintGenericAuth",
    en: "Check the API key, header template, and access permissions.",
    zh: "请检查 API Key、请求头模板与访问权限。",
  },
  {
    key: "translation.httpHintRateLimit",
    en: "Too many requests or insufficient quota; retry later.",
    zh: "请求过于频繁或额度不足，请稍后重试。",
  },
  // ---- 路由器与批处理 ----
  {
    key: "translation.routerSummaryUnsupported",
    en: "The current provider does not support automatic full-document summaries. Fill in a summary manually in the preview, or switch to an OpenAI-compatible provider.",
    zh: "当前翻译服务不支持自动生成全文摘要。请在预览中手动填写摘要，或切换到 OpenAI 兼容服务。",
  },
  {
    key: "translation.routerTestUnsupported",
    en: "The current provider does not support connection tests. Switch to an OpenAI-compatible or custom HTTP provider.",
    zh: "当前翻译服务不支持连接测试，请切换到 OpenAI 兼容或自定义 HTTP 服务。",
  },
  {
    key: "translation.routerReviewUnsupported",
    en: "The current provider does not support semantic review. Switch to an OpenAI-compatible provider.",
    zh: "当前翻译服务不支持语义审校，请切换到 OpenAI 兼容服务。",
  },
  {
    key: "translation.reviewInvalidJson",
    en: "The review response was not a valid annotation list. Retry the review.",
    zh: "审校返回的不是有效批注列表，请重试审校。",
  },
  {
    key: "translation.reviewEmpty",
    en: "The review returned no content.",
    zh: "审校没有返回内容。",
  },
  {
    key: "translation.reviewTooLong",
    en: "The review response is too long.",
    zh: "审校返回内容过长。",
  },
  {
    key: "translation.batchSummaryUnsupported",
    en: "The current provider does not support automatic full-document summaries. Enter one manually.",
    zh: "当前翻译服务不支持自动生成全文摘要，请手动填写。",
  },
  {
    key: "translation.missingAllBlocks",
    en: "The translation service did not return all blocks.",
    zh: "翻译服务没有返回全部块。",
  },
  // ---- 结果契约 ----
  {
    key: "translation.unexpectedBlock",
    en: "The translation service returned a block that was not requested: {id}",
    zh: "翻译服务返回了未请求的块：{id}",
  },
  {
    key: "translation.duplicateBlock",
    en: "The translation service returned a duplicate block: {id}",
    zh: "翻译服务重复返回了块：{id}",
  },
  {
    key: "translation.emptyBlock",
    en: "The translation service returned an empty translation: {id}",
    zh: "翻译服务返回了空译文：{id}",
  },
  {
    key: "translation.resultTooLong",
    en: "The translation result is too long and was rejected: {id}",
    zh: "翻译结果过长，已拒绝写入：{id}",
  },
  {
    key: "translation.missingBlocks",
    en: "The translation service is missing results for {count} blocks: {ids}",
    zh: "翻译服务缺少 {count} 个块的结果：{ids}",
  },
] as const satisfies readonly ErrorMessage[];
