import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { invoke, isTauri } from "./tauri";

/**
 * §4.8 「正在播放」共享数据源：SMTC 快照（事件）+ 位置本地推进 + 校准。
 *
 * 数据链路：
 *  - 挂载时 `get_system_media_info` 拉一次全量快照（含封面）作首帧——比等
 *    下一个事件快，且覆盖「事件线程尚未发出过快照」的冷启动窗口；
 *  - 此后订阅 Rust 事件线程的 `media:snapshot`：仅在曲目/播放态/封面/位置
 *    漂移 >1s 时到达（替代旧的每秒全量轮询，base64 封面不再每秒过 IPC）；
 *  - 两次事件之间本地推进 `pos`（250ms 步进）。Rust 侧快照 position 含
 *    LastUpdatedTime 插值（真实采样位置，同类媒体浮窗 同款），本地推进
 *    改为「锚点 + 真实流逝时间」插值而非固定累加——间歇掉帧/后台节流后
 *    一步追平，不产生累计漂移；到曲长即钳制（曲目结束态）。
 *  - 自愈补拉：事件只在「有变化」时推送——首帧拉取若恰逢 SMTC 瞬断/未
 *    就绪（返回 null 或失败），播放稳态下可能长时间没有下一条事件（不换
 *    曲、位置无漂移就不发），组件会一直停在「暂无播放信息」。media 为空
 *    期间按 4s→8s→15s 退避重拉，拉到即停；active 翻转为可见且仍无数据时
 *    立即补拉一次（用户正看着的面板优先自愈，如展开沉浸面板的首次显示）。
 *
 * 封面增量协议：`thumbChanged=false` 沿用上次封面；`true` 时 `thumb` 为新值
 * （null = 清除）。
 *
 * 收敛为模块级单例 store——此前每个消费组件各自
 * use 本 hook，同一窗口内音乐卡片 + 常驻沉浸页 + dock 迷你磁贴会各持一份
 * 全量快照（base64 封面可达数百 KB，内存 ×N），事件与初值拉取也各走各的。
 * 现在整窗只有一份监听 / 一次初值拉取 / 一个 250ms 推进节拍；数据经
 * useSyncExternalStore 订阅分发。消费分两档粒度：
 *  - media（曲目/封面/播放态，低频）：所有消费者共享；
 *  - pos（显示进度，4Hz）：只有 active 的消费者订阅（MusicMini /
 *    收起的沉浸页不再随进度重渲），订阅恢复时从锚点一步追平。
 *
 * @returns `{ media, pos, seekTo }`：media 为最近快照（无播放为 null）；pos
 *          为本地推进的显示进度（秒，active=false 冻结）；seekTo 乐观跳转
 *          并下发 seek 命令。浏览器模式恒为 null/0。
 *
 * @param active - false = 组件当前不可见（如沉浸面板收起后保持挂载的形态）：
 *        跳过 250ms 位置推进订阅，事件照常。恢复 true 后首拍从锚点追平。
 */

/** media.rs MediaControls：传输能力位 + 循环/随机状态。 */
export type MediaControls = {
  play: boolean;
  pause: boolean;
  next: boolean;
  previous: boolean;
  seek: boolean;
  shuffle: boolean;
  repeat: boolean;
  shuffleActive: boolean;
  /** "off" | "all" | "one" */
  repeatMode: string;
};

export type NowPlaying = {
  title: string;
  artist: string;
  album: string;
  playing: boolean;
  /** 事件锚点位置（秒），非显示进度。 */
  position: number;
  duration: number;
  thumb: string | null;
  /** §4.3 封面取色三色板（无封面为回退色板）。 */
  palette: MediaPalette | null;
  /** 传输能力位；旧载荷缺失时前端按「全部可用」降级处理。 */
  controls?: MediaControls;
  /** 当前会话 AUMID（唤起播放器/滚轮调应用音量用；缺失 = 未知）。 */
  aumid?: string;
};

/** media.rs MediaPalette：`#rrggbb` 三色（主色/主色前景/进度轨道）。 */
export type MediaPalette = {
  primary: string;
  onPrimary: string;
  track: string;
};

/** media.rs MediaSnapshot 事件载荷（snake_case 与 Rust serde 一致）。 */
type MediaSnapshotEvent = {
  title: string;
  artist: string;
  album: string;
  playing: boolean;
  position: number;
  duration: number;
  /** true = thumb 是新封面值（null=清除）；false = 沿用上次。 */
  thumbChanged: boolean;
  thumb: string | null;
  /** Some = 新取色结果（替换）；null/缺省 = 沿用上次。 */
  palette?: MediaPalette | null;
  controls?: MediaControls | null;
  aumid?: string | null;
};

/** 旧命令的载荷（thumb/palette 为全量字段）。 */
type SystemMediaCommand = Omit<NowPlaying, "thumb" | "palette"> & {
  thumb: string | null;
  palette?: MediaPalette | null;
};

/* ------------------------------------------------------------------ */
/* 模块级单例 store（本窗口唯一一份媒体快照与节拍）                      */
/* ------------------------------------------------------------------ */

let storeMedia: NowPlaying | null = null;
let storePos = 0;
/** 本地推进锚点：最近一次快照的 position 与到达时刻。 */
let anchorPos = 0;
let anchorAt = 0;
let storePlaying = false;
/** 事件到达代数——补拉在途时若有更近的事件（含空闲 null）到达，陈旧的
 * 拉取回复被丢弃，不再回退覆盖事件带来的新状态。 */
let eventSeq = 0;
let installed = false;
let tickTimer = 0;
let healTimer = 0;
/* media:snapshot 常驻监听句柄（仅供 __resetNowPlayingStoreForTest 卸载，
   生产路径常驻不主动卸——见 ensureInstalled 头注的成本权衡）。 */
let unlistenSnapshot: (() => void) | null = null;
/** 自愈退避档位（4s→8s→15s 封顶；拉到数据归零）。 */
const HEAL_STEPS_MS = [4000, 8000, 15000];
let healIdx = 0;
/** 连续多少拍「既无消费者也无媒体会话」后自停 heal 排程（防递归
 *  自续的空转定时器在无人使用的窗口里永远 4-15s 唤醒一次）。 */
const HEAL_IDLE_STOP_BEATS = 3;
let healIdleBeats = 0;

const mediaListeners = new Set<() => void>();
const posListeners = new Set<() => void>();

function notifyMedia() {
  for (const fn of mediaListeners) fn();
}

function notifyPos() {
  for (const fn of posListeners) fn();
}

/** 应用一个事件快照：thumb/palette/controls 增量合并 + 重置推进锚点。 */
function applySnapshot(snap: MediaSnapshotEvent) {
  const prev = storeMedia;
  const trackChanged =
    !!prev && (prev.title !== snap.title || prev.artist !== snap.artist || prev.album !== snap.album);
  const thumb = snap.thumbChanged || trackChanged || !prev ? (snap.thumb ?? null) : (prev.thumb ?? null);
  const next: NowPlaying = {
    title: snap.title,
    artist: snap.artist,
    album: snap.album,
    playing: !!snap.playing,
    position: Number.isFinite(snap.position) ? snap.position : 0,
    duration: Number.isFinite(snap.duration) ? snap.duration : 0,
    thumb,
    palette: snap.palette ?? prev?.palette ?? null,
    controls: snap.controls ?? prev?.controls,
    aumid: snap.aumid ?? prev?.aumid
  };
  anchorPos = next.position;
  anchorAt = performance.now();
  storePlaying = next.playing;
  storeMedia = next;
  storePos = next.position;
  notifyMedia();
  notifyPos();
}

/** 全量快照补拉（首帧 + 自愈）：有有效内容才入态，空闲/失败静默。 */
function pullSnapshot() {
  if (!isTauri()) return;
  const seq = eventSeq;
  void invoke<SystemMediaCommand | null>("get_system_media_info")
    .then((m) => {
      if (seq !== eventSeq || !m || (!m.title && !m.artist)) return;
      applySnapshot({ ...m, thumbChanged: true });
    })
    .catch(() => {});
}

/** 锚点插值出一拍显示进度（曲长钳制），并刷新锚点。 */
function advancePos() {
  if (!storePlaying) return;
  const next = anchorPos + (performance.now() - anchorAt) / 1000;
  const clamped = storeMedia && storeMedia.duration > 0 ? Math.min(next, storeMedia.duration) : next;
  anchorPos = clamped;
  anchorAt = performance.now();
  storePos = clamped;
}

function onMediaEvent(payload: MediaSnapshotEvent | null) {
  eventSeq++;
  if (!payload) {
    // 空闲（无会话/无内容）：清空显示。
    anchorPos = 0;
    anchorAt = 0;
    storePlaying = false;
    storeMedia = null;
    storePos = 0;
    notifyMedia();
    notifyPos();
    return;
  }
  if (!payload.title && !payload.artist) return; // 防御：无意义载荷
  applySnapshot(payload);
}

/** 自愈补拉排程：media 为空期间按 4s→8s→15s 退避重拉（拉到即归零）——
 *  快照事件只在有变化时推送，首帧拉取恰逢 SMTC 瞬断时会一直空着等下一条
 *  事件。无人订阅时跳过实际拉取。
 *  连续 {@link HEAL_IDLE_STOP_BEATS} 拍「无消费者且无媒体会话」后停止
 *  排程（不再无条件递归自续）；新消费者经 {@link ensureHeal} 重启。 */
function scheduleHeal(): void {
  healTimer = window.setTimeout(() => {
    healTimer = 0;
    const hasConsumers = mediaListeners.size + posListeners.size > 0;
    if (!storeMedia && hasConsumers) pullSnapshot();
    healIdx = storeMedia ? 0 : Math.min(healIdx + 1, HEAL_STEPS_MS.length - 1);
    if (!hasConsumers && !storeMedia) {
      if (++healIdleBeats >= HEAL_IDLE_STOP_BEATS) return; // 自停：不排下一拍
    } else {
      healIdleBeats = 0;
    }
    scheduleHeal();
  }, HEAL_STEPS_MS[healIdx]);
}

/** 消费者到来（订阅 / 可见性翻转发起的补拉）时（重）启动 heal 排程——
 *  自停后 healTimer 为 0，必须经本入口重新挂拍；空转拍计数一并清零。
 *  退避档同时归零——新消费者是新的补拉意图，不该继承空转期的旧档
 *  （否则自停重启后的首拍最长要等 15s）。 */
function ensureHeal(): void {
  healIdleBeats = 0;
  healIdx = 0;
  if (!healTimer) scheduleHeal();
}

/** 安装单例（首个订阅者挂载时执行一次；事件监听装好后常驻——事件低频，
 *  卸载重装的初值拉取比留着更贵；heal 节拍在无消费者时会自停，见
 *  scheduleHeal 的 注释）。 */
function ensureInstalled(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;
  if (!isTauri()) return;
  // 首帧：全量拉一次（含封面），冷启动不等事件。
  pullSnapshot();
  ensureHeal();
  void import("@tauri-apps/api/event")
    .then(({ listen }) => listen<MediaSnapshotEvent | null>("media:snapshot", (e) => onMediaEvent(e.payload)))
    .then((un) => {
      /* 句柄保留——__resetNowPlayingStoreForTest 卸监听兑现头注承诺，
         防 reset 后重装叠加第二份监听（生产路径无 reset，仅测试卫生）。 */
      unlistenSnapshot = un;
    })
    .catch(() => {
      // 监听失败：首帧拉取 + 自愈退避仍在，事件链路缺失。
    });
}

/* 250ms 步进渲染：位置 = 锚点 + 真实流逝时间（不累加、无累计漂移），
 * 暂停冻结在锚点；越曲长钳制到曲长（曲目结束）。interval 按 pos 订阅数
 * 启停（ensurePosTick / maybeStopPosTick）——不可见消费者（收起的沉浸页/
 * 迷你磁贴）不订阅即完全停表，不再 4 次/秒空转唤醒；锚点不重置，订阅
 * 恢复时 advancePos 从「锚点 + 流逝时间」一步追平。 */
const posTick = () => {
  if (!storePlaying || posListeners.size === 0) return;
  advancePos();
  notifyPos();
};

function ensurePosTick(): void {
  if (tickTimer) return;
  tickTimer = window.setInterval(posTick, 250);
}

function maybeStopPosTick(): void {
  if (posListeners.size > 0 || !tickTimer) return;
  window.clearInterval(tickTimer);
  tickTimer = 0;
}

function subscribeMedia(cb: () => void): () => void {
  mediaListeners.add(cb);
  ensureInstalled();
  ensureHeal();
  return () => {
    mediaListeners.delete(cb);
  };
}

function subscribePos(cb: () => void): () => void {
  const first = posListeners.size === 0;
  posListeners.add(cb);
  ensureInstalled();
  ensureHeal();
  if (first) ensurePosTick();
  // 订阅恢复（active 翻转/新消费者）：先把锚点追平到当前时刻，uSES 读到
  // 的首拍就是新鲜进度，而不是上一个订阅周期的陈值。
  advancePos();
  return () => {
    posListeners.delete(cb);
    maybeStopPosTick();
  };
}

const subscribeNone = () => () => {};

/* uSES 的 getSnapshot 用模块级稳定引用（内联箭头每次渲染新身份，多一次
 * 无谓的快照比对；值为对象时更要稳定）。 */
const getMediaSnapshot = () => storeMedia;
const getPosSnapshot = () => storePos;
const getMediaServerSnapshot = () => null;
const getPosServerSnapshot = () => 0;

/** 测试专用：重置模块级单例（清状态/停节拍/卸监听），保证用例隔离。
 *  heal 自停的空转拍计数一并归零（自停后 healTimer 已为 0）。 */
export function __resetNowPlayingStoreForTest(): void {
  if (tickTimer) window.clearInterval(tickTimer);
  if (healTimer) window.clearTimeout(healTimer);
  tickTimer = 0;
  healTimer = 0;
  healIdx = 0;
  healIdleBeats = 0;
  storeMedia = null;
  storePos = 0;
  anchorPos = 0;
  anchorAt = 0;
  storePlaying = false;
  eventSeq = 0;
  installed = false;
  /* 真卸监听（此前头注声称「卸监听」但只清定时器/订阅集——reset 后
     重装会叠加第二份 media:snapshot 监听；handler 幂等故行为无差，纯测试
     卫生收口）。 */
  unlistenSnapshot?.();
  unlistenSnapshot = null;
  mediaListeners.clear();
  posListeners.clear();
}

/**
 * seek：乐观更新锚点（进度条/歌词行立即跳转），SMTC Timeline 事件随后
 * 校准。参数为秒——Rust `control_system_media` 的 `position` 单位。
 */
export function seekTo(secs: number) {
  anchorPos = secs;
  anchorAt = performance.now();
  storePos = secs;
  notifyPos();
  if (isTauri()) {
    void invoke("control_system_media", { action: "seek", position: secs }).catch(() => {});
  }
}

/** 立即补拉一次全量快照（active 翻转为可见且仍无数据时的自愈入口）。
 *  这里也是明确的消费信号——若 heal 排程已因无消费者自停，随补拉重启。 */
export function pullNowPlaying(): void {
  pullSnapshot();
  ensureHeal();
}

export function useNowPlaying(active = true): {
  media: NowPlaying | null;
  pos: number;
  seekTo: (secs: number) => void;
} {
  const media = useSyncExternalStore(subscribeMedia, getMediaSnapshot, getMediaServerSnapshot);
  /* active=false：不订阅 pos（不随进度重渲），getSnapshot 仍在其它原因的重渲
   * 中读到最新值；active 翻转时 subscribe 身份变化触发重订 + 快照重读。 */
  const subscribePosForActive = useMemo(() => (active ? subscribePos : subscribeNone), [active]);
  const pos = useSyncExternalStore(subscribePosForActive, getPosSnapshot, getPosServerSnapshot);

  /** active 翻转为可见且仍无数据：立即补拉一次（翻转沿触发，挂载时不与
      首帧拉取重复）。展开沉浸面板/卡片重新可见时，事件可能迟迟不来。
      走公开入口 pullNowPlaying（补拉 + ensureHeal）——此前直调内部
      pullSnapshot 绕过了 heal 重启语义（heal 自停后的首次可见补拉不续表）。 */
  const prevActiveRef = useRef(active);
  useEffect(() => {
    if (active && !prevActiveRef.current && !storeMedia) pullNowPlaying();
    prevActiveRef.current = active;
  }, [active]);

  return { media, pos, seekTo };
}

/* ------------------------------------------------------------------ */
/* 「仅播放时显示」轻量播放态：media store 的布尔派生                     */
/* ------------------------------------------------------------------ */

/**
 * 一.6「仅播放时显示」自动隐藏的轻量播放态订阅：只关心 playing 布尔，
 * 不做位置推进定时器（DockShell 常驻消费，250ms 重渲染不可接受）。
 * 判定口径与 useNowPlaying 一致：有会话、有标题且 SMTC 状态为 Playing。
 *
 * 与全量快照同源（模块级单例 store）——此前独立监听 + 独立初值拉取，
 * 同窗口两份 media:snapshot 监听、两次 get_system_media_info。现在布尔从
 * 共享 media 派生，播放态翻转经订阅分发；事件低频（换曲/播放态变化），
 * 派生重渲与旧实现同阶。
 */
export function useMediaPlaying(): boolean {
  const media = useSyncExternalStore(subscribeMedia, getMediaSnapshot, getMediaServerSnapshot);
  return !!media && !!media.playing && !!media.title;
}
