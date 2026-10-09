/* eslint-disable react-refresh/only-export-components */
/**
 * 「+」磁贴的类型选择器（入口 b，ISLAND-SORT）：锚定在「+」磁贴旁的玻璃弹层，
 * 按 CATEGORY_NAMES 分组列出 WIDGET_REGISTRY 全部类型（图标 + 名称 + 有迷你形态
 * 标记），顶部搜索走 match-tier 五级评分（名称 / 描述 / 拼音首字母 / 类型 id），
 * 选中即 onPick(type)，调用方 addDockTile 追加到末尾。
 *
 * 定位 / 退场复用 WidgetConfigPopover 的写法：placePopover（上方优先、贴顶翻转
 * 到下方、视口钳制）+ useDelayedUnmount 160ms 播 .is-closing。岛默认贴顶，
 * 弹层多数时候翻到「+」下方。键盘：Esc 关闭（capture 拦截）、↑/↓ 在条目间
 * 移动、搜索框回车选第一条。「+」只在编辑模式出现，此时整窗可交互，外点关闭
 * 无需加入 useClickThrough 的 OVERLAY_SELECTOR。弹层 Portal 到 body，所有事件
 * 在根节点截断，不会沿 React 树冒泡回 DockTiles 的拖动 / 键盘处理器。
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent
} from "react";
import { createPortal } from "react-dom";
import { Search, X } from "lucide-react";
import { useT } from "../../i18n-lite";
import { useDelayedUnmount } from "../../lib/anim";
import { animDurations } from "../../lib/durations";
import { uiZoom } from "../../lib/ui-zoom";
import { useDismissable } from "../../lib/use-dismissable";
import { scoreMatch } from "../../lib/match-tier";
import { pinyinInitials } from "../../lib/pinyin";
import { WIDGET_REGISTRY, useCategoryNames, type WidgetCategory, type WidgetMeta } from "../registry";
import { placePopover, type PopoverAnchor } from "../WidgetConfigPopover";

/**
 * 关闭原因：调用方据此决定是否把焦点还给「+」——外点关闭时焦点正转移到点中的
 * 元素，不能抢回；"pick" 由调用方在选中后自行传入。
 */
export type PickerCloseReason = "escape" | "outside" | "button" | "pick";

export type DockTypePickerProps = {
  /** 「+」磁贴的视口矩形（open 翻真时取一次快照）。 */
  anchor: PopoverAnchor;
  open: boolean;
  onClose: (reason: PickerCloseReason) => void;
  onPick: (type: string) => void;
  /**
   * 该类型是否不可再入岛（调用方按 widget-store.findDockTileConflict 判定）：条目渲染为
   * 禁用态 + 「已在灵动岛」提示，搜索框回车也跳过它们。缺省全部可选。
   */
  isTypeDisabled?: (type: string) => boolean;
};

/** 分类展示顺序（与 WidgetGallery 一致）。 */
const CATEGORY_ORDER: readonly WidgetCategory[] = ["focus", "tools", "system", "online"];

export type PickerGroup = { category: WidgetCategory; items: WidgetMeta[] };

/**
 * 过滤 + 分组（纯函数，便于单测）。query 为空 → 全部类型按 registry 顺序分组；
 * 否则按 match-tier 评分过滤（名称 / 描述 / 中文名拼音首字母 / 类型 id 四路取最大，
 * 「jsq」命中「计算器」、「calc」命中 calculator），组内按分降序、同分保持 registry 顺序。
 * query 非空时**组间也按组内最高分降序**——此前组序固定为 focus>tools>
 * system>online，回车/首项选到的是「分类第一」而非全局最佳匹配（「jsq」会被
 * focus 类的弱匹配劫持）；组内 + 组间双降序后 flatMap 拉平即全局降序，方向键
 * 遍历顺序与之一致。query 为空保持固定分类序。
 */
export function groupPickerItems(
  registry: readonly WidgetMeta[],
  query: string,
  tr: (zh: string) => string
): PickerGroup[] {
  const q = query.trim();
  const scored = registry
    .map((meta) => ({
      meta,
      score: q
        ? scoreMatch(
            {
              name: tr(meta.name),
              generic: tr(meta.desc),
              keywords: pinyinInitials(meta.name) || undefined,
              id: meta.type
            },
            q
          )
        : 1
    }))
    .filter((x) => x.score > 0);
  if (q) scored.sort((a, b) => b.score - a.score);
  const groups: PickerGroup[] = CATEGORY_ORDER.map((category) => ({
    category,
    items: scored.filter((x) => x.meta.category === category).map((x) => x.meta)
  })).filter((g) => g.items.length > 0);
  if (q) {
    /* 组间按组内最高分（scored 已全局降序，首个同分类项即峰值；并列保持
       分类序——sort 稳定）。 */
    const top = new Map<WidgetCategory, number>();
    for (const x of scored) if (!top.has(x.meta.category)) top.set(x.meta.category, x.score);
    groups.sort((a, b) => (top.get(b.category) ?? 0) - (top.get(a.category) ?? 0));
  }
  return groups;
}

type Placement = ReturnType<typeof placePopover>;

export function DockTypePicker({ anchor, open, onClose, onPick, isTypeDisabled }: DockTypePickerProps) {
  const tr = useT();
  const catNames = useCategoryNames();
  const visible = useDelayedUnmount(open, animDurations().fxFastMs);
  const closing = !open && visible;
  const ref = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const anchorRef = useRef<PopoverAnchor>(anchor);
  const [pos, setPos] = useState<Placement | null>(null);
  const [query, setQuery] = useState("");

  /* open 翻真：快照锚点、清空搜索、下一帧把焦点落到搜索框。 */
  useEffect(() => {
    if (!open) return;
    anchorRef.current = anchor;
    setQuery("");
    const raf = requestAnimationFrame(() => inputRef.current?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(raf);
    // anchor 仅在打开瞬间取快照；后续变化不重定位。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const place = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    /* 锚点来自「+」按钮 gBCR（视觉坐标）：除回布局单位再定位（fixed left/top
       渲染会再乘 zoom）；offsetWidth / innerWidth 本就是未缩放值。 */
    const z = uiZoom();
    const a = anchorRef.current;
    setPos(
      placePopover(
        { x: a.x / z, y: a.y / z, w: a.w / z, h: a.h / z },
        { w: el.offsetWidth, h: el.offsetHeight },
        { w: window.innerWidth, h: window.innerHeight }
      )
    );
  }, []);
  useLayoutEffect(() => {
    if (visible) place();
  }, [visible, place]);
  useEffect(() => {
    if (!visible || !open) return;
    /* 窗口尺寸变化（缩放档 / 分辨率 / 岛随布局重排）后锚点快照已陈旧，
       按旧锚点重摆会挂错位置（甚至出屏）——直接关闭，重开取新锚点。 */
    const onResize = () => onClose("outside");
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [visible, open, onClose]);

  /* Esc 关闭（capture 阶段拦截，不让画布 / 编辑模式的 Esc 监听抢先）。
     理由感知：closePicker 对 Esc / 外点的焦点归还策略不同（见 DockTiles），
     Esc 保留本实现，外点交给下方统一骨架。 */
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      e.preventDefault();
      onClose("escape");
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, onClose]);

  /* 外点关闭（统一骨架）。 */
  useDismissable(open, ref, () => onClose("outside"), { escape: false });

  // hidden（贴图等内部类型）不进选择器：只能由内部流程（截图钉图）创建。
  const groups = useMemo(
    () =>
      groupPickerItems(
        WIDGET_REGISTRY.filter((w) => !w.hidden),
        query,
        tr
      ),
    [query, tr]
  );
  const disabled = (type: string) => isTypeDisabled?.(type) === true;
  /* 回车选首条：跳过已在岛上的类型。 */
  const first = groups.flatMap((g) => g.items).find((m) => !disabled(m.type));

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    // 弹层 Portal 在 body 下但 React 树仍挂在 DockTiles 内：一律截断，磁贴层的
    // 方向键 / Delete 处理器不得收到弹层里的按键。
    e.stopPropagation();
    if (e.key === "Enter" && !e.nativeEvent.isComposing && e.target === inputRef.current) {
      /* IME 组合期回车选词会被误当作「回车选首条」
         把第一个小组件误添加进灵动岛（React 合成事件读 nativeEvent.isComposing）。 */
      if (first) {
        e.preventDefault();
        onPick(first.type);
      }
      return;
    }
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    // 禁用条目不可聚焦：方向键只在可选条目间移动。
    const items = Array.from(
      ref.current?.querySelectorAll<HTMLButtonElement>(".dock-picker-item:not(:disabled)") ?? []
    );
    if (items.length === 0) return;
    e.preventDefault();
    const i = items.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === "ArrowDown") {
      items[i < 0 ? 0 : Math.min(items.length - 1, i + 1)].focus();
    } else if (i <= 0) {
      inputRef.current?.focus();
    } else {
      items[i - 1].focus();
    }
  };

  if (!visible) return null;

  const style: CSSProperties = pos
    ? { left: pos.left, top: pos.top, transformOrigin: pos.below ? "top center" : "bottom center" }
    : { left: -9999, top: -9999 };

  return createPortal(
    <div
      ref={ref}
      className={`dock-picker${closing ? " is-closing" : ""}${pos?.below ? " is-below" : ""}`}
      role="dialog"
      aria-label={tr("添加到灵动岛")}
      tabIndex={-1}
      data-interactive
      style={style}
      onKeyDown={onKeyDown}
      onPointerDown={(e) => e.stopPropagation()}
      onPointerUp={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => {
        if ((e.target as HTMLElement).closest("input")) return;
        e.preventDefault();
        e.stopPropagation();
        onClose("button");
      }}
    >
      <div className="dock-picker-head">
        <span className="dock-picker-title">{tr("添加到灵动岛")}</span>
        <button
          type="button"
          className="dock-picker-close"
          onClick={() => onClose("button")}
          aria-label={tr("关闭")}
          data-interactive
        >
          <X size={13} />
        </button>
      </div>
      <label className="dock-picker-search">
        <Search size={13} aria-hidden="true" />
        <input
          ref={inputRef}
          className="dock-picker-input"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={tr("搜索小组件类型")}
          aria-label={tr("搜索小组件类型")}
          autoComplete="off"
          spellCheck={false}
          data-interactive
        />
      </label>
      <div className="dock-picker-list scroll-fade-y">
        {groups.length === 0 && <div className="dock-picker-empty">{tr("没有匹配的类型")}</div>}
        {groups.map((g) => (
          <section key={g.category} className="dock-picker-group" aria-label={catNames[g.category]}>
            <div className="dock-picker-group-name" aria-hidden="true">
              {catNames[g.category]}
            </div>
            {g.items.map((meta) => {
              const Icon = meta.icon;
              const off = disabled(meta.type);
              return (
                <button
                  key={meta.type}
                  type="button"
                  className={`dock-picker-item${off ? " is-disabled" : ""}`}
                  disabled={off}
                  aria-disabled={off}
                  onClick={() => onPick(meta.type)}
                  title={off ? tr("已在灵动岛") : tr(meta.desc)}
                  data-interactive
                >
                  <Icon size={14} aria-hidden="true" />
                  <span className="dock-picker-item-name">{tr(meta.name)}</span>
                  {off ? (
                    <span className="dock-picker-badge">{tr("已在灵动岛")}</span>
                  ) : (
                    meta.MiniComponent && <span className="dock-picker-badge">{tr("迷你形态")}</span>
                  )}
                </button>
              );
            })}
          </section>
        ))}
      </div>
    </div>,
    document.body
  );
}
