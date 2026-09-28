/**
 * 通知中心列表主体（DOCK / 方案 D）：通知中心小组件与 dock 通知面板共用。
 *
 * 交互（分组/条目两级交互规范）：
 *  - 按来源分组；折叠态只显最新 2 条（第 2 条半透明暗示"还有更多"），
 *    点击组头/箭头展开全部；
 *  - 横向拖动删除：折叠组整卡可滑（删整组），展开组逐条可滑（删单条）。
 *    被拖项 1:1 跟手，同宿主内相邻项 0.3× / 隔一项 0.1× 弹性跟随，越过
 *    70px 阈值邻项脱跟；松手超阈值播 350ms 滑出后真正删除，否则弹回。
 *    拖动期间禁用过渡（跟手），松手后过渡接管（弹回 / 滑出）。中键直接删。
 *  - 删除/清空后底部出现 6s 恢复条（undo 槽由 store 维护）；
 *  - 底部：免打扰开关 + 一键清除（两段式确认）；空状态占位。
 *  - 「看到即已读」：面板处于活跃态且存在未读时，停留 1.2s 后全部标已读。
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactNode
} from "react";
import {
  AppWindow,
  Bell,
  BellOff,
  Bluetooth,
  CalendarDays,
  Check,
  CheckSquare,
  ChevronDown,
  CloudSun,
  Inbox,
  LocateFixed,
  Repeat,
  RotateCcw,
  Timer,
  Trash2,
  X,
  type LucideIcon
} from "lucide-react";
import { useT, type TranslateFn } from "../../i18n-lite";
import { SOURCE_TO_WIDGET, findInstanceIdByType, locateInstanceOnCanvas } from "../locate-widget";
import { useWidgetExpand } from "../expand-store";
import { setDnd, useDnd } from "../../lib/dnd";
import { useNow } from "../../lib/use-now";
import { useSafeTimeout } from "../../lib/use-safe-timeout";
import { prefersReducedMotion } from "../../lib/anim";
import { animDurations } from "../../lib/durations";
import { useConfirmAction } from "../../lib/use-confirm-remove";
import { useIncrementalList } from "../../lib/use-incremental-list";
import type { NotificationRecord } from "../../types/bindings/NotificationRecord";
import { friendlyTime, groupNotifications, swipeFollowOffset, type NotificationGrouping } from "./notification-model";
import {
  ensureNotificationListeners,
  selectUnreadCount,
  UNDO_WINDOW_MS,
  useNotificationStore
} from "./notification-store";
import "../../styles/feature-notifications.css";

/** 滑动删除确认阈值（滑动确认阈值）。 */
export const SWIPE_THRESHOLD = 70;
/** 方向锁定前的死区：小于此位移不区分横/纵，避免误吞垂直滚动。 */
const LOCK_DEADZONE = 6;
/* P1（动效速度档对齐）：退场/入场计时器此前写死标准档毫秒数（330/360/380），
   不随 设置→动效 速度档缩放——slow 档 CSS 放慢一倍后动画播到一半就被 JS
   卸载掐断。改为运行时读 animDurations()（时长单一真源），与 GroupBloom /
   ToastHost 的「派生值 + 余量」同范式。 */
/** 滑出动画时长：与 CSS .nc-row 滑出过渡同源（--dur-spatial-fast）+ 帧余量。 */
const leaveMs = () => animDurations().spatialFastMs + 20;
/** 「看到即已读」停留时长（非动画时长，不随速度档缩放）。 */
const READ_DWELL_MS = 1200;
/** 到达入场动画时长：与 CSS nc-arrive 同源（--dur-spatial-fast）+ 帧余量。 */
const arriveMs = () => animDurations().spatialFastMs + 20;
/** 批量退场总窗口：nc-mass-leave（--dur-fx）+ 逐组错落 40ms×4 档 + 帧余量。 */
const massLeaveMs = () => animDurations().fxMs + 4 * 40 + 30;

/** 来源 → 展示名与图标；未知来源回落原字符串 + 铃铛。 */
const SOURCE_META: Record<string, { label: string; icon: LucideIcon }> = {
  pomodoro: { label: "番茄钟", icon: Timer },
  todo: { label: "待办与截止", icon: CheckSquare },
  deadline: { label: "待办与截止", icon: CheckSquare },
  habit: { label: "习惯打卡", icon: Repeat },
  calendar: { label: "日历", icon: CalendarDays },
  timetable: { label: "课程表", icon: CalendarDays },
  countdown: { label: "倒计时", icon: Timer },
  email: { label: "邮件", icon: Inbox },
  weather: { label: "天气", icon: CloudSun },
  bluetooth: { label: "蓝牙", icon: Bluetooth },
  app: { label: "应用", icon: AppWindow }
};

function sourceMeta(source: string): { label: string; icon: LucideIcon } {
  return SOURCE_META[source] ?? { label: source, icon: Bell };
}

/* ------------------------------------------------------------------ *
 * 滑动宿主：一列可横滑的行共享一个「谁在拖 / 拖了多远」状态，行按序号求
 * 各自的跟随位移。pointermove 每帧写 ref，rAF 合并成一次 setState。
 * ------------------------------------------------------------------ */
type SwipeDrag = { index: number; dx: number } | null;

type SwipeHost = {
  drag: SwipeDrag;
  setLive: (d: SwipeDrag) => void;
};

function useSwipeHost(): SwipeHost {
  const [drag, setDrag] = useState<SwipeDrag>(null);
  const raf = useRef(0);
  const live = useRef<SwipeDrag>(null);
  const setLive = useCallback((d: SwipeDrag) => {
    live.current = d;
    cancelAnimationFrame(raf.current);
    raf.current = requestAnimationFrame(() => setDrag(live.current));
  }, []);
  useEffect(() => () => cancelAnimationFrame(raf.current), []);
  return useMemo(() => ({ drag, setLive }), [drag, setLive]);
}

type SwipeRowProps = {
  host: SwipeHost;
  index: number;
  /** 松手越过阈值 / 中键：播滑出动画后回调真正删除。 */
  onDismiss: () => void;
  /** 无位移的纯点击（拖动后的 click 被吞掉）。 */
  onTap?: () => void;
  className: string;
  /** 透传到行根的自定义属性（--sti 批量退场错落等）；位移 / 离场 transform 由行内状态独占。 */
  style?: CSSProperties;
  children: ReactNode;
};

/** 一行可横滑删除的卡片：手势状态机 + 跟随位移 + 滑出退场。 */
function SwipeRow({ host, index, onDismiss, onTap, className, style: outerStyle, children }: SwipeRowProps) {
  const safeTimeout = useSafeTimeout();
  const start = useRef<{ x: number; y: number; id: number; locked: "h" | "v" | null } | null>(null);
  const swallowClick = useRef(false);
  const [leaving, setLeaving] = useState<"left" | "right" | null>(null);
  const dragging = host.drag?.index === index;
  const offset = host.drag && !leaving ? swipeFollowOffset(host.drag.index, host.drag.dx, index, SWIPE_THRESHOLD) : 0;

  const dismiss = useCallback(
    (dir: "left" | "right") => {
      if (leaving) return;
      setLeaving(dir);
      // P1（reduce-motion 双标修复）：与批量退场 massLeaveCommit 同款短路——
      // 减少动态开启时直接删除，不再让瞬移到屏外终点的行占布局一个计时窗口。
      if (prefersReducedMotion()) {
        onDismiss();
        return;
      }
      safeTimeout(onDismiss, leaveMs());
    },
    [leaving, onDismiss, safeTimeout]
  );

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (leaving) return;
    const target = e.target as HTMLElement;
    // 行内控件（展开按钮等）自行处理，不启动手势。
    if (target.closest("button, a, input, [data-no-swipe]")) return;
    if (e.button === 1) {
      e.preventDefault();
      const rect = e.currentTarget.getBoundingClientRect();
      dismiss(e.clientX < rect.left + rect.width / 2 ? "left" : "right");
      return;
    }
    if (e.button !== 0) return;
    start.current = { x: e.clientX, y: e.clientY, id: e.pointerId, locked: null };
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const s = start.current;
    if (!s || s.id !== e.pointerId) return;
    const dx = e.clientX - s.x;
    const dy = e.clientY - s.y;
    if (!s.locked) {
      if (Math.abs(dx) < LOCK_DEADZONE && Math.abs(dy) < LOCK_DEADZONE) return;
      s.locked = Math.abs(dx) > Math.abs(dy) ? "h" : "v";
      if (s.locked === "h") {
        swallowClick.current = true;
        try {
          e.currentTarget.setPointerCapture(e.pointerId);
        } catch {
          // 极少数环境不支持捕获：仍可在行内拖动
        }
      }
    }
    if (s.locked !== "h") return;
    host.setLive({ index, dx });
  };

  const finish = (e: ReactPointerEvent<HTMLDivElement>, cancelled: boolean) => {
    const s = start.current;
    if (!s || s.id !== e.pointerId) return;
    start.current = null;
    if (s.locked !== "h") return;
    host.setLive(null);
    const dx = e.clientX - s.x;
    if (!cancelled && Math.abs(dx) > SWIPE_THRESHOLD) dismiss(dx < 0 ? "left" : "right");
  };

  const onClick = () => {
    if (swallowClick.current) {
      swallowClick.current = false;
      return;
    }
    onTap?.();
  };

  const style: CSSProperties | undefined = leaving
    ? outerStyle
    : offset !== 0
      ? { ...outerStyle, transform: `translate3d(${Math.round(offset)}px, 0, 0)` }
      : outerStyle;
  const cls = `${className}${dragging ? " is-dragging" : ""}${leaving ? ` is-leaving-${leaving}` : ""}`;

  return (
    <div
      className={cls}
      style={style}
      data-interactive
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={(e) => finish(e, false)}
      onPointerCancel={(e) => finish(e, true)}
      onClick={onClick}
    >
      {children}
    </div>
  );
}

/* ------------------------------------------------------------------ */

function NotificationItemView({
  record,
  now,
  tr,
  expanded,
  dim
}: {
  record: NotificationRecord;
  now: number;
  tr: TranslateFn;
  expanded: boolean;
  dim?: boolean;
}) {
  return (
    <div
      className={`nc-item${expanded ? " is-expanded" : ""}${dim ? " is-dim" : ""}${record.read ? "" : " is-unread"}`}
      data-kind={record.kind}
    >
      <span className="nc-item-bar" aria-hidden="true" />
      <div className="nc-item-main">
        <div className="nc-item-head">
          <span className="nc-item-title">{record.title}</span>
          <span className="nc-item-time">{friendlyTime(record.created_at, now, tr)}</span>
        </div>
        {record.body && <div className="nc-item-body">{record.body}</div>}
      </div>
    </div>
  );
}

type GroupProps = {
  group: NotificationGrouping;
  index: number;
  listHost: SwipeHost;
  expanded: boolean;
  /** 批量退场中（清除全部 / 本组被整组移除）：播 nc-mass-leave，播完由父级提交 store。 */
  leaving?: boolean;
  onToggle: () => void;
  now: number;
  tr: TranslateFn;
  onDismissRecord: (id: string) => void;
  onDismissGroup: (source: string, ids: string[]) => void;
  /** 外层 .nc-list 滚动容器节点：展开组的增量窗口把滚动监听绑到它上面。 */
  scrollNode: HTMLElement | null;
  /** 来源可定位时点击组头「定位」：切视图 + 选中 + 脉冲高亮来源组件。 */
  onLocate?: () => void;
  /** 到达中的记录 id：组卡与展开行挂 is-arriving 播入场。 */
  arrivingIds: ReadonlySet<string>;
  /** 一.10 最近一次本组展开/收起方向：nc-swap-in 按 --nc-swap-y 翻转位移——
     展开向下生长（默认 -4px）、收起向上收拢（6px），不再两方向同一条动画。 */
  swapDir?: "open" | "close";
};

/** 展开态的组：逐条可滑；组内自有滑动宿主（跟随只在组内传播）。
 *  组内条目走增量窗口（initial 30，滚近底部扩容）：MEMORY_CAP=200 条同源
 *  通知全量挂载曾是通知中心最大的 DOM 热点（200 个 SwipeRow + 30s 全列表
 *  重渲）；滚动容器复用外层 .nc-list（经 scrollNode 传入绑定）。 */
function ExpandedGroupItems({
  group,
  now,
  tr,
  onDismissRecord,
  scrollNode,
  arrivingIds
}: Pick<GroupProps, "group" | "now" | "tr" | "onDismissRecord" | "arrivingIds"> & { scrollNode: HTMLElement | null }) {
  const host = useSwipeHost();
  const { items, scrollRef, remaining, loadMore } = useIncrementalList(group.records, { initial: 30, step: 30 });
  useEffect(() => {
    scrollRef(scrollNode);
    return () => scrollRef(null);
  }, [scrollNode, scrollRef]);
  return (
    <div className="nc-group-items">
      {items.map((r, i) => (
        <SwipeRow
          key={r.id}
          host={host}
          index={i}
          className={`nc-row${arrivingIds.has(r.id) ? " is-arriving" : ""}`}
          onDismiss={() => onDismissRecord(r.id)}
        >
          <NotificationItemView record={r} now={now} tr={tr} expanded />
        </SwipeRow>
      ))}
      {remaining > 0 && (
        <button type="button" className="nc-more" aria-live="polite" onClick={loadMore} data-interactive>
          {tr("继续滚动加载剩余 {n} 条", { n: remaining })}
        </button>
      )}
    </div>
  );
}

function NotificationGroupCard({
  group,
  index,
  listHost,
  expanded,
  leaving,
  onToggle,
  now,
  tr,
  onDismissRecord,
  onDismissGroup,
  scrollNode,
  onLocate,
  arrivingIds,
  swapDir
}: GroupProps) {
  const meta = sourceMeta(group.source);
  const Icon = meta.icon;
  const count = group.records.length;
  const latest = group.records[0];
  /* 批量退场（清除全部 / 整组移除）：逐组错落播 nc-mass-leave。 */
  const leaveStyle = { "--sti": Math.min(index, 4) } as CSSProperties;
  /* 一.10 方向性交换动画：变量挂在组根，.nc-group / .nc-group-items 的
     nc-swap-in 关键帧经 var() 消费（自定义属性沿子树继承）。 */
  const swapStyle = { "--nc-swap-y": swapDir === "close" ? "6px" : "-4px" } as CSSProperties;
  const leaveCls = leaving ? " is-leaving" : "";
  const header = (
    <div className="nc-group-head">
      <span className="nc-group-icon" aria-hidden="true">
        <Icon size={14} />
      </span>
      <span className="nc-group-name">{tr(meta.label)}</span>
      <span className="nc-group-time">{latest ? friendlyTime(latest.created_at, now, tr) : ""}</span>
      {onLocate && (
        <button
          className="nc-group-locate"
          onClick={(e) => {
            e.stopPropagation();
            onLocate();
          }}
          aria-label={tr("定位来源组件")}
          title={tr("定位来源组件")}
          data-interactive
        >
          <LocateFixed size={13} />
        </button>
      )}
      <button
        className={`nc-group-expand${expanded ? " is-open" : ""}`}
        onClick={(e) => {
          e.stopPropagation();
          onToggle();
        }}
        aria-expanded={expanded}
        aria-label={expanded ? tr("收起") : tr("展开全部")}
        title={expanded ? tr("收起") : tr("展开全部")}
        data-interactive
      >
        {count > 1 && (
          /* key=count：新通知并入已有组时徽标重挂弹跳（w-num-pop），折叠卡
             本体不重挂、滑动/展开状态不丢。 */
          <span className="nc-group-count" key={count}>
            {count}
          </span>
        )}
        <ChevronDown size={13} />
      </button>
    </div>
  );

  if (expanded) {
    return (
      <div className={`nc-group is-expanded${leaveCls}`} style={{ ...leaveStyle, ...swapStyle }} data-interactive>
        {header}
        <ExpandedGroupItems
          group={group}
          now={now}
          tr={tr}
          onDismissRecord={onDismissRecord}
          scrollNode={scrollNode}
          arrivingIds={arrivingIds}
        />
      </div>
    );
  }
  const visible = group.records.slice(0, 2);
  return (
    <SwipeRow
      host={listHost}
      index={index}
      className={`nc-group nc-row${latest && arrivingIds.has(latest.id) ? " is-arriving" : ""}${leaveCls}`}
      style={{ ...leaveStyle, ...swapStyle }}
      onDismiss={() =>
        onDismissGroup(
          group.source,
          group.records.map((r) => r.id)
        )
      }
      onTap={onToggle}
    >
      {header}
      <div className="nc-group-items">
        {visible.map((r, i) => (
          <NotificationItemView key={r.id} record={r} now={now} tr={tr} expanded={false} dim={i === 1 && count > 2} />
        ))}
      </div>
    </SwipeRow>
  );
}

/* ------------------------------------------------------------------ */

export type NotificationCenterListProps = {
  /** 面板是否可见/活跃：决定「看到即已读」是否生效（dock 面板收起时为 false）。 */
  active?: boolean;
  /** 紧凑模式（dock 面板）：去掉外边距。 */
  compact?: boolean;
};

export function NotificationCenterList({ active = true, compact = false }: NotificationCenterListProps) {
  const tr = useT();
  const safeTimeout = useSafeTimeout();
  const records = useNotificationStore((s) => s.records);
  const hydrated = useNotificationStore((s) => s.hydrated);
  const undo = useNotificationStore((s) => s.undo);
  const unread = useNotificationStore(selectUnreadCount);
  const dnd = useDnd();
  const now = useNow(30_000).getTime();
  const listHost = useSwipeHost();
  const [expandedSources, setExpandedSources] = useState<Set<string>>(() => new Set());
  const { confirmingId: confirmClear, request: requestClear } = useConfirmAction();

  useEffect(() => {
    ensureNotificationListeners();
    void useNotificationStore.getState().hydrate();
  }, []);

  /* 看到即已读：活跃 + 有未读 → 停留 READ_DWELL_MS 后翻转。 */
  useEffect(() => {
    if (!active || unread === 0) return;
    const t = window.setTimeout(() => useNotificationStore.getState().markAllRead(), READ_DWELL_MS);
    return () => window.clearTimeout(t);
  }, [active, unread]);

  /* undo 槽超时自动消隐（store 不带定时器，UI 负责）。 */
  useEffect(() => {
    if (!undo) return;
    const left = Math.max(0, UNDO_WINDOW_MS - (Date.now() - undo.at));
    safeTimeout(() => {
      if (useNotificationStore.getState().undo === undo) useNotificationStore.getState().dismissUndo();
    }, left);
  }, [undo, safeTimeout]);

  const groups = useMemo(() => groupNotifications(records), [records]);

  /* 到达入场：records 与上次 diff，fresh id 短暂挂 enteringIds 播 nc-arrive
     （首次水合不播）；只新增 id，已读翻转等记录更新不触发。 */
  const [arrivingIds, setArrivingIds] = useState<ReadonlySet<string>>(() => new Set());
  const knownIdsRef = useRef<Set<string> | null>(null);
  useEffect(() => {
    const prev = knownIdsRef.current;
    const ids = records.map((r) => r.id);
    if (prev) {
      const fresh = ids.filter((id) => !prev.has(id));
      if (fresh.length > 0) {
        setArrivingIds((s) => {
          const next = new Set(s);
          for (const id of fresh) next.add(id);
          return next;
        });
        safeTimeout(() => {
          setArrivingIds((s) => {
            const next = new Set(s);
            for (const id of fresh) next.delete(id);
            return next;
          });
        }, arriveMs());
      }
    }
    knownIdsRef.current = new Set(ids);
  }, [records, safeTimeout]);

  /* 组级增量窗口：源数量本身不大，但每组展开最多 200 条（MEMORY_CAP），
     外层窗口与组内窗口共用 .nc-list 滚动容器（scrollNode 下传）。 */
  const {
    items: visibleGroups,
    scrollRef,
    remaining: groupsRemaining,
    loadMore: loadMoreGroups
  } = useIncrementalList(groups, {
    initial: 20,
    step: 20
  });
  const [scrollNode, setScrollNode] = useState<HTMLElement | null>(null);
  const listRef = useCallback(
    (node: HTMLElement | null) => {
      scrollRef(node);
      setScrollNode(node);
    },
    [scrollRef]
  );

  /* 一.10 记录每组最近一次切换方向，供 nc-swap-in 按 --nc-swap-y 翻转位移。 */
  const [swapDirs, setSwapDirs] = useState<Map<string, "open" | "close">>(() => new Map());

  const toggleGroup = (source: string) => {
    const closing = expandedSources.has(source);
    setExpandedSources((prev) => {
      const next = new Set(prev);
      if (closing) next.delete(source);
      else next.add(source);
      return next;
    });
    setSwapDirs((m) => new Map(m).set(source, closing ? "close" : "open"));
  };

  /* 批量退场：先逐组错落播 nc-mass-leave（单条滑动删除有自己的 leaving 退场，
     批量路径此前是瞬删），播完才提交 store。reduce-motion 直接瞬删。 */
  const [massLeave, setMassLeave] = useState<{ mode: "all" | "group"; source: string } | null>(null);
  const massLeaveCommit = (run: () => void, entry: { mode: "all" | "group"; source: string }) => {
    if (prefersReducedMotion()) {
      run();
      return;
    }
    setMassLeave(entry);
    safeTimeout(() => {
      run();
      setMassLeave((cur) => (cur === entry ? null : cur));
    }, massLeaveMs());
  };

  const dismissRecord = (id: string) => useNotificationStore.getState().deleteRecord(id);
  const dismissGroup = (source: string, ids: string[]) =>
    massLeaveCommit(() => useNotificationStore.getState().deleteRecords(ids), { mode: "group", source });

  const onClear = () => {
    if (!requestClear("clear")) return;
    massLeaveCommit(() => useNotificationStore.getState().clearAll(), { mode: "all", source: "all" });
  };

  return (
    <div className={`nc${compact ? " is-compact" : ""}`}>
      <div className="nc-list scroll-fade-y" data-interactive ref={listRef}>
        {visibleGroups.map((g, i) => {
          /* 定位来源组件（通知 → 行动）：来源可映射到小组件类型且画布上
             存在该组件时提供按钮；dock 面板场景（compact）先收起面板再定位，
             免得面板盖住目标。 */
          const widgetType = SOURCE_TO_WIDGET[g.source];
          const locateId = widgetType ? findInstanceIdByType(widgetType) : null;
          return (
            <NotificationGroupCard
              key={g.source}
              group={g}
              index={i}
              listHost={listHost}
              expanded={expandedSources.has(g.source)}
              leaving={!!massLeave && (massLeave.mode === "all" || massLeave.source === g.source)}
              onToggle={() => toggleGroup(g.source)}
              now={now}
              tr={tr}
              onDismissRecord={dismissRecord}
              onDismissGroup={dismissGroup}
              scrollNode={scrollNode}
              arrivingIds={arrivingIds}
              swapDir={swapDirs.get(g.source)}
              onLocate={
                locateId
                  ? () => {
                      if (compact) useWidgetExpand.getState().collapse();
                      locateInstanceOnCanvas(locateId);
                    }
                  : undefined
              }
            />
          );
        })}
        {groupsRemaining > 0 && (
          <button type="button" className="nc-more" aria-live="polite" onClick={loadMoreGroups} data-interactive>
            {tr("继续滚动加载剩余 {n} 组", { n: groupsRemaining })}
          </button>
        )}
        {hydrated && groups.length === 0 && (
          <div className="nc-empty">
            <BellOff size={22} />
            <span>{tr("暂无通知")}</span>
            <span className="nc-empty-sub">{tr("番茄钟、待办与各小组件的提醒会在这里留档")}</span>
          </div>
        )}
      </div>

      {undo && (
        <div className="nc-undo" key={undo.at} data-interactive>
          <span className="nc-undo-text">{tr("已删除 {n} 条通知").replace("{n}", String(undo.records.length))}</span>
          <button
            className="nc-undo-btn"
            onClick={() => useNotificationStore.getState().restoreDeleted()}
            data-interactive
          >
            <RotateCcw size={12} />
            {tr("恢复")}
          </button>
          <button
            className="nc-undo-close"
            onClick={() => useNotificationStore.getState().dismissUndo()}
            aria-label={tr("关闭")}
            title={tr("关闭")}
            data-interactive
          >
            <X size={12} />
          </button>
        </div>
      )}

      <div className="nc-foot" data-interactive>
        <button
          className={`nc-dnd${dnd ? " is-on" : ""}`}
          onClick={() => setDnd(!dnd)}
          role="switch"
          aria-checked={dnd}
          title={dnd ? tr("免打扰已开启：不弹通知、不响铃，历史照常留档") : tr("开启免打扰")}
          data-interactive
        >
          {dnd ? <BellOff size={13} /> : <Bell size={13} />}
          <span>{tr("免打扰")}</span>
          <span className="nc-dnd-track" aria-hidden="true">
            <span className="nc-dnd-thumb" />
          </span>
        </button>
        <button
          className={`nc-clear${confirmClear ? " is-confirming" : ""}`}
          onClick={onClear}
          disabled={records.length === 0}
          title={confirmClear ? tr("再次点击确认清除") : tr("清除全部通知")}
          aria-label={confirmClear ? tr("再次点击确认清除") : tr("清除全部通知")}
          data-interactive
        >
          {confirmClear ? <Check size={13} /> : <Trash2 size={13} />}
          <span>{confirmClear ? tr("确认清除") : tr("清除全部")}</span>
        </button>
      </div>
    </div>
  );
}
