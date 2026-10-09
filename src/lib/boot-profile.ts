/**
 * 冷启动打点。
 *
 * 为什么需要它：启动慢的原因可能在 Rust 侧（SQLite 迁移、托盘注册、
 * 窗口创建）、也可能在前端（bundle 解析、hydration、首帧渲染），没有
 * 分段数据只能靠猜。这里用一条极轻量的时间轴把关键阶段记下来，
 * 设置页诊断区可直接查看，无需外接工具。
 *
 * 设计约束：
 *  - 零依赖、零 IPC：只用 `performance.now()`，不影响启动本身。
 *  - 只保留最近一次启动的数据。主桌面层窗口（widget-0）把时间轴发布到
 *    localStorage（跨 WebView 共享）；各窗口自己的打点仍写 sessionStorage
 *    （按浏览上下文隔离，**不跨窗口**——旧注释「设置窗口从 sessionStorage
 *    恢复」的假设不成立，设置窗读到的只会是它自己的加载耗时）。
 *  - 采集失败绝不能影响启动，所有写入都包在 try 里。
 */

/** 阶段名。顺序即时间轴顺序。 */
export type BootPhase =
  | "script-eval" // main.tsx 开始执行
  | "react-mount" // createRoot().render() 调用完成
  | "hydrate-start" // 开始从 SQLite / localStorage 读数据
  | "hydrate-db" // app-store 水合完成
  | "hydrate-settings" // settings-store 水合完成
  | "first-paint"; // 首个真实界面帧（非启动闪屏）

export interface BootMark {
  phase: BootPhase;
  /** 相对 `navigationStart` 的毫秒数，保留一位小数。 */
  at: number;
}

const STORAGE_KEY = "focus-desk.boot-profile.v1";
/** 主窗口发布的共享时间轴（应用冷启动，跨窗口可读）：`{ bootAt, marks }`。 */
const SHARED_KEY = "focus-desk.boot-profile.shared.v1";

const marks: BootMark[] = [];

/** 当前时间轴位置（ms，相对页面导航开始）。 */
function now(): number {
  try {
    return Math.round(performance.now() * 10) / 10;
  } catch {
    return 0;
  }
}

/**
 * 本窗口是否应用冷启动的「主体」（主桌面层 `widget-0`；浏览器预览无 label
 * 同样视为主体）。其余窗口（设置 / 速记 / 全屏展示 / 超级面板…）各自打点
 * 但**不发布**共享时间轴——main.tsx 在每个 WebView 里都会跑，全部发布会让
 * 后开的窗口覆盖掉真正的应用启动数据。
 *
 * 零依赖约束下不 import lib/tauri：直接读 WebView 在用户脚本前注入的
 * internals（@tauri-apps/api 的 getCurrentWindow 同源）。
 */
function isPrimaryBootWindow(): boolean {
  try {
    const internals = (
      window as unknown as {
        __TAURI_INTERNALS__?: { metadata?: { currentWindow?: { label?: string }; label?: string } };
      }
    ).__TAURI_INTERNALS__;
    const label = internals?.metadata?.currentWindow?.label ?? internals?.metadata?.label;
    return label === undefined || label === "widget-0";
  } catch {
    return true;
  }
}

/**
 * 记录一个启动阶段打点。
 * 重复记录同一阶段只保留第一次（StrictMode 下 effect 执行两遍，
 * 第二次的时间没有意义）；sessionStorage 写入失败静默降级（内存数据仍可读）。
 *
 * @param phase - 阶段名，顺序即时间轴顺序。
 * @returns 无。
 * @throws 无（所有写入均包在 try 内——采集绝不能影响启动）。
 *
 * @example
 * ```ts
 * useEffect(() => { markBoot("first-paint"); }, []);
 * ```
 */
export function markBoot(phase: BootPhase): void {
  if (marks.some((m) => m.phase === phase)) return;
  marks.push({ phase, at: now() });
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(marks));
  } catch {
    // sessionStorage 不可用（隐私模式）时静默降级：内存里的数据仍可读。
  }
  if (isPrimaryBootWindow()) {
    try {
      localStorage.setItem(SHARED_KEY, JSON.stringify({ bootAt: Date.now(), marks }));
    } catch {
      // 共享发布失败静默降级：主窗口自身仍可从内存读取。
    }
  }
}

/**
 * 读取本次启动的时间轴。
 * 优先返回主窗口（widget-0）发布的共享时间轴（应用冷启动）；共享缺失时
 * 退回本窗口内存 / sessionStorage 数据；无任何数据时返回空数组。O(n)。
 *
 * @returns 打点数组副本（按记录顺序），元素含阶段名与相对导航开始的毫秒数。
 * @throws 无。
 *
 * @example
 * ```ts
 * console.table(readBootProfile());
 * ```
 */
export function readBootProfile(): BootMark[] {
  // 优先读主窗口发布的共享时间轴（应用冷启动）——本模块的展示方在设置窗，
  // 它自身的打点只反映设置窗的加载耗时，不是应用启动性能（特性本意）。
  try {
    const raw = localStorage.getItem(SHARED_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as { marks?: unknown };
      if (Array.isArray(parsed.marks) && parsed.marks.length > 0) {
        return parsed.marks as BootMark[];
      }
    }
  } catch {
    // fallthrough：共享读不到（损坏 / 主窗口发布失败）退回本窗口数据。
  }
  if (marks.length > 0) return [...marks];
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return Array.isArray(parsed) ? (parsed as BootMark[]) : [];
  } catch {
    return [];
  }
}

/**
 * 把时间轴格式化为「阶段：绝对耗时（+相对上一阶段）」的可读文本。
 * 使用场景：设置页诊断区展示、问题反馈时复制粘贴。
 *
 * @param list - 打点数组，默认 {@link readBootProfile} 的结果。
 * @returns 多行文本；无数据时返回占位提示。O(n)。
 * @throws 无。
 *
 * @example
 * ```ts
 * setTextareaValue(formatBootProfile());
 * ```
 */
export function formatBootProfile(list: BootMark[] = readBootProfile()): string {
  if (list.length === 0) return "（无启动数据）";
  const lines: string[] = [];
  let prev = 0;
  for (const m of list) {
    const delta = Math.round((m.at - prev) * 10) / 10;
    lines.push(`${m.phase.padEnd(18)} ${m.at.toFixed(1)}ms  (+${delta.toFixed(1)}ms)`);
    prev = m.at;
  }
  const total = list[list.length - 1].at;
  lines.push(`${"total".padEnd(18)} ${total.toFixed(1)}ms`);
  return lines.join("\n");
}

/**
 * 读取首帧到达（first-paint）时长。
 *
 * @returns 首帧相对导航开始的毫秒数；无打点数据时返回 null。O(n)。
 * @throws 无。
 *
 * @example
 * ```ts
 * const ms = bootTotalMs(); // 例如 412.5
 * ```
 */
export function bootTotalMs(): number | null {
  const list = readBootProfile();
  const paint = list.find((m) => m.phase === "first-paint");
  return paint ? paint.at : null;
}
