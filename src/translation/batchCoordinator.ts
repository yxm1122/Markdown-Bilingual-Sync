/**
 * 跨文件批量合并协调器（translation/batchCoordinator）
 *
 * 职责：在很短的防抖窗口内收集多个文件/多次 Provider 调用，把“语言对相同”的请求
 * 合并成一次 delegate.translate，再把返回结果按原始 id 路由回各自的调用，从而减少
 * 网络请求数、提高小文件的吞吐。
 *
 * 关键不变量：
 * - 合并请求使用 `mbsq_<callId>_<index>` 复合 id，调用方永远看不到复合 id；
 * - 每个调用块必须恰好交付一次：重复交付立即报错，缺失则整个调用失败；
 * - 只合并 sourceLanguage/targetLanguage/全文摘要完全相同的调用；术语表按 source 去重（先到先得）；
 * - 合并后的块仍按 documentId 分批，不同文件的块不会进入同一 HTTP 请求；
 * - 一个调用取消不影响同组其他调用；只有组内所有调用都取消/结算后才 abort 组信号。
 *
 * 外部依赖：被包装的 TranslationProvider；纯内存调度，不读写文件/配置。
 *
 * 安全边界：不解析译文内容；复合 id 仅是内存中的路由键，不写入缓存。
 * 调用方应保证 request.items 非空（本实现不会为空组发起代理请求）。
 */
import { shortHash } from "../util/hash";
import type {
  GlossaryEntry,
  TranslationChunkHandler,
  SummaryRequest,
  SummaryResult,
  TranslationProgress,
  TranslationProvider,
  TranslationRequest,
  TranslationResultItem,
} from "./types";
import { tError } from "../i18n/errors";

// ---- 内部数据结构 ----

/** 一次合并执行的分组：共享一个 AbortController，calls 为同语言对的调用。 */
interface CoordinatorGroup {
  controller: AbortController;
  calls: PendingCall[];
}

/** 一次未结算的 translate 调用及其路由状态。 */
interface PendingCall {
  /** 协调器内自增 id，用于生成唯一复合 id。 */
  id: number;
  request: TranslationRequest;
  signal?: AbortSignal;
  onChunk?: TranslationChunkHandler;
  onProgress?: TranslationProgress;
  /** 原始块 id 集合，用于判断是否交付完整。 */
  expected: Set<string>;
  /** 已交付的 原始 id -> 译文。 */
  delivered: Map<string, string>;
  /** 已交付块数，用于进度上报。 */
  completed: number;
  /** queued（待合并）-> inflight（已进入代理请求）-> settled（已 resolve/reject）。 */
  phase: "queued" | "inflight" | "settled";
  aborted: boolean;
  /** onChunk/onProgress 抛出的错误；最终以它失败该调用。 */
  callbackError?: unknown;
  group?: CoordinatorGroup;
  onAbort?: () => void;
  resolve: (results: TranslationResultItem[]) => void;
  reject: (error: unknown) => void;
}

/** 协调器选项。 */
export interface BatchTranslationCoordinatorOptions {
  /** 合并窗口毫秒数；0 表示下一个宏任务立即合并。默认 25ms。 */
  flushDelayMs?: number;
}

// ---- 合并调度 ----

/**
 * 合并式 Provider 包装器。
 * id 带 `batch:` 前缀以便区分；label 透传被包装 Provider。
 * 本类不持有定时器以外的资源，定时器触发后会清空自身引用。
 */
export class BatchTranslationCoordinator implements TranslationProvider {
  private readonly pending: PendingCall[] = [];
  private readonly flushDelayMs: number;
  private nextCallId = 1;
  private timer?: ReturnType<typeof setTimeout>;

  /**
   * @param delegate 实际执行翻译的 Provider（通常是路由器）。
   * @param options 防抖窗口；负数按 0 处理。
   */
  constructor(
    private readonly delegate: TranslationProvider,
    options: BatchTranslationCoordinatorOptions = {},
  ) {
    this.flushDelayMs = Math.max(0, options.flushDelayMs ?? 25);
  }

  /** 带命名空间的稳定标识，避免与代理 Provider 混淆。 */
  get id(): string {
    return `batch:${this.delegate.id}`;
  }

  /** 显示名透传被包装 Provider。 */
  get label(): string {
    return this.delegate.label;
  }

  /** 摘要能力透传；HTTP 等不支持自动摘要的 Provider 返回 false。 */
  get supportsSummary(): boolean {
    return this.delegate.supportsSummary === true;
  }

  /** 摘要请求不参与跨文件合并，直接转发给被包装 Provider。 */
  summarize(
    request: SummaryRequest,
    signal?: AbortSignal,
  ): Promise<SummaryResult> {
    if (signal?.aborted) {
      return Promise.reject(new Error(tError("common.translationCancelled")));
    }
    if (!this.delegate.summarize || this.delegate.supportsSummary !== true) {
      return Promise.reject(
        new Error(tError("translation.batchSummaryUnsupported")),
      );
    }
    return this.delegate.summarize(request, signal);
  }

  /**
   * 登记一次调用并等待合并执行。
   *
   * 取消：signal 触发时立即以“翻译已取消”reject；若还在队列中会先移出队列。
   * 若组内全部调用都已取消/结算，则 abort 共享的组信号，让代理请求尽快结束。
   *
   * @param request 必须包含至少一个块；语言对决定分组。
   * @returns 该调用自己的结果（原始 id），失败/取消时 reject。
   */
  translate(
    request: TranslationRequest,
    signal?: AbortSignal,
    onProgress?: TranslationProgress,
    onChunk?: TranslationChunkHandler,
  ): Promise<TranslationResultItem[]> {
    if (signal?.aborted) {
      return Promise.reject(new Error(tError("common.translationCancelled")));
    }
    return new Promise<TranslationResultItem[]>((resolve, reject) => {
      const call: PendingCall = {
        id: this.nextCallId,
        request,
        signal,
        onChunk,
        onProgress,
        expected: new Set(request.items.map((item) => item.id)),
        delivered: new Map(),
        completed: 0,
        phase: "queued",
        aborted: false,
        resolve,
        reject,
      };
      this.nextCallId += 1;
      if (signal) {
        // 取消回调：只结算本调用；队列中的要摘除，避免被后续 flush 合并。
        call.onAbort = () => {
          if (call.phase === "settled") {
            return;
          }
          call.aborted = true;
          if (call.phase === "queued") {
            const index = this.pending.indexOf(call);
            if (index >= 0) {
              this.pending.splice(index, 1);
            }
          }
          this.settle(call, false, new Error(tError("common.translationCancelled")));
          // 组内没有“仍在进行且未取消”的调用时，才中止共享请求，避免误伤其他文件。
          const group = call.group;
          if (
            group &&
            group.calls.every(
              (item) => item.aborted || item.phase === "settled",
            )
          ) {
            group.controller.abort();
          }
        };
        signal.addEventListener("abort", call.onAbort, { once: true });
      }
      this.pending.push(call);
      this.scheduleFlush();
    });
  }

  /**
   * 首次登记时启动防抖定时器；窗口结束后一次性取出全部待处理调用，
   * 按语言对分组并行执行。组内执行失败会统一把该组结算为失败。
   */
  private scheduleFlush(): void {
    if (this.timer) {
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = undefined;
      const calls = this.pending.splice(0);
      if (calls.length === 0) {
        return;
      }
      // 以“源语言\0目标语言\0摘要哈希”为键分组：不同语言对或不同全文摘要不能合并，
      // 否则固定上下文会串台。摘要只存哈希，避免把长文本放进 Map 键。
      const groups = new Map<string, PendingCall[]>();
      for (const call of calls) {
        const summaryKey = shortHash(call.request.summary?.trim() ?? "");
        const key = `${call.request.sourceLanguage}\u0000${call.request.targetLanguage}\u0000${summaryKey}`;
        const group = groups.get(key) ?? [];
        group.push(call);
        groups.set(key, group);
      }
      for (const group of groups.values()) {
        // runGroup 内部已捕获代理错误；这里兜底处理其未预期异常，防止调用悬挂。
        void this.runGroup(group).catch((error) => {
          for (const call of group) {
            this.settle(call, false, error);
          }
        });
      }
    }, this.flushDelayMs);
  }

  /**
   * 结算一次调用：幂等（已 settled 直接返回），移除 abort 监听，然后 resolve/reject。
   * 不负责清理 group/delivered，它们随调用对象一起被回收。
   */
  private settle(
    call: PendingCall,
    success: boolean,
    value: TranslationResultItem[] | unknown,
  ): void {
    if (call.phase === "settled") {
      return;
    }
    call.phase = "settled";
    if (call.signal && call.onAbort) {
      call.signal.removeEventListener("abort", call.onAbort);
    }
    if (success) {
      call.resolve(value as TranslationResultItem[]);
    } else {
      call.reject(value);
    }
  }

  /**
   * 执行一个语言对分组：合并块、合并术语、调用代理 Provider，并把结果路由回各调用。
   *
   * 路由规则：
   * - 复合 id 只用于本次代理请求；命中映射后还原为 originalId 写入 delivered；
   * - 代理的 onChunk 每批到达就分发：每个调用只收到属于自己的块，并各自累加进度；
   * - 代理最终返回的 results 中，已通过 onChunk 交付的会跳过，剩余部分再补发一次；
   * - 结束时不看代理是否抛错，而看每个调用是否已收齐：收齐即成功（保留部分成功），
   *   未收齐才用代理错误（或“没有返回全部块”）失败该调用。
   *
   * 取消：组信号传给代理；单个调用取消只标记 aborted 并跳过其后续结果。
   */
  private async runGroup(calls: PendingCall[]): Promise<void> {
    if (calls.length === 0) {
      return;
    }
    const controller = new AbortController();
    const group: CoordinatorGroup = { controller, calls };
    for (const call of calls) {
      call.phase = "inflight";
      call.group = group;
      if (call.signal?.aborted) {
        call.aborted = true;
        this.settle(call, false, new Error(tError("common.translationCancelled")));
      }
    }
    if (calls.every((call) => call.phase === "settled")) {
      return;
    }

    // 复合 id 映射：mbsq_<调用id>_<块下标> -> 原调用/原 id。
    const mapping = new Map<
      string,
      { call: PendingCall; originalId: string }
    >();
    const combinedItems: TranslationRequest["items"] = [];
    for (const call of calls) {
      if (call.aborted) {
        continue;
      }
      call.request.items.forEach((item, index) => {
        const compositeId = `mbsq_${call.id}_${index}`;
        mapping.set(compositeId, {
          call,
          originalId: item.id,
        });
        combinedItems.push({
          ...item,
          id: compositeId,
          // 调用方未提供文档标识时，按调用分配一个，避免不同文件混批。
          documentId: item.documentId ?? `call-${call.id}`,
        });
      });
    }
    if (combinedItems.length === 0) {
      // 理论上前置条件保证非空；防御性返回（调用方不应构造空 items）。
      return;
    }

    // 合并术语：按 source 小写去重，先到先得；不修改各调用原始术语表。
    const glossary: GlossaryEntry[] = [];
    const seenGlossary = new Set<string>();
    for (const call of calls) {
      for (const entry of call.request.glossary) {
        const key = entry.source.toLowerCase();
        if (seenGlossary.has(key)) {
          continue;
        }
        seenGlossary.add(key);
        glossary.push(entry);
      }
    }

    // 代理回调：先按调用分桶（同一批可能跨多个文件），再逐调用串行回调与计数。
    const handleChunk: TranslationChunkHandler = async (results) => {
      const byCall = new Map<
        PendingCall,
        Array<{ id: string; text: string }>
      >();
      for (const result of results) {
        const entry = mapping.get(result.id);
        if (!entry) {
          throw new Error(tError("translation.unexpectedBlock", { id: result.id }));
        }
        if (entry.call.aborted) {
          // 该文件已取消：结果直接丢弃，但不影响同组其他调用。
          continue;
        }
        if (entry.call.delivered.has(entry.originalId)) {
          throw new Error(
            tError("translation.duplicateBlock", { id: entry.originalId }),
          );
        }
        entry.call.delivered.set(entry.originalId, result.text);
        const list = byCall.get(entry.call) ?? [];
        list.push({ id: entry.originalId, text: result.text });
        byCall.set(entry.call, list);
      }
      // 并行通知各调用（不同文件互不阻塞）；任一回调失败都向上抛，代理应停止后续请求。
      const outcomes = await Promise.allSettled(
        [...byCall.entries()].map(async ([call, entries]) => {
          if (call.aborted) {
            return;
          }
          call.completed += entries.length;
          try {
            await call.onChunk?.(
              entries,
              call.completed,
              call.expected.size,
            );
            call.onProgress?.(call.completed, call.expected.size);
          } catch (error) {
            call.callbackError = error;
            throw error;
          }
        }),
      );
      const failed = outcomes.find(
        (outcome): outcome is PromiseRejectedResult =>
          outcome.status === "rejected",
      );
      if (failed) {
        throw failed.reason;
      }
    };

    // 代理调用：onProgress 不透明转发（进度由协调器按调用维度自行上报）。
    let failure: unknown;
    let returned: TranslationResultItem[] | undefined;
    try {
      returned = await this.delegate.translate(
        {
          sourceLanguage: calls[0].request.sourceLanguage,
          targetLanguage: calls[0].request.targetLanguage,
          items: combinedItems,
          glossary,
          ...(calls[0].request.summary?.trim()
            ? { summary: calls[0].request.summary }
            : {}),
        },
        controller.signal,
        undefined,
        handleChunk,
      );
      // 兼容不调用 onChunk、只在最终结果里返回译文的代理：把尚未交付的部分补发一次。
      const remaining = returned.filter((result) => {
        const entry = mapping.get(result.id);
        return entry && !entry.call.delivered.has(entry.originalId);
      });
      if (remaining.length > 0) {
        await handleChunk(
          remaining,
          remaining.length,
          combinedItems.length,
        );
      }
    } catch (error) {
      failure = error;
    }

    // 终态结算：以“每个调用是否收齐”为准；收齐的调用即使代理整体失败也保留成功结果。
    for (const call of calls) {
      if (call.phase === "settled") {
        continue;
      }
      if (call.callbackError) {
        this.settle(call, false, call.callbackError);
        continue;
      }
      if (call.delivered.size === call.expected.size) {
        // 按原请求顺序重建结果；此处 get 必定有值，?? "" 只是类型兜底。
        const results = call.request.items.map((item) => ({
          id: item.id,
          text: call.delivered.get(item.id) ?? "",
        }));
        this.settle(call, true, results);
        continue;
      }
      this.settle(
        call,
        false,
        failure ?? new Error(tError("translation.missingAllBlocks")),
      );
    }
  }
}
