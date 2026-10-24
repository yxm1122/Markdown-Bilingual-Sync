/**
 * 语言标签到文件后缀的转换（Node / 扩展主进程，供缓存、导出与批量扫描复用）。
 *
 * 缓存文件与导出文件都按 `<文件名>.<主语言标签><扩展名>` 命名（缓存固定 .md，导出沿用
 * 原文扩展名），因此这里既决定产物路径，也是“如何识别目标语言导出文件”的唯一规则。
 * 本模块为纯函数，不依赖 vscode/DOM，也不参与消息通信。
 */

/**
 * 取 BCP-47 标签的主语言子标签并转小写，作为文件后缀。
 *
 * 例如 zh-CN → zh、ja-JP → ja、en → en。只允许 1–8 位字母数字，避免把用户设置原样
 * 拼进文件名而引入 `/`、`..` 等路径字符。设置值不合法时抛出中文错误，交由命令层提示。
 * 注意：zh-CN 与 zh-TW 会得到同一个后缀，切换地区变体会复用/覆盖同一个缓存与导出文件。
 *
 * @param targetLanguage 译文语言标签（如 zh-CN；通常已通过 BCP-47 校验）。
 * @returns 小写的主语言标签（不含地区/文字子标签）。
 * @throws 无法得到合法的 [a-z0-9]{1,8} 后缀时抛出。
 */
export function languageSuffix(targetLanguage: string): string {
  const suffix = targetLanguage.split("-")[0]?.toLowerCase() ?? "";
  if (!/^[a-z0-9]{1,8}$/.test(suffix)) {
    throw new Error(
      `无法从译文语言“${targetLanguage}”生成文件后缀，请检查 targetLanguage 设置。`,
    );
  }
  return suffix;
}
