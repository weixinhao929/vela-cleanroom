/**
 * （事件级音效 + 滴答声）：Web Audio 合成音色库。
 *
 *  - 事件音：专注结束 / 休息结束各配独立音色与音量（0..1），替代单一的
 *    双音提示音——休息结束默认更「响」的 bell，与
 *    loud-bell 语义一致。
 *  - 滴答声：专注进行中的循环音（挂钟 tick-tock / 节拍器），1Hz 调度，
 *    模块级单例（全局只允许一路 tick），随开关即时启停。
 *
 * AudioContext 惰性单例 + suspended 自恢复（自动播放策略：番茄钟启动本身
 * 是用户手势，因此专注期首拍即可发声）。
 */

/** 阶段结束的事件音色。 */
export type EventSoundId = "soft" | "bell" | "digital" | "marimba" | "none";
/** 专注进行中的循环滴答音色。 */
export type TickSoundId = "none" | "clock" | "metronome";

/** 惰性 AudioContext 工厂：suspended 自恢复（自动播放策略）、closed 重建。 */
function ctxManager(): () => AudioContext | null {
  let ctx: AudioContext | null = null;
  return () => {
    const Ctx =
      window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return null;
    try {
      if (!ctx || ctx.state === "closed") ctx = new Ctx();
      if (ctx.state === "suspended") void ctx.resume().catch(() => {});
      return ctx;
    } catch {
      return null;
    }
  };
}

/** 事件音的共享 ctx。 */
const getCtx = ctxManager();
/* 滴答声专用**独立** ctx——stopTickNodes 的 200ms 延迟 close 此前关的是
   共享 ctx：FocusTickPlayer 的 effect 依赖（音色/音量/运行态）任一变化都会
   先 stop 再立即重建，新滴答挂在同一 ctx 上随后被 close，滴答静默失效。 */
const getTickCtx = ctxManager();

/** 单个振荡音符（带指数衰减包络）。 */
function tone(
  ctx: AudioContext,
  dest: AudioNode,
  opts: { freq: number; type: OscillatorType; at: number; dur: number; peak: number }
) {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = opts.type;
  osc.frequency.value = opts.freq;
  const t = opts.at;
  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, opts.peak), t + 0.012);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + opts.dur);
  osc.connect(gain).connect(dest);
  osc.start(t);
  osc.stop(t + opts.dur + 0.05);
}

/** 短噪声脉冲（挂钟滴答的「机械感」）。 */
function click(ctx: AudioContext, dest: AudioNode, at: number, freq: number, peak: number) {
  const len = Math.floor(ctx.sampleRate * 0.03);
  const buffer = ctx.createBuffer(1, len, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len);
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  const bp = ctx.createBiquadFilter();
  bp.type = "bandpass";
  bp.frequency.value = freq;
  bp.Q.value = 2.5;
  const gain = ctx.createGain();
  gain.gain.value = peak;
  src.connect(bp).connect(gain).connect(dest);
  src.start(at);
}

/**
 * 播放一次事件音。
 *
 * @param id - 音色（none 静默）。
 * @param volume - 音量 0..1（内部再按音色配方缩放，避免刺耳）。
 * @returns 是否真的发声（none / 音频不可用为 false）。
 * @throws 无（Web Audio 全程 try 包裹）。
 */
export function playEventSound(id: EventSoundId, volume: number): boolean {
  if (id === "none") return false;
  try {
    const ctx = getCtx();
    if (!ctx) return false;
    const v = Math.min(1, Math.max(0, volume));
    const now = ctx.currentTime + 0.01;
    const master = ctx.createGain();
    master.gain.value = v;
    master.connect(ctx.destination);
    switch (id) {
      case "soft":
        // 既有双音（660→880 正弦）保留为 soft 档。
        tone(ctx, master, { freq: 660, type: "sine", at: now, dur: 0.18, peak: 0.5 });
        tone(ctx, master, { freq: 880, type: "sine", at: now + 0.14, dur: 0.22, peak: 0.45 });
        break;
      case "bell":
        // 休息结束的「响铃」：基音 + 两个非谐分音，长衰减。
        tone(ctx, master, { freq: 880, type: "sine", at: now, dur: 1.1, peak: 0.5 });
        tone(ctx, master, { freq: 1318.5, type: "sine", at: now, dur: 0.8, peak: 0.22 });
        tone(ctx, master, { freq: 1760, type: "sine", at: now + 0.03, dur: 0.5, peak: 0.1 });
        break;
      case "digital":
        tone(ctx, master, { freq: 1046.5, type: "square", at: now, dur: 0.09, peak: 0.28 });
        tone(ctx, master, { freq: 1568, type: "square", at: now + 0.1, dur: 0.12, peak: 0.26 });
        break;
      case "marimba":
        tone(ctx, master, { freq: 523.25, type: "triangle", at: now, dur: 0.32, peak: 0.55 });
        tone(ctx, master, { freq: 1046.5, type: "sine", at: now, dur: 0.14, peak: 0.14 });
        tone(ctx, master, { freq: 659.25, type: "triangle", at: now + 0.09, dur: 0.3, peak: 0.4 });
        break;
    }
    return true;
  } catch {
    return false;
  }
}

/* ---------------- 滴答声（模块级单例，1Hz 调度） ---------------- */

interface TickState {
  kind: TickSoundId;
  timer: number;
  beat: number;
  gain: GainNode;
  ctx: AudioContext;
}

let tick: TickState | null = null;

function stopTickNodes() {
  if (!tick) return;
  window.clearInterval(tick.timer);
  try {
    tick.gain.gain.setTargetAtTime(0, tick.ctx.currentTime, 0.05);
  } catch {
    // closed
  }
  const closing = tick.ctx;
  window.setTimeout(() => {
    void closing.close().catch(() => {});
  }, 200);
  tick = null;
}

function scheduleTickBeat(state: TickState) {
  try {
    const { ctx, gain, kind } = state;
    const now = ctx.currentTime + 0.01;
    if (kind === "clock") {
      // 挂钟：滴/答交替（2000Hz / 1500Hz 机械咔哒）。
      const freq = state.beat % 2 === 0 ? 2000 : 1500;
      click(ctx, gain, now, freq, 0.5);
    } else {
      // 节拍器：每 4 拍一重音（880Hz 短正弦），其余 1320Hz 轻拍。
      const accent = state.beat % 4 === 0;
      tone(ctx, gain, { freq: accent ? 880 : 1320, type: "sine", at: now, dur: 0.05, peak: accent ? 0.6 : 0.3 });
    }
    state.beat++;
  } catch {
    // closed — 下一拍由 setTickActive 的调用方负责重启
  }
}

/**
 * 启停专注滴答（模块级单例；切换音色/音量即时生效）。
 *
 * @param kind - 音色（none 关闭）。
 * @param volume - 音量 0..1。
 * @param active - 是否处于「应发声」状态（专注运行中）。
 * @returns 无。
 */
export function setTickActive(kind: TickSoundId, volume: number, active: boolean): void {
  if (!active || kind === "none") {
    stopTickNodes();
    return;
  }
  const v = Math.min(1, Math.max(0, volume));
  if (v <= 0) {
    stopTickNodes();
    return;
  }
  if (tick && tick.kind === kind) {
    try {
      tick.gain.gain.setTargetAtTime(v, tick.ctx.currentTime, 0.1);
    } catch {
      // closed
    }
    return;
  }
  stopTickNodes();
  try {
    const ctx = getTickCtx();
    if (!ctx) return;
    const gain = ctx.createGain();
    gain.gain.value = v;
    gain.connect(ctx.destination);
    const state: TickState = { kind, timer: 0, beat: 0, gain, ctx };
    scheduleTickBeat(state);
    state.timer = window.setInterval(() => scheduleTickBeat(state), 1000);
    tick = state;
  } catch {
    // Audio unavailable — tick is best-effort.
  }
}
