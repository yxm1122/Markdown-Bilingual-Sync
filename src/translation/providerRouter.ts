/**
 * 翻译服务路由器（translation/providerRouter）
 *
 * 职责：按当前的 provider 设置（mock / openai / http）把调用转发给对应实现，
 * 自身不缓存实例、不发起请求，设置变更在下一次调用时生效。
 *
 * 关键不变量：
 * - id/label 必须与当前目标 Provider 一致，避免状态栏与任务面板显示错位；
 * - 未知 provider 值一律回退到 mock（与扩展入口的配置读取保持一致）。
 *
 * 外部依赖：三个 Provider 实现与共享类型；不直接读写配置或密钥。
 *
 * 安全边界：路由器不做 URL/密钥校验，校验责任在具体 Provider；转发时原样传递取消信号。
 */
import type { GenericHttpTranslationProvider } from "./genericHttpProvider";
import type { MockTranslationProvider } from "./mockProvider";
import type { OpenAITranslationProvider } from "./openaiProvider";
import type {
  ConnectionTestResult,
  ReviewAnnotationDraft,
  ReviewRequest,
  SummaryRequest,
  SummaryResult,
  TranslationChunkHandler,
  TranslationProgress,
  TranslationProvider,
  TranslationRequest,
  TranslationResultItem,
} from "./types";
import { tError } from "../i18n/errors";

/** 可选的翻译服务类型；与 VS Code 配置 provider 的取值一致。 */
export type ProviderKind = "mock" | "openai" | "http";

// ---- 路由器实现 ----

/**
 * 动态路由器：每次调用时读取 kind 再选择实现，因此切换配置无需重建对象。
 * 所有方法都直接委托，不吞错、不改写错误信息。
 */
export class TranslationProviderRouter implements TranslationProvider {
  /**
   * @param getKind 读取当前 provider 类型；未知值会回退到 mock。
   * @param mock 演示 Provider。
   * @param openai OpenAI 兼容 Provider。
   * @param http 自定义 HTTP 模板 Provider。
   */
  constructor(
    private readonly getKind: () => ProviderKind,
    private readonly mock: MockTranslationProvider,
    private readonly openai: OpenAITranslationProvider,
    private readonly http: GenericHttpTranslationProvider,
  ) {}

  /** 当前 Provider 的稳定标识。 */
  get id(): string {
    return this.current().id;
  }

  /** 当前 Provider 的显示名。 */
  get label(): string {
    return this.current().label;
  }

  /** 当前 Provider 是否支持自动摘要（HTTP 模板通常不支持）。 */
  get supportsSummary(): boolean {
    return this.current().supportsSummary === true;
  }

  /** 当前 Provider 是否支持语义审校（HTTP 模板通常不支持）。 */
  get supportsReview(): boolean {
    return this.current().supportsReview === true;
  }

  /** 当前 Provider 是否会把批注发送给模型（HTTP 模板通常不支持）。 */
  get supportsAnnotations(): boolean {
    return this.current().supportsAnnotations === true;
  }

  /** 转发整篇摘要请求；目标 Provider 未实现时给出可操作的本地化提示。 */
  async summarize(
    request: SummaryRequest,
    signal?: AbortSignal,
  ): Promise<SummaryResult> {
    const provider = this.current();
    if (!provider.summarize || provider.supportsSummary !== true) {
      throw new Error(
        tError("translation.routerSummaryUnsupported"),
      );
    }
    return provider.summarize(request, signal);
  }

  /** 转发语义审校请求；目标 Provider 未实现时给出本地化提示。 */
  async review(
    request: ReviewRequest,
    signal?: AbortSignal,
  ): Promise<ReviewAnnotationDraft[]> {
    const provider = this.current();
    if (!provider.review || provider.supportsReview !== true) {
      throw new Error(
        tError("translation.routerReviewUnsupported"),
      );
    }
    return provider.review(request, signal);
  }

  /** 转发翻译请求；进度、增量与取消语义完全由目标 Provider 决定。 */
  translate(
    request: TranslationRequest,
    signal?: AbortSignal,
    onProgress?: TranslationProgress,
    onChunk?: TranslationChunkHandler,
  ): Promise<TranslationResultItem[]> {
    return this.current().translate(request, signal, onProgress, onChunk);
  }

  /**
   * 转发连接测试；目标 Provider 未实现测试能力时抛出本地化提示。
   * @throws 不支持测试、配置错误、网络错误或取消。
   */
  async testConnection(
    sourceLanguage: string,
    targetLanguage: string,
    signal?: AbortSignal,
  ): Promise<ConnectionTestResult> {
    const provider = this.current();
    if (!provider.testConnection) {
      throw new Error(
        tError("translation.routerTestUnsupported"),
      );
    }
    return provider.testConnection(sourceLanguage, targetLanguage, signal);
  }

  /** 解析当前 Provider；未知类型按 mock 处理，保证调用永远有落点。 */
  private current(): TranslationProvider {
    const kind = this.getKind();
    return kind === "openai"
      ? this.openai
      : kind === "http"
        ? this.http
        : this.mock;
  }
}
