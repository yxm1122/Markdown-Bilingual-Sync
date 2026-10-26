/**
 * 标题解析与“标题路径”计算。
 *
 * 职责：从标题块的原始文本中提取级别与纯文本，并为每个块维护它所属的祖先标题链，
 * 作为翻译请求的上下文（`TranslationItem.headingPath`）。
 *
 * 关键不变量：路径只包含祖先标题，不包含块自身；同级或更高级标题出现时栈会回退。
 * 与其他模块的关系：`sync` / `syncService` 在构造翻译任务时调用，纯函数、无副作用。
 */
import type { MarkdownBlock } from "./types";

/** 标题的级别（1-6）与去掉标记后的纯文本。 */
export interface HeadingInfo {
  level: number;
  text: string;
}

const ATX_HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/;
const SETEXT_UNDERLINE = /^ {0,3}(=+|-+)[ \t]*$/;

/**
 * 提取标题块的信息；非标题或无法识别时返回 `null`。
 *
 * 支持 ATX（`## 标题 ##`）与 Setext（标题行 + `===`/`---`）两种写法。ATX 的收尾
 * `#` 只有在前面有空白时才是装饰符，因此不会误删正文里的 `#`。
 */
export function getHeadingInfo(block: MarkdownBlock): HeadingInfo | null {
  if (block.kind !== "heading") {
    return null;
  }
  const lines = block.raw.split("\n");
  const atx = ATX_HEADING.exec(lines[0]);
  if (atx) {
    const text = (atx[2] ?? "").replace(/[ \t]+#+[ \t]*$/, "").trim();
    return { level: atx[1].length, text };
  }
  if (lines.length >= 2) {
    const underline = SETEXT_UNDERLINE.exec(lines[lines.length - 1]);
    if (underline) {
      return {
        level: underline[1][0] === "=" ? 1 : 2,
        text: lines.slice(0, -1).join(" ").trim(),
      };
    }
  }
  return null;
}

/**
 * 为每个块生成其祖先标题路径。
 *
 * 返回的 Map 以块 `index` 为键，所有块都有条目（第一个标题之前为空数组）。用栈维护
 * 当前标题链：遇到标题先弹出层级不低于它的元素（同级或更深），再记录祖先路径，最后
 * 把自身入栈。
 */
export function buildHeadingPaths(
  blocks: readonly MarkdownBlock[],
): Map<number, string[]> {
  const paths = new Map<number, string[]>();
  const stack: HeadingInfo[] = [];
  for (const block of blocks) {
    const heading = getHeadingInfo(block);
    if (heading) {
      while (stack.length > 0 && stack[stack.length - 1].level >= heading.level) {
        stack.pop();
      }
      // 标题自身的路径不包含自身，避免翻译提示里重复出现标题文本。
      paths.set(block.index, stack.map((item) => item.text));
      stack.push(heading);
    } else {
      paths.set(block.index, stack.map((item) => item.text));
    }
  }
  return paths;
}

/**
 * 为每个块生成所属小节标识。
 *
 * 每个标题开启一个新小节，标题本身与后续块共享同一个 id，直到下一个标题出现。
 * 该标识只用于分批时保持“标题 + 正文”不被切断，不参与缓存或提示词。
 * 第一个标题之前的块属于 `section-0`。
 */
export function buildSectionIds(
  blocks: readonly MarkdownBlock[],
): Map<number, string> {
  const sections = new Map<number, string>();
  let counter = 0;
  for (const block of blocks) {
    if (block.kind === "heading") {
      counter += 1;
    }
    sections.set(block.index, `section-${counter}`);
  }
  return sections;
}
