/**
 * 白噪音/专注音效：Web Audio 实时合成，无需音频资源文件。
 *
 * 四种场景全部由噪声源 + 滤波器 + 幅度包络组合而成：
 *  - rain 雨声：白噪过低通 + 轻微幅度起伏，模拟持续雨幕。
 *  - cafe 咖啡厅：棕噪（能量更低沉）过带通 + 缓慢波动，像远处人声嗡鸣。
 *  - fire 篝火：棕噪打底 + 随机爆裂脉冲（每 0.2~1.2s 一次）。
 *  - white 白噪：原始白噪声，均匀掩蔽。
 *
 * 单例管理：全局只允许一路氛围音，切换场景即重建节点图。
 * AudioContext 必须由用户手势创建/恢复（各浏览器自动播放策略）。
 */

import { invoke } from "./tauri";

export type AmbienceKind = "rain" | "cafe" | "fire" | "white";

export const AMBIENCE_KINDS: { id: AmbienceKind; label: string }[] = [
  { id: "rain", label: "雨声" },
  { id: "cafe", label: "咖啡厅" },
  { id: "fire", label: "篝火" },
  { id: "white", label: "白噪" }
];

const STORAGE_KEY = "focus-desk.ambience.v1";

export interface AmbiencePrefs {
  kind: AmbienceKind;
  volume: number; // 0..1
}

/**
 * 读取环境音偏好（场景 + 音量），损坏/缺省回退 `{ rain, 0.4 }`。
 *
 * @returns 校验后的 {@link AmbiencePrefs}（volume 钳制到 0..1）。
 * @throws 无。
 */
export function loadAmbiencePrefs(): AmbiencePrefs {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { kind: "rain", volume: 0.4 };
    const parsed = JSON.parse(raw) as Partial<AmbiencePrefs>;
    const kind = AMBIENCE_KINDS.some((k) => k.id === parsed.kind) ? (parsed.kind as AmbienceKind) : "rain";
    const volume =
      typeof parsed.volume === "number" && Number.isFinite(parsed.volume)
        ? Math.min(1, Math.max(0, parsed.volume))
        : 0.4;
    return { kind, volume };
  } catch {
    return { kind: "rain", volume: 0.4 };
  }
}

/** 持久化环境音偏好；localStorage 写失败静默忽略。 */
export function saveAmbiencePrefs(prefs: AmbiencePrefs) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // best-effort
  }
}

/** 2 秒白噪 buffer，循环播放作为所有场景的噪声底。 */
function noiseBuffer(ctx: AudioContext, brown: boolean): AudioBuffer {
  const len = ctx.sampleRate * 2;
  const buffer = ctx.createBuffer(1, len, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  let last = 0;
  for (let i = 0; i < len; i++) {
    const white = Math.random() * 2 - 1;
    if (brown) {
      // 棕噪：对白噪做积分，能量集中在低频。
      last = (last + 0.02 * white) / 1.02;
      data[i] = last * 3.5;
    } else {
      data[i] = white;
    }
  }
  return buffer;
}

interface AmbienceNodes {
  ctx: AudioContext;
  master: GainNode;
  /** 篝火爆裂脉冲定时器（仅 fire 场景持有）。 */
  crackleTimer: number | null;
  /** 幅度起伏定时器（rain/cafe 持有）。 */
  swellTimer: number | null;
}

let active: AmbienceNodes | null = null;

/* （媒体在播时抑制白噪音）：用户意图与实际播放解耦——
 * 检测到任何媒体在播时淡出氛围音，全部停了再淡入恢复。desired 保存
 * 用户最后的播放意图，抑制解除时按它重建节点图。 */
let mediaInhibited = false;
let desired: { kind: AmbienceKind; volume: number; playing: boolean } | null = null;

/* 无手势环境下（抑制恢复由 media:snapshot 事件驱动，
 * 不是用户交互）新建的 AudioContext 可能被自动播放策略停在 suspended——
 * ctx 静默但 active 非 null，UI 会谎报「播放中」。两道补丁：
 *  1. isAmbiencePlaying 以 ctx.state === "running" 为准（真正出声才算）；
 *  2. resume 失败时挂「待手势恢复」：下一次用户交互（pointerdown/keydown，
 *     捕获式一次性）补一次 resume。 */
let pendingGestureResume = false;
let gestureArmed = false;

function armGestureResume(): void {
  if (gestureArmed || typeof window === "undefined") return;
  gestureArmed = true;
  const onGesture = () => {
    window.removeEventListener("pointerdown", onGesture, true);
    window.removeEventListener("keydown", onGesture, true);
    gestureArmed = false;
    if (!pendingGestureResume) return;
    const ctx = active?.ctx;
    if (!ctx || ctx.state === "closed") {
      pendingGestureResume = false;
      return;
    }
    void ctx
      .resume()
      .then(() => {
        // 仍失败（策略更严的环境）保持待恢复，等下一次手势。
        pendingGestureResume = ctx.state !== "running";
        if (pendingGestureResume) armGestureResume();
      })
      .catch(() => {
        pendingGestureResume = true;
        armGestureResume();
      });
  };
  window.addEventListener("pointerdown", onGesture, true);
  window.addEventListener("keydown", onGesture, true);
}

/** 建图后统一走这里恢复 ctx：失败挂手势重试，不再静默吞掉。 */
function resumeCtx(ctx: AudioContext): void {
  void ctx
    .resume()
    .then(() => {
      pendingGestureResume = ctx.state !== "running";
    })
    .catch(() => {
      pendingGestureResume = true;
    })
    .finally(() => {
      if (pendingGestureResume) armGestureResume();
    });
}

/**
 * 设置媒体抑制态（lib 层媒体联动：媒体在播 → true）。
 *
 * @param inhibited - true 淡出并挂起氛围音；false 按用户意图恢复。
 * @returns 无。
 */
export function setAmbienceMediaInhibited(inhibited: boolean): void {
  if (mediaInhibited === inhibited) return;
  mediaInhibited = inhibited;
  if (inhibited) {
    stopNodes();
  } else if (desired?.playing) {
    active = build(desired.kind, desired.volume);
    // 事件驱动的恢复没有用户手势：resume 可能被自动播放策略拒绝，
    // 走统一入口挂「待手势恢复」（见 resumeCtx）。
    resumeCtx(active.ctx);
  }
}

/** 查询当前是否被媒体播放抑制。O(1)。 */
export function isAmbienceMediaInhibited(): boolean {
  return mediaInhibited;
}

/**
 * 启动「媒体在播 → 抑制氛围音」守卫（监听 Rust media:snapshot）。
 * 挂载在每个 widget 窗口（media:snapshot 只投给 widget-*，氛围音的
 * AudioContext 就在其中某个 widget 窗口里，各自守卫各自的图）。
 *
 * @returns 停止守卫的函数（无监听时返回 no-op）。
 */
export function startAmbienceMediaGuard(): () => void {
  const isTauri = "__TAURI_INTERNALS__" in window;
  if (!isTauri) return () => {};
  let un: (() => void) | null = null;
  let disposed = false;
  /* media:snapshot 只在变化时到达——守卫挂载时音乐已在播的话没有
   * 首帧事件，抑制要等到下一次播放态变化才触发（恰是守卫要防的场景：
   * 音乐播放中开白噪音会同时出声）。启动先拉一次快照建初始态。 */
  void invoke<{ playing: boolean } | null>("get_system_media_info")
    .then((m) => {
      if (!disposed) setAmbienceMediaInhibited(!!m?.playing);
    })
    .catch(() => {
      /* 初始态拉取失败：只损失初始抑制，事件链路照常 */
    });
  void import("@tauri-apps/api/event")
    .then(({ listen }) =>
      listen<{ playing: boolean } | null>("media:snapshot", (e) => {
        setAmbienceMediaInhibited(!!e.payload?.playing);
      })
    )
    .then((f) => {
      if (disposed) f();
      else un = f;
    })
    .catch(() => {
      // 守卫失败只损失抑制能力，氛围音照常
    });
  return () => {
    disposed = true;
    un?.();
  };
}

function stopNodes() {
  if (!active) return;
  // 图即将拆除：待手势恢复的补重试失去目标（ctx 350ms 后 close），
  // 手势监听里对 closed ctx 的守卫会自行清零，这里先复位意图。
  pendingGestureResume = false;
  const { ctx, master, crackleTimer, swellTimer } = active;
  if (crackleTimer !== null) window.clearInterval(crackleTimer);
  if (swellTimer !== null) window.clearInterval(swellTimer);
  try {
    master.gain.cancelScheduledValues(ctx.currentTime);
    master.gain.setTargetAtTime(0, ctx.currentTime, 0.08);
  } catch {
    // context may already be closed
  }
  const closing = ctx;
  window.setTimeout(() => {
    void closing.close().catch(() => {});
  }, 350);
  active = null;
}

/** 持续噪声底 + 滤波 + 缓慢幅度起伏（雨声/咖啡厅共用的"呼吸感"）。 */
function startSwell(ctx: AudioContext, dest: AudioNode, brown: boolean, swellHz: number) {
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer(ctx, brown);
  src.loop = true;
  const amp = ctx.createGain();
  amp.gain.value = 0.85;
  src.connect(amp).connect(dest);
  src.start();

  const lfo = ctx.createOscillator();
  lfo.frequency.value = swellHz;
  const lfoGain = ctx.createGain();
  lfoGain.gain.value = 0.12;
  lfo.connect(lfoGain);
  lfoGain.connect(amp.gain);
  lfo.start();
}

function build(kind: AmbienceKind, volume: number): AmbienceNodes {
  const AudioCtor =
    window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const ctx = new AudioCtor();
  const master = ctx.createGain();
  master.gain.value = 0;
  master.connect(ctx.destination);

  let crackleTimer: number | null = null;
  let swellTimer: number | null = null;

  if (kind === "rain") {
    // 雨声：白噪 → 低通 1.2kHz，清晰但不刺耳。
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 1200;
    lp.connect(master);
    startSwell(ctx, lp, false, 0.09);
  } else if (kind === "cafe") {
    // 咖啡厅：棕噪 → 带通 300~900Hz，像远处人声与杯盘的嗡鸣。
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = 520;
    bp.Q.value = 0.6;
    bp.connect(master);
    startSwell(ctx, bp, true, 0.05);
    swellTimer = window.setInterval(() => {
      // 缓慢漂移中心频率，避免机械感。
      try {
        bp.frequency.setTargetAtTime(420 + Math.random() * 320, ctx.currentTime, 1.2);
      } catch {
        /* closed */
      }
    }, 3000);
  } else if (kind === "fire") {
    // 篝火：棕噪底 + 周期性爆裂。
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 700;
    lp.connect(master);
    startSwell(ctx, lp, true, 0.07);
    crackleTimer = window.setInterval(() => {
      if (Math.random() < 0.35) return;
      try {
        const now = ctx.currentTime;
        const osc = ctx.createOscillator();
        osc.type = "triangle";
        osc.frequency.value = 90 + Math.random() * 160;
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.0001, now);
        g.gain.exponentialRampToValueAtTime(0.25 + Math.random() * 0.2, now + 0.008);
        g.gain.exponentialRampToValueAtTime(0.0001, now + 0.06 + Math.random() * 0.08);
        osc.connect(g).connect(master);
        osc.start(now);
        osc.stop(now + 0.2);
      } catch {
        /* closed */
      }
    }, 260);
  } else {
    // 白噪：原始噪声，均匀掩蔽。
    startSwell(ctx, master, false, 0.02);
  }

  master.gain.setTargetAtTime(volume, ctx.currentTime, 0.25);
  return { ctx, master, crackleTimer, swellTimer };
}

/**
 * 切换环境音播放状态（单例音频图：切换场景即重建节点）。
 *
 * @param kind - 场景（rain/cafe/fire/white）。
 * @param volume - 目标音量 0..1。
 * @param playing - true 开始播放（先停旧图再建新图）；false 停止并释放。
 * @returns 切换后是否处于播放状态。
 * @throws 无（resume 失败静默——自动播放策略下需用户手势，UI 状态由
 *         调用方回读 {@link isAmbiencePlaying}）。
 *
 * @example
 * ```ts
 * const now = setAmbiencePlaying("rain", 0.4, !isAmbiencePlaying());
 * ```
 */
export function setAmbiencePlaying(kind: AmbienceKind, volume: number, playing: boolean): boolean {
  // 用户意图先行记录：媒体抑制解除后按它恢复（#8 的解耦核心）。
  desired = { kind, volume, playing };
  stopNodes();
  pendingGestureResume = false;
  if (!playing || mediaInhibited) return false;
  active = build(kind, volume);
  // 用户手势路径（番茄面板开关）resume 通常直接放行；个别策略严的环境
  // 走统一入口挂「待手势恢复」。
  resumeCtx(active.ctx);
  return true;
}

/** 查询环境音当前是否**真正出声**（ctx 处于 running 才算——
 * suspended 时虽持有节点图但被自动播放策略静默，此前谎报播放中。
 * resume 在途的短暂窗口按未播放处理，成功后调用方重读即翻转）。 */
export function isAmbiencePlaying(): boolean {
  return active !== null && active.ctx.state === "running";
}

/**
 * 调节音量（播放中实时生效，0.1s 平滑过渡；未播放时 no-op）。
 *
 * @param volume - 目标音量 0..1（越界钳制）。
 * @returns 无。
 */
export function setAmbienceVolume(volume: number) {
  if (!active) return;
  const v = Math.min(1, Math.max(0, volume));
  try {
    active.master.gain.setTargetAtTime(v, active.ctx.currentTime, 0.1);
  } catch {
    /* closed */
  }
}
