/**
 * [CTX]窗口上下文动作：按前台窗口出专属指令。
 *
 * 同类启动器 的 window 型 cmd 按前台应用的类名/标题正则出指令（Explorer 里给
 * 「复制当前文件夹路径」，浏览器里给「读取当前页 URL」）。Vela 落地：
 * 面板打开时探一次前台进程（game.rs get_foreground_app）：
 *  - explorer.exe → read_explorer_path 拿当前文件夹 → 复制路径 / 在终端打开；
 *  - 常见浏览器（chrome/msedge/firefox/opera/brave/vivaldi…）→ read_browser_url
 *    拿地址栏 → 复制 URL / 收藏到书签组件。
 * 探测是异步的一次性快照（面板打开时取，不订阅），失败/超时不出上下文段。
 */
import { isTauri, invoke } from "./tauri";
import type { Command } from "./commands";

/** 常见桌面浏览器进程名（小写，含尾缀变体）。 */
const BROWSERS = new Set([
  "chrome.exe",
  "msedge.exe",
  "firefox.exe",
  "opera.exe",
  "brave.exe",
  "vivaldi.exe",
  "arc.exe",
  "chromium.exe"
]);

/** 前台是否是资源管理器 / 浏览器（进程名小写匹配）。 */
export function classifyForeground(processName: string): "explorer" | "browser" | null {
  const p = processName.toLowerCase();
  if (p === "explorer.exe") return "explorer";
  if (BROWSERS.has(p)) return "browser";
  return null;
}

/** 书签组件实例的收藏落点：localStorage 键型与 BookmarksWidget 一致
 *  （focus-desk.bookmarks.<instanceId>，数组 {id,name,url}）。写入后靠
 *  widget-config 的广播让已挂载组件自愈读取——书签组件自身每 30s 低频
 *  自刷 + 挂载重读，这里写完即生效口径与便签一致。 */
function appendBookmark(url: string, name: string): boolean {
  const prefix = "focus-desk.bookmarks.";
  let target: string | null = null;
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key && key.startsWith(prefix)) {
      target = key.slice(prefix.length);
      break;
    }
  }
  const id = target ?? "palette";
  const key = `${prefix}${id}`;
  let arr: unknown;
  try {
    arr = JSON.parse(localStorage.getItem(key) ?? "[]");
  } catch {
    arr = [];
  }
  if (!Array.isArray(arr)) arr = [];
  const next = [...(arr as { id?: string; name?: string; url?: string }[]), { id: crypto.randomUUID(), name, url }];
  try {
    localStorage.setItem(key, JSON.stringify(next));
    return true;
  } catch {
    return false;
  }
}

/** 探测结果：前台进程 + 解析出的路径/URL。 */
export type ForegroundContext = {
  type: "explorer" | "browser";
  value: string;
};

/** 一次性探测（面板打开时调；非 Tauri / 全屏 / 失败为 null）。
 *  前台信息取「呼出前快照」（get_summon_foreground）：全局热键 dispatch
 *  在窗口编排前抓的真正前台——面板打开后再取只会得到 Vela 自己。 */
export async function probeForegroundContext(): Promise<ForegroundContext | null> {
  if (!isTauri()) return null;
  try {
    const fg = await invoke<{ process_name: string; window_title: string; is_fullscreen: boolean } | null>(
      "get_summon_foreground"
    );
    if (!fg || fg.is_fullscreen) return null;
    const kind = classifyForeground(fg.process_name);
    if (kind === "explorer") {
      const path = await invoke<string | null>("read_explorer_path");
      if (path && path.trim()) return { type: "explorer", value: path.trim() };
      return null;
    }
    if (kind === "browser") {
      const url = await invoke<string | null>("read_browser_url");
      if (url && /^https?:\/\//i.test(url.trim())) return { type: "browser", value: url.trim() };
      return null;
    }
    return null;
  } catch {
    return null;
  }
}

/** 由探测结果构建上下文命令段。 */
export function buildContextCommands(ctx: ForegroundContext, tr: (zh: string) => string, close: () => void): Command[] {
  const group = tr("当前窗口");
  const copyPath = (text: string, done: string) => () => {
    close();
    if (isTauri()) void invoke("copy_text_to_clipboard", { text }).catch(() => {});
    void import("../components/ToastHost").then(async ({ pushAppToast }) => {
      const { t } = await import("../i18n-lite");
      pushAppToast(t(done), "", "info");
    });
  };
  if (ctx.type === "explorer") {
    return [
      {
        id: "ctx-copy-folder",
        label: tr("复制当前文件夹路径"),
        group,
        hint: ctx.value,
        keywords: ["copy", "path", "folder", "复制", "路径", "explorer"],
        run: copyPath(ctx.value, "已复制路径")
      },
      {
        id: "ctx-terminal",
        label: tr("在终端打开"),
        group,
        keywords: ["terminal", "wt", "powershell", "cmd", "终端"],
        run: () => {
          close();
          if (isTauri()) void invoke("open_terminal_at", { path: ctx.value }).catch(() => {});
        }
      }
    ];
  }
  return [
    {
      id: "ctx-copy-url",
      label: tr("复制当前页网址"),
      group,
      hint: ctx.value.slice(0, 80),
      keywords: ["copy", "url", "复制", "网址", "browser"],
      run: copyPath(ctx.value, "已复制网址")
    },
    {
      id: "ctx-bookmark",
      label: tr("收藏到书签组件"),
      group,
      keywords: ["bookmark", "书签", "收藏", "star"],
      run: () => {
        close();
        const name = titleFromUrl(ctx.value);
        const ok = appendBookmark(ctx.value, name);
        void import("../components/ToastHost").then(async ({ pushAppToast }) => {
          const { t } = await import("../i18n-lite");
          pushAppToast(ok ? t("已收藏到书签") : t("收藏失败"), "", ok ? "info" : "error");
        });
      }
    },
    {
      id: "ctx-open-url",
      label: tr("打开该网址"),
      group,
      keywords: ["open", "url", "打开"],
      run: () => {
        close();
        if (isTauri()) void invoke("open_path", { path: ctx.value }).catch(() => {});
      }
    }
  ];
}

/** URL → 展示名（host + 首段路径；解析失败回原串）。 */
export function titleFromUrl(url: string): string {
  try {
    const u = new URL(url);
    const seg = u.pathname.split("/").filter(Boolean)[0];
    return seg ? `${u.hostname}/${seg}`.slice(0, 80) : u.hostname;
  } catch {
    return url.slice(0, 80);
  }
}
