import { useLayoutEffect, useRef, useState } from "react";

/**
 * 光标锚定的 fixed 菜单视口钳制（与 ContextMenu 面板同语义的收边版）：
 * 首帧按原始坐标渲染，layout 阶段测量实际尺寸后，右/下越界时向内收到
 * 安全边（不翻转 origin，只收边）。供仍使用私有菜单皮的组件
 * （.widget-context-menu 一族）复用；统一菜单（openContextMenu）自带
 * 钳制 + 翻转，无需本钩子。
 */
export function useViewportClampedPos(x: number, y: number, margin = 8) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState({ x, y });
  useLayoutEffect(() => {
    const el = ref.current;
    const w = el?.offsetWidth ?? 0;
    const h = el?.offsetHeight ?? 0;
    const nx = w > 0 && x + w + margin > window.innerWidth ? Math.max(margin, window.innerWidth - w - margin) : x;
    const ny = h > 0 && y + h + margin > window.innerHeight ? Math.max(margin, window.innerHeight - h - margin) : y;
    setPos((p) => (p.x === nx && p.y === ny ? p : { x: nx, y: ny }));
  }, [x, y, margin]);
  return { ref, pos };
}
