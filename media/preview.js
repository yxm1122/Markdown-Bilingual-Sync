/**
 * 双语预览 Webview 前端脚本。
 *
 * 运行环境：VS Code Webview（浏览器环境，无 Node API）。页面结构由 src/preview/html.ts
 * 以 nonce 脚本引入本文件；scripts/render-sample.ts 生成的 tmp/preview*.html 也会直接
 * 引用同一份脚本，用浏览器打开时进入 standalone 模式。
 *
 * 与扩展主进程的通信：
 * - 上行：vscode.postMessage({ type, ... })，type 对应
 *   src/preview/previewManager.ts 的 onMessage switch（sync、export、stageSourceEdit、
 *   saveTargetEdit、togglePaneReadonly、openLink 等）。
 * - 下行：window 的 message 事件，type 为 busy / toast / exportSettled / exportError /
 *   sourceConfirm / sourceSettled / sourceError。
 *
 * 无 VS Code API 时（静态预览）退化为 localStorage 保存状态、window.__mbsMessages 记录
 * 上行消息并 toast 显示动作，便于离线检查布局。
 *
 * 安全约定：用户/文档内容一律通过 textContent、value 或 dataset 写入，不拼 innerHTML；
 * 页面 CSP 只允许 nonce 脚本与受控的图片/样式来源，因此不要在此文件使用 eval 或内联事件属性。
 */
(function () {
  "use strict";

  // ---- 运行环境：VS Code Webview 与 standalone 静态预览 ----
  // acquireVsCodeApi 只存在于真实 Webview；静态预览里没有它，用它判断运行环境。
  const standalone = typeof acquireVsCodeApi !== "function";
  const vscode = standalone
    ? {
        // 最小可用的宿主替身：只实现本文件依赖的状态与消息接口。
        postMessage(message) {
          window.__mbsMessages = (window.__mbsMessages || []).concat([message]);
          console.log("[mbs] message", message);
        },
        getState() {
          try {
            return JSON.parse(window.localStorage.getItem("mbs-preview-state") || "{}");
          } catch {
            return {};
          }
        },
        setState(state) {
          try {
            window.localStorage.setItem("mbs-preview-state", JSON.stringify(state));
          } catch {
            /* ignore */
          }
        },
      }
    : acquireVsCodeApi();

  const root = document.querySelector(".mbs-root");
  const toast = document.querySelector(".mbs-toast");
  if (!root) {
    return;
  }

  // 文案由宿主页面序列化到 #mbs-ui-text（见 html.ts 的 webviewText），避免在 JS 里
  // 重复维护中文字符串；解析失败时退化为空表，界面只缺文案不报错。
  const uiTextNode = document.getElementById("mbs-ui-text");
  const TEXT = (function () {
    try {
      return JSON.parse(uiTextNode?.textContent || "{}");
    } catch {
      return {};
    }
  })();

  /**
   * 与主进程 formatText() 相同的 {name} 插值规则：只替换 values 中存在的键。
   * @param {string} key TEXT 中的键。
   * @param {Record<string, string | number>} [values] 占位符取值。
   * @returns {string} 替换后的文案。
   */
  function text(key, values) {
    const template = typeof TEXT[key] === "string" ? TEXT[key] : "";
    return template.replace(/\{(\w+)\}/g, function (match, name) {
      return values && Object.prototype.hasOwnProperty.call(values, name)
        ? String(values[name])
        : match;
    });
  }

  // ---- 状态持久化与轻提示 ----
  // 宿主每次 update() 都会重建 webview.html，DOM 与 JS 变量随之重置；因此把模式、
  // 滚动位置等跨刷新状态写入 vscode.setState（standalone 下写入 localStorage）。
  let toastTimer = 0;
  const state = (function () {
    try {
      return Object.assign({}, vscode.getState() || {});
    } catch {
      return {};
    }
  })();

  /**
   * 合并并持久化一份状态补丁。
   * @param {Record<string, unknown>} patch 需要写入的状态字段。
   */
  function saveState(patch) {
    Object.assign(state, patch);
    try {
      vscode.setState(state);
    } catch {
      /* ignore */
    }
  }

  // 提示条只写 textContent，不拼 HTML；2.8s 后自动隐藏，重复调用会重置计时。
  function showToast(text, kind) {
    if (!toast) {
      return;
    }
    toast.textContent = text;
    toast.dataset.kind = kind || "info";
    toast.classList.add("is-visible");
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(function () {
      toast.classList.remove("is-visible");
    }, 2800);
  }

  if (toast && toast.dataset.initialText) {
    showToast(toast.dataset.initialText, toast.dataset.initialKind || "info");
    delete toast.dataset.initialText;
    delete toast.dataset.initialKind;
  }

  // ---- 滚动同步与恢复 ----
  // 两种滚动模型：columns/stacked 使用页面滚动；split 使用左右两个 .mbs-split-content
  // 各自滚动。保存时两种位置都记录，恢复时根据当前 DOM 是否存在分栏容器决定恢复方式。
  function splitContents() {
    return {
      source: document.querySelector(
        '.mbs-split-content[data-split-content="source"]',
      ),
      target: document.querySelector(
        '.mbs-split-content[data-split-content="target"]',
      ),
    };
  }

  // 把当前页面/分栏滚动位置写入 state。切换布局/只读等“本地主动触发重绘”前会先调用，
  // 避免最后一次滚动因 100ms 节流尚未落盘而丢失。
  function captureScroll() {
    const panes = splitContents();
    const patch = { pageScroll: window.scrollY };
    if (panes.source instanceof HTMLElement) {
      patch.sourceScroll = panes.source.scrollTop;
    }
    if (panes.target instanceof HTMLElement) {
      patch.targetScroll = panes.target.scrollTop;
    }
    saveState(patch);
  }

  let scrollSaveTimer = 0;
  // 滚动事件非常频繁，用 100ms 节流合并写入，减少 setState 序列化开销。
  function scheduleScrollSave() {
    if (scrollSaveTimer) {
      return;
    }
    scrollSaveTimer = window.setTimeout(function () {
      scrollSaveTimer = 0;
      captureScroll();
    }, 100);
  }

  // 新 DOM 加载后恢复位置：分栏布局恢复两侧容器，其余布局恢复整页滚动。
  function restoreScroll() {
    const panes = splitContents();
    if (panes.source instanceof HTMLElement) {
      panes.source.scrollTop = Number(state.sourceScroll) || 0;
    }
    if (panes.target instanceof HTMLElement) {
      panes.target.scrollTop = Number(state.targetScroll) || 0;
    }
    if (!(panes.source instanceof HTMLElement) && !(panes.target instanceof HTMLElement)) {
      window.scrollTo(0, Number(state.pageScroll) || 0);
    }
  }

  function setupScrollPersistence() {
    const panes = splitContents();
    if (panes.source instanceof HTMLElement) {
      panes.source.addEventListener("scroll", scheduleScrollSave, {
        passive: true,
      });
    }
    if (panes.target instanceof HTMLElement) {
      panes.target.addEventListener("scroll", scheduleScrollSave, {
        passive: true,
      });
    }
    window.addEventListener("scroll", scheduleScrollSave, { passive: true });
    // 首帧恢复一次；80ms 后再恢复一次，等待字体/CSS 布局稳定，避免高度变化导致位置偏移。
    window.requestAnimationFrame(restoreScroll);
    window.setTimeout(restoreScroll, 80);
  }

  // ---- 模式与布局 ----
  // mode 只切换根节点的 data-mode（CSS 控制显示哪一栏），不需要宿主重绘，因此本地生效并持久化。
  function setMode(mode) {
    if (!["bilingual", "source", "target"].includes(mode)) {
      return;
    }
    root.dataset.mode = mode;
    document.querySelectorAll(".mbs-mode-switch [data-mode]").forEach(function (button) {
      button.setAttribute("aria-pressed", String(button.dataset.mode === mode));
    });
    saveState({ mode: mode });
  }

  function updateLayoutButtons(layout) {
    document.querySelectorAll(".mbs-layout-switch [data-layout]").forEach(function (button) {
      button.setAttribute("aria-pressed", String(button.dataset.layout === layout));
    });
  }

  function requestLayout(layout) {
    if (!["columns", "stacked", "split"].includes(layout)) {
      return;
    }
    updateLayoutButtons(layout);
    if (layout !== "split") {
      root.dataset.layout = layout;
    }
    // 布局切换会触发宿主 update() 重建 HTML（split 的 DOM 结构不同，必须由宿主生成）；
    // 重建前先捕获滚动位置，新页面加载后由 restoreScroll() 恢复。
    captureScroll();
    post({ type: "setLayout", layout: layout });
  }

  // ---- 分栏块级滚动同步 ----
  // 左右两侧块高度不同，不能按像素等比映射。这里以“源栏当前可见的第一个块”为锚点，
  // 找到目标栏同一 data-sync-key 的块，把它的顶部对齐到相同偏移。
  function setupSplitScrollSync() {
    const source = document.querySelector(
      '.mbs-split-content[data-split-content="source"]',
    );
    const target = document.querySelector(
      '.mbs-split-content[data-split-content="target"]',
    );
    if (!(source instanceof HTMLElement) || !(target instanceof HTMLElement)) {
      return;
    }

    // 程序化设置 scrollTop 也会触发 scroll 事件；用 WeakMap 标记被同步的一侧，
    // 在它自己的下一次 scroll 事件中跳过，避免两侧互相驱动形成回弹/死循环。
    const suppressed = new WeakMap();
    let frame = 0;

    function pairedBlocks(pane) {
      return Array.from(pane.querySelectorAll("[data-sync-key]"));
    }

    function sync(from, to) {
      // 侧栏被 CSS 隐藏（offsetHeight 为 0）或页面尚未布局时不计算。
      if (from.clientHeight === 0 || to.clientHeight === 0) {
        return;
      }
      const blocks = pairedBlocks(from);
      if (blocks.length === 0) {
        return;
      }
      const fromTop = from.getBoundingClientRect().top;
      let anchor = blocks[blocks.length - 1];
      for (const block of blocks) {
        // 第一个底部越过视口顶部的块，即当前可见（或部分可见）的块。
        if (block.getBoundingClientRect().bottom > fromTop + 1) {
          anchor = block;
          break;
        }
      }
      const key = anchor.dataset.syncKey;
      const twin = pairedBlocks(to).find(function (block) {
        return block.dataset.syncKey === key;
      });
      if (!twin) {
        return;
      }
      const toTop = to.getBoundingClientRect().top;
      const twinTop = twin.getBoundingClientRect().top - toTop + to.scrollTop;
      // offset 取锚点顶部相对源容器顶部的偏移（部分滚出时钳制为 0，保证块顶对齐）。
      const offset = Math.max(
        0,
        anchor.getBoundingClientRect().top - fromTop,
      );
      const nextTop = Math.max(0, twinTop - offset);
      // 小于 2px 视为已经对齐，避免亚像素抖动反复设置 scrollTop。
      if (Math.abs(to.scrollTop - nextTop) < 2) {
        return;
      }
      suppressed.set(to, true);
      to.scrollTop = nextTop;
      // 兜底清除标记：部分浏览器在位置未变时不会再派发 scroll 事件。
      window.setTimeout(function () {
        suppressed.delete(to);
      }, 80);
    }

    function onScroll(from, to) {
      if (suppressed.get(from)) {
        suppressed.delete(from);
        return;
      }
      // 滚动事件可能每帧多次，合并为一次动画帧内的同步。
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(function () {
        sync(from, to);
      });
    }

    source.addEventListener(
      "scroll",
      function () {
        onScroll(source, target);
      },
      { passive: true },
    );
    target.addEventListener(
      "scroll",
      function () {
        onScroll(target, source);
      },
      { passive: true },
    );
  }

  // ---- 与扩展主进程通信 ----
  // 所有上行消息都从这里发出；type 必须与 previewManager.onMessage 的 switch 分支一致。
  // standalone 静态预览没有宿主，只记录消息并 toast 动作类型，方便检查按钮绑定。
  function post(message) {
    vscode.postMessage(message);
    if (standalone) {
      showToast(text("staticPreview", { type: message.type }), "info");
    }
  }

  // ---- 模态框：公共状态与 DOM 引用 ----
  // 预览内有两个互斥模态框：导出确认与原文写回确认。activeModal 记录当前打开的
  // 元素与触发按钮，用于焦点陷阱和关闭后还原焦点。
  const exportModal = document.querySelector(
    ".mbs-modal[data-modal='export']",
  );
  const exportDataNode = document.getElementById("mbs-export-data");
  const sourceDataNode = document.getElementById("mbs-source-data");
  const exportMeta = document.getElementById("mbs-export-meta");
  const exportWarning = document.getElementById("mbs-export-warning");
  const exportError = document.getElementById("mbs-export-error");
  const exportNote = document.getElementById("mbs-export-note");
  const exportDiffTable = document.getElementById("mbs-diff-table");
  const exportLeftLabel = document.getElementById("mbs-diff-left-label");
  const exportRightLabel = document.getElementById("mbs-diff-right-label");
  const exportCancelButton = exportModal
    ? exportModal.querySelector("[data-export-cancel]")
    : null;
  const exportWriteButton = exportModal
    ? exportModal.querySelector("[data-export-write]")
    : null;
  const sourceModal = document.querySelector(
    ".mbs-modal[data-modal='source']",
  );
  const sourceMeta = document.getElementById("mbs-source-meta");
  const sourceError = document.getElementById("mbs-source-error");
  const sourceDiffTable = document.getElementById("mbs-source-diff-table");
  const sourceCancelButton = sourceModal
    ? sourceModal.querySelector("[data-source-cancel]")
    : null;
  const sourceWriteButton = sourceModal
    ? sourceModal.querySelector("[data-source-write]")
    : null;
  let activeModal = null;
  // 写入进行中时禁用对应按钮，防止重复提交；状态只活在本次 Webview 生命周期内。
  let exportBusy = false;
  let sourceBusy = false;

  function modalIsOpen(modal) {
    return Boolean(activeModal && activeModal.el === modal);
  }

  /**
   * 打开模态框并把键盘焦点移入。
   * @param {Element | null} modal 模态框根元素。
   * @param {HTMLElement | null} [focusTarget] 初始焦点；缺省为第一个 button。
   */
  function openModal(modal, focusTarget) {
    if (!modal) {
      return;
    }
    if (activeModal) {
      closeActiveModal(false);
    }
    activeModal = {
      el: modal,
      // 记录触发者，关闭后把焦点还回去（若它仍在 DOM 中）。
      trigger:
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null,
    };
    modal.hidden = false;
    document.body.classList.add("mbs-modal-open");
    // 背景整体 inert：既阻止点击，也让 Tab/读屏不会落到模态框之外。
    root.inert = true;
    const focus =
      focusTarget instanceof HTMLElement
        ? focusTarget
        : modal.querySelector("button");
    if (focus instanceof HTMLElement) {
      focus.focus();
    }
  }

  function closeActiveModal(restoreFocus) {
    if (!activeModal) {
      return;
    }
    const trigger = activeModal.trigger;
    activeModal.el.hidden = true;
    document.body.classList.remove("mbs-modal-open");
    root.inert = false;
    activeModal = null;
    if (restoreFocus !== false && trigger instanceof HTMLElement && trigger.isConnected) {
      trigger.focus();
    }
  }

  // ---- diff 渲染 ----
  // diff 文本来自主进程，但按不可信内容处理：全部用 createElement + textContent 构建，
  // 不拼 innerHTML，既避免注入也符合页面 CSP。
  function appendMeta(container, label, value, asCode) {
    if (!container) {
      return;
    }
    const item = document.createElement("span");
    if (label) {
      const labelEl = document.createElement("span");
      labelEl.className = "mbs-meta-label";
      labelEl.textContent = label;
      item.appendChild(labelEl);
    }
    const valueEl = document.createElement(asCode ? "code" : "strong");
    valueEl.textContent = value;
    item.appendChild(valueEl);
    container.appendChild(item);
  }

  function renderDiffTable(table, diff) {
    if (!table) {
      return;
    }
    table.replaceChildren();
    // 兼容主进程传入的空 diff / 旧格式：rows 不是数组时按“无差异”展示。
    const rows = diff && Array.isArray(diff.rows) ? diff.rows : [];
    const fragment = document.createDocumentFragment();
    for (const row of rows) {
      if (!row || typeof row !== "object") {
        continue;
      }
      if (row.kind === "collapsed" || row.kind === "truncated") {
        const collapsed = document.createElement("div");
        collapsed.className = "mbs-diff-collapsed";
        collapsed.textContent =
          row.kind === "truncated"
            ? text("truncated", { count: Number(row.hidden) || 0 })
            : text("collapsed", { count: Number(row.hidden) || 0 });
        fragment.appendChild(collapsed);
        continue;
      }
      fragment.appendChild(renderDiffRow(row));
    }
    if (rows.length === 0) {
      const empty = document.createElement("div");
      empty.className = "mbs-diff-collapsed";
      empty.textContent = text("emptyDiff");
      fragment.appendChild(empty);
    }
    table.appendChild(fragment);
  }

  function renderDiffRow(row) {
    const rowEl = document.createElement("div");
    rowEl.className = "mbs-diff-row";
    // 只有 change 行着色；其余（context）按普通文本展示。
    rowEl.dataset.kind = row.kind === "change" ? "change" : "context";
    appendDiffCell(rowEl, row.left, "left", rowEl.dataset.kind);
    appendDiffCell(rowEl, row.right, "right", rowEl.dataset.kind);
    return rowEl;
  }

  function appendDiffCell(rowEl, cell, side, rowKind) {
    const line = document.createElement("span");
    line.className = "mbs-diff-ln";
    const code = document.createElement("code");
    code.className = "mbs-diff-code";
    if (cell && typeof cell === "object") {
      // 行号 0 不存在，用 || "" 把 0/NaN 归一为空行号（对侧新增/删除行）。
      line.textContent = String(Number(cell.lineNumber) || "");
      code.textContent = String(cell.text ?? "");
      if (rowKind === "change") {
        code.classList.add(side === "left" ? "is-removed" : "is-added");
      }
    } else {
      code.classList.add("is-empty");
    }
    rowEl.append(line, code);
  }

  // ---- 导出确认弹窗 ----
  // 打开时由宿主在 update() 中把 exportConfirmation 注入 #mbs-export-data 初始 JSON；
  // 写入/取消都是异步的，期间禁用两个按钮，等待 exportSettled 或 exportError。
  function setExportPending(pending) {
    exportBusy = pending;
    if (exportCancelButton instanceof HTMLButtonElement) {
      exportCancelButton.disabled = pending;
    }
    if (exportWriteButton instanceof HTMLButtonElement) {
      exportWriteButton.disabled = pending;
      exportWriteButton.textContent = pending ? text("writing") : text("write");
    }
  }

  function renderExport(data) {
    if (!exportMeta || !exportDiffTable) {
      return;
    }
    exportMeta.replaceChildren();
    appendMeta(exportMeta, text("destination"), String(data.destination || ""), true);
    appendMeta(exportMeta, text("summary"), String(data.summary || ""), false);

    const diff = data.diff && typeof data.diff === "object" ? data.diff : {};
    // 差异统计（+新增 / -删除）用独立 span 着色，数字缺失时按 0 处理。
    const change = document.createElement("span");
    const addEl = document.createElement("span");
    addEl.className = "mbs-diff-stat-add";
    addEl.textContent = "+" + (Number(diff.added) || 0);
    const delEl = document.createElement("span");
    delEl.className = "mbs-diff-stat-del";
    delEl.textContent = "-" + (Number(diff.removed) || 0);
    change.append(addEl, document.createTextNode(" / "), delEl);
    exportMeta.appendChild(change);

    if (exportWarning) {
      const count = Number(data.warningCount) || 0;
      exportWarning.hidden = count === 0;
      exportWarning.textContent =
        count > 0 ? text("warning", { count: count }) : "";
    }

    if (exportNote) {
      const notes = [];
      if (diff.coarse) {
        notes.push(text("noteCoarse"));
      }
      if (diff.truncated) {
        notes.push(text("noteTruncated"));
      }
      exportNote.hidden = notes.length === 0;
      exportNote.textContent = notes.join(" ");
    }

    if (exportLeftLabel) {
      exportLeftLabel.textContent = data.existing
        ? text("currentFile")
        : text("newFile");
    }
    if (exportRightLabel) {
      exportRightLabel.textContent = text("exportContent");
    }

    renderDiffTable(exportDiffTable, diff);
  }

  function showExportError(message) {
    if (!exportError) {
      return;
    }
    exportError.hidden = false;
    exportError.textContent = String(message || text("exportFailed"));
  }

  function clearExportError() {
    if (!exportError) {
      return;
    }
    exportError.hidden = true;
    exportError.textContent = "";
  }

  function openExportModal(data) {
    if (!exportModal || !data || !data.diff) {
      return;
    }
    renderExport(data);
    clearExportError();
    setExportPending(false);
    openModal(exportModal, exportCancelButton);
  }

  function closeExportModal() {
    if (!modalIsOpen(exportModal)) {
      return;
    }
    closeActiveModal();
    setExportPending(false);
  }

  function cancelExport() {
    if (!modalIsOpen(exportModal) || exportBusy) {
      return;
    }
    closeExportModal();
    post({ type: "exportCancel" });
  }

  function writeExport() {
    if (
      !modalIsOpen(exportModal) ||
      !(exportWriteButton instanceof HTMLButtonElement) ||
      exportWriteButton.disabled
    ) {
      return;
    }
    clearExportError();
    setExportPending(true);
    post({ type: "exportWrite" });
  }

  // ---- 原文写回确认弹窗 ----
  // 暂存修改后由宿主发送 sourceConfirm 消息打开；写入结果通过 sourceSettled /
  // sourceError 回到这里。与导出不同，取消不会通知宿主（宿主不持有待确认状态）。
  function setSourcePending(pending) {
    sourceBusy = pending;
    if (sourceCancelButton instanceof HTMLButtonElement) {
      sourceCancelButton.disabled = pending;
    }
    if (sourceWriteButton instanceof HTMLButtonElement) {
      sourceWriteButton.disabled = pending;
      sourceWriteButton.textContent = pending
        ? text("sourceWriting")
        : text("sourceWrite");
    }
  }

  function showSourceError(message) {
    if (!sourceError) {
      return;
    }
    sourceError.hidden = false;
    sourceError.textContent = String(message || text("sourceWriteFailed"));
  }

  function clearSourceError() {
    if (!sourceError) {
      return;
    }
    sourceError.hidden = true;
    sourceError.textContent = "";
  }

  function renderSource(data) {
    if (!sourceMeta || !sourceDiffTable) {
      return;
    }
    sourceMeta.replaceChildren();
    appendMeta(sourceMeta, text("destination"), String(data.destination || ""), true);
    appendMeta(
      sourceMeta,
      text("summary"),
      text("sourceSummary", { count: Number(data.count) || 0 }),
      false,
    );
    renderDiffTable(sourceDiffTable, data.diff);
  }

  function openSourceModal(data) {
    if (!sourceModal || !data || !data.diff) {
      return;
    }
    renderSource(data);
    clearSourceError();
    setSourcePending(false);
    openModal(sourceModal, sourceCancelButton);
  }

  function closeSourceModal() {
    if (!modalIsOpen(sourceModal)) {
      return;
    }
    closeActiveModal();
    setSourcePending(false);
  }

  function writeSource() {
    if (
      !modalIsOpen(sourceModal) ||
      !(sourceWriteButton instanceof HTMLButtonElement) ||
      sourceWriteButton.disabled
    ) {
      return;
    }
    clearSourceError();
    setSourcePending(true);
    post({ type: "writeSourceEdits" });
  }

  // ---- 模态框交互：遮罩、按钮与焦点陷阱 ----
  // 事件绑定在模态框根上而不是按钮上，因为弹窗内容会被 renderDiffTable() 动态替换。
  if (exportModal) {
    exportModal.addEventListener("click", function (event) {
      const target = event.target;
      if (!(target instanceof Element)) {
        return;
      }
      // 点击遮罩或“取消/×”都走取消流程；导出进行中 cancelExport() 会自行忽略。
      if (
        target.closest("[data-export-dismiss]") ||
        target.closest("[data-export-cancel]")
      ) {
        event.preventDefault();
        cancelExport();
        return;
      }
      if (target.closest("[data-export-write]")) {
        event.preventDefault();
        writeExport();
      }
    });
  }

  if (sourceModal) {
    sourceModal.addEventListener("click", function (event) {
      const target = event.target;
      if (!(target instanceof Element)) {
        return;
      }
      if (
        target.closest("[data-source-dismiss]") ||
        target.closest("[data-source-cancel]")
      ) {
        event.preventDefault();
        closeSourceModal();
        return;
      }
      if (target.closest("[data-source-write]")) {
        event.preventDefault();
        writeSource();
      }
    });
  }

  // 全局 Escape 关闭 + Tab 焦点循环：root 已 inert，这里只需在模态框内部首尾之间跳转。
  document.addEventListener("keydown", function (event) {
    if (!activeModal) {
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      if (modalIsOpen(exportModal)) {
        cancelExport();
      } else {
        closeActiveModal();
      }
      return;
    }
    if (event.key !== "Tab") {
      return;
    }
    // 只统计可见、未禁用的按钮（offsetParent 为 null 表示 display:none）。
    const focusable = Array.from(
      activeModal.el.querySelectorAll("button:not(:disabled)"),
    ).filter(function (element) {
      return element instanceof HTMLElement && element.offsetParent !== null;
    });
    if (focusable.length === 0) {
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });

  // ---- 内联编辑 ----
  // 编辑时不把渲染后的 HTML 设为 contenteditable，而是临时插入 textarea 并隐藏原内容：
  // 这样保存的是 Markdown 原始文本，不会把渲染结果反解析回 Markdown，也不破坏块结构。
  function startPaneEdit(pane, kind) {
    if (!(pane instanceof HTMLElement) || pane.dataset.editing === "true") {
      return;
    }
    if (kind !== "source" && kind !== "target") {
      return;
    }
    const block = pane.closest(".mbs-block");
    const raw = pane.querySelector('textarea[data-raw="' + kind + '"]');
    const content = pane.querySelector("[data-edit-content]");
    if (
      !(block instanceof HTMLElement) ||
      !(raw instanceof HTMLTextAreaElement) ||
      !(content instanceof HTMLElement)
    ) {
      return;
    }
    const blockIndex = Number(block.dataset.block);
    if (!Number.isFinite(blockIndex)) {
      return;
    }
    // 三种目标块使用不同的保存消息：独立译文、待回译译文、普通译文。
    const pendingId = block.dataset.pendingId || "";
    const pendingTargetId = block.dataset.pendingTargetId || "";
    const standaloneId = block.dataset.standaloneId || "";
    pane.dataset.editing = "true";
    content.hidden = true;
    const editor = document.createElement("textarea");
    editor.className = "mbs-inline-editor";
    editor.value = raw.value;
    editor.spellcheck = false;
    editor.setAttribute(
      "aria-label",
      kind === "source" ? text("sourceEditHint") : text("targetEditHint"),
    );
    // 行数按内容自适应，同时限制在 5–28 行，避免超长块撑满整个窗口。
    editor.rows = Math.min(28, Math.max(5, raw.value.split("\n").length + 1));
    const bar = document.createElement("div");
    bar.className = "mbs-editor-bar";
    const hint = document.createElement("span");
    hint.className = "mbs-editor-hint";
    hint.textContent =
      kind === "source"
        ? text("sourceEditHint")
        : standaloneId
          ? text("standaloneEditHint")
          : pendingTargetId
            ? text("targetDraftEditHint")
            : text("targetEditHint");
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "mbs-button";
    cancel.textContent = text("cancelEdit");
    const save = document.createElement("button");
    save.type = "button";
    save.className = "mbs-button mbs-button-primary";
    save.textContent =
      kind === "source"
        ? text("saveSourceStage")
        : standaloneId
          ? text("saveStandaloneTarget")
          : pendingTargetId
            ? text("saveTargetDraft")
            : text("saveTarget");
    bar.append(hint, cancel, save);
    pane.append(editor, bar);

    const finish = function () {
      pane.dataset.editing = "false";
      editor.remove();
      bar.remove();
      content.hidden = false;
    };
    const submit = function () {
      const value = editor.value;
      // 服务端也会校验空内容，这里先拦截以保留编辑框和输入。
      if (!value.trim()) {
        showToast(text("emptyEdit"), "error");
        return;
      }
      if (kind === "source") {
        if (pendingId) {
          // 正在编辑“待插入的新原文块”，按 pendingId 更新而不是按块号。
          post({
            type: "updateSourceInsert",
            pendingId: pendingId,
            text: value,
          });
        } else {
          post({ type: "stageSourceEdit", blockIndex: blockIndex, text: value });
        }
      } else {
        if (standaloneId) {
          post({
            type: "updateStandaloneTarget",
            standaloneId: standaloneId,
            text: value,
          });
        } else if (pendingTargetId) {
          post({
            type: "updateTargetInsert",
            pendingTargetId: pendingTargetId,
            text: value,
          });
        } else {
          // 普通译文编辑带上打开编辑框时的原文哈希、缓存 ID 与旧译文，
          // 主进程据此拒绝“编辑期间内容已被其他操作改掉”的写入。
          post({
            type: "saveTargetEdit",
            blockIndex: blockIndex,
            text: value,
            baseText: raw.value,
            sourceHash: block.dataset.sourceHash || "",
            cacheId: block.dataset.cacheId || "",
          });
        }
      }
      finish();
    };
    cancel.addEventListener("click", finish);
    save.addEventListener("click", submit);
    editor.addEventListener("keydown", function (event) {
      if (event.key === "Escape") {
        event.preventDefault();
        finish();
      } else if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
        // Ctrl/Cmd+Enter 与“保存”等价；多行编辑仍用 Enter 换行。
        event.preventDefault();
        submit();
      }
    });
    editor.focus();
  }

  // ---- 插入新块编辑器 ----
  // 插入编辑器不属于任何块，用独立 wrapper 放到目标位置；split 布局下“插入译文”
  // 必须挂到目标栏对应单元格之后，否则会插进源栏的 DOM。
  function removeInsertEditor() {
    const existing = document.querySelector(".mbs-insert-editor");
    if (existing) {
      existing.remove();
    }
  }

  function findSplitTargetCell(block) {
    const content = document.querySelector(
      '.mbs-split-content[data-split-content="target"]',
    );
    if (!(content instanceof HTMLElement)) {
      return null;
    }
    const cells = Array.from(content.querySelectorAll(".mbs-split-cell"));
    // 优先按同步键找同一块的译文单元格，找不到再退回块序号。
    const key = block.dataset.syncKey;
    if (key) {
      const twin = cells.find(function (cell) {
        return cell.dataset.syncKey === key;
      });
      if (twin) {
        return twin;
      }
    }
    const index = block.dataset.block;
    return (
      cells.find(function (cell) {
        return cell.dataset.block === index;
      }) || null
    );
  }

  function startInsertEditor(trigger) {
    if (!(trigger instanceof HTMLElement)) {
      return;
    }
    const action = trigger.dataset.action;
    const block = trigger.closest(".mbs-block");
    const start = action === "insertSourceBlockStart";
    const target = action === "insertTargetBlock";
    // 当前模式隐藏了要插入的那一栏时，先切回双语，否则编辑器会落在不可见区域。
    if (target && root.dataset.mode === "source") {
      setMode("bilingual");
    }
    if (start && root.dataset.mode === "target") {
      setMode("bilingual");
    }
    // -1 表示文档开头；其余情况用触发按钮所在块的序号。
    const afterBlockIndex = start
      ? -1
      : Number(block instanceof HTMLElement ? block.dataset.block : NaN);
    if (!start && !Number.isFinite(afterBlockIndex)) {
      return;
    }
    // 同一时间只保留一个插入编辑器，避免重复提交。
    removeInsertEditor();

    const wrapper = document.createElement("div");
    wrapper.className = "mbs-insert-editor";
    const editor = document.createElement("textarea");
    editor.className = "mbs-inline-editor";
    editor.placeholder = text("insertPlaceholder");
    editor.spellcheck = false;
    editor.rows = 5;
    editor.setAttribute("aria-label", text("insertPlaceholder"));
    const bar = document.createElement("div");
    bar.className = "mbs-editor-bar";
    const hint = document.createElement("span");
    hint.className = "mbs-editor-hint";
    hint.textContent = target
      ? text("targetInsertHint")
      : text("sourceEditHint");
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "mbs-button";
    cancel.textContent = text("cancelEdit");
    const save = document.createElement("button");
    save.type = "button";
    save.className = "mbs-button mbs-button-primary";
    save.textContent = target
      ? text("addStandaloneTarget")
      : text("stageInsert");
    bar.append(hint, cancel, save);
    wrapper.append(editor, bar);

    if (start) {
      // 文档开头插入：split 布局下两个分栏都带 .mbs-blocks，querySelector 取到的是源栏。
      const main = document.querySelector(".mbs-blocks");
      if (!main) {
        return;
      }
      main.prepend(wrapper);
    } else if (block instanceof HTMLElement) {
      if (target && root.dataset.layout === "split") {
        const cell = findSplitTargetCell(block);
        if (cell) {
          cell.after(wrapper);
          wrapper.scrollIntoView({ block: "nearest" });
        } else {
          block.after(wrapper);
        }
      } else {
        block.after(wrapper);
      }
    }

    const finish = function () {
      wrapper.remove();
    };
    const submit = function () {
      const value = editor.value;
      if (!value.trim()) {
        showToast(text("emptyEdit"), "error");
        return;
      }
      // 主进程会解析 Markdown 并决定是否生成独立译文块或待回译块。
      post({
        type: target ? "insertTargetBlock" : "insertSourceBlock",
        afterBlockIndex: afterBlockIndex,
        text: value,
      });
      finish();
    };
    cancel.addEventListener("click", finish);
    save.addEventListener("click", submit);
    editor.addEventListener("keydown", function (event) {
      if (event.key === "Escape") {
        event.preventDefault();
        finish();
      } else if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        submit();
      }
    });
    editor.focus();
  }

  // ---- 初始数据：宿主注入的确认弹窗 ----
  // html.ts 会把 ExportConfirmationView / SourceConfirmationView 序列化进 application/json
  // 脚本标签；这里解析后直接打开模态框，使刷新页面也能保留待确认状态。
  function openInitialSource() {
    if (!sourceDataNode) {
      return;
    }
    const raw = sourceDataNode.textContent;
    if (!raw || !raw.trim()) {
      return;
    }
    try {
      openSourceModal(JSON.parse(raw));
    } catch {
      /* 忽略损坏的初始原文确认数据 */
    }
  }

  function openInitialExport() {
    if (!exportDataNode) {
      return;
    }
    const raw = exportDataNode.textContent;
    if (!raw || !raw.trim()) {
      return;
    }
    try {
      openExportModal(JSON.parse(raw));
    } catch {
      /* 忽略损坏的初始导出数据 */
    }
  }

  // ---- 初始化 ----
  // 先恢复宿主注入的确认弹窗，再恢复模式和滚动；这两步都只操作当前 DOM，不请求宿主。
  openInitialExport();
  openInitialSource();

  setMode(state.mode || "bilingual");
  setupSplitScrollSync();
  setupScrollPersistence();

  // ---- 事件委托：工具栏、模式、布局、块操作与链接 ----
  // 块内容会随宿主重绘整体替换，因此不在每个按钮上绑定监听，统一委托到 root。
  root.addEventListener("click", function (event) {
    const target = event.target;
    if (!(target instanceof Element)) {
      return;
    }

    // 预览模式：仅切换 CSS 显示，不请求宿主。
    const modeButton = target.closest(".mbs-mode-switch button[data-mode]");
    if (modeButton) {
      event.preventDefault();
      setMode(modeButton.dataset.mode || "bilingual");
      return;
    }

    // 对照布局：columns/stacked 本地生效，split 需要宿主重建 DOM。
    const layoutButton = target.closest(".mbs-layout-switch button[data-layout]");
    if (layoutButton) {
      event.preventDefault();
      requestLayout(layoutButton.dataset.layout || "columns");
      return;
    }

    // 插入/删除的二级菜单：同一时间只允许展开一个，重复点击当前项则收起。
    const splitToggle = target.closest("[data-split-toggle]");
    if (splitToggle) {
      event.preventDefault();
      const group = splitToggle.closest(".mbs-split-action");
      if (group) {
        const wasOpen = group.dataset.open === "true";
        document
          .querySelectorAll('.mbs-split-action[data-open="true"]')
          .forEach(function (item) {
            item.removeAttribute("data-open");
          });
        if (!wasOpen) {
          group.dataset.open = "true";
        }
      }
      return;
    }

    // split 布局的“⋯”操作开关：每块操作默认收起，展开时关闭其他单元格。
    const actionsToggle = target.closest(
      '[data-action="toggleCellActions"]',
    );
    if (actionsToggle) {
      event.preventDefault();
      const cell = actionsToggle.closest(".mbs-split-cell");
      if (cell) {
        const open = cell.dataset.actionsOpen !== "true";
        document
          .querySelectorAll('.mbs-split-cell[data-actions-open="true"]')
          .forEach(function (item) {
            item.removeAttribute("data-actions-open");
            const button = item.querySelector(".mbs-actions-toggle");
            if (button) {
              button.setAttribute("aria-expanded", "false");
            }
          });
        if (open) {
          cell.dataset.actionsOpen = "true";
        }
        actionsToggle.setAttribute("aria-expanded", String(open));
      }
      return;
    }

    // 显式的“编辑原文/编辑译文”按钮。
    const editButton = target.closest("[data-edit-pane]");
    if (editButton) {
      event.preventDefault();
      const pane = editButton.closest(".mbs-pane");
      if (pane) {
        startPaneEdit(pane, editButton.dataset.editPane);
      }
      return;
    }

    // 直接点击块内容也可进入编辑；链接点击保留给下方的 openLink 处理。
    const editContent = target.closest("[data-edit-content]");
    if (editContent && !target.closest("a")) {
      const pane = editContent.closest(".mbs-pane");
      if (pane && pane.dataset.editing !== "true") {
        event.preventDefault();
        startPaneEdit(pane, editContent.dataset.editContent);
        return;
      }
    }

    // 其余块级操作统一转成 { type } 消息；先收起所有展开的插入/删除菜单。
    const action = target.closest("[data-action]");
    if (action) {
      event.preventDefault();
      document
        .querySelectorAll('.mbs-split-action[data-open="true"]')
        .forEach(function (item) {
          item.removeAttribute("data-open");
        });
      const type = action.dataset.action;
      if (!type) {
        return;
      }
      if (type === "togglePaneReadonly") {
        // 只读切换会让宿主重绘整页；先记录滚动位置，刷新后恢复阅读位置。
        captureScroll();
      }
      // 插入操作需要先就地创建编辑器，不直接发给宿主。
      if (
        type === "insertSourceBlock" ||
        type === "insertSourceBlockStart" ||
        type === "insertTargetBlock"
      ) {
        startInsertEditor(action);
        return;
      }
      const message = { type: type };
      // 只传递当前操作实际带有的标识字段；主进程会再做类型与存在性校验。
      if (action.dataset.block !== undefined) {
        message.blockIndex = Number(action.dataset.block);
      }
      if (action.dataset.pendingId) {
        message.pendingId = action.dataset.pendingId;
      }
      if (action.dataset.pendingTargetId) {
        message.pendingTargetId = action.dataset.pendingTargetId;
      }
      if (action.dataset.standaloneId) {
        message.standaloneId = action.dataset.standaloneId;
      }
      if (action.dataset.pane) {
        message.pane = action.dataset.pane;
      }
      post(message);
      return;
    }

    // 文档链接：不直接导航 Webview（会丢掉当前页面），交给主进程用系统浏览器打开。
    const link = target.closest("a[data-mbs-href]");
    if (link) {
      event.preventDefault();
      const href = link.dataset.mbsHref;
      if (href) {
        post({ type: "openLink", href: href });
      }
    }
  });

  // 鼠标离开块后自动收起三点菜单与二级操作，避免菜单残留在页面上；
  // relatedTarget 仍在块内时说明只是移到了子元素，不收起。
  root.addEventListener("mouseout", function (event) {
    const target = event.target;
    if (!(target instanceof Element)) {
      return;
    }
    const block = target.closest(".mbs-block");
    if (!block) {
      return;
    }
    const related = event.relatedTarget;
    if (related instanceof Node && block.contains(related)) {
      return;
    }
    block
      .querySelectorAll('.mbs-split-action[data-open="true"]')
      .forEach(function (group) {
        group.removeAttribute("data-open");
      });
    const cell = block.closest(".mbs-split-cell");
    if (cell) {
      cell.removeAttribute("data-actions-open");
      const toggle = cell.querySelector(".mbs-actions-toggle");
      if (toggle) {
        toggle.setAttribute("aria-expanded", "false");
      }
    }
  });

  // ---- 宿主消息处理 ----
  // 只处理扩展主进程主动推送的几种消息；消息形状先做最小校验，未知类型静默忽略。
  // 真实 Webview 中消息只能由宿主注入，standalone 下没有别的发送方。
  window.addEventListener("message", function (event) {
    const message = event.data;
    if (!message || typeof message !== "object") {
      return;
    }
    // 忙碌态：只切换进度条与 aria-busy；message 文本作为提示显示。
    if (message.type === "busy") {
      root.classList.toggle("mbs-busy", Boolean(message.busy));
      root.setAttribute("aria-busy", String(Boolean(message.busy)));
      if (message.busy && message.message) {
        showToast(message.message, "info");
      }
      return;
    }
    if (message.type === "toast") {
      showToast(String(message.text || ""), message.kind || "info");
      return;
    }
    // 写入完成/失败：只在对应模态框仍打开时更新，避免误改已关闭的界面。
    if (message.type === "exportSettled") {
      closeExportModal();
      return;
    }
    if (message.type === "exportError" && modalIsOpen(exportModal)) {
      setExportPending(false);
      showExportError(message.message);
      return;
    }
    // 主进程完成暂存后推来原文 diff，打开写回确认框。
    if (message.type === "sourceConfirm") {
      openSourceModal(message.data);
      return;
    }
    if (message.type === "sourceSettled") {
      closeSourceModal();
      return;
    }
    if (message.type === "sourceError" && modalIsOpen(sourceModal)) {
      setSourcePending(false);
      showSourceError(message.message);
      return;
    }
  });
})();
