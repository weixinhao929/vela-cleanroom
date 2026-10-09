/**
 * 截图套件纯逻辑：框选矩形运算（归一/钳制/
 * 移动/角点缩放/命中）、标注图元模型与 canvas 绘制、最终合成导出。
 * 全部纯函数（DOM canvas 参数注入），供 SnipView 与单测共用。
 */

export type Rect = { x: number; y: number; w: number; h: number };
export type Corner = "nw" | "ne" | "sw" | "se";

/** 两点 → 正向矩形（拖拽方向任意）。 */
export function normalizeRect(x0: number, y0: number, x1: number, y1: number): Rect {
  return { x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.abs(x1 - x0), h: Math.abs(y1 - y0) };
}

/** 钳制到 [0, maxW]×[0, maxH] 视口内。 */
export function clampRect(r: Rect, maxW: number, maxH: number): Rect {
  const x = Math.max(0, Math.min(r.x, maxW));
  const y = Math.max(0, Math.min(r.y, maxH));
  return {
    x,
    y,
    w: Math.max(0, Math.min(r.w, maxW - x)),
    h: Math.max(0, Math.min(r.h, maxH - y))
  };
}

/** 平移并钳制。 */
export function moveRect(r: Rect, dx: number, dy: number, maxW: number, maxH: number): Rect {
  return clampRect({ ...r, x: r.x + dx, y: r.y + dy }, maxW, maxH);
}

/** 拖角点缩放：以角为锚，另一端不动。 */
export function resizeRect(r: Rect, corner: Corner, px: number, py: number, maxW: number, maxH: number): Rect {
  const anchors: Record<Corner, [number, number]> = {
    nw: [r.x + r.w, r.y + r.h],
    ne: [r.x, r.y + r.h],
    sw: [r.x + r.w, r.y],
    se: [r.x, r.y]
  };
  const [ax, ay] = anchors[corner];
  return clampRect(normalizeRect(ax, ay, px, py), maxW, maxH);
}

/** 角点命中检测（容差 tol，CSS px）。 */
export function hitTestCorner(r: Rect, px: number, py: number, tol = 10): Corner | null {
  const pts: Record<Corner, [number, number]> = {
    nw: [r.x, r.y],
    ne: [r.x + r.w, r.y],
    sw: [r.x, r.y + r.h],
    se: [r.x + r.w, r.y + r.h]
  };
  for (const c of Object.keys(pts) as Corner[]) {
    const [cx, cy] = pts[c];
    if (Math.abs(px - cx) <= tol && Math.abs(py - cy) <= tol) return c;
  }
  return null;
}

/** 点是否在矩形内。 */
export function rectContains(r: Rect, px: number, py: number): boolean {
  return px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h;
}

/** 识别为「有效选区」的最小尺寸（防误触点击出 1px 选区）。 */
export const MIN_SELECTION = 8;

/* ---- 标注图元 ---- */

export type Tool = "select" | "pen" | "highlighter" | "arrow" | "rect" | "ellipse" | "text" | "mosaic";

export type Shape =
  | { tool: "pen" | "highlighter"; color: string; size: number; points: [number, number][] }
  | { tool: "arrow" | "rect" | "ellipse"; color: string; size: number; x0: number; y0: number; x1: number; y1: number }
  | { tool: "text"; color: string; size: number; x: number; y: number; text: string }
  | { tool: "mosaic"; x: number; y: number; w: number; h: number };

/** 预览态也用同一绘制函数（进行中的图元以增量字段呈现）。 */
export function drawShape(ctx: CanvasRenderingContext2D, s: Shape) {
  ctx.save();
  if (s.tool === "pen" || s.tool === "highlighter") {
    ctx.strokeStyle = s.color;
    ctx.lineWidth = s.size;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    if (s.tool === "highlighter") ctx.globalAlpha = 0.4;
    ctx.beginPath();
    s.points.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
    if (s.points.length === 1) {
      // 单点点击也留一个点。
      ctx.arc(s.points[0][0], s.points[0][1], s.size / 2, 0, Math.PI * 2);
      ctx.fillStyle = s.color;
      ctx.fill();
    }
    ctx.stroke();
  } else if (s.tool === "arrow" || s.tool === "rect" || s.tool === "ellipse") {
    ctx.strokeStyle = s.color;
    ctx.lineWidth = s.size;
    const x = Math.min(s.x0, s.x1);
    const y = Math.min(s.y0, s.y1);
    const w = Math.abs(s.x1 - s.x0);
    const h = Math.abs(s.y1 - s.y0);
    if (s.tool === "arrow") {
      // 主线 + 30° 两条短翼（与涂鸦板同款）。
      const ang = Math.atan2(s.y1 - s.y0, s.x1 - s.x0);
      const len = Math.max(12, s.size * 4);
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(s.x0, s.y0);
      ctx.lineTo(s.x1, s.y1);
      ctx.moveTo(s.x1, s.y1);
      ctx.lineTo(s.x1 - len * Math.cos(ang - Math.PI / 6), s.y1 - len * Math.sin(ang - Math.PI / 6));
      ctx.moveTo(s.x1, s.y1);
      ctx.lineTo(s.x1 - len * Math.cos(ang + Math.PI / 6), s.y1 - len * Math.sin(ang + Math.PI / 6));
      ctx.stroke();
    } else if (s.tool === "rect") {
      ctx.strokeRect(x, y, w, h);
    } else {
      ctx.beginPath();
      ctx.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
      ctx.stroke();
    }
  } else if (s.tool === "text") {
    ctx.fillStyle = s.color;
    ctx.font = `600 ${s.size}px sans-serif`;
    ctx.textBaseline = "top";
    for (const [i, line] of s.text.split("\n").entries()) {
      ctx.fillText(line, s.x, s.y + i * s.size * 1.25);
    }
  }
  ctx.restore();
}

/** 马赛克：对源画布指定区域做像素化（cell 为物理像素格边长）。
 *  在合成导出时以物理坐标调用；纯函数（对传入 canvas 有副作用，但无隐藏状态）。 */
export function applyMosaic(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, cell: number) {
  const rx = Math.max(0, Math.floor(x));
  const ry = Math.max(0, Math.floor(y));
  const rw = Math.max(1, Math.floor(w));
  const rh = Math.max(1, Math.floor(h));
  const data = ctx.getImageData(rx, ry, rw, rh);
  const px = data.data;
  const c = Math.max(2, Math.floor(cell));
  for (let by = 0; by < rh; by += c) {
    for (let bx = 0; bx < rw; bx += c) {
      let r = 0;
      let g = 0;
      let b = 0;
      let n = 0;
      for (let yy = by; yy < Math.min(by + c, rh); yy++) {
        for (let xx = bx; xx < Math.min(bx + c, rw); xx++) {
          const i = (yy * rw + xx) * 4;
          r += px[i];
          g += px[i + 1];
          b += px[i + 2];
          n++;
        }
      }
      r = Math.round(r / n);
      g = Math.round(g / n);
      b = Math.round(b / n);
      for (let yy = by; yy < Math.min(by + c, rh); yy++) {
        for (let xx = bx; xx < Math.min(bx + c, rw); xx++) {
          const i = (yy * rw + xx) * 4;
          px[i] = r;
          px[i + 1] = g;
          px[i + 2] = b;
        }
      }
    }
  }
  ctx.putImageData(data, rx, ry);
}

/** 合成导出：冻结帧 + 标注（CSS 坐标 × scale 换物理）→ 裁剪选区 → PNG dataURL。 */
export function composeSnip(
  img: CanvasImageSource,
  imgW: number,
  imgH: number,
  shapes: readonly Shape[],
  sel: Rect,
  scale: number
): string {
  const full = document.createElement("canvas");
  full.width = imgW;
  full.height = imgH;
  const ctx = full.getContext("2d");
  if (!ctx) return "";
  ctx.drawImage(img, 0, 0, imgW, imgH);
  // 马赛克先作用于原始像素（物理坐标），再画其余标注。
  for (const s of shapes) {
    if (s.tool === "mosaic") {
      applyMosaic(ctx, s.x * scale, s.y * scale, s.w * scale, s.h * scale, 10 * scale);
    }
  }
  ctx.save();
  ctx.scale(scale, scale);
  for (const s of shapes) {
    if (s.tool !== "mosaic") drawShape(ctx, s);
  }
  ctx.restore();
  const w = Math.max(1, Math.round(sel.w * scale));
  const h = Math.max(1, Math.round(sel.h * scale));
  const out = document.createElement("canvas");
  out.width = w;
  out.height = h;
  const octx = out.getContext("2d");
  if (!octx) return "";
  octx.drawImage(full, sel.x * scale, sel.y * scale, w, h, 0, 0, w, h);
  return out.toDataURL("image/png");
}

/** 保存文件名：截图_yyyyMMdd_HHmmss（CSH 同款防撞名格式）。 */
export function snipFileName(now = new Date()): string {
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `截图_${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}_${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}.png`;
}
