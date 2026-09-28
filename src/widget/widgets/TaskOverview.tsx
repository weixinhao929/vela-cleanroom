/**
 * 任务全览（C1 第三个沉浸页：看板式）。
 *
 * 待办清单卡片展开后的五列看板「逾期 / 今天 / 之后 / 无期限 / 已完成」，
 * 列由 completed + dueAt 派生（task-overview-shared.bucketTasks），不新增
 * 存储字段。卡片 = 标题 + 优先级色条 + 截止徽标。
 *
 * 交互（pointer 拖动 + FLIP 落位，范式同通知中心滑删）：
 *  - 拖到「已完成」= toggleTask；拖出已完成到日期列 = 先 toggleTask 恢复再改期；
 *  - 拖到「今天 / 之后」= updateTask({dueAt})（保留原时分秒，无则 23:59）；
 *  - 拖到「无期限」= updateTask({dueAt: ""})；
 *  - 列内拖动 = reorderTasks（以五列展示序拼接的全量 id 覆写 sortOrder）；
 *  - 「逾期」不是可指派目标（过去的时间无意义），只接受本列重排；
 *  - 位移 < 6px 的松手视为点击：切换完成（键盘 Enter / Space 同义）。
 *  数据写入全部经 useAppStore 既有动作（persist-first 协议自动生效）。
 *
 * 契约：registry `ExpandedComponent`，签名 ({instanceId, active})。本页
 * 无轮询 / rAF / 采集——仅订阅 store 与 60s 共享日界节拍；active=false
 * 时中止在途拖动（Esc 收起由 WidgetExpandOverlay 处理）。
 * 动效门禁：FLIP 由 flipReorder 内部按 reduce-motion 短路；悬停浮起增强档
 * 走 useFxEffectEnabled("cardHover")；CSS 侧 ko-* 全部收在 reduce-motion 兜底块。
 */
import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent
} from "react";
import { createPortal } from "react-dom";
import {
  AlertCircle,
  CalendarCheck,
  CalendarDays,
  CheckCircle2,
  Infinity as InfinityIcon,
  ListChecks,
  type LucideIcon
} from "lucide-react";
import { useAppLocale, useT } from "../../i18n-lite";
import { flipReorder } from "../../lib/anim";
import { useFxEffectEnabled } from "../../lib/fx";
import { useNow } from "../../lib/use-now";
import { useAppStore } from "../../store/app-store";
import type { Task } from "../../domain/schemas";
import type { ExpandedComponentProps } from "../expand-store";
import { bucketTasks, dueAtForBucket, TASK_BUCKETS, type BucketedTasks, type TaskBucket } from "./task-overview-shared";
import "../../styles/feature-immersive.css";

/** 拾起阈值：位移小于此值的松手视为点击（切换完成），避免手抖误拖。 */
const DRAG_THRESHOLD = 6;
/** 日界刷新节拍（共享 ticker）：只为跨午夜时把「今天」滑成「逾期」。 */
const DAY_TICK_MS = 60_000;

/** 五列元数据；label / hint 为中文键，渲染时经 tr() 翻译（逾期列复用「已逾期」既有键，与待办卡片分组标签同词）。 */
const COLUMNS: { bucket: TaskBucket; label: string; hint: string; icon: LucideIcon }[] = [
  { bucket: "overdue", label: "已逾期", hint: "过期未完成的任务会出现在这里", icon: AlertCircle },
  { bucket: "today", label: "今天", hint: "拖到这里设为今天到期", icon: CalendarCheck },
  { bucket: "later", label: "之后", hint: "拖到这里推到明天", icon: CalendarDays },
  { bucket: "none", label: "无期限", hint: "拖到这里清除截止时间", icon: InfinityIcon },
  { bucket: "done", label: "已完成", hint: "拖到这里标记完成", icon: CheckCircle2 }
];

/** 逾期列不可作为跨列落点（无法指派过去的时间），仅接受本列卡片重排。 */
const canDrop = (target: TaskBucket, from: TaskBucket) => target !== "overdue" || from === "overdue";

/** pointerdown 后、越过阈值前的待定手势。 */
type Pending = {
  task: Task;
  bucket: TaskBucket;
  index: number;
  pointerId: number;
  sx: number;
  sy: number;
  rect: DOMRect;
  moved: boolean;
};

/** 进行中的拖动：幽灵卡位置 + 指针所在列与插入索引（几何索引，含源卡自身）。
 *  overBucket 记录指针实际所在列（可能是拒收的逾期列，用于「不可放」反馈）；
 *  droppable=false 时松手不提交。 */
type DragState = {
  task: Task;
  fromBucket: TaskBucket;
  fromIndex: number;
  grabX: number;
  grabY: number;
  w: number;
  h: number;
  x: number;
  y: number;
  overBucket: TaskBucket | null;
  overIndex: number;
  droppable: boolean;
};

type DueInfo = { text: string; tone: "overdue" | "today" | "later" };

const priorityLabel = (p: number, tr: (s: string) => string) =>
  p === 3 ? tr("高") : p === 2 ? tr("中") : p === 1 ? tr("低") : "";

const startOfDay = (ms: number) => {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
};

export function TaskOverview({ active }: ExpandedComponentProps) {
  const tr = useT();
  const locale = useAppLocale();
  const tasks = useAppStore((s) => s.tasks);
  const nowMs = useNow(DAY_TICK_MS).getTime();
  const fxLift = useFxEffectEnabled("cardHover");

  const buckets = useMemo(() => bucketTasks(tasks, nowMs), [tasks, nowMs]);
  const openCount = tasks.length - buckets.done.length;

  const fmtTime = useMemo(
    () => new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit", hour12: false }),
    [locale]
  );
  const fmtDate = useMemo(() => new Intl.DateTimeFormat(locale, { month: "numeric", day: "numeric" }), [locale]);

  /** 截止徽标：逾期显日期、今天 / 明天显相对词，其余显日期；已完成与无期限不显。 */
  const dueInfo = useCallback(
    (task: Task, bucket: TaskBucket): DueInfo | null => {
      if (bucket === "done" || bucket === "none") return null;
      const d = new Date(task.dueAt);
      if (Number.isNaN(d.getTime())) return null;
      const time = fmtTime.format(d);
      if (bucket === "today") return { text: `${tr("今天")} ${time}`, tone: "today" };
      const diffDays = Math.round((startOfDay(d.getTime()) - startOfDay(nowMs)) / 86_400_000);
      if (bucket === "later" && diffDays === 1) return { text: `${tr("明天")} ${time}`, tone: "later" };
      return { text: `${fmtDate.format(d)} ${time}`, tone: bucket === "overdue" ? "overdue" : "later" };
    },
    [fmtTime, fmtDate, nowMs, tr]
  );

  /* ---- 拖动宿主 ----
     pointermove 每帧写 ref，rAF 合并成一次 setState（同通知中心 useSwipeHost）；
     commit 读 ref 取最新值。列体元素按 bucket 登记，供几何命中。 */
  const [drag, setDrag] = useState<DragState | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const pendingRef = useRef<Pending | null>(null);
  const rafRef = useRef(0);
  const boardRef = useRef<HTMLDivElement>(null);
  const colRefs = useRef<Partial<Record<TaskBucket, HTMLDivElement | null>>>({});
  const bucketsRef = useRef<BucketedTasks>(buckets);
  bucketsRef.current = buckets;

  const setDragLive = useCallback((next: DragState | null) => {
    dragRef.current = next;
    cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(() => setDrag(next));
  }, []);

  useEffect(() => () => cancelAnimationFrame(rafRef.current), []);

  /* 收起（Esc / 遮罩点击）时中止在途拖动：之后迟到的 pointerup 不再提交。 */
  useEffect(() => {
    if (active) return;
    pendingRef.current = null;
    if (dragRef.current) setDragLive(null);
  }, [active, setDragLive]);

  /** 几何命中：指针所在列 + 插入索引（指针在某卡中线之上即插到它前面）。 */
  const hitTest = (x: number, y: number): { bucket: TaskBucket; index: number } | null => {
    for (const b of TASK_BUCKETS) {
      const el = colRefs.current[b];
      if (!el) continue;
      const r = el.getBoundingClientRect();
      if (x < r.left || x > r.right || y < r.top || y > r.bottom) continue;
      const cards = Array.from(el.querySelectorAll<HTMLElement>(":scope > .ko-card"));
      let index = cards.length;
      for (let i = 0; i < cards.length; i++) {
        const cr = cards[i].getBoundingClientRect();
        if (y < cr.top + cr.height / 2) {
          index = i;
          break;
        }
      }
      return { bucket: b, index };
    }
    return null;
  };

  /** 点击 / 键盘切换完成：跨列位移用 FLIP 平滑落位。 */
  const toggleWithFlip = (id: string) => {
    const store = useAppStore.getState();
    const board = boardRef.current;
    if (board) flipReorder(board, ".ko-card", () => store.toggleTask(id));
    else store.toggleTask(id);
  };

  /** 松手提交：按落点列派生 store 动作，再以五列展示序覆写全量 sortOrder。 */
  const commitDrop = (d: DragState) => {
    const store = useAppStore.getState();
    const task = store.tasks.find((t) => t.id === d.task.id);
    const target = d.overBucket;
    if (!task || !target || !d.droppable) return;
    const snapshot = bucketsRef.current;
    /* overIndex 是含源卡自身的几何索引；同列时先移除源卡再插入，落点在源卡之后需 -1。 */
    let insertAt = d.overIndex;
    if (target === d.fromBucket && insertAt > d.fromIndex) insertAt -= 1;
    const lists = {} as Record<TaskBucket, string[]>;
    for (const b of TASK_BUCKETS) lists[b] = snapshot[b].filter((t) => t.id !== task.id).map((t) => t.id);
    lists[target].splice(Math.min(insertAt, lists[target].length), 0, task.id);
    const nextOrder = TASK_BUCKETS.flatMap((b) => lists[b]);
    const prevOrder = TASK_BUCKETS.flatMap((b) => snapshot[b].map((t) => t.id));
    const orderChanged = nextOrder.some((id, i) => id !== prevOrder[i]);
    const bucketChanged = target !== d.fromBucket;
    if (!orderChanged && !bucketChanged) return;

    const mutate = () => {
      if (bucketChanged) {
        if (target === "done") {
          if (!task.completed) store.toggleTask(task.id);
        } else if (target === "today" || target === "later" || target === "none") {
          /* 拖出「已完成」先恢复为未完成，再按目标列改期 / 清期。 */
          if (task.completed) store.toggleTask(task.id);
          store.updateTask(task.id, { dueAt: dueAtForBucket(target, task.dueAt, nowMs) });
        }
      }
      if (orderChanged) store.reorderTasks(nextOrder);
    };
    const board = boardRef.current;
    if (board) flipReorder(board, ".ko-card", mutate);
    else mutate();
  };

  /* ---- 卡片手势 ---- */
  const onCardPointerDown = (e: ReactPointerEvent<HTMLDivElement>, task: Task, bucket: TaskBucket, index: number) => {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest("button, a, input, [data-no-drag]")) return;
    pendingRef.current = {
      task,
      bucket,
      index,
      pointerId: e.pointerId,
      sx: e.clientX,
      sy: e.clientY,
      rect: e.currentTarget.getBoundingClientRect(),
      moved: false
    };
  };

  const onCardPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const p = pendingRef.current;
    if (!p || p.pointerId !== e.pointerId) return;
    if (!p.moved) {
      const dx = e.clientX - p.sx;
      const dy = e.clientY - p.sy;
      if (Math.abs(dx) < DRAG_THRESHOLD && Math.abs(dy) < DRAG_THRESHOLD) return;
      p.moved = true;
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        // 极少数环境不支持捕获：仍可在面板内拖动
      }
      dragRef.current = {
        task: p.task,
        fromBucket: p.bucket,
        fromIndex: p.index,
        grabX: p.sx - p.rect.left,
        grabY: p.sy - p.rect.top,
        w: p.rect.width,
        h: p.rect.height,
        x: e.clientX,
        y: e.clientY,
        overBucket: p.bucket,
        overIndex: p.index,
        droppable: true
      };
    }
    const cur = dragRef.current;
    if (!cur) return;
    const hit = hitTest(e.clientX, e.clientY);
    setDragLive({
      ...cur,
      x: e.clientX,
      y: e.clientY,
      overBucket: hit?.bucket ?? null,
      overIndex: hit?.index ?? 0,
      droppable: !!hit && canDrop(hit.bucket, cur.fromBucket)
    });
  };

  const onCardPointerUp = (e: ReactPointerEvent<HTMLDivElement>, cancelled: boolean) => {
    const p = pendingRef.current;
    if (!p || p.pointerId !== e.pointerId) return;
    pendingRef.current = null;
    if (!p.moved) {
      if (!cancelled) toggleWithFlip(p.task.id);
      return;
    }
    const d = dragRef.current;
    setDragLive(null);
    if (!d || cancelled) return;
    commitDrop(d);
  };

  const onCardKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>, task: Task) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      toggleWithFlip(task.id);
    }
  };

  const summary = tr("未完成 {a} · 已完成 {b}")
    .replace("{a}", String(openCount))
    .replace("{b}", String(buckets.done.length));
  const dragTask = drag?.task ?? null;

  return (
    <div className={`ko${fxLift ? " is-fx" : ""}${drag ? " is-dragging" : ""}`}>
      <div className="ko-head">
        <ListChecks size={16} className="ko-head-icon" aria-hidden="true" />
        <span className="ko-title">{tr("任务全览")}</span>
        <span className="ko-summary">{summary}</span>
        <span className="ko-hint">{tr("拖动卡片可改期或标记完成 · 点击卡片切换完成")}</span>
      </div>

      {tasks.length === 0 ? (
        <div className="ko-empty">
          <ListChecks size={26} aria-hidden="true" />
          <span>{tr("还没有任务")}</span>
          <span className="ko-empty-sub">
            {tr("在待办清单卡片中添加任务后，会按逾期 / 今天 / 之后 / 无期限 / 已完成分列展示")}
          </span>
        </div>
      ) : (
        <div className="ko-board" ref={boardRef}>
          {COLUMNS.map((col) => {
            const Icon = col.icon;
            const list = buckets[col.bucket];
            const over = drag?.overBucket === col.bucket ? drag : null;
            const isOver = over?.droppable === true;
            const rejected = over != null && !over.droppable;
            const placeholderAt = over?.droppable ? over.overIndex : -1;
            return (
              <section
                key={col.bucket}
                className={`ko-col b-${col.bucket}${isOver ? " is-over" : ""}${rejected ? " is-rejected" : ""}`}
                aria-label={tr(col.label)}
              >
                <header className="ko-col-head">
                  <Icon size={13} aria-hidden="true" />
                  <span className="ko-col-name">{tr(col.label)}</span>
                  <span className="ko-col-count">{list.length}</span>
                </header>
                <div
                  className="ko-col-body scroll-fade-y"
                  ref={(el) => {
                    colRefs.current[col.bucket] = el;
                  }}
                  data-interactive
                >
                  {list.map((task, index) => {
                    const isSource = drag?.task.id === task.id;
                    const due = dueInfo(task, col.bucket);
                    return (
                      <Fragment key={task.id}>
                        {placeholderAt === index && (
                          <div className="ko-placeholder" style={{ height: over?.h }} aria-hidden="true" />
                        )}
                        <div
                          className={`ko-card${isSource ? " is-source" : ""}${task.completed ? " is-done" : ""}`}
                          role="button"
                          tabIndex={0}
                          aria-pressed={task.completed}
                          aria-label={due ? `${task.title} · ${due.text}` : task.title}
                          title={tr("点击切换完成 · 拖动到其他列改期或标记完成")}
                          data-interactive
                          onPointerDown={(e) => onCardPointerDown(e, task, col.bucket, index)}
                          onPointerMove={onCardPointerMove}
                          onPointerUp={(e) => onCardPointerUp(e, false)}
                          onPointerCancel={(e) => onCardPointerUp(e, true)}
                          onKeyDown={(e) => onCardKeyDown(e, task)}
                        >
                          <CardBody task={task} due={due} tr={tr} />
                        </div>
                      </Fragment>
                    );
                  })}
                  {placeholderAt >= list.length && (
                    <div className="ko-placeholder" style={{ height: over?.h }} aria-hidden="true" />
                  )}
                  {list.length === 0 && !isOver && <div className="ko-col-empty">{tr(col.hint)}</div>}
                </div>
              </section>
            );
          })}
        </div>
      )}

      {/* 幽灵卡：portal 到 body 以脱离面板 overflow / backdrop-filter 的包含块，z 序压过遮罩。 */}
      {drag &&
        dragTask &&
        createPortal(
          <div
            className={`ko-ghost${fxLift ? " is-fx" : ""}`}
            style={{ left: drag.x - drag.grabX, top: drag.y - drag.grabY, width: drag.w }}
            aria-hidden="true"
          >
            <div className={`ko-card is-ghost${dragTask.completed ? " is-done" : ""}`}>
              <CardBody task={dragTask} due={dueInfo(dragTask, drag.fromBucket)} tr={tr} />
            </div>
          </div>,
          document.body
        )}
    </div>
  );
}

/** 卡片内容（列内卡与幽灵卡共用）：优先级色条 + 标题 + 截止徽标。 */
function CardBody({ task, due, tr }: { task: Task; due: DueInfo | null; tr: (s: string) => string }) {
  const p = task.priority ?? 0;
  const pl = priorityLabel(p, tr);
  return (
    <>
      <span className={`ko-pri p${p}`} aria-hidden="true" />
      <div className="ko-card-main">
        <span className="ko-card-title">{task.title}</span>
        {(due || pl) && (
          <span className="ko-card-meta">
            {pl && <span className={`ko-pri-tag p${p}`}>{pl}</span>}
            {due && <span className={`ko-due t-${due.tone}`}>{due.text}</span>}
          </span>
        )}
      </div>
    </>
  );
}

export default TaskOverview;
