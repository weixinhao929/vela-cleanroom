/**
 * 课表导入预览与课程编辑弹层（从 TimetableWidget 拆出的共享弹层组件）。
 * 预览弹层展示解析出的课程/冲突/未识别行；编辑弹层增改单条课程的
 * 名称/教师/地点/周次/节次。
 */
import { useState } from "react";
import { CircleAlert, Trash2 } from "lucide-react";
import { parseWeeksLabel, TT_PALETTE, type TimetableSession } from "../timetable";
import { useT } from "../../i18n-lite";
import { DAY_NAMES, dialogKeyDown, type Preview } from "./timetable-shared";
import { DatePicker } from "../../components/DatePicker";
import { WidgetSelect } from "../../components/WidgetSelect";

/* ------------------------------------------------------------------ */
/* 导入预览：解析结果 + 学期设置，确认后写入                             */
/* ------------------------------------------------------------------ */

export function TimetableImportPreview({
  preview,
  closing,
  onChange,
  onCancel,
  onConfirm
}: {
  preview: Preview;
  closing: boolean;
  onChange: (p: Preview) => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const tr = useT();
  const shown = preview.sessions.slice(0, 60);
  return (
    <div
      className={`tt-preview-overlay${closing ? " closing" : ""}`}
      role="dialog"
      aria-modal="true"
      onKeyDown={(e) => dialogKeyDown(e, onCancel)}
    >
      <div className={`tt-preview${closing ? " closing" : ""}`}>
        <div className="tt-preview-title">
          {tr("解析结果")} · {preview.mode === "grid" ? tr("网格式") : tr("清单式")}
          <span className="tt-preview-count">
            {preview.sessions.length} {tr("条上课记录")}
          </span>
        </div>
        <div className="tt-preview-form">
          <label className="tt-field">
            <span>{tr("第一周周一")}</span>
            <DatePicker
              value={preview.semesterStart ?? ""}
              onChange={(v) => onChange({ ...preview, semesterStart: v })}
              ariaLabel={tr("第一周周一")}
              /* 初始焦点落进弹层：容器 onKeyDown 的 Esc 关闭只有焦点在内才收得到，
                 与课程编辑弹层（首字段 autoFocus）一致。 */
              autoFocus
            />
          </label>
          <label className="tt-field">
            <span>{tr("总周数")}</span>
            <input
              type="number"
              min={1}
              max={60}
              value={preview.totalWeeks}
              onChange={(e) =>
                onChange({ ...preview, totalWeeks: Math.max(1, Math.min(60, Number(e.target.value) || 1)) })
              }
              data-interactive
            />
          </label>
        </div>
        <div className="tt-preview-table">
          <div className="tt-preview-row head">
            <span>{tr("课程")}</span>
            <span>{tr("星期")}</span>
            <span>{tr("节次")}</span>
            <span>{tr("周次")}</span>
            <span>{tr("地点")}</span>
          </div>
          <div className="tt-preview-scroll">
            {shown.map((s) => (
              <div className="tt-preview-row" key={s.id}>
                <span title={s.rawName || s.name}>{s.name}</span>
                <span>{tr(`星期${DAY_NAMES[s.day - 1]}`)}</span>
                <span>{s.startSection === s.endSection ? s.startSection : `${s.startSection}-${s.endSection}`}</span>
                <span>{s.weeksLabel || tr("全程")}</span>
                <span>{s.location || "—"}</span>
              </div>
            ))}
            {preview.sessions.length > shown.length && (
              <div className="tt-preview-more">
                还有 {preview.sessions.length - shown.length} {tr("条未展示")}
              </div>
            )}
          </div>
        </div>
        <div className="tt-preview-actions">
          <button className="tt-preview-cancel" onClick={onCancel} data-interactive>
            {tr("取消")}
          </button>
          <button className="tt-preview-ok" onClick={onConfirm} data-interactive>
            {tr("确认导入")}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 课程编辑弹层：手动新增 / 编辑单门课                                  */
/* ------------------------------------------------------------------ */

export function TimetableSessionEditor({
  session,
  confirmDelete,
  closing,
  onSave,
  onDelete,
  onCancel
}: {
  session: TimetableSession | null;
  confirmDelete: boolean;
  closing: boolean;
  onSave: (draft: Omit<TimetableSession, "id">) => void | Promise<void>;
  onDelete: () => void;
  onCancel: () => void;
}) {
  const tr = useT();
  const [name, setName] = useState(session?.name ?? "");
  const [day, setDay] = useState(session?.day ?? 1);
  const [startSection, setStartSection] = useState(session?.startSection ?? 1);
  const [endSection, setEndSection] = useState(session?.endSection ?? 2);
  const [weeksText, setWeeksText] = useState(session?.weeksLabel ?? "");
  const [location, setLocation] = useState(session?.location ?? "");
  const [teacher, setTeacher] = useState(session?.teacher ?? "");
  /* W-020 颜色自定义：空 = 按课程名自动配色。 */
  const [color, setColor] = useState(session?.colorOverride ?? "");
  const [error, setError] = useState("");

  const save = () => {
    const n = name.trim();
    if (!n) {
      setError(tr("请输入课程名称"));
      return;
    }
    if (endSection < startSection) {
      setError(tr("结束节次不能小于开始节次"));
      return;
    }
    const weeks = parseWeeksLabel(weeksText);
    void onSave({
      name: n,
      rawName: n,
      day,
      startSection: Math.max(1, Math.min(30, startSection)),
      endSection: Math.max(startSection, Math.min(30, endSection)),
      weeks,
      weeksLabel: weeksText.trim(),
      location: location.trim(),
      teacher: teacher.trim(),
      colorOverride: color || undefined
    });
  };

  const isNew = !session;
  return (
    <div
      className={`tt-preview-overlay${closing ? " closing" : ""}`}
      role="dialog"
      aria-modal="true"
      onKeyDown={(e) => dialogKeyDown(e, onCancel)}
    >
      <div className={`tt-preview tt-session-editor${closing ? " closing" : ""}`}>
        <div className="tt-preview-title">{isNew ? tr("新建课程") : tr("编辑课程")}</div>
        <div className="tt-session-form">
          <label className="tt-field" style={{ flex: "1 1 100%" }}>
            <span>{tr("课程名称")}</span>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={tr("请输入课程名称")}
              autoFocus
              data-interactive
            />
          </label>
          <label className="tt-field">
            <span>{tr("星期")}</span>
            <WidgetSelect
              value={String(day)}
              onChange={(v) => setDay(Number(v))}
              options={DAY_NAMES.map((d, i) => ({ value: String(i + 1), label: tr(`星期${d}`) }))}
              ariaLabel={tr("星期")}
              align="left"
            />
          </label>
          <label className="tt-field">
            <span>{tr("开始节次")}</span>
            <input
              type="number"
              min={1}
              max={30}
              value={startSection}
              onChange={(e) => setStartSection(Number(e.target.value) || 1)}
              data-interactive
            />
          </label>
          <label className="tt-field">
            <span>{tr("结束节次")}</span>
            <input
              type="number"
              min={1}
              max={30}
              value={endSection}
              onChange={(e) => setEndSection(Number(e.target.value) || 1)}
              data-interactive
            />
          </label>
          <label className="tt-field" style={{ flex: "1 1 100%" }}>
            <span>{tr("周次（如 1-16 或 1-8,10-16周）")}</span>
            <input
              type="text"
              value={weeksText}
              placeholder="1-16"
              onChange={(e) => setWeeksText(e.target.value)}
              data-interactive
            />
          </label>
          <label className="tt-field" style={{ flex: "1 1 100%" }}>
            <span>{tr("地点")}</span>
            <input type="text" value={location} onChange={(e) => setLocation(e.target.value)} data-interactive />
          </label>
          <label className="tt-field" style={{ flex: "1 1 100%" }}>
            <span>{tr("教师")}</span>
            <input type="text" value={teacher} onChange={(e) => setTeacher(e.target.value)} data-interactive />
          </label>
          <div className="tt-field" style={{ flex: "1 1 100%" }}>
            <span>{tr("颜色")}</span>
            <div className="tt-color-palette">
              <button
                className={`tt-color-dot auto${color === "" ? " active" : ""}`}
                onClick={() => setColor("")}
                title={tr("自动（按课程名）")}
                data-interactive
              />
              {TT_PALETTE.map(([c1]) => (
                <button
                  key={c1}
                  className={`tt-color-dot${color === c1 ? " active" : ""}`}
                  style={{ background: c1 }}
                  onClick={() => setColor(c1)}
                  data-interactive
                />
              ))}
            </div>
          </div>
        </div>
        {error && (
          <div className="tt-error">
            <CircleAlert size={12} /> {error}
          </div>
        )}
        <div className="tt-preview-actions tt-session-actions">
          <div style={{ flex: 1, display: "flex", gap: 8 }}>
            {!isNew && (
              <button
                className={`tt-preview-cancel${confirmDelete ? " danger" : ""}`}
                onClick={onDelete}
                data-interactive
                title={confirmDelete ? tr("再次点击确认删除") : tr("删除课程")}
              >
                <Trash2 size={13} /> {confirmDelete ? tr("再次点击确认删除") : tr("删除课程")}
              </button>
            )}
          </div>
          <button className="tt-preview-cancel" onClick={onCancel} data-interactive>
            {tr("取消")}
          </button>
          <button className="tt-preview-ok" onClick={save} data-interactive>
            {tr("保存课程")}
          </button>
        </div>
      </div>
    </div>
  );
}
