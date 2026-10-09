/* eslint-disable react-refresh/only-export-components */
/**
 * 音乐沉浸页（首批沉浸表面之一）：封面放大 + 封面 blur 背景 + 径向
 * 频谱 + 歌词预留位。
 *
 * 契约：经 registry 的 `ExpandedComponent` 挂到音乐/正在播放卡片，由
 * WidgetExpandOverlay 常驻叠放——active=false 时保持挂载但暂停重活
 * （媒体快照留在内存，重开瞬时恢复，见 expand-store 注释）。
 *
 * 动态配色：优先消费 SYS 会话 media 快照的 `palette` 三色
 * （{primary, onPrimary, track}，封面取色）；未合入时回退主题 accent。
 * 消费口收敛在 extractPalette 一处——后端字段合入后零改动生效。
 *
 * 数据源：改走共享 useNowPlaying（media:snapshot 事件 + 本地
 * 插值推进 + seekTo），替代此前 1s 全量轮询 get_system_media_info——
 * base64 封面不再每秒过 IPC，与卡片同一数据管道。歌词行点击 seek 同样
 * 走 seekTo（秒），仅当会话上报 IsPlaybackPositionEnabled 时可点。
 * repeat/shuffle 按钮消费快照 controls（同类媒体浮窗 对齐）。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Disc3,
  ExternalLink,
  MicVocal,
  Pause,
  Play,
  Repeat,
  Repeat1,
  Shuffle,
  SkipBack,
  SkipForward
} from "lucide-react";
import { isTauri, invoke } from "../../lib/tauri";
import { prefersReducedMotion } from "../../lib/anim";
import { fetchLyrics, indexForTime, type LrcLine } from "../../lib/lyrics";
import { useT } from "../../i18n-lite";
import { useNowPlaying } from "../../lib/use-now-playing";
import { useMediaSessions } from "../../lib/media-sessions";
import { useWidgetConfig } from "../widget-config";
import type { ExpandedComponentProps } from "../expand-store";
import { AudioVisualizer, type AudioSourceMode, type BandColorMode, type BandDistMode } from "./AudioVisualizer";

/** SYS 会话封面取色输出（media.rs 快照 palette 三色）；未合入时缺失。 */
export type MediaPalette = { primary: string; onPrimary: string; track: string };

const HEX_RE = /^#[0-9a-f]{6}([0-9a-f]{2})?$/i;

/**
 * 从媒体快照提取封面取色三色。字段缺失或非法时返回 null（调用方回退
 * 主题 token）。这里是 palette 的唯一消费口：media.rs 合入取色后，沉浸页
 * 无需任何改动即可切换为封面动态配色。
 */
export function extractPalette(m: unknown): MediaPalette | null {
  const p = (m as { palette?: Partial<MediaPalette> | null } | null)?.palette;
  if (!p || typeof p.primary !== "string" || typeof p.onPrimary !== "string" || typeof p.track !== "string")
    return null;
  if (!HEX_RE.test(p.primary) || !HEX_RE.test(p.onPrimary) || !HEX_RE.test(p.track)) return null;
  return { primary: p.primary, onPrimary: p.onPrimary, track: p.track };
}

function fmtTime(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return "0:00";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

/**
 * 音乐沉浸页。数据链路与 NowPlayingCard 相同（共享 useNowPlaying：
 * media:snapshot 事件 + 本地插值推进）；频谱采集按 active 门控，收起即停。
 */
export function MusicImmersive({ instanceId, active }: ExpandedComponentProps) {
  const tr = useT();
  /* 频谱参数镜像卡片配置（colorMode/gain/…），沉浸页与卡片观感一致。 */
  const { config, update: updateConfig } = useWidgetConfig(instanceId);
  const mode = ((config.mode as AudioSourceMode) || "playback") as AudioSourceMode;
  const colorMode = ((config.colorMode as BandColorMode) || "theme") as BandColorMode;
  const gain = typeof config.gain === "number" ? config.gain : 1;
  const smoothing = typeof config.smoothing === "number" ? config.smoothing : 0.5;
  const bandCount = typeof config.bandCount === "number" ? config.bandCount : 64;
  const dist = ((config.dist as BandDistMode) || "log") as BandDistMode;

  /* active=false（收起后保持挂载）时跳过 250ms 位置推进渲染：隐藏面板不重渲染。 */
  const { media, pos, seekTo } = useNowPlaying(active);
  /* 播放源会话列表：共享事件源（lib/media-sessions——Rust 每拍枚举变化时
     emit media:sessions + 30s 兜底复核；沉浸页与底层卡片同窗口共享一份）。 */
  const { sessions, selectedId: sessionId } = useMediaSessions(active);

  /* 传输控制：toggle 为主键动作（不依赖可能过期的 playing 快照），
     shuffle/repeat 为开关式动作，均由 Rust 按会话当前态处理。 */
  const control = (action: string) => {
    if (isTauri()) void invoke("control_system_media", { action }).catch(() => {});
  };

  /* 唤起播放器：与卡片封面点击同款（带曲目标题，浏览器可定位窗口）。 */
  const openPlayer = () => {
    if (!isTauri() || !media?.aumid) return;
    void invoke("open_media_player", { aumid: media.aumid, title: media.title }).catch(() => {});
  };

  /* 进度条 seek：点击 + 拖动（pointer capture），拖动中只更新预览，
     松手一次性 seekTo（乐观跳转 + 下发命令）。 */
  const barRef = useRef<HTMLDivElement>(null);
  const [dragRatio, setDragRatio] = useState<number | null>(null);
  const ratioFromEvent = (e: React.PointerEvent): number | null => {
    const el = barRef.current;
    if (!el || !media || !(media.duration > 0)) return null;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0) return null;
    return Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
  };

  /* ---- 歌词（默认关闭） ---- */
  const [lyricsOn, setLyricsOn] = useState(false);
  const [lyrics, setLyrics] = useState<LrcLine[] | null>(null);
  const [lyricsState, setLyricsState] = useState<"idle" | "loading" | "ok" | "none">("idle");
  /* 一.5 歌词延迟微调（秒，-5 ~ +5 步进 0.5，持久化在实例配置）：SMTC 时间轴
     与流媒体 App 内部进度存在整体快慢差，一个偏移量即可对齐。正值 = 歌词推后显示。 */
  const lyricOffsetSec =
    typeof config.lyricOffsetSec === "number" && Number.isFinite(config.lyricOffsetSec)
      ? Math.max(-5, Math.min(5, config.lyricOffsetSec))
      : 0;
  const nudgeLyricOffset = (delta: number) => {
    const next = Math.round(Math.min(5, Math.max(-5, lyricOffsetSec + delta)) * 2) / 2;
    updateConfig({ lyricOffsetSec: next });
  };
  const trackKey = media ? `${media.artist}|${media.title}` : "";
  useEffect(() => {
    if (!lyricsOn || !active || !media?.title) {
      // （旧歌词滞留）：切到无标题曲目/媒体清空时提前返回，但上一首的
      // 歌词与 ok 态原样保留并继续渲染——清空歌词来源（关闭/无曲目）时
      // 一并清屏；仅 inactive（临时失活）时保留现状。
      if (!lyricsOn || !media?.title) {
        setLyrics(null);
        setLyricsState("idle");
      }
      return;
    }
    const controller = new AbortController();
    setLyricsState("loading");
    setLyrics(null);
    fetchLyrics(media.artist, media.title, {
      album: media.album,
      durationSec: media.duration || undefined,
      signal: controller.signal
    })
      .then((lines) => {
        if (controller.signal.aborted) return;
        setLyrics(lines);
        setLyricsState(lines ? "ok" : "none");
      })
      .catch(() => {
        if (!controller.signal.aborted) setLyricsState("none");
      });
    return () => controller.abort();
    // 只在曲目切换/开关/激活翻转时重拉；media 对象引用每秒会变（position），故用 trackKey。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lyricsOn, active, trackKey]);

  /* 延迟微调只作用于「当前行判定」的显示口径；歌词行点击 seek 仍用原始时间戳（那是正确目标点）。 */
  const activeLine = lyrics ? indexForTime(lyrics, pos + lyricOffsetSec) : -1;
  /* 译文双行：引擎携带了任何译文行才显示开关；config.lyricTranslation 缺省开。 */
  const hasTranslation = !!lyrics?.some((l) => !!l.translation);
  const showTranslation = hasTranslation && config.lyricTranslation !== false;
  const lyricsListRef = useRef<HTMLDivElement>(null);
  /* 五.6 用户滚动感知：用户滚轮/触摸回看后暂停自动居中 4s 并显示「回到当前行」
     ——此前下一句激活时 scrollTo 会把列表从用户手里拽回去。监听 wheel/touch
     而非 scroll：程序化 smooth 滚动也会发 scroll 事件，会把自己误判成用户。 */
  const LYRICS_FOLLOW_PAUSE_MS = 4000;
  const userScrollResumeTimer = useRef(0);
  const [followPaused, setFollowPaused] = useState(false);
  /* 当前行自动居中：滚动容器内定位，reduce-motion 时瞬跳；用户回看窗口期内跳过。 */
  useEffect(() => {
    const list = lyricsListRef.current;
    if (!list || activeLine < 0) return;
    if (followPaused) return;
    const el = list.children[activeLine] as HTMLElement | undefined;
    if (!el) return;
    const top = el.offsetTop - list.clientHeight / 2 + el.offsetHeight / 2;
    list.scrollTo({ top: Math.max(0, top), behavior: prefersReducedMotion() ? "auto" : "smooth" });
  }, [activeLine, followPaused]);
  const onLyricsUserScroll = () => {
    window.clearTimeout(userScrollResumeTimer.current);
    setFollowPaused(true);
    userScrollResumeTimer.current = window.setTimeout(() => setFollowPaused(false), LYRICS_FOLLOW_PAUSE_MS);
  };
  const resumeLyricsFollow = () => {
    window.clearTimeout(userScrollResumeTimer.current);
    setFollowPaused(false);
  };
  useEffect(
    () => () => {
      window.clearTimeout(userScrollResumeTimer.current);
    },
    []
  );

  const palette = useMemo(() => extractPalette(media), [media]);
  /* 取色缺失时回退主题 token；CSS 全部经 --mi-* 局部变量取色。 */
  const style = {
    "--mi-accent": palette?.primary ?? "var(--accent)",
    "--mi-on-accent": palette?.onPrimary ?? "var(--paper-solid, #fff)",
    "--mi-track": palette?.track ?? "var(--accent-2)"
  } as React.CSSProperties;

  /* 能力位：旧载荷缺失时按可用降级。 */
  const ctl = media?.controls;
  const canToggle = !ctl || ctl.play || ctl.pause;
  const canSkip = !ctl || ctl.next || ctl.previous;
  const seekable = !ctl || ctl.seek;

  const basePct = media && media.duration > 0 ? Math.min(100, (pos / media.duration) * 100) : 0;
  const displayPct = dragRatio != null ? dragRatio * 100 : basePct;
  const displayPos = dragRatio != null && media ? dragRatio * media.duration : pos;
  const sessionName = sessions.find((s) => s.id === sessionId)?.name;

  /* 键盘 seek（a11y）：←/→ ±5s（Shift ±30s）、Home/End 到首尾；不可 seek
   * 或时长未知（直播）时与点击同口径禁用。 */
  const onBarKeyDown = (e: React.KeyboardEvent) => {
    if (!seekable || !media || !(media.duration > 0)) return;
    const step = e.shiftKey ? 30 : 5;
    let next: number | null = null;
    if (e.key === "ArrowRight" || e.key === "ArrowUp") next = Math.min(media.duration, pos + step);
    else if (e.key === "ArrowLeft" || e.key === "ArrowDown") next = Math.max(0, pos - step);
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = media.duration;
    if (next == null) return;
    e.preventDefault();
    seekTo(next);
  };

  return (
    <div className={`mi${active ? " is-active" : ""}`} style={style}>
      {/* 封面 blur 背景：同图放大 + 大半径模糊 + 压暗，叠加 accent 氛围层。
          五.4：key=thumb——换曲时重挂并播 mi-bg-in 淡入，替代背景图瞬变。 */}
      {media?.thumb && (
        <>
          <div
            key={media.thumb}
            className="mi-bg"
            style={{ backgroundImage: `url(${media.thumb})` }}
            aria-hidden="true"
          />
          <div className="mi-bg-tint" aria-hidden="true" />
        </>
      )}

      <div className="mi-main">
        {/* 封面 1.5×：卡片内 44px 封面在沉浸态放大为大尺寸主视觉。 */}
        <div className={`mi-cover-wrap${media?.playing ? " playing" : ""}`}>
          <div className="mi-cover">
            {media?.thumb ? (
              <img src={media.thumb} alt="" draggable={false} />
            ) : (
              <Disc3 size={64} className="mi-cover-fallback" />
            )}
          </div>
          {/* 径向频谱：环绕封面的环形放射（active 时才挂载，收起即停采集）。 */}
          <div className="mi-spectrum">
            {active && (
              <AudioVisualizer
                style="radial"
                height={0}
                mode={mode}
                colorMode={colorMode}
                gain={gain}
                smoothing={smoothing}
                bandCount={Math.max(bandCount, 48)}
                dist={dist}
              />
            )}
          </div>
        </div>

        <div className="mi-info">
          <div className="mi-title" title={media?.title}>
            {media?.title || tr("未知曲目")}
          </div>
          <div className="mi-artist" title={media?.artist}>
            {media?.artist || tr("未知艺术家")}
            {media?.album ? ` · ${media.album}` : ""}
          </div>
          {sessionName && (
            <button
              className="mi-source"
              onClick={openPlayer}
              disabled={!media?.aumid}
              title={tr("打开播放器")}
              data-interactive
            >
              <ExternalLink size={11} />
              <span>
                {tr("播放源")} · {sessionName}
              </span>
            </button>
          )}

          <div className="mi-progress">
            <span className="mi-time">{fmtTime(displayPos)}</span>
            {/* 时长未知（直播/部分流媒体）不渲染拖条与总时长，只留已播放时间。 */}
            {media != null && media.duration > 0 && (
              <div
                ref={barRef}
                className={`mi-bar${seekable ? "" : " is-disabled"}`}
                role="slider"
                aria-label={tr("播放进度")}
                aria-valuemin={0}
                aria-valuemax={media.duration}
                aria-valuenow={displayPos}
                aria-valuetext={`${fmtTime(displayPos)} / ${fmtTime(media.duration)}`}
                aria-disabled={!seekable}
                tabIndex={seekable ? 0 : -1}
                data-interactive={seekable || undefined}
                onKeyDown={onBarKeyDown}
                onPointerDown={(e) => {
                  if (!seekable || !media) return;
                  const r = ratioFromEvent(e);
                  if (r == null) return;
                  e.currentTarget.setPointerCapture(e.pointerId);
                  setDragRatio(r);
                }}
                onPointerMove={(e) => {
                  if (dragRatio == null) return;
                  const r = ratioFromEvent(e);
                  if (r != null) setDragRatio(r);
                }}
                onPointerUp={(e) => {
                  if (dragRatio == null || !media) return;
                  e.currentTarget.releasePointerCapture?.(e.pointerId);
                  const r = ratioFromEvent(e) ?? dragRatio;
                  setDragRatio(null);
                  seekTo(r * media.duration);
                }}
                onPointerCancel={() => setDragRatio(null)}
              >
                <div className="mi-bar-fill" style={{ transform: `scaleX(${displayPct / 100})` }} />
              </div>
            )}
            {media != null && media.duration > 0 && <span className="mi-time">{fmtTime(media.duration)}</span>}
          </div>

          <div className="mi-controls">
            {/* shuffle/repeat：会话上报能力时展示，状态随快照亮灭。 */}
            {ctl?.shuffle && (
              <button
                className={`mi-btn mi-mode${ctl.shuffleActive ? " is-on" : ""}`}
                onClick={() => control("shuffle")}
                aria-label={tr("随机播放")}
                aria-pressed={ctl.shuffleActive}
                title={tr("随机播放")}
                data-interactive
              >
                <Shuffle size={18} />
              </button>
            )}
            <button
              className="mi-btn"
              onClick={() => control("previous")}
              disabled={!canSkip}
              aria-label={tr("上一曲")}
              title={tr("上一曲")}
              data-interactive
            >
              <SkipBack size={18} />
            </button>
            <button
              className="mi-btn mi-toggle"
              onClick={() => control("toggle")}
              disabled={!canToggle}
              aria-label={media?.playing ? tr("暂停") : tr("播放")}
              title={media?.playing ? tr("暂停") : tr("播放")}
              data-interactive
            >
              {media?.playing ? <Pause size={22} /> : <Play size={22} />}
            </button>
            <button
              className="mi-btn"
              onClick={() => control("next")}
              disabled={!canSkip}
              aria-label={tr("下一曲")}
              title={tr("下一曲")}
              data-interactive
            >
              <SkipForward size={18} />
            </button>
            {ctl?.repeat && (
              <button
                className={`mi-btn mi-mode${ctl.repeatMode !== "off" ? " is-on" : ""}`}
                onClick={() => control("repeat")}
                aria-pressed={ctl.repeatMode !== "off"}
                aria-label={
                  ctl.repeatMode === "one" ? tr("单曲循环") : ctl.repeatMode === "all" ? tr("列表循环") : tr("关闭循环")
                }
                title={
                  ctl.repeatMode === "one" ? tr("单曲循环") : ctl.repeatMode === "all" ? tr("列表循环") : tr("关闭循环")
                }
                data-interactive
              >
                {ctl.repeatMode === "one" ? <Repeat1 size={18} /> : <Repeat size={18} />}
              </button>
            )}
          </div>
        </div>
      </div>

      {/* 歌词位（§4.11）：默认关闭；开启后 LRCLIB 两级取词 + 二分高亮当前行。 */}
      <div className={`mi-lyrics-slot${lyricsOn ? " on" : ""}`}>
        <div className="mi-lyrics-head">
          <span className="mi-lyrics-title">
            <MicVocal size={13} /> {tr("歌词")}
          </span>
          <span className="mi-lyrics-hint">
            {!lyricsOn
              ? tr("暂未启用")
              : lyricsState === "loading"
                ? tr("加载中…")
                : lyricsState === "none"
                  ? tr("暂无歌词")
                  : !media
                    ? tr("暂无播放信息")
                    : ""}
          </span>
          <button
            className={`mi-lyrics-toggle${lyricsOn ? " on" : ""}`}
            onClick={() => setLyricsOn((v) => !v)}
            aria-pressed={lyricsOn}
            data-interactive
          >
            {lyricsOn ? tr("关闭") : tr("开启")}
          </button>
          {/* 引擎升级：译文开关只在取到的歌词带译文时出现（QQ trans / 网易云 tlyric）。 */}
          {lyricsOn && hasTranslation && (
            <button
              className={`mi-lyrics-trans-toggle${showTranslation ? " on" : ""}`}
              onClick={() => updateConfig({ lyricTranslation: !showTranslation })}
              aria-pressed={showTranslation}
              aria-label={tr("译文")}
              data-interactive
            >
              {tr("译文")}
            </button>
          )}
          {/* 一.5 延迟微调：±0.5s 步进，当前偏移量即时可见（0 时显示「对齐」）。 */}
          {lyricsOn && (
            <span className="mi-lyrics-offset" role="group" aria-label={tr("歌词偏移")}>
              <button onClick={() => nudgeLyricOffset(-0.5)} aria-label={tr("歌词提前")} data-interactive>
                −
              </button>
              <span>{lyricOffsetSec === 0 ? tr("对齐") : `${lyricOffsetSec > 0 ? "+" : ""}${lyricOffsetSec}s`}</span>
              <button onClick={() => nudgeLyricOffset(0.5)} aria-label={tr("歌词延后")} data-interactive>
                ＋
              </button>
            </span>
          )}
        </div>
        {/* 一.11 歌词槽折叠：列表常驻挂载，开关走 .mi-lyrics-fold 的 grid-rows
            0fr→1fr 过渡（同番茄配置区范式），替换此前条件挂载的 ~108px 高度硬切。 */}
        <div className={`mi-lyrics-fold${lyricsOn && lyrics && lyrics.length > 0 ? " open" : ""}`}>
          <div className="mi-lyrics-clip">
            <div
              className="mi-lyrics-list"
              ref={lyricsListRef}
              role="list"
              onWheel={onLyricsUserScroll}
              onTouchMove={onLyricsUserScroll}
            >
              {(lyrics ?? []).map((l, i) => (
                <div
                  key={`${l.time}-${i}`}
                  role="listitem"
                  className={`mi-lyric-line${i === activeLine ? " is-active" : ""}${i < activeLine ? " is-past" : ""}${seekable ? " clickable" : ""}`}
                  onClick={seekable ? () => seekTo(l.time) : undefined}
                  onKeyDown={
                    seekable
                      ? (e) => {
                          if (e.key !== "Enter" && e.key !== " ") return;
                          e.preventDefault();
                          seekTo(l.time);
                        }
                      : undefined
                  }
                  tabIndex={seekable ? 0 : undefined}
                  data-interactive={seekable || undefined}
                >
                  {l.text}
                  {showTranslation && l.translation && <span className="mi-lyric-trans">{l.translation}</span>}
                </div>
              ))}
            </div>
            {/* 五.6：自动跟唱暂停提示——点击立即回到当前行（Apple Music 同语言）。 */}
            {followPaused && (
              <button className="mi-lyrics-resume" onClick={resumeLyricsFollow} data-interactive>
                {tr("回到当前行")}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
