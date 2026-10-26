/**
 * 术语表存储（glossary/glossaryStore）
 *
 * 职责：维护两层用户术语表并合并：
 * - 全局：`globalStorageUri/glossary.json`，跨工作区复用；
 * - 工作区：工作区根目录的 `.mbs-glossary.json`，团队/项目共享。
 *
 * 合并顺序为 全局 → 工作区，后出现的同名 source 覆盖前面的条目。
 * 文档级 AI 术语表存在译文缓存的摘要元数据中，不在这里读取。
 *
 * 关键不变量：
 * - 文件不存在时 load 返回空表且不报错；open 会先创建空文件；
 * - 已打开文档优先于磁盘内容，确保用户未保存的编辑立即生效；
 * - 不写入 SecretStorage，也不缓存文件内容。
 */
import * as path from "node:path";
import * as vscode from "vscode";
import { tError } from "../i18n/errors";
import {
  mergeGlossaryResults,
  parseGlossaryText,
  type GlossaryLoadResult,
  type NamedGlossary,
} from "./glossary";

const EMPTY_GLOSSARY = "[]\n";
const WORKSPACE_GLOSSARY_FILE = ".mbs-glossary.json";

/** 术语表作用域，用于打开文件与管理合并优先级。 */
export type GlossaryScope = "global" | "workspace";

export class GlossaryStore {
  /** 保存扩展上下文；全局术语表路径由 globalStorageUri 派生。 */
  constructor(private readonly context: vscode.ExtensionContext) {}

  /** 全局术语表文件的固定位置（globalStorage/glossary.json）。 */
  get glossaryUri(): vscode.Uri {
    return vscode.Uri.joinPath(this.context.globalStorageUri, "glossary.json");
  }

  /** 工作区术语表文件位置（工作区根目录/.mbs-glossary.json）。 */
  workspaceGlossaryUri(folder: vscode.WorkspaceFolder): vscode.Uri {
    return vscode.Uri.joinPath(folder.uri, WORKSPACE_GLOSSARY_FILE);
  }

  /** 在编辑器中打开全局术语表；必要时先创建空 JSON 数组文件。 */
  async open(): Promise<void> {
    const uri = this.glossaryUri;
    await this.ensureFile(uri);
    await this.openUri(uri);
  }

  /**
   * 打开工作区术语表。
   * @param sourceUri 用于定位工作区的源文件；缺省时取活动编辑器或第一个工作区。
   * @returns 找不到工作区时返回 false，由命令层提示用户。
   */
  async openWorkspaceGlossary(sourceUri?: vscode.Uri): Promise<boolean> {
    const folder = this.resolveWorkspaceFolder(sourceUri);
    if (!folder) {
      return false;
    }
    const uri = this.workspaceGlossaryUri(folder);
    await this.ensureFile(uri);
    await this.openUri(uri);
    return true;
  }

  /**
   * 读取并解析用户术语表（全局 + 工作区）。
   * 文件缺失视为空表；JSON 结构错误会带上文件名向上抛出，由命令层提示用户修正。
   * 工作区后加载，覆盖全局的同名 source。
   */
  async load(): Promise<GlossaryLoadResult> {
    return this.loadFor();
  }

  /** 读取指定文件适用的合并术语表；不传 sourceUri 时只加载全局表。 */
  async loadFor(sourceUri?: vscode.Uri): Promise<GlossaryLoadResult> {
    const uris: vscode.Uri[] = [this.glossaryUri];
    // 只使用源文件所在工作区的术语表；文件在 workspace 外时不能借用其他工作区的词表。
    const folder = sourceUri
      ? vscode.workspace.getWorkspaceFolder(sourceUri)
      : undefined;
    if (folder) {
      uris.push(this.workspaceGlossaryUri(folder));
    }

    const sources: NamedGlossary[] = [];
    for (const uri of uris) {
      const result = await this.read(uri);
      if (result) {
        sources.push({ label: path.basename(uri.fsPath), result });
      }
    }
    return mergeGlossaryResults(sources);
  }

  /** 为“打开工作区术语表”定位工作区：源文件 → 活动编辑器 → 第一个工作区。 */
  private resolveWorkspaceFolder(
    sourceUri?: vscode.Uri,
  ): vscode.WorkspaceFolder | undefined {
    if (sourceUri) {
      const folder = vscode.workspace.getWorkspaceFolder(sourceUri);
      if (folder) {
        return folder;
      }
    }
    const active = vscode.window.activeTextEditor?.document.uri;
    if (active) {
      const folder = vscode.workspace.getWorkspaceFolder(active);
      if (folder) {
        return folder;
      }
    }
    return vscode.workspace.workspaceFolders?.[0];
  }

  /** 读取一个术语表文件；文件不存在返回 undefined。 */
  private async read(uri: vscode.Uri): Promise<GlossaryLoadResult | undefined> {
    const openDocument = vscode.workspace.textDocuments.find(
      (document) => document.uri.toString() === uri.toString(),
    );
    try {
      const text = openDocument
        ? openDocument.getText()
        : new TextDecoder("utf-8").decode(
            await vscode.workspace.fs.readFile(uri),
          );
      return parseGlossaryText(text);
    } catch (error) {
      if (
        !openDocument &&
        error instanceof vscode.FileSystemError &&
        error.code === "FileNotFound"
      ) {
        return undefined;
      }
      throw new Error(
        tError("glossary.fileError", {
          file: path.basename(uri.fsPath),
          message: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }

  /** 打开指定术语表文件。 */
  private async openUri(uri: vscode.Uri): Promise<void> {
    const document = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(document, { preview: false });
  }

  /** 确保术语表文件存在；不存在时创建空数组文件。 */
  private async ensureFile(uri: vscode.Uri): Promise<void> {
    await vscode.workspace.fs.createDirectory(
      vscode.Uri.file(path.dirname(uri.fsPath)),
    );
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
  }
}
