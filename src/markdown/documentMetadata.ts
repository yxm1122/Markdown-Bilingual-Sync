/**
 * 从相对路径与 YAML frontmatter 提取只读文档元数据。
 *
 * 这里只解析顶层白名单字段，不引入完整 YAML 解析器；嵌套对象、锚点和
 * 复杂表达式直接忽略。所有值都会截断，并作为不可信数据放入摘要 user JSON。
 */
import type { DocumentMetadata } from "../translation/types";

type StringField = Exclude<
  keyof DocumentMetadata,
  "tags" | "keywords" | "categories"
>;
type ListField = "tags" | "keywords" | "categories";

const STRING_LIMITS: Record<StringField, number> = {
  relativePath: 200,
  title: 160,
  name: 160,
  description: 300,
  audience: 160,
  product: 120,
  project: 120,
  version: 40,
  locale: 20,
  lang: 20,
  type: 40,
  docType: 40,
};

const LIST_FIELDS = new Set<ListField>(["tags", "keywords", "categories"]);
const LIST_LIMIT = 10;
const LIST_ITEM_LIMIT = 48;

const CANONICAL_KEYS: Record<string, keyof DocumentMetadata> = {
  title: "title",
  name: "name",
  description: "description",
  tags: "tags",
  keywords: "keywords",
  categories: "categories",
  category: "categories",
  audience: "audience",
  product: "product",
  project: "project",
  version: "version",
  locale: "locale",
  lang: "lang",
  language: "lang",
  type: "type",
  doctype: "docType",
  doc_type: "docType",
};

function capString(value: string, limit: number): string | undefined {
  const text = value.trim();
  return text ? text.slice(0, limit).trim() : undefined;
}

function unquote(value: string): string {
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")))
  ) {
    return value.slice(1, -1).trim();
  }
  return value.trim();
}

/** 去掉不在引号内的行内注释。 */
function stripInlineComment(value: string): string {
  let quote: string | null = null;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (quote) {
      if (char === quote && value[index - 1] !== "\\") {
        quote = null;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === "#" && (index === 0 || /\s/.test(value[index - 1]))) {
      return value.slice(0, index).trim();
    }
  }
  return value.trim();
}

function parseInlineArray(value: string): string[] {
  const body = value.slice(1, -1);
  const items: string[] = [];
  let current = "";
  let quote: string | null = null;
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index];
    if (quote) {
      if (char === quote && body[index - 1] !== "\\") {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === ",") {
      items.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  items.push(current.trim());
  return items.map(unquote).filter(Boolean);
}

function setStringField(
  metadata: DocumentMetadata,
  field: keyof DocumentMetadata,
  raw: string,
): void {
  if (LIST_FIELDS.has(field as ListField)) {
    setListField(metadata, field as ListField, [raw]);
    return;
  }
  const limit = STRING_LIMITS[field as StringField];
  if (!limit) {
    return;
  }
  const value = capString(stripInlineComment(unquote(raw)), limit);
  if (value) {
    metadata[field as StringField] = value;
  }
}

function setListField(
  metadata: DocumentMetadata,
  field: ListField,
  items: readonly string[],
): void {
  const values: string[] = [];
  for (const item of items) {
    const value = capString(
      stripInlineComment(unquote(item)),
      LIST_ITEM_LIMIT,
    );
    if (value && !values.includes(value)) {
      values.push(value);
    }
    if (values.length >= LIST_LIMIT) {
      break;
    }
  }
  if (values.length > 0) {
    metadata[field] = values;
  }
}

function capRelativePath(value: string): string | undefined {
  const normalized = value
    .replace(/\\/g, "/")
    .replace(/^\.\/+/, "")
    .replace(/\/+/g, "/");
  const tail = normalized.split("/").filter(Boolean).slice(-8).join("/");
  return tail ? tail.slice(-200) : undefined;
}

interface PendingList {
  field: ListField;
  items: string[];
}

interface PendingBlock {
  field: StringField;
  style: "|" | ">";
  lines: string[];
}

/** 解析 frontmatter 的顶层白名单字段；复杂/嵌套结构忽略。 */
export function parseFrontmatterMetadata(
  raw?: string,
): DocumentMetadata {
  if (!raw?.trim()) {
    return {};
  }
  const lines = raw.split(/\r?\n/);
  let start = 0;
  if (lines[0]?.trim() === "---") {
    start = 1;
  }
  let end = lines.length;
  for (let index = lines.length - 1; index >= start; index -= 1) {
    const text = lines[index].trim();
    if (text === "---" || text === "...") {
      end = index;
      break;
    }
  }

  const metadata: DocumentMetadata = {};
  let pendingKey: keyof DocumentMetadata | null = null;
  let list: PendingList | null = null;
  let block: PendingBlock | null = null;

  const flush = () => {
    if (list) {
      setListField(metadata, list.field, list.items);
    }
    if (block) {
      const text = block.lines
        .join(block.style === "|" ? "\n" : " ")
        .replace(/\s+/g, block.style === "|" ? "\n" : " ")
        .trim();
      const value = capString(text, STRING_LIMITS[block.field]);
      if (value) {
        metadata[block.field] = value;
      }
    }
    list = null;
    block = null;
    pendingKey = null;
  };

  for (let index = start; index < end; index += 1) {
    const line = lines[index];
    if (!line.trim()) {
      if (block) {
        block.lines.push("");
      }
      continue;
    }
    if (/^\s*#/.test(line)) {
      continue;
    }
    const topLevel = /^([A-Za-z0-9_-]+):(.*)$/.exec(line);
    if (topLevel) {
      flush();
      const field = CANONICAL_KEYS[topLevel[1].toLowerCase()];
      if (!field) {
        continue;
      }
      const rest = stripInlineComment(topLevel[2].trim());
      if (!rest) {
        pendingKey = field;
        continue;
      }
      const blockMatch = /^([|>])[+-]?$/.exec(rest);
      if (blockMatch) {
        const style = blockMatch[1] as "|" | ">";
        if (LIST_FIELDS.has(field as ListField)) {
          continue;
        }
        block = { field: field as StringField, style, lines: [] };
        continue;
      }
      if (rest.startsWith("[") && rest.endsWith("]")) {
        if (LIST_FIELDS.has(field as ListField)) {
          setListField(
            metadata,
            field as ListField,
            parseInlineArray(rest),
          );
        }
        continue;
      }
      setStringField(metadata, field, rest);
      continue;
    }

    if (block && /^\s+/.test(line)) {
      block.lines.push(line.replace(/^\s+/, ""));
      continue;
    }

    const item = /^\s*-\s*(.*)$/.exec(line);
    if (item) {
      if (!list && pendingKey && LIST_FIELDS.has(pendingKey as ListField)) {
        list = { field: pendingKey as ListField, items: [] };
        pendingKey = null;
      }
      if (list) {
        list.items.push(item[1]);
      }
      continue;
    }

    // 缩进的非列表内容属于嵌套对象，忽略；顶格非 key 行也忽略。
    if (/^\s+/.test(line)) {
      continue;
    }
    flush();
  }

  flush();
  return metadata;
}

/** 合并白名单 frontmatter 与相对路径；没有内容时返回 undefined。 */
export function buildDocumentMetadata(
  rawFrontmatter: string | undefined,
  relativePath: string | undefined,
): DocumentMetadata | undefined {
  const metadata = parseFrontmatterMetadata(rawFrontmatter);
  const path = relativePath ? capRelativePath(relativePath) : undefined;
  if (path) {
    metadata.relativePath = path;
  }
  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

/** 摘要请求不发送原始 frontmatter；保留换行结构，去掉开头空行。 */
export function stripFrontmatterText(
  sourceText: string,
  rawFrontmatter?: string,
): string {
  if (!rawFrontmatter) {
    return sourceText;
  }
  // 切块器统一用 \n 记录 raw；原文可能是 CRLF，先归一化再比较。
  const normalizedSource = sourceText.replace(/\r\n?/g, "\n");
  const normalizedRaw = rawFrontmatter.replace(/\r\n?/g, "\n");
  if (!normalizedSource.startsWith(normalizedRaw)) {
    return sourceText;
  }
  return normalizedSource
    .slice(normalizedRaw.length)
    .replace(/^\n+/, "");
}
