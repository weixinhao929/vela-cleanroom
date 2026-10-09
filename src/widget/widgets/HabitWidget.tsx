/**
 * 习惯打卡小组件：每日/每周习惯、半年热力图（Map 预聚合，P-perf）、
 * 连续天数与完成率统计、到点提醒（来源门控 + 专注静音）。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { BarChart3, Check, ChevronUp, Download, Flame, MoreHorizontal, Pin, Plus, Trash2, X } from "lucide-react";
import { useWidgetConfig } from "../widget-config";
import { useT } from "../../i18n-lite";
import { flipReorder, useCountUp } from "../../lib/anim";
import { useConfirmAction, useDelayedRemoval } from "../../lib/use-confirm-remove";
import { useNow, dayKeyOf } from "../../lib/use-now";
import { useHabitsStore, type Habit } from "../../store/habits-store";

// Use the LOCAL calendar date (not UTC via toISOString) so a habit day rolls
// over at local midnight instead of 08:00 (UTC+8) — otherwise habits reset
// at the wrong time for users east of UTC.
const todayKey = () => {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
};

const dateKey = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** 周一作为一周的第一天。 */
const weekStartOf = (d: Date): Date => {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
  return x;
};

const prevWeekOf = (ws: Date): Date => {
  const x = new Date(ws);
  x.setDate(x.getDate() - 7);
  return x;
};

/** 某习惯在指定周（周一起）的打卡次数。 */
const weekCountOf = (h: Habit, ws: Date): number => {
  let n = 0;
  for (let i = 0; i < 7; i++) {
    const d = new Date(ws);
    d.setDate(ws.getDate() + i);
    if (h.done[dateKey(d)]) n += 1;
  }
  return n;
};

/** 半年热力图（26 周 × 7 天）：格子颜色 = 当日完成习惯占比。
 *  dayKey：调用方传入的本地日键（含在重算依赖里）——常驻桌面跨天/跨周后
 *  窗口跟随滚动，不再定格在挂载周。 */
function HabitHeatmap({ habits, weeks = 26, dayKey }: { habits: Habit[]; weeks?: number; dayKey?: string }) {
  const tr = useT();
  const grid = useMemo(() => {
    const end = new Date();
    end.setHours(0, 0, 0, 0);
    const shiftToMonday = (end.getDay() + 6) % 7; // 0=Mon … 6=Sun
    end.setDate(end.getDate() + (6 - shiftToMonday)); // 对齐到本周周日
    /* P-perf：逐格 habits.filter 是 O(cells×habits)（26×7×H）；先单遍
       汇总每个打卡键的完成数（O(Σkeys)），格子构建只查 Map。 */
    const doneCount = new Map<string, number>();
    for (const h of habits) {
      for (const k of Object.keys(h.done)) {
        if (h.done[k]) doneCount.set(k, (doneCount.get(k) ?? 0) + 1);
      }
    }
    const total = habits.length;
    const columns: { key: string; ratio: number; done: number; total: number; future: boolean }[][] = [];
    for (let w = weeks - 1; w >= 0; w--) {
      const col: { key: string; ratio: number; done: number; total: number; future: boolean }[] = [];
      for (let dow = 0; dow < 7; dow++) {
        const d = new Date(end);
        d.setDate(end.getDate() - (w * 7 + (6 - dow)));
        const k = dateKey(d);
        const done = doneCount.get(k) ?? 0;
        col.push({
          key: k,
          ratio: total === 0 ? 0 : done / total,
          done,
          total,
          future: d.getTime() > Date.now() - 86_400_000 && d.getTime() > new Date().setHours(0, 0, 0, 0)
        });
      }
      columns.push(col);
    }
    return columns;
    // dayKey 是刻意的失效键（跨天滚动窗口），不参与计算体。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [habits, weeks, dayKey]);

  const level = (cell: { ratio: number; total: number }) =>
    cell.total === 0 || cell.ratio === 0 ? 0 : cell.ratio < 0.34 ? 1 : cell.ratio < 0.67 ? 2 : cell.ratio < 1 ? 3 : 4;

  /* 今日格：key 拼上等级，点亮/升级时重建触发一次 scale 弹跳 */
  const todayStr = dateKey(new Date());

  return (
    <div className="habit-heatmap" role="img" aria-label={tr("近半年习惯完成热力图")}>
      {grid.map((col, i) => (
        <div className="habit-heatmap-col" key={i}>
          {col.map((cell) => {
            const lv = level(cell);
            const isToday = cell.key === todayStr;
            return (
              <span
                key={isToday ? `${cell.key}-l${lv}` : cell.key}
                className={`habit-heatmap-cell l${lv}${cell.future ? " future" : ""}${isToday ? " today" : ""}`}
                title={cell.total > 0 ? `${cell.key} · ${cell.done}/${cell.total}` : cell.key}
              />
            );
          })}
        </div>
      ))}
    </div>
  );
}

export function HabitWidget({ instanceId }: { instanceId: string }) {
  const tr = useT();
  const habits = useHabitsStore((s) => s.habits);
  const addHabit = useHabitsStore((s) => s.addHabit);
  const toggleHabit = useHabitsStore((s) => s.toggleHabit);
  const updateHabit = useHabitsStore((s) => s.updateHabit);
  const setHabitPinned = useHabitsStore((s) => s.setHabitPinned);
  const moveHabitUp = useHabitsStore((s) => s.moveHabitUp);
  const removeHabit = useHabitsStore((s) => s.removeHabit);
  const [adding, setAdding] = useState(false);
  const [showHeatmap, setShowHeatmap] = useState(false);
  const [draft, setDraft] = useState("");
  const listRef = useRef<HTMLDivElement | null>(null);
  const now = useNow();
  /* （零点 30s 相位）：useNow 共享 ticker 的相位与零点无对齐，跨零点后
     ≤30s 内 today 仍是昨天，此时打卡会记错天。补一个对齐下一个零点的
     一次性定时器，到点立刻翻日（自重排到之后的每个零点）。 */
  const [midnightToday, setMidnightToday] = useState<string | null>(null);
  useEffect(() => {
    let cancel: (() => void) | null = null;
    const schedule = () => {
      const d = new Date();
      const next = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, 0, 0, 2).getTime();
      const id = window.setTimeout(
        () => {
          setMidnightToday(dayKeyOf(new Date()));
          schedule();
        },
        Math.max(50, next - d.getTime())
      );
      cancel = () => window.clearTimeout(id);
    };
    schedule();
    return () => cancel?.();
  }, []);
  // 时钟回拨等极端情况下以较新者为准（日期键字典序可比）。
  const today = midnightToday && midnightToday >= dayKeyOf(now) ? midnightToday : dayKeyOf(now);
  /** /033 展开的习惯详情面板（重命名 / 每周目标 / 提醒 / 补卡）。 */
  const [expandId, setExpandId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const { config } = useWidgetConfig(instanceId);
  const showCompleted = (config.showCompleted as boolean) !== false;
  const showStreak = config.showStreak !== false;
  const showCount = config.showCount !== false;

  const visibleHabits = showCompleted ? habits : habits.filter((h) => !h.done[today]);

  const add = () => {
    const name = draft.trim();
    if (!name) return;
    addHabit(name);
    setDraft("");
    setAdding(false);
  };

  const toggle = (id: string) => toggleHabit(id, today);

  /** 补卡：补打/撤销任意历史日期。 */
  const toggleDate = (id: string, key: string) => toggleHabit(id, key);

  /** 上移一位（在当前可见列表内交换，隐藏项不动）。 */
  const setPinned = (id: string, v: boolean) => setHabitPinned(id, v);

  /** 上移一位（在当前可见列表内交换，隐藏项不动）；落位用 FLIP 回弹替代瞬移。 */
  const moveUp = (id: string) => {
    const el = listRef.current;
    if (el) flipReorder(el, ".habit-row", () => moveHabitUp(id, { today, showCompleted }));
    else moveHabitUp(id, { today, showCompleted });
  };

  /* 删除交互：二次点击确认 + 收拢淡出后真正移除（时长由 hook 按 --dur-fx
     运行时派生：写死 240ms 不随动效速度档缩放；统一状态机见 use-confirm-remove）。 */
  const { confirmingId: confirmDeleteId, request: confirmRequest } = useConfirmAction();
  const { removingIds, begin: beginRemoval } = useDelayedRemoval(removeHabit);
  const requestDelete = (id: string) => {
    if (confirmRequest(id)) beginRemoval(id);
  };
  // 导出 CSV：习惯,日期,是否完成（UTF-8 BOM 保证 Excel 中文不乱码）。
  const exportCsv = () => {
    const rows: string[] = [`${tr("习惯")},${tr("日期")},${tr("完成")}`];
    const esc = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
    const keys = new Set<string>();
    for (const h of habits) for (const k of Object.keys(h.done)) if (h.done[k]) keys.add(k);
    const sortedKeys = [...keys].sort();
    for (const h of habits) {
      for (const k of sortedKeys) {
        if (h.done[k]) rows.push([esc(h.name), k, tr("是")].join(","));
      }
    }
    const blob = new Blob(["\uFEFF" + rows.join("\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `habits-${todayKey()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const doneCount = habits.filter((h) => h.done[today]).length;
  /* 完成 x/y 计数 count-up：勾选/取消时数字滚动而非瞬时跳变 */
  const doneCountStr = useCountUp(doneCount);

  /** 每日习惯连胜：今天未打卡不断链，从昨天起算。 */
  const dayStreakOf = (h: Habit): number => {
    let n = 0;
    const d = new Date();
    if (!h.done[today]) d.setDate(d.getDate() - 1);
    for (;;) {
      if (h.done[dateKey(d)]) {
        n += 1;
        d.setDate(d.getDate() - 1);
      } else {
        break;
      }
    }
    return n;
  };

  /** 每周目标习惯连胜：按"周达成次数 ≥ perWeek"逐周回溯；本周未达标且未结束不计不断链。 */
  const weekStreakOf = (h: Habit): number => {
    const t = h.perWeek ?? 0;
    if (t <= 0) return 0;
    let n = 0;
    let ws = weekStartOf(new Date());
    if (weekCountOf(h, ws) < t) ws = prevWeekOf(ws);
    while (weekCountOf(h, ws) >= t) {
      n += 1;
      ws = prevWeekOf(ws);
    }
    return n;
  };

  const streakOf = (h: Habit): number => ((h.perWeek ?? 0) > 0 ? weekStreakOf(h) : dayStreakOf(h));

  /** 统计派生：总打卡 / 最长连胜（周习惯按周）/ 本月完成率。 */
  const longestDayStreak = (h: Habit): number => {
    const keys = Object.keys(h.done)
      .filter((k) => h.done[k])
      .sort();
    let best = 0;
    let run = 0;
    let prev: number | null = null;
    for (const k of keys) {
      const t = new Date(`${k}T00:00:00`).getTime();
      if (prev !== null && Math.round((t - prev) / 86_400_000) === 1) run += 1;
      else run = 1;
      if (run > best) best = run;
      prev = t;
    }
    return best;
  };

  const longestWeekStreak = (h: Habit): number => {
    const t = h.perWeek ?? 0;
    if (t <= 0) return 0;
    const keys = Object.keys(h.done)
      .filter((k) => h.done[k])
      .sort();
    if (keys.length === 0) return 0;
    const first = weekStartOf(new Date(`${keys[0]}T00:00:00`));
    const cur = weekStartOf(new Date());
    let best = 0;
    let run = 0;
    for (let ws = new Date(first); ws.getTime() <= cur.getTime(); ws = new Date(ws.getTime() + 7 * 86_400_000)) {
      if (weekCountOf(h, ws) >= t) {
        run += 1;
        if (run > best) best = run;
      } else if (ws.getTime() < cur.getTime()) {
        run = 0; // 本周未结束，未达标不重置连胜
      }
    }
    return best;
  };

  const stats = useMemo(() => {
    let total = 0;
    let longest = 0;
    let longestUnit = tr("天");
    const now = new Date();
    const daysElapsed = now.getDate();
    const monthPrefix = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
    let doneMonth = 0;
    let expected = 0;
    for (const h of habits) {
      total += Object.values(h.done).filter(Boolean).length;
      if ((h.perWeek ?? 0) > 0) {
        const s = longestWeekStreak(h);
        if (s > longest) {
          longest = s;
          longestUnit = tr("周");
        }
        expected += ((h.perWeek ?? 0) / 7) * daysElapsed;
      } else {
        const s = longestDayStreak(h);
        if (s > longest) {
          longest = s;
          longestUnit = tr("天");
        }
        expected += daysElapsed;
      }
      for (const k of Object.keys(h.done)) if (h.done[k] && k.startsWith(monthPrefix)) doneMonth += 1;
    }
    const rate = expected > 0 ? Math.min(999, Math.round((doneMonth / expected) * 100)) : 0;
    return { total, longest, longestUnit, rate };
  }, [habits, tr]);

  const weekDays = (() => {
    const out: string[] = [];
    const d = new Date();
    for (let i = 6; i >= 0; i--) {
      const dd = new Date(d);
      dd.setDate(d.getDate() - i);
      out.push(dateKey(dd));
    }
    return out;
  })();

  /** 补卡网格：近 8 周 × 7 天，历史格子可点击补打/撤销。
     依赖 today（共享 ticker 的本地日键）——桌面常驻数日后零点翻新，
     此前 useMemo([]) 把网格定格在挂载日（"今天"格子消失、future 标记失真）。 */
  const patchGrid = useMemo(() => {
    const start = weekStartOf(new Date());
    const cols: { key: string; future: boolean }[][] = [];
    for (let w = 7; w >= 0; w--) {
      const col: { key: string; future: boolean }[] = [];
      for (let dow = 0; dow < 7; dow++) {
        const d = new Date(start);
        d.setDate(start.getDate() + w * 7 + dow);
        col.push({ key: dateKey(d), future: d.getTime() > new Date().setHours(0, 0, 0, 0) });
      }
      cols.push(col);
    }
    return cols;
    // today 是刻意的失效键（共享 ticker 的本地日键，跨零点重算网格）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [today]);

  const toggleExpand = (id: string) => {
    setExpandId((cur) => (cur === id ? null : id));
    setRenameDraft(habits.find((h) => h.id === id)?.name ?? "");
  };

  const saveRename = (h: Habit) => {
    const name = renameDraft.trim();
    if (name && name !== h.name) updateHabit(h.id, { name });
  };

  return (
    <div className="habit">
      <div className="habit-head">
        <div className="habit-title">
          <Check size={14} />
          <span>{tr("习惯打卡")}</span>
          {showCount && (
            <span className="habit-count">
              {doneCountStr}/{habits.length}
            </span>
          )}
        </div>
        <div className="habit-head-actions">
          <button
            className="habit-tool"
            onClick={() => setShowHeatmap((v) => !v)}
            aria-label={tr("热力图")}
            title={showHeatmap ? tr("收起热力图") : tr("近半年热力图")}
            data-interactive
          >
            <BarChart3 size={13} className={showHeatmap ? "on" : ""} />
          </button>
          <button
            className="habit-tool"
            onClick={exportCsv}
            aria-label={tr("导出 CSV")}
            title={tr("导出全部打卡记录为 CSV")}
            data-interactive
          >
            <Download size={13} />
          </button>
          <button className="habit-add" onClick={() => setAdding((a) => !a)} aria-label={tr("添加习惯")}>
            {adding ? <X size={14} /> : <Plus size={14} />}
          </button>
        </div>
      </div>

      {showHeatmap && (
        <div className="habit-heatmap-wrap">
          <div className="habit-heatmap-head">
            <span>{tr("近半年完成度")}</span>
            <span className="habit-heatmap-legend">
              <i className="habit-heatmap-cell l0" />
              <i className="habit-heatmap-cell l1" />
              <i className="habit-heatmap-cell l2" />
              <i className="habit-heatmap-cell l3" />
              <i className="habit-heatmap-cell l4" />
            </span>
          </div>
          {/* 月度/年度统计：由 done 记录派生 */}
          <div className="habit-stats">
            <span>
              {tr("本月")} <b>{stats.rate}%</b>
            </span>
            <span>
              {tr("总打卡")} <b>{stats.total}</b>
            </span>
            <span>
              {tr("最长连胜")}{" "}
              <b>
                {stats.longest}
                {stats.longestUnit}
              </b>
            </span>
          </div>
          <HabitHeatmap habits={habits} dayKey={today} />
        </div>
      )}

      {adding && (
        <div className="habit-form">
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            /* IME 组合期回车选词不当作提交——拼音串会被存成习惯名。 */
            onKeyDown={(e) => e.key === "Enter" && !e.nativeEvent.isComposing && add()}
            placeholder={tr("新习惯，例如：喝水 8 杯")}
            data-interactive
          />
          <button className="habit-save" onClick={add}>
            {tr("添加")}
          </button>
        </div>
      )}

      <div className="habit-list" ref={listRef}>
        {visibleHabits.length === 0 && <div className="widget-empty">{tr("还没有习惯，添加一个开始打卡吧")}</div>}
        {visibleHabits.map((h, idx) => {
          const perWeek = h.perWeek ?? 0;
          const weekNow = weekCountOf(h, weekStartOf(new Date()));
          const weekHit = perWeek > 0 && weekNow >= perWeek;
          return (
            <div className={`habit-row${removingIds.has(h.id) ? " is-closing" : ""}`} key={h.id}>
              <div className={`habit-item${h.done[today] ? " done" : ""}${expandId === h.id ? " expanded" : ""}`}>
                {h.pinned && <Pin size={10} className="habit-pin-icon" />}
                <button className="habit-check" onClick={() => toggle(h.id)} aria-label={`${tr("打卡")}：${h.name}`}>
                  {h.done[today] && <Check size={14} />}
                </button>
                <span className="habit-name">{h.name}</span>
                {showStreak &&
                  (() => {
                    /* streak≥2 时火焰常亮摇曳（.lit）；数值 +1 时 key 重建触发 flare 放大 */
                    const s = streakOf(h);
                    const unit = perWeek > 0 ? tr("周") : tr("天");
                    return (
                      <span className={`habit-streak${s > 1 ? " lit" : ""}${weekHit ? " met" : ""}`} key={`s${s}`}>
                        {s > 0 ? (
                          <>
                            <Flame size={12} className="habit-streak-icon" />
                            {s} {unit}
                          </>
                        ) : (
                          tr("未开始")
                        )}
                      </span>
                    );
                  })()}
                <span className="habit-week" title={tr("最近 7 天打卡")}>
                  {weekDays.map((k) => (
                    <span key={k} className={`habit-week-dot${h.done[k] ? " on" : ""}`} />
                  ))}
                </span>
                {perWeek > 0 && (
                  <span className={`habit-week-target${weekHit ? " met" : ""}`} title={tr("本周目标")}>
                    {weekNow}/{perWeek}
                  </span>
                )}
                {idx > 0 && (
                  <button
                    className="habit-row-btn habit-up"
                    onClick={() => moveUp(h.id)}
                    aria-label={tr("上移")}
                    title={tr("上移一位")}
                    data-interactive
                  >
                    <ChevronUp size={12} />
                  </button>
                )}
                <button
                  className={`habit-row-btn habit-more${expandId === h.id ? " on" : ""}`}
                  onClick={() => toggleExpand(h.id)}
                  aria-label={tr("编辑习惯")}
                  title={tr("编辑 / 补卡 / 提醒")}
                  data-interactive
                >
                  <MoreHorizontal size={13} />
                </button>
                <button
                  className={`habit-del${confirmDeleteId === h.id ? " danger" : ""}`}
                  onClick={() => requestDelete(h.id)}
                  aria-label={confirmDeleteId === h.id ? tr("再次点击确认删除") : tr("删除习惯")}
                  title={confirmDeleteId === h.id ? tr("再次点击确认删除") : tr("删除习惯")}
                  data-interactive
                >
                  {confirmDeleteId === h.id ? <Check size={12} /> : <Trash2 size={12} />}
                </button>
              </div>

              {/* /032/033/034/035 详情面板 */}
              {expandId === h.id && (
                <div className="habit-panel">
                  <div className="habit-panel-row">
                    <span className="habit-panel-label">{tr("名称")}</span>
                    <input
                      value={renameDraft}
                      onChange={(e) => setRenameDraft(e.target.value)}
                      /* IME 组合期回车选词不当作改名提交。 */
                      onKeyDown={(e) => e.key === "Enter" && !e.nativeEvent.isComposing && saveRename(h)}
                      onBlur={() => saveRename(h)}
                      placeholder={tr("习惯名称")}
                      data-interactive
                    />
                  </div>
                  <div className="habit-panel-row">
                    <span className="habit-panel-label">{tr("频率")}</span>
                    <div className="habit-chips">
                      <button
                        className={`habit-chip${perWeek === 0 ? " on" : ""}`}
                        onClick={() => updateHabit(h.id, { perWeek: 0 })}
                        data-interactive
                      >
                        {tr("每日")}
                      </button>
                      {[1, 2, 3, 4, 5, 6].map((n) => (
                        <button
                          key={n}
                          className={`habit-chip${perWeek === n ? " on" : ""}`}
                          onClick={() => updateHabit(h.id, { perWeek: n })}
                          title={`${tr("每周")} ${n} ${tr("次")}`}
                          data-interactive
                        >
                          {n}
                        </button>
                      ))}
                      <button
                        className={`habit-chip${perWeek === 7 ? " on" : ""}`}
                        onClick={() => updateHabit(h.id, { perWeek: 7 })}
                        data-interactive
                      >
                        7
                      </button>
                    </div>
                  </div>
                  <div className="habit-panel-row">
                    <span className="habit-panel-label">{tr("提醒")}</span>
                    <input
                      type="time"
                      value={h.remindAt ?? ""}
                      onChange={(e) =>
                        updateHabit(h.id, { remindAt: e.target.value || undefined, remindedOn: undefined })
                      }
                      data-interactive
                    />
                    {h.remindAt && (
                      <button
                        className="habit-row-btn"
                        onClick={() => updateHabit(h.id, { remindAt: undefined, remindedOn: undefined })}
                        title={tr("清除提醒")}
                        data-interactive
                      >
                        <X size={12} />
                      </button>
                    )}
                    <button
                      className={`habit-chip${h.pinned ? " on" : ""}`}
                      onClick={() => setPinned(h.id, !h.pinned)}
                      title={tr("置顶")}
                      data-interactive
                    >
                      <Pin size={11} />
                      {tr("置顶")}
                    </button>
                  </div>
                  <div className="habit-panel-grid" aria-label={tr("近 8 周补卡")}>
                    {patchGrid.map((col, ci) => {
                      const colStart = weekStartOf(new Date(`${col[0].key}T00:00:00`));
                      const hit = perWeek > 0 && weekCountOf(h, colStart) >= perWeek;
                      return (
                        <div className={`habit-patch-col${hit ? " hit" : ""}`} key={ci}>
                          {col.map((c) => (
                            <button
                              key={c.key}
                              className={`habit-patch-cell${h.done[c.key] ? " on" : ""}`}
                              disabled={c.future}
                              onClick={() => toggleDate(h.id, c.key)}
                              title={
                                c.future
                                  ? `${c.key} · ${tr("未来日期，无法补卡")}`
                                  : `${c.key}${h.done[c.key] ? " ✓" : ""}`
                              }
                              aria-label={c.key}
                              aria-pressed={c.future ? undefined : !!h.done[c.key]}
                              aria-disabled={c.future || undefined}
                              data-interactive
                            />
                          ))}
                        </div>
                      );
                    })}
                  </div>
                  <div className="habit-panel-tip">{tr("点击历史格子补卡 / 撤销误打")}</div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
