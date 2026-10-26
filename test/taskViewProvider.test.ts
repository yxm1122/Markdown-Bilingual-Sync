/** 测试：任务 TreeView 的语言切换、节点映射与作用域。 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { UI_TEXT } from "../src/i18n";
import { TaskViewProvider } from "../src/status/taskViewProvider";
import type { TaskSnapshot } from "../src/status/taskMonitor";

type LanguageKey = "sourceLanguage" | "targetLanguage";

interface FakeConfigState {
  sourceLanguage: string;
  targetLanguage: string;
  supportedLanguages: string[];
  workspaceValues: Partial<Record<LanguageKey, string>>;
}

const mocks = vi.hoisted(() => {
  const updates: Array<{ key: string; value: unknown; target: number }> = [];
  const updateBehavior: {
    error?: Error;
    delays?: Record<string, number>;
    failKey?: "sourceLanguage" | "targetLanguage";
  } = {};
  const state: {
    sourceLanguage: string;
    targetLanguage: string;
    supportedLanguages: string[];
    workspaceValues: Record<string, string | undefined>;
  } = {
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
      return { workspaceValue: state.workspaceValues[key] };
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
  return {
    updates,
    updateBehavior,
    state,
    showErrorMessage,
    getConfiguration,
  };
});

vi.mock("vscode", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./vscodeStub")>();
  return {
    ...actual.vscodeStub,
    workspace: {
      ...actual.vscodeStub.workspace,
      getConfiguration: mocks.getConfiguration,
      onDidChangeConfiguration: () => ({ dispose() {} }),
    },
    window: {
      ...actual.vscodeStub.window,
      showErrorMessage: mocks.showErrorMessage,
    },
  };
});

const EMPTY_SNAPSHOT: TaskSnapshot = {
  active: [],
  finished: [],
  activeCount: 0,
  recentFailure: false,
};

function createProvider(snapshot: TaskSnapshot = EMPTY_SNAPSHOT) {
  const monitor = {
    onDidChange: () => () => undefined,
    snapshot: () => snapshot,
    cancel: vi.fn(),
    cancelAll: vi.fn(() => 0),
    clearFinished: vi.fn(),
    getTask: (id: number) => [...snapshot.active, ...snapshot.finished].find((task) => task.id === id),
  };
  const limiter = {
    onDidChange: () => () => undefined,
    activeCount: 1,
    waitingCount: 2,
    limit: 8,
  };
  const output = { appendLine: vi.fn(), show: vi.fn() };
  const openPreview = vi.fn();
  const provider = new TaskViewProvider({
    monitor: monitor as never,
    limiter: limiter as never,
    output: output as never,
    openPreview,
    getSystemInfo: () => ({
      provider: "Mock",
      model: "Mock",
      tokenBudget: 2_000,
      batchSize: 50,
    }),
  });
  return { provider, monitor, output, openPreview };
}

function resetLanguageState(): void {
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
}

describe("TaskViewProvider language switching", () => {
  beforeEach(resetLanguageState);

  it("writes an allowed target to Global when it has no workspace value", async () => {
    const { provider } = createProvider();
    await provider.setLanguage("target", "ja-JP");

    expect(mocks.updates).toEqual([
      { key: "targetLanguage", value: "ja-JP", target: 1 },
    ]);
    expect(mocks.showErrorMessage).not.toHaveBeenCalled();
    provider.dispose();
  });

  it("keeps Workspace scope when the setting is already overridden there", async () => {
    mocks.state.workspaceValues.targetLanguage = "zh-CN";
    const { provider } = createProvider();
    await provider.setLanguage("target", "ja-JP");

    expect(mocks.updates[0]).toMatchObject({
      key: "targetLanguage",
      value: "ja-JP",
      target: 2,
    });
    provider.dispose();
  });

  it("serializes rapid selections so the last choice wins", async () => {
    mocks.updateBehavior.delays = { "ja-JP": 20 };
    const { provider } = createProvider();
    const first = provider.setLanguage("target", "ja-JP");
    const second = provider.setLanguage("target", "zh-CN");
    await Promise.all([first, second]);

    expect(mocks.updates.map((update) => update.value).slice(-2)).toEqual([
      "ja-JP",
      "zh-CN",
    ]);
    expect(mocks.state.targetLanguage).toBe("zh-CN");
    provider.dispose();
  });

  it("rejects an unsupported language without writing", async () => {
    const { provider } = createProvider();
    await provider.setLanguage("target", "fr");

    expect(mocks.updates).toHaveLength(0);
    expect(mocks.showErrorMessage).toHaveBeenCalledTimes(1);
    provider.dispose();
  });

  it("rejects a language equal to the other side", async () => {
    const { provider } = createProvider();
    await provider.setLanguage("target", "EN");

    expect(mocks.updates).toHaveLength(0);
    expect(mocks.showErrorMessage).toHaveBeenCalledTimes(1);
    provider.dispose();
  });

  it("preserves settings and reports an error when the update fails", async () => {
    mocks.updateBehavior.failKey = "sourceLanguage";
    mocks.updateBehavior.error = new Error("settings are locked");
    const { provider } = createProvider();
    await provider.setLanguage("source", "ja-JP");

    expect(mocks.state.sourceLanguage).toBe("en");
    expect(mocks.showErrorMessage).toHaveBeenCalledTimes(1);
    provider.dispose();
  });

  it("swaps both languages", async () => {
    const { provider } = createProvider();
    await provider.swapLanguages();

    expect(mocks.updates.map((update) => update.value)).toEqual([
      "zh-CN",
      "en",
    ]);
    expect(mocks.state.sourceLanguage).toBe("zh-CN");
    expect(mocks.state.targetLanguage).toBe("en");
    provider.dispose();
  });

  it("rolls back the first write when the second swap write fails", async () => {
    mocks.updateBehavior.failKey = "targetLanguage";
    mocks.updateBehavior.error = new Error("cannot write");
    const { provider } = createProvider();
    await provider.swapLanguages();

    expect(mocks.state.sourceLanguage).toBe("en");
    expect(mocks.showErrorMessage).toHaveBeenCalledTimes(1);
    provider.dispose();
  });

  it("rejects a swap when both languages are the same", async () => {
    mocks.state.sourceLanguage = "en";
    mocks.state.targetLanguage = "en";
    const { provider } = createProvider();
    await provider.swapLanguages();

    expect(mocks.updates).toHaveLength(0);
    expect(mocks.showErrorMessage).toHaveBeenCalledTimes(1);
    provider.dispose();
  });
});

describe("TaskViewProvider tree mapping", () => {
  const snapshot: TaskSnapshot = {
    activeCount: 1,
    recentFailure: true,
    active: [
      {
        id: 1,
        label: "docs/running.md",
        uri: { fsPath: "/docs/running.md" } as never,
        status: "running",
        phase: "正在翻译第 2/4 块…",
        completed: 2,
        total: 4,
        failed: 0,
        startedAt: Date.now() - 5_000,
      },
    ],
    finished: [
      {
        id: 2,
        label: "docs/failed.md",
        uri: { fsPath: "/docs/failed.md" } as never,
        status: "failed",
        phase: "",
        completed: 1,
        total: 3,
        failed: 2,
        startedAt: Date.now() - 20_000,
        finishedAt: Date.now() - 10_000,
        error: "请求超时",
      },
    ],
  };

  it("builds sections, stats and system rows", () => {
    const { provider } = createProvider(snapshot);
    const sections = provider.getChildren();
    expect(sections).toHaveLength(4);
    expect(sections.map((section) => (section as { label: string }).label)).toEqual([
      UI_TEXT.taskPanel.overviewTitle,
      UI_TEXT.taskPanel.activeSection,
      UI_TEXT.taskPanel.historySection,
      UI_TEXT.taskPanel.systemTitle,
    ]);

    const overview = sections[0] as { id: string };
    const stats = provider.getChildren(overview as never);
    expect(stats.map((item) => (item as { label: string }).label)).toContain(
      UI_TEXT.taskPanel.activeTasksLabel,
    );
    const concurrency = stats.find(
      (item) => (item as { id: string }).id === "overview:concurrency",
    ) as { description: string };
    expect(concurrency.description).toContain("1/8");

    const system = sections[3] as { id: string };
    const info = provider.getChildren(system as never);
    expect(info.map((item) => (item as { label: string }).label)).toContain(
      UI_TEXT.taskPanel.modelLabel,
    );
    provider.dispose();
  });

  it("maps running and failed tasks with icons, details and commands", () => {
    const { provider } = createProvider(snapshot);
    const sections = provider.getChildren();
    const activeSection = sections[1] as { id: string };
    const activeTasks = provider.getChildren(activeSection as never);
    const running = activeTasks[0] as { kind: string; id: string };
    expect(running.kind).toBe("task");
    const runningItem = provider.getTreeItem(running as never) as unknown as {
      label: string;
      description: string;
      contextValue: string;
      collapsibleState: number;
      command: { command: string } | undefined;
      iconPath: { id: string; color?: { id: string } };
    };
    expect(runningItem.label).toBe("docs/running.md");
    expect(runningItem.description).toContain("2/4");
    expect(runningItem.contextValue).toBe("taskActive");
    expect(runningItem.collapsibleState).toBe(1);
    expect(runningItem.command?.command).toBe(
      "markdownBilingualSync.task.openSource",
    );
    expect(runningItem.iconPath.id).toBe("sync~spin");
    expect(runningItem.iconPath.color?.id).toBe("charts.blue");

    const runningChildren = provider.getChildren(running as never);
    expect(runningChildren[0]).toMatchObject({
      kind: "detail",
      label: "正在翻译第 2/4 块…",
    });

    const historySection = sections[2] as { id: string };
    const finishedTasks = provider.getChildren(historySection as never);
    const failed = finishedTasks[0] as { kind: string; id: string };
    const failedItem = provider.getTreeItem(failed as never) as unknown as {
      contextValue: string;
      iconPath: { id: string; color?: { id: string } };
    };
    expect(failedItem.contextValue).toBe("taskFinished");
    expect(failedItem.iconPath.id).toBe("error");
    expect(failedItem.iconPath.color?.id).toBe("errorForeground");
    const failedChildren = provider.getChildren(failed as never);
    expect(failedChildren[0]).toMatchObject({
      kind: "detail",
      label: "请求超时",
    });
    provider.dispose();
  });

  it("formats queued/running/failed descriptions without duplicated status or separators", () => {
    const now = Date.now();
    const state: TaskSnapshot = {
      activeCount: 2,
      recentFailure: true,
      active: [
        {
          id: 10,
          label: "docs/queued.md",
          status: "queued",
          phase: "",
          completed: 0,
          total: 0,
          failed: 0,
        },
        {
          id: 11,
          label: "docs/running.md",
          status: "running",
          phase: "正在翻译",
          completed: 0,
          total: 0,
          failed: 0,
          startedAt: now - 5_000,
        },
      ],
      finished: [
        {
          id: 12,
          label: "docs/failed.md",
          status: "failed",
          phase: "",
          completed: 0,
          total: 0,
          failed: 2,
          startedAt: now - 9_000,
          finishedAt: now - 2_000,
          error: "请求超时",
        },
        {
          id: 13,
          label: "docs/empty.md",
          status: "success",
          phase: "",
          completed: 0,
          total: 0,
          failed: 0,
          startedAt: now - 9_000,
          finishedAt: now - 8_000,
        },
      ],
    };
    const { provider } = createProvider(state);
    const sections = provider.getChildren();
    const activeTasks = provider.getChildren(sections[1] as never);
    const description = (node: unknown) =>
      (provider.getTreeItem(node as never) as unknown as { description?: string })
        .description ?? "";

    expect(description(activeTasks[0])).toBe(
      UI_TEXT.taskPanel.statusLabels.queued,
    );
    const running = description(activeTasks[1]);
    expect(running).toContain(UI_TEXT.taskPanel.statusLabels.running);
    expect(running).not.toContain(UI_TEXT.taskPanel.noBlocks);
    expect(running).toMatch(/\d+(\.\d+)?s/);

    const finishedTasks = provider.getChildren(sections[2] as never);
    const failed = description(finishedTasks[0]);
    expect(failed).not.toContain(" ·  · ");
    expect(failed).toContain(
      UI_TEXT.taskPanel.statusLabels.failed,
    );
    expect(failed).toContain("2");
    expect(failed).not.toContain(` · ${UI_TEXT.taskPanel.statusLabels.failed} · ${UI_TEXT.taskPanel.statusLabels.failed}`);
    expect(description(finishedTasks[1])).toContain(
      UI_TEXT.taskPanel.noBlocks,
    );
    provider.dispose();
  });

  it("shows an empty hint when there are no active tasks", () => {
    const { provider } = createProvider({
      active: [],
      finished: [],
      activeCount: 0,
      recentFailure: false,
    });
    const sections = provider.getChildren();
    const activeSection = sections[1] as { id: string };
    const children = provider.getChildren(activeSection as never);
    expect(children[0]).toMatchObject({
      kind: "detail",
      label: UI_TEXT.taskPanel.noActive,
    });
    provider.dispose();
  });
});
