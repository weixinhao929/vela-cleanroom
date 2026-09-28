import { create } from "zustand";
import { subscribeWithSelector } from "zustand/middleware";
import { invoke, isTauri } from "../lib/tauri";
import { sqliteRepo } from "../lib/persistence/sqlite";
import { persistMirrored } from "../lib/local-backup";
import { pushAppToast } from "../components/ToastHost";
import { t } from "../i18n-lite";
import {
  buildGroupFromAnchor,
  buildGroupFromMembers,
  isValidGroup,
  sanitizeGroups,
  stripGroupId,
  type WidgetGroup
} from "./widget-groups";
import { computeArrangement } from "./arrange";
import { copyInstanceData } from "./instance-data";
export type { WidgetGroup } from "./widget-groups";
import { reportPersistError } from "../lib/persist-error";
import { isPersistSuspended } from "../lib/persist-gate";
import { animDurations } from "../lib/durations";
import { scheduleWidgetWindowReconcile } from "./window-reconcile";
import { useSettingsStore } from "../store/settings-store";
import { loadWidgetConfig, type WidgetConfig } from "./widget-config";
import {
  DOCK_DEFAULTS,
  DOCK_TOP_INSET_MAX,
  cloneDockDefaults,
  type DockAutoHideMode,
  dockTileInstanceId,
  migrateDockConfig
} from "./dock/dock-logic";

/**
 * 小组件布局 store（zustand + subscribeWithSelector）。
 *
 * 职责：多视图（home/work/focus + 用户自建）下小组件实例的布局、z 序、
 * 回收站与编辑会话状态的唯一事实来源。持久化为双后端镜像（localStorage
 * 权威 + SQLite setSetting 镜像，300ms 尾随防抖、单次 stringify 复用）；
 * 拖拽/缩放期间挂起跨窗口广播（见 cross-window），pointerup 一次性提交；
 * hydrate 以 localStorage 为权威源，DB 落后时回写自愈（B-2）。
 */

/** 结构校验：是否为合法实例（至少含 id + type）。 */
function isValidInstance(v: unknown): v is WidgetInstance {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as Record<string, unknown>).id === "string" &&
    typeof (v as Record<string, unknown>).type === "string"
  );
}

/** Returns true when `v` is a structurally valid TrashWidget. */
function isValidTrash(v: unknown): v is TrashWidget {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as Record<string, unknown>).id === "string" &&
    typeof (v as Record<string, unknown>).type === "string" &&
    typeof (v as Record<string, unknown>).deletedAt === "string"
  );
}

/**
 * View ids are arbitrary strings. The default views use the stable ids
 * "home" / "work" / "focus"; user-created views use generated ids.
 */
export type ViewId = string;

export type WidgetInstance = {
  id: string;
  type: string;
  x: number;
  y: number;
  w: number;
  h: number;
  z: number;
  /** Per-widget opacity multiplier (0–1). Defaults to 1 (fully opaque). */
  opacity?: number;
  /** 鼠标穿透：开启后该小组件的所有区域不恢复窗口输入，点击直达桌面。
   *  布局随实例一起持久化；编辑模式不受影响（编辑时整窗可交互）。 */
  clickThrough?: boolean;
  /** 穿透角标可见性：false 时开启穿透也不在卡片右上角渲染「穿透」角标。
   *  缺省（undefined）= 显示，兼容旧持久化数据。 */
  ctBadge?: boolean;
  /** DeskOrder 借鉴 #12：所属编组 id（组容器渲染；成员自身几何 = 解散恢复位）。 */
  groupId?: string;
};

/** A named view. `id` is the stable storage key for its layout. */
export type ViewDef = {
  id: string;
  name: string;
};

/**
 * 命名布局模板（I2）：保存当前视图全部小组件的布局快照，之后可一键套用。
 * 只存布局字段（type/x/y/w/h/z/opacity/clickThrough/ctBadge），不存实例配置。
 */
export type LayoutTemplate = {
  id: string;
  name: string;
  createdAt: number;
  instances: WidgetInstance[];
};

/** A deleted widget kept in the recycle bin (recoverable within 30 days). */
export type TrashWidget = {
  id: string;
  type: string;
  x: number;
  y: number;
  w: number;
  h: number;
  z: number;
  opacity?: number;
  clickThrough?: boolean;
  ctBadge?: boolean;
  view: string;
  deletedAt: string;
};

/** How long a deleted widget stays in the recycle bin before auto-purge. */
export const TRASH_RETENTION_DAYS = 30;

/* ---- DOCK（C2 → 灵动岛 2.0 §4.1）：贴边聚合容器配置 v2 ---- */

/**
 * 岛贴哪条边。产品决策「岛只贴顶边」（设置页注释：贴底没有使用价值），
 * 解析层（parseDockConfig）恒归一为 top；bottom 仅在 DockShell 拖拽换边
 * 预览的运行期分支保留。left / right 竖边（F-11）从未有渲染实现，类型
 * 上保留以兼容旧载荷的字面量空间，但写入侧（isDockEdge/setDockPlacement）
 * 一律拒绝——杜绝「存了 left 渲染成 top」的半成品状态。
 */
export type DockEdge = "top" | "bottom" | "left" | "right";
/** 沿边吸附点：start / center / end，或自由位（free，此时 offset 生效）。 */
export type DockSnap = "start" | "center" | "end" | "free";
/**
 * 岛内磁贴：`type` 是 registry 类型 id；`instanceId` 可选绑定画布上的某个实例
 * （共享其 widget-config）；`config` 仅在无 instanceId 时作为磁贴私有配置。
 * `id` 为 uuid，是排序 / 移除 / 展开 id（dock:<id>）的键。
 */
export type DockTile = { id: string; type: string; instanceId?: string; config?: WidgetConfig };
/** 鼠标动作（F-6，悬停/左键/中键三档动作）。 */
export type DockMouseActions = {
  hover: "none" | "peak" | "expand-first";
  blank: "none" | "panel";
  middle: "collapse" | "panel";
  wheel: "none" | "cycle";
};
/** 接管链各 kind 开关 + 展示时长（F-8）。 */
/** G10：brightness / volume 为应用内调整的 OSD 式接管（缺省开，旧载荷缺项回默认）。 */
export type DockTakeoverConfig = {
  pomodoro: boolean;
  media: boolean;
  notification: boolean;
  brightness: boolean;
  volume: boolean;
  /** 一.4 剪贴板纯链接「链接快开」接管开关（缺省开）。 */
  link: boolean;
  durationMs: number;
};

/**
 * dock 配置 v2：按屏幕分区持久化（与 bar-pos.v1 同一思路——多屏各有一条
 * dock，A 屏开关/选边不影响 B 屏）。`enabled` 缺省 false：既有桌面不会
 * 在升级后凭空多出一条；首运行播种默认布局时一并开启（见 WidgetCanvas）。
 * `version: 2` 是内容格式标记（持久化键名里的 `.v1` 是历史命名，不改）。
 */
export type DockConfig = {
  version: 2;
  enabled: boolean;
  /** 贴边。设置页已不再提供顶 / 底选择（贴底边没有使用价值），解析时一律归为 top；
   *  字段与渲染分支保留只为旧载荷兼容与类型稳定。 */
  edge: DockEdge;
  /** 岛中心相对屏宽（竖边时相对屏高）的 0–1 比例，抗分辨率变化。 */
  offset: number;
  snap: DockSnap;
  /** 外形：pill 悬浮胶囊（现状）/ bangs 贴边刘海（F-11 二期）。 */
  style: "pill" | "bangs";
  /** 顺序即排布。 */
  tiles: DockTile[];
  mouse: DockMouseActions;
  takeover: DockTakeoverConfig;
  /** QQ 式自动隐藏：`true` = 平时收进屏幕上缘只留一条，指针靠近弹出、离开
   *  收回；`"when-playing"` = 一.6「仅播放时显示」（媒体在播才弹出）。
   *  旧载荷的三态（never / fullscreen / idle）解析时折算：never → false，
   *  其余 → true。 */
  autoHide: DockAutoHideMode;
  panel: { mode: "carousel" | "grid" };
  /** 磁贴高度档位（px）。 */
  density: 36 | 42 | 48;
  /** 顶边避让（px，0–64）：岛与屏幕上边缘的间距；bangs 外形贴边渲染时不生效。 */
  topInset: number;
  /** 岛两端的「‹ ›」视图切换按钮：点击切到上一个 / 下一个视图（设置页可关）。 */
  viewArrows: boolean;
};

/** v1 固定三磁贴的类型 id（配置面板的规范顺序；迁移白名单见 dock-logic）。 */
export type DockTileId = "clock" | "pomodoro" | "notifications";
export const DOCK_TILE_IDS: readonly DockTileId[] = ["clock", "pomodoro", "notifications"];

/** 默认三磁贴用固定 id（稳定、可断言）；运行时新增磁贴一律走 createDockTile 取 uuid。 */
export const DEFAULT_DOCK: DockConfig = {
  ...cloneDockDefaults(),
  tiles: [
    { id: "dock-tile-clock", type: "clock" },
    { id: "dock-tile-pomodoro", type: "pomodoro" },
    { id: "dock-tile-notifications", type: "notifications" }
  ]
};

/** 深拷贝一份默认配置（子对象与 tiles 逐枚新建，绝不与常量共享引用）。 */
function freshDefaultDock(): DockConfig {
  return { ...cloneDockDefaults(), tiles: DEFAULT_DOCK.tiles.map((t) => ({ ...t })) };
}

/**
 * dock 拖拽瞬态（画布卡片拖入 / 岛内排序共用，DROP / REORDER 会话消费）：
 * pointer 指针视口坐标、overIsland 是否命中岛矩形（外扩 24px）、insertIndex
 * 插入位预览下标。不持久化、不跨窗口同步；null = 无拖拽进行中。
 */
export type DockDrag = { pointer: { x: number; y: number } | null; overIsland: boolean; insertIndex: number };

/** 新建磁贴（其他会话的入岛入口统一由此取 uuid id）。 */
export function createDockTile(type: string, instanceId?: string): DockTile {
  return instanceId ? { id: uid(), type, instanceId } : { id: uid(), type };
}

/** 配置里是否带有课表数据（data 对象或非空 profiles）。 */
function timetableDataInConfig(cfg: WidgetConfig | undefined): boolean {
  if (!cfg) return false;
  if (cfg.data && typeof cfg.data === "object") return true;
  return Array.isArray(cfg.profiles) && cfg.profiles.length > 0;
}

/**
 * 岛上「+」（类型选择器 / 配置面板 / 图库）加磁贴的工厂。课程表这类全应用
 * 只有一份数据的类型：画布已有同类型实例时直接绑定该实例——磁贴与画布卡片
 * 读写同一份 widget-config，画布导入的课表即刻在岛上可见，磁贴里导入/编辑
 * 也会同步回画布并持久化。其余类型维持无实例磁贴语义（天气/快捷方式等允许
 * 磁贴私有数据）。绑定后由入岛去重规则兜底：同一实例不会被重复添加。
 */
export function createDockTileAutoBound(type: string): DockTile {
  if (type === "timetable") {
    const candidates = useWidgetStore.getState().instances.filter((i) => i.type === "timetable");
    const withData = candidates.find((i) => timetableDataInConfig(loadWidgetConfig(i.id)));
    const pick = withData ?? candidates[0];
    if (pick) return createDockTile(type, pick.id);
  }
  return createDockTile(type);
}

/**
 * 入岛去重规则——四条入口（画布拖入 / 图库 / 岛上「+」/ 配置面板「+」）共用的
 * 单一事实，由 addDockTile 强制执行，各入口只用它渲染禁用态：
 *  - 磁贴身份 = 绑定实例时取 instanceId，否则取 type；
 *  - 同一身份只能在岛上出现一次：同一张画布卡片不会被拖入两次，图库 / 「+」加的
 *    无实例磁贴每种类型至多一枚；
 *  - 绑定到**不同**实例的同类型磁贴（两张城市不同的天气卡）各算一个身份，允许并存。
 *
 * @returns 与候选冲突的既有磁贴；无冲突返回 undefined。
 */
export function findDockTileConflict(
  tiles: readonly DockTile[],
  tile: Pick<DockTile, "type" | "instanceId">
): DockTile | undefined {
  return tiles.find((t) =>
    tile.instanceId ? t.instanceId === tile.instanceId : t.type === tile.type && !t.instanceId
  );
}

/** 写入侧守卫：只接受有渲染实现的边（top/bottom）；left/right 竖边无实现，拒绝。 */
function isDockEdge(v: unknown): v is DockEdge {
  return v === "top" || v === "bottom";
}
function isDockSnap(v: unknown): v is DockSnap {
  return v === "start" || v === "center" || v === "end" || v === "free";
}
function pickEnum<T extends string>(v: unknown, options: readonly T[], fallback: T): T {
  return (options as readonly string[]).includes(v as string) ? (v as T) : fallback;
}
function clampOffset(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : fallback;
}
/** 有限数取整并钳到 [min, max]；非数值回落 fallback。 */
function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.round(v))) : fallback;
}

/** v2 磁贴元素校验：id / type 非空字符串；instanceId 若有须为字符串；config 若有须为对象。 */
function isDockTileObject(v: unknown): v is DockTile {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.id === "string" &&
    o.id !== "" &&
    typeof o.type === "string" &&
    o.type !== "" &&
    (o.instanceId === undefined || typeof o.instanceId === "string") &&
    (o.config === undefined || (typeof o.config === "object" && o.config !== null && !Array.isArray(o.config)))
  );
}

/** 过滤非法磁贴、按 id 去重并逐枚拷贝（只保留契约字段）。 */
function sanitizeDockTiles(tiles: readonly unknown[]): DockTile[] {
  const seen = new Set<string>();
  const out: DockTile[] = [];
  for (const t of tiles) {
    if (!isDockTileObject(t) || seen.has(t.id)) continue;
    // 已下线类型（应用启动器）的磁贴一并剔除（RETIRED_TYPES 见 loadInstances）。
    if (RETIRED_TYPES.has(t.type)) continue;
    seen.add(t.id);
    const tile: DockTile = { id: t.id, type: t.type };
    if (t.instanceId !== undefined) tile.instanceId = t.instanceId;
    if (t.config !== undefined) tile.config = t.config;
    out.push(tile);
  }
  return out;
}

function parseDockMouse(v: unknown): DockMouseActions {
  const o = v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  const d = DOCK_DEFAULTS.mouse;
  return {
    hover: pickEnum(o.hover, ["none", "peak", "expand-first"] as const, d.hover),
    blank: pickEnum(o.blank, ["none", "panel"] as const, d.blank),
    middle: pickEnum(o.middle, ["collapse", "panel"] as const, d.middle),
    wheel: pickEnum(o.wheel, ["none", "cycle"] as const, d.wheel)
  };
}

function parseDockTakeover(v: unknown): DockTakeoverConfig {
  const o = v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  const d = DOCK_DEFAULTS.takeover;
  const bool = (val: unknown, fallback: boolean) => (typeof val === "boolean" ? val : fallback);
  return {
    pomodoro: bool(o.pomodoro, d.pomodoro),
    media: bool(o.media, d.media),
    notification: bool(o.notification, d.notification),
    brightness: bool(o.brightness, d.brightness),
    volume: bool(o.volume, d.volume),
    link: bool(o.link, d.link),
    // F-6：展示时长 3–15s。
    durationMs:
      typeof o.durationMs === "number" && Number.isFinite(o.durationMs)
        ? Math.min(15_000, Math.max(3_000, Math.round(o.durationMs)))
        : d.durationMs
  };
}

/** autoHide 解析：true / false / "when-playing"；旧三态（fullscreen / idle →
 *  true，never → false）与垃圾值回默认。 */
function parseDockAutoHide(v: unknown): DockAutoHideMode {
  if (typeof v === "boolean") return v;
  if (v === "when-playing") return "when-playing";
  if (v === "fullscreen" || v === "idle") return true;
  if (v === "never") return false;
  return DOCK_DEFAULTS.autoHide;
}

/**
 * 解析持久化 dock 配置。
 *  - v1（无 version 字段；tiles 为字符串数组）→ dock-logic.migrateDockConfig
 *    无损迁移（enabled 保留，磁贴换成 {id,type}，其余回默认）；
 *  - v2 → 字段级校验，损坏 / 缺省逐项回落默认；磁贴剔除非法项并按 id 去重；
 *  - 整体损坏 → 默认配置。
 *  - edge 一律归为 top：贴底边选项已从设置页移除（没有使用价值），旧载荷里的
 *    bottom / left / right 不再按原边渲染。
 *  - autoHide 旧三态折算成布尔（never → false，fullscreen / idle → true）。
 * 持久化键名不变（`.dock.v1` 是历史命名），内容以 `version` 区分。
 */
export function parseDockConfig(raw: string | null | undefined): DockConfig {
  if (!raw) return freshDefaultDock();
  try {
    const p = JSON.parse(raw) as unknown;
    if (!p || typeof p !== "object" || Array.isArray(p)) return freshDefaultDock();
    const o = p as Record<string, unknown>;
    // v1 从不写 version；v2 起必带 version:2。以此判别（而非磁贴形状），v1 载荷里
    // 混入的非字符串垃圾项交给 migrateDockConfig 自己过滤。
    const looksV1 = !(typeof o.version === "number" && o.version >= 2);
    if (looksV1) return { ...migrateDockConfig(o), edge: "top" };
    const rawTiles = o.tiles;
    const d = DOCK_DEFAULTS;
    const panel = o.panel && typeof o.panel === "object" ? (o.panel as Record<string, unknown>) : {};
    return {
      version: 2,
      enabled: typeof o.enabled === "boolean" ? o.enabled : d.enabled,
      edge: "top",
      offset: clampOffset(o.offset, d.offset),
      snap: isDockSnap(o.snap) ? o.snap : d.snap,
      style: pickEnum(o.style, ["pill", "bangs"] as const, d.style),
      tiles: Array.isArray(rawTiles) ? sanitizeDockTiles(rawTiles) : freshDefaultDock().tiles,
      mouse: parseDockMouse(o.mouse),
      takeover: parseDockTakeover(o.takeover),
      autoHide: parseDockAutoHide(o.autoHide),
      panel: { mode: pickEnum(panel.mode, ["carousel", "grid"] as const, d.panel.mode) },
      density: o.density === 36 || o.density === 48 ? o.density : o.density === 42 ? 42 : d.density,
      topInset: clampInt(o.topInset, 0, DOCK_TOP_INSET_MAX, d.topInset),
      viewArrows: typeof o.viewArrows === "boolean" ? o.viewArrows : d.viewArrows
    };
  } catch {
    return freshDefaultDock();
  }
}

/** The three default views shipped with the app. */
export const DEFAULT_VIEWS: ViewDef[] = [
  { id: "home", name: "Home" },
  { id: "work", name: "Work" },
  { id: "focus", name: "Focus" }
];

/**
 * Reads this window's screen index from the URL hash (`#screen=N`). The Rust
 * core creates one widget-layer window per monitor, each labeled `widget-<i>`
 * and encoded with `#screen=<i>` so the frontend can partition the widget store
 * by screen. The settings window has no `#screen` hash → starts on the primary
 * partition ("0") and can retarget it at runtime via `switchScreen` to manage
 * another display's widget set (docs/issues-2026-09-09-multimonitor-and-ddl.md A).
 */
export function getScreenId(): string {
  if (typeof window === "undefined") return "0";
  const m = /#screen=(\d+)/.exec(window.location.hash);
  return m ? m[1] : "0";
}

/**
 * The screen partition this window currently reads/writes. Desktop widget
 * windows bind it from their URL hash for their whole life; only the settings
 * window mutates it (switchScreen). All persistence keys below derive from it
 * at call time — never at module load — so a retarget takes effect everywhere.
 */
let currentScreen = getScreenId();

/** Current widget partition id (see `currentScreen`). */
export function currentScreenId(): string {
  return currentScreen;
}

/** 设置窗口最近一次管理的屏幕分区（跨重启恢复；桌面层窗口不读写）。 */
const SETTINGS_SCREEN_KEY = "focus-desk.settings.screen";

/** 恢复设置窗口上次管理的屏幕分区（不存在/不合法时保持默认 "0"）。 */
export function readPersistedSettingsScreen(): string {
  try {
    const v = localStorage.getItem(SETTINGS_SCREEN_KEY);
    return v && /^\d+$/.test(v) ? v : "0";
  } catch {
    return "0";
  }
}

function viewKey(): string {
  return `focus-desk.screen.${currentScreen}.widgets.view.v1`;
}
function viewsKey(): string {
  return `focus-desk.screen.${currentScreen}.widgets.views.v1`;
}
function trashKey(): string {
  return `focus-desk.screen.${currentScreen}.widgets.trash.v1`;
}
function templatesKey(): string {
  return `focus-desk.screen.${currentScreen}.widgets.templates.v1`;
}
/** DOCK 配置键（按屏分区，风格对齐 `focus-desk.screen.<N>.bar-pos.v1`）。 */
function dockKey(): string {
  return `focus-desk.screen.${currentScreen}.dock.v1`;
}
function dbDockKey(): string {
  return `widget:dock:${currentScreen}`;
}

/** Each view gets an independent layout key derived from its id (scoped by screen). */
function layoutKey(view: string): string {
  return `focus-desk.screen.${currentScreen}.widgets.${view}.v1`;
}

/** SQLite mirror keys are screen-scoped: each monitor's widget window owns its
 *  own durable copy. Earlier builds used global keys (`widget:layout:<view>`),
 *  so on multi-monitor setups one screen's hydrate adopted (and its next save
 *  overwrote) another screen's layout. Reads fall back to the legacy key so
 *  existing installs keep their layout. */
function dbViewsKey(): string {
  return `widget:views:${currentScreen}`;
}
function dbTrashKey(): string {
  return `widget:trash:${currentScreen}`;
}
const LEGACY_DB_TRASH_KEY = "widget:trash";
/** 编组布局键（DeskOrder 借鉴 #12）：与各视图布局键平行，按屏分区。 */
function groupsKey(view: string): string {
  return `focus-desk.screen.${currentScreen}.groups.${view}.v1`;
}
function dbGroupsKey(view: string): string {
  return `widget:groups:${currentScreen}:${view}`;
}
function dbLayoutKey(view: string): string {
  return `widget:layout:${currentScreen}:${view}`;
}
function legacyDbLayoutKey(view: string): string {
  return `widget:layout:${view}`;
}

/**
 * True when a layout has ever been persisted for `view` (including an empty
 * `[]`). `loadInstances` can't distinguish "no layout yet" from "user deleted
 * every widget", so seeding defaults must be gated on key presence, not on the
 * loaded array being empty.
 */
export function hasPersistedLayout(view: string): boolean {
  try {
    return localStorage.getItem(layoutKey(view)) !== null;
  } catch {
    return false;
  }
}

/** Grid snap size in px for drag alignment. */
export const GRID = 20;

/** Element-wise equality for the (short) align-guide arrays. */
function sameNumbers(a: number[], b: number[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Monotonic sequence for hydrate() calls: an in-flight SQLite read from an
 *  earlier hydrate must not apply over a newer one (view switches re-hydrate). */
let hydrateSeq = 0;

/**
 * Snaps a widget coordinate to the grid, then clamps it so at least a 40px
 * grabbable strip of the card stays inside the viewport. Keeps the clamped
 * value grid-aligned so edge-docked widgets still line up.
 */
function clampAxis(v: number, axis: "x" | "y"): number {
  const snapped = Math.round(v / GRID) * GRID;
  if (typeof window === "undefined") return snapped;
  const limit = Math.max(0, (axis === "x" ? window.innerWidth : window.innerHeight) - 40);
  const gridLimit = Math.floor(limit / GRID) * GRID;
  return Math.min(Math.max(0, snapped), gridLimit);
}

/** 只夹取、不网格化（对齐 alignMoveWidget 的口径）：智能对齐（WidgetCard snap）
 *  会给出 ≤8px 的非网格落点，提交时若再走 clampAxis 的 20px 网格吸附，松手
 *  瞬间卡片会横跳回网格（importLayout 导入的非网格布局一拖即现）。 */
function clampFree(v: number, axis: "x" | "y"): number {
  if (typeof window === "undefined") return Math.max(0, v);
  const limit = Math.max(0, (axis === "x" ? window.innerWidth : window.innerHeight) - 40);
  return Math.min(Math.max(0, v), limit);
}

type WidgetState = {
  instances: WidgetInstance[];
  /** 当前视图的编组容器（DeskOrder 借鉴 #12）；与 instances 同视图持久化。 */
  groups: WidgetGroup[];
  /** 当前管理的屏幕分区 id：桌面层=本窗口 URL screen（不变）；设置窗可切换。 */
  screenId: string;
  editMode: boolean;
  /** The widget currently selected (focused) in edit mode — the only one that
   *  responds to arrow-key nudging / Delete. Transient UI state, never synced. */
  selectedId: string | null;
  /** 多选集合（I3）：编辑模式下框选/批量选中的全部小组件 id。
   *  「主单元」= selectedId（最后点选/框选中的最后一个），作为对齐基准与键盘响应者。
   *  瞬态 UI 状态，不持久化、不同步。 */
  selectedIds: string[];
  activeView: string;
  views: ViewDef[];
  /** Deleted widgets awaiting restore (30-day retention). */
  trash: TrashWidget[];
  /** 拖拽时的对齐辅助线（画布坐标）。仅在拖拽期间非空，画布据此渲染贯穿参考线。 */
  alignGuides: { xs: number[]; ys: number[] };
  /** 拖拽预览位移（瞬态、不持久化、不同步）：编辑模式拖拽进行中，被拖卡片
   *  id → 相对拖拽起点的 (dx,dy)。渲染层据此叠加 translate，指针抬起时一次性
   *  写回 instances，避免每帧重建 instances 数组 + 全序列化落盘（PERF-1）。 */
  dragPreview: Record<string, { dx: number; dy: number }>;
  /** 缩放瞬态预览（同 dragPreview 思路）：缩放期间只有该卡片读到非空矩形并重渲，
   *  指针抬起时一次性写回 instances 并落盘。此前缩放每 rAF 都 updateWidget 写
   *  instances，所有订阅 instances 的组件（日历/概览等）逐帧重算。 */
  resizePreview: { id: string; x: number; y: number; w: number; h: number } | null;
  /** 透明度瞬态预览（同 resizePreview 思路）：独立透明度滑条拖动期间只写此
   *  瞬态，仅目标卡读到并重渲；松手/键盘步进后一次性 updateWidget 写回
   *  instances。此前滑条每步都 updateWidget 重建 instances 数组 → 整画布
   *  reconcile（widget-config.ts 头注释所述卡顿源的本地渲染半边）。 */
  opacityPreview: { id: string; value: number } | null;
  /** 拖拽合并投放目标（瞬态）：拖拽进行中光标下的候选卡 id，目标卡亮出
   *  「松手即合并」高亮；拖拽结束清空。此前合并命中只在松手 toast，投放意图
   *  全程无提示。 */
  mergeTargetId: string | null;
  setMergeTargetId(id: string | null): void;
  /** 命名布局模板（I2）。 */
  templates: LayoutTemplate[];
  /** DOCK（C2 → 灵动岛 2.0）：本屏的贴边聚合容器配置 v2，按屏持久化。 */
  dock: DockConfig;
  /** 局部更新 dock 配置并立即落盘（岛级开关项；tiles 传入时做合法性过滤 + 去重）。 */
  setDock(patch: Partial<DockConfig>): void;
  /** 加入磁贴：index 省略 = 追加末尾，越界钳到合法区间；同 id 已存在则忽略（幂等）。 */
  addDockTile(tile: DockTile, index?: number): void;
  removeDockTile(id: string): void;
  /** 移动磁贴到目标下标（先移出再插入，toIndex 按移出后的数组钳位）。 */
  moveDockTile(id: string, toIndex: number): void;
  /** 岛级位置（F-4 拖动松手一次 commit）：边 / 偏移（钳 0–1）/ 吸附点，非法值忽略。 */
  setDockPlacement(placement: { edge?: DockEdge; offset?: number; snap?: DockSnap }): void;
  /** 逐磁贴配置合并（F-7）：只对无 instanceId 的磁贴有意义——有实例的写实例 widget-config。 */
  setDockTileConfig(id: string, patch: WidgetConfig): void;
  /** 拖拽瞬态（不落盘）：DROP / REORDER 会话每帧写入；null = 无拖拽。 */
  dockDrag: DockDrag | null;
  setDockDrag(drag: DockDrag): void;
  clearDockDrag(): void;
  /* ---- D 节画布动画辅助（均为瞬态 UI 状态，不持久化） ---- */
  /** DeskOrder 借鉴 #12：把当前多选（≥2）编成一组。 */
  groupSelected(): void;
  /**
   * BentoDesk 借鉴 #2：拖 A 放到 B 上合并——目标未编组则以目标矩形建组，
   * 已编组则追加成员；被拖卡片不提交位移。返回组 id 与本次并入的成员
   * （撤销时逐一摘除即回到合并前状态；无效输入返回 null）。
   */
  mergeIntoGroup(draggedIds: string[], targetId: string): { groupId: string; appendedIds: string[] } | null;
  /** 解散编组：成员回到编组前的原位（坐标从未被改写）。 */
  disbandGroup(groupId: string): void;
  /** 切换组内显示的成员（标签点击）。 */
  switchGroupTab(groupId: string, memberId: string): void;
  /** 从组里摘除一个成员（剩 1 人即解散）；组不存在时 no-op。 */
  removeGroupMember(groupId: string, memberId: string): void;
  /** 更新组几何（编辑模式拖动/缩放提交）。 */
  updateGroup(id: string, patch: Partial<Pick<WidgetGroup, "x" | "y" | "w" | "h">>): void;
  /** 组置顶（标签点击时唤起）。 */
  bringGroupToFront(id: string): void;
  /** 删除整组（成员一并进回收站）。 */
  removeGroup(id: string): void;
  /** 退场中的卡片 id：卡片播 .is-exiting 后由 removeWidgetsAnimated 真正移除。 */
  exitingIds: string[];
  /** 新恢复的卡片 id：画布上播 .fly-in 入场。 */
  enteringIds: string[];
  /** 新增/恢复/复制的卡片 id：落位后播一次 accent 描边脉冲。 */
  pulseIds: string[];
  /** 需要一次性 left/top 过渡的卡片 id（批量对齐 / 视口 resize clamp）。 */
  posAnimIds: string[];
  /** 动画化删除（#63）：先标记 exitingIds 播 220ms 退场，再真正移入回收站。 */
  removeWidgetsAnimated(ids: string[]): void;
  /** 标记一批卡片做一次性位置过渡（#65/#76）。 */
  setPosAnim(ids: string[]): void;
  /** 保存当前视图布局为命名模板；重名返回 false。 */
  saveTemplate(name: string): boolean;
  /** 套用模板：用模板实例替换当前视图。返回是否成功。 */
  applyTemplate(id: string): boolean;
  deleteTemplate(id: string): void;
  /** 新增实例并返回其 id（[SNIP] 钉图等流程需要紧接着写新实例的配置）。 */
  addWidget(type: string, size: { w: number; h: number }): string;
  duplicateWidget(id: string): void;
  removeWidget(id: string): void;
  restoreWidget(id: string): void;
  purgeWidget(id: string): void;
  emptyWidgetTrash(): void;
  updateWidget(id: string, patch: Partial<Omit<WidgetInstance, "id" | "type">>): void;
  bringToFront(id: string): void;
  sendToBack(id: string): void;
  selectWidget(id: string | null): void;
  /** 多选（I3）：Ctrl/Shift+点击切换选中。 */
  toggleSelect(id: string): void;
  /** 框选（I3）：把 id 数组设为选中集合，最后一个为主单元。 */
  setSelected(ids: string[]): void;
  clearSelection(): void;
  /** 批量移动（I3）：把选中的全部小组件按 (dx,dy) 平移（吸附网格 + clamp）。 */
  moveSelectedBy(dx: number, dy: number): void;
  /** 批量删除（I3）：把选中的全部小组件移入回收站。 */
  removeSelected(): void;
  /** 批量对齐 / 等距（I3）：以主单元（selectedId）为基准对齐，或按包围盒等距分布。 */
  alignSelected(mode: "left" | "center" | "right" | "top" | "middle" | "bottom" | "hspace" | "vspace"): void;
  /** BentoDesk 借鉴 #8：把多选卡片自动排布成网格/横排/纵列（包围盒内 + 视口 clamp）。 */
  arrangeSelected(mode: "grid" | "row" | "column"): void;
  setEditMode(mode: boolean): void;
  setAlignGuides(xs: number[], ys: number[]): void;
  /** 拖拽移动：坐标由调用方 snap / 吸附，这里只 clamp 到视口（不二次网格化，
   * 否则会把吸附到其它组件边缘的目标位置拉回 20px 网格）。 */
  alignMoveWidget(id: string, x: number, y: number): void;
  /** 拖拽期间更新预览位移（不写 instances，不落盘）。 */
  setDragPreview(preview: Record<string, { dx: number; dy: number }>): void;
  /** 拖拽结束：把 dragPreview 的位移一次性写入 instances 并落盘，随后清空预览。 */
  commitDragMove(): void;
  /** 缩放期间更新预览矩形（不写 instances，不落盘）。 */
  setResizePreview(preview: { id: string; x: number; y: number; w: number; h: number } | null): void;
  /** 缩放结束：把预览矩形一次性写入 instances 并落盘，随后清空预览。 */
  commitResize(): void;
  /** 透明度滑条拖动期间更新瞬态预览（不写 instances，不落盘）。 */
  setOpacityPreview(preview: { id: string; value: number } | null): void;
  setActiveView(view: string): void;
  addView(name: string): string;
  removeView(id: string): void;
  renameView(id: string, name: string): void;
  hydrate(): Promise<void>;
  /** 切换本窗口管理的屏幕分区（仅设置窗口调用）：重绑持久化 key 并按
   *  目标屏的已存数据整体重建 store，随后异步合并 SQLite 镜像。 */
  switchScreen(screen: string): void;
  exportLayout(): string;
  importLayout(json: string): boolean;
  resetView(view: string): void;
};

const uid = () => crypto.randomUUID();

/**
 * Monotonic z-index counter. Every "bring to front" bumps this, so the most
 * recently clicked widget is always strictly above every other widget — no
 * matter how many times the same widget is re-clicked.
 *
 * NOTE: this must stay well below CSS's z-index ceiling (2^31-1). An earlier
 * build seeded the counter from Date.now() (~1.7e12), which the browser clamps
 * to the same maximum for every widget — silently collapsing all widgets onto
 * one layer so "bring to front" appeared to do nothing. We now start from 0 and
 * re-sequence any oversized persisted values on load.
 */
let zCounter = 0;
const nextZ = () => ++zCounter;

/** CSS clamps z-index at 2^31-1; keep our counter far below that ceiling.
 *  导出供拖拽层取"必然高于所有卡片"的值（MAX_Z + 1）；沉浸/模态层在 CSS 里
 *  用 2_100_000 起跳，天然仍在其上。 */
export const MAX_Z = 2_000_000;

/**
 * Raises the counter above the highest persisted z so new widgets stay on top,
 * and re-sequences any oversized (legacy Date.now-based) z values that would
 * otherwise collapse the stacking order.
 */
function syncZCounter(instances: WidgetInstance[]) {
  const maxZ = instances.reduce((m, i) => Math.max(m, i.z), 0);
  if (maxZ >= zCounter) zCounter = maxZ + 1;
  if (zCounter > MAX_Z) {
    const sorted = [...instances].sort((a, b) => a.z - b.z);
    sorted.forEach((i, idx) => {
      i.z = idx + 1;
    });
    zCounter = sorted.length + 1;
  }
}

/**
 * Guarantees the module-level counter is strictly above the current max z so
 * the next z produced by `nextZ()` is always the highest. Called before any
 * operation that assigns a fresh z (add, duplicate, bring-to-front) so the
 * counter can never drift below persisted values — the root cause of "clicking
 * a widget doesn't bring it to front".
 */
function ensureCounterAbove(instances: WidgetInstance[]) {
  const maxZ = instances.reduce((m, i) => Math.max(m, i.z), 0);
  if (zCounter <= maxZ) zCounter = maxZ + 1;
}

/**
 * Compacts z values back to 1..N (preserving order) once they drift past MAX_Z.
 * Called from bringToFront/sendToBack so a long session of stacking operations
 * can't push z unboundedly toward the CSS 2^31-1 ceiling. Returns a new array;
 * the input is not mutated.
 */
function renormalizeZ(instances: WidgetInstance[]): WidgetInstance[] {
  if (instances.length === 0) return instances;
  const maxZ = instances.reduce((m, i) => Math.max(m, i.z), 0);
  if (maxZ <= MAX_Z) return instances;
  const order = instances.map((i, idx) => ({ z: i.z, idx })).sort((a, b) => a.z - b.z);
  const next = [...instances];
  order.forEach(({ idx }, rank) => {
    next[idx] = { ...next[idx], z: rank + 1 };
  });
  zCounter = next.length + 1;
  return next;
}

function loadViews(): ViewDef[] {
  try {
    const raw = localStorage.getItem(viewsKey());
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) {
        const list = parsed.filter((v): v is ViewDef => !!v && typeof v.id === "string" && typeof v.name === "string");
        if (list.length > 0) return list;
      }
    }
  } catch {
    // ignore
  }
  return DEFAULT_VIEWS;
}

function saveViews(views: ViewDef[]) {
  try {
    localStorage.setItem(viewsKey(), JSON.stringify(views));
  } catch {
    // best-effort
  }
  if (isTauri()) {
    sqliteRepo.setSetting(dbViewsKey(), JSON.stringify(views)).catch(reportPersistError("saveViews"));
  }
}

function loadView(): string {
  try {
    const raw = localStorage.getItem(viewKey());
    if (raw) return raw;
  } catch {
    // ignore
  }
  return "home";
}

/**
 * 已下线的小组件类型（如「应用启动器」，功能并入快捷方式）。读取布局时剔除
 * 对应实例：注册表里已无该类型，留着只会渲染成空白卡/报错。
 */
const RETIRED_TYPES: ReadonlySet<string> = new Set(["applauncher"]);

function isLiveInstance(v: unknown): v is WidgetInstance {
  return isValidInstance(v) && !RETIRED_TYPES.has((v as WidgetInstance).type);
}

/**
 * 布局读取时的就地迁移（localStorage 与 SQLite 镜像两条读取路径共用）：
 * - 「编码哈希」并入计算器（计算 / 编码 / 哈希三页签）：encoder 实例改为
 *   calculator，位置尺寸原样保留；
 * - 「贴图」收编为截图钉图专属（注册表 hidden，任何添加入口不再列出）：
 *   无 config.src 的空贴图实例剔除——正常钉出的贴图在创建后立即写 src。
 */
function sanitizeInstances(list: WidgetInstance[]): WidgetInstance[] {
  return list
    .map((v) => (v.type === "encoder" ? ({ ...v, type: "calculator" } as WidgetInstance) : v))
    .filter((v) => v.type !== "pin" || typeof loadWidgetConfig(v.id).src === "string");
}

/**
 * E18 写前备份轮换：落盘前
 * 把现值挪到 `<key>.bak`（内容变化才轮换，拖拽防抖的稳定态不重复写），
 * 主键损坏/丢失时读取侧先试备份——把「localStorage 损坏 = 布局丢失（只能
 * 等 SQLite 镜像兜底）」变成「退一步用上一份好数据」。
 */
export function localStorageWriteWithBackup(key: string, json: string): void {
  const prev = localStorage.getItem(key);
  if (prev !== null && prev !== json) {
    localStorage.setItem(`${key}.bak`, prev);
  }
  localStorage.setItem(key, json);
}

/** 安全读主键或备份：主键不存在时回退 `.bak`（存在但损坏由调用方判定）。 */
// （读取侧按「先主后备」两段判定，见 loadInstances；写侧只负责轮换备份。）

/**
 * 读取某视图的布局实例（元素级校验，剔除缺 id/type 的损坏条目，
 * 防 NaN/空值击穿 WidgetCard 渲染）。
 *
 * E18：主键**缺失或解析失败**（非法 JSON / 非数组）时退回 `.bak`；主键是
 * 合法的空数组（用户刚删光）不算损坏——不用备份顶替，防「删除复活」。
 *
 * @param view - 视图 id。
 * @returns 实例数组；无布局/解析失败返回空数组。
 */
export function loadInstances(view: string): WidgetInstance[] {
  /** @returns null = 载荷损坏；数组 = 合法（含合法空数组）。 */
  const parseOutcome = (raw: string | null): WidgetInstance[] | null => {
    if (raw === null) return null;
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return sanitizeInstances(parsed.filter(isLiveInstance));
    } catch {
      // fallthrough：交给调用方试备份
    }
    return null;
  };
  const key = layoutKey(view);
  try {
    const main = parseOutcome(localStorage.getItem(key));
    if (main !== null) return main;
    const bak = parseOutcome(localStorage.getItem(`${key}.bak`));
    if (bak !== null) return bak;
  } catch {
    // ignore
  }
  return [];
}

/** #75 布局保存失败通知：画布层监听该事件，在角落滑入红色提示条。 */
function notifySaveFailure() {
  try {
    window.dispatchEvent(new CustomEvent("vela:layout-save-failed"));
  } catch {
    // best-effort
  }
}

/** 尾沿防抖窗口：拖拽/缩放等连续路径会把 setTimeout 反复重置，直到最后一帧
 *  停止 300ms 后才真正序列化落盘，把 60 次/秒的写压到一次。 */
const SAVE_DEBOUNCE_MS = 300;

let pendingSave: { view: string; instances: WidgetInstance[] } | null = null;
let saveTimer: number | null = null;

/** 真正执行一次布局落盘（localStorage + SQLite 镜像），同一份 JSON 只序列化一次。 */
function writeInstancesNow(view: string, instances: WidgetInstance[]) {
  // B-恢复 ack 协议：备份整表替换期间，其他窗口的在飞落盘一律丢弃，
  // 否则旧状态会覆盖刚恢复的数据。
  if (isPersistSuspended()) return;
  // C-2（审查修复）：防抖快照过期守卫——快照记录后远端包可能已直写并更新
  // 了内存态（applyRemoteWidgets）。此时把旧快照落盘会造成「内存 B / 持久层 A」
  // 分叉，若用户未再编辑即退出，重启回档丢 B。丢弃过期快照，落盘当前内存态。
  const st = useWidgetStore.getState();
  const latest = view === st.activeView && instances !== st.instances ? st.instances : instances;
  // A-30：同一份布局只序列化一次，localStorage 与 SQLite 镜像复用同一字符串，
  // 避免对齐/批量路径对数组做两次全量 JSON.stringify。
  const json = JSON.stringify(latest);
  try {
    // E18：写前把上一份好数据轮换进 `.bak`（内容变化才写）。
    localStorageWriteWithBackup(layoutKey(view), json);
  } catch {
    notifySaveFailure();
  }
  // Mirror the layout into SQLite so the packaged app keeps a durable copy
  // that survives localStorage clears and is included in backups.
  if (isTauri()) {
    sqliteRepo.setSetting(dbLayoutKey(view), json).catch((e) => {
      console.error(e);
      notifySaveFailure();
    });
  }
  // P1：布局落盘后对账窗口集（删光/放入首个小组件 → 销毁/重建该屏窗口）。
  scheduleWidgetWindowReconcile();
}

/**
 * 若存在未触发的防抖保存，立即落盘并清空定时器。
 * 使用场景：视图切换 / 退出 / 导入前需要确定性落盘时调用。
 *
 * @returns 无。
 */
export function flushWidgetLayoutSync() {
  if (saveTimer !== null) {
    window.clearTimeout(saveTimer);
    saveTimer = null;
  }
  if (pendingSave) {
    const { view, instances } = pendingSave;
    pendingSave = null;
    if (!isPersistSuspended()) writeInstancesNow(view, instances);
  }
  flushGroupsSave();
}

/** 读取某视图的编组（元素级校验；缺键/损坏返回空数组）。 */
export function loadGroups(view: string): WidgetGroup[] {
  try {
    const raw = localStorage.getItem(groupsKey(view));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isValidGroup) : [];
  } catch {
    return [];
  }
}

/** 编组落盘（300ms 尾沿防抖，与布局同款；镜像进 SQLite 随备份走）。 */
let pendingGroupsSave: { view: string; groups: WidgetGroup[] } | null = null;
let groupsSaveTimer: number | null = null;

function writeGroupsNow(view: string, groups: WidgetGroup[]) {
  if (isPersistSuspended()) return;
  const json = JSON.stringify(groups);
  try {
    localStorage.setItem(groupsKey(view), json);
  } catch {
    notifySaveFailure();
  }
  if (isTauri()) {
    sqliteRepo.setSetting(dbGroupsKey(view), json).catch(reportPersistError("saveGroups"));
  }
}

function saveGroups(view: string, groups: WidgetGroup[]) {
  pendingGroupsSave = { view, groups };
  if (groupsSaveTimer !== null) window.clearTimeout(groupsSaveTimer);
  groupsSaveTimer = window.setTimeout(() => {
    groupsSaveTimer = null;
    if (pendingGroupsSave) {
      const { view: v, groups: g } = pendingGroupsSave;
      pendingGroupsSave = null;
      writeGroupsNow(v, g);
    }
  }, SAVE_DEBOUNCE_MS);
}

/** 冲刷编组防抖保存（flushWidgetLayoutSync 一并调用）。 */
function flushGroupsSave() {
  if (groupsSaveTimer !== null) {
    window.clearTimeout(groupsSaveTimer);
    groupsSaveTimer = null;
  }
  if (pendingGroupsSave) {
    const { view, groups } = pendingGroupsSave;
    pendingGroupsSave = null;
    if (!isPersistSuspended()) writeGroupsNow(view, groups);
  }
}

function saveInstances(view: string, instances: WidgetInstance[]) {
  // PERF-1：拖拽/缩放每帧调用，只记录最新 (view, instances)，尾沿防抖后才落盘。
  pendingSave = { view, instances };
  if (saveTimer !== null) window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    saveTimer = null;
    if (pendingSave) {
      const { view: v, instances: ins } = pendingSave;
      pendingSave = null;
      writeInstancesNow(v, ins);
    }
  }, SAVE_DEBOUNCE_MS);
}

// 页面卸载/退出前强制落盘，避免防抖窗口内的最后几次编辑被浏览器关闭丢弃。
if (typeof window !== "undefined") {
  window.addEventListener("pagehide", flushWidgetLayoutSync);
  window.addEventListener("beforeunload", flushWidgetLayoutSync);
}

function loadTrash(): TrashWidget[] {
  try {
    const raw = localStorage.getItem(trashKey());
    if (raw) {
      const parsed = JSON.parse(raw);
      // Element-level validation: entries without a valid deletedAt/id would
      // break purge/restore and render oddly in the recycle bin UI.
      if (Array.isArray(parsed)) return parsed.filter(isValidTrash);
    }
  } catch {
    // ignore
  }
  return [];
}

function saveTrash(trash: TrashWidget[]) {
  try {
    localStorage.setItem(trashKey(), JSON.stringify(trash));
  } catch {
    // best-effort
  }
  if (isTauri()) {
    sqliteRepo.setSetting(dbTrashKey(), JSON.stringify(trash)).catch(reportPersistError("saveTrash"));
  }
}

/** 读取命名布局模板（I2）。校验失败或无记录时返回空数组。 */
function loadTemplates(): LayoutTemplate[] {
  try {
    const raw = localStorage.getItem(templatesKey());
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed.filter(
          (t): t is LayoutTemplate =>
            !!t &&
            typeof (t as Record<string, unknown>).id === "string" &&
            typeof (t as Record<string, unknown>).name === "string" &&
            Array.isArray((t as Record<string, unknown>).instances)
        );
      }
    }
  } catch {
    // ignore
  }
  return [];
}

/** 持久化命名布局模板：写 localStorage + 走备份镜像（可在完整备份里恢复）。 */
function saveTemplates(templates: LayoutTemplate[]) {
  persistMirrored(templatesKey(), JSON.stringify(templates));
  if (isTauri()) {
    sqliteRepo
      .setSetting(`widget:templates:${currentScreen}`, JSON.stringify(templates))
      .catch(reportPersistError("saveTemplates"));
  }
}

/** 持久化载荷是否为可解析的 v1（对象且无 version:2）——需一次性回写为 v2。 */
function isLegacyDockPayload(raw: string): boolean {
  try {
    const p = JSON.parse(raw) as unknown;
    return !!p && typeof p === "object" && !Array.isArray(p) && (p as Record<string, unknown>).version !== 2;
  } catch {
    return false;
  }
}

/**
 * 读取当前屏的 dock 配置（localStorage 权威；缺键/损坏回落默认）。
 * v1 载荷在此迁移并立即回写 v2：迁移生成的磁贴 uuid 首次启动即固定，
 * 不会每次启动重生成（展开 id / 逐磁贴配置都以 tile.id 为键）。
 */
function loadDock(): DockConfig {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(dockKey());
  } catch {
    return parseDockConfig(null);
  }
  const cfg = parseDockConfig(raw);
  if (raw && isLegacyDockPayload(raw)) saveDock(cfg);
  return cfg;
}

/** dock 配置是否曾持久化（首运行播种需要区分「从未设置」与「用户关掉了」）。 */
export function hasPersistedDock(): boolean {
  try {
    return localStorage.getItem(dockKey()) !== null;
  } catch {
    return false;
  }
}

/** 持久化 dock 配置：localStorage 权威 + SQLite `widget:dock:<N>` 镜像（随备份恢复）。 */
function saveDock(cfg: DockConfig) {
  const json = JSON.stringify(cfg);
  try {
    localStorage.setItem(dockKey(), json);
  } catch {
    notifySaveFailure();
  }
  if (isTauri()) {
    sqliteRepo.setSetting(dbDockKey(), json).catch(reportPersistError("saveDock"));
    // P1：dock 落盘后对账窗口集（加首枚/删末枚磁贴改变“该屏有无内容”）。
    scheduleWidgetWindowReconcile();
  }
}

/**
 * Drops recycle-bin entries older than the retention window (W-093 天数可配，
 * 缺省读全局设置 extra.recycleRetentionDays，7–90 天，默认 30）。
 */
export function purgeExpiredTrash(trash: TrashWidget[], days?: number): TrashWidget[] {
  const d =
    typeof days === "number" && Number.isFinite(days) && days > 0
      ? days
      : useSettingsStore.getState().extra.recycleRetentionDays || TRASH_RETENTION_DAYS;
  const cutoff = Date.now() - d * 24 * 60 * 60 * 1000;
  return trash.filter((t) => {
    const ts = new Date(t.deletedAt).getTime();
    return Number.isFinite(ts) && ts >= cutoff;
  });
}

/**
 * Loads a view's layout. P8（对齐 settings 层策略）：localStorage 是权威源——
 * 键存在且可解析（含刻意清空的空布局 `[]`）时一律以它为准，SQLite 只是镜像：
 * 读库 IPC 失败或镜像落后（此前某次 setSetting 失败）都绝不反过来覆盖新鲜布局，
 * 并在发现分叉时把 localStorage 内容回写 DB 自愈。仅当 localStorage 无键或已
 * 损坏（首次运行/存储被清/快照损坏）才采纳 DB 副本，并回填 localStorage 镜像
 * （WidgetCanvas 的首播判定只查 localStorage，必须先落镜再返回）。
 */
export async function loadInstancesFromDb(view: string): Promise<WidgetInstance[]> {
  const local = loadInstances(view);
  if (!isTauri()) return local;
  let lsRaw: string | null = null;
  let lsUsable = false;
  try {
    lsRaw = localStorage.getItem(layoutKey(view));
    if (lsRaw !== null && Array.isArray(JSON.parse(lsRaw))) lsUsable = true;
  } catch {
    // 缺键/损坏按「不可用」处理，走下方 DB 补缺路径
  }
  let dbRaw: string | null = null;
  try {
    dbRaw = await sqliteRepo.getSetting(dbLayoutKey(view));
    if (!dbRaw) dbRaw = await sqliteRepo.getSetting(legacyDbLayoutKey(view)); // pre-screen-scoped builds
  } catch {
    return local; // 镜像读失败：localStorage 权威，保持现状不回退陈旧副本
  }
  if (lsRaw !== null && lsUsable) {
    // 权威在 localStorage：仅当镜像确实落后时才回写自愈（读到 legacy 键也算落后）。
    if (lsRaw !== dbRaw && local.length > 0) {
      sqliteRepo
        .setSetting(dbLayoutKey(view), lsRaw)
        .catch((err) => console.warn("[widgets] self-heal mirror write failed:", dbLayoutKey(view), err));
    }
    return local;
  }
  if (!dbRaw) return local;
  try {
    const parsed = JSON.parse(dbRaw);
    if (!Array.isArray(parsed)) return local;
    const instances = sanitizeInstances(parsed.filter(isLiveInstance));
    // Mirror the durable copy back into localStorage when that key is missing:
    // the first-run seeding decision in WidgetCanvas checks localStorage only,
    // so it must not race (and clobber) this async read.
    try {
      localStorage.setItem(layoutKey(view), JSON.stringify(instances));
    } catch {
      // best-effort
    }
    return instances;
  } catch {
    return local; // DB 副本损坏：不采纳、不落镜，待下次保存自愈
  }
}

const initialViews = loadViews();
const initialView = loadView();

export const useWidgetStore = create<WidgetState>()(
  subscribeWithSelector((set, get) => ({
    instances: [],
    groups: [],
    screenId: currentScreen,
    editMode: false,
    selectedId: null,
    selectedIds: [],
    activeView: initialView,
    views: initialViews,
    trash: purgeExpiredTrash(loadTrash()),
    alignGuides: { xs: [], ys: [] },
    dragPreview: {},
    resizePreview: null,
    opacityPreview: null,
    mergeTargetId: null,
    templates: loadTemplates(),
    dock: loadDock(),
    dockDrag: null,
    exitingIds: [],
    enteringIds: [],
    pulseIds: [],
    posAnimIds: [],

    setDock: (patch) => {
      const next: DockConfig = { ...get().dock, ...patch, version: 2 };
      if (patch.tiles) next.tiles = sanitizeDockTiles(patch.tiles);
      set({ dock: next });
      saveDock(next);
    },

    addDockTile: (tile, index) => {
      if (!isDockTileObject(tile)) return;
      const cur = get().dock.tiles;
      if (cur.some((t) => t.id === tile.id)) return;
      // 入岛去重（findDockTileConflict）：同实例 / 同类型无实例磁贴已在岛上则忽略。
      if (findDockTileConflict(cur, tile)) return;
      const at = index === undefined ? cur.length : Math.min(cur.length, Math.max(0, Math.floor(index)));
      const [copy] = sanitizeDockTiles([tile]);
      const next: DockConfig = { ...get().dock, tiles: [...cur.slice(0, at), copy, ...cur.slice(at)] };
      set({ dock: next });
      saveDock(next);
    },

    removeDockTile: (id) => {
      const cur = get().dock.tiles;
      if (!cur.some((t) => t.id === id)) return;
      const next: DockConfig = { ...get().dock, tiles: cur.filter((t) => t.id !== id) };
      set({ dock: next });
      saveDock(next);
    },

    moveDockTile: (id, toIndex) => {
      const cur = get().dock.tiles;
      const from = cur.findIndex((t) => t.id === id);
      if (from < 0) return;
      const rest = cur.filter((t) => t.id !== id);
      const at = Math.min(rest.length, Math.max(0, Math.floor(toIndex)));
      if (at === from) return;
      const next: DockConfig = { ...get().dock, tiles: [...rest.slice(0, at), cur[from], ...rest.slice(at)] };
      set({ dock: next });
      saveDock(next);
    },

    setDockPlacement: ({ edge, offset, snap }) => {
      const cur = get().dock;
      const next: DockConfig = {
        ...cur,
        edge: isDockEdge(edge) ? edge : cur.edge,
        offset: clampOffset(offset, cur.offset),
        snap: isDockSnap(snap) ? snap : cur.snap
      };
      if (next.edge === cur.edge && next.offset === cur.offset && next.snap === cur.snap) return;
      set({ dock: next });
      saveDock(next);
    },

    setDockTileConfig: (id, patch) => {
      const cur = get().dock.tiles;
      if (!cur.some((t) => t.id === id)) return;
      const next: DockConfig = {
        ...get().dock,
        tiles: cur.map((t) => (t.id === id ? { ...t, config: { ...(t.config ?? {}), ...patch } } : t))
      };
      set({ dock: next });
      saveDock(next);
    },

    setDockDrag: (drag) => set({ dockDrag: drag }),

    clearDockDrag: () => {
      if (get().dockDrag !== null) set({ dockDrag: null });
    },

    groupSelected: () => {
      const st = get();
      const members = st.instances.filter((i) => st.selectedIds.includes(i.id));
      const built = buildGroupFromMembers(members, uid, nextZ);
      if (!built) return;
      const instances = st.instances.map((i) => {
        const idx = built.members.findIndex((m) => m.id === i.id);
        return idx >= 0 ? built.members[idx] : i;
      });
      ensureCounterAbove(instances);
      set({ instances, groups: [...st.groups, built.group], selectedId: null, selectedIds: [] });
      saveInstances(st.activeView, instances);
      saveGroups(st.activeView, get().groups);
    },

    mergeIntoGroup: (draggedIds, targetId) => {
      const st = get();
      const target = st.instances.find((i) => i.id === targetId);
      if (!target || draggedIds.includes(targetId)) return null;
      const dragged = st.instances.filter((i) => draggedIds.includes(i.id) && !i.groupId);
      if (!dragged.length) return null;
      const appendedIds = dragged.map((d) => d.id);
      if (target.groupId) {
        const group = st.groups.find((g) => g.id === target.groupId);
        if (!group) return null;
        const appended = new Set(appendedIds);
        const groups = st.groups.map((g) =>
          g.id === group.id ? { ...g, memberIds: [...g.memberIds, ...appendedIds] } : g
        );
        const instances = st.instances.map((i) => (appended.has(i.id) ? { ...i, groupId: group.id } : i));
        set({ instances, groups, selectedId: null, selectedIds: [] });
        saveInstances(st.activeView, instances);
        saveGroups(st.activeView, groups);
        return { groupId: group.id, appendedIds };
      }
      const built = buildGroupFromAnchor(target, dragged, uid, nextZ);
      if (!built) return null;
      const instances = st.instances.map((i) => {
        const idx = built.members.findIndex((m) => m.id === i.id);
        return idx >= 0 ? built.members[idx] : i;
      });
      ensureCounterAbove(instances);
      set({ instances, groups: [...st.groups, built.group], selectedId: null, selectedIds: [] });
      saveInstances(st.activeView, instances);
      saveGroups(st.activeView, get().groups);
      return { groupId: built.group.id, appendedIds };
    },

    disbandGroup: (groupId) => {
      const st = get();
      const group = st.groups.find((g) => g.id === groupId);
      if (!group) return;
      const instances = st.instances.map((i) => (i.groupId === groupId ? { ...i, groupId: undefined } : i));
      set({ instances, groups: st.groups.filter((g) => g.id !== groupId) });
      saveInstances(st.activeView, instances);
      saveGroups(st.activeView, get().groups);
    },

    switchGroupTab: (groupId, memberId) => {
      const st = get();
      const group = st.groups.find((g) => g.id === groupId);
      if (!group || !group.memberIds.includes(memberId) || group.activeId === memberId) return;
      const groups = st.groups.map((g) => (g.id === groupId ? { ...g, activeId: memberId } : g));
      set({ groups });
      saveGroups(st.activeView, groups);
    },

    removeGroupMember: (groupId, memberId) => {
      const st = get();
      const group = st.groups.find((g) => g.id === groupId);
      if (!group || !group.memberIds.includes(memberId)) return;
      const remaining = group.memberIds.filter((x) => x !== memberId);
      const instances = st.instances.map((i) => (i.id === memberId ? { ...i, groupId: undefined } : i));
      if (remaining.length < 2) {
        // 只剩一人：整组解散（最后一个成员也原位恢复）。
        const finalInstances = instances.map((i) => (i.groupId === groupId ? { ...i, groupId: undefined } : i));
        set({ instances: finalInstances, groups: st.groups.filter((g) => g.id !== groupId) });
        saveInstances(st.activeView, finalInstances);
        saveGroups(st.activeView, get().groups);
        return;
      }
      const groups = st.groups.map((g) =>
        g.id === groupId
          ? { ...g, memberIds: remaining, activeId: g.activeId === memberId ? remaining[0] : g.activeId }
          : g
      );
      set({ instances, groups });
      saveInstances(st.activeView, instances);
      saveGroups(st.activeView, groups);
    },

    updateGroup: (id, patch) => {
      const st = get();
      if (!st.groups.some((g) => g.id === id)) return;
      const groups = st.groups.map((g) => (g.id === id ? { ...g, ...patch } : g));
      set({ groups });
      saveGroups(st.activeView, groups);
    },

    bringGroupToFront: (id) => {
      const st = get();
      const group = st.groups.find((g) => g.id === id);
      if (!group) return;
      const z = nextZ();
      const groups = st.groups.map((g) => (g.id === id ? { ...g, z } : g));
      set({ groups });
      saveGroups(st.activeView, groups);
    },

    removeGroup: (id) => {
      const st = get();
      const group = st.groups.find((g) => g.id === id);
      if (!group) return;
      set({ groups: st.groups.filter((g) => g.id !== id) });
      saveGroups(st.activeView, get().groups);
      // 成员逐一走既有删除路径（进回收站；groupId 已在上一步不影响——
      // removeWidget 内 stripGroupId 保证回收站条目干净）。
      get().removeWidgetsAnimated([...group.memberIds]);
    },

    removeWidgetsAnimated: (ids) => {
      const st = get();
      const valid = ids.filter((id) => st.instances.some((i) => i.id === id) && !st.exitingIds.includes(id));
      if (!valid.length) return;
      set({ exitingIds: [...st.exitingIds, ...valid] });
      window.setTimeout(() => {
        const cur = get();
        set({
          exitingIds: cur.exitingIds.filter((x) => !valid.includes(x)),
          selectedIds: cur.selectedIds.filter((x) => !valid.includes(x)),
          selectedId: cur.selectedId && valid.includes(cur.selectedId) ? null : cur.selectedId
        });
        for (const id of valid) get().removeWidget(id);
        // 删除可撤销：所有删除入口（快捷条/编辑栏/批量/Delete 键/入岛移动）都
        // 汇聚到本动作，在这里统一给一条带「撤销」的 toast（此前只有更轻量的
        // 编组合并/入岛有撤销，删除本身反而没有）。
        pushAppToast(
          valid.length === 1 ? t("已删除小组件") : `${t("已删除")} ${valid.length} ${t("个小组件")}`,
          t("已进入回收站可撤销或稍后恢复"),
          "info",
          {
            action: {
              label: t("撤销"),
              run: () => {
                const s = useWidgetStore.getState();
                for (const id of valid) s.restoreWidget(id);
              }
            }
          }
        );
      }, 220);
    },

    setPosAnim: (ids) => {
      set({ posAnimIds: ids });
      window.setTimeout(() => {
        if (get().posAnimIds === ids) set({ posAnimIds: [] });
      }, 280);
    },

    addWidget: (type, size) => {
      const { instances, activeView } = get();
      ensureCounterAbove(instances);
      const offset = instances.length * 24;
      const inst: WidgetInstance = {
        id: uid(),
        type,
        x: 16 + offset,
        y: 16 + offset,
        w: size.w,
        h: size.h,
        z: nextZ()
      };
      set({ instances: [...instances, inst] });
      saveInstances(activeView, get().instances);
      // 新实例落位后对账：岛上无数据课程表磁贴可以就此绑定到这个新实例。
      reconcileDockTiles();
      // 落位脉冲等入场动画播完再挂：pulse-in 与入场动画竞争 animation 属性，
      // 挂载首帧就带 pulse-in 会顶掉入场 scale/fade（一1 级联修复的配套时序）。
      // 禁用动画时 animMs=0，脉冲在下一拍即出现；750ms 从脉冲实际出现起算。
      window.setTimeout(() => {
        set({ pulseIds: [...get().pulseIds, inst.id] });
        window.setTimeout(() => {
          set({ pulseIds: get().pulseIds.filter((x) => x !== inst.id) });
        }, 750);
      }, animDurations().animMs + 20);
      // [SNIP] 返回新实例 id：钉图等跨窗口流程需要紧接着写入该实例的配置。
      return inst.id;
    },

    removeWidget: (id) => {
      const { activeView, instances, trash } = get();
      const inst = instances.find((i) => i.id === id);
      if (!inst) return;
      const entry: TrashWidget = {
        ...stripGroupId([inst])[0],
        view: activeView,
        deletedAt: new Date().toISOString()
      };
      const nextTrash = purgeExpiredTrash([entry, ...trash]);
      set({ instances: instances.filter((i) => i.id !== id), trash: nextTrash });
      // 编组成员被删：从组里摘除（剩 1 人即自动解散，见 removeGroupMember）。
      if (inst.groupId) get().removeGroupMember(inst.groupId, id);
      saveInstances(activeView, get().instances);
      saveTrash(nextTrash);
      // 本次删除进了回收站（可撤销，不降级）；purgeExpiredTrash 可能顺带清掉逾期项。
      reconcileDockTiles();
    },

    restoreWidget: (id) => {
      const { trash, activeView } = get();
      const entry = trash.find((t) => t.id === id);
      if (!entry) return;
      const nextTrash = trash.filter((t) => t.id !== id);
      set({ trash: nextTrash });
      saveTrash(nextTrash);
      // Restore into the view it was deleted from (fall back to the active view).
      const targetView = get().views.some((v) => v.id === entry.view) ? entry.view : activeView;
      const { deletedAt: _deletedAt, view: _view, ...inst } = entry;
      void _deletedAt;
      void _view;
      ensureCounterAbove(get().instances);
      const restored = { ...inst, z: nextZ() };
      if (targetView === get().activeView) {
        set({
          instances: [...get().instances, restored],
          enteringIds: [...get().enteringIds, restored.id],
          pulseIds: [...get().pulseIds, restored.id]
        });
        saveInstances(targetView, get().instances);
        window.setTimeout(() => {
          set({
            enteringIds: get().enteringIds.filter((x) => x !== restored.id),
            pulseIds: get().pulseIds.filter((x) => x !== restored.id)
          });
        }, 550);
      } else {
        saveInstances(targetView, [...loadInstances(targetView), restored]);
      }
      // 实例回归（可能带着课表数据）后对账：无数据课程表磁贴可以就此绑定。
      reconcileDockTiles();
    },

    purgeWidget: (id) => {
      const nextTrash = purgeExpiredTrash(get().trash.filter((t) => t.id !== id));
      set({ trash: nextTrash });
      saveTrash(nextTrash);
      reconcileDockTiles();
    },

    emptyWidgetTrash: () => {
      set({ trash: [] });
      saveTrash([]);
      reconcileDockTiles();
    },

    duplicateWidget: (id) => {
      const { activeView } = get();
      const src = get().instances.find((i) => i.id === id);
      if (!src) return;
      ensureCounterAbove(get().instances);
      const copy: WidgetInstance = {
        ...src,
        id: uid(),
        // Offset the copy so it doesn't overlap the original exactly.
        x: src.x + GRID,
        y: src.y + GRID,
        z: nextZ()
      };
      // 副本带走实例数据的独立拷贝（便签/书签/日历/涂鸦）：此后两边各自编辑，
      // 不共享——与「复制待办 = 两块同步」的全局数据模型划清边界。
      copyInstanceData(src.id, copy.id);
      set({ instances: [...get().instances, copy] });
      saveInstances(activeView, get().instances);
      // 新实例落位后对账：无数据课程表磁贴可以就此绑定到这个副本。
      reconcileDockTiles();
      // 与 addWidget 同理：脉冲等入场动画播完再挂，避免顶掉入场 scale/fade。
      window.setTimeout(() => {
        set({ pulseIds: [...get().pulseIds, copy.id] });
        window.setTimeout(() => {
          set({ pulseIds: get().pulseIds.filter((x) => x !== copy.id) });
        }, 750);
      }, animDurations().animMs + 20);
    },

    updateWidget: (id, patch) => {
      const { activeView } = get();
      // Snap x/y to the grid for clean alignment, then clamp so the widget can
      // never be dragged/nudged fully off-screen (an off-screen card has no
      // grabbable pixels left — recovery would require resetting the view).
      const next = { ...patch };
      if (typeof next.x === "number") next.x = clampAxis(next.x, "x");
      if (typeof next.y === "number") next.y = clampAxis(next.y, "y");
      set({ instances: get().instances.map((i) => (i.id === id ? { ...i, ...next } : i)) });
      saveInstances(activeView, get().instances);
    },

    bringToFront: (id) => {
      const { activeView, instances } = get();
      // Already the unique top card → nothing to change. Skipping here keeps
      // mouse-enter auto-raise from spamming store writes (and re-rendering the
      // whole canvas) when the pointer sweeps across the topmost card.
      const target = instances.find((i) => i.id === id);
      if (target && instances.every((i) => i.id === id || i.z < target.z)) return;
      // Compute the new z directly from the current max so the clicked widget is
      // ALWAYS strictly above every other widget — independent of any counter
      // drift from imports / copies / legacy persisted values. This is the
      // bulletproof guarantee for "last clicked stays on top".
      const maxZ = instances.reduce((m, i) => Math.max(m, i.z), 0);
      const newZ = maxZ + 1;
      // Keep the counter ahead so add/duplicate still produce higher z values.
      if (zCounter <= newZ) zCounter = newZ + 1;
      let next = instances.map((i) => (i.id === id ? { ...i, z: newZ } : i));
      next = renormalizeZ(next);
      set({ instances: next });
      saveInstances(activeView, get().instances);
    },

    sendToBack: (id) => {
      const { activeView } = get();
      const minZ = get().instances.reduce((m, i) => Math.min(m, i.z), 0);
      let next = get().instances.map((i) => (i.id === id ? { ...i, z: minZ - 1 } : i));
      next = renormalizeZ(next);
      set({ instances: next });
      saveInstances(activeView, get().instances);
    },

    setEditMode: (mode) => {
      set({ editMode: mode, selectedId: mode ? get().selectedId : null, selectedIds: mode ? get().selectedIds : [] });
      if (isTauri()) {
        invoke("set_edit_mode", { enabled: mode }).catch(console.error);
      }
    },

    setAlignGuides: (xs, ys) => {
      const cur = get().alignGuides;
      // 拖拽的 rAF 回调每帧调用；值未变时跳过写入，避免无谓的画布重渲染。
      if (sameNumbers(cur.xs, xs) && sameNumbers(cur.ys, ys)) return;
      set({ alignGuides: { xs, ys } });
    },

    alignMoveWidget: (id, x, y) => {
      const { activeView } = get();
      set({
        instances: get().instances.map((i) => (i.id === id ? { ...i, x: clampFree(x, "x"), y: clampFree(y, "y") } : i))
      });
      saveInstances(activeView, get().instances);
    },

    setDragPreview: (preview) => set({ dragPreview: preview }),

    setMergeTargetId: (id) => {
      // 拖拽的 rAF 回调每帧调用；目标未变时跳过写入，避免无谓的重渲染。
      if (get().mergeTargetId === id) return;
      set({ mergeTargetId: id });
    },

    setResizePreview: (preview) => set({ resizePreview: preview }),

    setOpacityPreview: (preview) => set({ opacityPreview: preview }),

    commitResize: () => {
      const { resizePreview } = get();
      if (!resizePreview) return;
      const { id, x, y, w, h } = resizePreview;
      set({ resizePreview: null });
      get().updateWidget(id, { x, y, w, h });
    },

    commitDragMove: () => {
      const { instances, dragPreview, activeView } = get();
      if (Object.keys(dragPreview).length === 0) {
        set({ alignGuides: { xs: [], ys: [] } });
        return;
      }
      // 提交帧 left/top 跳到终值且 transform 预览同帧归零；若 .widget-card 的
      // transform 过渡（.3s）仍生效，卡片会先冲出 (dx,dy) 再滑回——即"松手
      // 后滑一小段才归位"。挂 drag-commit 类抑制所有卡片过渡两帧后恢复。
      document.documentElement.classList.add("drag-commit");
      requestAnimationFrame(() =>
        requestAnimationFrame(() => document.documentElement.classList.remove("drag-commit"))
      );
      const next = instances.map((i) => {
        const off = dragPreview[i.id];
        if (!off) return i;
        // 与拖拽预览同一坐标系：只夹取、不二次网格化（见 clampFree 注释）。
        return { ...i, x: clampFree(i.x + off.dx, "x"), y: clampFree(i.y + off.dy, "y") };
      });
      set({ instances: next, dragPreview: {}, alignGuides: { xs: [], ys: [] } });
      saveInstances(activeView, next);
    },

    selectWidget: (id) => set({ selectedIds: id ? [id] : [], selectedId: id }),

    toggleSelect: (id) => {
      const cur = get().selectedIds;
      const has = cur.includes(id);
      const next = has ? cur.filter((x) => x !== id) : [...cur, id];
      set({ selectedIds: next, selectedId: next.length ? next[next.length - 1] : null });
    },

    setSelected: (ids) => set({ selectedIds: ids, selectedId: ids.length ? ids[ids.length - 1] : null }),

    clearSelection: () => set({ selectedIds: [], selectedId: null }),

    moveSelectedBy: (dx, dy) => {
      const { activeView } = get();
      if (get().selectedIds.length === 0) return;
      const selectedSet = new Set(get().selectedIds);
      const next = get().instances.map((i) => {
        if (!selectedSet.has(i.id)) return i;
        return {
          ...i,
          x: clampAxis(Math.round((i.x + dx) / GRID) * GRID, "x"),
          y: clampAxis(Math.round((i.y + dy) / GRID) * GRID, "y")
        };
      });
      set({ instances: next });
      saveInstances(activeView, get().instances);
    },

    removeSelected: () => {
      const { activeView, trash } = get();
      if (get().selectedIds.length === 0) return;
      const selectedSet = new Set(get().selectedIds);
      const removed = get().instances.filter((i) => selectedSet.has(i.id));
      const entries: TrashWidget[] = removed.map((inst) => ({
        ...inst,
        view: activeView,
        deletedAt: new Date().toISOString()
      }));
      const nextTrash = purgeExpiredTrash([...entries, ...trash]);
      set({
        instances: get().instances.filter((i) => !selectedSet.has(i.id)),
        trash: nextTrash,
        selectedIds: [],
        selectedId: null
      });
      saveInstances(activeView, get().instances);
      saveTrash(nextTrash);
      reconcileDockTiles();
    },

    alignSelected: (mode) => {
      const { activeView } = get();
      const sel = get().instances.filter((i) => get().selectedIds.includes(i.id));
      if (sel.length < 2) return;
      const primary = sel.find((i) => i.id === get().selectedId) ?? sel[sel.length - 1];
      if (!primary) return;
      const targets = new Map<string, { x: number; y: number }>();
      for (const i of sel) {
        let x = i.x;
        let y = i.y;
        switch (mode) {
          case "left":
            x = primary.x;
            break;
          case "center":
            x = primary.x + Math.round((primary.w - i.w) / 2);
            break;
          case "right":
            x = primary.x + primary.w - i.w;
            break;
          case "top":
            y = primary.y;
            break;
          case "middle":
            y = primary.y + Math.round((primary.h - i.h) / 2);
            break;
          case "bottom":
            y = primary.y + primary.h - i.h;
            break;
        }
        targets.set(i.id, { x, y });
      }
      // 等距分布：按中心点把选中的小组件均匀铺满包围盒（水平/垂直）。
      if (mode === "hspace") {
        const sorted = [...sel].sort((a, b) => a.x + a.w / 2 - (b.x + b.w / 2));
        const n = sel.length;
        const minC = sorted[0].x + sorted[0].w / 2;
        const maxC = sorted[n - 1].x + sorted[n - 1].w / 2;
        const step = n > 1 ? (maxC - minC) / (n - 1) : 0;
        sorted.forEach((s, idx) => {
          const cx = minC + step * idx;
          targets.set(s.id, { x: Math.round(cx - s.w / 2), y: s.y });
        });
      }
      if (mode === "vspace") {
        const sorted = [...sel].sort((a, b) => a.y + a.h / 2 - (b.y + b.h / 2));
        const n = sel.length;
        const minC = sorted[0].y + sorted[0].h / 2;
        const maxC = sorted[n - 1].y + sorted[n - 1].h / 2;
        const step = n > 1 ? (maxC - minC) / (n - 1) : 0;
        sorted.forEach((s, idx) => {
          const cy = minC + step * idx;
          targets.set(s.id, { x: s.x, y: Math.round(cy - s.h / 2) });
        });
      }
      const selectedSet = new Set(get().selectedIds);
      const next = get().instances.map((i) => {
        const t = selectedSet.has(i.id) ? targets.get(i.id) : undefined;
        if (!t) return i;
        return { ...i, x: clampAxis(t.x, "x"), y: clampAxis(t.y, "y") };
      });
      set({ instances: next });
      /* #65 批量对齐：标记选中卡做一次性 left/top 过渡（拖拽路径不受影响）。 */
      get().setPosAnim([...selectedSet]);
      saveInstances(activeView, get().instances);
    },

    arrangeSelected: (mode) => {
      const { activeView } = get();
      const sel = get().instances.filter((i) => get().selectedIds.includes(i.id));
      if (sel.length < 2) return;
      const targets = computeArrangement(sel, mode, { w: window.innerWidth, h: window.innerHeight });
      if (targets.size === 0) return;
      const next = get().instances.map((i) => {
        const t = targets.get(i.id);
        return t ? { ...i, x: t.x, y: t.y } : i;
      });
      set({ instances: next });
      /* 与批量对齐同款：一次性位置过渡 + 落盘。 */
      get().setPosAnim(sel.map((s) => s.id));
      saveInstances(activeView, get().instances);
    },

    setActiveView: (view) => {
      const { activeView, instances } = get();
      if (view === activeView) return;
      // Persist the current view's layout, then load the target view's. A debounced
      // drag save may still be in flight for the outgoing view — flush it first so
      // it can't be clobbered by the incoming view's own save buffer.
      flushWidgetLayoutSync();
      writeInstancesNow(activeView, instances);
      flushGroupsSave();
      const loaded = loadInstances(view);
      const nextGroups = sanitizeGroups(loadGroups(view), loaded);
      // H-审计：与 removeView 一致，切视图必须重置参考线，否则上一视图的
      // 对齐辅助线残留到新视图（拖拽时误导吸附判断）。
      set({
        activeView: view,
        instances: nextGroups.instances,
        groups: nextGroups.groups,
        selectedId: null,
        selectedIds: [],
        dragPreview: {},
        resizePreview: null,
        opacityPreview: null,
        alignGuides: { xs: [], ys: [] },
        dockDrag: null
      });
      try {
        localStorage.setItem(viewKey(), view);
      } catch {
        // ignore
      }
    },

    addView: (name) => {
      const trimmed = name.trim();
      if (!trimmed) return "";
      const id = uid();
      const next = [...get().views, { id, name: trimmed }];
      set({ views: next });
      saveViews(next);
      return id;
    },

    removeView: (id) => {
      const { views, activeView } = get();
      if (views.length <= 1) return;
      if (!views.some((v) => v.id === id)) return;
      const next = views.filter((v) => v.id !== id);
      // 删除的是当前活动视图时，先冲刷待落盘的防抖保存：防抖窗口内最后一次
      // 编辑仍指向这个即将删除的视图，若在清除其布局后定时器才触发，会把已
      // 删视图的布局重新写回 localStorage，留下孤儿数据。
      if (activeView === id) flushWidgetLayoutSync();
      set({ views: next });
      saveViews(next);
      // Clear the removed view's layout storage.
      try {
        localStorage.removeItem(layoutKey(id));
        localStorage.removeItem(groupsKey(id));
      } catch {
        // ignore
      }
      if (isTauri()) {
        sqliteRepo.setSetting(dbLayoutKey(id), "[]").catch(reportPersistError("clearLayout"));
      }
      // If the deleted view was active, switch to another view.
      if (activeView === id) {
        const fallback = next[0]?.id ?? "home";
        const loaded = loadInstances(fallback);
        const fbGroups = sanitizeGroups(loadGroups(fallback), loaded);
        // 视图切换必须重置瞬态选中/拖拽状态，否则旧视图的 selectedId 会残留，
        // 键盘删除/多选对齐可能误伤兜底视图里恰巧同 id 的小组件（或指向不存在
        // 的小组件使快捷键无响应）。
        set({
          activeView: fallback,
          instances: fbGroups.instances,
          groups: fbGroups.groups,
          selectedId: null,
          selectedIds: [],
          dragPreview: {},
          resizePreview: null,
          opacityPreview: null,
          alignGuides: { xs: [], ys: [] }
        });
        try {
          localStorage.setItem(viewKey(), fallback);
        } catch {
          // ignore
        }
      }
      // 该视图的实例随布局键一起永久消失（不进回收站）：绑定它们的磁贴降级。
      reconcileDockTiles();
    },

    renameView: (id, name) => {
      const trimmed = name.trim();
      if (!trimmed) return;
      const next = get().views.map((v) => (v.id === id ? { ...v, name: trimmed } : v));
      set({ views: next });
      saveViews(next);
    },

    /**
     * Loads the persisted layout into the store. Returns a promise that
     * resolves once the durable SQLite copy (if any) has been applied, so the
     * caller can safely make "first run" decisions like seeding the default
     * layout AFTER knowing whether durable storage holds anything.
     */
    hydrate: (): Promise<void> => {
      const view = get().activeView;
      const loaded = loadInstances(view);
      syncZCounter(loaded);
      set({ instances: loaded });
      if (!isTauri()) return Promise.resolve();
      // Guards against the async SQLite response landing after the store has
      // moved on (user edit, view switch, cross-window sync): a stale layout
      // must never overwrite newer state. `baseline` is the exact array set
      // above — any later mutation replaces it with a new reference.
      const seq = ++hydrateSeq;
      const baseline = loaded;
      // A-12：trash 的异步读与 instances 一样需要 baseline 守卫——若读库期间用户
      // 已删/清了回收站（get().trash 换成新引用），旧快照不得把改动倒灌回来。
      const trashBaseline = get().trash;
      const layout = loadInstancesFromDb(view).then((instances) => {
        if (seq !== hydrateSeq) return;
        if (instances.length === 0) return;
        if (get().instances !== baseline) return;
        syncZCounter(instances);
        set({ instances });
      });
      const trash = (async () => {
        let raw: string | null = null;
        try {
          raw = await sqliteRepo.getSetting(dbTrashKey());
          if (!raw) raw = await sqliteRepo.getSetting(LEGACY_DB_TRASH_KEY);
        } catch {
          return; // 镜像读失败：localStorage 权威，保持现状不回退陈旧副本
        }
        if (seq !== hydrateSeq) return;
        // P8：trashKey() 存在且可解析（含刻意清空的 []）即权威；镜像落后则回写自愈，
        // 仅缺键/损坏时才采纳 DB 副本——与布局的 loadInstancesFromDb 同一策略。
        let lsRaw: string | null = null;
        let lsUsable = false;
        try {
          lsRaw = localStorage.getItem(trashKey());
          if (lsRaw !== null && Array.isArray(JSON.parse(lsRaw))) lsUsable = true;
        } catch {
          // 缺键/损坏按「不可用」处理
        }
        if (lsRaw !== null && lsUsable) {
          if (lsRaw !== raw) {
            sqliteRepo
              .setSetting(dbTrashKey(), lsRaw)
              .catch((err) => console.warn("[widgets] self-heal mirror write failed:", dbTrashKey(), err));
          }
          return;
        }
        if (!raw || get().trash !== trashBaseline) return;
        try {
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed)) set({ trash: purgeExpiredTrash(parsed.filter(isValidTrash)) });
        } catch {
          // ignore
        }
      })();
      // DOCK：localStorage 缺键（首启 / 存储被清 / 备份恢复到新机）时采纳 SQLite
      // 镜像并回填；有键即权威，不回退。与布局/回收站同一 P8 策略的精简版。
      const dock = (async () => {
        if (hasPersistedDock()) return;
        let raw: string | null = null;
        try {
          raw = await sqliteRepo.getSetting(dbDockKey());
        } catch {
          return;
        }
        if (seq !== hydrateSeq || !raw || hasPersistedDock()) return;
        const cfg = parseDockConfig(raw);
        try {
          localStorage.setItem(dockKey(), JSON.stringify(cfg));
        } catch {
          // best-effort
        }
        set({ dock: cfg });
      })();
      return Promise.all([layout, trash, dock]).then(() => {
        // P1：hydrate 完成后对账一次——启动时按陈旧镜像建的窗口（该屏实际
        // 已空）在此销毁；对账依据仍是镜像，镜像本身未愈的极端情况在下
        // 一次布局落盘时收敛。
        scheduleWidgetWindowReconcile();
      });
    },

    switchScreen: (screen) => {
      if (screen === currentScreen) return;
      // 旧分区若有防抖窗口内的待落盘编辑，先按旧 key 冲刷（切换后 key 就
      // 指向目标屏了，迟到的落盘会把 A 屏布局写进 B 屏）。
      flushWidgetLayoutSync();
      currentScreen = screen;
      try {
        localStorage.setItem(SETTINGS_SCREEN_KEY, screen);
      } catch {
        // best-effort
      }
      const views = loadViews();
      const persisted = loadView();
      // 目标屏持久化的活动视图可能已不存在（视图在别的窗口被删），回落首项。
      const activeView = views.some((v) => v.id === persisted) ? persisted : (views[0]?.id ?? "home");
      const loaded = loadInstances(activeView);
      syncZCounter(loaded);
      const groupsRaw = loadGroups(activeView);
      const sanitized = sanitizeGroups(groupsRaw, loaded);
      set({
        screenId: screen,
        views,
        activeView,
        instances: sanitized.instances,
        groups: sanitized.groups,
        trash: purgeExpiredTrash(loadTrash()),
        templates: loadTemplates(),
        dock: loadDock(),
        dockDrag: null,
        selectedId: null,
        selectedIds: [],
        dragPreview: {},
        resizePreview: null,
        opacityPreview: null,
        alignGuides: { xs: [], ys: [] }
      });
      // 异步合并该屏的 SQLite 镜像（首启/localStorage 被清时兜底），随后对账磁贴绑定。
      void get()
        .hydrate()
        .then(() => reconcileDockTiles());
    },

    exportLayout: () =>
      JSON.stringify(
        {
          version: 1,
          view: get().activeView,
          exportedAt: new Date().toISOString(),
          instances: stripGroupId(get().instances)
        },
        null,
        2
      ),

    importLayout: (json) => {
      try {
        const parsed = JSON.parse(json);
        if (!parsed || !Array.isArray(parsed.instances)) return false;
        const instances: WidgetInstance[] = (parsed.instances as unknown[])
          .filter((i): i is WidgetInstance => {
            if (!i || typeof i !== "object") return false;
            const o = i as Record<string, unknown>;
            return (
              typeof o.id === "string" &&
              typeof o.type === "string" &&
              typeof o.x === "number" &&
              typeof o.y === "number" &&
              typeof o.w === "number" &&
              typeof o.h === "number"
            );
          })
          .map((i) => ({ ...i, z: typeof i.z === "number" ? i.z : nextZ() }));
        const { activeView } = get();
        ensureCounterAbove(instances);
        set({ instances });
        saveInstances(activeView, instances);
        // 整表替换：旧实例不进回收站，绑定它们的磁贴降级（对账读防抖缓冲，不必先落盘）。
        reconcileDockTiles();
        return true;
      } catch {
        return false;
      }
    },

    resetView: (view) => {
      saveInstances(view, []);
      if (get().activeView === view) set({ instances: [] });
      reconcileDockTiles();
    },

    saveTemplate: (name) => {
      const trimmed = name.trim();
      if (!trimmed) return false;
      const { templates, instances } = get();
      if (templates.some((t) => t.name === trimmed)) return false;
      const next = [
        ...templates,
        // 模板不携带编组（groupId 剥离）：套用到任意视图不会产生孤儿引用。
        { id: uid(), name: trimmed, createdAt: Date.now(), instances: stripGroupId(instances) }
      ];
      saveTemplates(next);
      set({ templates: next });
      return true;
    },

    applyTemplate: (id) => {
      const t = get().templates.find((x) => x.id === id);
      if (!t) return false;
      // 深拷贝并重新分配实例 id，避免套用后与另一窗口的同步回环冲突；
      // 便签/书签/日历/涂鸦等按实例 id 寻址的数据桶随之搬家，模板带回内容。
      const instances: WidgetInstance[] = t.instances.map((i) => {
        const nid = uid();
        copyInstanceData(i.id, nid);
        return { ...i, id: nid, z: nextZ() };
      });
      const { activeView } = get();
      ensureCounterAbove(instances);
      set({ instances, selectedId: null, selectedIds: [] });
      saveInstances(activeView, instances);
      reconcileDockTiles();
      return true;
    },

    deleteTemplate: (id) => {
      const next = get().templates.filter((t) => t.id !== id);
      saveTemplates(next);
      set({ templates: next });
    }
  }))
);

/**
 * BentoDesk 借鉴 #1：时间线恢复入口（layout-timeline 的 undo/redo 调用）。
 * 整替目标视图的实例与编组并落盘；清除与复活实例同 id 的回收站条目（防
 * 「回收站里还躺着一份」导致重复恢复）；目标为活动视图时同步内存态并
 * 重排岛磁贴（applyTemplate 同款收尾）。
 */
export function applyTimelineState(view: string, instances: WidgetInstance[], groups: WidgetGroup[]) {
  const st = useWidgetStore.getState();
  const liveIds = new Set(instances.map((i) => i.id));
  const trash = st.trash.filter((w) => !liveIds.has(w.id));
  ensureCounterAbove(instances);
  if (st.activeView === view) {
    /* 五.2 恢复可见化：存活卡几何变化走 pos-anim FLIP、复活卡走 fly-in + 落位
       脉冲——undo/快照套用不再是存活卡瞬跳硬切（机制与拖拽落位/回收站恢复
       同源）。窗口 560ms 覆盖 pos-anim 500ms 档 + 尾帧。 */
    const prev = new Map(st.instances.map((i) => [i.id, i]));
    const movedIds: string[] = [];
    const revivedIds: string[] = [];
    for (const i of instances) {
      const before = prev.get(i.id);
      if (!before) revivedIds.push(i.id);
      else if (before.x !== i.x || before.y !== i.y || before.w !== i.w || before.h !== i.h) movedIds.push(i.id);
    }
    useWidgetStore.setState({
      instances,
      groups,
      trash,
      selectedId: null,
      selectedIds: [],
      ...(movedIds.length ? { posAnimIds: movedIds } : {}),
      ...(revivedIds.length ? { enteringIds: revivedIds, pulseIds: revivedIds } : {})
    });
    if (movedIds.length > 0 || revivedIds.length > 0) {
      window.setTimeout(() => {
        const cur = useWidgetStore.getState();
        useWidgetStore.setState({
          posAnimIds: cur.posAnimIds.filter((x) => !movedIds.includes(x)),
          enteringIds: cur.enteringIds.filter((x) => !revivedIds.includes(x)),
          pulseIds: cur.pulseIds.filter((x) => !revivedIds.includes(x))
        });
      }, 560);
    }
    reconcileDockTiles();
  } else {
    useWidgetStore.setState({ trash });
  }
  saveTrash(trash);
  saveInstances(view, instances);
  saveGroups(view, groups);
}

/** 跨窗口同步载荷：另一窗口（设置窗口 / 桌面层）发来的完整小组件状态。 */
export type WidgetSyncPayload = {
  /** 发送方 WebView 实例标识；接收方跳过自己的回声（旧版本载荷无此字段）。 */
  instanceId?: string;
  /** A-12：发送方单调递增的版本号。接收方按发送方记忆 lastRev，拒绝乱序/重复
   *  到达的旧快照，避免 80ms 防抖交错时旧整包覆盖新整包。旧版本载荷无此字段。 */
  rev?: number;
  /** 所属屏幕分区 id：只有与当前窗口 screenId 一致时才应用，避免多屏互相覆盖。 */
  screenId: string;
  instances: WidgetInstance[];
  /** DeskOrder 借鉴 #12：编组容器（旧版本载荷无此字段，按空组兼容）。 */
  groups?: WidgetGroup[];
  views: ViewDef[];
  activeView: string;
  trash: TrashWidget[];
};

/**
 * 应用另一窗口同步来的小组件状态：写入 localStorage 镜像（保证本窗口内
 * loadInstances() 等直接读存储的代码也能拿到最新数据），再整体 setState。
 * 仅更新内存态，不触发保存动作，避免回写引发同步循环。
 * 仅接受与自己屏幕分区匹配的载荷，跨屏布局不混淆。
 *
 * 注意：不无条件抢占 activeView。若发送方编辑的是与本窗口当前视图不同的
 * 视图（例如设置窗口的 activeView 与桌面层不一致），只把该视图的布局持久化
 * 到对应 key，绝不把桌面用户正在看的视图拽走。
 */
export function applyRemoteWidgets(p: WidgetSyncPayload) {
  if (!p || p.screenId !== currentScreenId()) return;
  if (!Array.isArray(p.instances) || !Array.isArray(p.views) || !Array.isArray(p.trash)) return;
  const local = useWidgetStore.getState();
  try {
    // Persist the incoming layout to ITS own view key so edits to a non-active
    // view survive, even when this window is showing a different view.
    // C-4（审查修复）：与本地写路径同规格——走写前 .bak 轮换（防坏包直接
    // 顶掉上一份好数据），且只持久化洗过的载荷副本（外层仅校验过
    // Array.isArray，元素级过滤在此先行）。后续 setState 分支再用另一份
    // 独立拷贝（syncZCounter 原地改号不得污染镜像）。
    const sanitized = p.instances
      .filter((i): i is WidgetInstance => !!i && typeof i === "object" && typeof i.id === "string")
      .map((i) => ({ ...i }));
    syncZCounter(sanitized);
    localStorageWriteWithBackup(layoutKey(p.activeView), JSON.stringify(sanitized));
    if (Array.isArray(p.groups)) {
      const cleanGroups = sanitizeGroups(p.groups.filter(isValidGroup), sanitized).groups;
      localStorageWriteWithBackup(groupsKey(p.activeView), JSON.stringify(cleanGroups));
    }
    localStorageWriteWithBackup(viewsKey(), JSON.stringify(p.views));
    localStorageWriteWithBackup(trashKey(), JSON.stringify(p.trash));
    // C-2（审查修复）：远端包直写后清掉待落盘的本地防抖快照——它记录的是
    // 旧内存态，放行会在 300ms 防抖到期后把旧布局写回（writeInstancesNow
    // 的过期守卫是第二道保险）。
    pendingSave = null;
    if (saveTimer !== null) {
      window.clearTimeout(saveTimer);
      saveTimer = null;
    }
  } catch {
    // best-effort
  }
  const trash = purgeExpiredTrash(p.trash);
  if (p.activeView === local.activeView) {
    // Work on a copy: syncZCounter renumbers z in place, and mutating the shared
    // payload would also corrupt the layout mirror we just wrote above.
    const instances = p.instances.map((i) => ({ ...i }));
    syncZCounter(instances);
    const gs = sanitizeGroups(Array.isArray(p.groups) ? p.groups.filter(isValidGroup) : [], instances);
    useWidgetStore.setState({ instances: gs.instances, groups: gs.groups, views: p.views, trash });
  } else {
    // Same screen, but a different view was edited: absorb the shared metadata
    // without switching the local view or overwriting its instances.
    useWidgetStore.setState({ views: p.views, trash });
  }
}

/* ---- DOCK：跨窗口同步（sync:dock）与绑定实例失效对账 ---- */

/**
 * 跨窗口 dock 同步载荷（sync:dock）：设置窗「灵动岛」页与桌面层各持一份 store，
 * dock 不在 sync:widgets 里——此前设置窗的改动要到下次启动才到桌面层，期间桌面层
 * 任意一次 saveDock 还会用陈旧内存态把它覆盖掉。整份配置 + 屏幕分区，接收方按屏采纳。
 */
export type DockSyncPayload = {
  /** 发送方 WebView 实例标识；接收方跳过自己的回声。 */
  instanceId?: string;
  /** 发送方单调递增版本号（拒旧、拒重复，与 sync:widgets 同型）。 */
  rev?: number;
  screenId: string;
  dock: DockConfig;
};

/**
 * 应用另一窗口同步来的 dock 配置：只接受同屏载荷；经 parseDockConfig 洗一遍后写
 * localStorage 镜像（loadDock / hasPersistedDock 直接读存储）并整体 setState。不走
 * saveDock 的 SQLite 写（发送方已镜像），避免回写引发同步循环。
 */
export function applyRemoteDock(p: DockSyncPayload) {
  if (!p || p.screenId !== currentScreenId() || !p.dock || typeof p.dock !== "object") return;
  const cfg = parseDockConfig(JSON.stringify(p.dock));
  try {
    localStorage.setItem(dockKey(), JSON.stringify(cfg));
  } catch {
    // best-effort
  }
  useWidgetStore.setState({ dock: cfg });
}

/** 磁贴降级事件（需求 §7 风险表）：detail 为被降级的磁贴数组，DockShell 据此弹一次性提示。 */
export const DOCK_TILES_DEGRADED_EVENT = "vela:dock-tiles-degraded";

/**
 * 绑定实例是否仍存在于本屏：当前视图内存态 → 回收站（可恢复；Alt 拖入岛的磁贴
 * 正是绑定回收站里的实例）→ 各视图的持久化布局（localStorage 权威，含当前视图——
 * hydrate 前内存态可能还是空的）。某视图若有防抖窗口内未落盘的布局（pendingSave），
 * 以该缓冲为准：此时 localStorage 是陈旧副本，刚删掉的实例还躺在里面。
 */
function dockInstanceExists(instanceId: string, st: Pick<WidgetState, "instances" | "trash" | "views">): boolean {
  if (st.instances.some((i) => i.id === instanceId)) return true;
  if (st.trash.some((t) => t.id === instanceId)) return true;
  return st.views.some((v) => {
    const list = pendingSave?.view === v.id ? pendingSave.instances : loadInstances(v.id);
    return list.some((i) => i.id === instanceId);
  });
}

/**
 * 绑定实例已被**永久**删除（清空 / 逾期清理回收站、删视图、整表替换）的磁贴降级为
 * 无实例磁贴：保留磁贴与位置、去掉 instanceId，此后按图库入口的无实例语义读写
 * （DockTile.config），不静默消失。降级后若与岛上既有的无实例同类磁贴同身份
 * （findDockTileConflict），则移除该枚而非保留两枚。移入回收站不触发（可撤销）。
 *
 * @returns 被降级（含因重复而移除）的磁贴；有变化时同时派发 DOCK_TILES_DEGRADED_EVENT。
 */
/**
 * 岛上磁贴绑定对账，两个方向：
 *  - 降级：绑定实例已被**永久**删除（清空 / 逾期清理回收站、删视图、整表替换）
 *    的磁贴去掉 instanceId，保留磁贴与位置，不静默消失。降级后若与岛上既有的
 *    无实例同类磁贴同身份，直接移除（去重规则不允许并存）。
 *  - 升级（课程表）：无实例课程表磁贴自身没有课表数据（tile.config 与合成键
 *    都没有 data/profiles）而画布已有课程表实例 → 绑定到该实例，与画布卡片
 *    同源。已导入过私有数据的磁贴保持独立，不吞用户的既有数据。
 *
 * 调用点：启动 hydrate 后、画布增删实例、跨窗口 sync 事件。
 *
 * @returns 被降级的磁贴列表（DockShell 据此弹提示；升级不产生提示）。
 */
export function reconcileDockTiles(): DockTile[] {
  const st = useWidgetStore.getState();
  const degraded = st.dock.tiles.filter((t) => !!t.instanceId && !dockInstanceExists(t.instanceId, st));
  const gone = new Set(degraded.map((t) => t.id));
  const survivors = st.dock.tiles.filter((t) => !gone.has(t.id));
  const tiles: DockTile[] = [];
  for (const t of st.dock.tiles) {
    if (!gone.has(t.id)) {
      tiles.push(t);
      continue;
    }
    const { instanceId: _instanceId, ...rest } = t;
    void _instanceId;
    if (findDockTileConflict(survivors, rest) || findDockTileConflict(tiles, rest)) continue;
    tiles.push(rest);
  }

  // 升级：无实例课程表磁贴 → 绑定画布课程表实例（自身有数据则跳过）。
  let upgraded = false;
  const timetableCandidates = st.instances.filter((i) => i.type === "timetable");
  if (timetableCandidates.length > 0) {
    const withData = timetableCandidates.find((i) => timetableDataInConfig(loadWidgetConfig(i.id)));
    const target = withData ?? timetableCandidates[0];
    for (let i = 0; i < tiles.length; i++) {
      const t = tiles[i];
      if (t.instanceId || t.type !== "timetable") continue;
      // 自身已有课表数据（磁贴私有配置或合成键）：保持独立，不吞用户数据。
      if (timetableDataInConfig(t.config) || timetableDataInConfig(loadWidgetConfig(dockTileInstanceId(t)))) continue;
      // 目标实例已被其他磁贴绑定（或降级幸存者冲突）：不重复绑定。
      if (findDockTileConflict(tiles, { type: t.type, instanceId: target.id })) continue;
      tiles[i] = { ...t, instanceId: target.id };
      upgraded = true;
      break; // 一实例一磁贴：绑定一枚即可
    }
  }

  if (upgraded || degraded.length > 0) {
    const next: DockConfig = { ...st.dock, tiles };
    useWidgetStore.setState({ dock: next });
    saveDock(next);
  }
  if (degraded.length > 0) {
    try {
      window.dispatchEvent(new CustomEvent(DOCK_TILES_DEGRADED_EVENT, { detail: degraded }));
    } catch {
      // best-effort
    }
  }
  return degraded;
}

/**
 * A-12：启动期事件丢失窗兜底。sync:widgets 监听注册完成后由 cross-window 调用。
 * 第二窗口启动时，发送方对共享 localStorage 与 SQLite 的最新保存可能发生在本窗口
 * 读库之后，其后投递的 sync:widgets 事件又落在监听注册前被丢弃——本窗口会一直停留
 * 在陈旧布局直到下一次编辑。这里在监听就绪后重读一次持久层（P8：localStorage 权威，
 * 缺键才采纳 DB 副本并自愈镜像；发送方每次保存都先写 localStorage 再镜像写库），
 * 带 seq + baseline 守卫，绝不覆盖启动后用户的新编辑。
 */
export async function repullWidgetsFromDb(): Promise<void> {
  if (!isTauri()) return;
  const view = useWidgetStore.getState().activeView;
  const seq = ++hydrateSeq;
  const instBaseline = useWidgetStore.getState().instances;
  const trashBaseline = useWidgetStore.getState().trash;

  // 先读布局（可能回退到 localStorage；空布局不采纳）。
  const instances = await loadInstancesFromDb(view);
  if (seq !== hydrateSeq) return;
  if (instances.length !== 0 && useWidgetStore.getState().instances === instBaseline) {
    syncZCounter(instances);
    useWidgetStore.setState({ instances });
  }

  // 再读回收站（同样带 baseline 守卫；P8 策略与 hydrate 一致）。
  let raw: string | null = null;
  try {
    raw = await sqliteRepo.getSetting(dbTrashKey());
    if (!raw) raw = await sqliteRepo.getSetting(LEGACY_DB_TRASH_KEY);
  } catch {
    return; // 镜像读失败：保持现状
  }
  if (seq !== hydrateSeq) return;
  let lsRaw: string | null = null;
  let lsUsable = false;
  try {
    lsRaw = localStorage.getItem(trashKey());
    if (lsRaw !== null && Array.isArray(JSON.parse(lsRaw))) lsUsable = true;
  } catch {
    // 缺键/损坏按「不可用」处理
  }
  if (lsRaw !== null && lsUsable) {
    if (lsRaw !== raw) {
      sqliteRepo
        .setSetting(dbTrashKey(), lsRaw)
        .catch((err) => console.warn("[widgets] self-heal mirror write failed:", dbTrashKey(), err));
    }
    return;
  }
  if (!raw || useWidgetStore.getState().trash !== trashBaseline) return;
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      useWidgetStore.setState({ trash: purgeExpiredTrash(parsed.filter(isValidTrash)) });
    }
  } catch {
    // ignore
  }
}
