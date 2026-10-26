/**
 * 受保护 Markdown 片段的识别与还原（Node / 扩展主进程）。
 *
 * 模型偶尔会把行内代码当作普通正文翻译，或改写脚注定义的标签。这两类内容一旦
 * 变化就会破坏代码语义或脚注链接，因此这里提供确定性的兜底还原：
 *
 * - 行内代码按 CommonMark 的反引号分隔规则识别；只有源文与译文都能完整配对、
 *   片段均不跨行且数量一致时才按顺序还原，避免误改模型新增或删除的代码片段；
 * - 脚注定义只还原 `[^id]:` 标签，不触碰其后的译文正文。
 *
 * 纯函数，不依赖 vscode / DOM，可供同步层、回译和评估脚本复用。
 */

/** 一个完整的行内代码片段；`start` / `end` 为原文下标（`end` 不含）。 */
export interface InlineCodeSpan {
  start: number;
  end: number;
  /** 含分隔反引号的原始片段。 */
  raw: string;
}

/**
 * 按 CommonMark 规则扫描行内代码片段。
 *
 * 开始分隔符由 N 个连续反引号组成，必须由同样数量的反引号闭合；反斜杠在代码片段内
 * 没有转义含义。未闭合的反引号串按普通文本忽略，扫描继续向后寻找可配对的串。
 */
export function findInlineCodeSpans(text: string): InlineCodeSpan[] {
  const spans: InlineCodeSpan[] = [];
  let index = 0;
  while (index < text.length) {
    const open = text.indexOf("`", index);
    if (open < 0) {
      break;
    }
    let run = 1;
    while (text[open + run] === "`") {
      run += 1;
    }
    const contentStart = open + run;
    let cursor = contentStart;
    let close = -1;
    while (cursor < text.length) {
      const next = text.indexOf("`", cursor);
      if (next < 0) {
        break;
      }
      let closeRun = 1;
      while (text[next + closeRun] === "`") {
        closeRun += 1;
      }
      if (closeRun === run) {
        close = next;
        break;
      }
      cursor = next + closeRun;
    }
    if (close < 0) {
      index = contentStart;
      continue;
    }
    spans.push({
      start: open,
      end: close + run,
      raw: text.slice(open, close + run),
    });
    index = close + run;
  }
  return spans;
}

/**
 * 还原译文中被改写的行内代码。
 *
 * 保守策略：源文与译文都必须有片段、片段数量一致、每对片段的分隔符长度一致，且
 * 全部片段不跨行；满足条件时按出现顺序把译文的代码片段替换回源文片段。任一片段
 * 跨行（常见于转义反引号造成的误配对）、数量不同或分隔符风格改变则原样返回，避免
 * 把正文拼接错位。
 */
export function restoreInlineCode(source: string, translated: string): string {
  const sourceSpans = findInlineCodeSpans(source);
  if (
    sourceSpans.length === 0 ||
    sourceSpans.some((span) => span.raw.includes("\n"))
  ) {
    return translated;
  }
  const translatedSpans = findInlineCodeSpans(translated);
  if (
    translatedSpans.length !== sourceSpans.length ||
    translatedSpans.some((span) => span.raw.includes("\n")) ||
    translatedSpans.some(
      (span, index) =>
        /^`+/.exec(span.raw)?.[0].length !==
        /^`+/.exec(sourceSpans[index].raw)?.[0].length,
    )
  ) {
    return translated;
  }
  let result = translated;
  for (let index = sourceSpans.length - 1; index >= 0; index -= 1) {
    const target = translatedSpans[index];
    const origin = sourceSpans[index];
    if (target.raw === origin.raw) {
      continue;
    }
    result =
      result.slice(0, target.start) + origin.raw + result.slice(target.end);
  }
  return result;
}

/** 匹配任意 Alert 标记（包括模型翻译后的本地化标记），用于按位置还原。 */
const ANY_ALERT_MARKER = /\[![^\]\n]+\]/g;

/** 找到文本中的全部 Alert 标记及其下标。纯函数。 */
function findAlertMarkers(
  text: string,
): Array<{ start: number; end: number; raw: string }> {
  return [...text.matchAll(ANY_ALERT_MARKER)].map((match) => ({
    start: match.index,
    end: match.index + match[0].length,
    raw: match[0],
  }));
}

/**
 * 还原被翻译的 GitHub Alert 标记（如 `[!WARNING]` -> `[!警告]`）。
 *
 * 只有源文与译文的标记数量一致时才按出现顺序替换，避免误改正文中的普通链接。
 */
export function restoreAlertMarkers(
  source: string,
  translated: string,
): string {
  const sourceMarkers = findAlertMarkers(source);
  if (sourceMarkers.length === 0) {
    return translated;
  }
  const translatedMarkers = findAlertMarkers(translated);
  if (translatedMarkers.length !== sourceMarkers.length) {
    return translated;
  }
  let result = translated;
  for (let index = sourceMarkers.length - 1; index >= 0; index -= 1) {
    const target = translatedMarkers[index];
    const origin = sourceMarkers[index];
    if (target.raw === origin.raw) {
      continue;
    }
    result =
      result.slice(0, target.start) + origin.raw + result.slice(target.end);
  }
  return result;
}

/** 匹配行首的脚注定义标签（多行模式，用于连续定义合成的块）。 */
const FOOTNOTE_LABEL_LINE = /^ {0,3}\[\^[^\]\n]+\]:/gm;

/** 找到文本中所有行首脚注标签及其下标。纯函数。 */
function findFootnoteLabels(
  text: string,
): Array<{ start: number; end: number; raw: string }> {
  return [...text.matchAll(FOOTNOTE_LABEL_LINE)].map((match) => ({
    start: match.index,
    end: match.index + match[0].length,
    raw: match[0],
  }));
}

/**
 * 还原脚注定义标签。
 *
 * 支持一个块内包含多个连续脚注定义：标签数量一致时按行位置替换；
 * 只有一个源标签且译文完全丢失标签时在开头补回。标签后的正文保持不变。
 */
export function restoreFootnoteLabel(source: string, translated: string): string {
  const sourceLabels = findFootnoteLabels(source);
  if (sourceLabels.length === 0) {
    return translated;
  }
  const targetLabels = findFootnoteLabels(translated);
  if (sourceLabels.length === targetLabels.length) {
    let result = translated;
    for (let index = sourceLabels.length - 1; index >= 0; index -= 1) {
      const target = targetLabels[index];
      const origin = sourceLabels[index];
      if (target.raw === origin.raw) {
        continue;
      }
      result =
        result.slice(0, target.start) + origin.raw + result.slice(target.end);
    }
    return result;
  }
  if (sourceLabels.length === 1 && targetLabels.length === 0) {
    return `${sourceLabels[0].raw} ${translated.trimStart()}`;
  }
  return translated;
}

/**
 * 对模型输出做受保护语法兜底还原。
 *
 * @param source 该块的源文（或回译时的输入文本）。
 * @param translated 模型返回的译文。
 * @param kind 原始块类型；脚注块会额外校验 `[^id]:` 标签。
 * @returns 还原后的译文；无适用片段时返回原值。
 */
export function restoreProtectedSyntax(
  source: string,
  translated: string,
  kind?: string,
): string {
  let result = restoreAlertMarkers(source, translated);
  if (kind === "footnote") {
    result = restoreFootnoteLabel(source, result);
  }
  return restoreInlineCode(source, result);
}
