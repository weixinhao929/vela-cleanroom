/**
 * 系统音频可视化小组件：Web Audio AnalyserNode 频谱 + Canvas 2D 柱状渲染。
 * 性能设计：Float32Array 复用、DPR 缓存、主题色低频刷新、空闲降帧 15fps、
 * 页面隐藏停绘、reduce-motion 静帧；设备切换经 Rust 枚举事件驱动。
 */
import { useEffect, useReducer, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { Volume2, VolumeX } from "lucide-react";
import { invoke, isTauri } from "../../lib/tauri";
import { useTauriEvent } from "../../lib/use-tauri-event";
import { prefersReducedMotion } from "../../lib/anim";
import { coveredTickGate } from "../../lib/use-covered";
import { animDurations } from "../../lib/durations";
import { useT } from "../../i18n-lite";

/* （多实例参数互踩）：Rust 采集线程是全局单管线（同参共享、异参换代重拉，
 * ），两个可视化实例配不同 mode/dist 时后启动者会顶掉先前的口径，先前
 * 的订阅者收到的是别人口径的频谱。前端把 mode/dist 收敛为窗口级共享参数：
 * 最后挂载/改配置的实例生效，全部实例跟随（口径全局一致，不再互踩）。 */
type AudioParams = { mode: AudioSourceMode; dist: BandDistMode };
const audioParamsByInstance = new Map<object, AudioParams>();
const audioParamListeners = new Set<() => void>();
function currentAudioParams(): AudioParams | null {
  let last: AudioParams | null = null;
  for (const p of audioParamsByInstance.values()) last = p;
  return last;
}

/**
 * 音频监控小组件的实时频谱可视化。
 *
 * 数据链路：Rust 侧 WASAPI 环回采集线程以 ~30fps 推送 64 个频带
 * （audio:spectrum 事件，已做过快攻慢放包络），前端在 rAF 里再插值一层
 * （上升快、下降慢），两级平滑叠加出连续丝滑的动画。
 *
 * 样式（visualStyle / 扩展）：
 *  - bars 经典渐变圆头条 + 底部倒影
 *  - wave 平滑曲线 + 渐变填充
 *  - mirror 中轴上下对称生长的条
 *  - minimal 细线极简点
 *  - radial 环形放射频谱（中心圆随音量脉动）
 *  - butterfly 蝴蝶双翼（左右对称、上下呼应，Rainmeter 皮肤风）
 *
 * 可调参数（/124/125/127）：
 *  - bandCount 前端把 64 频带重采样为 16–96 根（取区间峰值，宽窄卡片皆宜）
 *  - peakHold 峰值保持：每根上方一条缓慢下落的帽线（专业频谱表语言）
 *  - colorMode theme 跟随主题 / mono 单色 / rainbow 彩虹渐变
 *  - gain 灵敏度（0.5–3）：小音量场景把频谱"抬"起来
 *  - smoothing 平滑度（0–1）：替换绘制循环里的硬编码插值系数
 *  - dist 频带分布 log（音乐）/ linear（语音），传给 Rust 重建分带
 *
 * 主题自适应：颜色取自 --accent / --accent-2 / --ink（每 400ms 刷新缓存），
 * 跟随全局预设与主色实时变化；空闲（无声/非 Tauri）时播放低幅呼吸动画。
 */

export type VisualStyle = "bars" | "wave" | "mirror" | "minimal" | "radial" | "butterfly";
export type BandColorMode = "theme" | "mono" | "rainbow";
export type BandDistMode = "log" | "linear";

/** Rust 侧固定推送的频带数；前端按 bandCount 重采样。 */
const SOURCE_BANDS = 64;

type ThemeColors = {
  accent: string;
  accent2: string;
  ink: string;
};

function readTheme(): ThemeColors {
  const cs = getComputedStyle(document.documentElement);
  // 只接受真正的颜色字面量：解析出 inherit/initial/var() 之类的值时回退默认色，
  // 否则 addColorStop/.strokeStyle 会抛 SyntaxError 并杀死整个 rAF 循环。
  const looksLikeColor = (v: string) =>
    /^(#[0-9a-f]{3,8}|rgba?\(|hsla?\(|oklch\(|oklab\(|lab\(|lch\(|color\(|color-mix\()/i.test(v);
  const v = (name: string, fallback: string) => {
    const val = cs.getPropertyValue(name).trim();
    return looksLikeColor(val) ? val : fallback;
  };
  return {
    accent: v("--accent", "#7c8cf8"),
    accent2: v("--accent-2", "#4fc3f7"),
    ink: v("--ink", "#1f2430")
  };
}

/* 主题色缓存（模块级共享）：绘制每帧读 computed style 代价高，定时
 * 400ms 刷新；窗口隐藏停表（绘制循环本就 hidden 早退，别让 getComputedStyle
 * 空转），恢复可见立即重读一次再续表。多实例共享一份表——此前每实例一个
 * 定时器 + 一对 visibilitychange 监听。监听装好后常驻（模块级单例语义）。 */
let sharedTheme: ThemeColors | null = null;
let sharedThemeTimer = 0;
let sharedThemeVisInstalled = false;

function getSharedTheme(): ThemeColors {
  if (sharedTheme === null) sharedTheme = readTheme();
  if (!sharedThemeVisInstalled) {
    sharedThemeVisInstalled = true;
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) {
        if (sharedThemeTimer !== 0) {
          window.clearInterval(sharedThemeTimer);
          sharedThemeTimer = 0;
        }
      } else {
        sharedTheme = readTheme();
        ensureSharedThemeTimer();
      }
    });
  }
  ensureSharedThemeTimer();
  return sharedTheme;
}

function ensureSharedThemeTimer(): void {
  if (sharedThemeTimer !== 0 || document.hidden) return;
  sharedThemeTimer = window.setInterval(() => {
    sharedTheme = readTheme();
  }, 400);
}

export type AudioSourceMode = "playback" | "microphone" | "both";

export function AudioVisualizer({
  style = "bars",
  height = 64,
  mode = "playback",
  colorMode = "theme",
  gain = 1,
  smoothing = 0.5,
  bandCount = 64,
  peakHold = false,
  dist = "log"
}: {
  style?: VisualStyle;
  /** 画布高度：px 数字或 CSS 高度（如 "100%"，由外层容器决定实际高度）。 */
  height?: number | string;
  mode?: AudioSourceMode;
  colorMode?: BandColorMode;
  gain?: number;
  smoothing?: number;
  bandCount?: number;
  peakHold?: boolean;
  dist?: BandDistMode;
}) {
  const tr = useT();
  const canvasRef = useRef<HTMLCanvasElement>(null);

  /** 绘制循环实时读取的最新参数（gain 等微调不重启 Rust 采集管线）。 */
  const liveRef = useRef({ style, colorMode, gain, smoothing, peakHold, bandCount });
  liveRef.current = { style, colorMode, gain, smoothing, peakHold, bandCount };

  /* 共享参数注册：本实例配置变化/挂载 → 写入注册表并广播；卸载 → 摘除并
   * 广播（回落到最后一个存活实例的口径）。eff* 供采集管线使用。 */
  const instanceKeyRef = useRef<object>({});
  const [, bumpAudioParams] = useReducer((x: number) => x + 1, 0);
  useEffect(() => {
    const key = instanceKeyRef.current;
    // 先 delete 再 set：Map 更新既有键不改变插入顺序，「最后挂载/改配置的
    // 实例生效」在改配置方向会失灵（先挂载的实例改 mode 仍在队首，队尾
    // 实例的旧口径继续生效）。delete+set 把改配置者移到队尾，语义与注释一致。
    audioParamsByInstance.delete(key);
    audioParamsByInstance.set(key, { mode, dist });
    audioParamListeners.forEach((fn) => fn());
    return () => {
      audioParamsByInstance.delete(key);
      audioParamListeners.forEach((fn) => fn());
    };
  }, [mode, dist]);
  useEffect(() => {
    const fn = bumpAudioParams;
    audioParamListeners.add(fn);
    return () => {
      audioParamListeners.delete(fn);
    };
  }, []);
  const sharedParams = currentAudioParams();
  const effMode = sharedParams?.mode ?? mode;
  const effDist = sharedParams?.dist ?? dist;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // （bandCount 整拆管线）：数组按上限 96 分配一次，NB 改为每拍从
    // liveRef 现读——改频带数不再停 Rust 采集、重建订阅与 canvas 管线。
    const MAX_NB = 96;
    const nbOf = () => Math.max(8, Math.min(MAX_NB, Math.round(liveRef.current.bandCount)));
    /** Rust 推送、重采样 + 增益后的最新目标值（0~1）。 */
    const target = new Float32Array(MAX_NB);
    /** rAF 插值后的平滑值。 */
    const smoothed = new Float32Array(MAX_NB);
    /** 峰值保持帽线（缓慢下落，只升不降的视觉记忆）。 */
    const peaks = new Float32Array(MAX_NB);
    let level = 0;
    let levelSmooth = 0;
    let alive = true;
    // （presence 空闲频谱冻结）：presence 暂停后 audio:spectrum 停发，
    // target[] 停在最后一帧的非零值——能量判定看不出「无事件」，频谱条冻结
    // 在半高。记录最近事件时刻，>2s 无事件按 silent 处理（回落空闲呼吸）。
    let lastEventAt = 0;

    // 主题色缓存已上移模块级共享（getSharedTheme）：多实例一份
    // 400ms 刷新表 + 可见性暂停，本 effect 不再持有定时器与监听。

    // --- 频谱事件订阅（Tauri）；浏览器模式无事件，走空闲动画。 ---
    let unlisten: (() => void) | undefined;
    let disposed = false;
    // start/stop 是异步 IPC 且顺序不保证：若 cleanup 的 stop 先于 start 到达，
    // Rust 侧计数为 0 会忽略 stop，随后 start 落地 → 计数永久 +1，采集线程
    // 从此无人回收。用 running 保证「成功 start 必有对应 stop」。
    // 窗口隐藏时停采集、恢复可见再重启；running 守卫确保 refcount 严格配对。
    // starting/wanted：start 在途时再次 doStart（快速 hide→show）不能再发一次
    // ——此前 running 只在 resolve 后置位，两次并发 start 让 Rust 计数 +2、
    // cleanup 只 stop 一次；在途期间收到 stop 也要记住"不再想要"，落地后立即回收。
    let running = false;
    let starting = false;
    let wanted = false;
    const doStop = () => {
      wanted = false;
      if (!isTauri() || !running) return;
      running = false;
      void invoke("stop_audio_spectrum").catch(() => {});
    };
    const doStart = () => {
      if (!isTauri() || disposed) return;
      wanted = true;
      if (running || starting) return;
      starting = true;
      void invoke("start_audio_spectrum", { mode: effMode, dist: effDist })
        .then(() => {
          starting = false;
          running = true;
          if (disposed || !wanted) doStop();
        })
        .catch(() => {
          starting = false;
        });
    };
    doStart();
    const onVis = () => {
      if (document.hidden) doStop();
      else doStart();
    };
    document.addEventListener("visibilitychange", onVis);
    if (isTauri()) {
      void listen<{ level: number; bands: number[] }>("audio:spectrum", (e) => {
        const bands = e.payload?.bands;
        if (!Array.isArray(bands)) return;
        lastEventAt = performance.now();
        // /125：64 源频带 → bandCount 根（区间取峰保留能量感），
        // 再乘灵敏度增益，小音量也能撑起画面。NB 现读（bandCount 实时可变）。
        const curNB = nbOf();
        const g = Math.max(0.5, Math.min(3, liveRef.current.gain));
        for (let j = 0; j < curNB; j++) {
          const s = Math.floor((j * SOURCE_BANDS) / curNB);
          const t = Math.floor(((j + 1) * SOURCE_BANDS) / curNB);
          let peak = 0;
          for (let k = s; k < Math.max(t, s + 1) && k < SOURCE_BANDS; k++) {
            const v = Number(bands[k]);
            if (Number.isFinite(v) && v > peak) peak = v;
          }
          target[j] = Math.min(1, peak * g);
        }
        const lv = Number(e.payload?.level);
        level = Number.isFinite(lv) ? Math.min(1, Math.max(0, lv)) : 0;
      })
        .then((f) => {
          if (disposed) f();
          else unlisten = f;
        })
        /* 注册失败不留未处理 rejection（频谱是增强行为）。 */
        .catch((err: unknown) => console.error("[audio-visualizer] listen audio:spectrum failed:", err));
    }

    // --- 尺寸自适应（DPR 感知）。CSS 尺寸缓存在闭包里由 ResizeObserver 更新，
    // 绘制循环每帧读 clientWidth/Height 会强制同步布局。 ---
    let cssW = 0;
    let cssH = 0;
    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const rect = canvas.getBoundingClientRect();
      cssW = rect.width;
      cssH = rect.height;
      canvas.width = Math.max(1, Math.round(cssW * dpr));
      canvas.height = Math.max(1, Math.round(cssH * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);

    // --- 绘制循环。 ---
    // 三重降载：① 系统开启「减少动态」时只绘制一帧静态基线后停表；
    // ② 窗口隐藏（document.hidden）时跳过绘制；③ 空闲（无声）呼吸动画
    // 降到 ~30fps —— 静音时全速重绘 64 条频谱纯属浪费；不再压到 15fps，
    // 正弦呼吸在 15fps 下呈可见离散步进（抽帧感），30fps 仍省一半开销。
    // 双信号：应用内「减少动态」开关（data-reduce-motion）+ OS 偏好。
    // 实时性：不再在 effect 建立时快照（运行中切换偏好不生效），改为
    // draw 循环体内每帧实时读——prefersReducedMotion() 是廉价读，热路径安全。
    const IDLE_FRAME_MS = 33;
    const start = performance.now();
    let lastDraw = start;
    const draw = (now: number) => {
      if (!alive) return;
      if (document.hidden || coveredTickGate()) {
        // [COVERED]：被前台全屏完全遮挡时与
        // document.hidden 同待遇——保活 rAF 但跳过绘制工作。
        requestAnimationFrame(draw);
        return;
      }
      const reduceMotion = prefersReducedMotion();
      const w = cssW;
      const h = cssH;
      const t = (now - start) / 1000;
      const { style: st, colorMode: cm, smoothing: sm, peakHold: ph } = liveRef.current;
      const NB = nbOf();

      // 是否有真实音频：目标值几乎为零且事件从未带来能量 → 空闲呼吸。
      let energy = 0;
      for (let i = 0; i < NB; i++) energy += target[i];
      const stale = isTauri() && lastEventAt > 0 && performance.now() - lastEventAt > 2000;
      const silent = stale || energy < 0.02;

      if (silent && now - lastDraw < IDLE_FRAME_MS && !reduceMotion) {
        requestAnimationFrame(draw);
        return;
      }
      // 帧间隔归一：下列 k/decay 都是 60fps 基准的「每帧」系数，120/144Hz 屏上
      // 若原样使用，衰减速度成倍偏移（rb.tsx specLoop 同一结论）。按真实 dt
      // 换算：指数系数用 1-(1-k)^norm，线性衰减直接乘 norm。dt 钳到 [1,100]ms，
      // 覆盖空闲门控与窗口隐藏恢复后的间隔大帧。
      const dtMs = Math.min(100, Math.max(1, now - lastDraw));
      const norm = dtMs / 16.6667;
      lastDraw = now;

      ctx.clearRect(0, 0, w, h);

      // 平滑度滑杆驱动插值系数（0.5 时与旧硬编码 0.5/0.12 一致）。
      const kUp = Math.max(0.15, 0.75 - sm * 0.5);
      const kDown = 0.02 + sm * 0.2;
      for (let i = 0; i < NB; i++) {
        const idle = 0.05 + 0.035 * Math.sin(t * 1.3 + i * 0.38) + 0.02 * Math.sin(t * 0.7 + i * 0.13);
        const goal = silent ? idle : target[i];
        // 上升快、下降慢，叠加 Rust 侧包络，两级平滑足够丝滑。
        const k = goal > smoothed[i] ? kUp : kDown;
        smoothed[i] += (goal - smoothed[i]) * (1 - Math.pow(1 - k, norm));
        // 峰值保持：不低于当前值，且随帧间隔缓慢回落。
        const decay = (0.004 + 0.006 * (1 - sm)) * norm;
        peaks[i] = Math.max(smoothed[i], peaks[i] - decay);
      }
      levelSmooth += ((silent ? 0.12 : level) - levelSmooth) * (1 - Math.pow(0.82, norm));

      // 绘制函数按数组长度迭代：传 [0, NB) 子视图，bandCount 变化即时生效。
      const theme = getSharedTheme();
      const bands = smoothed.subarray(0, NB);
      const peakView = peaks.subarray(0, NB);
      if (st === "wave") {
        drawWave(ctx, w, h, bands, theme, t, cm);
      } else if (st === "mirror") {
        drawMirror(ctx, w, h, bands, theme, cm, ph ? peakView : null);
      } else if (st === "minimal") {
        drawMinimal(ctx, w, h, bands, theme, cm);
      } else if (st === "radial") {
        drawRadial(ctx, w, h, bands, theme, t, levelSmooth, silent, cm);
      } else if (st === "butterfly") {
        drawButterfly(ctx, w, h, bands, theme, t, cm);
      } else {
        drawBars(ctx, w, h, bands, theme, silent, cm, ph ? peakView : null);
      }

      // reduce-motion 下不排 rAF（静态基线一帧即止），但挂一个低频
      // 监听——运行期**关闭**偏好时恢复绘制循环（此前循环永久死亡，只有
      // 开启方向能实时生效）；偏好仍开启时零绘制开销。
      if (reduceMotion) {
        if (!reduceMotionWatcher) {
          reduceMotionWatcher = window.setInterval(() => {
            // 偏好翻回 false（用户关掉「减少动态」）→ 重新入列，draw 自续。
            if (!alive || prefersReducedMotion()) return;
            requestAnimationFrame(draw);
          }, 1000);
        }
        return;
      }
      if (reduceMotionWatcher) {
        window.clearInterval(reduceMotionWatcher);
        reduceMotionWatcher = 0;
      }
      requestAnimationFrame(draw);
    };
    let reduceMotionWatcher = 0;
    requestAnimationFrame(draw);

    return () => {
      alive = false;
      disposed = true;
      if (reduceMotionWatcher) window.clearInterval(reduceMotionWatcher);
      ro.disconnect();
      unlisten?.();
      document.removeEventListener("visibilitychange", onVis);
      doStop();
    };
    // mode / dist（共享口径 eff*）变化时重启采集管线，让 Rust 侧按新检测源/
    // 分带重建；其余参数（含 bandCount）经 liveRef 实时生效，不重启——bandCount
    // 的数组按上限分配、每拍现读 NB（见 effect 头部），不再需要进 deps 整拆管线。
  }, [effMode, effDist]);

  /* 点击频谱切换系统静音：切换后 1.5s 内浮现状态角标；退场先摘 .show
     播完过渡再延迟卸载（setTimeout + cleanup），避免角标瞬间消失。 */
  const [muted, setMuted] = useState(false);
  /* muted 与系统真实静音态对齐（审计修复）：挂载初值走 get_system_mute，
   * 此后键盘静音键/其它软件改静音经 osd:volume（audio_events.rs 默认端点
   * 回调，Rust 已节流）同步——此前 aria-pressed 只反映本组件自己的点击，
   * 外部改静音后状态陈旧。本组件的 toggle 也会触发端点回调，两条路径
   * 收敛到同一事件源。 */
  useTauriEvent<{ level: number; muted: boolean } | null>("osd:volume", (payload) => {
    if (payload && typeof payload.muted === "boolean") setMuted(payload.muted);
  });
  useEffect(() => {
    if (!isTauri()) return;
    void invoke<boolean>("get_system_mute")
      .then((m) => {
        if (typeof m === "boolean") setMuted(m);
      })
      .catch(() => {});
  }, []);
  const [muteFlash, setMuteFlash] = useState<string | null>(null);
  const [flashClosing, setFlashClosing] = useState(false);
  const flashTimer = useRef(0);
  const flashHideTimer = useRef(0);
  const onCanvasClick = () => {
    if (!isTauri()) return;
    void invoke<boolean>("toggle_system_mute")
      .then((nextMuted) => {
        setMuted(nextMuted);
        setFlashClosing(false);
        setMuteFlash(nextMuted ? "muted" : "unmuted");
        window.clearTimeout(flashTimer.current);
        window.clearTimeout(flashHideTimer.current);
        flashTimer.current = window.setTimeout(() => {
          setFlashClosing(true);
          // 与 .music-mute-flash 的 --anim-dur 过渡对齐（时长单一真源运行时
          // 读取：写死 260ms 不随动效速度档缩放），播完再卸载。
          flashHideTimer.current = window.setTimeout(() => setMuteFlash(null), animDurations().animMs + 10);
        }, 1500);
      })
      .catch(() => {});
  };
  useEffect(
    () => () => {
      window.clearTimeout(flashTimer.current);
      window.clearTimeout(flashHideTimer.current);
    },
    []
  );

  return (
    <button
      type="button"
      className="music-visual-wrap"
      onClick={onCanvasClick}
      data-interactive
      title={tr("点击切换系统静音")}
      aria-label={tr("点击切换系统静音")}
      aria-pressed={muted}
    >
      <canvas ref={canvasRef} className="music-visual" style={{ height }} aria-hidden="true" />
      {muteFlash && (
        <span className={`music-mute-flash${flashClosing ? "" : " show"}`}>
          {muteFlash === "muted" ? <VolumeX size={11} /> : <Volume2 size={11} />}
          {muteFlash === "muted" ? tr("已静音") : tr("已取消静音")}
        </span>
      )}
    </button>
  );
}

/* ------------------------------------------------------------------ */
/* 配色：theme 跟随主题 / mono 单色 / rainbow 按频带取色相。 */
/* ------------------------------------------------------------------ */

function bandColor(i: number, n: number, theme: ThemeColors, cm: BandColorMode): string {
  if (cm === "rainbow") return `hsl(${(i / Math.max(1, n)) * 300}, 85%, 62%)`;
  if (cm === "mono") return theme.accent;
  return mixColor(theme.accent, theme.accent2, n <= 1 ? 0 : i / (n - 1));
}

/* ------------------------------------------------------------------ */
/* 各样式的绘制实现                                                     */
/* ------------------------------------------------------------------ */

function drawBars(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  v: Float32Array,
  theme: ThemeColors,
  silent: boolean,
  cm: BandColorMode,
  peaks: Float32Array | null
) {
  const n = v.length;
  const gap = Math.max(2, (w / n) * 0.3);
  const barW = Math.max(1.5, (w - gap * (n - 1)) / n);
  const baseline = h * 0.78;
  const maxH = h * 0.74;

  const grad = cm === "mono" ? null : ctx.createLinearGradient(0, baseline - maxH, 0, baseline);
  if (grad) {
    grad.addColorStop(0, theme.accent2);
    grad.addColorStop(1, theme.accent);
  }
  ctx.fillStyle = grad ?? theme.accent;
  if (!silent) {
    ctx.shadowColor = theme.accent;
    ctx.shadowBlur = 8;
  } else {
    ctx.shadowBlur = 0;
  }

  for (let i = 0; i < n; i++) {
    const bh = Math.max(2, v[i] * maxH);
    const x = i * (barW + gap);
    const r = Math.min(barW / 2, 3);
    if (cm === "rainbow" || cm === "mono") ctx.fillStyle = bandColor(i, n, theme, cm);
    roundRect(ctx, x, baseline - bh, barW, bh, r);
    ctx.fill();
  }
  ctx.shadowBlur = 0;

  // 峰值保持帽线：每根条上方一条 2px 横线缓慢下落。
  if (peaks) {
    ctx.fillStyle = hexToRgba(cm === "mono" ? theme.accent : theme.accent2, 0.85);
    for (let i = 0; i < n; i++) {
      const py = baseline - Math.max(2, peaks[i] * maxH) - 3;
      roundRect(ctx, i * (barW + gap), py, barW, 2, 1);
      ctx.fill();
    }
  }

  // 底部倒影：低透明度反向，营造光泽。
  ctx.globalAlpha = 0.16;
  ctx.fillStyle = grad ?? theme.accent;
  for (let i = 0; i < n; i++) {
    const bh = Math.max(2, v[i] * maxH) * 0.32;
    const x = i * (barW + gap);
    roundRect(ctx, x, baseline + 2, barW, bh, Math.min(barW / 2, 2));
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

function drawWave(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  v: Float32Array,
  theme: ThemeColors,
  t: number,
  cm: BandColorMode
) {
  const n = v.length;
  const mid = h / 2;
  const pts: { x: number; y: number }[] = [];
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * w;
    const sway = Math.sin(t * 0.9 + i * 0.25) * h * 0.02;
    pts.push({ x, y: mid - v[i] * h * 0.46 + sway });
  }

  const fill =
    cm === "rainbow"
      ? (() => {
          const g = ctx.createLinearGradient(0, 0, w, 0);
          for (let s = 0; s <= 4; s++) g.addColorStop(s / 4, bandColor(Math.floor((s / 4) * n), n, theme, cm));
          return g;
        })()
      : ctx.createLinearGradient(0, 0, 0, h);
  if (cm === "rainbow") {
    // 已按横向构造。
  } else {
    fill.addColorStop(0, hexToRgba(theme.accent2, 0.22));
    fill.addColorStop(1, hexToRgba(theme.accent, 0.02));
  }

  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 0; i < pts.length - 1; i++) {
    const xc = (pts[i].x + pts[i + 1].x) / 2;
    const yc = (pts[i].y + pts[i + 1].y) / 2;
    ctx.quadraticCurveTo(pts[i].x, pts[i].y, xc, yc);
  }
  ctx.lineTo(w, pts[pts.length - 1].y);
  // 填充到画布底部
  ctx.lineTo(w, h);
  ctx.lineTo(0, h);
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();

  // 上缘描线
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 0; i < pts.length - 1; i++) {
    const xc = (pts[i].x + pts[i + 1].x) / 2;
    const yc = (pts[i].y + pts[i + 1].y) / 2;
    ctx.quadraticCurveTo(pts[i].x, pts[i].y, xc, yc);
  }
  ctx.lineTo(w, pts[pts.length - 1].y);
  ctx.strokeStyle = cm === "mono" ? theme.accent : theme.accent;
  ctx.lineWidth = 1.6;
  ctx.shadowColor = theme.accent;
  ctx.shadowBlur = 6;
  ctx.stroke();
  ctx.shadowBlur = 0;
}

function drawMirror(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  v: Float32Array,
  theme: ThemeColors,
  cm: BandColorMode,
  peaks: Float32Array | null
) {
  const n = v.length;
  const gap = Math.max(2, (w / n) * 0.34);
  const barW = Math.max(1.5, (w - gap * (n - 1)) / n);
  const mid = h / 2;
  const maxH = h * 0.44;

  const grad = cm === "mono" ? null : ctx.createLinearGradient(0, mid - maxH, 0, mid + maxH);
  if (grad) {
    grad.addColorStop(0, theme.accent2);
    grad.addColorStop(0.5, theme.accent);
    grad.addColorStop(1, theme.accent2);
  }

  for (let i = 0; i < n; i++) {
    const bh = Math.max(1.5, v[i] * maxH);
    const x = i * (barW + gap);
    const r = Math.min(barW / 2, 3);
    ctx.fillStyle = grad ?? bandColor(i, n, theme, cm);
    roundRect(ctx, x, mid - bh, barW, bh, r);
    ctx.fill();
    ctx.globalAlpha = 0.45;
    roundRect(ctx, x, mid + 1, barW, bh * 0.8, r);
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  if (peaks) {
    ctx.fillStyle = hexToRgba(cm === "mono" ? theme.accent : theme.accent2, 0.85);
    for (let i = 0; i < n; i++) {
      const py = mid - Math.max(1.5, peaks[i] * maxH) - 3;
      roundRect(ctx, i * (barW + gap), py, barW, 2, 1);
      ctx.fill();
    }
  }

  ctx.fillStyle = hexToRgba(theme.ink, 0.25);
  ctx.fillRect(0, mid - 0.5, w, 1);
}

function drawMinimal(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  v: Float32Array,
  theme: ThemeColors,
  cm: BandColorMode
) {
  const n = v.length;
  const gap = Math.max(3, (w / n) * 0.55);
  const barW = Math.max(2, (w - gap * (n - 1)) / n);
  const baseline = h * 0.85;
  const maxH = h * 0.72;

  for (let i = 0; i < n; i++) {
    const bh = Math.max(2, v[i] * maxH);
    const x = i * (barW + gap);
    ctx.fillStyle = cm === "theme" ? hexToRgba(theme.accent, 0.85) : hexToRgba(bandColor(i, n, theme, cm), 0.9);
    roundRect(ctx, x, baseline - bh, barW, bh, barW / 2);
    ctx.fill();
  }
}

/* ------------------------------------------------------------------ */

/**
 * 环形频谱（AudioVisualizer 风）：频带呈放射状围绕中心圆，
 * 圆环随音量脉动 + 整体缓慢旋转；圆点端帽 + 外辉光，声浪从圆心向外生长。
 */
function drawRadial(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  v: Float32Array,
  theme: ThemeColors,
  t: number,
  level: number,
  silent: boolean,
  cm: BandColorMode
) {
  const cx = w / 2;
  const cy = h / 2;
  const maxR = Math.min(w, h) / 2 - 6;
  // 中心圆：半径随音量脉动（无声时低幅呼吸）。
  const coreR = Math.max(4, maxR * (0.3 + level * 0.34));
  const ring = Math.max(2, maxR * (0.4 + level * 0.5));
  const spin = t * 0.18;
  const n = v.length;

  // 中心辉光。
  const glow = ctx.createRadialGradient(cx, cy, 0, cx, cy, ring + 10);
  glow.addColorStop(0, hexToRgba(theme.accent, silent ? 0.16 : 0.3));
  glow.addColorStop(1, "transparent");
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, w, h);

  // 频带放射条：向外长条 + 向内短反射，色相沿圆周渐变。
  // 主题双色预解析一次通道，逐频带数值混色——此前每频带 2 次字符串
  // 解析 + 模板格式化（48 频带 × 每帧）。解析失败回退旧 mixColor 路径。
  const pa = parseChannel(theme.accent);
  const pb = parseChannel(theme.accent2);
  const barLen = maxR - ring - 2;
  if (barLen > 2) {
    ctx.lineCap = "round";
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 - Math.PI / 2 + spin;
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      const len = Math.max(1.5, v[i] * barLen);
      const stroke =
        cm === "theme"
          ? pa && pb
            ? mixChannels(pa, pb, i / n)
            : mixColor(theme.accent, theme.accent2, i / n)
          : bandColor(i, n, theme, cm);
      // 外侧主条。
      ctx.strokeStyle = stroke;
      ctx.lineWidth = Math.max(1.5, ((Math.PI * 2 * ring) / n) * 0.5);
      ctx.globalAlpha = 0.95;
      ctx.beginPath();
      ctx.moveTo(cx + ca * ring, cy + sa * ring);
      ctx.lineTo(cx + ca * (ring + len), cy + sa * (ring + len));
      ctx.stroke();
      // 内侧短反射（更暗），呼应 bars 的倒影语言。
      ctx.globalAlpha = 0.35;
      ctx.lineWidth = Math.max(1, ((Math.PI * 2 * coreR) / n) * 0.4);
      ctx.beginPath();
      ctx.moveTo(cx + ca * (coreR + 2), cy + sa * (coreR + 2));
      ctx.lineTo(cx + ca * (coreR + 2 + len * 0.32), cy + sa * (coreR + 2 + len * 0.32));
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  // 中心圆盘 + 描边。
  ctx.beginPath();
  ctx.arc(cx, cy, coreR, 0, Math.PI * 2);
  ctx.fillStyle = hexToRgba(theme.accent, 0.14);
  ctx.fill();
  ctx.strokeStyle = theme.accent;
  ctx.lineWidth = 1.4;
  if (!silent) {
    ctx.shadowColor = theme.accent;
    ctx.shadowBlur = 9;
  }
  ctx.stroke();
  ctx.shadowBlur = 0;
}

/**
 * 蝴蝶样式：左右对称的双翼轮廓 —— 上翼随频带生长，下翼取反相频带
 * 呼应，整体随节拍开合，像一只停在桌面上的光蝶。
 */
function drawButterfly(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  v: Float32Array,
  theme: ThemeColors,
  t: number,
  cm: BandColorMode
) {
  const n = v.length;
  const cx = w / 2;
  const cy = h / 2;
  const half = Math.max(2, Math.floor(n / 2));
  // 上翼（左→右整条轮廓）：距中心越远用的频带越高，左右镜像。
  const upper: { x: number; y: number }[] = [];
  const lower: { x: number; y: number }[] = [];
  for (let j = 0; j < n; j++) {
    const x = (j / (n - 1)) * w;
    const d = Math.abs(j - (n - 1) / 2) / ((n - 1) / 2 || 1);
    const bi = Math.min(half - 1, Math.floor(d * half));
    const sway = Math.sin(t * 1.1 + d * 2.4) * h * 0.03;
    upper.push({ x, y: cy - v[bi] * h * 0.44 + sway });
    // 下翼用反相频带（高频侧换到低频侧），上下轮廓形成错落的翼形。
    const bj = Math.min(half - 1, half - 1 - bi);
    lower.push({ x, y: cy + v[bj] * h * 0.36 + sway * 0.6 });
  }

  const fill =
    cm === "rainbow"
      ? (() => {
          const g = ctx.createLinearGradient(0, 0, w, 0);
          for (let s = 0; s <= 4; s++) g.addColorStop(s / 4, bandColor(Math.floor((s / 4) * n), n, theme, cm));
          return g;
        })()
      : (() => {
          const g = ctx.createLinearGradient(0, 0, 0, h);
          g.addColorStop(0, hexToRgba(theme.accent2, 0.4));
          g.addColorStop(0.5, hexToRgba(theme.accent, 0.3));
          g.addColorStop(1, hexToRgba(theme.accent2, 0.12));
          return g;
        })();

  ctx.beginPath();
  ctx.moveTo(upper[0].x, upper[0].y);
  for (let i = 0; i < upper.length - 1; i++) {
    const xc = (upper[i].x + upper[i + 1].x) / 2;
    const yc = (upper[i].y + upper[i + 1].y) / 2;
    ctx.quadraticCurveTo(upper[i].x, upper[i].y, xc, yc);
  }
  ctx.lineTo(w, upper[upper.length - 1].y);
  ctx.lineTo(w, lower[lower.length - 1].y);
  for (let i = lower.length - 1; i > 0; i--) {
    const xc = (lower[i].x + lower[i - 1].x) / 2;
    const yc = (lower[i].y + lower[i - 1].y) / 2;
    ctx.quadraticCurveTo(lower[i].x, lower[i].y, xc, yc);
  }
  ctx.lineTo(0, lower[0].y);
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.strokeStyle = theme.accent;
  ctx.lineWidth = 1.2;
  ctx.shadowColor = theme.accent;
  ctx.shadowBlur = 7;
  ctx.stroke();
  ctx.shadowBlur = 0;

  // 中轴脉络线。
  ctx.strokeStyle = hexToRgba(theme.accent, 0.5);
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(cx, cy - h * 0.06);
  ctx.lineTo(cx, cy + h * 0.06);
  ctx.stroke();
}

/** 两色线性插值（支持 #hex / rgba 输入，失败回退 from）。 */
function mixColor(from: string, to: string, t: number): string {
  const pa = parseChannel(from);
  const pb = parseChannel(to);
  if (!pa || !pb) return from;
  return mixChannels(pa, pb, t);
}

/** 预解析通道的数值混色（热路径用：radial 每帧逐频带，见 drawRadial）。 */
function mixChannels(pa: [number, number, number], pb: [number, number, number], t: number): string {
  const r = Math.round(pa[0] + (pb[0] - pa[0]) * t);
  const g = Math.round(pa[1] + (pb[1] - pa[1]) * t);
  const b = Math.round(pa[2] + (pb[2] - pa[2]) * t);
  return `rgb(${r},${g},${b})`;
}

/* （hsl/oklch 解析失真）：主题变量可能是 hsl()/oklch()/color-mix() 等现代
 * 写法，字面量正则不识别 → mixColor 退化为单色渐变、hexToRgba 丢 alpha。
 * 经离屏 canvas 的 fillStyle 让浏览器引擎归一成 #rrggbb/rgba() 再读回，
 * 覆盖全部合法颜色语法（无头模式下 getContext 失败则维持旧回退）。 */
let normalizeCanvas: HTMLCanvasElement | null = null;

function parseRgbish(color: string): [number, number, number] | null {
  const hex = color.trim().match(/^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  if (hex) return [parseInt(hex[1], 16), parseInt(hex[2], 16), parseInt(hex[3], 16)];
  const rgb = color.trim().match(/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/i);
  if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
  return null;
}

function normalizeViaCanvas(color: string): string | null {
  try {
    if (!normalizeCanvas) normalizeCanvas = document.createElement("canvas");
    const ctx = normalizeCanvas.getContext("2d");
    if (!ctx) return null;
    // 哨兵色：非法颜色赋值后 fillStyle 保持原值，与哨兵相等即解析失败。
    ctx.fillStyle = "#010203";
    ctx.fillStyle = color;
    const normalized = String(ctx.fillStyle);
    return normalized === "#010203" ? null : normalized;
  } catch {
    return null;
  }
}

function parseChannel(color: string): [number, number, number] | null {
  const direct = parseRgbish(color);
  if (direct) return direct;
  const normalized = normalizeViaCanvas(color);
  return normalized ? parseRgbish(normalized) : null;
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

/** 支持 #rgb/#rrggbb/rgba()；非可解析色原样返回并给出回退 alpha。 */
function hexToRgba(color: string, alpha: number): string {
  const m = color.trim().match(/^#?([a-f\d])([a-f\d])([a-f\d])$/i);
  if (m) {
    const r = parseInt(m[1] + m[1], 16);
    const g = parseInt(m[2] + m[2], 16);
    const b = parseInt(m[3] + m[3], 16);
    return `rgba(${r},${g},${b},${alpha})`;
  }
  const m2 = color.trim().match(/^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i);
  if (m2) {
    return `rgba(${parseInt(m2[1], 16)},${parseInt(m2[2], 16)},${parseInt(m2[3], 16)},${alpha})`;
  }
  const m3 = color.trim().match(/^rgba?\(([^)]+)\)$/i);
  if (m3) {
    const parts = m3[1].split(/[\s,/]+/).filter(Boolean);
    if (parts.length >= 3) {
      return `rgba(${parts[0]},${parts[1]},${parts[2]},${alpha})`;
    }
  }
  // hsl()/oklch() 等现代写法经 canvas 归一成 #rrggbb 后补 alpha，
  // 不再原样返回（丢失 alpha 的颜色用于半透明中轴线会完全不透明）。
  const ch = parseChannel(color);
  if (ch) return `rgba(${ch[0]},${ch[1]},${ch[2]},${alpha})`;
  return color;
}
