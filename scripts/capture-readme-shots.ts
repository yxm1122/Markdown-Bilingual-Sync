/**
 * 生成 README 宣传截图（深色、2x、英文界面）。
 *
 * 输入：render-readme-preview.ts 生成的 tmp/readme-*.html。
 * 输出：docs/assets/readme/{hero,lock-editing,brief,glossary,annotations,selection}.png。
 *
 * 使用本机 Edge headless + CDP；2x 截图后由 ffmpeg 缩放到 1800px 宽并压缩。
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

const projectRoot = process.cwd();
const outputDir = path.join(projectRoot, "docs", "assets", "readme");
const rawDir = path.join(projectRoot, "tmp", "readme-shots");
const profileDir = path.join(projectRoot, "tmp", `edge-readme-${process.pid}`);
const port = 9461;
const viewport = { width: 1440, height: 960 };

interface WebSocketLike {
  addEventListener(
    type: "open" | "error" | "close" | "message",
    listener: (event: { data?: unknown }) => void,
  ): void;
  send(data: string): void;
  close(): void;
}

interface Target {
  type: string;
  webSocketDebuggerUrl: string;
}

interface PngSize {
  width: number;
  height: number;
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
    throw new Error("找不到 Microsoft Edge；请通过 EDGE_PATH 指定浏览器可执行文件。");
  }
  return found;
}

function pngSize(buffer: Buffer): PngSize {
  if (buffer.length < 24 || buffer.toString("ascii", 1, 4) !== "PNG") {
    throw new Error("截图不是有效 PNG");
  }
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
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
      socket.addEventListener("error", () => reject(new Error("CDP WebSocket 连接失败")));
    });
    return new Cdp(socket);
  }

  send(
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> {
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

  private collectError(
    method: string | undefined,
    params: Record<string, unknown> | undefined,
  ): void {
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
        this.errors.push(
          `${entry.text || "log error"}${entry.url ? ` (${entry.url})` : ""}`,
        );
      }
    }
  }
}

const quote = (value: string) => JSON.stringify(value);

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

  async navigate(file: string): Promise<void> {
    await this.cdp.send("Page.navigate", {
      url: pathToFileURL(path.join(projectRoot, "tmp", file)).href,
    });
    await this.waitFor("document.readyState === 'complete'");
    await this.waitFor("document.querySelector('.pv-app')");
    await this.evaluate("document.fonts.ready.then(() => true)", true);
    await sleep(150);
    await this.dismissToasts();
  }

  async viewport(width: number, height: number, scale = 1): Promise<void> {
    await this.cdp.send("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor: scale,
      mobile: false,
    });
    await sleep(100);
  }

  async click(selector: string): Promise<void> {
    await this.evaluate(
      `(() => { const el = document.querySelector(${quote(selector)}); if (!el) throw new Error("missing " + ${quote(selector)}); el.click(); })()`,
    );
    await sleep(60);
  }

  async dismissToasts(): Promise<void> {
    await this.evaluate(
      `document.querySelectorAll(".toast-close").forEach((button) => button.click())`,
    );
    await sleep(40);
  }

  /** 截图前裁出圆角，避免深色矩形在浅色页面上显得生硬。 */
  async roundCorners(): Promise<void> {
    await this.evaluate(`(() => {
      document.documentElement.style.background = "transparent";
      document.body.style.background = "transparent";
      const app = document.querySelector(".pv-app");
      if (app) {
        app.style.borderRadius = "12px";
        app.style.overflow = "hidden";
        app.style.border = "1px solid rgba(255,255,255,0.08)";
        app.style.boxSizing = "border-box";
      }
    })()`);
    await sleep(80);
  }

  async capture(name: string): Promise<{ raw: string; size: PngSize }> {
    await this.dismissToasts();
    await this.evaluate(
      "new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
      true,
    );
    const capture = (await this.cdp.send("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: false,
      fromSurface: true,
    })) as { data: string };
    const buffer = Buffer.from(capture.data, "base64");
    const raw = path.join(rawDir, `${name}.png`);
    await writeFile(raw, buffer);
    const errors = this.cdp.takeErrors();
    if (errors.length > 0) {
      throw new Error(`${name} 运行时错误：\n${errors.join("\n")}`);
    }
    return { raw, size: pngSize(buffer) };
  }

  /**
   * 找到包含指定文本的块，滚动到块中部并点击译文区域打开内联编辑器。
   */
  async editBlockContaining(text: string): Promise<void> {
    await this.evaluate(`(() => {
      const blocks = Array.from(document.querySelectorAll(".pv-block"));
      const block = blocks.find((node) => (node.textContent || "").includes(${quote(text)}));
      if (!block) throw new Error("missing block: " + ${quote(text)});
      block.scrollIntoView({ block: "center" });
    })()`);
    await sleep(250);
    await this.evaluate(`(() => {
      const blocks = Array.from(document.querySelectorAll(".pv-block"));
      const block = blocks.find((node) => (node.textContent || "").includes(${quote(text)}));
      const target = block?.querySelector(".pv-pane-target .pv-md");
      if (!target) throw new Error("missing target editor: " + ${quote(text)});
      target.click();
    })()`);
    await this.waitFor("document.querySelector('.pv-editor textarea')");
    await sleep(200);
  }

  async selectBlocks(count: number): Promise<void> {
    await this.click(".pv-toolbar-actions .pv-icon-button");
    await this.waitFor("document.querySelector('.pv-selection-bar')");
    await this.evaluate(`(() => {
      const blocks = Array.from(document.querySelectorAll(".pv-block")).slice(0, ${count});
      for (const block of blocks) block.click();
      window.scrollTo({ top: 0 });
    })()`);
    await sleep(250);
    await this.waitFor(`document.querySelectorAll('.pv-block.is-selected').length >= ${count}`);
  }
}

function downscale(raw: string, output: string): void {
  const result = spawnSync(
    "ffmpeg",
    [
      "-y",
      "-loglevel",
      "error",
      "-i",
      raw,
      "-vf",
      "scale=1800:-1:flags=lanczos",
      "-frames:v",
      "1",
      "-compression_level",
      "9",
      output,
    ],
    { stdio: "inherit", windowsHide: true },
  );
  if (result.status !== 0) {
    throw new Error(`ffmpeg 缩放失败：${output}`);
  }
}

async function main(): Promise<void> {
  const edgePath = findEdge();
  await mkdir(outputDir, { recursive: true });
  await mkdir(rawDir, { recursive: true });
  await launchEdge(edgePath);
  const target = await pageTarget();
  const cdp = await Cdp.connect(target.webSocketDebuggerUrl);
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Log.enable");
  const page = new Page(cdp);
  await page.viewport(viewport.width, viewport.height, 2);

  const shots: Array<{ name: string; file: string; raw: string; width: number; height: number }> = [];

  try {
    await page.navigate("readme-hero.html");
    await page.roundCorners();
    let shot = await page.capture("hero");
    shots.push({ name: "hero", file: "hero.png", raw: shot.raw, ...shot.size });

    await page.navigate("readme-edit.html");
    await page.roundCorners();
    await page.editBlockContaining("A sandbox account");
    shot = await page.capture("lock-editing");
    shots.push({ name: "lock-editing", file: "lock-editing.png", raw: shot.raw, ...shot.size });

    await page.navigate("readme-brief.html");
    await page.roundCorners();
    await page.click(".pv-summary-toggle");
    await page.waitFor("document.querySelector('.pv-summary.is-open')");
    await page.click(".pv-brief-toggle");
    await page.waitFor("document.querySelector('.pv-brief.is-open')");
    await page.evaluate("document.querySelector('.pv-brief')?.scrollIntoView({ block: 'start' })");
    await sleep(200);
    shot = await page.capture("brief");
    shots.push({ name: "brief", file: "brief.png", raw: shot.raw, ...shot.size });

    await page.navigate("readme-brief.html");
    await page.roundCorners();
    await page.click(".pv-summary-toggle");
    await page.waitFor("document.querySelector('.pv-summary.is-open')");
    await page.click(".pv-glossary-section .pv-brief-toggle");
    await page.waitFor("document.querySelector('.pv-glossary-section.is-open')");
    await page.evaluate("document.querySelector('.pv-glossary-section')?.scrollIntoView({ block: 'start' })");
    await sleep(200);
    shot = await page.capture("glossary");
    shots.push({ name: "glossary", file: "glossary.png", raw: shot.raw, ...shot.size });

    await page.navigate("readme-annotations.html");
    await page.roundCorners();
    await page.click(".pv-annotation-badge");
    await page.waitFor("document.querySelector('.pv-annotations')");
    await page.click(".pv-annotation-details summary");
    await sleep(200);
    shot = await page.capture("annotations");
    shots.push({ name: "annotations", file: "annotations.png", raw: shot.raw, ...shot.size });

    await page.navigate("readme-selection.html");
    await page.roundCorners();
    await page.selectBlocks(3);
    shot = await page.capture("selection");
    shots.push({ name: "selection", file: "selection.png", raw: shot.raw, ...shot.size });

    for (const item of shots) {
      downscale(item.raw, path.join(outputDir, item.file));
      console.log(`✓ ${item.file} (${item.width}×${item.height} raw)`);
    }
  } finally {
    cdp.close();
  }
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
