import { useEffect, useRef, useState } from "react";
import { emit } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Check, CornerDownLeft } from "lucide-react";
import { loadNotes, pickQuickNoteTarget, saveNotes, type Note } from "./notes-store";
import { useT } from "../i18n-lite";
import { animDurations } from "../lib/durations";

/**
 * 全局速记窗口（Ctrl+Alt+Q 呼出）。
 * 独立小窗口（index.html#quick-note），保存后写入便签数最多的实例，
 * 并通过 Tauri 事件 sync:notes 让桌面上的便签小组件立即刷新。
 */
export function QuickNoteView() {
  const tr = useT();
  const [text, setText] = useState("");
  const [target, setTarget] = useState<string>("");
  const [targetCount, setTargetCount] = useState(0);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  /* 退场：先播 pop-out 再销毁窗口，与命令面板关闭同节奏；
     窗口本体由 Rust visible(false) 创建、main.tsx 首帧握手后显示。 */
  const [closing, setClosing] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    const id = pickQuickNoteTarget();
    setTarget(id);
    setTargetCount(loadNotes(id).length);
    inputRef.current?.focus();
  }, []);

  const close = () => {
    if (closing) return;
    setClosing(true);
    /* 三.1：等待与 CSS quick-note-out（--dur-fx-xfast）同源取值——原注释
       130ms / JS 140ms / CSS 120ms 三数互不一致且不随速度档。+20ms 兜底尾帧。 */
    window.setTimeout(() => {
      void getCurrentWindow().close();
    }, animDurations().fxXfastMs + 20);
  };

  const save = () => {
    const body = text.trim();
    if (!body || saving) return;
    setSaving(true);
    const note: Note = { id: crypto.randomUUID(), text: body, updatedAt: new Date().toISOString() };
    const next = [note, ...loadNotes(target)];
    saveNotes(target, next);
    /* 保存成功反馈（M3）：先播对勾再退场（共 ~300ms），与待办勾选的
       springCheck 同语言——保存与关窗之间没有视觉确认，用户不确定写没写上。
       emit 失败补一次重试（1s 后，退场顺延到重试结束）：数据已落共享
       localStorage，但目标窗口的内存态靠这条事件刷新——静默失败会让桌面
       摘要/列表滞后到下次编辑。重试仍失败则放弃（下次编辑时对账）。 */
    const finish = () => {
      setSaved(true);
      window.setTimeout(close, animDurations().fxMs);
    };
    const attempt = (retried: boolean): Promise<void> =>
      emit("sync:notes", { instanceId: target, notes: next }).then(
        () => finish(),
        () =>
          retried ? finish() : new Promise<void>((resolve) => window.setTimeout(() => resolve(attempt(true)), 1000))
      );
    void attempt(false);
  };

  return (
    <div className={`quick-note${closing ? " is-closing" : ""}`}>
      <div className="quick-note-head">
        <span>{tr("速记")}</span>
        <span className="quick-note-kbd">
          Ctrl+Enter {tr("保存")} · Esc {tr("关闭")}
        </span>
      </div>
      <textarea
        ref={inputRef}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            close();
          } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            save();
          }
        }}
        placeholder={tr("想到什么就记下来…支持 #标签 与 Markdown")}
        rows={5}
        autoFocus
      />
      <div className="quick-note-foot">
        <span className="quick-note-target">
          {tr("将保存到")}{" "}
          {target === "quicknote"
            ? tr("默认便签（添加便签小组件后自动汇入）")
            : `${tr("便签")} · ${targetCount} ${tr("条")}`}
        </span>
        <button onClick={save} disabled={!text.trim() || saving} data-interactive>
          {saved ? <Check size={13} className="quick-note-check" /> : <CornerDownLeft size={12} />}
          {saved ? tr("已保存") : tr("保存")}
        </button>
      </div>
    </div>
  );
}
