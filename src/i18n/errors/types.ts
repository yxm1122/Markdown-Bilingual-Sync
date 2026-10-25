/**
 * 运行时错误/警告文案条目的公共协议。
 *
 * key 为稳定标识，供 tError 类型检查与测试定位；en 是 source 模板（也是 l10n
 * bundle 的 key），zh 是 zh-cn 翻译模板。两者占位符集合必须一致。
 */
export interface ErrorMessage {
  /** 稳定、按领域分组的错误标识（如 sync.missingBlock）。 */
  readonly key: string;
  /** 英文模板；作为 bundle.l10n.json 的 key。 */
  readonly en: string;
  /** 中文模板；写入 bundle.l10n.zh-cn.json。 */
  readonly zh: string;
}
