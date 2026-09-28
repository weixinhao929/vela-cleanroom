/**
 * 截图覆盖窗视图（借鉴 ClassSoftwareHub #4）：冻结帧铺满窗口作背景，
 * 框选只是从帧上裁——覆盖层永远不会拍到自己。框选后进入编辑：标注工具
 * （画笔/荧光笔/箭头/矩形/椭圆/文字/马赛克）+ 撤销重做，三出口 =
 * 复制剪贴板 / 保存文件 / 钉到桌面（经 snip:pin 事件由 primary 窗落组件）。
 * Esc 退出；窗口由 Rust visible(false) 创建，本视图就绪后自行 show。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowUpRight,
  Copy,
  Crop,
  Eraser,
  Highlighter,
  Maximize2,
  Minus,
  PenLine,
  Pin,
  Redo2,
  Save,
  Square,
  Type,
  Undo2,
  Circle
} from "lucide-react";
import { invoke, isTauri } from "../../lib/tauri";
import { useT } from "../../i18n-lite";
import { pushAppToast } from "../../components/ToastHost";
import {
  MIN_SELECTION,
  clampRect,
  composeSnip,
  hitTestCorner,
  moveRect,
  normalizeRect,
  rectContains,
  resizeRect,
  snipFileName,
  drawShape,
  type Corner,
  type Rect,
  type Shape,
  type Tool
} from "./snip-logic";
import type { SnipFrame } from "../../types/bindings/SnipFrame";
import type { SnipPinResult } from "../../types/bindings/SnipPinResult";
import "./snip.css";

const COLORS = ["#e5484d", "#f5a524", "#28c840", "#3b82f6", "#ffffff", "#111111"];
const PEN_SIZE = 4;
const TEXT_SIZE = 20;
const MOSAIC_MIN = 12;

type DragState =
  | { kind: "none" }
  | { kind: "new"; x0: number; y0: number }
  | { kind: "move"; startX: number; startY: number; orig: Rect }
  | { kind: "resize"; corner: Corner }
  | { kind: "draw"; shape: Shape };

export function SnipView() {
  const tr = useT();
  const [frame, setFrame] = useState<SnipFrame | null>(null);
  const [imgReady, setImgReady] = useState(false);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const [sel, setSel] = useState<Rect | null>(null);
  const [drag, setDrag] = useState<DragState>({ kind: "none" });
  const [tool, setTool] = useState<Tool>("select");
  const [color, setColor] = useState(COLORS[0]);
  const [shapes, setShapes] = useState<Shape[]>([]);
  // C-5：重做栈改 state——ref 变更不触发重渲，工具栏「重做」按钮的 disabled
  // 此前读到的是过期长度；updater 里 push ref 在 StrictMode 下还会双调用
  // 重复压栈。
  const [redoStack, setRedoStack] = useState<Shape[]>([]);
  const [textAt, setTextAt] = useState<[number, number] | null>(null);
  const [textDraft, setTextDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const shownRef = useRef(false);
  // C-5：冻结帧地址收进 state——render 期读 imgRef.current?.src 依赖「恰好
  // 有别的状态变化触发重渲」才拿到值，convertFileSrc 异步就绪本身不通知渲染。
  const [frameSrc, setFrameSrc] = useState("");

  const logicalW = frame ? frame.phys_w / frame.scale : 0;
  const logicalH = frame ? frame.phys_h / frame.scale : 0;

  /* 就绪握手：取帧元数据 + 加载冻结帧，首帧后 show。C-1：取帧被拒/超时的
     覆盖窗既不 show 也不 close——Rust 3s 兜底 show 后是纯黑遮罩盖住全屏；
     失败分支与 img.onerror 同款直接关窗退出。 */
  useEffect(() => {
    if (!isTauri()) return;
    invoke<SnipFrame | null>("get_snip_frame")
      .then((f) => {
        if (!f) {
          void import("@tauri-apps/api/window").then(({ getCurrentWindow }) => getCurrentWindow().close());
          return;
        }
        setFrame(f);
      })
      .catch(() => {
        void import("@tauri-apps/api/window").then(({ getCurrentWindow }) => getCurrentWindow().close());
      });
  }, []);

  useEffect(() => {
    if (!frame) return;
    const img = new Image();
    img.onload = () => {
      setImgReady(true);
      if (!shownRef.current && isTauri()) {
        shownRef.current = true;
        void import("@tauri-apps/api/window").then(({ getCurrentWindow }) => {
          const w = getCurrentWindow();
          void w.show();
          void w.setFocus();
        });
      }
    };
    img.onerror = () => {
      if (isTauri()) {
        void import("@tauri-apps/api/window").then(({ getCurrentWindow }) => getCurrentWindow().close());
      }
    };
    void import("@tauri-apps/api/core").then(({ convertFileSrc }) => {
      const url = convertFileSrc(frame.path);
      img.src = url;
      setFrameSrc(url);
    });
    imgRef.current = img;
  }, [frame]);

  const closeWindow = useCallback(() => {
    if (!isTauri()) return;
    void import("@tauri-apps/api/window").then(({ getCurrentWindow }) => getCurrentWindow().close());
  }, []);

  /* C-5：撤销/重做成对操作，键盘与工具栏共用（此前工具栏撤销不入重做栈，
     与 Ctrl+Z 行为不一致）；直接读渲染闭包里的当前 state，点击/按键发生在
     两次渲染之间，值必然新鲜。 */
  const undo = useCallback(() => {
    if (shapes.length === 0) return;
    const last = shapes[shapes.length - 1];
    setRedoStack((r) => [...r, last]);
    setShapes((p) => p.slice(0, -1));
  }, [shapes]);

  const redo = useCallback(() => {
    if (redoStack.length === 0) return;
    const popped = redoStack[redoStack.length - 1];
    setShapes((p) => [...p, popped]);
    setRedoStack((r) => r.slice(0, -1));
  }, [redoStack]);

  /* 标注画布重绘（shapes 或进行中图元变化时）。 */
  useEffect(() => {
    const c = canvasRef.current;
    if (!c || !frame) return;
    const dpr = frame.scale;
    c.width = Math.round(logicalW * dpr);
    c.height = Math.round(logicalH * dpr);
    const ctx = c.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.scale(dpr, dpr);
    for (const s of shapes) if (s.tool !== "mosaic") drawShape(ctx, s);
    // 马赛克在预览层画格纹（导出时才做真像素化）。
    for (const s of shapes) {
      if (s.tool === "mosaic") {
        ctx.save();
        ctx.globalAlpha = 0.9;
        const step = 10;
        for (let y = s.y; y < s.y + s.h; y += step) {
          for (let x = s.x; x < s.x + s.w; x += step) {
            ctx.fillStyle =
              (Math.floor(x / step) + Math.floor(y / step)) % 2 === 0
                ? "rgba(120,120,120,0.35)"
                : "rgba(60,60,60,0.35)";
            ctx.fillRect(x, y, Math.min(step, s.x + s.w - x), Math.min(step, s.y + s.h - y));
          }
        }
        ctx.restore();
      }
    }
    if (drag.kind === "draw" && drag.shape.tool !== "mosaic") drawShape(ctx, drag.shape);
  }, [shapes, drag, frame, logicalW, logicalH]);

  /* 键盘：Esc 逐级退出（文字 → 选区 → 关窗），Ctrl+Z/Y 撤销重做。 */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (textAt) {
        if (e.key === "Escape") {
          setTextAt(null);
          setTextDraft("");
        }
        return; // 文字编辑期其余按键交给 textarea。
      }
      if (e.key === "Escape") {
        if (shapes.length > 0) {
          setShapes([]);
          setRedoStack([]);
        } else if (sel) setSel(null);
        else closeWindow();
        return;
      }
      // C-5：Ctrl+Shift+Z 此前先命中撤销分支再命中重做分支（撤销块没排除
      // shift），一减一加净效果为零——重做快捷键实际失效。分支按 shift 互斥。
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z" && !e.shiftKey) {
        e.preventDefault();
        undo();
      }
      if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === "y" || (e.shiftKey && e.key.toLowerCase() === "z"))) {
        e.preventDefault();
        redo();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [textAt, shapes.length, undo, redo, sel, closeWindow]);

  function localPos(e: React.PointerEvent): [number, number] {
    const rect = rootRef.current?.getBoundingClientRect();
    return [e.clientX - (rect?.left ?? 0), e.clientY - (rect?.top ?? 0)];
  }

  function onPointerDown(e: React.PointerEvent) {
    if (busy || textAt) return;
    const [px, py] = localPos(e);
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    if (tool !== "select") {
      // 标注工具：画笔/形状/马赛克起笔；文字进入草稿态。
      if (tool === "text") {
        setTextAt([px, py]);
        setTextDraft("");
        return;
      }
      if (tool === "mosaic") {
        setDrag({ kind: "draw", shape: { tool: "mosaic", x: px, y: py, w: 0, h: 0 } });
        return;
      }
      if (tool === "pen" || tool === "highlighter") {
        setDrag({ kind: "draw", shape: { tool, color, size: PEN_SIZE, points: [[px, py]] } });
        return;
      }
      setDrag({ kind: "draw", shape: { tool, color, size: PEN_SIZE, x0: px, y0: py, x1: px, y1: py } });
      return;
    }
    // 选择工具：角点缩放 → 选区内移动 → 空白处重新框选。
    if (sel) {
      const corner = hitTestCorner(sel, px, py);
      if (corner) {
        setDrag({ kind: "resize", corner });
        return;
      }
      if (rectContains(sel, px, py)) {
        setDrag({ kind: "move", startX: px, startY: py, orig: sel });
        return;
      }
    }
    setDrag({ kind: "new", x0: px, y0: py });
    setSel(null);
  }

  function onPointerMove(e: React.PointerEvent) {
    if (drag.kind === "none") return;
    const [px, py] = localPos(e);
    if (drag.kind === "new") {
      setSel(normalizeRect(drag.x0, drag.y0, px, py));
    } else if (drag.kind === "move" && sel) {
      setSel(moveRect(drag.orig, px - drag.startX, py - drag.startY, logicalW, logicalH));
    } else if (drag.kind === "resize" && sel) {
      setSel(resizeRect(sel, drag.corner, px, py, logicalW, logicalH));
    } else if (drag.kind === "draw") {
      const s = drag.shape;
      if (s.tool === "pen" || s.tool === "highlighter") {
        setDrag({ kind: "draw", shape: { ...s, points: [...s.points, [px, py]] } });
      } else if (s.tool === "mosaic") {
        setDrag({ kind: "draw", shape: { ...s, w: px - s.x, h: py - s.y } });
      } else if (s.tool === "arrow" || s.tool === "rect" || s.tool === "ellipse") {
        setDrag({ kind: "draw", shape: { ...s, x1: px, y1: py } });
      }
    }
  }

  function onPointerUp() {
    if (drag.kind === "new" && sel && (sel.w < MIN_SELECTION || sel.h < MIN_SELECTION)) {
      setSel(null); // 误触点击不成选区。
    }
    if (drag.kind === "draw") {
      const s = drag.shape;
      let commit = true;
      if ((s.tool === "pen" || s.tool === "highlighter") && s.points.length < 2) commit = s.points.length === 1;
      if (
        (s.tool === "arrow" || s.tool === "rect" || s.tool === "ellipse") &&
        Math.abs(s.x1 - s.x0) < 2 &&
        Math.abs(s.y1 - s.y0) < 2
      )
        commit = false;
      if (s.tool === "mosaic" && (Math.abs(s.w) < MOSAIC_MIN || Math.abs(s.h) < MOSAIC_MIN)) commit = false;
      if (commit) {
        const norm: Shape =
          s.tool === "mosaic"
            ? {
                tool: "mosaic",
                x: Math.min(s.x, s.x + s.w),
                y: Math.min(s.y, s.y + s.h),
                w: Math.abs(s.w),
                h: Math.abs(s.h)
              }
            : s;
        setShapes((prev) => [...prev, norm]);
        setRedoStack([]);
      }
    }
    setDrag({ kind: "none" });
  }

  function commitText() {
    if (textAt && textDraft.trim()) {
      setShapes((prev) => [
        ...prev,
        { tool: "text", color, size: TEXT_SIZE, x: textAt[0], y: textAt[1], text: textDraft.replace(/\s+$/, "") }
      ]);
      setRedoStack([]);
    }
    setTextAt(null);
    setTextDraft("");
  }

  function compose(): string | null {
    if (!imgRef.current || !frame || !sel) return null;
    const full: Rect = { x: 0, y: 0, w: logicalW, h: logicalH };
    return composeSnip(imgRef.current, frame.phys_w, frame.phys_h, shapes, sel.w > 0 ? sel : full, frame.scale);
  }

  async function act(kind: "copy" | "save" | "pin") {
    const dataUrl = compose();
    if (!dataUrl) return;
    setBusy(true);
    try {
      if (kind === "copy") {
        await invoke("copy_image_to_clipboard", { dataUrl });
      } else if (kind === "save") {
        const { save } = await import("@tauri-apps/plugin-dialog");
        const path = await save({
          title: tr("保存截图"),
          defaultPath: snipFileName(),
          filters: [{ name: "PNG", extensions: ["png"] }]
        });
        if (!path) {
          setBusy(false); // 用户取消：留在覆盖窗。
          return;
        }
        await invoke("write_snip_png", { dataUrl, path });
      } else {
        const r = await invoke<SnipPinResult>("pin_snip_image", { dataUrl });
        if (isTauri()) {
          const { emit } = await import("@tauri-apps/api/event");
          await emit("snip:pin", { path: r.path, w: r.w, h: r.h });
        }
      }
      closeWindow();
    } catch (e) {
      // C-1：三出口失败此前只默默恢复按钮——用户没有任何解释，选区还在，
      // 却不知道为什么没复制/没保存/没钉上。报错后留在覆盖窗，可换出口重试。
      setBusy(false);
      const title = kind === "copy" ? tr("复制失败") : kind === "save" ? tr("保存失败") : tr("钉图失败");
      pushAppToast(title, e instanceof Error ? e.message : String(e), "error");
    }
  }

  function selectFull() {
    setSel(clampRect({ x: 0, y: 0, w: logicalW, h: logicalH }, logicalW, logicalH));
  }

  if (!frame) {
    return <div className="snip-root snip-loading" ref={rootRef} />;
  }

  const dim = sel
    ? [
        { left: 0, top: 0, width: logicalW, height: Math.max(0, sel.y) },
        { left: 0, top: sel.y + sel.h, width: logicalW, height: Math.max(0, logicalH - sel.y - sel.h) },
        { left: 0, top: sel.y, width: Math.max(0, sel.x), height: sel.h },
        { left: sel.x + sel.w, top: sel.y, width: Math.max(0, logicalW - sel.x - sel.w), height: sel.h }
      ]
    : [{ left: 0, top: 0, width: logicalW, height: logicalH }];

  const toolbarTop = sel ? (sel.y + sel.h + 64 > logicalH ? Math.max(8, sel.y - 52) : sel.y + sel.h + 12) : 12;

  const toolDefs: { id: Tool; icon: typeof PenLine; label: string }[] = [
    { id: "select", icon: Crop, label: tr("选择 / 移动选区") },
    { id: "pen", icon: PenLine, label: tr("画笔") },
    { id: "highlighter", icon: Highlighter, label: tr("荧光笔") },
    { id: "arrow", icon: ArrowUpRight, label: tr("箭头") },
    { id: "rect", icon: Square, label: tr("矩形") },
    { id: "ellipse", icon: Circle, label: tr("椭圆") },
    { id: "text", icon: Type, label: tr("文字") },
    { id: "mosaic", icon: Minus, label: tr("马赛克") }
  ];

  return (
    <div
      className="snip-root"
      ref={rootRef}
      style={{ width: logicalW, height: logicalH, cursor: "crosshair" }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onContextMenu={(e) => {
        e.preventDefault();
        closeWindow();
      }}
    >
      <img
        className="snip-frame"
        src={frameSrc}
        alt=""
        draggable={false}
        style={{ width: logicalW, height: logicalH, opacity: imgReady ? 1 : 0 }}
      />
      <canvas ref={canvasRef} className="snip-annot" style={{ width: logicalW, height: logicalH }} />
      {dim.map((d, i) => (
        <div key={i} className="snip-dim" style={d} />
      ))}
      {sel && (
        <>
          <div className="snip-sel" style={{ left: sel.x, top: sel.y, width: sel.w, height: sel.h }} />
          {(["nw", "ne", "sw", "se"] as Corner[]).map((c) => (
            <span key={c} className={`snip-handle snip-handle-${c}`} style={handlePos(sel, c)} />
          ))}
          <span className="snip-size" style={{ left: sel.x, top: Math.max(0, sel.y - 22) }}>
            {Math.round(sel.w * frame.scale)} × {Math.round(sel.h * frame.scale)}
          </span>
        </>
      )}
      {textAt && (
        <textarea
          className="snip-text-input"
          style={{ left: textAt[0], top: textAt[1], color }}
          value={textDraft}
          autoFocus
          onChange={(e) => setTextDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              commitText();
            }
          }}
          onBlur={commitText}
          placeholder={tr("输入文字，Enter 确认")}
        />
      )}
      {sel && (
        <div
          className="snip-toolbar"
          style={{ left: Math.min(Math.max(8, sel.x), Math.max(8, logicalW - 460)), top: toolbarTop }}
        >
          <div className="snip-tools">
            {toolDefs.map(({ id, icon: Icon, label }) => (
              <button
                key={id}
                className={`snip-tool${tool === id ? " is-active" : ""}`}
                title={label}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={() => setTool(id)}
              >
                <Icon size={14} />
              </button>
            ))}
          </div>
          <div className="snip-colors">
            {tool !== "select" && tool !== "mosaic"
              ? COLORS.map((c) => (
                  <button
                    key={c}
                    className={`snip-color${color === c ? " is-active" : ""}`}
                    style={{ background: c }}
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={() => setColor(c)}
                  />
                ))
              : null}
          </div>
          <div className="snip-tools">
            <button
              className="snip-tool"
              title={tr("撤销")}
              disabled={shapes.length === 0}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={undo}
            >
              <Undo2 size={14} />
            </button>
            <button
              className="snip-tool"
              title={tr("重做")}
              disabled={redoStack.length === 0}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={redo}
            >
              <Redo2 size={14} />
            </button>
            <button
              className="snip-tool"
              title={tr("清空标注")}
              disabled={shapes.length === 0}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => setShapes([])}
            >
              <Eraser size={14} />
            </button>
            <button
              className="snip-tool"
              title={tr("全屏选区")}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={selectFull}
            >
              <Maximize2 size={14} />
            </button>
          </div>
          <div className="snip-outs">
            <button
              className="snip-out"
              disabled={busy}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => void act("copy")}
            >
              <Copy size={13} />
              {tr("复制")}
            </button>
            <button
              className="snip-out"
              disabled={busy}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => void act("save")}
            >
              <Save size={13} />
              {tr("保存")}
            </button>
            <button
              className="snip-out is-primary"
              disabled={busy}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => void act("pin")}
            >
              <Pin size={13} />
              {tr("钉到桌面")}
            </button>
          </div>
        </div>
      )}
      {!sel && <div className="snip-tip">{tr("拖拽框选截图区域 · Esc 退出 · 右键取消")}</div>}
    </div>
  );
}

function handlePos(sel: Rect, c: Corner): { left: number; top: number } {
  const size = 10;
  const cx = c.includes("w") ? sel.x : sel.x + sel.w;
  const cy = c.includes("n") ? sel.y : sel.y + sel.h;
  return { left: cx - size / 2, top: cy - size / 2 };
}
