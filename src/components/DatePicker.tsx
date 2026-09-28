/**
 * 简约日历选择器（全应用统一）：替换原生 type=date / datetime-local 的系统日历。
 *
 * - DatePicker：纯日期（YYYY-MM-DD，空串 = 未选）；弹层 = 月份翻页 + 周一为首列的
 *   日网格，今天描边、选中实底，底部「清除 / 今天」。Esc / 外点关闭。
 * - DateTimePicker：日期 + 时间组合（datetime-local 的 YYYY-MM-DDTHH:mm 形），
 *   弹层底部内嵌时间输入；只选日期不选时间时值退化为纯日期（Date 解析兼容）。
 *
 * 样式在 styles/date-picker.css（独立文件而非 settings.css：桌面层窗口不加载
 * settings.css，本组件要供 DDL / 倒计时等桌面小组件共用）。
 */
import { useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { CalendarDays, ChevronLeft, ChevronRight } from "lucide-react";
import { useT } from "../i18n-lite";
import { useDelayedUnmount } from "../lib/anim";
import { animDurations } from "../lib/durations";
import { useDismissable } from "../lib/use-dismissable";
import "../styles/date-picker.css";

const DP_WEEKDAYS = ["一", "二", "三", "四", "五", "六", "日"];
/** 表头单字 → i18n 键（周一…周日，与 CalendarWidget 表头同源）；英文界面显示 Mon…Sun。 */
const DP_WEEKDAY_KEY: Record<string, string> = {
  一: "周一",
  二: "周二",
  三: "周三",
  四: "周四",
  五: "周五",
  六: "周六",
  日: "周日"
};

/** (y, m) 月首周一序（0=周一）与该月天数，返回 6×7 日网格的 42 个 {iso, day, inMonth}。 */
function dpGrid(year: number, month: number): { iso: string; day: number; inMonth: boolean }[] {
  const first = new Date(year, month, 1);
  const lead = (first.getDay() + 6) % 7; // 周一为首列
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const cells: { iso: string; day: number; inMonth: boolean }[] = [];
  const iso = (y: number, m: number, d: number) =>
    `${y}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  for (let i = 0; i < 42; i++) {
    const raw = new Date(year, month, 1 - lead + i);
    cells.push({
      iso: iso(raw.getFullYear(), raw.getMonth(), raw.getDate()),
      day: raw.getDate(),
      inMonth: i >= lead && i < lead + daysInMonth
    });
  }
  return cells;
}

function todayIso(): string {
  const t = new Date();
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`;
}

/** iso 日期 ±delta 天（跨月/跨年由 Date 进位自然处理）。 */
function isoShift(iso: string, delta: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const t = new Date(y, (m ?? 1) - 1, d ?? 1);
  t.setDate(t.getDate() + delta);
  const mm = String(t.getMonth() + 1).padStart(2, "0");
  const dd = String(t.getDate()).padStart(2, "0");
  return t.getFullYear() + "-" + mm + "-" + dd;
}

/** iso 日期 ±dir 个月，日号钳到目标月天数（1/31 翻下月不滚成 3 月初）。 */
function isoShiftMonth(iso: string, dir: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const yy = y ?? 2020;
  const mm0 = m ?? 1;
  const ny = dir < 0 && mm0 === 1 ? yy - 1 : dir > 0 && mm0 === 12 ? yy + 1 : yy;
  const nm = dir < 0 && mm0 === 1 ? 12 : dir > 0 && mm0 === 12 ? 1 : mm0 + dir;
  const dim = new Date(ny, nm, 0).getDate();
  const dd = String(Math.min(d ?? 1, dim)).padStart(2, "0");
  return ny + "-" + String(nm).padStart(2, "0") + "-" + dd;
}

function parseIso(value: string): { y: number; m: number } | null {
  const parsed = value.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return parsed ? { y: Number(parsed[1]), m: Number(parsed[2]) - 1 } : null;
}

/** 弹层骨架：头部翻月 + 周行 + 日网格 +（可选）时间行 + 底部动作。 */
function CalendarPopover({
  value,
  withTime,
  timeValue,
  onTimeChange,
  onPick,
  onClear,
  closing
}: {
  value: string;
  withTime?: boolean;
  timeValue?: string;
  onTimeChange?: (t: string) => void;
  onPick: (iso: string) => void;
  onClear: () => void;
  /** 退场中（useDelayedUnmount 关闭窗口）：播 tm-dp-out 后由父级卸载。 */
  closing?: boolean;
}) {
  const tr = useT();
  const [view, setView] = useState(() => parseIso(value) ?? { y: new Date().getFullYear(), m: new Date().getMonth() });
  // 翻月方向（-1 上月 / 1 下月）：日网格按「年-月」重挂并带方向性滑入。
  const [flipDir, setFlipDir] = useState(0);
  /* roving tabindex：整个日网格只占一个 Tab 停靠点（此前 ~30 个本月日全进
     Tab 序，键盘选日期要按 30+ 次 Tab）。方向键 ±1 天 / ±7 天，PageUp/Down
     翻月，Home/End 月首/月尾；焦点日越出视图月时翻月跟随。 */
  const gridRef = useRef<HTMLDivElement>(null);
  const [focusIso, setFocusIso] = useState<string | null>(null);
  useLayoutEffect(() => {
    if (!focusIso) return;
    gridRef.current?.querySelector<HTMLButtonElement>('button[data-iso="' + focusIso + '"]')?.focus();
  }, [focusIso, view]);
  const cells = dpGrid(view.y, view.m);
  const focusTarget = focusIso ?? (value || cells.find((c) => c.inMonth)?.iso) ?? null;
  const moveFocus = (nextIso: string) => {
    const target = parseIso(nextIso);
    if (target && (target.y !== view.y || target.m !== view.m)) {
      setFlipDir(target.y > view.y || (target.y === view.y && target.m > view.m) ? 1 : -1);
      setView({ y: target.y, m: target.m });
    }
    setFocusIso(nextIso);
  };
  const onGridKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const btn = e.target as HTMLElement;
    const iso = btn instanceof HTMLButtonElement ? btn.dataset.iso : undefined;
    if (!iso) return;
    const step: Record<string, number> = { ArrowRight: 1, ArrowLeft: -1, ArrowUp: -7, ArrowDown: 7 };
    if (e.key in step) {
      e.preventDefault();
      moveFocus(isoShift(iso, step[e.key]));
    } else if (e.key === "PageUp" || e.key === "PageDown") {
      e.preventDefault();
      moveFocus(isoShiftMonth(iso, e.key === "PageUp" ? -1 : 1));
    } else if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      const inMonth = cells.filter((c) => c.inMonth);
      const target = e.key === "Home" ? inMonth[0] : inMonth[inMonth.length - 1];
      if (target) moveFocus(target.iso);
    }
  };
  // 每次打开都把视图对准当前值（或今天）；open 切换由父级 key 重挂触发。
  useLayoutEffect(() => {
    setView(parseIso(value) ?? { y: new Date().getFullYear(), m: new Date().getMonth() });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div
      className={`tm-dp-pop${closing ? " is-closing" : ""}`}
      role="dialog"
      aria-label={tr("选择日期")}
      data-interactive
    >
      <div className="tm-dp-head">
        <button
          type="button"
          className="tm-dp-nav"
          aria-label={tr("上个月")}
          onClick={() => {
            setFlipDir(-1);
            setView((v) => (v.m === 0 ? { y: v.y - 1, m: 11 } : { y: v.y, m: v.m - 1 }));
          }}
        >
          <ChevronLeft size={14} />
        </button>
        <span className="tm-dp-month">
          {view.y} {tr("年")} {view.m + 1} {tr("月")}
        </span>
        <button
          type="button"
          className="tm-dp-nav"
          aria-label={tr("下个月")}
          onClick={() => {
            setFlipDir(1);
            setView((v) => (v.m === 11 ? { y: v.y + 1, m: 0 } : { y: v.y, m: v.m + 1 }));
          }}
        >
          <ChevronRight size={14} />
        </button>
      </div>
      <div className="tm-dp-week" aria-hidden="true">
        {DP_WEEKDAYS.map((d) => (
          <span key={d}>{tr(DP_WEEKDAY_KEY[d])}</span>
        ))}
      </div>
      <div
        className="tm-dp-grid"
        key={`${view.y}-${view.m}`}
        data-dir={flipDir || undefined}
        ref={gridRef}
        onKeyDown={onGridKeyDown}
      >
        {cells.map((c, i) => (
          <button
            key={`${c.iso}-${i}`}
            type="button"
            className={`tm-dp-day${c.inMonth ? "" : " is-out"}${c.iso === value ? " is-selected" : ""}${c.iso === todayIso() ? " is-today" : ""}`}
            data-iso={c.iso}
            tabIndex={c.iso === focusTarget ? 0 : -1}
            aria-selected={c.iso === value}
            onClick={() => onPick(c.iso)}
          >
            {c.day}
          </button>
        ))}
      </div>
      {withTime && (
        <div className="tm-dp-time">
          <ClockLabel />
          <input
            type="time"
            className="tm-dtp-time"
            value={timeValue ?? ""}
            onChange={(e) => onTimeChange?.(e.target.value)}
            aria-label={tr("时间")}
            data-interactive
          />
        </div>
      )}
      <div className="tm-dp-foot">
        <button type="button" className="tm-dp-act" onClick={onClear}>
          {tr("清除")}
        </button>
        <button type="button" className="tm-dp-act" onClick={() => onPick(todayIso())}>
          {tr("今天")}
        </button>
      </div>
    </div>
  );
}

function ClockLabel() {
  const tr = useT();
  return <span className="tm-dp-time-label">{tr("时间")}</span>;
}

/** 打开状态 + 外点 / Esc 关闭 + 触发按钮的公共骨架。 */
function usePickerShell() {
  const tr = useT();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  /* 统一关闭骨架：外点（pointerdown capture）+ Esc（capture 抢先，嵌套弹层
     只关一层）+ 关闭归还焦点到触发按钮（此前焦点跌落 body）。 */
  useDismissable(open, wrapRef, () => setOpen(false), { restoreFocus: true });
  // 渲染函数（非组件）：hook 内定义的组件每轮渲染都是新类型，<Field/> 会
  // 整树重挂——DateTimePicker 的父级在时间输入每键后重渲染，autoFocus 会把
  // 焦点从时间输入框抢走。按函数调用返回元素则不产生组件边界。
  const renderField = ({
    display,
    placeholder,
    ariaLabel,
    autoFocus
  }: {
    display: string;
    placeholder: string;
    ariaLabel?: string;
    autoFocus?: boolean;
  }) => (
    <button
      type="button"
      className={`tm-dp-field${open ? " is-open" : ""}`}
      data-interactive
      aria-label={ariaLabel}
      aria-haspopup="dialog"
      aria-expanded={open}
      autoFocus={autoFocus}
      onClick={() => setOpen((v) => !v)}
    >
      <span className={display ? "" : "is-placeholder"}>{display || placeholder}</span>
      <CalendarDays size={14} />
    </button>
  );
  return { tr, open, setOpen, wrapRef, renderField };
}

/** 纯日期选择。value 形如 YYYY-MM-DD（空串 = 未选）。 */
export function DatePicker({
  value,
  onChange,
  ariaLabel,
  autoFocus
}: {
  value: string;
  onChange: (v: string) => void;
  ariaLabel?: string;
  autoFocus?: boolean;
}) {
  const tr = useT();
  const { open, setOpen, wrapRef, renderField } = usePickerShell();
  // 退场窗口（120ms 档）保持挂载播 tm-dp-out，播完卸载（F-9 弹层退场档）。
  const renderPop = useDelayedUnmount(open, animDurations().fxXfastMs);
  return (
    <div className="tm-dp" ref={wrapRef}>
      {renderField({ display: value, placeholder: tr("选择日期"), ariaLabel, autoFocus })}
      {renderPop && (
        <CalendarPopover
          key={String(open)}
          closing={!open}
          value={value}
          onPick={(iso) => {
            onChange(iso);
            setOpen(false);
          }}
          onClear={() => {
            onChange("");
            setOpen(false);
          }}
        />
      )}
    </div>
  );
}

/**
 * 日期 + 时间选择（datetime-local 兼容）：value 形如 YYYY-MM-DDTHH:mm；
 * 只选了日期未选时间时值为纯日期（new Date() 可解析），两者皆空 = 空串。
 */
export function DateTimePicker({
  value,
  onChange,
  ariaLabel,
  autoFocus
}: {
  value: string;
  onChange: (v: string) => void;
  ariaLabel?: string;
  autoFocus?: boolean;
}) {
  const tr = useT();
  const { open, setOpen, wrapRef, renderField } = usePickerShell();
  // 退场窗口（120ms 档）保持挂载播 tm-dp-out，播完卸载——与上方 DatePicker
  // 同范式（此前裸 {open && ...} 条件渲染，关闭瞬消无退场）。
  const renderPop = useDelayedUnmount(open, animDurations().fxXfastMs);
  const datePart = value.slice(0, 10);
  const timePart = value.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/)?.[2] ?? "";
  const commit = (date: string, time: string) => onChange(date && time ? `${date}T${time}` : date);
  return (
    <div className="tm-dp" ref={wrapRef}>
      {renderField({
        display: value ? value.replace("T", " ") : "",
        placeholder: tr("选择时间"),
        ariaLabel,
        autoFocus
      })}
      {renderPop && (
        <CalendarPopover
          key={String(open)}
          closing={!open}
          value={datePart}
          withTime
          timeValue={timePart}
          onTimeChange={(t) => commit(datePart || todayIso(), t)}
          onPick={(iso) => commit(iso, timePart)}
          onClear={() => {
            onChange("");
            setOpen(false);
          }}
        />
      )}
    </div>
  );
}
