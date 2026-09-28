/**
 * 今日概览小组件：聚合今日任务/截止/课程/习惯打卡的统一面板，
 * 60s 低频刷新派生数据，点击条目跳转对应小组件。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlarmClock,
  CalendarCheck2,
  CheckCircle2,
  Cloud,
  CloudRain,
  CloudSun,
  Cloudy,
  CalendarDays,
  Flame,
  ListTodo,
  Plus,
  Repeat,
  Snowflake,
  Sun,
  Timer,
  Zap
} from "lucide-react";
import { useAppStore } from "../../store/app-store";
import { useHabitsStore, habitTodayKey, habitWeekStart, habitWeekCount } from "../../store/habits-store";
import { useSettingsStore } from "../../store/settings-store";
import { useT } from "../../i18n-lite";
import { useWidgetConfig } from "../widget-config";
import { loadWidgetConfig, CHANGE_EVENT } from "../widget-config";
import { useWidgetStore } from "../widget-store";
import { sanitizeTimetableData, sessionsInWeek } from "../timetable";
import { fetchJson } from "../../lib/network";
import { isOnline } from "../../lib/online-status";
import { useSafeTimeout } from "../../lib/use-safe-timeout";
import { useNow } from "../../lib/use-now";
import { listCalendarEventsOnDayAcrossInstances } from "./calendar-shared";
import { useTauriEvent } from "../../lib/use-tauri-event";
import { WEATHER_CACHE_KEY, weatherCacheSlot, writeCurrentWeatherSlot } from "./weather-cache";

const WEEKDAY_CN = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

/* W-042 复用天气组件的离线缓存（key / 坐标槽格式取自 weather-cache，与 WeatherWidget 同源）。 */
type WeatherCacheSnapshot = {
  weather?: { temperature?: number; weathercode?: number };
  forecast?: { temperature_2m_max?: number[]; temperature_2m_min?: number[] } | null;
};

function readWeatherCache(
  lat: number,
  lon: number
): { temp: number; code: number; hi: number | null; lo: number | null } | null {
  try {
    const raw = localStorage.getItem(WEATHER_CACHE_KEY);
    if (!raw) return null;
    const all = JSON.parse(raw) as Record<string, WeatherCacheSnapshot>;
    const snap = all[weatherCacheSlot(lat, lon)];
    if (!snap?.weather || snap.weather.temperature == null) return null;
    return {
      temp: snap.weather.temperature,
      code: snap.weather.weathercode ?? 0,
      hi: snap.forecast?.temperature_2m_max?.[0] ?? null,
      lo: snap.forecast?.temperature_2m_min?.[0] ?? null
    };
  } catch {
    return null;
  }
}

/** W-040 按时段问候语。 */
function greetingByHour(hour: number): string {
  if (hour >= 5 && hour < 11) return "早上好";
  if (hour >= 11 && hour < 13) return "中午好";
  if (hour >= 13 && hour < 18) return "下午好";
  if (hour >= 18 && hour < 23) return "晚上好";
  return "夜深了";
}

/** F5 今日概览：聚合"今日课程 + 待办 + 截止日期 + 天气"，一屏掌握。 */
export function TodayOverviewWidget({ instanceId }: { instanceId: string }) {
  const tr = useT();
  const safeTimeout = useSafeTimeout();
  const tasks = useAppStore((s) => s.tasks);
  const deadlines = useAppStore((s) => s.deadlines);
  const sessions = useAppStore((s) => s.sessions);
  const addTask = useAppStore((s) => s.addTask);
  const toggleTask = useAppStore((s) => s.toggleTask);
  const habits = useHabitsStore((s) => s.habits);
  const toggleHabit = useHabitsStore((s) => s.toggleHabit);
  // 只订阅画布上首个课程表实例的 id（原始值）：原先订阅整个 instances，任何
  // 布局/z 序变化都会触发下面的 loadWidgetConfig JSON.parse。
  const timetableId = useWidgetStore((s) => s.instances.find((i) => i.type === "timetable")?.id ?? null);
  const { config } = useWidgetConfig(instanceId);
  const showTasks = config.showTasks !== false;
  const showDeadlines = config.showDeadlines !== false;
  const showWeather = config.showWeather !== false;
  const showTimetable = config.showTimetable !== false;
  /* W-038 今日专注统计开关；W-040 问候语开关与自定义文本；W-041 各区块条数上限。 */
  const showFocus = config.showFocus !== false;
  const showGreeting = config.showGreeting !== false;
  const customGreeting = typeof config.greeting === "string" ? config.greeting.trim() : "";
  const maxTasks = typeof config.maxTasks === "number" && config.maxTasks > 0 ? Math.floor(config.maxTasks) : 5;
  const maxCourses = typeof config.maxCourses === "number" && config.maxCourses > 0 ? Math.floor(config.maxCourses) : 6;
  const maxDeadlines =
    typeof config.maxDeadlines === "number" && config.maxDeadlines > 0 ? Math.floor(config.maxDeadlines) : 5;
  /* 今日日程（跨实例聚合日历事件）：补齐「今天的事」口径——待办/DDL/习惯
     都是全局数据，日历事件按实例分键，此前进不了今日概览。 */
  const showEvents = config.showEvents !== false;
  const maxEvents = typeof config.maxEvents === "number" && config.maxEvents > 0 ? Math.floor(config.maxEvents) : 5;

  /* 跨零点后标题日期/问候/今日课程/习惯键/专注统计跟随真实日期：此前
     useMemo(() => new Date(), []) 把日期冻结在挂载时刻，常驻桌面跨天即
     陈旧（TimetableWidget 的同类问题已改 useNow，对齐）。共享低频 ticker，
     60s 粒度足够（仅日期边界需要变化）。 */
  const today = useNow(60_000);
  const todayDay = ((today.getDay() + 6) % 7) + 1; // 1=周一…7=周日

  /* ---- 今日课程：从画布上任一"课程表"小组件的配置读取最新数据 ----
     课表导入 / 编辑只改课表小组件自己的配置（instances 不变），必须同时
     订阅配置变更事件，否则"今日课程"要等画布重建才刷新。 */
  const [cfgVersion, setCfgVersion] = useState(0);
  useEffect(() => {
    const onChanged = () => setCfgVersion((v) => v + 1);
    window.addEventListener(CHANGE_EVENT, onChanged);
    return () => window.removeEventListener(CHANGE_EVENT, onChanged);
  }, []);
  useTauriEvent("sync:widget-config", () => setCfgVersion((v) => v + 1));

  const timetableData = useMemo(() => {
    if (!timetableId) return null;
    const cfg = loadWidgetConfig(timetableId);
    return sanitizeTimetableData(cfg.data) ?? null;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- cfgVersion 是刻意引入的失效信号
  }, [timetableId, cfgVersion]);

  const todaySessions = useMemo(() => {
    if (!timetableData) return [];
    // 审计修复：weekNumberFor 会把学期前/后日期钳制进 [1,totalWeeks]，导致
    // 寒暑假显示第 1 周的课为"今日课程"。改为原始周号 + 越界返回空（与
    // timetable-extras.sessionsOnDate 的口径一致）。
    const start = new Date(`${timetableData.semesterStart}T00:00:00`);
    if (Number.isNaN(start.getTime())) return [];
    const mondayOf = (d: Date) => {
      const m = new Date(d);
      m.setDate(m.getDate() - ((m.getDay() + 6) % 7));
      m.setHours(0, 0, 0, 0);
      return m;
    };
    const days = Math.floor((mondayOf(today).getTime() - mondayOf(start).getTime()) / 86400000);
    const week = Math.floor(days / 7) + 1;
    if (!Number.isFinite(week) || week < 1 || week > timetableData.totalWeeks) return [];
    return sessionsInWeek(timetableData.sessions, week).filter((s) => s.day === todayDay);
  }, [timetableData, today, todayDay]);

  /* ---- 今日待办（未完成） ---- */
  const pendingTasks = useMemo(() => tasks.filter((t) => !t.completed), [tasks]);

  /* ---- 今日习惯（置顶优先） ---- */
  const todayKeyStr = habitTodayKey();
  const todayHabits = useMemo(() => [...habits.filter((h) => h.pinned), ...habits.filter((h) => !h.pinned)], [habits]);
  const doneHabitCount = useMemo(() => habits.filter((h) => h.done[todayKeyStr]).length, [habits, todayKeyStr]);

  /* W-039 快捷添加：回车即入列，复用 addTask。 */
  const [quickTitle, setQuickTitle] = useState("");
  const submitQuick = () => {
    const title = quickTitle.trim();
    if (!title) return;
    addTask(title);
    setQuickTitle("");
  };

  /* W-038 今日专注：当天已完成专注段的轮数与总时长。 */
  const focusStats = useMemo(() => {
    const dayKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
    const list = sessions.filter((s) => s.type === "focus" && s.completed && s.startedAt.slice(0, 10) === dayKey);
    const secs = list.reduce((acc, s) => acc + (s.plannedSeconds || 0), 0);
    return { rounds: list.length, minutes: Math.round(secs / 60) };
  }, [sessions, today]);

  /* #105 勾选完成后行退场：被移除的待办保留 240ms 播收拢淡出，后续行随收拢平滑上移 */
  const [closingTaskIds, setClosingTaskIds] = useState<string[]>([]);
  const prevPendingRef = useRef<string[]>([]);
  useEffect(() => {
    const cur = pendingTasks.map((t) => t.id);
    const prev = prevPendingRef.current;
    const gone = prev.filter((id) => !cur.includes(id));
    prevPendingRef.current = cur;
    if (gone.length) {
      setClosingTaskIds((old) => [...new Set([...old, ...gone])]);
      safeTimeout(() => {
        setClosingTaskIds((old) => old.filter((id) => cur.includes(id)));
      }, 250);
    }
  }, [pendingTasks, safeTimeout]);
  const closingTasks = useMemo(
    () =>
      closingTaskIds.map((id) => tasks.find((t) => t.id === id)).filter((t): t is NonNullable<typeof t> => Boolean(t)),
    [closingTaskIds, tasks]
  );

  /* ---- 今日日程（全部日历实例，含重复规则展开）----
     刷新信号：挂载 / 跨天（today）/ 同窗日历编辑（focus-desk:calendar-changed）
     / 组件配置变化（cfgVersion）。 */
  const [calVersion, setCalVersion] = useState(0);
  useEffect(() => {
    const onChanged = () => setCalVersion((v) => v + 1);
    window.addEventListener("focus-desk:calendar-changed", onChanged);
    return () => window.removeEventListener("focus-desk:calendar-changed", onChanged);
  }, []);
  const todayEvents = useMemo(
    () => listCalendarEventsOnDayAcrossInstances(today).slice(0, maxEvents),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- calVersion/cfgVersion 是刻意引入的失效信号
    [today, maxEvents, calVersion, cfgVersion]
  );

  /* ---- 今日 / 临期截止日期 ---- */
  const todayDeadlines = useMemo(() => {
    const now = Date.now();
    return deadlines
      .filter((d) => !d.completed)
      .map((d) => ({ d, dueMs: new Date(d.dueAt).getTime() }))
      .filter((x) => Number.isFinite(x.dueMs))
      .sort((a, b) => a.dueMs - b.dueMs)
      .filter((x) => x.dueMs <= now + 24 * 60 * 60 * 1000) // 已到期或 24h 内
      .slice(0, maxDeadlines);
  }, [deadlines, maxDeadlines]);

  /* ---- 今日天气（W-042 优先读天气组件缓存，无缓存再发一次轻量请求） ---- */
  const [weather, setWeather] = useState<{ temp: number; code: number; hi: number | null; lo: number | null } | null>(
    null
  );
  const lat = useSettingsStore((s) => s.extra.weatherLat);
  const lon = useSettingsStore((s) => s.extra.weatherLon);
  const city = useSettingsStore((s) => s.extra.weatherCity);
  useEffect(() => {
    if (!showWeather) return;
    // 缓存命中（含高低温）即不再请求网络；每 60s 重读一次以拿到天气组件的新快照。
    const read = () => {
      const cached = readWeatherCache(lat, lon);
      if (cached) setWeather(cached);
      return cached;
    };
    const hit = read();
    const id = window.setInterval(read, 60_000);
    let controller: AbortController | undefined;
    if (!hit && isOnline()) {
      controller = new AbortController();
      fetchJson<{ current_weather?: { temperature?: number; weathercode?: number; windspeed?: number } }>(
        `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current_weather=true&timezone=auto`,
        { retries: 1, signal: controller.signal }
      )
        .then((data) => {
          if (data?.current_weather?.temperature != null) {
            const code = data.current_weather.weathercode ?? 0;
            setWeather({ temp: data.current_weather.temperature, code, hi: null, lo: null });
            // 回写共享「当前天气」槽：同坐标的天气磁贴 / 天气站可直接复用，
            // 不再对同一 lat/lon 各发一次请求。
            writeCurrentWeatherSlot(lat, lon, {
              temperature: data.current_weather.temperature,
              weathercode: code,
              windspeed: data.current_weather.windspeed ?? 0
            });
          }
        })
        .catch(() => {});
    }
    return () => {
      window.clearInterval(id);
      controller?.abort();
    };
  }, [lat, lon, showWeather, cfgVersion]);

  const WIcon = weather ? weatherIcon(weather.code) : null;
  const doneCount = tasks.filter((t) => t.completed).length;
  const greeting = customGreeting || tr(greetingByHour(today.getHours()));

  return (
    <div className="today-overview">
      {/* 日期标题 */}
      <div className="today-overview-head">
        <div className="today-overview-date">
          <strong>
            {today.getMonth() + 1}月{today.getDate()}日
          </strong>
          <span>{tr(WEEKDAY_CN[today.getDay()])}</span>
        </div>
        {showWeather && weather && WIcon && (
          <div className="today-overview-weather" title={tr("今日高 / 低温")}>
            <WIcon size={18} />
            <span>{Math.round(weather.temp)}°</span>
            {weather.hi != null && weather.lo != null && (
              <em className="today-overview-hilo">
                {Math.round(weather.hi)}°/{Math.round(weather.lo)}°
              </em>
            )}
            {city && <em>{tr(city)}</em>}
          </div>
        )}
      </div>

      {/* W-040 问候语 */}
      {showGreeting && <div className="today-overview-greeting">{greeting}</div>}

      {/* W-038 今日专注统计 */}
      {showFocus && (
        <section className="today-overview-block today-overview-focus">
          <div className="today-overview-block-head">
            <span className="today-overview-block-title">
              <Flame size={13} /> {tr("今日专注")}
            </span>
            <span className="today-overview-block-meta" key={focusStats.rounds}>
              {focusStats.rounds} {tr("轮")} · {focusStats.minutes} {tr("分钟")}
            </span>
          </div>
        </section>
      )}

      {/* 待办进度 */}
      {showTasks && (
        <section className="today-overview-block">
          <div className="today-overview-block-head">
            <span className="today-overview-block-title">
              <ListTodo size={13} /> {tr("今日待办")}
            </span>
            <span className="today-overview-block-meta" key={doneCount}>
              {doneCount}/{tasks.length} ·{" "}
              {tr(pendingTasks.length === 0 ? "全部完成" : "剩余 {n} 项").replace("{n}", String(pendingTasks.length))}
            </span>
          </div>
          <div className="today-overview-tasks">
            {pendingTasks.length === 0 && closingTasks.length === 0 ? (
              <span className="today-overview-empty">{tr("没有未完成任务")}</span>
            ) : (
              <>
                {pendingTasks.slice(0, maxTasks).map((t, i) => (
                  <div className="today-overview-task" key={t.id} style={{ ["--sti" as string]: i }}>
                    {/* W-037 行内勾选：概览里直接完成待办 */}
                    <button
                      className="today-overview-check"
                      onClick={() => toggleTask(t.id)}
                      aria-label={tr("完成待办")}
                      aria-pressed={t.completed}
                      title={tr("完成待办")}
                      data-interactive
                    />
                    <span className="today-overview-task-title">{t.title}</span>
                  </div>
                ))}
                {/* #105 退场帧：勾选完成的行收拢淡出，后续行随高度收拢平滑上移 */}
                {closingTasks.map((t) => (
                  <div className="today-overview-task is-closing" key={`closing-${t.id}`}>
                    <CheckCircle2 size={13} className="today-overview-dot" />
                    <span className="today-overview-task-title">{t.title}</span>
                  </div>
                ))}
                {pendingTasks.length > maxTasks && (
                  <span className="today-overview-empty">
                    {tr("还有 {n} 项未显示").replace("{n}", String(pendingTasks.length - maxTasks))}
                  </span>
                )}
              </>
            )}
          </div>
          {/* W-039 快捷添加待办 */}
          <div className="today-overview-quickadd">
            <input
              value={quickTitle}
              onChange={(e) => setQuickTitle(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && submitQuick()}
              placeholder={tr("快速添加待办…")}
              data-interactive
            />
            <button onClick={submitQuick} aria-label={tr("添加待办")} data-interactive>
              <Plus size={13} />
            </button>
          </div>
        </section>
      )}

      {/* 今日习惯 */}
      {habits.length > 0 && (
        <section className="today-overview-block">
          <div className="today-overview-block-head">
            <span className="today-overview-block-title">
              <Repeat size={13} /> {tr("今日习惯")}
            </span>
            <span className="today-overview-block-meta" key={doneHabitCount}>
              {doneHabitCount}/{habits.length}
            </span>
          </div>
          <div className="today-overview-tasks">
            {todayHabits.slice(0, maxTasks).map((h, i) => {
              const done = !!h.done[todayKeyStr];
              const perWeek = h.perWeek ?? 0;
              const weekNow = perWeek > 0 ? habitWeekCount(h, habitWeekStart(new Date())) : 0;
              return (
                <div className="today-overview-task" key={h.id} style={{ ["--sti" as string]: i }}>
                  <button
                    className={`today-overview-check${done ? " done" : ""}`}
                    onClick={() => toggleHabit(h.id, todayKeyStr)}
                    aria-label={done ? tr("取消打卡") : tr("打卡")}
                    aria-pressed={done}
                    title={done ? tr("取消打卡") : tr("打卡")}
                    data-interactive
                  />
                  <span className={`today-overview-task-title${done ? " done" : ""}`}>{h.name}</span>
                  {perWeek > 0 && (
                    <span className="today-overview-task-extra">
                      {weekNow}/{perWeek} {tr("次")}
                    </span>
                  )}
                </div>
              );
            })}
            {todayHabits.length > maxTasks && (
              <span className="today-overview-empty">
                {tr("还有 {n} 项未显示").replace("{n}", String(todayHabits.length - maxTasks))}
              </span>
            )}
          </div>
        </section>
      )}

      {/* 今日课程 */}
      {showTimetable && (
        <section className="today-overview-block">
          <div className="today-overview-block-head">
            <span className="today-overview-block-title">
              <CalendarCheck2 size={13} /> {tr("今日课程")}
            </span>
            <span className="today-overview-block-meta" key={todaySessions.length}>
              {todaySessions.length} {tr("节")}
            </span>
          </div>
          <div className="today-overview-tasks">
            {todaySessions.length === 0 ? (
              <span className="today-overview-empty">{tr("今天没有课")}</span>
            ) : (
              todaySessions.slice(0, maxCourses).map((s, i) => (
                <div className="today-overview-task" key={s.id} style={{ ["--sti" as string]: i }}>
                  <Timer size={13} className="today-overview-dot" />
                  <span className="today-overview-task-title">{s.name}</span>
                  <span className="today-overview-task-extra">
                    {s.startSection === s.endSection
                      ? `第${s.startSection}节`
                      : `第${s.startSection}-${s.endSection}节`}
                    {s.location ? ` · ${s.location}` : ""}
                  </span>
                </div>
              ))
            )}
          </div>
        </section>
      )}

      {/* 今日日程（跨实例日历聚合） */}
      {showEvents && (
        <section className="today-overview-block">
          <div className="today-overview-block-head">
            <span className="today-overview-block-title">
              <CalendarDays size={13} /> {tr("今日日程")}
            </span>
            <span className="today-overview-block-meta" key={todayEvents.length}>
              {todayEvents.length} {tr("项")}
            </span>
          </div>
          <div className="today-overview-tasks">
            {todayEvents.length === 0 ? (
              <span className="today-overview-empty">{tr("今天没有日程")}</span>
            ) : (
              todayEvents.map(({ event }, i) => (
                <div className="today-overview-task" key={`${event.id}-${i}`} style={{ ["--sti" as string]: i }}>
                  <CalendarDays
                    size={13}
                    className="today-overview-dot"
                    style={event.color ? { color: event.color } : undefined}
                  />
                  <span className="today-overview-task-title">{event.text}</span>
                  <span className="today-overview-task-extra">{event.time || tr("全天")}</span>
                </div>
              ))
            )}
          </div>
        </section>
      )}
      {/* 截止日期 */}
      {showDeadlines && (
        <section className="today-overview-block">
          <div className="today-overview-block-head">
            <span className="today-overview-block-title">
              <AlarmClock size={13} /> {tr("截止日期")}
            </span>
          </div>
          <div className="today-overview-tasks">
            {todayDeadlines.length === 0 ? (
              <span className="today-overview-empty">{tr("24h 内无截止任务")}</span>
            ) : (
              todayDeadlines.map(({ d, dueMs }, i) => {
                const overdue = dueMs < Date.now();
                const diff = dueMs - Date.now();
                const label = overdue ? tr("已逾期") : diff < 60 * 60 * 1000 ? tr("不足 1 小时") : tr("今天");
                return (
                  <div
                    className={`today-overview-task${overdue ? " overdue" : ""}`}
                    key={d.id}
                    style={{ ["--sti" as string]: i }}
                  >
                    <Zap size={13} className="today-overview-dot" />
                    <span className="today-overview-task-title">{d.title}</span>
                    <span className="today-overview-task-extra">{label}</span>
                  </div>
                );
              })
            )}
          </div>
        </section>
      )}
    </div>
  );
}

function weatherIcon(code: number) {
  if (code === 0) return Sun;
  if (code <= 2) return CloudSun;
  if (code === 3) return Cloudy;
  if (code >= 51 && code <= 67) return CloudRain;
  if (code >= 71 && code <= 77) return Snowflake;
  if (code >= 95) return Zap;
  return Cloud;
}
