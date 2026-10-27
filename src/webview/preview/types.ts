/**
 * 原生预览前端类型：宿主状态、UI 文案与上行消息。
 *
 * 所有 Host → Webview 类型来自宿主 `src/preview/protocol.ts`；这里只补充浏览器侧的
 * 引导数据与上行消息联合类型。类型导入不会把宿主 Node 模块打进 Webview bundle。
 */
import type { UI_TEXT } from "../../i18n";
import type {
  ExportConfirmationView,
  SourceConfirmationView,
} from "../../export/diffPreview";
import type {
  PreviewAppState,
  PreviewHostMessage,
  PreviewNotice,
} from "../../preview/protocol";
import type { PreviewLayout } from "../../preview/layout";

export type PreviewText = (typeof UI_TEXT)["preview"];
export type ProviderText = (typeof UI_TEXT)["providers"];

export interface UiCatalog {
  preview: PreviewText;
  providers: ProviderText;
  consistency: { noCache: string };
}

export interface BootData {
  state: PreviewAppState;
  notice?: PreviewNotice;
  exportConfirmation?: ExportConfirmationView;
}

export type InboundMessage = PreviewHostMessage;

/** Webview 可以发送给宿主的全部动作（与 PreviewManager.onMessage 对齐）。 */
export type OutboundMessage =
  | { type: "ready" }
  | { type: "setLayout"; layout: PreviewLayout }
  | { type: "togglePaneReadonly"; pane: "source" | "target" }
  | { type: "sync" }
  | { type: "importTranslation" }
  | { type: "checkConsistency" }
  | { type: "refresh" }
  | { type: "editCache" }
  | { type: "export" }
  | { type: "openCacheFolder" }
  | { type: "retranslateAll" }
  | { type: "retranslateStale" }
  | { type: "applySourceEdits" }
  | { type: "discardSourceEdits" }
  | { type: "insertSourceBlock"; afterBlockIndex: number; text: string }
  | { type: "insertTargetBlock"; afterBlockIndex: number; text: string }
  | { type: "stageSourceEdit"; blockIndex: number; text: string; sourceHash?: string }
  | { type: "saveTargetEdit"; blockIndex: number; text: string; baseText: string; sourceHash: string; cacheId?: string }
  | { type: "updateSourceInsert"; pendingId: string; text: string }
  | { type: "removeSourceInsert"; pendingId: string }
  | { type: "updateStandaloneTarget"; standaloneId: string; text: string }
  | { type: "deleteTargetOnlyBlock"; standaloneId: string }
  | { type: "backTranslateTargetOnly"; standaloneId: string }
  | { type: "deleteSourceBlock"; blockIndex: number }
  | { type: "undoDeleteSourceBlock"; blockIndex: number }
  | { type: "deleteTargetBlock"; blockIndex: number }
  | { type: "undoDeleteTargetBlock"; blockIndex: number }
  | { type: "retranslateBlock"; blockIndex: number }
  | { type: "markSynced"; blockIndex: number }
  | { type: "backTranslate"; blockIndex: number }
  | { type: "revealSource"; blockIndex: number }
  | { type: "generateSummary" }
  | { type: "saveSummary"; summaryText: string }
  | { type: "clearSummary" }
  | { type: "saveGlossary"; glossaryText: string }
  | { type: "setAssistToggle"; key: "stableTranslation" | "summaryContext"; value: boolean }
  | { type: "exportWrite" }
  | { type: "exportCancel" }
  | { type: "writeSourceEdits" }
  | { type: "cancelSourceWrite" }
  | { type: "openLink"; href: string };

export interface MenuAction {
  label: string;
  icon?: string;
  hint?: string;
  disabled?: boolean;
  onSelect: () => void;
}

export type MenuEntry = MenuAction | { separator: true };

export interface PendingSourceConfirmation {
  data: SourceConfirmationView;
}
