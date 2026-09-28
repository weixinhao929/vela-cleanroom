/**
 * 布局时间线（BentoDesk 借鉴 #1，v1）：布局结构变更的自动快照 + 撤销/重做。
 *
 * - 挂接方式：订阅 widget-store（零侵入——store 动作不用逐个埋点），实例/
 *   编组引用变化即标脏；500ms 尾沿防抖 + 2s 强制冲刷窗，连续编辑只落一份。
 * - 显著性阈值：与游标处的上一份快照相比只有实例/组的**增删**才落盘
 *   （BentoDesk「item ≥3 或 zone ≥1」同哲学）——移动/缩放/改配置不产生
 *   历史噪音。
 * - 有界历史：每 (screen, view) 键独立，auto 上限 20 条，满逐最旧；快照是
 *   全量 JSON（布局数据小、损坏条目直接跳过不炸列表）。
 * - 恢复语义：undo/redo 前先冲刷 pending 快照（等价 BentoDesk 的
 *   pre_restore——未落盘的现状先补一份，任何恢复本身可再撤销）；恢复期间
 *   挂起自动捕获，防止把恢复动作又记成新历史、冲掉 redo 分支。
 * - 入口：Ctrl+Z 撤销 / Ctrl+Shift+Z（Ctrl+Y）重做，文本输入焦点时不接管。
 *   恢复入口是 widget-store.applyTimelineState（清同 id 回收站条目防复活）。
 *
 * 纯函数（isSignificant / pushCapped）与副作用（订阅、持久化、恢复）分离，
 * 前者在 layout-timeline.test.ts 直接驱动。pinned 快照 / 时间轴 UI /
 * burst 合并（规则批量 pre/post 对）留作后续批次。
 */
import {
  useWidgetStore,
  currentScreenId,
  loadInstances,
  loadGroups,
  flushWidgetLayoutSync,
  applyTimelineState
} from "./widget-store";
import type { WidgetGroup, WidgetInstance } from "./widget-store";
import { sqliteRepo } from "../lib/persistence/sqlite";
import { isTauri } from "../lib/tauri";
import { pushAppToast } from "../components/ToastHost";
import { t } from "../i18n-lite";

/** 尾沿防抖：变更停止该时长后落一份快照。 */
const DEBOUNCE_MS = 500;
/** 强制冲刷窗：即使变更持续到来也必须落盘的上限（防永不落盘）。 */
const COALESCE_MAX_MS = 2000;
/** 每键 auto 快照上限（BentoDesk 同款容量 20）。 */
const CAP = 20;

export type LayoutSnapshot = {
  id: string;
  view: string;
  capturedAt: number;
  instances: WidgetInstance[];
  groups: WidgetGroup[];
  /** v2：手动固定（pin）的快照不参与容量淘汰、永不驱逐（BentoDesk 双队列语义）。 */
  pinned?: boolean;
};

/** 两份快照的结构差（纯函数）：时间轴列表的 "+2 组件 −1 组" 摘要用。 */
export function deltaOf(
  prev: LayoutSnapshot | null,
  next: LayoutSnapshot
): { added: number; removed: number; groupsAdded: number; groupsRemoved: number } {
  const idsOf = (xs: { id: string }[]) => new Set(xs.map((x) => x.id));
  return {
    added: prev
      ? [...idsOf(next.instances)].filter((x) => !idsOf(prev.instances).has(x)).length
      : next.instances.length,
    removed: prev ? [...idsOf(prev.instances)].filter((x) => !idsOf(next.instances).has(x)).length : 0,
    groupsAdded: prev ? [...idsOf(next.groups)].filter((x) => !idsOf(prev.groups).has(x)).length : next.groups.length,
    groupsRemoved: prev ? [...idsOf(prev.groups)].filter((x) => !idsOf(next.groups).has(x)).length : 0
  };
}

function timelineKey(view: string): string {
  return `focus-desk.screen.${currentScreenId()}.timeline.${view}.v1`;
}
function dbTimelineKey(view: string): string {
  return `widget:timeline:${currentScreenId()}:${view}`;
}

/**
 * 显著性判定（纯函数）：实例或组的 id 集合有增删才算结构变化。
 * prev 为空且当前也为空 → 不落（空→空的初始化噪音）。
 */
export function isSignificant(
  prev: LayoutSnapshot | null,
  instances: WidgetInstance[],
  groups: WidgetGroup[]
): boolean {
  const idsOf = (xs: { id: string }[]) => new Set(xs.map((x) => x.id));
  const diff = (a: Set<string>, b: Set<string>) => {
    for (const x of a) if (!b.has(x)) return true;
    for (const x of b) if (!a.has(x)) return true;
    return false;
  };
  if (!prev) return instances.length > 0 || groups.length > 0;
  return diff(idsOf(prev.instances), idsOf(instances)) || diff(idsOf(prev.groups), idsOf(groups));
}

/** 有界追加（纯函数）：非 pinned 条目超上限逐最旧；pinned 永不驱逐。 */
export function pushCapped(list: LayoutSnapshot[], snap: LayoutSnapshot, cap: number): LayoutSnapshot[] {
  const next = [...list, snap];
  let auto = next.filter((s) => !s.pinned).length;
  if (auto <= cap) return next;
  const out: LayoutSnapshot[] = [];
  for (const s of next) {
    if (auto > cap && !s.pinned) {
      auto--;
      continue; // 逐最旧的非 pinned 条目
    }
    out.push(s);
  }
  return out;
}

type TimelineState = {
  entries: LayoutSnapshot[];
  /** 游标：entries 中「当前态」的下标；entries.length - 1 = 最新。 */
  cursor: number;
};

const stateByView = new Map<string, TimelineState>();

function isValidSnapshot(v: unknown): v is LayoutSnapshot {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.id === "string" &&
    typeof o.view === "string" &&
    typeof o.capturedAt === "number" &&
    Array.isArray(o.instances) &&
    Array.isArray(o.groups)
  );
}

/** 取某视图的时间线（首次访问时从 localStorage 载入；损坏条目跳过）。 */
function stateFor(view: string): TimelineState {
  let st = stateByView.get(view);
  if (st) return st;
  let entries: LayoutSnapshot[] = [];
  try {
    const raw = localStorage.getItem(timelineKey(view));
    const parsed = raw ? JSON.parse(raw) : null;
    if (Array.isArray(parsed)) entries = parsed.filter(isValidSnapshot);
  } catch {
    entries = [];
  }
  st = { entries, cursor: Math.max(0, entries.length - 1) };
  stateByView.set(view, st);
  return st;
}

function persist(view: string, entries: LayoutSnapshot[]) {
  const json = JSON.stringify(entries);
  try {
    localStorage.setItem(timelineKey(view), json);
  } catch {
    // 时间线非权威数据，写失败静默（主布局落盘有自己的失败通知）。
  }
  if (isTauri()) {
    sqliteRepo.setSetting(dbTimelineKey(view), json).catch(() => {});
  }
  notifyTimeline();
}

/* ---- v2：时间轴面板 API（快照列表 / pin / 任意点恢复 / 清空 / 订阅）。 ---- */

const listeners = new Set<() => void>();
function notifyTimeline(): void {
  for (const fn of listeners) fn();
}
export function subscribeTimeline(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** 某视图的快照列表（新→旧浅拷贝；面板渲染用）。 */
export function getTimelineEntries(view: string): LayoutSnapshot[] {
  return [...stateFor(view).entries].reverse();
}

/** 当前游标（面板高亮「现在」用；-1 = 无历史）。 */
export function timelineCursor(view: string): number {
  return stateFor(view).cursor;
}

/** 固定/取消固定一条快照（pinned 不参与容量淘汰；取消时字段清空，序列化无痕）。 */
export function pinSnapshot(view: string, id: string, pinned: boolean): void {
  const st = stateFor(view);
  const idx = st.entries.findIndex((s) => s.id === id);
  if (idx < 0 || !!st.entries[idx].pinned === pinned) return;
  st.entries = st.entries.map((s) =>
    s.id === id ? { ...s, ...(pinned ? { pinned: true as const } : { pinned: undefined }) } : s
  );
  persist(view, st.entries);
}

/** 恢复到任意一条快照（时间轴 seek）。当前态未落盘的变更先冲刷成快照
 *  （pre_restore 语义：恢复本身可再撤销）。 */
export function restoreSnapshot(view: string, id: string): boolean {
  flushPendingTimeline();
  const st = stateFor(view);
  const idx = st.entries.findIndex((s) => s.id === id);
  if (idx < 0) return false;
  const snap = st.entries[idx];
  restoring = true;
  try {
    applyTimelineState(
      snap.view,
      snap.instances.map((i) => ({ ...i })),
      snap.groups.map((g) => ({ ...g }))
    );
  } finally {
    restoring = false;
  }
  st.cursor = idx;
  pushAppToast(t("已恢复布局快照"), "");
  return true;
}

/** 清空某视图的历史（含 pinned；面板两步确认后调用）。 */
export function clearTimeline(view: string): void {
  const st = stateFor(view);
  st.entries = [];
  st.cursor = 0;
  persist(view, st.entries);
}

/* ---- 自动捕获：订阅 + 防抖（500ms 尾沿 / 2s 强制冲刷）。 ---- */
let dirty = false;
let dirtySince = 0;
let dirtyView: string | null = null;
let dirtyTimer: number | null = null;
/** 恢复进行中：挂起自动捕获（防止恢复动作本身进历史）。 */
let restoring = false;

function touch(view: string) {
  if (restoring) return;
  dirty = true;
  if (!dirtySince) {
    dirtySince = Date.now();
    dirtyView = view;
  }
  // 持续变更最多等 COALESCE_MAX_MS 就必须冲刷。
  const elapsed = Date.now() - dirtySince;
  const delay = Math.max(0, Math.min(DEBOUNCE_MS, COALESCE_MAX_MS - elapsed));
  if (dirtyTimer !== null) window.clearTimeout(dirtyTimer);
  dirtyTimer = window.setTimeout(() => {
    dirtyTimer = null;
    flushPendingTimeline();
  }, delay);
}

/** 冲刷 pending 捕获（undo/redo 与确定性时点调用）。 */
export function flushPendingTimeline(): void {
  if (dirtyTimer !== null) {
    window.clearTimeout(dirtyTimer);
    dirtyTimer = null;
  }
  if (!dirty) return;
  dirty = false;
  dirtySince = 0;
  const view = dirtyView;
  dirtyView = null;
  if (!view) return;
  const st = useWidgetStore.getState();
  let instances: WidgetInstance[];
  let groups: WidgetGroup[];
  if (st.activeView === view) {
    instances = st.instances;
    groups = st.groups;
  } else {
    // 标脏后视图已切换：先强制落盘再从存储读旧视图的真实布局。
    flushWidgetLayoutSync();
    instances = loadInstances(view);
    groups = loadGroups(view);
  }
  captureNow(view, instances, groups);
}

function captureNow(view: string, instances: WidgetInstance[], groups: WidgetGroup[]) {
  const st = stateFor(view);
  const prev = st.entries[st.cursor] ?? null;
  if (!isSignificant(prev, instances, groups)) return;
  // 用户在 undo 后又做了新变更：截断 redo 分支（标准撤销栈语义）。
  const base = st.cursor < st.entries.length - 1 ? st.entries.slice(0, st.cursor + 1) : st.entries;
  const snap: LayoutSnapshot = {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    view,
    capturedAt: Date.now(),
    instances,
    groups
  };
  st.entries = pushCapped(base, snap, CAP);
  st.cursor = st.entries.length - 1;
  persist(view, st.entries);
}

/* ---- 撤销 / 重做。 ---- */

/** 撤销当前视图的最近一次结构变更；无可撤销返回 false。 */
export function undoLayout(): boolean {
  flushPendingTimeline();
  const view = useWidgetStore.getState().activeView;
  const st = stateFor(view);
  if (st.cursor <= 0) return false;
  const snap = st.entries[st.cursor - 1];
  restoring = true;
  try {
    applyTimelineState(
      snap.view,
      snap.instances.map((i) => ({ ...i })),
      snap.groups.map((g) => ({ ...g }))
    );
  } finally {
    restoring = false;
  }
  st.cursor -= 1;
  pushAppToast(t("已撤销布局更改"), "");
  return true;
}

/** 重做（撤销的逆操作）；无可重做返回 false。 */
export function redoLayout(): boolean {
  flushPendingTimeline();
  const view = useWidgetStore.getState().activeView;
  const st = stateFor(view);
  if (st.cursor >= st.entries.length - 1) return false;
  const snap = st.entries[st.cursor + 1];
  restoring = true;
  try {
    applyTimelineState(
      snap.view,
      snap.instances.map((i) => ({ ...i })),
      snap.groups.map((g) => ({ ...g }))
    );
  } finally {
    restoring = false;
  }
  st.cursor += 1;
  pushAppToast(t("已重做布局更改"), "");
  return true;
}

/* ---- 初始化：订阅 store + 全局快捷键（WidgetCanvas 挂载时调用一次）。 ---- */

function isEditableTarget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  return el.isContentEditable || el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT";
}

let initialized = false;
export function initLayoutTimeline(): void {
  if (initialized || typeof window === "undefined") return;
  initialized = true;
  useWidgetStore.subscribe((s, prev) => {
    if (s.instances !== prev.instances || s.groups !== prev.groups) touch(s.activeView);
  });
  window.addEventListener("keydown", (e) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    if (isEditableTarget(e.target)) return;
    const key = e.key.toLowerCase();
    if (key === "z" && !e.shiftKey) {
      if (undoLayout()) e.preventDefault();
    } else if ((key === "z" && e.shiftKey) || key === "y") {
      if (redoLayout()) e.preventDefault();
    }
  });
}

/** 测试专用：清空内存时间线与标脏状态（不动 localStorage）。 */
export function __resetTimelineForTests(): void {
  stateByView.clear();
  dirty = false;
  dirtySince = 0;
  dirtyView = null;
  if (dirtyTimer !== null) {
    window.clearTimeout(dirtyTimer);
    dirtyTimer = null;
  }
  restoring = false;
}
