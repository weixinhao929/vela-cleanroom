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
  GROUP_MIN_SIZE,
  isValidGroup,
  sanitizeGroups,
  stripGroupId,
  type MergeTarget,
  type WidgetGroup
} from "./widget-groups";
import { computeArrangement } from "./arrange";
import { copyInstanceData, removeInstanceData } from "./instance-data";
export type { WidgetGroup, MergeTarget } from "./widget-groups";
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
 * hydrate 以 localStorage 为权威源，DB 落后时回写自愈。
 */

/** 显示名/组名的持久化长度上限（硬化）：写入路径 UI 层钳 24（按码点），
 *  这里只挡被篡改的存储/备份带来的极端值（撑爆标签条与侧栏布局）。远超
 *  UI 上限才算毒化，正常用户数据永不触及。 */
const LABEL_LENGTH_LIMIT = 256;

/** 结构校验：是否为合法实例（至少含 id + type，几何字段须为有限数字）。
 *  有限性在此收口：持久化 JSON 里被篡改的 z（对象 / NaN / Infinity）一旦进
 *  store，会经 Math.max 毒化 zCounter 为 NaN，再沿 renormalizeZ / syncZCounter
 *  的排序扩散成全局层序失效——不可信输入在入口即被剔除。 */
function isValidInstance(v: unknown): v is WidgetInstance {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.id === "string" &&
    typeof o.type === "string" &&
    Number.isFinite(o.x) &&
    Number.isFinite(o.y) &&
    Number.isFinite(o.w) &&
    Number.isFinite(o.h) &&
    Number.isFinite(o.z) &&
    (o.label === undefined || (typeof o.label === "string" && o.label.length <= LABEL_LENGTH_LIMIT))
  );
}

/** Returns true when `v` is a structurally valid TrashWidget. */
function isValidTrash(v: unknown): v is TrashWidget {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.id === "string" &&
    typeof o.type === "string" &&
    typeof o.deletedAt === "string" &&
    (o.label === undefined || (typeof o.label === "string" && o.label.length <= LABEL_LENGTH_LIMIT))
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
  /** 所属编组 id（组容器渲染；成员自身几何 = 解散恢复位）。 */
  groupId?: string;
  /** 自定义显示名（重命名标签）：设置后卡片标题 / 组标签 / 花瓣 / 配置面板与
   *  设置页共用此名（widgetDisplayName 优先读取）；空串/缺省回落自动名
   *  （类型译名 + 同类型序号）。随实例持久化并跨窗口同步。 */
  label?: string;
};

/** A named view. `id` is the stable storage key for its layout. */
export type ViewDef = {
  id: string;
  name: string;
};

/**
 * 命名布局模板：保存当前视图全部小组件的布局快照，之后可一键套用。
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
  /** 自定义显示名快照：删除时随实例展开带入（运行时一直如此，类型
   *  未声明），恢复时原样带回；回收站列表用它显示用户起的名字。 */
  label?: string;
  view: string;
  deletedAt: string;
};

/** How long a deleted widget stays in the recycle bin before auto-purge. */
export const TRASH_RETENTION_DAYS = 30;

/* ---- DOCK（→ 灵动岛 2.0 §4.1）：贴边聚合容器配置 v2 ---- */

/**
 * 岛贴哪条边。产品决策「岛只贴顶边」（设置页注释：贴底没有使用价值），
 * 解析层（parseDockConfig）恒归一为 top；bottom 仅作为 DockShell 渲染分支
 * 的类型稳定占位保留（拖拽换边预览已随贴底退役，不再有运行期写入路径）。
 * left / right 竖边从未有渲染实现，类型上保留以兼容旧载荷的字面量
 * 空间，但写入侧（isDockEdge/setDockPlacement）一律拒绝——杜绝「存了 left
 * 渲染成 top」的半成品状态。
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
/** 鼠标动作（悬停/左键/中键三档动作）。 */
export type DockMouseActions = {
  hover: "none" | "peak" | "expand-first";
  blank: "none" | "panel";
  middle: "collapse" | "panel";
  wheel: "none" | "cycle";
};
/** 接管链各 kind 开关 + 展示时长。 */
/** brightness / volume 为应用内调整的 OSD 式接管（缺省开，旧载荷缺项回默认）。 */
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
  /** 外形：pill 悬浮胶囊（现状）/ bangs 贴边刘海（二期）。 */
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

/** 默认三磁贴（稳定、可断言）；运行时新增磁贴一律走 createDockTile 取 uuid。 */
export const DEFAULT_DOCK: DockConfig = {
  ...cloneDockDefaults(),
  tiles: [
    { id: "dock-tile-clock", type: "clock" },
    { id: "dock-tile-pomodoro", type: "pomodoro" },
    { id: "dock-tile-notifications", type: "notifications" }
  ]
};

/** 深拷贝一份默认配置（子对象与 tiles 逐枚新建，绝不与常量共享引用）。
 *  非主屏的默认磁贴 id 加屏号后缀——widget-config 合成键
 *  （focus-desk.widget-config.dock-tile-<id>.v1）全局共享，此前两块屏的
 *  默认磁贴共用同一合成键互相污染 tile.config 播种；主屏保持原 id，
 *  既有用户数据连续性不受影响。 */
function freshDefaultDock(): DockConfig {
  const sfx = currentScreen === "0" ? "" : `-${currentScreen}`;
  return {
    ...cloneDockDefaults(),
    tiles: DEFAULT_DOCK.tiles.map((t) => ({ ...t, id: `${t.id}${sfx}` }))
  };
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

/** v2 磁贴元素校验：id / type 非空字符串；instanceId 若有须为非空字符串
 *  （空串曾被放行，dockTileInstanceId 侧另有 truthiness 兜底）；config 若有须为对象。 */
function isDockTileObject(v: unknown): v is DockTile {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.id === "string" &&
    o.id !== "" &&
    typeof o.type === "string" &&
    o.type !== "" &&
    (o.instanceId === undefined || (typeof o.instanceId === "string" && o.instanceId !== "")) &&
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
    if (t.instanceId) tile.instanceId = t.instanceId;
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
    // 展示时长 3–15s。
    durationMs:
      typeof o.durationMs === "number" && Number.isFinite(o.durationMs)
        ? Math.min(15_000, Math.max(3_000, Math.round(o.durationMs)))
        : d.durationMs
  };
}

/* ---- ：dock 广播防抖的冲刷钩子（cross-window 注入，防静态环依赖） ---- */

/* switchScreen 分区切换前必须先冲刷待发射的 sync:dock——80ms 窗口内切屏会
   把旧屏那次广播取消（订阅回调只 clear 不发），此后发射的是新屏快照：旧屏
   对端错过事件且无自愈时机，其后任意一次 dock 写入都以陈旧内存整包回写、
   污染 LS 权威源与 SQLite 镜像。实现由 cross-window 的 useCrossWindowSync
   挂载 / 卸载时摘除。 */
let dockBroadcastFlusher: (() => void) | null = null;
export function registerDockBroadcastFlusher(fn: (() => void) | null): void {
  dockBroadcastFlusher = fn;
}

/* ---- ：widgets 广播防抖的冲刷钩子（dock 的 同款） ---- */

/* switchScreen 分区切换的 set() 会触发 cross-window 的 widgets 订阅回调，
   把旧屏 80ms 内待发射的 sync:widgets **取消**（clear 不发）——旧屏那次编辑
   从此无人知晓，管理/桌面层对端要等下一次任意编辑才追上，且期间任意一次
   落盘/回写都可能以陈旧内存整包扩散。切换前必须先以「旧屏号 + 订阅期快照」
   冲刷一次（冲刷点在 currentScreen 改写之前，屏号与数据一致）。实现由
   cross-window 的 useCrossWindowSync 挂载 / 卸载时注入与摘除（防静态环依赖）。 */
let widgetsBroadcastFlusher: (() => void) | null = null;
export function registerWidgetsBroadcastFlusher(fn: (() => void) | null): void {
  widgetsBroadcastFlusher = fn;
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

/* ---- ：removeDockTile 的磁贴私有数据延迟清理（撤销窗口内可恢复） ---- */

/** 兜底延迟（ms）：无撤销 toast 的 removeDockTile 调用方（设置页磁贴芯片 ×、
 *  DockConfigPanel）在此时长后真正清理数据；有撤销 toast 的调用方由
 *  onDismiss → finalizeDockTileDataRemoval 提前执行（窗口含悬停暂停的
 *  全部时长，比固定值精确）。 */
const DOCK_TILE_DATA_REMOVAL_FALLBACK_MS = 15_000;

const dockTileDataRemovals = new Map<string, { timer: number; instanceKey: string }>();

/** 登记延迟清理任务（removeDockTile 内部调用）：同 tileId 的旧任务先取消
 *  （移除 → 撤销 → 再移除的往返不误删第二次撤销窗口内的数据）。 */
function scheduleDockTileDataRemoval(tile: DockTile): void {
  cancelDockTileDataRemoval(tile.id);
  const instanceKey = dockTileInstanceId(tile);
  const timer = window.setTimeout(() => {
    dockTileDataRemovals.delete(tile.id);
    removeInstanceData(instanceKey);
  }, DOCK_TILE_DATA_REMOVAL_FALLBACK_MS);
  dockTileDataRemovals.set(tile.id, { timer, instanceKey });
}

/** 撤销路径取消清理（undo 动作 run 的第一步调用）。 */
export function cancelDockTileDataRemoval(tileId: string): void {
  const e = dockTileDataRemovals.get(tileId);
  if (!e) return;
  window.clearTimeout(e.timer);
  dockTileDataRemovals.delete(tileId);
}

/** 撤销窗口关闭（撤销 toast 的 onDismiss）：立即执行未取消的清理。
 *  与兜底 timer 互斥——谁先到谁执行，另一方随即 no-op。 */
export function finalizeDockTileDataRemoval(tileId: string): void {
  const e = dockTileDataRemovals.get(tileId);
  if (!e) return;
  window.clearTimeout(e.timer);
  dockTileDataRemovals.delete(tileId);
  removeInstanceData(e.instanceKey);
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
    if (looksV1) {
      /* 迁移 id 确定性生成（`dock-tile-<type>`，非主屏加屏号后缀）——
         随机 uuid 在多窗口并发迁移同一 v1 键时各造一套，先后落盘 + sync:dock
         整包互顶后展开 id / 合成配置键全部漂移；屏号后缀同时避免与其它屏的
         默认磁贴共用同一个 widget-config 合成键。edge 归 top 由迁移函数
         自身完成（不再调用点覆盖成死代码）。 */
      const sfx = currentScreen === "0" ? "" : `-${currentScreen}`;
      return migrateDockConfig(o, (t) => `dock-tile-${t}${sfx}`);
    }
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
 * 默认视图名按界面语言本地化：中文界面首启不再看到英文 Home/Work/Focus。
 * 只在「无持久化视图」的种子路径生效——一经保存即为用户数据，不随语言切换
 * 改名。英文模式直接用 DEFAULT_VIEWS 原名：t() 的英文词典是异步 chunk，
 * 模块初始化期（initialViews = loadViews()）词典未到位会回退中文，而种子名
 * 保存后固化，不能赌词典时序；这里也不走 t() 的另一原因是部分测试以部分
 * 实现 mock settings-store，模块初始化期访问其 state 字段会先于 mock 就绪。
 */
function localizedDefaultViews(): ViewDef[] {
  let isZh = true;
  try {
    isZh = useSettingsStore.getState()?.general?.language !== "English";
  } catch {
    // mock 环境缺 getState：按中文处理（测试都会显式 setState views，不影响）。
  }
  if (!isZh) return DEFAULT_VIEWS;
  const zh: Record<string, string> = { home: "主页", work: "工作", focus: "专注" };
  return DEFAULT_VIEWS.map((v) => ({ ...v, name: zh[v.id] ?? v.name }));
}

/** 视图名长度上限（按 Unicode 码点计）。与 rename.ts 的 LABEL_MAX_CHARS 同值
 *  同语义（UI 弹窗 maxLength / truncateLabel 是第一道闸，这里是对直调与持久
 *  化载荷的硬防线）——不复用其导出：import ./rename 会把 display-name →
 *  registry(.tsx) → app-store → use-covered 整条链拽进本模块的求值图，
 *  以最小 mock 起测的用例（widget-store.hydrate.test）会因缺
 *  currentWindowLabel 导出而在模块求值期崩溃。 */
const VIEW_NAME_MAX_CHARS = 24;

/** 按码点截断视图名（Array.from 逐码点，emoji 代理对不劈半）。 */
function truncateViewName(name: string): string {
  return Array.from(name.trim()).slice(0, VIEW_NAME_MAX_CHARS).join("");
}

/** 视图名去重：与现有视图重名时追加「 2」「 3」…序号（新建/复制共用，
 *  重命名不走这里——用户明确输入的名字被悄悄改写比撞名更糟，由 UI 的
 *  promptViewName 校验）。 */
function uniqueViewName(views: ViewDef[], base: string): string {
  const trimmed = truncateViewName(base);
  if (!views.some((v) => v.name === trimmed)) return trimmed;
  for (let i = 2; i < 1000; i++) {
    const candidate = truncateViewName(`${trimmed} ${i}`);
    if (!views.some((v) => v.name === candidate)) return candidate;
  }
  return trimmed; // 理论不可达：防御性回落
}

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
  return viewsKeyFor(currentScreen);
}
function trashKey(): string {
  return trashKeyFor(currentScreen);
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
  return layoutKeyFor(currentScreen, view);
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
/** 编组布局键：与各视图布局键平行，按屏分区。 */
function groupsKey(view: string): string {
  return groupsKeyFor(currentScreen, view);
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
  /** 当前视图的编组容器；与 instances 同视图持久化。 */
  groups: WidgetGroup[];
  /** 当前管理的屏幕分区 id：桌面层=本窗口 URL screen（不变）；设置窗可切换。 */
  screenId: string;
  editMode: boolean;
  /** The widget currently selected (focused) in edit mode — the only one that
   *  responds to arrow-key nudging / Delete. Transient UI state, never synced. */
  selectedId: string | null;
  /** 多选集合：编辑模式下框选/批量选中的全部小组件 id。
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
  /** 命名布局模板。 */
  templates: LayoutTemplate[];
  /** DOCK（→ 灵动岛 2.0）：本屏的贴边聚合容器配置 v2，按屏持久化。 */
  dock: DockConfig;
  /** 局部更新 dock 配置并立即落盘（岛级开关项；tiles 传入时做合法性过滤 + 去重）。 */
  setDock(patch: Partial<DockConfig>): void;
  /** 加入磁贴：index 省略 = 追加末尾，越界钳到合法区间；同 id 已存在则忽略（幂等）。 */
  addDockTile(tile: DockTile, index?: number): void;
  removeDockTile(id: string): void;
  /** 移动磁贴到目标下标（先移出再插入，toIndex 按移出后的数组钳位）。 */
  moveDockTile(id: string, toIndex: number): void;
  /** 岛级位置（拖动松手一次 commit）：边 / 偏移（钳 0–1）/ 吸附点，非法值忽略。 */
  setDockPlacement(placement: { edge?: DockEdge; offset?: number; snap?: DockSnap }): void;
  /** 逐磁贴配置合并：只对无 instanceId 的磁贴有意义——有实例的写实例 widget-config。 */
  setDockTileConfig(id: string, patch: WidgetConfig): void;
  /** 拖拽瞬态（不落盘）：DROP / REORDER 会话每帧写入；null = 无拖拽。 */
  dockDrag: DockDrag | null;
  setDockDrag(drag: DockDrag): void;
  clearDockDrag(): void;
  /* ---- D 节画布动画辅助（均为瞬态 UI 状态，不持久化） ---- */
  /** 把当前多选（≥2）编成一组。 */
  groupSelected(): void;
  /**
   * 拖 A 放到 B 上合并——目标未编组则以目标矩形建组，
   * 已编组则追加成员；被拖卡片不提交位移。返回组 id 与本次并入的成员
   * （撤销时逐一摘除即回到合并前状态；无效输入返回 null）。
   */
  mergeIntoGroup(draggedIds: string[], target: MergeTarget): { groupId: string; appendedIds: string[] } | null;
  /** 解散编组：成员回到编组前的原位（坐标从未被改写）。返回被解散的组快照
   *  （供撤销 toast 经 restoreGroup 重建；无效输入返回 null）。 */
  disbandGroup(groupId: string): WidgetGroup | null;
  /** 撤销解散：按快照重建同 id 的组并挂回仍存活的成员（≥2 人，不足则 no-op）。 */
  restoreGroup(group: WidgetGroup): void;
  /** 切换组内显示的成员（标签点击）。 */
  switchGroupTab(groupId: string, memberId: string): void;
  /** 从组里摘除一个成员（剩 1 人即解散）；组不存在时 no-op。options.feedback
   *  = false 走静默路径（内部调用方：删除成员 / 拖标签摘出自带反馈，不叠
   *  toast 与回场动画）。 */
  removeGroupMember(groupId: string, memberId: string, options?: { feedback?: boolean }): void;
  /** 标签拖拽重排：memberIds 必须是既有成员的完整重排（多余/缺失 id 拒绝）。 */
  reorderGroupMembers(groupId: string, memberIds: string[]): void;
  /** 更新组几何 / 不透明度 / 组名（编辑模式拖动、缩放提交、配置弹层与重命名
   *  共用）。x/y 提交时钳回视口（与 updateWidget 同口径：至少留 40px 可抓握条）；
   *  name 传 undefined 即恢复默认（键存在时覆盖展开）。 */
  updateGroup(id: string, patch: Partial<Pick<WidgetGroup, "x" | "y" | "w" | "h" | "opacity" | "name">>): void;
  /** 组置顶（标签点击时唤起；已是实例∪组的唯一顶层时 no-op，防高频写放大）。 */
  bringGroupToFront(id: string): void;
  /** 组移到底层（与卡片 sendToBack 同语义：实例∪组取最小 z 再 −1）。 */
  sendGroupToBack(id: string): void;
  /** 删除整组（成员一并进回收站）。 */
  removeGroup(id: string): void;
  /** 组×组合并（拖整组到另一组上）：源组成员全部并入目标组、源组移除；
   *  返回源组快照供撤销 toast（摘回成员 + restoreGroup 重建）。 */
  mergeGroups(sourceId: string, targetId: string): WidgetGroup | null;
  /** 退场中的卡片/编组 id：播 .is-exiting 后由 removeWidgetsAnimated /
   *  removeGroup 真正移除（组 id 与实例 id 同池，互不冲突）。 */
  exitingIds: string[];
  /** 新恢复的卡片/编组 id：画布上播 .fly-in 入场。 */
  enteringIds: string[];
  /** 新增/恢复/复制的卡片/编组 id：落位后播一次 accent 描边脉冲。 */
  pulseIds: string[];
  /** 需要一次性 left/top 过渡的卡片/编组 id（批量对齐 / 视口 resize clamp / 时间线恢复）。 */
  posAnimIds: string[];
  /** V2：时间线纪元——applyTimelineState（undo/redo/快照跳转）每次自增；
   *  退场延迟回调捕获调度时的纪元，到期不一致即放弃变更（撤销赢过在途删除）。 */
  historyEpoch: number;
  /** 动画化删除（#63）：先标记 exitingIds 播 fx 档退场，再真正移入回收站。
   *  V1：groupSnapshot 用于「删除整组」——成员逐个恢复后追加 restoreGroup，
   *  撤销找回编组身份（组名/几何/激活标签），而不是散落一地。 */
  removeWidgetsAnimated(ids: string[], groupSnapshot?: WidgetGroup): void;
  /** 批量删除（组一等公民）：选中集合按 id 池分流——组走 removeGroup（组壳
   *  退场 + 成员进回收站），实例走 removeWidgetsAnimated。 */
  removeSelectionAnimated(): void;
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
  /** V5：复制整组——组壳/成员几何同偏移 GRID，新 id 池，组名与成员自定义名
   *  均不带走（副本回落默认名哲学），成员实例数据深拷贝互不共享。 */
  duplicateGroup(id: string): void;
  removeWidget(id: string): void;
  restoreWidget(id: string): void;
  purgeWidget(id: string): void;
  emptyWidgetTrash(): void;
  updateWidget(id: string, patch: Partial<Omit<WidgetInstance, "id" | "type">>): void;
  bringToFront(id: string): void;
  sendToBack(id: string): void;
  selectWidget(id: string | null): void;
  /** 多选：Ctrl/Shift+点击切换选中。 */
  toggleSelect(id: string): void;
  /** 框选：把 id 数组设为选中集合，最后一个为主单元。 */
  setSelected(ids: string[]): void;
  clearSelection(): void;
  /** 批量移动：把选中的全部小组件按 (dx,dy) 平移（吸附网格 + clamp）。 */
  moveSelectedBy(dx: number, dy: number): void;
  /** 批量删除：把选中的全部小组件移入回收站。 */
  removeSelected(): void;
  /** 批量对齐 / 等距：以主单元（selectedId）为基准对齐，或按包围盒等距分布。 */
  alignSelected(mode: "left" | "center" | "right" | "top" | "middle" | "bottom" | "hspace" | "vspace"): void;
  /** 把多选卡片自动排布成网格/横排/纵列（包围盒内 + 视口 clamp）。 */
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
  /** 新建视图（重名自动加「 2/3…」序号）；返回新视图 id，空名返回 ""。 */
  addView(name: string): string;
  removeView(id: string): void;
  /** 重命名视图；撞其它视图同名时拒绝（静默 no-op，UI 层负责提示）。 */
  renameView(id: string, name: string): void;
  /** 复制视图（同屏克隆）：实例重造 id 并搬数据桶（applyTemplate 同契约），
   *  编组不随行（成员 id 已全部换新）。返回新视图 id；源视图不存在返回 ""。 */
  duplicateView(id: string, name: string): string;
  /** 视图排序：把 moveId 移动到 beforeId 所在位置（视图页拖拽 / 上移下移共用）。 */
  reorderViews(moveId: string, beforeId: string): void;
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
 *
 * 编组容器与卡片共享同一 z 序空间（GroupCard 与 WidgetCard 平铺在同一画布），
 * 极值/重排必须取 instances ∪ groups——只看实例会让重启后 zCounter 低于组 z，
 * 随后的 bringToFront 只抬到与组平级（DOM 序组在后 → 卡片仍被组盖住）。
 */
function syncZCounter(instances: WidgetInstance[], groups: WidgetGroup[] = []) {
  const maxZ = Math.max(
    instances.reduce((m, i) => Math.max(m, i.z), 0),
    groups.reduce((m, g) => Math.max(m, g.z), 0)
  );
  if (maxZ >= zCounter) zCounter = maxZ + 1;
  if (zCounter > MAX_Z) {
    const ranked = [
      ...instances.map((i) => ({ z: i.z, set: (z: number) => (i.z = z) })),
      ...groups.map((g) => ({ z: g.z, set: (z: number) => (g.z = z) }))
    ].sort((a, b) => a.z - b.z);
    ranked.forEach((r, idx) => r.set(idx + 1));
    zCounter = ranked.length + 1;
  }
}

/**
 * Guarantees the module-level counter is strictly above the current max z so
 * the next z produced by `nextZ()` is always the highest. Called before any
 * operation that assigns a fresh z (add, duplicate, bring-to-front) so the
 * counter can never drift below persisted values — the root cause of "clicking
 * a widget doesn't bring it to front". 组与卡片同空间：极值同样取并集。
 */
function ensureCounterAbove(instances: WidgetInstance[], groups: WidgetGroup[] = []) {
  const maxZ = Math.max(
    instances.reduce((m, i) => Math.max(m, i.z), 0),
    groups.reduce((m, g) => Math.max(m, g.z), 0)
  );
  if (zCounter <= maxZ) zCounter = maxZ + 1;
}

/**
 * Compacts z values back to 1..N (preserving order) once they drift past MAX_Z.
 * Called from bringToFront/sendToBack so a long session of stacking operations
 * can't push z unboundedly toward the CSS 2^31-1 ceiling. Returns a new pair;
 * the inputs are not mutated（实例与组一起重排，保持并集内的相对层序）.
 */
function renormalizeZ(
  instances: WidgetInstance[],
  groups: WidgetGroup[]
): {
  instances: WidgetInstance[];
  groups: WidgetGroup[];
} {
  const maxZ = Math.max(
    instances.reduce((m, i) => Math.max(m, i.z), 0),
    groups.reduce((m, g) => Math.max(m, g.z), 0)
  );
  if (maxZ <= MAX_Z) return { instances, groups };
  const order = [
    ...instances.map((i, idx) => ({ z: i.z, kind: "i" as const, idx })),
    ...groups.map((g, idx) => ({ z: g.z, kind: "g" as const, idx }))
  ].sort((a, b) => a.z - b.z);
  const nextInstances = [...instances];
  const nextGroups = [...groups];
  order.forEach(({ kind, idx }, rank) => {
    if (kind === "i") nextInstances[idx] = { ...nextInstances[idx], z: rank + 1 };
    else nextGroups[idx] = { ...nextGroups[idx], z: rank + 1 };
  });
  zCounter = order.length + 1;
  return { instances: nextInstances, groups: nextGroups };
}

/** views 载荷判定——合法视图表（至少一条 {id,name}）。
 *  供 loadViews 两段读取、hydrate 的 viewsHeal 防污染与 viewsAdopt 采纳三处
 *  共用同一套口径。返回 null = 载荷损坏/缺失（调用方决定回退策略）。 */
function parseViewsPayload(raw: string | null): ViewDef[] | null {
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      const list = parsed.filter((v): v is ViewDef => !!v && typeof v.id === "string" && typeof v.name === "string");
      if (list.length > 0) return list;
    }
  } catch {
    // fallthrough：按损坏处理
  }
  return null;
}

export function loadViews(): ViewDef[] {
  try {
    const main = parseViewsPayload(localStorage.getItem(viewsKey()));
    if (main !== null) return main;
    /* 主键损坏/缺失退回 .bak（loadInstances 同款两段判定；views 至少
       一条有效，不存在 loadInstances 那种「合法空表」歧义）。主备俱坏由
       hydrate 的 viewsAdopt 分支读 DB 镜像兜底，此处才回落默认表。 */
    const bakRaw = localStorage.getItem(`${viewsKey()}.bak`);
    const bak = parseViewsPayload(bakRaw);
    if (bak !== null) {
      /* 主键损坏而备份完好：回写主键就地自愈——下一次 saveViews 的轮换会把
         自愈后的内容转存 .bak，DB 镜像由 viewsHeal 随后收敛到好值。 */
      try {
        localStorage.setItem(viewsKey(), bakRaw as string);
      } catch {
        // best-effort
      }
      return bak;
    }
  } catch {
    // ignore
  }
  return localizedDefaultViews();
}

function saveViews(views: ViewDef[]) {
  /* 恢复期间不写 LS/DB（旧视图清单不得盖回刚导入的数据；恢复以
     reload 收尾，跳过的写在恢复后由新内存态接管）。 */
  if (isPersistSuspended()) return;
  const json = JSON.stringify(views);
  try {
    /* 写前 .bak 轮换——views 是 轮换批四键
       （layout/groups/trash/dock）之后唯一没跟上的布局权威键。单键损坏从
       「整屏视图结构静默丢失 + viewsHeal 污染 DB 镜像」退化为「退一步用
       上一份好数据」。 */
    localStorageWriteWithBackup(viewsKey(), json);
  } catch {
    // best-effort
  }
  if (isTauri()) {
    sqliteRepo.setSetting(dbViewsKey(), json).catch(reportPersistError("saveViews"));
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
 * 写前备份轮换：落盘前
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
 * 主键**缺失或解析失败**（非法 JSON / 非数组）时退回 `.bak`；主键是
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

/** 布局保存失败通知：画布层监听该事件，在角落滑入红色提示条。 */
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
  // 防抖快照过期守卫——快照记录后远端包可能已直写并更新
  // 了内存态（applyRemoteWidgets）。此时把旧快照落盘会造成「内存 B / 持久层 A」
  // 分叉，若用户未再编辑即退出，重启回档丢 B。丢弃过期快照，落盘当前内存态。
  const st = useWidgetStore.getState();
  const latest = view === st.activeView && instances !== st.instances ? st.instances : instances;
  // 同一份布局只序列化一次，localStorage 与 SQLite 镜像复用同一字符串，
  // 避免对齐/批量路径对数组做两次全量 JSON.stringify。
  const json = JSON.stringify(latest);
  try {
    // 写前把上一份好数据轮换进 `.bak`（内容变化才写）。
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
  // 布局落盘后对账窗口集（删光/放入首个小组件 → 销毁/重建该屏窗口），
  // 经内容边沿门控（见 scheduleWidgetWindowReconcileOnContentEdge 头注）。
  scheduleWidgetWindowReconcileOnContentEdge(st.dock);
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

/** 读取某视图的编组（元素级校验；缺键/损坏返回空数组）。
 *  与 loadInstances 同口径：主键**缺失或解析失败**时退回 `.bak`；主键是
 *  合法的空数组（用户刚解散全部编组）不算损坏——不用备份顶替，防「解散复活」。 */
export function loadGroups(view: string): WidgetGroup[] {
  const key = groupsKey(view);
  for (const k of [key, `${key}.bak`]) {
    try {
      const raw = localStorage.getItem(k);
      if (raw === null) continue;
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed.filter(isValidGroup);
    } catch {
      // 主键损坏 → 试备份
    }
  }
  return [];
}

/** 编组落盘（300ms 尾沿防抖，与布局同款；镜像进 SQLite 随备份走）。 */
let pendingGroupsSave: { view: string; groups: WidgetGroup[] } | null = null;
let groupsSaveTimer: number | null = null;

function writeGroupsNow(view: string, groups: WidgetGroup[]) {
  if (isPersistSuspended()) return;
  // 同款过期守卫——防抖快照记录后远端包可能已
  // 直写并更新内存态，旧快照落盘会造成「内存新 / 持久层旧」分叉。过期时
  // 落当前内存态，与 writeInstancesNow 口径对齐。
  const st = useWidgetStore.getState();
  const latest = view === st.activeView && groups !== st.groups ? st.groups : groups;
  const json = JSON.stringify(latest);
  try {
    // 同款写前 .bak 轮换（与布局/跨窗路径同一口径——此前三处写组里只有
    // applyRemoteWidgets 用备份轮换，本地保存损坏即全组蒸发）。
    localStorageWriteWithBackup(groupsKey(view), json);
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

/** 退场定时器（≈220ms）到点时用户已 Ctrl+数字切走
 *  视图的定向删除——删除必须作用于「删除发生时组件所在的视图」，与新活动
 *  视图无关。此前回调在（新视图的）内存实例表 find 不到目标 → 静默 return →
 *  旧视图组件「删了又复活」。本函数绕开内存态（内存此时属于新视图，绝不能
 *  碰），直接对捕获视图的持久层操作：loadInstances(view) 过滤后
 *  writeInstancesNow(view,…) 立即落盘（跨视图恢复的立即写同口径；切视图
 *  时 setActiveView 已把含退场中组件的旧视图布局冲刷进 LS，此处读到的是
 *  权威现状）。trash 凭证在两个分支里等价：内存路径由 removeWidget 在到期时
 *  写入（view=当前活动视图=捕获视图），本函数统一在此写入（view=捕获视图，
 *  恢复时经 路径回到原视图）。成员被删时同步在 loadGroups(view) 上摘除
 *  成员关系（剩 <2 人整组解散、幸存者解绑——removeGroupMember 同语义，
 *  作用域换成目标视图）。 */
function removeInstancesInViewNow(view: string, ids: string[]): void {
  const idSet = new Set(ids);
  const current = loadInstances(view);
  const removed = current.filter((i) => idSet.has(i.id));
  if (!removed.length) return;
  let instances = current.filter((i) => !idSet.has(i.id));
  const hitGroups = new Set(removed.filter((i) => i.groupId).map((i) => i.groupId as string));
  if (hitGroups.size) {
    const freed: string[] = [];
    const groups = loadGroups(view)
      .filter((g) => {
        if (!hitGroups.has(g.id)) return true;
        const rest = g.memberIds.filter((m) => !idSet.has(m));
        if (rest.length >= 2) return true; // 仍 ≥2 人：保留，成员表在下方回写。
        if (rest.length === 1) freed.push(rest[0]); // 剩 1 人：整组解散，幸存者解绑。
        return false;
      })
      .map((g) => (hitGroups.has(g.id) ? { ...g, memberIds: g.memberIds.filter((m) => !idSet.has(m)) } : g));
    if (freed.length) {
      const freedSet = new Set(freed);
      instances = instances.map((i) => (freedSet.has(i.id) ? { ...i, groupId: undefined } : i));
    }
    writeGroupsNow(view, groups);
  }
  writeInstancesNow(view, instances);
  const entries: TrashWidget[] = removed.map((inst) => ({
    ...stripGroupId([inst])[0],
    view,
    deletedAt: new Date().toISOString()
  }));
  const nextTrash = purgeExpiredTrash([...entries, ...useWidgetStore.getState().trash]);
  useWidgetStore.setState({ trash: nextTrash });
  saveTrash(nextTrash);
  // 删除的实例可能绑定岛上磁贴：与 removeWidget 的收尾对账同口径。
  reconcileDockTiles();
}

// 页面卸载/退出前强制落盘，避免防抖窗口内的最后几次编辑被浏览器关闭丢弃。
if (typeof window !== "undefined") {
  window.addEventListener("pagehide", flushWidgetLayoutSync);
  window.addEventListener("beforeunload", flushWidgetLayoutSync);
}

/* ── 设置导出/导入：跨屏布局快照（GeneralPage「导出/导入设置」专用） ──
   此前的导出只带当前管理屏的实例表（无编组），导入又借 importLayout 逐视图
   写回——saveInstances/saveGroups 是单槽防抖，多视图循环里后者顶掉前者，只
   有最后一个视图真正落盘；且 importLayout 内 sanitizeGroups 拿「上一个活动
   视图」的内存组污染导入视图，编组全灭。这里改为整屏快照：立即落盘（绕开
   防抖）+ SQLite 镜像 + 逐视图 sync:widgets 广播（接收端 applyRemoteWidgets
   自带屏号过滤与落盘对账），编组随实例同进同出。 */

/** 屏幕分区的持久化键（导入/导出需直取任意分区，绕过 currentScreen）。 */
function viewsKeyFor(screen: string): string {
  return `focus-desk.screen.${screen}.widgets.views.v1`;
}
function trashKeyFor(screen: string): string {
  return `focus-desk.screen.${screen}.widgets.trash.v1`;
}
function layoutKeyFor(screen: string, view: string): string {
  return `focus-desk.screen.${screen}.widgets.${view}.v1`;
}
function groupsKeyFor(screen: string, view: string): string {
  return `focus-desk.screen.${screen}.groups.${view}.v1`;
}

/** 读某键的主值或 .bak 备份：只要能解析出数组就返回（元素级校验交给导入侧）。 */
function readScreenArray(key: string): unknown[] | null {
  for (const k of [key, `${key}.bak`]) {
    try {
      const raw = localStorage.getItem(k);
      if (raw === null) continue;
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      // 主键损坏 → 试备份
    }
  }
  return null;
}

function isViewDefLike(v: unknown): v is ViewDef {
  return (
    !!v &&
    typeof v === "object" &&
    typeof (v as Record<string, unknown>).id === "string" &&
    typeof (v as Record<string, unknown>).name === "string"
  );
}

/** 单个屏幕分区的布局快照（设置导出载荷的 `screens[<id>]`）。 */
export type ScreenLayoutSnapshot = {
  views: ViewDef[];
  layouts: Record<string, unknown[]>;
  groups: Record<string, unknown[]>;
};

/**
 * 导出全部屏幕分区（含当前屏与无显示器在线的历史屏）的视图表 / 布局 / 编组。
 * 视图表读不出来的屏整屏跳过：宁可少备一个屏，也不能导出空视图表——恢复端
 * 会把空表当真，把该屏视图清光。
 */
export function exportScreenLayoutSnapshots(): Record<string, ScreenLayoutSnapshot> {
  const screens = new Set<string>([currentScreen]);
  const keyRe = /^focus-desk\.screen\.(\d+)\./;
  for (let i = 0; i < localStorage.length; i++) {
    const m = (localStorage.key(i) ?? "").match(keyRe);
    if (m) screens.add(m[1]);
  }
  const out: Record<string, ScreenLayoutSnapshot> = {};
  for (const sid of screens) {
    const viewsRaw = readScreenArray(viewsKeyFor(sid));
    if (viewsRaw === null) continue;
    const views = viewsRaw.filter(isViewDefLike);
    const layouts: Record<string, unknown[]> = {};
    const groups: Record<string, unknown[]> = {};
    for (const v of views) {
      const inst = readScreenArray(layoutKeyFor(sid, v.id));
      if (inst !== null) layouts[v.id] = inst;
      const gr = readScreenArray(groupsKeyFor(sid, v.id));
      if (gr !== null) groups[v.id] = gr;
    }
    out[sid] = { views, layouts, groups };
  }
  return out;
}

/**
 * 整屏写入视图表 / 布局 / 编组（设置导入专用）：元素级校验 + 立即落盘
 * （localStorage 写前备份轮换 + SQLite 镜像，绕开单槽防抖）+ 逐视图
 * sync:widgets 广播，让该屏在线的桌面窗口即时应用。回收站不在设置导出
 * 范围内：载荷原样带回该屏现有数据。视图表缺失/损坏 → 整屏拒绝（返回
 * false），不做半吊子覆盖。
 */
export function importScreenLayoutSnapshot(
  screenId: string,
  snap: { views?: unknown; layouts?: unknown; groups?: unknown }
): boolean {
  if (!Array.isArray(snap.views)) return false;
  const views = (snap.views as unknown[]).filter(isViewDefLike);
  if (views.length === 0) return false;
  const layouts = (snap.layouts ?? {}) as Record<string, unknown>;
  const groups = (snap.groups ?? {}) as Record<string, unknown>;
  const trash: TrashWidget[] =
    screenId === currentScreen
      ? useWidgetStore.getState().trash
      : ((readScreenArray(trashKeyFor(screenId)) ?? []) as TrashWidget[]);
  /* 整表写是并发未挂闸门的低概率漏点——恢复备份
     进行中（口径），迟到的导入写不得把恢复前的旧布局/视图表盖回共享
     LS 与 SQLite 镜像；下方的 sync:widgets 广播与内存 setState 照常（内存态
     短暂跟进无害，恢复以 reload 收尾）。 */
  const persistAllowed = !isPersistSuspended();
  if (persistAllowed) {
    try {
      localStorageWriteWithBackup(viewsKeyFor(screenId), JSON.stringify(views));
    } catch {
      notifySaveFailure();
    }
  }
  for (const v of views) {
    const rawList = Array.isArray(layouts[v.id]) ? (layouts[v.id] as unknown[]) : [];
    // isLiveInstance 与读取路径同口径（含几何/z 的有限性校验）：导入侧不
    // 复活读取侧会丢弃的损坏条目。
    const instances = sanitizeInstances(rawList.filter(isLiveInstance));
    const rawGroups = Array.isArray(groups[v.id]) ? (groups[v.id] as unknown[]).filter(isValidGroup) : [];
    const pair = sanitizeGroups(rawGroups, instances);
    const layoutJson = JSON.stringify(pair.instances);
    const groupsJson = JSON.stringify(pair.groups);
    if (persistAllowed) {
      try {
        localStorageWriteWithBackup(layoutKeyFor(screenId, v.id), layoutJson);
        localStorageWriteWithBackup(groupsKeyFor(screenId, v.id), groupsJson);
      } catch {
        notifySaveFailure();
      }
      if (isTauri()) {
        sqliteRepo
          .setSetting(`widget:layout:${screenId}:${v.id}`, layoutJson)
          .catch(reportPersistError("importLayout"));
        sqliteRepo
          .setSetting(`widget:groups:${screenId}:${v.id}`, groupsJson)
          .catch(reportPersistError("importGroups"));
      }
    }
    const payload: WidgetSyncPayload = {
      screenId,
      activeView: v.id,
      instances: pair.instances,
      groups: pair.groups,
      views,
      trash
    };
    /* 静默 catch 改上报——导入的布局广播丢失时
       在线窗口要等重启才应用，留 console.error 证据（保持不中断语义）。 */
    void import("@tauri-apps/api/event")
      .then(({ emit }) => emit("sync:widgets", payload))
      .catch((err: unknown) => console.error("[widgets] import layout broadcast failed", err));
  }
  if (isTauri() && persistAllowed) {
    sqliteRepo.setSetting(`widget:views:${screenId}`, JSON.stringify(views)).catch(reportPersistError("importViews"));
  }
  // 本窗管理的屏：同步刷新内存（活动视图若在被导入之列，重读刚落盘的数据），
  // 并把 z 计数器抬到导入后极值之上，避免新组件被压底。
  if (screenId === currentScreen) {
    const st = useWidgetStore.getState();
    const active = st.activeView;
    if (views.some((v) => v.id === active)) {
      const loaded = loadInstances(active);
      const pair = sanitizeGroups(loadGroups(active), loaded);
      useWidgetStore.setState({ views, instances: pair.instances, groups: pair.groups });
      syncZCounter(pair.instances, pair.groups);
    } else {
      useWidgetStore.setState({ views });
      syncZCounter(st.instances, st.groups);
    }
  }
  return true;
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
  /* 恢复期间不写 LS/DB（同 saveViews 口径）。 */
  if (isPersistSuspended()) return;
  try {
    localStorage.setItem(trashKey(), JSON.stringify(trash));
  } catch {
    // best-effort
  }
  if (isTauri()) {
    sqliteRepo.setSetting(dbTrashKey(), JSON.stringify(trash)).catch(reportPersistError("saveTrash"));
  }
}

/** 读取命名布局模板。校验失败或无记录时返回空数组。 */
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
  /* 入口整体挂闸（saveViews 同款 early-return）——
     此前 persistMirrored 内部虽挡了 LS 半边，其后的 sqliteRepo.setSetting
     仍会把恢复前的旧模板写回镜像库（恢复以 reload 收尾，跳过的写由恢复后
     的新内存态接管）。 */
  if (isPersistSuspended()) return;
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

/** dock 载荷的「结构性损坏」判定：JSON 解析失败，或 version≥2 但 tiles 非数组
 *  （v1 的 tiles 存在且非数组同理）——这类载荷经 parseDockConfig 会**静默回默认
 *  三磁贴**并固化为权威值，必须在 loadDock 里走 .bak / DB 镜像回退而不是放行。 */
function dockRawCorrupt(raw: string | null): boolean {
  if (!raw) return false;
  try {
    const o: unknown = JSON.parse(raw);
    if (!o || typeof o !== "object" || Array.isArray(o)) return true;
    const rec = o as Record<string, unknown>;
    if (rec.version !== undefined && rec.version !== 2 && typeof rec.version !== "number") return true;
    if (rec.tiles !== undefined && !Array.isArray(rec.tiles)) return true;
    return false;
  } catch {
    return true;
  }
}

/**
 * 读取当前屏的 dock 配置（localStorage 权威；缺键/损坏回落默认）。
 * v1 载荷在此迁移并立即回写 v2：迁移生成的磁贴 uuid 首次启动即固定，
 * 不会每次启动重生成（展开 id / 逐磁贴配置都以 tile.id 为键）。
 * 主键结构性损坏时先试 `<key>.bak`（两段判定的读取侧，布局同款）；
 * .bak 也坏则删掉主键让 hydrate 的 SQLite 镜像分支有机会采纳——而不是
 * parseDockConfig 静默回默认磁贴把用户配置固化丢失。
 */
function loadDock(): DockConfig {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(dockKey());
  } catch {
    return parseDockConfig(null);
  }
  if (dockRawCorrupt(raw)) {
    let bak: string | null = null;
    try {
      bak = localStorage.getItem(`${dockKey()}.bak`);
    } catch {
      // ignore
    }
    if (bak && !dockRawCorrupt(bak)) {
      const cfg = parseDockConfig(bak);
      saveDock(cfg);
      return cfg;
    }
    try {
      localStorage.removeItem(dockKey());
    } catch {
      // ignore
    }
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

/* ---- ：窗口对账边沿门控 ----
   reconcile_widget_windows 的语义只关心「该屏有无内容」的翻转——加首枚 / 删
   末枚磁贴或小组件才需要建 / 销该屏窗口。此前每次布局 / dock 落盘（拖动小组件
   的 300ms 防抖尾沿、设置页滑条提交）都排一次对账，Rust 主线程每次要跑一轮
   显示器枚举 + 槽位表读库 + 逐屏内容查询。这里维护与 Rust screen_has_content
   同口径的「本屏有内容」快照，仅边沿翻转（或快照未知）时才 schedule；两次
   落盘之间经旁路（如 removeView 直删布局键）改动内容的极端情况，由下一次
   落盘时的全量快照比对自愈，removeView 自身也走本门控。 */
let screenHadContent: boolean | null = null;

/** 与 monitor.rs screen_has_content 同口径：dock（enabled 且有磁贴）或任一视图
 *  布局非空即有内容。读 localStorage 权威源（落盘顺序先 LS 后镜像，判定不会
 *  早于本窗写入）；pendingSave 的在途布局优先于磁盘上的陈旧副本
 *  （dockInstanceExists 同款口径）。读失败宁可误判有内容——多对账一次无害，
 *  误销毁正在使用的桌面层窗口才是事故。 */
function screenHasContentNow(cfg: DockConfig): boolean {
  if (cfg.enabled && cfg.tiles.length > 0) return true;
  try {
    return loadViews().some((v) => {
      const list = pendingSave?.view === v.id ? pendingSave.instances : loadInstances(v.id);
      return list.length > 0;
    });
  } catch {
    return true;
  }
}

/** 内容快照与缓存比对：翻转（或首跑）才排一次对账，并把缓存推进到本次快照。 */
function scheduleWidgetWindowReconcileOnContentEdge(cfg: DockConfig): void {
  const has = screenHasContentNow(cfg);
  if (screenHadContent === has) return;
  screenHadContent = has;
  scheduleWidgetWindowReconcile();
}

/** 持久化 dock 配置：localStorage 权威 + SQLite `widget:dock:<N>` 镜像（随备份恢复）。 */
function saveDock(cfg: DockConfig) {
  /* B-恢复 ack 协议闸门——恢复备份进行中（pause→导入→resume），布局 /
     编组 / settings / lsmirror 全部停写，dock 不能把恢复前的旧配置写回
     LS+镜像覆盖刚导入的数据（与 writeInstancesNow 同口径）。 */
  if (isPersistSuspended()) return;
  const json = JSON.stringify(cfg);
  try {
    localStorageWriteWithBackup(dockKey(), json);
  } catch {
    notifySaveFailure();
  }
  if (isTauri()) {
    sqliteRepo.setSetting(dbDockKey(), json).catch(reportPersistError("saveDock"));
    // dock 落盘后对账窗口集——经内容边沿门控（加首枚/删末枚磁贴、开关岛
    // 改变「该屏有无内容」时才触发，见 scheduleWidgetWindowReconcileOnContentEdge）。
    scheduleWidgetWindowReconcileOnContentEdge(cfg);
  }
}

/* ---- ：实例数据的跨屏引用防线 ----
   copyScreenLayout 保留实例 id（两屏共用同一数据桶，「同一块便签放两块屏」
   是该特性的预期语义）。此前的销毁点（删视图 / 彻底删除 / 清空回收站 /
   逾期自动清除）一律无条件 removeInstanceData——在任意一屏触发都会把其它屏
   仍在使用的数据桶连根拔掉（便签/书签/日历/涂鸦/图库 + 磁盘副本立即丢失）。
   销毁前先扫所有屏的布局键：仍被任何布局引用的 id 只删几何条目、数据保留；
   没有任何引用才真正销毁。回收站条目不算引用（恢复后内容为空属可接受降级，
   跨屏活动引用才是要防的立即丢失）。 */

/** 扫描 localStorage 中所有屏的布局键，判断实例 id 是否仍被引用。
    excludeLayoutKeys 跳过指定键（调用方正要删除的那份布局）。
    扫描本身失败（存储不可用）时宁可误报「有引用」——多留一份数据无害，
    误销毁正在使用的数据才是事故。布局键形如
    `focus-desk.screen.<N>.widgets.<viewId>.v1`（viewId 为 uuid，不含点），
    views/view/trash 是同前缀的视图清单/活动视图/回收站键（值同样是「带 id
    的对象数组」，不排除会误判成引用）。 */
function isInstanceLiveInAnyLayout(id: string, excludeLayoutKeys?: ReadonlySet<string>): boolean {
  const layoutRe = /^focus-desk\.screen\.\d+\.widgets\.([^.]+)\.v1$/;
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key) continue;
      const m = key.match(layoutRe);
      if (!m || m[1] === "views" || m[1] === "view" || m[1] === "trash") continue;
      if (excludeLayoutKeys?.has(key)) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(localStorage.getItem(key) ?? "");
      } catch {
        continue;
      }
      if (
        Array.isArray(parsed) &&
        parsed.some((x) => !!x && typeof x === "object" && (x as { id?: unknown }).id === id)
      ) {
        return true;
      }
    }
  } catch {
    return true;
  }
  return false;
}

/** 无跨屏引用时才真正销毁实例数据（purge / 逾期清除 / 删视图旁路共用）。 */
function destroyInstanceDataIfUnreferenced(id: string): void {
  if (isInstanceLiveInAnyLayout(id)) return;
  removeInstanceData(id);
}

/**
 * Drops recycle-bin entries older than the retention window (天数可配，
 * 缺省读全局设置 extra.recycleRetentionDays，7–90 天，默认 30 天)。
 */
export function purgeExpiredTrash(trash: TrashWidget[], days?: number): TrashWidget[] {
  const d =
    typeof days === "number" && Number.isFinite(days) && days > 0
      ? days
      : useSettingsStore.getState().extra.recycleRetentionDays || TRASH_RETENTION_DAYS;
  const cutoff = Date.now() - d * 24 * 60 * 60 * 1000;
  return trash.filter((t) => {
    const ts = new Date(t.deletedAt).getTime();
    const keep = Number.isFinite(ts) && ts >= cutoff;
    // 逾期自动清除同样清理实例数据（数据桶 + gallery 磁盘副本）——只删
    // 几何条目会让数据永久滞留，30 天保留期对数据形同虚设。
    // 跨屏引用防线：该 id 若仍活在其它屏的布局里（复制布局保留 id），
    // 数据保留，只让本屏回收站条目过期消失。
    if (!keep && Number.isFinite(ts)) destroyInstanceDataIfUnreferenced(t.id);
    return keep;
  });
}

/**
 * Loads a view's layout. ：localStorage 是权威源——
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

/**
 * 编组的 DB 合并（loadInstancesFromDb 的 同型）：localStorage 权威——主键
 * 或 `.bak` 任一可解析（含刻意清空的 `[]`，与 loadGroups 同序回退）即以它为
 * 准，镜像落后就回写自愈；仅两者都缺/坏才采纳 DB 副本并回填镜像。此前
 * hydrate 只给实例走 DB 兜底，组键一坏全部编组静默解散，DB 好镜像在旁不用。
 */
async function loadGroupsFromDb(view: string): Promise<WidgetGroup[]> {
  const local = loadGroups(view);
  if (!isTauri()) return local;
  let lsRaw: string | null = null;
  const key = groupsKey(view);
  try {
    for (const k of [key, `${key}.bak`]) {
      const raw = localStorage.getItem(k);
      if (raw !== null && Array.isArray(JSON.parse(raw))) {
        lsRaw = raw;
        break;
      }
    }
  } catch {
    // 缺键/损坏按「不可用」处理，走下方 DB 补缺路径
  }
  let dbRaw: string | null = null;
  try {
    dbRaw = await sqliteRepo.getSetting(dbGroupsKey(view));
  } catch {
    return local; // 镜像读失败：localStorage 权威，保持现状不回退陈旧副本
  }
  if (lsRaw !== null) {
    // 权威在 localStorage：仅当镜像确实落后时才回写自愈（空组不主动清镜像，
    // 与 loadInstancesFromDb 同款 length 守卫——下一次真实保存自然对齐）。
    if (lsRaw !== dbRaw && local.length > 0) {
      sqliteRepo
        .setSetting(dbGroupsKey(view), lsRaw)
        .catch((err) => console.warn("[widgets] self-heal mirror write failed:", dbGroupsKey(view), err));
    }
    return local;
  }
  if (!dbRaw) return local;
  try {
    const parsed = JSON.parse(dbRaw);
    if (!Array.isArray(parsed)) return local;
    const groups = parsed.filter(isValidGroup);
    try {
      localStorage.setItem(key, JSON.stringify(groups));
    } catch {
      // best-effort
    }
    return groups;
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
    historyEpoch: 0,

    setDock: (patch) => {
      const cur = get().dock;
      const next: DockConfig = { ...cur, ...patch, version: 2 };
      /* mouse/takeover/panel 三个子对象做**叶子合并**而非整包替换——
         两窗口并发编辑不同子字段（如设置窗改接管开关 vs 桌面层改鼠标动作）
         时，调用方渲染闭包里的旧子对象不再把对端刚改的字段回滚
         （sync:dock 整包 LWW 的主要伤害面）。tiles/scalar 维持原语义。 */
      if (patch.mouse) next.mouse = { ...cur.mouse, ...patch.mouse };
      if (patch.takeover) next.takeover = { ...cur.takeover, ...patch.takeover };
      if (patch.panel) next.panel = { ...cur.panel, ...patch.panel };
      if (patch.tiles) next.tiles = sanitizeDockTiles(patch.tiles);
      /* setDock 是最后一个未过校验的入盘口（offset:7 / density:99 /
         durationMs:999 一类非法值此前可直接入盘）——与解析侧同口径洗白，
         两条路径永不漂移（复用 parse 系列的钳制 / 枚举守卫）。 */
      next.enabled = typeof next.enabled === "boolean" ? next.enabled : DOCK_DEFAULTS.enabled;
      next.edge = isDockEdge(next.edge) ? next.edge : DOCK_DEFAULTS.edge;
      next.offset = clampOffset(next.offset, DOCK_DEFAULTS.offset);
      next.snap = isDockSnap(next.snap) ? next.snap : DOCK_DEFAULTS.snap;
      next.style = pickEnum(next.style, ["pill", "bangs"] as const, DOCK_DEFAULTS.style);
      next.mouse = parseDockMouse(next.mouse);
      next.takeover = parseDockTakeover(next.takeover);
      next.autoHide = parseDockAutoHide(next.autoHide);
      next.panel = { mode: pickEnum(next.panel.mode, ["carousel", "grid"] as const, DOCK_DEFAULTS.panel.mode) };
      next.density =
        next.density === 36 || next.density === 48 ? next.density : next.density === 42 ? 42 : DOCK_DEFAULTS.density;
      next.topInset = clampInt(next.topInset, 0, DOCK_TOP_INSET_MAX, DOCK_DEFAULTS.topInset);
      next.viewArrows = typeof next.viewArrows === "boolean" ? next.viewArrows : DOCK_DEFAULTS.viewArrows;
      set({ dock: next });
      saveDock(next);
    },

    addDockTile: (tile, index) => {
      if (!isDockTileObject(tile)) return;
      /* retired 类型在此挡下——isDockTileObject 不查 RETIRED_TYPES，
         sanitizeDockTiles 会把它滤掉，`[copy]` 解构空数组得 undefined 直插
         tiles（内存渲染崩溃的潜伏路径；守卫口径与 sanitize 对齐）。 */
      if (RETIRED_TYPES.has(tile.type)) return;
      const cur = get().dock.tiles;
      if (cur.some((t) => t.id === tile.id)) return;
      // 入岛去重（findDockTileConflict）：同实例 / 同类型无实例磁贴已在岛上则忽略。
      if (findDockTileConflict(cur, tile)) return;
      const at = index === undefined ? cur.length : Math.min(cur.length, Math.max(0, Math.floor(index)));
      const [copy] = sanitizeDockTiles([tile]);
      if (!copy) return;
      const next: DockConfig = { ...get().dock, tiles: [...cur.slice(0, at), copy, ...cur.slice(at)] };
      set({ dock: next });
      saveDock(next);
    },

    removeDockTile: (id) => {
      const cur = get().dock.tiles;
      const gone = cur.find((t) => t.id === id);
      if (!gone) return;
      const next: DockConfig = { ...get().dock, tiles: cur.filter((t) => t.id !== id) };
      set({ dock: next });
      saveDock(next);
      /* 无实例磁贴的合成配置键（focus-desk.widget-config.dock-tile-<id>.v1
         及其数据桶）改为**延迟清理**——「已从灵动岛移除 · 撤销」的 undo 只回插
         tile，组件此前写进合成键的用户数据（课程表 data/profiles、便签、图库
         ——磁盘副本被 evict 后不可恢复）会随同步清理永久丢失。有撤销 toast 的
         调用方（DockTiles.removeWithUndo / DockTile 右键）挂 onDismiss 提前
         finalize、undo run 先 cancel；其余调用方走兜底延迟。绑定实例的数据
         属于实例自身生命周期，不在此清。 */
      if (!gone.instanceId) scheduleDockTileDataRemoval(gone);
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
      const instances = applyMemberPatches(st.instances, built.members);
      ensureCounterAbove(instances, st.groups);
      set({ instances, groups: [...st.groups, built.group], selectedId: null, selectedIds: [] });
      saveInstances(st.activeView, instances);
      saveGroups(st.activeView, get().groups);
      /* 新组容器入场（卡片新建同款 fly-in + 脉冲）。 */
      markEntering([built.group.id]);
      /* 创建反馈闭环：合并/解散/删除都有 toast + 撤销，编组本身此前没有
         ——一键编组 ↔ 一键撤销（disbandGroup 成员原位还原，快照可再撤销）。 */
      pushAppToast(t("已编组"), "", "info", {
        action: {
          label: t("撤销"),
          run: () => useWidgetStore.getState().disbandGroup(built.group.id)
        }
      });
    },

    mergeIntoGroup: (draggedIds, target) => {
      const st = get();
      if (draggedIds.includes(target.id)) return null;
      const dragged = st.instances.filter((i) => draggedIds.includes(i.id) && !i.groupId);
      if (!dragged.length) return null;
      const appendedIds = dragged.map((d) => d.id);
      /* 目标已是编组 → 并入。kind=widget 目标按 findMergeTargetAt 的口径恒为
         未编组卡片（编组成员不渲染、存储坐标不代表视觉位置，命中测试早已
         skip）——下方对其 groupId 的解析只是对本 API 其它调用方的防御，
         画布拖拽路径走不到。 */
      const groupIdOfTarget =
        target.kind === "group" ? target.id : (st.instances.find((i) => i.id === target.id)?.groupId ?? null);
      if (groupIdOfTarget) {
        const group = st.groups.find((g) => g.id === groupIdOfTarget);
        if (!group) return null;
        const appended = new Set(appendedIds);
        const groups = st.groups.map((g) =>
          g.id === group.id ? { ...g, memberIds: [...g.memberIds, ...appendedIds], activeId: appendedIds[0] } : g
        );
        const instances = st.instances.map((i) => (appended.has(i.id) ? { ...i, groupId: group.id } : i));
        set({ instances, groups, selectedId: null, selectedIds: [] });
        saveInstances(st.activeView, instances);
        saveGroups(st.activeView, groups);
        /* 并入反馈：既有组壳播一次 accent 脉冲（新成员在组内、不单独入场）。
           activeId 切到被拖成员（拖入即所见）：并入前组壳显示的还是旧标签，
           用户刚拖进来的卡若不亮出来，视觉上等于「消失」进组里。 */
        markPulse([group.id]);
        return { groupId: group.id, appendedIds };
      }
      const anchor = st.instances.find((i) => i.id === target.id);
      if (!anchor) return null;
      const built = buildGroupFromAnchor(anchor, dragged, uid, nextZ);
      if (!built) return null;
      /* 同 ：拖 A 放到 B 上建组时亮 A（被拖者），不是 B（落点锚）——与并入
         分支同一「拖入即所见」语义。 */
      const group: WidgetGroup = { ...built.group, activeId: dragged[0].id };
      const instances = applyMemberPatches(st.instances, built.members);
      ensureCounterAbove(instances, st.groups);
      set({ instances, groups: [...st.groups, group], selectedId: null, selectedIds: [] });
      saveInstances(st.activeView, instances);
      saveGroups(st.activeView, get().groups);
      markEntering([group.id]);
      return { groupId: group.id, appendedIds };
    },

    disbandGroup: (groupId) => {
      const st = get();
      const group = st.groups.find((g) => g.id === groupId);
      if (!group) return null;
      /* 重复触发（退场窗口内连点）只保留首个。 */
      if (st.exitingIds.includes(groupId)) return null;
      /* 源组壳先播 .is-exiting 快速淡出（fx-fast 档）再卸载，成员
         fly-in 随后错峰回场——此前壳是瞬消（对比 removeGroup 有退场）。
         快照同步返回，撤销 toast 即刻可用；淡出窗口（≈150ms）内的撤销
         会因组仍在而 no-op、随后仍被卸载——窗口远小于人类点 toast 的
         反应时，接受（removeGroup 的两级串联同款时序语义）。 */
      set({ exitingIds: [...st.exitingIds, groupId] });
      /* 闭包捕获解散发生时的视图——淡出窗口
         （≈170ms）内用户 Ctrl+数字切走后，下方回调在内存里 find 的已是
         新视图的组表，旧组「解散了又复活」。到期时视图不符则对捕获视图的
         持久层定向生效（loadGroups/loadInstances 过滤后 writeGroupsNow/
         writeInstancesNow 立即落盘）；markEntering 是屏上回场动画，切走后
         成员不在当前视图渲染，定向分支不播。 */
      const viewAtDisband = st.activeView;
      /* V2：捕获调度纪元——窗口内 undo/redo 已把旧状态套回来时，本次解散
         放弃（撤销赢过在途变更），只清自己的退场标记与选中残留。 */
      const epochAtDisband = st.historyEpoch;
      window.setTimeout(() => {
        const cur = get();
        /* 解散即摘选中（对齐 removeWidgetsAnimated 的到期清理）——
           selectedId 残留死 id 让选中语义变脏。 */
        set({
          exitingIds: cur.exitingIds.filter((x) => x !== groupId),
          selectedIds: cur.selectedIds.filter((x) => x !== groupId),
          selectedId: cur.selectedId === groupId ? null : cur.selectedId
        });
        if (get().historyEpoch !== epochAtDisband) return;
        if (get().activeView !== viewAtDisband) {
          const persisted = loadGroups(viewAtDisband);
          if (!persisted.some((x) => x.id === groupId)) return;
          writeGroupsNow(
            viewAtDisband,
            persisted.filter((x) => x.id !== groupId)
          );
          writeInstancesNow(
            viewAtDisband,
            loadInstances(viewAtDisband).map((i) => (i.groupId === groupId ? { ...i, groupId: undefined } : i))
          );
          markGroupTombstone(groupId);
          return;
        }
        const g = cur.groups.find((x) => x.id === groupId);
        if (!g) return;
        const instances = cur.instances.map((i) => (i.groupId === groupId ? { ...i, groupId: undefined } : i));
        set({ instances, groups: cur.groups.filter((x) => x.id !== groupId) });
        saveInstances(cur.activeView, instances);
        saveGroups(cur.activeView, get().groups);
        markGroupTombstone(groupId);
        /* 解散可见化：成员回到原位时按卡片入场语言错落回场（fly-in + 脉冲），
           此前成员是原地瞬现。组快照原样返回（含几何/层级/激活标签/组名）供撤销重建。 */
        markEntering([...g.memberIds]);
      }, animDurations().fxFastMs + 20);
      return group;
    },

    restoreGroup: (group) => {
      const st = get();
      if (st.groups.some((g) => g.id === group.id)) return;
      /* 撤销重建即解除墓碑——此后对端携带该组的包恢复正常采纳。 */
      deletedGroupTombstones.delete(group.id);
      const ids = new Set(group.memberIds);
      /* 只回收仍自由的成员：解散后被编入其它组的成员不抢回——直接改写其
         groupId 会让旧组的 memberIds 残留幽灵条目（渲染层按 groupId 过滤
         后不可见，却随持久化长期留存，sanitize 也不清洗跨组重复）。 */
      const alive = st.instances.filter((i) => ids.has(i.id) && !i.groupId);
      if (alive.length < 2) return;
      ensureCounterAbove(st.instances, st.groups);
      const rebuilt: WidgetGroup = { ...group, memberIds: alive.map((m) => m.id), z: nextZ() };
      const revived = new Set(rebuilt.memberIds);
      const instances = st.instances.map((i) => (revived.has(i.id) ? { ...i, groupId: group.id } : i));
      set({ instances, groups: [...st.groups, rebuilt] });
      saveInstances(st.activeView, instances);
      saveGroups(st.activeView, get().groups);
      markEntering([rebuilt.id]);
    },

    switchGroupTab: (groupId, memberId) => {
      const st = get();
      const group = st.groups.find((g) => g.id === groupId);
      if (!group || !group.memberIds.includes(memberId) || group.activeId === memberId) return;
      const groups = st.groups.map((g) => (g.id === groupId ? { ...g, activeId: memberId } : g));
      set({ groups });
      saveGroups(st.activeView, groups);
    },

    reorderGroupMembers: (groupId, memberIds) => {
      const st = get();
      const group = st.groups.find((g) => g.id === groupId);
      if (!group) return;
      // 只接受既有成员的完整重排：长度一致且无未知 id（拖拽会话期间的过期
      // 提交——成员被另一窗口摘除等——直接丢弃）。
      if (memberIds.length !== group.memberIds.length) return;
      const known = new Set(group.memberIds);
      if (!memberIds.every((id) => known.has(id))) return;
      if (memberIds.every((id, i) => id === group.memberIds[i])) return;
      const groups = st.groups.map((g) =>
        g.id === groupId ? { ...g, memberIds, activeId: memberIds.includes(g.activeId) ? g.activeId : memberIds[0] } : g
      );
      set({ groups });
      saveGroups(st.activeView, groups);
    },

    removeGroupMember: (groupId, memberId, options) => {
      const st = get();
      const group = st.groups.find((g) => g.id === groupId);
      if (!group || !group.memberIds.includes(memberId)) return;
      const feedback = options?.feedback !== false;
      const remaining = group.memberIds.filter((x) => x !== memberId);
      const instances = st.instances.map((i) => (i.id === memberId ? { ...i, groupId: undefined } : i));
      if (remaining.length < 2) {
        // 只剩一人：整组解散（最后一个成员也原位恢复）。
        const finalInstances = instances.map((i) => (i.groupId === groupId ? { ...i, groupId: undefined } : i));
        set({ instances: finalInstances, groups: st.groups.filter((g) => g.id !== groupId) });
        saveInstances(st.activeView, finalInstances);
        saveGroups(st.activeView, get().groups);
        /* 反馈对齐：菜单/面板摘成员与显式解散同语言（成员 fly-in 回场 +
           撤销 toast）；内部路径（删除成员 / 撤销合并）经 feedback=false 静默。 */
        if (feedback) {
          markEntering([...group.memberIds]);
          pushAppToast(t("已解散编组"), "", "info", {
            action: {
              label: t("撤销"),
              run: () => useWidgetStore.getState().restoreGroup(group)
            }
          });
        }
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
      if (feedback) {
        /* 被摘成员在其原位 fly-in 回场（此前原地瞬现、无撤销）——与 disbandGroup
           的成员回场同一语言；拖标签摘出路径自带落位脉冲，走静默。 */
        markEntering([memberId]);
        pushAppToast(t("已移出编组"), "", "info", {
          action: {
            label: t("撤销"),
            run: () => {
              const s = useWidgetStore.getState();
              if (s.groups.some((g) => g.id === groupId)) {
                s.mergeIntoGroup([memberId], { kind: "group", id: groupId });
              } else {
                s.restoreGroup(group);
              }
            }
          }
        });
      }
    },

    updateGroup: (id, patch) => {
      const st = get();
      if (!st.groups.some((g) => g.id === id)) return;
      const next = { ...patch };
      /* x/y 只夹取、不网格化（clampFree）——智能对齐（computeAlignAdjust）
         给出 ≤8px 的离网格落点，提交若再走 clampAxis 的 20px 网格吸附，松手
         瞬间组会被拉回网格，对齐参考线「说谎」（卡片侧同款问题当年经
         alignMoveWidget 修过，组侧对齐照跟）。调用方只剩拖拽（对齐/钳位后的
         终值）与缩放（预吸附值）提交，都不依赖这里的二次吸附；40px 抓边条
         钳制语义不变。 */
      if (typeof next.x === "number") next.x = clampFree(next.x, "x");
      if (typeof next.y === "number") next.y = clampFree(next.y, "y");
      /* w/h 防御：非有限数丢弃（防旁路写入毒化几何与 CSS），低于容器最小
         尺寸夹起——缩放手柄的提交值本就 ≥ GROUP_MIN_SIZE，这里挡的是本
         API 的其它调用方（对齐 isValidGroup 在入口的有限性收口）。 */
      if (typeof next.w === "number") {
        if (!Number.isFinite(next.w)) delete next.w;
        else next.w = Math.max(next.w, GROUP_MIN_SIZE.w);
      }
      if (typeof next.h === "number") {
        if (!Number.isFinite(next.h)) delete next.h;
        else next.h = Math.max(next.h, GROUP_MIN_SIZE.h);
      }
      /* 组名与几何同走本 API——字符串（含空串）放行，undefined 恢复默认；
         非字符串丢弃（对齐 isValidGroup 的入口收口）。 */
      if (next.name !== undefined && typeof next.name !== "string") delete next.name;
      const groups = st.groups.map((g) => (g.id === id ? { ...g, ...next } : g));
      set({ groups });
      saveGroups(st.activeView, groups);
    },

    bringGroupToFront: (id) => {
      const st = get();
      const group = st.groups.find((g) => g.id === id);
      if (!group) return;
      /* 已是实例∪组的唯一顶层 → no-op（对齐 bringToFront 的写放大守卫：标签
         点击 / 配置面板行点击都会走这里，不能每次都整包落盘 + 跨窗广播）。 */
      const maxZ = Math.max(
        st.instances.reduce((m, i) => Math.max(m, i.z), 0),
        st.groups.reduce((m, g) => Math.max(m, g.z), 0)
      );
      if (maxZ <= group.z) return;
      const z = maxZ + 1;
      if (zCounter <= z) zCounter = z + 1;
      const groups = st.groups.map((g) => (g.id === id ? { ...g, z } : g));
      set({ groups });
      saveGroups(st.activeView, groups);
    },

    sendGroupToBack: (id) => {
      const st = get();
      const group = st.groups.find((g) => g.id === id);
      if (!group) return;
      const minZ = Math.min(
        st.instances.reduce((m, i) => Math.min(m, i.z), 0),
        st.groups.reduce((m, g) => Math.min(m, g.z), 0)
      );
      const z = minZ - 1;
      let groups = st.groups.map((g) => (g.id === id ? { ...g, z } : g));
      const norm = renormalizeZ(st.instances, groups);
      groups = norm.groups;
      set({ groups });
      if (norm.instances !== st.instances) {
        set({ instances: norm.instances });
        saveInstances(st.activeView, norm.instances);
      }
      saveGroups(st.activeView, groups);
    },

    removeGroup: (id) => {
      const st = get();
      const group = st.groups.find((g) => g.id === id);
      if (!group) return;
      /* 重复触发（连点删除）只保留首个退场会话。 */
      if (st.exitingIds.includes(id)) return;
      /* 组壳先播 .is-exiting（成员在编组期间没有卡片 DOM，
         removeWidgetsAnimated 标记成员是无效的——退场动画必须打在组容器上），
         到点再删组，成员逐一走既有删除路径（进回收站 + 撤销 toast）。时长随
         动效速度档（fx 档 + 尾帧余量）：此前硬编码 220ms 只在标准档（200ms）
         吻合，慢速档 --dur-fx 可达 400ms，组会在淡出中段被移除。 */
      set({ exitingIds: [...st.exitingIds, id] });
      /* 闭包捕获删除发生时的视图——退场窗口内用户
         Ctrl+数字切走后，回调在新视图组表 find 不到 → 旧组连同成员「删了又
         复活」。到期视图不符时对捕获视图定向生效：组从 loadGroups(view)
         摘除，成员经 removeInstancesInViewNow 删除并入回收站（凭证 view=
         捕获视图，与内存路径 removeWidget 写入的 view 等价）；撤销 toast
         照常给出（undo 走 trash 凭证，跨视图恢复由 路径承接）。 */
      const viewAtDelete = st.activeView;
      /* V2：同 disbandGroup——窗口内历史跳转后放弃本次删除（撤销赢）。 */
      const epochAtDelete = st.historyEpoch;
      window.setTimeout(() => {
        const cur = get();
        /* 删除即摘选中（对齐 removeWidgetsAnimated）。 */
        set({
          exitingIds: cur.exitingIds.filter((x) => x !== id),
          selectedIds: cur.selectedIds.filter((x) => x !== id),
          selectedId: cur.selectedId === id ? null : cur.selectedId
        });
        if (get().historyEpoch !== epochAtDelete) return;
        if (get().activeView !== viewAtDelete) {
          const persisted = loadGroups(viewAtDelete);
          const g = persisted.find((x) => x.id === id);
          if (!g) return;
          writeGroupsNow(
            viewAtDelete,
            persisted.filter((x) => x.id !== id)
          );
          removeInstancesInViewNow(viewAtDelete, [...g.memberIds]);
          markGroupTombstone(id);
          pushAppToast(t("已删除 {n} 个小组件", { n: g.memberIds.length }), t("已进入回收站可撤销或稍后恢复"), "info", {
            action: {
              label: t("撤销"),
              run: () => {
                const s = useWidgetStore.getState();
                for (const mid of g.memberIds) s.restoreWidget(mid);
                /* V1：跨视图撤销同样尝试重建组——restoreGroup 只回收当前内存
                   表里仍自由的成员，恢复落在异视图时自然 no-op（不误伤）。 */
                s.restoreGroup(g);
              }
            }
          });
          return;
        }
        const g = cur.groups.find((x) => x.id === id);
        if (!g) return;
        set({ groups: cur.groups.filter((x) => x.id !== id) });
        saveGroups(cur.activeView, get().groups);
        markGroupTombstone(id);
        /* V1：把组快照传给成员删除——其撤销 toast 在逐个恢复成员后追加
           restoreGroup，编组身份（组名/几何/激活标签）不再随删除蒸发。 */
        get().removeWidgetsAnimated([...g.memberIds], g);
      }, animDurations().fxMs + 20);
    },

    mergeGroups: (sourceId, targetId) => {
      const st = get();
      if (sourceId === targetId) return null;
      const source = st.groups.find((g) => g.id === sourceId);
      const target = st.groups.find((g) => g.id === targetId);
      if (!source || !target) return null;
      /* 重复触发（退场窗口内）只保留首个。 */
      if (st.exitingIds.includes(sourceId)) return null;
      /* 源组壳先播 .is-exiting 快速淡出（fx-fast 档）再真正改表——此前
         目标有脉冲、成员有归并，唯独消失的源壳是瞬消。淡出窗口（≈150ms）
         内源组保持旧渲染，到点执行归并 + 目标脉冲；快照同步返回供撤销
         toast（窗口内撤销会因组仍在而 no-op，同 disbandGroup 的时序语义）。 */
      set({ exitingIds: [...st.exitingIds, sourceId] });
      /* V2：窗口内历史跳转后放弃归并（源组已被撤销保回时不再吞并）。 */
      const epochAtMerge = st.historyEpoch;
      window.setTimeout(() => {
        const cur = get();
        set({ exitingIds: cur.exitingIds.filter((x) => x !== sourceId) });
        if (get().historyEpoch !== epochAtMerge) return;
        const src = cur.groups.find((g) => g.id === sourceId);
        const tgt = cur.groups.find((g) => g.id === targetId);
        if (!src || !tgt) return;
        const moved = new Set(src.memberIds);
        const groups = cur.groups
          .filter((g) => g.id !== sourceId)
          .map((g) => {
            if (g.id !== targetId) return g;
            /* 目标未命名时采纳源组名——命名组并入匿名组后只剩「编组 · N」，
               用户起的名字随源组蒸发；目标有自己的名字则保留（并入不改名）。
               撤销路径不受影响（快照原样重建源组）。 */
            const name = typeof g.name === "string" && g.name.trim() ? g.name : src.name;
            return { ...g, memberIds: [...g.memberIds, ...src.memberIds], name };
          });
        const instances = cur.instances.map((i) => (moved.has(i.id) ? { ...i, groupId: targetId } : i));
        set({ instances, groups, selectedId: null, selectedIds: [] });
        saveInstances(cur.activeView, instances);
        saveGroups(cur.activeView, groups);
        markGroupTombstone(sourceId);
        /* 目标组壳脉冲确认吞并（源组 DOM 淡出后由本回调移除）。 */
        markPulse([targetId]);
      }, animDurations().fxFastMs + 20);
      /* 源组快照供撤销：摘回成员后 restoreGroup 原样重建（几何/层级/激活标签/组名）。 */
      return source;
    },

    removeWidgetsAnimated: (ids, groupSnapshot) => {
      const st = get();
      const valid = ids.filter((id) => st.instances.some((i) => i.id === id) && !st.exitingIds.includes(id));
      if (!valid.length) return;
      set({ exitingIds: [...st.exitingIds, ...valid] });
      /* 闭包捕获删除发生时的视图——退场动画窗口
         （≈220ms）内用户 Ctrl+数字切走后，到期回调经 removeWidget 在（新
         视图的）内存实例表 find 不到 → 静默 return → 旧视图组件「删了又
         复活」。到期时视图不符则对捕获视图的持久层定向删除
         （removeInstancesInViewNow：过滤 + 立即落盘 + trash 凭证 view=捕获
         视图，与内存路径 removeWidget 的凭证写入时机/字段完全等价）。 */
      const viewAtDelete = st.activeView;
      /* V2：窗口内历史跳转后放弃删除（撤销赢；被恢复的成员不再入回收站，
         也不发 toast——什么都没发生）。 */
      const epochAtDelete = st.historyEpoch;
      window.setTimeout(() => {
        const cur = get();
        set({
          exitingIds: cur.exitingIds.filter((x) => !valid.includes(x)),
          selectedIds: cur.selectedIds.filter((x) => !valid.includes(x)),
          selectedId: cur.selectedId && valid.includes(cur.selectedId) ? null : cur.selectedId
        });
        if (get().historyEpoch !== epochAtDelete) return;
        if (get().activeView !== viewAtDelete) {
          removeInstancesInViewNow(viewAtDelete, valid);
        } else {
          for (const id of valid) get().removeWidget(id);
        }
        // 删除可撤销：所有删除入口（快捷条/编辑栏/批量/Delete 键/入岛移动）都
        // 汇聚到本动作，在这里统一给一条带「撤销」的 toast（此前只有更轻量的
        // 编组合并/入岛有撤销，删除本身反而没有）。两个分支的 trash 凭证都带
        // 捕获视图，undo 的 restoreWidget 跨视图恢复路径等价承接。
        pushAppToast(
          /* 整句模板 + {n} 占位符——拼接式（「已删除」+ n +「个小组件」）
             的语序在英文里不成立，占位符模板才能给出自然译文。 */
          valid.length === 1 ? t("已删除小组件") : t("已删除 {n} 个小组件", { n: valid.length }),
          t("已进入回收站可撤销或稍后恢复"),
          "info",
          {
            action: {
              label: t("撤销"),
              run: () => {
                const s = useWidgetStore.getState();
                for (const id of valid) s.restoreWidget(id);
                /* V1：带组快照删除（「删除整组」）时，成员恢复后原样重建编组
                   ——组名/几何/激活标签随撤销回来，而不是散落一地。 */
                if (groupSnapshot) s.restoreGroup(groupSnapshot);
              }
            }
          }
        );
      }, animDurations().fxMs + 20);
    },

    removeSelectionAnimated: () => {
      const st = get();
      if (st.selectedIds.length === 0) return;
      /* 组一等公民：选中集合混装实例与组（id 同池不冲突），按归属分流——
         组走 removeGroup（组壳退场 + 成员进回收站），实例走 removeWidgetsAnimated。 */
      const groupIds = st.selectedIds.filter((id) => st.groups.some((g) => g.id === id));
      const instIds = st.selectedIds.filter((id) => st.instances.some((i) => i.id === id));
      for (const gid of groupIds) get().removeGroup(gid);
      if (instIds.length) get().removeWidgetsAnimated(instIds);
    },

    setPosAnim: (ids) => {
      set({ posAnimIds: ids });
      window.setTimeout(() => {
        if (get().posAnimIds === ids) set({ posAnimIds: [] });
      }, 280);
    },

    addWidget: (type, size) => {
      const { instances, activeView } = get();
      ensureCounterAbove(instances, get().groups);
      const offset = instances.length * 24;
      const inst: WidgetInstance = {
        id: uid(),
        type,
        // 级联偏移随实例数线性增长，clamp 到视口（与 move/import 同款 40px 可抓条），
        // 否则几十个实例后新卡落在屏幕外且无抓手可恢复。
        x: clampAxis(16 + offset, "x"),
        y: clampAxis(16 + offset, "y"),
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

    duplicateGroup: (id) => {
      const { activeView } = get();
      const src = get().groups.find((g) => g.id === id);
      if (!src) return;
      const members = src.memberIds
        .map((mid) => get().instances.find((i) => i.id === mid))
        .filter((i): i is WidgetInstance => !!i);
      if (members.length < 2) return;
      ensureCounterAbove(get().instances, get().groups);
      /* 与 duplicateWidget 同款 GRID 偏移；组壳 clampFree 只夹不吸附（与
         updateGroup 提交同语义）。成员几何随壳同移——成员坐标在组内是
         「摘出/解散时回哪」的落点语义，照抄原值会让两份组各自解散时
         叠回同一处。 */
      const idMap = new Map<string, string>();
      const copies: WidgetInstance[] = members.map((m) => {
        const nid = uid();
        idMap.set(m.id, nid);
        return {
          ...m,
          id: nid,
          x: m.x + GRID,
          y: m.y + GRID,
          /* 副本哲学：自定义名不带走（label/组名都回落默认，同类型 ≥2
             自动带序号天然可区分）。 */
          label: undefined
        };
      });
      const group: WidgetGroup = {
        id: uid(),
        x: clampFree(src.x + GRID, "x"),
        y: clampFree(src.y + GRID, "y"),
        w: src.w,
        h: src.h,
        z: nextZ(),
        opacity: src.opacity,
        memberIds: copies.map((c) => c.id),
        activeId: idMap.get(src.activeId) ?? copies[0].id
      };
      const instances = [...get().instances, ...copies.map((c) => ({ ...c, groupId: group.id }))];
      // 成员实例数据深拷贝（便签/书签/日历/涂鸦）：两份组各自编辑不共享，
      // 与 duplicateWidget 的边界一致。
      for (let i = 0; i < members.length; i++) copyInstanceData(members[i].id, copies[i].id);
      set({ instances, groups: [...get().groups, group] });
      saveInstances(activeView, get().instances);
      saveGroups(activeView, get().groups);
      reconcileDockTiles();
      markEntering([group.id]);
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
      // 静默：删除本身有回收站 + 撤销 toast，回场动画/「已移出编组」对被删
      // 卡片没有意义（组件随后即进回收站）。
      if (inst.groupId) get().removeGroupMember(inst.groupId, id, { feedback: false });
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
      ensureCounterAbove(get().instances, get().groups);
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
        /* 跨视图恢复改立即落盘。此前走 saveInstances
           单槽防抖——批量恢复 N 条时背靠背调用互相顶掉唯一槽位，且
           loadInstances 只读 localStorage（不含 pendingSave 里尚未落盘的前
           几次恢复），300ms 后只有「LS 旧值 + 最后一条」落盘，其余条目随
           回收站凭证（trash 立即写删除）一并永久丢失。writeInstancesNow 对齐
           duplicateView 的立即写口径；若同视图还有未落盘的防抖快照，先冲刷，
           防止旧快照在恢复之后经定时器回写覆盖。 */
        if (pendingSave?.view === targetView) flushWidgetLayoutSync();
        writeInstancesNow(targetView, [...loadInstances(targetView), restored]);
      }
      // 实例回归（可能带着课表数据）后对账：无数据课程表磁贴可以就此绑定。
      reconcileDockTiles();
    },

    purgeWidget: (id) => {
      // 彻底删除 = 几何条目 + 实例数据（数据桶/配置/瞬态/磁盘副本）。
      // 跨屏引用防线：复制布局保留实例 id，其它屏仍引用时数据不动。
      destroyInstanceDataIfUnreferenced(id);
      const nextTrash = purgeExpiredTrash(get().trash.filter((t) => t.id !== id));
      set({ trash: nextTrash });
      saveTrash(nextTrash);
      reconcileDockTiles();
    },

    emptyWidgetTrash: () => {
      // 清空回收站 = 全部条目彻底删除，同 purgeWidget 口径（含跨屏防线）。
      for (const t of get().trash) destroyInstanceDataIfUnreferenced(t.id);
      set({ trash: [] });
      saveTrash([]);
      reconcileDockTiles();
    },

    duplicateWidget: (id) => {
      const { activeView } = get();
      const src = get().instances.find((i) => i.id === id);
      if (!src) return;
      ensureCounterAbove(get().instances, get().groups);
      const copy: WidgetInstance = {
        ...src,
        id: uid(),
        // Offset the copy so it doesn't overlap the original exactly.
        x: src.x + GRID,
        y: src.y + GRID,
        z: nextZ(),
        /* 副本不带走自定义名——保留 label 会与源卡/源标签完全同名
           （label 优先级高于自动序号），清空后回落自动名（同类型 ≥2 自动
           带序号，天然可区分）。 */
        label: undefined
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
      const { activeView, instances, groups } = get();
      // Already the unique top card → nothing to change. Skipping here keeps
      // mouse-enter auto-raise from spamming store writes (and re-rendering the
      // whole canvas) when the pointer sweeps across the topmost card.
      // 「顶层」按实例∪组判定：组渲染在卡片之后，与组平级时 DOM 序组仍盖住卡片。
      const target = instances.find((i) => i.id === id);
      const maxZ = Math.max(
        instances.reduce((m, i) => Math.max(m, i.z), 0),
        groups.reduce((m, g) => Math.max(m, g.z), 0)
      );
      if (target && maxZ <= target.z) return;
      // Compute the new z directly from the current max (instances ∪ groups) so
      // the clicked widget is ALWAYS strictly above everything — independent of
      // any counter drift from imports / copies / legacy persisted values. This
      // is the bulletproof guarantee for "last clicked stays on top".
      const newZ = maxZ + 1;
      // Keep the counter ahead so add/duplicate still produce higher z values.
      if (zCounter <= newZ) zCounter = newZ + 1;
      let next = instances.map((i) => (i.id === id ? { ...i, z: newZ } : i));
      const norm = renormalizeZ(next, groups);
      next = norm.instances;
      set({ instances: next, groups: norm.groups });
      if (norm.groups !== groups) saveGroups(activeView, norm.groups);
      saveInstances(activeView, get().instances);
    },

    sendToBack: (id) => {
      const { activeView } = get();
      // 最小 z 同样取实例∪组：只看实例会把卡片送到与组平级（组在后 → 仍盖住）。
      const minZ = Math.min(
        get().instances.reduce((m, i) => Math.min(m, i.z), 0),
        get().groups.reduce((m, g) => Math.min(m, g.z), 0)
      );
      let next = get().instances.map((i) => (i.id === id ? { ...i, z: minZ - 1 } : i));
      const norm = renormalizeZ(next, get().groups);
      next = norm.instances;
      set({ instances: next, groups: norm.groups });
      if (norm.groups !== get().groups) saveGroups(activeView, norm.groups);
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
      /* 混合拖动：卡片的拖拽会话可携带选中的组（dragPreview 的 id 键同池），
         组位移同样只夹取、不二次网格化，与实例提交同一坐标系。 */
      let anyGroupTouched = false;
      const nextGroups = get().groups.map((g) => {
        const off = dragPreview[g.id];
        if (!off) return g;
        anyGroupTouched = true;
        return { ...g, x: clampFree(g.x + off.dx, "x"), y: clampFree(g.y + off.dy, "y") };
      });
      set({
        instances: next,
        groups: anyGroupTouched ? nextGroups : get().groups,
        dragPreview: {},
        alignGuides: { xs: [], ys: [] }
      });
      saveInstances(activeView, next);
      if (anyGroupTouched) saveGroups(activeView, nextGroups);
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
      /* 键盘微移同样覆盖选中的组（吸附网格 + 40px 抓边钳位，与实例同式）。 */
      let anyGroupTouched = false;
      const nextGroups = get().groups.map((g) => {
        if (!selectedSet.has(g.id)) return g;
        anyGroupTouched = true;
        return {
          ...g,
          x: clampAxis(Math.round((g.x + dx) / GRID) * GRID, "x"),
          y: clampAxis(Math.round((g.y + dy) / GRID) * GRID, "y")
        };
      });
      set({ instances: next, ...(anyGroupTouched ? { groups: nextGroups } : {}) });
      saveInstances(activeView, get().instances);
      if (anyGroupTouched) saveGroups(activeView, nextGroups);
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
      /* 组一等公民：选中集合 = 实例 ∪ 组（id 同池），按同一套矩形数学
         对齐/分布；组的几何走 groups 表（成员坐标不参与渲染语义）。 */
      const selIds = new Set(get().selectedIds);
      const items: { id: string; x: number; y: number; w: number; h: number }[] = [
        ...get().instances.filter((i) => selIds.has(i.id)),
        ...get().groups.filter((g) => selIds.has(g.id))
      ];
      if (items.length < 2) return;
      const primary = items.find((it) => it.id === get().selectedId) ?? items[items.length - 1];
      if (!primary) return;
      const targets = new Map<string, { x: number; y: number }>();
      for (const i of items) {
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
        const sorted = [...items].sort((a, b) => a.x + a.w / 2 - (b.x + b.w / 2));
        const n = items.length;
        const minC = sorted[0].x + sorted[0].w / 2;
        const maxC = sorted[n - 1].x + sorted[n - 1].w / 2;
        const step = n > 1 ? (maxC - minC) / (n - 1) : 0;
        sorted.forEach((s, idx) => {
          const cx = minC + step * idx;
          targets.set(s.id, { x: Math.round(cx - s.w / 2), y: s.y });
        });
      }
      if (mode === "vspace") {
        const sorted = [...items].sort((a, b) => a.y + a.h / 2 - (b.y + b.h / 2));
        const n = items.length;
        const minC = sorted[0].y + sorted[0].h / 2;
        const maxC = sorted[n - 1].y + sorted[n - 1].h / 2;
        const step = n > 1 ? (maxC - minC) / (n - 1) : 0;
        sorted.forEach((s, idx) => {
          const cy = minC + step * idx;
          targets.set(s.id, { x: s.x, y: Math.round(cy - s.h / 2) });
        });
      }
      let anyGroupTouched = false;
      const nextInstances = get().instances.map((i) => {
        const t2 = targets.get(i.id);
        if (!t2) return i;
        return { ...i, x: clampAxis(t2.x, "x"), y: clampAxis(t2.y, "y") };
      });
      const nextGroups = get().groups.map((g) => {
        const t2 = targets.get(g.id);
        if (!t2) return g;
        anyGroupTouched = true;
        return { ...g, x: clampAxis(t2.x, "x"), y: clampAxis(t2.y, "y") };
      });
      set({ instances: nextInstances, ...(anyGroupTouched ? { groups: nextGroups } : {}) });
      /* 批量对齐：标记选中卡做一次性 left/top 过渡（拖拽路径不受影响）。 */
      get().setPosAnim([...selIds]);
      saveInstances(activeView, get().instances);
      if (anyGroupTouched) saveGroups(activeView, nextGroups);
    },

    arrangeSelected: (mode) => {
      const { activeView } = get();
      /* 同 alignSelected——排布输入是泛型矩形（arrange.ts ArrangeRect），
         实例与组混装即可，落位分别写回两张表。 */
      const selIds = new Set(get().selectedIds);
      const items: { id: string; x: number; y: number; w: number; h: number }[] = [
        ...get().instances.filter((i) => selIds.has(i.id)),
        ...get().groups.filter((g) => selIds.has(g.id))
      ];
      if (items.length < 2) return;
      const targets = computeArrangement(items, mode, { w: window.innerWidth, h: window.innerHeight });
      if (targets.size === 0) return;
      let anyGroupTouched = false;
      const nextInstances = get().instances.map((i) => {
        const t = targets.get(i.id);
        return t ? { ...i, x: t.x, y: t.y } : i;
      });
      const nextGroups = get().groups.map((g) => {
        const t = targets.get(g.id);
        if (!t) return g;
        anyGroupTouched = true;
        return { ...g, x: t.x, y: t.y };
      });
      set({ instances: nextInstances, ...(anyGroupTouched ? { groups: nextGroups } : {}) });
      /* 与批量对齐同款：一次性位置过渡 + 落盘。 */
      get().setPosAnim([...selIds]);
      saveInstances(activeView, get().instances);
      if (anyGroupTouched) saveGroups(activeView, nextGroups);
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
      // 重名自动加序号：侧栏/命令面板/Dock 箭头 tooltip 都靠名字区分视图。
      const next = [...get().views, { id, name: uniqueViewName(get().views, trimmed) }];
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
      /* 删视图 = 视图内全部小组件一并进回收站（与单个删除同契约，30 天内可
         恢复；恢复时目标视图已不存在，restoreWidget 自动回落当前活动视图）。
         实例数据不再当场销毁——彻底删除发生在回收站 purge，且经跨屏引用
         防线（destroyInstanceDataIfUnreferenced）保护共用数据桶的其它屏。
         此前 removeInstanceData 立即物理清桶，跨屏复制过布局的另一屏会当场
         丢内容，单屏用户也失去了 30 天反悔窗口。 */
      const removed = loadInstances(id);
      set({ views: next });
      saveViews(next);
      // Clear the removed view's layout storage.
      // 写前轮换会在主键旁留 `<key>.bak`——只删主键会把孤儿备份
      // 键永久留在 localStorage（新视图 uid 不同键，永不复用），一并清理。
      // （screen 变体键 layoutKeyFor/groupsKeyFor 属跨屏保护面，保留。）
      try {
        localStorage.removeItem(layoutKey(id));
        localStorage.removeItem(`${layoutKey(id)}.bak`);
        localStorage.removeItem(groupsKey(id));
        localStorage.removeItem(`${groupsKey(id)}.bak`);
      } catch {
        // ignore
      }
      if (removed.length > 0) {
        const entries: TrashWidget[] = removed.map((inst) => ({
          ...stripGroupId([inst])[0],
          view: id,
          deletedAt: new Date().toISOString()
        }));
        const nextTrash = purgeExpiredTrash([...entries, ...get().trash]);
        set({ trash: nextTrash });
        saveTrash(nextTrash);
      }
      if (isTauri()) {
        sqliteRepo.setSetting(dbLayoutKey(id), "[]").catch(reportPersistError("clearLayout"));
        sqliteRepo.setSetting(dbGroupsKey(id), "[]").catch(reportPersistError("clearGroups"));
        /* removeView 直删布局键、不经 writeInstancesNow——删除的视图若承载
           该屏唯一内容（其余视图皆空、岛已关），必须走一次内容边沿门控让对账
           销毁窗口（此前此路径从不排对账，空屏窗口要等重启才回收）。 */
        scheduleWidgetWindowReconcileOnContentEdge(get().dock);
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
      // 实例已随布局键移入回收站（可恢复）：绑定它们的磁贴**不**降级
      //（与单个删除进回收站同契约）；降级发生在清空/逾期回收站时。
      reconcileDockTiles();
    },

    renameView: (id, name) => {
      const trimmed = truncateViewName(name);
      if (!trimmed) return;
      // 撞名拒绝（不自动改名，理由见 uniqueViewName 注释）：UI 层已校验，
      // 这里是直调（跨窗同步/脚本）时的兜底。
      if (get().views.some((v) => v.id !== id && v.name === trimmed)) return;
      const next = get().views.map((v) => (v.id === id ? { ...v, name: trimmed } : v));
      set({ views: next });
      saveViews(next);
    },

    duplicateView: (id, name) => {
      const { views } = get();
      const src = views.find((v) => v.id === id);
      if (!src) return "";
      const nid = uid();
      /* 同屏克隆必须重造实例 id（同屏两个视图共用 id 会把磁贴绑定 / 回收站 /
         数据桶语义全部打结），数据桶随拷贝搬家（applyTemplate 同契约）；
         编组不随行——成员 id 已全部换新，旧组引用必然悬空。
         名称经 uniqueViewName 去重：调用方给的「X 副本」撞名时自动加序号。 */
      /* 跨窗 80ms 陈旧窗口——对端（桌面窗）300ms 防抖
         在途时，本窗读 LS 拿到的是其最后一次落盘的布局，副本缺最后一笔拖拽
         落位。对端内存缓冲跨窗不可达，无低成本解法；widgets 广播（80ms）会
         直写 LS 把窗口收窄到 ≈80ms+IPC 时延，原视图自身不受影响。接受为
         既定取舍。 */
      const cloned = loadInstances(id).map((inst) => {
        const freshId = uid();
        copyInstanceData(inst.id, freshId);
        return { ...stripGroupId([inst])[0], id: freshId };
      });
      const next = [...views, { id: nid, name: uniqueViewName(views, name.trim() || src.name) }];
      set({ views: next });
      saveViews(next);
      // 立即落盘（绕开单槽防抖——防抖缓冲此刻属于活动视图）；落盘内含
      // SQLite 镜像与内容边沿对账（目标屏从空到有内容时借此建窗）。
      writeInstancesNow(nid, cloned);
      reconcileDockTiles();
      return nid;
    },

    reorderViews: (moveId, beforeId) => {
      const { views } = get();
      const from = views.findIndex((v) => v.id === moveId);
      const to = views.findIndex((v) => v.id === beforeId);
      if (from < 0 || to < 0 || from === to) return;
      const next = [...views];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
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
      // 组容器随实例一并加载（此前只载实例——重启/刷新后 groups 恒为空表，
      // 已编组成员因挂着 groupId 不渲染而整组"消失"，编组状态无法跨会话存活）。
      const bootGroups = sanitizeGroups(loadGroups(view), loaded);
      // 组 z 一并喂进计数器：只看实例会让 zCounter 低于组 z，重启后的
      // 置顶/新增只抬到与组平级（DOM 序组在后 → 卡片仍被组盖住）。
      syncZCounter(loaded, bootGroups.groups);
      set({ instances: bootGroups.instances, groups: bootGroups.groups });
      if (!isTauri()) return Promise.resolve();
      // Guards against the async SQLite response landing after the store has
      // moved on (user edit, view switch, cross-window sync): a stale layout
      // must never overwrite newer state. `baseline` is the exact array set
      // above — any later mutation replaces it with a new reference.
      const seq = ++hydrateSeq;
      const baseline = loaded;
      const groupsBaseline = bootGroups.groups;
      // trash 的异步读与 instances 一样需要 baseline 守卫——若读库期间用户
      // 已删/清了回收站（get().trash 换成新引用），旧快照不得把改动倒灌回来。
      const trashBaseline = get().trash;
      // viewsAdopt 的同款 baseline 守卫——异步窗口内视图表被动过则不回灌。
      const viewsBaseline = get().views;
      const layout = loadInstancesFromDb(view).then((instances) => {
        if (seq !== hydrateSeq) return;
        if (instances.length === 0) return;
        if (get().instances !== baseline) return;
        syncZCounter(instances, get().groups);
        // DB 镜像替换实例时，组对账跟随（用当前内存组——异步窗口内的编辑不丢）。
        const next = sanitizeGroups(get().groups, instances);
        set({ instances: next.instances, groups: next.groups });
      });
      /* 组的 DB 兜底（补缺）：LS 组键主备俱坏而 DB 有好镜像时补回编组。
         串在 layout 之后（先定实例基线再对组做 sanitize，两分支不互踩基线
         守卫）；仅补缺——内存组非空（LS 完好路径）或异步窗口内有人动过
         组（baseline 守卫，同 ）时不动。 */
      const groupsMerge = layout
        .then(() => loadGroupsFromDb(view))
        .then((groups) => {
          if (seq !== hydrateSeq) return;
          if (groups.length === 0) return;
          const cur = get().groups;
          if (cur.length > 0 || cur !== groupsBaseline) return;
          const next = sanitizeGroups(groups, get().instances);
          syncZCounter(get().instances, next.groups);
          set({ groups: next.groups, ...(next.instances !== get().instances ? { instances: next.instances } : {}) });
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
        // trashKey() 存在且可解析（含刻意清空的 []）即权威；镜像落后则回写自愈，
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
      // 镜像并回填；有键即权威，不回退。与布局/回收站同一 策略的精简版。
      const dock = (async () => {
        /* LS 存在时分叉自愈（viewsHeal 同款）——saveDock 的 setSetting 是
           fire-and-forget，一次失败（DB 锁 / 磁盘满）后镜像长期陈旧且无任何回写
           时机（hydrate 只在缺键时看 DB），备份恢复到新机（走 DB）时 dock 回滚
           到旧配置。LS 为权威：raw 不一致即回写镜像（一次 getSetting 换长期
           一致性）。 */
        if (hasPersistedDock()) {
          let lsRaw: string | null = null;
          try {
            lsRaw = localStorage.getItem(dockKey());
          } catch {
            return;
          }
          if (lsRaw === null) return;
          let dbRaw: string | null = null;
          try {
            dbRaw = await sqliteRepo.getSetting(dbDockKey());
          } catch {
            return; // 镜像读失败：LS 权威，保持现状
          }
          if (dbRaw === lsRaw) return;
          if (seq !== hydrateSeq) return; // 并发 hydrate：最新一轮负责
          sqliteRepo.setSetting(dbDockKey(), lsRaw).catch(() => {});
          return;
        }
        let raw: string | null = null;
        try {
          raw = await sqliteRepo.getSetting(dbDockKey());
        } catch {
          return;
        }
        if (seq !== hydrateSeq || !raw || hasPersistedDock()) return;
        const cfg = parseDockConfig(raw);
        const json = JSON.stringify(cfg);
        try {
          localStorage.setItem(dockKey(), json);
        } catch {
          // best-effort
        }
        /* 采纳后立即对账镜像——raw 可能是 v1（迁移已换 id / 折算字段），
           不回写则镜像永远停在 v1，下次 LS 再缺键时会重新迁移、再换一组
           磁贴 id（展开 id / 合成配置键全部漂移）。 */
        sqliteRepo.setSetting(dbDockKey(), json).catch(() => {});
        set({ dock: cfg });
      })();
      /* （2026-10-03 案例）：views 镜像自愈——布局 / 回收站 / dock 的启动
         自愈齐了，唯独 views 漏了：saveViews 只在用户编辑视图清单时写库，
         镜像可长期缺键（实测 widget:views:1 缺失而 widget:layout:1:* 齐全）。
         后果有二：Rust 空屏对账经 views 索引查布局时误判“空屏”（关灵动岛即
         触发误销毁，Rust 侧已改为按 layout 前缀直扫）；备份恢复到新机时
         视图清单丢失——布局在、视图不在，对应视图整页不可见。按 localStorage
         权威补齐镜像。 */
      const viewsHeal = (async () => {
        let lsRaw: string | null = null;
        try {
          lsRaw = localStorage.getItem(viewsKey());
        } catch {
          return;
        }
        if (lsRaw === null) return;
        /* lsRaw 不可解析为合法视图表（单键损坏）时
           跳过回写——否则唯一好副本（DB 镜像）被损坏串污染，viewsAdopt 的
           采纳也随之失效。损坏场景的恢复由下方 viewsAdopt 分支负责（回填
           LS 后下一次 heal 自然收敛到好值）。 */
        if (parseViewsPayload(lsRaw) === null) return;
        let raw: string | null = null;
        try {
          raw = await sqliteRepo.getSetting(dbViewsKey());
        } catch {
          return; // 镜像读失败：localStorage 权威，保持现状
        }
        if (raw === lsRaw) return;
        sqliteRepo
          .setSetting(dbViewsKey(), lsRaw)
          .catch((err) => console.warn("[widgets] self-heal mirror write failed:", dbViewsKey(), err));
      })();
      /* views 的 DB 采纳分支——LS 主备俱坏（主键损坏
         且 .bak 尚未轮换出好值）而 SQLite 镜像完好时，用镜像重建视图表并
         回填 LS。与 layout/groups/trash/dock 四键的 策略对齐（views 此前
         是唯一只有「LS→DB」单方向的布局权威键：loadViews 落回默认表后，
         用户自建视图整屏消失且 UI 不可达，布局键全部成为孤儿）。baseline
         守卫：异步窗口内视图表被动过（本窗编辑 / 跨窗同步）则不回灌。 */
      const viewsAdopt = (async () => {
        let lsUsable = false;
        try {
          lsUsable =
            parseViewsPayload(localStorage.getItem(viewsKey())) !== null ||
            parseViewsPayload(localStorage.getItem(`${viewsKey()}.bak`)) !== null;
        } catch {
          return; // LS 读失败：无从判定，保持现状
        }
        if (lsUsable) return;
        let raw: string | null = null;
        try {
          raw = await sqliteRepo.getSetting(dbViewsKey());
        } catch {
          return; // 镜像读失败：保持默认表（下一次 saveViews 重建镜像）
        }
        const adopted = parseViewsPayload(raw);
        if (seq !== hydrateSeq || !adopted) return;
        if (get().views !== viewsBaseline) return;
        try {
          localStorage.setItem(viewsKey(), JSON.stringify(adopted));
        } catch {
          // best-effort：LS 回填失败只影响下次启动（内存态已恢复）
        }
        /* 活动视图不在恢复表内（viewKey 是独立键，可能指向损坏前已删/已
           改名的视图）：回落首视图并载入其布局。不走 setActiveView——它会
           先冲刷当前（默认表）视图的在途防抖，默认表此刻无可保数据，直接
           复用其「载入 + 重置画布瞬态」语义即可。 */
        const patch: { views: ViewDef[]; activeView?: string; instances?: WidgetInstance[]; groups?: WidgetGroup[] } = {
          views: adopted
        };
        if (!adopted.some((v) => v.id === get().activeView)) {
          const first = adopted[0].id;
          const loaded = loadInstances(first);
          const g = sanitizeGroups(loadGroups(first), loaded);
          syncZCounter(loaded, g.groups);
          patch.activeView = first;
          patch.instances = g.instances;
          patch.groups = g.groups;
          try {
            localStorage.setItem(viewKey(), first);
          } catch {
            // ignore
          }
        }
        set(patch);
      })();
      return Promise.all([layout, groupsMerge, trash, dock, viewsHeal, viewsAdopt]).then(() => {
        // hydrate 完成后对账一次——启动时按陈旧镜像建的窗口（该屏实际
        // 已空）在此销毁；对账依据仍是镜像，镜像本身未愈的极端情况在下
        // 一次布局落盘时收敛。首跑时内容缓存为空必然触发，此后走边沿门控
        //（见 scheduleWidgetWindowReconcileOnContentEdge 头注）。
        scheduleWidgetWindowReconcileOnContentEdge(get().dock);
      });
    },

    switchScreen: (screen) => {
      if (screen === currentScreen) return;
      // 旧分区若有防抖窗口内的待落盘编辑，先按旧 key 冲刷（切换后 key 就
      // 指向目标屏了，迟到的落盘会把 A 屏布局写进 B 屏）。
      flushWidgetLayoutSync();
      /* dock 广播防抖同款冲刷（见 dockBroadcastFlusher 头注）——必须在
         下面的 set() 触发 dock 订阅（clear 旧定时器）**之前**以旧屏快照发射。 */
      dockBroadcastFlusher?.();
      /* widgets 广播防抖同款冲刷（见
         widgetsBroadcastFlusher 头注）——同样必须在 set() 触发 widgets 订阅
         （clear 旧定时器）之前，以旧屏号 + 旧屏快照发射，防旧屏数据丢播或
         被迟到定时器打上新屏标。 */
      widgetsBroadcastFlusher?.();
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
      const groupsRaw = loadGroups(activeView);
      const sanitized = sanitizeGroups(groupsRaw, loaded);
      syncZCounter(loaded, sanitized.groups);
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
          .map((i) => ({ ...i, z: Number.isFinite(i.z) ? i.z : nextZ() }));
        const { activeView } = get();
        ensureCounterAbove(instances, get().groups);
        /* 整表替换后旧编组的成员引用全部悬空：就地清洗（成员不足 2 人的组自动
           解散），否则内存里的组会继续引用已不存在的实例。 */
        const replaced = sanitizeGroups(get().groups, instances);
        set({ instances: replaced.instances, groups: replaced.groups });
        saveInstances(activeView, instances);
        saveGroups(activeView, replaced.groups);
        // 整表替换：旧实例不进回收站，绑定它们的磁贴降级（对账读防抖缓冲，不必先落盘）。
        reconcileDockTiles();
        return true;
      } catch {
        return false;
      }
    },

    resetView: (view) => {
      /* 清空 = 全部小组件进回收站（与删视图 / 单个删除同契约）。此前直接写
         空布局：组件不进回收站无法恢复，实例数据桶又永久滞留（清了布局却
         清不掉便签/图库的磁盘数据），两个「清空」语义互相矛盾。 */
      // 先冲刷在途的防抖编辑（单槽防抖会被下面的 saveInstances 顶掉）。
      flushWidgetLayoutSync();
      const removed = loadInstances(view);
      if (removed.length > 0) {
        const entries: TrashWidget[] = removed.map((inst) => ({
          ...stripGroupId([inst])[0],
          view,
          deletedAt: new Date().toISOString()
        }));
        const nextTrash = purgeExpiredTrash([...entries, ...get().trash]);
        set({ trash: nextTrash });
        saveTrash(nextTrash);
      }
      saveInstances(view, []);
      saveGroups(view, []);
      if (get().activeView === view) set({ instances: [], groups: [] });
      // 立即落盘（同 removeView 的直删语义）：破坏性操作不留防抖窗口，
      // 否则断电/崩溃会留下「内存已清、磁盘仍有布局」的错位。
      flushWidgetLayoutSync();
      reconcileDockTiles();
    },

    saveTemplate: (name) => {
      const trimmed = name.trim();
      if (!trimmed) return false;
      const { templates, instances } = get();
      if (templates.some((t) => t.name === trimmed)) return false;
      // 新模板插在最前（与布局历史面板的「最新在前」同口径）：保存后立即可见，
      // 不必在 220px 的滚动列表里翻到底部找刚存的那条。
      const next = [
        // 模板不携带编组（groupId 剥离）：套用到任意视图不会产生孤儿引用。
        { id: uid(), name: trimmed, createdAt: Date.now(), instances: stripGroupId(instances) },
        ...templates
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
      ensureCounterAbove(instances, get().groups);
      // 旧模板存量可能仍带 groupId（stripGroupId 只保证新存的模板干净），
      // 套用时统一剥离并清空本视图编组——实例 id 全部换新，旧组员必然悬空。
      const stripped = stripGroupId(instances);
      set({ instances: stripped, groups: [], selectedId: null, selectedIds: [] });
      saveInstances(activeView, stripped);
      saveGroups(activeView, []);
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

/** 把 buildGroupFromMembers/Anchor 产出的成员补丁（挂好 groupId 的成员副本）
 *  合并回实例表：Map 查找代替「每实例 × 每成员 findIndex」的嵌套扫描，
 *  两处建组路径（选中编组 / 拖拽合并）共用同一实现。 */
function applyMemberPatches(instances: WidgetInstance[], members: WidgetInstance[]): WidgetInstance[] {
  const patch = new Map(members.map((m) => [m.id, m]));
  return instances.map((i) => patch.get(i.id) ?? i);
}

/** 入场动画标记（卡片/编组同池，restoreWidget 同款窗口）：ids 挂
 *  enteringIds + pulseIds，750ms 后清理——覆盖 fly-in（0.42s）与落位脉冲
 *  （0.7s）两者的 CSS 字面量时长（此前 550ms 会把脉冲在 79% 处掐尾）。
 *  导出供组件层复用（GroupCard 摘出致解散的成员回场，同 markPulse 的
 *  复用理由：避免各处手工复刻 setState + 定时清理造成时长/语义漂移）。 */
export function markEntering(ids: string[]) {
  if (!ids.length) return;
  useWidgetStore.setState((s) => ({
    enteringIds: [...s.enteringIds, ...ids.filter((x) => !s.enteringIds.includes(x))],
    pulseIds: [...s.pulseIds, ...ids.filter((x) => !s.pulseIds.includes(x))]
  }));
  window.setTimeout(() => {
    useWidgetStore.setState((s) => ({
      enteringIds: s.enteringIds.filter((x) => !ids.includes(x)),
      pulseIds: s.pulseIds.filter((x) => !ids.includes(x))
    }));
  }, 750);
}

/** 单脉冲标记（编组并入/摘出落位等无入场的反馈）：ids 挂 pulseIds，
 *  750ms 后清理。GroupCard 标签摘出等组件层路径也复用（导出），避免各处
 *  手工复刻 setState + 定时清理造成时长/语义漂移。 */
export function markPulse(ids: string[]) {
  if (!ids.length) return;
  useWidgetStore.setState((s) => ({
    pulseIds: [...s.pulseIds, ...ids.filter((x) => !s.pulseIds.includes(x))]
  }));
  window.setTimeout(() => {
    useWidgetStore.setState((s) => ({ pulseIds: s.pulseIds.filter((x) => !ids.includes(x)) }));
  }, 750);
}

/**
 * 时间线恢复入口（layout-timeline 的 undo/redo 调用）。
 * 整替目标视图的实例与编组并落盘；清除与复活实例同 id 的回收站条目（防
 * 「回收站里还躺着一份」导致重复恢复）；目标为活动视图时同步内存态并
 *  重排岛磁贴（applyTemplate 同款收尾）。
 */
export function applyTimelineState(view: string, rawInstances: WidgetInstance[], rawGroups: WidgetGroup[]) {
  const st = useWidgetStore.getState();
  /* V2：快照可能拍自退场两级串联的中间态（组表已删、成员 groupId 还挂着
     指向已不存在的组）——套用前先过 sanitizeGroups 剥孤儿 groupId / 治愈
     activeId，否则会恢复出既不渲染卡片（画布按 groupId 过滤）也不渲染组
     的「隐形组件」，要等切视图/重启才自愈。 */
  const healed = sanitizeGroups(rawGroups, rawInstances);
  const instances = healed.instances;
  const groups = healed.groups;
  /* R-前端-4（复审）：时间线撤销/快照套用即解除快照内复活组的墓碑——与
     restoreGroup 的 toast 撤销同款待遇（只给了一条路径）。否则撤销
     救回的组仍被墓碑滤出远端包，「撤销赢过在途变更」的 V2 语义被迟到
     旧包反向打掉。 */
  for (const g of groups) deletedGroupTombstones.delete(g.id);
  const liveIds = new Set(instances.map((i) => i.id));
  const trash = st.trash.filter((w) => !liveIds.has(w.id));
  ensureCounterAbove(instances, groups);
  if (st.activeView === view) {
    /* 五.2 恢复可见化：存活卡几何变化走 pos-anim FLIP、复活卡走 fly-in + 落位
       脉冲——undo/快照套用不再是存活卡瞬跳硬切（机制与拖拽落位/回收站恢复
       同源）。编组容器几何变化同样入列（GroupCard 订阅 posAnimIds 播
       left/top 过渡）。窗口 560ms 覆盖 pos-anim 500ms 档 + 尾帧。 */
    const prev = new Map(st.instances.map((i) => [i.id, i]));
    const prevGroups = new Map(st.groups.map((g) => [g.id, g]));
    const movedIds: string[] = [];
    const revivedIds: string[] = [];
    for (const i of instances) {
      const before = prev.get(i.id);
      if (!before) revivedIds.push(i.id);
      else if (before.x !== i.x || before.y !== i.y || before.w !== i.w || before.h !== i.h) movedIds.push(i.id);
    }
    for (const g of groups) {
      const before = prevGroups.get(g.id);
      if (!before) revivedIds.push(g.id);
      else if (before.x !== g.x || before.y !== g.y || before.w !== g.w || before.h !== g.h) movedIds.push(g.id);
    }
    useWidgetStore.setState({
      instances,
      groups,
      trash,
      selectedId: null,
      selectedIds: [],
      /* V2：历史跳转清空在途退场标记（被撤销救回的组/卡片不该再带
         .is-exiting 淡出样式渲染）并自增纪元——在途的延迟删除/解散/归并
         回调到点发现纪元不符即放弃，撤销赢过在途变更。 */
      exitingIds: [],
      historyEpoch: st.historyEpoch + 1,
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
  /** 发送方单调递增的版本号。接收方按发送方记忆 lastRev，拒绝乱序/重复
   *  到达的旧快照，避免 80ms 防抖交错时旧整包覆盖新整包。旧版本载荷无此字段。 */
  rev?: number;
  /** 所属屏幕分区 id：只有与当前窗口 screenId 一致时才应用，避免多屏互相覆盖。 */
  screenId: string;
  instances: WidgetInstance[];
  /** 编组容器（旧版本载荷无此字段——接收端保留本地组，不清空）。 */
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
/* 组删除/解散/归并意图墓碑——取代此前 exitingIds 兼任的
 * 远端复活过滤。exitingIds 的存活窗（退场动画 ≈fxMs）与真正的威胁窗（回调
 * 提交删除**之后**、对端尚未收到删除广播的迟到整包）并不重叠：退场窗内过滤
 * 会把组壳提前从远端包里滤掉，延迟回调 find 不到组而早退——成员不入回收
 * 站、无撤销、无广播，删除半途流产（组壳消失 + 成员散落）。墓碑在**提交
 * 删除时**写入、短 TTL 过期：只拦提交后的迟到旧包（V3 的本意），不干扰
 * 退场窗内的远端包（回调到点正常完成删除并广播）。restoreGroup 撤销时清除。 */
const deletedGroupTombstones = new Map<string, number>();
/* R-前端-5（复审备案）：TTL 覆盖不了对端拖拽挂起同步 >5s 后的补发全量快照
 * （对端从未应用删除包、内存仍含组）。按墙钟的墓碑无法区分「对端还没收到」
 * 与「对端收到了但挂着」；完备解需按对端 rev 确认过期，复杂度不抵该窗口
 * 的触发概率（同屏 + 恰好拖拽超 5s + 恰有迟到包），备案接受。 */
const GROUP_TOMBSTONE_TTL_MS = 5000;
function markGroupTombstone(id: string): void {
  deletedGroupTombstones.set(id, Date.now() + GROUP_TOMBSTONE_TTL_MS);
}
function isGroupTombstoned(id: string): boolean {
  const until = deletedGroupTombstones.get(id);
  if (until === undefined) return false;
  if (Date.now() > until) {
    deletedGroupTombstones.delete(id);
    return false;
  }
  return true;
}

export function applyRemoteWidgets(p: WidgetSyncPayload) {
  if (!p || p.screenId !== currentScreenId()) return;
  if (!Array.isArray(p.instances) || !Array.isArray(p.views) || !Array.isArray(p.trash)) return;
  /* views 元素过 isViewDefLike 过滤（与 instances 的
     isLiveInstance、groups 的 isValidGroup 对称的第三道防线）——外层只验了
     Array.isArray，畸形元素（非 {id,name} 对象）会随镜像写进 LS 并随
     setState 进内存，侧栏视图列表/切视图逻辑按 v.id 取值即崩。 */
  const views = p.views.filter(isViewDefLike);
  const local = useWidgetStore.getState();
  // 元素级清洗在 try 外声明：镜像写盘（try 内）与内存 setState 分支共用同一
  // 份洗过的载荷——内存分支用原始 p.instances 会把畸形条目放进 marquee/合并
  // 逻辑，与镜像分叉。
  // 实例侧对齐组侧口径（组过 isValidGroup）——isLiveInstance 含几何/z
  // 有限性、label 类型与长度、下线类型剔除，与持久化读取路径同一套
  // 收口；此前只查 id（注释声称挡畸形坐标，代码并未做到）。
  const sanitized = p.instances.filter(isLiveInstance).map((i) => ({ ...i }));
  /* V3：刚删除/解散/归并的组不接受远端整包复活——对端发送先于收到我们的
     删除广播时是过期快照；放行会把刚删的组原样复活且再无回调清理。
     过滤基准从 exitingIds 换成**提交墓碑**（见 deletedGroupTombstones
     声明处注释）——退场窗内不再过滤（回调到点正常完成删除），只拦提交后
     TTL 内的迟到旧包。成员的孤儿 groupId 由 sanitizeGroups 剥离。
     注意实例侧不可同样过滤：到期回调靠重查实例建回收站条目，滤掉会让
     组件凭空蒸发且不进回收站。镜像/内存两分支共用同一份过滤结果。 */
  const remoteGroups = Array.isArray(p.groups)
    ? p.groups.filter(isValidGroup).filter((g) => !isGroupTombstoned(g.id))
    : null;
  try {
    // Persist the incoming layout to ITS own view key so edits to a non-active
    // view survive, even when this window is showing a different view.
    // 与本地写路径同规格——走写前 .bak 轮换（防坏包直接
    // 顶掉上一份好数据），且只持久化洗过的载荷副本（外层仅校验过
    // Array.isArray，元素级过滤在此先行）。后续 setState 分支再用另一份
    // 独立拷贝（syncZCounter 原地改号不得污染镜像）。
    // 旧版本发送方载荷无 groups：保留本地组（不得清空——编组跨窗口存活）。
    // V3 的退场过滤见函数头 remoteGroups（镜像/内存两分支共用）。
    const incomingGroups = remoteGroups ?? local.groups;
    const cleanGroups = sanitizeGroups(incomingGroups, sanitized).groups;
    syncZCounter(sanitized, cleanGroups);
    /* 接收侧 LS 直写挂闸门（与下方 applyRemoteDock 同口径）——恢复
       备份进行中，pause 前在飞的 sync:widgets 到达时不得把恢复前的旧布局/
       组/视图/回收站写回共享 LS（覆盖刚导入的数据）；下方内存 setState
       照常执行（恢复以 reload 收尾，内存态短暂跟进无害）。 */
    if (!isPersistSuspended()) {
      localStorageWriteWithBackup(layoutKey(p.activeView), JSON.stringify(sanitized));
      localStorageWriteWithBackup(groupsKey(p.activeView), JSON.stringify(cleanGroups));
      localStorageWriteWithBackup(viewsKey(), JSON.stringify(views));
      localStorageWriteWithBackup(trashKey(), JSON.stringify(p.trash));
    }
    // 远端包直写后清掉待落盘的本地防抖快照——它记录的是
    // 旧内存态，放行会在 300ms 防抖到期后把旧布局写回（writeInstancesNow
    // 的过期守卫是第二道保险）。
    // 只清同视图的快照——异视图编辑到达时（设置窗改了 B 视图、本窗
    // 正在 A 视图拖拽），本窗对 A 的在途快照与远端包写的 B 键互不相干，
    // 无条件清掉会让 A 的内存编辑失去唯一的落盘触发（pagehide 冲刷见
    // null 直接跳过 → 退出应用丢该次布局）。
    if (pendingSave?.view === p.activeView) {
      pendingSave = null;
      if (saveTimer !== null) {
        window.clearTimeout(saveTimer);
        saveTimer = null;
      }
    }
    // 只清了 instances 的 pendingSave——groups 的
    // 300ms 防抖旧快照放行会在到期后把旧组表写回（writeGroupsNow 的过期
    // 守卫是第二道保险），同视图时一并清掉。
    if (pendingGroupsSave?.view === p.activeView) {
      pendingGroupsSave = null;
      if (groupsSaveTimer !== null) {
        window.clearTimeout(groupsSaveTimer);
        groupsSaveTimer = null;
      }
    }
  } catch {
    // best-effort
  }
  const trash = purgeExpiredTrash(p.trash);
  if (p.activeView === local.activeView) {
    // Work on a copy: syncZCounter renumbers z in place, and mutating the shared
    // payload would also corrupt the layout mirror we just wrote above.
    // 与镜像分支同口径：内存态也用洗过的 sanitized（缺 type/坐标的畸形条目
    // 不得进入 marquee/合并/置顶逻辑），再独立拷贝一份防污染镜像。
    const instances = sanitized.map((i) => ({ ...i }));
    // 载荷缺 groups（旧版本发送方）时保留本地组——组不能因一次无组快照被清散。
    const gs = sanitizeGroups(remoteGroups ?? local.groups, instances);
    syncZCounter(instances, gs.groups);
    useWidgetStore.setState({ instances: gs.instances, groups: gs.groups, views, trash });
  } else {
    // Same screen, but a different view was edited: absorb the shared metadata
    // without switching the local view or overwriting its instances.
    useWidgetStore.setState({ views, trash });
    /* 导入/远端整替 views 后，本窗活动视图可能已不在
       新表内（幽灵视图）——侧栏/Ctrl+数字列表里没有它，用户一切走就回不来，
       此后本窗的布局编辑会写进 UI 不可达的孤儿键。回落到新表首个视图：走
       setActiveView 完整语义（冲刷幽灵视图在途防抖，保住其最后一笔编辑，
       再载入目标视图）。发送方（设置窗导入端）只修正了自己的 activeView，
       本分支补齐对端对称处理。 */
    const st = useWidgetStore.getState();
    if (views.length > 0 && !views.some((v) => v.id === st.activeView)) {
      st.setActiveView(views[0].id);
    }
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
  const remote = parseDockConfig(JSON.stringify(p.dock));
  /* 叶子合并的实际语义澄清——remote 恒经 parseDockConfig 产出**全字段**
     子对象（缺项回默认），{...cur, ...remote} 合并恒等于 remote 整包，注释
     此前宣称的「发送方旧字段不覆盖本窗并发改动」对本路径不成立（跨窗并发
     编辑仍是对端整包胜出——发送方在打包时刻的快照即其权威）。真正的并发
     保护在本地 setDock：调用方（DockPage / DockConfigPanel）已改为 getState()
     取当前兄弟字段，不再展开陈旧渲染闭包。保留合并写法以对称本地路径、
     并为未来「remote 增量载荷」留兼容位。 */
  const cur = useWidgetStore.getState().dock;
  const cfg: DockConfig = {
    ...remote,
    mouse: { ...cur.mouse, ...remote.mouse },
    takeover: { ...cur.takeover, ...remote.takeover },
    panel: { ...cur.panel, ...remote.panel }
  };
  /* 等值短路（repullDockFromLs 同口径）——三方窗口的重播 / 启动回读竞态会
     出现与本窗内存完全一致的整包；整包 setState 会让全部磁贴对象身份重建
     （memo 全 miss + 逐磁贴重跑落种 effect），LS 镜像也无谓重写。 */
  if (JSON.stringify(cfg) === JSON.stringify(cur)) return;
  /* B-恢复 ack 协议闸门——恢复备份进行中，pause 前在飞的 sync:dock 到达时
     接收方不得把恢复前的旧配置写回 LS（覆盖刚导入的数据）；内存态照常跟进。 */
  if (!isPersistSuspended()) {
    try {
      localStorageWriteWithBackup(dockKey(), JSON.stringify(cfg));
    } catch {
      // best-effort
    }
  }
  /* 远端移除的无实例磁贴，其合成配置键 / 数据桶一并清理
     （与 removeDockTile 同口径；绑定实例的数据属实例生命周期不在此清）。 */
  const newIds = new Set(cfg.tiles.map((t) => t.id));
  for (const t of cur.tiles) {
    if (!t.instanceId && !newIds.has(t.id)) removeInstanceData(dockTileInstanceId(t));
  }
  useWidgetStore.setState({ dock: cfg });
}

/** 磁贴降级事件（需求 §7 风险表）：detail 为被降级的磁贴数组，DockShell 据此弹一次性提示。 */
export const DOCK_TILES_DEGRADED_EVENT = "vela:dock-tiles-degraded";

/**
 * （的 dock 版）：sync:dock 监听就绪后由 cross-window 调用，重读共享
 * localStorage 权威快照——兜住「发送方在接收窗 loadDock 之后、监听注册之前
 * 完成的一次保存」：那条 sync:dock 事件被丢、启动读又没看到，接收窗内存态
 * 陈旧到下次编辑，且基于陈旧态的编辑会整包回写反向覆盖对端的新配置。
 * 调用方应以 applyingRemote 包裹（抑制采纳引发的回播）。
 */
export function repullDockFromLs(): void {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(dockKey());
  } catch {
    return;
  }
  if (raw === null) return;
  const cfg = parseDockConfig(raw);
  if (JSON.stringify(cfg) === JSON.stringify(useWidgetStore.getState().dock)) return;
  useWidgetStore.setState({ dock: cfg });
}

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
 * 绑定实例已被**永久**删除（清空 / 逾期清理回收站、整表替换；删视图自本批
 * 起走回收站不再永久销毁）的磁贴降级为
 * 无实例磁贴：保留磁贴与位置、去掉 instanceId，此后按图库入口的无实例语义读写
 * （DockTile.config），不静默消失。降级后若与岛上既有的无实例同类磁贴同身份
 * （findDockTileConflict），则移除该枚而非保留两枚。移入回收站不触发（可撤销）。
 *
 * @returns 被降级（含因重复而移除）的磁贴；有变化时同时派发 DOCK_TILES_DEGRADED_EVENT。
 */
/**
 * 岛上磁贴绑定对账，两个方向：
 *  - 降级：绑定实例已被**永久**删除（清空 / 逾期清理回收站、整表替换；删视图
 *    自本批起走回收站不再永久销毁）
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
  /* 事件只装「真的降级保留下来」的磁贴——因与既有无实例同类磁贴同身份
     而被整体移除的那部分不是降级（磁贴没了），混进 toast 会出现「已降级」
     提示配上消失的磁贴。返回值维持文档口径（含因重复而移除）不变。 */
  const downgraded = degraded.filter((t) => tiles.some((x) => x.id === t.id && !x.instanceId));
  if (downgraded.length > 0) {
    try {
      window.dispatchEvent(new CustomEvent(DOCK_TILES_DEGRADED_EVENT, { detail: downgraded }));
    } catch {
      // best-effort
    }
  }
  return degraded;
}

/**
 * 启动期事件丢失窗兜底。sync:widgets 监听注册完成后由 cross-window 调用。
 * 第二窗口启动时，发送方对共享 localStorage 与 SQLite 的最新保存可能发生在本窗口
 * 读库之后，其后投递的 sync:widgets 事件又落在监听注册前被丢弃——本窗口会一直停留
 * 在陈旧布局直到下一次编辑。这里在监听就绪后重读一次持久层（localStorage 权威，
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
    syncZCounter(instances, useWidgetStore.getState().groups);
    useWidgetStore.setState({ instances });
  }

  // 再读回收站（同样带 baseline 守卫；策略与 hydrate 一致）。
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
