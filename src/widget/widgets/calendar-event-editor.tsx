/**
 * 日历事件编辑弹层（从 CalendarWidget 拆出的共享弹层组件）：
 * 文本/时间/重复规则的增改表单，键盘可达（Esc 关闭、Enter 提交）。
 */
import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, Plus, X } from "lucide-react";
import { useT } from "../../i18n-lite";
import { EVENT_COLORS, REMIND_CHOICES, type CalendarEvent } from "./calendar-shared";

/* ------------------------------------------------------------------ */
/* W-013/014 事件编辑行：添加 / 编辑共用                                */
/* ------------------------------------------------------------------ */

export function CalendarEventEditor({
  editing,
  onSave,
  onCancel
}: {
  editing: CalendarEvent | null;
  onSave: (draft: CalendarEvent) => void;
  onCancel: () => void;
}) {
  const tr = useT();
  const [text, setText] = useState(editing?.text ?? "");
  const [time, setTime] = useState(editing?.time ?? "");
  const [color, setColor] = useState(editing?.color ?? "");
  const [repeat, setRepeat] = useState<CalendarEvent["repeat"]>(editing?.repeat ?? "none");
  const [remind, setRemind] = useState(editing?.remind ?? 0);
  const hasAdvanced = !!editing && (!!editing.color || editing.repeat !== "none" || editing.remind > 0);
  const [open, setOpen] = useState(hasAdvanced);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  const submit = () => {
    const t = text.trim();
    if (!t) return;
    onSave({
      id: editing?.id ?? crypto.randomUUID(),
      text: t,
      time: /^\d{1,2}:\d{2}$/.test(time) ? time : "",
      color,
      repeat,
      remind
    });
    if (!editing) {
      setText("");
      setTime("");
      setColor("");
      setRepeat("none");
      setRemind(0);
      setOpen(false);
    }
  };

  return (
    <div className={`widget-cal-pop-add${editing ? " editing" : ""}`}>
      <div className="widget-cal-pop-add-row">
        <input
          type="time"
          value={time}
          onChange={(e) => setTime(e.target.value)}
          title={tr("时间（可选）")}
          data-interactive
        />
        <input
          ref={inputRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
          placeholder={editing ? tr("修改事件…") : tr("添加事件…")}
          data-interactive
        />
        <button
          className="widget-cal-adv-toggle"
          onClick={() => setOpen((v) => !v)}
          aria-label={tr("更多选项")}
          title={tr("更多选项")}
          data-interactive
        >
          <ChevronDown size={13} className={open ? "open" : ""} />
        </button>
        {editing ? (
          <>
            <button onClick={submit} aria-label={tr("保存")} title={tr("保存")} data-interactive>
              <Check size={14} />
            </button>
            <button onClick={onCancel} aria-label={tr("取消")} title={tr("取消")} data-interactive>
              <X size={14} />
            </button>
          </>
        ) : (
          <button onClick={submit} aria-label={tr("添加")} data-interactive>
            <Plus size={14} />
          </button>
        )}
      </div>
      {/* 高级区常驻挂载 + grid-rows 折叠（样式此前完全缺失，见 feature-calendar.css）；inert 收起时不可聚焦。 */}
      <div className={`widget-cal-pop-adv-wrap${open ? " open" : ""}`} inert={!open}>
        <div className="widget-cal-pop-adv-clip">
          <div className="widget-cal-pop-adv">
            <span className="widget-cal-adv-label">{tr("颜色")}</span>
            <div className="widget-cal-adv-colors">
              {EVENT_COLORS.map((c) => (
                <button
                  key={c || "auto"}
                  className={color === c ? "active" : ""}
                  style={c ? { background: c } : undefined}
                  onClick={() => setColor(c)}
                  aria-label={c || tr("默认")}
                  data-interactive
                />
              ))}
            </div>
            <span className="widget-cal-adv-label">{tr("重复")}</span>
            <div className="widget-cal-adv-seg">
              {(["none", "weekly", "monthly", "yearly"] as const).map((r) => (
                <button key={r} className={repeat === r ? "active" : ""} onClick={() => setRepeat(r)} data-interactive>
                  {tr(r === "none" ? "不重复" : r === "weekly" ? "每周" : r === "monthly" ? "每月" : "每年")}
                </button>
              ))}
            </div>
            <span className="widget-cal-adv-label">{tr("提醒")}</span>
            <div className="widget-cal-adv-seg">
              {REMIND_CHOICES.map((m) => (
                <button key={m} className={remind === m ? "active" : ""} onClick={() => setRemind(m)} data-interactive>
                  {m === 0 ? tr("无") : tr("{n} 分钟前").replace("{n}", String(m))}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
