/** 测试：Language Model Tool 适配层的结果包装、确认信息与错误映射。 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as vscode from "vscode";
import { AgentService, AgentToolError } from "../src/agent/agentService";
import { registerAgentTools } from "../src/agent/agentTools";
import { AGENT_TOOL_NAMES } from "../src/agent/toolNames";
import type {
  DocumentBriefUpdateView,
  DocumentBriefView,
  DocumentGlossaryUpdateView,
  GlossaryReadView,
  GlossaryUpdateView,
} from "../src/agent/types";

const mocks = vi.hoisted(() => {
  class LanguageModelTextPart {
    constructor(readonly value: string) {}
  }

  class LanguageModelToolResult {
    constructor(readonly content: unknown[]) {}
  }

  class MarkdownString {
    value = "";
    appendMarkdown(text: string) {
      this.value += text;
      return this;
    }
    appendText(text: string) {
      this.value += text;
      return this;
    }
  }

  const registered = new Map<string, unknown>();

  const vscode = {
    lm: {
      registerTool(name: string, tool: unknown) {
        registered.set(name, tool);
        return { dispose() {} };
      },
    },
    LanguageModelTextPart,
    LanguageModelToolResult,
    MarkdownString,
  };

  return { vscode, registered, MarkdownString };
});

vi.mock("vscode", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./vscodeStub")>();
  return { ...actual.vscodeStub, ...mocks.vscode };
});

const limits = {
  maxSummaryChars: 50_000,
  maxBriefFieldChars: 400,
  maxDocumentGlossaryEntries: 200,
  maxTermLength: 200,
  maxUserGlossaryEntries: 1000,
};

function briefView(): DocumentBriefView {
  return {
    ok: true,
    file: "/project/docs/guide.md",
    relativePath: "docs/guide.md",
    sourceLanguage: "en",
    targetLanguage: "zh-CN",
    hasCacheFile: true,
    documentBrief: {
      exists: true,
      stale: false,
      summary: "全文摘要。",
      summaryChars: 5,
      updatedAt: "2026-01-01T00:00:00.000Z",
      model: "manual",
      brief: { audience: "后端开发者", toneAndStyle: "简洁" },
      briefFilledCount: 2,
      locks: {
        summary: true,
        brief: { audience: true },
        glossary: true,
      },
      glossary: [{ source: "API", target: "接口" }],
      glossaryCount: 1,
    },
    limits,
  };
}

function briefUpdate(): DocumentBriefUpdateView {
  return {
    ok: true,
    file: "/project/docs/guide.md",
    relativePath: "docs/guide.md",
    created: false,
    changes: {
      summary: "updated",
      brief: ["audience"],
      cleared: [],
      glossary: { added: 1, updated: 0, removed: 0 },
    },
    brief: { audience: "运维人员" },
    locks: {},
    stale: false,
    summaryChars: 5,
    glossaryCount: 2,
    locksOverridden: ["audience"],
  };
}

function docGlossaryUpdate(): DocumentGlossaryUpdateView {
  return {
    ok: true,
    file: "/project/docs/guide.md",
    relativePath: "docs/guide.md",
    mode: "merge",
    total: 2,
    counts: { added: 1, updated: 0, removed: 0 },
    changed: {
      added: [{ source: "queue", target: "队列" }],
      updated: [],
      removed: [],
    },
    duplicates: [],
    locksOverridden: [],
    stale: false,
    summaryChars: 5,
  };
}

function glossaryRead(): GlossaryReadView {
  return {
    ok: true,
    scope: "global",
    sources: [
      {
        scope: "global",
        path: "/storage/glossary.json",
        total: 2,
        warnings: [],
      },
    ],
    workspaceAvailable: false,
    degraded: false,
    warnings: [],
    total: 2,
    matched: 2,
    offset: 0,
    limit: 1,
    hasMore: true,
    entries: [{ source: "API", target: "接口", from: "global" }],
  };
}

function glossaryUpdate(): GlossaryUpdateView {
  return {
    ok: true,
    scope: "global",
    path: "/storage/glossary.json",
    mode: "merge",
    total: 3,
    counts: { added: 1, updated: 0, removed: 0 },
    changed: {
      added: [{ source: "queue", target: "队列" }],
      updated: [],
      removed: [],
    },
    duplicates: [],
    shadowing: { scope: "workspace", count: 0, sample: [] },
  };
}

function resultText(result: vscode.LanguageModelToolResult): string {
  const part = result.content[0] as { value: string };
  return part.value;
}

function tool(name: string): vscode.LanguageModelTool<object> {
  const value = mocks.registered.get(name);
  if (!value) {
    throw new Error(`tool not registered: ${name}`);
  }
  return value as vscode.LanguageModelTool<object>;
}

async function invokeTool(
  name: string,
  input: unknown,
): Promise<vscode.LanguageModelToolResult> {
  const result = await tool(name).invoke(
    { toolInvocationToken: undefined, input: input as object },
    token,
  );
  if (!result) {
    throw new Error("tool returned no result");
  }
  return result;
}

async function prepareTool(
  name: string,
  input: unknown,
): Promise<vscode.PreparedToolInvocation> {
  const prepared = await tool(name).prepareInvocation!(
    { input: input as object },
    token,
  );
  if (!prepared) {
    throw new Error("tool returned no preparation");
  }
  return prepared;
}

const token = {} as vscode.CancellationToken;

describe("registerAgentTools", () => {
  let service: AgentService;

  beforeEach(() => {
    mocks.registered.clear();
    service = {
      readDocumentBrief: vi.fn(async () => briefView()),
      updateDocumentBrief: vi.fn(async () => briefUpdate()),
      updateDocumentGlossary: vi.fn(async () => docGlossaryUpdate()),
      readGlossary: vi.fn(async () => glossaryRead()),
      updateGlossary: vi.fn(async () => glossaryUpdate()),
    } as unknown as AgentService;
    registerAgentTools(
      { subscriptions: [] } as unknown as vscode.ExtensionContext,
      service,
    );
  });

  it("registers all five tools with stable names", () => {
    expect([...mocks.registered.keys()].sort()).toEqual(
      Object.values(AGENT_TOOL_NAMES).sort(),
    );
  });

  it("returns JSON text for a read tool", async () => {
    const result = await invokeTool(AGENT_TOOL_NAMES.getDocumentBrief, {
      file: "/project/docs/guide.md",
    });
    const json = JSON.parse(resultText(result));
    expect(json.ok).toBe(true);
    expect(json.relativePath).toBe("docs/guide.md");
    expect(json.documentBrief.brief.audience).toBe("后端开发者");
  });

  it("returns JSON text for a write tool", async () => {
    const result = await invokeTool(AGENT_TOOL_NAMES.updateDocumentBrief, {
      file: "/project/docs/guide.md",
      brief: { audience: "运维人员" },
    });
    const json = JSON.parse(resultText(result));
    expect(json.ok).toBe(true);
    expect(json.changes.brief).toEqual(["audience"]);
    expect(
      (service.updateDocumentBrief as ReturnType<typeof vi.fn>),
    ).toHaveBeenCalledTimes(1);
  });

  it("normalizes null input to an empty object", async () => {
    await invokeTool(AGENT_TOOL_NAMES.getDocumentBrief, null);
    expect(
      (service.readDocumentBrief as ReturnType<typeof vi.fn>),
    ).toHaveBeenCalledWith({});
  });

  it("maps AgentToolError to a structured error result", async () => {
    (
      service.readDocumentBrief as ReturnType<typeof vi.fn>
    ).mockRejectedValueOnce(
      new AgentToolError("NO_ACTIVE_EDITOR", "open a file", "pass a path"),
    );
    const result = await invokeTool(AGENT_TOOL_NAMES.getDocumentBrief, {});
    expect(JSON.parse(resultText(result))).toEqual({
      ok: false,
      code: "NO_ACTIVE_EDITOR",
      message: "open a file",
      hint: "pass a path",
    });
  });

  it("maps unexpected errors to an UNEXPECTED result", async () => {
    (
      service.readGlossary as ReturnType<typeof vi.fn>
    ).mockRejectedValueOnce(new Error("boom"));
    const result = await invokeTool(AGENT_TOOL_NAMES.getGlossary, {
      scope: "global",
    });
    const json = JSON.parse(resultText(result));
    expect(json.ok).toBe(false);
    expect(json.code).toBe("UNEXPECTED");
    expect(json.message).toContain("boom");
  });

  it("builds a brief confirmation with file, field changes and lock overrides", async () => {
    const prepared = await prepareTool(
      AGENT_TOOL_NAMES.updateDocumentBrief,
      {
        file: "/project/docs/guide.md",
        summary: "新的摘要。",
        brief: { audience: "运维人员", toneAndStyle: "" },
        glossary: [{ source: "queue", target: "队列" }],
      },
    );
    expect(prepared.invocationMessage).toBeTruthy();
    expect(prepared.confirmationMessages?.title).toContain("文档简报");
    const message = prepared.confirmationMessages?.message;
    const text =
      typeof message === "string" ? message : (message as { value: string }).value;
    expect(text).toContain("docs/guide.md");
    expect(text).toContain("受众");
    expect(text).toContain("运维人员");
    expect(text).toContain("清除");
    expect(text).toContain("生成锁");
    expect(text).toContain("queue");
  });

  it("builds document glossary and user glossary confirmations", async () => {
    const doc = await prepareTool(
      AGENT_TOOL_NAMES.updateDocumentGlossary,
      {
        file: "/project/docs/guide.md",
        entries: [{ source: "queue", target: "队列" }],
        remove: ["API"],
      },
    );
    const docText =
      typeof doc.confirmationMessages?.message === "string"
        ? doc.confirmationMessages.message
        : (doc.confirmationMessages?.message as { value: string }).value;
    expect(docText).toContain("文档术语表");
    expect(docText).toContain("queue");
    expect(docText).toContain("模式：merge");
    expect(docText).toContain("合并 1 条");
    expect(docText).toContain("删除 1 条");

    const user = await prepareTool(AGENT_TOOL_NAMES.updateGlossary, {
      scope: "global",
      entries: [{ source: "queue", target: "队列" }],
    });
    expect(user.confirmationMessages?.title).toContain("全局");
    const userText =
      typeof user.confirmationMessages?.message === "string"
        ? user.confirmationMessages.message
        : (user.confirmationMessages?.message as { value: string }).value;
    expect(userText).toContain("/storage/glossary.json");
    expect(userText).toContain("queue");
    expect(userText).toContain("模式：merge");
    expect(userText).toContain("合并 1 条");
  });

  it("does not claim a glossary lock override when normalization changes nothing", async () => {
    const prepared = await prepareTool(
      AGENT_TOOL_NAMES.updateDocumentBrief,
      {
        file: "/project/docs/guide.md",
        glossary: [{ source: " API ", target: " 接口 " }],
      },
    );
    const message = prepared.confirmationMessages?.message;
    const text =
      typeof message === "string" ? message : (message as { value: string }).value;
    expect(text).toContain("API");
    expect(text).not.toContain("生成锁");
  });

  it("falls back to a generic confirmation when reading state fails", async () => {
    (
      service.readDocumentBrief as ReturnType<typeof vi.fn>
    ).mockRejectedValueOnce(new Error("boom"));
    const prepared = await prepareTool(
      AGENT_TOOL_NAMES.updateDocumentBrief,
      { file: "/project/docs/guide.md", brief: { audience: "x" } },
    );
    expect(prepared.confirmationMessages?.title).toContain("文档简报");
    expect(prepared.confirmationMessages?.message).toBeTruthy();
  });
});
