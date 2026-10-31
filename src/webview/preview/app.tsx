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
import {
  BRIEF_FIELD_LIMIT,
  briefFilledCount,
  briefSaveSignature,
  normalizeBriefDraft,
} from "./briefModel";
import {
  GLOSSARY_MAX_ENTRIES,
  GLOSSARY_MAX_TERM_LENGTH,
  cleanGlossaryText,
  parseGlossaryRows,
  serializeGlossaryRows,
  validateGlossaryRows,
  type GlossaryRow,
} from "./glossaryModel";
import type {
  ReviewOption,
  TranslationBrief,
} from "../../translation/types";
import {
  isUserAnnotationPending,
  MAX_ANNOTATION_MESSAGE,
  type AnnotationView,
} from "../../annotations/types";
import type {
  BlockSelection,
  BootData,
  MenuEntry,
  OutboundMessage,
  UiCatalog,
} from "./types";

type Mode = "bilingual" | "source" | "target";
type Side = "source" | "target";
type BulkAction =
  | "retranslate"
  | "review"
  | "backTranslate"
  | "markSynced"
  | "deleteTranslation";
type Summary = PreviewModel["assist"]["summary"];

/** 选择快照签名：内容、锚点或锁定态变化时，旧选择不能继续用于批量操作。 */
function blockSelectionSignature(block: PreviewBlockView): string {
  return [
    block.sourceHash,
    block.cacheId ?? "",
    block.cacheDst ?? "",
    String(block.human),
  ].join("|");
}

/** 多选/拖选时命中的块 key；只认带 data-key 的块或分栏单元格。 */
function selectionKeyFromTarget(target: EventTarget | null): string | null {
  if (!(target instanceof Element)) {
    return null;
  }
  const node = target.closest<HTMLElement>(
    ".pv-block[data-key], .pv-cell[data-key]",
  );
  return node?.dataset.key ?? null;
}

/** 交互控件不参与块选择，避免误触链接、按钮和编辑器。 */
function isSelectionInteractiveTarget(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    Boolean(
      target.closest(
        "a,button,input,textarea,select,label,summary,dialog",
      ),
    )
  );
}

interface DragSelectionState {
  pointerId: number;
  mode: "select" | "deselect";
  anchorKey: string;
  lastKey: string;
  startX: number;
  startY: number;
  started: boolean;
}

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
  kind: PreviewToastKind;}

interface SplitScrollAnchor {
  side: Side;
  key: string;
  /** 当前块内的滚动进度（0–1）。 */
  progress: number;
  atTop: boolean;
  atBottom: boolean;
}

interface AnnotationTarget {
  block: PreviewBlockView;
  x: number;
  y: number;
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
  className?: string;
  disabled?: boolean;
  title?: string;
  onClick?: (event: MouseEvent) => void;
}) {
  return (
    <button
      type="button"
      class={`pv-button${props.primary ? " is-primary" : ""}${
        props.className ? ` ${props.className}` : ""
      }`}
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
      aria-pressed={props.active === undefined ? undefined : props.active}
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

// ---- 批注 ----

type AnnotationUpdateInput = {
  message?: string;
  mode?: "once" | "persistent";
  side?: Side;
  reactivate?: boolean;
};

function annotationKindLabel(
  annotation: AnnotationView,
  text: UiCatalog,
): string {
  if (annotation.author === "user") {
    return "";
  }
  switch (annotation.kind) {
    case "source-issue":
      return text.preview.annotations.typeSourceIssue;
    case "translation-uncertain":
      return text.preview.annotations.typeTranslationUncertain;
    case "term":
      return text.preview.annotations.typeTerm;
    case "structure":
      return text.preview.annotations.typeStructure;
    default:
      return annotation.kind;
  }
}

function userAnnotationStatusLabel(
  annotation: AnnotationView,
  text: UiCatalog,
): string {
  if (annotation.status === "pending" || annotation.status === "open") {
    return text.preview.annotations.statusPending;
  }
  if (annotation.status === "applied") {
    return text.preview.annotations.statusApplied;
  }
  if (annotation.status === "ineffective") {
    return text.preview.annotations.statusIneffective;
  }
  return text.preview.annotations.statusArchived;
}

function userAnnotationStatusClass(annotation: AnnotationView): string {
  if (annotation.status === "pending" || annotation.status === "open") {
    return "is-pending";
  }
  if (annotation.status === "applied") {
    return "is-applied";
  }
  if (annotation.status === "ineffective") {
    return "is-ineffective";
  }
  return "is-inactive";
}

function annotationNeedsAttention(annotation: AnnotationView): boolean {
  if (annotation.author === "ai") {
    return annotation.status === "open";
  }
  return (
    isUserAnnotationPending(annotation) ||
    annotation.status === "ineffective"
  );
}

function isAnnotationDimmed(annotation: AnnotationView): boolean {
  return annotation.author === "ai" && annotation.status === "dismissed";
}

function AnnotationItem(props: {
  annotation: AnnotationView;
  text: UiCatalog;
  busy: boolean;
  onStatus: (
    annotationId: string,
    status: "open" | "resolved" | "dismissed",
  ) => void;
  onDelete: (annotationId: string) => void;
  onUpdate: (annotationId: string, input: AnnotationUpdateInput) => void;
  onAdoptAnswer: (annotation: AnnotationView, option: ReviewOption) => void;
  onPrepareAnswer: (
    annotation: AnnotationView,
    text: string,
    mode?: "once" | "persistent",
  ) => void;
  canAnnotate: boolean;
}) {
  const { annotation, text } = props;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(annotation.message);
  const [draftMode, setDraftMode] = useState<"once" | "persistent">(
    annotation.mode ?? "once",
  );
  const [draftSide, setDraftSide] = useState<Side>(annotation.side);
  const isUser = annotation.author === "user";
  const options = annotation.options ?? [];
  const instructions = options.filter(
    (option) => option.kind === "instruction",
  );
  const advices = options.filter((option) => option.kind === "advice");

  const startEdit = () => {
    setDraft(annotation.message);
    setDraftMode(annotation.mode ?? "once");
    setDraftSide(annotation.side);
    setEditing(true);
  };
  const saveEdit = () => {
    const message = draft.trim();
    if (!message) {
      return;
    }
    props.onUpdate(annotation.id, {
      message,
      mode: draftMode,
      side: draftSide,
    });
    setEditing(false);
  };

  const actions = isUser ? (
    <span class="pv-annotation-actions">
      <button
        type="button"
        class="pv-link"
        disabled={props.busy || editing}
        onClick={startEdit}
      >
        {text.preview.annotations.edit}
      </button>
      {annotation.status === "ineffective" ? (
        <button
          type="button"
          class="pv-link"
          disabled={props.busy || editing}
          onClick={() =>
            props.onUpdate(annotation.id, { reactivate: true })
          }
        >
          {text.preview.annotations.retry}
        </button>
      ) : null}
      <button
        type="button"
        class="pv-link is-danger"
        disabled={props.busy || editing}
        onClick={() => props.onDelete(annotation.id)}
      >
        {text.preview.annotations.delete}
      </button>
    </span>
  ) : (
    <span class="pv-annotation-actions">
      {annotation.status === "open" ? (
        <>
          <button
            type="button"
            class="pv-link"
            disabled={props.busy}
            onClick={() => props.onStatus(annotation.id, "resolved")}
          >
            {text.preview.annotations.resolve}
          </button>
          <button
            type="button"
            class="pv-link"
            disabled={props.busy}
            onClick={() => props.onStatus(annotation.id, "dismissed")}
          >
            {text.preview.annotations.dismiss}
          </button>
        </>
      ) : (
        <button
          type="button"
          class="pv-link"
          disabled={props.busy}
          onClick={() => props.onStatus(annotation.id, "open")}
        >
          {text.preview.annotations.reopen}
        </button>
      )}
      <button
        type="button"
        class="pv-link is-danger"
        disabled={props.busy}
        onClick={() => props.onDelete(annotation.id)}
      >
        {text.preview.annotations.delete}
      </button>
    </span>
  );

  const kindLabel = annotationKindLabel(annotation, text);
  return (
    <article
      class={`pv-annotation${
        isAnnotationDimmed(annotation) ? " is-dimmed" : ""
      }`}
    >
      <div class="pv-annotation-meta">
        <span class="pv-annotation-tags">
          {isUser ? (
            <>
              <span
                class={`pv-annotation-mode is-${
                  annotation.mode ?? "persistent"
                }`}
              >
                {annotation.mode === "once"
                  ? text.preview.annotations.modeOnceBadge
                  : text.preview.annotations.modePersistentBadge}
              </span>
              <span class="pv-annotation-separator" aria-hidden="true">
                ·
              </span>
              <span
                class={`pv-annotation-state ${userAnnotationStatusClass(
                  annotation,
                )}`}
                title={text.preview.annotations.statusHint}
              >
                {userAnnotationStatusLabel(annotation, text)}
              </span>
              {annotation.mode === "once" &&
              (annotation.status === "applied" ||
                annotation.status === "ineffective") ? (
                <span class="pv-annotation-state is-inactive">
                  {text.preview.annotations.statusInactive}
                </span>
              ) : null}
              {annotation.originAnnotationId ? (
                <span class="pv-annotation-origin">
                  {text.preview.annotations.fromAi}
                </span>
              ) : null}
            </>
          ) : (
            <>
              <span class="pv-annotation-kind">{kindLabel}</span>
              <span class="pv-annotation-separator" aria-hidden="true">
                ·
              </span>
            </>
          )}
          <span class="pv-annotation-side-label">
            {annotation.side === "source"
              ? text.preview.panes.source
              : text.preview.panes.target}
          </span>
          {annotation.author === "ai" ? (
            annotation.status === "open" ? (
              <span
                class={`pv-annotation-severity is-${annotation.severity}`}
              >
                {annotation.severity === "check"
                  ? text.preview.annotations.severityCheck
                  : text.preview.annotations.severityInfo}
              </span>
            ) : annotation.answeredBy ? (
              <span class="pv-annotation-answered">
                {text.preview.annotations.answered}
              </span>
            ) : (
              <span class={`pv-annotation-state is-${annotation.status}`}>
                {annotation.status === "dismissed"
                  ? text.preview.annotations.statusDismissed
                  : text.preview.annotations.statusChecked}
              </span>
            )
          ) : null}
          {annotation.stale ? (
            <span
              class="pv-annotation-stale"
              title={text.preview.annotations.stale}
            >
              !
            </span>
          ) : null}
        </span>
        {actions}
      </div>
      {editing ? (
        <div class="pv-annotation-edit">
          <textarea
            class="pv-textarea"
            rows={3}
            value={draft}
            maxLength={MAX_ANNOTATION_MESSAGE}
            spellcheck={false}
            aria-label={text.preview.annotations.edit}
            onInput={(event) => setDraft(event.currentTarget.value)}
          />
          <div class="pv-annotation-edit-actions">
            <label
              class="pv-check"
              title={text.preview.annotations.modeOnceHint}
            >
              <input
                type="checkbox"
                checked={draftMode === "once"}
                onChange={(event) =>
                  setDraftMode(
                    event.currentTarget.checked ? "once" : "persistent",
                  )
                }
              />
              {text.preview.annotations.modeOnce}
            </label>
            <select
              class="pv-input pv-annotation-side-select"
              aria-label={text.preview.annotations.side}
              title={text.preview.annotations.sideHint}
              value={draftSide}
              onChange={(event) =>
                setDraftSide(event.currentTarget.value as Side)
              }
            >
              <option value="source">{text.preview.panes.source}</option>
              <option value="target">{text.preview.panes.target}</option>
            </select>
            <Button
              disabled={props.busy || !draft.trim()}
              onClick={saveEdit}
            >
              {text.preview.annotations.saveEdit}
            </Button>
            <Button disabled={props.busy} onClick={() => setEditing(false)}>
              {text.preview.annotations.cancelEdit}
            </Button>
          </div>
        </div>
      ) : (
        <p class="pv-annotation-message">{annotation.message}</p>
      )}
      {!editing &&
      (annotation.question || options.length > 0) ? (
        <details class="pv-annotation-details">
          <summary>{text.preview.annotations.details}</summary>
          {annotation.question ? (
            <p class="pv-annotation-question">{annotation.question}</p>
          ) : null}
          {options.length > 0 ? (
            <section class="pv-annotation-answer-section">
              <p class="pv-annotation-answer-label">
                {text.preview.annotations.optionsLabel}
              </p>
              {instructions.length > 0 ? (
                <div class="pv-annotation-answer-list">
                  {instructions.map((option, index) => (
                    <div
                      class="pv-annotation-answer-row"
                      key={`${index}-${option.text.slice(0, 32)}`}
                    >
                      <span class="pv-annotation-answer-index">
                        {index + 1}
                      </span>
                      <p class="pv-annotation-answer-text">
                        <span
                          class={`pv-annotation-mode is-${option.mode ?? "once"}`}
                        >
                          {option.mode === "persistent"
                            ? text.preview.annotations.modePersistentBadge
                            : text.preview.annotations.modeOnceBadge}
                        </span>{" "}
                        {option.text}
                      </p>
                      {annotation.author === "ai" &&
                      annotation.status === "open" &&
                      props.canAnnotate ? (
                        <div class="pv-annotation-answer-actions">
                          <button
                            type="button"
                            class="pv-link"
                            disabled={props.busy}
                            aria-label={`${text.preview.annotations.adoptAnswer} ${
                              index + 1
                            }: ${option.text.slice(0, 40)}`}
                            onClick={() =>
                              props.onAdoptAnswer(annotation, option)
                            }
                          >
                            {text.preview.annotations.adoptAnswer}
                          </button>
                          <button
                            type="button"
                            class="pv-link"
                            disabled={props.busy}
                            aria-label={`${text.preview.annotations.editAnswer} ${
                              index + 1
                            }: ${option.text.slice(0, 40)}`}
                            onClick={() =>
                              props.onPrepareAnswer(
                                annotation,
                                option.text,
                                option.mode,
                              )
                            }
                          >
                            {text.preview.annotations.editAnswer}
                          </button>
                        </div>
                      ) : null}
                    </div>
                  ))}
                </div>
              ) : null}
              {advices.map((option, index) => (
                <p
                  class="pv-annotation-advice"
                  key={`advice-${index}-${option.text.slice(0, 32)}`}
                >
                  <span class="pv-annotation-advice-label">
                    {text.preview.annotations.adviceLabel}
                  </span>
                  {option.text}
                </p>
              ))}
              {annotation.author === "ai" &&
              annotation.status === "open" &&
              props.canAnnotate ? (
                <button
                  type="button"
                  class="pv-link pv-annotation-answer-write"
                  disabled={props.busy}
                  onClick={() => props.onPrepareAnswer(annotation, "")}
                >
                  <Icon name="edit" />
                  {text.preview.annotations.writeAnswer}
                </button>
              ) : null}
            </section>
          ) : annotation.author === "ai" &&
            annotation.question &&
            annotation.status === "open" &&
            props.canAnnotate ? (
            <button
              type="button"
              class="pv-link pv-annotation-answer-write"
              disabled={props.busy}
              onClick={() => props.onPrepareAnswer(annotation, "")}
            >
              <Icon name="edit" />
              {text.preview.annotations.writeAnswer}
            </button>
          ) : null}
        </details>
      ) : null}
    </article>
  );
}

function AnnotationGroup(props: {
  title: string;
  annotations: readonly AnnotationView[];
  open: boolean;
  onToggle: () => void;
  text: UiCatalog;
  busy: boolean;
  onStatus: (
    annotationId: string,
    status: "open" | "resolved" | "dismissed",
  ) => void;
  onDelete: (annotationId: string) => void;
  onUpdate: (annotationId: string, input: AnnotationUpdateInput) => void;
  onAdoptAnswer: (annotation: AnnotationView, option: ReviewOption) => void;
  onPrepareAnswer: (
    annotation: AnnotationView,
    text: string,
    mode?: "once" | "persistent",
  ) => void;
  canAnnotate: boolean;
}) {
  if (props.annotations.length === 0) {
    return null;
  }
  return (
    <section class={`pv-annotation-group${props.open ? " is-open" : ""}`}>
      <button
        type="button"
        class="pv-annotation-group-head"
        aria-expanded={props.open}
        onClick={props.onToggle}
      >
        <Icon name="chevron-down" />
        <span class="pv-annotation-group-title">{props.title}</span>
        <span class="pv-annotation-group-count">
          {props.annotations.length}
        </span>
      </button>
      {props.open ? (
        <div class="pv-annotation-group-body">
          {props.annotations.map((annotation) => (
            <AnnotationItem
              key={annotation.id}
              annotation={annotation}
              text={props.text}
              busy={props.busy}
              onStatus={props.onStatus}
              onDelete={props.onDelete}
              onUpdate={props.onUpdate}
              onAdoptAnswer={props.onAdoptAnswer}
              onPrepareAnswer={props.onPrepareAnswer}
              canAnnotate={props.canAnnotate}
            />
          ))}
        </div>
      ) : null}
    </section>
  );
}

function AnnotationPopover(props: {
  target: AnnotationTarget;
  block: PreviewBlockView;
  text: UiCatalog;
  busy: boolean;
  reviewSupported: boolean;
  annotationsSupported: boolean;
  onClose: () => void;
  onReview: () => void;
  onSave: (input: {
    side: "source" | "target";
    mode: "once" | "persistent";
    message: string;
    originAnnotationId?: string;
    resolveAnnotationId?: string;
  }) => void;
  onStatus: (
    annotationId: string,
    status: "open" | "resolved" | "dismissed",
  ) => void;
  onDelete: (annotationId: string) => void;
  onUpdate: (annotationId: string, input: AnnotationUpdateInput) => void;
}) {
  const text = props.text;
  const ref = useRef<HTMLDivElement>(null);
  const composeRef = useRef<HTMLTextAreaElement>(null);
  const [position, setPosition] = useState({
    left: props.target.x,
    top: props.target.y,
  });
  const positionRef = useRef(position);
  positionRef.current = position;
  const customPositionRef = useRef(false);
  const dragRef = useRef<{
    startX: number;
    startY: number;
    left: number;
    top: number;
  } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [draft, setDraft] = useState("");
  const [pendingMessage, setPendingMessage] = useState<string | null>(null);
  const [once, setOnce] = useState(true);
  const [answerOrigin, setAnswerOrigin] = useState<AnnotationView | null>(
    null,
  );
  const [side, setSide] = useState<"source" | "target">(
    props.block.targetRaw.trim() ? "target" : "source",
  );
  const [openGroups, setOpenGroups] = useState({ ai: true, user: true });

  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) {
      return;
    }
    const place = () => {
      const rect = node.getBoundingClientRect();
      if (customPositionRef.current) {
        const current = positionRef.current;
        setPosition({
          left: Math.min(
            Math.max(4, window.innerWidth - rect.width - 4),
            Math.max(4, current.left),
          ),
          top: Math.min(
            Math.max(4, window.innerHeight - rect.height - 4),
            Math.max(4, current.top),
          ),
        });
        return;
      }
      let left = props.target.x - rect.width;
      let top = props.target.y;
      if (left < 4) {
        left = 4;
      }
      if (left + rect.width > window.innerWidth - 4) {
        left = Math.max(4, window.innerWidth - rect.width - 4);
      }
      if (top + rect.height > window.innerHeight - 4) {
        top = Math.max(4, props.target.y - rect.height - 8);
      }
      setPosition({ left, top });
    };
    place();
    window.addEventListener("resize", place);
    if (typeof ResizeObserver === "undefined") {
      return () => window.removeEventListener("resize", place);
    }
    const observer = new ResizeObserver(place);
    observer.observe(node);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", place);
    };
  }, [props.target]);

  useEffect(() => {
    composeRef.current?.focus();
  }, []);

  useEffect(() => {
    const blockKey = props.block.key;
    return () => {
      window.setTimeout(() => {
        const active = document.activeElement;
        if (active && active !== document.body) {
          return;
        }
        const badge = Array.from(
          document.querySelectorAll<HTMLElement>(".pv-annotation-badge"),
        ).find((element) => element.dataset.blockKey === blockKey);
        const blockNode = badge
          ? undefined
          : Array.from(
              document.querySelectorAll<HTMLElement>(".pv-block, .pv-cell"),
            ).find((element) => element.dataset.key === blockKey);
        (badge ?? blockNode?.querySelector<HTMLElement>(".pv-action"))?.focus();
      }, 0);
    };
  }, [props.block.key]);

  useEffect(() => {
    if (!pendingMessage) {
      return;
    }
    const saved = (props.block.annotations ?? []).some(
      (annotation) =>
        annotation.author === "user" &&
        annotation.message === pendingMessage,
    );
    if (saved) {
      setPendingMessage(null);
      setDraft("");
      setOnce(true);
      setAnswerOrigin(null);
    }
  }, [pendingMessage, props.block.annotations]);

  useEffect(() => {
    if (!answerOrigin) {
      return;
    }
    const current = (props.block.annotations ?? []).find(
      (annotation) => annotation.id === answerOrigin.id,
    );
    if (!current || current.status !== "open") {
      setAnswerOrigin(null);
    }
  }, [answerOrigin, props.block.annotations]);

  useEffect(() => {
    const onPointerDown = (event: MouseEvent) => {
      if (!(event.target instanceof Node) || !ref.current?.contains(event.target)) {
        props.onClose();
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        props.onClose();
      }
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [props.onClose]);

  const startDrag = (event: JSX.TargetedPointerEvent<HTMLElement>) => {
    if (event.button !== 0) {
      return;
    }
    const target = event.target as HTMLElement | null;
    if (target?.closest("button, input, select, textarea, a")) {
      return;
    }
    const node = ref.current;
    if (!node) {
      return;
    }
    const rect = node.getBoundingClientRect();
    dragRef.current = {
      startX: event.clientX,
      startY: event.clientY,
      left: rect.left,
      top: rect.top,
    };
    customPositionRef.current = true;
    setDragging(true);
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // 合成事件或指针已释放时允许继续拖动。
    }
    event.preventDefault();
  };
  const moveDrag = (event: JSX.TargetedPointerEvent<HTMLElement>) => {
    const drag = dragRef.current;
    const node = ref.current;
    if (!drag || !node) {
      return;
    }
    const rect = node.getBoundingClientRect();
    setPosition({
      left: Math.min(
        Math.max(4, window.innerWidth - rect.width - 4),
        Math.max(4, drag.left + event.clientX - drag.startX),
      ),
      top: Math.min(
        Math.max(4, window.innerHeight - rect.height - 4),
        Math.max(4, drag.top + event.clientY - drag.startY),
      ),
    });
  };
  const endDrag = (event: JSX.TargetedPointerEvent<HTMLElement>) => {
    if (!dragRef.current) {
      return;
    }
    dragRef.current = null;
    setDragging(false);
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // 指针已释放时忽略。
    }
  };

  const annotations = [...(props.block.annotations ?? [])].sort(
    (left, right) =>
      (annotationNeedsAttention(left) ? 0 : 1) -
      (annotationNeedsAttention(right) ? 0 : 1),
  );
  const aiAnnotations = annotations.filter(
    (annotation) => annotation.author === "ai",
  );
  const userAnnotations = annotations.filter(
    (annotation) => annotation.author === "user",
  );
  const canReview =
    props.reviewSupported &&
    props.block.hasCache &&
    props.block.status !== "deleted" &&
    props.block.status !== "copy" &&
    Boolean(props.block.targetRaw.trim()) &&
    !props.block.standaloneTargetId &&
    !props.block.pendingInsertId;
  const canAnnotate =
    props.block.status !== "deleted" &&
    !props.block.status.startsWith("copy");
  const humanLocked =
    props.block.human && props.block.status !== "deleted";

  const adoptAnswer = (annotation: AnnotationView, option: ReviewOption) => {
    if (!canAnnotate || option.kind !== "instruction") {
      return;
    }
    props.onSave({
      side: annotation.side,
      mode: option.mode ?? "once",
      message: option.text,
      originAnnotationId: annotation.id,
      resolveAnnotationId: annotation.id,
    });
  };
  const prepareAnswer = (
    annotation: AnnotationView,
    text: string,
    mode: "once" | "persistent" = "once",
  ) => {
    if (!canAnnotate) {
      return;
    }
    setAnswerOrigin(annotation);
    setDraft(text);
    setOnce(mode === "once");
    window.setTimeout(() => composeRef.current?.focus(), 0);
  };

  return (
    <div
      ref={ref}
      class={`pv-annotations${dragging ? " is-dragging" : ""}`}
      role="dialog"
      aria-label={text.preview.annotations.title}
      style={{ left: `${position.left}px`, top: `${position.top}px` }}
      onMouseDown={(event) => event.stopPropagation()}
    >
      <header
        class="pv-annotations-head"
        onPointerDown={startDrag}
        onPointerMove={moveDrag}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        <span class="pv-annotations-grip" aria-hidden="true">
          <Icon name="grabber" />
        </span>
        <Icon name="comment-discussion" />
        <span class="pv-annotations-title">{text.preview.annotations.title}</span>
        <span class="pv-annotations-block">
          {props.text.preview.kindLabels[props.block.kind] ?? props.block.kind}
          {props.block.headingPath ? ` · ${props.block.headingPath}` : ""}
        </span>
        <button
          type="button"
          class="pv-action"
          title={text.preview.annotations.title}
          aria-label={text.preview.annotations.title}
          onClick={props.onClose}
        >
          <Icon name="close" />
        </button>
      </header>
      <div class="pv-annotations-body">
        {annotations.length === 0 ? (
          <p class="pv-annotations-empty">{text.preview.annotations.empty}</p>
        ) : (
          <div class="pv-annotation-list">
            <AnnotationGroup
              title={text.preview.annotations.ai}
              annotations={aiAnnotations}
              open={openGroups.ai}
              onToggle={() =>
                setOpenGroups((current) => ({
                  ...current,
                  ai: !current.ai,
                }))
              }
              text={text}
              busy={props.busy}
              onStatus={props.onStatus}
              onDelete={props.onDelete}
              onUpdate={props.onUpdate}
              onAdoptAnswer={adoptAnswer}
              onPrepareAnswer={prepareAnswer}
              canAnnotate={canAnnotate}
            />
            <AnnotationGroup
              title={text.preview.annotations.user}
              annotations={userAnnotations}
              open={openGroups.user}
              onToggle={() =>
                setOpenGroups((current) => ({
                  ...current,
                  user: !current.user,
                }))
              }
              text={text}
              busy={props.busy}
              onStatus={props.onStatus}
              onDelete={props.onDelete}
              onUpdate={props.onUpdate}
              onAdoptAnswer={adoptAnswer}
              onPrepareAnswer={prepareAnswer}
              canAnnotate={canAnnotate}
            />
          </div>
        )}
        {!props.annotationsSupported ? (
          <p class="pv-summary-note is-warning">
            {text.preview.annotations.unsupported}
          </p>
        ) : null}
        {!canAnnotate ? (
          <p class="pv-summary-note is-warning">
            {text.preview.annotations.cannotAnnotate}
          </p>
        ) : humanLocked ? (
          <p class="pv-summary-note">
            {text.preview.annotations.humanPendingHint}
          </p>
        ) : null}
        <div class="pv-annotation-compose">
          {answerOrigin ? (
            <p class="pv-summary-note">
              {text.preview.annotations.answeringQuestion}
              {" · "}
              <button
                type="button"
                class="pv-link"
                disabled={props.busy}
                onClick={() => setAnswerOrigin(null)}
              >
                {text.preview.annotations.cancelAnswer}
              </button>
            </p>
          ) : null}
          <textarea
            ref={composeRef}
            class="pv-textarea"
            rows={3}
            value={draft}
            maxLength={MAX_ANNOTATION_MESSAGE}
            spellcheck={false}
            aria-label={text.preview.annotations.add}
            placeholder={text.preview.annotations.placeholder}
            disabled={props.busy || !canAnnotate}
            onInput={(event) => {
              setDraft(event.currentTarget.value);
              setPendingMessage(null);
            }}
          />
          <div class="pv-annotation-compose-actions">
            <label
              class="pv-check"
              title={text.preview.annotations.modeOnceHint}
            >
              <input
                type="checkbox"
                checked={once}
                disabled={props.busy || !canAnnotate}
                onChange={(event) => setOnce(event.currentTarget.checked)}
              />
              {text.preview.annotations.modeOnce}
            </label>
            <select
              class="pv-input pv-annotation-side-select"
              aria-label={text.preview.annotations.side}
              title={text.preview.annotations.sideHint}
              value={answerOrigin?.side ?? side}
              disabled={
                props.busy || !canAnnotate || Boolean(answerOrigin)
              }
              onChange={(event) =>
                setSide(event.currentTarget.value as "source" | "target")
              }
            >
              <option value="source">{props.text.preview.panes.source}</option>
              <option value="target">{props.text.preview.panes.target}</option>
            </select>
            <Button
              disabled={props.busy || !draft.trim() || !canAnnotate}
              onClick={() => {
                const message = draft.trim();
                if (!message || !canAnnotate) {
                  return;
                }
                setPendingMessage(message);
                props.onSave({
                  side: answerOrigin?.side ?? side,
                  mode: once ? "once" : "persistent",
                  message,
                  ...(answerOrigin
                    ? {
                        originAnnotationId: answerOrigin.id,
                        resolveAnnotationId: answerOrigin.id,
                      }
                    : {}),
                });
              }}
            >
              {text.preview.annotations.save}
            </Button>
          </div>
        </div>
        <div class="pv-annotation-footer">
          {canReview ? (
            <Button disabled={props.busy} onClick={props.onReview}>
              <Icon name="sparkle" /> {text.preview.annotations.review}
            </Button>
          ) : null}
          <span class="pv-summary-note">{text.preview.annotations.reviewHint}</span>
        </div>
      </div>
    </div>
  );
}

// ---- 工具栏 / 上下文栏 ----

function Toolbar(props: {
  model: PreviewModel;
  text: UiCatalog;
  busy: boolean;
  locked: boolean;
  selectionMode: boolean;
  canSelect: boolean;
  taskActivity: { running: number; queued: number };
  onSync: () => void;
  onReview: () => void;
  onExport: () => void;
  onRefresh: () => void;
  toolbarMenu: (event: MouseEvent) => void;
  onToggleSelection: () => void;
  onOpenTasks: () => void;
}) {
  const { model, text, busy, locked, taskActivity } = props;
  const taskCount = taskActivity.running + taskActivity.queued;
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
        {taskCount > 0 ? (
          <button
            type="button"
            class="pv-task-activity"
            title={text.preview.toolbar.taskActivityTitle}
            aria-label={text.preview.toolbar.taskActivityTitle}
            onClick={props.onOpenTasks}
          >
            <span
              class={`codicon ${
                taskActivity.running > 0
                  ? "codicon-sync codicon-modifier-spin"
                  : "codicon-clock"
              }`}
            />
            <span>
              {fmt(text.preview.toolbar.taskActivity, taskActivity)}
            </span>
          </button>
        ) : null}
        <Button primary disabled={busy} onClick={props.onSync}>
          <Icon name="sync" size={14} />
          {text.preview.toolbar.sync}
        </Button>
        <Button
          className="pv-review-action"
          disabled={busy || !model.cacheExists || !model.reviewSupported}
          title={
            !model.cacheExists
              ? text.preview.toolbar.exportDisabledTitle
              : !model.reviewSupported
                ? text.preview.toolbar.reviewUnsupportedTitle
                : undefined
          }
          onClick={props.onReview}
        >
          <Icon name="comment-discussion" size={14} />
          {text.preview.toolbar.reviewMachine}
        </Button>
        <Button
          disabled={locked || !model.cacheExists}
          title={model.cacheExists ? undefined : text.preview.toolbar.exportDisabledTitle}
          onClick={props.onExport}
        >
          <Icon name="export" size={14} />
          {text.preview.toolbar.export}
        </Button>
        <IconButton
          icon="checklist"
          title={
            props.selectionMode
              ? text.preview.selection.exit
              : text.preview.toolbar.selectBlocksTitle
          }
          active={props.selectionMode}
          disabled={busy || !props.canSelect}
          onClick={props.onToggleSelection}
        />
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
  add(
    model.counts.pendingAnnotations,
    text.preview.stats.pendingAnnotations,
    "comment-discussion",
    "is-note",
  );
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

function SelectionBar(props: {
  text: UiCatalog;
  selectedCount: number;
  counts: Record<BulkAction, number>;
  onAction: (action: BulkAction) => void;
  onSelectAll: () => void;
  onClear: () => void;
  onExit: () => void;
}) {
  const t = props.text.preview.selection;
  const actions: Array<{
    key: BulkAction;
    label: string;
    icon: string;
  }> = [
    { key: "retranslate", label: t.retranslate, icon: "refresh" },
    { key: "review", label: t.review, icon: "comment-discussion" },
    { key: "backTranslate", label: t.backTranslate, icon: "arrow-swap" },
    { key: "markSynced", label: t.markSynced, icon: "check" },
    {
      key: "deleteTranslation",
      label: t.deleteTranslation,
      icon: "trash",
    },
  ];
  return (
    <div
      class="pv-selection-bar"
      role="region"
      aria-label={t.actionGroup}
    >
      <div class="pv-selection-summary" title={t.hint}>
        <Icon name="checklist" size={14} />
        <strong>{fmt(t.selected, { count: props.selectedCount })}</strong>
        <span class="pv-selection-hint">{t.hint}</span>
      </div>
      <div
        class="pv-selection-actions"
        role="group"
        aria-label={t.actionGroup}
      >
        {actions.map((action) => (
          <button
            key={action.key}
            type="button"
            class="pv-bulk-action"
            disabled={props.counts[action.key] === 0}
            title={action.label}
            onClick={() => props.onAction(action.key)}
          >
            <Icon name={action.icon} size={13} />
            <span>{action.label}</span>
            {props.counts[action.key] > 0 ? (
              <span class="pv-bulk-count">
                {props.counts[action.key]}
              </span>
            ) : null}
          </button>
        ))}
      </div>
      <div class="pv-selection-tools">
        <button
          type="button"
          class="pv-selection-tool"
          onClick={props.onSelectAll}
        >
          {t.selectAll}
        </button>
        <button
          type="button"
          class="pv-selection-tool"
          disabled={props.selectedCount === 0}
          onClick={props.onClear}
        >
          {t.clear}
        </button>
        <IconButton icon="close" title={t.exit} onClick={props.onExit} />
      </div>
    </div>
  );
}

function Notices(props: {
  model: PreviewModel;
  text: UiCatalog;
  busy: boolean;
  locked: boolean;
  onApplySource: () => void;
  onDiscardSource: () => void;
  onRetranslateStale: () => void;
}) {
  const { model, text, busy, locked } = props;
  const notices: JSX.Element[] = [];
  if (model.pendingSourceCount > 0) {
    notices.push(
      <div key="pending" class="pv-notice is-info">
        <Icon name="edit" />
        <span class="pv-notice-text">
          {model.pendingSourceCount} · {text.preview.actions.sourcePendingBadge}
        </span>
        <span class="pv-notice-actions">
          <Button disabled={locked} onClick={props.onApplySource}>
            {fmt(text.preview.actions.applySource, { count: model.pendingSourceCount })}
          </Button>
          <Button disabled={locked} onClick={props.onDiscardSource}>
            {text.preview.actions.resetSource}
          </Button>
        </span>
      </div>,
    );
  }
  if (model.counts.pendingAnnotations > 0) {
    notices.push(
      <div key="annotations" class="pv-notice is-info">
        <Icon name="comment-discussion" />
        <span class="pv-notice-text">
          {fmt(text.preview.subbar.pendingAnnotations, {
            count: model.counts.pendingAnnotations,
          })}
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

function formatGlossaryLines(lines: readonly number[]): string {
  const shown = lines.slice(0, 8);
  return lines.length > shown.length
    ? `${shown.join(", ")}…`
    : shown.join(", ");
}

const TERM_FIELD_MAX_WIDTH = 168;
const TERM_EDIT_MIN_WIDTH = 260;

function TermText(props: {
  text: string;
  className: string;
  active: boolean;
}) {
  const fieldRef = useRef<HTMLSpanElement>(null);
  const trackRef = useRef<HTMLSpanElement>(null);
  const [distance, setDistance] = useState(0);

  useLayoutEffect(() => {
    if (!props.active) {
      setDistance(0);
      return;
    }
    const field = fieldRef.current;
    const track = trackRef.current;
    if (!field || !track) {
      return;
    }
    const measure = () => {
      const full = track.getBoundingClientRect().width || track.scrollWidth;
      const visible =
        field.getBoundingClientRect().width || field.clientWidth;
      const overflow = Math.ceil(full - visible);
      setDistance(overflow > 1 ? overflow : 0);
    };
    measure();
    if (typeof ResizeObserver === "undefined") {
      return;
    }
    const observer = new ResizeObserver(measure);
    observer.observe(field);
    return () => observer.disconnect();
  }, [props.active, props.text]);

  const duration = Math.min(6000, Math.max(1400, distance * 18));
  return (
    <span
      ref={fieldRef}
      class={`pv-term-text${props.className ? ` ${props.className}` : ""}${
        distance > 0 ? " is-revealing" : ""
      }`}
      title={props.text}
      style={
        distance > 0
          ? `--term-shift:-${distance}px;--term-duration:${duration}ms;`
          : undefined
      }
    >
      <span class="pv-term-static">{props.text}</span>
      <span
        ref={trackRef}
        class="pv-term-track"
        data-text={props.text}
        aria-hidden="true"
      />
    </span>
  );
}

function GlossaryTermCard(props: {
  row: GlossaryRow;
  index: number;
  disabled: boolean;
  editing: boolean;
  invalid: boolean;
  duplicate: boolean;
  text: UiCatalog;
  available: number;
  onEdit: (side: Side, width: number) => void;
  onDelete: () => void;
}) {
  const cardRef = useRef<HTMLDivElement>(null);
  const [hovered, setHovered] = useState<Side | null>(null);
  const [natural, setNatural] = useState(0);
  const text = props.text;
  const t = text.preview.summary;

  useLayoutEffect(() => {
    const card = cardRef.current;
    if (!card) {
      return;
    }
    const main = card.querySelector<HTMLElement>(".pv-term-main");
    const tracks = card.querySelectorAll<HTMLElement>(".pv-term-track");
    const separator = card.querySelector<HTMLElement>(".pv-term-separator");
    if (!main || tracks.length < 2 || !separator) {
      return;
    }
    const mainStyle = getComputedStyle(main);
    const gap = parseFloat(mainStyle.columnGap || mainStyle.gap) || 0;
    const padding =
      (parseFloat(mainStyle.paddingLeft) || 0) +
      (parseFloat(mainStyle.paddingRight) || 0);
    setNatural(
      Math.min(tracks[0].getBoundingClientRect().width, TERM_FIELD_MAX_WIDTH) +
        Math.min(tracks[1].getBoundingClientRect().width, TERM_FIELD_MAX_WIDTH) +
        separator.getBoundingClientRect().width +
        gap * 2 +
        padding +
        (card.offsetWidth - card.clientWidth),
    );
  }, [props.row.source, props.row.target, props.available]);

  const filling =
    props.available > 1 && natural > props.available + 1;

  const sideProps = (side: Side) => ({
    type: "button" as const,
    class: `pv-term-side pv-term-${side}`,
    disabled: props.disabled || props.editing,
    "aria-label": `${t.glossaryEditTerm} ${props.index + 1} ${
      side === "source" ? t.glossaryTableSource : t.glossaryTableTarget
    }: ${props.row[side]}`,
    title: props.row[side],
    onClick: () =>
      props.onEdit(
        side,
        cardRef.current?.getBoundingClientRect().width ?? 0,
      ),
    onMouseEnter: () => setHovered(side),
    onMouseLeave: () => setHovered(null),
    onFocus: () => setHovered(side),
    onBlur: () =>
      setHovered((current) => (current === side ? null : current)),
  });
  return (
    <div
      ref={cardRef}
      class={`pv-term-card${props.invalid ? " is-invalid" : ""}${
        props.duplicate ? " is-warning" : ""
      }${filling ? " is-filling" : ""}`}
      data-term-index={props.index}
      role="listitem"
      title={props.duplicate ? t.glossaryDuplicate : undefined}
    >
      <div class="pv-term-main">
        <button {...sideProps("source")}>
          <TermText
            text={props.row.source}
            className=""
            active={hovered === "source"}
          />
        </button>
        <span class="pv-term-separator" aria-hidden="true">
          |
        </span>
        <button {...sideProps("target")}>
          <TermText
            text={props.row.target}
            className=""
            active={hovered === "target"}
          />
        </button>
      </div>
      <button
        type="button"
        class="pv-term-delete"
        disabled={props.disabled || props.editing}
        title={`${text.preview.summary.glossaryDelete} ${props.index + 1}`}
        aria-label={`${text.preview.summary.glossaryDelete} ${props.index + 1}`}
        onClick={props.onDelete}
      >
        <Icon name="close" />
      </button>
    </div>
  );
}

function GlossaryTable(props: {
  text: UiCatalog;
  value: string;
  disabled: boolean;
  onDraft: (value: string) => void;
  onEditing: (editing: boolean) => void;
}) {
  const text = props.text;
  const t = text.preview.summary;
  const parsed = useMemo(() => parseGlossaryRows(props.value), [props.value]);
  const validation = useMemo(
    () => validateGlossaryRows(parsed.rows),
    [parsed.rows],
  );
  const [bulk, setBulk] = useState(false);
  const [filter, setFilter] = useState("");
  const [editing, setEditing] = useState<{
    index: number;
    original: GlossaryRow | null;
    source: string;
    target: string;
    side: Side;
    width: number;
  } | null>(null);
  const termFlowRef = useRef<HTMLDivElement>(null);
  const [flowWidth, setFlowWidth] = useState(0);
  const editorRef = useRef<HTMLDivElement>(null);
  const settledRef = useRef(false);
  const switchingRef = useRef(false);
  const restoreFocusRef = useRef<{
    index: number;
    side: Side;
  } | null>(null);
  const isEditing = Boolean(editing);

  useEffect(() => {
    props.onEditing(isEditing);
    return () => {
      if (isEditing) {
        props.onEditing(false);
      }
    };
  }, [isEditing]);

  useEffect(() => {
    if (!editing) {
      return;
    }
    const input = editorRef.current?.querySelector<HTMLInputElement>(
      `[data-glossary-edit="${editing.side}"]`,
    );
    if (input) {
      input.focus();
      input.select();
    }
  }, [editing?.index, editing?.original, editing?.side]);

  useEffect(() => {
    if (editing) {
      return;
    }
    const target = restoreFocusRef.current;
    if (!target) {
      return;
    }
    restoreFocusRef.current = null;
    const timer = window.setTimeout(() => {
      const active = document.activeElement;
      if (active && active !== document.body) {
        return;
      }
      const flow = termFlowRef.current;
      if (!flow) {
        return;
      }
      const card =
        target.index >= 0
          ? flow.querySelector<HTMLElement>(
              `[data-term-index="${target.index}"]`,
            )
          : null;
      const side = card?.querySelector<HTMLElement>(
        `.pv-term-side.pv-term-${target.side}`,
      );
      const element =
        side ?? flow.querySelector<HTMLElement>(".pv-term-add");
      element?.focus();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [editing]);

  useLayoutEffect(() => {
    if (bulk) {
      return;
    }
    const flow = termFlowRef.current;
    if (!flow) {
      return;
    }
    const measure = () => {
      const style = getComputedStyle(flow);
      const width =
        flow.clientWidth -
        (parseFloat(style.paddingLeft) || 0) -
        (parseFloat(style.paddingRight) || 0);
      setFlowWidth(width > 1 ? width : 0);
    };
    measure();
    window.addEventListener("resize", measure);
    if (typeof ResizeObserver === "undefined") {
      return () => window.removeEventListener("resize", measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(flow);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [bulk]);

  const filtered = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    return parsed.rows
      .map((row, index) => ({ row, index }))
      .filter(({ row }) =>
        needle
          ? row.source.toLowerCase().includes(needle) ||
            row.target.toLowerCase().includes(needle)
          : true,
      );
  }, [parsed.rows, filter]);

  const resolvedSide = (
    draft: {
      original: GlossaryRow | null;
      source: string;
      target: string;
    },
    side: Side,
  ): string => {
    const value = (side === "source" ? draft.source : draft.target).trim();
    if (value) {
      return value.slice(0, GLOSSARY_MAX_TERM_LENGTH);
    }
    if (!draft.original) {
      return "";
    }
    return side === "source" ? draft.original.source : draft.original.target;
  };
  const beginEdit = (
    index: number,
    row: GlossaryRow,
    side: Side,
    width: number,
  ) => {
    if (props.disabled) {
      return;
    }
    settledRef.current = false;
    switchingRef.current = false;
    restoreFocusRef.current = null;
    setEditing({
      index,
      original: row,
      source: row.source,
      target: row.target,
      side,
      width,
    });
  };
  const startNew = () => {
    if (
      props.disabled ||
      validation.count >= GLOSSARY_MAX_ENTRIES
    ) {
      return;
    }
    settledRef.current = false;
    switchingRef.current = false;
    restoreFocusRef.current = null;
    setEditing({
      index: parsed.rows.length,
      original: null,
      source: "",
      target: "",
      side: "source",
      width: 0,
    });
  };
  const finishEdit = (commit: boolean) => {
    if (!editing || settledRef.current) {
      return;
    }
    settledRef.current = true;
    const source = resolvedSide(editing, "source");
    const target = resolvedSide(editing, "target");
    if (commit) {
      if (editing.original) {
        const original = editing.original;
        const matches = (row: GlossaryRow | undefined) =>
          row?.source === original.source && row?.target === original.target;
        const index = matches(parsed.rows[editing.index])
          ? editing.index
          : parsed.rows.findIndex(matches);
        if (index < 0) {
          restoreFocusRef.current = { index: -1, side: "source" };
          setEditing(null);
          return;
        }
        const next = parsed.rows.slice();
        next[index] = { source, target };
        props.onDraft(serializeGlossaryRows(next));
      } else if (source && target) {
        props.onDraft(
          serializeGlossaryRows([...parsed.rows, { source, target }]),
        );
      }
    }
    restoreFocusRef.current = editing.original
      ? { index: editing.index, side: editing.side }
      : commit && source && target
        ? { index: parsed.rows.length, side: editing.side }
        : { index: -1, side: "source" };
    setEditing(null);
  };
  const changeSide = (side: Side, value: string) => {
    setEditing((current) => {
      if (!current) {
        return current;
      }
      return side === "source"
        ? { ...current, source: value }
        : { ...current, target: value };
    });
  };
  const armSwitchGuard = () => {
    switchingRef.current = true;
    setTimeout(() => {
      switchingRef.current = false;
    }, 0);
  };
  const switchSide = (side: Side) => {
    if (!editing || editing.side === side) {
      return;
    }
    armSwitchGuard();
    setEditing((current) => {
      if (!current || current.side === side) {
        return current;
      }
      return {
        ...current,
        [current.side]: resolvedSide(current, current.side),
        side,
      };
    });
  };
  const commitSide = () => {
    if (!editing) {
      return;
    }
    const value = (
      editing.side === "source" ? editing.source : editing.target
    ).trim();
    if (!editing.original) {
      const other = (
        editing.side === "source" ? editing.target : editing.source
      ).trim();
      if (!value) {
        return;
      }
      if (!other) {
        armSwitchGuard();
        setEditing((current) => {
          if (!current) {
            return current;
          }
          return {
            ...current,
            [current.side]: value,
            side: current.side === "source" ? "target" : "source",
          };
        });
        return;
      }
    }
    finishEdit(true);
  };
  const editKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Enter") {
      event.preventDefault();
      commitSide();
    } else if (event.key === "Escape") {
      event.preventDefault();
      finishEdit(false);
    }
  };
  const blurEdit = (related: Node | null) => {
    if (settledRef.current) {
      return;
    }
    if (switchingRef.current) {
      switchingRef.current = false;
      return;
    }
    if (related && editorRef.current?.contains(related)) {
      return;
    }
    finishEdit(true);
  };
  const removeRow = (index: number) => {
    if (props.disabled) {
      return;
    }
    if (editing) {
      settledRef.current = true;
      setEditing(null);
    }
    const next = parsed.rows.filter((_, rowIndex) => rowIndex !== index);
    props.onDraft(serializeGlossaryRows(next));
  };
  const renderEditSide = (side: Side) => {
    if (!editing) {
      return null;
    }
    const label =
      side === "source"
        ? text.preview.summary.glossaryTableSource
        : text.preview.summary.glossaryTableTarget;
    const value = side === "source" ? editing.source : editing.target;
    return (
      <span class="pv-term-edit-field">
        {editing.side === side ? (
          <input
            class="pv-term-edit-input"
            data-glossary-edit={side}
            value={value}
            maxLength={GLOSSARY_MAX_TERM_LENGTH}
            spellcheck={false}
            aria-label={label}
            placeholder={label}
            title={text.preview.summary.glossaryEditHint}
            onInput={(event) => changeSide(side, event.currentTarget.value)}
            onKeyDown={editKeyDown}
            onBlur={(event) => blurEdit(event.relatedTarget as Node | null)}
          />
        ) : (
          <button
            type="button"
            class={`pv-term-side pv-term-${side}`}
            disabled={props.disabled}
            aria-label={`${text.preview.summary.glossaryEditTerm} ${
              editing.index + 1
            } ${label}${value ? `: ${value}` : ""}`}
            title={value || label}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => switchSide(side)}
          >
            {value || (
              <span class="pv-term-placeholder">{label}</span>
            )}
          </button>
        )}
      </span>
    );
  };
  const editor = editing ? (
    <div
      class="pv-term-card is-editing"
      ref={editorRef}
      role="listitem"
      data-term-index={editing.index}
      title={text.preview.summary.glossaryEditHint}
      style={`width:${Math.max(editing.width, TERM_EDIT_MIN_WIDTH)}px;`}
    >
      <div class="pv-term-main">
        {renderEditSide("source")}
        <span class="pv-term-separator" aria-hidden="true">
          |
        </span>
        {renderEditSide("target")}
      </div>
    </div>
  ) : null;

  return (
    <div class="pv-glossary">
      {!bulk ? (
        <div class="pv-glossary-toolbar">
          <button
            type="button"
            class="pv-link"
            disabled={props.disabled}
            onClick={() => {
              if (editing) {
                finishEdit(true);
              }
              setBulk(true);
            }}
          >
            {text.preview.summary.glossaryBulkEdit}
          </button>
        </div>
      ) : (
        <div class="pv-glossary-toolbar">
          <button
            type="button"
            class="pv-link"
            disabled={props.disabled}
            onClick={() => {
              if (parsed.invalidLines.length > 0) {
                return;
              }
              setBulk(false);
            }}
          >
            {text.preview.summary.glossaryTableEdit}
          </button>
        </div>
      )}
      {bulk ? (
        <textarea
          class="pv-textarea pv-glossary-text"
          rows={6}
          spellcheck={false}
          aria-label={t.glossaryTitle}
          value={props.value}
          placeholder={t.glossaryPlaceholder}
          onInput={(event) => props.onDraft(event.currentTarget.value)}
        />
      ) : (
        <>
          {validation.count > 10 ? (
            <input
              class="pv-input pv-glossary-filter"
              value={filter}
              spellcheck={false}
              aria-label={text.preview.summary.glossaryFilter}
              placeholder={text.preview.summary.glossaryFilter}
              onInput={(event) => setFilter(event.currentTarget.value)}
            />
          ) : null}
          {parsed.rows.length === 0 && !editing ? (
            <p class="pv-glossary-empty">
              {text.preview.summary.glossaryEmpty}
            </p>
          ) : null}
          <div
            class="pv-term-flow"
            ref={termFlowRef}
            role="list"
            aria-label={t.glossaryTitle}
          >
            {filtered.map(({ row, index }) => {
              if (editing?.original && editing.index === index) {
                return <Fragment key={`edit-${index}`}>{editor}</Fragment>;
              }
              const invalid = validation.invalidRows.has(index);
              const duplicate = validation.duplicateRows.has(index);
              return (
                <GlossaryTermCard
                  key={index}
                  row={row}
                  index={index}
                  disabled={props.disabled}
                  editing={Boolean(editing)}
                  invalid={invalid}
                  duplicate={duplicate}
                  text={text}
                  available={flowWidth}
                  onEdit={(side, width) =>
                    beginEdit(index, row, side, width)
                  }
                  onDelete={() => removeRow(index)}
                />
              );
            })}
            {editing && !editing.original
              ? <Fragment key="new">{editor}</Fragment>
              : null}
            {!editing ? (
              <div class="pv-term-add-row" role="listitem">
                <button
                  type="button"
                  class="pv-term-add"
                  disabled={
                    props.disabled ||
                    validation.count >= GLOSSARY_MAX_ENTRIES
                  }
                  onClick={startNew}
                >
                  <Icon name="add" /> {text.preview.summary.glossaryAdd}
                </button>
              </div>
            ) : null}
          </div>
        </>
      )}
      {parsed.invalidLines.length > 0 ? (
        <p class="pv-summary-note is-error">
          {fmt(text.preview.summary.glossaryInvalidLines, {
            lines: formatGlossaryLines(parsed.invalidLines),
          })}
        </p>
      ) : null}
      {validation.invalidRows.size > 0 ? (
        <p class="pv-summary-note is-error">
          {fmt(text.preview.summary.glossaryInvalid, { max: GLOSSARY_MAX_TERM_LENGTH })}
        </p>
      ) : null}
      {validation.tooMany ? (
        <p class="pv-summary-note is-error">
          {fmt(text.preview.summary.glossaryTooMany, { max: GLOSSARY_MAX_ENTRIES })}
        </p>
      ) : null}
      {validation.duplicateRows.size > 0 ? (
        <p class="pv-summary-note is-warning">{text.preview.summary.glossaryDuplicate}</p>
      ) : null}
      <p class="pv-summary-note">{t.glossaryHint}</p>
    </div>
  );
}

function SummaryPanel(props: {
  text: UiCatalog;
  summary: Summary;
  open: boolean;
  busy: boolean;
  locked: boolean;
  stableTranslation: boolean;
  summaryContext: boolean;
  summaryDraft: string;
  glossaryDraft: string;
  brief: TranslationBrief;
  onToggle: () => void;
  onDraft: (value: string) => void;
  onGlossaryDraft: (value: string) => void;
  onBriefDraft: (patch: Partial<TranslationBrief>) => void;
  onGenerate: () => void;
  onSave: () => void;
  onClear: () => void;
  onAssist: (key: "stableTranslation" | "summaryContext", value: boolean) => void;
}) {
  const { text, summary } = props;
  const hasSummary = Boolean(summary.text.trim());
  const [openSection, setOpenSection] = useState<
    "brief" | "glossary" | null
  >(null);
  const [glossaryEditing, setGlossaryEditing] = useState(false);
  const toggleSection = (section: "brief" | "glossary") => {
    setOpenSection((current) => (current === section ? null : section));
  };
  const glossaryParsed = useMemo(
    () => parseGlossaryRows(props.glossaryDraft),
    [props.glossaryDraft],
  );
  const glossaryValidation = useMemo(
    () => validateGlossaryRows(glossaryParsed.rows),
    [glossaryParsed.rows],
  );
  const glossaryBlocked =
    glossaryEditing ||
    glossaryParsed.invalidLines.length > 0 ||
    glossaryValidation.hasErrors;
  const filledBrief = briefFilledCount(props.brief);
  const totalTokens = summary.tokens + (summary.briefTokens ?? 0);
  const meta: string[] = [];
  if (hasSummary) {
    meta.push(fmt(text.preview.summary.tokens, { count: totalTokens }));
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
            <Button
              disabled={props.locked || glossaryBlocked}
              title={
                glossaryBlocked
                  ? text.preview.summary.glossarySaveBlocked
                  : undefined
              }
              onClick={props.onSave}
            >
              {text.preview.summary.save}
            </Button>
            <Button disabled={props.locked || !hasSummary} onClick={props.onClear}>
              {text.preview.summary.clear}
            </Button>
            <label class="pv-check" title={text.preview.summary.stableTranslationTitle}>
              <input
                type="checkbox"
                disabled={props.locked}
                checked={props.stableTranslation}
                onChange={(event) => props.onAssist("stableTranslation", event.currentTarget.checked)}
              />
              {text.preview.summary.stableTranslation}
            </label>
            <label class="pv-check" title={text.preview.summary.useSummaryTitle}>
              <input
                type="checkbox"
                checked={props.summaryContext}
                disabled={!hasSummary || props.locked}
                onChange={(event) => props.onAssist("summaryContext", event.currentTarget.checked)}
              />
              {text.preview.summary.useSummary}
            </label>
          </div>
          <textarea
            class="pv-textarea"
            rows={6}
            spellcheck={false}
            disabled={props.locked}
            aria-label={text.preview.summary.title}
            value={props.summaryDraft}
            placeholder={text.preview.summary.placeholder}
            onInput={(event) => props.onDraft(event.currentTarget.value)}
          />
          <p class="pv-summary-note">
            {meta.join(" · ")}
            {summary.stale ? ` · ${text.preview.summary.staleHint}` : ""}
          </p>
          <div class={`pv-brief${openSection === "brief" ? " is-open" : ""}`}>
            <button
              type="button"
              class="pv-brief-toggle"
              aria-expanded={openSection === "brief"}
              onClick={() => toggleSection("brief")}
            >
              <Icon name="settings" />
              <span class="pv-brief-title">
                {text.preview.summary.briefAdvanced}
              </span>
              <span class="pv-brief-count">
                {fmt(text.preview.summary.briefFilled, {
                  count: filledBrief,
                })}
              </span>
              <Icon name="chevron-down" />
            </button>
            {openSection === "brief" ? (
              <div class="pv-brief-fields">
                <label class="pv-brief-field">
                  <span>{text.preview.summary.briefAudience}</span>
                  <input
                    class="pv-input"
                    value={props.brief.audience ?? ""}
                    maxLength={BRIEF_FIELD_LIMIT}
                    spellcheck={false}
                    disabled={props.locked}
                    placeholder={text.preview.summary.briefAudiencePlaceholder}
                    onInput={(event) =>
                      props.onBriefDraft({ audience: event.currentTarget.value })
                    }
                  />
                </label>
                <label class="pv-brief-field">
                  <span>{text.preview.summary.briefTone}</span>
                  <textarea
                    class="pv-textarea"
                    rows={2}
                    value={props.brief.toneAndStyle ?? ""}
                    maxLength={BRIEF_FIELD_LIMIT}
                    spellcheck={false}
                    disabled={props.locked}
                    placeholder={text.preview.summary.briefTonePlaceholder}
                    onInput={(event) =>
                      props.onBriefDraft({
                        toneAndStyle: event.currentTarget.value,
                      })
                    }
                  />
                </label>
                <label class="pv-brief-field">
                  <span>{text.preview.summary.briefAmbiguities}</span>
                  <textarea
                    class="pv-textarea"
                    rows={3}
                    value={props.brief.ambiguities ?? ""}
                    maxLength={BRIEF_FIELD_LIMIT}
                    spellcheck={false}
                    disabled={props.locked}
                    placeholder={
                      text.preview.summary.briefAmbiguitiesPlaceholder
                    }
                    onInput={(event) =>
                      props.onBriefDraft({
                        ambiguities: event.currentTarget.value,
                      })
                    }
                  />
                </label>
                <label class="pv-brief-field">
                  <span>{text.preview.summary.briefDoNotTranslate}</span>
                  <textarea
                    class="pv-textarea"
                    rows={2}
                    value={props.brief.doNotTranslate ?? ""}
                    maxLength={BRIEF_FIELD_LIMIT}
                    spellcheck={false}
                    disabled={props.locked}
                    placeholder={
                      text.preview.summary.briefDoNotTranslatePlaceholder
                    }
                    onInput={(event) =>
                      props.onBriefDraft({
                        doNotTranslate: event.currentTarget.value,
                      })
                    }
                  />
                </label>
                <p class="pv-summary-note">
                  {text.preview.summary.briefHint}
                </p>
              </div>
            ) : null}
          </div>
          <div
            class={`pv-brief pv-glossary-section${
              openSection === "glossary" ? " is-open" : ""
            }`}
          >
            <button
              type="button"
              class="pv-brief-toggle"
              aria-expanded={openSection === "glossary"}
              onClick={() => toggleSection("glossary")}
            >
              <Icon name="book" />
              <span class="pv-brief-title">
                {text.preview.summary.glossaryTitle}
              </span>
              <span class="pv-brief-count">
                {fmt(text.preview.summary.glossaryCount, {
                  count: glossaryValidation.count,
                })}
              </span>
              <span class="pv-glossary-limit">
                / {GLOSSARY_MAX_ENTRIES}
              </span>
              <Icon name="chevron-down" />
            </button>
            {openSection === "glossary" ? (
              hasSummary ? (
                <GlossaryTable
                  text={text}
                  value={props.glossaryDraft}
                  disabled={props.locked}
                  onDraft={props.onGlossaryDraft}
                  onEditing={setGlossaryEditing}
                />
              ) : (
                <p class="pv-summary-note">
                  {text.preview.summary.glossaryNeedsSummary}
                </p>
              )
            ) : null}
          </div>
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
        disabled={props.busy}
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
  busy: boolean;
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
        disabled={props.busy}
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
        <Button primary disabled={props.busy} onClick={() => props.onSave(draft)}>
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
  selectionMode?: boolean;
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
      {stale && !props.selectionMode ? (
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
        {(canEditSource || canEditTarget) &&
          !props.selectionMode &&
          !props.busy && (
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
    selectionMode?: boolean;
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
  if (props.selectionMode || props.busy || props.readonly) {
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

function annotationCounts(block: PreviewBlockView): {
  attention: number;
  total: number;
} {
  const annotations = block.annotations ?? [];
  return {
    attention: annotations.filter(annotationNeedsAttention).length,
    total: annotations.length,
  };
}

function AnnotationBadge(props: {
  block: PreviewBlockView;
  text: UiCatalog;
  onClick?: () => void;
}) {
  const { attention, total } = annotationCounts(props.block);
  if (total === 0) {
    return null;
  }
  const active = attention > 0;
  const count = active ? attention : total;
  const label = active
    ? props.text.preview.annotations.openCount
    : props.text.preview.annotations.viewCount;
  return (
    <button
      type="button"
      class={`pv-annotation-badge${active ? "" : " is-view-only"}`}
      data-block-key={props.block.key}
      title={fmt(label, { count })}
      aria-label={fmt(label, { count })}
      onClick={(event) => {
        event.stopPropagation();
        props.onClick?.();
      }}
    >
      <Icon name="comment-discussion" />
      <span>{count}</span>
    </button>
  );
}

function BlockHead(props: {
  block: PreviewBlockView;
  text: UiCatalog;
  actions?: boolean;
  onMenu?: (event: MouseEvent) => void;
  onRetranslate?: () => void;
  onAnnotations?: () => void;
  showLine?: boolean;
  selectionMode?: boolean;
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
      {props.selectionMode ? null : (
        <AnnotationBadge
          block={block}
          text={text}
          onClick={props.onAnnotations}
        />
      )}
      {block.headingPath ? (
        <span class="pv-heading-path" title={text.preview.actions.headingPathTitle}>
          {block.headingPath}
        </span>
      ) : null}
      {props.showLine && block.sourceLine ? <span class="pv-line">L{block.sourceLine}</span> : null}
      {props.actions && !props.selectionMode ? (
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
  selectionMode: boolean;
  selected: boolean;
  onMenu: (event: MouseEvent, block: PreviewBlockView, side?: Side) => void;
  onRetranslate: (block: PreviewBlockView) => void;
  onAnnotations: (block: PreviewBlockView) => void;
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
      <article
        class={`pv-block${props.selected ? " is-selected" : ""}`}
        data-status={block.status}
        data-key={block.key}
      >
        <BlockHead
          block={block}
          text={text}
          actions
          showLine
          selectionMode={props.selectionMode}
          onMenu={(event) => props.onMenu(event, block)}
          onRetranslate={() => props.onRetranslate(block)}
          onAnnotations={() => props.onAnnotations(block)}
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
          busy={props.busy}
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
  selectionMode: boolean;
  selected: boolean;
  onMenu: (event: MouseEvent, block: PreviewBlockView, side: Side) => void;
  onStartEdit: (block: PreviewBlockView, side: Side) => void;
  onRetranslate: (block: PreviewBlockView) => void;
  onAnnotations: (block: PreviewBlockView) => void;
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
      class={`pv-cell${props.selected ? " is-selected" : ""}`}
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
          {!props.selectionMode &&
          (isTarget ? Boolean(block.standaloneTargetId) : !block.standaloneTargetId) ? (
            <AnnotationBadge
              block={block}
              text={text}
              onClick={() => props.onAnnotations(block)}
            />
          ) : null}
          {block.sourceLine ? <span class="pv-line">L{block.sourceLine}</span> : null}
          {props.selectionMode ? null : (
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
          )}
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
          selectionMode={props.selectionMode}
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
  onAnnotations: (block: PreviewBlockView) => void;
  onStartEdit: (block: PreviewBlockView, side: Side) => void;
  onSave: (text: string) => void;
  onCancel: () => void;
  onOpenLink: (href: string) => void;
  onInsertSave: (text: string) => void;
  onInsertCancel: () => void;
  onToggleReadonly: (side: Side) => void;
  selectionMode: boolean;
  selectedKeys: ReadonlySet<string>;
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
        busy={props.busy}
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
                selectionMode={props.selectionMode}
                selected={props.selectedKeys.has(block.key)}
                onMenu={props.onMenu}
                onStartEdit={props.onStartEdit}
                onRetranslate={props.onRetranslate}
                onAnnotations={props.onAnnotations}
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
                selectionMode={props.selectionMode}
                selected={props.selectedKeys.has(block.key)}
                onMenu={props.onMenu}
                onStartEdit={props.onStartEdit}
                onRetranslate={props.onRetranslate}
                onAnnotations={props.onAnnotations}
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
  shifted: boolean;
  onDismiss: (id: number) => void;
}) {
  return (
    <div
      class={`toast-host${props.shifted ? " is-shifted" : ""}`}
      aria-live="polite"
    >
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
  const [taskActivity, setTaskActivity] = useState({
    running: 0,
    queued: 0,
  });
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(
    () => new Set(),
  );
  const selectionSignatures = useRef<Map<string, string>>(new Map());
  const lastSelectedKey = useRef<string | null>(null);
  const dragSelectionRef = useRef<DragSelectionState | null>(null);
  const suppressSelectionClick = useRef(false);
  const locked = busy || taskActivity.running + taskActivity.queued > 0;
  const [summaryOpen, setSummaryOpen] = useState(false);
  const [summaryDraft, setSummaryDraft] = useState(props.boot.state.model.assist.summary.text);
  const [summaryDirty, setSummaryDirty] = useState(false);
  const [briefDraft, setBriefDraft] = useState<TranslationBrief>(
    props.boot.state.model.assist.summary.brief,
  );
  const [briefDirty, setBriefDirty] = useState(false);
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
  const [annotationTarget, setAnnotationTarget] =
    useState<AnnotationTarget | null>(null);
  const [revealRequest, setRevealRequest] = useState<{
    blockKey?: string;
    first?: boolean;
  } | null>(null);
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
  const briefDraftRef = useRef(briefDraft);
  const glossaryDraftRef = useRef(glossaryDraft);
  const pendingBriefSave = useRef<string | null>(null);
  summaryDraftRef.current = summaryDraft;
  briefDraftRef.current = briefDraft;
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
          // 只有宿主确实回写了与提交内容一致的简报，才清除 dirty；
          // 校验失败或用户在保存期间继续输入时保留草稿。
          if (pendingBriefSave.current !== null) {
            const saved = message.state.model.assist.summary;
            const savedSignature = briefSaveSignature(
              saved.text,
              saved.brief,
              saved.glossaryText ?? "",
            );
            const currentSignature = briefSaveSignature(
              summaryDraftRef.current,
              briefDraftRef.current,
              glossaryDraftRef.current,
            );
            if (
              savedSignature === pendingBriefSave.current &&
              currentSignature === pendingBriefSave.current
            ) {
              setSummaryDirty(false);
              setBriefDirty(false);
              setGlossaryDirty(false);
            }
            pendingBriefSave.current = null;
          }
          break;
        }
        case "busy":
          setBusy(Boolean(message.busy));
          if (message.busy && message.message) {
            showToast(message.message, "info");
          }
          break;
        case "taskActivity": {
          const running =
            typeof message.running === "number" &&
            Number.isFinite(message.running)
              ? Math.max(0, Math.floor(message.running))
              : 0;
          const queued =
            typeof message.queued === "number" &&
            Number.isFinite(message.queued)
              ? Math.max(0, Math.floor(message.queued))
              : 0;
          setTaskActivity({ running, queued });
          break;
        }
        case "revealBlock":
          setRevealRequest({
            ...(typeof message.blockKey === "string"
              ? { blockKey: message.blockKey }
              : {}),
            ...(message.first === true ? { first: true } : {}),
          });
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
    if (!briefDirty) {
      setBriefDraft(host.model.assist.summary.brief);
    }
  }, [host.model.assist.summary.brief, briefDirty]);
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

  // 块被移除时关闭编辑/插入/批注
  useEffect(() => {
    if (editing && !host.model.blocks.some((block) => block.key === editing.key)) {
      setEditing(null);
    }
    if (
      annotationTarget &&
      !host.model.blocks.some(
        (block) => block.key === annotationTarget.block.key,
      )
    ) {
      setAnnotationTarget(null);
    }
  }, [editing, annotationTarget, host.model.blocks]);

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
  const selectableBlocks = useMemo(
    () => blocks.filter((block) => block.blockIndex >= 0),
    [blocks],
  );
  const selectedBlocks = useMemo(
    () => selectableBlocks.filter((block) => selectedKeys.has(block.key)),
    [selectableBlocks, selectedKeys],
  );
  const blockByKey = useMemo(
    () =>
      new Map(selectableBlocks.map((block) => [block.key, block])),
    [selectableBlocks],
  );

  useEffect(() => {
    if (!revealRequest || host.model.blocks.length === 0) {
      return;
    }
    const target = revealRequest.first
      ? host.model.blocks.find((block) => block.blockIndex >= 0)
      : host.model.blocks.find(
          (block) => block.key === revealRequest.blockKey,
        );
    if (!target) {
      setRevealRequest(null);
      return;
    }
    const nodes = Array.from(
      document.querySelectorAll<HTMLElement>(
        `.pv-block[data-key="${CSS.escape(target.key)}"], .pv-cell[data-key="${CSS.escape(target.key)}"]`,
      ),
    );
    if (nodes.length === 0) {
      const timer = window.setTimeout(() => {
        setRevealRequest((current) => (current ? { ...current } : current));
      }, 16);
      return () => window.clearTimeout(timer);
    }
    const reduceMotion =
      window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches ===
      true;
    for (const node of nodes) {
      node.scrollIntoView({
        block: "center",
        behavior: reduceMotion ? "auto" : "smooth",
      });
      node.classList.add("is-revealed");
      window.setTimeout(() => node.classList.remove("is-revealed"), 1400);
    }
    setRevealRequest(null);
  }, [host.model.blocks, revealRequest]);
  const selectionCounts = useMemo<Record<BulkAction, number>>(() => {
    const reviewable = (block: PreviewBlockView) =>
      block.hasCache &&
      block.canRetranslate &&
      !block.human &&
      block.status !== "deleted" &&
      block.status !== "untranslated" &&
      Boolean(block.targetRaw.trim());
    return {
      retranslate: selectedBlocks.filter(
        (block) => block.canRetranslate && block.status !== "deleted",
      ).length,
      review: selectedBlocks.filter(reviewable).length,
      backTranslate: selectedBlocks.filter(
        (block) => block.canBackTranslate,
      ).length,
      markSynced: selectedBlocks.filter(
        (block) => block.canMarkSynced,
      ).length,
      deleteTranslation: selectedBlocks.filter(
        (block) => block.hasCache && block.status !== "deleted",
      ).length,
    };
  }, [selectedBlocks]);

  // 模型刷新后清理已消失或内容/锁定态变化的块，避免把旧选择带到新结构上。
  useEffect(() => {
    const byKey = new Map(
      host.model.blocks
        .filter((block) => block.blockIndex >= 0)
        .map((block) => [block.key, block]),
    );
    setSelectedKeys((current) => {
      let changed = false;
      const next = new Set<string>();
      for (const key of current) {
        const block = byKey.get(key);
        if (
          block &&
          selectionSignatures.current.get(key) ===
            blockSelectionSignature(block)
        ) {
          next.add(key);
        } else {
          selectionSignatures.current.delete(key);
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [host.model.blocks]);

  useEffect(() => {
    if (selectionMode && selectableBlocks.length === 0) {
      setSelectionMode(false);
      setSelectedKeys(new Set());
      selectionSignatures.current.clear();
      lastSelectedKey.current = null;
    }
  }, [selectionMode, selectableBlocks.length]);

  useEffect(() => {
    if (!selectionMode) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.key === "Escape" &&
        !editing &&
        !insert &&
        !menu &&
        !annotationTarget
      ) {
        event.preventDefault();
        setSelectionMode(false);
        setSelectedKeys(new Set());
        selectionSignatures.current.clear();
        lastSelectedKey.current = null;
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [annotationTarget, editing, insert, menu, selectionMode]);

  const clearSelection = () => {
    dragSelectionRef.current = null;
    suppressSelectionClick.current = false;
    setSelectedKeys(new Set());
    selectionSignatures.current.clear();
    lastSelectedKey.current = null;
  };

  const exitSelection = () => {
    setSelectionMode(false);
    clearSelection();
  };

  const toggleSelectionMode = () => {
    if (busy) {
      return;
    }
    if (selectionMode) {
      exitSelection();
      return;
    }
    setEditing(null);
    setInsert(null);
    setMenu(null);
    setAnnotationTarget(null);
    clearSelection();
    setSelectionMode(true);
  };

  const selectAllBlocks = () => {
    selectionSignatures.current = new Map(
      selectableBlocks.map((block) => [
        block.key,
        blockSelectionSignature(block),
      ]),
    );
    setSelectedKeys(new Set(selectableBlocks.map((block) => block.key)));
    lastSelectedKey.current = null;
  };

  const toggleBlockSelection = (
    block: PreviewBlockView,
    shiftKey: boolean,
  ) => {
    if (busy || block.blockIndex < 0) {
      return;
    }
    const key = block.key;
    setSelectedKeys((current) => {
      const next = new Set(current);
      if (shiftKey && lastSelectedKey.current) {
        const from = selectableBlocks.findIndex(
          (item) => item.key === lastSelectedKey.current,
        );
        const to = selectableBlocks.findIndex((item) => item.key === key);
        if (from >= 0 && to >= 0) {
          const start = Math.min(from, to);
          const end = Math.max(from, to);
          for (let index = start; index <= end; index += 1) {
            const item = selectableBlocks[index];
            next.add(item.key);
            selectionSignatures.current.set(
              item.key,
              blockSelectionSignature(item),
            );
          }
          lastSelectedKey.current = key;
          return next;
        }
      }
      if (next.has(key)) {
        next.delete(key);
        selectionSignatures.current.delete(key);
      } else {
        next.add(key);
        selectionSignatures.current.set(
          key,
          blockSelectionSignature(block),
        );
      }
      lastSelectedKey.current = key;
      return next;
    });
  };

  const applyDragRange = (
    fromKey: string,
    toKey: string,
    mode: "select" | "deselect",
  ) => {
    const from = selectableBlocks.findIndex((block) => block.key === fromKey);
    const to = selectableBlocks.findIndex((block) => block.key === toKey);
    if (from < 0 || to < 0) {
      return;
    }
    const start = Math.min(from, to);
    const end = Math.max(from, to);
    const range = selectableBlocks.slice(start, end + 1);
    for (const block of range) {
      if (mode === "select") {
        selectionSignatures.current.set(
          block.key,
          blockSelectionSignature(block),
        );
      } else {
        selectionSignatures.current.delete(block.key);
      }
    }
    setSelectedKeys((current) => {
      const next = new Set(current);
      for (const block of range) {
        if (mode === "select") {
          next.add(block.key);
        } else {
          next.delete(block.key);
        }
      }
      return next;
    });
    lastSelectedKey.current = toKey;
  };

  const handleBodyClick = (event: JSX.TargetedMouseEvent<HTMLDivElement>) => {
    if (!selectionMode || busy) {
      return;
    }
    if (suppressSelectionClick.current) {
      suppressSelectionClick.current = false;
      return;
    }
    if (isSelectionInteractiveTarget(event.target)) {
      return;
    }
    const key = selectionKeyFromTarget(event.target);
    const block = key ? blockByKey.get(key) : undefined;
    if (!block) {
      return;
    }
    toggleBlockSelection(block, event.shiftKey);
  };

  const handleBodyPointerDown = (
    event: JSX.TargetedPointerEvent<HTMLDivElement>,
  ) => {
    if (!selectionMode || busy || event.button !== 0) {
      return;
    }
    if (isSelectionInteractiveTarget(event.target)) {
      return;
    }
    const key = selectionKeyFromTarget(event.target);
    const block = key ? blockByKey.get(key) : undefined;
    if (!key || !block) {
      return;
    }
    suppressSelectionClick.current = false;
    dragSelectionRef.current = {
      pointerId: event.pointerId,
      mode: selectedKeys.has(key) ? "deselect" : "select",
      anchorKey: key,
      lastKey: key,
      startX: event.clientX,
      startY: event.clientY,
      started: false,
    };
  };

  const handleBodyPointerMove = (
    event: JSX.TargetedPointerEvent<HTMLDivElement>,
  ) => {
    const drag = dragSelectionRef.current;
    if (
      !selectionMode ||
      !drag ||
      drag.pointerId !== event.pointerId
    ) {
      return;
    }
    if (event.pointerType === "mouse" && event.buttons === 0) {
      dragSelectionRef.current = null;
      if (drag.started) {
        window.setTimeout(() => {
          suppressSelectionClick.current = false;
        }, 0);
      }
      return;
    }
    if (isSelectionInteractiveTarget(event.target)) {
      return;
    }
    const key = selectionKeyFromTarget(event.target);
    if (!key) {
      return;
    }
    if (!drag.started) {
      if (
        Math.hypot(
          event.clientX - drag.startX,
          event.clientY - drag.startY,
        ) < 4
      ) {
        return;
      }
      drag.started = true;
      suppressSelectionClick.current = true;
      applyDragRange(drag.anchorKey, drag.anchorKey, drag.mode);
    }
    applyDragRange(drag.lastKey, key, drag.mode);
    drag.lastKey = key;
    event.preventDefault();
  };

  const handleBodyPointerUp = (
    event: JSX.TargetedPointerEvent<HTMLDivElement>,
  ) => {
    const drag = dragSelectionRef.current;
    if (!drag || drag.pointerId !== event.pointerId) {
      return;
    }
    dragSelectionRef.current = null;
    if (drag.started) {
      window.setTimeout(() => {
        suppressSelectionClick.current = false;
      }, 0);
    }
  };

  const handleBodyPointerCancel = () => {
    dragSelectionRef.current = null;
    suppressSelectionClick.current = false;
  };

  const handleBodyPointerLeave = () => {
    const drag = dragSelectionRef.current;
    if (!drag) {
      return;
    }
    dragSelectionRef.current = null;
    if (drag.started) {
      window.setTimeout(() => {
        suppressSelectionClick.current = false;
      }, 0);
    }
  };

  const sendBulkAction = (action: BulkAction) => {
    if (busy) {
      return;
    }
    const current = selectedBlocks.filter(
      (block) =>
        selectionSignatures.current.get(block.key) ===
        blockSelectionSignature(block),
    );
    if (current.length !== selectedBlocks.length) {
      showToast(text.preview.selection.changed, "info");
      const nextKeys = new Set(current.map((block) => block.key));
      setSelectedKeys(nextKeys);
      for (const key of [...selectionSignatures.current.keys()]) {
        if (!nextKeys.has(key)) {
          selectionSignatures.current.delete(key);
        }
      }
    }
    const payload: BlockSelection[] = current.map((block) => ({
      blockIndex: block.blockIndex,
      ...(block.sourceHash ? { sourceHash: block.sourceHash } : {}),
      ...(block.cacheId ? { cacheId: block.cacheId } : {}),
      ...(block.cacheDst ? { cacheDst: block.cacheDst } : {}),
      human: block.human,
    }));
    if (payload.length === 0) {
      return;
    }
    switch (action) {
      case "retranslate":
        sendMessage({ type: "retranslateBlocks", blocks: payload });
        break;
      case "review":
        sendMessage({ type: "reviewBlocks", blocks: payload });
        break;
      case "backTranslate":
        sendMessage({ type: "backTranslateBlocks", blocks: payload });
        break;
      case "markSynced":
        sendMessage({ type: "markSyncedBlocks", blocks: payload });
        break;
      case "deleteTranslation":
        sendMessage({ type: "deleteTargetBlocks", blocks: payload });
        break;
      default:
        break;
    }
  };

  const startEdit = (block: PreviewBlockView, side: Side) => {
    if (locked || selectionMode) {
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
    if (!editing || locked) {
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
    if (locked || selectionMode) {
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
    if (!insert || locked) {
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

  const openAnnotationsForBlock = (block: PreviewBlockView) => {
    if (busy || selectionMode) {
      return;
    }
    const node = Array.from(
      document.querySelectorAll<HTMLElement>(".pv-block, .pv-cell"),
    ).find((element) => element.dataset.key === block.key);
    const rect = node?.getBoundingClientRect();
    setAnnotationTarget({
      block,
      x: rect ? Math.min(window.innerWidth - 8, rect.right) : window.innerWidth - 16,
      y: rect ? Math.max(8, rect.top + 24) : 72,
    });
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
          { label: text.preview.actions.editTarget, icon: "edit", disabled: locked, onSelect: () => startEdit(block, "target") },
          { separator: true },
          {
            label: text.preview.actions.backTranslateTarget,
            icon: "arrow-swap",
            onSelect: () => sendMessage({ type: "backTranslateTargetOnly", standaloneId: block.standaloneTargetId! }),
          },
          {
            label: text.preview.actions.removeStandalone,
            icon: "trash",
            disabled: locked,
            onSelect: () => sendMessage({ type: "deleteTargetOnlyBlock", standaloneId: block.standaloneTargetId! }),
          },
        );
      }
      return items;
    }
    if (isPending) {
      if (includeSource) {
        items.push(
          { label: text.preview.actions.editSource, icon: "edit", disabled: locked, onSelect: () => startEdit(block, "source") },
          {
            label: text.preview.actions.removeInsert,
            icon: "trash",
            disabled: locked,
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
          disabled: locked,
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
        { label: text.preview.actions.editSource, icon: "edit", disabled: locked, onSelect: () => startEdit(block, "source") },
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
          disabled: locked,
          onSelect: () => sendMessage({ type: "undoDeleteTargetBlock", blockIndex: block.blockIndex }),
        });
      } else {
        if (block.canEditTarget) {
          items.push({
            label: text.preview.actions.editTarget,
            icon: "edit",
            disabled: locked,
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
            disabled: locked,
            onSelect: () => startInsert(block.blockIndex, "source"),
          },
          {
            label: `${text.preview.actions.insertBlock}: ${text.preview.actions.targetChoice}`,
            icon: "diff-added",
            disabled: locked,
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
            disabled: block.sourceDeleted || locked,
            onSelect: () => sendMessage({ type: "deleteSourceBlock", blockIndex: block.blockIndex }),
          },
        );
      }
    }
    const counts = annotationCounts(block);
    items.push(
      { separator: true },
      {
        label: fmt(
          counts.attention > 0
            ? text.preview.annotations.openCount
            : text.preview.annotations.viewCount,
          {
            count:
              counts.attention > 0 ? counts.attention : counts.total,
          },
        ),
        icon: "comment-discussion",
        onSelect: () => openAnnotationsForBlock(block),
      },
    );
    if (side === "source" && !block.sourceDeleted && !isStandalone) {
      // 分栏源单元格只提供源侧插入/删除；目标侧操作在译文单元格中。
      items.push(
        { separator: true },
        { label: text.preview.actions.insertBlock, icon: "diff-added", disabled: locked, onSelect: () => startInsert(block.blockIndex, "source") },
        { label: text.preview.actions.deleteSourceBlock, icon: "trash", disabled: locked, onSelect: () => sendMessage({ type: "deleteSourceBlock", blockIndex: block.blockIndex }) },
      );
    }
    return items;
  };

  const toolbarMenu = (event: MouseEvent) => {
    const items: MenuEntry[] = [
      {
        label: text.preview.toolbar.importTranslation,
        icon: "cloud-download",
        disabled: locked,
        onSelect: () => sendMessage({ type: "importTranslation" }),
      },
      {
        label: text.preview.toolbar.checkConsistency,
        icon: "checklist",
        disabled: !host.model.cacheExists || locked,
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
        disabled: locked,
        onSelect: () => startInsert(-1, "source"),
      },
      { separator: true },
      {
        label: fmt(text.preview.actions.applySource, { count: host.model.pendingSourceCount }),
        icon: "check-all",
        disabled: host.model.pendingSourceCount === 0 || locked,
        onSelect: () => sendMessage({ type: "applySourceEdits" }),
      },
      {
        label: text.preview.actions.resetSource,
        icon: "trash",
        disabled: host.model.pendingSourceCount === 0 || locked,
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
  const updateBrief = (patch: Partial<TranslationBrief>) => {
    setBriefDraft((current) => ({ ...current, ...patch }));
    setBriefDirty(true);
  };
  const saveBrief = () => {
    if (locked) {
      return;
    }
    if (!summaryDraft.trim()) {
      showToast(text.preview.summary.empty, "error");
      return;
    }
    const parsed = parseGlossaryRows(glossaryDraft);
    const validation = validateGlossaryRows(parsed.rows);
    if (parsed.invalidLines.length > 0 || validation.hasErrors) {
      showToast(text.preview.summary.glossarySaveBlocked, "error");
      return;
    }
    const cleaned = cleanGlossaryText(glossaryDraft);
    const brief = normalizeBriefDraft(briefDraft);
    pendingBriefSave.current = briefSaveSignature(
      summaryDraft,
      brief,
      cleaned,
    );
    glossaryDraftRef.current = cleaned;
    setGlossaryDraft(cleaned);
    sendMessage({
      type: "saveBrief",
      summaryText: summaryDraft,
      brief,
      glossaryText: cleaned,
    });
  };

  const openBlockMenu = (
    event: MouseEvent,
    block: PreviewBlockView,
    side?: Side,
  ) => {
    if (busy || selectionMode) {
      return;
    }
    openMenu(event, blockMenuItems(block, side));
  };

  const activeAnnotationBlock = annotationTarget
    ? host.model.blocks.find(
        (block) => block.key === annotationTarget.block.key,
      ) ?? annotationTarget.block
    : null;

  return (
    <div
      class={`pv-app${busy ? " is-busy" : ""}${
        selectionMode ? " is-selecting" : ""
      }`}
      data-layout={layout}
      data-mode={mode}
    >
      <Toolbar
        model={host.model}
        text={text}
        busy={busy}
        locked={locked}
        selectionMode={selectionMode}
        canSelect={selectableBlocks.length > 0}
        taskActivity={taskActivity}
        onSync={() => sendMessage({ type: "sync" })}
        onReview={() => sendMessage({ type: "reviewMachineBlocks" })}
        onExport={() => sendMessage({ type: "export" })}
        onRefresh={() => sendMessage({ type: "refresh" })}
        toolbarMenu={toolbarMenu}
        onToggleSelection={toggleSelectionMode}
        onOpenTasks={() => sendMessage({ type: "openTaskPanel" })}
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
      {selectionMode ? (
        <SelectionBar
          text={text}
          selectedCount={selectedBlocks.length}
          counts={selectionCounts}
          onAction={sendBulkAction}
          onSelectAll={selectAllBlocks}
          onClear={clearSelection}
          onExit={exitSelection}
        />
      ) : null}
      <Notices
        model={host.model}
        text={text}
        busy={busy}
        locked={locked}
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
          locked={locked}
          stableTranslation={assist.stableTranslation}
          summaryContext={assist.summaryContext}
          summaryDraft={summaryDraft}
          glossaryDraft={glossaryDraft}
          brief={briefDraft}
          onToggle={() => setSummaryOpen((open) => !open)}
          onDraft={(value) => {
            setSummaryDirty(true);
            setSummaryDraft(value);
          }}
          onGlossaryDraft={(value) => {
            setGlossaryDirty(true);
            setGlossaryDraft(value);
          }}
          onBriefDraft={updateBrief}
          onGenerate={() => {
            if (busy) return;
            pendingBriefSave.current = null;
            setSummaryDirty(false);
            setBriefDirty(false);
            setGlossaryDirty(false);
            sendMessage({ type: "generateSummary" });
          }}
          onSave={saveBrief}
          onClear={() => {
            if (locked) return;
            pendingBriefSave.current = null;
            setSummaryDirty(false);
            setBriefDirty(false);
            setGlossaryDirty(false);
            sendMessage({ type: "clearSummary" });
          }}
          onAssist={(key, value) => {
            if (locked) return;
            setAssist((current) => ({ ...current, [key]: value }));
            sendMessage({ type: "setAssistToggle", key, value });
          }}
        />
      )}
      <div
        ref={bodyRef}
        class={`pv-body${layout === "split" ? " is-split" : ""}`}
        onClick={handleBodyClick}
        onPointerDown={handleBodyPointerDown}
        onPointerMove={handleBodyPointerMove}
        onPointerUp={handleBodyPointerUp}
        onPointerCancel={handleBodyPointerCancel}
        onPointerLeave={handleBodyPointerLeave}
      >
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
            busy={locked}
            editing={editing}
            insert={insert}
            selectionMode={selectionMode}
            selectedKeys={selectedKeys}
            onMenu={openBlockMenu}
            onRetranslate={retranslateBlock}
            onAnnotations={openAnnotationsForBlock}
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
                busy={locked}
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
                busy={locked}
                readonly={false}
                editing={editing}
                insert={insert}
                selectionMode={selectionMode}
                selected={selectedKeys.has(block.key)}
                onMenu={(event, target, side) => openBlockMenu(event, target, side)}
                onRetranslate={retranslateBlock}
                onAnnotations={openAnnotationsForBlock}
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
      {annotationTarget && activeAnnotationBlock ? (
        <AnnotationPopover
          target={annotationTarget}
          block={activeAnnotationBlock}
          text={text}
          busy={locked}
          reviewSupported={host.model.reviewSupported}
          annotationsSupported={host.model.annotationsSupported}
          onClose={() => setAnnotationTarget(null)}
          onReview={() =>
            sendMessage({
              type: "reviewBlock",
              blockIndex: activeAnnotationBlock.blockIndex,
            })
          }
          onSave={(input) =>
            sendMessage({
              type: "saveAnnotation",
              blockIndex: activeAnnotationBlock.blockIndex,
              sourceHash: activeAnnotationBlock.sourceHash,
              cacheId: activeAnnotationBlock.cacheId,
              ...input,
            })
          }
          onStatus={(annotationId, status) =>
            sendMessage({
              type: "setAnnotationStatus",
              annotationId,
              status,
            })
          }
          onDelete={(annotationId) =>
            sendMessage({ type: "deleteAnnotation", annotationId })
          }
          onUpdate={(annotationId, input) =>
            sendMessage({ type: "updateAnnotation", annotationId, ...input })
          }
        />
      ) : null}
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
        shifted={Boolean(annotationTarget)}
        onDismiss={(id) => setToasts((current) => current.filter((toast) => toast.id !== id))}
      />
    </div>
  );
}
