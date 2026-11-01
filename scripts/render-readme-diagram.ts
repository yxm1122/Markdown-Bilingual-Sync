/**
 * 把 README 的块状态 SVG 渲染为 PNG。
 *
 * README 使用 PNG 是为了兼容 Marketplace 的图片处理；SVG 保留为可编辑源文件。
 * 输出：docs/assets/readme/block-states.png（2400×1350）。
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm } from "node:fs/promises";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

const projectRoot = process.cwd();
const svgPath = path.join(projectRoot, "docs", "assets", "readme", "block-states.svg");
const outputPath = path.join(projectRoot, "docs", "assets", "readme", "block-states.png");
const rawPath = path.join(projectRoot, "tmp", "block-states@2x.png");
const profileDir = path.join(projectRoot, "tmp", `edge-readme-diagram-${process.pid}`);

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

function pngSize(buffer: Buffer): { width: number; height: number } {
  if (buffer.length < 24 || buffer.toString("ascii", 1, 4) !== "PNG") {
    throw new Error("PNG 输出无效");
  }
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

async function main(): Promise<void> {
  const edgePath = findEdge();
  await mkdir(path.dirname(rawPath), { recursive: true });
  const render = spawnSync(
    edgePath,
    [
      "--headless=new",
      "--disable-gpu",
      "--hide-scrollbars",
      "--force-device-scale-factor=2",
      "--window-size=1600,900",
      "--default-background-color=00000000",
      `--user-data-dir=${profileDir}`,
      `--screenshot=${rawPath}`,
      pathToFileURL(svgPath).href,
    ],
    { stdio: "ignore", windowsHide: true },
  );
  if (render.status !== 0 || !existsSync(rawPath)) {
    throw new Error("Edge 渲染 SVG 失败");
  }
  const raw = await readFile(rawPath);
  const rawSize = pngSize(raw);
  if (rawSize.width !== 3200 || rawSize.height !== 1800) {
    throw new Error(`SVG 截图尺寸异常：${rawSize.width}×${rawSize.height}`);
  }

  const resize = spawnSync(
    "ffmpeg",
    [
      "-y",
      "-loglevel",
      "error",
      "-i",
      rawPath,
      "-vf",
      "scale=2400:-1:flags=lanczos",
      "-frames:v",
      "1",
      "-compression_level",
      "9",
      outputPath,
    ],
    { stdio: "inherit", windowsHide: true },
  );
  if (resize.status !== 0) {
    throw new Error("ffmpeg 缩放状态图失败");
  }
  const output = await readFile(outputPath);
  const size = pngSize(output);
  if (size.width !== 2400 || size.height !== 1350) {
    throw new Error(`状态图输出尺寸异常：${size.width}×${size.height}`);
  }
  console.log(`✓ block-states.png (${size.width}×${size.height})`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      await rm(profileDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      /* Edge 可能仍占用 profile；不影响输出 */
    }
  });
