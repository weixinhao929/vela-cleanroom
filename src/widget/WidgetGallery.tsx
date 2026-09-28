import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, ChevronDown, Dock, Monitor, Plus, Search, X } from "lucide-react";
import {
  preloadWidgets,
  useCategoryNames,
  useTranslatedWidgetRegistry,
  type WidgetCategory,
  type WidgetMeta
} from "./registry";
import { createDockTileAutoBound, findDockTileConflict, useWidgetStore } from "./widget-store";
import { useT } from "../i18n-lite";
import { useSafeTimeout } from "../lib/use-safe-timeout";
import { animDurations } from "../lib/durations";

/**
 * Vela-style widget gallery: a two-pane modal. The left pane lists widgets
 * grouped by category with a search box; the right pane shows a live preview
 * of the selected widget. Clicking a card adds it to the canvas.
 *
 * 关闭语义：所有退出路径（遮罩 / 返回 / 关闭按钮 / Esc / 添加完成后）都必须
 * 调用 onClose 卸载本组件本身。此前这些路径只调 setEditMode(false)，导致
 * 全屏遮罩永久驻留、用户被困在添加面板里。
 */
/** 数据作用域：内容按实例分键（复制 = 独立副本，多块互不相通）。 */
const PER_INSTANCE_TYPES = new Set(["notes", "bookmarks", "calendar", "sketch", "gallery"]);
/** 数据作用域：全局共享（多块实例实时同步同一份数据）。 */
const GLOBAL_TYPES = new Set(["todo", "deadlines", "habits", "pomodoro"]);

export function WidgetGallery({ onClose }: { onClose: () => void }) {
  const tr = useT();
  const safeTimeout = useSafeTimeout();
  /* D3：模态对称退场——关闭后保留一拍播淡出缩离（wg-overlay/panel-out =
     --dur-fx）再真正卸载；时长经 animDurations 同步速度档，+20ms 余量防掐尾。 */
  const [closing, setClosing] = useState(false);
  const closeAnimated = () => {
    if (closing) return;
    setClosing(true);
    safeTimeout(onClose, animDurations().fxMs + 20);
  };
  const catNames = useCategoryNames();
  const registry = useTranslatedWidgetRegistry();
  const addWidget = useWidgetStore((s) => s.addWidget);
  const [query, setQuery] = useState("");
  const [group, setGroup] = useState<"category" | "all">("category");
  const [selected, setSelected] = useState<WidgetMeta | null>(null);
  /* [DROP] 图库入口：所选类型直接进灵动岛（无实例磁贴，追加末尾）。禁用态与
     widget-store.findDockTileConflict 同一规则（同类型无实例磁贴已在岛上即禁用）。 */
  const addDockTile = useWidgetStore((s) => s.addDockTile);
  const selectedOnIsland = useWidgetStore(
    (s) => !!selected && !!findDockTileConflict(s.dock.tiles, { type: selected.type })
  );

  // Esc 关闭图库（但不退出编辑模式，用户还能继续摆放刚添加的小组件）。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeAnimated();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [closing]);

  /* C10：图库打开后空闲时预热全部小组件 chunk（本地文件加载成本≈0），
     首次添加不再出现「骨架屏→内容」的等待。 */
  useEffect(() => {
    const idle = (window as unknown as { requestIdleCallback?: (cb: () => void) => number }).requestIdleCallback;
    if (idle) {
      idle(() => preloadWidgets());
      return;
    }
    safeTimeout(() => preloadWidgets(), 800);
  }, [safeTimeout]);

  /* 数据作用域标注：per-instance 类型（便签/书签/日历/涂鸦/图库）的内容
     按实例分键——多块实例互不相通、复制是独立副本；todo/deadlines/habits/
     pomodoro 全局共享，多块实例实时同步。此前无任何提示，「复制便签得到
     空壳」「两块待办永远同步」都被当成 bug。 */
  const scopeOf = (type: string): { label: string; scope: "own" | "shared" } | null => {
    if (PER_INSTANCE_TYPES.has(type)) return { label: tr("数据独立"), scope: "own" };
    if (GLOBAL_TYPES.has(type)) return { label: tr("数据同步"), scope: "shared" };
    return null;
  };

  const handleAdd = (type: string, size: { w: number; h: number }) => {
    addWidget(type, size);
    // 添加后回到编辑模式（而非直接退出），方便用户立刻拖拽定位新小组件；
    // 图库本身必须关闭，否则遮罩会挡住画布。
    onClose();
  };

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return registry.filter((w) => !q || w.name.toLowerCase().includes(q) || w.desc.toLowerCase().includes(q));
  }, [registry, query]);

  /* #72 过滤退场：被滤掉的卡片保留 160ms 播 .is-closing 淡出再卸载，
     期间不可点击；重新匹配时立即摘除退场标记。 */
  const [closingTypes, setClosingTypes] = useState<Set<string>>(new Set());
  const prevTypes = useRef<Set<string>>(new Set(filtered.map((w) => w.type)));
  useEffect(() => {
    const prev = prevTypes.current;
    const cur = new Set(filtered.map((w) => w.type));
    prevTypes.current = cur;
    setClosingTypes((old) => {
      const next = new Set([...old].filter((t) => !cur.has(t)));
      for (const t of prev) if (!cur.has(t)) next.add(t);
      return next.size === old.size && [...next].every((t) => old.has(t)) ? old : next;
    });
  }, [filtered]);
  useEffect(() => {
    if (!closingTypes.size) return;
    /* 卡片退场 gal-tile-out = --dur-fx-fast，+30ms 余量；随速度档。 */
    safeTimeout(() => setClosingTypes(new Set()), animDurations().fxFastMs + 30);
  }, [closingTypes, safeTimeout]);
  const displayItems = useMemo(() => {
    if (!closingTypes.size) return filtered;
    return registry.filter((w) => filtered.some((f) => f.type === w.type) || closingTypes.has(w.type));
  }, [registry, filtered, closingTypes]);

  const groups = useMemo(() => {
    if (group === "all") return [{ category: "all" as WidgetCategory, items: displayItems }];
    const cats: WidgetCategory[] = ["focus", "tools", "system", "online"];
    return cats
      .map((c) => ({ category: c, items: displayItems.filter((w) => w.category === c) }))
      .filter((g) => g.items.length > 0);
  }, [displayItems, group]);

  /* [POLISH] A4 按压几何「挤压 + 邻块吸收」：按住的卡片外圆角张大、邻卡圆角
     收缩并微降透明（widget.css 图库区段）。图库面板带 backdrop-filter，透明
     窗口里子元素 transform 会触发合成层重建导致卡片消失（见 .widget-gallery-card
     hover 注释），因此形变全部用 border-radius / 颜色 / 透明度表达，不动 transform。
     按压态用 JS 类名而非 :has(:active)——check-transitions 门禁按「首个 :active 之前
     的选择器」比对基线，:has() 内的伪类会被截断成无效基线。 */
  const [pressedType, setPressedType] = useState<string | null>(null);
  const releasePress = (type: string) => setPressedType((t) => (t === type ? null : t));

  return (
    <div className={`widget-gallery-overlay${closing ? " is-closing" : ""}`} onClick={closeAnimated}>
      <div className={`widget-gallery-panel${closing ? " is-closing" : ""}`} onClick={(e) => e.stopPropagation()}>
        <div className="widget-gallery-topbar">
          <button className="widget-gallery-back" onClick={closeAnimated}>
            <ArrowLeft size={16} />
            {tr("返回")}
          </button>
          <div className="widget-gallery-pill">
            <Monitor size={13} />
            {tr("正在添加到桌面小组件层")}
          </div>
          <div className="widget-gallery-search">
            <Search size={14} />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={tr("搜索小组件…")}
              data-interactive
            />
          </div>
          <div className="widget-gallery-group">
            <span>{tr("分组方式")}</span>
            <button
              className="widget-gallery-group-btn"
              onClick={() => setGroup(group === "category" ? "all" : "category")}
            >
              {group === "category" ? tr("类别") : tr("全部")}
              <ChevronDown size={13} />
            </button>
          </div>
          <button className="widget-gallery-close" onClick={closeAnimated} aria-label={tr("关闭")}>
            <X size={15} />
          </button>
        </div>

        <div className="widget-gallery-body">
          <div className="widget-gallery-list">
            {groups.map((g) => (
              <div className="widget-gallery-cat" key={g.category}>
                {group === "category" && <div className="widget-gallery-cat-label">{catNames[g.category]}</div>}
                <div className={`widget-gallery-grid${pressedType ? " absorb" : ""}`}>
                  {g.items.map((w) => {
                    const Icon = w.icon;
                    const active = selected?.type === w.type;
                    const closing = closingTypes.has(w.type);
                    const pressed = pressedType === w.type;
                    return (
                      <button
                        key={w.type}
                        className={`widget-gallery-card${active ? " active" : ""}${closing ? " is-closing" : ""}${pressed ? " is-pressed" : ""}`}
                        onClick={() => setSelected(w)}
                        onDoubleClick={() => handleAdd(w.type, w.defaultSize)}
                        onPointerDown={() => setPressedType(w.type)}
                        onPointerUp={() => releasePress(w.type)}
                        onPointerCancel={() => releasePress(w.type)}
                        onPointerLeave={() => releasePress(w.type)}
                        data-interactive
                      >
                        <div className="widget-gallery-card-icon">
                          <Icon size={20} />
                        </div>
                        <div className="widget-gallery-card-text">
                          <span className="widget-gallery-card-name">{w.name}</span>
                          <span className="widget-gallery-card-desc">{w.desc}</span>
                          {scopeOf(w.type) && (
                            <span className={`widget-gallery-scope is-${scopeOf(w.type)!.scope}`}>
                              {scopeOf(w.type)!.label}
                            </span>
                          )}
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
            {displayItems.length === 0 && <div className="widget-gallery-empty">{tr("没有匹配的小组件")}</div>}
          </div>

          <div className="widget-gallery-preview">
            {selected ? (
              <>
                <div className="widget-gallery-preview-head">
                  <span className="widget-gallery-preview-title">{selected.name}</span>
                  <div className="widget-gallery-preview-actions">
                    {/* [DROP] F-2 入口 b：所选类型进灵动岛；已在岛上 → 禁用态「已在灵动岛」。 */}
                    <button
                      className="widget-gallery-preview-add is-dock"
                      onClick={() => addDockTile(createDockTileAutoBound(selected.type))}
                      disabled={selectedOnIsland}
                      aria-disabled={selectedOnIsland}
                      title={tr(selectedOnIsland ? "已在灵动岛" : "添加到灵动岛")}
                      data-interactive
                    >
                      <Dock size={14} />
                      {tr(selectedOnIsland ? "已在灵动岛" : "添加到灵动岛")}
                    </button>
                    <button
                      className="widget-gallery-preview-add"
                      onClick={() => handleAdd(selected.type, selected.defaultSize)}
                    >
                      <Plus size={14} />
                      {tr("添加")}
                    </button>
                  </div>
                </div>
                <div className="widget-gallery-preview-card">
                  <selected.icon size={40} />
                </div>
                <div className="widget-gallery-preview-desc">
                  {selected.desc}
                  {scopeOf(selected.type) && (
                    <span className={`widget-gallery-scope is-${scopeOf(selected.type)!.scope}`}>
                      {scopeOf(selected.type)!.label}
                    </span>
                  )}
                </div>
              </>
            ) : (
              <div className="widget-gallery-preview-empty">{tr("选择一个小组件以预览")}</div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
