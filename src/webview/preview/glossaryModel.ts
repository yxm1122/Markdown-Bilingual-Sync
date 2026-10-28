/**
 * 预览术语表的纯数据模型。
 *
 * 表格与批量编辑共用同一条 `source => target` 文本协议，避免 Webview 与宿主出现
 * 两套解析规则。空行/`#` 注释行忽略；` => ` 空行作为“正在编辑的新行”保留。
 */

export const GLOSSARY_MAX_TERM_LENGTH = 200;
export const GLOSSARY_MAX_ENTRIES = 200;

export interface GlossaryRow {
  source: string;
  target: string;
}

export interface ParsedGlossaryRows {
  rows: GlossaryRow[];
  /** 批量文本中缺少 `=>` 的行号（1 基）。 */
  invalidLines: number[];
}

/** 解析术语表文本；保留只有 `=>` 的空行，供表格编辑。 */
export function parseGlossaryRows(text: string): ParsedGlossaryRows {
  const rows: GlossaryRow[] = [];
  const invalidLines: number[] = [];
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const separator = line.indexOf("=>");
    if (separator < 0) {
      invalidLines.push(index + 1);
      continue;
    }
    rows.push({
      source: line.slice(0, separator).trim(),
      target: line.slice(separator + 2).trim(),
    });
  }
  return { rows, invalidLines };
}

/** 序列化为 `source => target` 文本；dropEmpty 用于保存前去掉未填写的新行。 */
export function serializeGlossaryRows(
  rows: readonly GlossaryRow[],
  dropEmpty = false,
): string {
  return rows
    .filter((row) => !dropEmpty || row.source.trim() || row.target.trim())
    .map((row) => `${row.source.trim()} => ${row.target.trim()}`)
    .join("\n");
}

export interface GlossaryValidation {
  /** 只填一边、字段为空或超长的行（0 基）。 */
  invalidRows: Set<number>;
  /** source 重复的行（0 基）；保存时后一条生效。 */
  duplicateRows: Set<number>;
  /** 有实际内容的行数。 */
  count: number;
  tooMany: boolean;
  hasErrors: boolean;
}

/** 校验表格行；空占位行不算错误，也不计入条数。 */
export function validateGlossaryRows(
  rows: readonly GlossaryRow[],
): GlossaryValidation {
  const invalidRows = new Set<number>();
  const bySource = new Map<string, number[]>();
  let count = 0;
  rows.forEach((row, index) => {
    const source = row.source.trim();
    const target = row.target.trim();
    if (!source && !target) {
      return;
    }
    count += 1;
    if (
      !source ||
      !target ||
      source.length > GLOSSARY_MAX_TERM_LENGTH ||
      target.length > GLOSSARY_MAX_TERM_LENGTH
    ) {
      invalidRows.add(index);
    }
    if (source) {
      const key = source.toLowerCase();
      const indexes = bySource.get(key);
      if (indexes) {
        indexes.push(index);
      } else {
        bySource.set(key, [index]);
      }
    }
  });
  const duplicateRows = new Set<number>();
  for (const indexes of bySource.values()) {
    if (indexes.length > 1) {
      indexes.forEach((index) => duplicateRows.add(index));
    }
  }
  const tooMany = count > GLOSSARY_MAX_ENTRIES;
  return {
    invalidRows,
    duplicateRows,
    count,
    tooMany,
    hasErrors: invalidRows.size > 0 || tooMany,
  };
}

/** 去掉未填写的新行，返回可发送给宿主的文本。 */
export function cleanGlossaryText(text: string): string {
  return serializeGlossaryRows(parseGlossaryRows(text).rows, true);
}

/**
 * 规范化术语表文本：忽略注释/空行，按 source 去重（后一条覆盖前一条，保留首次出现
 * 的位置），用于保存后比较宿主回写内容与本地草稿是否一致。
 */
export function canonicalGlossaryText(text: string): string {
  const entries = new Map<string, GlossaryRow>();
  for (const row of parseGlossaryRows(text).rows) {
    const source = row.source.trim();
    const target = row.target.trim();
    if (!source || !target) {
      continue;
    }
    entries.set(source.toLowerCase(), { source, target });
  }
  return serializeGlossaryRows([...entries.values()]);
}
