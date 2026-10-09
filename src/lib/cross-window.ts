import { useEffect } from "react";
import { shallow } from "zustand/shallow";
import { isTauri, currentWindowLabel } from "./tauri";
import { suspendPersistence, resumePersistence } from "./persist-gate";
import { isRemoteApplying, withRemoteApply } from "./sync-gate";
import {
  applySettings,
  repullSettingsFromLs,
  sanitizeSettings,
  scheduleSettingsSave,
  themeEnvOf,
  setExternalSettingsAdoptionHook,
  useSettingsStore
} from "../store/settings-store";
import {
  applyRemotePomodoroSnapshot,
  getLastLocalControlWallMs,
  getPomodoroControlEpoch,
  getPomodoroSyncSnapshot,
  hydrateApp,
  noteHydrationRemoteRemovals,
  readPomodoroLiveSnapshot,
  walkPomodoroDisplay,
  writePomodoroLiveSnapshot,
  useAppStore,
  type PomodoroSyncSnapshot
} from "../store/app-store";
import {
  normalizeConfig,
  type PomodoroConfig,
  type PomodoroInterruption,
  type PomodoroSessionRecord
} from "../domain/pomodoro";
import type { Deadline, Task } from "../domain/schemas";
import { applyRemoteHabits, useHabitsStore } from "../store/habits-store";
import {
  applyRemoteDock,
  applyRemoteWidgets,
  currentScreenId,
  reconcileDockTiles,
  registerDockBroadcastFlusher,
  registerWidgetsBroadcastFlusher,
  repullDockFromLs,
  repullWidgetsFromDb,
  useWidgetStore,
  type DockSyncPayload,
  type WidgetSyncPayload
} from "../widget/widget-store";

/**
 * 跨窗口实时同步：设置窗口与桌面小组件层是两个独立的 WebView，
 * 各自持有独立的 store 实例，任何一侧的修改默认另一侧都看不到
 * （这正是"设置改了桌面小组件没反应"的根因）。
 *
 * 这里通过 Tauri 事件广播 (emit 对所有窗口可见) 做双向同步：
 *  - 设置项（外观/动画/通知等）→ sync:settings
 *  - 小组件布局/视图/回收站     → sync:widgets
 *  - 视图切换（即时）           → sync:view-switch
 *  - 灵动岛配置（按屏）         → sync:dock
 *  - 任务/截止日/番茄钟配置     → sync:app
 * 应用远端状态时用 applyingRemote 标志抑制本窗口的对外广播，
 * 避免两边互相触发形成同步风暴。
 */

let applyingRemote = false;

/**
 * 回播退避（feedback 风暴阻尼）：「保留本地值 → 立即回播」是三方合并的
 * 收敛手段，但两窗口各自持更新时间戳互不相让时，立即回播会把收敛过程
 * 变成无界的乒乓广播（实测：设置里快速切换主题模式后，三窗口以 ~10Hz
 * 无限互相翻转、Rust 消息队列被打满）。这里给回播路径加指数退避：
 * 首次立即，随后 50ms → 100ms → … → 上限 2s；静默 3s 后复位。真正的
 * 用户编辑（防抖 80ms 的常规发射）不受影响——退避只作用于「收到远端
 * 包后因分歧而回播」这一条被动链路。
 */
const REPLAY_BACKOFF_BASE_MS = 50;
const REPLAY_BACKOFF_CAP_MS = 2000;
const REPLAY_BACKOFF_RESET_MS = 3000;
let replayBackoff = 0;
let replayLastAt = 0;

/** 计算下一次回播的等待（ms）；内部推进退避档位。 */
function nextReplayDelayMs(): number {
  const now = Date.now();
  if (now - replayLastAt > REPLAY_BACKOFF_RESET_MS) replayBackoff = 0;
  const delay =
    replayBackoff === 0 ? 0 : Math.min(REPLAY_BACKOFF_CAP_MS, REPLAY_BACKOFF_BASE_MS * 2 ** (replayBackoff - 1));
  replayBackoff = Math.min(12, replayBackoff + 1);
  replayLastAt = now;
  return delay;
}

/** 测试专用：复位回播退避档位（生产代码不得调用）。 */
export function resetReplayBackoffForTests(): void {
  replayBackoff = 0;
  replayLastAt = 0;
}

/**
 * 拖拽/缩放这类「编辑会话」进行中挂起 widgets 的对外广播。编辑会话里
 * instances 每帧变化（resize）时，若仍走「每帧全量 JSON.stringify + 80ms 防抖
 * emit」，序列化成本依然存在；挂起后广播仅在 pointerup 一次性发出。
 */
let widgetsSyncSuspended = false;
/** 挂起期间是否发生过被抑制的布局变化，resume 时据此补发一次最终快照。 */
let widgetsDirtyDuringSuspend = false;

/** 本窗口 widgets 快照的单调版本号，随每次 emit 自增。 */
let widgetsRev = 0;
/** 本窗口 dock 快照的单调版本号（与 widgetsRev 同型，独立计数）。 */
let dockRev = 0;

/**
 * emit 失败此前完全静默（`.catch(() => {})`），而各通道的基线推进 /
 * 墓碑重盖 / 删除凭证消费都发生在 emit **之前**——失败后后续合并判定基于
 * 虚基线、对端停留旧值且无任何证据。统一入口：失败留 warn 证据 + 300ms×n
 * 退避重发同一载荷（ts/rev 不变，接收方幂等）；重发仍失败由 onFinalFail
 * 标脏（复位去重串 / 恢复被消费的删除凭证），本窗下一次任意编辑即重播。
 */
function emitWithRetry(event: string, payload: unknown, onFinalFail?: () => void): void {
  const send = (attempt: number): void => {
    import("@tauri-apps/api/event")
      .then(({ emit }) => emit(event, payload))
      .catch((err: unknown) => {
        console.warn(`[sync] ${event} emit failed (attempt ${attempt}/3)`, err);
        if (attempt < 3) window.setTimeout(() => send(attempt + 1), 300 * attempt);
        else onFinalFail?.();
      });
  };
  send(1);
}

/** 统一 emit 入口：带上 instanceId + 单调 rev（接收方据此拒旧、拒重复）。 */
function emitWidgets(snap: {
  screenId: string;
  instances: WidgetSyncPayload["instances"];
  groups?: WidgetSyncPayload["groups"];
  views: WidgetSyncPayload["views"];
  activeView: WidgetSyncPayload["activeView"];
  trash: WidgetSyncPayload["trash"];
}) {
  const rev = ++widgetsRev;
  /* emit 终败兜底（对齐 settings/app/dock/habits 四
     通道的现有写法）。widgets 的发射侧去重是订阅闭包里的引用级短路，模块层
     没有可复位的去重串——改标挂起期脏位：终败后置位 widgetsDirtyDuringSuspend，
     下一次编辑会话结束（setWidgetsSyncSuspended(false)，每次拖拽/缩放
     pointerup 都会调）即补发一次全量快照（幂等）；期间任何真实编辑本就会因
     引用变化重新发射。语义与其他通道的「终败后下一次编辑必重播」一致。 */
  emitWithRetry(SYNC_EVENTS.widgets, { instanceId: INSTANCE_ID, rev, ...snap } as WidgetSyncPayload, () => {
    widgetsDirtyDuringSuspend = true;
  });
}

function broadcastWidgetsSnapshot() {
  const s = useWidgetStore.getState();
  emitWidgets({
    screenId: currentScreenId(),
    instances: s.instances,
    groups: s.groups,
    views: s.views,
    activeView: s.activeView,
    trash: s.trash
  });
}

/**
 * 标记小组件编辑会话边界（拖拽/缩放期间挂起跨窗口广播）。
 * 解除挂起时若期间发生过变更，补发一次最终快照（幂等，与 onDragEnd
 * 重复调用无害）——把高频拖拽期的 N 次整表广播压成 1 次。
 *
 * @param v - true 挂起；false 解除并按需补发。
 * @returns 无。
 */
export function setWidgetsSyncSuspended(v: boolean) {
  widgetsSyncSuspended = v;
  if (!v && widgetsDirtyDuringSuspend) {
    widgetsDirtyDuringSuspend = false;
    broadcastWidgetsSnapshot();
  }
}

/** 本 WebView 的实例标识。emit 时随载荷带上，接收方跳过自己的回声。 */
const INSTANCE_ID =
  typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `win-${Math.random().toString(36).slice(2)}`;

/** 同步事件名单点定义，替代散布 7 处的魔法字符串。 */
export const SYNC_EVENTS = {
  settings: "sync:settings",
  widgets: "sync:widgets",
  viewSwitch: "sync:view-switch",
  dock: "sync:dock",
  app: "sync:app",
  pomodoro: "sync:pomodoro",
  /** （副屏统计即时刷新）：单条新完成的专注会话记录（增量广播，
   *  receiver 按 id 去重 append——sessions 整表不在 AppSyncPayload 里，
   *  副屏「今日 N 轮/时长」此前要等本窗重启才刷新）。 */
  session: "sync:session",
  /** （打断统计跨窗同步）：单条新打断记录（receiver 按起始/结束/原因
   *  组合键去重 append——副窗口的中断计数与月度打断图即时刷新）。 */
  interruption: "sync:interruption",
  habits: "sync:habits"
} as const;

/** 同步字段清单（单点定义）。：export 供防漂移锁测试遍历——
 *  snapshotFor 每新增一个持久化字段而漏更此清单时，测试必红（漏同步的
 *  字段在其他窗口保持旧值直到重启，如此前漏 floatingThemeMode）。 */
export const SETTINGS_FIELDS = [
  "preset",
  "themeMode",
  // [SPLIT-THEME] 浮窗深浅档（消费方 app/FloatingThemeSync.tsx）：漏进清单时
  // 设置窗改档后其他浮窗保持旧档直到重启（修复的正是这一例）。
  "floatingThemeMode",
  "primaryColor",
  // 自定义主题的底色/文字配色：与 preset 配对（preset="custom" 时由它供色）——
  // 漏进同步清单时设置窗改色后其他窗口保持旧色直到重启。
  "customColors",
  "zoom",
  "font",
  "fontSize",
  "widgetBackground",
  "widgetOpacity",
  "settingsWindowOpacity",
  // 壁纸挑选偏好（样式页「壁纸」区）：文件夹路径 + 最近使用路径表。
  "wallpaperFolder",
  "recentWallpapers",
  "cornerRadius",
  "spacing",
  "blur",
  "general",
  "extra",
  "notifications",
  "shortcuts",
  // 应用内快捷键（窗口 keydown：切视图/命令面板/设置搜索/退出编辑）：与
  // shortcuts 同步——设置窗改键后其他窗口的处理器要实时跟随，不重启。
  "appShortcuts"
] as const;

/** 同步字段快照类型由 SETTINGS_FIELDS 单点派生，字段增删只改这一处。 */
export type SettingsSnapshot = Record<(typeof SETTINGS_FIELDS)[number], unknown>;

/** settings 同步载荷：字段快照 + 发送方 instanceId + 发送时刻（并发仲裁用）。 */
export type SettingsSyncPayload = SettingsSnapshot & { instanceId?: string; ts?: number };
/** 视图切换载荷：任一窗口主动切换视图时即时广播，接收方据此真正切换本地视图。 */
export type ViewSwitchSyncPayload = {
  instanceId?: string;
  /** 所属屏幕分区；接收方只采纳与自己同屏的切换（多屏视图互相独立）。 */
  screenId: string;
  view: string;
};
/** app 同步载荷：任务 / 截止日 / 番茄钟配置快照 + 删除凭证。 */
export type AppSyncPayload = {
  instanceId?: string;
  /** 发送时刻单调时间戳：既用于拒乱序旧包（-DDL），也是本包内所有变更行/
   *  叶子/删除的统一仲裁时刻（发送方发射时把本地改动的时间戳重盖为它，使同一
   *  个值在两端拿到相同的 ts，并发冲突两端才能选出同一个赢家）。 */
  ts?: number;
  /** 本防抖窗口内被发送方删除的行 id。接收方无法从「整表缺行」推断删除（可能
   *  只是发送方还没看到新增），删除必须携带显式凭证；缺行不再推断为删除。 */
  removedTasks?: string[];
  removedDeadlines?: string[];
  tasks?: Task[];
  deadlines?: Deadline[];
  pomodoroConfig?: PomodoroConfig;
};
/** 番茄钟运行态载荷。快照带墙钟锚点，接收方据此走秒与正确暂停。 */
export type PomodoroSyncPayload = PomodoroSyncSnapshot & {
  instanceId?: string;
  /** 发送时刻的 Date.now()，接收方拒乱序到达的旧快照。 */
  wallMs?: number;
  /** 控制态包（sig 变化：开始/暂停/模式/任务/正倒计时切换）为 true；
   *  纯锚点包（走秒降频重发）为 false。接收方对控制包做严格纪元仲裁，
   *  对锚点包只比对已应用的远端纪元（见 u4 注释）。旧版本载荷缺省
   *  undefined，按控制包严格处理，行为与历史版本一致。 */
  control?: boolean;
};
/** §4.14 习惯打卡载荷：与 widgets 通道同型的按发送方单调 rev（此前 last-writer-wins，
 *  两窗口连续打卡时乱序到达的旧整表会把新打卡回滚）。 */
export type HabitsSyncPayload = {
  instanceId?: string;
  /** 发送方本地单调递增；接收方按发送方记忆上次已应用的 rev，拒旧拒重。 */
  rev?: number;
  habits?: unknown;
};

/** §4.14：本窗口 habits 快照的单调版本号，随每次 emit 自增。 */
let habitsRev = 0;

/** 从 settings store 抽取全部同步字段（单点派生，替代手写 3 处字段清单）。 */
function pickSettingsFields(s: ReturnType<typeof useSettingsStore.getState>): SettingsSnapshot {
  const rec = s as unknown as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const f of SETTINGS_FIELDS) out[f] = rec[f];
  return out as SettingsSnapshot;
}

/* ============ 三方合并基础设施（settings / app 两通道共用） ============ */

/** 一个已交换值的记忆：JSON 串 + 该值的时间戳（本地编辑时刻 / 发射包 ts / 采纳的远端包 ts）。 */
export type LeafMem = { json: string; ts: number };

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * 「原子叶子」路径：这些映射表字段整体作为一个叶子参与合并，不再摊平成逐键叶子。
 * 必须如此的原因（fxToggles 全开丢失缺陷）：布尔开关表以「缺键 = 开启」编码——
 * `fxToggles = {}`（全部开启）摊平后没有任何叶子，「删掉键」这个动作在叶子级
 * 合并里不可表达：本地删了键、远端基线里还有该键，合并时按「远端有本地无」
 * 采纳远端的 false，开关被静默打回关闭——「全部开启要点好几次、动不动全部
 * 关闭」的根因。整体成一个叶子后，空表与非空表都是可比较、可传播的值。
 */
const ATOMIC_LEAF_PATHS: ReadonlySet<string> = new Set(["extra.fxToggles", "notifications.sources"]);

/**
 * 规范化 JSON：对象键按字典序输出后再序列化。
 * 叶子比对必须与键序无关：同一份 `weatherCities` / `notifications.sources`
 * 在两窗口可能持有不同键序（本地 sanitize 的字面量序 vs 载荷线序 vs 持久化
 * 序）——按原始 JSON.stringify 比较会永远「不相等」，每次交换都被当成变更、
 * 每次采纳又被 sanitize 重排，形成永不收敛的回播乒乓（设置快速切换后
 * 无限来回翻转风暴的根因）。数组保序（顺序即语义）。
 */
function canonicalize(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonicalize);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(v as Record<string, unknown>).sort()) {
      out[key] = canonicalize((v as Record<string, unknown>)[key]);
    }
    return out;
  }
  return v;
}

function jsonOf(v: unknown): string {
  return JSON.stringify(canonicalize(v)) ?? "";
}

/**
 * 把普通对象按「点分路径 → 叶子值」一维化（数组与原始值视为叶子，undefined 跳过）。
 * settings 的 general/extra/notifications/shortcuts 是嵌套对象，比较与合并粒度
 * 由此从顶层字段下沉到子键：两窗口改同一嵌套对象的不同子键不再互相回滚。
 * {@link ATOMIC_LEAF_PATHS} 命中的路径例外：整个子对象作为一个叶子。
 */
export function flattenLeaves(value: unknown, prefix = "", out = new Map<string, unknown>()): Map<string, unknown> {
  if (isPlainObject(value)) {
    if (prefix && ATOMIC_LEAF_PATHS.has(prefix)) {
      out.set(prefix, value);
      return out;
    }
    for (const [k, v] of Object.entries(value)) flattenLeaves(v, prefix ? `${prefix}.${k}` : k, out);
  } else if (prefix && value !== undefined) {
    out.set(prefix, value);
  }
  return out;
}

/** 沿点分路径不可变写入叶子：只浅克隆路径上的各层，未触及的子树引用不变。 */
function setLeaf(root: Record<string, unknown>, parts: string[], value: unknown): Record<string, unknown> {
  const [head, ...rest] = parts;
  if (rest.length === 0) return { ...root, [head]: value };
  const child = root[head];
  return { ...root, [head]: setLeaf(isPlainObject(child) ? child : {}, rest, value) };
}

/**
 * 并发冲突仲裁：(ts, json) 字典序更大者胜。两窗口对同一叶子/行的并发编辑，
 * 双方拿到相同输入必得相同赢家——不会像「后到者胜」那样两端各选各的而永久分叉。
 */
function remoteWins(localTs: number, localJson: string, remoteTs: number, remoteJson: string): boolean {
  if (remoteTs !== localTs) return remoteTs > localTs;
  return remoteJson > localJson;
}

export type LeafMergeResult = {
  /** 合并后的顶层对象（沿改动路径不可变重建）。 */
  next: Record<string, unknown>;
  /** 合并结果与本地是否有差异（无差异则跳过 setState，避免多余重绘）。 */
  changed: boolean;
  /** 保留了与远端不同的本地值 ⇒ 对端缺我方最新值，需回播一次。 */
  diverged: boolean;
  /** 合并后的新基线（下一次三方比对的共同祖先）。 */
  base: Map<string, LeafMem>;
  /** 各叶子当前值的时间戳（采纳远端者取远端包 ts）。 */
  editTs: Map<string, number>;
};

/**
 * 叶子级三方合并（纯函数）。base 是双方上次交换的共同祖先——只在发射/采纳时
 * 更新，**本地编辑不更新**。旧实现在编辑瞬间就把基线同步成本地值，使
 * 「本地 ≠ 基线」恒假，所谓字段级回退保护从未生效过（任何并发包都整包采纳）。
 *  - 远端相对基线没变 → 保留本地（含仅本地变了的情形，回播由 diverged 触发）；
 *  - 远端相对基线变了 → 按 (ts, json) 与本地当前值仲裁：远端更新则采纳，否则
 *    保留本地并回播——第三个窗口迟到的陈旧包（ts 更旧）不会回滚已采纳的新值；
 *  - 远端缺该叶子（旧版本载荷）→ 保留本地；本地缺（新版本新增键）→ 采纳远端。
 */
export function mergeLeaves(
  local: Record<string, unknown>,
  remote: Record<string, unknown>,
  base: Map<string, LeafMem>,
  editTs: Map<string, number>,
  remoteTs: number
): LeafMergeResult {
  const localLeaves = flattenLeaves(local);
  const remoteLeaves = flattenLeaves(remote);
  const nextBase = new Map<string, LeafMem>();
  const nextEditTs = new Map(editTs);
  let next = local;
  let changed = false;
  let diverged = false;
  for (const path of new Set([...localLeaves.keys(), ...remoteLeaves.keys()])) {
    const hasLocal = localLeaves.has(path);
    const hasRemote = remoteLeaves.has(path);
    const localVal = localLeaves.get(path);
    const remoteVal = remoteLeaves.get(path);
    const localJson = jsonOf(localVal);
    const remoteJson = jsonOf(remoteVal);
    const mem = base.get(path);
    const localTs = editTs.get(path) ?? mem?.ts ?? 0;
    let takeRemote: boolean;
    if (!hasRemote) takeRemote = false;
    else if (!hasLocal) {
      // 远端有、本地无（对端新增叶子）无条件采纳——sanitize 白名单
      // 兜底最终值，但静默采纳不可观测；留 debug 级观测点（生产零噪声，
      // 排查「设置项凭空出现」时可开）。
      console.debug("[sync] mergeLeaves: adopting remote-only leaf", path);
      takeRemote = true;
    } else {
      const remoteChanged = !mem || remoteJson !== mem.json;
      takeRemote = remoteChanged && remoteWins(localTs, localJson, remoteTs, remoteJson);
      if (!takeRemote && remoteJson !== localJson) diverged = true;
    }
    if (takeRemote) {
      nextBase.set(path, { json: remoteJson, ts: remoteTs });
      nextEditTs.set(path, remoteTs);
      if (remoteJson !== localJson) {
        changed = true;
        next = setLeaf(next, path.split("."), remoteVal);
      }
    } else {
      nextBase.set(path, { json: localJson, ts: localTs });
    }
  }
  return { next, changed, diverged, base: nextBase, editTs: nextEditTs };
}

/** 对比前后快照，给本地刚改动的叶子盖上编辑时刻（供并发仲裁；不动基线）。 */
/**
 * 顶层 section 的「相对路径 → 规范化串」视图，按对象引用备忘。
 * Zustand 不可变更新语义下未变 section 的引用稳定——逐键编辑 / 拖滑条
 * 时订阅期盖章只重算被写的 section，不再每次全表 flatten + canonicalize
 * ×2（~200 叶）。原始值顶层字段（preset/themeMode 等）整体视为单叶子。
 */
const sectionLeavesMemo = new WeakMap<object, Map<string, string>>();

function sectionLeaves(value: unknown): Map<string, string> {
  if (value !== null && typeof value === "object") {
    let m = sectionLeavesMemo.get(value as object);
    if (!m) {
      m = new Map();
      for (const [path, v] of flattenLeaves(value)) m.set(path, jsonOf(v));
      sectionLeavesMemo.set(value as object, m);
    }
    return m;
  }
  return new Map([["", JSON.stringify(value) ?? ""]]);
}

function stampLeafEdits(prev: unknown, curr: unknown, editTs: Map<string, number>, now: number) {
  if (!isPlainObject(prev) || !isPlainObject(curr)) return;
  const p = prev as Record<string, unknown>;
  const c = curr as Record<string, unknown>;
  for (const k of Object.keys(c)) {
    // 引用未变 ⇒ 内容未变（不可变语义），整节跳过；undefined 叶子与
    // flattenLeaves 同口径跳过。
    if (p[k] === c[k] || c[k] === undefined) continue;
    const before = sectionLeaves(p[k]);
    for (const [sub, json] of sectionLeaves(c[k])) {
      if (before.get(sub) !== json) editTs.set(sub ? `${k}.${sub}` : k, now);
    }
  }
}

/**
 * 发射后把叶子基线对齐到刚发出的快照，并把「自上次交换以来改过」的叶子时间戳
 * 重盖为本包 ts：接收方采纳时记的正是包 ts，同一个值两端 ts 一致，后续并发
 * 仲裁才不会因两端持有不同时间戳而各选各的。
 * 回播（isReplay）例外：被保留的本地值多源于早于对端的编辑（或晚到的水合），
 * 若随回播把它们的 ts 重盖为「现在」，陈旧值就永远赢过对端真正更新的值——
 * 这是互不相让的乒乓风暴的时间戳放大器。回播只对齐基线、不刷新编辑时刻。
 */
function syncLeafBase(
  snap: unknown,
  base: Map<string, LeafMem>,
  editTs: Map<string, number>,
  packetTs: number,
  isReplay = false
): Map<string, LeafMem> {
  const next = new Map<string, LeafMem>();
  for (const [path, v] of flattenLeaves(snap)) {
    const json = jsonOf(v);
    const prev = base.get(path);
    if (!prev || prev.json !== json) {
      if (!isReplay) editTs.set(path, packetTs);
    }
    next.set(path, { json, ts: editTs.get(path) ?? prev?.ts ?? 0 });
  }
  return next;
}

/* ============ settings 通道：叶子级三方合并 ============ */

/** 上次与对端交换（发射或采纳）的设置叶子基线；本地编辑不更新（见 mergeLeaves）。 */
let settingsBase = new Map<string, LeafMem>();
/** 各设置叶子当前值的时间戳（本地编辑 = 编辑时刻；发射后 = 包 ts；采纳远端 = 远端包 ts）。 */
let settingsEditTs = new Map<string, number>();

function snapshotSettings(): SettingsSnapshot {
  return pickSettingsFields(useSettingsStore.getState());
}

/** 回播用的独立定时器（与用户编辑的 80ms 防抖互不抢占）。 */
let settingsReplayTimer = 0;

/** 发射设置快照。isReplay = 分歧回播：不重盖编辑时间戳（见 syncLeafBase），经退避调度。 */
function emitSettings(isReplay = false) {
  const snap = snapshotSettings();
  const ts = Date.now();
  settingsBase = syncLeafBase(snap, settingsBase, settingsEditTs, ts, isReplay);
  // 重发仍失败 → 复位去重串，本窗下一次任意编辑必重播。
  emitWithRetry(SYNC_EVENTS.settings, { instanceId: INSTANCE_ID, ts, ...snap } satisfies SettingsSyncPayload, () => {
    lastSettingsJson = "";
  });
}

/** 分歧回播入口：按指数退避调度（立即 → 50ms → … → 2s 封顶）。 */
function replaySettings() {
  const delay = nextReplayDelayMs();
  if (delay === 0) {
    emitSettings(true);
    return;
  }
  if (settingsReplayTimer) return; // 已有待发的回播：新分歧会体现在那一次快照里
  settingsReplayTimer = window.setTimeout(() => {
    settingsReplayTimer = 0;
    emitSettings(true);
  }, delay);
}

/**
 * 应用远端设置快照（叶子级三方合并版）。只取 SETTINGS_FIELDS 内的字段（未知
 * 顶层键与 instanceId/ts 不进合并），远端缺字段时保留本地（兼容旧载荷），再统一
 * 过 sanitizeSettings。合并结果与本地无差异（对端回声/重复广播）时跳过 setState
 * ——无意义的全量 applySettings 重放会触发一次全窗样式重算，视觉上就是闪动。
 * 保留了本地更新值时回播一次让对端收敛（直接 emit，订阅广播在 applyingRemote
 * 期间被抑制）。
 */
function applyRemoteSettings(payload: Partial<SettingsSnapshot>, remoteTs: number) {
  const current = useSettingsStore.getState() as unknown as Record<string, unknown>;
  const remote: Record<string, unknown> = {};
  for (const field of SETTINGS_FIELDS) if (payload[field] !== undefined) remote[field] = payload[field];
  const result = mergeLeaves(snapshotSettings(), remote, settingsBase, settingsEditTs, remoteTs);
  settingsBase = result.base;
  settingsEditTs = result.editTs;
  if (result.changed) {
    const applied = sanitizeSettings({ ...current, ...result.next });
    useSettingsStore.setState(applied as never);
    const __st = useSettingsStore.getState();
    applySettings(__st, themeEnvOf(__st), __st.general.reduceEffects);
    // 采纳后的快照串同步进去重短路，防后续等值编辑被漏播（见声明处注释）。
    // 去重串与合并口径统一走 canonicalize（键序无关）。
    lastSettingsJson = jsonOf(snapshotSettings());
    // 采纳即落盘：本地 setter 之外的唯一状态入口也要回写持久层（并发
    // 整快照 last-writer-wins——否则磁盘停在旧快照，重启回档）。
    scheduleSettingsSave();
  }
  if (result.diverged) replaySettings();
}

/** 挂载：以当前设置为基线（ts=0：各窗口同源于持久化存储，视为无编辑）。 */
function seedSettingsBase() {
  settingsEditTs = new Map();
  settingsBase = syncLeafBase(snapshotSettings(), new Map(), new Map(), 0);
}

/**
 * 静默采纳外部权威快照（LS 回读 repullSettingsFromLs / DB 水合）后
 * 推进同步基线（发射侧去重通例，dock/habits 通道同款收口）：刷新
 * lastSettingsJson 短路串并重播 settingsBase 种子——否则回读后用户改回
 * 「本窗上次发射过的值」会被误判重复而漏播，对端停留在旧值直到下一次
 * 不同的编辑。settings-store 经 setExternalSettingsAdoptionHook 反向注册
 * （依赖倒置防循环 import，click-shield 同款）。
 */
export function noteExternalSettingsAdoption(): void {
  lastSettingsJson = jsonOf(snapshotSettings());
  seedSettingsBase();
}

/* ============ sync:app 通道：行级三方合并 + 显式删除凭证 + 墓碑 ============ */

/** 任务 / 截止日各行「上次交换」的基线（id → JSON+ts）。已删行的基线在墓碑有效期内
 *  保留，供「对端在我删除之后又改了这行」的仲裁使用。 */
let tasksBase = new Map<string, LeafMem>();
let deadlinesBase = new Map<string, LeafMem>();
/** 各行当前值的时间戳（本地编辑 = 编辑时刻；发射后 = 包 ts；采纳远端 = 远端包 ts）。 */
let tasksTs = new Map<string, number>();
let deadlinesTs = new Map<string, number>();
/** 番茄钟配置叶子基线 / 时间戳（与 settings 同一套叶子级合并）。 */
let configBase = new Map<string, LeafMem>();
let configEditTs = new Map<string, number>();
/** 本防抖窗口内本地删除、尚未随包发出的行 id（发射时作为删除凭证带出）。 */
let pendingRemovedTasks = new Set<string>();
let pendingRemovedDeadlines = new Set<string>();

/**
 * 已删行墓碑（id → 删除时刻；发射后重盖为包 ts）。行级合并下，迟到的陈旧整包若
 * 仍带着已删行，仅凭基线分不清「远端新增」与「删除前的旧包」——墓碑是防复活的
 * 最后闸门。TTL 内有效，过期即信任远端（id 为随机 uid，正常操作撞不上过期墓碑）。
 */
const appTombstones = new Map<string, number>();
const APP_TOMBSTONE_TTL_MS = 30_000;

/** 导出仅供测试（TTL 边界用例）。 */
export function pruneAppTombstones(now: number) {
  for (const [id, at] of appTombstones) if (now - at > APP_TOMBSTONE_TTL_MS) appTombstones.delete(id);
}

/** 行对象的规范化串备忘（按行引用）——对比前后整表时未变行引用
 *  稳定，只有被写/新增行需要序列化。 */
const rowJsonMemo = new WeakMap<object, string>();

function rowJsonOf(r: { id: string }): string {
  if (r !== null && typeof r === "object") {
    let s = rowJsonMemo.get(r);
    if (s === undefined) {
      s = jsonOf(r);
      rowJsonMemo.set(r, s);
    }
    return s;
  }
  return jsonOf(r);
}

/** 对比前后整表：改动/新增的行盖编辑时刻，消失的行记墓碑并进入待发删除凭证（不动基线）。 */
function stampRowEdits<T extends { id: string }>(
  prev: T[],
  curr: T[],
  rowTs: Map<string, number>,
  pendingRemoved: Set<string>,
  now: number
) {
  const before = new Map(prev.map((r) => [r.id, rowJsonOf(r)]));
  const currIds = new Set<string>();
  for (const row of curr) {
    currIds.add(row.id);
    const b = before.get(row.id);
    if (b === undefined) {
      // 新增（或删后重加）：撤销可能存在的墓碑与待发删除凭证。
      appTombstones.delete(row.id);
      pendingRemoved.delete(row.id);
      rowTs.set(row.id, now);
    } else if (b !== rowJsonOf(row)) {
      rowTs.set(row.id, now);
    }
  }
  for (const id of before.keys()) {
    if (currIds.has(id)) continue;
    rowTs.delete(id);
    appTombstones.set(id, now);
    pendingRemoved.add(id);
  }
}

/** 发射后对齐行基线（同 syncLeafBase）：改过的行时间戳重盖为包 ts（回播不重盖，
 *  理由见 syncLeafBase 的 isReplay 注释）；已删行的旧基线在墓碑有效期内保留。 */
function syncRowBase<T extends { id: string }>(
  rows: T[],
  base: Map<string, LeafMem>,
  rowTs: Map<string, number>,
  packetTs: number,
  isReplay = false
): Map<string, LeafMem> {
  const next = new Map<string, LeafMem>();
  for (const row of rows) {
    /* 行基线对齐改走 rowJsonOf（WeakMap 按行引用
       备忘，同源）——每包全表 canonicalize+stringify 的热路径中，未变行
       引用稳定直接命中备忘；产出与 jsonOf 逐字节同构（同一函数算出后缓存）。 */
    const json = rowJsonOf(row);
    const prev = base.get(row.id);
    if ((!prev || prev.json !== json) && !isReplay) rowTs.set(row.id, packetTs);
    next.set(row.id, { json, ts: rowTs.get(row.id) ?? prev?.ts ?? 0 });
  }
  for (const [id, mem] of base) {
    if (!next.has(id) && appTombstones.has(id)) next.set(id, mem);
  }
  return next;
}

export type RowMergeResult<T> = {
  merged: T[];
  changed: boolean;
  diverged: boolean;
  base: Map<string, LeafMem>;
  rowTs: Map<string, number>;
  /** 因采纳远端删除凭证而移除的行 id（调用方记墓碑）。 */
  tombstoned: string[];
  /** 对端在我删除之后又编辑、按仲裁复活采纳的行 id（调用方撤墓碑）。 */
  revived: string[];
  /** 命中墓碑被拒收的行 id——拒收证明删除凭证仍被需要，调用方滑动
   *  续期墓碑时刻；否则 30s TTL 过期后，链式重播/休眠唤醒积压的同一陈旧
   *  包可让已删行复活。 */
  renewedTombstones: string[];
};

/**
 * 行级三方合并（纯函数；tombstones 只读）：
 *  - 同 id 并存：与 mergeLeaves 同一套「远端相对基线没变 → 保留本地；变了 → 按
 *    (ts,json) 与本地当前值仲裁」；
 *  - 本地有、远端无：仅当远端带显式删除凭证才删（本地在基线后又编辑且编辑晚于删除
 *    时编辑胜，保留并回播）；无凭证 ⇒ 对端还没看到这行，保留（基线里已有 ⇒ 对端
 *    漏了，回播补齐）；
 *  - 远端有、本地无：命中有效墓碑 ⇒ 陈旧包，拒收防复活（除非对端在删除之后又改了
 *    它——按包 ts 仲裁，编辑胜则复活采纳）；否则视为远端新增，采纳。
 */
export function mergeRows<T extends { id: string }>(
  local: T[],
  remote: T[] | undefined,
  removedIds: string[] | undefined,
  base: Map<string, LeafMem>,
  rowTs: Map<string, number>,
  tombstones: Map<string, number>,
  remoteTs: number
): RowMergeResult<T> {
  if (!remote)
    return {
      merged: local,
      changed: false,
      diverged: false,
      base,
      rowTs,
      tombstoned: [],
      revived: [],
      renewedTombstones: []
    };
  const removed = new Set(removedIds ?? []);
  const remoteMap = new Map(remote.map((r) => [r.id, r]));
  const localIds = new Set(local.map((r) => r.id));
  const nextBase = new Map<string, LeafMem>();
  const nextTs = new Map(rowTs);
  const tombstoned: string[] = [];
  const revived: string[] = [];
  const renewedTombstones: string[] = [];
  const merged: T[] = [];
  let changed = false;
  let diverged = false;

  for (const row of local) {
    const id = row.id;
    /* 本地行改走 rowJsonOf 备忘（行对象不可变更新，
       引用即版本；后续 emitApp → syncRowBase 对同一批行对象二次序列化时直接
       命中，不再每包 2-3 次全量 canonicalize+stringify）。 */
    const localJson = rowJsonOf(row);
    const mem = base.get(id);
    const localTs = rowTs.get(id) ?? mem?.ts ?? 0;
    const localChanged = !mem || localJson !== mem.json;
    const r = remoteMap.get(id);
    if (r !== undefined) {
      /* 远端行同样走备忘——与基线串（jsonOf/rowJsonOf 同构产出）的
         逐字节比较语义不变。 */
      const remoteJson = rowJsonOf(r);
      const remoteChanged = !mem || remoteJson !== mem.json;
      const takeRemote = remoteChanged && remoteWins(localTs, localJson, remoteTs, remoteJson);
      if (takeRemote) {
        merged.push(r);
        nextBase.set(id, { json: remoteJson, ts: remoteTs });
        nextTs.set(id, remoteTs);
        if (remoteJson !== localJson) changed = true;
      } else {
        merged.push(row);
        nextBase.set(id, { json: localJson, ts: localTs });
        if (remoteJson !== localJson) diverged = true;
      }
      continue;
    }
    if (removed.has(id)) {
      if (localChanged && localTs > remoteTs) {
        merged.push(row);
        nextBase.set(id, { json: localJson, ts: localTs });
        diverged = true;
      } else {
        changed = true;
        tombstoned.push(id);
        nextTs.delete(id);
        if (mem) nextBase.set(id, mem);
      }
      continue;
    }
    merged.push(row);
    nextBase.set(id, { json: localJson, ts: localTs });
    if (mem) diverged = true;
  }

  for (const r of remote) {
    const id = r.id;
    if (localIds.has(id)) continue;
    /* 远端独有行的序列化同样换 rowJsonOf 备忘。 */
    const remoteJson = rowJsonOf(r);
    const delTs = tombstones.get(id);
    if (delTs !== undefined) {
      const mem = base.get(id);
      const editedAfterDelete = !!mem && remoteJson !== mem.json && remoteTs > delTs;
      if (!editedAfterDelete) {
        if (mem) nextBase.set(id, mem);
        renewedTombstones.push(id);
        continue;
      }
      revived.push(id);
    }
    merged.push(r);
    nextBase.set(id, { json: remoteJson, ts: remoteTs });
    nextTs.set(id, remoteTs);
    changed = true;
  }
  return { merged, changed, diverged, base: nextBase, rowTs: nextTs, tombstoned, revived, renewedTombstones };
}

type AppSnapshot = { tasks: Task[]; deadlines: Deadline[]; pomodoroConfig: PomodoroConfig };

function snapshotApp(): AppSnapshot {
  const s = useAppStore.getState();
  return { tasks: s.tasks, deadlines: s.deadlines, pomodoroConfig: s.pomodoroConfig };
}

/** 挂载：以当前整表为基线（ts=0：各窗口同源于持久化存储，视为无编辑）。 */
function seedAppBase() {
  const s = snapshotApp();
  tasksBase = new Map(s.tasks.map((t) => [t.id, { json: jsonOf(t), ts: 0 }]));
  deadlinesBase = new Map(s.deadlines.map((d) => [d.id, { json: jsonOf(d), ts: 0 }]));
  configBase = syncLeafBase(s.pomodoroConfig, new Map(), new Map(), 0);
  tasksTs = new Map();
  deadlinesTs = new Map();
  configEditTs = new Map();
  pendingRemovedTasks = new Set();
  pendingRemovedDeadlines = new Set();
}

/** 回播定时器（与用户编辑的 80ms 防抖互不抢占）。注释更正：定时器与
 *  settings 各自独立，但退避档位与 replaySettings 共用同一 replayBackoff
 *  梯子（50ms→2s 封顶、3s 静默复位）——两通道交错分歧时各自爬梯更快，
 *  行为仍收敛（封顶即上限）。 */
let appReplayTimer = 0;

/** 发射 app 快照。isReplay = 分歧回播：不重盖行/叶子时间戳（防乒乓放大）。 */
function emitApp(isReplay = false) {
  const s = snapshotApp();
  const ts = Date.now();
  const removedTasks = [...pendingRemovedTasks];
  const removedDeadlines = [...pendingRemovedDeadlines];
  pendingRemovedTasks = new Set();
  pendingRemovedDeadlines = new Set();
  // 删除时刻统一重盖为包 ts：对端拿到的删除凭证就是这个 ts，两端「编辑 vs 删除」
  // 的仲裁口径才一致。
  for (const id of removedTasks) appTombstones.set(id, ts);
  for (const id of removedDeadlines) appTombstones.set(id, ts);
  tasksBase = syncRowBase(s.tasks, tasksBase, tasksTs, ts, isReplay);
  deadlinesBase = syncRowBase(s.deadlines, deadlinesBase, deadlinesTs, ts, isReplay);
  configBase = syncLeafBase(s.pomodoroConfig, configBase, configEditTs, ts, isReplay);
  // 重发仍失败 → 恢复被消费的删除凭证（否则删除永远传不出去）+
  // 复位去重串，本窗下一次任意编辑必重播。
  emitWithRetry(
    SYNC_EVENTS.app,
    {
      instanceId: INSTANCE_ID,
      ts,
      removedTasks,
      removedDeadlines,
      ...s
    } satisfies AppSyncPayload,
    () => {
      pendingRemovedTasks = new Set([...pendingRemovedTasks, ...removedTasks]);
      pendingRemovedDeadlines = new Set([...pendingRemovedDeadlines, ...removedDeadlines]);
      lastAppJson = "";
    }
  );
}

/** 分歧回播入口：指数退避调度（与 replaySettings 同型）。 */
function replayApp() {
  const delay = nextReplayDelayMs();
  if (delay === 0) {
    emitApp(true);
    return;
  }
  if (appReplayTimer) return;
  appReplayTimer = window.setTimeout(() => {
    appReplayTimer = 0;
    emitApp(true);
  }, delay);
}

/**
 * （行级守卫）：sync:app 的行载荷虽来自另一窗口的内存态，仍是「线上数据」
 * 坏行（旧版本/损坏的载荷）不校验就会经 persist-first 动作写进 SQLite。
 * 手写轻量守卫而非 zod：主包不静态引入 zod（与 local-storage 的动态 import
 * 纪律一致）；这里只挡类型级垃圾，ISO 格式等严检仍由持久化/导入边界负责。
 */
function isTaskLike(r: unknown): r is Task {
  if (typeof r !== "object" || r === null) return false;
  const t = r as Record<string, unknown>;
  return (
    typeof t.id === "string" &&
    t.id.length > 0 &&
    typeof t.title === "string" &&
    typeof t.completed === "boolean" &&
    typeof t.createdAt === "string" &&
    typeof t.dueAt === "string" &&
    typeof t.priority === "number" &&
    Array.isArray(t.tags) &&
    typeof t.sortOrder === "number"
  );
}

function isDeadlineLike(r: unknown): r is Deadline {
  if (typeof r !== "object" || r === null) return false;
  const d = r as Record<string, unknown>;
  return (
    typeof d.id === "string" &&
    d.id.length > 0 &&
    typeof d.title === "string" &&
    typeof d.dueAt === "string" &&
    typeof d.notified === "boolean" &&
    typeof d.completed === "boolean" &&
    Array.isArray(d.notifiedTiers) &&
    typeof d.repeat === "string"
  );
}

/** 过滤远端行：坏行丢弃并记日志，不让单行垃圾污染整包三方合并。 */
function sanitizeRemoteRows<T>(rows: unknown, guard: (r: unknown) => r is T, label: string): T[] | undefined {
  if (!Array.isArray(rows)) return undefined;
  const ok = rows.filter(guard);
  if (ok.length !== rows.length) {
    console.warn(`sync:app dropped ${rows.length - ok.length} malformed ${label} row(s)`);
  }
  return ok;
}

/**
 * 应用远端 app 快照：任务/截止日按行三方合并，番茄钟配置按叶子三方合并。
 * 返回是否需要回播（保留了对端没有的本地更新值）。
 */
function applyRemoteApp(payload: AppSyncPayload, remoteTs: number): boolean {
  /* 水合窗口内到达的删除凭证先并入水合墓碑（本窗内存尚无这些行，
     mergeRows 不会为不存在的行立墓碑——否则随后落地的陈旧 DB 快照会把
     已删行 merge 回内存且 withRemoteApply 抑制再广播，复活滞留到重启）。
     水合墓碑只影响本次水合的 mergeById——水合结束
     后，持有旧内存的第三个窗口发来的陈旧整包仍带着已删行，而 appTombstones
     无记录会被 mergeRows 当「远端新增」采纳并回播扩散。凭证生效时同步镜像
     进 appTombstones（Date.now() 口径与 tombstoned 写入一致；的拒收
     滑动续期照常覆盖它，30s TTL 后回归「信任远端」的既定语义）。 */
  const hydrationNoted = noteHydrationRemoteRemovals(payload.removedTasks, payload.removedDeadlines);
  if (hydrationNoted) {
    const mirrorAt = Date.now();
    if (Array.isArray(payload.removedTasks)) for (const id of payload.removedTasks) appTombstones.set(id, mirrorAt);
    if (Array.isArray(payload.removedDeadlines))
      for (const id of payload.removedDeadlines) appTombstones.set(id, mirrorAt);
  }
  const current = snapshotApp();
  pruneAppTombstones(Date.now());
  const tm = mergeRows(
    current.tasks,
    sanitizeRemoteRows(payload.tasks, isTaskLike, "task"),
    payload.removedTasks,
    tasksBase,
    tasksTs,
    appTombstones,
    remoteTs
  );
  const dm = mergeRows(
    current.deadlines,
    sanitizeRemoteRows(payload.deadlines, isDeadlineLike, "deadline"),
    payload.removedDeadlines,
    deadlinesBase,
    deadlinesTs,
    appTombstones,
    remoteTs
  );
  const cm = mergeLeaves(
    current.pomodoroConfig as unknown as Record<string, unknown>,
    (payload.pomodoroConfig ?? {}) as unknown as Record<string, unknown>,
    configBase,
    configEditTs,
    remoteTs
  );
  tasksBase = tm.base;
  tasksTs = tm.rowTs;
  deadlinesBase = dm.base;
  deadlinesTs = dm.rowTs;
  configBase = cm.base;
  configEditTs = cm.editTs;
  for (const id of tm.tombstoned) appTombstones.set(id, remoteTs);
  for (const id of dm.tombstoned) appTombstones.set(id, remoteTs);
  for (const id of tm.revived) appTombstones.delete(id);
  for (const id of dm.revived) appTombstones.delete(id);
  // 墓碑拒收滑动续期——拒收证明删除凭证仍被需要，不续期则 30s 后
  // 同一陈旧包（链式重播/休眠唤醒积压）可复活已删行。
  const renewAt = Date.now();
  for (const id of tm.renewedTombstones) appTombstones.set(id, renewAt);
  for (const id of dm.renewedTombstones) appTombstones.set(id, renewAt);
  if (tm.changed || dm.changed || cm.changed) {
    useAppStore.setState({
      tasks: tm.merged,
      deadlines: dm.merged,
      pomodoroConfig: normalizeConfig(cm.next as Partial<PomodoroConfig>)
    });
    // 与 settings 通道同理：采纳后的快照串进短路基准，防等值编辑漏播。
    // 本地编辑的防抖发射在飞时**不**刷新——采纳后快照已含本地新行，
    // 刷新会让在飞定时器尾判「无变化」吞掉新行首播；保持旧基准，定时器
    // 尾对比不等即整包发射，新行随包带出。
    if (!appEmitPending) {
      const snap = snapshotApp();
      lastAppJson = jsonOf(snap);
    }
  }
  return tm.diverged || dm.diverged || cm.diverged;
}

/** 设置快照的最近已知串（去重短路）。模块级：applyRemoteSettings 采纳远端后
 *  同步刷新它——否则采纳后的本地编辑若恰好回到旧串，会被误判为「没变」而
 *  漏播，对端停留在旧值直到下一次别的编辑。 */
let lastSettingsJson = "";
/** app 快照的最近已知串（同上）。 */
let lastAppJson = "";
/** app 通道防抖发射在飞标记：本地编辑已排队未播期间，applyRemoteApp
 *  不得用采纳后的快照刷新 lastAppJson——快照已含本地新行，刷新会让在飞
 *  定时器尾判「与上次发射相同」直接返回，本地新增行的首播被吞（对端看不到
 *  新任务直到本窗下一次任意编辑）。 */
let appEmitPending = false;

/**
 * 跨窗口状态同步 hook（发布/订阅中介者）。
 *
 * 挂载在小组件主窗与设置窗的 App 根部：订阅三个 store（settings/widgets/
 * app+pomodoro+habits），本地变化经尾随防抖（设置 80ms / 小组件 120ms）
 * 广播；同时监听远端载荷，应用时置 applyingRemote 抑制回声。settings 与 app
 * 两通道走三方合并（叶子级 / 行级，见 mergeLeaves / mergeRows）：以上次交换的
 * 快照为共同祖先，只采纳远端真正改过的部分，本窗口的并发编辑不被整包回滚，
 * 双方都改时按 (ts, json) 仲裁使两端收敛到同一结果。
 *
 * @returns 无（副作用型 hook）；浏览器模式为 no-op。
 * @throws 无（emit/listen 失败静默）。
 */
/**
 * persist-pause / persist-resume 监听（B-恢复 ack 协议的接收侧，抽共用）。
 *
 * 任何窗口收到 pause 即置位本窗闸门（此后一切防抖落盘直接丢弃）并回发
 * sync:persist-acked；resume 解除。ack 载荷带本窗口 label：发起方按 label
 * 排除自己（emit 回环到发送方自身时不能计入去重集合）；重复 pause 再次回
 * ack 无害。完整同步（useCrossWindowSync）与只读设置精简同步
 * （useCrossWindowSettingsSync 的 taskbar-net / snip / super-panel /
 * fullscreen 卫星窗）都必须挂载——卫星窗不挂则：①恢复备份的 ack 永远收不齐
 * 恒等满 1200ms 超时；②卫星窗未置 suspended，迟到的 sync:settings 被采纳后
 * 照常写共享 localStorage，与恢复流程竞态可把恢复前旧态写回。
 */
function setupPersistGateListeners(): () => void {
  let disposed = false;
  /* 逐个注册、逐个入列——旧实现两个 listen 都成功
     才给 un 赋值，uPause 成功后 uResume 因瞬时 IPC 失败 reject 时 un 仍是
     null，uPause 泄漏且本窗落入「有 pause 无 resume」的半残态（闸门被远端
     pause 置位后再也解不开，直到 reload）。失败路径先拆已注册者再上报。 */
  const unsubs: (() => void)[] = [];
  let un: (() => void) | null = null;
  void (async () => {
    try {
      const { listen, emit } = await import("@tauri-apps/api/event");
      // 按发起方 label 计数置位/解除——两窗并发恢复时先完成方的
      // resume 不再解除另一方的暂停；自回声（remote:自己）与本地 self
      // 是同一所有者，重复 pause 由集合去重。
      const uPause = await listen<string>("sync:persist-pause", (e) => {
        const me = currentWindowLabel() ?? INSTANCE_ID;
        const sender = typeof e.payload === "string" ? e.payload : "unknown";
        suspendPersistence(sender === me ? "self" : `remote:${sender}`);
        /* ack 裸 emit 的 rejection 是 unhandled；
           失败补一次轻量重试（ack 丢失会让发起方等满 1200ms 超时才放行，
           恢复流程整体慢一拍），仍失败上报后放弃（发起方超时兜底仍在）。 */
        emit("sync:persist-acked", me).catch((err: unknown) => {
          console.warn("[sync] persist-acked emit failed, retrying once", err);
          emit("sync:persist-acked", me).catch((retryErr: unknown) => {
            console.error("[sync] persist-acked emit retry failed", retryErr);
          });
        });
      });
      unsubs.push(uPause);
      const uResume = await listen<string>("sync:persist-resume", (e) => {
        const me = currentWindowLabel() ?? INSTANCE_ID;
        const sender = typeof e.payload === "string" ? e.payload : "unknown";
        resumePersistence(sender === me ? "self" : `remote:${sender}`);
      });
      unsubs.push(uResume);
      if (disposed) {
        unsubs.forEach((u) => u());
      } else {
        un = () => unsubs.forEach((u) => u());
      }
    } catch (err) {
      // 监听注册失败只损失本窗的闸门响应（不致命）；先拆已注册者防泄漏
      //记日志便于排查。
      unsubs.forEach((u) => u());
      console.error("[sync] persist-gate listen failed", err);
    }
  })();
  return () => {
    disposed = true;
    un?.();
  };
}

/**
 * 设置通道广播（80ms 防抖 + 防抖尾去重）：完整同步（useCrossWindowSync）与
 * 只读设置精简同步（useCrossWindowSettingsSync，网速条）共用。挂载即以当前
 * 快照重建三方合并基线的 settings 半边。返回清理函数。
 */
function setupSettingsBroadcast(): () => void {
  let settingsTimer = 0;
  lastSettingsJson = "";
  seedSettingsBase();
  // 注册「外部快照采纳」基线推进钩子（settings-store 的 LS 回读 /
  // DB 水合两条静默写路径完成后回调）；卸载时摘除。
  setExternalSettingsAdoptionHook(noteExternalSettingsAdoption);
  // Selector over ONLY the synced fields + shallow equality: the listener runs
  // just when a synced value actually changes, not on every store write such as
  // settingsOpen/settingsPage (which would JSON.stringify the whole snapshot for
  // nothing and emit a spurious first sync).
  const unsubSettingsStore = useSettingsStore.subscribe(
    (s) => pickSettingsFields(s),
    (snap, prev) => {
      // applyingRemote：采纳远端期间；isRemoteApplying：水合等「非用户编辑」
      // 的晚到写入（见 sync-gate）——两者都不得视为本地编辑去广播。
      if (applyingRemote || isRemoteApplying()) return;
      stampLeafEdits(prev, snap, settingsEditTs, Date.now());
      clearTimeout(settingsTimer);
      // 去重序列化移入防抖尾（与 widgets 通道的引用级短路同目标）：此前每次
      // store 写入都在主线程整表 stringify——逐字编辑设置 = 每窗口每键
      // O(N) 序列化。80ms 窗口内至多序列化一次，与上次发射相同则不发。
      settingsTimer = window.setTimeout(() => {
        const json = jsonOf(pickSettingsFields(useSettingsStore.getState()));
        if (json === lastSettingsJson) return;
        lastSettingsJson = json;
        emitSettings();
      }, 80);
    },
    { equalityFn: shallow }
  );
  /* 80ms 广播防抖的 pagehide 冲刷（对齐 widget-config
       150ms 通道的收尾范式）。根因：关窗时防抖尾包随定时器一起蒸发——对端错过
       本窗最后一次设置编辑后，其内存停留在旧快照，此后对端任意一次编辑都会以
       陈旧内存整包回写共享 LS/磁盘，把本窗刚做的修改回滚。冲刷仅在该定时器
       计时中触发：clear 后按定时器回调同款「现取 store 现值」口径发射（去重串
       照常短路等值包），幂等——接收方有叶子基线 + (ts,json) 仲裁守卫。完整同步
       与精简同步（useCrossWindowSettingsSync 卫星窗）共用本 setup，一并获得。 */
  const flushSettingsOnPageHide = () => {
    if (!settingsTimer) return;
    clearTimeout(settingsTimer);
    settingsTimer = 0;
    const json = jsonOf(pickSettingsFields(useSettingsStore.getState()));
    if (json === lastSettingsJson) return;
    lastSettingsJson = json;
    emitSettings();
  };
  window.addEventListener("pagehide", flushSettingsOnPageHide);
  return () => {
    window.clearTimeout(settingsTimer);
    window.removeEventListener("pagehide", flushSettingsOnPageHide);
    // 分歧回播定时器（模块级 settingsReplayTimer）一并清理：完整同步的
    // cleanup 自行清过一次；精简同步（useCrossWindowSettingsSync）只调用本
    // 函数，若不在此清理，卫星窗卸载后待发回播会在已拆除的订阅上发射。
    // 清理后必须复位句柄：残留非 0 值会让 remount 后 replaySettings 的
    // 「已有待发回播」早退永久成立（退避档通道失效）。
    clearTimeout(settingsReplayTimer);
    settingsReplayTimer = 0;
    unsubSettingsStore();
    setExternalSettingsAdoptionHook(null);
  };
}

/**
 * 远端设置快照的采纳（回声跳过 + applyingRemote 抑制 + 损坏载荷兜底）：
 * 完整同步的 u1 与精简接收端共用。
 */
function handleRemoteSettingsPayload(payload: SettingsSyncPayload | undefined): void {
  if (!payload) return;
  if (payload.instanceId === INSTANCE_ID) return;
  applyingRemote = true;
  try {
    // Validate/clamp the remote snapshot before applying: a malformed or
    // partial payload (older build, corrupt values) would otherwise flow
    // straight into setState + applySettings, where a bad primaryColor
    // value could crash `luminance`/`hexToRgba`.
    // 旧版本载荷无 ts 时取到达时刻：并发仲裁退化为「后到者胜」（旧行为）。
    const remoteTs = typeof payload.ts === "number" ? payload.ts : Date.now();
    applyRemoteSettings(payload, remoteTs);
  } catch (err) {
    // A malformed payload must never take down the listener itself.
    console.error("sync:settings apply failed", err);
  } finally {
    applyingRemote = false;
  }
}

export function useCrossWindowSync() {
  useEffect(() => {
    if (!isTauri()) return;

    // ---- 对外广播：设置项（80ms 尾随防抖，滑动条拖动时不会逐帧广播） ----
    // 挂载即以当前快照建立三方合并的共同祖先基线（settings 与 app 两通道）。
    // 此后本地编辑只给叶子/行盖时间戳、**不动基线**：防抖窗口内/初始化竞态下到达
    // 的远端旧快照与基线比对时，「本地 ≠ 基线」才成立，本窗口的编辑才真正得到保留。
    const unsubSettingsStore = setupSettingsBroadcast();
    lastAppJson = "";
    seedAppBase();

    // ---- 对外广播：小组件状态 ----
    // Selector 只取持久化字段：selectedId / selectedIds / editMode 等瞬态
    // （编辑模式点选、框选、拖拽参考线）变化频繁但不参与同步，旧的全量
    // 订阅会让每次点选都触发一次全量 JSON.stringify + 定时器重排。
    // groups 必须随包：漏发会让接收端 applyRemoteWidgets 把本地组清成空表
    // （「合并后打开设置窗口编组就散」的根因——设置窗挂载 hydrate 触发的
    // 一次无 groups 快照把桌面刚建的组冲掉）。
    let lastWidgetsSnap: Pick<WidgetSyncPayload, "instances" | "groups" | "views" | "activeView" | "trash"> | null =
      null;
    let widgetsTimer = 0;
    const unsubWidgetsStore = useWidgetStore.subscribe(
      (s) => ({ instances: s.instances, groups: s.groups, views: s.views, activeView: s.activeView, trash: s.trash }),
      (snap) => {
        if (applyingRemote) return;
        if (widgetsSyncSuspended) {
          widgetsDirtyDuringSuspend = true;
          return;
        }
        // 引用级短路。equalityFn=shallow 已保证「字段引用有变」才进回调，
        // 这里再按引用比较一次作第二道保险，彻底移除每帧全量 JSON.stringify
        // （真正的序列化只在 80ms 防抖触发 emit 时由 IPC 层进行）。
        if (
          lastWidgetsSnap &&
          lastWidgetsSnap.instances === snap.instances &&
          lastWidgetsSnap.groups === snap.groups &&
          lastWidgetsSnap.views === snap.views &&
          lastWidgetsSnap.activeView === snap.activeView &&
          lastWidgetsSnap.trash === snap.trash
        ) {
          return;
        }
        lastWidgetsSnap = snap;
        clearTimeout(widgetsTimer);
        widgetsTimer = window.setTimeout(() => {
          /* 发射时现取 store 现值（对齐 dock 通道
             emitDockNow 的口径），不再沿用订阅回调捕获的旧 snap——屏号与
             数据同源同时刻取自 getState，从结构上杜绝「防抖窗口内编辑后
             切屏：定时器到期把旧屏数据打上新屏标」。防抖窗口内若远端包
             被采纳（applyingRemote 抑制了本回调的重排），现值发射只是一次
             幂等回声，不再像旧 snap 那样把远端刚带来的值整包回滚。 */
          const cur = useWidgetStore.getState();
          emitWidgets({
            screenId: currentScreenId(),
            instances: cur.instances,
            groups: cur.groups,
            views: cur.views,
            activeView: cur.activeView,
            trash: cur.trash
          });
        }, 80);
      },
      { equalityFn: shallow }
    );

    // ---- 对外广播：视图切换（即时，不防抖） ----
    // 切换视图是明确的用户意图（设置窗「视图」页的「切换」/ Ctrl+1/2/3 / 命令面板），
    // 不能只靠上面的整包快照传达：快照接收端对「activeView 与本地不同」的载荷故意
    // 只吸收元数据、不拽动本地视图（见 widget-store applyRemoteWidgets——那是为了
    // 一边编辑另一视图时不打扰桌面）。这里单独发一条即时事件，接收方据此真正切换，
    // 设置窗口里点「切换」桌面才会跟着换视图。
    const unsubViewSwitch = useWidgetStore.subscribe(
      (s) => s.activeView,
      (view) => {
        if (applyingRemote) return;
        /* 补齐：emit 失败退避重发（接收方按 view 字符串幂等采纳）。 */
        emitWithRetry(SYNC_EVENTS.viewSwitch, {
          instanceId: INSTANCE_ID,
          screenId: currentScreenId(),
          view
        } satisfies ViewSwitchSyncPayload);
      }
    );

    // ---- 对外广播：灵动岛配置（按屏） ----
    // 每个写方（setDock / addDockTile / setDockPlacement…）都整对象替换 dock，
    // 引用变化即有效变更；dockDrag 等瞬态不在 selector 里，拖动排序不触发。
    // 去重序列化移入防抖尾（与 habits 通道同口径）——引用变化但内容相同
    // 的写入（幂等重放 / 陈旧闭包整包回写）不再每写一次整包 stringify + 广播。
    let dockTimer = 0;
    let lastDockJson = "";
    const emitDockNow = () => {
      const cur = useWidgetStore.getState().dock;
      const json = jsonOf(cur);
      if (json === lastDockJson) return;
      lastDockJson = json;
      const rev = ++dockRev;
      emitWithRetry(
        SYNC_EVENTS.dock,
        {
          instanceId: INSTANCE_ID,
          rev,
          screenId: currentScreenId(),
          dock: cur
        } satisfies DockSyncPayload,
        () => {
          lastDockJson = "";
        }
      );
    };
    const unsubDockStore = useWidgetStore.subscribe(
      (s) => s.dock,
      () => {
        if (applyingRemote) return;
        clearTimeout(dockTimer);
        dockTimer = window.setTimeout(() => {
          dockTimer = 0;
          emitDockNow();
        }, 80);
      }
    );
    /* 把「pending 即发」的冲刷能力挂给 widget-store（经 register 回调
       注入，避免静态环依赖）——switchScreen 分区切换 set() 会触发订阅回调把
       旧屏 80ms 内待发射的 sync:dock **取消**（clear 不发），此后发射的是新屏
       快照：旧屏对端错过事件且 repull 只在监听就绪时执行一次，其后任意一次
       dock 写入都以陈旧内存整包回写、污染 LS 权威源与 SQLite 镜像。布局通道
       有 flushWidgetLayoutSync 同款，dock 此前漏了。 */
    registerDockBroadcastFlusher(() => {
      if (applyingRemote) return;
      if (dockTimer) {
        clearTimeout(dockTimer);
        dockTimer = 0;
      }
      emitDockNow();
    });
    /* widgets 80ms 广播防抖的对位冲刷钩子（dock 的
       同款）——switchScreen 的 set() 会触发上面的 widgets 订阅回调，把
       旧屏待发射的 sync:widgets **取消**（clear 不发），旧屏那次编辑从此
       无人知晓（旧屏对端要等下一次任意编辑才追上）。switchScreen 在切换前
       经此钩子先发射一次——冲刷点在 currentScreen 改写之前，屏号与数据
       一致；无待发定时器时 no-op。 */
    registerWidgetsBroadcastFlusher(() => {
      if (applyingRemote) return;
      if (!widgetsTimer) return;
      clearTimeout(widgetsTimer);
      widgetsTimer = 0;
      /* 冲刷与 的 80ms 定时器同口径——现取 store
         现值发射，不再用订阅回调捕获的 lastWidgetsSnap。防抖窗口内远端包被
         采纳时（applyingRemote 抑制订阅回调、snap 不更新），旧 snap 会把远端
         刚带来的值整包回滚给同屏对端（widgets 通道整包 LWW、无墓碑可救）；
         现值发射在无并发时与 snap 等价（幂等回声），有并发时保住对端更新。 */
      const cur = useWidgetStore.getState();
      emitWidgets({
        screenId: currentScreenId(),
        instances: cur.instances,
        groups: cur.groups,
        views: cur.views,
        activeView: cur.activeView,
        trash: cur.trash
      });
    });

    // ---- 对外广播：任务 / 截止日 / 番茄钟配置 ----
    // 设置窗口里改「专注时长」或增删任务时，桌面层正在运行的番茄钟与
    // 今日任务小组件必须立刻看到，否则要等重启才生效。整表快照 + 行级
    // 三方合并（见 mergeRows）：整表承载全部现状，行级比对保住并发编辑。
    let appTimer = 0;
    const unsubAppStore = useAppStore.subscribe(
      (s) => ({ tasks: s.tasks, deadlines: s.deadlines, pomodoroConfig: s.pomodoroConfig }),
      (snap, prev) => {
        if (applyingRemote || isRemoteApplying()) return;
        // 只盖时间戳、记删除凭证与墓碑，不动基线（基线只在发射/采纳时更新）。
        const now = Date.now();
        stampRowEdits(prev.tasks, snap.tasks, tasksTs, pendingRemovedTasks, now);
        stampRowEdits(prev.deadlines, snap.deadlines, deadlinesTs, pendingRemovedDeadlines, now);
        stampLeafEdits(prev.pomodoroConfig, snap.pomodoroConfig, configEditTs, now);
        clearTimeout(appTimer);
        appEmitPending = true;
        // 去重序列化移入防抖尾：任何一条任务/截止日的每次编辑（拖输入法、逐字
        // 打标题）此前都在每个窗口主线程整表 stringify 一遍。80ms 窗口内至多
        // 一次序列化，与上次发射相同则不发。
        appTimer = window.setTimeout(() => {
          appEmitPending = false;
          const cur = useAppStore.getState();
          const json = jsonOf({
            tasks: cur.tasks,
            deadlines: cur.deadlines,
            pomodoroConfig: cur.pomodoroConfig
          });
          if (json === lastAppJson) return;
          lastAppJson = json;
          emitApp();
        }, 80);
      },
      { equalityFn: shallow }
    );

    // ---- 对外广播：番茄钟运行态（残留接线）----
    // tick 只在 primary 窗口跑，其余窗口的番茄钟小组件读到的
    // remainingSeconds 若无同步将永久冻结。快照带墙钟锚点（segmentAnchor 等
    // 模块级变量不随 store 走），接收方应用后既每秒走秒，暂停/中断等操作
    // 也按墙钟正确计算。
    // 广播降频（P-perf 三轮）：此前 primary 的每秒 tick 形成 ~1s 广播节拍，
    // 每窗口每秒一条 IPC。现在纯走秒（控制态不变、剩余秒推进 ≤5s）最多
    // 5s 一条锚点包——接收窗口由本地走秒器（walkPomodoroDisplay，见 u4）
    // 用墙钟锚点自行推进显示，观感不变。控制态（运行/暂停/模式/任务/正倒
    // 计时）变化立即播；中途手动调整锚点类字段（加时等）靠 ≤5s 的锚点包
    // 追平。静止态无变化即无广播，零开销语义保留。
    let lastPomoSig = "";
    let lastPomoEmitAt = 0;
    let lastPomoRemaining = Number.NaN;
    const POMODORO_ANCHOR_EVERY_MS = 5000;
    /* 接收窗口的本地走秒定时器（u4 中管理启停；作用域在 cleanup 可及处）。 */
    let pomodoroWalkTimer = 0;
    const stopPomodoroWalk = () => {
      if (pomodoroWalkTimer) {
        window.clearInterval(pomodoroWalkTimer);
        pomodoroWalkTimer = 0;
      }
    };
    const unsubPomodoroStore = useAppStore.subscribe(
      (s) => s.pomodoro,
      (pomodoro) => {
        // 必须与 app 通道同款双重门闩。此前只查 applyingRemote——
        // useCrossWindowSync 挂载后的兜底 hydrateApp 虽包在 withRemoteApply 里，
        // 但本订阅不认 sync-gate 的门闩，水合重建的 pomodoro 对象（引用必变）
        // 被当成「本地控制变更」广播：任一副窗口启动都会向全网发射一份
        // defaults+LS 恢复值的陈旧快照，静默暂停/重置其他窗口正在运行的计时。
        if (applyingRemote || isRemoteApplying()) return;
        const sig = `${pomodoro.isRunning}|${pomodoro.mode}|${pomodoro.timerMode}|${pomodoro.currentTaskId}|${pomodoro.currentEventLabel}`;
        const now = Date.now();
        const controlChanged = sig !== lastPomoSig;
        const anchorDue =
          !Number.isNaN(lastPomoRemaining) &&
          (Math.abs(pomodoro.remainingSeconds - lastPomoRemaining) >= 5 ||
            now - lastPomoEmitAt >= POMODORO_ANCHOR_EVERY_MS);
        if (!controlChanged && !anchorDue) return;
        lastPomoSig = sig;
        lastPomoEmitAt = now;
        lastPomoRemaining = pomodoro.remainingSeconds;
        // （迟加入窗口）：同一份快照落 LS 引导键——sync:pomodoro 在暂停态
        // 完全不广播，晚打开的窗口（全屏窗/新副屏）靠这份键值拿到初始数据。
        writePomodoroLiveSnapshot();
        /* 补齐：控制包失败退避重发（接收方按 wallMs/纪元幂等，重发无害；
           暂停/恢复跨窗不因单次 IPC 抖动丢失）。control 标记控制态包。 */
        emitWithRetry(SYNC_EVENTS.pomodoro, {
          instanceId: INSTANCE_ID,
          wallMs: now,
          control: controlChanged,
          ...getPomodoroSyncSnapshot()
        } satisfies PomodoroSyncPayload);
      }
    );

    /* （副屏统计即时刷新）：新完成的会话记录增量广播。订阅尾条 id：
       append-only（tail 截断只影响头部），尾条变化即新记录。水合/远端应用
       都在双重门闩内，不会回声。 */
    let lastEmittedSessionId = useAppStore.getState().sessions.at(-1)?.id ?? "";
    const unsubSessionStore = useAppStore.subscribe(
      (s) => s.sessions,
      (sessions) => {
        if (applyingRemote || isRemoteApplying()) return;
        const last = sessions.at(-1);
        if (!last || last.id === lastEmittedSessionId) return;
        lastEmittedSessionId = last.id;
        /* 补齐：增量包失败退避重发（接收方按记录 id 幂等去重）。 */
        emitWithRetry(SYNC_EVENTS.session, {
          instanceId: INSTANCE_ID,
          record: last
        });
      }
    );

    /* （打断统计跨窗同步）：新打断记录增量广播——与 session 通道同款。
       打断记录无 id 字段，用 startedAt|endedAt|reason 组合键去重（同一打断
       瞬时三元组实际只在重复广播时出现）。此前副窗口的「中断 N 次」与
       月度打断图要等重启才刷新。 */
    const interruptionKey = (i: PomodoroInterruption) => `${i.startedAt}|${i.endedAt}|${i.reason}`;
    const initialInterruption = useAppStore.getState().interruptions.at(-1);
    let lastEmittedInterruptionKey = initialInterruption ? interruptionKey(initialInterruption) : "";
    const unsubInterruptionStore = useAppStore.subscribe(
      (s) => s.interruptions,
      (interruptions) => {
        if (applyingRemote || isRemoteApplying()) return;
        const last = interruptions.at(-1);
        if (!last) return;
        const key = interruptionKey(last);
        if (key === lastEmittedInterruptionKey) return;
        lastEmittedInterruptionKey = key;
        /* 补齐：增量包失败退避重发（接收方按组合键幂等去重）。 */
        emitWithRetry(SYNC_EVENTS.interruption, {
          instanceId: INSTANCE_ID,
          record: last
        });
      }
    );

    // ---- 对外广播：习惯打卡（全局单例，跨窗口保持一致） ----
    let lastHabitsJson = "";
    let habitsTimer = 0;
    const unsubHabitsStore = useHabitsStore.subscribe(
      (s) => s.habits,
      (_habits) => {
        if (applyingRemote) return;
        clearTimeout(habitsTimer);
        // 去重序列化移入防抖尾（同 settings/app 通道口径）：引用变化但内容
        // 相同的写入不再每写一次整表 stringify。
        habitsTimer = window.setTimeout(() => {
          const cur = useHabitsStore.getState().habits;
          const json = jsonOf(cur);
          if (json === lastHabitsJson) return;
          lastHabitsJson = json;
          const rev = ++habitsRev;
          // 重发仍失败 → 复位去重串，本窗下一次任意编辑必重播。
          emitWithRetry(SYNC_EVENTS.habits, { instanceId: INSTANCE_ID, rev, habits: cur }, () => {
            lastHabitsJson = "";
          });
        }, 80);
      },
      { equalityFn: shallow }
    );

    /* widgets/dock/app/habits 四条 80ms 广播防抖的
       pagehide 冲刷（settings 通道在 setupSettingsBroadcast 内自行冲刷；对齐
       widget-config 150ms 通道的 pagehide 收尾范式）。根因：关窗时防抖尾包随
       定时器蒸发 → 对端错过本窗最后一次编辑 → 对端此后任意一次编辑以陈旧
       内存整包回写磁盘（widgets/dock 是整包 LWW，回滚面最大），本窗刚做的
       修改被无声回滚。每条通道仅当其定时器计时中才冲刷（clear 后按各自定时器
       回调的「现取 store 现值」口径立即发射，不用旧快照）；接收方有 rev/ts/
       行基线守卫，等值或重复包幂等无害。监听在 cleanup 中移除，防 remount 后
       双挂导致重复冲刷。 */
    const flushBroadcastsOnPageHide = () => {
      if (widgetsTimer) {
        clearTimeout(widgetsTimer);
        widgetsTimer = 0;
        const cur = useWidgetStore.getState();
        emitWidgets({
          screenId: currentScreenId(),
          instances: cur.instances,
          groups: cur.groups,
          views: cur.views,
          activeView: cur.activeView,
          trash: cur.trash
        });
      }
      if (dockTimer) {
        clearTimeout(dockTimer);
        dockTimer = 0;
        emitDockNow();
      }
      if (appTimer) {
        clearTimeout(appTimer);
        appTimer = 0;
        appEmitPending = false;
        const cur = useAppStore.getState();
        const json = jsonOf({ tasks: cur.tasks, deadlines: cur.deadlines, pomodoroConfig: cur.pomodoroConfig });
        if (json !== lastAppJson) {
          lastAppJson = json;
          emitApp();
        }
      }
      if (habitsTimer) {
        clearTimeout(habitsTimer);
        habitsTimer = 0;
        const cur = useHabitsStore.getState().habits;
        const json = jsonOf(cur);
        if (json !== lastHabitsJson) {
          lastHabitsJson = json;
          const rev = ++habitsRev;
          emitWithRetry(SYNC_EVENTS.habits, { instanceId: INSTANCE_ID, rev, habits: cur }, () => {
            lastHabitsJson = "";
          });
        }
      }
    };
    window.addEventListener("pagehide", flushBroadcastsOnPageHide);

    // ---- 接收远端事件。emit 会广播到所有窗口（包括发送方自己）：
    //      载荷带 instanceId，自己的回声直接跳过，省一次全量 setState。 ----
    /* unsubs 改为「注册即入列」的可变数组——旧实现
       要等全部 9 个 listen 成功才整体赋值，中途某个 reject 时 catch 迭代的
       是空数组，u1..uk 已注册的监听全部泄漏。现在失败路径能真正拆掉已注
       册者（未挂载卸载则由 cleanup 兜底），成功路径与 cleanup 都迭代同一
       数组；unlisten 幂等，disposed 分支与 catch 的重复拆除无害。 */
    const unsubs: (() => void)[] = [];
    let disposed = false;
    void (async () => {
      const { listen } = await import("@tauri-apps/api/event");
      const u1 = await listen<SettingsSyncPayload>(SYNC_EVENTS.settings, (e) => {
        handleRemoteSettingsPayload(e.payload);
      });
      unsubs.push(u1);
      // 按发送方记忆「上次已应用的 rev」，拒绝乱序/重复到达的旧整包快照。
      // pendingRemoteView：幽灵视图守卫的待采纳切换（见下方 uView 注释），由
      // u2 在 views 列表跟进后补切。
      let pendingRemoteView: string | null = null;
      const lastWidgetsRevBySender = new Map<string, number>();
      const u2 = await listen<WidgetSyncPayload>(SYNC_EVENTS.widgets, (e) => {
        if (!e.payload) return;
        if (e.payload.instanceId === INSTANCE_ID) return;
        const sender = e.payload.instanceId ?? "legacy";
        const rev = typeof e.payload.rev === "number" ? e.payload.rev : 0;
        const last = lastWidgetsRevBySender.get(sender) ?? 0;
        if (rev !== 0 && rev <= last) return;
        lastWidgetsRevBySender.set(sender, rev);
        applyingRemote = true;
        try {
          applyRemoteWidgets(e.payload);
        } catch (err) {
          // 载荷畸形时必须保住监听器与其后的对账/补切（与其余接收端同款
          // 兜底）——不 catch 会连带跳过 reconcileDockTiles 与 pendingRemoteView。
          console.error("sync:widgets apply failed", err);
        } finally {
          applyingRemote = false;
        }
        // 对端删的实例（清空回收站 / 删视图…）可能是本屏磁贴绑定的：在 applyingRemote
        // 之外对账，降级产生的 dock 变化才会照常经 sync:dock 广播回去。
        reconcileDockTiles();
        // 之前因「视图列表未到位」而暂存的远端切换：列表已随本包吸收，补切。
        if (pendingRemoteView) {
          const target = pendingRemoteView;
          pendingRemoteView = null;
          const st = useWidgetStore.getState();
          if (st.views.some((v) => v.id === target) && st.activeView !== target) {
            applyingRemote = true;
            try {
              useWidgetStore.getState().setActiveView(target);
            } catch (err) {
              console.error("sync:view-switch deferred apply failed", err);
            } finally {
              applyingRemote = false;
            }
          }
        }
      });
      unsubs.push(u2);
      // 视图切换：同屏采纳、回声跳过。走 store 的 setActiveView 完整语义（冲刷并保存
      // 当前视图布局 → 载入目标视图布局 → 重置选中/参考线等瞬态 → 记住活动视图），
      // 与本窗口自己切换完全一致；紧随其后的 sync:widgets 整包快照会带来目标视图
      // 的最新实例并按「同视图」分支采纳。applyingRemote 期间不回播，不会来回互切。
      // 幽灵视图守卫：对端「新建视图并立即切换」时，view-switch 即时事件可能先于
      // 携带新视图列表的 80ms 防抖快照到达——本地 views 里还没有这个 id，直接切会
      // 落进空布局（幽灵视图闪空窗）。此时记为待采纳，等 views 列表跟进后再切。
      const uView = await listen<ViewSwitchSyncPayload>(SYNC_EVENTS.viewSwitch, (e) => {
        if (!e.payload) return;
        if (e.payload.instanceId === INSTANCE_ID) return;
        if (e.payload.screenId !== currentScreenId()) return;
        const view = e.payload.view;
        if (typeof view !== "string" || !view) return;
        pendingRemoteView = view;
        if (!useWidgetStore.getState().views.some((v) => v.id === view)) return;
        pendingRemoteView = null;
        applyingRemote = true;
        try {
          useWidgetStore.getState().setActiveView(view);
        } catch (err) {
          console.error("sync:view-switch apply failed", err);
        } finally {
          applyingRemote = false;
        }
      });
      unsubs.push(uView);
      // 灵动岛配置：同屏采纳、回声跳过、按发送方 rev 拒旧拒重（与 widgets 同型）。
      const lastDockRevBySender = new Map<string, number>();
      const uDock = await listen<DockSyncPayload>(SYNC_EVENTS.dock, (e) => {
        if (!e.payload) return;
        if (e.payload.instanceId === INSTANCE_ID) return;
        const sender = e.payload.instanceId ?? "legacy";
        const rev = typeof e.payload.rev === "number" ? e.payload.rev : 0;
        const last = lastDockRevBySender.get(sender) ?? 0;
        if (rev !== 0 && rev <= last) return;
        lastDockRevBySender.set(sender, rev);
        applyingRemote = true;
        try {
          applyRemoteDock(e.payload);
          /* 远端采纳后推进去重基线——本窗 dock 已变成对端内容，若基线还停在
             自己上一次发射的 JSON，之后用户改回“恰好相同”的内容会被误判为重复
             而拒绝广播，对端从此停留在旧态（发射侧去重的通例：凡是不经本通道
             发射的 dock 变更都要同步刷新基线）。 */
          lastDockJson = jsonOf(useWidgetStore.getState().dock);
        } catch (err) {
          console.error("sync:dock apply failed", err);
        } finally {
          applyingRemote = false;
        }
      });
      unsubs.push(uDock);
      // -DDL：单调时间戳守卫（与 sync:pomodoro 的 wallMs 同型）。相等也拒——
      // 多窗口交错时保留先到者；回声同样推进基准。通过守卫的包不再整包覆盖，
      // 而是行级/叶子级三方合并（applyRemoteApp）：防抖窗口内两窗口分别改不同
      // 行不再互相回滚；删除凭证 + 墓碑保证已删行不会被陈旧包复活。
      let lastAppTs = 0;
      const u3 = await listen<AppSyncPayload>(SYNC_EVENTS.app, (e) => {
        if (!e.payload) return;
        const ts = typeof e.payload.ts === "number" ? e.payload.ts : Date.now();
        if (e.payload.instanceId === INSTANCE_ID) {
          if (ts > lastAppTs) lastAppTs = ts;
          return;
        }
        if (ts <= lastAppTs) return;
        lastAppTs = ts;
        applyingRemote = true;
        let replay = false;
        try {
          replay = applyRemoteApp(e.payload, ts);
        } catch (err) {
          console.error("sync:app apply failed", err);
        } finally {
          applyingRemote = false;
        }
        // 保留了对端没有的本地更新值 → 回播让对端收敛。回播走指数退避：
        // 立即回播在两端时间戳纠缠时会把收敛变成无界乒乓（风暴），退避让
        // 仲裁在静默期内完成，双方收敛到同一个赢家。
        if (replay) {
          replayApp();
        }
      });
      unsubs.push(u3);
      // 接收番茄钟运行态快照。wallMs 单调守卫拒乱序旧包（同一发送方
      // 的事件通道是 FIFO，但多窗口操作与 primary tick 的快照仍可能交错）。
      // 审计修复（暂停竞态）：
      //  1) 相等也拒（<=）——同毫秒内暂停包与 tick 包互踩时保留先到者；
      //  2) 回声也推进守卫基准——本窗口刚广播的时间戳成为下界，此后任何
      //     窗口（含 primary tick）更旧的运行态快照都不再可能回滚暂停。
      // （跨发送方暂停回滚）：wallMs 仲裁只覆盖「同拍互踩」——迷你窗发
      // 暂停包后、主窗恰逢 5s 锚点到点以 >发出「运行中」锚点包
      // 时，两边会一致回滚到运行态。控制纪元（controlEpoch，每个用户控制
      // 动作自增并随包携带）让纪元更新的包无条件获胜、纪元更旧的包无条件
      // 拒收，锚点包永远压不过更新的控制态包。
      let lastPomodoroWallMs = 0;
      let lastPomodoroEpoch = 0;
      const u4 = await listen<PomodoroSyncPayload>(SYNC_EVENTS.pomodoro, (e) => {
        if (!e.payload) return;
        const wallMs = typeof e.payload.wallMs === "number" ? e.payload.wallMs : Date.now();
        const epoch = typeof e.payload.controlEpoch === "number" ? e.payload.controlEpoch : 0;
        if (e.payload.instanceId === INSTANCE_ID) {
          if (wallMs > lastPomodoroWallMs) lastPomodoroWallMs = wallMs;
          if (epoch > lastPomodoroEpoch) lastPomodoroEpoch = epoch;
          return;
        }
        // 纪元更旧 = 发送方还没看到本地已应用/已发出的控制变更，整包拒收
        // （旧版本载荷无纪元字段，恒 0，退回纯 wallMs 仲裁保兼容）。
        // 纪元基线是启动墙钟（见 app-store），重载后的窗口本地纪元天然
        // 大于老窗口的锚点包纪元——锚点包（control=false，纯走秒重发）若也
        // 与本地控制纪元比对，会被永久拒收、无法重新采纳运行态。因此锚点
        // 包只与「已应用的远端纪元」比对；控制包保持严格双基准仲裁（本地
        // store 纪元 ∪ 回声基准，取大者）。
        // 只比回声基准会在「本地控制动作与其回声之间」重开暂停回滚
        // 竞态——锚点包额外比对本地控制动作墙钟（见下方第三基准）。
        const isControlPacket = e.payload.control !== false;
        const localEpoch = Math.max(lastPomodoroEpoch, getPomodoroControlEpoch());
        const gateEpoch = isControlPacket ? localEpoch : lastPomodoroEpoch;
        if (epoch < gateEpoch) return;
        if (epoch === gateEpoch && wallMs <= lastPomodoroWallMs) return;
        /* 锚点包第三基准——本地控制动作墙钟。本地控制（暂停/开始…）
           已应用、控制包已发射而自身回声未到的窗口里，锚点早于本地控制时刻
           即发送方尚未见过我们的控制包，其运行态认知已被超越，拒收防回滚
           （相等也拒，与 同拍互踩口径一致）。重载窗口该值为 0 不受影响。
           R-前端-7（复审备案）：按发送时刻仲裁仍留毫秒级残窗——对端在「本地
           控制之后、应用控制包之前」发出的锚点（wallMs 更新、内容为运行态）
           可通过三闸；窗口已从「回声延迟」缩窄为「对端应用延迟 × 恰逢锚点
           拍」，且 emitWithRetry 重试保证最终收敛，接受。 */
        if (!isControlPacket && wallMs <= getLastLocalControlWallMs()) return;
        lastPomodoroEpoch = Math.max(lastPomodoroEpoch, epoch);
        lastPomodoroWallMs = wallMs;
        applyingRemote = true;
        try {
          applyRemotePomodoroSnapshot(e.payload);
        } catch (err) {
          console.error("sync:pomodoro apply failed", err);
        } finally {
          applyingRemote = false;
        }
        /* 本地走秒器（P-perf 三轮）：发送端锚点包降频到 ≤5s 后，接收窗口
           用已应用的墙钟锚点每秒自行推进 remainingSeconds（walkPomodoroDisplay
           与 primary tick 同算同源）。写回包 applyingRemote 守卫，不会回声
           再广播。暂停/重置快照（isRunning=false）到达即停。 */
        if (e.payload.pomodoro?.isRunning) {
          if (!pomodoroWalkTimer) {
            pomodoroWalkTimer = window.setInterval(() => {
              if (!useAppStore.getState().pomodoro.isRunning) {
                stopPomodoroWalk();
                return;
              }
              applyingRemote = true;
              try {
                walkPomodoroDisplay();
              } finally {
                applyingRemote = false;
              }
            }, 1000);
          }
        } else {
          stopPomodoroWalk();
        }
      });
      unsubs.push(u4);
      // 习惯打卡：全局单例。§4.14：与 widgets 同型的按发送方 rev 守卫——
      // 多窗口交替打卡时乱序到达的旧整表不再可能回滚对方的最新打卡。
      const lastHabitsRevBySender = new Map<string, number>();
      const u5 = await listen<HabitsSyncPayload>(SYNC_EVENTS.habits, (e) => {
        if (!e.payload) return;
        if (e.payload.instanceId === INSTANCE_ID) return;
        const sender = e.payload.instanceId ?? "legacy";
        const rev = typeof e.payload.rev === "number" ? e.payload.rev : 0;
        const last = lastHabitsRevBySender.get(sender) ?? 0;
        // rev=0（旧版本载荷）不拒：退回 last-writer-wins 兼容行为。
        if (rev !== 0 && rev <= last) return;
        lastHabitsRevBySender.set(sender, rev);
        applyingRemote = true;
        try {
          applyRemoteHabits(e.payload.habits);
          /* 远端采纳后推进去重基线（与 uDock / lastSettingsJson 同口径）——
             本窗 habits 已变成对端内容，基线若仍停在本地最后一次发射的 JSON，
             之后用户改回「恰好相同」的内容会被误判为重复而拒绝广播，对端停留
             在旧值直到下一次不同的编辑。 */
          lastHabitsJson = jsonOf(useHabitsStore.getState().habits);
        } catch (err) {
          console.error("sync:habits apply failed", err);
        } finally {
          applyingRemote = false;
        }
      });
      unsubs.push(u5);
      // B-恢复 ack 协议：备份整表替换/重置期间的持久化暂停闸门。任何窗口收到
      // pause 即置位闸门（此后防抖落盘直接丢弃）并回发 ack；resume 解除。
      // ack 载荷带本窗口 label：发起方按 label 排除自己（emit 会回环到发送方
      // 自身，用 INSTANCE_ID 时自回声会被计入去重集合，两窗口场景永远等不到
      // 对端真 ack 就放行）；重复 pause 再次回 ack 无害。
      // 抽成共用 helper——taskbar-net/snip/super-panel/fullscreen 等挂
      // useCrossWindowSettingsSync 的卫星窗也要参与 pause-ack 协议，否则
      // 恢复备份恒等满 1200ms 超时、卫星窗在恢复窗口内照常写共享 LS。
      const uPauseResume = setupPersistGateListeners();
      /* persist-gate 的两个 listen 在 helper 内部同样「注册即入列」并
         自带失败自拆；此处只需把 helper 的统一收口句柄挂进主链的拆除列表。 */
      unsubs.push(uPauseResume);
      /* （副屏统计即时刷新）：接收单条新会话记录——按 id 去重 append。
         withRemoteApply + applyingRemote 双闸，采纳不会触发本窗回播。 */
      const u8 = await listen<{ instanceId?: string; record?: PomodoroSessionRecord }>(SYNC_EVENTS.session, (e) => {
        if (!e.payload || e.payload.instanceId === INSTANCE_ID) return;
        const rec = e.payload.record;
        if (!rec || typeof rec.id !== "string") return;
        if (useAppStore.getState().sessions.some((x) => x.id === rec.id)) return;
        applyingRemote = true;
        try {
          withRemoteApply(() => {
            useAppStore.setState((st) => ({
              sessions: [...st.sessions, rec].slice(Math.max(0, st.sessions.length + 1 - 500))
            }));
          });
        } catch (err) {
          console.error("sync:session apply failed", err);
        } finally {
          applyingRemote = false;
        }
      });
      unsubs.push(u8);
      /* （打断统计跨窗同步）：接收单条新打断记录——按 起始|结束|原因
         组合键去重 append（记录无 id 字段），双闸内采纳不回播。 */
      const u9 = await listen<{ instanceId?: string; record?: PomodoroInterruption }>(SYNC_EVENTS.interruption, (e) => {
        if (!e.payload || e.payload.instanceId === INSTANCE_ID) return;
        const rec = e.payload.record;
        if (!rec || typeof rec.startedAt !== "string" || typeof rec.reason !== "string") return;
        const key = `${rec.startedAt}|${rec.endedAt}|${rec.reason}`;
        if (useAppStore.getState().interruptions.some((x) => `${x.startedAt}|${x.endedAt}|${x.reason}` === key)) return;
        applyingRemote = true;
        try {
          withRemoteApply(() => {
            useAppStore.setState((st) => ({
              // INTERRUPTIONS_CAP=300（app-store 同值；跨窗模块不引常量）。
              interruptions: [...st.interruptions, rec].slice(Math.max(0, st.interruptions.length + 1 - 300))
            }));
          });
        } catch (err) {
          console.error("sync:interruption apply failed", err);
        } finally {
          applyingRemote = false;
        }
      });
      unsubs.push(u9);
      if (disposed) {
        unsubs.forEach((u) => u());
        return;
      }
      // 监听就绪后重读一次 SQLite 权威副本，兜住「启动期 sync:widgets 落在
      // 监听注册前被丢弃」的陈旧布局缺口（带 seq+baseline 守卫，不覆盖新编辑）。
      void repullWidgetsFromDb();
      // 同款兜底扩到 settings/app 通道：设置侧回读共享 localStorage 权威快照；
      // app 侧重跑一次水合（DB 快照补齐合并，幂等）。被丢弃的启动期广播
      // 对应的落盘写入都会在这两次回读中被采纳。仅 Tauri（跨窗同步只存在于
      // 多窗口运行时；浏览器/测试环境重跑水合无意义且依赖不完整的持久层）。
      if (isTauri()) {
        repullSettingsFromLs();
        // （迟加入窗口初始拉取）：番茄钟通道同款兜底。sync:pomodoro 在
        // 暂停态完全不广播、锚点包最长 5s 一发——此前晚打开的窗口在暂停态
        // 永远拿不到数据（全屏窗停在占位、副窗显示满额）。读共享 LS 引导
        // 快照应用一次（不回播），随后被实时广播自然接管。必须在
        // hydrateApp 之前：应用后 remotePomodoroApplied 置位，晚到水合不再
        // 用 defaults+LS 旧值整包覆盖。
        const livePomo = readPomodoroLiveSnapshot();
        if (livePomo) {
          applyingRemote = true;
          try {
            applyRemotePomodoroSnapshot(livePomo);
          } catch {
            // 引导失败静默——实时广播仍是主路径
          } finally {
            applyingRemote = false;
          }
        }
        void hydrateApp().catch((err) => console.error("[sync] app repull failed", err));
        // dock 通道同款兜底——uDock 注册前被丢弃的 sync:dock 事件对应的
        // LS 写入在此采纳（applyingRemote 抑制采纳引发的回播）。此处**不**推进
        // 去重基线：启动期基线为空串，与任何 JSON 都不等，首次本地编辑必发射
        // （habits 通道同口径）；基线只在「远端采纳」（uDock）与「本窗发射」
        // 两个时点推进，凡是不经本通道发射的 dock 变更即刷新基线。
        applyingRemote = true;
        try {
          repullDockFromLs();
        } finally {
          applyingRemote = false;
        }
      }
    })().catch((err: unknown) => {
      /* ①：注册链中断处理（对齐 setupPersistGateListeners 的口径）——
         u1 成功后 u2 因瞬时 IPC 失败 reject，u3..u9 永不注册，本窗会进入
         「settings 可同步、其余全聋」的静默分叉态直到 reload，且已注册监听
         泄漏。先拆已注册监听（未挂载则由下方 cleanup 兜底），再上报进控制台
         供诊断；不重抛，避免 unhandled rejection。
         unsubs 已改为「注册即入列」，这里迭代到的
         是真正已注册的集合（旧实现此时恒为空数组，u1 等已注册者照样泄漏）。 */
      unsubs.forEach((u) => u());
      console.error("[sync] cross-window listen chain interrupted:", err);
    });

    return () => {
      disposed = true;
      // 摘除 pagehide 冲刷监听（与各防抖定时器同生命周期）。
      window.removeEventListener("pagehide", flushBroadcastsOnPageHide);
      // 设置通道的防抖定时器 + 订阅由共用 helper 一并清理。
      unsubSettingsStore();
      clearTimeout(settingsReplayTimer);
      // 清理后必须复位句柄：定时器被取消不再触发回调内的复位，残留非 0 值
      // 会让 remount 后 replay* 的「已有待发回播」早退永久成立（退避档通道失效）。
      settingsReplayTimer = 0;
      clearTimeout(widgetsTimer);
      clearTimeout(dockTimer);
      /* 摘除 switchScreen 挂的 dock 冲刷钩子（防迟到的 flusher 调用
         已卸载订阅后的陈旧闭包）。：widgets 冲刷钩子同款摘除。 */
      registerDockBroadcastFlusher(null);
      registerWidgetsBroadcastFlusher(null);
      clearTimeout(appTimer);
      appEmitPending = false;
      clearTimeout(appReplayTimer);
      appReplayTimer = 0;
      clearTimeout(habitsTimer);
      unsubWidgetsStore();
      unsubViewSwitch();
      unsubDockStore();
      unsubAppStore();
      unsubPomodoroStore();
      unsubSessionStore();
      unsubInterruptionStore();
      stopPomodoroWalk();
      unsubHabitsStore();
      unsubs.forEach((u) => u());
    };
  }, []);
}

/**
 * 只读设置窗口（taskbar-net 网速条）的精简跨窗同步：只收发 sync:settings——
 * 主题 token / 网速显示选项即时生效即可。此前挂完整 useCrossWindowSync：该窗
 * 会接收 sync:widgets 整包快照（全 instances/views/trash）、sync:app 整表
 * 任务/截止日、habits、pomodoro 包，逐包做三方合并 + setState +
 * reconcileDockTiles，还额外 repullWidgetsFromDb——对一个只渲染两个数字的
 * 常驻窗口是纯开销（注释自称「静默接收端」，代码上却付全价）。
 */
export function useCrossWindowSettingsSync() {
  useEffect(() => {
    if (!isTauri()) return;
    const unsubBroadcast = setupSettingsBroadcast();
    // 卫星窗同样参与恢复备份的 pause-ack 协议（置位闸门 + 回 ack +
    // resume 解除），否则发起方按 getAll() 计数永远等不齐 ack。
    const unsubPersistGate = setupPersistGateListeners();
    let disposed = false;
    let un: (() => void) | undefined;
    void (async () => {
      const { listen } = await import("@tauri-apps/api/event");
      const u = await listen<SettingsSyncPayload>(SYNC_EVENTS.settings, (e) => {
        handleRemoteSettingsPayload(e.payload);
      });
      if (disposed) u();
      else un = u;
    })().catch((err: unknown) => {
      /* ①：卫星窗单监听注册失败不留未处理 rejection（窗口退化为「本地
         设置不跟随远端」，下一次挂载自愈），上报进控制台供诊断。 */
      console.error("[sync] settings-only listen chain interrupted:", err);
    });
    return () => {
      disposed = true;
      un?.();
      unsubBroadcast();
      unsubPersistGate();
    };
  }, []);
}
