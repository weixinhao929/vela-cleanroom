/**
 * Dock 纯逻辑（/ 互斥优先级链）：接管仲裁、时间格式、
 * 环形进度，以及灵动岛 2.0 的 v1→v2 迁移与几何纯函数（插入位 / 吸附）。
 * 无 React / 无 IO，供 dock/ 各组件与单测共用。
 *
 * 类型经 `import type` 单向引用 widget-store（编译期擦除，无运行时环）；
 * DOCK_DEFAULTS 在此定义、widget-store 的 DEFAULT_DOCK 组装 tiles——保持本文件
 * 零运行时依赖，migrateDockConfig 可脱离 store 独立单测。
 */
import type { DockConfig, DockSnap, DockTile } from "../widget-store";
import { CHANGE_EVENT } from "../widget-config";

/**
 * 临时接管的种类。优先级：番茄钟响铃 > 亮度/音量/媒体切歌/链接快开（同级
 * 最新优先）> 通知到达。brightness / volume 是 OSD 式即时反馈（应用内
 * 调整 + 一.2 系统级 watcher 两路来源），与媒体同级——正在拖滑杆时切歌，
 * 最新者胜，不互相挤占。link压过通知、与媒体同级：系统通知在 Vela
 * 的排序里本就是最低档（不打断更高优先级的即时反馈）。
 */
export type TakeoverKind = "pomodoro" | "media" | "notification" | "brightness" | "volume" | "link";

export const TAKEOVER_PRIORITY: Record<TakeoverKind, number> = {
  pomodoro: 3,
  brightness: 2,
  volume: 2,
  media: 2,
  link: 2,
  notification: 1
};

/* （单点化）：dock 有两个语义不同、数值不同的「长按」阈值，此前在
   DockTile / DockTiles 各自定义同名 LONG_PRESS_MS（600 / 300），改名前
   极易误引。收敛到本模块单点导出： */
/** 磁贴菜单长按（DockTile）：按住 600ms 触发菜单等价操作。feature-dock.css
 *  的 `.is-pressing` 600ms 渐进压下过渡与本值配对（CSS 无法消费 JS 常量，
 *  改值必须同步该规则的裸时长并在两处注记）。 */
export const TILE_MENU_LONG_PRESS_MS = 600;
/** 磁贴拖动长按（DockTiles）：非编辑模式按住 300ms 起拖。 */
export const TILE_DRAG_LONG_PRESS_MS = 300;

/** 接管展示时长：到期后 dock 回到常规磁贴排布。 */
export const TAKEOVER_MS = 6000;

/** 接管展示时长的合法区间（3–15s）。：单点钳制——widget-store
 *  的 parseDockTakeover、DockTakeover 对绕过 store 的值兜底、DockPage 滑条
 *  min/max 此前三处各自硬编码，任一改区间即漂移。 */
export const TAKEOVER_DURATION_MIN_MS = 3_000;
export const TAKEOVER_DURATION_MAX_MS = 15_000;
export function clampTakeoverDurationMs(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v)
    ? Math.min(TAKEOVER_DURATION_MAX_MS, Math.max(TAKEOVER_DURATION_MIN_MS, Math.round(v)))
    : TAKEOVER_MS;
}

export type Takeover = {
  kind: TakeoverKind;
  title: string;
  sub?: string;
  /** 媒体接管条附带的封面 data URL（NextUp 样式）；仅展示用，不参与
   *  仲裁身份（同 kind 判定仍走 kind+priority）。 */
  thumb?: string;
  /** 一.4 链接快开携带的完整 URL（title 是缩短显示；点击时用本字段打开）。 */
  url?: string;
  /** 到期时刻（epoch ms）。：仅仲裁纯函数的内部字段——useDockTakeover
   *  的 state 已剥离 until（同内容续提案只顺延 ref 不换引用，state.until
   *  必然陈旧，属埋雷字段）；到期时刻唯一真源是 DockTakeover 的 untilRef。 */
  until: number;
};

/** 接管的「展示面」形状：不含仲裁内部字段 until（UI 层消费的类型）。 */
export type TakeoverFace = Omit<Takeover, "until">;

export type TakeoverCandidate = Omit<Takeover, "until">;

/**
 * 各 kind 的接管开关（可配置）：缺省 / 缺项 = 开启。DockConfig.takeover
 * 的 {pomodoro, media, notification} 直接映射到这里。
 */
export type TakeoverKindToggles = Partial<Record<TakeoverKind, boolean>>;

/**
 * 互斥仲裁：同一时刻 dock 只显示一条接管。
 *  - 当前为空或已过期 → 接受候选；
 *  - 候选优先级 ≥ 当前 → 抢占（同级最新优先，如连续两条通知显示最新的）；
 *  - 候选优先级 < 当前且当前未过期 → 丢弃候选，保持当前；
 *  - 候选 kind 被 enabledKinds 关闭 → 丢弃候选，保持当前。
 *
 * @returns 新的接管状态（可能与 current 同引用表示不变）。三参调用永不返回
 *   null（向后兼容）；带 enabledKinds 时，候选被关且当前为空 → null。
 */
export function resolveTakeover(current: Takeover | null, candidate: TakeoverCandidate, now: number): Takeover;
export function resolveTakeover(
  current: Takeover | null,
  candidate: TakeoverCandidate,
  now: number,
  enabledKinds: TakeoverKindToggles | undefined
): Takeover | null;
export function resolveTakeover(
  current: Takeover | null,
  candidate: TakeoverCandidate,
  now: number,
  enabledKinds?: TakeoverKindToggles
): Takeover | null {
  if (enabledKinds && enabledKinds[candidate.kind] === false) return current;
  if (!current || current.until <= now) return { ...candidate, until: now + TAKEOVER_MS };
  if (TAKEOVER_PRIORITY[candidate.kind] >= TAKEOVER_PRIORITY[current.kind]) {
    return { ...candidate, until: now + TAKEOVER_MS };
  }
  return current;
}

/** 到期判定（由 UI 定时器调用）。 */
export function takeoverExpired(t: Takeover | null, now: number): boolean {
  return !!t && t.until <= now;
}

/** 二.2 续提案判定：kind 与全部可见内容（标题/副标/链接/封面）一致 → 视为同一条
 *  接管的延续（如连续的音量事件），调用方只顺延到期、不换 state 对象。
 *  参数用展示面形状（UI 层的 state 不含 until）。 */
export function takeoverContentEqual(a: TakeoverFace, b: TakeoverFace): boolean {
  return (
    a.kind === b.kind &&
    a.title === b.title &&
    (a.sub ?? null) === (b.sub ?? null) &&
    (a.url ?? null) === (b.url ?? null) &&
    thumbEqual(a.thumb ?? null, b.thumb ?? null)
  );
}

/** thumb（base64 data URL，可达数十 KB）的等值代理：同引用 / 长度不等先短路，
 *  内容比较结果按 (a,b) 有序对缓存最近一次。续提案的 thumb 来自调用方的保鲜
 *  ref（同引用），热路径（音量 ~20/s）零逐字比较；长度短路挡住新旧封面切换。 */
let thumbEqCache: { a: string; b: string; eq: boolean } | null = null;
function thumbEqual(a: string | null, b: string | null): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  const c = thumbEqCache;
  if (c && c.a === a && c.b === b) return c.eq;
  const eq = a === b;
  thumbEqCache = { a, b, eq };
  return eq;
}

/** 一.4 链接快开接管条上的链接缩短：保留前缀，尽量在分隔符处截断，
 *  余下折叠成省略号（完整 URL 经 Takeover.url 随候选携带）。 */
export function shortenUrl(url: string, max = 48): string {
  if (url.length <= max) return url;
  const cut = url.slice(0, max);
  const sep = Math.max(cut.lastIndexOf("/"), cut.lastIndexOf("?"), cut.lastIndexOf("&"));
  return `${sep > max * 0.6 ? cut.slice(0, sep) : cut}…`;
}

/** HH:MM（24 小时制，本地时间）。 */
export function formatClock(d: Date): string {
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** mm:ss（≥1h 切 h:mm:ss）；负数/非法按 0 处理。 */
export function formatMMSS(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(Number.isFinite(totalSeconds) ? totalSeconds : 0));
  // 正计时/180 分钟上限倒计时超 1 小时——此前显示 75:12，与主面板/
  // 全屏的 1:15:12 不一致。
  const h = Math.floor(s / 3600);
  if (h > 0) {
    return `${h}:${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
  }
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

/**
 * 环形进度 0–1：倒计时 = 已用占比（remaining 越少环越满）；正计时 = 已计秒
 * 占目标占比（无目标时恒 0）。planned ≤ 0 时返回 0，避免除零。
 */
export function ringProgress(
  remainingSeconds: number,
  plannedSeconds: number,
  timerMode: "countdown" | "countup"
): number {
  if (!Number.isFinite(plannedSeconds) || plannedSeconds <= 0) return 0;
  const r = Math.max(0, remainingSeconds);
  const p = timerMode === "countup" ? r / plannedSeconds : 1 - r / plannedSeconds;
  return Math.min(1, Math.max(0, p));
}

/** 媒体切歌判定：标题或艺术家变化且新标题非空（忽略首次采样与空→空）。 */
export function trackChanged(
  prev: { title: string; artist: string } | null,
  next: { title: string; artist: string } | null
): boolean {
  if (!next || !next.title) return false;
  if (!prev) return false;
  return prev.title !== next.title || prev.artist !== next.artist;
}

/* ================================================================== *
 * 灵动岛 2.0（ISLAND-CORE）：展开 id / v2 默认值 / v1 迁移 / 几何纯函数
 * ------------------------------------------------------------------ */

/** dock 展开态在 expand-store 中的 id 前缀（与画布实例 id 区隔；§4.4）。 */
export const DOCK_EXPAND_PREFIX = "dock:";
/** 全岛面板的展开 id（DockPanel 空壳已接线，默认配置下无入口触发）。 */
export const DOCK_PANEL_EXPAND_ID = "dock:panel";

/** 磁贴 FLIP 重排的参与元素选择器：磁贴 + 末尾「+」（增删/排序时一并滑动）。
 *  放在此处供 DockTiles（拖拽/键盘）与 DockTile（右键移除）共用，避免两者
 *  循环依赖（DockTiles 渲染 DockTile，选择器不能从 DockTiles 反向导出）。 */
export const DOCK_FLIP_SELECTOR = ".dock-tile, .dock-tile-add";

/** 单磁贴的展开 id。磁贴 id 为 uuid，不会与 "panel" 撞名。 */
export const dockTileExpandId = (tileId: string): string => `${DOCK_EXPAND_PREFIX}${tileId}`;

/**
 * 磁贴的 instanceId：绑定了画布实例的直接用；无实例磁贴用
 * `dock-tile-<tileId>` 合成 id（DockTile.config 落种到该键，作临时配置源）。
 * 单磁贴展开（DockTileExpanded）与全岛面板（DockPanel）必须共用同一口径，
 * 否则展开内容读 `focus-desk.widget-config..v1` 全局空键、右键"配置"却写
 * tile.config，两份数据永不汇合，且所有无实例磁贴串用同一个空键。
 */
export function dockTileInstanceId(tile: DockTile): string {
  /* truthiness 而非 ??：isDockTileObject 此前放行 instanceId:""，空串会
     原样返回、读进全局空键 focus-desk.widget-config..v1（正是本函数头注
     要防的键）——校验侧已挡，这里再兜一层。 */
  return tile.instanceId ? tile.instanceId : `dock-tile-${tile.id}`;
}

/* 落种短路缓存（键 → 最近成功落种的内容 JSON）——首渲同步落种在
   StrictMode 双调 / 并发渲染重放下会重复执行「读-合并-序列化-比对」，
   落种幂等但白费；tile.config 未变时 effect 重种是最常见来源，内容相同
   直接短路（组件在两次落种间自写数据会让合并结果变化、缓存自然失效）。 */
const seededCache = new Map<string, string>();

/**
 * 无实例磁贴：把 tile.config 落种到合成 instanceId 的 widget-config 键，
 * 让 useWidgetConfig(instanceId) 读到磁贴私有配置。落种是**合并**而非覆盖：
 * 该键同时是组件自己写用户数据的落点（如课程表磁贴展开面板里导入的
 * data/profiles——那不走 tile.config），整写会把它们冲掉、下次落种即"丢数据"。
 * 冲突字段以 tile.config 为准（展示开关来自弹层/设置页的显式写入）；
 * 组件写入的键独有字段（data 等）保留。内容未变则不写不广播；
 * `notify` 为 true 时派发 CHANGE_EVENT 让已挂载组件重读。
 */
export function seedDockTileConfig(tile: DockTile, notify: boolean): void {
  if (tile.instanceId || !tile.config) return;
  const id = dockTileInstanceId(tile);
  const key = `focus-desk.widget-config.${id}.v1`;
  let existing: Record<string, unknown> = {};
  try {
    const raw = localStorage.getItem(key);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      existing = parsed as Record<string, unknown>;
    }
  } catch {
    // 键损坏按空处理：用 tile.config 重建（与 loadWidgetConfig 的容错同口径）。
  }
  let next: string;
  try {
    next = JSON.stringify({ ...existing, ...tile.config });
  } catch {
    return;
  }
  if (seededCache.get(key) === next) return;
  try {
    if (localStorage.getItem(key) === next) {
      seededCache.set(key, next);
      return;
    }
    localStorage.setItem(key, next);
  } catch {
    return;
  }
  seededCache.set(key, next);
  if (notify) window.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: id }));
}

/** v1 的三枚固定磁贴类型（迁移白名单 + 配置面板的规范顺序）。 */
export const V1_DOCK_TILE_TYPES: readonly string[] = ["clock", "pomodoro", "notifications"];

/** start / end 吸附点渲染时的贴边留白（px）——DockShell 的静止几何与
 *  DockPanel.islandOrigin 的起点推导共用的单点常量（布局单位）。 */
export const DOCK_FLUSH_PX = 8;

/** `.dock-tiles` 的 flex gap（px）：插入竖条落在相邻磁贴的间隙中线（DockDropZone
 *  的外部拖入插入位、DockTiles 让位步长的缺省兜底都按它算）。feature-dock.css
 *  的 `.dock-tiles { gap }` 消费同一值——CSS 无法读 JS 常量，改值必须同步该规则
 *  并在两处注记（与 TILE_MENU_LONG_PRESS_MS ↔ .is-pressing 同款纪律）。 */
export const DOCK_TILE_GAP_PX = 4;

/**
 * DockConfig v2 除 tiles 外的默认值（single source；widget-store 的
 * DEFAULT_DOCK 在此之上拼默认三磁贴）。takeover.durationMs 与 TAKEOVER_MS
 * 同源（6s），保证 v2 默认行为与 2.0 前完全一致。
 */
export const DOCK_DEFAULTS: Omit<DockConfig, "tiles"> = {
  version: 2,
  enabled: false,
  edge: "top",
  offset: 0.5,
  snap: "center",
  style: "pill",
  mouse: { hover: "none", blank: "none", middle: "collapse", wheel: "none" },
  takeover: {
    pomodoro: true,
    media: true,
    notification: true,
    brightness: true,
    volume: true,
    link: true,
    durationMs: TAKEOVER_MS
  },
  autoHide: false,
  panel: { mode: "carousel" },
  density: 42,
  topInset: 10,
  viewArrows: true
};

/** topInset 合法区间（px）。 */
export const DOCK_TOP_INSET_MAX = 64;

/**
 * DOCK_DEFAULTS 的深拷贝：mouse / takeover / panel 子对象逐个新建。浅展开会让每份
 * 配置与模块常量共享这三个子对象——任何一处就地赋值都会污染默认值。
 */
export function cloneDockDefaults(): Omit<DockConfig, "tiles"> {
  return {
    ...DOCK_DEFAULTS,
    mouse: { ...DOCK_DEFAULTS.mouse },
    takeover: { ...DOCK_DEFAULTS.takeover },
    panel: { ...DOCK_DEFAULTS.panel }
  };
}

const defaultIdGen = (_type: string): string => crypto.randomUUID();

/**
 * v1 → v2 配置迁移（纯函数，§4.1）：v1 的 tiles 是字符串数组，逐枚换成
 * {id, type} 对象（id = idGen(type)；缺省 crypto.randomUUID 供单测，生产
 * 调用点 widget-store.parseDockConfig 注入确定性 `dock-tile-<type>` 生成器
 * 随机 uuid 在多窗口并发迁移同一 v1 键时各造一套，sync:dock 整包互顶后
 * 展开 id / 合成配置键全部漂移）；enabled / autoHide 合法值保留（旧三态
 * 折算，与 parseDockAutoHide 同口径——文档一直声称折算，实现此前直接回
 * 默认）；edge 一律归 top（竖边无实现、贴底已退役，渲染侧本就只认 top，
 * 保留逻辑只会被调用点覆盖成死代码）：offset / snap 合法值保留
 * （v1 与 v2 同为贴边容器模型，位置字段大概率存在——此前一律回默认，
 * 自称「无损」实为有损：用户自定义岛位升级后重置居中；v1 特有的边名
 * 值不认，安全回默认）。其余字段一律回默认。未知与重复的 v1 磁贴类型被
 * 剔除（v1 解析本就如此）；tiles 缺失时回默认三磁贴。
 */
export function migrateDockConfig(v1: unknown, idGen: (type: string) => string = defaultIdGen): DockConfig {
  const o = v1 && typeof v1 === "object" ? (v1 as Record<string, unknown>) : {};
  const rawTiles = Array.isArray(o.tiles) ? o.tiles : V1_DOCK_TILE_TYPES;
  const seen = new Set<string>();
  const tiles: DockTile[] = [];
  for (const t of rawTiles) {
    if (typeof t !== "string" || !V1_DOCK_TILE_TYPES.includes(t) || seen.has(t)) continue;
    seen.add(t);
    tiles.push({ id: idGen(t), type: t });
  }
  const autoHide: DockAutoHideMode =
    typeof o.autoHide === "boolean"
      ? o.autoHide
      : o.autoHide === "when-playing"
        ? "when-playing"
        : o.autoHide === "fullscreen" || o.autoHide === "idle"
          ? true
          : o.autoHide === "never"
            ? false
            : DOCK_DEFAULTS.autoHide;
  const isSnapValue = (v: unknown): v is DockSnap => v === "start" || v === "center" || v === "end" || v === "free";
  return {
    ...cloneDockDefaults(),
    enabled: typeof o.enabled === "boolean" ? o.enabled : DOCK_DEFAULTS.enabled,
    edge: "top",
    offset:
      typeof o.offset === "number" && Number.isFinite(o.offset)
        ? Math.min(1, Math.max(0, o.offset))
        : DOCK_DEFAULTS.offset,
    snap: isSnapValue(o.snap) ? o.snap : DOCK_DEFAULTS.snap,
    autoHide,
    tiles
  };
}

/**
 * 插入位索引（拖动预览）：指针 x 对一排按 left 排布的磁贴矩形求新磁贴应落的下标。
 * 语义：指针在某磁贴中线左侧 → 插它前面；落在中线上或右侧 → 插它后面。
 * 空列表 → 0；越过最后一枚中线 → 磁贴数。
 */
export function insertionIndexAt(rects: { left: number; width: number }[], x: number): number {
  let i = 0;
  for (const r of rects) {
    if (x < r.left + r.width / 2) break;
    i++;
  }
  return i;
}

/**
 * 沿边吸附（纯函数）：offset 为岛中心占边长的 0–1 比例，吸附点
 * start=0 / center=0.5 / end=1。像素距离 = |offset − 点| × size；与最近点
 * 距离 < threshold 时吸到该点，否则保持自由位（snap="free"，offset 原样
 * 返回并钳到 0–1）。距离并列时按 start → center → end 取先者（确定性）；
 * size 非正数时视为无吸附（free）。
 */
export function snapOffset(offset: number, size: number, threshold = 32): { offset: number; snap: DockSnap } {
  const clamped = Number.isFinite(offset) ? Math.min(1, Math.max(0, offset)) : 0.5;
  if (!Number.isFinite(size) || size <= 0) return { offset: clamped, snap: "free" };
  const points: [DockSnap, number][] = [
    ["start", 0],
    ["center", 0.5],
    ["end", 1]
  ];
  let best: [DockSnap, number] = points[0];
  let bestDist = Math.abs(clamped - best[1]) * size;
  for (const p of points.slice(1)) {
    const d = Math.abs(clamped - p[1]) * size;
    if (d < bestDist) {
      best = p;
      bestDist = d;
    }
  }
  if (bestDist < threshold) return { offset: best[1], snap: best[0] };
  return { offset: clamped, snap: "free" };
}

/* ================================================================== *
 * 二.12 「通知期间强制可见」：自动隐藏必须让位的全部条件（单一真源）
 * ------------------------------------------------------------------ */

/** 自动隐藏（QQ 式收合）必须让位、岛体强制弹出的条件集合。
 *
 * 设计原则：**弹出时机不由用户决定、且本身
 * 需要被看见 / 被点击的内容，任何自动隐藏开关都不能把它压掉**——接管条
 * （含系统通知 / 外部推送 / 链接快开 / 音量 / 亮度 / 媒体 / 番茄钟响铃全部
 * kind）、展开面、编辑模式、拖动中，一律强制岛体在屏。
 *
 * 此前该清单散写在 DockShell 的 `tucked` 行内表达式里，新增接管 kind 时
 * 容易漏更新（takeover 本身是单值，只要判空即可全 kind 覆盖，但把语义收进
 * 具名纯函数 + 穷举测试，是为了让「新增一种临时内容必须进排除清单」成为
 * 显式契约，而不是靠 review 记性）。
 */
export function dockForceVisible(s: {
  editMode: boolean;
  /** expand-store 的当前展开 id（null = 无）。 */
  expandedId: string | null;
  /** 当前接管（null = 无）。任何 kind 都算——不分优先级。 */
  takeover: TakeoverFace | null;
  dragging: boolean;
  /** 指针正在岛上（自动隐藏的弹出条件）。 */
  revealed: boolean;
}): boolean {
  return s.editMode || s.expandedId != null || s.takeover != null || s.dragging || s.revealed;
}

/**
 * 一.6 自动隐藏模式。`true` = QQ 式常驻收合（靠近弹出）；`"when-playing"`
 * = 「仅播放时显示」——媒体正在播放才弹出，暂停 / 停止 / 无会话一律收合
 * 。悬停 / 展开 / 接管等强制弹出条件不受
 * 模式影响（dockForceVisible 统一裁决）。
 */
export type DockAutoHideMode = boolean | "when-playing";

/** 收合判定（纯函数）：autoHide 关 = 永不收合；true = 常驻收合；
 * when-playing = 仅在「无正在播放的媒体」时收合。forceVisible 任一条件
 * 成立则一律不收合。 */
export function dockTucked(mode: DockAutoHideMode, mediaPlaying: boolean, forceVisible: boolean): boolean {
  if (mode === false) return false;
  if (forceVisible) return false;
  if (mode === true) return true;
  return !mediaPlaying;
}
