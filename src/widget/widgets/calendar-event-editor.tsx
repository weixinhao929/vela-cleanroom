/**
 * 日历事件编辑弹层（从 CalendarWidget 拆出的共享弹层组件）：
 * 文本/起止时间/重复（每天/每周/每月/每月 + 间隔 + 终止日）/地点/备注/颜色/
 * 提醒的增改表单，键盘可达（Esc 关闭、Enter 提交——form 内任意输入框生效）。
 */
import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, Plus, X } from "lucide-react";
import { useT } from "../../i18n-lite";
import { EVENT_COLORS, MAX_REPEAT_EVERY, REMIND_CHOICES, type CalendarEvent } from "./calendar-shared";

const TIME_RE = /^\d{1,2}:\d{2}$/;

export function CalendarEventEditor({
  editing,
  presetTime,
  anchorDate,
  onSave,
  onCancel
}: {
  editing: CalendarEvent | null;
  /** 时间轴空白快速创建的预填时刻（仅添加模式；key 变化触发重挂载生效）。 */
  presetTime?: string;
  /** 锚点日期键（YYYY-MM-DD）：终止日输入的 min 约束。 */
  anchorDate?: string;
  onSave: (draft: CalendarEvent, scope: "series" | "once") => void;
  onCancel: () => void;
}) {
  const tr = useT();
  const [text, setText] = useState(editing?.text ?? "");
  const [time, setTime] = useState(editing?.time ?? presetTime ?? "");
  const [endTime, setEndTime] = useState(editing?.endTime ?? "");
  const [color, setColor] = useState(editing?.color ?? "");
  const [repeat, setRepeat] = useState<CalendarEvent["repeat"]>(editing?.repeat ?? "none");
  const [repeatEvery, setRepeatEvery] = useState(editing?.repeatEvery ?? 1);
  const [repeatUntil, setRepeatUntil] = useState(editing?.repeatUntil ?? "");
  const [remind, setRemind] = useState(editing?.remind ?? 0);
  const [location, setLocation] = useState(editing?.location ?? "");
  const [note, setNote] = useState(editing?.note ?? "");
  /* 编辑重复事件时的修改范围：整个系列（默认）/ 仅此日（系列分裂）。 */
  const [scope, setScope] = useState<"series" | "once">("series");
  const hasAdvanced =
    !!editing &&
    (!!editing.color ||
      editing.repeat !== "none" ||
      editing.remind > 0 ||
      !!editing.location ||
      !!editing.note ||
      !!editing.endTime);
  const [open, setOpen] = useState(hasAdvanced || !!presetTime);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) inputRef.current?.focus();
    else if (presetTime) {
      // 快速创建：预填了时刻，直接聚焦文本框。
      inputRef.current?.focus();
    }
  }, [editing, presetTime]);

  const submit = () => {
    const t = text.trim();
    if (!t) return;
    // 结束时间无效（早于开始/格式坏）时按未设置处理（展示层回退默认时长）。
    // 开始时间为空时结束一并置空——内存态不携带孤儿 endTime（读侧
    // normalizeCalendarEvent 同条件剥离，两头口径一致，重载后表单值不凭空消失）。
    const validEnd =
      TIME_RE.test(endTime) && time && endTime.padStart(5, "0") > time.padStart(5, "0") ? endTime.padStart(5, "0") : "";
    onSave(
      {
        id: editing?.id ?? crypto.randomUUID(),
        text: t,
        time: TIME_RE.test(time) ? time.padStart(5, "0") : "",
        endTime: validEnd,
        color,
        repeat,
        repeatEvery: repeat !== "none" ? Math.min(MAX_REPEAT_EVERY, Math.max(1, Math.floor(repeatEvery) || 1)) : 1,
        repeatUntil: repeat !== "none" && /^\d{4}-\d{2}-\d{2}$/.test(repeatUntil) ? repeatUntil : "",
        // 降为不重复时旧例外/终止日一并清空（脏数据防护）。
        excepted: repeat !== "none" ? (editing?.excepted ?? []) : [],
        remind,
        location: location.trim(),
        note: note.trim()
      },
      scope
    );
    if (!editing) {
      setText("");
      setTime("");
      setEndTime("");
      setColor("");
      setRepeat("none");
      setRepeatEvery(1);
      setRepeatUntil("");
      setRemind(0);
      setLocation("");
      setNote("");
      setOpen(false);
      setScope("series");
    }
  };

  const everyUnit =
    repeat === "daily" ? tr("天") : repeat === "weekly" ? tr("周") : repeat === "monthly" ? tr("月") : tr("年");

  return (
    <div className={`widget-cal-pop-add${editing ? " editing" : ""}`}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
        onKeyDown={(e) => {
          /* 兑现头注承诺的「Esc 关闭」——此前只有 Enter 提交（form
             原生），Esc 是死注释。Escape 在输入框/下拉任意焦点位都收起编辑器。 */
          if (e.key === "Escape") {
            e.preventDefault();
            onCancel();
          }
        }}
      >
        {/* 编辑重复事件：修改范围（整个系列 / 仅此日=系列分裂）。
            去掉 role="radiogroup"（其合法子项是 radio+aria-checked，与
            aria-pressed 切换按钮语义混搭会让读屏报空组）——对齐同批 的
            纯 aria-pressed 分段按钮范式，容器语义由 aria-label 所在的组容器
            补充。 */}
        {editing && editing.repeat !== "none" && (
          <div className="widget-cal-scope-row" aria-label={tr("修改范围")}>
            <button
              type="button"
              className={scope === "series" ? "active" : ""}
              onClick={() => setScope("series")}
              aria-pressed={scope === "series"}
              data-interactive
            >
              {tr("整个系列")}
            </button>
            <button
              type="button"
              className={scope === "once" ? "active" : ""}
              onClick={() => setScope("once")}
              aria-pressed={scope === "once"}
              data-interactive
            >
              {tr("仅此日")}
            </button>
          </div>
        )}
        <div className="widget-cal-pop-add-row">
          <input
            type="time"
            value={time}
            onChange={(e) => setTime(e.target.value)}
            title={tr("开始时间（可选）")}
            data-interactive
          />
          <span className="widget-cal-pop-add-sep">–</span>
          <input
            type="time"
            value={endTime}
            onChange={(e) => setEndTime(e.target.value)}
            title={tr("结束时间（可选）")}
            data-interactive
          />
          <input
            ref={inputRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={editing ? tr("修改事件…") : tr("添加事件…")}
            data-interactive
          />
          <button
            type="button"
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
              <button type="submit" aria-label={tr("保存")} title={tr("保存")} data-interactive>
                <Check size={14} />
              </button>
              <button type="button" onClick={onCancel} aria-label={tr("取消")} title={tr("取消")} data-interactive>
                <X size={14} />
              </button>
            </>
          ) : (
            <button type="submit" aria-label={tr("添加")} data-interactive>
              <Plus size={14} />
            </button>
          )}
        </div>
        {/* 高级区常驻挂载 + grid-rows 折叠；inert 收起时不可聚焦。 */}
        <div className={`widget-cal-pop-adv-wrap${open ? " open" : ""}`} inert={!open}>
          <div className="widget-cal-pop-adv-clip">
            <div className="widget-cal-pop-adv">
              <span className="widget-cal-adv-label">{tr("颜色")}</span>
              <div className="widget-cal-adv-colors">
                {EVENT_COLORS.map((c) => (
                  <button
                    type="button"
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
                {(["none", "daily", "weekly", "monthly", "yearly"] as const).map((r) => (
                  <button
                    type="button"
                    key={r}
                    className={repeat === r ? "active" : ""}
                    onClick={() => setRepeat(r)}
                    data-interactive
                  >
                    {tr(
                      r === "none"
                        ? "不重复"
                        : r === "daily"
                          ? "每天"
                          : r === "weekly"
                            ? "每周"
                            : r === "monthly"
                              ? "每月"
                              : "每年"
                    )}
                  </button>
                ))}
              </div>
              {repeat !== "none" && (
                <div className="widget-cal-adv-repeat-extra">
                  <label className="widget-cal-adv-inline">
                    <span>{tr("每")}</span>
                    <input
                      type="number"
                      min={1}
                      max={MAX_REPEAT_EVERY}
                      value={repeatEvery}
                      onChange={(e) => setRepeatEvery(Number(e.target.value))}
                      data-interactive
                    />
                    <span>{everyUnit}</span>
                  </label>
                  <label className="widget-cal-adv-inline">
                    <span>{tr("直到")}</span>
                    <input
                      type="date"
                      value={repeatUntil}
                      // 终止日不得早于锚点日（否则事件在所有日期静默消失——
                      // 数据层另有读入防护，这里挡住源头）。
                      min={anchorDate}
                      onChange={(e) => setRepeatUntil(e.target.value)}
                      data-interactive
                    />
                    {repeatUntil && (
                      <button type="button" className="widget-cal-adv-clear" onClick={() => setRepeatUntil("")}>
                        <X size={11} />
                      </button>
                    )}
                  </label>
                </div>
              )}
              <span className="widget-cal-adv-label">{tr("提醒")}</span>
              <div className="widget-cal-adv-seg">
                {REMIND_CHOICES.map((m) => (
                  <button
                    type="button"
                    key={m}
                    className={remind === m ? "active" : ""}
                    onClick={() => setRemind(m)}
                    data-interactive
                  >
                    {m === 0 ? tr("无") : tr("{n} 分钟前").replace("{n}", String(m))}
                  </button>
                ))}
              </div>
              <span className="widget-cal-adv-label">{tr("地点")}</span>
              <input
                className="widget-cal-adv-input"
                value={location}
                onChange={(e) => setLocation(e.target.value)}
                placeholder={tr("地点（可选）")}
                data-interactive
              />
              <span className="widget-cal-adv-label">{tr("备注")}</span>
              <input
                className="widget-cal-adv-input"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder={tr("备注（可选）")}
                data-interactive
              />
            </div>
          </div>
        </div>
      </form>
    </div>
  );
}
