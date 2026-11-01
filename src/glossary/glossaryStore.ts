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
 * - 更新操作在按 URI 串行队列内完成读取、合并与写入；
 * - 已打开且未保存的术语表拒绝写入；已打开且干净时用 WorkspaceEdit 更新；
 * - 不写入 SecretStorage，也不缓存文件内容。
 */
import * as path from "node:path";
import * as vscode from "vscode";
import { tError } from "../i18n/errors";
import type { GlossaryEntry } from "../translation/types";
import {
  inspectGlossaryText,
  MAX_USER_GLOSSARY_ENTRIES,
  mergeGlossaryResults,
  parseGlossaryText,
  type GlossaryLoadResult,
  type NamedGlossary,
} from "./glossary";
import {
  applyGlossaryPatch,
  assertGlossaryPatch,
  serializeGlossaryFile,
  type GlossaryPatch,
} from "./glossaryPatch";

const WORKSPACE_GLOSSARY_FILE = ".mbs-glossary.json";

/** 术语表作用域，用于打开文件与管理合并优先级。 */
export type GlossaryScope = "global" | "workspace";

/** 单个作用域的读取快照。 */
export interface GlossaryScopeSnapshot {
  scope: GlossaryScope;
  uri: vscode.Uri;
  entries: GlossaryEntry[];
  warnings: string[];
}

/** 单个作用域的更新结果；before 为写入前的有效条目。 */
export interface GlossaryScopeUpdateResult {
  scope: GlossaryScope;
  uri: vscode.Uri;
  before: GlossaryEntry[];
  entries: GlossaryEntry[];
  added: GlossaryEntry[];
  updated: GlossaryEntry[];
  removed: GlossaryEntry[];
  duplicates: string[];
}

/** 术语表文件级错误；Agent 工具据此返回稳定的错误 code。 */
export type GlossaryStoreErrorCode =
  | "no-workspace"
  | "dirty"
  | "invalid-existing"
  | "file-error"
  | "write-failed"
  | "update-failed"
  | "save-failed";

export class GlossaryStoreError extends Error {
  constructor(
    readonly code: GlossaryStoreErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "GlossaryStoreError";
  }
}

export class GlossaryStore {
  /** 按术语表 URI 串行化写入，避免并发工具调用互相覆盖。 */
  private readonly writeChains = new Map<string, Promise<unknown>>();

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

  /**
   * 读取单个作用域；文件不存在时返回空表。
   * @param sourceUri 用于定位工作区；workspace 作用域必填或在当前工作区中查找。
   * @throws 没有工作区时抛本地化错误（仅 workspace 作用域）。
   */
  async readScope(
    scope: GlossaryScope,
    sourceUri?: vscode.Uri,
  ): Promise<GlossaryScopeSnapshot> {
    const uri = this.scopeUri(scope, sourceUri);
    const result = await this.read(uri);
    return {
      scope,
      uri,
      entries: result?.entries ?? [],
      warnings: result?.warnings ?? [],
    };
  }

  /**
   * 在一个串行队列内合并更新单个作用域。
   *
   * merge 会先检查现有文件：结构无效或超过上限时拒绝，避免重写时丢数据；
   * replace 不解析现有内容，用于显式整体替换。所有校验失败都不写文件。
   */
  async updateScope(
    scope: GlossaryScope,
    sourceUri: vscode.Uri | undefined,
    patch: GlossaryPatch,
  ): Promise<GlossaryScopeUpdateResult> {
    const uri = this.scopeUri(scope, sourceUri);
    return this.withWriteLock(uri, async () => {
      const openDocument = this.findOpenDocument(uri);
      if (openDocument?.isDirty) {
        throw new GlossaryStoreError(
          "dirty",
          tError("glossary.dirty", { file: path.basename(uri.fsPath) }),
        );
      }
      const baseText = openDocument
        ? openDocument.getText()
        : await this.readText(uri);

      let current: GlossaryEntry[] = [];
      let existingDuplicates: string[] = [];
      if (patch.mode === "merge" && baseText?.trim()) {
        const inspection = inspectGlossaryText(baseText);
        if (inspection.invalidItems.length > 0 || inspection.overflow) {
          const items = inspection.invalidItems.slice(0, 20).join(", ");
          throw new GlossaryStoreError(
            "invalid-existing",
            tError("glossary.invalidExisting", {
              items: items || "—",
              max: MAX_USER_GLOSSARY_ENTRIES,
            }),
          );
        }
        current = inspection.entries;
        existingDuplicates = inspection.duplicateSources;
      }

      const patched = applyGlossaryPatch(
        current,
        patch,
        MAX_USER_GLOSSARY_ENTRIES,
      );
      assertGlossaryPatch(patched);
      const nextText =
        patch.mode === "merge"
          ? serializeMergedGlossary(baseText, patched.entries)
          : serializeGlossaryFile(patched.entries);
      await this.writeText(uri, nextText, openDocument, baseText);

      return {
        scope,
        uri,
        before: current,
        entries: patched.entries,
        added: patched.added,
        updated: patched.updated,
        removed: patched.removed,
        duplicates: [
          ...new Set([...existingDuplicates, ...patched.duplicates]),
        ],
      };
    });
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

  /**
   * 读/写作用域对应的文件。
   * workspace 作用域在 sourceUri 位于工作区外时不会借用其他工作区的词表。
   */
  private scopeUri(
    scope: GlossaryScope,
    sourceUri?: vscode.Uri,
  ): vscode.Uri {
    if (scope === "global") {
      return this.glossaryUri;
    }
    const folder = sourceUri
      ? vscode.workspace.getWorkspaceFolder(sourceUri)
      : this.resolveWorkspaceFolder();
    if (!folder) {
      throw new GlossaryStoreError(
        "no-workspace",
        tError("glossary.noWorkspace"),
      );
    }
    return this.workspaceGlossaryUri(folder);
  }

  /** 读取一个术语表文件；文件不存在返回 undefined。 */
  private async read(uri: vscode.Uri): Promise<GlossaryLoadResult | undefined> {
    const text = await this.readText(uri);
    return text === undefined ? undefined : parseGlossaryText(text);
  }

  /** 读取文件文本：已打开文档优先；文件不存在返回 undefined。 */
  private async readText(uri: vscode.Uri): Promise<string | undefined> {
    const openDocument = this.findOpenDocument(uri);
    if (openDocument) {
      return openDocument.getText();
    }
    try {
      return new TextDecoder("utf-8").decode(
        await vscode.workspace.fs.readFile(uri),
      );
    } catch (error) {
      if (
        error instanceof vscode.FileSystemError &&
        error.code === "FileNotFound"
      ) {
        return undefined;
      }
      throw new GlossaryStoreError(
        "file-error",
        tError("glossary.fileError", {
          file: path.basename(uri.fsPath),
          message: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }

  /**
   * 写入术语表文本。
   * 已打开且干净时用 WorkspaceEdit 更新并保存；写入前再次确认内容没有被外部修改。
   */
  private async writeText(
    uri: vscode.Uri,
    text: string,
    openDocument: vscode.TextDocument | undefined,
    baseText: string | undefined,
  ): Promise<void> {
    try {
      await vscode.workspace.fs.createDirectory(
        vscode.Uri.file(path.dirname(uri.fsPath)),
      );
      if (!openDocument) {
        await vscode.workspace.fs.writeFile(
          uri,
          new TextEncoder().encode(text),
        );
        return;
      }
    } catch (error) {
      throw new GlossaryStoreError(
        "write-failed",
        tError("glossary.writeError", {
          file: path.basename(uri.fsPath),
          message: error instanceof Error ? error.message : String(error),
        }),
      );
    }
    if (openDocument.isDirty || openDocument.getText() !== (baseText ?? "")) {
      throw new GlossaryStoreError(
        "dirty",
        tError("glossary.dirty", { file: path.basename(uri.fsPath) }),
      );
    }
    const edit = new vscode.WorkspaceEdit();
    const end = openDocument.positionAt(openDocument.getText().length);
    edit.replace(uri, new vscode.Range(new vscode.Position(0, 0), end), text);
    const applied = await vscode.workspace.applyEdit(edit);
    if (!applied) {
      throw new GlossaryStoreError(
        "update-failed",
        tError("glossary.updateFailed"),
      );
    }
    const saved = await openDocument.save();
    if (!saved) {
      throw new GlossaryStoreError(
        "save-failed",
        tError("glossary.saveFailed"),
      );
    }
  }

  /** 在当前打开的文本文档中查找指定 URI。 */
  private findOpenDocument(
    uri: vscode.Uri,
  ): vscode.TextDocument | undefined {
    return vscode.workspace.textDocuments.find(
      (document) => document.uri.toString() === uri.toString(),
    );
  }

  /**
   * 按 URI 串行化写入；前一次失败不会阻塞后续操作。
   */
  private async withWriteLock<T>(
    uri: vscode.Uri,
    action: () => Promise<T>,
  ): Promise<T> {
    const key = uri.toString();
    const previous = this.writeChains.get(key) ?? Promise.resolve();
    const next = previous.then(action, action);
    this.writeChains.set(key, next);
    try {
      return await next;
    } finally {
      if (this.writeChains.get(key) === next) {
        this.writeChains.delete(key);
      }
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
        new TextEncoder().encode(serializeGlossaryFile([])),
      );
    }
  }
}

/**
 * merge 写入时保留现有 `{ "entries": [...] }` 包装与其他顶层字段；
 * 裸数组文件继续写裸数组，replace 模式始终写裸数组。
 */
function serializeMergedGlossary(
  baseText: string | undefined,
  entries: readonly GlossaryEntry[],
): string {
  if (baseText?.trim()) {
    try {
      const parsed: unknown = JSON.parse(baseText);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const record = parsed as Record<string, unknown>;
        if (Array.isArray(record.entries)) {
          return `${JSON.stringify({ ...record, entries }, null, 2)}\n`;
        }
      }
    } catch {
      // inspectGlossaryText 已在 merge 前校验过 JSON；这里只做防御性回退。
    }
  }
  return serializeGlossaryFile(entries);
}
