/**
 * Provider 预设列表（translation/presets）
 *
 * 职责：为“应用 Provider 预设”命令提供纯数据：服务显示名、说明、provider 类型，
 * 以及需要写入的 VS Code 配置键值。
 *
 * 关键不变量：
 * - id 唯一且稳定（测试与命令列表依赖它）；
 * - settings 的键必须是 markdownBilingualSync 配置节下的合法键；只写公开地址与模型名；
 * - 本模块不包含任何密钥，密钥始终由 SecretStorage 单独保存。
 *
 * 外部依赖：仅 providerRouter 的 ProviderKind 类型；无 I/O、无副作用。
 *
 * 安全边界：所有远程地址均为 HTTPS；localhost/127.0.0.1 仅用于本机服务。
 * 应用预设的实际写入由 extension.ts 完成，本模块不校验用户最终配置。
 */
import type { ProviderKind } from "./providerRouter";

/** 单个 Provider 预设；settings 缺省表示只切换 provider、保留用户已有模板。 */
export interface ProviderPreset {
  /** 稳定标识，用于查找与测试。 */
  id: string;
  /** QuickPick 主标题。 */
  label: string;
  /** QuickPick 副标题，说明服务与默认模型。 */
  description: string;
  /** 要切换到的 Provider 类型。 */
  provider: ProviderKind;
  /** 需要写入全局配置的键值对；不含密钥。 */
  settings?: Readonly<Record<string, string>>;
}

/**
 * 内置预设。顺序即 QuickPick 展示顺序；OpenAI 兼容服务共享 openai Provider，
 * “自定义 HTTP 模板”与“Mock 演示”不覆盖用户已配置的模板/设置。
 */
export const PROVIDER_PRESETS: readonly ProviderPreset[] = [
  {
    id: "openai",
    label: "OpenAI",
    description: "官方 API · gpt-4o-mini",
    provider: "openai",
    settings: {
      apiBaseUrl: "https://api.openai.com/v1",
      apiModel: "gpt-4o-mini",
    },
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    description: "api.deepseek.com · deepseek-chat",
    provider: "openai",
    settings: {
      apiBaseUrl: "https://api.deepseek.com/v1",
      apiModel: "deepseek-chat",
    },
  },
  {
    id: "siliconflow",
    label: "SiliconFlow",
    description: "api.siliconflow.cn · DeepSeek-V3.2",
    provider: "openai",
    settings: {
      apiBaseUrl: "https://api.siliconflow.cn/v1",
      apiModel: "deepseek-ai/DeepSeek-V3.2",
    },
  },
  {
    id: "ollama",
    label: "Ollama（本机）",
    description: "127.0.0.1:11434 · qwen2.5:7b",
    provider: "openai",
    settings: {
      apiBaseUrl: "http://127.0.0.1:11434/v1",
      apiModel: "qwen2.5:7b",
    },
  },
  {
    id: "lmstudio",
    label: "LM Studio（本机）",
    description: "127.0.0.1:1234 · local-model",
    provider: "openai",
    settings: {
      apiBaseUrl: "http://127.0.0.1:1234/v1",
      apiModel: "local-model",
    },
  },
  {
    id: "http",
    label: "自定义 HTTP 模板",
    description: "保留现有请求模板，仅切换 provider",
    provider: "http",
  },
  {
    id: "mock",
    label: "Mock 演示",
    description: "不发起网络请求，仅用于本地演示",
    provider: "mock",
  },
];
