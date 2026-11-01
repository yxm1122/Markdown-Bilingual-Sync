/**
 * Agent 工具的业务编排层。
 *
 * 职责：把 Language Model Tool 的输入转换为现有服务调用，并集中处理：
 * - 源文件解析（绝对/工作区相对路径、活动编辑器回退、缓存/术语表路径保护）；
 * - 运行时校验（brief 字段、术语条目、分页、作用域）；
 * - 默认覆盖生成锁，但把被覆盖项返回给模型；
 * - 写入后刷新已打开的预览；
 * - 结构化错误（code/message/hint）与不含正文的审计日志。
 *
 * 不直接操作缓存格式或术语表 JSON；这些写入统一走 SyncService/GlossaryStore。
 */
import * as path from "node:path";
import * as vscode from "vscode";
import type { CacheStore } from "../cache/cacheStore";
import { MAX_SUMMARY_CHARS, summarySourceHash } from "../cache/summaryMarker";
import {
  MAX_DOCUMENT_GLOSSARY_ENTRIES,
  GlossaryParseError,
  MAX_TERM_LENGTH,
  MAX_USER_GLOSSARY_ENTRIES,
} from "../glossary/glossary";
import {
  applyGlossaryPatch,
  diffGlossaryEntries,
  GlossaryPatchError,
  type GlossaryPatchMode,
} from "../glossary/glossaryPatch";
import {
  GlossaryStoreError,
  type GlossaryScopeSnapshot,
  type GlossaryStore,
} from "../glossary/glossaryStore";
import { formatText, UI_TEXT } from "../i18n";
import { tError } from "../i18n/errors";
import type { PreviewManager } from "../preview/previewManager";
import type {
  SyncService,
} from "../sync/syncService";
import { BriefPatchError, applyBriefPatch } from "../translation/briefPatch";
import { BRIEF_FIELD_KEYS } from "../translation/summaryLocks";
import {
  MAX_BRIEF_FIELD_CHARS,
} from "../translation/types";
import { isSupportedLanguageId } from "../util/language";
import {
  DEFAULT_GLOSSARY_PAGE_SIZE,
  MAX_GLOSSARY_PAGE_SIZE,
  MAX_TOOL_SAMPLE_ENTRIES,
  type AgentLimits,
  type DocumentBriefUpdateView,
  type DocumentBriefView,
  type DocumentGlossaryUpdateView,
  type GetDocumentBriefInput,
  type GetGlossaryInput,
  type GlossaryEntryView,
  type GlossaryReadView,
  type GlossaryScopeName,
  type GlossarySourceView,
  type GlossaryUpdateView,
  type UpdateDocumentBriefInput,
  type UpdateDocumentGlossaryInput,
  type UpdateGlossaryInput,
} from "./types";

/** 工具错误的稳定分类；模型可以据此决定重试或换参数。 */
export type AgentToolErrorCode =
  | "NO_ACTIVE_EDITOR"
  | "FILE_NOT_FOUND"
  | "AMBIGUOUS_FILE"
  | "NOT_MARKDOWN"
  | "NOT_LOCAL_FILE"
  | "CACHE_PATH"
  | "GLOSSARY_PATH"
  | "NO_WORKSPACE"
  | "SUMMARY_REQUIRED"
  | "INVALID_INPUT"
  | "LIMIT_EXCEEDED"
  | "FILE_DIRTY"
  | "FILE_ERROR"
  | "GLOSSARY_INVALID"
  | "CACHE_CONFLICT"
  | "WRITE_FAILED"
  | "BUSY";

/** 带 code/hint 的工具错误；工具层原样转为 JSON 结果。 */
export class AgentToolError extends Error {
  constructor(
    readonly code: AgentToolErrorCode,
    message: string,
    readonly hint?: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "AgentToolError";
  }
}

export interface AgentServiceDeps {
  syncService: SyncService;
  glossaryStore: GlossaryStore;
  cacheStore: CacheStore;
  previewManager: PreviewManager;
  output: vscode.OutputChannel;
}

const AGENT_LIMITS: AgentLimits = {
  maxSummaryChars: MAX_SUMMARY_CHARS,
  maxBriefFieldChars: MAX_BRIEF_FIELD_CHARS,
  maxDocumentGlossaryEntries: MAX_DOCUMENT_GLOSSARY_ENTRIES,
  maxTermLength: MAX_TERM_LENGTH,
  maxUserGlossaryEntries: MAX_USER_GLOSSARY_ENTRIES,
};

function isFileSystemNotFound(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      (error as { code?: unknown }).code === "FileNotFound",
  );
}

function isScopeName(value: string): value is GlossaryScopeName {
  return value === "global" || value === "workspace" || value === "effective";
}

export class AgentService {
  constructor(private readonly deps: AgentServiceDeps) {}

  /** 读取文档简报、生成锁与文档术语表。 */
  async readDocumentBrief(
    input: GetDocumentBriefInput = {},
  ): Promise<DocumentBriefView> {
    const uri = await this.resolveSourceUri(input.file);
    const state = await this.deps.syncService.loadPreviewState(uri);
    const summary = state.summary;
    const exists = Boolean(summary?.text.trim());
    const includeSummary = input.includeSummary !== false;
    const includeGlossary = input.includeGlossary !== false;
    return {
      ok: true,
      file: uri.fsPath,
      relativePath: this.relativePath(uri),
      sourceLanguage: state.sourceLanguage,
      targetLanguage: state.targetLanguage,
      hasCacheFile: Boolean(state.cacheText?.trim()),
      documentBrief: {
        exists,
        stale:
          summary !== undefined &&
          summary.sourceHash !== summarySourceHash(state.sourceText),
        ...(includeSummary ? { summary: summary?.text ?? "" } : {}),
        summaryChars: summary?.text.length ?? 0,
        ...(summary?.updatedAt ? { updatedAt: summary.updatedAt } : {}),
        ...(summary?.model ? { model: summary.model } : {}),
        brief: summary?.brief ?? {},
        briefFilledCount: BRIEF_FIELD_KEYS.filter(
          (field) => summary?.brief?.[field]?.trim(),
        ).length,
        locks: summary?.locks ?? {},
        ...(includeGlossary
          ? { glossary: summary?.glossary ?? [] }
          : {}),
        glossaryCount: summary?.glossary?.length ?? 0,
      },
      limits: AGENT_LIMITS,
    };
  }

  /** 创建或更新文档简报；brief 按字段合并，术语表整体替换。 */
  async updateDocumentBrief(
    input: UpdateDocumentBriefInput = {},
  ): Promise<DocumentBriefUpdateView> {
    let summary: string | undefined;
    if (input.summary !== undefined) {
      if (typeof input.summary !== "string") {
        throw new AgentToolError("INVALID_INPUT", tError("sync.summaryEmpty"));
      }
      summary = input.summary.trim();
      if (!summary) {
        throw new AgentToolError("INVALID_INPUT", tError("sync.summaryEmpty"));
      }
      if (summary.length > MAX_SUMMARY_CHARS) {
        throw new AgentToolError(
          "INVALID_INPUT",
          tError("sync.summaryTooLong", { chars: MAX_SUMMARY_CHARS }),
        );
      }
    }

    const briefCheck = applyBriefPatch({}, input.brief);
    if (briefCheck.issues.length > 0) {
      throw new AgentToolError(
        "INVALID_INPUT",
        new BriefPatchError(briefCheck.issues).message,
      );
    }

    if (input.glossary !== undefined) {
      const glossaryCheck = applyGlossaryPatch(
        [],
        { mode: "replace", entries: input.glossary },
        MAX_DOCUMENT_GLOSSARY_ENTRIES,
      );
      if (!glossaryCheck.ok) {
        throw new AgentToolError(
          glossaryCheck.issues.some((issue) => issue.code === "too-many")
            ? "LIMIT_EXCEEDED"
            : "INVALID_INPUT",
          new GlossaryPatchError(glossaryCheck.issues).message,
        );
      }
    }

    if (
      summary === undefined &&
      input.brief === undefined &&
      input.glossary === undefined
    ) {
      throw new AgentToolError("INVALID_INPUT", tError("agent.noChanges"));
    }

    const uri = await this.resolveSourceUri(input.file);
    const before = await this.deps.syncService.loadPreviewState(uri);
    const previousText = before.summary?.text.trim() ?? "";
    if (!previousText && summary === undefined) {
      throw new AgentToolError(
        "SUMMARY_REQUIRED",
        tError("agent.summaryRequired"),
        UI_TEXT.agent.hintSummaryRequired,
      );
    }

    const result = await this.runExclusiveDocumentWrite(() =>
      this.deps.syncService.patchDocumentBrief(uri, {
        ...(summary !== undefined ? { summary } : {}),
        ...(input.brief !== undefined ? { brief: input.brief } : {}),
        ...(input.glossary !== undefined ? { glossary: input.glossary } : {}),
      }),
    );
    this.deps.previewManager.refresh(uri);

    const previous = result.previous;
    const next = result.summary;
    const created = !previous?.text.trim();
    const summaryState = created
      ? "created"
      : previousText !== next.text.trim()
        ? "updated"
        : "unchanged";
    const changedBrief = BRIEF_FIELD_KEYS.filter(
      (field) =>
        (previous?.brief?.[field] ?? "") !== (next.brief?.[field] ?? ""),
    );
    const cleared = changedBrief.filter(
      (field) => Boolean(previous?.brief?.[field]) && !next.brief?.[field],
    );
    const glossaryDiff = diffGlossaryEntries(
      previous?.glossary ?? [],
      next.glossary ?? [],
    );
    const stale = next.sourceHash !== summarySourceHash(before.sourceText);

    this.log(
      `update document brief ${this.relativePath(uri)} summary=${summaryState} brief=${changedBrief.join(",") || "-"} glossary=+${glossaryDiff.added.length}/~${glossaryDiff.updated.length}/-${glossaryDiff.removed.length} locks=${result.overrodeLocks.join(",") || "-"}`,
    );

    return {
      ok: true,
      file: uri.fsPath,
      relativePath: this.relativePath(uri),
      created,
      changes: {
        summary: summaryState,
        brief: changedBrief,
        cleared,
        glossary: {
          added: glossaryDiff.added.length,
          updated: glossaryDiff.updated.length,
          removed: glossaryDiff.removed.length,
        },
      },
      brief: next.brief ?? {},
      locks: next.locks ?? {},
      ...(next.updatedAt ? { updatedAt: next.updatedAt } : {}),
      stale,
      summaryChars: next.text.length,
      glossaryCount: next.glossary?.length ?? 0,
      locksOverridden: result.overrodeLocks,
    };
  }

  /** 增量或整体替换文档术语表；必须已有文档简报。 */
  async updateDocumentGlossary(
    input: UpdateDocumentGlossaryInput = {},
  ): Promise<DocumentGlossaryUpdateView> {
    const mode: GlossaryPatchMode = input.mode ?? "merge";
    if (mode !== "merge" && mode !== "replace") {
      throw new AgentToolError(
        "INVALID_INPUT",
        tError("glossary.patchInvalidMode"),
      );
    }
    if (
      input.entries === undefined &&
      input.remove === undefined
    ) {
      throw new AgentToolError("INVALID_INPUT", tError("agent.noChanges"));
    }
    if (
      mode === "merge" &&
      Array.isArray(input.entries) &&
      input.entries.length === 0 &&
      (input.remove === undefined ||
        (Array.isArray(input.remove) && input.remove.length === 0))
    ) {
      throw new AgentToolError("INVALID_INPUT", tError("agent.noChanges"));
    }
    const check = applyGlossaryPatch(
      [],
      { mode, entries: input.entries, remove: input.remove },
      MAX_DOCUMENT_GLOSSARY_ENTRIES,
    );
    if (!check.ok) {
      throw new AgentToolError(
        check.issues.some((issue) => issue.code === "too-many")
          ? "LIMIT_EXCEEDED"
          : "INVALID_INPUT",
        new GlossaryPatchError(check.issues).message,
      );
    }

    const uri = await this.resolveSourceUri(input.file);
    const before = await this.deps.syncService.loadPreviewState(uri);
    if (!before.summary?.text.trim()) {
      throw new AgentToolError(
        "SUMMARY_REQUIRED",
        tError("agent.summaryRequired"),
        UI_TEXT.agent.hintGlossaryNeedsSummary,
      );
    }

    const result = await this.runExclusiveDocumentWrite(() =>
      this.deps.syncService.patchDocumentGlossary(uri, {
        mode,
        ...(input.entries !== undefined ? { entries: input.entries } : {}),
        ...(input.remove !== undefined ? { remove: input.remove } : {}),
      }),
    );
    this.deps.previewManager.refresh(uri);

    const next = result.summary;
    const stale = next.sourceHash !== summarySourceHash(before.sourceText);
    this.log(
      `update document glossary ${this.relativePath(uri)} mode=${mode} added=${result.added.length} updated=${result.updated.length} removed=${result.removed.length} locks=${result.overrodeLocks.join(",") || "-"}`,
    );

    return {
      ok: true,
      file: uri.fsPath,
      relativePath: this.relativePath(uri),
      mode,
      total: next.glossary?.length ?? 0,
      counts: {
        added: result.added.length,
        updated: result.updated.length,
        removed: result.removed.length,
      },
      changed: {
        added: result.added.slice(0, MAX_TOOL_SAMPLE_ENTRIES),
        updated: result.updated.slice(0, MAX_TOOL_SAMPLE_ENTRIES),
        removed: result.removed.slice(0, MAX_TOOL_SAMPLE_ENTRIES),
      },
      duplicates: result.duplicates.slice(0, MAX_TOOL_SAMPLE_ENTRIES),
      locksOverridden: result.overrodeLocks,
      stale,
      summaryChars: next.text.length,
    };
  }

  /** 读取单个或合并后的用户术语表；支持查询与分页。 */
  async readGlossary(input: GetGlossaryInput = {}): Promise<GlossaryReadView> {
    const scope: GlossaryScopeName = input.scope ?? "effective";
    if (!isScopeName(scope)) {
      throw new AgentToolError(
        "INVALID_INPUT",
        tError("agent.invalidScope"),
      );
    }
    const limit = normalizePageSize(input.limit);
    const offset = normalizeOffset(input.offset);
    const query =
      typeof input.query === "string" ? input.query.trim().toLowerCase() : "";

    const sourceUri =
      input.file !== undefined
        ? await this.resolveSourceUri(input.file)
        : undefined;
    const folder = sourceUri
      ? vscode.workspace.getWorkspaceFolder(sourceUri)
      : this.defaultWorkspaceFolder();
    const globalRead = await this.readGlossaryScopeSafe("global");
    const workspaceRead = folder
      ? await this.readGlossaryScopeSafe(
          "workspace",
          sourceUri ?? folder.uri,
        )
      : {};
    if (scope === "workspace" && !folder) {
      throw new AgentToolError(
        "NO_WORKSPACE",
        tError("agent.noWorkspace"),
        UI_TEXT.agent.hintOpenFolder,
      );
    }
    if (scope === "global" && !globalRead.snapshot) {
      this.throwGlossaryReadError(globalRead.error);
    }
    if (scope === "workspace" && !workspaceRead.snapshot) {
      this.throwGlossaryReadError(workspaceRead.error);
    }
    if (
      scope === "effective" &&
      !globalRead.snapshot &&
      !workspaceRead.snapshot
    ) {
      this.throwGlossaryReadError(globalRead.error ?? workspaceRead.error);
    }
    const globalSnapshot = globalRead.snapshot;
    const workspaceSnapshot = workspaceRead.snapshot;
    const warnings: string[] = [];
    let degraded = false;
    if (scope === "effective") {
      if (!globalSnapshot) {
        degraded = true;
        warnings.push(
          formatText(UI_TEXT.agent.degradedScope, {
            scope: UI_TEXT.agent.scopeGlobal,
            message: errorMessage(globalRead.error),
          }),
        );
      }
      if (folder && !workspaceSnapshot) {
        degraded = true;
        warnings.push(
          formatText(UI_TEXT.agent.degradedScope, {
            scope: UI_TEXT.agent.scopeWorkspace,
            message: errorMessage(workspaceRead.error),
          }),
        );
      }
      if (
        !folder &&
        (vscode.workspace.workspaceFolders?.length ?? 0) > 1
      ) {
        degraded = true;
        warnings.push(UI_TEXT.agent.workspaceAmbiguous);
      }
    }

    let entries: GlossaryEntryView[];
    if (scope === "global") {
      entries = (globalSnapshot?.entries ?? []).map((entry) => ({
        ...entry,
        from: "global" as const,
      }));
    } else if (scope === "workspace") {
      entries = (workspaceSnapshot?.entries ?? []).map((entry) => ({
        ...entry,
        from: "workspace" as const,
      }));
    } else {
      const merged = new Map<string, GlossaryEntryView>();
      for (const entry of globalSnapshot?.entries ?? []) {
        merged.set(entry.source.toLowerCase(), {
          ...entry,
          from: "global",
        });
      }
      for (const entry of workspaceSnapshot?.entries ?? []) {
        merged.set(entry.source.toLowerCase(), {
          ...entry,
          from: "workspace",
        });
      }
      entries = [...merged.values()];
    }

    const total = entries.length;
    const matchedEntries = query
      ? entries.filter(
          (entry) =>
            entry.source.toLowerCase().includes(query) ||
            entry.target.toLowerCase().includes(query),
        )
      : entries;
    const page = matchedEntries.slice(offset, offset + limit);
    const sources: GlossarySourceView[] = [];
    if (scope === "global") {
      sources.push(toSourceView(globalSnapshot!));
    } else if (scope === "workspace") {
      sources.push(toSourceView(workspaceSnapshot!));
    } else {
      sources.push(
        globalSnapshot
          ? toSourceView(globalSnapshot)
          : {
              scope: "global",
              path: this.deps.glossaryStore.glossaryUri.fsPath,
              total: 0,
              warnings: [errorMessage(globalRead.error)],
            },
      );
      if (folder) {
        sources.push(
          workspaceSnapshot
            ? toSourceView(workspaceSnapshot)
            : {
                scope: "workspace",
                path: this.deps.glossaryStore.workspaceGlossaryUri(folder)
                  .fsPath,
                total: 0,
                warnings: [errorMessage(workspaceRead.error)],
              },
        );
      }
    }

    return {
      ok: true,
      scope,
      sources,
      workspaceAvailable: workspaceSnapshot !== undefined,
      degraded,
      warnings,
      total,
      matched: matchedEntries.length,
      offset,
      limit,
      hasMore: offset + page.length < matchedEntries.length,
      entries: page,
    };
  }

  /** 读取术语表作用域；失败时返回错误，供调用方决定降级还是抛出。 */
  private async readGlossaryScopeSafe(
    scope: "global" | "workspace",
    sourceUri?: vscode.Uri,
  ): Promise<{ snapshot?: GlossaryScopeSnapshot; error?: unknown }> {
    try {
      return {
        snapshot: await this.deps.glossaryStore.readScope(scope, sourceUri),
      };
    } catch (error) {
      // 只降级已知的文件/解析错误；程序错误继续向上抛，避免掩盖 bug。
      if (
        error instanceof GlossaryStoreError ||
        error instanceof GlossaryParseError
      ) {
        return { error };
      }
      throw error;
    }
  }

  /** 把术语表读取错误转换为稳定的 AgentToolError。 */
  private throwGlossaryReadError(error: unknown): never {
    if (error instanceof GlossaryStoreError) {
      if (error.code === "no-workspace") {
        throw new AgentToolError(
          "NO_WORKSPACE",
          error.message,
          UI_TEXT.agent.hintOpenFolder,
        );
      }
      throw new AgentToolError(
        "GLOSSARY_INVALID",
        error.message,
        UI_TEXT.agent.hintFixGlossary,
      );
    }
    if (error instanceof GlossaryParseError) {
      throw new AgentToolError(
        "GLOSSARY_INVALID",
        error.message,
        UI_TEXT.agent.hintFixGlossary,
      );
    }
    throw new AgentToolError(
      "GLOSSARY_INVALID",
      error instanceof Error
        ? error.message
        : tError("glossary.invalidJson"),
      UI_TEXT.agent.hintFixGlossary,
    );
  }

  /** 更新全局或工作区术语表；返回覆盖/被覆盖的同名 source 统计。 */
  async updateGlossary(
    input: UpdateGlossaryInput = {},
  ): Promise<GlossaryUpdateView> {
    const scope = input.scope;
    if (scope !== "global" && scope !== "workspace") {
      throw new AgentToolError(
        "INVALID_INPUT",
        tError("agent.invalidScope"),
      );
    }
    const mode: GlossaryPatchMode = input.mode ?? "merge";
    if (mode !== "merge" && mode !== "replace") {
      throw new AgentToolError(
        "INVALID_INPUT",
        tError("glossary.patchInvalidMode"),
      );
    }
    if (input.entries === undefined && input.remove === undefined) {
      throw new AgentToolError("INVALID_INPUT", tError("agent.noChanges"));
    }
    if (
      mode === "merge" &&
      Array.isArray(input.entries) &&
      input.entries.length === 0 &&
      (input.remove === undefined ||
        (Array.isArray(input.remove) && input.remove.length === 0))
    ) {
      throw new AgentToolError("INVALID_INPUT", tError("agent.noChanges"));
    }
    const check = applyGlossaryPatch(
      [],
      { mode, entries: input.entries, remove: input.remove },
      MAX_USER_GLOSSARY_ENTRIES,
    );
    if (!check.ok) {
      throw new AgentToolError(
        check.issues.some((issue) => issue.code === "too-many")
          ? "LIMIT_EXCEEDED"
          : "INVALID_INPUT",
        new GlossaryPatchError(check.issues).message,
      );
    }

    const sourceUri =
      input.file !== undefined
        ? await this.resolveSourceUri(input.file)
        : undefined;
    const folder = sourceUri
      ? vscode.workspace.getWorkspaceFolder(sourceUri)
      : this.defaultWorkspaceFolder();
    if (scope === "workspace" && !folder) {
      throw new AgentToolError(
        "NO_WORKSPACE",
        tError("agent.noWorkspace"),
        UI_TEXT.agent.hintOpenFolder,
      );
    }
    const scopeSource = sourceUri ?? folder?.uri;
    const result = await (async () => {
      try {
        return await this.deps.glossaryStore.updateScope(
          scope,
          scope === "workspace" ? scopeSource : undefined,
          {
            mode,
            ...(input.entries !== undefined
              ? { entries: input.entries }
              : {}),
            ...(input.remove !== undefined ? { remove: input.remove } : {}),
          },
        );
      } catch (error) {
        this.throwStructuredWriteError(error);
      }
    })();

    let shadowing: GlossaryUpdateView["shadowing"];
    if (scope === "global") {
      const workspaceRead = folder
        ? await this.readGlossaryScopeSafe("workspace", scopeSource)
        : {};
      const workspaceSnapshot = workspaceRead.snapshot;
      if (folder && !workspaceSnapshot) {
        // 写入已成功；另一作用域无法读取时只降级 shadowing 统计，不回头报失败。
        shadowing = {
          scope: "workspace",
          count: 0,
          sample: [],
          unavailable: true,
        };
      } else {
        const keys = new Set(
          (workspaceSnapshot?.entries ?? []).map((entry) =>
            entry.source.toLowerCase(),
          ),
        );
        const shadowed = result.entries.filter((entry) =>
          keys.has(entry.source.toLowerCase()),
        );
        shadowing = {
          scope: "workspace",
          count: shadowed.length,
          sample: shadowed
            .slice(0, MAX_TOOL_SAMPLE_ENTRIES)
            .map((entry) => entry.source),
        };
      }
    } else {
      const globalRead = await this.readGlossaryScopeSafe("global");
      const globalSnapshot = globalRead.snapshot;
      if (!globalSnapshot) {
        shadowing = {
          scope: "global",
          count: 0,
          sample: [],
          unavailable: true,
        };
      } else {
        const keys = new Set(
          globalSnapshot.entries.map((entry) =>
            entry.source.toLowerCase(),
          ),
        );
        const overrides = result.entries.filter((entry) =>
          keys.has(entry.source.toLowerCase()),
        );
        shadowing = {
          scope: "global",
          count: overrides.length,
          sample: overrides
            .slice(0, MAX_TOOL_SAMPLE_ENTRIES)
            .map((entry) => entry.source),
        };
      }
    }

    this.log(
      `update ${scope} glossary ${result.uri.fsPath} mode=${mode} added=${result.added.length} updated=${result.updated.length} removed=${result.removed.length} shadowed=${shadowing.count}`,
    );

    return {
      ok: true,
      scope,
      path: result.uri.fsPath,
      mode,
      total: result.entries.length,
      counts: {
        added: result.added.length,
        updated: result.updated.length,
        removed: result.removed.length,
      },
      changed: {
        added: result.added.slice(0, MAX_TOOL_SAMPLE_ENTRIES),
        updated: result.updated.slice(0, MAX_TOOL_SAMPLE_ENTRIES),
        removed: result.removed.slice(0, MAX_TOOL_SAMPLE_ENTRIES),
      },
      duplicates: result.duplicates.slice(0, MAX_TOOL_SAMPLE_ENTRIES),
      shadowing,
    };
  }

  // ---- 路径解析与安全 ----

  /**
   * 解析工具传入的源文件：
   * - 绝对路径直接使用；相对路径按工作区根目录解析，多根冲突时报错；
   * - 省略时回退活动编辑器，再回退唯一可见的 Markdown/Skill 编辑器；
   * - 拒绝非 file URI、缓存文件、术语表文件和非 Markdown/Skill 文档。
   */
  private async resolveSourceUri(file: unknown): Promise<vscode.Uri> {
    if (
      file !== undefined &&
      file !== null &&
      typeof file !== "string"
    ) {
      throw new AgentToolError(
        "INVALID_INPUT",
        tError("agent.invalidFileInput"),
      );
    }
    const raw = typeof file === "string" ? file.trim() : "";
    let uri: vscode.Uri;
    if (raw) {
      uri = path.isAbsolute(raw)
        ? vscode.Uri.file(raw)
        : await this.resolveRelativeFile(raw);
    } else {
      uri = this.activeSourceUri();
    }
    return this.validateSourceUri(uri);
  }

  /** 按工作区根目录解析相对路径；多根工作区必须唯一命中。 */
  private async resolveRelativeFile(raw: string): Promise<vscode.Uri> {
    const normalized = path.posix.normalize(raw.replace(/\\/g, "/"));
    if (
      !normalized ||
      normalized === "." ||
      normalized === ".." ||
      normalized.startsWith("../") ||
      path.posix.isAbsolute(normalized) ||
      /^[a-zA-Z]:/.test(normalized)
    ) {
      throw new AgentToolError(
        "INVALID_INPUT",
        tError("agent.invalidRelativePath", { file: raw }),
        UI_TEXT.agent.hintPath,
      );
    }
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (folders.length === 0) {
      throw new AgentToolError(
        "NO_WORKSPACE",
        tError("agent.noWorkspace"),
        UI_TEXT.agent.hintOpenFolder,
      );
    }
    const matches: vscode.Uri[] = [];
    for (const folder of folders) {
      const candidate = vscode.Uri.joinPath(
        folder.uri,
        ...normalized.split("/"),
      );
      if (await this.uriExists(candidate)) {
        matches.push(candidate);
      }
    }
    if (matches.length === 0) {
      throw new AgentToolError(
        "FILE_NOT_FOUND",
        tError("agent.fileNotFound", { file: raw }),
        UI_TEXT.agent.hintPath,
      );
    }
    if (matches.length > 1) {
      const list = matches
        .map((candidate) =>
          vscode.workspace.asRelativePath(candidate, false),
        )
        .join(", ");
      throw new AgentToolError(
        "AMBIGUOUS_FILE",
        tError("agent.ambiguousFile", { file: raw, matches: list }),
        UI_TEXT.agent.hintPassFile,
      );
    }
    return matches[0];
  }

  /** 活动编辑器回退：活动 Markdown/Skill，或唯一可见的 Markdown/Skill。 */
  private activeSourceUri(): vscode.Uri {
    const active = vscode.window.activeTextEditor;
    if (active && isSupportedLanguageId(active.document.languageId)) {
      return active.document.uri;
    }
    const unique = new Map<string, vscode.Uri>();
    for (const editor of vscode.window.visibleTextEditors ?? []) {
      if (isSupportedLanguageId(editor.document.languageId)) {
        unique.set(editor.document.uri.toString(), editor.document.uri);
      }
    }
    if (unique.size === 1) {
      return [...unique.values()][0];
    }
    throw new AgentToolError(
      "NO_ACTIVE_EDITOR",
      tError("agent.noActiveEditor"),
      UI_TEXT.agent.hintPassFile,
    );
  }

  /** 拒绝缓存/术语表路径，并确认文件可打开且语言受支持。 */
  private async validateSourceUri(uri: vscode.Uri): Promise<vscode.Uri> {
    if (uri.scheme !== "file") {
      throw new AgentToolError(
        "NOT_LOCAL_FILE",
        tError("agent.notLocalFile"),
      );
    }
    if (this.deps.cacheStore.isCacheUri(uri)) {
      throw new AgentToolError("CACHE_PATH", tError("agent.cachePath"));
    }
    if (this.isGlossaryUri(uri)) {
      throw new AgentToolError(
        "GLOSSARY_PATH",
        tError("agent.glossaryPath"),
      );
    }
    let document: vscode.TextDocument;
    try {
      document = await vscode.workspace.openTextDocument(uri);
    } catch (error) {
      if (isFileSystemNotFound(error)) {
        throw new AgentToolError(
          "FILE_NOT_FOUND",
          tError("agent.fileNotFound", { file: uri.fsPath }),
          UI_TEXT.agent.hintPath,
        );
      }
      throw error;
    }
    if (!isSupportedLanguageId(document.languageId)) {
      throw new AgentToolError(
        "NOT_MARKDOWN",
        tError("agent.notMarkdown", { file: uri.fsPath }),
        UI_TEXT.agent.hintPassFile,
      );
    }
    return uri;
  }

  /** 判断 URI 是否为全局或任一工作区术语表文件。 */
  private isGlossaryUri(uri: vscode.Uri): boolean {
    const target = uri.toString();
    if (target === this.deps.glossaryStore.glossaryUri.toString()) {
      return true;
    }
    return (vscode.workspace.workspaceFolders ?? []).some(
      (folder) =>
        target ===
        this.deps.glossaryStore.workspaceGlossaryUri(folder).toString(),
    );
  }

  /** 文件是否存在；只吞掉 FileNotFound。 */
  private async uriExists(uri: vscode.Uri): Promise<boolean> {
    try {
      await vscode.workspace.fs.stat(uri);
      return true;
    } catch (error) {
      if (isFileSystemNotFound(error)) {
        return false;
      }
      throw error;
    }
  }

  /** 把同一文件的同步/清缓存互斥错误转成可重试的 BUSY。 */
  private async runExclusiveDocumentWrite<T>(
    action: () => Promise<T>,
  ): Promise<T> {
    try {
      return await action();
    } catch (error) {
      this.throwStructuredWriteError(error);
    }
  }

  /**
   * 把服务层写入错误转换为稳定 code：
   * - 术语补丁/上限 → INVALID_INPUT / LIMIT_EXCEEDED；
   * - brief 校验 → INVALID_INPUT；
   * - 摘要竞态 → SUMMARY_REQUIRED；
   * - 文件互斥 → BUSY（带重试提示）。
   */
  private throwStructuredWriteError(error: unknown): never {
    if (error instanceof GlossaryPatchError) {
      throw new AgentToolError(
        error.issues.some((issue) => issue.code === "too-many")
          ? "LIMIT_EXCEEDED"
          : "INVALID_INPUT",
        error.message,
      );
    }
    if (error instanceof BriefPatchError) {
      throw new AgentToolError("INVALID_INPUT", error.message);
    }
    if (error instanceof GlossaryStoreError) {
      switch (error.code) {
        case "dirty":
          throw new AgentToolError(
            "FILE_DIRTY",
            error.message,
            UI_TEXT.agent.hintSaveOrClose,
          );
        case "no-workspace":
          throw new AgentToolError(
            "NO_WORKSPACE",
            error.message,
            UI_TEXT.agent.hintOpenFolder,
          );
        case "invalid-existing":
          throw new AgentToolError(
            "GLOSSARY_INVALID",
            error.message,
            UI_TEXT.agent.hintFixGlossary,
          );
        case "file-error":
          throw new AgentToolError(
            "FILE_ERROR",
            error.message,
            UI_TEXT.agent.hintFileAccess,
          );
        case "write-failed":
          throw new AgentToolError(
            "WRITE_FAILED",
            error.message,
            UI_TEXT.agent.hintFileAccess,
          );
        case "update-failed":
        case "save-failed":
          throw new AgentToolError(
            "WRITE_FAILED",
            error.message,
            UI_TEXT.agent.hintSaveOrClose,
          );
      }
    }
    if (error instanceof GlossaryParseError) {
      throw new AgentToolError(
        "GLOSSARY_INVALID",
        error.message,
        UI_TEXT.agent.hintFixGlossary,
      );
    }
    if (error instanceof Error) {
      if (error.message === tError("cache.dirty")) {
        throw new AgentToolError(
          "FILE_DIRTY",
          error.message,
          UI_TEXT.agent.hintSaveOrClose,
        );
      }
      if (
        error.message === tError("cache.updateOpenFailed") ||
        error.message === tError("cache.saveFailed")
      ) {
        throw new AgentToolError(
          "WRITE_FAILED",
          error.message,
          UI_TEXT.agent.hintSaveOrClose,
        );
      }
      if (
        error.message === tError("sync.summaryUntrackedCache") ||
        error.message === tError("sync.summaryOrphanAnchor")
      ) {
        throw new AgentToolError(
          "CACHE_CONFLICT",
          error.message,
          UI_TEXT.agent.hintFixCache,
        );
      }
      if (
        error.message === tError("sync.summaryRequiredForBrief") ||
        error.message === tError("sync.glossaryNoSummary")
      ) {
        throw new AgentToolError(
          "SUMMARY_REQUIRED",
          tError("agent.summaryRequired"),
          UI_TEXT.agent.hintSummaryRequired,
        );
      }
      if (
        error.message === tError("sync.fileSyncBusy") ||
        error.message === tError("sync.clearingCacheBusyOp")
      ) {
        throw new AgentToolError(
          "BUSY",
          error.message,
          UI_TEXT.agent.hintRetryBusy,
        );
      }
    }
    throw error;
  }

  /**
   * 默认工作区：活动编辑器所在工作区，否则仅在只有一个工作区时使用它。
   * 多根工作区且没有活动编辑器时返回 undefined，避免把术语写进错误的工作区。
   */
  private defaultWorkspaceFolder(): vscode.WorkspaceFolder | undefined {
    const active = vscode.window.activeTextEditor?.document.uri;
    const activeFolder = active
      ? vscode.workspace.getWorkspaceFolder(active)
      : undefined;
    if (activeFolder) {
      return activeFolder;
    }
    const folders = vscode.workspace.workspaceFolders ?? [];
    return folders.length === 1 ? folders[0] : undefined;
  }

  /** 工作区相对路径；文件在工作区外时退回 basename。 */
  private relativePath(uri: vscode.Uri): string {
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    if (!folder) {
      return path.basename(uri.fsPath);
    }
    return vscode.workspace
      .asRelativePath(uri, false)
      .replace(/\\/g, "/");
  }

  /** 审计日志：只记录文件、作用域与变更数量，不记录正文。 */
  private log(message: string): void {
    this.deps.output.appendLine(
      `[${new Date().toISOString()}] agent: ${message}`,
    );
  }
}

function toSourceView(snapshot: GlossaryScopeSnapshot): GlossarySourceView {
  return {
    scope: snapshot.scope,
    path: snapshot.uri.fsPath,
    total: snapshot.entries.length,
    warnings: snapshot.warnings,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? "unknown");
}

function normalizePageSize(value: unknown): number {
  const number =
    typeof value === "number" && Number.isFinite(value)
      ? Math.trunc(value)
      : DEFAULT_GLOSSARY_PAGE_SIZE;
  return Math.min(MAX_GLOSSARY_PAGE_SIZE, Math.max(1, number));
}

function normalizeOffset(value: unknown): number {
  const number =
    typeof value === "number" && Number.isFinite(value)
      ? Math.trunc(value)
      : 0;
  return Math.max(0, number);
}
