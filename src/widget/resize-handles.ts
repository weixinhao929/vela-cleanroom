/**
 * 8 向缩放手柄（WidgetCard / GroupCard 共用）：细长条覆盖整条边缘，任意位置
 * 均可拖动缩放；四角小块允许同时拖两个方向。命中区从视觉边加宽，
 * 高 DPI 与 zoom≠100% 下也可命中；视觉仍由 CSS 控制（默认透明、悬停浮现）。
 */

/** corner handle size */
export const HS = 10;
/** edge thickness */
export const EDGE = 8;

export interface ResizeHandleDef {
  id: string;
  cursor: string;
  /** 读屏标签：手柄本身无文字，键盘缩放由 Shift+方向键承担。 */
  label: string;
  style: React.CSSProperties;
}

export const RESIZE_HANDLES: ResizeHandleDef[] = [
  // 四角（小块，允许同时拖拽两个方向）
  { id: "nw", cursor: "nw-resize", label: "缩放：左上角", style: { top: 0, left: 0, width: HS, height: HS } },
  { id: "ne", cursor: "ne-resize", label: "缩放：右上角", style: { top: 0, right: 0, width: HS, height: HS } },
  { id: "se", cursor: "se-resize", label: "缩放：右下角", style: { bottom: 0, right: 0, width: HS, height: HS } },
  { id: "sw", cursor: "sw-resize", label: "缩放：左下角", style: { bottom: 0, left: 0, width: HS, height: HS } },
  // 四条边：细长条覆盖边缘，与四角相接形成封闭框
  { id: "n", cursor: "n-resize", label: "缩放：上边缘", style: { top: 0, left: HS, right: HS, height: EDGE } },
  { id: "s", cursor: "s-resize", label: "缩放：下边缘", style: { bottom: 0, left: HS, right: HS, height: EDGE } },
  { id: "w", cursor: "w-resize", label: "缩放：左边缘", style: { left: 0, top: HS, bottom: HS, width: EDGE } },
  { id: "e", cursor: "e-resize", label: "缩放：右边缘", style: { right: 0, top: HS, bottom: HS, width: EDGE } }
];
