/**
 * 风格化交互组件（无第三方依赖的轻量实现）。
 *
 * 组件与行为：
 *  - SpecularFrame
 *    选中态边框的高光沿圆周扫动，光斑角度跟随指针方向；空闲时缓慢自转。
 *    不受动效模式门控（选中框任何时候都在），仅在系统减少动态时静止。
 *  - PixelSwapBurst
 *    主题预设切换时的一波像素格涟漪（由中心向外的 stagger 缩放 + 淡出），
 *    在增强动效模式下由调用方启用。
 *  - ParticleText
 *    Canvas 2D 粒子从散点聚合成文字（许可证页 "Vela"），带指针斥力与
 *    空闲漂移。任何动效模式都渲染；减少动态时绘制静态聚合帧。
 *
 * 共享实现说明：SpecularFrame 的所有实例共用一个 rAF 循环与一个
 * document 级 pointermove 监听（注册表驱动），几十个实例也只有一份开销。
 */
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { useSettingsStore, type AnimationSpeed } from "../store/settings-store";
import { prefersReducedMotion } from "./anim";
import { useSafeTimeout } from "./use-safe-timeout";

/* ------------------------------------------------------------------ */
/* SpecularFrame：选中态边框高光                                        */
/* ------------------------------------------------------------------ */

type SpecEntry = {
  el: HTMLElement;
  angle: number;
  target: number | null;
  bright: number;
};

const specRegistry = new Set<SpecEntry>();
let specRaf = 0;
let specPointerBound = false;
/** 指针静止超过该时长即暂停自转循环（P3 三轮）：设置窗可见但无人操作时，
    空闲自转的每帧 setProperty 纯属空转。角度冻结在当前值，指针一动由
    onSpecPointerMove 恢复（新实例挂载同样恢复）。 */
const SPEC_IDLE_PAUSE_MS = 3000;
let specLastMoveAt = 0;
/** 最近一次 pointer 坐标：pointermove 只记坐标，布局读取统一在 rAF 里做
    （此前每个实例每次 move 各读一次 gBCR，几十个实例=每事件几十次强制布局）。 */
let specPx = 0;
let specPy = 0;
let specLastPx = -1;
let specLastPy = -1;

/** 指针角度 = 元素中心指向指针的方位角（conic from 以正上方为 0°）。 */
function angleToPointer(r: DOMRect, px: number, py: number): number {
  const dx = px - (r.left + r.width / 2);
  const dy = py - (r.top + r.height / 2);
  return (Math.atan2(dx, -dy) * 180) / Math.PI;
}

function specLoop(now: number, last: number) {
  /* C11 实时性：reduce-motion 命中即停表并把已挂实例静止回正（215deg 与
     挂载时 reduce 分支同值）。prefersReducedMotion() 是廉价读，热路径安全；
     解除后由下一次 pointermove 或新实例挂载重启循环。 */
  if (prefersReducedMotion()) {
    cancelAnimationFrame(specRaf);
    specRaf = 0;
    for (const entry of specRegistry) {
      entry.target = null;
      entry.el.style.setProperty("--spec-ang", "215deg");
    }
    return;
  }
  specRaf = requestAnimationFrame((t) => specLoop(t, now));
  /* 空闲暂停（P3 三轮）：指针静止超时后停表（取消刚排的下一帧），高光停在
     当前角度；恢复路径与 reduce-motion 解除相同（pointermove / 新实例挂载）。 */
  if (now - specLastMoveAt > SPEC_IDLE_PAUSE_MS) {
    cancelAnimationFrame(specRaf);
    specRaf = 0;
    return;
  }
  // 真实帧间 delta（秒）：硬编码 1/60 在高刷屏上会让自转/缓动速度成倍偏移。
  const dt = Math.min(0.1, Math.max(0.001, (now - last) / 1000));
  const moved = specPx !== specLastPx || specPy !== specLastPy;
  // 先全量读（gBCR）再全量写（setProperty）：旧实现循环体内第 i 个实例写样式
  // 后第 i+1 个实例读 gBCR，style 已脏 → 每个读都触发强制 layout flush，
  // 几十个实例 = 指针每动一帧几十次 reflow。
  const rects: DOMRect[] = [];
  if (moved) {
    for (const entry of specRegistry) rects.push(entry.el.getBoundingClientRect());
  }
  let ri = 0;
  for (const entry of specRegistry) {
    // 指针移动过的帧才重新判定邻近目标（布局读取收敛到 rAF，且仅在需要时）。
    if (moved) {
      const r = rects[ri++];
      const dx = Math.max(r.left - specPx, 0, specPx - r.right);
      const dy = Math.max(r.top - specPy, 0, specPy - r.bottom);
      const dist = Math.hypot(dx, dy);
      // 指针在元素 260px 邻近范围内才接管角度；否则回到自转。
      entry.target = dist < 260 ? angleToPointer(r, specPx, specPy) : null;
    }
    if (entry.target === null) {
      // 空闲自转：没有指针目标时每秒 24°，缓慢扫动保持「随时都在」的观感。
      entry.angle = (entry.angle + 24 * dt) % 360;
    } else {
      const diff = ((entry.target - entry.angle + 540) % 360) - 180;
      entry.angle += diff * (1 - Math.exp(-dt * 8));
    }
    entry.el.style.setProperty("--spec-ang", `${entry.angle.toFixed(2)}deg`);
  }
  if (moved) {
    specLastPx = specPx;
    specLastPy = specPy;
  }
}

function onSpecPointerMove(e: PointerEvent) {
  specPx = e.clientX;
  specPy = e.clientY;
  specLastMoveAt = performance.now();
  // reduce-motion 解除后的恢复路径：注册表还有活实例但循环已停 → 重启。
  if (!specRaf && specRegistry.size > 0 && !prefersReducedMotion()) {
    const t0 = performance.now();
    specRaf = requestAnimationFrame((t) => specLoop(t, t0));
  }
}

function bindSpecPointer() {
  if (specPointerBound) return;
  specPointerBound = true;
  document.addEventListener("pointermove", onSpecPointerMove, { passive: true });
}

function registerSpec(el: HTMLElement) {
  const entry: SpecEntry = { el, angle: Math.random() * 360, target: null, bright: 0 };
  specRegistry.add(entry);
  if (!prefersReducedMotion()) {
    bindSpecPointer();
    if (!specRaf) {
      // 新实例挂载视为一次活动：空闲暂停计时从这里重新起算，首帧自转可见。
      specLastMoveAt = performance.now();
      const t0 = performance.now();
      specRaf = requestAnimationFrame((t) => specLoop(t, t0));
    }
  }
  return () => {
    specRegistry.delete(entry);
    if (specRegistry.size === 0 && specRaf) {
      cancelAnimationFrame(specRaf);
      specRaf = 0;
    }
  };
}

/**
 * 选中框高光组件：包在任意元素内部，渲染一层随指针转向的圆周高光描边
 * （共享单 rAF 循环驱动全部实例，最后一个卸载时停表）。
 * 父元素需 position: relative（设置页卡片/分段项已具备）。
 *
 * @param thickness - 描边厚度像素，默认 1.5。
 * @returns 高光层 span（aria-hidden，纯装饰）。
 */
export function SpecularFrame({ thickness = 1.5 }: { thickness?: number }) {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!ref.current) return;
    if (prefersReducedMotion()) {
      ref.current.style.setProperty("--spec-ang", "215deg");
      return;
    }
    return registerSpec(ref.current);
  }, []);
  return (
    <span ref={ref} className="rb-spec" aria-hidden="true" style={{ "--spec-w": `${thickness}px` } as CSSProperties} />
  );
}

/* ------------------------------------------------------------------ */
/* PixelSwapBurst：预设切换像素翻牌涟漪（Canvas 2D，纯色格）              */
/* ------------------------------------------------------------------ */

/** 画布网格密度：约 20×11 格。旧实现用 144 个独立 DOM 元素各自做 3D
 *  rotateY 翻牌（=144 个活跃合成层），GPU 压力大导致卡顿。改用单张
 *  canvas，一帧内批量 fillRect 所有格子，纯色格 + 中心向外涟漪，
 * 真正做到丝滑。 */
const PX_COLS = 20;
const PX_ROWS = 11;

/** 基准动画总时长（ms，animationDuration=100 且速度=标准）。
 *  两段式：前进涟漪（撑开成纯色）+ 回退涟漪（逐格收回），自然收拢，
 *  不再用「整体淡出」收尾，避免抽帧感。 */
const PX_BASE_TOTAL = 1180;

/** 速度 → 时长倍数：animationSpeed 三档（慢/标准/快）。 */
const PX_SPEED_FACTOR = {
  slow: 1.7,
  normal: 1,
  fast: 0.55
} as const;

/** 解析 #RRGGBB / #RGB 十六进制 → [r,g,b]。 */
function parseHexColor(v: string): [number, number, number] {
  const t = v.trim();
  const m = /^#([0-9a-f]{6})$/i.exec(t);
  if (m) return [parseInt(m[1].slice(0, 2), 16), parseInt(m[1].slice(2, 4), 16), parseInt(m[1].slice(4, 6), 16)];
  const m3 = /^#([0-9a-f]{3})$/i.exec(t);
  if (m3)
    return [parseInt(m3[1][0] + m3[1][0], 16), parseInt(m3[1][1] + m3[1][1], 16), parseInt(m3[1][2] + m3[1][2], 16)];
  return [129, 212, 250];
}

/**
 * 预设切换像素翻牌涟漪组件（Canvas 2D，单张 fixed 画布批量 fillRect，
 * 合成器友好；替代旧 144 个 DOM 翻牌层方案）。
 * trigger 变化时从中心向外播放：格子立起 → 目标主题纯色（bg/bgGlow 交替
 * + accent 点缀）→ 整体淡出。
 *
 * @param trigger - 变化即触发一次涟漪的信号串（如 `${preset}|${themeMode}`）。
 * @param tokens - 目标预设 token 集（PRESETS[preset]），提供色板。
 * @returns 覆盖层 canvas（pointer-events: none，动画完自动卸载）。
 */
export function PixelSwapBurst({
  trigger,
  tokens
}: {
  trigger: string;
  /** 目标预设的 token 集（PRESETS[preset]），提供纯色色板（bg/bgGlow/accent）。 */
  tokens: { bg: string; bgGlow: string; ink: string; accent: string; paper: string; name?: string };
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const safeTimeout = useSafeTimeout();
  const [on, setOn] = useState(false);
  const [rev, setRev] = useState(0);
  const prev = useRef(trigger);
  const paletteRef = useRef([tokens.bg, tokens.bgGlow, tokens.accent, tokens.bgGlow]);

  useEffect(() => {
    // 目标预设变了的瞬间就要翻到「下一个样式」，所以这里不等 state 广播，
    // 直接同步取最新 tokens 作为新色板。
    paletteRef.current = [tokens.bg, tokens.bgGlow, tokens.accent, tokens.bgGlow];
  }, [tokens]);

  useEffect(() => {
    if (prev.current === trigger) return;
    prev.current = trigger;
    setOn(true);
    setRev((r) => r + 1);
    // 动画时长随速度设置缩放；timeout 略留余量（多 8%）确保不提前卸载。
    const ex = useSettingsStore.getState().extra;
    const total = pxTotalMs(ex);
    safeTimeout(() => setOn(false), total * 1.08);
  }, [trigger, safeTimeout]);

  useEffect(() => {
    if (!on) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const resize = () => {
      canvas.width = Math.round(window.innerWidth * dpr);
      canvas.height = Math.round(window.innerHeight * dpr);
    };
    resize();
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const cw = window.innerWidth;
    const ch = window.innerHeight;
    const cellW = cw / PX_COLS;
    const cellH = ch / PX_ROWS;
    const cx = cw / 2;
    const cy = ch / 2;

    // 速度：animationDuration(50–200%) × animationSpeed 档位，缩放整条时间轴。
    const f = pxTimeFactor(useSettingsStore.getState().extra);
    const FWD = 240 * f; // 单格「翻过去」
    const REC = 240 * f; // 单格「翻回来」
    const HOLD = 180 * f; // 停留纯色块的间隙
    const SPREAD = 500 * f; // 涟漪由内向外的最大错开

    // 每个格子的静态相位数据：相对中心的波前错开 + 回收错开 + 纯色。
    type Cell = { x: number; y: number; spread: number; rgb: [number, number, number] };
    const cells: Cell[] = [];
    for (let r = 0; r < PX_ROWS; r++) {
      for (let c = 0; c < PX_COLS; c++) {
        const gx = (c + 0.5) * cellW;
        const gy = (r + 0.5) * cellH;
        const dist = Math.hypot(gx - cx, gy - cy) / Math.hypot(cw, ch);
        const k = (r * 13 + c * 7) % paletteRef.current.length;
        // 中心先翻、向外扩散；平方让波纹更集中、更「丝滑」的波前推进。
        cells.push({
          x: gx,
          y: gy,
          spread: dist * dist * SPREAD,
          rgb: parseHexColor(paletteRef.current[k])
        });
      }
    }

    const start = performance.now();
    let raf = 0;
    /* raf: ok 爆闪一次性动画，done 即停 */
    const loop = (now: number) => {
      const t = now - start;
      ctx.clearRect(0, 0, cw, ch);
      let done = true;
      for (const cell of cells) {
        // 时间轴：翻过去 → 保持纯色 → 翻回来（逐格收回，不整体淡出）。
        const fwdEnd = cell.spread + FWD;
        const recStart = fwdEnd + HOLD;
        const recEnd = recStart + REC;
        if (t >= recEnd) continue; // 已翻回来，不再绘制（不阻塞完成判定）
        done = false; // 只要还有格子处于绘制期就继续循环

        let w: number;
        let a: number;
        let flash: number;
        if (t <= fwdEnd) {
          // 翻过去：scaleX 1→0→1（立起又躺平成新色块），翻转瞬间高光爆闪。
          const p = (t - cell.spread) / FWD;
          const sxp = Math.abs(Math.cos(p * Math.PI));
          w = Math.max(0.5, cellW * sxp);
          a = Math.min(1, p * 7);
          flash = 1 + (1 - sxp) * 0.55;
        } else if (t <= recStart) {
          // 保持：整块实心纯色短暂停顿。
          w = cellW;
          a = 1;
          flash = 1;
        } else {
          // 翻回来：scaleX 1→0 收回成一条线淡出，形成与前进呼应的涟漪。
          const p = (t - recStart) / REC;
          const sxp = 1 - p;
          w = Math.max(0.5, cellW * sxp);
          a = Math.max(0, 1 - p);
          flash = 1 + p * 0.2;
        }
        const [rr, gg, bb] = cell.rgb;
        ctx.globalAlpha = a;
        ctx.fillStyle = `rgb(${Math.min(255, Math.round(rr * flash))},${Math.min(
          255,
          Math.round(gg * flash)
        )},${Math.min(255, Math.round(bb * flash))})`;
        ctx.fillRect(cell.x - w / 2, cell.y - cellH / 2, w, cellH);
      }
      ctx.globalAlpha = 1;
      if (!done) raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);

    window.addEventListener("resize", resize);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
    };
  }, [on, rev]);

  if (!on) return null;
  return <canvas ref={canvasRef} className="rb-px-swap" aria-hidden="true" />;
}

/** 结合里里外外的速度设置，导出本帧像素动画的时长换算系数。 */
function pxTimeFactor(ex: { animationDuration: number; animationSpeed: AnimationSpeed }): number {
  const dur = (ex.animationDuration ?? 100) / 100;
  const speed = PX_SPEED_FACTOR[ex.animationSpeed ?? "normal"] ?? 1;
  return Math.max(0.4, dur * speed);
}

/** 估算整段动画总时长（用于卸载 canvas）。 */
function pxTotalMs(ex: { animationDuration: number; animationSpeed: AnimationSpeed }): number {
  const f = pxTimeFactor(ex);
  return PX_BASE_TOTAL * (f / 1.0);
}

/* ------------------------------------------------------------------ */
/* ParticleText：粒子聚合成文字                                         */
/* ------------------------------------------------------------------ */

type Particle = {
  x: number;
  y: number;
  tx: number;
  ty: number;
  sx: number;
  sy: number;
  delay: number;
  seed: number;
  depth: number;
};

/**
 * 粒子文字组件：文字栅格化采样为粒子，散点 → 逐粒（错峰）聚合成 `text`；
 * 聚合完成后进入空闲漂移 + 指针斥力的呼吸态。单 canvas + 单 rAF 循环，
 * reduce-motion 直接绘制聚合完成静态帧（不排动画）。
 *
 * @param text - 要呈现的文本。
 * @param className - 追加到画布容器的类名。
 * @param height - 画布高度 px，默认 150。
 * @param fontSize - 采样字号 px，默认 92。
 * @param particle - 粒子间距系数（越小粒子越多），默认 1.6。
 * @param density - 采样密度步长，默认 4。
 * @param scatter - 初始散布半径 px，默认 170。
 * @param gatherDuration - 聚合时长 ms，默认 1500。
 * @param stagger - 粒子间最大延迟 ms（错峰入场），默认 500。
 * @param repelRadius - 指针斥力半径 px，默认 90。
 * @param accent - 可选主色（覆盖默认前景色）。
 * @param highlight - 可选高亮色。
 * @returns 粒子画布。
 */
export function ParticleText({
  text,
  className,
  height = 150,
  fontSize = 92,
  particle = 1.6,
  density = 4,
  scatter = 170,
  gatherDuration = 1500,
  stagger = 500,
  repelRadius = 90,
  accent,
  highlight
}: {
  text: string;
  className?: string;
  height?: number;
  fontSize?: number;
  particle?: number;
  density?: number;
  scatter?: number;
  gatherDuration?: number;
  stagger?: number;
  repelRadius?: number;
  accent?: string;
  highlight?: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const cs = getComputedStyle(document.documentElement);
    const accentColor = accent || cs.getPropertyValue("--accent").trim() || "#81d4fa";
    const highlightColor = highlight || cs.getPropertyValue("--accent-2").trim() || accentColor;
    const parseColor = (v: string): [number, number, number] => {
      const m = /^#([0-9a-f]{6})$/i.exec(v.trim());
      if (m) return [parseInt(m[1].slice(0, 2), 16), parseInt(m[1].slice(2, 4), 16), parseInt(m[1].slice(4, 6), 16)];
      const m2 = /^#([0-9a-f]{3})$/i.exec(v.trim());
      if (m2)
        return [
          parseInt(m2[1][0] + m2[1][0], 16),
          parseInt(m2[1][1] + m2[1][1], 16),
          parseInt(m2[1][2] + m2[1][2], 16)
        ];
      return [129, 212, 250];
    };
    const cA = parseColor(accentColor);
    const cB = parseColor(highlightColor);

    let particles: Particle[] = [];
    let raf = 0;
    let start = 0;
    let alive = true;
    const pointer = { x: -9999, y: -9999 };

    /** 离屏采样文字像素 → 目标点位（步长 density，粒子上限保护）。 */
    const sample = (w: number, h: number): { x: number; y: number; depth: number }[] => {
      const off = document.createElement("canvas");
      off.width = Math.max(1, Math.floor(w));
      off.height = Math.max(1, Math.floor(h));
      const octx = off.getContext("2d");
      if (!octx) return [];
      const size = Math.min(fontSize, h * 0.86, w / Math.max(2.2, text.length * 0.62));
      octx.font = `800 ${size}px ${cs.getPropertyValue("--ui-font") || "sans-serif"}`;
      octx.textAlign = "center";
      octx.textBaseline = "middle";
      octx.fillStyle = "#fff";
      octx.fillText(text, w / 2, h / 2);
      const data = octx.getImageData(0, 0, off.width, off.height).data;
      const pts: { x: number; y: number; depth: number }[] = [];
      for (let y = 0; y < off.height; y += density) {
        for (let x = 0; x < off.width; x += density) {
          if (data[(y * off.width + x) * 4 + 3] > 128) {
            pts.push({ x, y, depth: Math.random() });
          }
        }
      }
      return pts;
    };

    const build = () => {
      const rect = canvas.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = Math.max(1, rect.width);
      const h = Math.max(1, rect.height);
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const targets = sample(w, h);
      particles = targets.map((t) => {
        const angle = Math.random() * Math.PI * 2;
        const dist = scatter * (0.35 + t.depth * 0.75);
        return {
          tx: t.x,
          ty: t.y,
          x: t.x + Math.cos(angle) * dist,
          y: t.y + Math.sin(angle) * dist,
          sx: 0,
          sy: 0,
          delay: Math.random() * stagger,
          seed: Math.random(),
          depth: t.depth
        };
      });
      start = performance.now();
    };

    const drawFrame = (now: number) => {
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      ctx.clearRect(0, 0, w, h);
      const elapsed = now - start;
      // P-perf：reduced-motion 双信号查询（DOM 属性 + MQL.matches）原在
      // 粒子循环体内逐粒子调用（3 次/粒子/帧，2000 粒 = 6000 次读 DOM/帧），
      // 提升为每帧一次——偏好变化最早也要下一帧才被感知，语义不变。
      const reduced = prefersReducedMotion();
      const n = particles.length;
      for (let i = 0; i < n; i++) {
        const p = particles[i];
        const t = reduced ? 1 : Math.min(1, Math.max(0, (elapsed - p.delay) / gatherDuration));
        const eased = 1 - Math.pow(1 - t, 3);
        // 聚合插值 + 空闲漂移（聚合完成后小幅呼吸）。
        const drift = reduced ? 0 : Math.min(1, t) * 1;
        const dx = Math.sin(now / 900 + p.seed * 40) * 1.6 * drift;
        const dy = Math.cos(now / 1100 + p.seed * 60) * 1.6 * drift;
        let x = p.sx + (p.tx - p.sx) * eased + dx;
        let y = p.sy + (p.ty - p.sy) * eased + dy;
        if (t >= 1 && !reduced) {
          p.sx = p.tx;
          p.sy = p.ty;
          x = p.tx + dx;
          y = p.ty + dy;
          // 指针斥力：范围内的粒子被推开（软衰减）。
          const rdx = x - pointer.x;
          const rdy = y - pointer.y;
          const dist = Math.hypot(rdx, rdy);
          if (dist < repelRadius && dist > 0.01) {
            const force = (1 - dist / repelRadius) ** 2 * 26;
            x += (rdx / dist) * force;
            y += (rdy / dist) * force;
          }
        } else {
          p.sx = p.x;
          p.sy = p.y;
        }
        p.x = x;
        p.y = y;
        // 深度混色：accent → highlight，前景粒子更亮。
        const mixT = p.depth;
        const r = Math.round(cA[0] + (cB[0] - cA[0]) * mixT);
        const g = Math.round(cA[1] + (cB[1] - cA[1]) * mixT);
        const b = Math.round(cA[2] + (cB[2] - cA[2]) * mixT);
        ctx.fillStyle = `rgb(${r},${g},${b})`;
        const size = particle * (0.75 + mixT * 0.5);
        ctx.fillRect(x - size / 2, y - size / 2, size, size);
      }
    };

    const loop = (now: number) => {
      if (!alive) return;
      if (!document.hidden) drawFrame(now);
      raf = requestAnimationFrame(loop);
    };

    build();
    if (prefersReducedMotion()) {
      drawFrame(performance.now());
    } else {
      raf = requestAnimationFrame(loop);
    }

    const onMove = (e: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      pointer.x = e.clientX - rect.left;
      pointer.y = e.clientY - rect.top;
    };
    const onLeave = () => {
      pointer.x = -9999;
      pointer.y = -9999;
    };
    canvas.addEventListener("pointermove", onMove, { passive: true });
    canvas.addEventListener("pointerleave", onLeave);

    let resizeTimer = 0;
    const ro = new ResizeObserver(() => {
      window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(() => {
        if (!alive) return;
        build();
        if (prefersReducedMotion()) drawFrame(performance.now());
      }, 160);
    });
    ro.observe(canvas);

    return () => {
      alive = false;
      cancelAnimationFrame(raf);
      ro.disconnect();
      window.clearTimeout(resizeTimer);
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerleave", onLeave);
    };
  }, [text, height, fontSize, particle, density, scatter, gatherDuration, stagger, repelRadius, accent, highlight]);

  return (
    <canvas
      ref={canvasRef}
      className={className ? `rb-particle-text ${className}` : "rb-particle-text"}
      style={{ height }}
      role="img"
      aria-label={text}
    />
  );
}
