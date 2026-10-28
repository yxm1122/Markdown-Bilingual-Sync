/**
 * Vitest 使用的 `vscode` 模块替身。
 *
 * 通过 vitest.config.ts 的 resolve.alias 全局替换 `vscode`：
 * - l10n.t 从 l10n/bundle.l10n.zh-cn.json 查表，默认测试 locale 为 zh-cn，
 *   因此现有中文断言可以保持；缺失条目回退到英文 source；
 * - env.language 默认 "zh-cn"，供 getLocale()/Intl 格式化测试使用；
 * - 其余 API 只提供最小可用实现；需要断言的测试仍可用 vi.mock("vscode") 覆盖，
 *   覆盖时建议展开本文件的 vscodeStub，以保留 l10n/env。
 *
 * 注意：本文件只用于测试，不进 VSIX（.vscodeignore 已排除 test/**）。
 */
import enBundle from "../l10n/bundle.l10n.json";
import zhBundle from "../l10n/bundle.l10n.zh-cn.json";

const EN = enBundle as Record<string, string>;
const ZH = zhBundle as Record<string, string>;

type L10nMessage = string | { message: string };

/** 默认测试 locale；需要英文 locale 的测试可临时修改后恢复。 */
export const env = { language: "zh-cn" };

/**
 * 按当前 env.language 取译文：zh 开头查 zh-cn bundle，其余回退英文 source。
 * 未登记时再回退原字符串。
 */
export function translate(message: L10nMessage): string {
  const source = typeof message === "string" ? message : message.message;
  if (env.language.toLowerCase().startsWith("zh")) {
    return ZH[source] ?? EN[source] ?? source;
  }
  return EN[source] ?? source;
}

/** 与 vscode.l10n 兼容的最小实现。 */
export const l10n = { t: translate };

/** 最小 Uri 替身；需要路径语义的测试应使用各自的 FakeUri。 */
export class Uri {
  constructor(
    readonly fsPath: string,
    readonly scheme = "file",
  ) {}

  get path(): string {
    return this.fsPath.replace(/\\/g, "/");
  }

  static file(fsPath: string): Uri {
    return new Uri(fsPath);
  }

  static joinPath(base: Uri, ...parts: string[]): Uri {
    return new Uri([base.fsPath.replace(/[\\/]+$/, ""), ...parts].join("/"));
  }

  toString(): string {
    return `${this.scheme}://${this.path}`;
  }
}

function disposable(): { dispose: () => void } {
  return { dispose() {} };
}

/** 最小 FileSystemError 替身；AnnotationStore 用 code 判断文件不存在。 */
export class FileSystemError extends Error {
  constructor(
    readonly code: string,
    message = code,
  ) {
    super(message);
    this.name = "FileSystemError";
  }
}

/** 最小 VS Code API 集合；测试可以展开后覆盖具体成员。 */
export const vscodeStub = {
  l10n,
  env,
  Uri,
  FileSystemError,
  ConfigurationTarget: { Global: 1, Workspace: 2 },
  StatusBarAlignment: { Left: 1, Right: 2 },
  FileType: { File: 1, Directory: 2 },
  EventEmitter: class {
    event = () => disposable();
    fire() {}
    dispose() {}
  },
  Disposable: class {
    constructor(private readonly callback?: () => void) {}
    dispose() {
      this.callback?.();
    }
  },
  ThemeColor: class {
    constructor(readonly id: string) {}
  },
  ThemeIcon: class {
    constructor(
      readonly id: string,
      readonly color?: unknown,
    ) {}
  },
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  TreeItem: class {
    id?: string;
    description?: string;
    tooltip?: unknown;
    iconPath?: unknown;
    contextValue?: string;
    command?: unknown;
    constructor(
      readonly label: string,
      readonly collapsibleState = 0,
    ) {}
  },
  MarkdownString: class {
    private value = "";
    appendMarkdown(text: string) {
      this.value += text;
      return this;
    }
    appendText(text: string) {
      this.value += text;
      return this;
    }
  },
  commands: {
    registerCommand: () => disposable(),
    executeCommand: async () => undefined,
  },
  window: {
    showErrorMessage: async () => undefined,
    showWarningMessage: async () => undefined,
    showInformationMessage: async () => undefined,
    showInputBox: async () => undefined,
    showQuickPick: async () => undefined,
    showTextDocument: async () => undefined,
    showOpenDialog: async () => undefined,
    showSaveDialog: async () => undefined,
    createOutputChannel: () => ({
      appendLine() {},
      show() {},
      dispose() {},
    }),
    createStatusBarItem: () => ({
      text: "",
      tooltip: undefined,
      command: undefined,
      backgroundColor: undefined,
      name: "",
      show() {},
      hide() {},
      dispose() {},
    }),
    registerWebviewViewProvider: () => disposable(),
    activeTextEditor: undefined,
    visibleTextEditors: [],
  },
  workspace: {
    textDocuments: [],
    workspaceFolders: undefined,
    getConfiguration: () => ({
      get: (_key: string, fallback?: unknown) => fallback,
      inspect: () => undefined,
      update: async () => undefined,
    }),
    onDidChangeConfiguration: () => disposable(),
    onDidSaveTextDocument: () => disposable(),
    onDidChangeTextDocument: () => disposable(),
    onDidOpenTextDocument: () => disposable(),
    onDidCloseTextDocument: () => disposable(),
    openTextDocument: async () => ({}),
    asRelativePath: (value: unknown) => String(value),
    fs: {
      readFile: async () => new Uint8Array(),
      writeFile: async () => undefined,
      createDirectory: async () => undefined,
      rename: async () => undefined,
      stat: async () => ({}),
      readDirectory: async () => [],
      delete: async () => undefined,
    },
  },
};

export default vscodeStub;
