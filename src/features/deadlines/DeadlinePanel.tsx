/**
 * 截止（DDL）面板：倒计时排序列表、自然语言日期输入预览、周期规则、
 * 多档提醒状态展示与增删改；完成/逾期语义按 repeat 滚动。
 */
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { AlertCircle, CalendarClock, Check, Clock, Copy, Plus, Repeat, Trash2, X } from "lucide-react";
import { Panel } from "../../components/ui/Panel";
import { copyText } from "../../lib/clipboard";
import { flipReorder } from "../../lib/anim";
import { todoNotification } from "../../lib/notifications";
import { markReminded } from "../../lib/remind-dedupe";
import { dayKeyOf, dayKeyToDate, useNow } from "../../lib/use-now";
import { useAppStore } from "../../store/app-store";
import { useWidgetConfig } from "../../widget/widget-config";
import { useT, useAppLocale } from "../../i18n-lite";
import { parseNaturalDateTime, stripMatchedDate } from "../../lib/natural-date";
import { useSafeTimeout } from "../../lib/use-safe-timeout";
import { useConfirmAction } from "../../lib/use-confirm-remove";
import type { Deadline } from "../../domain/schemas";
import { DateTimePicker } from "../../components/DatePicker";

/* （性能）：date-fns 此前只为 formatDistanceToNowStrict + zhCN locale
   引入整包依赖（数十 KB vendor）。改用手写相对时长后整体移除。 */

/** 紧急程度：逾期 / 临期（<1h）/ 紧迫（<24h）/ 正常。 */
type Urgency = "overdue" | "imminent" | "soon" | "normal";

function urgencyLevel(due: Date, now: Date): Urgency {
  const diff = due.getTime() - now.getTime();
  if (diff < 0) return "overdue";
  if (diff <= 60 * 60 * 1000) return "imminent";
  if (diff <= 24 * 60 * 60 * 1000) return "soon";
  return "normal";
}

/** 与 date-fns formatDistanceToNowStrict 等价的最大单位相对时长（如「3 小时」）。 */
function relativeSpan(from: Date, to: Date, tr: (s: string) => string): string {
  const diff = Math.abs(to.getTime() - from.getTime());
  const min = 60_000,
    hour = 3_600_000,
    day = 86_400_000;
  const months = Math.floor(day * 30.44);
  const years = Math.floor(day * 365.25);
  const fmt = (n: number, unit: string) => `${n} ${tr(unit)}`;
  if (diff >= years) return fmt(Math.floor(diff / years), "年");
  if (diff >= months) return fmt(Math.floor(diff / months), "个月");
  if (diff >= day) return fmt(Math.floor(diff / day), "天");
  if (diff >= hour) return fmt(Math.floor(diff / hour), "小时");
  if (diff >= min) return fmt(Math.floor(diff / min), "分钟");
  return fmt(Math.max(1, Math.floor(diff / 1000)), "秒");
}

/* 多档提醒：24h / 1h / 10min 各提醒一次。 */
const REMINDER_TIERS = [
  { key: "24h", ms: 24 * 60 * 60 * 1000 },
  { key: "1h", ms: 60 * 60 * 1000 },
  { key: "10min", ms: 10 * 60 * 1000 }
] as const;

/* 周期规则。 */
const REPEATS: Deadline["repeat"][] = ["none", "daily", "weekly", "monthly", "yearly"];
const repeatLabel = (r: Deadline["repeat"], tr: (s: string) => string) =>
  r === "daily"
    ? tr("每天")
    : r === "weekly"
      ? tr("每周")
      : r === "monthly"
        ? tr("每月")
        : r === "yearly"
          ? tr("每年")
          : tr("不重复");

/** datetime-local 控件值（本地时区 YYYY-MM-DDTHH:mm）。 */
function toLocalInput(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function DeadlinePanel({ instanceId }: { instanceId: string }) {
  const tr = useT();
  const safeTimeout = useSafeTimeout();
  const locale = useAppLocale();
  /* 显示用日期格式化走 Intl（跟随应用语言）；datetime-local 的 toLocalInput 保持手写。 */
  const fmtDeadline = useMemo(
    () =>
      new Intl.DateTimeFormat(locale, {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false
      }),
    [locale]
  );
  const fmtExact = useMemo(
    () =>
      new Intl.DateTimeFormat(locale, {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false
      }),
    [locale]
  );
  const fmtMonth = useMemo(() => new Intl.DateTimeFormat(locale, { month: "short" }), [locale]);
  const [title, setTitle] = useState("");
  const [dueAt, setDueAt] = useState("");
  const [repeat, setRepeat] = useState<Deadline["repeat"]>("none");
  const [error, setError] = useState("");
  const [copiedId, setCopiedId] = useState<string | null>(null);
  // 删除二次确认：首次点击进入确认态，2 秒内再次点击才真正删除。
  const { confirmingId: confirmDeleteId, request: confirmRequest } = useConfirmAction();
  // 退场动画：先播 is-closing 收拢淡出，再真正落删/落勾（对齐待办面板 #104）。
  const [closingIds, setClosingIds] = useState<Set<string>>(new Set());
  const exitThen = (id: string, action: () => void) => {
    setClosingIds((s) => new Set(s).add(id));
    safeTimeout(() => {
      action();
      setClosingIds((s) => {
        const nx = new Set(s);
        nx.delete(id);
        return nx;
      });
    }, 220);
  };
  const requestDelete = (id: string) => {
    if (confirmRequest(id)) exitThen(id, () => deleteDeadline(id));
  };
  /* 勾选完成会让行按「未完成在前」重排跳位 —— 落勾前对列表做 FLIP 过渡。 */
  const groupsRef = useRef<HTMLDivElement>(null);
  const commitToggle = (id: string) => {
    const el = groupsRef.current;
    if (el && showCompleted) flipReorder(el, ".deadline-row", () => toggleDeadline(id));
    else toggleDeadline(id);
  };
  const deadlines = useAppStore((s) => s.deadlines);
  const addDeadline = useAppStore((s) => s.addDeadline);
  const toggleDeadline = useAppStore((s) => s.toggleDeadline);
  const deleteDeadline = useAppStore((s) => s.deleteDeadline);
  const updateDeadline = useAppStore((s) => s.updateDeadline);
  const setDeadlineTiers = useAppStore((s) => s.setDeadlineTiers);
  const now = useNow();
  // E-dayKey：分组只关心日期边界，依赖归约为天粒度 todayKey，不再每 30s
  // 全量重算；多档提醒 effect 与逾期计数仍用实时 now（分钟级功能语义）。
  const todayKey = dayKeyOf(now);
  // in-flight 防重（持久化在途的 deadline id）+ 失败退避时间戳，配合 store
  // 的乐观置位，杜绝「IPC 慢/失败 → 每 30s 重复发档甚至热循环」。失败后按
  // 退避窗口延迟重试（不永久禁用，避免编辑后连提醒也一并被吞）。
  const tiersInFlight = useRef<Set<string>>(new Set());
  const tiersRetryAt = useRef<Map<string, number>>(new Map());
  const TIER_RETRY_BACKOFF_MS = 60_000;
  const { config } = useWidgetConfig(instanceId);
  const showCompleted = config.showCompleted !== false;
  const showOverdue = config.showOverdue !== false;
  const showRelativeTime = config.showRelativeTime !== false;
  const showUrgency = config.showUrgency !== false;
  const showGrouping = config.showGrouping !== false;
  const maxItems = (config.maxItems as number) || 0;
  const sortOrder = (config.sortOrder as string) || "soonest";
  const multiTierRemind = config.multiTierRemind !== false;

  /* 行内编辑：双击进入，改标题 / 截止 / 周期，Esc 取消。 */
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [editDue, setEditDue] = useState("");
  const [editRepeat, setEditRepeat] = useState<Deadline["repeat"]>("none");
  const startEdit = (d: Deadline) => {
    setEditingId(d.id);
    setEditTitle(d.title);
    const date = new Date(d.dueAt);
    setEditDue(Number.isNaN(date.getTime()) ? "" : toLocalInput(date));
    setEditRepeat(d.repeat ?? "none");
  };
  const saveEdit = () => {
    if (!editingId) return;
    const d = deadlines.find((x) => x.id === editingId);
    if (d && editTitle.trim() && editDue) {
      const patch: { title?: string; dueAt?: string; repeat?: Deadline["repeat"] } = {};
      if (editTitle.trim() !== d.title) patch.title = editTitle.trim();
      const iso = new Date(editDue).toISOString();
      if (iso !== d.dueAt) patch.dueAt = iso;
      if (editRepeat !== (d.repeat ?? "none")) patch.repeat = editRepeat;
      if (Object.keys(patch).length) updateDeadline(d.id, patch);
    }
    setEditingId(null);
  };

  // 未完成在前（按 dueAt 升序），已完成全部排到列表底部（已完成之间也按 dueAt 排序）。
  // 隐藏已完成时只保留未完成项。
  const sorted = useMemo(
    () =>
      [...deadlines]
        .filter((d) => showCompleted || !d.completed)
        .sort((a, b) => {
          if (a.completed !== b.completed) return a.completed ? 1 : -1;
          const cmp = a.dueAt.localeCompare(b.dueAt);
          return sortOrder === "latest" ? -cmp : cmp;
        })
        .slice(0, maxItems > 0 ? maxItems : undefined),
    [deadlines, showCompleted, sortOrder, maxItems]
  );

  const overdueCount = useMemo(
    () => deadlines.filter((d) => !d.completed && new Date(d.dueAt).getTime() < now.getTime()).length,
    [deadlines, now]
  );

  // 分组：逾期 / 今天 / 未来 / 已完成，便于快速浏览即将到来的节点。
  // 逾期判定用 now（30s tick）而非 Date.now：后者不在 deps 里，到期瞬间
  // 之后 memo 不会重算，条目要等别的依赖变化才移入「已逾期」。
  const groups = useMemo(() => {
    const byKey: Record<"overdue" | "today" | "future" | "done", typeof sorted> = {
      overdue: [],
      today: [],
      future: [],
      done: []
    };
    const startToday = (dayKeyToDate(todayKey) ?? new Date()).getTime();
    const nowMs = now.getTime();
    sorted.forEach((d) => {
      if (d.completed) {
        byKey.done.push(d);
        return;
      }
      const date = new Date(d.dueAt);
      const startDue = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
      if (date.getTime() < nowMs) byKey.overdue.push(d);
      else if (startDue === startToday) byKey.today.push(d);
      else byKey.future.push(d);
    });
    const labels: Record<keyof typeof byKey, string> = {
      overdue: tr("已逾期"),
      today: tr("今天"),
      future: tr("未来"),
      done: tr("已完成")
    };
    return (Object.keys(byKey) as (keyof typeof byKey)[])
      .filter((k) => byKey[k].length > 0)
      .map((k) => ({ key: k, label: labels[k], items: byKey[k] }));
  }, [sorted, todayKey, now, tr]);

  /* 多档提醒链：每个档位只发一次；到期后按「剩余时间对应的最高档」
   * 一次性补发到位（不再逐档在多个 30s 周期里连发）。 */
  useEffect(() => {
    if (!multiTierRemind) return;
    deadlines.forEach((deadline) => {
      if (deadline.completed) return;
      const dueMs = new Date(deadline.dueAt).getTime();
      if (!Number.isFinite(dueMs)) return;
      const sent = deadline.notifiedTiers ?? [];
      const remaining = dueMs - now.getTime();
      // 未发送且已到点的档位（tiers 由大到小：24h→1h→10min，末尾最具体）。
      const applicable = REMINDER_TIERS.filter((t) => !sent.includes(t.key) && remaining <= t.ms);
      if (applicable.length === 0) return;
      // （多实例重复通知）：同窗/跨窗多个 DDL 组件读到同一份「未发档位」
      // 快照时各自派发一次通知。markReminded 写 localStorage（全窗共享）做
      // 档位级全局在途标记——只有抢到至少一个档位的实例发声；落库推进不
      // 受影响（另一实例失败时本实例仍会补写 store）。
      const fresh = applicable.filter((t) =>
        markReminded(`focus-desk.ddl-tier.${deadline.id}.${t.key}.${todayKey}`, "focus-desk.ddl-tier.", todayKey)
      );
      // in-flight 防重：该 id 已有一次派发在途，跳过本轮。
      if (tiersInFlight.current.has(deadline.id)) return;
      // 失败退避：上一次持久化失败后，在退避窗口内不重试。
      if ((tiersRetryAt.current.get(deadline.id) ?? 0) > now.getTime()) return;

      const late = remaining <= 0;
      const leftText =
        remaining > 60 * 60 * 1000
          ? `${Math.ceil(remaining / (60 * 60 * 1000))} ${tr("小时")}`
          : `${Math.max(1, Math.ceil(remaining / 60000))} ${tr("分钟")}`;
      if (fresh.length > 0) {
        todoNotification({
          overdue: late,
          title: tr("DDL 即将到期"),
          body: `${deadline.title} · ${late ? tr("已到期") : `${tr("还有")} ${leftText}`}`
        });
      }
      // 一次推进到「剩余时间对应的最高档」：把所有已到点档位一并标记已发。
      const nextSent = [...sent, ...applicable.map((t) => t.key)];
      tiersInFlight.current.add(deadline.id);
      void setDeadlineTiers(deadline.id, nextSent)
        .then(() => {
          tiersInFlight.current.delete(deadline.id);
          tiersRetryAt.current.delete(deadline.id);
        })
        .catch(() => {
          tiersInFlight.current.delete(deadline.id);
          tiersRetryAt.current.set(deadline.id, now.getTime() + TIER_RETRY_BACKOFF_MS);
        });
    });
  }, [deadlines, now, todayKey, setDeadlineTiers, tr, multiTierRemind]);

  /* 自然语言日期：标题里写"周五下午5点交论文"可自动带出截止时间。 */
  const natural = useMemo(() => parseNaturalDateTime(title), [title]);

  function submit(event: FormEvent) {
    event.preventDefault();
    let name = title.trim();
    let dueIso = dueAt ? new Date(dueAt).toISOString() : "";
    if (natural) {
      const stripped = stripMatchedDate(name, natural.matched).trim();
      if (stripped) name = stripped;
      if (!dueIso) dueIso = natural.date.toISOString();
    }
    if (!name || !dueIso) {
      setError(tr("请填写截止事项和截止时间"));
      return;
    }
    addDeadline(name, dueIso, repeat);
    setTitle("");
    setDueAt("");
    setRepeat("none");
    setError("");
  }

  // 复制截止事项到剪贴板（含标题与格式化截止时间）。
  const copyDeadline = async (id: string, text: string) => {
    const ok = await copyText(text);
    if (ok) {
      setCopiedId(id);
      safeTimeout(() => setCopiedId((c) => (c === id ? null : c)), 1200);
    }
  };

  const renderDeadline = (deadline: (typeof deadlines)[number]) => {
    const date = new Date(deadline.dueAt);
    const overdue = !deadline.completed && date.getTime() < now.getTime();
    const urgency = deadline.completed ? "normal" : urgencyLevel(date, now);

    if (editingId === deadline.id) {
      return (
        <div className="deadline-edit" key={deadline.id}>
          <input
            className="deadline-edit-title"
            value={editTitle}
            onChange={(e) => setEditTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") saveEdit();
              else if (e.key === "Escape") setEditingId(null);
            }}
            autoFocus
            data-interactive
          />
          <div className="deadline-edit-ctrl">
            <DateTimePicker value={editDue} onChange={setEditDue} ariaLabel={tr("截止时间")} />
            <div className="deadline-repeat-chips" role="group" aria-label={tr("重复")}>
              {REPEATS.map((r) => (
                <button
                  key={r}
                  type="button"
                  className={`deadline-repeat-chip${editRepeat === r ? " on" : ""}`}
                  onClick={() => setEditRepeat(r)}
                  data-interactive
                >
                  {repeatLabel(r, tr)}
                </button>
              ))}
            </div>
            <button type="button" className="deadline-edit-save" onClick={saveEdit} data-interactive>
              {tr("保存")}
            </button>
            <button
              type="button"
              className="ghost-button"
              onClick={() => setEditingId(null)}
              aria-label={tr("取消")}
              data-interactive
            >
              <X size={14} />
            </button>
          </div>
        </div>
      );
    }

    return (
      <div
        key={deadline.id}
        className={`deadline-row ${deadline.completed ? "done" : ""} ${overdue && showOverdue ? "overdue" : ""} ${!deadline.completed && showUrgency ? `urgency-${urgency}` : ""}${confirmDeleteId === deadline.id ? " confirm" : ""}${closingIds.has(deadline.id) ? " is-closing" : ""}`}
        data-urgency={!deadline.completed && showUrgency ? urgency : undefined}
        onClick={() => {
          // 隐藏已完成时，勾选会让行离开列表 → 先播退场再落勾。
          if (!deadline.completed && !showCompleted) exitThen(deadline.id, () => toggleDeadline(deadline.id));
          else commitToggle(deadline.id);
        }}
        /* #12：行内已含复制/删除真按钮，行本身不再声明 role="button"
         （交互元素嵌套会让读屏器把整行播成一个按钮）。保留 Tab+Enter
         快捷勾选，语义由行内控件承担。 */
        tabIndex={0}
        onKeyDown={(e) => {
          if ((e.key === "Enter" || e.key === " ") && e.target === e.currentTarget) {
            e.preventDefault();
            commitToggle(deadline.id);
          }
        }}
        onDoubleClick={(e) => {
          e.stopPropagation();
          startEdit(deadline);
        }}
        title={tr("双击编辑")}
      >
        <div className="date-tile">
          <strong>{date.getDate()}</strong>
          <span>{dayLabel(date, deadline.completed)}</span>
        </div>
        <div className="deadline-copy">
          <strong>{deadline.title}</strong>
          {showRelativeTime && (
            <span className="deadline-relative">
              {!deadline.completed && showUrgency && (urgency === "imminent" || urgency === "soon") ? (
                <Clock size={13} aria-hidden="true" />
              ) : null}
              {overdue && <AlertCircle size={13} />}{" "}
              {tr(overdue ? "已逾期 {r}" : "还有 {r}", { r: relativeSpan(date, now, tr) })}
            </span>
          )}
          <span className="deadline-exact">{fmtExact.format(date)}</span>
          {/* 周期标识：勾选完成会自动滚到下一期。 */}
          {(deadline.repeat ?? "none") !== "none" && (
            <span className="deadline-repeat-badge">
              <Repeat size={10} />
              {repeatLabel(deadline.repeat ?? "none", tr)}
            </span>
          )}
        </div>
        <button
          className="ghost-button"
          onClick={(e) => {
            e.stopPropagation();
            void copyDeadline(deadline.id, `${deadline.title}｜${fmtDeadline.format(date)}`);
          }}
          aria-label={tr("复制截止日期")}
          title={tr("复制截止日期")}
        >
          {copiedId === deadline.id ? <Check size={15} /> : <Copy size={15} />}
        </button>
        <button
          className={`ghost-button${confirmDeleteId === deadline.id ? " danger" : ""}`}
          onClick={(e) => {
            e.stopPropagation();
            requestDelete(deadline.id);
          }}
          aria-label={tr("删除截止日期")}
          title={confirmDeleteId === deadline.id ? tr("再次点击确认删除") : tr("删除截止日期")}
        >
          {confirmDeleteId === deadline.id ? <Check size={15} /> : <Trash2 size={15} />}
        </button>
      </div>
    );
  };

  /** 日期瓷片标签：优先「今天/明天/昨天」，否则 Intl 短月份（跟随应用语言）。 */
  const dayLabel = (date: Date, completed: boolean): string => {
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const startOfDue = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
    const diff = Math.round((startOfDue - startOfToday) / 86400000);
    if (completed) return tr("完成");
    if (diff === 0) return tr("今天");
    if (diff === 1) return tr("明天");
    if (diff === -1) return tr("昨天");
    return fmtMonth.format(date);
  };

  return (
    <Panel
      title={tr("DDL 提醒")}
      kicker="DEADLINES"
      className="deadline-panel"
      action={
        overdueCount > 0 ? (
          <span className="deadline-count danger">
            <AlertCircle size={12} />
            {overdueCount} {tr("逾期")}
          </span>
        ) : (
          <span className="deadline-count">
            {deadlines.length} {tr("项")}
          </span>
        )
      }
    >
      <form className="deadline-form" onSubmit={submit}>
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder={tr("事项，可写“周五下午5点”")}
          aria-label={tr("截止事项")}
          data-interactive
        />
        <DateTimePicker value={dueAt} onChange={setDueAt} ariaLabel={tr("截止时间")} />
        {error && (
          <div className="deadline-error" role="alert">
            {error}
          </div>
        )}
        <button type="submit" data-interactive>
          <Plus size={17} />
          {tr("添加")}
        </button>
      </form>
      {/* 周期选择 + 自然语言识别预览。 */}
      <div className="deadline-form-extra">
        <div className="deadline-repeat-chips" role="group" aria-label={tr("重复")}>
          {REPEATS.map((r) => (
            <button
              key={r}
              type="button"
              className={`deadline-repeat-chip${repeat === r ? " on" : ""}`}
              onClick={() => setRepeat(r)}
              data-interactive
            >
              {repeatLabel(r, tr)}
            </button>
          ))}
        </div>
        {natural && (
          <span className="deadline-natural-preview">
            {tr("识别")}：
            <b>{`${natural.date.getMonth() + 1}/${natural.date.getDate()} ${String(natural.date.getHours()).padStart(2, "0")}:${String(natural.date.getMinutes()).padStart(2, "0")}`}</b>
          </span>
        )}
      </div>
      <div className="deadline-groups" ref={groupsRef}>
        {sorted.length === 0 && (
          <div className="empty-state compact">
            <CalendarClock size={22} />
            <strong>{tr("没有逼近的截止日期")}</strong>
            <span>{tr("把重要节点放在这里。")}</span>
          </div>
        )}
        {showGrouping
          ? groups.map((g) => (
              <div className="deadline-group" key={g.key}>
                <div className="deadline-group-label">
                  {g.label}
                  <em>{g.items.length}</em>
                </div>
                {g.items.map(renderDeadline)}
              </div>
            ))
          : sorted.map(renderDeadline)}
      </div>
    </Panel>
  );
}
