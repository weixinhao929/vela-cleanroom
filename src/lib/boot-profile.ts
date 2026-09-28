/**
 * 冷启动打点（P4）。
 *
 * 为什么需要它：启动慢的原因可能在 Rust 侧（SQLite 迁移、托盘注册、
 * 窗口创建）、也可能在前端（bundle 解析、hydration、首帧渲染），没有
 * 分段数据只能靠猜。这里用一条极轻量的时间轴把关键阶段记下来，
 * 设置页诊断区可直接查看，无需外接工具。
 *
 * 设计约束：
 *  - 零依赖、零 IPC：只用 `performance.now()`，不影响启动本身。
 *  - 只保留最近一次启动的数据，写进 sessionStorage 便于跨页面（设置窗口）读取。
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
}

/**
 * 读取本次启动的时间轴。
 * 优先返回内存数据；跨窗口场景（设置窗口）从 sessionStorage 恢复；
 * 无任何数据时返回空数组。O(n)。
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
