/**
 * 文案插值工具（纯函数，扩展宿主与测试共用）。
 *
 * 模板使用 `{name}` 占位符（只匹配 \w+）。Webview 侧的 `formatText` 与
 * Webview 静态脚本中的同名实现必须与本文件保持一致。
 */

/**
 * 按 `{name}` 占位符替换模板中的值。
 *
 * 使用函数式 replace，避免值中的 `$&`、`$1` 等被当作替换模式解释。
 * 未在 values 中提供的占位符保持原样，便于发现漏传参数。
 *
 * @param template 含 `{name}` 占位符的文案。
 * @param values 占位符到字符串/数字的映射。
 * @returns 替换后的文案。
 */
export function formatText(
  template: string,
  values: Record<string, string | number>,
): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) =>
    Object.hasOwn(values, key) ? String(values[key]) : match,
  );
}

/**
 * 按 locale 格式化 ISO 时间（预览摘要的“生成于”）。
 * @param value ISO 时间；无法解析时原样返回。
 * @param locale BCP-47 locale（来自 getLocale）。
 */
export function formatDateTime(value: string, locale: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

