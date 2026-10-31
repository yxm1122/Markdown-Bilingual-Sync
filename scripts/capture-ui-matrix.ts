/**
 * 生产预览截图矩阵：三套主题 × 三种布局 × 三种模式 + 关键交互状态。
 *
 * 运行方式：`npm run ui:matrix`（先由 render-sample 生成静态页面，再启动本脚本）。
 * 使用本机 Edge 的 headless CDP，不依赖 Playwright；输出到 `artifacts/ui-matrix/`：
 * - 每张 PNG；
 * - `manifest.json`（视口、溢出、控制台错误、PNG 尺寸）；
 * - `index.html` 联系表，便于逐张检查；
 * - `report.md` 汇总。
 *
 * 通过条件：每个状态无横向溢出、无运行时异常/console.error、PNG 可解析。
 * 环境变量：`EDGE_PATH` 指定浏览器；`UI_MATRIX_PORT` 指定调试端口。
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import type { StaticTheme } from "./static-themes";
import { STATIC_THEME_NAMES } from "./static-themes";

const projectRoot = process.cwd();
const outputDir = path.join(projectRoot, "artifacts", "ui-matrix");
const profileDir = path.join(projectRoot, "tmp", `edge-matrix-${process.pid}`);
const port = Number(process.env.UI_MATRIX_PORT || 9455);
const viewport = { width: 1440, height: 960 };
const narrowViewport = { width: 900, height: 900 };
const themes: StaticTheme[] = ["dark", "light", "hc"];
const layouts = ["columns", "stacked", "split"] as const;
const modes = ["bilingual", "source", "target"] as const;

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

interface PngSize {
  width: number;
  height: number;
}

interface ShotMetrics {
  viewport: [number, number];
  docScrollWidth: number;
  app: { left: number; top: number; right: number; bottom: number; width: number; height: number };
  dialog: { left: number; top: number; right: number; bottom: number } | null;
  visibleText: number;
  layout: string;
  mode: string;
  readonly: { source: boolean | null; target: boolean | null };
}

interface ShotRecord {
  theme: StaticTheme;
  state: string;
  file: string;
  viewport: [number, number];
  png: PngSize;
  metrics: ShotMetrics;
  errors: string[];
  overflow: boolean;
}

interface ScrollCheckRecord {
  theme: StaticTheme;
  name: string;
  sourceKey: string | null;
  targetKey: string | null;
  targetKeyAfterScroll: string | null;
  sourceKeyAfterReturn: string | null;
  bilingualSourceKey: string | null;
  bilingualTargetKey: string | null;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** 在常见安装位置中找到 Edge；失败时提示设置 EDGE_PATH。 */
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
    throw new Error(
      "找不到 Microsoft Edge；请通过 EDGE_PATH 指定浏览器可执行文件。",
    );
  }
  return found;
}

/** 读取 PNG 的 IHDR 宽高，防止截图为空或尺寸异常。 */
function pngSize(buffer: Buffer): PngSize {
  if (buffer.length < 24 || buffer.toString("ascii", 1, 4) !== "PNG") {
    throw new Error("截图不是有效 PNG");
  }
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
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
      this.collectError(message.method, message.params);
    });
  }

  static async connect(url: string): Promise<Cdp> {
    const WebSocketCtor = (
      globalThis as unknown as { WebSocket: new (url: string) => WebSocketLike }
    ).WebSocket;
    if (!WebSocketCtor) {
      throw new Error("当前 Node 版本缺少全局 WebSocket");
    }
    const socket = new WebSocketCtor(url);
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve());
      socket.addEventListener("error", () =>
        reject(new Error("CDP WebSocket 连接失败")),
      );
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

  close(): void {
    this.socket.close();
  }

  takeErrors(): string[] {
    const errors = this.errors;
    this.errors = [];
    return errors;
  }

  private collectError(method: string | undefined, params: Record<string, unknown> | undefined): void {
    if (method === "Runtime.exceptionThrown") {
      const details = params?.exceptionDetails as
        | { text?: string; exception?: { description?: string } }
        | undefined;
      this.errors.push(
        details?.exception?.description || details?.text || "Uncaught exception",
      );
      return;
    }
    if (method === "Runtime.consoleAPICalled") {
      const type = params?.type;
      if (type !== "error" && type !== "assert") {
        return;
      }
      const args = (params?.args as { value?: unknown; description?: string }[] | undefined) ?? [];
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
      return;
    }
    if (method === "Log.entryAdded") {
      const entry = params?.entry as
        | { level?: string; text?: string; url?: string }
        | undefined;
      if (entry?.level === "error") {
        this.errors.push(`${entry.text || "log error"}${entry.url ? ` (${entry.url})` : ""}`);
      }
    }
  }
}

let browserProcess: ChildProcess | null = null;

async function launchEdge(edgePath: string): Promise<void> {
  await mkdir(profileDir, { recursive: true });
  browserProcess = spawn(
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
          return;
        }
      }
    } catch {
      /* 浏览器还没就绪 */
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

function matrixUrl(theme: StaticTheme): string {
  return pathToFileURL(
    path.join(projectRoot, "tmp", `preview-matrix-${theme}.html`),
  ).href;
}

function emptyUrl(theme: StaticTheme): string {
  return pathToFileURL(
    path.join(projectRoot, "tmp", `preview-empty-${theme}.html`),
  ).href;
}

function quote(value: string): string {
  return JSON.stringify(value);
}

class Page {
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

  async waitFor(expression: string, timeout = 8000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      if (await this.evaluate<boolean>(`Boolean(${expression})`)) {
        return;
      }
      await sleep(60);
    }
    throw new Error(`等待页面条件超时：${expression}`);
  }

  async viewport(width: number, height: number): Promise<void> {
    await this.cdp.send("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await sleep(80);
  }

  async navigate(url: string): Promise<void> {
    await this.cdp.send("Page.navigate", { url });
    await this.waitFor("document.readyState === 'complete'");
    await this.waitFor("document.querySelector('.pv-app')");
    await this.evaluate("document.fonts.ready.then(() => true)", true);
    await sleep(120);
    await this.dismissToasts();
  }

  async click(selector: string): Promise<void> {
    await this.evaluate(
      `(() => { const el = document.querySelector(${quote(selector)}); if (!el) throw new Error("missing " + ${quote(selector)}); el.click(); })()`,
    );
    await sleep(40);
  }

  async dismissToasts(): Promise<void> {
    await this.evaluate(
      `document.querySelectorAll(".toast-close").forEach((button) => button.click())`,
    );
    await sleep(30);
  }

  async shot(theme: StaticTheme, state: string): Promise<ShotRecord> {
    await this.dismissToasts();
    await this.evaluate(
      "new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
      true,
    );
    const errors = this.cdp.takeErrors();
    const metrics = await this.evaluate<ShotMetrics>(`(() => {
      const appEl = document.querySelector(".pv-app");
      const app = appEl.getBoundingClientRect();
      const dialog = document.querySelector("dialog[open]");
      const rect = dialog ? dialog.getBoundingClientRect() : null;
      const pane = (side) => document.querySelector('.pv-split-pane[data-pane="' + side + '"]');
      const readonly = (side) => {
        const node = pane(side);
        return node ? node.classList.contains("is-readonly") : null;
      };
      return {
        viewport: [window.innerWidth, window.innerHeight],
        docScrollWidth: document.documentElement.scrollWidth,
        app: { left: app.left, top: app.top, right: app.right, bottom: app.bottom, width: app.width, height: app.height },
        dialog: rect ? { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom } : null,
        visibleText: (appEl.innerText || "").trim().length,
        layout: appEl.dataset.layout,
        mode: appEl.dataset.mode,
        readonly: { source: readonly("source"), target: readonly("target") },
      };
    })()`);
    const overflow =
      metrics.docScrollWidth > metrics.viewport[0] + 1 ||
      metrics.app.width > metrics.viewport[0] + 1 ||
      metrics.app.left < -1 ||
      metrics.app.right > metrics.viewport[0] + 1 ||
      (metrics.dialog !== null &&
        (metrics.dialog.left < -1 ||
          metrics.dialog.top < -1 ||
          metrics.dialog.right > metrics.viewport[0] + 1 ||
          metrics.dialog.bottom > metrics.viewport[1] + 1));
    const file = `${theme}-${state}.png`;
    const capture = (await this.cdp.send("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: false,
    })) as { data: string };
    const buffer = Buffer.from(capture.data, "base64");
    await writeFile(path.join(outputDir, file), buffer);
    const png = pngSize(buffer);
    const record: ShotRecord = {
      theme,
      state,
      file,
      viewport: metrics.viewport,
      png,
      metrics,
      errors,
      overflow,
    };
    if (errors.length > 0) {
      throw new Error(`${file} 运行时错误：\n${errors.join("\n")}`);
    }
    if (overflow) {
      throw new Error(`${file} 出现横向溢出：${JSON.stringify(metrics)}`);
    }
    if (png.width !== metrics.viewport[0] || png.height !== metrics.viewport[1]) {
      throw new Error(
        `${file} 截图尺寸 ${png.width}x${png.height} 与视口 ${metrics.viewport.join("x")} 不一致`,
      );
    }
    return record;
  }

  async openExportDialog(): Promise<void> {
    await this.evaluate(`(() => {
      const initial = JSON.parse(document.getElementById("mbs-initial-state").textContent);
      window.postMessage({
        type: "state",
        state: initial.state,
        exportConfirmation: {
          destination: "demo.zh-CN.md",
          summary: "共 17 块：已翻译 12，译文锁定 1，原文已更新 1，复制/公式 3",
          warningCount: 0,
          existing: true,
          diff: {
            rows: [
              { kind: "context", left: { lineNumber: 1, text: "# Markdown Bilingual Sync" }, right: { lineNumber: 1, text: "# Markdown Bilingual Sync" }, hidden: 0 },
              { kind: "change", left: { lineNumber: 2, text: "This paragraph was edited after the first sync, so its translation is now stale." }, right: { lineNumber: 2, text: "这一段在上次同步后修改过，因此译文已过期。" }, hidden: 0 },
              { kind: "collapsed", left: null, right: null, hidden: 12 },
              { kind: "change", left: { lineNumber: 15, text: "- Translate only the blocks that changed." }, right: { lineNumber: 15, text: "- 只翻译发生变化的块。" }, hidden: 0 },
              { kind: "change", left: null, right: { lineNumber: 16, text: "- 同步后新增的源文条目。" }, hidden: 0 },
              { kind: "context", left: { lineNumber: 16, text: "| Glossary and export | 就绪 | Global glossary, diff export |" }, right: { lineNumber: 17, text: "| Glossary and export | 就绪 | Global glossary, diff export |" }, hidden: 0 }
            ],
            added: 3,
            removed: 2,
            unchanged: 1,
            coarse: false,
            truncated: 0
          }
        }
      }, "*");
    })()`);
    await this.waitFor("document.querySelector('dialog[open]')");
  }

  async openSourceDialog(): Promise<void> {
    await this.evaluate(`(() => {
      window.postMessage({
        type: "sourceConfirm",
        data: {
          destination: "demo.md",
          count: 2,
          diff: {
            rows: [
              { kind: "context", left: { lineNumber: 1, text: "# Markdown Bilingual Sync" }, right: { lineNumber: 1, text: "# Markdown Bilingual Sync" }, hidden: 0 },
              { kind: "change", left: { lineNumber: 2, text: "This paragraph was edited after the first sync, so its translation is now stale." }, right: { lineNumber: 2, text: "This paragraph was edited after the first sync, so its translation is now stale. (final)" }, hidden: 0 },
              { kind: "change", left: { lineNumber: 15, text: "- Translate only the blocks that changed." }, right: { lineNumber: 15, text: "- Translate only the blocks that changed.\\n- A new source item was added after the sync." }, hidden: 0 }
            ],
            added: 2,
            removed: 0,
            unchanged: 1,
            coarse: false,
            truncated: 0
          }
        }
      }, "*");
    })()`);
    await this.waitFor("document.querySelector('dialog[open]')");
  }

  async closeDialog(): Promise<void> {
    await this.click(".dialog-close");
    await this.waitFor("!document.querySelector('dialog[open]')");
    await this.dismissToasts();
  }

  async editTarget(): Promise<void> {
    await this.click(".pv-block .pv-pane-target .pv-md");
    await this.waitFor("document.querySelector('.pv-editor textarea')");
  }

  async cancelEditing(): Promise<void> {
    await this.evaluate(`(() => {
      const textarea = document.querySelector(".pv-editor textarea");
      textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    })()`);
    await this.waitFor("!document.querySelector('.pv-editor textarea')");
  }

  async openBlockMenu(): Promise<void> {
    await this.evaluate(
      `document.querySelector(".pv-block")?.classList.add("is-demo-hover")`,
    );
    await this.click(".pv-block .pv-block-actions .pv-action");
    await this.waitFor("document.querySelector('.menu')");
  }

  async closeMenu(): Promise<void> {
    await this.evaluate(
      `document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))`,
    );
    await this.waitFor("!document.querySelector('.menu')");
  }

  async setBusy(busy: boolean): Promise<void> {
    await this.evaluate(
      `window.postMessage({ type: "busy", busy: ${busy ? "true" : "false"} }, "*")`,
    );
    await (busy
      ? this.waitFor("document.querySelector('.pv-app.is-busy')")
      : this.waitFor("!document.querySelector('.pv-app.is-busy')"));
  }

  async select(layout: (typeof layouts)[number], mode: (typeof modes)[number]): Promise<void> {
    await this.click(`.pv-seg [data-layout="${layout}"]`);
    await this.waitFor(
      `document.querySelector(".pv-app").dataset.layout === ${quote(layout)}`,
    );
    await this.click(`.pv-seg [data-mode="${mode}"]`);
    await this.waitFor(
      `document.querySelector(".pv-app").dataset.mode === ${quote(mode)}`,
    );
    await this.dismissToasts();
  }

  /** 当前滚动容器顶部第一个可见块的 key。 */
  async firstVisibleKey(side: "source" | "target"): Promise<string | null> {
    return this.evaluate<string | null>(`(() => {
      const pane = document.querySelector('[data-split-content="${side}"]');
      const rect = pane.getBoundingClientRect();
      const cells = Array.from(pane.querySelectorAll(".pv-cell[data-sync-key]"));
      const first = cells.find((cell) => cell.getBoundingClientRect().bottom > rect.top + 1);
      return first ? first.dataset.syncKey : null;
    })()`);
  }

  async scrollSplit(side: "source" | "target", top: number): Promise<void> {
    await this.evaluate(`(() => {
      const pane = document.querySelector('[data-split-content="${side}"]');
      pane.scrollTop = ${top};
      pane.dispatchEvent(new Event("scroll"));
    })()`);
    await sleep(120);
  }

  /** 仅原文/仅译文切换后，另一侧应回到同一块；回到双语后两侧应一致。 */
  async verifySplitScrollSync(theme: StaticTheme): Promise<ScrollCheckRecord> {
    await this.select("split", "bilingual");
    await this.click('.pv-seg [data-mode="source"]');
    await this.waitFor(`document.querySelector(".pv-app").dataset.mode === "source"`);
    await this.scrollSplit("source", 400);
    const sourceKey = await this.firstVisibleKey("source");

    await this.click('.pv-seg [data-mode="target"]');
    await this.waitFor(`document.querySelector(".pv-app").dataset.mode === "target"`);
    const targetKey = await this.firstVisibleKey("target");
    if (!sourceKey || !targetKey || sourceKey !== targetKey) {
      throw new Error(
        `${theme} split scroll: source ${sourceKey} -> target ${targetKey}`,
      );
    }

    await this.scrollSplit("target", 200);
    const targetKeyAfterScroll = await this.firstVisibleKey("target");
    await this.click('.pv-seg [data-mode="source"]');
    await this.waitFor(`document.querySelector(".pv-app").dataset.mode === "source"`);
    const sourceKeyAfterReturn = await this.firstVisibleKey("source");
    if (
      !targetKeyAfterScroll ||
      !sourceKeyAfterReturn ||
      targetKeyAfterScroll !== sourceKeyAfterReturn
    ) {
      throw new Error(
        `${theme} split scroll: target ${targetKeyAfterScroll} -> source ${sourceKeyAfterReturn}`,
      );
    }

    await this.click('.pv-seg [data-mode="bilingual"]');
    await this.waitFor(`document.querySelector(".pv-app").dataset.mode === "bilingual"`);
    await sleep(120);
    const bilingualSourceKey = await this.firstVisibleKey("source");
    const bilingualTargetKey = await this.firstVisibleKey("target");
    if (
      !bilingualSourceKey ||
      !bilingualTargetKey ||
      bilingualSourceKey !== sourceKeyAfterReturn ||
      bilingualTargetKey !== sourceKeyAfterReturn
    ) {
      throw new Error(
        `${theme} split scroll: bilingual ${bilingualSourceKey}/${bilingualTargetKey} expected ${sourceKeyAfterReturn}`,
      );
    }
    await this.select("split", "bilingual");
    return {
      theme,
      name: "split-scroll-carryover",
      sourceKey,
      targetKey,
      targetKeyAfterScroll,
      sourceKeyAfterReturn,
      bilingualSourceKey,
      bilingualTargetKey,
    };
  }
}

/** 联系表：按主题分组展示截图，附检查结果。 */
function contactSheet(records: ShotRecord[]): string {
  const sections = themes
    .map((theme) => {
      const shots = records.filter((record) => record.theme === theme);
      const cards = shots
        .map(
          (shot) => `<figure>
  <a href="${shot.file}"><img src="${shot.file}" alt="${theme} ${shot.state}" loading="lazy"></a>
  <figcaption><strong>${shot.state}</strong><span>${shot.png.width}×${shot.png.height}</span></figcaption>
</figure>`,
        )
        .join("\n");
      return `<section>
<h2>${STATIC_THEME_NAMES[theme]} <small>${shots.length} 张</small></h2>
<div class="grid">${cards}</div>
</section>`;
    })
    .join("\n");
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<title>Native preview UI matrix</title>
<style>
  body { margin: 0; padding: 24px; background: #1e1e1e; color: #ccc; font: 13px/1.5 "Segoe UI", "Microsoft YaHei UI", sans-serif; }
  h1 { margin: 0 0 4px; font-size: 20px; color: #fff; }
  h2 { margin: 28px 0 12px; font-size: 15px; color: #fff; }
  h2 small { color: #9d9d9d; font-weight: 400; }
  .meta { color: #9d9d9d; margin-bottom: 8px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(420px, 1fr)); gap: 14px; }
  figure { margin: 0; background: #252526; border: 1px solid #3c3c3c; border-radius: 3px; overflow: hidden; }
  figure img { display: block; width: 100%; height: auto; }
  figcaption { display: flex; justify-content: space-between; gap: 8px; padding: 6px 9px; color: #ccc; }
  figcaption span { color: #9d9d9d; font-variant-numeric: tabular-nums; }
</style>
</head>
<body>
<h1>Native preview UI matrix</h1>
<p class="meta">${records.length} 张截图 · 三主题 × 三布局 × 三模式 + 关键状态 · ${new Date().toISOString()}</p>
${sections}
</body>
</html>`;
}

/** Markdown 汇总，方便在 docs/PR 里引用。 */
function report(
  records: ShotRecord[],
  durationMs: number,
  scrollChecks: ScrollCheckRecord[],
): string {
  const lines = [
    "# Native preview UI matrix",
    "",
    `- Generated: ${new Date().toISOString()}`,
    `- Screenshots: ${records.length}`,
    `- Split scroll carryover checks: ${scrollChecks.length} passed`,
    `- Duration: ${(durationMs / 1000).toFixed(1)}s`,
    `- Themes: ${themes.map((theme) => STATIC_THEME_NAMES[theme]).join(", ")}`,
    `- Layouts: ${layouts.join(", ")}`,
    `- Modes: ${modes.join(", ")}`,
    `- Horizontal overflow: ${records.filter((record) => record.overflow).length}`,
    `- Console/runtime errors: ${records.filter((record) => record.errors.length > 0).length}`,
    "",
    "## Per theme",
    "",
    "| Theme | Screenshots | Overflow | Errors |",
    "| --- | --- | --- | --- |",
    ...themes.map((theme) => {
      const shots = records.filter((record) => record.theme === theme);
      return `| ${STATIC_THEME_NAMES[theme]} | ${shots.length} | ${shots.filter((record) => record.overflow).length} | ${shots.filter((record) => record.errors.length > 0).length} |`;
    }),
    "",
    "## Files",
    "",
    ...records.map(
      (record) =>
        `- [${record.theme}/${record.state}](${record.file}) — ${record.png.width}×${record.png.height}`,
    ),
    "",
  ];
  return lines.join("\n");
}

async function main(): Promise<void> {
  const started = Date.now();
  const edgePath = findEdge();
  await mkdir(outputDir, { recursive: true });

  console.log(`Edge: ${edgePath}`);
  console.log(`Output: ${outputDir}`);
  await launchEdge(edgePath);

  const target = await pageTarget();
  const cdp = await Cdp.connect(target.webSocketDebuggerUrl);
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Log.enable");
  const page = new Page(cdp);
  const records: ShotRecord[] = [];
  const scrollChecks: ScrollCheckRecord[] = [];

  try {
    for (const theme of themes) {
      console.log(`\n[${STATIC_THEME_NAMES[theme]}]`);
      await page.viewport(viewport.width, viewport.height);
      await page.navigate(matrixUrl(theme));

      for (const layout of layouts) {
        for (const mode of modes) {
          await page.select(layout, mode);
          const record = await page.shot(theme, `${layout}-${mode}`);
          records.push(record);
          console.log(`  ✓ ${record.file}`);
        }
      }

      await page.select("columns", "bilingual");

      await page.click(".pv-summary-toggle");
      await page.waitFor("document.querySelector('.pv-summary.is-open')");
      records.push(await page.shot(theme, "summary"));
      console.log("  ✓ summary");
      await page.click(".pv-brief-toggle");
      await page.waitFor("document.querySelector('.pv-brief.is-open')");
      records.push(await page.shot(theme, "brief"));
      console.log("  ✓ brief");
      await page.click(".pv-brief-toggle");
      await page.waitFor("!document.querySelector('.pv-brief.is-open')");
      await page.click(".pv-glossary-section .pv-brief-toggle");
      await page.waitFor("document.querySelector('.pv-glossary-section.is-open')");
      records.push(await page.shot(theme, "glossary"));
      console.log("  ✓ glossary");
      await page.click(".pv-term-card .pv-term-side.pv-term-source");
      await page.waitFor("document.querySelector('.pv-term-card.is-editing')");
      records.push(await page.shot(theme, "glossary-edit"));
      console.log("  ✓ glossary-edit");
      await page.click(".pv-glossary-section .pv-brief-toggle");
      await page.waitFor("!document.querySelector('.pv-glossary-section.is-open')");
      await page.click(".pv-summary-toggle");
      await page.waitFor("!document.querySelector('.pv-summary.is-open')");

      await page.click(".pv-annotation-badge");
      await page.waitFor("document.querySelector('.pv-annotations')");
      await page.click(".pv-annotation-details summary");
      records.push(await page.shot(theme, "annotations"));
      console.log("  ✓ annotations");
      await page.click(".pv-annotations-head .pv-action");
      await page.waitFor("!document.querySelector('.pv-annotations')");

      await page.openExportDialog();
      records.push(await page.shot(theme, "export-dialog"));
      console.log("  ✓ export-dialog");
      await page.closeDialog();

      await page.openSourceDialog();
      records.push(await page.shot(theme, "source-dialog"));
      console.log("  ✓ source-dialog");
      await page.closeDialog();

      await page.editTarget();
      records.push(await page.shot(theme, "editing"));
      console.log("  ✓ editing");
      await page.cancelEditing();

      await page.openBlockMenu();
      records.push(await page.shot(theme, "block-menu"));
      console.log("  ✓ block-menu");
      await page.closeMenu();

      await page.click(".pv-toolbar-actions .pv-icon-button");
      await page.waitFor("document.querySelector('.pv-selection-bar')");
      await page.click(".pv-block");
      records.push(await page.shot(theme, "selection"));
      console.log("  ✓ selection");
      await page.click(".pv-selection-tools .pv-icon-button");
      await page.waitFor("!document.querySelector('.pv-selection-bar')");

      await page.evaluate(
        "window.postMessage({ type: 'taskActivity', running: 1, queued: 2 }, '*')",
      );
      await page.waitFor("document.querySelector('.pv-task-activity')");
      records.push(await page.shot(theme, "task-activity"));
      console.log("  ✓ task-activity");
      await page.evaluate(
        "window.postMessage({ type: 'taskActivity', running: 0, queued: 0 }, '*')",
      );
      await page.waitFor("!document.querySelector('.pv-task-activity')");

      await page.select("split", "bilingual");
      await page.click('.pv-split-pane[data-pane="target"] .pv-pane-mode');
      await page.waitFor(
        `document.querySelector('.pv-split-pane[data-pane="target"]').classList.contains("is-readonly")`,
      );
      records.push(await page.shot(theme, "split-readonly"));
      console.log("  ✓ split-readonly");
      await page.click('.pv-split-pane[data-pane="target"] .pv-pane-mode');
      await page.waitFor(
        `!document.querySelector('.pv-split-pane[data-pane="target"]').classList.contains("is-readonly")`,
      );
      await page.dismissToasts();

      scrollChecks.push(await page.verifySplitScrollSync(theme));
      console.log("  ✓ split-scroll-carryover");

      await page.setBusy(true);
      records.push(await page.shot(theme, "busy"));
      console.log("  ✓ busy");
      await page.setBusy(false);

      await page.select("columns", "bilingual");
      await page.viewport(narrowViewport.width, narrowViewport.height);
      records.push(await page.shot(theme, "narrow"));
      console.log("  ✓ narrow");
      await page.viewport(viewport.width, viewport.height);

      await page.navigate(emptyUrl(theme));
      records.push(await page.shot(theme, "empty"));
      console.log("  ✓ empty");
    }
  } finally {
    cdp.close();
  }

  await writeFile(
    path.join(outputDir, "manifest.json"),
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        durationMs: Date.now() - started,
        edge: edgePath,
        records,
        scrollChecks,
      },
      null,
      2,
    ),
    "utf8",
  );
  await writeFile(path.join(outputDir, "index.html"), contactSheet(records), "utf8");
  await writeFile(
    path.join(outputDir, "report.md"),
    report(records, Date.now() - started, scrollChecks),
    "utf8",
  );
  console.log(
    `\n完成：${records.length} 张截图，0 溢出，0 运行时错误。` +
      `\n联系表：${path.join(outputDir, "index.html")}`,
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    browserProcess?.kill();
    await sleep(400);
    if (browserProcess?.pid) {
      spawnSync("taskkill", ["/PID", String(browserProcess.pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
    }
    try {
      await rm(profileDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      /* 浏览器进程可能仍占用 profile；不影响截图结果 */
    }
  });
