/**
 * 涂鸦小组件：手绘画布（画笔/橡皮/形状/颜色/背景），撤销栈截断 20
 * （控内存），笔画期缓存视口 rect、保存节流合并写盘。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowUpRight,
  Brush,
  Circle,
  ClipboardCopy,
  Download,
  Eraser,
  ImagePlus,
  Layers,
  Minus,
  Redo2,
  Square,
  Trash2,
  Undo2
} from "lucide-react";
import { useT } from "../../i18n-lite";
import { invoke, isTauri } from "../../lib/tauri";
import { pickFilePath } from "../../lib/file-dialog";
import { useSafeTimeout } from "../../lib/use-safe-timeout";
import { listAllPickerHistory } from "../color-shared";
import { useWidgetConfig } from "../widget-config";

const sketchKey = (instanceId: string) => `focus-desk.sketch.${instanceId}`;

const COLORS = ["#ffffff", "#81d4fa", "#4fc3f7", "#f6d365", "#74e0a5", "#f9a8d4", "#f87171", "#a78bfa"];

type Tool = "brush" | "eraser" | "line" | "rect" | "ellipse" | "arrow";
type BgMode = "transparent" | "grid" | "white" | "dark";

/**
 * 撤销栈条目：入栈时只做一次 drawImage 到离屏 canvas（GPU 拷贝，近乎零成本），
 * PNG 编码（大画布可达上百毫秒）推迟到笔画结束后的空闲时段；编码完成即释放
 * 位图，常驻内存回到压缩后的 dataURL 量级。
 */
type HistEntry = { canvas: HTMLCanvasElement | null; dataUrl: string | null };

function captureCanvas(src: HTMLCanvasElement): HistEntry {
  const c = document.createElement("canvas");
  c.width = src.width;
  c.height = src.height;
  c.getContext("2d")?.drawImage(src, 0, 0);
  return { canvas: c, dataUrl: null };
}

function encodeEntry(e: HistEntry): void {
  if (e.canvas && e.dataUrl === null) {
    e.dataUrl = e.canvas.toDataURL("image/png");
    e.canvas = null;
  }
}

function scheduleIdle(cb: () => void): void {
  if (typeof window.requestIdleCallback === "function") window.requestIdleCallback(cb, { timeout: 1500 });
  else window.setTimeout(cb, 50);
}

/** 未编码位图最多积压这么多张（快速连续落笔时），超出则同步编码最老的一张控内存。 */
const MAX_RAW_PENDING = 3;

const BG_LABEL: Record<BgMode, string> = {
  transparent: "透明",
  grid: "网格",
  white: "白底",
  dark: "深色"
};
/** 导出/复制时「含背景」使用的填充色；透明与网格按白色合成。 */
const BG_FILL: Record<BgMode, string> = {
  transparent: "#ffffff",
  grid: "#ffffff",
  white: "#ffffff",
  dark: "#151922"
};

/**
 * Whiteboard / doodle widget. Draw with the mouse or a pen on a sticky-canvas;
 * strokes are persisted as a PNG file in app data () so the sketch
 * survives restarts without eating the localStorage quota. Supports brush /
 * eraser / shapes, custom colors, canvas backgrounds, undo / redo, export and
 * clipboard copy.
 */
export function SketchWidget({ instanceId }: { instanceId: string }) {
  const tr = useT();
  const safeTimeout = useSafeTimeout();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  /* 卸载冲刷专用：React 在 passive cleanup 之前就把 canvasRef 置空，此前的
     "卸载时冲掉节流保存"因此永远早退、最后 ≤600ms 的笔画必丢。这份引用只在
     挂载时赋值、不随卸载清空——脱离 DOM 的 canvas 位图仍可 toDataURL。 */
  const canvasKeep = useRef<HTMLCanvasElement | null>(null);
  const attachCanvas = useCallback((el: HTMLCanvasElement | null) => {
    canvasRef.current = el;
    if (el) canvasKeep.current = el;
  }, []);
  const drawing = useRef(false);
  const last = useRef<{ x: number; y: number } | null>(null);
  const { config, update } = useWidgetConfig(instanceId);
  // Default 3px to match config-schemas (defaultBrushSize: num(3,1,20)) and the
  // settings Stepper. A `|| 4` here made a fresh widget default to 4px while
  // the settings UI showed/edited 3px — the same setting read differently.
  const defaultBrushSize = (config.defaultBrushSize as number) || 3;
  const defaultColor = (config.defaultColor as string) || "white";
  const bgMode = ((config.bgMode as BgMode) || "grid") satisfies BgMode;
  const exportQuality = (config.exportQuality as number) || 0.92;
  const [color, setColor] = useState(() => {
    const map: Record<string, string> = {
      white: "#ffffff",
      gray: "#9ca3af",
      blue: "#81d4fa",
      green: "#74e0a5"
    };
    return map[defaultColor] ?? "#ffffff";
  });
  const [size, setSize] = useState(defaultBrushSize);
  const [tool, setTool] = useState<Tool>("brush");
  const [haveInk, setHaveInk] = useState(false);
  const haveInkRef = useRef(false);
  haveInkRef.current = haveInk;
  // 撤销 / 重做历史栈：每次笔触开始前入栈一张画布快照（见 HistEntry 的懒编码说明）。
  const past = useRef<HistEntry[]>([]);
  const future = useRef<HistEntry[]>([]);
  /* 待编码的快照队列 + 单飞标记：一次空闲回调只编一张，避免长任务。 */
  const pendingEncode = useRef<HistEntry[]>([]);
  const encodeScheduled = useRef(false);
  /* 画布后备像素比（≤2）：pos() 已按 canvas.width 映射，线宽等需乘它保持视觉粗细。 */
  const dprRef = useRef(1);
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);
  /* 快照切换闪变：undo/redo/clear 后画布轻闪一次，给出「内容变了」的因果反馈。 */
  const [snapFlash, setSnapFlash] = useState(false);
  /* 键盘作用域：仅当鼠标悬停在本组件上时响应 Ctrl+Z/Y 与 B/E。 */
  const [hover, setHover] = useState(false);
  /* 导出菜单 / 复制反馈 / 导入中。 */
  const [exportOpen, setExportOpen] = useState(false);
  const [copyState, setCopyState] = useState<"ok" | "fail" | null>(null);
  const [busy, setBusy] = useState(false);
  /* 最近取色：取色器历史作为额外色源。 */
  const [recent, setRecent] = useState<string[]>(() => listAllPickerHistory(10));
  /* 形状工具拖拽预览：down 时的画布快照 + 起点。 */
  const shapeSnap = useRef<ImageData | null>(null);
  const shapeStart = useRef<{ x: number; y: number } | null>(null);
  /* 笔画期间缓存的画布视口矩形：pos() 不再每次 pointermove 都 getBoundingClientRect。 */
  const strokeRect = useRef<DOMRect | null>(null);
  /* 保存节流：连续笔画合并成一次写盘。 */
  const saveTimer = useRef<number | null>(null);

  const snapshot = (): HistEntry => {
    const c = canvasRef.current;
    return c ? captureCanvas(c) : { canvas: null, dataUrl: "" };
  };

  /** 空闲时把队首快照编码成 PNG 并释放位图；笔画进行中不编（留到 up() 再泵）。 */
  const pumpEncode = () => {
    if (encodeScheduled.current || pendingEncode.current.length === 0) return;
    encodeScheduled.current = true;
    scheduleIdle(() => {
      encodeScheduled.current = false;
      if (drawing.current) return;
      const e = pendingEncode.current.shift();
      if (e) encodeEntry(e);
      pumpEncode();
    });
  };

  const enqueueEncode = (e: HistEntry) => {
    pendingEncode.current.push(e);
    // 快速连续落笔时未编码位图会积压（每张 = 整画布 RGBA），超过上限同步编最老的一张。
    while (pendingEncode.current.filter((x) => x.canvas).length > MAX_RAW_PENDING) {
      const oldest = pendingEncode.current.shift();
      if (oldest) encodeEntry(oldest);
    }
    if (!drawing.current) pumpEncode();
  };

  /* （undo/redo 异步乱序）：dataUrl 快照经 Image 异步装载，连续 undo/redo
     时多个 onload 完成顺序无保证——后触发的旧快照会盖掉已应用的新快照。
     应用序号守卫：仅当本回合仍是最新应用时才允许上屏。 */
  const applySeqRef = useRef(0);

  const apply = (entry: HistEntry) => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const seq = ++applySeqRef.current;
    // 橡皮擦会把合成模式留在 destination-out，不复位则这里的 drawImage 变成「擦」。
    ctx.globalCompositeOperation = "source-over";
    if (entry.canvas) {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(entry.canvas, 0, 0, canvas.width, canvas.height);
      setHaveInk(true);
      return;
    }
    if (!entry.dataUrl) return;
    const img = new Image();
    img.onload = () => {
      if (seq !== applySeqRef.current) return;
      ctx.globalCompositeOperation = "source-over";
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      setHaveInk(true);
    };
    img.src = entry.dataUrl;
  };

  const pushHistory = () => {
    const e = snapshot();
    past.current.push(e);
    // 撤销栈上限 50→20，控制大画布 PNG dataURL 常驻内存（每实例峰值达数十 MB）。
    if (past.current.length > 20) past.current.shift();
    future.current = [];
    enqueueEncode(e);
    setCanUndo(past.current.length > 0);
    setCanRedo(false);
  };

  const undo = () => {
    if (past.current.length === 0) return;
    const cur = snapshot();
    future.current.push(cur);
    if (future.current.length > 20) future.current.shift();
    enqueueEncode(cur);
    const prev = past.current.pop()!;
    apply(prev);
    setCanUndo(past.current.length > 0);
    setCanRedo(future.current.length > 0);
    setHaveInk(true);
    setSnapFlash(true);
    schedulePersist();
  };

  const redo = () => {
    if (future.current.length === 0) return;
    const cur = snapshot();
    past.current.push(cur);
    if (past.current.length > 20) past.current.shift();
    enqueueEncode(cur);
    const next = future.current.pop()!;
    apply(next);
    setCanUndo(past.current.length > 0);
    setCanRedo(future.current.length > 0);
    setHaveInk(true);
    setSnapFlash(true);
    schedulePersist();
  };

  /* 快捷键经 ref 调最新实现，避免 hover 期间重复绑监听。 */
  const undoRef = useRef(undo);
  undoRef.current = undo;
  const redoRef = useRef(redo);
  redoRef.current = redo;

  // Restore a previously saved sketch (: file first, legacy dataURL second).
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const drawDataUrl = (src: string) => {
      const img = new Image();
      img.onload = () => {
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        setHaveInk(true);
      };
      img.src = src;
    };
    try {
      const saved = localStorage.getItem(sketchKey(instanceId));
      if (!saved) return;
      if (saved === "file" && isTauri()) {
        void invoke<string | null>("read_sketch_image", { instanceId })
          .then((dataUrl) => {
            if (dataUrl) drawDataUrl(dataUrl);
          })
          .catch(() => {});
      } else if (saved.startsWith("data:")) {
        drawDataUrl(saved);
        // 旧存档迁移：画布已恢复，下一次持久化自然转存为文件。
        schedulePersist();
      }
    } catch {
      // best-effort restore
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instanceId]);

  /* 画布分辨率跟随容器（原先固定 300×150 被拉伸，线条发虚）。缩放时
     备份重绘，画布清空时直接改尺寸。 */
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const sync = () => {
      if (drawing.current) return;
      // 后备尺寸按 DPR 分配（125%/150% 缩放下原先 1:1 后备被放大，线条发虚），
      // 与 AudioVisualizer 同做法；上限 2 控内存与快照编码开销。
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const rect = canvas.getBoundingClientRect();
      const w = Math.max(1, Math.round(rect.width * dpr));
      const h = Math.max(1, Math.round(rect.height * dpr));
      dprRef.current = dpr;
      if (canvas.width === w && canvas.height === h) return;
      let backup: HTMLCanvasElement | null = null;
      if (haveInkRef.current) {
        backup = document.createElement("canvas");
        backup.width = canvas.width;
        backup.height = canvas.height;
        backup.getContext("2d")?.drawImage(canvas, 0, 0);
      }
      canvas.width = w;
      canvas.height = h;
      if (backup) canvas.getContext("2d")?.drawImage(backup, 0, 0, w, h);
    };
    sync();
    const ro = new ResizeObserver(sync);
    ro.observe(canvas);
    return () => ro.disconnect();
  }, []);

  /* 最近取色：低频刷新 + 窗口聚焦时刷新。 */
  useEffect(() => {
    const refresh = () => setRecent(listAllPickerHistory(10));
    const t = window.setInterval(() => {
      if (!document.hidden) refresh();
    }, 10000);
    window.addEventListener("focus", refresh);
    return () => {
      window.clearInterval(t);
      window.removeEventListener("focus", refresh);
    };
  }, []);

  const pos = (e: React.PointerEvent): { x: number; y: number } => {
    const canvas = canvasRef.current!;
    // clientX/Y 与 rect 均为视口坐标，笔画内复用 down 时缓存的 rect 即可。
    const rect = strokeRect.current;
    if (!rect || rect.width === 0 || rect.height === 0) return { x: 0, y: 0 };
    return {
      x: ((e.clientX - rect.left) / rect.width) * canvas.width,
      y: ((e.clientY - rect.top) / rect.height) * canvas.height
    };
  };

  const isShape = (t: Tool) => t === "line" || t === "rect" || t === "ellipse" || t === "arrow";

  /** 形状落笔：按当前工具画直线/矩形/椭圆/箭头。 */
  const drawShape = (
    ctx: CanvasRenderingContext2D,
    t: Tool,
    s: { x: number; y: number },
    e: { x: number; y: number }
  ) => {
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.globalCompositeOperation = "source-over";
    ctx.strokeStyle = color;
    ctx.lineWidth = size * dprRef.current;
    ctx.beginPath();
    if (t === "line") {
      ctx.moveTo(s.x, s.y);
      ctx.lineTo(e.x, e.y);
      ctx.stroke();
      return;
    }
    if (t === "rect") {
      ctx.strokeRect(Math.min(s.x, e.x), Math.min(s.y, e.y), Math.abs(e.x - s.x), Math.abs(e.y - s.y));
      return;
    }
    if (t === "ellipse") {
      ctx.ellipse(
        (s.x + e.x) / 2,
        (s.y + e.y) / 2,
        Math.abs(e.x - s.x) / 2,
        Math.abs(e.y - s.y) / 2,
        0,
        0,
        Math.PI * 2
      );
      ctx.stroke();
      return;
    }
    // arrow：主线 + 两条 30° 短线构成箭头。
    ctx.moveTo(s.x, s.y);
    ctx.lineTo(e.x, e.y);
    ctx.stroke();
    const ang = Math.atan2(e.y - s.y, e.x - s.x);
    const head = Math.max(10, size * 4) * dprRef.current;
    ctx.beginPath();
    ctx.moveTo(e.x, e.y);
    ctx.lineTo(e.x - head * Math.cos(ang - Math.PI / 6), e.y - head * Math.sin(ang - Math.PI / 6));
    ctx.moveTo(e.x, e.y);
    ctx.lineTo(e.x - head * Math.cos(ang + Math.PI / 6), e.y - head * Math.sin(ang + Math.PI / 6));
    ctx.stroke();
  };

  const down = (e: React.PointerEvent) => {
    // 右键/中键落笔不入撤销栈——此前会 pushHistory + 画一个点，undo 栈
    // 被无意义快照污染。
    if (e.pointerType === "mouse" && e.button !== 0) return;
    e.preventDefault();
    // 先置 drawing 再入栈：快照的 PNG 编码在笔画期间不泵，留到 up() 后的空闲时段。
    drawing.current = true;
    // 入栈时机移到落笔前：捕获本笔开始前的基线，使首笔也能撤销（#）。
    pushHistory();
    const canvas = canvasRef.current!;
    canvas.setPointerCapture(e.pointerId);
    strokeRect.current = canvas.getBoundingClientRect();
    last.current = pos(e);
    if (isShape(tool)) {
      const ctx = canvas.getContext("2d");
      if (ctx) shapeSnap.current = ctx.getImageData(0, 0, canvas.width, canvas.height);
      shapeStart.current = last.current;
      setHaveInk(true);
    } else {
      paint(e);
    }
  };

  const move = (e: React.PointerEvent) => {
    if (!drawing.current) return;
    if (isShape(tool)) {
      const canvas = canvasRef.current;
      const ctx = canvas?.getContext("2d");
      const snap = shapeSnap.current;
      const start = shapeStart.current;
      if (!canvas || !ctx || !snap || !start) return;
      const p = pos(e);
      ctx.putImageData(snap, 0, 0);
      drawShape(ctx, tool, start, p);
      last.current = p;
    } else {
      paint(e);
    }
  };

  const up = (e: React.PointerEvent) => {
    if (!drawing.current) return;
    drawing.current = false;
    last.current = null;
    shapeSnap.current = null;
    shapeStart.current = null;
    strokeRect.current = null;
    const canvas = canvasRef.current!;
    // 橡皮擦留下的 destination-out 必须复位，否则后续 undo/redo/形状会「擦」而非「画」。
    const ctx = canvas.getContext("2d");
    if (ctx) ctx.globalCompositeOperation = "source-over";
    try {
      canvas.releasePointerCapture(e.pointerId);
    } catch {
      // ignore
    }
    pumpEncode();
    schedulePersist();
  };

  const paint = (e: React.PointerEvent) => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const p = pos(e);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = tool === "eraser" ? "rgba(0,0,0,1)" : color;
    ctx.lineWidth = (tool === "eraser" ? size * 3 : size) * dprRef.current;
    ctx.globalCompositeOperation = tool === "eraser" ? "destination-out" : "source-over";
    ctx.beginPath();
    if (last.current) {
      ctx.moveTo(last.current.x, last.current.y);
      ctx.lineTo(p.x, p.y);
      ctx.stroke();
    }
    last.current = p;
    setHaveInk(true);
  };

  /* 持久化：Tauri 下存 app data 文件（localStorage 只留 "file" 标记），
     浏览器 dev 下退回 dataURL。600ms 节流合并连续笔画。 */
  const doPersistNow = () => {
    const canvas = canvasRef.current ?? canvasKeep.current;
    if (!canvas) return;
    const dataUrl = canvas.toDataURL("image/png");
    if (isTauri()) {
      void invoke("save_sketch_image", { instanceId, dataUrl })
        .then(() => {
          try {
            localStorage.setItem(sketchKey(instanceId), "file");
          } catch {
            // best-effort
          }
        })
        .catch(() => {
          try {
            localStorage.setItem(sketchKey(instanceId), dataUrl);
          } catch {
            // best-effort
          }
        });
    } else {
      try {
        localStorage.setItem(sketchKey(instanceId), dataUrl);
      } catch {
        // best-effort
      }
    }
  };

  const schedulePersist = () => {
    if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      saveTimer.current = null;
      doPersistNow();
    }, 600);
  };

  /* 卸载时冲掉未落盘的节流保存，避免最后一笔丢失。 */
  useEffect(() => {
    return () => {
      if (saveTimer.current !== null) {
        window.clearTimeout(saveTimer.current);
        doPersistNow();
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const clear = () => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    pushHistory();
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    setHaveInk(false);
    setSnapFlash(true);
    try {
      localStorage.removeItem(sketchKey(instanceId));
    } catch {
      // ignore
    }
    if (isTauri()) void invoke("delete_sketch_image", { instanceId }).catch(() => {});
  };

  /* 导出：透明 PNG / 含背景 PNG / JPEG（质量可配）。 */
  const doExport = (kind: "png-t" | "png-bg" | "jpeg") => {
    setExportOpen(false);
    const canvas = canvasRef.current;
    if (!canvas) return;
    const fill = kind === "png-t" ? null : BG_FILL[bgMode];
    const out = document.createElement("canvas");
    out.width = canvas.width;
    out.height = canvas.height;
    const c = out.getContext("2d");
    if (!c) return;
    if (fill) {
      c.fillStyle = fill;
      c.fillRect(0, 0, out.width, out.height);
    }
    c.drawImage(canvas, 0, 0);
    out.toBlob(
      (blob) => {
        if (!blob) return;
        const a = document.createElement("a");
        a.download = `sketch-${Date.now()}.${kind === "jpeg" ? "jpg" : "png"}`;
        a.href = URL.createObjectURL(blob);
        a.click();
        safeTimeout(() => URL.revokeObjectURL(a.href), 5000);
      },
      kind === "jpeg" ? "image/jpeg" : "image/png",
      kind === "jpeg" ? exportQuality : undefined
    );
  };

  /* 复制到剪贴板：Tauri 走 Rust 写 CF_DIBV5/CF_DIB；dev 浏览器走
     navigator.clipboard。 */
  const copyImage = async () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    try {
      if (isTauri()) {
        await invoke("copy_image_to_clipboard", { dataUrl: canvas.toDataURL("image/png") });
        setCopyState("ok");
      } else {
        const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, "image/png"));
        const ClipboardItemCtor = (window as unknown as { ClipboardItem?: typeof ClipboardItem }).ClipboardItem;
        if (!blob || !ClipboardItemCtor || !navigator.clipboard?.write) throw new Error("unsupported");
        await navigator.clipboard.write([new ClipboardItemCtor({ "image/png": blob })]);
        setCopyState("ok");
      }
    } catch {
      setCopyState("fail");
    }
    safeTimeout(() => setCopyState(null), 1500);
  };

  /* 置入图片：选本地图片 → 居中等比贴到画布，随后即可批注。 */
  const importImage = async () => {
    if (!isTauri() || busy) return;
    setBusy(true);
    try {
      const picked = await pickFilePath({
        title: tr("置入图片"),
        filters: [{ name: tr("图片"), extensions: ["png", "jpg", "jpeg", "webp", "gif", "bmp"] }]
      });
      if (!picked) return;
      const dataUrl = await invoke<string>("read_image_data_url", { path: picked });
      const canvas = canvasRef.current;
      const ctx = canvas?.getContext("2d");
      if (!canvas || !ctx) return;
      const img = new Image();
      img.onload = () => {
        const scale = Math.min((canvas.width * 0.9) / img.width, (canvas.height * 0.9) / img.height, 1);
        const w = img.width * scale;
        const h = img.height * scale;
        pushHistory();
        ctx.drawImage(img, (canvas.width - w) / 2, (canvas.height - h) / 2, w, h);
        setHaveInk(true);
        schedulePersist();
      };
      img.src = dataUrl;
    } catch {
      // 选图取消或读取失败：静默返回
    } finally {
      setBusy(false);
    }
  };

  /* 键盘快捷键（悬停/聚焦作用域）：Ctrl+Z 撤销 / Ctrl+Y·Ctrl+Shift+Z 重做、
      B 画笔 / E 橡皮。focus-within 同步 hover 态，纯键盘 Tab 进入也能用。 */
  useEffect(() => {
    if (!hover) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      const k = e.key.toLowerCase();
      const mod = e.ctrlKey || e.metaKey;
      if (mod && k === "z") {
        e.preventDefault();
        if (e.shiftKey) redoRef.current();
        else undoRef.current();
        return;
      }
      if (mod && k === "y") {
        e.preventDefault();
        redoRef.current();
        return;
      }
      if (mod || e.altKey) return;
      if (k === "b") setTool("brush");
      else if (k === "e") setTool("eraser");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [hover]);

  /* 导出菜单：Esc 关闭。 */
  useEffect(() => {
    if (!exportOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setExportOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [exportOpen]);

  const bgModes: BgMode[] = ["transparent", "grid", "white", "dark"];

  return (
    <div
      className="sketch"
      onPointerEnter={() => setHover(true)}
      onPointerLeave={() => setHover(false)}
      onFocus={() => setHover(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setHover(false);
      }}
    >
      <div className="sketch-toolbar" data-interactive>
        <div className="sketch-tools">
          <button
            className={`sketch-tool${tool === "brush" ? " active" : ""}`}
            onClick={() => setTool("brush")}
            title={tr("画笔") + " (B)"}
            aria-label={tr("画笔") + " (B)"}
          >
            <Brush size={14} />
          </button>
          <button
            className={`sketch-tool${tool === "eraser" ? " active" : ""}`}
            onClick={() => setTool("eraser")}
            title={tr("橡皮擦") + " (E)"}
            aria-label={tr("橡皮擦") + " (E)"}
          >
            <Eraser size={14} />
          </button>
          <span className="sketch-tool-sep" />
          <button
            className={`sketch-tool${tool === "line" ? " active" : ""}`}
            onClick={() => setTool("line")}
            title={tr("直线")}
            aria-label={tr("直线")}
          >
            <Minus size={14} />
          </button>
          <button
            className={`sketch-tool${tool === "rect" ? " active" : ""}`}
            onClick={() => setTool("rect")}
            title={tr("矩形")}
            aria-label={tr("矩形")}
          >
            <Square size={13} />
          </button>
          <button
            className={`sketch-tool${tool === "ellipse" ? " active" : ""}`}
            onClick={() => setTool("ellipse")}
            title={tr("椭圆")}
            aria-label={tr("椭圆")}
          >
            <Circle size={13} />
          </button>
          <button
            className={`sketch-tool${tool === "arrow" ? " active" : ""}`}
            onClick={() => setTool("arrow")}
            title={tr("箭头")}
            aria-label={tr("箭头")}
          >
            <ArrowUpRight size={14} />
          </button>
        </div>
        <div className="sketch-colors">
          {COLORS.map((c) => (
            <button
              key={c}
              className={`sketch-color${color === c && tool !== "eraser" ? " active" : ""}`}
              style={{ background: c }}
              onClick={() => {
                setColor(c);
                setTool("brush");
              }}
              aria-label={`${tr("颜色")} ${c}`}
            />
          ))}
          {/* 自定义颜色：原生 color 输入，选任意色即用。 */}
          <label className="sketch-custom" title={tr("自定义颜色")}>
            <input
              type="color"
              value={/^#[0-9a-f]{6}$/i.test(color) ? color : "#ffffff"}
              onChange={(e) => {
                setColor(e.target.value);
                setTool("brush");
              }}
              aria-label={tr("自定义颜色")}
            />
          </label>
          {recent.length > 0 && (
            <>
              <span className="sketch-tool-sep" />
              {recent.slice(0, 6).map((c) => (
                <button
                  key={`r-${c}`}
                  className={`sketch-color sketch-recent${color === c && tool !== "eraser" ? " active" : ""}`}
                  style={{ background: c }}
                  onClick={() => {
                    setColor(c);
                    setTool("brush");
                  }}
                  title={tr("最近取色") + " " + c}
                  aria-label={`${tr("最近取色")} ${c}`}
                />
              ))}
            </>
          )}
        </div>
        <div className="sketch-size" title={tr("画笔粗细")}>
          <input
            className="widget-range"
            type="range"
            min={1}
            max={14}
            value={size}
            onChange={(e) => setSize(Number(e.target.value))}
          />
        </div>
        <div className="sketch-actions">
          {/* 画布背景：透明 / 网格 / 白底 / 深色 循环切换。 */}
          <button
            className={`sketch-act bg-${bgMode}`}
            title={tr("画布背景") + "：" + tr(BG_LABEL[bgMode])}
            aria-label={tr("画布背景") + "：" + tr(BG_LABEL[bgMode])}
            onClick={() => {
              const i = bgModes.indexOf(bgMode);
              update({ bgMode: bgModes[(i + 1) % bgModes.length] });
            }}
          >
            <Layers size={14} />
          </button>
          <button
            className="sketch-act"
            onClick={undo}
            title={tr("撤销") + " (Ctrl+Z)"}
            aria-label={tr("撤销") + " (Ctrl+Z)"}
            disabled={!canUndo}
          >
            <Undo2 size={14} />
          </button>
          <button
            className="sketch-act"
            onClick={redo}
            title={tr("重做") + " (Ctrl+Y)"}
            aria-label={tr("重做") + " (Ctrl+Y)"}
            disabled={!canRedo}
          >
            <Redo2 size={14} />
          </button>
          <button
            className="sketch-act"
            onClick={() => void copyImage()}
            title={tr("复制图片")}
            aria-label={tr("复制图片")}
          >
            <ClipboardCopy size={14} />
          </button>
          {isTauri() && (
            <button
              className="sketch-act"
              onClick={() => void importImage()}
              title={tr("置入图片")}
              aria-label={tr("置入图片")}
              disabled={busy}
            >
              <ImagePlus size={14} />
            </button>
          )}
          <div className="sketch-export-wrap">
            <button
              className="sketch-act"
              onClick={() => setExportOpen((v) => !v)}
              title={tr("导出图片")}
              aria-label={tr("导出图片")}
              aria-expanded={exportOpen}
            >
              <Download size={14} />
            </button>
            {exportOpen && (
              <>
                <div className="sketch-menu-mask" onClick={() => setExportOpen(false)} />
                <div className="sketch-menu">
                  <button onClick={() => doExport("png-t")}>{tr("PNG（透明）")}</button>
                  <button onClick={() => doExport("png-bg")}>{tr("PNG（含背景）")}</button>
                  <button onClick={() => doExport("jpeg")}>{tr("JPEG")}</button>
                </div>
              </>
            )}
          </div>
          <button
            className="sketch-act danger"
            onClick={clear}
            title={tr("清空")}
            aria-label={tr("清空")}
            disabled={!haveInk}
          >
            <Trash2 size={14} />
          </button>
        </div>
      </div>
      {/* 深色背景色值以 BG_FILL 为单一来源，CSS 经 --sketch-bg-dark 消费。 */}
      <div
        className={`sketch-stage bg-${bgMode}`}
        style={bgMode === "dark" ? { ["--sketch-bg-dark" as string]: BG_FILL.dark } : undefined}
      >
        <canvas
          ref={attachCanvas}
          onPointerDown={down}
          onPointerMove={move}
          onPointerUp={up}
          onPointerCancel={up}
          className={`sketch-canvas${snapFlash ? " snap-flash" : ""}`}
          onAnimationEnd={() => setSnapFlash(false)}
        />
        {copyState && (
          <div className={`sketch-toast${copyState === "fail" ? " fail" : ""}`}>
            {copyState === "ok" ? tr("已复制图片") : tr("复制失败，请重试")}
          </div>
        )}
      </div>
    </div>
  );
}
