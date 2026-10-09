import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { ArrowLeft, Check, Dock, Plus, Search, X } from "lucide-react";
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
import { armPopupClickShield } from "../lib/click-shield";

/**
 * 桌面「添加小组件」图库：形式与设置页「添加小组件」（WidgetGalleryPage /
 * .tm-gallery-*）一致——返回 + 胶囊搜索、带计数的分类芯片、分类分节的两列
 * 圆形图标卡片，单击卡片即入画布并打勾反馈。差异只有两点：
 * ① 容器是画布上的玻璃模态而非设置页内嵌页（所有打开入口都已先进入编辑
 *   模式，收起图库即可拖拽摆放新组件）；
 * ② 卡片悬停多一枚「入岛」圆钮——原预览面板的灵动岛入口收编进卡片。
 *
 * 关闭语义：所有退出路径（遮罩 / 返回 / 关闭按钮 / Esc）都必须调用 onClose
 * 卸载本组件本身。此前这些路径只调 setEditMode(false)，导致全屏遮罩永久
 * 驻留、用户被困在添加面板里。添加本身不关闭图库（旧版双击添加即关）：
 * 与设置页一致保持打开可连续添加，反馈靠卡片打勾。
 */
/** 数据作用域：内容按实例分键（复制 = 独立副本，多块互不相通）。 */
const PER_INSTANCE_TYPES = new Set(["notes", "bookmarks", "calendar", "sketch", "gallery"]);
/** 数据作用域：全局共享（多块实例实时同步同一份数据）。 */
const GLOBAL_TYPES = new Set(["todo", "deadlines", "habits", "pomodoro"]);
/** 同一卡片两次激活的最小间隔——单击即添加的即时反馈保留，但 300ms 内
    的第二次激活（双击 = click×2，或回车连按）忽略，防止误双击产出两个实例。
    300ms 覆盖典型双击间隔（系统双击时限 500ms 的主体区间），又不至于吃掉
    用户刻意连续添加不同卡片的操作（按类型分键，互不影响）。 */
const ADD_DEBOUNCE_MS = 300;

export function WidgetGallery({ onClose, forceClosing }: { onClose: () => void; forceClosing?: boolean }) {
  const tr = useT();
  const safeTimeout = useSafeTimeout();
  /* 模态对称退场——关闭后保留一拍播淡出缩离（wg-overlay/panel-out =
     --dur-fx）再真正卸载；时长经 animDurations 同步速度档，+20ms 余量防掐尾。
     forceClosing：父级强制关闭路径（退出编辑模式的防御性同步）不经过
     closeAnimated——经此标志同样进入退场态，由父级的延迟卸载窗口收尾，
     两条路径播同一套动画。 */
  const [closing, setClosing] = useState(false);
  const isClosing = closing || !!forceClosing;
  const closeAnimated = () => {
    if (closing) return;
    // [CLICK-SHIELD]：全屏遮罩常压在可点组件上，
    // 退场开始即屏蔽连点（默认关；不走 useDelayedUnmount，手动挂）。
    armPopupClickShield();
    setClosing(true);
    safeTimeout(onClose, animDurations().fxMs + 20);
  };
  const catNames = useCategoryNames();
  const registry = useTranslatedWidgetRegistry();
  const addWidget = useWidgetStore((s) => s.addWidget);
  const addDockTile = useWidgetStore((s) => s.addDockTile);
  const dockTiles = useWidgetStore((s) => s.dock.tiles);
  const [query, setQuery] = useState("");
  const [cat, setCat] = useState<"all" | WidgetCategory>("all");
  /* 刚添加的组件类型：卡片上短暂打勾反馈（与设置页图库同一交互）。 */
  const [justAdded, setJustAdded] = useState<string | null>(null);
  const addedTimer = useRef(0);
  useEffect(() => () => window.clearTimeout(addedTimer.current), []);

  // Esc 关闭图库（但不退出编辑模式，用户还能继续摆放刚添加的小组件）。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeAnimated();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [closing]);

  /* 图库打开后空闲时预热全部小组件 chunk（本地文件加载成本≈0），
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
     空壳」「两块待办永远同步」都被当成 bug。改版后不占卡片版面（对齐设置
     页卡片），收进悬停 tooltip。 */
  const scopeOf = (type: string): { label: string; scope: "own" | "shared" } | null => {
    if (PER_INSTANCE_TYPES.has(type)) return { label: tr("数据独立"), scope: "own" };
    if (GLOBAL_TYPES.has(type)) return { label: tr("数据同步"), scope: "shared" };
    return null;
  };

  /* 添加即入画布（旧版单击选中 + 双击添加）：反馈与设置页同款——卡片打勾
     1.2s；图库保持打开，方便一次加多块。
     同一卡片 300ms 内的第二次激活忽略（见 ADD_DEBOUNCE_MS）——
     单击立即添加的体感不变，误双击不再产出两个实例。 */
  const lastAddAtRef = useRef(new Map<string, number>());
  const handleAdd = (w: WidgetMeta) => {
    const now = Date.now();
    if (now - (lastAddAtRef.current.get(w.type) ?? 0) < ADD_DEBOUNCE_MS) return;
    lastAddAtRef.current.set(w.type, now);
    addWidget(w.type, w.defaultSize);
    setJustAdded(w.type);
    window.clearTimeout(addedTimer.current);
    addedTimer.current = window.setTimeout(() => setJustAdded(null), 1200);
  };

  /* 入岛禁用态与 addDockTile 的去重规则同一事实（findDockTileConflict）：
     同类型无实例磁贴已在岛上即禁用。 */
  const onIsland = (type: string) => !!findDockTileConflict(dockTiles, { type });

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return registry.filter(
      (w) =>
        (cat === "all" || w.category === cat) &&
        (!q || w.name.toLowerCase().includes(q) || w.desc.toLowerCase().includes(q))
    );
  }, [registry, query, cat]);

  /* 分类芯片（全部 / 专注 / 工具 / 系统 / 在线）：计数与设置页同源
     （useTranslatedWidgetRegistry 已滤掉 dockOnly / hidden）。 */
  const cats: { id: "all" | WidgetCategory; label: string; count: number }[] = [
    { id: "all", label: tr("全部"), count: registry.length },
    ...(["focus", "tools", "system", "online"] as WidgetCategory[]).map((c) => ({
      id: c,
      label: catNames[c],
      count: registry.filter((w) => w.category === c).length
    }))
  ];

  /* 分类芯片键盘巡览（roving tabindex）——role=tablist 此前只能
     鼠标点 / 逐个 Tab。只有激活芯片 tabIndex=0（其余 -1，Tab 一次进出整组），
     ArrowLeft/Right 循环移动焦点并切换分类（同时激活）；芯片始终横向排列
     （RTL 布局未启用），Left=前一个 / Right=后一个。鼠标点击语义不变。 */
  const chipRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const onChipsKeyDown = (e: ReactKeyboardEvent) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const delta = e.key === "ArrowRight" ? 1 : -1;
    const idx = cats.findIndex((c) => c.id === cat);
    const nextIdx = (idx + delta + cats.length) % cats.length;
    const next = cats[nextIdx];
    if (!next) return;
    setCat(next.id);
    chipRefs.current[nextIdx]?.focus();
  };

  /* 过滤退场：被滤掉的卡片保留 160ms 播 .is-closing 淡出再卸载，
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

  /* 「全部」= 按分类分节展示（节标题 + 两列网格）；选了具体分类则平铺该类。 */
  const groups = useMemo(() => {
    if (cat !== "all") return [{ category: cat, items: displayItems }];
    const ordered: WidgetCategory[] = ["focus", "tools", "system", "online"];
    return ordered
      .map((c) => ({ category: c, items: displayItems.filter((w) => w.category === c) }))
      .filter((g) => g.items.length > 0);
  }, [displayItems, cat]);

  /* [POLISH] 按压几何「挤压 + 邻块吸收」：按住的卡片外圆角张大、邻卡圆角
     收缩并微降透明（widget.css 图库区段）。图库面板带 backdrop-filter，透明
     窗口里子元素 transform 会触发合成层重建导致卡片消失（见 .widget-gallery-card
     hover 注释），因此形变全部用 border-radius / 颜色 / 透明度表达，不动 transform。
     按压态用 JS 类名而非 :has(:active)——check-transitions 门禁按「首个 :active 之前
     的选择器」比对基线，:has() 内的伪类会被截断成无效基线。 */
  const [pressedType, setPressedType] = useState<string | null>(null);
  const releasePress = (type: string) => setPressedType((t) => (t === type ? null : t));

  const renderCard = (w: WidgetMeta) => {
    const Icon = w.icon;
    const added = justAdded === w.type;
    const island = onIsland(w.type);
    const closing = closingTypes.has(w.type);
    const pressed = pressedType === w.type;
    const scope = scopeOf(w.type);
    return (
      <div
        key={w.type}
        role="button"
        tabIndex={0}
        className={`widget-gallery-card${added ? " just-added" : ""}${closing ? " is-closing" : ""}${pressed ? " is-pressed" : ""}`}
        title={scope ? `${w.desc} · ${scope.label}` : w.desc}
        onClick={() => handleAdd(w)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            handleAdd(w);
          }
        }}
        onPointerDown={() => setPressedType(w.type)}
        onPointerUp={() => releasePress(w.type)}
        onPointerCancel={() => releasePress(w.type)}
        onPointerLeave={() => releasePress(w.type)}
        data-interactive
      >
        <span className="widget-gallery-card-icon" aria-hidden="true">
          <Icon size={20} />
        </span>
        <span className="widget-gallery-card-text">
          <span className="widget-gallery-card-name">{w.name}</span>
          <span className="widget-gallery-card-desc">{w.desc}</span>
        </span>
        {/* 悬停浮现的双圆钮：右侧「+」添加入画布（添加后短变 ✓，纯展示）；
            左侧「岛」把类型加入灵动岛（原预览面板入口收编），已在岛上→禁用。 */}
        <button
          type="button"
          className="widget-gallery-card-dock"
          onClick={(e) => {
            e.stopPropagation();
            addDockTile(createDockTileAutoBound(w.type));
          }}
          disabled={island}
          aria-label={tr(island ? "已在灵动岛" : "添加到灵动岛")}
          title={tr(island ? "已在灵动岛" : "添加到灵动岛")}
          data-interactive
        >
          <Dock size={13} />
        </button>
        <span className="widget-gallery-card-add" aria-hidden="true">
          {added ? <Check size={14} /> : <Plus size={14} />}
        </span>
      </div>
    );
  };

  return (
    <div className={`widget-gallery-overlay${isClosing ? " is-closing" : ""}`} onClick={closeAnimated}>
      <div className={`widget-gallery-panel${isClosing ? " is-closing" : ""}`} onClick={(e) => e.stopPropagation()}>
        <div className="widget-gallery-topbar">
          <button type="button" className="widget-gallery-back" onClick={closeAnimated}>
            <ArrowLeft size={15} />
            {tr("返回")}
          </button>
          <div className="widget-gallery-search">
            <Search size={14} />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              /* 补上注释自述却从未实现的「输入 → 回车添加」
                 ——回车即添加首条过滤结果（含当前分类过滤；空结果不动）。
                 教训：中文 IME 的「回车选词」也派发 key==="Enter"
                 （isComposing===true），裸判断会把拼音串误当确认——先判
                 nativeEvent.isComposing（门禁 lint:ime 按此口径检查）。 */
              onKeyDown={(e) => {
                if (e.key !== "Enter" || e.nativeEvent.isComposing) return;
                const first = filtered[0];
                if (first) handleAdd(first);
              }}
              placeholder={tr("搜索小组件…")}
              aria-label={tr("搜索小组件")}
              /* 打开即聚焦搜索框：图库的主路径就是「输入 → 回车添加」，键盘
                 用户不必再 Tab 一次（与布局模板面板的名称框同款）。 */
              autoFocus
              data-interactive
            />
          </div>
          <button type="button" className="widget-gallery-close" onClick={closeAnimated} aria-label={tr("关闭")}>
            <X size={15} />
          </button>
        </div>

        <div className="widget-gallery-chips" role="tablist" aria-label={tr("分类")} onKeyDown={onChipsKeyDown}>
          {cats.map((c, i) => (
            <button
              key={c.id}
              ref={(el) => {
                chipRefs.current[i] = el;
              }}
              type="button"
              role="tab"
              aria-selected={cat === c.id}
              /* roving tabindex——仅激活芯片可 Tab 聚焦，方向键在组内移动。 */
              tabIndex={cat === c.id ? 0 : -1}
              className={`widget-gallery-chip${cat === c.id ? " active" : ""}`}
              onClick={() => setCat(c.id)}
              data-interactive
            >
              {c.label}
              <span className="widget-gallery-chip-count">{c.count}</span>
            </button>
          ))}
        </div>

        {/* key 只含分类——搜索每敲一个字符不重挂整网格（与设置页图库同策略）；
            换分类保留整页入场语义。 */}
        <div className="widget-gallery-scroll" key={cat}>
          {groups.map((g) => (
            <div className="widget-gallery-cat" key={g.category}>
              {cat === "all" && <div className="widget-gallery-cat-label">{catNames[g.category]}</div>}
              <div className={`widget-gallery-grid${pressedType ? " absorb" : ""}`}>{g.items.map(renderCard)}</div>
            </div>
          ))}
          {displayItems.length === 0 && <div className="widget-gallery-empty">{tr("没有匹配的小组件")}</div>}
        </div>
      </div>
    </div>
  );
}
