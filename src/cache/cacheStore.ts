/**
 * 译文缓存的磁盘存储与路径管理。
 *
 * 职责：把原文文件映射到全局存储目录下的缓存路径，并负责读写、删除、打开缓存文件。
 *
 * 关键不变量：
 * - 缓存路径固定为 `<globalStorage>/cache/<projectKey>/<相对路径>.<语言>.md`，
 *   `projectKey` 由工作区目录 URI 的哈希生成，不写入用户工作区；
 * - 任何计算出的路径都必须仍位于对应项目目录内，防止 `..` 或盘符跳出；
 * - 写缓存时若文件已在编辑器中打开且未保存，一律拒绝写入，避免覆盖用户修改。
 *
 * 与其他模块的关系：`SyncService` 是唯一调用方；`extension` 清理缓存时使用
 * `isCacheUri` 判断文档是否属于缓存，防止误清用户文件。
 */
import * as path from "node:path";
import * as vscode from "vscode";
import { shortHash } from "../util/hash";
import { languageSuffix } from "../util/language";
import { tError } from "../i18n/errors";

/** 基于 `ExtensionContext.globalStorageUri` 的缓存仓库。 */
export class CacheStore {
  /** 仅依赖扩展上下文提供全局存储位置，不访问工作区文件。 */
  constructor(private readonly context: vscode.ExtensionContext) {}

  /** 所有项目缓存的根目录（`globalStorage/cache`）。 */
  get globalCacheRoot(): vscode.Uri {
    return vscode.Uri.joinPath(this.context.globalStorageUri, "cache");
  }

  /**
   * 计算某个原文文件在指定目标语言下的缓存路径。
   *
   * 仅支持 `file:` 源；工作区内文件按“工作区哈希 + 工作区相对路径”存放，工作区外
   * 文件按“目录哈希 + 文件名”存放。目录层级原样保留，只把原扩展名替换为
   * `.<语言>.md`，使多个目标语言互不覆盖。
   *
   * 出错条件：源不是本地文件、目标语言无法生成合法后缀、相对路径为空/越界/为绝对
   * 路径、最终路径跳出项目目录时抛出本地化错误。无文件系统副作用。
   */
  getCacheUri(sourceUri: vscode.Uri, targetLanguage: string): vscode.Uri {
    if (sourceUri.scheme !== "file") {
      throw new Error(tError("cache.localFileOnly"));
    }
    const suffix = languageSuffix(targetLanguage);

    const folder = vscode.workspace.getWorkspaceFolder(sourceUri);
    let projectKey: string;
    let relative: string;
    if (folder) {
      // 工作区路径变化（重命名/移动）会改变 projectKey，旧缓存不再被引用。
      projectKey = shortHash(folder.uri.toString());
      relative = vscode.workspace.asRelativePath(sourceUri, false);
    } else {
      const directory = path.dirname(sourceUri.fsPath);
      projectKey = shortHash(directory);
      relative = path.basename(sourceUri.fsPath);
    }

    const normalized = path.posix.normalize(relative.replace(/\\/g, "/"));
    // 统一按 POSIX 形式校验：拒绝空路径、`..` 段、绝对路径和 Windows 盘符。
    if (
      !normalized ||
      normalized === ".." ||
      normalized.startsWith("../") ||
      path.posix.isAbsolute(normalized) ||
      /^[a-zA-Z]:/.test(normalized)
    ) {
      throw new Error(tError("cache.unsafePath"));
    }

    const extension = path.posix.extname(normalized);
    const base = extension ? normalized.slice(0, -extension.length) : normalized;
    const fileName = `${base}.${suffix}.md`;
    const root = vscode.Uri.joinPath(this.globalCacheRoot, projectKey);
    const cacheUri = vscode.Uri.joinPath(root, ...fileName.split("/"));

    // 统一分隔符并转小写，兼容 Windows/macOS 的大小写不敏感文件系统。
    const rootPath = root.fsPath.replace(/\\/g, "/").toLowerCase();
    const cachePath = cacheUri.fsPath.replace(/\\/g, "/").toLowerCase();
    if (cachePath !== rootPath && !cachePath.startsWith(`${rootPath}/`)) {
      throw new Error(tError("cache.pathEscaped"));
    }
    return cacheUri;
  }

  /** 判断一个 URI 是否位于缓存根目录之下（不要求文件存在），用于保护缓存标签页。 */
  isCacheUri(uri: vscode.Uri): boolean {
    if (uri.scheme !== "file") {
      return false;
    }
    const root = this.globalCacheRoot.fsPath;
    const relative = path.relative(root, uri.fsPath);
    return (
      relative.length > 0 &&
      !relative.startsWith("..") &&
      !path.isAbsolute(relative)
    );
  }

  /**
   * 读取缓存文本（UTF-8）。
   *
   * 文件不存在时返回 `undefined`，其他 IO 错误原样抛出。注意：读取的是磁盘内容，
   * 不是编辑器中未保存的缓冲区。
   */
  async read(cacheUri: vscode.Uri): Promise<string | undefined> {
    try {
      const bytes = await vscode.workspace.fs.readFile(cacheUri);
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

  /** 判断缓存文件是否存在；只吞掉“文件不存在”，权限等其他错误继续抛出。 */
  async exists(cacheUri: vscode.Uri): Promise<boolean> {
    try {
      await vscode.workspace.fs.stat(cacheUri);
      return true;
    } catch (error) {
      if (
        error instanceof vscode.FileSystemError &&
        error.code === "FileNotFound"
      ) {
        return false;
      }
      throw error;
    }
  }

  /**
   * 写入缓存文本。
   *
   * 若缓存已在编辑器中打开：有未保存修改时直接拒绝；否则通过 WorkspaceEdit 整体
   * 替换并保存，使打开的标签页立即看到新内容。未打开时直接写文件。
   *
   * 失败条件：缓存文档脏、整体替换被拒绝、保存失败、IO 错误。写入不是原子操作，
   * 进程崩溃可能留下截断的缓存。
   */
  async write(cacheUri: vscode.Uri, text: string): Promise<void> {
    const openDocument = vscode.workspace.textDocuments.find(
      (document) => document.uri.toString() === cacheUri.toString(),
    );
    if (openDocument?.isDirty) {
      throw new Error(
        tError("cache.dirty"),
      );
    }

    await this.ensureParentDirectory(cacheUri);

    if (openDocument) {
      const edit = new vscode.WorkspaceEdit();
      const end = openDocument.positionAt(openDocument.getText().length);
      edit.replace(
        cacheUri,
        new vscode.Range(new vscode.Position(0, 0), end),
        text,
      );
      const applied = await vscode.workspace.applyEdit(edit);
      if (!applied) {
        throw new Error(tError("cache.updateOpenFailed"));
      }
      const saved = await openDocument.save();
      if (!saved) {
        throw new Error(tError("cache.saveFailed"));
      }
      return;
    }

    await vscode.workspace.fs.writeFile(
      cacheUri,
      new TextEncoder().encode(text),
    );
  }

  /**
   * 删除整个缓存根目录并返回删除前的文件数。
   *
   * 有任意缓存标签页打开时拒绝执行（避免编辑器指向已删除文件）。优先移入回收站，
   * 回收站不可用时退化为永久删除。目录不存在时返回 0。
   */
  async clearAll(): Promise<number> {
    const openDocuments = vscode.workspace.textDocuments.filter((document) =>
      this.isCacheUri(document.uri),
    );
    if (openDocuments.length > 0) {
      throw new Error(
        tError("cache.openDocuments", { count: openDocuments.length }),
      );
    }
    const root = this.globalCacheRoot;
    if (!(await this.exists(root))) {
      return 0;
    }
    // 先统计文件数再删除；统计与删除之间若有并发写入，计数可能偏小。
    const removed = await this.countFiles(root);
    try {
      await vscode.workspace.fs.delete(root, {
        recursive: true,
        useTrash: true,
      });
    } catch {
      await vscode.workspace.fs.delete(root, {
        recursive: true,
        useTrash: false,
      });
    }
    return removed;
  }

  /**
   * 删除单个缓存文件；文件不存在返回 `false`。
   *
   * 缓存正在编辑器中打开时拒绝执行。与 `clearAll` 一样优先使用回收站。
   */
  async delete(cacheUri: vscode.Uri): Promise<boolean> {
    const openDocument = vscode.workspace.textDocuments.find(
      (document) => document.uri.toString() === cacheUri.toString(),
    );
    if (openDocument) {
      throw new Error(tError("cache.openBeforeClear"));
    }
    if (!(await this.exists(cacheUri))) {
      return false;
    }
    try {
      await vscode.workspace.fs.delete(cacheUri, {
        recursive: false,
        useTrash: true,
      });
    } catch {
      await vscode.workspace.fs.delete(cacheUri, {
        recursive: false,
        useTrash: false,
      });
    }
    return true;
  }

  /** 在编辑器中打开缓存文件；不存在时抛出本地化提示。 */
  async openFile(cacheUri: vscode.Uri): Promise<void> {
    if (!(await this.exists(cacheUri))) {
      throw new Error(tError("cache.notGenerated"));
    }
    const document = await vscode.workspace.openTextDocument(cacheUri);
    await vscode.window.showTextDocument(document, { preview: false });
  }

  /** 在系统文件管理器中定位某个原文对应的项目缓存目录，不存在时先创建。 */
  async openFolder(sourceUri: vscode.Uri, targetLanguage: string): Promise<void> {
    const cacheUri = this.getCacheUri(sourceUri, targetLanguage);
    const folder = cacheUri.with({
      path: cacheUri.path.slice(0, cacheUri.path.lastIndexOf("/")),
    });
    await vscode.workspace.fs.createDirectory(folder);
    await vscode.commands.executeCommand("revealFileInOS", folder);
  }

  /** 在系统文件管理器中打开缓存根目录，不存在时先创建。 */
  async openGlobalFolder(): Promise<void> {
    await vscode.workspace.fs.createDirectory(this.globalCacheRoot);
    await vscode.commands.executeCommand("revealFileInOS", this.globalCacheRoot);
  }

  /** 递归统计目录下的文件数（目录本身不计入），仅供清空前的提示使用。 */
  private async countFiles(folder: vscode.Uri): Promise<number> {
    const entries = await vscode.workspace.fs.readDirectory(folder);
    let count = 0;
    for (const [name, type] of entries) {
      if ((type & vscode.FileType.Directory) !== 0) {
        count += await this.countFiles(vscode.Uri.joinPath(folder, name));
      } else {
        count += 1;
      }
    }
    return count;
  }

  /**
   * 确保缓存文件的父目录存在。
   *
   * 直接用 URI 路径截取最后一段，不经过 `fsPath`，避免不同平台分隔符差异。
   */
  private async ensureParentDirectory(cacheUri: vscode.Uri): Promise<void> {
    const parent = cacheUri.with({
      path: cacheUri.path.slice(0, cacheUri.path.lastIndexOf("/")),
    });
    await vscode.workspace.fs.createDirectory(parent);
  }
}
