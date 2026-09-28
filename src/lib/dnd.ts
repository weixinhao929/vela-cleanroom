import { useSyncExternalStore } from "react";
import { persistMirrored } from "./local-backup";

/**
 * 免打扰（DND）全局开关 + 时段计划 —— DOCK 通知中心底部入口手动切换；
 * 设置 → 通知中心磁贴配置页可加「按时段自动开启」（如 22:00–08:00）。
 *
 * 为什么独立于 settings-store：设置切片属 SYS 会话管辖，且免打扰是通知
 * 管道的伴生状态（notifications.ts 与通知中心/Dock 同批演进），放 lib 层
 * 一条最小可订阅存储即可。持久化走 persistMirrored（localStorage 权威 +
 * SQLite lsmirror 镜像，随备份可恢复），键风格对齐 bar-pos.v1。
 *
 * 语义：生效判定 = 手动开关开启 **或** 当前时刻落在计划时段内（见
 * {@link dndSuppressing}，通知派发一律用它；手动开关单独经
 * {@link dndEnabled} 供 UI 回显，避免「时段自动开启中、开关却显示关」的
 * 表达混乱——配置页对时段命中态另有说明文案）。开启后不弹应用内 toast、
 * 不发 OS 系统通知、不响提示音；通知历史照常留档（回看不受影响）。
 * 跨窗口即时性：通知只由主小组件窗口派发，每窗口启动时从 localStorage
 * 读一次即够用；其余窗口的显示层开关在重载前可能短暂不同步，属可接受折衷。
 */

const DND_KEY = "focus-desk.dnd.v1";

/** 时段计划（24h 制 "HH:MM"；start > end 视为跨午夜时段，如 22:00–08:00）。 */
export type DndSchedule = { enabled: boolean; start: string; end: string };

type DndState = { on: boolean; sched?: DndSchedule };

const DEFAULT_SCHEDULE: DndSchedule = { enabled: false, start: "22:00", end: "08:00" };

function readInitial(): DndState {
  try {
    const raw = localStorage.getItem(DND_KEY);
    if (!raw) return { on: false };
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return { on: false };
    const o = parsed as { on?: unknown; sched?: unknown };
    const on = o.on === true;
    const sched =
      o.sched && typeof o.sched === "object"
        ? (() => {
            const s = o.sched as { enabled?: unknown; start?: unknown; end?: unknown };
            // 形态与范围都校验（"25:99" 形态合法但越界）：hmToMinutes 是
            // 函数声明，模块初始化调用时已完成提升。
            const okTime = (v: unknown): v is string => typeof v === "string" && hmToMinutes(v) !== null;
            return {
              enabled: s.enabled === true,
              start: okTime(s.start) ? s.start : DEFAULT_SCHEDULE.start,
              end: okTime(s.end) ? s.end : DEFAULT_SCHEDULE.end
            };
          })()
        : undefined;
    return { on, ...(sched ? { sched } : {}) };
  } catch {
    return { on: false };
  }
}

let state = readInitial();
const listeners = new Set<() => void>();

function notify(): void {
  for (const fn of listeners) fn();
}

function persist(): void {
  persistMirrored(DND_KEY, JSON.stringify(state));
}

/** 当前免打扰手动开关是否开启（O(1)，UI 回显用）。 */
export function dndEnabled(): boolean {
  return state.on;
}

/** 当前时段计划配置（无配置返回关闭态默认值；UI 编辑起点）。 */
export function getDndSchedule(): DndSchedule {
  return state.sched ?? DEFAULT_SCHEDULE;
}

/** "HH:MM" → 当日分钟数；非法输入返回 null。 */
function hmToMinutes(hm: string): number | null {
  const t = hm.trim();
  if (!/^\d{1,2}:\d{2}$/.test(t)) return null;
  const [h, min] = t.split(":");
  const hh = Number(h);
  const mm = Number(min);
  if (hh > 23 || mm > 59) return null;
  return hh * 60 + mm;
}

/**
 * 某时刻是否落在时段计划内（纯函数，供测试）。规则：
 * - 计划未启用或任一端时间非法 → false；
 * - start < end 为同日时段（含两端，分钟粒度）；
 * - start > end 为跨午夜时段（如 22:00–08:00 = 22:00 起到次日 08:00）；
 * - start === end 视为全天生效。
 */
export function inDndSchedule(sched: DndSchedule, now: Date = new Date()): boolean {
  if (!sched.enabled) return false;
  const s = hmToMinutes(sched.start);
  const e = hmToMinutes(sched.end);
  if (s === null || e === null) return false;
  if (s === e) return true;
  const cur = now.getHours() * 60 + now.getMinutes();
  if (s < e) return cur >= s && cur <= e;
  return cur >= s || cur <= e; // 跨午夜
}

/** 通知派发用的最终判定：手动开启 或 命中计划时段。 */
export function dndSuppressing(now: Date = new Date()): boolean {
  return dndEnabled() || inDndSchedule(getDndSchedule(), now);
}

/** 切换手动开关；持久化失败仅记日志（开关本身照常生效到下次重载）。 */
export function setDnd(on: boolean): void {
  if (on === state.on) return;
  state = { ...state, on };
  persist();
  notify();
}

/** 更新时段计划（整块写入；enabled=false 时段保留、仅停用）。 */
export function setDndSchedule(sched: DndSchedule): void {
  state = { ...state, sched };
  persist();
  notify();
}

/** 订阅变化（返回取消函数）。 */
export function subscribeDnd(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** React 绑定：`const dnd = useDnd();`（手动开关）。 */
export function useDnd(): boolean {
  return useSyncExternalStore(subscribeDnd, dndEnabled, dndEnabled);
}

/** React 绑定：时段计划（配置页编辑用，返回当前配置对象）。 */
export function useDndSchedule(): DndSchedule {
  return useSyncExternalStore(subscribeDnd, getDndSchedule, getDndSchedule);
}
