/**
 * 全屏展示纯逻辑（借鉴 ClassSoftwareHub #5）：hash 模式解析、运行中倒计时
 * 扫描（localStorage 注入）、番茄钟快照插值（sync:pomodoro 载荷 + 墙钟）。
 * 独立窗口不挂桌面层 store，全部从绝对时间戳现算。
 */

export type FullscreenKind = "clock" | "countdown" | "pomodoro";

const KINDS: readonly FullscreenKind[] = ["clock", "countdown", "pomodoro"];

/** 从窗口 hash（#fullscreen&kind=xx）解析模式，未知回退 clock。 */
export function parseFullscreenKind(hash: string): FullscreenKind {
  const query = hash.indexOf("&") >= 0 ? hash.slice(hash.indexOf("&") + 1) : "";
  const kind = new URLSearchParams(query).get("kind") ?? "clock";
  return KINDS.includes(kind as FullscreenKind) ? (kind as FullscreenKind) : "clock";
}

/** 最小 localStorage 读取接口（测试注入假存储）。 */
export interface ReadOnlyStorage {
  getItem(key: string): string | null;
  readonly length: number;
  key(index: number): string | null;
}

/** 枚举 storage 键名。 */
export function storageKeys(ls: ReadOnlyStorage): string[] {
  const out: string[] = [];
  for (let i = 0; i < ls.length; i++) {
    const k = ls.key(i);
    if (k) out.push(k);
  }
  return out;
}

/** 扫描倒计时运行态：任一实例 running 且未到期即返回其 endAt/total（取最早到期的）。 */
export function scanRunningCountdown(ls: ReadOnlyStorage, now = Date.now()): { endAt: number; total: number } | null {
  let best: { endAt: number; total: number } | null = null;
  for (const key of storageKeys(ls)) {
    if (!key.startsWith("focus-desk.countdown.state.")) continue;
    try {
      const p = JSON.parse(ls.getItem(key) ?? "null") as {
        running?: boolean;
        endAt?: number;
        total?: number;
        left?: number;
      } | null;
      if (!p || p.running !== true || typeof p.endAt !== "number" || p.endAt <= now) continue;
      const cand = {
        endAt: p.endAt,
        total: typeof p.total === "number" ? p.total : typeof p.left === "number" ? p.left : 0
      };
      if (!best || cand.endAt < best.endAt) best = cand;
    } catch {
      // 坏数据跳过
    }
  }
  return best;
}

/** sync:pomodoro 快照的最小形状（app-store PomodoroSyncSnapshot 的子集）。 */
export type PomodoroSnapshotLike = {
  pomodoro: { mode: string; timerMode: string; remainingSeconds: number; isRunning: boolean };
  segmentAnchorMs: number | null;
  segmentBaseSeconds: number;
  segmentStartedAt: string | null;
};

/** 番茄钟插值：用墙钟从锚点现算当前秒数（countup 显示已计时，其余倒计时）。 */
export function interpolatePomodoro(
  snap: PomodoroSnapshotLike,
  nowMs: number
): { seconds: number; running: boolean; countUp: boolean; mode: string } {
  const countUp = snap.pomodoro.timerMode === "countup";
  if (!snap.pomodoro.isRunning || snap.segmentAnchorMs === null) {
    return {
      seconds: Math.max(0, Math.round(snap.pomodoro.remainingSeconds)),
      running: false,
      countUp,
      mode: snap.pomodoro.mode
    };
  }
  const elapsed = (nowMs - snap.segmentAnchorMs) / 1000;
  if (countUp) {
    return {
      seconds: Math.max(0, Math.round(snap.segmentBaseSeconds + elapsed)),
      running: true,
      countUp,
      mode: snap.pomodoro.mode
    };
  }
  return {
    seconds: Math.max(0, Math.round(snap.segmentBaseSeconds - elapsed)),
    running: true,
    countUp,
    mode: snap.pomodoro.mode
  };
}

/** 秒 → 大字时间文本（h:mm:ss / mm:ss）。 */
export function fmtBig(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`
    : `${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
}
