/**
 * 原生双语预览（Preact）。
 *
 * 单一渲染所有者：宿主只下发 PreviewModel + 面板状态，所有 DOM 由本组件树生成；
 * 未变化的块通过 key 复用，因此更新时焦点、滚动和摘要草稿不会被整页替换清空。
 *
 * 与宿主的通信仍走既有消息协议（见 src/preview/protocol.ts）；本文件只负责展示与
 * 用户意图，不直接读写缓存或源文件。
 */
import { Fragment } from "preact";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "preact/hooks";
import type { ComponentChildren, JSX } from "preact";
import type { PreviewBlockView, PreviewModel } from "../../preview/previewModel";
import type { PreviewLayout, PreviewReadonlyState } from "../../preview/layout";
import type {
  DiffRow,
  ExportConfirmationView,
  SourceConfirmationView,
} from "../../export/diffPreview";
import type {
  PreviewAppState,
  PreviewToastKind,
} from "../../preview/protocol";
import {
  catalog,
  formatText as fmt,
  savedState,
  saveState,
  send,
  standaloneMode,
} from "./bridge";
import type { BootData, MenuEntry, OutboundMessage, UiCatalog } from "./types";

type Mode = "bilingual" | "source" | "target";
type Side = "source" | "target";
type Summary = PreviewModel["assist"]["summary"];

interface EditingState {
  key: string;
  side: Side;
  kind: "source" | "target" | "pending" | "standalone";
  blockIndex?: number;
  pendingId?: string;
  standaloneId?: string;
  /** 打开编辑器时的初始文本；之后的输入由编辑器自己持有，避免整页重渲染。 */
  baseText: string;
  sourceHash: string;
  cacheId?: string;
}

interface InsertState {
  afterBlockIndex: number;
  type: "source" | "target";
}

interface Toast {
  id: number;
  text: string;
  kind: PreviewToastKind;
}

interface SplitScrollAnchor {
  side: Side;
  key: string;
  /** 当前块内的滚动进度（0–1）。 */
  progress: number;
  atTop: boolean;
  atBottom: boolean;
}

interface MenuState {
  x: number;
  y: number;
  items: MenuEntry[];
}

interface ExportDialogState {
  data: ExportConfirmationView;
  writing: boolean;
  error?: string;
}

interface SourceDialogState {
  data: SourceConfirmationView;
  writing: boolean;
  error?: string;
}

// ---- 展示辅助 ----

const STATUS_COLORS: Record<string, string> = {
  translated: "var(--vscode-testing-iconPassed)",
  stale: "var(--vscode-editorWarning-foreground)",
  human: "var(--vscode-charts-blue)",
  "human-stale": "var(--vscode-editorWarning-foreground)",
  untranslated: "var(--vscode-errorForeground)",
  copy: "var(--vscode-descriptionForeground)",
  "copy-stale": "var(--vscode-editorWarning-foreground)",
  "copy-pending": "var(--vscode-descriptionForeground)",
  deleted: "var(--vscode-errorForeground)",
};

const STATUS_ICONS: Record<string, string> = {
  translated: "pass-filled",
  stale: "warning",
  human: "lock",
  "human-stale": "lock",
  untranslated: "circle-slash",
  copy: "copy",
  "copy-stale": "copy",
  "copy-pending": "copy",
  deleted: "trash",
};

function Icon({ name, size }: { name: string; size?: number }) {
  return (
    <span
      class={`codicon codicon-${name}`}
      style={size ? { fontSize: `${size}px` } : undefined}
      aria-hidden="true"
    />
  );
}

function Button(props: {
  children?: ComponentChildren;
  primary?: boolean;
  disabled?: boolean;
  title?: string;
  onClick?: (event: MouseEvent) => void;
}) {
  return (
    <button
      type="button"
      class={`pv-button${props.primary ? " is-primary" : ""}`}
      disabled={props.disabled}
      title={props.title}
      onClick={props.onClick}
    >
      {props.children}
    </button>
  );
}

function IconButton(props: {
  icon: string;
  title: string;
  active?: boolean;
  disabled?: boolean;
  onClick?: (event: MouseEvent) => void;
}) {
  return (
    <button
      type="button"
      class={`pv-icon-button${props.active ? " is-active" : ""}`}
      title={props.title}
      aria-label={props.title}
      disabled={props.disabled}
      onClick={props.onClick}
    >
      <Icon name={props.icon} />
    </button>
  );
}

function compactTokens(tokens: number): string {
  if (!tokens) {
    return "—";
  }
  return tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : String(tokens);
}

function formatDate(iso: string | undefined): string {
  if (!iso) {
    return "";
  }
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }
  try {
    return new Intl.DateTimeFormat(document.documentElement.lang || undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(date);
  } catch {
    return iso;
  }
}

function summaryModelLabel(model: string | undefined, text: UiCatalog): string {
  if (!model) {
    return "";
  }
  switch (model) {
    case "mock":
      return text.providers.mockTranslation;
    case "openai":
      return text.providers.openaiCompatible;
    case "http":
      return text.providers.customHttp;
    case "manual":
      return text.preview.summary.manual;
    default:
      return model.startsWith("batch:") ? model.slice(6) : model;
  }
}

function statusColor(block: PreviewBlockView): string {
  return STATUS_COLORS[block.status] ?? "var(--vscode-descriptionForeground)";
}

function statusIcon(block: PreviewBlockView): string {
  if (block.human && block.status === "human-stale") {
    return "lock";
  }
  return STATUS_ICONS[block.status] ?? "info";
}

// ---- 菜单 ----

function Menu(props: {
  state: MenuState;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: props.state.x, top: props.state.y });

  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) {
      return;
    }
    const rect = node.getBoundingClientRect();
    let left = props.state.x - rect.width;
    let top = props.state.y;
    if (left < 4) {
      left = 4;
    }
    if (top + rect.height > window.innerHeight - 4) {
      top = props.state.y - rect.height - 8;
    }
    if (top < 4) {
      top = 4;
    }
    setPosition({ left, top });
    const first = node.querySelector<HTMLButtonElement>(".menu-item:not([disabled])");
    first?.focus();
  }, [props.state]);

  useEffect(() => {
    const onPointerDown = (event: MouseEvent) => {
      if (!(event.target instanceof Node) || !ref.current?.contains(event.target)) {
        props.onClose();
      }
    };
    const onScroll = (event: Event) => {
      // 菜单自身内容滚动时保持打开；页面或分栏滚动时立即关闭，避免菜单悬空。
      if (event.target instanceof Node && ref.current?.contains(event.target)) {
        return;
      }
      props.onClose();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        props.onClose();
        return;
      }
      if (
        event.key !== "ArrowDown" &&
        event.key !== "ArrowUp" &&
        event.key !== "Home" &&
        event.key !== "End"
      ) {
        return;
      }
      const items = Array.from(
        ref.current?.querySelectorAll<HTMLButtonElement>(".menu-item:not([disabled])") ?? [],
      );
      if (!items.length) {
        return;
      }
      event.preventDefault();
      const current = items.indexOf(document.activeElement as HTMLButtonElement);
      let next: number;
      if (event.key === "Home") {
        next = 0;
      } else if (event.key === "End") {
        next = items.length - 1;
      } else if (event.key === "ArrowDown") {
        next = current < 0 ? 0 : (current + 1) % items.length;
      } else {
        next = current < 0 ? items.length - 1 : (current - 1 + items.length) % items.length;
      }
      items[next]?.focus();
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [props.onClose]);

  return (
    <div
      ref={ref}
      class="menu"
      role="menu"
      style={{ left: `${position.left}px`, top: `${position.top}px` }}
      onMouseDown={(event) => event.stopPropagation()}
    >
      {props.state.items.map((item, index) =>
        "separator" in item ? (
          <div key={`sep-${index}`} class="menu-separator" role="separator" />
        ) : (
          <button
            key={`${item.label}-${index}`}
            type="button"
            class="menu-item"
            role="menuitem"
            disabled={item.disabled}
            onClick={() => {
              if (item.disabled) {
                return;
              }
              props.onClose();
              item.onSelect();
            }}
          >
            {item.icon ? <Icon name={item.icon} /> : <span style="width:16px" />}
            <span class="menu-item-label">{item.label}</span>
            {item.hint ? <span class="menu-item-hint">{item.hint}</span> : null}
          </button>
        ),
      )}
    </div>
  );
}

// ---- 工具栏 / 上下文栏 ----

function Toolbar(props: {
  model: PreviewModel;
  text: UiCatalog;
  busy: boolean;
  onSync: () => void;
  onExport: () => void;
  onRefresh: () => void;
  toolbarMenu: (event: MouseEvent) => void;
}) {
  const { model, text, busy } = props;
  return (
    <header class="pv-toolbar">
      <div class="pv-file">
        <Icon name="markdown" />
        <div class="pv-file-text">
          <h1 class="pv-file-title">{model.fileLabel}</h1>
          <p class="pv-file-meta">
            {model.sourceLanguage} → {model.targetLanguage} · {model.providerLabel}
          </p>
        </div>
      </div>
      <div class="pv-toolbar-actions">
        <Button primary disabled={busy} onClick={props.onSync}>
          <Icon name="sync" size={14} />
          {text.preview.toolbar.sync}
        </Button>
        <Button
          disabled={busy || !model.cacheExists}
          title={model.cacheExists ? undefined : text.preview.toolbar.exportDisabledTitle}
          onClick={props.onExport}
        >
          <Icon name="export" size={14} />
          {text.preview.toolbar.export}
        </Button>
        <IconButton
          icon="refresh"
          title={text.preview.toolbar.refresh}
          disabled={busy}
          onClick={props.onRefresh}
        />
        <IconButton
          icon="ellipsis"
          title={text.preview.toolbar.moreActions}
          onClick={props.toolbarMenu}
        />
      </div>
    </header>
  );
}

function Stats(props: {
  model: PreviewModel;
  text: UiCatalog;
}) {
  const { model, text } = props;
  const items: JSX.Element[] = [];
  const add = (
    count: number,
    label: string,
    icon: string,
    className: string,
  ) => {
    if (count <= 0) {
      return;
    }
    items.push(
      <span key={label} class={`pv-stat ${className}`}>
        <Icon name={icon} />
        <strong>{count}</strong> {label}
      </span>,
    );
  };
  add(model.counts.translated, text.preview.stats.translated, "pass-filled", "is-ok");
  add(model.counts.stale, text.preview.stats.stale, "warning", "is-warn");
  add(model.counts.human, text.preview.stats.human, "lock", "is-human");
  add(model.counts.copy, text.preview.stats.copy, "copy", "is-copy");
  add(model.counts.untranslated, text.preview.stats.untranslated, "circle-slash", "is-missing");
  if (items.length === 0) {
    items.push(
      <span key="empty" class="pv-stat is-muted">
        <Icon name="info" /> {text.preview.stats.empty}
      </span>,
    );
  }
  items.push(
    <span key="total" class="pv-stat is-muted">
      {fmt(text.preview.stats.total, { count: model.counts.total })}
    </span>,
  );
  return <div class="pv-stats">{items}</div>;
}

function ContextBar(props: {
  model: PreviewModel;
  text: UiCatalog;
  mode: Mode;
  layout: PreviewLayout;
  busy: boolean;
  summaryOpen: boolean;
  onMode: (mode: Mode) => void;
  onLayout: (layout: PreviewLayout) => void;
  onToggleSummary: () => void;
}) {
  const { model, text, mode, layout, busy, summaryOpen } = props;
  const summary = model.assist.summary;
  const summaryBadge = summary.text
    ? compactTokens(summary.tokens)
    : "—";
  return (
    <div class="pv-context">
      <Stats model={model} text={text} />
      <div class="pv-context-controls">
        <div class="pv-seg" role="group" aria-label={text.preview.toolbar.previewMode}>
          {(["bilingual", "source", "target"] as const).map((value) => (
            <button
              key={value}
              type="button"
              disabled={busy}
              data-mode={value}
              aria-pressed={mode === value}
              title={
                value === "bilingual"
                  ? text.preview.toolbar.bilingual
                  : value === "source"
                    ? text.preview.toolbar.sourceOnly
                    : text.preview.toolbar.targetOnly
              }
              onClick={() => props.onMode(value)}
            >
              {value === "bilingual"
                ? text.preview.toolbar.bilingual
                : value === "source"
                  ? text.preview.toolbar.sourceOnly
                  : text.preview.toolbar.targetOnly}
            </button>
          ))}
        </div>
        <div class="pv-seg" role="group" aria-label={text.preview.subbar.layout}>
          {(["columns", "stacked", "split"] as const).map((value) => (
            <button
              key={value}
              type="button"
              disabled={busy}
              data-layout={value}
              aria-pressed={layout === value}
              title={
                value === "columns"
                  ? text.preview.subbar.columns
                  : value === "stacked"
                    ? text.preview.subbar.stacked
                    : text.preview.subbar.split
              }
              onClick={() => props.onLayout(value)}
            >
              {value === "columns"
                ? text.preview.subbar.columns
                : value === "stacked"
                  ? text.preview.subbar.stacked
                  : text.preview.subbar.split}
            </button>
          ))}
        </div>
        <button
          type="button"
          class={`pv-summary-toggle${summary.stale ? " is-stale" : ""}`}
          aria-expanded={summaryOpen}
          title={text.preview.summary.title}
          onClick={props.onToggleSummary}
        >
          <Icon name="book" />
          <span>{text.preview.summary.title}</span>
          <span class={`pv-badge${summary.stale ? " is-stale" : ""}`}>{summaryBadge}</span>
        </button>
      </div>
    </div>
  );
}

function Notices(props: {
  model: PreviewModel;
  text: UiCatalog;
  busy: boolean;
  onApplySource: () => void;
  onDiscardSource: () => void;
  onRetranslateStale: () => void;
}) {
  const { model, text, busy } = props;
  const notices: JSX.Element[] = [];
  if (model.pendingSourceCount > 0) {
    notices.push(
      <div key="pending" class="pv-notice is-info">
        <Icon name="edit" />
        <span class="pv-notice-text">
          {model.pendingSourceCount} · {text.preview.actions.sourcePendingBadge}
        </span>
        <span class="pv-notice-actions">
          <Button disabled={busy} onClick={props.onApplySource}>
            {fmt(text.preview.actions.applySource, { count: model.pendingSourceCount })}
          </Button>
          <Button disabled={busy} onClick={props.onDiscardSource}>
            {text.preview.actions.resetSource}
          </Button>
        </span>
      </div>,
    );
  }
  if (model.counts.stale > 0) {
    notices.push(
      <div key="stale" class="pv-notice is-warning">
        <Icon name="warning" />
        <span class="pv-notice-text">
          {model.counts.stale} · {text.preview.statusLabels.stale}
        </span>
        <span class="pv-notice-actions">
          <Button disabled={busy} onClick={props.onRetranslateStale}>
            {fmt(text.preview.subbar.retranslateStale, { count: model.counts.stale })}
          </Button>
        </span>
      </div>,
    );
  }
  if (model.warnings.length > 0) {
    notices.push(
      <div key="warnings" class="pv-notice is-warning">
        <Icon name="info" />
        <span class="pv-notice-text" title={model.warnings.join("\n")}>
          {model.warnings.join(" · ")}
        </span>
      </div>,
    );
  }
  return notices.length > 0 ? <div class="pv-notices">{notices}</div> : null;
}

// ---- 摘要 ----

function SummaryPanel(props: {
  text: UiCatalog;
  summary: Summary;
  open: boolean;
  busy: boolean;
  stableTranslation: boolean;
  summaryContext: boolean;
  summaryDraft: string;
  glossaryDraft: string;
  onToggle: () => void;
  onDraft: (value: string) => void;
  onGlossaryDraft: (value: string) => void;
  onGenerate: () => void;
  onSave: () => void;
  onClear: () => void;
  onSaveGlossary: () => void;
  onAssist: (key: "stableTranslation" | "summaryContext", value: boolean) => void;
}) {
  const { text, summary } = props;
  const hasSummary = Boolean(summary.text.trim());
  const meta: string[] = [];
  if (hasSummary) {
    meta.push(fmt(text.preview.summary.tokens, { count: summary.tokens }));
    if (summary.updatedAt) {
      meta.push(
        fmt(text.preview.summary.generatedAt, {
          time: formatDate(summary.updatedAt),
        }),
      );
    }
    if (summary.model) {
      meta.push(summaryModelLabel(summary.model, text));
    }
  }
  const status = hasSummary
    ? summary.stale
      ? text.preview.summary.stale
      : text.preview.summary.generated
    : text.preview.summary.noSummary;
  return (
    <section class={`pv-summary${props.open ? " is-open" : ""}`}>
      <button
        type="button"
        class="pv-summary-head"
        aria-expanded={props.open}
        onClick={props.onToggle}
      >
        <Icon name="book" />
        <span class="pv-summary-title">{text.preview.summary.title}</span>
        <span class={`pv-summary-state${summary.stale ? " is-stale" : ""}`}>{status}</span>
        <span class="pv-summary-meta">{meta.join(" · ")}</span>
        <Icon name="chevron-down" />
      </button>
      {props.open ? (
        <div class="pv-summary-body">
          <div class="pv-summary-actions">
            <Button
              primary
              disabled={props.busy || !summary.canGenerate}
              title={summary.canGenerate ? text.preview.summary.generateTitle : text.preview.summary.unsupported}
              onClick={props.onGenerate}
            >
              {text.preview.summary.generate}
            </Button>
            <Button disabled={props.busy} onClick={props.onSave}>
              {text.preview.summary.save}
            </Button>
            <Button disabled={props.busy || !hasSummary} onClick={props.onClear}>
              {text.preview.summary.clear}
            </Button>
            <label class="pv-check" title={text.preview.summary.stableTranslationTitle}>
              <input
                type="checkbox"
                disabled={props.busy}
                checked={props.stableTranslation}
                onChange={(event) => props.onAssist("stableTranslation", event.currentTarget.checked)}
              />
              {text.preview.summary.stableTranslation}
            </label>
            <label class="pv-check" title={text.preview.summary.useSummaryTitle}>
              <input
                type="checkbox"
                checked={props.summaryContext}
                disabled={!hasSummary || props.busy}
                onChange={(event) => props.onAssist("summaryContext", event.currentTarget.checked)}
              />
              {text.preview.summary.useSummary}
            </label>
          </div>
          <textarea
            class="pv-textarea"
            rows={6}
            spellcheck={false}
            aria-label={text.preview.summary.title}
            value={props.summaryDraft}
            placeholder={text.preview.summary.placeholder}
            onInput={(event) => props.onDraft(event.currentTarget.value)}
          />
          <p class="pv-summary-note">
            {meta.join(" · ")}
            {summary.stale ? ` · ${text.preview.summary.staleHint}` : ""}
          </p>
          {hasSummary ? (
            <div class="pv-glossary">
              <div class="pv-glossary-head">
                <span class="pv-glossary-title">{text.preview.summary.glossaryTitle}</span>
                <span class="pv-glossary-count">
                  {fmt(text.preview.summary.glossaryCount, { count: summary.glossaryCount ?? 0 })}
                </span>
              </div>
              <textarea
                class="pv-textarea pv-glossary-text"
                rows={4}
                spellcheck={false}
                aria-label={text.preview.summary.glossaryTitle}
                value={props.glossaryDraft}
                placeholder={text.preview.summary.glossaryPlaceholder}
                onInput={(event) => props.onGlossaryDraft(event.currentTarget.value)}
              />
              <div class="pv-summary-actions" style="margin-top:6px">
                <Button disabled={props.busy} onClick={props.onSaveGlossary}>
                  {text.preview.summary.saveGlossary}
                </Button>
                <span class="pv-summary-note" style="margin:0">
                  {text.preview.summary.glossaryHint}
                </span>
              </div>
            </div>
          ) : (
            <p class="pv-summary-note">{text.preview.summary.glossaryNeedsSummary}</p>
          )}
        </div>
      ) : null}
    </section>
  );
}

// ---- 内联编辑 / 插入编辑器 ----

function InlineEditor(props: {
  initial: string;
  hint: string;
  saveLabel: string;
  busy: boolean;
  onSave: (text: string) => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  // 草稿留在编辑器内部：输入时只重渲染 textarea，不触发 300 块文档的整棵树 diff。
  const [draft, setDraft] = useState(props.initial);
  useEffect(() => {
    const node = ref.current;
    if (node) {
      node.focus();
      node.setSelectionRange(node.value.length, node.value.length);
    }
  }, []);
  return (
    <div class="pv-editor">
      <textarea
        ref={ref}
        rows={Math.min(28, Math.max(5, draft.split("\n").length + 1))}
        spellcheck={false}
        value={draft}
        aria-label={props.hint}
        onInput={(event) => setDraft(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            props.onCancel();
          } else if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
            event.preventDefault();
            props.onSave(draft);
          }
        }}
      />
      <div class="pv-editor-actions">
        <span class="pv-editor-hint">{props.hint}</span>
        <Button onClick={props.onCancel}>{catalog!.preview.actions.cancelEdit}</Button>
        <Button primary disabled={props.busy} onClick={() => props.onSave(draft)}>
          {props.saveLabel}
        </Button>
      </div>
    </div>
  );
}

function InsertEditor(props: {
  type: "source" | "target";
  onSave: (text: string) => void;
  onCancel: () => void;
}) {
  const text = catalog!.preview;
  const ref = useRef<HTMLTextAreaElement>(null);
  const [draft, setDraft] = useState("");
  useEffect(() => {
    ref.current?.focus();
  }, []);
  return (
    <div class="pv-editor">
      <textarea
        ref={ref}
        rows={5}
        spellcheck={false}
        aria-label={text.actions.insertPlaceholder}
        placeholder={text.actions.insertPlaceholder}
        value={draft}
        onInput={(event) => setDraft(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            props.onCancel();
          } else if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
            event.preventDefault();
            props.onSave(draft);
          }
        }}
      />
      <div class="pv-editor-actions">
        <span class="pv-editor-hint">
          {props.type === "target" ? text.actions.targetInsertHint : text.actions.sourceEditHint}
        </span>
        <Button onClick={props.onCancel}>{text.actions.cancelEdit}</Button>
        <Button primary onClick={() => props.onSave(draft)}>
          {props.type === "target" ? text.actions.addStandaloneTarget : text.actions.stageInsert}
        </Button>
      </div>
    </div>
  );
}

// ---- 块内容 ----

function PaneContent(props: {
  block: PreviewBlockView;
  side: Side;
  text: UiCatalog;
  language: string;
  readonly: boolean;
  flat?: boolean;
  busy: boolean;
  editing: EditingState | null;
  onStartEdit: (block: PreviewBlockView, side: Side) => void;
  onSave: (text: string) => void;
  onCancel: () => void;
  onRetranslate: () => void;
  onOpenLink: (href: string) => void;
}) {
  const { block, side, text } = props;
  const isTarget = side === "target";
  const isPending = Boolean(block.pendingInsertId);
  const isStandalone = Boolean(block.standaloneTargetId);
  const isDeleted = block.sourceDeleted;
  const editing = props.editing;
  let content: JSX.Element;
  if (editing && editing.key === block.key && editing.side === side) {
    content = (
      <InlineEditor
        initial={editing.baseText}
        hint={
          editing.kind === "source" || editing.kind === "pending"
            ? text.preview.actions.sourceEditHint
            : editing.kind === "standalone"
              ? text.preview.actions.standaloneEditHint
              : text.preview.actions.targetEditHint
        }
        saveLabel={
          editing.kind === "source" || editing.kind === "pending"
            ? text.preview.actions.saveSourceStage
            : editing.kind === "standalone"
              ? text.preview.actions.saveStandaloneTarget
              : text.preview.actions.saveTarget
        }
        busy={props.busy}
        onSave={props.onSave}
        onCancel={props.onCancel}
      />
    );
  } else if (!isTarget) {
    if (isStandalone) {
      content = (
        <div class="pv-placeholder">
          <Icon name="info" />
          {text.preview.actions.standaloneSourceEmpty}
        </div>
      );
    } else {
      content = block.sourceHtml ? (
        <div
          class="pv-md"
          dangerouslySetInnerHTML={{ __html: block.sourceHtml }}
          onClick={(event) => handleContentClick(event, props, false)}
        />
      ) : (
        <div class="pv-placeholder">
          <Icon name="info" />
          {text.preview.placeholders.sourceEmpty}
        </div>
      );
    }
  } else if (isPending) {
    content = (
      <div class="pv-placeholder">
        <Icon name="info" />
        {text.preview.placeholders.untranslated}
      </div>
    );
  } else if (block.status === "deleted") {
    content = (
      <div class="pv-placeholder">
        <Icon name="info" />
        {text.preview.placeholders.skipped}
      </div>
    );
  } else if (block.targetHtml) {
    content = (
      <div
        class="pv-md"
        dangerouslySetInnerHTML={{ __html: block.targetHtml }}
        onClick={(event) => handleContentClick(event, props, true)}
      />
    );
  } else {
    const placeholder = block.hasCache
      ? text.preview.placeholders.targetEmpty
      : block.status === "copy-pending"
        ? text.preview.placeholders.copyPending
        : text.preview.placeholders.untranslated;
    content = (
      <div class="pv-placeholder">
        <Icon name="circle-slash" />
        {placeholder}
      </div>
    );
  }

  const canEditSource = !isTarget && !isStandalone && !isDeleted && !props.readonly;
  const canEditTarget = isTarget && block.canEditTarget && !isDeleted && !props.readonly;
  const stale = isTarget && (block.status === "stale" || block.status === "human-stale");
  const body = (
    <Fragment>
      {content}
      {stale ? (
        <div class="pv-stale-hint">
          <Icon name="warning" />
          <span>{text.preview.statusLabels.stale}</span>
          <button type="button" class="pv-link" onClick={props.onRetranslate}>
            {text.preview.actions.retranslate}
          </button>
        </div>
      ) : null}
    </Fragment>
  );
  if (props.flat) {
    return body;
  }
  return (
    <div class={`pv-pane pv-pane-${side}`} data-pane={side}>
      <div class="pv-pane-label">
        <span>{isTarget ? text.preview.panes.target : text.preview.panes.source}</span>
        <span class="pv-lang">{props.language}</span>
        {(canEditSource || canEditTarget) && (
          <button
            type="button"
            class="pv-pane-edit"
            title={canEditSource ? text.preview.actions.editSourceTitle : text.preview.actions.editTargetTitle}
            onClick={() => props.onStartEdit(block, side)}
          >
            <Icon name="edit" />
            {text.preview.actions.editHint}
          </button>
        )}
      </div>
      {body}
    </div>
  );
}

function handleContentClick(
  event: MouseEvent,
  props: {
    block: PreviewBlockView;
    side: Side;
    busy: boolean;
    readonly: boolean;
    onStartEdit: (block: PreviewBlockView, side: Side) => void;
    onOpenLink: (href: string) => void;
  },
  isTarget: boolean,
) {
  const target = event.target;
  if (!(target instanceof Element)) {
    return;
  }
  // 拖选/双击选词后浏览器仍会派发 click；此时不应进入编辑或打开链接。
  const selection = window.getSelection();
  if (selection && !selection.isCollapsed && selection.toString().trim()) {
    const content = target.closest(".pv-md");
    const inContent = (node: Node | null) =>
      Boolean(content && node && content.contains(node));
    if (
      content &&
      (inContent(selection.anchorNode) || inContent(selection.focusNode))
    ) {
      return;
    }
  }
  const link = target.closest("a");
  if (link) {
    const href = link.getAttribute("data-mbs-href");
    if (href) {
      event.preventDefault();
      props.onOpenLink(href);
    }
    return;
  }
  if (target.closest("input, button, summary, label")) {
    return;
  }
  if (props.busy || props.readonly) {
    return;
  }
  if (!isTarget && props.block.standaloneTargetId) {
    return;
  }
  if (isTarget && !props.block.canEditTarget) {
    return;
  }
  props.onStartEdit(props.block, props.side);
}

function PendingBadges({ block, text }: { block: PreviewBlockView; text: UiCatalog }) {
  const badges: JSX.Element[] = [];
  if (block.sourceDeleted) {
    badges.push(
      <span key="deleted" class="pv-badge is-stale">
        {text.preview.actions.sourceDeletePendingLabel}
      </span>,
    );
  } else if (block.sourcePending && !block.pendingInsertId) {
    badges.push(
      <span key="pending" class="pv-badge">
        {text.preview.actions.sourcePendingBadge}
      </span>,
    );
  }
  return <Fragment>{badges}</Fragment>;
}

function BlockHead(props: {
  block: PreviewBlockView;
  text: UiCatalog;
  actions?: boolean;
  onMenu?: (event: MouseEvent) => void;
  onRetranslate?: () => void;
  showLine?: boolean;
}) {
  const { block, text } = props;
  return (
    <header class="pv-block-head">
      <span class="pv-kind">{text.preview.kindLabels[block.kind] ?? block.kind}</span>
      <span class="pv-status" style={`--status-color:${statusColor(block)}`}>
        <Icon name={statusIcon(block)} />
        <strong>{block.statusLabel}</strong>
      </span>
      <PendingBadges block={block} text={text} />
      {block.headingPath ? (
        <span class="pv-heading-path" title={text.preview.actions.headingPathTitle}>
          {block.headingPath}
        </span>
      ) : null}
      {props.showLine && block.sourceLine ? <span class="pv-line">L{block.sourceLine}</span> : null}
      {props.actions ? (
        <span class="pv-block-actions">
          {(block.status === "stale" || block.status === "human-stale") && (
            <button
              type="button"
              class="pv-action is-warn"
              title={text.preview.actions.retranslateTitle}
              onClick={props.onRetranslate}
            >
              <Icon name="refresh" />
            </button>
          )}
          <button
            type="button"
            class="pv-action"
            title={text.preview.actions.showBlockActions}
            aria-label={text.preview.actions.showBlockActions}
            onClick={props.onMenu}
          >
            <Icon name="ellipsis" />
          </button>
        </span>
      ) : null}
    </header>
  );
}

function PairedBlock(props: {
  block: PreviewBlockView;
  text: UiCatalog;
  sourceLanguage: string;
  targetLanguage: string;
  busy: boolean;
  readonly: boolean;
  editing: EditingState | null;
  insert: InsertState | null;
  onMenu: (event: MouseEvent, block: PreviewBlockView, side?: Side) => void;
  onRetranslate: (block: PreviewBlockView) => void;
  onStartEdit: (block: PreviewBlockView, side: Side) => void;
  onSave: (text: string) => void;
  onCancel: () => void;
  onOpenLink: (href: string) => void;
  onInsertSave: (text: string) => void;
  onInsertCancel: () => void;
}) {
  const { block, text } = props;
  const insertHere =
    props.insert && props.insert.afterBlockIndex === block.blockIndex
      ? props.insert
      : null;
  return (
    <Fragment>
      <article class="pv-block" data-status={block.status} data-key={block.key}>
        <BlockHead
          block={block}
          text={text}
          actions
          showLine
          onMenu={(event) => props.onMenu(event, block)}
          onRetranslate={() => props.onRetranslate(block)}
        />
        <div class="pv-pair">
          <PaneContent
            {...props}
            block={block}
            side="source"
            language={props.sourceLanguage}
            readonly={false}
            flat={false}
            onRetranslate={() => props.onRetranslate(block)}
          />
          <PaneContent
            {...props}
            block={block}
            side="target"
            language={props.targetLanguage}
            readonly={false}
            flat={false}
            onRetranslate={() => props.onRetranslate(block)}
          />
        </div>
      </article>
      {insertHere ? (
        <InsertEditor
          type={insertHere.type}
          onSave={props.onInsertSave}
          onCancel={props.onInsertCancel}
        />
      ) : null}
    </Fragment>
  );
}

// ---- 分栏 ----

function SplitCell(props: {
  block: PreviewBlockView;
  side: Side;
  text: UiCatalog;
  language: string;
  busy: boolean;
  readonly: boolean;
  editing: EditingState | null;
  onMenu: (event: MouseEvent, block: PreviewBlockView, side: Side) => void;
  onStartEdit: (block: PreviewBlockView, side: Side) => void;
  onRetranslate: (block: PreviewBlockView) => void;
  onSave: (text: string) => void;
  onCancel: () => void;
  onOpenLink: (href: string) => void;
}) {
  const { block, side, text } = props;
  const isTarget = side === "target";
  const hidden =
    (isTarget && Boolean(block.pendingInsertId)) ||
    (!isTarget && Boolean(block.standaloneTargetId));
  return (
    <article
      class="pv-cell"
      data-status={block.status}
      data-key={block.key}
      data-sync-key={block.key}
    >
      {props.readonly ? null : (
        <header class="pv-cell-head">
          <span class="pv-kind">{text.preview.kindLabels[block.kind] ?? block.kind}</span>
          <span class="pv-status" style={`--status-color:${statusColor(block)}`}>
            <Icon name={statusIcon(block)} />
            <strong>{block.statusLabel}</strong>
          </span>
          <PendingBadges block={block} text={text} />
          {block.sourceLine ? <span class="pv-line">L{block.sourceLine}</span> : null}
          <span class="pv-cell-actions">
            <button
              type="button"
              class="pv-action"
              title={text.preview.actions.showBlockActions}
              aria-label={text.preview.actions.showBlockActions}
              onClick={(event) => props.onMenu(event, block, side)}
            >
              <Icon name="ellipsis" />
            </button>
          </span>
        </header>
      )}
      {hidden ? (
        <div class="pv-placeholder">
          <Icon name="info" />
          {isTarget ? text.preview.placeholders.untranslated : text.preview.actions.standaloneSourceEmpty}
        </div>
      ) : (
        <PaneContent
          block={block}
          side={side}
          text={text}
          language={props.language}
          readonly={props.readonly}
          flat
          busy={props.busy}
          editing={props.editing}
          onStartEdit={props.onStartEdit}
          onSave={props.onSave}
          onCancel={props.onCancel}
          onRetranslate={() => props.onRetranslate(block)}
          onOpenLink={props.onOpenLink}
        />
      )}
    </article>
  );
}

function SplitView(props: {
  model: PreviewModel;
  text: UiCatalog;
  mode: Mode;
  readonly: PreviewReadonlyState;
  busy: boolean;
  editing: EditingState | null;
  insert: InsertState | null;
  onMenu: (event: MouseEvent, block: PreviewBlockView, side: Side) => void;
  onRetranslate: (block: PreviewBlockView) => void;
  onStartEdit: (block: PreviewBlockView, side: Side) => void;
  onSave: (text: string) => void;
  onCancel: () => void;
  onOpenLink: (href: string) => void;
  onInsertSave: (text: string) => void;
  onInsertCancel: () => void;
  onToggleReadonly: (side: Side) => void;
}) {
  const { model, text, mode, readonly } = props;
  const sourceRef = useRef<HTMLDivElement>(null);
  const targetRef = useRef<HTMLDivElement>(null);
  // 只抑制「程序写入另一侧」触发的回声事件，避免双向反馈；
  // 用户在本侧连续滚动时不应被节流，否则另一侧会明显落后。
  const syncLock = useRef<Record<Side, number>>({ source: 0, target: 0 });
  // 仅原文/仅译文时另一侧不可见，无法实时测量；记录最后滚动块的进度，
  // 切换模式后在新可见侧还原，避免两侧各自停在不同位置。
  const scrollAnchor = useRef<SplitScrollAnchor | null>(null);

  /** 找到滚动容器顶部对应的块及其块内偏移。 */
  const locateAnchor = (pane: HTMLDivElement) => {
    if (pane.clientHeight === 0) {
      return null;
    }
    const cells = Array.from(pane.querySelectorAll<HTMLElement>(".pv-cell[data-sync-key]"));
    if (!cells.length) {
      return null;
    }
    const paneRect = pane.getBoundingClientRect();
    let anchor = cells[cells.length - 1];
    for (const cell of cells) {
      if (cell.getBoundingClientRect().bottom > paneRect.top + 1) {
        anchor = cell;
        break;
      }
    }
    return {
      anchor,
      anchorTop: anchor.getBoundingClientRect().top - paneRect.top + pane.scrollTop,
      anchorHeight: Math.max(1, anchor.offsetHeight),
      max: Math.max(0, pane.scrollHeight - pane.clientHeight),
    };
  };

  const readAnchor = (
    pane: HTMLDivElement,
    side: Side,
  ): SplitScrollAnchor | null => {
    const located = locateAnchor(pane);
    if (!located) {
      return null;
    }
    const progress = Math.max(
      0,
      Math.min(1, (pane.scrollTop - located.anchorTop) / located.anchorHeight),
    );
    return {
      side,
      key: located.anchor.dataset.syncKey ?? "",
      progress,
      atTop: pane.scrollTop <= 1,
      atBottom: located.max > 0 && pane.scrollTop >= located.max - 1,
    };
  };

  const applyAnchor = (pane: HTMLDivElement, anchor: SplitScrollAnchor): void => {
    const located = locateAnchor(pane);
    if (!located) {
      return;
    }
    const twin = pane.querySelector<HTMLElement>(
      `.pv-cell[data-sync-key="${CSS.escape(anchor.key)}"]`,
    );
    if (!twin) {
      return;
    }
    const paneRect = pane.getBoundingClientRect();
    const twinTop =
      twin.getBoundingClientRect().top - paneRect.top + pane.scrollTop;
    const next = anchor.atTop
      ? 0
      : anchor.atBottom
        ? located.max
        : twinTop + anchor.progress * twin.offsetHeight;
    pane.scrollTop = Math.max(0, Math.min(located.max, next));
  };

  useEffect(() => {
    scrollAnchor.current = null;
    const saved = savedState();
    if (sourceRef.current) {
      sourceRef.current.scrollTop = saved.sourceScroll ?? 0;
    }
    if (targetRef.current) {
      targetRef.current.scrollTop = saved.targetScroll ?? 0;
    }
    const save = () => {
      saveState({
        sourceScroll: sourceRef.current?.scrollTop ?? 0,
        targetScroll: targetRef.current?.scrollTop ?? 0,
      });
    };
    const source = sourceRef.current;
    const target = targetRef.current;
    let timer = 0;
    const schedule = () => {
      if (timer) {
        return;
      }
      timer = window.setTimeout(() => {
        timer = 0;
        save();
      }, 100);
    };
    source?.addEventListener("scroll", schedule, { passive: true });
    target?.addEventListener("scroll", schedule, { passive: true });
    return () => {
      if (timer) {
        window.clearTimeout(timer);
      }
      source?.removeEventListener("scroll", schedule);
      target?.removeEventListener("scroll", schedule);
    };
  }, [model.fileLabel]);

  useEffect(() => {
    const source = sourceRef.current;
    const target = targetRef.current;
    if (!source || !target) {
      return;
    }
    const sync = (from: HTMLDivElement, to: HTMLDivElement, fromSide: Side) => {
      // 隐藏侧不参与测量；可见侧无论是否双语都记录锚点，供模式切换还原。
      if (from.clientHeight === 0) {
        return;
      }
      scrollAnchor.current = readAnchor(from, fromSide);
      if (mode !== "bilingual" || to.clientHeight === 0) {
        return;
      }
      const now = performance.now();
      if (now < syncLock.current[fromSide]) {
        return;
      }
      const located = locateAnchor(from);
      if (!located) {
        return;
      }
      const twin = to.querySelector<HTMLElement>(
        `.pv-cell[data-sync-key="${CSS.escape(located.anchor.dataset.syncKey ?? "")}"]`,
      );
      if (!twin) {
        return;
      }
      const toRect = to.getBoundingClientRect();
      // offsetTop 的 offsetParent 可能是 .pv-body 而不是滚动容器，使用 rect 差更可靠。
      const twinTop =
        twin.getBoundingClientRect().top - toRect.top + to.scrollTop;
      const delta = from.scrollTop - located.anchorTop;
      const mapped =
        delta <= 0
          ? delta
          : (delta / located.anchorHeight) * twin.offsetHeight;
      const toMax = Math.max(0, to.scrollHeight - to.clientHeight);
      let next = twinTop + mapped;
      // 顶部/底部按整篇文档对齐，避免最后一块高度不同导致另一侧永远差一截。
      if (from.scrollTop <= 1) {
        next = 0;
      } else if (located.max > 0 && from.scrollTop >= located.max - 1) {
        next = toMax;
      }
      next = Math.max(0, Math.min(toMax, next));
      if (Math.abs(to.scrollTop - next) < 2) {
        return;
      }
      const toSide: Side = fromSide === "source" ? "target" : "source";
      syncLock.current[toSide] = now + 90;
      to.scrollTop = next;
    };
    const onSource = () => sync(source, target, "source");
    const onTarget = () => sync(target, source, "target");
    source.addEventListener("scroll", onSource, { passive: true });
    target.addEventListener("scroll", onTarget, { passive: true });
    return () => {
      source.removeEventListener("scroll", onSource);
      target.removeEventListener("scroll", onTarget);
    };
  }, [model.fileLabel, mode, readonly.source, readonly.target]);

  // 切换仅原文/仅译文/双语后，把最后滚动的块位置还原到新可见侧。
  useLayoutEffect(() => {
    const anchor = scrollAnchor.current;
    const source = sourceRef.current;
    const target = targetRef.current;
    if (!anchor || !source || !target) {
      return;
    }
    if (mode === "source") {
      applyAnchor(source, anchor);
    } else if (mode === "target") {
      applyAnchor(target, anchor);
    } else if (anchor.side === "source") {
      applyAnchor(target, anchor);
    } else {
      applyAnchor(source, anchor);
    }
  }, [mode]);

  const footnoteSource = model.sourceFootnotesHtml;
  const footnoteTarget = model.targetFootnotesHtml;
  const renderInsert = (side: Side, afterBlockIndex: number) => {
    if (!props.insert || props.insert.type !== side || props.insert.afterBlockIndex !== afterBlockIndex) {
      return null;
    }
    return (
      <InsertEditor
        type={side}
        onSave={props.onInsertSave}
        onCancel={props.onInsertCancel}
      />
    );
  };

  return (
    <div class="pv-split">
      <section class={`pv-split-pane${readonly.source ? " is-readonly" : ""}`} data-pane="source">
        <header class="pv-split-head">
          <span>{text.preview.panes.source}</span>
          <span class="pv-lang">{model.sourceLanguage}</span>
          <span class="pv-split-tools">
            <button
              type="button"
              class={`pv-pane-mode${readonly.source ? " is-active" : ""}`}
              disabled={props.busy}
              aria-pressed={readonly.source}
              aria-label={readonly.source ? text.preview.actions.exitReadonlyTitle : text.preview.actions.readonlyPreviewTitle}
              title={readonly.source ? text.preview.actions.exitReadonlyTitle : text.preview.actions.readonlyPreviewTitle}
              onClick={() => props.onToggleReadonly("source")}
            >
              <Icon name={readonly.source ? "lock" : "eye"} />
            </button>
          </span>
        </header>
        <div ref={sourceRef} class="pv-split-scroll" data-split-content="source">
          {mode !== "target" && renderInsert("source", -1)}
          {model.blocks.map((block) => (
            <Fragment key={`source:${block.key}`}>
              <SplitCell
                block={block}
                side="source"
                text={text}
                language={model.sourceLanguage}
                busy={props.busy}
                readonly={readonly.source}
                editing={props.editing}
                onMenu={props.onMenu}
                onStartEdit={props.onStartEdit}
                onRetranslate={props.onRetranslate}
                onSave={props.onSave}
                onCancel={props.onCancel}
                onOpenLink={props.onOpenLink}
              />
              {renderInsert("source", block.blockIndex)}
            </Fragment>
          ))}
          {footnoteSource ? (
            <article class="pv-cell" data-key="footnotes:source" data-sync-key="footnotes:source">
              <header class="pv-cell-head">
                <span class="pv-kind">{text.preview.panes.sourceFootnotes}</span>
              </header>
              <div class="pv-md" dangerouslySetInnerHTML={{ __html: footnoteSource }} />
            </article>
          ) : null}
        </div>
      </section>
      <section class={`pv-split-pane${readonly.target ? " is-readonly" : ""}`} data-pane="target">
        <header class="pv-split-head">
          <span>{text.preview.panes.target}</span>
          <span class="pv-lang">{model.targetLanguage}</span>
          <span class="pv-split-tools">
            <button
              type="button"
              class={`pv-pane-mode${readonly.target ? " is-active" : ""}`}
              disabled={props.busy}
              aria-pressed={readonly.target}
              aria-label={readonly.target ? text.preview.actions.exitReadonlyTitle : text.preview.actions.readonlyPreviewTitle}
              title={readonly.target ? text.preview.actions.exitReadonlyTitle : text.preview.actions.readonlyPreviewTitle}
              onClick={() => props.onToggleReadonly("target")}
            >
              <Icon name={readonly.target ? "lock" : "eye"} />
            </button>
          </span>
        </header>
        <div ref={targetRef} class="pv-split-scroll" data-split-content="target">
          {mode !== "source" && renderInsert("target", -1)}
          {model.blocks.map((block) => (
            <Fragment key={`target:${block.key}`}>
              <SplitCell
                block={block}
                side="target"
                text={text}
                language={model.targetLanguage}
                busy={props.busy}
                readonly={readonly.target}
                editing={props.editing}
                onMenu={props.onMenu}
                onStartEdit={props.onStartEdit}
                onRetranslate={props.onRetranslate}
                onSave={props.onSave}
                onCancel={props.onCancel}
                onOpenLink={props.onOpenLink}
              />
              {renderInsert("target", block.blockIndex)}
            </Fragment>
          ))}
          {footnoteTarget ? (
            <article class="pv-cell" data-key="footnotes:target" data-sync-key="footnotes:target">
              <header class="pv-cell-head">
                <span class="pv-kind">{text.preview.panes.targetFootnotes}</span>
              </header>
              <div class="pv-md" dangerouslySetInnerHTML={{ __html: footnoteTarget }} />
            </article>
          ) : null}
        </div>
      </section>
    </div>
  );
}

function PairedFootnotes(props: { model: PreviewModel; text: UiCatalog }) {
  const { model, text } = props;
  if (!model.sourceFootnotesHtml && !model.targetFootnotesHtml) {
    return null;
  }
  return (
    <section class="pv-footnotes">
      <div class="pv-pair">
        <div class="pv-pane pv-pane-source">
          <div class="pv-pane-label">
            <span>{text.preview.panes.sourceFootnotes}</span>
            <span class="pv-lang">{model.sourceLanguage}</span>
          </div>
          {model.sourceFootnotesHtml ? (
            <div class="pv-md" dangerouslySetInnerHTML={{ __html: model.sourceFootnotesHtml }} />
          ) : (
            <div class="pv-placeholder">
              <Icon name="info" />
              {text.preview.placeholders.noFootnotes}
            </div>
          )}
        </div>
        <div class="pv-pane pv-pane-target">
          <div class="pv-pane-label">
            <span>{text.preview.panes.targetFootnotes}</span>
            <span class="pv-lang">{model.targetLanguage}</span>
          </div>
          {model.targetFootnotesHtml ? (
            <div class="pv-md" dangerouslySetInnerHTML={{ __html: model.targetFootnotesHtml }} />
          ) : (
            <div class="pv-placeholder">
              <Icon name="info" />
              {text.preview.placeholders.noFootnotes}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

// ---- diff 弹窗 ----

function diffRowKey(row: DiffRow, index: number): string {
  return `${row.kind}-${index}-${row.left?.lineNumber ?? ""}-${row.right?.lineNumber ?? ""}`;
}

function DiffDialog(props: {
  kind: "export" | "source";
  text: UiCatalog;
  data: ExportConfirmationView | SourceConfirmationView;
  writing: boolean;
  error?: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const { text, data } = props;
  const isExport = props.kind === "export";
  const diff = data.diff;
  const title = isExport ? text.preview.modal.title : text.preview.sourceModal.title;
  const eyebrow = isExport ? text.preview.modal.eyebrow : text.preview.sourceModal.eyebrow;
  const destination = data.destination;
  const summary = isExport
    ? (data as ExportConfirmationView).summary
    : fmt(text.preview.sourceModal.summary, { count: (data as SourceConfirmationView).count });
  const currentLabel = isExport
    ? (data as ExportConfirmationView).existing
      ? text.preview.modal.currentFile
      : text.preview.modal.newFile
    : text.preview.sourceModal.currentFile;
  const rightLabel = isExport ? text.preview.modal.exportContent : text.preview.sourceModal.updatedFile;
  const writeLabel = isExport
    ? props.writing
      ? text.preview.modal.writing
      : text.preview.modal.write
    : props.writing
      ? text.preview.modal.writing
      : text.preview.sourceModal.write;
  const cancelLabel = isExport ? text.preview.modal.cancel : text.preview.sourceModal.cancel;
  const note = isExport
    ? [
        diff.coarse ? text.preview.modal.noteCoarse : "",
        diff.truncated ? text.preview.modal.noteTruncated : "",
      ]
        .filter(Boolean)
        .join(" ")
    : text.preview.sourceModal.note;
  const warning = isExport ? (data as ExportConfirmationView).warningCount : 0;

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) {
      return;
    }
    if (!dialog.open) {
      dialog.showModal();
    }
    const primary = dialog.querySelector<HTMLButtonElement>(".dialog-actions .pv-button.is-primary");
    primary?.focus();
  }, []);

  return (
    <dialog
      ref={ref}
      class="diff-dialog"
      aria-labelledby="diff-dialog-title"
      onCancel={(event) => {
        event.preventDefault();
        if (!props.writing) {
          props.onCancel();
        }
      }}
      onClick={(event) => {
        if (event.target === ref.current && !props.writing) {
          props.onCancel();
        }
      }}
    >
      <div class="dialog-inner">
        <header class="dialog-head">
          <div class="dialog-head-text">
            <p class="dialog-eyebrow">{eyebrow}</p>
            <h2 class="dialog-title" id="diff-dialog-title">{title}</h2>
          </div>
          <button type="button" class="dialog-close" aria-label={text.preview.modal.close} onClick={props.onCancel} disabled={props.writing}>
            <Icon name="close" />
          </button>
        </header>
        <dl class="dialog-meta">
          <dt>{isExport ? text.preview.modal.destination : text.preview.sourceModal.destination}</dt>
          <dd>{destination}</dd>
          <dt>{isExport ? text.preview.modal.summary : text.preview.sourceModal.summary}</dt>
          <dd>{summary}</dd>
        </dl>
        {warning > 0 ? <div class="dialog-summary">{fmt(text.preview.modal.warning, { count: warning })}</div> : null}
        {props.error ? <p class="dialog-error" role="alert">{props.error}</p> : null}
        <div class="diff-head">
          <span />
          <span>{currentLabel}</span>
          <span />
          <span>{rightLabel}</span>
        </div>
        <div class="diff-scroll">
          <div class="diff-table">
            {diff.rows.length === 0 ? (
              <div class="diff-row is-collapsed">
                <span /><span class="diff-left">{text.preview.modal.emptyDiff}</span><span /><span class="diff-right" />
              </div>
            ) : (
              diff.rows.map((row, index) => {
                if (row.kind === "collapsed" || row.kind === "truncated") {
                  const message =
                    row.kind === "truncated"
                      ? fmt(text.preview.modal.truncated, { count: row.hidden })
                      : fmt(text.preview.modal.collapsed, { count: row.hidden });
                  return (
                    <div key={diffRowKey(row, index)} class="diff-row is-collapsed">
                      <span /><span class="diff-left">{message}</span><span /><span class="diff-right" />
                    </div>
                  );
                }
                return (
                  <div
                    key={diffRowKey(row, index)}
                    class={`diff-row ${row.kind === "change" ? "is-change" : "is-unchanged"}`}
                  >
                    <span class="diff-line">{row.left?.lineNumber ?? ""}</span>
                    <span class={`diff-left${row.kind === "change" && row.left ? " is-removed" : ""}`}>
                      <span class="diff-text">{row.left?.text ?? ""}</span>
                    </span>
                    <span class="diff-line">{row.right?.lineNumber ?? ""}</span>
                    <span class={`diff-right${row.kind === "change" && row.right ? " is-added" : ""}`}>
                      <span class="diff-text">{row.right?.text ?? ""}</span>
                    </span>
                  </div>
                );
              })
            )}
          </div>
        </div>
        {note ? <p class="dialog-note">{note}</p> : null}
        <footer class="dialog-actions">
          <Button disabled={props.writing} onClick={props.onCancel}>{cancelLabel}</Button>
          <Button primary disabled={props.writing} onClick={props.onConfirm}>{writeLabel}</Button>
        </footer>
      </div>
    </dialog>
  );
}

// ---- Toast ----

function ToastHost(props: {
  toasts: Toast[];
  closeLabel: string;
  onDismiss: (id: number) => void;
}) {
  return (
    <div class="toast-host" aria-live="polite">
      {props.toasts.map((toast) => (
        <div key={toast.id} class="toast" data-tone={toast.kind}>
          <Icon
            name={
              toast.kind === "success"
                ? "pass-filled"
                : toast.kind === "error"
                  ? "error"
                  : "info"
            }
            size={15}
          />
          <span class="toast-text">{toast.text}</span>
          <button type="button" class="toast-close" aria-label={props.closeLabel} onClick={() => props.onDismiss(toast.id)}>
            <Icon name="close" size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}

function normalizeGlossaryText(value: string): string {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.replace(/\s*=>\s*/, " => "))
    .join("\n");
}

// ---- App ----

export function App(props: { boot: BootData; text: UiCatalog }) {
  const text = props.text;
  const [host, setHost] = useState<PreviewAppState>(props.boot.state);
  const [mode, setMode] = useState<Mode>(() => {
    const saved = savedState().mode;
    return saved === "source" || saved === "target" || saved === "bilingual"
      ? saved
      : "bilingual";
  });
  const [busy, setBusy] = useState(false);
  const [summaryOpen, setSummaryOpen] = useState(false);
  const [summaryDraft, setSummaryDraft] = useState(props.boot.state.model.assist.summary.text);
  const [summaryDirty, setSummaryDirty] = useState(false);
  const [glossaryDraft, setGlossaryDraft] = useState(
    props.boot.state.model.assist.summary.glossaryText ?? "",
  );
  const [glossaryDirty, setGlossaryDirty] = useState(false);
  const [assist, setAssist] = useState({
    stableTranslation: props.boot.state.model.assist.stableTranslation,
    summaryContext: props.boot.state.model.assist.summaryContext,
  });
  const [editing, setEditing] = useState<EditingState | null>(null);
  const [insert, setInsert] = useState<InsertState | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [exportDialog, setExportDialog] = useState<ExportDialogState | null>(
    props.boot.exportConfirmation
      ? { data: props.boot.exportConfirmation, writing: false }
      : null,
  );
  const [sourceDialog, setSourceDialog] = useState<SourceDialogState | null>(null);
  const toastId = useRef(0);
  const bodyRef = useRef<HTMLDivElement>(null);
  const summaryDraftRef = useRef(summaryDraft);
  const glossaryDraftRef = useRef(glossaryDraft);
  const pendingSummarySave = useRef<string | null>(null);
  const pendingGlossarySave = useRef<string | null>(null);
  summaryDraftRef.current = summaryDraft;
  glossaryDraftRef.current = glossaryDraft;

  const showToast = useCallback((message: string, kind: PreviewToastKind = "info") => {
    const id = ++toastId.current;
    setToasts((current) => [...current, { id, text: message, kind }].slice(-3));
    window.setTimeout(() => {
      setToasts((current) => current.filter((toast) => toast.id !== id));
    }, 4200);
  }, []);

  const sendMessage = useCallback((message: OutboundMessage) => {
    send(message);
    if (standaloneMode) {
      showToast(
        fmt(text.preview.modal.staticPreview, { type: message.type }),
        "info",
      );
    }
  }, [showToast, text.preview.modal.staticPreview]);

  const openMenu = useCallback((event: MouseEvent, items: MenuEntry[]) => {
    event.preventDefault();
    event.stopPropagation();
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    setMenu({ x: rect.right, y: rect.bottom + 2, items });
  }, []);

  // 宿主消息
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const message = event.data;
      if (!message || typeof message !== "object" || typeof message.type !== "string") {
        return;
      }
      switch (message.type) {
        case "state": {
          setHost(message.state);
          if (message.notice) {
            showToast(message.notice.text, message.notice.kind);
          }
          setExportDialog((current) => {
            if (current?.writing && !message.exportConfirmation) {
              return current;
            }
            return message.exportConfirmation
              ? { data: message.exportConfirmation, writing: false }
              : null;
          });
          // 只有宿主确实回写了与提交内容一致的摘要/术语表，才清除 dirty；
          // 校验失败或用户在保存期间继续输入时保留草稿。
          const savedSummary = message.state.model.assist.summary.text;
          if (pendingSummarySave.current !== null) {
            if (
              savedSummary === pendingSummarySave.current &&
              summaryDraftRef.current === pendingSummarySave.current
            ) {
              setSummaryDirty(false);
            }
            pendingSummarySave.current = null;
          }
          const savedGlossary = message.state.model.assist.summary.glossaryText ?? "";
          if (pendingGlossarySave.current !== null) {
            if (
              normalizeGlossaryText(savedGlossary) ===
                normalizeGlossaryText(pendingGlossarySave.current) &&
              glossaryDraftRef.current === pendingGlossarySave.current
            ) {
              setGlossaryDirty(false);
            }
            pendingGlossarySave.current = null;
          }
          break;
        }
        case "busy":
          setBusy(Boolean(message.busy));
          if (message.busy && message.message) {
            showToast(message.message, "info");
          }
          break;
        case "toast":
          showToast(String(message.text || ""), message.kind || "info");
          break;
        case "sourceConfirm":
          setSourceDialog({ data: message.data, writing: false });
          break;
        case "sourceSettled":
          setSourceDialog(null);
          break;
        case "sourceError":
          setSourceDialog((current) =>
            current ? { ...current, writing: false, error: message.message } : current,
          );
          break;
        case "exportSettled":
          setExportDialog(null);
          break;
        case "exportError":
          showToast(message.message, "error");
          setExportDialog((current) =>
            current ? { ...current, writing: false, error: message.message } : current,
          );
          break;
        default:
          break;
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [showToast]);

  // 首次 ready + 初始提示
  useEffect(() => {
    if (!standaloneMode) {
      send({ type: "ready" });
    }
    if (props.boot.notice) {
      showToast(props.boot.notice.text, props.boot.notice.kind);
    }
  }, [showToast]);

  // 摘要/术语表草稿：用户未编辑时跟随宿主模型，编辑中不被刷新覆盖。
  useEffect(() => {
    if (!summaryDirty) {
      setSummaryDraft(host.model.assist.summary.text);
    }
  }, [host.model.assist.summary.text, summaryDirty]);
  useEffect(() => {
    if (!glossaryDirty) {
      setGlossaryDraft(host.model.assist.summary.glossaryText ?? "");
    }
  }, [host.model.assist.summary.glossaryText, glossaryDirty]);
  useEffect(() => {
    setAssist({
      stableTranslation: host.model.assist.stableTranslation,
      summaryContext: host.model.assist.summaryContext,
    });
  }, [
    host.model.assist.stableTranslation,
    host.model.assist.summaryContext,
  ]);

  // 块被移除时关闭编辑/插入
  useEffect(() => {
    if (editing && !host.model.blocks.some((block) => block.key === editing.key)) {
      setEditing(null);
    }
  }, [editing, host.model.blocks]);

  // 模式持久化 + 页面滚动位置恢复
  useEffect(() => {
    saveState({ mode });
  }, [mode]);
  useEffect(() => {
    const body = bodyRef.current;
    if (!body) {
      return;
    }
    const saved = savedState().bodyScroll ?? 0;
    body.scrollTop = saved;
    const onScroll = () => {
      saveState({ bodyScroll: body.scrollTop });
    };
    body.addEventListener("scroll", onScroll, { passive: true });
    return () => body.removeEventListener("scroll", onScroll);
  }, [host.layout]);

  const summary = host.model.assist.summary;
  const readonly = host.readonly;
  const layout = host.layout;
  const blocks = host.model.blocks;

  const startEdit = (block: PreviewBlockView, side: Side) => {
    if (busy) {
      return;
    }
    if (layout === "split" && readonly[side]) {
      return;
    }
    if (side === "source") {
      if (block.standaloneTargetId || block.sourceDeleted) {
        return;
      }
      if (block.pendingInsertId) {
        setEditing({
          key: block.key,
          side,
          kind: "pending",
          pendingId: block.pendingInsertId,
          baseText: block.sourceRaw,
          sourceHash: "",
        });
      } else {
        setEditing({
          key: block.key,
          side,
          kind: "source",
          blockIndex: block.blockIndex,
          baseText: block.sourceRaw,
          sourceHash: block.sourceHash,
        });
      }
      return;
    }
    if (!block.canEditTarget || block.sourceDeleted) {
      return;
    }
    if (block.standaloneTargetId) {
      setEditing({
        key: block.key,
        side,
        kind: "standalone",
        standaloneId: block.standaloneTargetId,
        baseText: block.targetRaw,
        sourceHash: "",
      });
    } else {
      setEditing({
        key: block.key,
        side,
        kind: "target",
        blockIndex: block.blockIndex,
        baseText: block.targetRaw,
        sourceHash: block.sourceHash,
        cacheId: block.cacheId,
      });
    }
  };

  const saveEdit = (draft: string) => {
    if (!editing || busy) {
      return;
    }
    if (layout === "split" && readonly[editing.side]) {
      setEditing(null);
      return;
    }
    if (!draft.trim()) {
      showToast(text.preview.actions.emptyEdit, "error");
      return;
    }
    switch (editing.kind) {
      case "source":
        sendMessage({
          type: "stageSourceEdit",
          blockIndex: editing.blockIndex!,
          text: draft,
          sourceHash: editing.sourceHash,
        });
        break;
      case "pending":
        sendMessage({ type: "updateSourceInsert", pendingId: editing.pendingId!, text: draft });
        break;
      case "target":
        sendMessage({
          type: "saveTargetEdit",
          blockIndex: editing.blockIndex!,
          text: draft,
          baseText: editing.baseText,
          sourceHash: editing.sourceHash,
          ...(editing.cacheId ? { cacheId: editing.cacheId } : {}),
        });
        break;
      case "standalone":
        sendMessage({ type: "updateStandaloneTarget", standaloneId: editing.standaloneId!, text: draft });
        break;
      default:
        break;
    }
    setEditing(null);
  };

  const startInsert = (afterBlockIndex: number, type: "source" | "target") => {
    if (busy) {
      return;
    }
    if (type === "target" && mode === "source") {
      setMode("bilingual");
    }
    if (type === "source" && mode === "target") {
      setMode("bilingual");
    }
    setInsert({ afterBlockIndex, type });
  };

  const saveInsert = (draft: string) => {
    if (!insert || busy) {
      return;
    }
    if (!draft.trim()) {
      showToast(text.preview.actions.emptyEdit, "error");
      return;
    }
    sendMessage({
      type: insert.type === "target" ? "insertTargetBlock" : "insertSourceBlock",
      afterBlockIndex: insert.afterBlockIndex,
      text: draft,
    });
    setInsert(null);
  };

  const blockMenuItems = (block: PreviewBlockView, side?: Side): MenuEntry[] => {
    const items: MenuEntry[] = [];
    const isStandalone = Boolean(block.standaloneTargetId);
    const isPending = Boolean(block.pendingInsertId);
    const includeSource = side !== "target";
    const includeTarget = side !== "source";
    if (isStandalone) {
      if (includeTarget) {
        items.push(
          { label: text.preview.actions.editTarget, icon: "edit", onSelect: () => startEdit(block, "target") },
          { separator: true },
          {
            label: text.preview.actions.backTranslateTarget,
            icon: "arrow-swap",
            onSelect: () => sendMessage({ type: "backTranslateTargetOnly", standaloneId: block.standaloneTargetId! }),
          },
          {
            label: text.preview.actions.removeStandalone,
            icon: "trash",
            onSelect: () => sendMessage({ type: "deleteTargetOnlyBlock", standaloneId: block.standaloneTargetId! }),
          },
        );
      }
      return items;
    }
    if (isPending) {
      if (includeSource) {
        items.push(
          { label: text.preview.actions.editSource, icon: "edit", onSelect: () => startEdit(block, "source") },
          {
            label: text.preview.actions.removeInsert,
            icon: "trash",
            onSelect: () => sendMessage({ type: "removeSourceInsert", pendingId: block.pendingInsertId! }),
          },
        );
      }
      return items;
    }
    if (block.sourceDeleted) {
      if (includeSource) {
        items.push({
          label: text.preview.actions.undoDelete,
          icon: "history",
          onSelect: () => sendMessage({ type: "undoDeleteSourceBlock", blockIndex: block.blockIndex }),
        });
      }
      if (includeTarget) {
        items.push({
          label: text.preview.actions.revealSource,
          icon: "go-to-file",
          onSelect: () => sendMessage({ type: "revealSource", blockIndex: block.blockIndex }),
        });
      }
      return items;
    }
    if (includeSource) {
      items.push(
        { label: text.preview.actions.editSource, icon: "edit", onSelect: () => startEdit(block, "source") },
      );
      if (block.canRetranslate) {
        items.push({
          label: block.status === "deleted" ? text.preview.actions.resumeTranslate : block.hasCache ? text.preview.actions.retranslate : text.preview.actions.translate,
          icon: "refresh",
          onSelect: () => sendMessage({ type: "retranslateBlock", blockIndex: block.blockIndex }),
        });
      }
      items.push({
        label: text.preview.actions.revealSource,
        icon: "go-to-file",
        disabled: !block.sourceHash,
        onSelect: () => sendMessage({ type: "revealSource", blockIndex: block.blockIndex }),
      });
    }
    if (includeTarget) {
      if (block.status === "deleted") {
        items.push({
          label: text.preview.actions.undoDelete,
          icon: "history",
          onSelect: () => sendMessage({ type: "undoDeleteTargetBlock", blockIndex: block.blockIndex }),
        });
      } else {
        if (block.canEditTarget) {
          items.push({
            label: text.preview.actions.editTarget,
            icon: "edit",
            onSelect: () => startEdit(block, "target"),
          });
        }
        if (block.canMarkSynced) {
          items.push({
            label: text.preview.actions.markSynced,
            icon: "check",
            onSelect: () => sendMessage({ type: "markSynced", blockIndex: block.blockIndex }),
          });
        }
        if (block.canBackTranslate) {
          items.push({
            label: text.preview.actions.backTranslate,
            icon: "arrow-swap",
            onSelect: () => sendMessage({ type: "backTranslate", blockIndex: block.blockIndex }),
          });
        }
      }
      if (!block.sourceDeleted) {
        items.push(
          { separator: true },
          {
            label: `${text.preview.actions.insertBlock}: ${text.preview.actions.sourceChoice}`,
            icon: "diff-added",
            onSelect: () => startInsert(block.blockIndex, "source"),
          },
          {
            label: `${text.preview.actions.insertBlock}: ${text.preview.actions.targetChoice}`,
            icon: "diff-added",
            onSelect: () => startInsert(block.blockIndex, "target"),
          },
          { separator: true },
          {
            label: text.preview.actions.deleteTranslation,
            icon: "trash",
            disabled: block.status === "deleted",
            onSelect: () => sendMessage({ type: "deleteTargetBlock", blockIndex: block.blockIndex }),
          },
          {
            label: text.preview.actions.deleteBlock,
            icon: "trash",
            disabled: block.sourceDeleted,
            onSelect: () => sendMessage({ type: "deleteSourceBlock", blockIndex: block.blockIndex }),
          },
        );
      }
    }
    if (side === "source" && !block.sourceDeleted && !isStandalone) {
      // 分栏源单元格只提供源侧插入/删除；目标侧操作在译文单元格中。
      items.push(
        { separator: true },
        { label: text.preview.actions.insertBlock, icon: "diff-added", onSelect: () => startInsert(block.blockIndex, "source") },
        { label: text.preview.actions.deleteSourceBlock, icon: "trash", onSelect: () => sendMessage({ type: "deleteSourceBlock", blockIndex: block.blockIndex }) },
      );
    }
    return items;
  };

  const toolbarMenu = (event: MouseEvent) => {
    const items: MenuEntry[] = [
      {
        label: text.preview.toolbar.importTranslation,
        icon: "cloud-download",
        disabled: busy,
        onSelect: () => sendMessage({ type: "importTranslation" }),
      },
      {
        label: text.preview.toolbar.checkConsistency,
        icon: "checklist",
        disabled: !host.model.cacheExists || busy,
        onSelect: () => sendMessage({ type: "checkConsistency" }),
      },
      {
        label: text.preview.toolbar.refresh,
        icon: "refresh",
        disabled: busy,
        onSelect: () => sendMessage({ type: "refresh" }),
      },
      { label: text.preview.toolbar.editCache, icon: "edit", onSelect: () => sendMessage({ type: "editCache" }) },
      { label: text.preview.toolbar.openCacheFolder, icon: "folder-opened", onSelect: () => sendMessage({ type: "openCacheFolder" }) },
      { separator: true },
      {
        label: text.preview.subbar.retranslateAll,
        icon: "sync",
        disabled: !host.model.cacheExists || busy,
        onSelect: () => sendMessage({ type: "retranslateAll" }),
      },
      {
        label: fmt(text.preview.subbar.retranslateStale, { count: host.model.counts.stale }),
        icon: "history",
        disabled: host.model.counts.stale === 0 || busy,
        onSelect: () => sendMessage({ type: "retranslateStale" }),
      },
      {
        label: text.preview.actions.insertAtStart,
        icon: "diff-added",
        disabled: busy,
        onSelect: () => startInsert(-1, "source"),
      },
      { separator: true },
      {
        label: fmt(text.preview.actions.applySource, { count: host.model.pendingSourceCount }),
        icon: "check-all",
        disabled: host.model.pendingSourceCount === 0 || busy,
        onSelect: () => sendMessage({ type: "applySourceEdits" }),
      },
      {
        label: text.preview.actions.resetSource,
        icon: "trash",
        disabled: host.model.pendingSourceCount === 0 || busy,
        onSelect: () => sendMessage({ type: "discardSourceEdits" }),
      },
    ];
    openMenu(event, items);
  };

  const handleMode = (next: Mode) => {
    setMode(next);
    saveState({ mode: next });
  };
  const handleLayout = (next: PreviewLayout) => {
    if (next === layout) {
      return;
    }
    setHost((current) => ({ ...current, layout: next }));
    sendMessage({ type: "setLayout", layout: next });
  };
  const toggleReadonly = (side: Side) => {
    if (busy) {
      return;
    }
    if (editing?.side === side) {
      setEditing(null);
    }
    setHost((current) => ({
      ...current,
      readonly: { ...current.readonly, [side]: !current.readonly[side] },
    }));
    sendMessage({ type: "togglePaneReadonly", pane: side });
  };
  const retranslateBlock = (block: PreviewBlockView) => {
    if (busy) {
      return;
    }
    const index = block.blockIndex;
    if (index >= 0) {
      sendMessage({ type: "retranslateBlock", blockIndex: index });
    }
  };
  const saveSummary = () => {
    if (busy) {
      return;
    }
    if (!summaryDraft.trim()) {
      showToast(text.preview.summary.empty, "error");
      return;
    }
    pendingSummarySave.current = summaryDraft;
    sendMessage({ type: "saveSummary", summaryText: summaryDraft });
  };
  const saveGlossary = () => {
    if (busy) {
      return;
    }
    pendingGlossarySave.current = glossaryDraft;
    sendMessage({ type: "saveGlossary", glossaryText: glossaryDraft });
  };

  const openBlockMenu = (
    event: MouseEvent,
    block: PreviewBlockView,
    side?: Side,
  ) => {
    if (busy) {
      return;
    }
    openMenu(event, blockMenuItems(block, side));
  };

  return (
    <div
      class={`pv-app${busy ? " is-busy" : ""}`}
      data-layout={layout}
      data-mode={mode}
    >
      <Toolbar
        model={host.model}
        text={text}
        busy={busy}
        onSync={() => sendMessage({ type: "sync" })}
        onExport={() => sendMessage({ type: "export" })}
        onRefresh={() => sendMessage({ type: "refresh" })}
        toolbarMenu={toolbarMenu}
      />
      <ContextBar
        model={host.model}
        text={text}
        mode={mode}
        layout={layout}
        busy={busy}
        summaryOpen={summaryOpen}
        onMode={handleMode}
        onLayout={handleLayout}
        onToggleSummary={() => setSummaryOpen((open) => !open)}
      />
      <Notices
        model={host.model}
        text={text}
        busy={busy}
        onApplySource={() => sendMessage({ type: "applySourceEdits" })}
        onDiscardSource={() => sendMessage({ type: "discardSourceEdits" })}
        onRetranslateStale={() => sendMessage({ type: "retranslateStale" })}
      />
      {blocks.length === 0 ? null : (
        <SummaryPanel
          text={text}
          summary={summary}
          open={summaryOpen}
          busy={busy}
          stableTranslation={assist.stableTranslation}
          summaryContext={assist.summaryContext}
          summaryDraft={summaryDraft}
          glossaryDraft={glossaryDraft}
          onToggle={() => setSummaryOpen((open) => !open)}
          onDraft={(value) => {
            setSummaryDirty(true);
            setSummaryDraft(value);
          }}
          onGlossaryDraft={(value) => {
            setGlossaryDirty(true);
            setGlossaryDraft(value);
          }}
          onGenerate={() => {
            if (busy) return;
            pendingSummarySave.current = null;
            pendingGlossarySave.current = null;
            setSummaryDirty(false);
            setGlossaryDirty(false);
            sendMessage({ type: "generateSummary" });
          }}
          onSave={saveSummary}
          onClear={() => {
            if (busy) return;
            pendingSummarySave.current = null;
            pendingGlossarySave.current = null;
            setSummaryDirty(false);
            setGlossaryDirty(false);
            sendMessage({ type: "clearSummary" });
          }}
          onSaveGlossary={saveGlossary}
          onAssist={(key, value) => {
            if (busy) return;
            setAssist((current) => ({ ...current, [key]: value }));
            sendMessage({ type: "setAssistToggle", key, value });
          }}
        />
      )}
      <div ref={bodyRef} class={`pv-body${layout === "split" ? " is-split" : ""}`}>
        {blocks.length === 0 ? (
          <div class="pv-empty">
            <Icon name="book" size={32} />
            <h2 class="pv-empty-title">{text.preview.placeholders.emptyDocument}</h2>
            <Button primary disabled={busy} onClick={() => sendMessage({ type: "sync" })}>
              <Icon name="sync" size={14} />
              {text.preview.toolbar.sync}
            </Button>
          </div>
        ) : layout === "split" ? (
          <SplitView
            model={host.model}
            text={text}
            mode={mode}
            readonly={readonly}
            busy={busy}
            editing={editing}
            insert={insert}
            onMenu={openBlockMenu}
            onRetranslate={retranslateBlock}
            onStartEdit={startEdit}
            onSave={saveEdit}
            onCancel={() => setEditing(null)}
            onOpenLink={(href) => sendMessage({ type: "openLink", href })}
            onInsertSave={saveInsert}
            onInsertCancel={() => setInsert(null)}
            onToggleReadonly={toggleReadonly}
          />
        ) : (
          <div class="pv-paired">
            {insert?.afterBlockIndex === -1 ? (
              <InsertEditor
                type={insert.type}
                onSave={saveInsert}
                onCancel={() => setInsert(null)}
              />
            ) : null}
            {blocks.map((block) => (
              <PairedBlock
                key={block.key}
                block={block}
                text={text}
                sourceLanguage={host.model.sourceLanguage}
                targetLanguage={host.model.targetLanguage}
                busy={busy}
                readonly={false}
                editing={editing}
                insert={insert}
                onMenu={(event, target, side) => openBlockMenu(event, target, side)}
                onRetranslate={retranslateBlock}
                onStartEdit={startEdit}
                onSave={saveEdit}
                onCancel={() => setEditing(null)}
                onOpenLink={(href) => sendMessage({ type: "openLink", href })}
                onInsertSave={saveInsert}
                onInsertCancel={() => setInsert(null)}
              />
            ))}
            <PairedFootnotes model={host.model} text={text} />
          </div>
        )}
      </div>
      {menu ? <Menu state={menu} onClose={() => setMenu(null)} /> : null}
      {exportDialog ? (
        <DiffDialog
          kind="export"
          text={text}
          data={exportDialog.data}
          writing={exportDialog.writing}
          error={exportDialog.error}
          onCancel={() => {
            setExportDialog(null);
            sendMessage({ type: "exportCancel" });
          }}
          onConfirm={() => {
            setExportDialog((current) => (current ? { ...current, writing: true, error: undefined } : current));
            sendMessage({ type: "exportWrite" });
          }}
        />
      ) : null}
      {sourceDialog ? (
        <DiffDialog
          kind="source"
          text={text}
          data={sourceDialog.data}
          writing={sourceDialog.writing}
          error={sourceDialog.error}
          onCancel={() => {
            setSourceDialog(null);
            sendMessage({ type: "cancelSourceWrite" });
          }}
          onConfirm={() => {
            setSourceDialog((current) => (current ? { ...current, writing: true, error: undefined } : current));
            sendMessage({ type: "writeSourceEdits" });
          }}
        />
      ) : null}
      <ToastHost
        toasts={toasts}
        closeLabel={text.preview.modal.close}
        onDismiss={(id) => setToasts((current) => current.filter((toast) => toast.id !== id))}
      />
    </div>
  );
}
