/**
 * 日历小组件：月/周/双月视图、事件（含重复规则展开）、ICS 订阅、节假日标注
 * 与今日 DDL 聚合；选中日详情为时间线视图（刻度轴 + 事件块 + 当前时刻线）。
 * 重复展开在 useMemo 内预解析锚点（P-perf）；提醒已上移到主窗单驱动调度器
 * （calendar-reminders），组件只负责展示与编辑。
 */
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import {
  Bell,
  Calendar,
  Check,
  ChevronLeft,
  ChevronRight,
  Download,
  RefreshCw,
  Repeat,
  Search,
  Upload,
  X
} from "lucide-react";
import { getHoliday, getLunarInfo } from "../../lib/lunar";
import { useAppStore } from "../../store/app-store";
import { useHabitsStore } from "../../store/habits-store";
import { useWidgetConfig, loadWidgetConfig, CHANGE_EVENT } from "../widget-config";
import { useWidgetStore, loadInstances } from "../widget-store";
import { parseTimeList, sanitizeTimetableData, type TimetableData } from "../timetable";
import { sessionsOnDate, type SyncedCourseEvent } from "../timetable-extras";
import { useT } from "../../i18n-lite";
import { useDelayedUnmount } from "../../lib/anim";
import { animDurations } from "../../lib/durations";
import { CalendarEventEditor } from "./calendar-event-editor";
import {
  calendarDateKey as dateKey,
  calendarEventsKey as eventsKey,
  hhmmToMin,
  icsToEventDraft,
  mergeImportedEvents,
  splitRepeatOnce,
  layoutTimeline,
  loadCalendarEvents as loadEvents,
  minToHHMM,
  parseCalendarKey as parseKey,
  repeatMatches,
  type CalendarEvent,
  type EventMap,
  type TimelineItem
} from "./calendar-shared";
import { useTauriEvent } from "../../lib/use-tauri-event";
import { ensureHolidayData, subscribeRemoteHolidays } from "../../lib/holiday-update";
import { scheduleMirrorSync } from "../../lib/local-backup";
import { buildCalendarIcs, fetchIcsEvents, parseIcs, type IcsEvent } from "../../lib/ics";
import { useSafeTimeout } from "../../lib/use-safe-timeout";

const WEEKDAYS_MON = ["一", "二", "三", "四", "五", "六", "日"];
const WEEKDAYS_SUN = ["日", "一", "二", "三", "四", "五", "六"];
const WEEKDAY_CN = ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"];
const MONTHS_CN = ["一月", "二月", "三月", "四月", "五月", "六月", "七月", "八月", "九月", "十月", "十一月", "十二月"];

/** 单字星期缩写 → 完整名称，用于翻译表头。 */
const SHORT_WEEKDAYS: Record<string, string> = {
  一: "周一",
  二: "周二",
  三: "周三",
  四: "周四",
  五: "周五",
  六: "周六",
  日: "周日"
};

/** 日历角标语义：数据源（getHoliday）以中文字面量「休」「班」标记
 *  放假/调休上班——判定与渲染都改用本语义枚举（与课表侧 timetable-extras
 *  的 holidayKind 同一取值），显示文本经 tr("休")/tr("班") 翻译（词典条目
 *  与课表角标共用：Off / Workday），不再把汉字硬编码在 JSX 里。 */
type HolidayKind = "rest" | "work";

/** 数据源汉字标记 → 语义枚举；其余标记（「假」「纪念」）不渲染角标，返回
 *  null。数据源契约见 lunar.ts 的 HolidayInfo（mark 取值休/班/假/纪念）。 */
function holidayMarkKind(mark: string | undefined): HolidayKind | null {
  if (mark === "休") return "rest";
  if (mark === "班") return "work";
  return null;
}

/** 时间线每小时刻度高度（px）。 */
const TL_HOUR_PX = 52;

/** ICS 订阅自动刷新间隔。 */
const ICS_AUTO_REFRESH_MS = 30 * 60_000;

/** 计算 ISO 8601 周数（周一为一周起点，第 1 周包含该年首个周四）。 */
function getISOWeekNumber(date: Date): number {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
}

/** 重复规则短标签（搜索结果 / 删除菜单提示用）。
 *  间隔 >1 时按「每 N 天/周/月/年」组装——单位词单取（天/周/月/年），
 *  不再从 base.slice(1) 截：那是对中文字形的假设，英文 "Every day" 截出
 *  "very day"，产出「Every 3 very day」。 */
function repeatLabel(ev: CalendarEvent, tr: (s: string) => string): string {
  if (ev.repeat === "none") return "";
  const base =
    ev.repeat === "daily"
      ? tr("每天")
      : ev.repeat === "weekly"
        ? tr("每周")
        : ev.repeat === "monthly"
          ? tr("每月")
          : tr("每年");
  if (ev.repeatEvery > 1) {
    const unit =
      ev.repeat === "daily"
        ? tr("天")
        : ev.repeat === "weekly"
          ? tr("周")
          : ev.repeat === "monthly"
            ? tr("月")
            : tr("年");
    return `${tr("每")} ${ev.repeatEvery} ${unit}`;
  }
  return base;
}

export function CalendarWidget({ instanceId }: { instanceId: string }) {
  const tr = useT();
  const safeTimeout = useSafeTimeout();
  const [today, setToday] = useState(() => new Date());
  const [view, setView] = useState(() => {
    const n = new Date();
    return new Date(n.getFullYear(), n.getMonth(), 1);
  });
  /* 周视图游标（当前展示的那一周里的任一天）。 */
  const [weekCursor, setWeekCursor] = useState(() => new Date());
  const [events, setEvents] = useState<EventMap>(() => loadEvents(instanceId));
  const { config, update: updateConfig } = useWidgetConfig(instanceId);
  /* 默认选中今天：点开组件即见当日时间线（用户工作流：「点开每天的日程」）。 */
  const [selected, setSelected] = useState<string | null>(() => {
    const n = new Date();
    return dateKey(n.getFullYear(), n.getMonth(), n.getDate());
  });
  /* 编辑中的事件（key + id + dayKey）；null = 添加模式。dayKey 为打开
     编辑器时的查看日（与 deleteMenu 同款冻结）：编辑器常驻渲染期间用户
     可能点周条/月格换天，saveEvent「仅此日」若读实时 selected 会把系列分裂
     到错误的日期上（原系列在错误点截断 + 续系列从错误日重锚）。 */
  const [editingEvent, setEditingEvent] = useState<{ key: string; id: string; dayKey: string } | null>(null);
  const [holVersion, setHolVersion] = useState(0);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  /* 重复事件删除三选一（仅此日 / 此日及以后 / 整个系列）。dayKey 固定为
     打开菜单时的查看日：菜单 6s 内用户可能点周条换天，此时 selected 已变，
     「仅此日」若读实时 selected 会把例外记到错误的日期上。 */
  const [deleteMenu, setDeleteMenu] = useState<{ key: string; id: string; dayKey: string } | null>(null);
  /* 删除/改系列前的事件快照（撤销条，5s 内可撤销）。kind 区分撤销语义
     once = 从例外集移回该日（与「仅此日编辑」的系列分裂正交）；
     whole = 整对象恢复（整删/终止日修改）。 */
  const [undoState, setUndoState] = useState<{
    key: string;
    prev: CalendarEvent;
    kind: "whole" | "once";
    dayKey?: string;
  } | null>(null);
  useEffect(() => {
    if (!confirmDelete) return;
    safeTimeout(() => setConfirmDelete(null), 2000);
  }, [confirmDelete, safeTimeout]);
  useEffect(() => {
    if (!deleteMenu) return;
    safeTimeout(() => setDeleteMenu(null), 6000);
  }, [deleteMenu, safeTimeout]);
  useEffect(() => {
    if (!undoState) return;
    safeTimeout(() => setUndoState(null), 5000);
  }, [undoState, safeTimeout]);
  const [showPicker, setShowPicker] = useState(false);
  const [pickerYear, setPickerYear] = useState(() => view.getFullYear());
  const pickerRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const tlScrollRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  /* 导入结果反馈（条数；-1 = 解析失败）。 */
  /* 导入结果反馈（skipped=-1 = 解析失败/空文件）。 */
  const [importNotice, setImportNotice] = useState<{ added: number; skipped: number } | null>(null);
  useEffect(() => {
    if (importNotice == null) return;
    safeTimeout(() => setImportNotice(null), 3000);
  }, [importNotice, safeTimeout]);
  /* 时间轴空白快速创建：点击时刻（15 分钟吸附）预填进添加行。 */
  const [quickCreateTime, setQuickCreateTime] = useState<string | null>(null);
  /* 时间线块拖拽（非重复自有事件）：竖向平移改时刻（15 分钟吸附、时长
   *  保持）。moved 阈值 4px 内视为点击（进编辑）；dragJustEnded 拦截拖拽
   *  结束后紧跟的那次 click，避免「拖完立即弹编辑」。
   *  dragStateRef 镜像：pointermove 频率高于 React 渲染帧率，渲染间隙
   *  到达的 move 事件若读 state 闭包（尚未重渲染）会拿到旧值 null——计算
   *  路径一律走 ref，state 仅驱动拖拽中的视觉跟随。 */
  const [dragState, setDragState] = useState<{
    id: string;
    key: string;
    startY: number;
    startMin: number;
    durMin: number;
    newStart: number;
    moved: boolean;
  } | null>(null);
  const dragStateRef = useRef<typeof dragState>(null);
  const setDrag = (next: typeof dragState) => {
    dragStateRef.current = next;
    setDragState(next);
  };
  const dragJustEndedRef = useRef(false);
  /* 退场动画窗口：进场 cal-detail-in 用 --dur-fx，退场同节奏（w-fade-out）。 */
  const pickerVisible = useDelayedUnmount(showPicker, Math.round(animDurations().fxMs));
  /* 搜索浮层。 */
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQ, setSearchQ] = useState("");
  const searchRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!searchOpen) return;
    const onDown = (e: MouseEvent) => {
      if (searchRef.current && !searchRef.current.contains(e.target as Node)) {
        setSearchOpen(false);
        setSearchQ("");
      }
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [searchOpen]);

  /* 时间线「当前时刻」红线：30s 节拍（与 today 跨天检查同粒度、独立 state，
     today 只在跨天时才更新，不能驱动分钟级红线）。 */
  const [nowTick, setNowTick] = useState(() => new Date());
  useEffect(() => {
    const id = window.setInterval(() => {
      const n = new Date();
      setNowTick((prev) =>
        prev.getHours() * 60 + prev.getMinutes() === n.getHours() * 60 + n.getMinutes() ? prev : n
      );
      setToday((prev) =>
        prev.getFullYear() === n.getFullYear() && prev.getMonth() === n.getMonth() && prev.getDate() === n.getDate()
          ? prev
          : n
      );
    }, 30_000);
    return () => window.clearInterval(id);
  }, []);

  /* ---- 节假日在线更新：拉取远程表并订阅变更触发重渲染。 ---- */
  useEffect(() => {
    void ensureHolidayData();
    return subscribeRemoteHolidays(() => setHolVersion((v) => v + 1));
  }, []);

  /* ---- ICS 订阅：窗口跟随视图年份（翻到窗口外月份订阅事件不再消失）；
     失败保留旧数据（stale 标记）；30 分钟自动刷新。 ---- */
  const icsEnabled =
    config.icsEnabled === true && typeof config.icsUrl === "string" && /^https?:\/\//.test(config.icsUrl);
  const icsUrl = typeof config.icsUrl === "string" ? config.icsUrl.trim() : "";
  const [icsEvents, setIcsEvents] = useState<IcsEvent[]>([]);
  const [icsState, setIcsState] = useState<"idle" | "loading" | "stale" | "error">("idle");
  const [icsStamp, setIcsStamp] = useState(0);
  const winLo = Math.min(today.getFullYear(), view.getFullYear(), weekCursor.getFullYear());
  const winHi = Math.max(today.getFullYear(), view.getFullYear(), weekCursor.getFullYear()) + 1;
  useEffect(() => {
    if (!icsEnabled || !icsUrl) {
      setIcsEvents([]);
      setIcsState("idle");
      return;
    }
    let disposed = false;
    setIcsState("loading");
    const start = new Date(winLo, 0, 1);
    const end = new Date(winHi, 11, 31);
    fetchIcsEvents(icsUrl, start, end)
      .then((list) => {
        if (disposed) return;
        setIcsEvents(list);
        setIcsState("idle");
      })
      .catch(() => {
        if (disposed) return;
        // 失败保留旧数据（此前直接清空——网络抖一下订阅事件整段消失直到下次
        // 成功）；从未成功过（无数据）时按 error 展示，有数据按 stale（过期标记）。
        setIcsEvents((cur) => {
          setIcsState(cur.length > 0 ? "stale" : "error");
          return cur;
        });
      });
    return () => {
      disposed = true;
    };
  }, [icsEnabled, icsUrl, icsStamp, winLo, winHi]);
  useEffect(() => {
    if (!icsEnabled) return;
    const id = window.setInterval(() => {
      // 文档隐藏（最小化/被遮挡）时跳过本轮：回来后的下一轮自然补拉，
      // 不在后台白白发请求。
      if (document.hidden) return;
      setIcsStamp((v) => v + 1);
    }, ICS_AUTO_REFRESH_MS);
    return () => window.clearInterval(id);
  }, [icsEnabled]);

  const icsByDay = useMemo(() => {
    const map: Record<string, IcsEvent[]> = {};
    for (const ev of icsEvents) (map[ev.date] ||= []).push(ev);
    return map;
  }, [icsEvents]);

  /* ---- 课程表 → 日历同步（派生读取，不复制数据）----
     同步开关在课程表小组件设置里（calendarSync）；这里扫描所有视图的
     （instances 不变），必须订阅配置变更事件才能实时刷新。 */
  const views = useWidgetStore((s) => s.views);
  // 只订阅当前画布上课程表实例的 id 列表（useShallow 逐元素比较）：原先直接
  // 订阅 instances，任何布局变化（缩放/拖拽提交/hover 置顶改 z）都会让下面的
  // 全视图 loadInstances + JSON.parse 白跑一遍。
  const timetableIds = useWidgetStore(
    useShallow((s) => s.instances.filter((i) => i.type === "timetable").map((i) => i.id))
  );
  const [cfgVersion, setCfgVersion] = useState(0);
  useEffect(() => {
    const onChanged = () => setCfgVersion((v) => v + 1);
    window.addEventListener(CHANGE_EVENT, onChanged);
    return () => window.removeEventListener(CHANGE_EVENT, onChanged);
  }, []);
  useTauriEvent("sync:widget-config", () => setCfgVersion((v) => v + 1));

  const syncSources = useMemo(() => {
    const ids = new Set<string>(timetableIds);
    for (const v of views) {
      for (const inst of loadInstances(v.id)) {
        if (inst.type === "timetable") ids.add(inst.id);
      }
    }
    const out: { data: TimetableData; starts: string[]; ends: string[] }[] = [];
    for (const id of ids) {
      const cfg = loadWidgetConfig(id);
      if (cfg.calendarSync !== true) continue;
      const data = sanitizeTimetableData(cfg.data);
      if (data) {
        out.push({ data, starts: parseTimeList(cfg.sectionTimes), ends: parseTimeList(cfg.sectionTimesEnd) });
      }
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- cfgVersion 是配置变更的失效信号
  }, [views, timetableIds, cfgVersion]);

  const deadlines = useAppStore((s) => s.deadlines);
  const deadlinesByDay = useMemo(() => {
    const map: Record<string, { id: string; title: string; completed: boolean }[]> = {};
    for (const d of deadlines) {
      const dt = new Date(d.dueAt);
      if (Number.isNaN(dt.getTime())) continue;
      const key = dateKey(dt.getFullYear(), dt.getMonth(), dt.getDate());
      (map[key] ||= []).push({ id: d.id, title: d.title, completed: d.completed });
    }
    return map;
  }, [deadlines]);

  const showLunar = config.showLunar !== false;
  const showHolidays = config.showHolidays !== false;
  const showSolarTerms = config.showSolarTerms !== false;
  const showRestMarks = config.showRestMarks !== false;
  const showMemorialMarks = config.showMemorialMarks !== false;
  const showEventDots = config.showEventDots !== false;
  const showWeekNumber = config.showWeekNumber === true;
  const firstDayOfWeek = (config.firstDayOfWeek as string) || "monday";
  const compact = !!config.compact;
  /* 视图粒度。 */
  const viewMode =
    (config.viewMode as string) === "week" || (config.viewMode as string) === "double"
      ? (config.viewMode as "week" | "double")
      : "month";
  /* 月格事件摘要。 */
  const showCellEvents = config.showCellEvents !== false && !compact;

  const habits = useHabitsStore((s) => s.habits);
  const habitsDoneByDay = useMemo(() => {
    const map: Record<string, string[]> = {};
    for (const h of habits) {
      for (const [key, val] of Object.entries(h.done)) {
        if (val) (map[key] ||= []).push(h.name);
      }
    }
    return map;
  }, [habits]);

  useEffect(() => {
    try {
      localStorage.setItem(eventsKey(instanceId), JSON.stringify(events));
    } catch {
      // best-effort
    }
    // 写穿持久化：调度 SQLite 镜像同步（500ms 防抖合批，与便签同款）——
    // 此前日历编辑只在 hydrate/手动备份时才进镜像，编辑后立刻断电会丢
    // 到上次快照。浏览器模式 scheduleMirrorSync 内部静默 no-op。
    scheduleMirrorSync();
    // 同窗广播：今日概览监听后即时重扫（跨窗口经 reload/重启自然生效）。
    window.dispatchEvent(new Event("focus-desk:calendar-changed"));
  }, [events, instanceId]);

  /** 重复展开：某日期上的全部本组件事件（锚点 + 重复规则命中 − 单次例外）。
   *  P-perf：锚点键的 parseKey 正则解析在 memo 内一次性预解析（此前每次
   *  单日查询都对全部锚点重跑 regex——月视图 42 格 × 锚点数）。
   *  与 calendar-shared.calendarEventsOnDay 是同口径
   *  双实现（本份为月视图 42 格性能预解析版）——单侧改重复/例外/终止日规则
   *  必须同步另一侧，否则 CalendarMini（消费 shared 版）与主视图静默分裂。 */
  const eventsOnDay = useMemo(() => {
    const parsedAnchors: { key: string; anchor: Date; list: CalendarEvent[] }[] = [];
    for (const [anchorKey, list] of Object.entries(events)) {
      if (list.length === 0) continue;
      const anchor = parseKey(anchorKey);
      if (!anchor) continue;
      const repeating = list.filter((ev) => ev.repeat !== "none");
      if (repeating.length > 0) parsedAnchors.push({ key: anchorKey, anchor, list: repeating });
    }
    return (date: Date): CalendarEvent[] => {
      const key = dateKey(date.getFullYear(), date.getMonth(), date.getDate());
      const out = [...(events[key] ?? []).filter((ev) => !ev.excepted.includes(key))];
      for (const { key: anchorKey, anchor, list } of parsedAnchors) {
        if (anchorKey === key) continue;
        for (const ev of list) {
          if (!ev.excepted.includes(key) && repeatMatches(anchor, ev, date)) out.push(ev);
        }
      }
      out.sort((a, b) => a.time.localeCompare(b.time) || a.text.localeCompare(b.text));
      return out;
    };
  }, [events]);

  /** P-perf：每日事件的结果缓存（按日期键）。月格 42 格（双月 84）+ 周视图
   *  7 行在每次渲染都直调 eventsOnDay——nowTick 30s 节拍 / 选中态 / 菜单开关
   *  都会整组件重渲染，等于每 30 秒把全部锚点 × 全部格子重展开一遍。缓存
   *  随 eventsOnDay 一起重建（事件表一变即失效）。 */
  const eventsByDay = useMemo(() => {
    const cache = new Map<string, CalendarEvent[]>();
    return (date: Date): CalendarEvent[] => {
      const key = dateKey(date.getFullYear(), date.getMonth(), date.getDate());
      let v = cache.get(key);
      if (v === undefined) {
        v = eventsOnDay(date);
        cache.set(key, v);
      }
      return v;
    };
  }, [eventsOnDay]);

  // 点击外部关闭年份/月份选择。
  useEffect(() => {
    if (!showPicker) return;
    const onDown = (e: MouseEvent) => {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) {
        setShowPicker(false);
      }
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [showPicker]);

  const year = view.getFullYear();
  const month = view.getMonth();

  /* 周视图 7 天（weekCursor 所在周，可跨月；需上移到 syncedEvents 之前供其
     覆盖计算——定义顺序即依赖顺序）。 */
  const weekDays = useMemo(() => {
    const base = new Date(weekCursor.getFullYear(), weekCursor.getMonth(), weekCursor.getDate());
    const dow = firstDayOfWeek === "monday" ? (base.getDay() + 6) % 7 : base.getDay();
    base.setDate(base.getDate() - dow);
    return Array.from({ length: 7 }, (_, i) => {
      const d = new Date(base);
      d.setDate(base.getDate() + i);
      return d;
    });
  }, [weekCursor, firstDayOfWeek]);

  /** 当月（+周视图当前周，可跨月）每天的课程事件，供网格圆点/周列表/详情用。 */
  const syncedEvents = useMemo(() => {
    const map: Record<string, SyncedCourseEvent[]> = {};
    if (!syncSources.length) return map;
    const seen = new Set<string>();
    const addDate = (d: Date) => {
      const key = dateKey(d.getFullYear(), d.getMonth(), d.getDate());
      if (seen.has(key)) return;
      seen.add(key);
      for (const src of syncSources) {
        const evts = sessionsOnDate(src.data, d, src.starts, src.ends);
        if (evts.length) (map[key] ||= []).push(...evts);
      }
      if (map[key]) map[key].sort((a, b) => a.start.localeCompare(b.start));
    };
    // 月格：当月逐日。
    const d = new Date(year, month, 1);
    while (d.getMonth() === month) {
      addDate(d);
      d.setDate(d.getDate() + 1);
    }
    // 周视图翻页只动 weekCursor 不动 view（shift 提前 return）——若只按
    // view 的月份算，跨到其它月份的周里课程事件整段消失。把当前周
    // 的 7 天并入覆盖。
    for (const wd of weekDays) addDate(wd);
    return map;
  }, [syncSources, year, month, weekDays]);

  /** 生成按首日偏移的格子：null 表示空白。 */
  const weekLabels = firstDayOfWeek === "monday" ? WEEKDAYS_MON : WEEKDAYS_SUN;

  /* 切月方向：前进 +1 / 后退 -1，驱动网格方向化切换动画。 */
  const navDir = useRef(0);
  const applyDir = (next: Date) => {
    const cur = year * 12 + month;
    const dst = next.getFullYear() * 12 + next.getMonth();
    navDir.current = dst >= cur ? 1 : -1;
  };

  const shift = (delta: number) => {
    navDir.current = delta >= 0 ? 1 : -1;
    setSelected(null);
    if (viewMode === "week") {
      setWeekCursor((c) => {
        const n = new Date(c);
        n.setDate(n.getDate() + delta * 7);
        return n;
      });
      return;
    }
    setView(new Date(year, month + delta, 1));
  };
  const goToday = () => {
    const n = new Date();
    applyDir(new Date(n.getFullYear(), n.getMonth(), 1));
    setView(new Date(n.getFullYear(), n.getMonth(), 1));
    setWeekCursor(new Date(n));
    setSelected(dateKey(n.getFullYear(), n.getMonth(), n.getDate()));
  };
  const jumpTo = (y: number, m: number) => {
    setSelected(null);
    applyDir(new Date(y, m, 1));
    setView(new Date(y, m, 1));
    setWeekCursor(new Date(y, m, 1));
    setShowPicker(false);
  };

  const isToday = (y: number, m: number, d: number) =>
    d === today.getDate() && m === today.getMonth() && y === today.getFullYear();

  const openPicker = () => {
    setPickerYear(year);
    setShowPicker(true);
  };

  /* ------------------ 事件读写（/014 + 系列/例外语义） ------------------ */

  /** 删除前快照（撤销条用）。 */
  const snapshotFor = (key: string, id: string): CalendarEvent | null =>
    (events[key] ?? []).find((e) => e.id === id) ?? null;

  const removeEvent = (key: string, id: string) => {
    setEvents((prev) => {
      const list = (prev[key] ?? []).filter((e) => e.id !== id);
      const next = { ...prev };
      if (list.length > 0) next[key] = list;
      else delete next[key];
      return next;
    });
  };

  const removeEventWithUndo = (key: string, id: string) => {
    const prev = snapshotFor(key, id);
    if (prev) setUndoState({ key, prev, kind: "whole" });
    removeEvent(key, id);
    setDeleteMenu(null);
    setConfirmDelete(null);
    if (editingEvent?.id === id) setEditingEvent(null);
  };

  /** 「仅此日」：把当前查看日加入例外（系列其余日期不受影响）。 */
  const deleteEventOnce = (key: string, id: string, dayKey: string) => {
    const prev = snapshotFor(key, id);
    if (!prev) return;
    /* 撤销记录携带 kind=once + dayKey——撤销 = 从例外集移回该日（幂等，
       且与「仅此日编辑」的系列分裂正交）。此前撤销条统一整对象替换，若 5s
       窗内先删后编辑，未截断的旧快照会与分裂产物并存（编辑日重复、未来日
       双份，且永不自愈）。 */
    setUndoState({ key, prev, kind: "once", dayKey });
    setEvents((p) => ({
      ...p,
      [key]: (p[key] ?? []).map((e) => (e.id === id ? { ...e, excepted: [...new Set([...e.excepted, dayKey])] } : e))
    }));
    setDeleteMenu(null);
  };

  /** 「此日及以后」：终止日改到前一天；锚点不早于该日时等价整系列删除。 */
  const deleteEventFrom = (key: string, id: string, dayKey: string) => {
    const prev = snapshotFor(key, id);
    if (!prev) return;
    const anchor = parseKey(key);
    const day = parseKey(dayKey);
    if (!anchor || !day || anchor >= day) {
      removeEventWithUndo(key, id);
      return;
    }
    const until = new Date(day.getFullYear(), day.getMonth(), day.getDate() - 1);
    const untilKey = dateKey(until.getFullYear(), until.getMonth(), until.getDate());
    setUndoState({ key, prev, kind: "whole" });
    setEvents((p) => ({
      ...p,
      [key]: (p[key] ?? []).map((e) => (e.id === id ? { ...e, repeatUntil: untilKey } : e))
    }));
    setDeleteMenu(null);
  };

  const undoDelete = () => {
    const u = undoState;
    if (!u) return;
    setEvents((prev) => {
      const list = prev[u.key] ?? [];
      /* 仅此日删除的撤销 = 从例外集移回该日（幂等，与系列分裂正交）；
         整删/终止日修改仍是整对象恢复。once 撤销若对象已被整删（id 不在），
         map 为 no-op——放弃恢复比复活成「无例外的完整系列」更安全。 */
      if (u.kind === "once" && u.dayKey) {
        return {
          ...prev,
          [u.key]: list.map((e) =>
            e.id === u.prev.id ? { ...e, excepted: e.excepted.filter((d) => d !== u.dayKey) } : e
          )
        };
      }
      return list.some((e) => e.id === u.prev.id)
        ? { ...prev, [u.key]: list.map((e) => (e.id === u.prev.id ? u.prev : e)) }
        : { ...prev, [u.key]: [...list, u.prev] };
    });
    setUndoState(null);
  };

  const requestRemoveEvent = (key: string, id: string) => {
    const ev = (events[key] ?? []).find((e) => e.id === id);
    // 重复事件：三选一菜单（仅此日 / 此日及以后 / 整个系列）。
    // dayKey 取事件实际发生的查看日（时间线块/全天 chip 均在详情内触发，
    // selected 非 null；防御为空时回退锚点日）。
    if (ev && ev.repeat !== "none") {
      /* 实现补齐注释承诺的回退——events 的存储键
         即系列锚点日（deleteEventFrom 的 parseKey(key) 同源），selected 为空
         时以 key 兜底；此前此处直接 return，删除菜单永不弹出（静默失效）。 */
      setDeleteMenu({ key, id, dayKey: selected ?? key });
      return;
    }
    if (confirmDelete === id) {
      removeEventWithUndo(key, id);
    } else {
      setConfirmDelete(id);
    }
  };

  /** 拖拽 / 键盘微调的时刻提交：按 id 原位替换（不走 saveEvent——后者靠
   *  editingEvent 判定编辑态，拖拽路径没有该上下文，会被当成新增追加）。 */
  const commitEventMove = (key: string, id: string, time: string, endTime: string) => {
    setEvents((prev) => ({
      ...prev,
      [key]: (prev[key] ?? []).map((x) => (x.id === id ? { ...x, time, endTime } : x))
    }));
  };

  /** 保存：scope=series（默认）改整个系列；scope=once 对重复事件做系列分裂
   *  （原系列终止 + 当日单次 + 续系列），见 calendar-shared.splitRepeatOnce。 */
  const saveEvent = (key: string, draft: CalendarEvent, scope: "series" | "once" = "series") => {
    if (scope === "once" && editingEvent) {
      /* 分裂日读打开编辑器时冻结的查看日（编辑器常驻渲染期间换天后
         保存，不得把「仅此日」记到新查看的日期上）；冻结值缺失时兜底实时
         selected（防御旧状态）。 */
      const dayKey = editingEvent.dayKey || selected;
      if (dayKey) {
        const target = (events[editingEvent.key] ?? []).find((e) => e.id === editingEvent.id);
        if (target && target.repeat !== "none") {
          setEvents((prev) => splitRepeatOnce(prev, editingEvent.key, editingEvent.id, dayKey, draft));
          setEditingEvent(null);
          setQuickCreateTime(null);
          return;
        }
      }
    }
    setEvents((prev) => {
      const editing = editingEvent?.key === key ? editingEvent.id : null;
      const list = prev[key] ?? [];
      const next = editing ? list.map((e) => (e.id === editing ? draft : e)) : [...list, draft];
      return { ...prev, [key]: next };
    });
    setEditingEvent(null);
    setQuickCreateTime(null);
  };

  /* ------------------ ICS 导入 / 导出 ------------------ */

  const onImportIcs = async (file: File) => {
    try {
      const text = await file.text();
      const list = parseIcs(text, new Date(winLo - 1, 0, 1), new Date(winHi + 1, 11, 31));
      if (list.length === 0) {
        setImportNotice({ added: 0, skipped: -1 });
        return;
      }
      // 去重合并在纯函数内完成（同日+同时+同标题跳过——重复导入同一文件
      // 不再翻倍；草稿/统计在 updater 外算，StrictMode double-invoke 安全）。
      const drafts = list.map((ie) => ({ date: ie.date, event: icsToEventDraft(ie) }));
      const merged = mergeImportedEvents(events, drafts);
      /* 应用搬回 updater 内对最新 prev 重放——file.text()/parseIcs 的
         await 期间本窗新增/拖拽编辑不再被渲染闭包里的旧 events 整包覆盖；
         prev 未变时复用外部结果（含统计同源），mergeImportedEvents 已改
         复制语义，双调用幂等。 */
      setEvents((prev) => (prev === events ? merged.events : mergeImportedEvents(prev, drafts).events));
      setImportNotice({ added: merged.added, skipped: merged.skipped });
    } catch {
      setImportNotice({ added: 0, skipped: -1 });
    }
  };

  const onExportIcs = () => {
    if (Object.keys(events).length === 0) return; // 空日历不出空壳文件
    const ics = buildCalendarIcs(events);
    const blob = new Blob([ics], { type: "text/calendar;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `focusdesk-calendar-${dateKey(today.getFullYear(), today.getMonth(), today.getDate())}.ics`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  /* ------------------ 搜索 ------------------ */

  const searchResults = useMemo(() => {
    const q = searchQ.trim().toLowerCase();
    if (!q) return [] as { key: string; ev: CalendarEvent }[];
    const out: { key: string; ev: CalendarEvent }[] = [];
    for (const [key, list] of Object.entries(events)) {
      for (const ev of list) {
        if (
          ev.text.toLowerCase().includes(q) ||
          ev.location.toLowerCase().includes(q) ||
          ev.note.toLowerCase().includes(q)
        ) {
          out.push({ key, ev });
        }
      }
    }
    return out.slice(0, 12);
  }, [events, searchQ]);

  /* ------------------ 二级目录：选中日期的详情（时间线） ------------------ */

  const selectedDetail = useMemo(() => {
    if (!selected) return null;
    const date = parseKey(selected);
    if (!date) return null;
    const lunar = getLunarInfo(date);
    const holiday = getHoliday(date);
    return {
      date,
      lunar: lunar.lunar,
      term: lunar.term,
      holiday
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, holVersion]);

  const selectedEvents = useMemo(
    () => (selected && selectedDetail ? eventsOnDay(selectedDetail.date) : []),
    [selected, selectedDetail, eventsOnDay]
  );
  const selectedIcs = useMemo(() => (selected ? (icsByDay[selected] ?? []) : []), [selected, icsByDay]);
  /* 事件 id → 存储键（锚点日）。selectedEvents 会把其他锚点日的重复事件
     合并进来展示（eventsOnDay），而删除/编辑此前一律拿当前查看日 selected
     当键去 events[selected] 找——非锚点日删不掉、编辑被当成新增（原事件 +
     新副本并存）。事件 id 为 uuid 全局唯一，此映射对重复/非重复事件统一
     成立（非重复事件的键就是它所在的那天）。 */
  const anchorKeyById = useMemo(() => {
    const m = new Map<string, string>();
    for (const [key, list] of Object.entries(events)) {
      for (const ev of list) m.set(ev.id, key);
    }
    return m;
  }, [events]);

  /** 时间线：自有定时事件 + 同步课程 + 订阅定时事件。 */
  const timeline = useMemo(() => {
    if (!selected || !selectedDetail) return null;
    const items: TimelineItem[] = [];
    for (const ev of selectedEvents) {
      if (!ev.time) continue; // 全天进置顶区
      const s = hhmmToMin(ev.time);
      if (s == null) continue;
      const e = ev.endTime ? hhmmToMin(ev.endTime) : null;
      items.push({
        id: ev.id,
        kind: "event",
        title: ev.text,
        startMin: s,
        endMin: e != null && e > s ? e : s + 60,
        color: ev.color,
        location: ev.location,
        ev
      });
    }
    for (const c of syncedEvents[selected] ?? []) {
      const s = hhmmToMin(c.start);
      if (s == null) continue;
      const e = hhmmToMin(c.end);
      items.push({
        id: c.id,
        kind: "course",
        title: c.name,
        startMin: s,
        endMin: e != null && e > s ? e : s + 45,
        color: c.color,
        location: c.location
      });
    }
    for (const sub of selectedIcs) {
      if (!sub.time) continue;
      const s = hhmmToMin(sub.time);
      if (s == null) continue;
      const e = sub.endTime ? hhmmToMin(sub.endTime) : null;
      items.push({
        id: sub.uid,
        kind: "sub",
        title: sub.title,
        startMin: s,
        endMin: e != null && e > s ? e : s + 60,
        color: "",
        location: sub.location
      });
    }
    return layoutTimeline(items);
  }, [selected, selectedDetail, selectedEvents, syncedEvents, selectedIcs]);

  /* 选中今天时时间线自动滚到当前时刻附近（切换日期时定位一次）。 */
  const selectedIsToday =
    selected != null && selected === dateKey(today.getFullYear(), today.getMonth(), today.getDate());
  useEffect(() => {
    const el = tlScrollRef.current;
    if (!el || !timeline || !selectedIsToday) return;
    const nowMin = nowTick.getHours() * 60 + nowTick.getMinutes();
    const hourPx = compact ? 42 : TL_HOUR_PX; // 与 renderTimeline 同值
    const top = ((nowMin - timeline.hourStart * 60) / 60) * hourPx;
    el.scrollTop = Math.max(0, top - 120);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 仅切换选中日时定位
  }, [selected]);

  /** 置顶区条目：全天事件 / DDL / 习惯 / 全天订阅（无时刻的安排）。 */
  const alldayRows = useMemo(() => {
    if (!selected) return [] as { type: string; id: string; label: string; done?: boolean; ev?: CalendarEvent }[];
    const rows: { type: string; id: string; label: string; done?: boolean; ev?: CalendarEvent }[] = [];
    for (const ev of selectedEvents) {
      if (!ev.time) rows.push({ type: "event", id: ev.id, label: ev.text, ev });
    }
    for (const d of deadlinesByDay[selected] ?? []) {
      rows.push({ type: "ddl", id: d.id, label: d.title, done: d.completed });
    }
    for (const sub of selectedIcs) {
      if (!sub.time) rows.push({ type: "sub", id: sub.uid, label: sub.title });
    }
    const doneHabits = habitsDoneByDay[selected] ?? [];
    if (doneHabits.length > 0) {
      rows.push({ type: "habit", id: "habits", label: `${tr("打卡")} ${doneHabits.length}` });
    }
    return rows;
  }, [selected, selectedEvents, deadlinesByDay, selectedIcs, habitsDoneByDay, tr]);

  /** 详情周条（iOS 日视图语言）：选中日所在周的 7 天，点选快速换天，
      不必回月历网格。周起点跟随 firstDayOfWeek 配置。 */
  const selectedWeekDays = useMemo(() => {
    const base = selectedDetail ? new Date(selectedDetail.date) : new Date();
    const dow = firstDayOfWeek === "monday" ? (base.getDay() + 6) % 7 : base.getDay();
    base.setDate(base.getDate() - dow);
    return Array.from({ length: 7 }, (_, i) => {
      const d = new Date(base);
      d.setDate(base.getDate() + i);
      return d;
    });
  }, [selectedDetail, firstDayOfWeek]);

  /* ------------------ 月格（月 / 双月共用） ------------------ */

  /** 方向键在月格间移动焦点/选中（不跨月；DOM 定位到目标格）。 */
  const onCellKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>, y: number, m: number, d: number) => {
    const delta =
      e.key === "ArrowLeft"
        ? -1
        : e.key === "ArrowRight"
          ? 1
          : e.key === "ArrowUp"
            ? -7
            : e.key === "ArrowDown"
              ? 7
              : 0;
    if (!delta) return;
    e.preventDefault();
    const nd = new Date(y, m, d + delta);
    if (nd.getMonth() !== m) return;
    const key = dateKey(nd.getFullYear(), nd.getMonth(), nd.getDate());
    setSelected(key);
    rootRef.current?.querySelector<HTMLElement>(`[data-cdate="${key}"]`)?.focus();
  };

  const renderMonthGrid = (gy0: number, gm0: number, opts: { mini?: boolean }) => {
    const norm = new Date(gy0, gm0, 1);
    const gy = norm.getFullYear();
    const gm = norm.getMonth();
    const gFirst = new Date(gy, gm, 1).getDay();
    const gDays = new Date(gy, gm + 1, 0).getDate();
    const gOffset = firstDayOfWeek === "monday" ? (gFirst + 6) % 7 : gFirst;
    const gCells: (number | null)[] = [
      ...Array.from({ length: gOffset }, () => null),
      ...Array.from({ length: gDays }, (_, i) => i + 1)
    ];
    const gRows: (number | null)[][] = [];
    for (let i = 0; i < gCells.length; i += 7) gRows.push(gCells.slice(i, i + 7));
    /** 该行首个有效日期的 ISO 周数；整行空白返回 0。
     *  周首日=周日时，行首周日属于上一 ISO 周（ISO 周以周一开头），与行内
     *  周一~周六分属两周——周号取行内多数日所在的周：优先行内周一。 */
    const weekNumberOf = (row: (number | null)[]) => {
      const first = row.find((x) => x !== null);
      if (first == null) return 0;
      if (firstDayOfWeek !== "monday") {
        const monday = row.find((x) => x !== null && new Date(gy, gm, x).getDay() === 1);
        if (monday != null) return getISOWeekNumber(new Date(gy, gm, monday));
      }
      return getISOWeekNumber(new Date(gy, gm, first));
    };
    const mini = opts.mini === true;
    return (
      <div
        key={`${gy}-${gm}`}
        className={`widget-cal-grid${showWeekNumber && !mini ? " with-week-num" : ""}${mini ? " mini" : ""}`}
        style={{ ["--cal-dir" as string]: navDir.current }}
      >
        {gRows.map((row, ri) => (
          <Fragment key={ri}>
            {showWeekNumber && !mini && <span className="widget-cal-week-num">{weekNumberOf(row)}</span>}
            {row.map((d, i) => {
              if (d === null) return <span key={i} className="widget-cal-cell empty" />;
              const key = dateKey(gy, gm, d);
              const date = new Date(gy, gm, d);
              const dayOwn = eventsByDay(date);
              const lunar = getLunarInfo(date);
              const holiday = getHoliday(date);
              const courses = syncedEvents[key] ?? [];
              const hasEvents = dayOwn.length > 0 || courses.length > 0 || (icsByDay[key]?.length ?? 0) > 0;
              const dayDeadlines = deadlinesByDay[key] ?? [];
              const isMemorial = showMemorialMarks && holiday != null && holiday.mark !== "休";
              /* 月格事件摘要：非紧凑模式下显示前 2 条（自有事件优先）。 */
              const chips = showCellEvents && !mini ? dayOwn.filter((ev) => ev.time).slice(0, 2) : [];
              /* 溢出计数含课程/订阅（此前漏算课程，且「0 自有 + N 订阅」时只显
                 示孤零零的 +N，现在 chips 为空也渲染 more 标记）。 */
              const chipMore =
                showCellEvents && !mini
                  ? dayOwn.length + courses.length + (icsByDay[key]?.length ?? 0) - chips.length
                  : 0;
              /* 悬停摘要：节假日 + 当日前三条事件。 */
              const hoverSummary = [
                holiday?.name,
                ...dayOwn.slice(0, 3).map((ev) => `${ev.time ? `${ev.time} ` : ""}${ev.text}`)
              ]
                .filter(Boolean)
                .join("\n");
              return (
                <button
                  key={i}
                  className={[
                    "widget-cal-cell",
                    isToday(gy, gm, d) ? "today" : "",
                    selected === key ? "selected" : "",
                    holiday ? "has-holiday" : ""
                  ].join(" ")}
                  onClick={() => setSelected(key)}
                  onKeyDown={(e) => onCellKeyDown(e, gy, gm, d)}
                  data-interactive
                  data-cdate={key}
                  aria-label={`${gy}${tr("年")}${gm + 1}${tr("月")}${d}${tr("日")} ${tr(WEEKDAY_CN[date.getDay()])}`}
                  title={hoverSummary || undefined}
                >
                  <span className="widget-cal-day">{d}</span>
                  {(showLunar || isMemorial) && !mini && (
                    <span className="widget-cal-lunar">
                      {isMemorial ? holiday!.name : showSolarTerms && lunar.term ? lunar.term : lunar.lunar}
                    </span>
                  )}
                  {showHolidays && holiday && showRestMarks && holiday.mark === "休" && (
                    <span className="widget-cal-rest-dot" />
                  )}
                  {showEventDots && hasEvents && <span className="widget-cal-dot" />}
                  {dayDeadlines.length > 0 && <span className="widget-cal-deadline-dot" />}
                  {(habitsDoneByDay[key]?.length ?? 0) > 0 && <span className="widget-cal-habit-dot" />}
                  {(chips.length > 0 || chipMore > 0) && (
                    <span className="widget-cal-cell-events">
                      {chips.map((ev) => (
                        <span
                          key={ev.id}
                          className="widget-cal-chip"
                          style={ev.color ? { borderColor: ev.color, color: ev.color } : undefined}
                        >
                          {ev.time ? `${ev.time} ` : ""}
                          {ev.text}
                        </span>
                      ))}
                      {chipMore > 0 && <span className="widget-cal-chip more">+{chipMore}</span>}
                    </span>
                  )}
                </button>
              );
            })}
          </Fragment>
        ))}
      </div>
    );
  };

  /* ------------------ 周视图（weekDays 已上移到 syncedEvents 之前） ------------------ */

  const renderWeekList = () => (
    <div className="widget-week-list">
      {weekDays.map((date) => {
        const key = dateKey(date.getFullYear(), date.getMonth(), date.getDate());
        const dayOwn = eventsByDay(date);
        const courses = syncedEvents[key] ?? [];
        const subs = icsByDay[key] ?? [];
        const dayDeadlines = deadlinesByDay[key] ?? [];
        const dayHabits = habitsDoneByDay[key] ?? [];
        const holiday = getHoliday(date);
        const lunar = getLunarInfo(date);
        return (
          <div
            key={key}
            className={[
              "widget-week-row",
              isToday(date.getFullYear(), date.getMonth(), date.getDate()) ? "today" : "",
              selected === key ? "selected" : ""
            ].join(" ")}
            onClick={() => setSelected(key)}
            data-interactive
            role="button"
            tabIndex={0}
            /* 对齐全库 Enter‖" " 无障碍激活惯例补空格激活
               （周视图行 div role=button 的键盘激活，非文本提交，无 IME 面）。 */
            onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && setSelected(key)}
          >
            <div className="widget-week-day">
              <span className="widget-week-num">{date.getDate()}</span>
              <span className="widget-week-dow">
                {tr(SHORT_WEEKDAYS[weekLabels[(date.getDay() + (firstDayOfWeek === "monday" ? 6 : 0)) % 7]] ?? "")}
              </span>
              {showLunar && (
                <span className="widget-week-lunar">{showSolarTerms && lunar.term ? lunar.term : lunar.lunar}</span>
              )}
              {showHolidays && holiday && showRestMarks && holiday.mark === "休" && (
                <span className="widget-cal-rest-dot" />
              )}
            </div>
            <div className="widget-week-body">
              {dayOwn.length === 0 &&
                courses.length === 0 &&
                subs.length === 0 &&
                dayDeadlines.length === 0 &&
                dayHabits.length === 0 && <span className="widget-week-empty">{tr("无安排")}</span>}
              {dayOwn.map((ev) => (
                <div key={ev.id} className="widget-week-ev" style={ev.color ? { borderColor: ev.color } : undefined}>
                  {ev.time && (
                    <span className="widget-week-ev-time">
                      {ev.time}
                      {ev.endTime ? `–${ev.endTime}` : ""}
                    </span>
                  )}
                  <span className="widget-week-ev-text">{ev.text}</span>
                  {ev.repeat !== "none" && <Repeat size={10} className="widget-week-ev-repeat" />}
                </div>
              ))}
              {courses.slice(0, 3).map((ev) => (
                <div key={ev.id} className="widget-week-ev course" style={{ borderColor: ev.color }}>
                  <span className="widget-week-ev-time">{ev.start}</span>
                  <span className="widget-week-ev-text">
                    {ev.name}
                    {ev.location ? ` · ${ev.location}` : ""}
                  </span>
                </div>
              ))}
              {subs.slice(0, 3).map((ev) => (
                <div key={ev.uid} className="widget-week-ev sub">
                  {ev.time && <span className="widget-week-ev-time">{ev.time}</span>}
                  <span className="widget-week-ev-text">{ev.title}</span>
                </div>
              ))}
              {dayDeadlines.slice(0, 3).map((d) => (
                <div key={d.id} className={`widget-week-ev ddl${d.completed ? " done" : ""}`}>
                  <span className="widget-week-ev-text">{d.title}</span>
                </div>
              ))}
              {dayDeadlines.length > 3 && <div className="widget-week-ev more">+{dayDeadlines.length - 3}</div>}
              {dayHabits.length > 0 && (
                <div className="widget-week-ev habit">
                  <Check size={10} className="widget-week-ev-repeat" />
                  <span className="widget-week-ev-text">
                    {tr("打卡")} {dayHabits.length}
                  </span>
                </div>
              )}
              {courses.length > 3 && <div className="widget-week-ev more">+{courses.length - 3}</div>}
              {subs.length > 3 && <div className="widget-week-ev more">+{subs.length - 3}</div>}
            </div>
          </div>
        );
      })}
    </div>
  );

  /* ------------------ 时间线渲染（选中日详情核心） ------------------ */

  const renderTimeline = () => {
    if (!timeline) return null;
    const hours = timeline.hourEnd - timeline.hourStart;
    // compact 用更密的小时行高——JS 定位与 CSS 渲染必须同值（此前 CSS 写了
    // 42px 但被 inline 的 52px 恒值覆盖，属于死代码 + 潜在错位坑）。
    const hourPx = compact ? 42 : TL_HOUR_PX;
    const nowMin = nowTick.getHours() * 60 + nowTick.getMinutes();
    const nowTop = selectedIsToday ? ((nowMin - timeline.hourStart * 60) / 60) * hourPx : -1;
    const nowVisible = nowTop >= 0 && nowTop <= hours * hourPx;
    /** 空白处点击 → 以点击时刻（15 分钟吸附）预填添加行。 */
    const onCanvasClick = (e: React.MouseEvent<HTMLDivElement>) => {
      if (!selected) return;
      const rect = e.currentTarget.getBoundingClientRect();
      // 像素 → 小时 → 分钟（吸附 15 分钟）：注意先乘 60 再除 15，量纲才对。
      const hoursFrac = (e.clientY - rect.top) / hourPx;
      const min = timeline.hourStart * 60 + Math.round((hoursFrac * 60) / 15) * 15;
      const clamped = Math.max(0, Math.min(23 * 60 + 45, min));
      setEditingEvent(null);
      setQuickCreateTime(minToHHMM(clamped));
    };
    return (
      <div className="widget-cal-tl-scroll" ref={tlScrollRef}>
        <div
          className={`widget-cal-tl-body${compact ? " compact" : ""}`}
          style={{ ["--tl-hours" as string]: hours, ["--tl-hour-px" as string]: `${hourPx}px` }}
        >
          <div className="widget-cal-tl-hours">
            {Array.from({ length: hours }, (_, i) => (
              <span key={i}>{minToHHMM((timeline.hourStart + i) * 60)}</span>
            ))}
          </div>
          <div className="widget-cal-tl-canvas" onClick={onCanvasClick}>
            {nowVisible && (
              <div className="widget-cal-tl-now" style={{ top: nowTop }}>
                <span className="widget-cal-tl-now-time">{minToHHMM(nowMin)}</span>
              </div>
            )}
            {timeline.items.map((it) => {
              // 拖拽中的块跟随指针（吸附后时刻），其余按原位渲染。
              const dragging = dragState?.id === it.id && dragState.moved;
              const renderStart = dragging ? dragState!.newStart : it.startMin;
              const top = ((renderStart - timeline.hourStart * 60) / 60) * hourPx;
              const rawH = ((it.endMin - it.startMin) / 60) * hourPx - 2;
              const h = Math.max(20, rawH);
              const timeLabel = `${minToHHMM(renderStart)}${it.endMin - it.startMin >= 15 ? `–${minToHHMM(renderStart + (it.endMin - it.startMin))}` : ""}`;
              /* 可拖：自有 + 非重复 + 有时刻（重复事件的改动走编辑器的范围
                 选择，避免拖一下就把系列分裂/整体挪位的意外）。 */
              const draggable = it.kind === "event" && !!it.ev && it.ev.repeat === "none" && !!it.ev.time;
              return (
                <div
                  key={`${it.kind}-${it.id}`}
                  className={`widget-cal-tl-ev ${it.kind}${it.ev && editingEvent?.id === it.ev.id ? " editing" : ""}${draggable ? " grabbable" : ""}${dragging ? " dragging" : ""}`}
                  style={{
                    top,
                    height: h,
                    left: `${(it.col / it.cols) * 100}%`,
                    width: `calc(${(100 / it.cols).toFixed(3)}% - 4px)`,
                    ...(it.color
                      ? { borderColor: it.color, color: it.color }
                      : it.kind === "course"
                        ? { borderColor: "var(--accent, #5b8def)" }
                        : {})
                  }}
                  title={`${timeLabel} ${it.title}${it.location ? ` · ${it.location}` : ""}${it.ev?.note ? `\n${it.ev.note}` : ""}`}
                  onPointerDown={(e) => {
                    if (!draggable || e.button !== 0) return;
                    const key = anchorKeyById.get(it.ev!.id) ?? selected;
                    if (!key) return;
                    const s = hhmmToMin(it.ev!.time);
                    if (s == null) return;
                    const e2 = it.ev!.endTime ? hhmmToMin(it.ev!.endTime) : null;
                    const dur = e2 != null && e2 > s ? e2 - s : 60;
                    setDrag({
                      id: it.ev!.id,
                      key,
                      startY: e.clientY,
                      startMin: s,
                      durMin: dur,
                      newStart: s,
                      moved: false
                    });
                    // pointer capture 让后续 move/up 派发到本元素；个别环境
                    // （jsdom / 合成事件的无效 pointerId）会抛——失败不致命，
                    // 退化为常规冒泡。
                    try {
                      e.currentTarget.setPointerCapture?.(e.pointerId);
                    } catch {
                      /* noop */
                    }
                  }}
                  onPointerMove={(e) => {
                    const drag = dragStateRef.current;
                    if (!drag || drag.id !== it.id) return;
                    const dy = e.clientY - drag.startY;
                    if (!drag.moved && Math.abs(dy) <= 4) return; // 阈值内 = 点击
                    // 相对吸附：位移取 15 分钟档，保持事件原有分钟相位。
                    const delta = Math.round(((dy / hourPx) * 60) / 15) * 15;
                    const lo = timeline.hourStart * 60;
                    const hi = timeline.hourEnd * 60 - drag.durMin;
                    const ns = Math.max(lo, Math.min(hi, drag.startMin + delta));
                    setDrag({ ...drag, newStart: ns, moved: true });
                  }}
                  onPointerUp={() => {
                    const drag = dragStateRef.current;
                    if (!drag || drag.id !== it.id) return;
                    if (drag.moved) {
                      const ev0 = (events[drag.key] ?? []).find((x) => x.id === drag.id);
                      if (ev0 && drag.newStart !== drag.startMin) {
                        commitEventMove(
                          drag.key,
                          drag.id,
                          minToHHMM(drag.newStart),
                          ev0.endTime ? minToHHMM(drag.newStart + drag.durMin) : ""
                        );
                      }
                      // 拖拽结束会紧跟一次 click——拦掉，不进编辑。
                      dragJustEndedRef.current = true;
                      requestAnimationFrame(() => {
                        dragJustEndedRef.current = false;
                      });
                    }
                    setDrag(null);
                  }}
                  /* 触屏滚动/系统手势接管指针后没有 pointerup——不清理
                     会把块卡在拖拽视觉态（吸附偏移 + .dragging 样式）直到下一
                     次 pointerdown。与库内其余 21 处 setPointerCapture 的对称
                     pointercancel 纪律对齐。 */
                  onPointerCancel={() => {
                    const drag = dragStateRef.current;
                    if (!drag || drag.id !== it.id) return;
                    dragJustEndedRef.current = true;
                    requestAnimationFrame(() => {
                      dragJustEndedRef.current = false;
                    });
                    setDrag(null);
                  }}
                  onClick={(e) => {
                    // 事件块上的点击不落到画布空白快速创建。
                    e.stopPropagation();
                    if (dragJustEndedRef.current) return;
                    if (!it.ev) return;
                    const key = anchorKeyById.get(it.ev.id) ?? selected;
                    if (!key) return;
                    setEditingEvent(
                      editingEvent?.id === it.ev.id ? null : { key, id: it.ev.id, dayKey: selected ?? key }
                    );
                  }}
                  onKeyDown={(e) => {
                    // ↑↓ = ±15 分钟（Shift ±60）：键盘微调非重复事件时刻。
                    if ((e.key === "ArrowUp" || e.key === "ArrowDown") && draggable) {
                      e.preventDefault();
                      e.stopPropagation();
                      const key = anchorKeyById.get(it.ev!.id) ?? selected;
                      if (!key) return;
                      const s = hhmmToMin(it.ev!.time);
                      if (s == null) return;
                      const e2 = it.ev!.endTime ? hhmmToMin(it.ev!.endTime) : null;
                      const dur = e2 != null && e2 > s ? e2 - s : 60;
                      const step = (e.key === "ArrowUp" ? -1 : 1) * (e.shiftKey ? 60 : 15);
                      const lo = timeline.hourStart * 60;
                      const hi = timeline.hourEnd * 60 - dur;
                      const ns = Math.max(0, Math.min(hi, s + step));
                      if (ns === s || ns < lo) return;
                      commitEventMove(key, it.ev!.id, minToHHMM(ns), it.ev!.endTime ? minToHHMM(ns + dur) : "");
                      return;
                    }
                    if (e.key !== "Enter" && e.key !== " ") return;
                    e.preventDefault();
                    e.stopPropagation();
                    if (!it.ev) return;
                    const key = anchorKeyById.get(it.ev.id) ?? selected;
                    if (!key) return;
                    setEditingEvent(
                      editingEvent?.id === it.ev.id ? null : { key, id: it.ev.id, dayKey: selected ?? key }
                    );
                  }}
                  role={it.ev ? "button" : undefined}
                  tabIndex={it.ev ? 0 : undefined}
                  aria-label={`${timeLabel} ${it.title}${it.location ? ` · ${it.location}` : ""}`}
                  data-interactive={it.ev ? true : undefined}
                >
                  <span className="widget-cal-tl-ev-bar" style={{ background: it.color || "var(--accent, #5b8def)" }} />
                  <span className="widget-cal-tl-ev-body">
                    {h >= 34 && <span className="widget-cal-tl-ev-time">{timeLabel}</span>}
                    <span className="widget-cal-tl-ev-title">{it.title}</span>
                    {h >= 50 && it.location && <span className="widget-cal-tl-ev-loc">{it.location}</span>}
                  </span>
                  {it.ev && it.ev.repeat !== "none" && <Repeat size={9} className="widget-cal-tl-ev-repeat" />}
                  {it.ev && it.ev.remind > 0 && h >= 34 && <Bell size={9} className="widget-cal-tl-ev-repeat" />}
                  {it.ev && (
                    <button
                      className={`widget-cal-tl-ev-del${confirmDelete === it.ev.id ? " confirm" : ""}`}
                      aria-label={confirmDelete === it.ev.id ? tr("再次点击确认删除") : tr("删除事件")}
                      title={confirmDelete === it.ev.id ? tr("再次点击确认删除") : tr("删除事件")}
                      onClick={(e) => {
                        e.stopPropagation();
                        const key = anchorKeyById.get(it.ev!.id) ?? selected;
                        if (key) requestRemoveEvent(key, it.ev!.id);
                      }}
                      data-interactive
                    >
                      {confirmDelete === it.ev.id ? <Check size={10} /> : <X size={10} />}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className={`widget-calendar${compact ? " compact" : ""}`} ref={rootRef}>
      <div className="widget-cal-header">
        <button
          onClick={() => shift(-1)}
          aria-label={viewMode === "week" ? tr("上一周") : tr("上个月")}
          data-interactive
        >
          <ChevronLeft size={15} />
        </button>
        <button className="widget-cal-title" onClick={openPicker} aria-label={tr("选择年月")} data-interactive>
          {/* 原 tr 后逐片段拼接，英文模式语序不成立
              （"2026year 10month" / "10month8 – 10month14"）——改整句模板键 +
              占位符（照 "{m} 月 {d} 日" 先例），英文译文在 i18n.ts。 */}
          {viewMode === "week"
            ? tr("{m1} 月 {d1} 日 – {m2} 月 {d2} 日", {
                m1: weekDays[0].getMonth() + 1,
                d1: weekDays[0].getDate(),
                m2: weekDays[6].getMonth() + 1,
                d2: weekDays[6].getDate()
              })
            : tr("{y} 年 {m} 月", { y: year, m: month + 1 })}
        </button>
        <button onClick={goToday} aria-label={tr("跳转到今天")} data-interactive>
          <Calendar size={15} />
        </button>
        <button
          onClick={() => {
            setSearchOpen((v) => !v);
            if (searchOpen) setSearchQ("");
          }}
          className={searchOpen ? "on" : ""}
          aria-label={tr("搜索事件")}
          title={tr("搜索事件")}
          data-interactive
        >
          <Search size={15} />
        </button>
        <button
          onClick={() => shift(1)}
          aria-label={viewMode === "week" ? tr("下一周") : tr("下个月")}
          data-interactive
        >
          <ChevronRight size={15} />
        </button>
      </div>

      {/* 视图切换：月 / 周 / 双月 + ICS 状态 + 导入/导出。 */}
      <div className="widget-cal-mode">
        {(["month", "week", "double"] as const).map((m) => (
          <button
            key={m}
            className={viewMode === m ? "active" : ""}
            onClick={() => {
              navDir.current = 0;
              if (m === "week") setWeekCursor(new Date(year, month, 1));
              updateConfig({ viewMode: m });
            }}
            data-interactive
          >
            {tr(m === "month" ? "月" : m === "week" ? "周" : "双月")}
          </button>
        ))}
        {/* ICS 订阅状态：错误/过期提示 + 手动刷新；本地导入与导出。 */}
        {icsEnabled && (
          <button
            className={`widget-cal-ics${icsState === "error" || icsState === "stale" ? " error" : ""}${icsState === "loading" ? " loading" : ""}`}
            title={
              icsState === "error"
                ? tr("订阅拉取失败，点击重试")
                : icsState === "stale"
                  ? tr("订阅拉取失败，显示上次数据，点击重试")
                  : tr("刷新日历订阅")
            }
            onClick={() => setIcsStamp((v) => v + 1)}
            data-interactive
          >
            <RefreshCw size={11} />
          </button>
        )}
        <button
          className="widget-cal-io"
          onClick={() => fileRef.current?.click()}
          aria-label={tr("导入 .ics 文件")}
          title={tr("导入 .ics 文件")}
          data-interactive
        >
          <Upload size={11} />
        </button>
        <button
          className="widget-cal-io"
          onClick={onExportIcs}
          aria-label={tr("导出为 .ics")}
          title={tr("导出为 .ics")}
          data-interactive
        >
          <Download size={11} />
        </button>
        <input
          ref={fileRef}
          type="file"
          accept=".ics,text/calendar"
          className="widget-cal-file"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void onImportIcs(f);
            e.target.value = "";
          }}
        />
        {importNotice != null && (
          <span className={`widget-cal-import-note${importNotice.skipped < 0 ? " error" : ""}`}>
            {importNotice.skipped < 0
              ? tr("导入失败")
              : importNotice.skipped > 0
                ? tr("已导入 {n} 条，跳过 {m} 条重复")
                    .replace("{n}", String(importNotice.added))
                    .replace("{m}", String(importNotice.skipped))
                : tr("已导入 {n} 条事件").replace("{n}", String(importNotice.added))}
          </span>
        )}
      </div>

      {/* 搜索浮层：跨锚点匹配事件/地点/备注，点击跳转对应日期。 */}
      {searchOpen && (
        <div className="widget-cal-search" ref={searchRef}>
          <Search size={12} />
          <input
            autoFocus
            value={searchQ}
            onChange={(e) => setSearchQ(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && setSearchOpen(false)}
            placeholder={tr("搜索事件 / 地点 / 备注…")}
            data-interactive
          />
          {searchQ.trim() && (
            <div className="widget-cal-search-results">
              {searchResults.length === 0 && <div className="widget-cal-search-empty">{tr("无匹配事件")}</div>}
              {searchResults.map(({ key, ev }) => {
                const d = parseKey(key);
                return (
                  <button
                    key={ev.id}
                    onClick={() => {
                      if (d) {
                        jumpTo(d.getFullYear(), d.getMonth());
                        setSelected(key);
                      }
                      setSearchOpen(false);
                      setSearchQ("");
                    }}
                    data-interactive
                  >
                    <span className="t">{ev.text}</span>
                    <span className="m">
                      {key}
                      {ev.repeat !== "none" ? ` · ${repeatLabel(ev, tr)}` : ""}
                      {ev.time ? ` · ${ev.time}` : ""}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* 二级目录：年份 / 月份选择器。年份可直接输入（此前只能 ±1 步进）。 #57 统一退场。 */}
      {pickerVisible && (
        <div className={`widget-cal-picker${showPicker ? "" : " is-closing"}`} ref={pickerRef}>
          <div className="widget-cal-picker-year">
            <button onClick={() => setPickerYear((y) => y - 1)} aria-label={tr("上一年")} data-interactive>
              <ChevronLeft size={13} />
            </button>
            <input
              className="widget-cal-picker-year-input"
              type="number"
              min={1900}
              max={2100}
              value={pickerYear}
              onChange={(e) => {
                const v = Number(e.target.value);
                if (Number.isFinite(v) && v >= 1000 && v <= 9999) setPickerYear(Math.round(v));
              }}
              aria-label={tr("年份")}
              data-interactive
            />
            <button onClick={() => setPickerYear((y) => y + 1)} aria-label={tr("下一年")} data-interactive>
              <ChevronRight size={13} />
            </button>
          </div>
          <div className="widget-cal-picker-months">
            {MONTHS_CN.map((name, i) => (
              <button
                key={name}
                className={i === month && pickerYear === year ? "active" : ""}
                onClick={() => jumpTo(pickerYear, i)}
                data-interactive
              >
                {tr(name)}
              </button>
            ))}
          </div>
        </div>
      )}

      {viewMode === "week" ? (
        renderWeekList()
      ) : (
        <>
          {viewMode !== "double" && (
            <div className={`widget-cal-week${showWeekNumber ? " with-week-num" : ""}`}>
              <span className="widget-cal-detail-term">{selectedDetail?.term}</span>
              {weekLabels.map((d, i) => {
                const isWeekend = firstDayOfWeek === "monday" ? i >= 5 : i === 0 || i === 6;
                return (
                  <span key={d} className={isWeekend ? "weekend" : ""}>
                    {tr(SHORT_WEEKDAYS[d] ?? d)}
                  </span>
                );
              })}
            </div>
          )}
          {viewMode === "double" ? (
            <div className="widget-cal-double">
              <div className="widget-cal-double-month">
                <div className="widget-cal-double-label">{tr("本月")}</div>
                <div className="widget-cal-week mini">
                  {weekLabels.map((d) => (
                    <span key={d}>{tr(SHORT_WEEKDAYS[d] ?? d)}</span>
                  ))}
                </div>
                {renderMonthGrid(year, month, { mini: true })}
              </div>
              <div className="widget-cal-double-month">
                <div className="widget-cal-double-label">
                  {new Date(year, month + 1, 1).getMonth() + 1}
                  {tr("月")}
                </div>
                <div className="widget-cal-week mini">
                  {weekLabels.map((d) => (
                    <span key={d}>{tr(SHORT_WEEKDAYS[d] ?? d)}</span>
                  ))}
                </div>
                {renderMonthGrid(year, month + 1, { mini: true })}
              </div>
            </div>
          ) : (
            renderMonthGrid(year, month, {})
          )}
        </>
      )}

      {/* 选中日详情：时间线视图（刻度轴 + 定时事件块 + 当前时刻线）；
          全天/无时刻安排置顶。 */}
      {selected && selectedDetail && (
        <div className="widget-cal-detail" key={selected}>
          <div className="widget-cal-detail-head">
            <div className="widget-cal-detail-title">
              <strong>{selectedDetail.date.getDate()}</strong>
              <span>
                {selectedDetail.date.getFullYear()}
                {tr("年")}
                {selectedDetail.date.getMonth() + 1}
                {tr("月")} {tr(WEEKDAY_CN[selectedDetail.date.getDay()])}
              </span>
            </div>
            <button onClick={() => setSelected(null)} aria-label={tr("关闭")} data-interactive>
              <X size={13} />
            </button>
          </div>
          {/* 详情周条（iOS 日视图）：选中日所在周 7 天快速换天。 */}
          <div className="widget-cal-weekstrip">
            {selectedWeekDays.map((d) => {
              const key = dateKey(d.getFullYear(), d.getMonth(), d.getDate());
              const hol = getHoliday(d);
              const lun = getLunarInfo(d);
              const isSel = selected === key;
              const isTd = isToday(d.getFullYear(), d.getMonth(), d.getDate());
              return (
                <button
                  key={key}
                  className={`widget-cal-weekstrip-day${isSel ? " selected" : ""}${isTd ? " today" : ""}`}
                  onClick={() => setSelected(key)}
                  onKeyDown={(e) => {
                    // 左右方向键在周内换天（对齐月格方向键导航）。
                    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
                    e.preventDefault();
                    const idx = selectedWeekDays.indexOf(d);
                    const next = selectedWeekDays[idx + (e.key === "ArrowLeft" ? -1 : 1)];
                    if (!next) return;
                    const nk = dateKey(next.getFullYear(), next.getMonth(), next.getDate());
                    setSelected(nk);
                    rootRef.current?.querySelector<HTMLElement>(`[data-wsdate="${nk}"]`)?.focus();
                  }}
                  data-interactive
                  data-wsdate={key}
                  aria-label={`${d.getMonth() + 1}${tr("月")}${d.getDate()}${tr("日")} ${tr(WEEKDAY_CN[d.getDay()])}`}
                >
                  <span className="widget-cal-weekstrip-num">{d.getDate()}</span>
                  {/* 角标语义判定（holidayMarkKind）+ 显示文本走 tr()
                      （词典与课表角标共用：Off / Workday）。 */}
                  {showHolidays && showRestMarks && holidayMarkKind(hol?.mark) === "rest" && (
                    <i className="mark rest">{tr("休")}</i>
                  )}
                  {showHolidays && showRestMarks && holidayMarkKind(hol?.mark) === "work" && (
                    <i className="mark work">{tr("班")}</i>
                  )}
                  {showLunar && (
                    <span className="widget-cal-weekstrip-lunar">
                      {showSolarTerms && lun.term ? lun.term : lun.lunar}
                    </span>
                  )}
                </button>
              );
            })}
          </div>

          <div className="widget-cal-detail-meta">
            {showLunar && <span className="widget-cal-detail-lunar">{selectedDetail.lunar}</span>}
            {showSolarTerms && selectedDetail.term && (
              <span className="widget-cal-detail-term">{selectedDetail.term}</span>
            )}
            {showHolidays && selectedDetail.holiday && (
              <span
                className={`widget-cal-detail-holiday ${selectedDetail.holiday.mark === "休" ? "kind-rest" : "kind-mem"}`}
              >
                {selectedDetail.holiday.name}
              </span>
            )}
          </div>

          {/* 置顶：全天事件（可编辑/删）/ DDL / 全天订阅 / 习惯打卡。 */}
          {alldayRows.length > 0 && (
            <div className="widget-cal-tl-allday">
              {alldayRows.map((row) => (
                <div
                  key={`${row.type}-${row.id}`}
                  className={`widget-cal-allday-chip ${row.type}${row.done ? " done" : ""}${row.ev && editingEvent?.id === row.ev.id ? " editing" : ""}`}
                  style={row.ev?.color ? { borderColor: row.ev.color, color: row.ev.color } : undefined}
                  onClick={() => {
                    if (!row.ev) return;
                    const key = anchorKeyById.get(row.ev.id) ?? selected;
                    if (!key) return;
                    setEditingEvent(
                      editingEvent?.id === row.ev.id ? null : { key, id: row.ev.id, dayKey: selected ?? key }
                    );
                  }}
                  onKeyDown={(e) => {
                    if (e.key !== "Enter" && e.key !== " ") return;
                    e.preventDefault();
                    if (!row.ev) return;
                    const key = anchorKeyById.get(row.ev.id) ?? selected;
                    if (!key) return;
                    setEditingEvent(
                      editingEvent?.id === row.ev.id ? null : { key, id: row.ev.id, dayKey: selected ?? key }
                    );
                  }}
                  role={row.ev ? "button" : undefined}
                  tabIndex={row.ev ? 0 : undefined}
                  aria-label={row.ev ? `${tr("全天")} · ${row.label}` : undefined}
                  data-interactive={row.ev ? true : undefined}
                >
                  {row.type === "habit" && <Check size={10} />}
                  <span>{row.label}</span>
                  {row.ev && row.ev.repeat !== "none" && <Repeat size={10} className="widget-cal-tl-ev-repeat" />}
                  {row.ev && (
                    <button
                      className={`widget-cal-tl-ev-del${confirmDelete === row.ev.id ? " confirm" : ""}`}
                      aria-label={confirmDelete === row.ev.id ? tr("再次点击确认删除") : tr("删除事件")}
                      title={confirmDelete === row.ev.id ? tr("再次点击确认删除") : tr("删除事件")}
                      onClick={(e) => {
                        e.stopPropagation();
                        const key = anchorKeyById.get(row.ev!.id) ?? selected;
                        if (key) requestRemoveEvent(key, row.ev!.id);
                      }}
                      data-interactive
                    >
                      {confirmDelete === row.ev.id ? <Check size={10} /> : <X size={10} />}
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* 时间线主体：常驻渲染（无事件也显示刻度骨架 + 当前时刻线——
              此前 items 为空整条轴收起只剩文字，看不到「这是一天的时间轴」）。 */}
          {timeline && (
            <div className="widget-cal-tl-wrap">
              {timeline.items.length === 0 && (
                <div className="widget-cal-tl-hint">
                  {alldayRows.length > 0 ? tr("当天无定时安排") : tr("暂无安排 · 在下方添加事件")}
                </div>
              )}
              {renderTimeline()}
            </div>
          )}

          {/* 重复事件删除三选一。 */}
          {deleteMenu && (
            <div className="widget-cal-delmenu">
              <span className="widget-cal-delmenu-label">{tr("删除重复事件")}</span>
              <button
                onClick={() => deleteEventOnce(deleteMenu.key, deleteMenu.id, deleteMenu.dayKey)}
                data-interactive
              >
                {tr("仅此日")}
              </button>
              <button
                onClick={() => deleteEventFrom(deleteMenu.key, deleteMenu.id, deleteMenu.dayKey)}
                data-interactive
              >
                {tr("此日及以后")}
              </button>
              <button onClick={() => removeEventWithUndo(deleteMenu.key, deleteMenu.id)} data-interactive>
                {tr("整个系列")}
              </button>
              <button className="widget-cal-delmenu-close" onClick={() => setDeleteMenu(null)} data-interactive>
                <X size={11} />
              </button>
            </div>
          )}

          {/* 删除撤销（5s 窗口）。 */}
          {undoState && (
            <div className="widget-cal-undo">
              <span>
                {tr("已删除")} · {undoState.prev.text}
              </span>
              <button onClick={undoDelete} data-interactive>
                {tr("撤销")}
              </button>
            </div>
          )}

          {/* /014 添加与编辑共用一行：起止时间 + 文本 + 高级选项。 */}
          <CalendarEventEditor
            key={editingEvent ? `edit-${editingEvent.id}` : `add-${quickCreateTime ?? ""}`}
            editing={editingEvent ? (events[editingEvent.key]?.find((e) => e.id === editingEvent.id) ?? null) : null}
            presetTime={editingEvent ? undefined : (quickCreateTime ?? undefined)}
            anchorDate={editingEvent?.key ?? selected ?? undefined}
            onSave={(draft, scope) => saveEvent(editingEvent?.key ?? selected, draft, scope)}
            onCancel={() => {
              setEditingEvent(null);
              setQuickCreateTime(null);
            }}
          />
        </div>
      )}
    </div>
  );
}
