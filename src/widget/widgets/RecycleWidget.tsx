/**
 * 回收站小组件：聚合小组件回收站与便签回收站（8s 低频扫描，未变保引用），
 * 支持单条/批量恢复、彻底删除与一键清空（两段式确认），保留期可配。
 */
import { useEffect, useMemo, useState } from "react";
import { Check, ExternalLink, RotateCcw, Search, StickyNote, Trash2, X } from "lucide-react";
import { invoke, isTauri } from "../../lib/tauri";
import { useT } from "../../i18n-lite";
import { useSafeTimeout } from "../../lib/use-safe-timeout";
import { getWidgetMeta } from "../registry";
import { useWidgetStore } from "../widget-store";
import { useSettingsStore } from "../../store/settings-store";
import { emptyTrash, listAllNotesTrash, purgeTrash, restoreFromTrash, type TrashNoteRef } from "../notes-store";

/** E3（i18n）：相对时间此前硬编码中文，英文界面下仍是「X 分钟前」。 */
function timeAgo(iso: string, tr: (s: string) => string): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "";
  const diff = Date.now() - then;
  const min = Math.floor(diff / 60000);
  if (min < 1) return tr("刚刚");
  if (min < 60) return tr(`${min} 分钟前`);
  const h = Math.floor(min / 60);
  if (h < 24) return tr(`${h} 小时前`);
  const d = Math.floor(h / 24);
  return tr(`${d} 天前`);
}

/** W-092/W-093：距自动清除还剩几天（0 = 今天到期）。 */
function daysLeft(iso: string, retentionDays: number): number {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return retentionDays;
  const expire = then + retentionDays * 24 * 60 * 60 * 1000;
  return Math.max(0, Math.ceil((expire - Date.now()) / (24 * 60 * 60 * 1000)));
}

/**
 * F1 回收站：展示已删除（移入回收站）的小组件，支持单条/批量恢复、彻底
 * 删除与一键清空（两段式确认）。读取 widget-store 的 trash（保留期可配）。
 * W-092 显示原尺寸与所在视图；W-095 搜索与类型筛选；W-096 聚合便签回收站；
 * W-097 一键打开系统回收站。
 */
export function RecycleWidget() {
  const tr = useT();
  const safeTimeout = useSafeTimeout();
  const trash = useWidgetStore((s) => s.trash);
  const views = useWidgetStore((s) => s.views);
  const restoreWidget = useWidgetStore((s) => s.restoreWidget);
  const purgeWidget = useWidgetStore((s) => s.purgeWidget);
  const emptyWidgetTrash = useWidgetStore((s) => s.emptyWidgetTrash);
  const retentionDays = useSettingsStore((s) => s.extra.recycleRetentionDays) || 30;
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [confirmEmpty, setConfirmEmpty] = useState(false);
  /* W-095 搜索 + 类型筛选。 */
  const [query, setQuery] = useState("");
  const [typeFilter, setTypeFilter] = useState<string>("all");
  /* W-094 批量恢复：多选集合。 */
  const [checked, setChecked] = useState<Set<string>>(new Set());
  /* W-096 便签回收站聚合（低频轮询：便签组件在其它窗口删除时保持同步）。 */
  const [noteTrash, setNoteTrash] = useState<TrashNoteRef[]>(() => listAllNotesTrash());
  useEffect(() => {
    /* P-perf：隐藏页跳过扫描；结果未变时保持旧引用，避免每 8s 一次
       无意义重渲（listAllNotesTrash 每次全量扫 localStorage + JSON.parse）。 */
    const t = window.setInterval(() => {
      if (document.hidden) return;
      const next = listAllNotesTrash();
      setNoteTrash((prev) =>
        prev.length === next.length &&
        prev.every((p, i) => p.instanceId === next[i].instanceId && p.note.id === next[i].note.id)
          ? prev
          : next
      );
    }, 8000);
    return () => window.clearInterval(t);
  }, []);
  /* 行退场（#40）：恢复/彻底删除先播 200ms 滑出再真正执行，避免行瞬失。 */
  const [removingIds, setRemovingIds] = useState<Set<string>>(new Set());
  const removeRow = (id: string, fn: () => void) => {
    if (removingIds.has(id)) return;
    setRemovingIds((s) => new Set(s).add(id));
    safeTimeout(() => {
      fn();
      setRemovingIds((s) => {
        const n = new Set(s);
        n.delete(id);
        return n;
      });
    }, 200);
  };
  // 每 60s 刷新一次相对时间显示。
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = window.setInterval(() => setTick((v) => v + 1), 60000);
    return () => window.clearInterval(t);
  }, []);
  // 空态或单条操作后重置确认态，避免残留。
  useEffect(() => {
    if (confirmId && !trash.some((t) => t.id === confirmId)) setConfirmId(null);
  }, [trash, confirmId]);
  // 已恢复/删除的条目退出多选集合。
  useEffect(() => {
    setChecked((prev) => {
      const next = new Set([...prev].filter((id) => trash.some((t) => t.id === id)));
      return next.size === prev.size ? prev : next;
    });
  }, [trash]);

  const viewName = (id: string) => views.find((v) => v.id === id)?.name ?? id;

  /** W-095 可选类型 chips：回收站里实际出现过的组件类型。 */
  const typeChips = useMemo(() => {
    const metas = trash.map((t) => ({ type: t.type, name: getWidgetMeta(t.type)?.name ?? t.type }));
    const uniq = new Map(metas.map((m) => [m.type, m.name]));
    return [...uniq.entries()].map(([type, name]) => ({ type, name }));
  }, [trash]);

  const q = query.trim().toLowerCase();
  const visible = trash.filter((t) => {
    if (typeFilter !== "all" && t.type !== typeFilter) return false;
    if (!q) return true;
    const meta = getWidgetMeta(t.type);
    const name = meta ? tr(meta.name) : t.type;
    return name.toLowerCase().includes(q) || viewName(t.view).toLowerCase().includes(q);
  });

  const restoreChecked = () => {
    for (const id of checked) removeRow(id, () => restoreWidget(id));
    setChecked(new Set());
  };

  const openSystemBin = () => {
    if (!isTauri()) return;
    void invoke("open_system_location", { kind: "recycle" }).catch(() => {});
  };

  const total = trash.length + noteTrash.length;
  if (total === 0) {
    return (
      <div className="recycle-empty">
        <Trash2 size={26} />
        <span>{tr("回收站为空")}</span>
        {isTauri() && (
          <button
            className="recycle-sys-btn"
            onClick={openSystemBin}
            title={tr("打开系统回收站")}
            aria-label={tr("打开系统回收站")}
            data-interactive
          >
            <ExternalLink size={12} /> {tr("系统回收站")}
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="recycle">
      <div className="recycle-head">
        <span className="recycle-title">{tr("回收站")}</span>
        <span className="recycle-count" key={total}>
          {total}
        </span>
        {isTauri() && (
          <button
            className="recycle-sys-btn"
            onClick={openSystemBin}
            title={tr("打开系统回收站")}
            aria-label={tr("打开系统回收站")}
            data-interactive
          >
            <ExternalLink size={12} />
          </button>
        )}
        {/* #71 同一按钮切换内容：色彩过渡 morph + 图标/文案淡切，不再双按钮瞬时变形 */}
        <button
          className={`recycle-empty-btn${confirmEmpty ? " danger" : ""}`}
          onClick={() => {
            if (confirmEmpty) {
              emptyWidgetTrash();
              // 便签回收站一并清空：头部计数 total 计入了 noteTrash，「清空」
              // 此前只清组件项，计数不归零、便签条目原样保留。
              for (const { instanceId } of listAllNotesTrash()) emptyTrash(instanceId);
              setNoteTrash([]);
              setConfirmEmpty(false);
            } else {
              setConfirmEmpty(true);
            }
          }}
          onMouseLeave={() => setConfirmEmpty(false)}
          /* 键盘对称回退：焦点移出/超时也退出确认态（此前仅 mouseLeave）。 */
          onBlur={() => setConfirmEmpty(false)}
          title={tr("清空回收站")}
          data-interactive
        >
          <span className="btn-ico" key={confirmEmpty ? "c" : "n"}>
            {confirmEmpty ? <Check size={13} /> : <Trash2 size={13} />}
          </span>
          <span className="recycle-empty-label" key={confirmEmpty ? "t-c" : "t-n"}>
            {confirmEmpty ? tr("确定清空？") : tr("清空")}
          </span>
        </button>
      </div>

      {/* W-095 搜索 + 类型筛选；W-094 批量恢复。 */}
      {(trash.length > 4 || typeChips.length > 1 || checked.size > 0) && (
        <div className="recycle-tools">
          <div className="recycle-filter">
            <Search size={12} />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={tr("搜索已删组件…")}
              data-interactive
            />
          </div>
          {checked.size > 0 && (
            <button className="recycle-batch-btn" onClick={restoreChecked} data-interactive>
              <RotateCcw size={12} /> {tr("恢复所选")} ({checked.size})
            </button>
          )}
        </div>
      )}
      {typeChips.length > 1 && (
        <div className="recycle-chips">
          <button
            className={`recycle-chip${typeFilter === "all" ? " active" : ""}`}
            onClick={() => setTypeFilter("all")}
            data-interactive
          >
            {tr("全部")}
          </button>
          {typeChips.map((c) => (
            <button
              className={`recycle-chip${typeFilter === c.type ? " active" : ""}`}
              key={c.type}
              onClick={() => setTypeFilter(c.type)}
              data-interactive
            >
              {tr(c.name)}
            </button>
          ))}
        </div>
      )}

      <div className="recycle-list scroll-fade-y">
        {visible.map((t, ri) => {
          const meta = getWidgetMeta(t.type);
          const name = meta ? tr(meta.name) : t.type;
          const isChecked = checked.has(t.id);
          return (
            <div
              className={`recycle-row${removingIds.has(t.id) ? " is-closing" : ""}`}
              key={t.id}
              style={{ "--sti": ri } as React.CSSProperties}
            >
              <button
                className={`recycle-check${isChecked ? " on" : ""}`}
                onClick={() =>
                  setChecked((prev) => {
                    const next = new Set(prev);
                    if (next.has(t.id)) next.delete(t.id);
                    else next.add(t.id);
                    return next;
                  })
                }
                aria-label={tr("选择")}
                data-interactive
              >
                {isChecked && <Check size={11} />}
              </button>
              <span className="recycle-row-icon">{meta ? <meta.icon size={15} /> : <Trash2 size={15} />}</span>
              <div className="recycle-row-main">
                <span className="recycle-row-name">{name}</span>
                {/* W-092 删除信息增强：原尺寸 · 所在视图 · 剩余保留天数。 */}
                <span className="recycle-row-time">
                  {t.w}×{t.h} · {viewName(t.view)} · {timeAgo(t.deletedAt, tr)} · {daysLeft(t.deletedAt, retentionDays)}
                  {tr(" 天后清除")}
                </span>
              </div>
              <button
                className="recycle-row-btn"
                onClick={() => removeRow(t.id, () => restoreWidget(t.id))}
                title={tr("恢复")}
                aria-label={tr("恢复")}
                data-interactive
              >
                <RotateCcw size={14} />
              </button>
              {/* #71 彻底删除两段式确认：同一按钮 morph（图标淡切 + danger 底色过渡） */}
              <button
                className={`recycle-row-btn danger${confirmId === t.id ? " confirming" : ""}`}
                onClick={() => {
                  if (confirmId === t.id) {
                    removeRow(t.id, () => purgeWidget(t.id));
                    setConfirmId(null);
                  } else {
                    setConfirmId(t.id);
                  }
                }}
                onMouseLeave={() => setConfirmId(null)}
                onBlur={() => setConfirmId(null)}
                title={confirmId === t.id ? tr("再次点击确认删除") : tr("彻底删除")}
                aria-label={confirmId === t.id ? tr("再次点击确认删除") : tr("彻底删除")}
                data-interactive
              >
                <span className="btn-ico" key={confirmId === t.id ? t.id : ""}>
                  {confirmId === t.id ? <X size={14} /> : <Trash2 size={14} />}
                </span>
              </button>
            </div>
          );
        })}
        {visible.length === 0 && <div className="recycle-row-empty">{tr("无匹配项")}</div>}
      </div>

      {/* W-096 便签回收站聚合分区。 */}
      {noteTrash.length > 0 && (
        <div className="recycle-notes">
          <div className="recycle-notes-head">
            <StickyNote size={13} />
            <span>{tr("便签回收站")}</span>
            <span className="recycle-count small">{noteTrash.length}</span>
          </div>
          <div className="recycle-list scroll-fade-y">
            {noteTrash.map(({ instanceId, note }, ni) => {
              const nKey = `n-${instanceId}-${note.id}`;
              return (
                <div
                  className={`recycle-row${removingIds.has(note.id) ? " is-closing" : ""}`}
                  key={nKey}
                  style={{ "--sti": ni } as React.CSSProperties}
                >
                  <span className="recycle-row-icon">
                    <StickyNote size={15} />
                  </span>
                  <div className="recycle-row-main">
                    <span className="recycle-row-name note-snippet">
                      {note.text.split("\n")[0] || tr("（空便签）")}
                    </span>
                    <span className="recycle-row-time">{timeAgo(note.deletedAt, tr)}</span>
                  </div>
                  <button
                    className="recycle-row-btn"
                    onClick={() => {
                      restoreFromTrash(instanceId, note.id);
                      setNoteTrash(listAllNotesTrash());
                    }}
                    title={tr("恢复")}
                    aria-label={tr("恢复")}
                    data-interactive
                  >
                    <RotateCcw size={14} />
                  </button>
                  {/* 与组件分区一致：彻底删除两段式确认（n- 前缀避免与组件 id 撞键）。 */}
                  <button
                    className={`recycle-row-btn danger${confirmId === nKey ? " confirming" : ""}`}
                    onClick={() => {
                      if (confirmId === nKey) {
                        removeRow(note.id, () => {
                          purgeTrash(instanceId, note.id);
                          setNoteTrash(listAllNotesTrash());
                        });
                        setConfirmId(null);
                      } else {
                        setConfirmId(nKey);
                      }
                    }}
                    onMouseLeave={() => setConfirmId(null)}
                    onBlur={() => setConfirmId(null)}
                    title={confirmId === nKey ? tr("再次点击确认删除") : tr("彻底删除")}
                    aria-label={confirmId === nKey ? tr("再次点击确认删除") : tr("彻底删除")}
                    data-interactive
                  >
                    <span className="btn-ico" key={confirmId === nKey ? nKey : ""}>
                      {confirmId === nKey ? <X size={14} /> : <Trash2 size={14} />}
                    </span>
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
