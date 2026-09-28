/* eslint-disable react-refresh/only-export-components -- 定位纯函数与常量随组件文件导出（group-bloom.test.ts 锚点），同 UpdatePage 惯例。 */
/**
 * 编组花瓣预览（BentoDesk 借鉴 #3）：非编辑模式悬停组标签条约 300ms 弹出
 * 「花瓣」网格——成员图标 + 名称一览，点击直达该成员标签（免逐个点标签
 * 翻找；BentoDesk bloom 的「快速扫视」粒度，管理粒度仍是标签条本身）。
 *
 * 定位是确定性纯函数 `bloomPlacement`：默认在标签条上方展开，上方放不下
 * 翻到下方，横向夹在视口内（缩放锚点随翻侧换边，从标签条方向长出来）。
 * 关闭判定：组与花瓣双双离开（200ms grace）/ Esc / 外点。容器带
 * data-interactive，点击穿透按交互矩形自动放行。
 */
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { getWidgetMeta } from "./registry";
import { useT } from "../i18n-lite";
import { animDurations } from "../lib/durations";

/** 悬停意图延迟：停这么久才弹（快速划过不误触）。 */
export const BLOOM_HOVER_INTENT_MS = 300;
/** 离开 grace：组与花瓣之间往返移动不闪关。 */
export const BLOOM_LEAVE_GRACE_MS = 200;

export type BloomAnchor = { left: number; top: number; width: number; bottom: number };

export type BloomPlacement = { left: number; top: number; originX: string; originY: string };

/** 花瓣定位（纯函数，可单测）：上方优先、放不下翻下方，横向夹视口。 */
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

  const pos = bloomPlacement(anchor, { w: window.innerWidth, h: window.innerHeight }, { w: 280, h: 220 });
  const style: CSSProperties = {
    left: pos.left,
    top: pos.top,
    transformOrigin: `${pos.originX} ${pos.originY}`
  };

  return createPortal(
    <div
      ref={ref}
      className={`group-bloom${closing ? " is-closing" : ""}`}
      style={style}
      role="menu"
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
