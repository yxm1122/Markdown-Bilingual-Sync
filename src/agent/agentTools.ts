/**
 * Language Model Tool 适配层。
 *
 * 只负责：输入归一化、调用 AgentService、把结果/错误转成 JSON 文本，以及写操作前的
 * 确认信息。所有业务校验与写入都在 AgentService/SyncService/GlossaryStore 中完成。
 *
 * 工具名称必须与 package.json 的 `contributes.languageModelTools` 和
 * `onLanguageModelTool:<name>` 激活事件保持一致。
 */
import * as vscode from "vscode";
import { MAX_DOCUMENT_GLOSSARY_ENTRIES } from "../glossary/glossary";
import {
  applyGlossaryPatch,
  diffGlossaryEntries,
} from "../glossary/glossaryPatch";
import { formatText, UI_TEXT } from "../i18n";
import { tError } from "../i18n/errors";
import type { GlossaryEntry } from "../translation/types";
import { BRIEF_FIELD_KEYS } from "../translation/summaryLocks";
import { AgentService, AgentToolError } from "./agentService";
import { AGENT_TOOL_NAMES } from "./toolNames";
import {
  MAX_CONFIRM_SAMPLE_ENTRIES,
  type DocumentBriefView,
  type GetDocumentBriefInput,
  type GetGlossaryInput,
  type UpdateDocumentBriefInput,
  type UpdateDocumentGlossaryInput,
  type UpdateGlossaryInput,
} from "./types";

/** 把模型传入的 JSON 归一化为对象；数组/null/原始值一律视为空输入。 */
function asInput<T extends object>(value: unknown): T {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as T)
    : ({} as T);
}

/** 工具结果统一为一段 JSON 文本，便于模型解析。 */
function textResult(value: unknown): vscode.LanguageModelToolResult {
  const text =
    typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return new vscode.LanguageModelToolResult([
    new vscode.LanguageModelTextPart(text),
  ]);
}

/** 执行工具动作；已知错误转为结构化结果，未预期错误保留原始信息。 */
async function runTool<T>(
  action: () => Promise<T>,
): Promise<vscode.LanguageModelToolResult> {
  try {
    return textResult(await action());
  } catch (error) {
    if (error instanceof AgentToolError) {
      return textResult({
        ok: false,
        code: error.code,
        message: error.message,
        ...(error.hint ? { hint: error.hint } : {}),
        ...(error.details !== undefined ? { details: error.details } : {}),
      });
    }
    const message = error instanceof Error ? error.message : String(error);
    return textResult({
      ok: false,
      code: "UNEXPECTED",
      message: tError("agent.unexpected", { message }),
    });
  }
}

function fieldLabel(field: string): string {
  switch (field) {
    case "summary":
      return UI_TEXT.agent.fieldSummary;
    case "glossary":
      return UI_TEXT.agent.fieldGlossary;
    case "audience":
      return UI_TEXT.agent.fieldAudience;
    case "toneAndStyle":
      return UI_TEXT.agent.fieldToneAndStyle;
    case "ambiguities":
      return UI_TEXT.agent.fieldAmbiguities;
    case "doNotTranslate":
      return UI_TEXT.agent.fieldDoNotTranslate;
    default:
      return field;
  }
}

function scopeLabel(scope: "global" | "workspace"): string {
  return scope === "global"
    ? UI_TEXT.agent.scopeGlobal
    : UI_TEXT.agent.scopeWorkspace;
}

function formatValue(value: string | undefined): string {
  return value?.trim() || UI_TEXT.agent.confirmBriefEmpty;
}

/** 向 MarkdownString 追加一条术语样本；值使用 appendText 规避 Markdown 注入。 */
function appendEntrySample(
  md: vscode.MarkdownString,
  entries: readonly GlossaryEntry[],
): void {
  for (const entry of entries.slice(0, MAX_CONFIRM_SAMPLE_ENTRIES)) {
    md.appendMarkdown("\n- ");
    md.appendText(`${entry.source} → ${entry.target}`);
  }
}

/** 计算写操作会覆盖哪些生成锁；仅用于确认提示，不改变实际写入语义。 */
function overriddenDocumentTargets(
  view: DocumentBriefView,
  input: UpdateDocumentBriefInput,
): string[] {
  const targets: string[] = [];
  if (
    input.summary !== undefined &&
    view.documentBrief.locks.summary === true &&
    input.summary.trim() !== (view.documentBrief.summary ?? "").trim()
  ) {
    targets.push("summary");
  }
  if (input.brief) {
    for (const field of BRIEF_FIELD_KEYS) {
      if (!(field in input.brief)) {
        continue;
      }
      const raw = input.brief[field];
      const next = typeof raw === "string" ? raw.trim() : "";
      const previous = (view.documentBrief.brief[field] ?? "").trim();
      if (
        next !== previous &&
        view.documentBrief.locks.brief?.[field] === true
      ) {
        targets.push(field);
      }
    }
  }
  if (
    input.glossary !== undefined &&
    view.documentBrief.locks.glossary === true
  ) {
    const replacement = applyGlossaryPatch(
      [],
      { mode: "replace", entries: input.glossary },
      MAX_DOCUMENT_GLOSSARY_ENTRIES,
    );
    if (replacement.ok) {
      const diff = diffGlossaryEntries(
        view.documentBrief.glossary ?? [],
        replacement.entries,
      );
      if (
        diff.added.length + diff.updated.length + diff.removed.length >
        0
      ) {
        targets.push("glossary");
      }
    }
  }
  return targets;
}

async function prepareBriefUpdate(
  service: AgentService,
  input: UpdateDocumentBriefInput,
): Promise<vscode.PreparedToolInvocation> {
  const fallback: vscode.PreparedToolInvocation = {
    invocationMessage: UI_TEXT.agent.updatingDocumentBrief,
    confirmationMessages: {
      title: UI_TEXT.agent.updateDocumentBriefTitle,
      message: UI_TEXT.agent.confirmGenericBrief,
    },
  };
  try {
    const view = await service.readDocumentBrief({
      file: input.file,
      includeSummary: true,
      includeGlossary: true,
    });
    const md = new vscode.MarkdownString();
    md.appendText(
      formatText(UI_TEXT.agent.confirmFile, {
        file: view.relativePath || view.file,
      }),
    );
    md.appendMarkdown("\n\n");
    md.appendText(
      formatText(UI_TEXT.agent.confirmSummary, {
        state:
          typeof input.summary === "string"
            ? formatText(
                view.documentBrief.exists
                  ? UI_TEXT.agent.confirmSummaryUpdate
                  : UI_TEXT.agent.confirmSummaryCreate,
                { count: input.summary.trim().length },
              )
            : UI_TEXT.agent.confirmSummaryKeep,
      }),
    );
    md.appendMarkdown("\n\n");
    md.appendMarkdown(UI_TEXT.agent.confirmBrief);
    md.appendMarkdown("\n");
    const brief =
      input.brief &&
      typeof input.brief === "object" &&
      !Array.isArray(input.brief)
        ? input.brief
        : undefined;
    const briefFields = brief
      ? BRIEF_FIELD_KEYS.filter((field) => field in brief)
      : [];
    if (briefFields.length === 0) {
      md.appendText(UI_TEXT.agent.confirmBriefUnchanged);
    } else {
      for (const field of briefFields) {
        const raw = brief?.[field];
        const next = typeof raw === "string" ? raw.trim() : "";
        const previous = view.documentBrief.brief[field];
        const value = !next
          ? formatText(UI_TEXT.agent.confirmBriefCleared, {
              old: formatValue(previous),
            })
          : formatText(UI_TEXT.agent.confirmBriefChanged, {
              old: formatValue(previous),
              new: next,
            });
        md.appendText(
          formatText(UI_TEXT.agent.confirmBriefField, {
            field: fieldLabel(field),
            value,
          }),
        );
        md.appendMarkdown("\n");
      }
    }
    md.appendMarkdown("\n");
    const glossary = Array.isArray(input.glossary)
      ? input.glossary
      : undefined;
    if (glossary !== undefined) {
      md.appendText(
        formatText(UI_TEXT.agent.confirmGlossary, {
          state: formatText(UI_TEXT.agent.confirmGlossaryReplace, {
            count: glossary.length,
          }),
        }),
      );
      appendEntrySample(md, glossary);
    } else {
      md.appendText(
        formatText(UI_TEXT.agent.confirmGlossary, {
          state: UI_TEXT.agent.confirmGlossaryUnchanged,
        }),
      );
    }
    if (
      input.summary === undefined &&
      input.brief === undefined &&
      input.glossary === undefined
    ) {
      md.appendMarkdown("\n\n");
      md.appendText(UI_TEXT.agent.confirmNoChanges);
    }
    const overridden = overriddenDocumentTargets(view, input);
    if (overridden.length > 0) {
      md.appendMarkdown("\n\n");
      md.appendText(
        formatText(UI_TEXT.agent.confirmLocksOverridden, {
          targets: overridden.map(fieldLabel).join(", "),
        }),
      );
    }
    return {
      invocationMessage: UI_TEXT.agent.updatingDocumentBrief,
      confirmationMessages: {
        title: UI_TEXT.agent.updateDocumentBriefTitle,
        message: md,
      },
    };
  } catch {
    return fallback;
  }
}

async function prepareDocumentGlossaryUpdate(
  service: AgentService,
  input: UpdateDocumentGlossaryInput,
): Promise<vscode.PreparedToolInvocation> {
  const fallback: vscode.PreparedToolInvocation = {
    invocationMessage: UI_TEXT.agent.updatingDocumentGlossary,
    confirmationMessages: {
      title: UI_TEXT.agent.updateDocumentGlossaryTitle,
      message: UI_TEXT.agent.confirmGenericDocumentGlossary,
    },
  };
  try {
    const view = await service.readDocumentBrief({
      file: input.file,
      includeSummary: false,
      includeGlossary: true,
    });
    const md = new vscode.MarkdownString();
    md.appendText(
      formatText(UI_TEXT.agent.confirmFile, {
        file: view.relativePath || view.file,
      }),
    );
    md.appendMarkdown("\n\n");
    const mode = input.mode === "replace" ? "replace" : "merge";
    md.appendText(formatText(UI_TEXT.agent.confirmMode, { mode }));
    md.appendMarkdown("\n\n");
    const entries = Array.isArray(input.entries)
      ? input.entries
      : undefined;
    const remove = Array.isArray(input.remove) ? input.remove : undefined;
    if (entries !== undefined) {
      md.appendText(
        formatText(UI_TEXT.agent.confirmGlossary, {
          state: formatText(
            mode === "replace"
              ? UI_TEXT.agent.confirmGlossaryReplace
              : UI_TEXT.agent.confirmGlossaryMerge,
            { count: entries.length },
          ),
        }),
      );
      appendEntrySample(md, entries);
    } else {
      md.appendText(
        formatText(UI_TEXT.agent.confirmGlossary, {
          state: UI_TEXT.agent.confirmGlossaryUnchanged,
        }),
      );
    }
    if (remove && remove.length > 0) {
      md.appendMarkdown("\n");
      md.appendText(
        formatText(UI_TEXT.agent.confirmGlossaryRemove, {
          count: remove.length,
        }),
      );
    }
    if (
      entries === undefined &&
      (remove === undefined || remove.length === 0)
    ) {
      md.appendMarkdown("\n\n");
      md.appendText(UI_TEXT.agent.confirmNoChanges);
    }
    const patchCheck =
      entries !== undefined || remove !== undefined
        ? applyGlossaryPatch(
            view.documentBrief.glossary ?? [],
            { mode, entries, remove },
            MAX_DOCUMENT_GLOSSARY_ENTRIES,
          )
        : undefined;
    const hasGlossaryChanges =
      patchCheck !== undefined &&
      patchCheck.ok &&
      patchCheck.added.length +
        patchCheck.updated.length +
        patchCheck.removed.length >
        0;
    if (view.documentBrief.locks.glossary === true && hasGlossaryChanges) {
      md.appendMarkdown("\n\n");
      md.appendText(
        formatText(UI_TEXT.agent.confirmLocksOverridden, {
          targets: fieldLabel("glossary"),
        }),
      );
    }
    return {
      invocationMessage: UI_TEXT.agent.updatingDocumentGlossary,
      confirmationMessages: {
        title: UI_TEXT.agent.updateDocumentGlossaryTitle,
        message: md,
      },
    };
  } catch {
    return fallback;
  }
}

async function prepareUserGlossaryUpdate(
  service: AgentService,
  input: UpdateGlossaryInput,
): Promise<vscode.PreparedToolInvocation> {
  const scope = input.scope === "workspace" ? "workspace" : "global";
  const scopeText = scopeLabel(scope);
  const fallback: vscode.PreparedToolInvocation = {
    invocationMessage: UI_TEXT.agent.updatingGlossary,
    confirmationMessages: {
      title: formatText(UI_TEXT.agent.updateGlossaryTitle, {
        scope: scopeText,
      }),
      message: UI_TEXT.agent.confirmGenericGlossary,
    },
  };
  try {
    const view = await service.readGlossary({
      scope,
      file: input.file,
      limit: 1,
    });
    const md = new vscode.MarkdownString();
    md.appendText(
      formatText(UI_TEXT.agent.confirmScope, { scope: scopeText }),
    );
    md.appendMarkdown("\n");
    md.appendText(
      formatText(UI_TEXT.agent.confirmPath, {
        path: view.sources[0]?.path ?? "",
      }),
    );
    md.appendMarkdown("\n\n");
    const mode = input.mode === "replace" ? "replace" : "merge";
    md.appendText(formatText(UI_TEXT.agent.confirmMode, { mode }));
    md.appendMarkdown("\n\n");
    const entries = Array.isArray(input.entries)
      ? input.entries
      : undefined;
    const remove = Array.isArray(input.remove) ? input.remove : undefined;
    if (entries !== undefined) {
      md.appendText(
        formatText(UI_TEXT.agent.confirmUserGlossary, {
          scope: scopeText,
          state: formatText(
            mode === "replace"
              ? UI_TEXT.agent.confirmUserGlossaryReplace
              : UI_TEXT.agent.confirmGlossaryMerge,
            { count: entries.length },
          ),
        }),
      );
      appendEntrySample(md, entries);
    } else if (remove === undefined || remove.length === 0) {
      md.appendText(UI_TEXT.agent.confirmNoChanges);
    }
    if (remove && remove.length > 0) {
      md.appendMarkdown("\n");
      md.appendText(
        formatText(UI_TEXT.agent.confirmUserGlossaryRemove, {
          count: remove.length,
        }),
      );
    }
    return {
      invocationMessage: UI_TEXT.agent.updatingGlossary,
      confirmationMessages: {
        title: formatText(UI_TEXT.agent.updateGlossaryTitle, {
          scope: scopeText,
        }),
        message: md,
      },
    };
  } catch {
    return fallback;
  }
}

function createGetDocumentBriefTool(
  service: AgentService,
): vscode.LanguageModelTool<GetDocumentBriefInput> {
  return {
    prepareInvocation() {
      return {
        invocationMessage: UI_TEXT.agent.readingDocumentBrief,
      };
    },
    async invoke(options) {
      return runTool(() =>
        service.readDocumentBrief(asInput(options.input)),
      );
    },
  };
}

function createUpdateDocumentBriefTool(
  service: AgentService,
): vscode.LanguageModelTool<UpdateDocumentBriefInput> {
  return {
    prepareInvocation(options) {
      return prepareBriefUpdate(service, asInput(options.input));
    },
    async invoke(options) {
      return runTool(() =>
        service.updateDocumentBrief(asInput(options.input)),
      );
    },
  };
}

function createUpdateDocumentGlossaryTool(
  service: AgentService,
): vscode.LanguageModelTool<UpdateDocumentGlossaryInput> {
  return {
    prepareInvocation(options) {
      return prepareDocumentGlossaryUpdate(
        service,
        asInput(options.input),
      );
    },
    async invoke(options) {
      return runTool(() =>
        service.updateDocumentGlossary(asInput(options.input)),
      );
    },
  };
}

function createGetGlossaryTool(
  service: AgentService,
): vscode.LanguageModelTool<GetGlossaryInput> {
  return {
    prepareInvocation() {
      return {
        invocationMessage: UI_TEXT.agent.readingGlossary,
      };
    },
    async invoke(options) {
      return runTool(() => service.readGlossary(asInput(options.input)));
    },
  };
}

function createUpdateGlossaryTool(
  service: AgentService,
): vscode.LanguageModelTool<UpdateGlossaryInput> {
  return {
    prepareInvocation(options) {
      return prepareUserGlossaryUpdate(service, asInput(options.input));
    },
    async invoke(options) {
      return runTool(() =>
        service.updateGlossary(asInput(options.input)),
      );
    },
  };
}

/**
 * 注册 5 个 Language Model Tool；宿主没有 `vscode.lm` 时静默跳过，
 * 保证 VS Code 分支/旧版本仍能正常使用扩展的其他功能。
 */
export function registerAgentTools(
  context: vscode.ExtensionContext,
  service: AgentService,
): void {
  const lm = vscode.lm;
  if (!lm || typeof lm.registerTool !== "function") {
    return;
  }
  context.subscriptions.push(
    lm.registerTool(
      AGENT_TOOL_NAMES.getDocumentBrief,
      createGetDocumentBriefTool(service),
    ),
    lm.registerTool(
      AGENT_TOOL_NAMES.updateDocumentBrief,
      createUpdateDocumentBriefTool(service),
    ),
    lm.registerTool(
      AGENT_TOOL_NAMES.updateDocumentGlossary,
      createUpdateDocumentGlossaryTool(service),
    ),
    lm.registerTool(
      AGENT_TOOL_NAMES.getGlossary,
      createGetGlossaryTool(service),
    ),
    lm.registerTool(
      AGENT_TOOL_NAMES.updateGlossary,
      createUpdateGlossaryTool(service),
    ),
  );
}
