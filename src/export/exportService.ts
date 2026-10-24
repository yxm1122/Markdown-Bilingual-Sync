/**
 * 导出服务（export/exportService）
 *
 * 职责：把 SyncService 的原文/缓存状态交给 buildExportMarkdown 生成译文文档，
 * 计算目标路径、读取旧文件，并在用户确认后写入；供预览与批量导出命令复用。
 *
 * 关键不变量：
 * - prepare 只读：不写文件、不改缓存，可安全地反复调用；
 * - commit 必须先比对“确认时的旧内容”与“当前磁盘内容”，不一致则拒绝写入；
 * - 目标路径永远由源文件所在目录 + 生成的文件名决定，不拼接用户输入路径；
 * - 目标文件在编辑器中有未保存修改时拒绝写入，避免覆盖用户输入。
 *
 * 外部依赖：VS Code 文件系统/工作区/输出通道、SyncService、exportMarkdown。
 *
 * 安全边界：只写同目录下的导出文件；不发起网络请求；日志只记录长度与路径，不记录正文。
 * 批量导出时每个文件独立 commit，单个失败不会回滚其他已写文件（由调用方汇总提示）。
 */
import * as vscode from "vscode";
import { createMarkdownRuntime } from "../markdown/markdown";
import type { SyncService } from "../sync/syncService";
import {
  buildExportFileName,
  buildExportMarkdown,
  type ExportStats,
} from "./exportMarkdown";

/** 已准备好的导出：existingText 为确认时的磁盘内容（undefined 表示新建）。 */
export interface PreparedExport {
  target: vscode.Uri;
  text: string;
  existingText: string | undefined;
  /** 相对路径，仅用于展示。 */
  destination: string;
  /** 统计摘要，如“已翻译 12，缺少译文 2”。 */
  summary: string;
  warningCount: number;
}

/** prepare 结果：内容无变化时不需要写文件。 */
export type ExportPreparation =
  | { status: "ready"; prepared: PreparedExport }
  | { status: "unchanged"; destination: string };

// ---- 统计格式化 ----

/** 把非零统计项拼成中文摘要；全为 0 时返回“共 0 块”。纯函数。 */
function formatStats(stats: ExportStats): string {
  const parts = [
    ["已翻译", stats.translated],
    ["过期", stats.stale],
    ["译文锁定", stats.human + stats.humanStale],
    ["复制", stats.copied],
    ["已删除", stats.deleted],
    ["缺少译文", stats.missing],
  ]
    .filter(([, value]) => Number(value) > 0)
    .map(([label, value]) => `${label} ${value}`);
  return parts.length > 0 ? parts.join("，") : "共 0 块";
}

// ---- 服务实现 ----

/**
 * 导出流程服务。md 解析器为无状态复用；所有状态都来自 SyncService 与文件系统。
 */
export class ExportService {
  private readonly md = createMarkdownRuntime();

  /** @param syncService 提供已保存的原文与缓存；@param output 记录警告与写入审计。 */
  constructor(
    private readonly syncService: SyncService,
    private readonly output: vscode.OutputChannel,
  ) {}

  /**
   * 生成导出内容与确认信息（只读）。
   *
   * 失败语义：无缓存、导出内容为空、目标与原文相同时抛错；目标文件有未保存修改时抛错。
   * 已存在且内容完全一致时返回 unchanged，不产生确认页。
   * @throws 上述业务错误或文件系统读取错误（非 FileNotFound）。
   */
  async prepare(sourceUri: vscode.Uri): Promise<ExportPreparation> {
    const state = await this.syncService.loadState(
      sourceUri,
      true,
      "导出",
    );
    if (!state.cacheText?.trim()) {
      throw new Error(
        "尚未生成译文缓存，请先运行“翻译当前文件”或“同步译文”。",
      );
    }

    const result = buildExportMarkdown({
      md: this.md,
      sourceText: state.sourceText,
      cacheText: state.cacheText,
    });
    if (!result.text.trim()) {
      throw new Error("导出内容为空，未写入文件。");
    }

    const target = this.getExportUri(
      sourceUri,
      state.targetLanguage,
    );
    if (target.toString() === sourceUri.toString()) {
      throw new Error("导出路径与当前原文相同，已停止导出。");
    }

    this.logWarnings(result.warnings);
    const destination = vscode.workspace.asRelativePath(target, false);
    const existingText = await this.readIfExists(target);
    if (existingText === result.text) {
      return { status: "unchanged", destination };
    }

    const openDocument = vscode.workspace.textDocuments.find(
      (document) => document.uri.toString() === target.toString(),
    );
    if (openDocument?.isDirty) {
      throw new Error(
        "导出目标正在编辑且有未保存修改。请先保存或关闭该文件，再执行导出。",
      );
    }

    return {
      status: "ready",
      prepared: {
        target,
        text: result.text,
        existingText,
        destination,
        summary: formatStats(result.stats),
        warningCount: result.warnings.length,
      },
    };
  }

  /**
   * 确认后写入：先再次读取磁盘内容，必须与 prepare 时保存的 existingText 完全一致，
   * 否则判定确认期间被外部修改并拒绝写入。
   *
   * 单个文件失败会抛错，批量导出由调用方决定是否继续处理其余文件并汇总部分失败；
   * 本方法不会回滚已经写入的其他文件。
   * @throws 确认期间内容变化、目标被未保存编辑、写入/保存失败。
   */
  async commit(prepared: PreparedExport): Promise<void> {
    const current = await this.readIfExists(prepared.target);
    if (current !== prepared.existingText) {
      throw new Error(
        "导出目标在确认期间已被修改。请取消本次导出并重新生成差异预览。",
      );
    }

    await this.write(prepared.target, prepared.text);
    this.output.appendLine(
      `[${new Date().toISOString()}] exported ${prepared.text.length} chars to ${prepared.target.fsPath}`,
    );
  }

  /**
   * 计算导出目标：与源文件同目录，文件名由 buildExportFileName 生成。
   * 只使用源目录与 basename，不接受额外路径片段。纯函数（无 I/O）。
   */
  // ---- 目标路径与文件读写 ----

  private getExportUri(
    sourceUri: vscode.Uri,
    targetLanguage: string,
  ): vscode.Uri {
    const fileName = buildExportFileName(
      sourceUri.fsPath,
      targetLanguage,
    );
    const directory = vscode.Uri.joinPath(sourceUri, "..");
    return vscode.Uri.joinPath(directory, fileName);
  }

  /**
   * 读取 UTF-8 文本；文件不存在返回 undefined（用于比较“新建”与“已存在”）。
   * 其他文件系统错误（权限、目录等）原样抛出。
   */
  private async readIfExists(uri: vscode.Uri): Promise<string | undefined> {
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      return new TextDecoder("utf-8").decode(bytes);
    } catch (error) {
      if (
        error instanceof vscode.FileSystemError &&
        error.code === "FileNotFound"
      ) {
        return undefined;
      }
      throw error;
    }
  }

  /**
   * 写入导出文件：
   * - 文件已在编辑器中打开：先确认无未保存修改，再用 WorkspaceEdit 全量替换并保存，
   *   以保留编辑器的撤销栈与文档状态；
   * - 未打开：创建父目录后用文件系统写入 UTF-8。
   * @throws 目标有未保存修改、应用编辑失败或保存失败。
   */
  private async write(uri: vscode.Uri, text: string): Promise<void> {
    const openDocument = vscode.workspace.textDocuments.find(
      (document) => document.uri.toString() === uri.toString(),
    );
    if (openDocument) {
      if (openDocument.isDirty) {
        throw new Error(
          "导出目标正在编辑且有未保存修改，已停止写入。",
        );
      }
      const edit = new vscode.WorkspaceEdit();
      const end = openDocument.positionAt(openDocument.getText().length);
      edit.replace(
        uri,
        new vscode.Range(new vscode.Position(0, 0), end),
        text,
      );
      const applied = await vscode.workspace.applyEdit(edit);
      if (!applied) {
        throw new Error("无法更新已打开的导出文件。");
      }
      const saved = await openDocument.save();
      if (!saved) {
        throw new Error("导出文件保存失败。");
      }
      return;
    }

    const directory = vscode.Uri.joinPath(uri, "..");
    await vscode.workspace.fs.createDirectory(directory);
    await vscode.workspace.fs.writeFile(
      uri,
      new TextEncoder().encode(text),
    );
  }

  /** 逐条写入导出警告到输出通道（带时间戳）；不弹窗、不改状态。 */
  private logWarnings(warnings: readonly string[]): void {
    for (const warning of warnings) {
      this.output.appendLine(
        `[${new Date().toISOString()}] export warning: ${warning}`,
      );
    }
  }
}
