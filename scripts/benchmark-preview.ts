/**
 * 300 块文档的预览性能基线。
 *
 * 流程：
 * 1. 生成 300 个顶层块的英文 Markdown，用 Mock Provider 同步出缓存；
 * 2. 用生产 appShell + 静态 Dark+ 主题写出 tmp/preview-perf.html；
 * 3. 启动 headless Edge，通过 CDP 测量首屏、布局/模式切换、宿主 state 更新、
 *    连续输入、正文滚动、分栏滚动同步，并在 4× CPU 降速下复测关键路径；
 * 4. 输出 artifacts/ui-perf/report.{json,md} 与 300 块截图，超出预算则非零退出。
 *
 * 这些数字是本机基线，不是跨机器 SLA；CPU 降速用于放大主线程问题。
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { randomBytes } from "node:crypto";
import * as vscode from "vscode";
import { buildPreviewAppShell } from "../src/preview/appShell";
import {
  buildPreviewModel,
  type PreviewModel,
} from "../src/preview/previewModel";
import { syncDocument } from "../src/sync/sync";
import { MockTranslationProvider } from "../src/translation/mockProvider";
import { createMarkdownRuntime } from "../src/markdown/markdown";
import { STATIC_THEMES } from "./static-themes";

const projectRoot = process.cwd();
const outputDir = path.join(projectRoot, "artifacts", "ui-perf");
const pageDir = path.join(projectRoot, "tmp");
const pagePath = path.join(pageDir, "preview-perf.html");
const profileDir = path.join(projectRoot, "tmp", `edge-perf-${process.pid}`);
const port = Number(process.env.UI_PERF_PORT || 9456);
const viewport = { width: 1440, height: 960 };
const blockCount = 300;

interface WebSocketLike {
  addEventListener(
    type: "open" | "error" | "close" | "message",
    listener: (event: { data?: unknown }) => void,
  ): void;
  send(data: string): void;
  close(): void;
}

interface Target {
  id: string;
  type: string;
  webSocketDebuggerUrl: string;
}

interface LongTask {
  start: number;
  duration: number;
}

interface ScrollStats {
  frames: number;
  averageFrameMs: number;
  p95FrameMs: number;
  maxFrameMs: number;
  finalScroll: number;
  maxScroll: number;
  targetScroll?: number;
  targetMax?: number;
}

interface InputStats {
  dispatchMs: number;
  totalMs: number;
  characters: number;
  longTasks: LongTask[];
}

interface RateResult {
  layouts: Record<string, number[]>;
  modes: Record<string, number[]>;
  stateUpdates: number[];
  input: InputStats;
  scroll: ScrollStats;
  splitScroll: ScrollStats;
  maxLongTaskMs: number;
}

interface PerfReport {
  generatedAt: string;
  blocks: number;
  htmlBytes: number;
  viewport: { width: number; height: number };
  initial: {
    appAtMs: number;
    firstBlockAtMs: number;
    domContentLoadedMs: number;
    loadEventMs: number;
    firstContentfulPaintMs: number | null;
    longTasks: LongTask[];
    domNodes: number;
  };
  memory: { usedMb: number; totalMb: number };
  rate1: RateResult;
  rate4: RateResult;
  errors: string[];
  screenshot: string;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function findEdge(): string {
  const candidates = [
    process.env.EDGE_PATH,
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
    "/usr/bin/microsoft-edge",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  ].filter(Boolean) as string[];
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) {
    throw new Error("找不到 Microsoft Edge；请通过 EDGE_PATH 指定浏览器。");
  }
  return found;
}

class Cdp {
  private nextId = 0;
  private pending = new Map<
    number,
    { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void }
  >();
  private errors: string[] = [];

  private constructor(private readonly socket: WebSocketLike) {
    socket.addEventListener("message", (event) => {
      const raw = typeof event.data === "string" ? event.data : "";
      if (!raw) {
        return;
      }
      const message = JSON.parse(raw) as {
        id?: number;
        method?: string;
        params?: Record<string, unknown>;
        result?: Record<string, unknown>;
        error?: { message?: string };
      };
      if (typeof message.id === "number") {
        const pending = this.pending.get(message.id);
        if (!pending) {
          return;
        }
        this.pending.delete(message.id);
        if (message.error) {
          pending.reject(new Error(message.error.message || "CDP error"));
        } else {
          pending.resolve(message.result ?? {});
        }
        return;
      }
      if (message.method === "Runtime.exceptionThrown") {
        const details = message.params?.exceptionDetails as
          | { text?: string; exception?: { description?: string } }
          | undefined;
        this.errors.push(
          details?.exception?.description || details?.text || "Uncaught exception",
        );
      } else if (message.method === "Runtime.consoleAPICalled") {
        const type = message.params?.type;
        if (type !== "error" && type !== "assert") {
          return;
        }
        const args =
          (message.params?.args as { value?: unknown; description?: string }[] | undefined) ?? [];
        this.errors.push(
          args
            .map((arg) =>
              arg.description !== undefined
                ? arg.description
                : typeof arg.value === "string"
                  ? arg.value
                  : JSON.stringify(arg.value),
            )
            .join(" "),
        );
      } else if (message.method === "Log.entryAdded") {
        const entry = message.params?.entry as
          | { level?: string; text?: string; url?: string }
          | undefined;
        if (entry?.level === "error") {
          this.errors.push(`${entry.text || "log error"}${entry.url ? ` (${entry.url})` : ""}`);
        }
      }
    });
  }

  static async connect(url: string): Promise<Cdp> {
    const WebSocketCtor = (
      globalThis as unknown as { WebSocket: new (url: string) => WebSocketLike }
    ).WebSocket;
    const socket = new WebSocketCtor(url);
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve());
      socket.addEventListener("error", () => reject(new Error("CDP 连接失败")));
    });
    return new Cdp(socket);
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  takeErrors(): string[] {
    const errors = this.errors;
    this.errors = [];
    return errors;
  }

  close(): void {
    this.socket.close();
  }
}

/** 生成 300 块示例文档：标题、段落、列表、引用、代码与表格混合。 */
function buildSource(): string {
  const blocks: string[] = [];
  for (let index = 0; index < blockCount; index += 1) {
    if (index === 0) {
      blocks.push("# Performance benchmark document");
    } else if (index % 25 === 1) {
      blocks.push(`## Section ${Math.ceil(index / 25)}`);
    } else if (index % 29 === 0) {
      blocks.push(
        [
          "| Block | Kind | Status |",
          "| --- | --- | --- |",
          `| ${index} | table | translated |`,
          `| ${index + 1} | paragraph | translated |`,
        ].join("\n"),
      );
    } else if (index % 17 === 0) {
      blocks.push(
        [
          "```ts",
          `const value${index} = ${index};`,
          "export function render() {",
          `  return value${index};`,
          "}",
          "```",
        ].join("\n"),
      );
    } else if (index % 13 === 0) {
      blocks.push(
        `> Quoted block ${index}. The quick brown fox jumps over the lazy dog, and the note stays readable while the translation follows beside it.`,
      );
    } else if (index % 7 === 0) {
      blocks.push(
        [
          `- List item ${index}.1 with a short English sentence.`,
          `- List item ${index}.2 keeps enough text to wrap on a narrow pane.`,
          `- List item ${index}.3 closes the list.`,
        ].join("\n"),
      );
    } else if (index % 11 === 0) {
      blocks.push(
        `$$ E = mc^2 \\quad \\text{block ${index}} $$\n\nInline math $a^2 + b^2 = c^2$ stays protected.`,
      );
    } else {
      blocks.push(
        `Paragraph ${index}. The quick brown fox jumps over the lazy dog. This paragraph keeps a short English text next to its Chinese translation, plus enough words to exercise wrapping, line height and selection behavior in a long bilingual document.`,
      );
    }
  }
  return `${blocks.join("\n\n")}\n`;
}

async function writePerfPage(): Promise<{ model: PreviewModel; htmlBytes: number }> {
  const sourceText = buildSource();
  const md = createMarkdownRuntime();
  const provider = new MockTranslationProvider();
  const result = await syncDocument({
    md,
    sourceText,
    provider,
    sourceLanguage: "en",
    targetLanguage: "zh-CN",
    retranslateStale: false,
  });
  const model = buildPreviewModel({
    sourceText,
    cacheText: result.cacheText,
    sourceLanguage: "en",
    targetLanguage: "zh-CN",
    providerLabel: "Mock Provider",
    fileLabel: "performance.md",
  });
  if (model.blocks.length < blockCount) {
    throw new Error(
      `性能页面只生成了 ${model.blocks.length} 块，预期至少 ${blockCount} 块`,
    );
  }
  const nonce = randomBytes(18).toString("base64");
  const webview = {
    cspSource: "file:",
    asWebviewUri: (uri: { fsPath: string }) => pathToFileURL(uri.fsPath).href,
  };
  const html = buildPreviewAppShell({
    webview: webview as never,
    extensionUri: vscode.Uri.file(projectRoot),
    nonce,
    state: {
      model,
      layout: "columns",
      readonly: { source: false, target: false },
    },
  }).replace(
    "</head>",
    `<style id="static-theme">${STATIC_THEMES.dark}</style></head>`,
  );
  await mkdir(pageDir, { recursive: true });
  await writeFile(pagePath, html, "utf8");
  return { model, htmlBytes: Buffer.byteLength(html, "utf8") };
}

async function launchEdge(edgePath: string): Promise<ChildProcess> {
  await mkdir(profileDir, { recursive: true });
  const child = spawn(
    edgePath,
    [
      "--headless=new",
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profileDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-gpu",
      "--disable-extensions",
      "--disable-background-networking",
      "--disable-sync",
      "--force-device-scale-factor=1",
      `--window-size=${viewport.width},${viewport.height}`,
      "about:blank",
    ],
    { stdio: "ignore", windowsHide: true },
  );
  for (let attempt = 0; attempt < 150; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      if (response.ok) {
        const targets = (await response.json()) as Target[];
        if (targets.some((target) => target.type === "page")) {
          return child;
        }
      }
    } catch {
      /* 等待浏览器就绪 */
    }
    await sleep(100);
  }
  throw new Error("Edge 调试端点未就绪");
}

async function pageTarget(): Promise<Target> {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`);
  const targets = (await response.json()) as Target[];
  const target = targets.find((item) => item.type === "page");
  if (!target) {
    throw new Error("没有可用的页面 target");
  }
  return target;
}

class BenchPage {
  constructor(private readonly cdp: Cdp) {}

  async evaluate<T>(expression: string, awaitPromise = false): Promise<T> {
    const result = (await this.cdp.send("Runtime.evaluate", {
      expression,
      awaitPromise,
      returnByValue: true,
      userGesture: true,
    })) as {
      result: { value?: T };
      exceptionDetails?: { text?: string; exception?: { description?: string } };
    };
    if (result.exceptionDetails) {
      throw new Error(
        result.exceptionDetails.exception?.description ||
          result.exceptionDetails.text ||
          "页面求值失败",
      );
    }
    return result.result.value as T;
  }

  async waitFor(expression: string, timeout = 10000): Promise<void> {
    const started = Date.now();
    while (Date.now() - started < timeout) {
      if (await this.evaluate<boolean>(`Boolean(${expression})`)) {
        return;
      }
      await sleep(50);
    }
    throw new Error(`等待页面条件超时：${expression}`);
  }

  async navigate(): Promise<void> {
    await this.cdp.send("Page.navigate", { url: pathToFileURL(pagePath).href });
    await this.waitFor("document.readyState === 'complete'");
    await this.waitFor("document.querySelector('.pv-app')");
    await this.waitFor(`document.querySelectorAll('.pv-block').length >= ${blockCount}`);
    await this.evaluate("document.fonts.ready.then(() => true)", true);
    await sleep(150);
  }

  async click(selector: string): Promise<void> {
    await this.evaluate(
      `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) throw new Error("missing " + ${JSON.stringify(selector)}); el.click(); })()`,
    );
  }

  async resetView(): Promise<void> {
    await this.click('.pv-seg [data-layout="columns"]');
    await this.waitFor(`document.querySelector(".pv-app").dataset.layout === "columns"`);
    await this.click('.pv-seg [data-mode="bilingual"]');
    await this.waitFor(`document.querySelector(".pv-app").dataset.mode === "bilingual"`);
    await this.evaluate(`(() => { const body = document.querySelector(".pv-body"); body.scrollTop = 0; })()`);
    await sleep(80);
  }

  /** 一次操作耗时 + 期间的长任务。 */
  async measured(action: string): Promise<{ duration: number; longTasks: LongTask[] }> {
    return this.evaluate(
      `(async () => {
        const longStart = window.__bench.longTasks.length;
        const t0 = performance.now();
        ${action}
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        return { duration: performance.now() - t0, longTasks: window.__bench.longTasks.slice(longStart) };
      })()`,
      true,
    );
  }

  async measureLayout(layout: "columns" | "stacked" | "split"): Promise<number> {
    const result = await this.measured(
      `document.querySelector('.pv-seg [data-layout="${layout}"]').click(); await new Promise((resolve) => { const check = () => document.querySelector(".pv-app").dataset.layout === "${layout}" ? resolve() : requestAnimationFrame(check); requestAnimationFrame(check); });`,
    );
    return result.duration;
  }

  async measureMode(mode: "bilingual" | "source" | "target"): Promise<number> {
    const result = await this.measured(
      `document.querySelector('.pv-seg [data-mode="${mode}"]').click();`,
    );
    return result.duration;
  }

  async measureStateUpdate(): Promise<number> {
    const result = await this.measured(`(() => {
      const initial = JSON.parse(document.getElementById("mbs-initial-state").textContent);
      const model = initial.state.model;
      window.postMessage({
        type: "state",
        state: {
          ...initial.state,
          model: {
            ...model,
            counts: { ...model.counts, translated: model.counts.translated + 1 }
          }
        }
      }, "*");
    })()`);
    return result.duration;
  }

  async measureInput(): Promise<InputStats> {
    await this.evaluate(`(() => {
      const blocks = Array.from(document.querySelectorAll(".pv-block"));
      const block = blocks.find((item) =>
        item.querySelector(".pv-kind")?.textContent === "段落" &&
        item.querySelector(".pv-pane-target .pv-md")
      );
      if (!block) throw new Error("找不到可编辑的段落块");
      block.scrollIntoView({ block: "center" });
      block.querySelector(".pv-pane-target .pv-md").click();
    })()`);
    await this.waitFor("document.querySelector('.pv-pane-target .pv-editor textarea')");
    return this.evaluate<InputStats>(
      `(async () => {
        const textarea = document.querySelector(".pv-pane-target .pv-editor textarea");
        textarea.focus();
        const longStart = window.__bench.longTasks.length;
        const t0 = performance.now();
        for (let index = 0; index < 100; index += 1) {
          textarea.value += "字";
          textarea.dispatchEvent(new InputEvent("input", { bubbles: true, data: "字", inputType: "insertText" }));
          // 真实按键发生在独立任务中；让出宏任务，避免 100 次输入被合并成
          // 同一个长任务而误判为单次渲染卡顿。
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
        const dispatchMs = performance.now() - t0;
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        return {
          dispatchMs,
          totalMs: performance.now() - t0,
          characters: textarea.value.length,
          longTasks: window.__bench.longTasks.slice(longStart)
        };
      })()`,
      true,
    );
  }

  async cancelEditing(): Promise<void> {
    await this.evaluate(`(() => {
      const textarea = document.querySelector(".pv-pane-target .pv-editor textarea");
      if (textarea) {
        textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
      }
    })()`);
    await this.waitFor("!document.querySelector('.pv-pane-target .pv-editor textarea')");
    await this.evaluate(`(() => { document.querySelector(".pv-body").scrollTop = 0; })()`);
  }

  async measureScroll(selector: string): Promise<ScrollStats> {
    return this.evaluate<ScrollStats>(
      `(async () => {
        const scroller = document.querySelector(${JSON.stringify(selector)});
        const max = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
        scroller.scrollTop = 0;
        const frames = [];
        let last = performance.now();
        await new Promise((resolve) => {
          let step = 0;
          const tick = (now) => {
            frames.push(now - last);
            last = now;
            step += 1;
            scroller.scrollTop = max * (step / 60);
            if (step < 60) requestAnimationFrame(tick);
            else resolve();
          };
          requestAnimationFrame(tick);
        });
        // 等最后一帧的 scroll 事件与目标侧同步完成，再读取最终位置。
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        frames.shift();
        const sorted = frames.slice().sort((a, b) => a - b);
        const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] || 0;
        const result = {
          frames: frames.length,
          averageFrameMs: frames.reduce((sum, value) => sum + value, 0) / frames.length,
          p95FrameMs: p95,
          maxFrameMs: Math.max(...frames),
          finalScroll: scroller.scrollTop,
          maxScroll: max
        };
        if (${JSON.stringify(selector)} === "[data-split-content=\\"source\\"]") {
          const target = document.querySelector('[data-split-content="target"]');
          result.targetScroll = target.scrollTop;
          result.targetMax = Math.max(0, target.scrollHeight - target.clientHeight);
        }
        return result;
      })()`,
      true,
    );
  }

  async runRate(rate: number): Promise<RateResult> {
    await this.cdp.send("Emulation.setCPUThrottlingRate", { rate });
    await this.resetView();
    const layouts: Record<string, number[]> = { columns: [], stacked: [], split: [] };
    for (let round = 0; round < 2; round += 1) {
      for (const layout of ["stacked", "split", "columns"] as const) {
        layouts[layout].push(await this.measureLayout(layout));
      }
    }
    const modes: Record<string, number[]> = { source: [], target: [], bilingual: [] };
    for (let round = 0; round < 2; round += 1) {
      for (const mode of ["source", "target", "bilingual"] as const) {
        modes[mode].push(await this.measureMode(mode));
      }
    }
    const stateUpdates: number[] = [];
    for (let index = 0; index < 5; index += 1) {
      stateUpdates.push(await this.measureStateUpdate());
    }
    const input = await this.measureInput();
    await this.cancelEditing();
    await this.resetView();
    const scroll = await this.measureScroll(".pv-body");
    await this.measureLayout("split");
    const splitScroll = await this.measureScroll('[data-split-content="source"]');
    await this.resetView();
    const longTasks = await this.evaluate<LongTask[]>("window.__bench.longTasks");
    return {
      layouts,
      modes,
      stateUpdates,
      input,
      scroll,
      splitScroll,
      maxLongTaskMs: Math.max(0, ...longTasks.map((task) => task.duration)),
    };
  }
}

function maxOf(values: number[]): number {
  return Math.max(0, ...values);
}

function p95(values: number[]): number {
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] || 0;
}

function formatMs(value: number): string {
  return `${value.toFixed(1)}ms`;
}

function buildMarkdown(report: PerfReport): string {
  const row = (label: string, one: string, four: string) =>
    `| ${label} | ${one} | ${four} |`;
  return [
    "# Preview performance baseline",
    "",
    `- Generated: ${report.generatedAt}`,
    `- Document: ${report.blocks} top-level blocks (${(report.htmlBytes / 1024).toFixed(1)} KiB HTML)`,
    `- Viewport: ${report.viewport.width}×${report.viewport.height}`,
    `- DOM nodes after mount: ${report.initial.domNodes}`,
    `- Heap after mount: ${report.memory.usedMb.toFixed(1)} MiB`,
    "",
    "## Initial load",
    "",
    `- App mounted: ${formatMs(report.initial.appAtMs)}`,
    `- First block painted: ${formatMs(report.initial.firstBlockAtMs)}`,
    `- DOMContentLoaded: ${formatMs(report.initial.domContentLoadedMs)}`,
    `- Load event: ${formatMs(report.initial.loadEventMs)}`,
    `- First contentful paint: ${report.initial.firstContentfulPaintMs === null ? "n/a" : formatMs(report.initial.firstContentfulPaintMs)}`,
    "",
    "## Interaction baseline",
    "",
    "| Path | 1× CPU | 4× CPU |",
    "| --- | --- | --- |",
    row(
      "Layout switch (max)",
      formatMs(maxOf([...Object.values(report.rate1.layouts)].flat())),
      formatMs(maxOf([...Object.values(report.rate4.layouts)].flat())),
    ),
    row(
      "Mode switch (max)",
      formatMs(maxOf([...Object.values(report.rate1.modes)].flat())),
      formatMs(maxOf([...Object.values(report.rate4.modes)].flat())),
    ),
    row(
      "Host state update (p95/max)",
      `${formatMs(p95(report.rate1.stateUpdates))} / ${formatMs(maxOf(report.rate1.stateUpdates))}`,
      `${formatMs(p95(report.rate4.stateUpdates))} / ${formatMs(maxOf(report.rate4.stateUpdates))}`,
    ),
    row(
      "100 input events (total)",
      formatMs(report.rate1.input.totalMs),
      formatMs(report.rate4.input.totalMs),
    ),
    row(
      "Body scroll frame (p95/max)",
      `${formatMs(report.rate1.scroll.p95FrameMs)} / ${formatMs(report.rate1.scroll.maxFrameMs)}`,
      `${formatMs(report.rate4.scroll.p95FrameMs)} / ${formatMs(report.rate4.scroll.maxFrameMs)}`,
    ),
    row(
      "Split scroll frame (p95/max)",
      `${formatMs(report.rate1.splitScroll.p95FrameMs)} / ${formatMs(report.rate1.splitScroll.maxFrameMs)}`,
      `${formatMs(report.rate4.splitScroll.p95FrameMs)} / ${formatMs(report.rate4.splitScroll.maxFrameMs)}`,
    ),
    row(
      "Split target followed",
      `${Math.round(report.rate1.splitScroll.targetScroll ?? 0)} / ${Math.round(report.rate1.splitScroll.targetMax ?? 0)} px`,
      `${Math.round(report.rate4.splitScroll.targetScroll ?? 0)} / ${Math.round(report.rate4.splitScroll.targetMax ?? 0)} px`,
    ),
    row(
      "Longest long task",
      formatMs(report.rate1.maxLongTaskMs),
      formatMs(report.rate4.maxLongTaskMs),
    ),
    "",
    "## Per-operation (1× CPU)",
    "",
    "| Operation | Runs (ms) |",
    "| --- | --- |",
    ...Object.entries(report.rate1.layouts).map(
      ([layout, values]) => `| Layout: ${layout} | ${values.map(formatMs).join(", ")} |`,
    ),
    ...Object.entries(report.rate1.modes).map(
      ([mode, values]) => `| Mode: ${mode} | ${values.map(formatMs).join(", ")} |`,
    ),
    `| Host state updates | ${report.rate1.stateUpdates.map(formatMs).join(", ")} |`,
    "",
    report.errors.length > 0
      ? `## Errors\n\n${report.errors.map((error) => `- ${error}`).join("\n")}\n`
      : "## Errors\n\nNone.\n",
  ].join("\n");
}

async function main(): Promise<void> {
  const edgePath = findEdge();
  await mkdir(outputDir, { recursive: true });
  const { model, htmlBytes } = await writePerfPage();
  console.log(
    `性能页面：${model.blocks.length} 块，${(htmlBytes / 1024).toFixed(1)} KiB`,
  );

  const browser = await launchEdge(edgePath);
  const target = await pageTarget();
  const cdp = await Cdp.connect(target.webSocketDebuggerUrl);
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Log.enable");
  await cdp.send("Performance.enable");
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: viewport.width,
    height: viewport.height,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
    source: `
      window.__bench = { start: performance.now(), appAt: null, firstBlockAt: null, longTasks: [] };
      try {
        new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            window.__bench.longTasks.push({ start: entry.startTime, duration: entry.duration });
          }
        }).observe({ entryTypes: ["longtask"] });
      } catch {}
      const benchObserver = new MutationObserver(() => {
        if (window.__bench.appAt === null && document.querySelector(".pv-app")) {
          window.__bench.appAt = performance.now();
        }
        if (window.__bench.firstBlockAt === null && document.querySelector(".pv-block")) {
          window.__bench.firstBlockAt = performance.now();
        }
      });
      benchObserver.observe(document, { childList: true, subtree: true });
    `,
  });

  const page = new BenchPage(cdp);
  const errors: string[] = [];
  let report: PerfReport | null = null;
  try {
    await page.navigate();
    const initial = await page.evaluate<{
      appAt: number;
      firstBlockAt: number;
      domNodes: number;
      longTasks: LongTask[];
      nav: PerformanceNavigationTiming;
      fcp: number | null;
    }>(`(() => {
      const nav = performance.getEntriesByType("navigation")[0];
      const paints = performance.getEntriesByType("paint");
      const fcp = paints.find((entry) => entry.name === "first-contentful-paint");
      return {
        appAt: window.__bench.appAt,
        firstBlockAt: window.__bench.firstBlockAt,
        domNodes: document.getElementsByTagName("*").length,
        longTasks: window.__bench.longTasks.slice(),
        nav: { domContentLoadedEventEnd: nav.domContentLoadedEventEnd, loadEventEnd: nav.loadEventEnd },
        fcp: fcp ? fcp.startTime : null
      };
    })()`);
    const metricsBefore = (await cdp.send("Performance.getMetrics")) as {
      metrics: { name: string; value: number }[];
    };
    const heapUsed = metricsBefore.metrics.find((metric) => metric.name === "JSHeapUsedSize")?.value ?? 0;
    const heapTotal = metricsBefore.metrics.find((metric) => metric.name === "JSHeapTotalSize")?.value ?? 0;

    errors.push(...cdp.takeErrors());
    const rate1 = await page.runRate(1);
    errors.push(...cdp.takeErrors());
    const rate4 = await page.runRate(4);
    errors.push(...cdp.takeErrors());
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
    await page.resetView();

    const screenshotFile = "300-blocks.png";
    const capture = (await cdp.send("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: false,
    })) as { data: string };
    await writeFile(
      path.join(outputDir, screenshotFile),
      Buffer.from(capture.data, "base64"),
    );

    report = {
      generatedAt: new Date().toISOString(),
      blocks: model.blocks.length,
      htmlBytes,
      viewport,
      initial: {
        appAtMs: initial.appAt,
        firstBlockAtMs: initial.firstBlockAt,
        domContentLoadedMs: initial.nav.domContentLoadedEventEnd,
        loadEventMs: initial.nav.loadEventEnd,
        firstContentfulPaintMs: initial.fcp,
        longTasks: initial.longTasks,
        domNodes: initial.domNodes,
      },
      memory: { usedMb: heapUsed / 1024 / 1024, totalMb: heapTotal / 1024 / 1024 },
      rate1,
      rate4,
      errors,
      screenshot: screenshotFile,
    };
  } finally {
    cdp.close();
    browser.kill();
    await sleep(300);
    if (browser.pid) {
      spawnSync("taskkill", ["/PID", String(browser.pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
    }
  }

  if (!report) {
    throw new Error("性能报告未生成");
  }

  const budgets: { label: string; actual: number; limit: number }[] = [
    { label: "首屏挂载", actual: report.initial.appAtMs, limit: 2000 },
    { label: "布局切换（1× max）", actual: maxOf([...Object.values(report.rate1.layouts)].flat()), limit: 350 },
    { label: "模式切换（1× max）", actual: maxOf([...Object.values(report.rate1.modes)].flat()), limit: 120 },
    { label: "宿主更新（1× max）", actual: maxOf(report.rate1.stateUpdates), limit: 300 },
    { label: "100 次输入（1×）", actual: report.rate1.input.totalMs, limit: 2000 },
    { label: "正文滚动（1× max frame）", actual: report.rate1.scroll.maxFrameMs, limit: 100 },
    { label: "分栏滚动（1× max frame）", actual: report.rate1.splitScroll.maxFrameMs, limit: 120 },
    { label: "最长长任务（1×）", actual: report.rate1.maxLongTaskMs, limit: 300 },
    { label: "布局切换（4× max）", actual: maxOf([...Object.values(report.rate4.layouts)].flat()), limit: 1500 },
    { label: "模式切换（4× max）", actual: maxOf([...Object.values(report.rate4.modes)].flat()), limit: 600 },
    { label: "宿主更新（4× max）", actual: maxOf(report.rate4.stateUpdates), limit: 500 },
    { label: "100 次输入（4×）", actual: report.rate4.input.totalMs, limit: 6000 },
    { label: "正文滚动（4× max frame）", actual: report.rate4.scroll.maxFrameMs, limit: 260 },
    { label: "最长长任务（4×）", actual: report.rate4.maxLongTaskMs, limit: 1200 },
  ];
  const failures = budgets.filter((budget) => budget.actual > budget.limit);
  if (report.errors.length > 0 || failures.length > 0) {
    errors.push(...failures.map((failure) => `${failure.label} ${formatMs(failure.actual)} > ${failure.limit}ms`));
  }

  await writeFile(
    path.join(outputDir, "report.json"),
    JSON.stringify({ ...report, budgets, failures: errors }, null, 2),
    "utf8",
  );
  await writeFile(
    path.join(outputDir, "report.md"),
    buildMarkdown({ ...report, errors }),
    "utf8",
  );

  console.log(buildMarkdown({ ...report, errors }));
  if (errors.length > 0) {
    throw new Error(`性能预算未通过：\n${errors.join("\n")}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
