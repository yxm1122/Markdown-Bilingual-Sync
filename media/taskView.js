/**
 * 翻译任务侧边栏 Webview 脚本。
 *
 * 运行环境：VS Code Webview（辅助侧边栏视图，浏览器环境，无 Node API）。页面骨架由
 * src/status/taskViewHtml.ts 生成并以 nonce 引入本文件；文案通过 #mbs-task-text 里的
 * JSON 注入，避免在脚本中重复中文字符串。
 *
 * 与扩展主进程的通信：
 * - 上行：{ type: "ready" }、{ type: "cancelAll" | "clearFinished" | "openOutput" }、
 *   { type: "cancelTask" | "openSource" | "openPreview", id }、
 *   { type: "setSourceLanguage" | "setTargetLanguage", language }、
 *   { type: "swapLanguages" }；
 * - 下行：{ type: "state", state }，由 TaskViewProvider.sendState() 在任务/并发/语言设置
 *   变化时节流推送（约 100ms），本文件只接受这一种消息。state 中的 sourceLanguage、
 *   targetLanguage 与 supportedLanguages 驱动静态语言区。
 *
 * 渲染策略：任务列表由本脚本用字符串模板整体 innerHTML 重绘，因此所有动态文本都必须
 * 经过 escapeHtml()；事件统一委托到 document，避免每次重绘后重新绑定。语言 <select>
 * 属于静态骨架，只更新 <option> 与选中值，不参与 innerHTML 重绘，避免输入焦点丢失。
 */
(function () {
  "use strict";

  const vscode = acquireVsCodeApi();
  // ---- 文案与基础格式化 ----
  // 文案由宿主以 application/json 注入；解析失败时退化为空对象，界面只缺文案不报错。
  const textNode = document.getElementById("mbs-task-text");
  let TEXT = {};
  try {
    TEXT = JSON.parse(textNode?.textContent || "{}");
  } catch {
    TEXT = {};
  }

  // 固定骨架元素：工具栏按钮只在整页加载时存在，任务内容区每次 state 消息都会重绘。
  const content = document.getElementById("task-content");
  const cancelAllButton = document.querySelector('[data-action="cancelAll"]');
  const clearButton = document.querySelector('[data-action="clearFinished"]');
  const sourceLanguageSelect = document.getElementById("task-source-language");
  const targetLanguageSelect = document.getElementById("task-target-language");
  const swapLanguagesButton = document.querySelector(
    '[data-action="swapLanguages"]',
  );
  let state;

  /**
   * 与主进程 i18n.formatText() 一致的 {name} 插值：只替换 values 中存在的键。
   * @param {string} template 文案模板。
   * @param {Record<string, string | number>} [values] 占位符取值。
   * @returns {string} 替换后的文本。
   */
  function format(template, values) {
    return String(template || "").replace(/\{(\w+)\}/g, function (match, key) {
      return values && Object.prototype.hasOwnProperty.call(values, key)
        ? String(values[key])
        : match;
    });
  }

  /**
   * 转义要插入字符串模板的动态文本。
   * 任务名来自工作区路径、phase/error 来自 Provider 返回值，都可能包含 `<` 或引号；
   * 这里统一转义后再拼 innerHTML，避免 DOM 注入。
   * @param {unknown} value 任意待插入值。
   * @returns {string} 可安全放入 HTML 文本/属性的字符串。
   */
  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  // ---- 语言快捷切换 ----
  // 任务面板 UI 固定为中文，语言名称也按 zh-CN 展示；不支持 Intl.DisplayNames 时退回标签。
  const LANGUAGE_NAME_OVERRIDES = {
    "zh-cn": "中文（简体）",
    "zh-sg": "中文（简体）",
    "zh-hans": "中文（简体）",
    "zh-tw": "中文（繁體）",
    "zh-hk": "中文（繁體）",
    "zh-hant": "中文（繁體）",
  };
  let displayNames;
  try {
    displayNames = new Intl.DisplayNames(["zh-CN"], { type: "language" });
  } catch {
    displayNames = undefined;
  }

  /** 把 BCP-47 标签显示为本地化语言名；失败时原样返回标签。 */
  function languageName(tag) {
    const override = LANGUAGE_NAME_OVERRIDES[String(tag).toLowerCase()];
    if (override) {
      return override;
    }
    if (!displayNames) {
      return tag;
    }
    try {
      const name = displayNames.of(tag);
      return name && name !== tag ? name : tag;
    } catch {
      return tag;
    }
  }

  /** 按大小写不敏感匹配设置选中值；没有匹配时清空选中，避免误显示第一项。 */
  function setSelectValue(select, value, options) {
    if (!select) {
      return;
    }
    const selected = options.find(
      (language) => language.toLowerCase() === String(value).toLowerCase(),
    );
    if (selected) {
      select.value = selected;
    } else {
      select.selectedIndex = -1;
    }
  }

  /**
   * 同步静态语言区。只有选项集合变化时才重建 <option>，避免高频 state 推送打断
   * 已展开的下拉或焦点；选中值用大小写不敏感匹配，兼容设置中与 targetLanguage
   * 仅大小写不同的写法。原文与译文共用同一组候选语言。
   */
  function syncLanguageControls() {
    if (!state) {
      return;
    }
    const supported = Array.isArray(state.supportedLanguages)
      ? state.supportedLanguages.filter(
          (language) => typeof language === "string" && language,
        )
      : [];
    const source =
      typeof state.sourceLanguage === "string" ? state.sourceLanguage : "";
    const target =
      typeof state.targetLanguage === "string" ? state.targetLanguage : "";
    const signature = supported.join("\n");
    for (const select of [sourceLanguageSelect, targetLanguageSelect]) {
      if (!select) {
        continue;
      }
      if (select.dataset.options !== signature) {
        select.replaceChildren();
        for (const language of supported) {
          const option = document.createElement("option");
          option.value = language;
          option.textContent = languageName(language);
          option.title = language;
          select.appendChild(option);
        }
        select.dataset.options = signature;
      }
      select.disabled = supported.length === 0;
    }
    setSelectValue(sourceLanguageSelect, source, supported);
    setSelectValue(targetLanguageSelect, target, supported);
    const sourceOption = supported.find(
      (language) => language.toLowerCase() === source.toLowerCase(),
    );
    const targetOption = supported.find(
      (language) => language.toLowerCase() === target.toLowerCase(),
    );
    if (swapLanguagesButton) {
      swapLanguagesButton.disabled = !(
        sourceOption &&
        targetOption &&
        sourceOption.toLowerCase() !== targetOption.toLowerCase()
      );
    }
  }

  // ---- 任务状态、进度与耗时 ----
  function statusLabel(status) {
    return TEXT.statusLabels && TEXT.statusLabels[status]
      ? TEXT.statusLabels[status]
      : status;
  }

  function elapsedLabel(task, now) {
    if (!task.startedAt) {
      return "";
    }
    // 已完成任务用 finishedAt，运行中任务用本次 state 的生成时间；视图不自行计时，
    // 因此耗时只在宿主推送新状态时刷新。
    const end = task.finishedAt || now;
    const seconds = Math.max(0, (end - task.startedAt) / 1000);
    return format(TEXT.elapsed, { seconds: seconds.toFixed(1) });
  }

  function taskProgress(task) {
    if (task.total > 0) {
      // 钳制 completed，避免 Provider 回报的异常值与 total 不一致导致进度条越界。
      const completed = Math.max(0, Math.min(task.completed, task.total));
      return {
        text: format(TEXT.progress, {
          completed,
          total: task.total,
        }),
        percent: Math.round((completed / task.total) * 100),
      };
    }
    // 没有块数的成功任务（如空文档）直接显示 100% 与“无待翻译块”。
    if (task.status === "success" || task.status === "partial") {
      return { text: TEXT.noBlocks, percent: 100 };
    }
    return { text: "", percent: 0 };
  }

  function taskMeta(task, now) {
    const parts = [];
    const progress = taskProgress(task);
    if (progress.text) {
      parts.push(progress.text);
    }
    if (task.failed > 0) {
      // failedSuffix 自带前导“ · ”，单独展示时去掉，避免与后面的 join 重复。
      parts.push(
        format(TEXT.failedSuffix, { failed: task.failed }).replace(
          /^\s*·\s*/,
          "",
        ),
      );
    }
    const elapsed = elapsedLabel(task, now);
    if (elapsed) {
      parts.push(elapsed);
    }
    return parts.join(" · ");
  }

  // ---- 任务卡片 ----
  // 卡片用字符串模板拼 HTML；动态文本必须 escapeHtml。task.id 由主进程生成为数字，
  // 这里仍直接插入 data-id，若将来改为字符串需一并转义。
  function taskCard(task, active, now) {
    const progress = taskProgress(task);
    const actions = [];
    if (task.hasUri) {
      actions.push(
        '<button type="button" data-action="openSource" data-id="' +
          task.id +
          '">' +
          escapeHtml(TEXT.openSource) +
          "</button>",
        '<button type="button" data-action="openPreview" data-id="' +
          task.id +
          '">' +
          escapeHtml(TEXT.openPreview) +
          "</button>",
      );
    }
    if (active) {
      actions.push(
        '<button type="button" data-action="cancelTask" data-id="' +
          task.id +
          '">' +
          escapeHtml(TEXT.cancelTask) +
          "</button>",
      );
    }
    return (
      '<article class="task-card" data-status="' +
      escapeHtml(task.status) +
      '">' +
      '<div class="task-head">' +
      '<span class="task-dot" aria-hidden="true"></span>' +
      '<span class="task-name" title="' +
      escapeHtml(task.label) +
      '">' +
      escapeHtml(task.label) +
      "</span>" +
      '<span class="task-status">' +
      escapeHtml(statusLabel(task.status)) +
      "</span>" +
      "</div>" +
      '<div class="task-meta"><span>' +
      escapeHtml(taskMeta(task, now)) +
      "</span></div>" +
      '<div class="task-progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' +
      progress.percent +
      '"><div class="task-progress-fill" style="width:' +
      progress.percent +
      '%"></div></div>' +
      (task.phase
        ? '<p class="task-phase">' + escapeHtml(task.phase) + "</p>"
        : "") +
      (task.error
        ? '<p class="task-error">' + escapeHtml(task.error) + "</p>"
        : "") +
      (actions.length
        ? '<div class="task-card-actions">' + actions.join("") + "</div>"
        : "") +
      "</article>"
    );
  }

  // ---- 整页渲染 ----
  // 每次 state 推送都重建 innerHTML；先记录页面滚动位置，重绘后恢复，避免自动刷新时
  // 视图跳回顶部。也因为没有增删 DOM 监听，重绘不会造成事件监听泄漏。
  function render() {
    if (!state || !content) {
      return;
    }
    const scrollTop = window.scrollY;
    // 使用宿主生成 state 的时间作为“当前时间”，避免用户本机时钟与扩展进程不一致。
    const now = Number(state.generatedAt) || Date.now();
    const active = Array.isArray(state.active) ? state.active : [];
    const finished = Array.isArray(state.finished) ? state.finished : [];
    // 活动块统计从任务字段累加；Number() 兜底防止旧版本状态缺字段。
    const activeBlocks = active.reduce(
      (sum, task) => sum + (Number(task.completed) || 0),
      0,
    );
    const totalBlocks = active.reduce(
      (sum, task) => sum + (Number(task.total) || 0),
      0,
    );
    const failedBlocks = active.reduce(
      (sum, task) => sum + (Number(task.failed) || 0),
      0,
    );

    // 工具栏按钮的可用性跟随 state，而不是在本文件里维护一份计数。
    if (cancelAllButton) {
      cancelAllButton.disabled = active.length === 0;
    }
    if (clearButton) {
      clearButton.disabled = finished.length === 0;
    }

    const system = state.system || {};
    // 批量总览：活动文件数、并发占用、活动块数与失败块数。
    const metrics =
      '<section class="task-section"><div class="task-section-title">' +
      escapeHtml(TEXT.overviewTitle) +
      '</div><div class="task-overview">' +
      '<div class="task-metric"><div class="task-metric-label">' +
      escapeHtml(TEXT.activeTasksLabel) +
      '</div><div class="task-metric-value">' +
      active.length +
      "</div></div>" +
      '<div class="task-metric"><div class="task-metric-label">' +
      escapeHtml(TEXT.concurrencyLabel) +
      '</div><div class="task-metric-value">' +
      (state.activeRequests || 0) +
      "/" +
      (state.limit || 0) +
      (state.waiting ? " +" + state.waiting : "") +
      "</div></div>" +
      '<div class="task-metric"><div class="task-metric-label">' +
      escapeHtml(TEXT.activeBlocksLabel) +
      '</div><div class="task-metric-value">' +
      activeBlocks +
      (totalBlocks ? "/" + totalBlocks : "") +
      "</div></div>" +
      '<div class="task-metric"><div class="task-metric-label">' +
      escapeHtml(TEXT.failedBlocksLabel) +
      '</div><div class="task-metric-value' +
      (failedBlocks > 0 ? " is-error" : "") +
      '">' +
      failedBlocks +
      "</div></div></div></section>";

    // 运行状态：Provider/模型/预算/批量上限，全部来自扩展设置快照。
    const systemSection =
      '<section class="task-section"><div class="task-section-title">' +
      escapeHtml(TEXT.systemTitle) +
      '</div><div class="task-system">' +
      "<span>" +
      escapeHtml(TEXT.providerLabel) +
      "</span><span>" +
      escapeHtml(system.provider || "-") +
      "</span>" +
      "<span>" +
      escapeHtml(TEXT.modelLabel) +
      "</span><span>" +
      escapeHtml(system.model || "-") +
      "</span>" +
      "<span>" +
      escapeHtml(TEXT.tokenBudgetLabel) +
      "</span><span>" +
      escapeHtml(system.tokenBudget ?? "-") +
      "</span>" +
      "<span>" +
      escapeHtml(TEXT.batchLimitLabel) +
      "</span><span>" +
      escapeHtml(system.batchSize ?? "-") +
      "</span>" +
      "</div></section>";

    const activeSection =
      active.length > 0
        ? '<section class="task-section"><div class="task-section-title">' +
          escapeHtml(TEXT.activeSection) +
          "</div>" +
          active.map((task) => taskCard(task, true, now)).join("") +
          "</section>"
        : '<p class="task-hint">' + escapeHtml(TEXT.noActive) + "</p>";

    // 历史只展示最近 15 条，主进程最多保留 40 条，避免侧栏过长。
    const historySection =
      finished.length > 0
        ? '<section class="task-section"><div class="task-section-title">' +
          escapeHtml(TEXT.historySection) +
          "</div>" +
          finished
            .slice(0, 15)
            .map((task) => taskCard(task, false, now))
            .join("") +
          "</section>"
        : "";

    // 完全没有任务时给出引导；此时只显示系统状态，不显示全零的统计条。
    const empty =
      active.length === 0 && finished.length === 0
        ? '<div class="task-empty"><div>' +
          escapeHtml(TEXT.empty) +
          "</div><div>" +
          escapeHtml(TEXT.emptyHint) +
          '</div><p class="task-hint">' +
          escapeHtml(TEXT.moveHint) +
          "</p></div>"
        : "";

    content.innerHTML =
      empty
        ? empty + systemSection
        : metrics + systemSection + activeSection + historySection;
    window.scrollTo(0, scrollTop);
  }

  // ---- 宿主消息处理 ----
  // 只接受 { type: "state", state }；其他消息忽略。state 结构由 TaskViewProvider
  // 生成，本文件不做完整 schema 校验，render() 只对缺失的数组/字段做了部分兜底。
  window.addEventListener("message", function (event) {
    const message = event.data;
    if (!message || message.type !== "state") {
      return;
    }
    state = message.state;
    syncLanguageControls();
    render();
  });

  // ---- 事件委托 ----
  // 两个语言选择器是静态元素，直接绑定 change；宿主校验失败时会重新推送 state 还原选中值。
  if (sourceLanguageSelect) {
    sourceLanguageSelect.addEventListener("change", function () {
      if (sourceLanguageSelect.value) {
        vscode.postMessage({
          type: "setSourceLanguage",
          language: sourceLanguageSelect.value,
        });
      }
    });
  }
  if (targetLanguageSelect) {
    targetLanguageSelect.addEventListener("change", function () {
      if (targetLanguageSelect.value) {
        vscode.postMessage({
          type: "setTargetLanguage",
          language: targetLanguageSelect.value,
        });
      }
    });
  }
  // 卡片会被整体重绘，因此点击统一委托到 document。openOutput/cancelAll/clearFinished/
  // swapLanguages 不带 id 直接发送；其余任务级动作必须带整数 id，由主进程 switch 再做
  // 动作白名单校验。
  document.addEventListener("click", function (event) {
    const target = event.target;
    if (!(target instanceof Element)) {
      return;
    }
    const button = target.closest("[data-action]");
    if (!button) {
      return;
    }
    event.preventDefault();
    const action = button.getAttribute("data-action");
    if (!action) {
      return;
    }
    if (
      action === "openOutput" ||
      action === "cancelAll" ||
      action === "clearFinished" ||
      action === "swapLanguages"
    ) {
      vscode.postMessage({ type: action });
      return;
    }
    // 任务级动作必须带整数 id；没有 data-id 时 Number(null)=0 仍会通过 isInteger，
    // 但任务 id 从 1 开始，主进程查不到 0 号任务会直接忽略。
    const id = Number(button.getAttribute("data-id"));
    if (Number.isInteger(id)) {
      vscode.postMessage({ type: action, id });
    }
  });

  // 通知宿主可以推送初始状态；TaskViewProvider 在 resolve 时也会主动 sendState 一次。
  vscode.postMessage({ type: "ready" });
})();
