/**
 * 全局术语表存储（glossary/glossaryStore）
 *
 * 职责：在扩展 globalStorageUri 下维护单个 glossary.json，提供打开与读取能力。
 * 术语表是用户级资源，不随工作区或仓库共享。
 *
 * 关键不变量：
 * - 文件不存在时 load 返回空表且不报错；open 会先创建空文件；
 * - 已打开文档优先于磁盘内容，确保用户未保存的编辑立即生效；
 * - 不写入 SecretStorage，也不缓存文件内容。
 */
import * as vscode from "vscode";
import { parseGlossaryText, type GlossaryLoadResult } from "./glossary";

const EMPTY_GLOSSARY = "[]\n";

export class GlossaryStore {
  constructor(private readonly context: vscode.ExtensionContext) {}

  /** 术语表文件的固定位置（globalStorage/glossary.json）。 */
  get glossaryUri(): vscode.Uri {
    return vscode.Uri.joinPath(this.context.globalStorageUri, "glossary.json");
  }

  /** 在编辑器中打开术语表；必要时先创建空 JSON 数组文件。 */
  async open(): Promise<void> {
    const uri = await this.ensureFile();
    const document = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(document, { preview: false });
  }

  /**
   * 读取并解析术语表。
   * 文件缺失视为空表；JSON 结构错误会向上抛出，由命令层提示用户修正。
   */
  async load(): Promise<GlossaryLoadResult> {
    const uri = this.glossaryUri;
    const openDocument = vscode.workspace.textDocuments.find(
      (document) => document.uri.toString() === uri.toString(),
    );
    if (openDocument) {
      return parseGlossaryText(openDocument.getText());
    }

    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      return parseGlossaryText(new TextDecoder("utf-8").decode(bytes));
    } catch (error) {
      if (
        error instanceof vscode.FileSystemError &&
        error.code === "FileNotFound"
      ) {
        return { entries: [], warnings: [] };
      }
      throw error;
    }
  }

  private async ensureFile(): Promise<vscode.Uri> {
    const uri = this.glossaryUri;
    await vscode.workspace.fs.createDirectory(this.context.globalStorageUri);
    try {
      await vscode.workspace.fs.stat(uri);
    } catch (error) {
      if (
        !(error instanceof vscode.FileSystemError) ||
        error.code !== "FileNotFound"
      ) {
        throw error;
      }
      await vscode.workspace.fs.writeFile(
        uri,
        new TextEncoder().encode(EMPTY_GLOSSARY),
      );
    }
    return uri;
  }
}
