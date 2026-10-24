/**
 * 批量处理的文件筛选工具（batch/batchFiles）
 *
 * 职责：从 VS Code 找到的 Markdown 列表中剔除目标语言导出文件，并保证稳定的排序，
 * 供目录批量翻译与批量导出共享。
 *
 * 关键不变量：
 * - 只按路径后缀识别导出文件，不读取文件内容；
 * - 排序使用 localeCompare，避免不同平台的目录枚举顺序影响批次/日志。
 *
 * 外部依赖：node:path 与 languageSuffix；不做 I/O。
 */
import * as path from "node:path";
import { languageSuffix } from "../util/language";

/**
 * 判断文件是否为当前目标语言的导出文件（如 `docs/guide.zh-CN.md`）。
 * 仅做小写后缀匹配，不验证文件是否存在。
 */
export function isTargetExportFile(
  filePath: string,
  targetLanguage: string,
): boolean {
  const suffix = languageSuffix(targetLanguage).toLowerCase();
  return filePath.toLowerCase().endsWith(`.${suffix}.md`);
}

/**
 * 判断 filePath 是否严格位于 folderPath 内（不含文件夹自身）。
 * 使用 path.relative 处理 Windows 盘符、大小写与 `..` 路径，避免越界写入。
 */
export function isFileInsideFolder(
  folderPath: string,
  filePath: string,
): boolean {
  const relative = path.relative(folderPath, filePath);
  return (
    relative.length > 0 &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

/**
 * 过滤掉目标语言导出文件并按绝对路径排序。
 * 泛型保留调用方传入的文件对象类型（通常是 vscode.Uri）。
 */
export function filterBatchMarkdownFiles<T extends { fsPath: string }>(
  files: readonly T[],
  targetLanguage: string,
): T[] {
  return files
    .filter((file) => !isTargetExportFile(file.fsPath, targetLanguage))
    .sort((a, b) => a.fsPath.localeCompare(b.fsPath));
}
