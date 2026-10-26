/**
 * jsdom 缺失能力的统一补齐。
 *
 * Node 26 在全局暴露了一个不可用的 localStorage getter，Vitest 的 jsdom 环境不会覆盖它；
 * 因此在 Webview 测试里显式安装一个内存版 Storage。真实 Webview / 浏览器不受影响。
 */

function memoryStorage(): Storage {
  const store = new Map<string, string>();
  return {
    get length() {
      return store.size;
    },
    clear() {
      store.clear();
    },
    getItem(key: string) {
      return store.has(key) ? store.get(key)! : null;
    },
    key(index: number) {
      return Array.from(store.keys())[index] ?? null;
    },
    removeItem(key: string) {
      store.delete(key);
    },
    setItem(key: string, value: string) {
      store.set(key, String(value));
    },
  };
}

function ensureLocalStorage(): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    if (window.localStorage) {
      return;
    }
  } catch {
    /* 继续尝试覆盖 */
  }
  try {
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: memoryStorage(),
    });
  } catch {
    /* 读不到也不应让测试崩溃；需要持久化的用例会显式失败 */
  }
}

/** 安装 CSS.escape、dialog 方法与 localStorage。 */
export function installDomPolyfills(): void {
  ensureLocalStorage();
  const css = (globalThis as unknown as { CSS?: { escape?: (value: string) => string } }).CSS;
  if (!css) {
    (globalThis as unknown as { CSS: { escape: (value: string) => string } }).CSS = {
      escape: (value) => value,
    };
  } else if (typeof css.escape !== "function") {
    css.escape = (value) => value;
  }
  if (typeof HTMLDialogElement !== "undefined") {
    HTMLDialogElement.prototype.showModal = function showModal() {
      this.setAttribute("open", "");
    };
    HTMLDialogElement.prototype.close = function close() {
      this.removeAttribute("open");
    };
  }
}
