import { useCallback, useEffect, useRef, useState } from "react";
import { invoke, isTauri } from "./tauri";
import { useTauriEvent } from "./use-tauri-event";

/**
 * §4.8 「正在播放」共享数据源：SMTC 快照（事件）+ 位置本地推进 + 校准。
 *
 * 数据链路：
 *  - 挂载时 `get_system_media_info` 拉一次全量快照（含封面）作首帧——比等
 *    下一个事件快，且覆盖「事件线程尚未发出过快照」的冷启动窗口；
 *  - 此后订阅 Rust 事件线程的 `media:snapshot`：仅在曲目/播放态/封面/位置
 *    漂移 >1s 时到达（替代旧的每秒全量轮询，base64 封面不再每秒过 IPC）；
 *  - 两次事件之间本地推进 `pos`（250ms 步进）。Rust 侧快照 position 含
 *    LastUpdatedTime 插值（真实采样位置，同类媒体浮窗同款），本地推进
 *    改为「锚点 + 真实流逝时间」插值而非固定累加——间歇掉帧/后台节流后
 *    一步追平，不产生累计漂移；到曲长即钳制（曲目结束态）。
 *  - 自愈补拉：事件只在「有变化」时推送——首帧拉取若恰逢 SMTC 瞬断/未
 *    就绪（返回 null 或失败），播放稳态下可能长时间没有下一条事件（不换
 *    曲、位置无漂移就不发），组件会一直停在「暂无播放信息」。media 为空
 *    期间每 4s 重拉一次，拉到即停；active 翻转为可见且仍无数据时立即补拉
 *    一次（用户正看着的面板优先自愈，如展开沉浸面板的首次显示）。
 *
 * 封面增量协议：`thumbChanged=false` 沿用上次封面；`true` 时 `thumb` 为新值
 * （null = 清除）。多个组件各自 use 本 hook 时，封面状态在组件内各自维护。
 *
 * @returns `{ media, pos, seekTo }`：media 为最近快照（无播放为 null）；pos
 *          为本地推进的显示进度（秒）；seekTo 乐观跳转并下发 seek 命令。
 *          浏览器模式恒为 null/0。
 *
 * @param active - false = 组件当前不可见（如沉浸面板收起后保持挂载的形态）：
 *        跳过 250ms 位置推进渲染，事件订阅保持。恢复 true 后首拍从锚点追平。
 */

/** media.rs MediaControls：传输能力位 + 循环/随机状态（W-130）。 */
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
  /** 当前会话 AUMID（W-131：唤起播放器/滚轮调应用音量用；缺失 = 未知）。 */
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

export function useNowPlaying(active = true): {
  media: NowPlaying | null;
  pos: number;
  seekTo: (secs: number) => void;
} {
  const [media, setMedia] = useState<NowPlaying | null>(null);
  const [pos, setPos] = useState(0);
  /** 本地推进锚点：最近一次快照的 position 与到达时刻。 */
  const posRef = useRef(0);
  const anchorAtRef = useRef(0);
  const playingRef = useRef(false);
  const mediaRef = useRef<NowPlaying | null>(null);
  /** active 经 ref 读取：切换不重建 interval/订阅，只跳过推进渲染。 */
  const activeRef = useRef(active);
  activeRef.current = active;
  /** 卸载后丢弃在途回复（避免对已卸载组件 setState）。 */
  const aliveRef = useRef(true);
  useEffect(
    () => () => {
      aliveRef.current = false;
    },
    []
  );

  /** 应用一个事件快照：thumb/palette/controls 增量合并 + 重置推进锚点。
      只读 ref 与稳定的 setState，可安全被 useCallback([]) 捕获。 */
  const applySnapshot = useCallback((snap: MediaSnapshotEvent) => {
    const prev = mediaRef.current;
    const trackChanged =
      !!prev && (prev.title !== snap.title || prev.artist !== snap.artist || prev.album !== snap.album);
    const thumb = snap.thumbChanged || trackChanged || !prev ? (snap.thumb ?? null) : (prev.thumb ?? null);
    const next: NowPlaying = {
      title: snap.title,
      artist: snap.artist,
      album: snap.album,
      playing: snap.playing,
      position: snap.position,
      duration: snap.duration,
      thumb,
      palette: snap.palette ?? prev?.palette ?? null,
      controls: snap.controls ?? prev?.controls,
      aumid: snap.aumid ?? prev?.aumid
    };
    posRef.current = snap.position;
    anchorAtRef.current = performance.now();
    playingRef.current = snap.playing;
    mediaRef.current = next;
    setMedia(next);
    setPos(snap.position);
  }, []);

  /** 全量快照补拉（首帧 + 自愈）：有有效内容才入态，空闲/失败静默。 */
  const pullSnapshot = useCallback(() => {
    if (!isTauri()) return;
    void invoke<SystemMediaCommand | null>("get_system_media_info")
      .then((m) => {
        if (!aliveRef.current || !m || (!m.title && !m.artist)) return;
        applySnapshot({ ...m, thumbChanged: true });
      })
      .catch(() => {});
  }, [applySnapshot]);

  useTauriEvent<MediaSnapshotEvent | null>("media:snapshot", (payload) => {
    if (!payload) {
      // 空闲（无会话/无内容）：清空显示。
      posRef.current = 0;
      anchorAtRef.current = 0;
      playingRef.current = false;
      mediaRef.current = null;
      setMedia(null);
      setPos(0);
      return;
    }
    if (!payload.title && !payload.artist) return; // 防御：无意义载荷
    applySnapshot(payload);
  });

  /** seek：乐观更新锚点（进度条/歌词行立即跳转），SMTC Timeline 事件随后
      校准。参数为秒——Rust `control_system_media` 的 `position` 单位。 */
  const seekTo = useCallback((secs: number) => {
    posRef.current = secs;
    anchorAtRef.current = performance.now();
    setPos(secs);
    if (isTauri()) {
      void invoke("control_system_media", { action: "seek", position: secs }).catch(() => {});
    }
  }, []);

  /** active 翻转为可见且仍无数据：立即补拉一次（翻转沿触发，挂载时不与
      首帧拉取重复）。展开沉浸面板/卡片重新可见时，事件可能迟迟不来。 */
  const prevActiveRef = useRef(active);
  useEffect(() => {
    if (active && !prevActiveRef.current && !mediaRef.current) pullSnapshot();
    prevActiveRef.current = active;
  }, [active, pullSnapshot]);

  useEffect(() => {
    if (!isTauri()) return;
    // 首帧：全量拉一次（含封面），冷启动不等事件。
    pullSnapshot();
    // 自愈补拉：media 为空期间每 4s 重拉（拉到即停）——快照事件只在有变化
    // 时推送，首帧拉取恰逢 SMTC 瞬断时会一直空着等下一条事件。
    const heal = window.setInterval(() => {
      if (mediaRef.current) return;
      pullSnapshot();
    }, 4000);
    // 250ms 步进渲染：位置 = 锚点 + 真实流逝时间（不累加、无累计漂移），
    // 暂停冻结在锚点；越曲长钳制到曲长（曲目结束）。active=false（展开面板
    // 收起后保持挂载的隐藏形态）跳过推进渲染，避免不可见面板 4 次/秒重渲染；
    // 锚点不重置，恢复 active 时从「锚点 + 流逝时间」一步追平，无跳变。
    const tick = window.setInterval(() => {
      if (!activeRef.current || !playingRef.current) return;
      const media = mediaRef.current;
      const next = posRef.current + (performance.now() - anchorAtRef.current) / 1000;
      const clamped = media && media.duration > 0 ? Math.min(next, media.duration) : next;
      posRef.current = clamped;
      anchorAtRef.current = performance.now();
      setPos(clamped);
    }, 250);
    return () => {
      window.clearInterval(tick);
      window.clearInterval(heal);
    };
  }, [pullSnapshot]);

  return { media, pos, seekTo };
}

/**
 * 一.6「仅播放时显示」自动隐藏的轻量播放态订阅：只关心 playing 布尔，
 * 不做位置推进定时器（DockShell 常驻订阅，250ms 重渲染不可接受）。
 * 判定口径与 useNowPlaying 一致：有会话、有标题且 SMTC 状态为 Playing。
 */
export function useMediaPlaying(): boolean {
  const [playing, setPlaying] = useState(false);
  const lastRef = useRef(false);
  const apply = (v: boolean) => {
    if (v !== lastRef.current) {
      lastRef.current = v;
      setPlaying(v);
    }
  };
  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    void invoke<{ playing: boolean; title: string } | null>("get_system_media_info")
      .then((m) => {
        if (!disposed) apply(!!m && m.playing && !!m.title);
      })
      .catch(() => {});
    return () => {
      disposed = true;
    };
  }, []);
  useTauriEvent<MediaSnapshotEvent | null>("media:snapshot", (payload) => {
    apply(!!payload && payload.playing && !!payload.title);
  });
  return playing;
}
