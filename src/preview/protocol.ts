/**
 * 预览 Webview 的宿主 → 页面消息协议。
 *
 * 页面上行消息仍由 `PreviewManager.onMessage` 逐个校验；这里先约束下行消息，避免
 * 「模型 / 弹窗数据 / 忙碌态」在宿主侧逐渐长成无类型的对象。
 *
 * 关键不变量：
 * - 首次加载由 appShell 生成完整壳；ready 之后只发送 state；
 * - 弹窗数据与业务状态同源，不在页面内自行拼装。
 */
import type {
  ExportConfirmationView,
  SourceConfirmationView,
} from "../export/diffPreview";
import type { PreviewLayout, PreviewReadonlyState } from "./layout";
import type { PreviewModel } from "./previewModel";

/** 页面内提示条的语义类型（与 `showToast` 的 kind 对齐）。 */
export type PreviewToastKind = "info" | "success" | "error";

/** state 消息附带的初始提示。 */
export interface PreviewNotice {
  text: string;
  kind: PreviewToastKind;
}

/** Webview 完成首次挂载后的握手消息。 */
export interface PreviewReadyMessage {
  type: "ready";
}

/** 原生预览组件渲染所需的完整状态。 */
export interface PreviewAppState {
  model: PreviewModel;
  layout: PreviewLayout;
  readonly: PreviewReadonlyState;
}

/** 宿主可以发送给预览页面的全部消息。 */
export type PreviewHostMessage =
  | {
      /** 原生预览：更新模型与面板级状态；页面自行做 keyed 渲染。 */
      type: "state";
      state: PreviewAppState;
      notice?: PreviewNotice;
      exportConfirmation?: ExportConfirmationView;
    }
  | { type: "busy"; busy: boolean; message?: string }
  | { type: "taskActivity"; running: number; queued: number }
  | { type: "toast"; text: string; kind: PreviewToastKind }
  | { type: "sourceConfirm"; data: SourceConfirmationView }
  | { type: "sourceSettled" }
  | { type: "sourceError"; message: string }
  | { type: "exportSettled"; action?: "write" | "cancel" }
  | { type: "exportError"; message: string };
