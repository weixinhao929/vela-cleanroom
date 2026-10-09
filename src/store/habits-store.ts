import { create } from "zustand";
import { subscribeWithSelector } from "zustand/middleware";
import { persistMirrored } from "../lib/local-backup";

/**
 * 习惯打卡的全局状态。
 *
 * 此前习惯存于各小组件实例自己的 localStorage 键（`focus-desk.habits.<id>`），
 * 是一个「数据孤岛」：今日概览、今日待办、日历都读不到它，于是打卡/新增
 * 习惯不会同步到任何其它组件。这里把习惯提升为与任务（tasks）、截止日期
 * （deadlines）同级的全局单例，所有组件共用同一份数据。
 */

export type Habit = {
  id: string;
  name: string;
  done: Record<string, boolean>;
  /** 每周目标次数；0/缺省 = 每日习惯。 */
  perWeek?: number;
  /** 每日打卡提醒时间（HH:MM）；空 = 不提醒。 */
  remindAt?: string;
  /** 当天已提醒标记（YYYY-MM-DD），防止轮询重复发通知。 */
  remindedOn?: string;
  /** 置顶：置顶习惯始终排在列表最前。 */
  pinned?: boolean;
};

/** 全局习惯键（同类数据的唯一权威来源）。 */
export const HABITS_KEY = "focus-desk.habits.v1";
/** 旧版按实例隔离的键前缀，首次加载时迁移合并。 */
const LEGACY_PREFIX = "focus-desk.habits.";

function isHabit(v: unknown): v is Habit {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return typeof o.id === "string" && typeof o.name === "string" && !!o.done && typeof o.done === "object";
}

/** 清洗单条习惯记录：丢弃损坏字段，done 只保留 true 值。 */
function normalizeHabit(v: unknown): Habit | null {
  if (!isHabit(v)) return null;
  const o = v as unknown as Habit;
  const done: Record<string, boolean> = {};
  for (const [k, val] of Object.entries(o.done ?? {})) if (val === true) done[k] = true;
  return {
    id: o.id,
    name: String(o.name).trim() || o.id,
    done,
    ...(typeof o.perWeek === "number" && o.perWeek > 0 ? { perWeek: o.perWeek } : {}),
    ...(typeof o.remindAt === "string" && o.remindAt ? { remindAt: o.remindAt } : {}),
    ...(typeof o.remindedOn === "string" && o.remindedOn ? { remindedOn: o.remindedOn } : {}),
    ...(o.pinned ? { pinned: true } : {})
  };
}

function loadFrom(key: string): Habit[] {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.map(normalizeHabit).filter((h): h is Habit => h !== null);
  } catch {
    return [];
  }
}

/** 旧版按实例隔离的习惯键，一次性合并进全局键。 */
function loadLegacy(): Habit[] {
  const out: Habit[] = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key || key === HABITS_KEY || !key.startsWith(LEGACY_PREFIX)) continue;
      out.push(...loadFrom(key));
    }
  } catch {
    // best-effort
  }
  return out;
}

function dedupById(list: Habit[]): Habit[] {
  const seen = new Set<string>();
  return list.filter((h) => (seen.has(h.id) ? false : (seen.add(h.id), true)));
}

function clearLegacy() {
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const key = localStorage.key(i);
      if (key && key !== HABITS_KEY && key.startsWith(LEGACY_PREFIX)) localStorage.removeItem(key);
    }
  } catch {
    // best-effort
  }
}

/** 持久化整表：写 localStorage + 走进备份镜像（可随完整备份恢复）。 */
function persistRaw(habits: Habit[]) {
  persistMirrored(HABITS_KEY, JSON.stringify(habits));
}

/**
 * 初始状态：全局键优先，旧版按实例的键合并补齐（按 id 去重），并立即写回
 * 全局键 + 清理旧键——否则用户在全局里删除某条习惯后，旧键里残留的副本会
 * 在下次启动时被「复活」。
 */
function migrateInitial(): Habit[] {
  const global = loadFrom(HABITS_KEY);
  const legacy = loadLegacy();
  if (legacy.length === 0) return global;
  const merged = dedupById([...global, ...legacy]);
  persistRaw(merged);
  clearLegacy();
  return merged;
}

function sortPinnedFirst(hs: Habit[]): Habit[] {
  return [...hs.filter((h) => h.pinned), ...hs.filter((h) => !h.pinned)];
}

type HabitsState = {
  habits: Habit[];
  addHabit(name: string): void;
  /** 在指定日期（YYYY-MM-DD）上打卡/撤销。 */
  toggleHabit(id: string, dateKey: string): void;
  updateHabit(id: string, patch: Partial<Pick<Habit, "name" | "perWeek" | "remindAt" | "remindedOn" | "pinned">>): void;
  setHabitPinned(id: string, pinned: boolean): void;
  /** 在当前可见列表内上移一位（隐藏项不动），保持置顶块不变式。 */
  moveHabitUp(id: string, opts: { today: string; showCompleted: boolean }): void;
  removeHabit(id: string): void;
  /** 到点提醒后标记当天已提醒（不再重复发通知）。 */
  markHabitsReminded(ids: string[], dateKey: string): void;
};

/**
 * 习惯打卡 store（zustand + subscribeWithSelector）。
 *
 * 职责：习惯列表（含每日 done 映射、置顶、提醒时间、排序权重）的唯一
 * 事实来源。所有变更经统一 commit：先更新内存再 persistRaw 双写
 * （localStorage + 防抖镜像同步），保证进备份不落盲区。
 */

export const useHabitsStore = create<HabitsState>()(
  subscribeWithSelector((set, get) => {
    const commit = (next: Habit[]) => {
      set({ habits: next });
      persistRaw(next);
    };
    return {
      habits: migrateInitial(),

      addHabit: (name) => {
        const trimmed = name.trim();
        if (!trimmed) return;
        commit([...get().habits, { id: crypto.randomUUID(), name: trimmed, done: {} }]);
      },

      toggleHabit: (id, dateKey) =>
        commit(get().habits.map((h) => (h.id === id ? { ...h, done: { ...h.done, [dateKey]: !h.done[dateKey] } } : h))),

      updateHabit: (id, patch) => commit(get().habits.map((h) => (h.id === id ? { ...h, ...patch } : h))),

      setHabitPinned: (id, pinned) => {
        const hs = get().habits;
        const target = hs.find((h) => h.id === id);
        if (!target || !!target.pinned === pinned) return;
        const others = hs.filter((h) => h.id !== id);
        commit(
          sortPinnedFirst(pinned ? [{ ...target, pinned: true }, ...others] : [...others, { ...target, pinned: false }])
        );
      },

      moveHabitUp: (id, opts) => {
        const hs = get().habits;
        const vis = opts.showCompleted ? hs : hs.filter((h) => !h.done[opts.today]);
        const vi = vis.findIndex((h) => h.id === id);
        if (vi <= 0) return;
        const prev = vis[vi - 1];
        const arr = [...hs];
        const a = arr.findIndex((h) => h.id === id);
        const b = arr.findIndex((h) => h.id === prev.id);
        [arr[a], arr[b]] = [arr[b], arr[a]];
        commit(sortPinnedFirst(arr));
      },

      removeHabit: (id) => commit(get().habits.filter((h) => h.id !== id)),

      markHabitsReminded: (ids, dateKey) => {
        const setIds = new Set(ids);
        commit(get().habits.map((h) => (setIds.has(h.id) ? { ...h, remindedOn: dateKey } : h)));
      }
    };
  })
);

/**
 * 应用远端同步来的习惯整表（校验 + 落盘）。
 *
 * @param list - 远端载荷（期望 Habit 数组，逐条 normalize 过滤非法项）。
 * @returns 应用成功为 true；载荷非数组为 false。
 */
export function applyRemoteHabits(list: unknown): boolean {
  if (!Array.isArray(list)) return false;
  const habits = list.map(normalizeHabit).filter((h): h is Habit => h !== null);
  // 远端混入不认的行时只丢内存展示，不把删减结果 persistRaw 固化
  // （固化 + 广播回去 = 坏行替我们删了兄弟窗口的好数据）；与 app 通道
  // 「坏行丢弃仅限内存」口径一致。丢弃留痕计数，便于诊断载荷来源。
  const dropped = list.length - habits.length;
  if (dropped > 0) {
    console.warn(`[habits] 远端习惯表含 ${dropped} 条无法识别的行，已在内存中跳过（不落盘）`);
    useHabitsStore.setState({ habits });
    return true;
  }
  useHabitsStore.setState({ habits });
  persistRaw(habits);
  return true;
}

/* ---- 跨组件共用的日期 / 进度派生（今日概览 / 今日待办 / 日历复用） ---- */

/** 本地时区 YYYY-MM-DD 键（习惯按本地自然日翻转，不用 UTC）。O(1)。 */
export const habitDateKey = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** 今日的 {@link habitDateKey}。 */
export const habitTodayKey = (): string => habitDateKey(new Date());

/** 某日期所在周的周一 0 点（习惯「本周」以周一为起点）。O(1)。 */
export const habitWeekStart = (d: Date): Date => {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
  return x;
};

/** 某习惯在指定周（周一起）的打卡次数。O(7)。 */
export const habitWeekCount = (h: Habit, ws: Date): number => {
  let n = 0;
  for (let i = 0; i < 7; i++) {
    const d = new Date(ws);
    d.setDate(ws.getDate() + i);
    if (h.done[habitDateKey(d)]) n += 1;
  }
  return n;
};

/** 习惯是否「本周已达标」（仅每周习惯有意义；每日习惯恒为 false）。 */
export const habitWeekMet = (h: Habit, ws: Date): boolean =>
  (h.perWeek ?? 0) > 0 && habitWeekCount(h, ws) >= (h.perWeek as number);
