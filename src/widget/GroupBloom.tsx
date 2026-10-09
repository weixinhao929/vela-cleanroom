/* eslint-disable react-refresh/only-export-components -- 定位纯函数与常量随组件文件导出（group-bloom.test.ts 锚点），同 UpdatePage 惯例。 */
/**
 * 编组花瓣预览：非编辑模式悬停组标签条约 300ms 弹出
 * 「花瓣」网格——成员图标 + 名称一览，点击直达该成员标签。
 *
 * 定位是确定性纯函数 `bloomPlacement`：默认在标签条上方展开，上方放不下
 * 翻到下方，横向夹在视口内（缩放锚点随翻侧换边，从标签条方向长出来）。
 * 关闭判定：组与花瓣双双离开（200ms grace）/ Esc / 外点。容器带
 * data-interactive，点击穿透按交互矩形自动放行。
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { getWidgetMeta } from "./registry";
import { useT } from "../i18n-lite";
import { animDurations } from "../lib/durations";
import { uiZoom } from "../lib/ui-zoom";

/** 悬停意图延迟：停这么久才弹（快速划过不误触）。 */
export const BLOOM_HOVER_INTENT_MS = 300;
/** 离开 grace：组与花瓣之间往返移动不闪关。 */
export const BLOOM_LEAVE_GRACE_MS = 200;

export type BloomAnchor = { left: number; top: number; width: number; bottom: number };

export type BloomPlacement = { left: number; top: number; originX: string; originY: string };

/** 花瓣定位（纯函数，可单测）：上方优先、放不下翻下方，横向夹视口。
 *  输入/输出均为布局单位（fixed 定位坐标系）。 */
export function bloomPlacement(
  anchor: BloomAnchor,
  viewport: { w: number; h: number },
  size: { w: number; h: number }
): BloomPlacement {
  const above = anchor.top - size.h - 8;
  const useAbove = above >= 8 || anchor.bottom + size.h + 8 > viewport.h;
  const top = useAbove ? Math.max(8, above) : Math.min(anchor.bottom + 8, viewport.h - size.h - 8);
  const left = Math.min(Math.max(8, anchor.left), Math.max(8, viewport.w - size.w - 8));
  return {
    left: Math.round(left),
    top: Math.round(top),
    // 缩放锚点：从标签条那一侧长出来（上方展开 → 底部为锚；下方展开 → 顶部为锚）。
    originX: left <= 8 ? "left center" : "right center",
    originY: useAbove ? "bottom" : "top"
  };
}

/** 视觉矩形 → 布局矩形（纯函数，可单测）：标签条 gBCR 是视觉坐标（已含
 *  界面缩放），fixed 定位的 left/top 是布局单位、渲染时再乘 zoom——直接用
 *  视觉值定位会让花瓣随缩放成比例漂移（缩放 ≠100% 时「悬停标签页花瓣
 *  位置不对」的根源）。视口同理换算。 */
export function anchorToLayout(
  anchor: BloomAnchor,
  viewport: { w: number; h: number },
  zoom: number
): { anchor: BloomAnchor; viewport: { w: number; h: number } } {
  return {
    anchor: {
      left: anchor.left / zoom,
      top: anchor.top / zoom,
      width: anchor.width / zoom,
      bottom: anchor.bottom / zoom
    },
    viewport: { w: viewport.w / zoom, h: viewport.h / zoom }
  };
}

type Member = { id: string; type: string; name: string };

export function GroupBloom({
  members,
  activeId,
  anchor,
  onSelect,
  onClose,
  onHoverEnter,
  onHoverLeave
}: {
  members: Member[];
  activeId: string;
  anchor: BloomAnchor;
  onSelect: (memberId: string) => void;
  onClose: () => void;
  /** 悬停管理（grace 计时由调用方持有）：进入花瓣取消收回、离开重新武装。 */
  onHoverEnter?: () => void;
  onHoverLeave?: () => void;
}) {
  const tr = useT();
  const ref = useRef<HTMLDivElement>(null);
  const [closing, setClosing] = useState(false);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    if (!closing) return;
    /* group-bloom-out = --dur-fx-fast，+20ms 余量；随速度档（此前 140ms 掐尾）。 */
    const t = window.setTimeout(() => onCloseRef.current(), animDurations().fxFastMs + 20);
    return () => window.clearTimeout(t);
  }, [closing]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setClosing(true);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  /* zoomed 记忆化：anchor（父组件 state，引用稳定）与 zoom 不变时复用上一
     结果——此前每渲染重建对象，下方量测 effect 在父级每次重渲时都跑一遍
     （offsetWidth/Height 布局读 + bloomPlacement）。悬停寿命亚秒级，期间
     的窗口 resize 不重算可忽略（离开即卸载，下次悬停重取）。 */
  const zoom = uiZoom();
  const zoomed = useMemo(
    () => anchorToLayout(anchor, { w: window.innerWidth, h: window.innerHeight }, zoom),
    [anchor, zoom]
  );
  /* 位置二段确定：先用占位尺寸渲染（藏到屏外），useLayoutEffect 里量出真实
     渲染尺寸后重算——花瓣高度随成员数/名称换行变化（3 人一行只有 ~110px），
     按固定 220 估位会让花瓣底部与标签条之间空出上百像素。layout effect 在
     首帧绘制前跑完并同步重渲，用户只会看到最终位置。members.length 入依赖：
     成员增删改变花瓣尺寸时重量测。 */
  const [pos, setPos] = useState<BloomPlacement | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const next = bloomPlacement(zoomed.anchor, zoomed.viewport, {
      w: el.offsetWidth || 280,
      h: el.offsetHeight || 220
    });
    setPos((prev) =>
      prev &&
      prev.left === next.left &&
      prev.top === next.top &&
      prev.originX === next.originX &&
      prev.originY === next.originY
        ? prev
        : next
    );
    // setPos 有同值短路，重复度量不会成环。
  }, [zoomed, members.length]);
  const style: CSSProperties = {
    left: pos?.left ?? -9999,
    top: pos?.top ?? -9999,
    transformOrigin: pos ? `${pos.originX} ${pos.originY}` : "bottom center"
  };

  return createPortal(
    <div
      ref={ref}
      className={`group-bloom${closing ? " is-closing" : ""}`}
      style={style}
      /* 一览性浮层按 listbox/option 语义标注（此前 role=menu 但子项无
         menuitem、也无方向键巡览——语义与实际交互不符）。 */
      role="listbox"
      aria-label={tr("编组成员预览")}
      data-interactive
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
      onPointerEnter={onHoverEnter}
      onPointerLeave={onHoverLeave}
    >
      {members.map((m) => {
        const Icon = getWidgetMeta(m.type)?.icon;
        const active = m.id === activeId;
        return (
          <button
            key={m.id}
            type="button"
            role="option"
            aria-selected={active}
            className={`group-bloom-item${active ? " active" : ""}`}
            onClick={() => {
              onSelect(m.id);
              setClosing(true);
            }}
            title={m.name}
            data-interactive
          >
            <span className="group-bloom-icon">{Icon ? <Icon size={20} /> : null}</span>
            <span className="group-bloom-name">{m.name}</span>
          </button>
        );
      })}
    </div>,
    document.body
  );
}
