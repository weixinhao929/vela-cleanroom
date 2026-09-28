/**
 * 主题切换水墨过渡（#77 后继方案）：滴墨晕开。
 *
 * 点击发起的主题切换（预设 / 明暗模式 / 主色）不再做 token 硬切或交叉
 * 淡化，而是从点击落点落下一滴「目标主题底色」的墨，以有机毛边向外晕开
 * 吞没整个设置窗；覆盖满的瞬间回放 applySettings 完成真正换肤，最后留一
 * 圈主色「吸墨沉降」淡晕收尾。
 *
 * 协作时序（与 settings-store / theme-engine 的关系）：
 *  1. StylePage 的点击 handler 先 `armThemeInk()` 记录意图（含最近点击
 *     落点），再调 store setter；
 *  2. commit 后 StylePage effect 消费武装（consumeThemeInkArm），调
 *     theme-engine 的 deferNextThemeApply() 拦下本次 SettingsSync 的即时
 *     applySettings（否则 token 先行硬切，晕开只剩装饰）；
 *  3. playThemeInk 起墨：覆盖满时回调 onCovered → 调用方回放 applySettings
 *     完成换肤 → 沉降淡出后移除画布。
 * 非点击路径（跨窗口同步、系统明暗跟随、兜底）无武装 → 主题即时生效。
 *
 * 纯 DOM/Canvas 实现，不依赖 React；画布挂在 .tm-settings-window 内，
 * 过渡范围即「设置全页面」。prefers-reduced-motion 或引擎不可用时
 * playThemeInk 返回 false，调用方兜底立即上色。
 */

/** 武装记录：点击落点（视口坐标）+ 时间戳（过期防串扰）。 */
interface InkArm {
  x: number;
  y: number;
  at: number;
}

const ARM_TTL_MS = 2500;

let arm: InkArm | null = null;
let pointerListenerInstalled = false;
let lastPointer: { x: number; y: number } | null = null;

/** 记录最近一次点击落点（惰性安装一次 document 级监听）。 */
function ensurePointerListener(): void {
  if (pointerListenerInstalled || typeof document === "undefined") return;
  pointerListenerInstalled = true;
  document.addEventListener(
    "pointerdown",
    (e) => {
      lastPointer = { x: e.clientX, y: e.clientY };
    },
    { passive: true, capture: true }
  );
}

/**
 * 武装一次主题水墨过渡：由主题切换的点击 handler 在调用 store setter
 * 前调用。落点取最近一次 pointerdown（键盘触发时可能无落点，消费方
 * 回退为容器中心）。
 */
export function armThemeInk(): void {
  ensurePointerListener();
  arm = lastPointer ? { x: lastPointer.x, y: lastPointer.y, at: Date.now() } : { x: -1, y: -1, at: Date.now() };
}

/** 只读窥视是否有未消费的武装（渲染期抑制并行动效，如 PixelSwap）。 */
export function peekThemeInkArmed(): boolean {
  return arm !== null && Date.now() - arm.at <= ARM_TTL_MS;
}

/**
 * 消费武装（一次性）。过期（>2.5s）视为无武装，避免陈旧落点把无关的
 * 主题变化（跨窗同步回放等）也渲染成晕开。
 *
 * @returns 点击落点（视口坐标）；x=-1 表示无落点（键盘触发），消费方
 *          回退容器中心。无武装返回 null。
 */
export function consumeThemeInkArm(): { x: number; y: number } | null {
  const cur = arm;
  arm = null;
  if (!cur || Date.now() - cur.at > ARM_TTL_MS) return null;
  return { x: cur.x, y: cur.y };
}

/* ------------------------------------------------------------------ */
/* 墨形绘制                                                             */
/* ------------------------------------------------------------------ */

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);

/** #hex → [r,g,b]；非法输入返回 null（调用方回退预设色）。 */
function hexRgb(hex: string): [number, number, number] | null {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const h = m[1];
  const full =
    h.length === 3
      ? h
          .split("")
          .map((c) => c + c)
          .join("")
      : h;
  const n = parseInt(full, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** 两种 hex 色按 t 插值（墨缘 = 底色掺墨的沉积色）。 */
function mixHex(a: string, b: string, t: number): string {
  const A = hexRgb(a) ?? hexRgb("#000000")!;
  const B = hexRgb(b) ?? hexRgb("#ffffff")!;
  return `rgb(${A.map((v, i) => Math.round(v + (B[i] - v) * t)).join(",")})`;
}

function rgbaOf(hex: string, a: number): string {
  const [r, g, b] = hexRgb(hex) ?? [0, 0, 0];
  return `rgba(${r},${g},${b},${a})`;
}

/** 墨团极值毛边：多频正弦扰动半径（相位缓移模拟墨的流动）。 */
function edgeRadius(th: number, base: number, amp: number, ph: { a: number; b: number; c: number }): number {
  return (
    base * amp * (Math.sin(3 * th + ph.a) * 0.55 + Math.sin(7 * th + ph.b) * 0.3 + Math.sin(13 * th + ph.c) * 0.15)
  );
}

export interface ThemeInkColors {
  /** 目标主题底色（墨身）。 */
  bg: string;
  /** 目标主题文字色（与底色调配出墨缘沉积色）。 */
  ink: string;
  /** 目标主色（润染光晕与吸墨沉降）。 */
  accent: string;
}

export interface ThemeInkOptions {
  /** 挂画布的容器（.tm-settings-window；需可定位，见 settings.css）。 */
  container: HTMLElement;
  /** 容器局部坐标的墨源点。 */
  origin: { x: number; y: number };
  colors: ThemeInkColors;
  /** 设置窗不透明度（0-1）：画布整体 alpha 跟随，避免实墨盖在半透窗上。 */
  opacity?: number;
  /** 覆盖满整窗的瞬间回调（此处回放 applySettings 换肤）。 */
  onCovered: () => void;
  /** 过渡完全结束（沉降淡出、画布移除）后的回调。 */
  onDone?: () => void;
}

/**
 * 播放滴墨晕开。同步完成画布装配并启动 rAF；环境不支持（无 2d 上下文、
 * 减少动态）时返回 false，调用方应兜底立即应用主题。
 * 允许与上一场墨重叠播放（各自独立画布，后挂者在上层）：互斥会让快速
 * 连续切换主题时后半段全部退化为瞬切（用户反馈「有时候不出动画」）；
 * 上一场此时多已进入沉降淡出，重叠视觉自然。
 *
 * @returns true 表示已接管本次主题切换的上色时机。
 */
export function playThemeInk(opts: ThemeInkOptions): boolean {
  if (typeof window === "undefined" || typeof document === "undefined") return false;
  // 双信号守卫收进函数本体：OS 偏好 + 应用内「减少动态」开关（此前只查 OS，
  // 应用内开关依赖调用方自觉补查——守卫缺失即漏网）。
  if (window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches) return false;
  if (document.documentElement.getAttribute("data-reduce-motion") === "1") return false;

  const { container, origin, colors, onCovered, onDone } = opts;
  const rect = container.getBoundingClientRect();
  if (rect.width < 8 || rect.height < 8) return false;
  const canvas = document.createElement("canvas");
  const ctxOrNull = canvas.getContext("2d");
  if (!ctxOrNull) return false;
  // 起一个非空别名将窄化固化下来：提升的 function 声明（frame/settle）里
  // TS 不会沿用上方 if 收窄。
  const ctx: CanvasRenderingContext2D = ctxOrNull;

  const dpr = clamp(window.devicePixelRatio || 1, 1, 2);
  const W = rect.width;
  const H = rect.height;
  canvas.width = Math.round(W * dpr);
  canvas.height = Math.round(H * dpr);
  canvas.style.position = "absolute";
  canvas.style.inset = "0";
  canvas.style.width = "100%";
  canvas.style.height = "100%";
  canvas.style.borderRadius = "inherit";
  canvas.style.pointerEvents = "none";
  canvas.style.zIndex = "9999";
  canvas.style.opacity = String(clamp(opts.opacity ?? 1, 0, 1));
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  container.appendChild(canvas);

  /* 墨色：身 = 目标底色，缘 = 底色掺墨（边缘沉积更深），晕 = 新主色。 */
  const body = colors.bg;
  const rim = mixHex(colors.bg, colors.ink, 0.3);
  const halo = hexRgb(colors.accent) ? colors.accent : colors.ink;

  /* 覆盖半径与时长：墨缘须漫过最远的窗角。时长放慢（用户反馈偏快），
     缓动 easeOutCubic 前快后慢，网格覆盖检测（见下）保证真正盖满即换肤，
     不空等缓动尾段。 */
  const corners: [number, number][] = [
    [0, 0],
    [W, 0],
    [0, H],
    [W, H]
  ];
  const maxCorner = Math.max(...corners.map(([cx, cy]) => Math.hypot(cx - origin.x, cy - origin.y)));
  const rFinal = maxCorner * 1.02 + 16;
  const duration = clamp(950 + rFinal * 0.38, 1250, 1700);
  const settleMs = 500;

  /* 卫星飞溅墨点：骑在主墨缘前后的窄带内绽开、被吞没。 */
  const satellites = Array.from({ length: 9 }, () => {
    const ang = Math.random() * Math.PI * 2;
    return {
      ang,
      dist: rFinal * (0.5 + Math.random() * 0.47),
      r: 5 + Math.random() * 17,
      ph: { a: Math.random() * 7, b: Math.random() * 7, c: Math.random() * 7 }
    };
  });

  const phase = { a: Math.random() * 7, b: Math.random() * 7, c: Math.random() * 7 };
  const supportsFilter = (() => {
    ctx.save();
    ctx.filter = "blur(2px)";
    const ok = ctx.filter === "blur(2px)";
    ctx.restore();
    ctx.filter = "none";
    return ok;
  })();

  function blobPath(g: CanvasRenderingContext2D, x: number, y: number, r: number, amp: number, ph: typeof phase): void {
    g.save();
    g.translate(x, y);
    g.beginPath();
    const N = 150;
    for (let i = 0; i <= N; i++) {
      const th = (i / N) * Math.PI * 2;
      const r2 = r * (1 + edgeRadius(th, 1, amp, ph));
      const px = Math.cos(th) * r2;
      const py = Math.sin(th) * r2;
      if (i === 0) g.moveTo(px, py);
      else g.lineTo(px, py);
    }
    g.closePath();
    g.restore();
  }

  let startTs: number | null = null;
  let rafId = 0;
  let covered = false;
  let finished = false;

  /** 换肤只回放一次（覆盖检测、兜底、failSafe 竞态下保持幂等）。 */
  const coverOnce = (): void => {
    if (covered) return;
    covered = true;
    onCovered();
  };

  const cleanup = (): void => {
    if (finished) return;
    finished = true;
    canvas.remove();
    onDone?.();
  };

  /* 首帧看门狗：窗口被遮挡 / 渲染被节流时 rAF 可能长时间不来帧——墨层
     一直空挂、主题迟迟不上色（用户观感即「不出动画」）。600ms 仍无首帧
     就放弃播放：立即上色并静默撤掉画布，让主题切换永不迟于即时路径。 */
  window.setTimeout(() => {
    if (startTs === null) {
      cancelAnimationFrame(rafId);
      coverOnce();
      cleanup();
    }
  }, 600);

  /* raf: ok 换肤水墨一次性动画（isConnected 看门狗 + 总保险兜底） */
  function frame(ts: number): void {
    /* 容器被卸载（窗口关闭 / 页面切走）：直接换肤兜底，不再渲染。 */
    if (!container.isConnected) {
      coverOnce();
      cleanup();
      return;
    }
    if (startTs === null) startTs = ts;
    const el = ts - startTs;
    const p = clamp(el / duration, 0, 1);
    const r = Math.max(2, rFinal * easeOutCubic(p));
    /* 毛边绝对幅度随扩散略收敛（越摊越平），相位缓移。 */
    const amp = (0.085 - 0.035 * p) * clamp(90 / r, 0.5, 1);
    phase.a += 0.012;
    phase.b += 0.019;
    phase.c += 0.026;

    ctx.clearRect(0, 0, W, H);

    /* 落墨冲击：起手 130ms 的接触晕。 */
    if (el < 130) {
      const q = el / 130;
      ctx.save();
      ctx.globalAlpha = 0.5 * (1 - q);
      ctx.strokeStyle = rim;
      ctx.lineWidth = 2 - q;
      ctx.beginPath();
      ctx.arc(origin.x, origin.y, 8 + q * 30, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }

    /* 润染光晕（主色极淡渗入纸纤维）+ 软过渡层 + 墨身 + 墨缘沉积。 */
    ctx.save();
    blobPath(ctx, origin.x, origin.y, r * 1.14, amp * 1.7, phase);
    if (supportsFilter) ctx.filter = "blur(20px)";
    ctx.globalAlpha = 0.1;
    ctx.fillStyle = halo;
    ctx.fill();
    ctx.restore();
    ctx.save();
    blobPath(ctx, origin.x, origin.y, r * 1.06, amp * 1.3, phase);
    if (supportsFilter) ctx.filter = "blur(10px)";
    ctx.globalAlpha = 0.28;
    ctx.fillStyle = body;
    ctx.fill();
    ctx.restore();
    ctx.save();
    blobPath(ctx, origin.x, origin.y, r, amp, phase);
    ctx.globalAlpha = 1;
    ctx.fillStyle = body;
    ctx.fill();
    ctx.restore();
    ctx.save();
    blobPath(ctx, origin.x, origin.y, r, amp, phase);
    if (supportsFilter) ctx.filter = "blur(5px)";
    ctx.globalAlpha = 0.18;
    ctx.strokeStyle = rim;
    ctx.lineWidth = 12;
    ctx.stroke();
    ctx.restore();
    ctx.save();
    blobPath(ctx, origin.x, origin.y, r, amp, phase);
    ctx.globalAlpha = 0.55;
    ctx.strokeStyle = rim;
    ctx.lineWidth = 2.6;
    ctx.stroke();
    ctx.restore();

    /* 卫星墨点：只在墨缘经过其位置前后的窄带内可见。 */
    for (const s of satellites) {
      const appear = clamp((r - (s.dist - s.r * 12)) / (s.r * 7), 0, 1);
      const cover = clamp(1 - (r - s.dist - s.r) / (s.r * 7), 0, 1);
      const alpha = 0.95 * Math.min(appear, cover);
      if (alpha <= 0.01) continue;
      const sx = origin.x + Math.cos(s.ang) * s.dist;
      const sy = origin.y + Math.sin(s.ang) * s.dist;
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.fillStyle = body;
      ctx.beginPath();
      ctx.arc(sx, sy, s.r * (0.55 + 0.45 * appear), 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = alpha * 0.5;
      ctx.strokeStyle = rim;
      ctx.lineWidth = 1.4;
      ctx.stroke();
      ctx.restore();
    }

    /* 覆盖检测：抽样点全部落入墨缘（含 12px 外扩余量）即换肤，不等缓动尾段。 */
    let coveredNow = true;
    probe: for (let gx = 0; gx <= 4; gx++) {
      for (let gy = 0; gy <= 3; gy++) {
        const x = (W * gx) / 4;
        const y = (H * gy) / 3;
        const dist = Math.hypot(x - origin.x, y - origin.y);
        if (dist > r * 1.25) {
          coveredNow = false;
          break probe;
        }
        const th = Math.atan2(y - origin.y, x - origin.x);
        if (dist > r * (1 + edgeRadius(th, 1, amp, phase)) + 12) {
          coveredNow = false;
          break probe;
        }
      }
    }

    if (!coveredNow && p < 1) {
      rafId = requestAnimationFrame(frame);
      return;
    }

    /* 全覆盖：换肤，随后画布只剩一圈主色「吸墨沉降」淡晕渐隐。 */
    coverOnce();
    const settleStart = performance.now();
    const settle = (now: number): void => {
      if (!container.isConnected || finished) return;
      const q = clamp((now - settleStart) / settleMs, 0, 1);
      ctx.clearRect(0, 0, W, H);
      const gr = ctx.createRadialGradient(origin.x, origin.y, 0, origin.x, origin.y, Math.max(W, H) * 0.7);
      gr.addColorStop(0, rgbaOf(halo, 0.085 * (1 - q)));
      gr.addColorStop(1, rgbaOf(halo, 0));
      ctx.fillStyle = gr;
      ctx.fillRect(0, 0, W, H);
      if (q < 1) rafId = requestAnimationFrame(settle);
      else cleanup();
    };
    rafId = requestAnimationFrame(settle);
  }

  rafId = requestAnimationFrame(frame);
  /* 总保险：正常播放此计时器到期前早已自然收尾；播放中途 rAF 停摆（遮挡 /
     节流）时据此在最迟时长+500ms 处强制换肤撤画布，不让主题迟到。 */
  window.setTimeout(() => {
    cancelAnimationFrame(rafId);
    coverOnce();
    cleanup();
  }, duration + 500);
  return true;
}
