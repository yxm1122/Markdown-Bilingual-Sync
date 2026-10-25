/** 测试：任务视图语言切换的宿主校验、作用域、交换与回滚。 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TaskViewProvider } from "../src/status/taskViewProvider";

type LanguageKey = "sourceLanguage" | "targetLanguage";

interface FakeConfigState {
  sourceLanguage: string;
  targetLanguage: string;
  supportedLanguages: string[];
  workspaceValues: Partial<Record<LanguageKey, string>>;
}

const mocks = vi.hoisted(() => {
  class FakeUri {
    readonly fsPath: string;

    constructor(fsPath: string) {
      this.fsPath = fsPath;
    }

    static joinPath(base: FakeUri, ...parts: string[]): FakeUri {
      return new FakeUri([base.fsPath, ...parts].join("/"));
    }
  }

  const updates: Array<{
    key: string;
    value: unknown;
    target: number;
  }> = [];
  const updateBehavior: {
    error?: Error;
    delays?: Record<string, number>;
    failKey?: "sourceLanguage" | "targetLanguage";
  } = {};
  const state: FakeConfigState = {
    sourceLanguage: "en",
    targetLanguage: "zh-CN",
    supportedLanguages: ["zh-CN", "ja-JP", "en"],
    workspaceValues: {},
  };
  const showErrorMessage = vi.fn();
  const getConfiguration = vi.fn(() => ({
    get(key: string, fallback?: unknown) {
      const value = (state as unknown as Record<string, unknown>)[key];
      return value === undefined ? fallback : value;
    },
    inspect(key: string) {
      const workspaceValue = (
        state.workspaceValues as Record<string, string | undefined>
      )[key];
      return { workspaceValue };
    },
    async update(key: string, value: unknown, target: number) {
      if (updateBehavior.failKey === key) {
        throw updateBehavior.error ?? new Error("settings are locked");
      }
      if (updateBehavior.error) {
        throw updateBehavior.error;
      }
      const delay = updateBehavior.delays?.[String(value)] ?? 0;
      if (delay > 0) {
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
      updates.push({ key, value, target });
      (state as unknown as Record<string, unknown>)[key] = value;
    },
  }));
  const vscode = {
    Uri: FakeUri,
    workspace: {
      getConfiguration,
      onDidChangeConfiguration: () => ({ dispose() {} }),
    },
    window: { showErrorMessage },
    ConfigurationTarget: { Global: 1, Workspace: 2 },
  };

  return {
    FakeUri,
    updates,
    updateBehavior,
    state,
    showErrorMessage,
    getConfiguration,
    vscode,
  };
});

// 展开全局 stub 保留 l10n/env；本文件的 workspace/window mock 覆盖 stub 实现。
vi.mock("vscode", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./vscodeStub")>();
  return { ...actual.vscodeStub, ...mocks.vscode };
});

function createProvider(): {
  provider: TaskViewProvider;
  receive: (message: unknown) => void;
  postMessage: ReturnType<typeof vi.fn>;
} {
  let receive: (message: unknown) => void = () => undefined;
  const postMessage = vi.fn(async (_message: unknown) => true);
  const webview = {
    cspSource: "vscode-webview://test",
    asWebviewUri: (uri: { fsPath: string }) =>
      `https://webview.test${uri.fsPath}`,
    postMessage,
    onDidReceiveMessage: (listener: (message: unknown) => void) => {
      receive = listener;
      return { dispose() {} };
    },
  };
  const view = {
    webview,
    visible: true,
    onDidChangeVisibility: () => ({ dispose() {} }),
    onDidDispose: () => ({ dispose() {} }),
  };
  const provider = new TaskViewProvider({
    extensionUri: new mocks.FakeUri("/extension") as never,
    monitor: {
      onDidChange: () => () => undefined,
      snapshot: () => ({ active: [], finished: [], activeCount: 0 }),
    } as never,
    limiter: {
      onDidChange: () => () => undefined,
      activeCount: 0,
      waitingCount: 0,
      limit: 8,
    } as never,
    output: {
      appendLine: vi.fn(),
      show: vi.fn(),
    } as never,
    openPreview: vi.fn(),
    getSystemInfo: () => ({
      provider: "Mock",
      model: "Mock",
      tokenBudget: 2_000,
      batchSize: 50,
    }),
  });
  provider.resolveWebviewView(view as never);
  return { provider, receive, postMessage };
}

describe("TaskViewProvider language switching", () => {
  beforeEach(() => {
    mocks.updates.length = 0;
    mocks.updateBehavior.error = undefined;
    mocks.updateBehavior.delays = {};
    mocks.updateBehavior.failKey = undefined;
    mocks.state.sourceLanguage = "en";
    mocks.state.targetLanguage = "zh-CN";
    mocks.state.supportedLanguages = ["zh-CN", "ja-JP", "en"];
    mocks.state.workspaceValues = {};
    mocks.showErrorMessage.mockClear();
    mocks.getConfiguration.mockClear();
  });

  it("writes an allowed target to Global when it has no workspace value", async () => {
    const { provider, receive } = createProvider();
    receive({ type: "setTargetLanguage", language: "ja-JP" });

    await vi.waitFor(() => expect(mocks.updates).toHaveLength(1));
    expect(mocks.updates[0]).toEqual({
      key: "targetLanguage",
      value: "ja-JP",
      target: mocks.vscode.ConfigurationTarget.Global,
    });
    expect(mocks.showErrorMessage).not.toHaveBeenCalled();
    provider.dispose();
  });

  it("writes an allowed source to Global when it has no workspace value", async () => {
    const { provider, receive } = createProvider();
    receive({ type: "setSourceLanguage", language: "ja-JP" });

    await vi.waitFor(() => expect(mocks.updates).toHaveLength(1));
    expect(mocks.updates[0]).toEqual({
      key: "sourceLanguage",
      value: "ja-JP",
      target: mocks.vscode.ConfigurationTarget.Global,
    });
    expect(mocks.state.sourceLanguage).toBe("ja-JP");
    expect(mocks.showErrorMessage).not.toHaveBeenCalled();
    provider.dispose();
  });

  it("keeps Workspace scope when the setting is already overridden there", async () => {
    mocks.state.workspaceValues.targetLanguage = "zh-CN";
    const { provider, receive } = createProvider();
    receive({ type: "setTargetLanguage", language: "ja-JP" });

    await vi.waitFor(() => expect(mocks.updates).toHaveLength(1));
    expect(mocks.updates[0]?.target).toBe(
      mocks.vscode.ConfigurationTarget.Workspace,
    );
    provider.dispose();
  });

  it("serializes rapid selections so the last choice wins", async () => {
    mocks.updateBehavior.delays = { "ja-JP": 40, "zh-CN": 0 };
    const { provider, receive } = createProvider();
    receive({ type: "setTargetLanguage", language: "ja-JP" });
    receive({ type: "setTargetLanguage", language: "zh-CN" });

    await vi.waitFor(() => expect(mocks.updates).toHaveLength(2));
    expect(mocks.updates.map((item) => item.value)).toEqual([
      "ja-JP",
      "zh-CN",
    ]);
    expect(mocks.state.targetLanguage).toBe("zh-CN");
    provider.dispose();
  });

  it("includes language fields in the first state push", () => {
    const { provider, postMessage } = createProvider();
    const message = postMessage.mock.calls.at(-1)?.[0] as
      | { type?: string; state?: Record<string, unknown> }
      | undefined;

    expect(message?.type).toBe("state");
    expect(message?.state).toMatchObject({
      sourceLanguage: "en",
      targetLanguage: "zh-CN",
      supportedLanguages: ["zh-CN", "ja-JP", "en"],
    });
    provider.dispose();
  });

  it("rejects a target outside the options without writing settings", async () => {
    const { provider, receive, postMessage } = createProvider();
    postMessage.mockClear();
    receive({ type: "setTargetLanguage", language: "fr" });

    await vi.waitFor(() =>
      expect(mocks.showErrorMessage).toHaveBeenCalledWith(
        expect.stringContaining("不在“支持的语言”列表中"),
      ),
    );
    expect(mocks.updates).toHaveLength(0);
    expect(postMessage).toHaveBeenCalled();
    provider.dispose();
  });

  it("rejects a source outside the options without writing settings", async () => {
    const { provider, receive } = createProvider();
    receive({ type: "setSourceLanguage", language: "fr" });

    await vi.waitFor(() =>
      expect(mocks.showErrorMessage).toHaveBeenCalledWith(
        expect.stringContaining("无法切换原文语言"),
      ),
    );
    expect(mocks.updates).toHaveLength(0);
    provider.dispose();
  });

  it("rejects a target equal to the source language", async () => {
    mocks.state.sourceLanguage = "ja-JP";
    const { provider, receive } = createProvider();
    receive({ type: "setTargetLanguage", language: "JA-jp" });

    await vi.waitFor(() =>
      expect(mocks.showErrorMessage).toHaveBeenCalledWith(
        expect.stringContaining("不能与原文语言“ja-JP”相同"),
      ),
    );
    expect(mocks.updates).toHaveLength(0);
    provider.dispose();
  });

  it("rejects a source equal to the target language", async () => {
    mocks.state.targetLanguage = "ja-JP";
    const { provider, receive } = createProvider();
    receive({ type: "setSourceLanguage", language: "JA-jp" });

    await vi.waitFor(() =>
      expect(mocks.showErrorMessage).toHaveBeenCalledWith(
        expect.stringContaining("不能与译文语言“ja-JP”相同"),
      ),
    );
    expect(mocks.updates).toHaveLength(0);
    provider.dispose();
  });

  it("shows an error and preserves settings when the update fails", async () => {
    mocks.updateBehavior.error = new Error("settings are locked");
    const { provider, receive, postMessage } = createProvider();
    postMessage.mockClear();
    receive({ type: "setTargetLanguage", language: "ja-JP" });

    await vi.waitFor(() =>
      expect(mocks.showErrorMessage).toHaveBeenCalledWith(
        expect.stringContaining("切换译文语言失败：settings are locked"),
      ),
    );
    expect(mocks.updates).toHaveLength(0);
    expect(mocks.state.targetLanguage).toBe("zh-CN");
    expect(postMessage).toHaveBeenCalled();
    provider.dispose();
  });

  it("swaps both languages", async () => {
    const { provider, receive, postMessage } = createProvider();
    postMessage.mockClear();
    receive({ type: "swapLanguages" });

    await vi.waitFor(() => expect(mocks.updates).toHaveLength(2));
    expect(mocks.updates).toEqual([
      {
        key: "sourceLanguage",
        value: "zh-CN",
        target: mocks.vscode.ConfigurationTarget.Global,
      },
      {
        key: "targetLanguage",
        value: "en",
        target: mocks.vscode.ConfigurationTarget.Global,
      },
    ]);
    expect(mocks.state.sourceLanguage).toBe("zh-CN");
    expect(mocks.state.targetLanguage).toBe("en");
    expect(mocks.showErrorMessage).not.toHaveBeenCalled();
    provider.dispose();
  });

  it("rolls back the first write when the second swap write fails", async () => {
    mocks.updateBehavior.failKey = "targetLanguage";
    const { provider, receive } = createProvider();
    receive({ type: "swapLanguages" });

    await vi.waitFor(() =>
      expect(mocks.showErrorMessage).toHaveBeenCalledWith(
        expect.stringContaining("切换语言失败"),
      ),
    );
    // 第一条 source 写入成功，target 失败，随后 source 被回滚到旧值。
    expect(mocks.updates).toEqual([
      {
        key: "sourceLanguage",
        value: "zh-CN",
        target: mocks.vscode.ConfigurationTarget.Global,
      },
      {
        key: "sourceLanguage",
        value: "en",
        target: mocks.vscode.ConfigurationTarget.Global,
      },
    ]);
    expect(mocks.state.sourceLanguage).toBe("en");
    expect(mocks.state.targetLanguage).toBe("zh-CN");
    provider.dispose();
  });

  it("rejects a swap when source and target are the same", async () => {
    mocks.state.sourceLanguage = "zh-CN";
    mocks.state.targetLanguage = "ZH-cn";
    const { provider, receive } = createProvider();
    receive({ type: "swapLanguages" });

    await vi.waitFor(() =>
      expect(mocks.showErrorMessage).toHaveBeenCalledWith(
        expect.stringContaining("当前无法交换"),
      ),
    );
    expect(mocks.updates).toHaveLength(0);
    provider.dispose();
  });
});
