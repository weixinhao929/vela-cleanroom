/**
 * 今日待办面板：按截止/优先级聚合今日任务、快捷勾选与新增；
 * 与 app-store 共享任务数据，行内编辑支持自然语言日期。
 */
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Check, Copy, Eraser, GripVertical, Plus, Trash2, X } from "lucide-react";
import { Panel } from "../../components/ui/Panel";
import { copyText } from "../../lib/clipboard";
import { useAppStore } from "../../store/app-store";
import { useHabitsStore, habitTodayKey, habitWeekStart, habitWeekCount } from "../../store/habits-store";
import { useWidgetConfig } from "../../widget/widget-config";
import { useT, useAppLocale } from "../../i18n-lite";
import { confirmDialog } from "../../components/PromptDialog";
import { pushAppToast } from "../../components/ToastHost";
import { parseNaturalDateTime, stripMatchedDate } from "../../lib/natural-date";
import { dayKeyOf, dayKeyToDate, useNow } from "../../lib/use-now";
import { flipReorder } from "../../lib/anim";
import { useSafeTimeout } from "../../lib/use-safe-timeout";
import type { Task } from "../../domain/schemas";

/** 优先级文案：0 无 / 1 低 / 2 中 / 3 高。 */
const PRIORITIES = [0, 1, 2, 3] as const;
const priorityLabel = (p: number, tr: (s: string) => string) =>
  p === 3 ? tr("高") : p === 2 ? tr("中") : p === 1 ? tr("低") : tr("无");

/** 截止徽标：逾期红 / 今天强调 / 明天 / 其余显示日期（日期格式跟随应用内语言，
 *  与 DeadlinePanel 的 useAppLocale 口径一致；不传 locale 会跟随操作系统语言）。 */
function dueLabel(
  dueAt: string,
  tr: (s: string) => string,
  locale: string
): { text: string; tone: "overdue" | "today" | "normal" } {
  const d = new Date(dueAt);
  if (Number.isNaN(d.getTime())) return { text: "", tone: "normal" };
  const now = new Date();
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((startOf(d) - startOf(now)) / 86_400_000);
  if (d.getTime() < now.getTime() && diff <= 0) return { text: tr("已逾期"), tone: "overdue" };
  if (diff === 0) return { text: tr("今天"), tone: "today" };
  if (diff === 1) return { text: tr("明天"), tone: "normal" };
  return {
    text: new Intl.DateTimeFormat(locale, { month: "numeric", day: "numeric" }).format(d),
    tone: "normal"
  };
}

const parseTags = (raw: string): string[] => {
  const out: string[] = [];
  for (const part of raw.split(/[,，]/)) {
    const t = part.trim();
    if (t && !out.includes(t) && out.length < 5) out.push(t);
  }
  return out;
};

export function TodayTasksPanel({ instanceId }: { instanceId: string }) {
  const tr = useT();
  const locale = useAppLocale();
  const safeTimeout = useSafeTimeout();
  const nowTick = useNow();
  const [title, setTitle] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const tasks = useAppStore((s) => s.tasks);
  const addTask = useAppStore((s) => s.addTask);
  const toggleTask = useAppStore((s) => s.toggleTask);
  const deleteTask = useAppStore((s) => s.deleteTask);
  const clearCompletedTasks = useAppStore((s) => s.clearCompletedTasks);
  /* 行内编辑 / 手动排序。 */
  const updateTask = useAppStore((s) => s.updateTask);
  const reorderTasks = useAppStore((s) => s.reorderTasks);
  const habits = useHabitsStore((s) => s.habits);
  const toggleHabit = useHabitsStore((s) => s.toggleHabit);
  const todayKeyStr = habitTodayKey();
  const todayHabits = useMemo(() => [...habits.filter((h) => h.pinned), ...habits.filter((h) => !h.pinned)], [habits]);
  const { config } = useWidgetConfig(instanceId);
  const showCompleted = config.showCompleted !== false;
  const showCount = config.showCount !== false;
  const showProgressTrack = config.showProgressTrack !== false;
  const showEmptyState = config.showEmptyState !== false;
  const showFilter = config.showFilter !== false;
  const showDueGrouping = config.showDueGrouping !== false;
  const maxItems = (config.maxItems as number) || 0;
  const sortOrder = (config.sortOrder as string) || "newest";
  const manual = sortOrder === "manual";
  const [filter, setFilter] = useState<"all" | "active" | "done">("all");

  /* 行内编辑态：双击任务行进入，回车保存、Esc 取消。 */
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [editPriority, setEditPriority] = useState(0);
  const [editTags, setEditTags] = useState("");
  const startEdit = (t: Task) => {
    setEditingId(t.id);
    setEditTitle(t.title);
    setEditPriority(t.priority ?? 0);
    setEditTags((t.tags ?? []).join(", "));
  };
  const saveEdit = () => {
    if (!editingId) return;
    const t = tasks.find((x) => x.id === editingId);
    if (t) {
      const name = editTitle.trim();
      updateTask(t.id, {
        ...(name ? { title: name } : {}),
        priority: editPriority,
        tags: parseTags(editTags)
      });
    }
    setEditingId(null);
  };
  const cancelEdit = () => setEditingId(null);

  /* 删除/清除退场：命中的行先收拢淡出。
     单击即删：此前两击确认在点击穿透层下第二击易被吞，用户反馈"删不掉"，
     改为单击删除 + 退场动画。：toast 无撤销按钮的补偿不足——
     改为「延迟落删」：点击后行立即收拢隐藏，数据保留 4.5s，期间 toast 上
     「撤销」可恢复；窗口过后真正 deleteTask（对 sqlite/localStorage 双模式
     都无需新增 store 动作）。 */
  const [closingIds, setClosingIds] = useState<Set<string>>(new Set());
  const pendingDeleteRef = useRef<Map<string, { timer: number }>>(new Map());

  useEffect(() => {
    const pending = pendingDeleteRef.current;
    return () => {
      // 卸载时把仍在等待期的删除立即落盘（此前只 clearTimeout + clear，删除
      // 被直接取消——删完 4.5s 内切视图（Ctrl+1）导致面板卸载，待办复活）。
      for (const [id, { timer }] of pending.entries()) {
        window.clearTimeout(timer);
        deleteTask(id);
      }
      pending.clear();
    };
    // deleteTask 来自 store（引用稳定），挂载期只跑一次清理逻辑。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const undoDelete = (id: string) => {
    const p = pendingDeleteRef.current.get(id);
    if (!p) return;
    window.clearTimeout(p.timer);
    pendingDeleteRef.current.delete(id);
    setClosingIds((s) => {
      const n = new Set(s);
      n.delete(id);
      return n;
    });
  };

  const requestDelete = (id: string) => {
    const task = tasks.find((t) => t.id === id);
    if (!task || pendingDeleteRef.current.has(id)) return;
    setClosingIds((s) => new Set(s).add(id));
    // 真正删除推迟到 toast 离场（onDismiss）：撤销窗口与「撤销」按钮的可见性严格
    // 一致——此前固定 4.5s 而 toast 4s 就退场（最后 0.5s 无处可撤），悬停 toast
    // 只暂停 toast 计时不暂停删除，悬停超 4.5s 后按钮还在、撤销已 no-op。
    // 15s 兜底定时器只防 toast 队列异常（如从未离场）导致的悬空。
    const commit = () => {
      const p = pendingDeleteRef.current.get(id);
      if (!p) return;
      window.clearTimeout(p.timer);
      pendingDeleteRef.current.delete(id);
      setClosingIds((s) => {
        const n = new Set(s);
        n.delete(id);
        return n;
      });
      deleteTask(id);
    };
    const timer = window.setTimeout(commit, 15000);
    pendingDeleteRef.current.set(id, { timer });
    pushAppToast(tr("已删除"), task.title, "ok", {
      action: { label: tr("撤销"), run: () => undoDelete(id) },
      onDismiss: commit
    });
  };

  /* 清除已完成退场：已完成行整组收拢淡出后再清空数据 */
  const clearCompletedAnimated = async () => {
    if (
      await confirmDialog({
        title: tr("清除已完成"),
        message: tr("清除 {n} 项已完成任务？", { n: completed }),
        confirmLabel: tr("清除"),
        danger: true
      })
    ) {
      // 确认数（全部已完成）与实际清除（store 清全部已完成）同口径——
      // 此前取 visibleTasks（受 filter/showCompleted/maxItems 影响），筛选态
      // 下确认后 doneIds 为空直接 return，承诺清除却零删除。
      const doneIds = new Set(tasks.filter((t) => t.completed).map((t) => t.id));
      if (!doneIds.size) return;
      setClosingIds(doneIds);
      safeTimeout(() => {
        clearCompletedTasks();
        setClosingIds(new Set());
      }, 250);
    }
  };

  const visibleTasks = useMemo(() => {
    let list = showCompleted ? tasks : tasks.filter((t) => !t.completed);
    if (filter === "active") list = list.filter((t) => !t.completed);
    if (filter === "done") list = list.filter((t) => t.completed);
    list = [...list].sort((a, b) => {
      const aDone = a.completed ? 1 : 0;
      const bDone = b.completed ? 1 : 0;
      if (aDone !== bDone) return aDone - bDone; // 未完成在前
      if (manual) return (a.sortOrder ?? 0) - (b.sortOrder ?? 0); // 手动顺序
      const diff = new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
      return sortOrder === "oldest" ? -diff : diff;
    });
    if (maxItems > 0) list = list.slice(0, maxItems);
    return list;
  }, [tasks, showCompleted, sortOrder, manual, maxItems, filter]);

  /* 截止分组：仅当存在带截止的任务时启用，复用 DDL 的分组形态。
     E-dayKey：分组只关心日期边界，依赖用天粒度 todayKey，不再每 30s 全量重算。 */
  const hasDue = useMemo(() => tasks.some((t) => !t.completed && t.dueAt), [tasks]);
  const todayKey = dayKeyOf(nowTick);
  const taskGroups = useMemo(() => {
    if (!showDueGrouping || !hasDue) return null;
    const ref = dayKeyToDate(todayKey);
    if (!ref) return null;
    const byKey: Record<"overdue" | "today" | "future" | "noDue" | "done", Task[]> = {
      overdue: [],
      today: [],
      future: [],
      noDue: [],
      done: []
    };
    const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
    const startNow = startOf(ref);
    visibleTasks.forEach((t) => {
      if (t.completed) {
        byKey.done.push(t);
        return;
      }
      if (!t.dueAt) {
        byKey.noDue.push(t);
        return;
      }
      const d = new Date(t.dueAt);
      if (Number.isNaN(d.getTime())) {
        byKey.noDue.push(t);
        return;
      }
      const diff = Math.round((startOf(d) - startNow) / 86_400_000);
      // 与行徽标 dueLabel/今日概览统一口径：时刻已过即逾期（今天 10:00 到期、
      // 现在 14:00 → 逾期组），不再出现「分组在今天、徽标已逾期」的分裂。
      if (diff < 0 || (diff === 0 && d.getTime() < nowTick.getTime())) byKey.overdue.push(t);
      else if (diff === 0) byKey.today.push(t);
      else byKey.future.push(t);
    });
    const labels: Record<keyof typeof byKey, string> = {
      overdue: tr("已逾期"),
      today: tr("今天到期"),
      future: tr("即将到来"),
      noDue: tr("无截止"),
      done: tr("已完成")
    };
    return (Object.keys(byKey) as (keyof typeof byKey)[])
      .filter((k) => byKey[k].length > 0)
      .map((k) => ({ key: k, label: labels[k], items: byKey[k] }));
    // nowTick：逾期边界精确到时刻（见上方口径统一注释），30s 一拍重算的代价是 O(n) 过滤。
  }, [visibleTasks, showDueGrouping, hasDue, tr, todayKey, nowTick]);

  /* （性能）：计数与索引一次算好，避免每次渲染全表 filter/findIndex（O(n²)）。 */
  const { completed, activeCount } = useMemo(
    () => ({
      completed: tasks.reduce((n, t) => n + (t.completed ? 1 : 0), 0),
      activeCount: tasks.reduce((n, t) => n + (t.completed ? 0 : 1), 0)
    }),
    [tasks]
  );
  const progress = tasks.length ? Math.round((completed / tasks.length) * 100) : 0;
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const copy = async (id: string, text: string) => {
    const ok = await copyText(text);
    if (ok) {
      setCopiedId(id);
      safeTimeout(() => setCopiedId((c) => (c === id ? null : c)), 1200);
    }
  };

  // Focus the quick-add input when the tray "新建任务" action fires.
  useEffect(() => {
    const focus = () => inputRef.current?.focus();
    window.addEventListener("focus-task-input", focus);
    return () => window.removeEventListener("focus-task-input", focus);
  }, []);

  /* 自然语言日期：输入"明天下午3点交报告"自动拆出截止时间。 */
  const natural = useMemo(() => parseNaturalDateTime(title), [title]);

  function submit(event: FormEvent) {
    event.preventDefault();
    const value = title.trim();
    if (!value) return;
    let name = value;
    let dueAt: string | undefined;
    if (natural) {
      const stripped = stripMatchedDate(value, natural.matched).trim();
      if (stripped) {
        name = stripped;
        dueAt = natural.date.toISOString();
      }
    }
    addTask(name, dueAt ? { dueAt } : undefined);
    setTitle("");
  }

  /* 拖拽排序：HTML5 DnD，松手即按当前可见顺序覆写 sortOrder。
     键盘替代——行聚焦后 Alt+↑/↓ 移动（拖拽手柄本身不可聚焦）。
     落位用 FLIP 过渡回弹，替代此前的瞬间跳变。 */
  const listRef = useRef<HTMLDivElement>(null);
  const dragIndexRef = useRef<number>(-1);
  const [dragOverIndex, setDragOverIndex] = useState(-1);
  /* 拖起提升反馈：dragOver 高亮 + FLIP 落位之外补齐第一段——被拖行本体
     半透明 + 投影（.is-dragging），三段反馈不再缺首段。 */
  const [dragFromIndex, setDragFromIndex] = useState(-1);
  const applyReorder = (from: number, target: number) => {
    // 越界即不动：首行 Alt+↑ 的 target=-1 会让 splice(-1) 把它插到倒数第二位。
    if (from < 0 || from === target || target < 0 || target >= visibleTasks.length) return;
    const ids = visibleTasks.map((t) => t.id);
    const [moved] = ids.splice(from, 1);
    ids.splice(target, 0, moved);
    const el = listRef.current;
    if (el) flipReorder(el, ".task-row", () => reorderTasks(ids));
    else reorderTasks(ids);
  };
  const onDropRow = (target: number) => {
    const from = dragIndexRef.current;
    dragIndexRef.current = -1;
    setDragOverIndex(-1);
    setDragFromIndex(-1);
    applyReorder(from, target);
  };
  const onKeyboardMove = (index: number, dir: -1 | 1) => {
    applyReorder(index, index + dir);
  };

  /* 切换完成会因「未完成在前」排序引发行重排：非手动模式用 FLIP 平滑过渡，避免瞬跳。 */
  const toggleWithFlip = (id: string) => {
    const el = listRef.current;
    if (!manual && el) {
      flipReorder(el, ".task-row", () => toggleTask(id));
      return;
    }
    toggleTask(id);
  };

  const showClear = completed > 0;

  const renderRow = (task: Task, index: number) => {
    if (editingId === task.id) {
      return (
        <div className="task-row editing" key={task.id}>
          <input
            className="task-edit-title"
            value={editTitle}
            onChange={(e) => setEditTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") saveEdit();
              else if (e.key === "Escape") cancelEdit();
            }}
            autoFocus
            data-interactive
          />
          <div className="task-edit-ctrl">
            <div className="task-pri-chips" role="group" aria-label={tr("优先级")}>
              {PRIORITIES.map((p) => (
                <button
                  key={p}
                  type="button"
                  className={`task-pri-chip p${p}${editPriority === p ? " on" : ""}`}
                  onClick={() => setEditPriority(p)}
                  data-interactive
                >
                  {priorityLabel(p, tr)}
                </button>
              ))}
            </div>
            <input
              className="task-edit-tags"
              value={editTags}
              onChange={(e) => setEditTags(e.target.value)}
              placeholder={tr("标签，逗号分隔")}
              onKeyDown={(e) => {
                if (e.key === "Enter") saveEdit();
                else if (e.key === "Escape") cancelEdit();
              }}
              data-interactive
            />
            <button type="button" className="task-edit-save" onClick={saveEdit} data-interactive>
              {tr("保存")}
            </button>
            <button
              type="button"
              className="ghost-button"
              onClick={cancelEdit}
              aria-label={tr("取消")}
              data-interactive
            >
              <X size={14} />
            </button>
          </div>
        </div>
      );
    }
    const due = task.dueAt ? dueLabel(task.dueAt, tr, locale) : null;
    return (
      <div
        className={`task-row ${task.completed ? "done" : ""}${closingIds.has(task.id) ? " is-closing" : ""}${manual ? " manual" : ""}${dragOverIndex === index && manual ? " drag-over" : ""}${dragFromIndex === index ? " is-dragging" : ""}`}
        key={task.id}
        onClick={() => toggleWithFlip(task.id)}
        tabIndex={0}
        role="checkbox"
        aria-checked={task.completed}
        onKeyDown={(e) => {
          if (e.target !== e.currentTarget && (e.target as HTMLElement).closest("button,input")) return;
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            toggleWithFlip(task.id);
          } else if (e.key === "F2") {
            e.preventDefault();
            startEdit(task);
          } else if (manual && e.altKey && e.key === "ArrowUp") {
            e.preventDefault();
            onKeyboardMove(index, -1);
          } else if (manual && e.altKey && e.key === "ArrowDown") {
            e.preventDefault();
            onKeyboardMove(index, 1);
          }
        }}
        draggable={manual}
        onDragStart={() => {
          dragIndexRef.current = index;
          setDragFromIndex(index);
        }}
        onDragOver={(e) => {
          if (manual) {
            e.preventDefault();
            setDragOverIndex(index);
          }
        }}
        onDragLeave={() => setDragOverIndex((cur) => (cur === index ? -1 : cur))}
        onDrop={(e) => {
          if (manual) {
            e.preventDefault();
            onDropRow(index);
          }
        }}
        onDragEnd={() => {
          dragIndexRef.current = -1;
          setDragOverIndex(-1);
          setDragFromIndex(-1);
        }}
        onDoubleClick={(e) => {
          e.stopPropagation();
          startEdit(task);
        }}
        title={manual ? tr("双击编辑 · Alt+↑↓ 调整顺序") : tr("双击编辑")}
      >
        {manual && (
          <i className="task-drag-handle" aria-hidden>
            <GripVertical size={14} />
          </i>
        )}
        <button
          className="check-button"
          onClick={(e) => {
            e.stopPropagation();
            toggleWithFlip(task.id);
          }}
          aria-label={tr("切换完成状态")}
        >
          {/* SpringCheck（同名微交互的自绘版）：填充层弹簧胀入 +
              对勾 stroke 描边画出（stroke-dashoffset）；未完成时路径整体藏在
              dash 区间外不可见。增强档（fx）见 feature-fx.css §23。 */}
          <i className="check-fill" aria-hidden="true" />
          <svg className="check-mark" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            <path d="M5 12.5l4.6 4.6L19 7.6" />
          </svg>
        </button>
        <span className="task-cell">
          {(task.priority ?? 0) > 0 && (
            <i className={`task-pri-dot p${task.priority}`} title={priorityLabel(task.priority ?? 0, tr)}>
              {priorityLabel(task.priority ?? 0, tr)}
            </i>
          )}
          <span className="task-cell-title">{task.title}</span>
          {due && due.text && <em className={`task-due ${due.tone}`}>{due.text}</em>}
          {(task.tags ?? []).map((tag) => (
            <em className="task-tag" key={tag}>
              {tag}
            </em>
          ))}
        </span>
        <button
          className="ghost-button"
          onClick={(e) => {
            e.stopPropagation();
            void copy(task.id, task.title);
          }}
          aria-label={tr("复制待办")}
          title={copiedId === task.id ? tr("已复制") : tr("复制文本")}
          data-interactive
        >
          {copiedId === task.id ? <Check size={15} /> : <Copy size={15} />}
        </button>
        <button
          className="ghost-button"
          onClick={(e) => {
            e.stopPropagation();
            requestDelete(task.id);
          }}
          aria-label={tr("删除待办")}
          title={tr("删除")}
        >
          <Trash2 size={15} />
        </button>
      </div>
    );
  };

  return (
    <Panel
      title={tr("今日待办")}
      kicker="TODAY"
      className="tasks-panel"
      action={
        <div className="tasks-panel-action">
          {showCount && (
            <span className="progress-copy">
              {completed}/{tasks.length}
              {tr(" 完成")}
            </span>
          )}
          {showClear && (
            <button
              className="ghost-button clear-completed"
              onClick={() => void clearCompletedAnimated()}
              aria-label={tr("清除已完成")}
              title={tr("清除已完成")}
            >
              <Eraser size={13} />
            </button>
          )}
        </div>
      }
    >
      <form className="quick-add" onSubmit={submit}>
        <input
          ref={inputRef}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder={tr("添加待办，可写“明天下午3点”")}
          aria-label={tr("待办标题")}
        />
        <button type="submit" aria-label={tr("添加待办")}>
          <Plus size={18} />
        </button>
      </form>
      {/* 自然语言日期预览：解析成功时提示将写入的截止时间。 */}
      {natural && (
        <div className="task-natural-preview">
          {tr("识别截止时间")}：
          <b>{`${natural.date.getMonth() + 1}/${natural.date.getDate()} ${String(natural.date.getHours()).padStart(2, "0")}:${String(natural.date.getMinutes()).padStart(2, "0")}`}</b>
        </div>
      )}
      {showProgressTrack && (
        <div className="progress-track" title={`${progress}%${tr(" 完成")}`}>
          <span style={{ transform: `scaleX(${tasks.length ? completed / tasks.length : 0})` }} />
        </div>
      )}
      {showFilter && (
        <div className="task-filter" role="group" aria-label={tr("筛选")}>
          {(
            [
              ["all", "全部"],
              ["active", "进行中"],
              ["done", "已完成"]
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              className={filter === key ? "active" : ""}
              onClick={() => setFilter(key)}
              aria-pressed={filter === key}
            >
              {tr(label)}
              {key === "active" && activeCount > 0 && <em>{activeCount}</em>}
            </button>
          ))}
        </div>
      )}
      {/* 今日习惯：独立分组，复用任务行样式，整行点击切换打卡。 */}
      {todayHabits.length > 0 && (
        <div className="task-group habit-group">
          <div className="task-group-label">
            {tr("今日习惯")}
            <em>{todayHabits.length}</em>
          </div>
          <div className="habit-today-list">
            {todayHabits.map((h) => {
              const done = !!h.done[todayKeyStr];
              const perWeek = h.perWeek ?? 0;
              const weekNow = perWeek > 0 ? habitWeekCount(h, habitWeekStart(new Date())) : 0;
              return (
                <div
                  className={`task-row habit-today-row${done ? " done" : ""}`}
                  key={h.id}
                  onClick={() => toggleHabit(h.id, todayKeyStr)}
                  title={tr("打卡")}
                >
                  <button
                    className="check-button"
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleHabit(h.id, todayKeyStr);
                    }}
                    aria-label={tr("打卡")}
                  >
                    {/* 与上方任务行同款 SpringCheck 弹簧勾（此前裸条件渲染 Check 图标，
                        打卡无过渡反馈，与任务行勾选不一致）。 */}
                    <i className="check-fill" aria-hidden="true" />
                    <svg className="check-mark" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                      <path d="M5 12.5l4.6 4.6L19 7.6" />
                    </svg>
                  </button>
                  <span className="task-cell">
                    <span className="task-cell-title">{h.name}</span>
                    {perWeek > 0 && (
                      <em className="task-due normal">
                        {weekNow}/{perWeek} {tr("次")}
                      </em>
                    )}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}
      <div className="task-list" key={filter} ref={listRef}>
        {visibleTasks.length === 0 && showEmptyState && (
          <div className="empty-state">
            <Check size={22} />
            {tasks.length === 0 ? (
              <>
                <strong>{tr("今天还很轻盈")}</strong>
                <span>{tr("先写下最重要的一件事。")}</span>
              </>
            ) : (
              <>
                <strong>{tr("这里空空如也")}</strong>
                <span>
                  {filter === "done"
                    ? tr("还没有已完成的待办。")
                    : filter === "active"
                      ? tr("所有待办都完成啦！")
                      : tr("没有符合当前条件的待办。")}
                </span>
              </>
            )}
          </div>
        )}
        {taskGroups
          ? taskGroups.map((g) => (
              <div className="task-group" key={g.key}>
                <div className="task-group-label">
                  {g.label}
                  <em>{g.items.length}</em>
                </div>
                {(() => {
                  // 分组渲染用 Map 索引替代每行 findIndex（O(n²)→O(n)）。
                  const idxById = new Map(visibleTasks.map((t, i) => [t.id, i]));
                  return g.items.map((t) => renderRow(t, idxById.get(t.id) ?? 0));
                })()}
              </div>
            ))
          : visibleTasks.map((task, i) => renderRow(task, i))}
      </div>
      {manual && <div className="task-sort-hint">{tr("拖动任务行可调整顺序")}</div>}
    </Panel>
  );
}
