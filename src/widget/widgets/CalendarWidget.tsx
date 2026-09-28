/**
 * 日历小组件：月/周视图、事件（含重复规则展开）、ICS 订阅、节假日标注
 * 与今日 DDL 聚合。重复展开在 useMemo 内预解析锚点（P-perf）；
 * 提醒经 30s 低频 tick 检查。
 */
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { Bell, Calendar, Check, ChevronLeft, ChevronRight, Pencil, RefreshCw, Repeat, Trash2, X } from "lucide-react";
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
  loadCalendarEvents as loadEvents,
  parseCalendarKey as parseKey,
  repeatMatches,
  type CalendarEvent,
  type EventMap
} from "./calendar-shared";
import { useTauriEvent } from "../../lib/use-tauri-event";
import { ensureHolidayData, subscribeRemoteHolidays } from "../../lib/holiday-update";
import { fetchIcsEvents, type IcsEvent } from "../../lib/ics";
import { sourceNotify } from "../../lib/notifications";
import { markReminded } from "../../lib/remind-dedupe";
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

/** 计算 ISO 8601 周数（周一为一周起点，第 1 周包含该年首个周四）。 */
function getISOWeekNumber(date: Date): number {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
}

/* ------------------------------------------------------------------ */
/* W-013 结构化事件（类型定义下沉到 calendar-shared，弹层组件不再反向依赖本文件） */
/* ------------------------------------------------------------------ */

/** 事件按 instanceId 持久化到 localStorage（兼容旧版纯文本数组）。 */
export function CalendarWidget({ instanceId }: { instanceId: string }) {
  const tr = useT();
  const safeTimeout = useSafeTimeout();
  const [today, setToday] = useState(() => new Date());
  const [view, setView] = useState(() => {
    const n = new Date();
    return new Date(n.getFullYear(), n.getMonth(), 1);
  });
  /* W-017 周视图游标（当前展示的那一周里的任一天）。 */
  const [weekCursor, setWeekCursor] = useState(() => new Date());
  const [events, setEvents] = useState<EventMap>(() => loadEvents(instanceId));
  const { config, update: updateConfig } = useWidgetConfig(instanceId);
  const [selected, setSelected] = useState<string | null>(null);
  /* W-014 编辑中的事件（key + id）；null = 添加模式。 */
  const [editingEvent, setEditingEvent] = useState<{ key: string; id: string } | null>(null);
  const [holVersion, setHolVersion] = useState(0);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  // 事件删除退场：待播完 w-item-out 的 id 集合。
  const [closingEvents, setClosingEvents] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (!confirmDelete) return;
    safeTimeout(() => setConfirmDelete(null), 2000);
  }, [confirmDelete, safeTimeout]);
  const [showPicker, setShowPicker] = useState(false);
  const [pickerYear, setPickerYear] = useState(() => view.getFullYear());
  const pickerRef = useRef<HTMLDivElement>(null);
  /* 退场动画窗口：进场 cal-detail-in 用 --dur-fx，退场同节奏（w-fade-out）。 */
  const pickerVisible = useDelayedUnmount(showPicker, Math.round(animDurations().fxMs));

  /* ---- W-018 节假日在线更新：拉取远程表并订阅变更触发重渲染。 ---- */
  useEffect(() => {
    void ensureHolidayData();
    return subscribeRemoteHolidays(() => setHolVersion((v) => v + 1));
  }, []);

  /* ---- W-016 ICS 订阅：拉一年窗口缓存到组件状态。 ---- */
  const icsEnabled =
    config.icsEnabled === true && typeof config.icsUrl === "string" && /^https?:\/\//.test(config.icsUrl);
  const icsUrl = typeof config.icsUrl === "string" ? config.icsUrl.trim() : "";
  const [icsEvents, setIcsEvents] = useState<IcsEvent[]>([]);
  const [icsState, setIcsState] = useState<"idle" | "loading" | "error">("idle");
  const [icsStamp, setIcsStamp] = useState(0);
  useEffect(() => {
    if (!icsEnabled || !icsUrl) {
      setIcsEvents([]);
      setIcsState("idle");
      return;
    }
    let disposed = false;
    setIcsState("loading");
    const start = new Date(today.getFullYear(), 0, 1);
    const end = new Date(today.getFullYear() + 1, 11, 31);
    fetchIcsEvents(icsUrl, start, end)
      .then((list) => {
        if (disposed) return;
        setIcsEvents(list);
        setIcsState("idle");
      })
      .catch(() => {
        if (disposed) return;
        setIcsEvents([]);
        setIcsState("error");
      });
    return () => {
      disposed = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [icsEnabled, icsUrl, icsStamp, today.getFullYear()]);

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
  /* W-017 视图粒度。 */
  const viewMode =
    (config.viewMode as string) === "week" || (config.viewMode as string) === "double"
      ? (config.viewMode as "week" | "double")
      : "month";
  /* W-015 月格事件摘要。 */
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
    // 同窗广播：今日概览监听后即时重扫（跨窗口经 reload/重启自然生效）。
    window.dispatchEvent(new Event("focus-desk:calendar-changed"));
  }, [events, instanceId]);

  useEffect(() => {
    const id = window.setInterval(() => {
      const n = new Date();
      setToday((prev) =>
        prev.getFullYear() === n.getFullYear() && prev.getMonth() === n.getMonth() && prev.getDate() === n.getDate()
          ? prev
          : n
      );
    }, 30_000);
    return () => window.clearInterval(id);
  }, []);

  /** W-013 重复展开：某日期上的全部本组件事件（锚点 + 重复规则命中）。
   *  P-perf：锚点键的 parseKey 正则解析在 memo 内一次性预解析（此前每次
   *  单日查询都对全部锚点重跑 regex——月视图 42 格 × 锚点数）。 */
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
      const out = [...(events[key] ?? [])];
      for (const { key: anchorKey, anchor, list } of parsedAnchors) {
        if (anchorKey === key) continue;
        for (const ev of list) {
          if (repeatMatches(anchor, ev.repeat, date)) out.push(ev);
        }
      }
      out.sort((a, b) => a.time.localeCompare(b.time) || a.text.localeCompare(b.text));
      return out;
    };
  }, [events]);

  /* ---- W-013 事件提醒：轮询今天带提醒的事件，到点推送一次。 ---- */
  useEffect(() => {
    const tick = () => {
      const now = new Date();
      const nowMin = now.getHours() * 60 + now.getMinutes();
      const key = dateKey(now.getFullYear(), now.getMonth(), now.getDate());
      for (const ev of eventsOnDay(now)) {
        if (!ev.time || ev.remind <= 0) continue;
        const due = ev.time.split(":").map(Number);
        const startMin = (due[0] || 0) * 60 + (due[1] || 0);
        const fireAt = startMin - ev.remind;
        if (nowMin < fireAt || nowMin > fireAt + 15) continue;
        // 去重键按天写入、由 markReminded 顺带清扫过期键（此前永不清除、无限堆积）。
        const dedupeKey = `focus-desk.cal-remind.${instanceId}.${ev.id}.${key}`;
        if (!markReminded(dedupeKey, "focus-desk.cal-remind.", key)) continue;
        void sourceNotify("calendar", tr("日历提醒"), `${ev.time} ${ev.text}`);
      }
    };
    tick();
    const id = window.setInterval(tick, 30_000);
    return () => window.clearInterval(id);
  }, [eventsOnDay, instanceId, tr]);

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

  /** 当月每天的课程事件（按实际上课时间排序），供网格圆点与详情面板使用。 */
  const syncedEvents = useMemo(() => {
    const map: Record<string, SyncedCourseEvent[]> = {};
    if (!syncSources.length) return map;
    const d = new Date(year, month, 1);
    while (d.getMonth() === month || d.getTime() <= new Date(year, month + 1, 7).getTime()) {
      if (d.getFullYear() === year && d.getMonth() === month) {
        const key = dateKey(d.getFullYear(), d.getMonth(), d.getDate());
        for (const src of syncSources) {
          const evts = sessionsOnDate(src.data, d, src.starts, src.ends);
          if (evts.length) (map[key] ||= []).push(...evts);
        }
        if (map[key]) map[key].sort((a, b) => a.start.localeCompare(b.start));
      }
      d.setDate(d.getDate() + 1);
    }
    return map;
  }, [syncSources, year, month]);

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
    setSelected(null);
    applyDir(new Date(n.getFullYear(), n.getMonth(), 1));
    setView(new Date(n.getFullYear(), n.getMonth(), 1));
    setWeekCursor(new Date(n));
  };

  const openPicker = () => {
    setPickerYear(year);
    setShowPicker(true);
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

  /* ------------------ 事件读写（W-013/014） ------------------ */

  const removeEvent = (key: string, id: string) => {
    setEvents((prev) => {
      const list = (prev[key] ?? []).filter((e) => e.id !== id);
      const next = { ...prev };
      if (list.length > 0) next[key] = list;
      else delete next[key];
      return next;
    });
  };

  const requestRemoveEvent = (key: string, id: string) => {
    if (confirmDelete === id) {
      setConfirmDelete(null);
      // 先播 is-closing 收拢淡出，再真正落删（对齐便签/书签的退场语言）。
      setClosingEvents((s) => new Set(s).add(id));
      safeTimeout(() => {
        removeEvent(key, id);
        setClosingEvents((s) => {
          const nx = new Set(s);
          nx.delete(id);
          return nx;
        });
        if (editingEvent?.id === id) setEditingEvent(null);
      }, 200);
    } else {
      setConfirmDelete(id);
    }
  };

  const saveEvent = (key: string, draft: CalendarEvent) => {
    setEvents((prev) => {
      const editing = editingEvent?.key === key ? editingEvent.id : null;
      const list = prev[key] ?? [];
      const next = editing ? list.map((e) => (e.id === editing ? draft : e)) : [...list, draft];
      return { ...prev, [key]: next };
    });
    setEditingEvent(null);
  };

  /* ---- 二级目录：选中日期的详情 ---- */
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

  const selectedEvents = selected ? eventsOnDay(selectedDetail!.date) : [];
  const selectedIcs = selected ? (icsByDay[selected] ?? []) : [];
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

  /* ------------------ 月格（月 / 双月共用） ------------------ */

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
    /** 该行首个有效日期的 ISO 周数；整行空白返回 0。 */
    const weekNumberOf = (row: (number | null)[]) => {
      const d = row.find((x) => x !== null);
      if (d == null) return 0;
      return getISOWeekNumber(new Date(gy, gm, d));
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
              const dayOwn = eventsOnDay(date);
              const lunar = getLunarInfo(date);
              const holiday = getHoliday(date);
              const hasEvents =
                dayOwn.length > 0 || (syncedEvents[key]?.length ?? 0) > 0 || (icsByDay[key]?.length ?? 0) > 0;
              const dayDeadlines = deadlinesByDay[key] ?? [];
              const isMemorial = showMemorialMarks && holiday != null && holiday.mark !== "休";
              /* W-015 月格事件摘要：非紧凑模式下显示前 2 条（自有事件优先）。 */
              const chips = showCellEvents && !mini ? dayOwn.slice(0, 2) : [];
              const chipMore =
                showCellEvents && !mini ? dayOwn.length + (icsByDay[key]?.length ?? 0) - chips.length : 0;
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
                  data-interactive
                  title={holiday ? holiday.name : undefined}
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
                  {chips.length > 0 && (
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

  /* ------------------ 周视图（W-017） ------------------ */

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

  const renderWeekList = () => (
    <div className="widget-week-list">
      {weekDays.map((date) => {
        const key = dateKey(date.getFullYear(), date.getMonth(), date.getDate());
        const dayOwn = eventsOnDay(date);
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
            onKeyDown={(e) => e.key === "Enter" && setSelected(key)}
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
                  {ev.time && <span className="widget-week-ev-time">{ev.time}</span>}
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
              {dayDeadlines.map((d) => (
                <div key={d.id} className={`widget-week-ev ddl${d.completed ? " done" : ""}`}>
                  <span className="widget-week-ev-text">{d.title}</span>
                </div>
              ))}
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

  return (
    <div className={`widget-calendar${compact ? " compact" : ""}`}>
      <div className="widget-cal-header">
        <button
          onClick={() => shift(-1)}
          aria-label={viewMode === "week" ? tr("上一周") : tr("上个月")}
          data-interactive
        >
          <ChevronLeft size={15} />
        </button>
        <button className="widget-cal-title" onClick={openPicker} aria-label={tr("选择年月")} data-interactive>
          {viewMode === "week"
            ? `${weekDays[0].getMonth() + 1}${tr("月")}${weekDays[0].getDate()}${tr("日")} – ${weekDays[6].getMonth() + 1}${tr("月")}${weekDays[6].getDate()}${tr("日")}`
            : `${year}${tr("年")} ${month + 1}${tr("月")}`}
        </button>
        <button onClick={goToday} aria-label={tr("跳转到今天")} data-interactive>
          <Calendar size={15} />
        </button>
        <button
          onClick={() => shift(1)}
          aria-label={viewMode === "week" ? tr("下一周") : tr("下个月")}
          data-interactive
        >
          <ChevronRight size={15} />
        </button>
      </div>

      {/* W-017 视图切换：月 / 周 / 双月。 */}
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
        {/* W-016 ICS 订阅状态：错误提示 + 手动刷新。 */}
        {icsEnabled && (
          <button
            className={`widget-cal-ics${icsState === "error" ? " error" : ""}${icsState === "loading" ? " loading" : ""}`}
            title={icsState === "error" ? tr("订阅拉取失败，点击重试") : tr("刷新日历订阅")}
            onClick={() => setIcsStamp((v) => v + 1)}
            data-interactive
          >
            <RefreshCw size={11} />
          </button>
        )}
      </div>

      {/* 二级目录：年份 / 月份选择器。#57 统一退场：关闭后播 .is-closing 再卸载。 */}
      {pickerVisible && (
        <div className={`widget-cal-picker${showPicker ? "" : " is-closing"}`} ref={pickerRef}>
          <div className="widget-cal-picker-year">
            <button onClick={() => setPickerYear((y) => y - 1)} aria-label={tr("上一年")} data-interactive>
              <ChevronLeft size={13} />
            </button>
            <strong>
              {pickerYear}
              {tr("年")}
            </strong>
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

      {/* 同步课程：按实际上课时间排序展示（来自课程表小组件，只读） */}
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
          <div className="widget-cal-detail-deadlines">
            {(deadlinesByDay[selected] ?? []).map((d) => (
              <div key={d.id} className={`widget-cal-deadline${d.completed ? " done" : ""}`}>
                <span>{d.title}</span>
              </div>
            ))}
          </div>
          {/* 当天习惯打卡：只读列出已完成习惯的名称。 */}
          {(habitsDoneByDay[selected]?.length ?? 0) > 0 && (
            <div className="widget-cal-detail-habits">
              <div className="widget-cal-courses-head">{tr("当天习惯打卡")}</div>
              {(habitsDoneByDay[selected] ?? []).map((name, i) => (
                <div className="widget-cal-habit" key={`${name}-${i}`}>
                  <Check size={11} />
                  <span>{name}</span>
                </div>
              ))}
            </div>
          )}
          {/* 同步课程：按实际上课时间排序展示（来自课程表小组件，只读）。 */}
          {(syncedEvents[selected] ?? []).length > 0 && (
            <div className="widget-cal-courses">
              <div className="widget-cal-courses-head">{tr("当天课程 · 同步自课程表")}</div>
              {(syncedEvents[selected] ?? []).map((ev) => (
                <div
                  key={ev.id}
                  className="widget-cal-course"
                  title={`${ev.start}–${ev.end} ${ev.name}${ev.location ? ` · ${ev.location}` : ""}`}
                >
                  <span className="widget-cal-course-bar" style={{ background: ev.color }} />
                  <span className="widget-cal-course-time">
                    {ev.start}
                    <em>–{ev.end}</em>
                  </span>
                  <span className="widget-cal-course-body">
                    <span className="widget-cal-course-name">{ev.name}</span>
                    {ev.location && <span className="widget-cal-course-loc">{ev.location}</span>}
                  </span>
                </div>
              ))}
            </div>
          )}
          {/* W-013/014 事件编辑行：添加 / 编辑共用 */}
          {selectedIcs.length > 0 && (
            <div className="widget-cal-courses">
              <div className="widget-cal-courses-head">{tr("订阅日历 · ICS")}</div>
              {selectedIcs.map((ev) => (
                <div key={ev.uid} className="widget-cal-course sub" title={ev.location || undefined}>
                  <span className="widget-cal-course-bar sub" />
                  <span className="widget-cal-course-time">{ev.time || tr("全天")}</span>
                  <span className="widget-cal-course-body">
                    <span className="widget-cal-course-name">{ev.title}</span>
                    {ev.location && <span className="widget-cal-course-loc">{ev.location}</span>}
                  </span>
                </div>
              ))}
            </div>
          )}
          <div className="widget-cal-pop-list">
            {selectedEvents.length === 0 &&
              (syncedEvents[selected]?.length ?? 0) === 0 &&
              selectedIcs.length === 0 &&
              (deadlinesByDay[selected]?.length ?? 0) === 0 &&
              (habitsDoneByDay[selected]?.length ?? 0) === 0 && (
                <div className="widget-cal-pop-empty">{tr("暂无事件")}</div>
              )}
            {selectedEvents.map((ev) => (
              <div
                className={`widget-cal-pop-item${editingEvent?.id === ev.id ? " editing" : ""}${closingEvents.has(ev.id) ? " is-closing" : ""}`}
                key={ev.id}
              >
                <span
                  className="widget-cal-pop-item-bar"
                  style={{ background: ev.color || "var(--accent, #5b8def)" }}
                />
                {ev.time && <span className="widget-cal-pop-item-time">{ev.time}</span>}
                <span className="widget-cal-pop-item-text">{ev.text}</span>
                {ev.remind > 0 && <Bell size={10} className="widget-cal-pop-item-remind" />}
                {ev.repeat !== "none" && <Repeat size={10} className="widget-cal-pop-item-repeat" />}
                <button
                  onClick={() =>
                    setEditingEvent(
                      editingEvent?.id === ev.id ? null : { key: anchorKeyById.get(ev.id) ?? selected, id: ev.id }
                    )
                  }
                  className={editingEvent?.id === ev.id ? "on" : ""}
                  aria-label={tr("编辑事件")}
                  title={tr("编辑事件")}
                  data-interactive
                >
                  {editingEvent?.id === ev.id ? <X size={12} /> : <Pencil size={12} />}
                </button>
                <button
                  onClick={() => requestRemoveEvent(anchorKeyById.get(ev.id) ?? selected, ev.id)}
                  aria-label={confirmDelete === ev.id ? tr("再次点击确认删除") : tr("删除事件")}
                  title={confirmDelete === ev.id ? tr("再次点击确认删除") : tr("删除事件")}
                  data-interactive
                >
                  {confirmDelete === ev.id ? <Check size={12} /> : <Trash2 size={12} />}
                </button>
              </div>
            ))}
          </div>
          {/* W-013/014 添加与编辑共用一行：时间 + 文本 + 高级选项。 */}
          <CalendarEventEditor
            key={editingEvent ? `edit-${editingEvent.id}` : "add"}
            editing={editingEvent ? (events[editingEvent.key]?.find((e) => e.id === editingEvent.id) ?? null) : null}
            onSave={(draft) => saveEvent(editingEvent?.key ?? selected, draft)}
            onCancel={() => setEditingEvent(null)}
          />
        </div>
      )}
    </div>
  );
}
