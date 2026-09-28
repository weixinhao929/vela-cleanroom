/**
 * 音乐小组件：系统「正在播放」卡片（SMTC §4.8 事件化：media:snapshot 变化
 * 才发 + 250ms 本地进度推进）、频谱可视化与多媒体会话选择（锁定特定播放源）。
 * 配置经统一就地弹层 WidgetConfigPopover（B1）：组件右键打开；此前的右键
 * 勾选式快捷菜单（布局/检测源/样式）已删除。播放源选择（W-123）仍在
 * 「正在播放」卡片的右键/齿轮里。
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  Activity,
  AudioLines,
  Check,
  Disc3,
  Mic,
  Pause,
  Play,
  Repeat,
  Repeat1,
  Settings,
  Shuffle,
  SkipBack,
  SkipForward,
  Volume2
} from "lucide-react";
import { invoke, isTauri } from "../../lib/tauri";
import { FxDecrypt } from "../../lib/fx";
import { notifyOsd } from "../../lib/osd-events";
import { openContextMenu } from "../../components/ContextMenu";
import { useT } from "../../i18n-lite";
import { useTauriEvent } from "../../lib/use-tauri-event";
import { useNowPlaying } from "../../lib/use-now-playing";
import { useMediaSessions } from "../../lib/media-sessions";
import { useSettingsStore } from "../../store/settings-store";
import { useWidgetConfig } from "../widget-config";
import { useWidgetStore } from "../widget-store";
import { WidgetConfigPopover, type PopoverAnchor } from "../WidgetConfigPopover";
import {
  AudioVisualizer,
  type AudioSourceMode,
  type BandColorMode,
  type BandDistMode,
  type VisualStyle
} from "./AudioVisualizer";

/** W-118 布局：纯频谱 / 正在播放卡 / 两者。 */
type MusicLayout = "spectrum" | "nowplaying" | "both";

function fmtTime(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return "0:00";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

/**
 * W-118 「正在播放」卡片：歌名/歌手/封面/进度条 + 播放控制。
 * §4.8 事件化：数据源换共享 useNowPlaying（Rust WinRT 事件 → media:snapshot，
 * 变化才发 + 本地插值推进 + 事件校准），替代此前每秒全量轮询——base64
 * 封面不再每秒过 IPC，换曲/播放态变化即时到达。控制键走 control_system_media。
 *
 * W-130 进度条增强：进度条可点/可拖 seek（会话支持时，拖动中显示
 * 预览位置、松手下发）；按快照 controls 能力位置灰无效按钮（浏览器视频页
 * 常无上一曲/定位）；播放/暂停走 toggle（不依赖可能过期的 playing 快照）。
 *
 * W-123 卡片右键 = 多媒体会话选择器：Spotify / 浏览器等多个播放源并存时
 * 锁定其中一个，自动模式取「前台或正在播放」的那个。
 */
/** 正在播放卡片的展示开关（设置窗专段 / 齿轮快捷表可调，均默认生效）。 */
type NowPlayingCardOptions = {
  /** 标题与歌手居中（同类媒体浮窗同款）。 */
  centerTitle: boolean;
  /** 显示进度条（可点/可拖 seek）。 */
  showSeekbar: boolean;
  /** 显示随机/循环按钮（按会话上报能力位出现）。 */
  showModeButtons: boolean;
  /** 滚轮调节当前播放源的应用音量。 */
  wheelVolume: boolean;
};

function NowPlayingCard({
  onSessionsMenu,
  options
}: {
  onSessionsMenu?: (e: React.MouseEvent) => void;
  options: NowPlayingCardOptions;
}) {
  const tr = useT();
  const { media, pos, seekTo } = useNowPlaying();

  const control = (action: string) => {
    void invoke("control_system_media", { action }).catch(() => {});
  };

  /* W-131 封面点击唤起播放器（同类媒体浮窗同目的）：
     带曲目标题，浏览器多窗口时可定位到播放那个。 */
  const openPlayer = () => {
    if (!media?.aumid) return;
    void invoke("open_media_player", { aumid: media.aumid, title: media.title }).catch(() => {});
  };

  /* W-131 滚轮调「正在播放应用」的会话音量（ISimpleAudioVolume）：上滚 +
     5%、下滚 −5%，卡片浮标回显约 1.2s。120ms 节流防 WASAPI 请求风暴；
     应用没有音频会话（如部分 UWP 桥接）时后端返回 None，浮标不出现。 */
  const [volPill, setVolPill] = useState<number | null>(null);
  const volTimer = useRef(0);
  const lastWheel = useRef(0);
  const onCardWheel = (e: React.WheelEvent) => {
    if (!media?.aumid || !options.wheelVolume) return;
    const now = performance.now();
    if (now - lastWheel.current < 120) return;
    lastWheel.current = now;
    const delta = e.deltaY < 0 ? 0.05 : -0.05;
    void invoke<number | null>("adjust_media_app_volume", { aumid: media.aumid, delta })
      .then((v) => {
        if (typeof v !== "number") return;
        /* G10：滚轮调应用音量 → 灵动岛 OSD 接管（卡片浮标照常回显）。 */
        notifyOsd("volume", tr("音量"), `${Math.round(v * 100)}%`);
        setVolPill(Math.round(v * 100));
        window.clearTimeout(volTimer.current);
        volTimer.current = window.setTimeout(() => setVolPill(null), 1200);
      })
      .catch(() => {});
  };
  useEffect(() => () => window.clearTimeout(volTimer.current), []);

  /* W-130 进度条 seek：点击 + 拖动（pointer capture），拖动中只更新预览，
     松手一次性下发，拖动期间本地推进被预览值覆盖。 */
  const barRef = useRef<HTMLDivElement>(null);
  const [dragRatio, setDragRatio] = useState<number | null>(null);
  const ratioFromEvent = (e: React.PointerEvent): number | null => {
    const el = barRef.current;
    if (!el || !media || !(media.duration > 0)) return null;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0) return null;
    return Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
  };

  /* P-perf 三轮：进度显示 1Hz 节流 + CSS --dur-np-progress 线性平滑。此前
     250ms tick 每次写 style.transform 都会触发 useClickThrough 的全量命中
     采集（播放期 4 次/s × O(可交互元素数)）。大跳（换曲 / seek 校准 >15%）
     立即追平并以 .snap 跳变，不播倒退/快进爬行；拖动 seek 走 dragRatio 直显。
     hooks 须在下方提前 return 之前调用，故 media 取空安全口径。 */
  const basePct = media && media.duration > 0 ? Math.min(100, (pos / media.duration) * 100) : 0;
  const basePctRef = useRef(basePct);
  basePctRef.current = basePct;
  const [shownPct, setShownPct] = useState(basePct);
  useEffect(() => {
    /* 大跳立即追平（换曲 / seek 落点回填），常规推进交给 1s 节拍。 */
    if (Math.abs(basePct - shownPct) > 15) setShownPct(basePct);
  }, [basePct, shownPct]);
  useEffect(() => {
    const iv = window.setInterval(() => {
      if (document.hidden) return;
      setShownPct(basePctRef.current);
    }, 1000);
    return () => window.clearInterval(iv);
  }, []);
  const displayPct = dragRatio != null ? dragRatio * 100 : shownPct;
  /* 与上一渲染帧的差值决定是否旁路过渡（.snap）：>15% 视为数据跳变。 */
  const lastRenderPct = useRef(displayPct);
  useLayoutEffect(() => {
    lastRenderPct.current = displayPct;
  });
  const pctSnapped = Math.abs(displayPct - lastRenderPct.current) > 15;

  if (!isTauri()) {
    return (
      <div className="np np-empty">
        <Disc3 size={22} />
        <span>{tr("系统媒体信息需在应用内查看")}</span>
      </div>
    );
  }
  if (!media) {
    return (
      <div className="np np-empty">
        <Disc3 size={22} className="np-empty-spin" />
        <span>{tr("暂无播放信息")}</span>
      </div>
    );
  }

  /* 能力位（W-130）：旧载荷缺失（undefined）时按可用降级，不误灰。 */
  const ctl = media.controls;
  const canToggle = !ctl || ctl.play || ctl.pause;
  const canSkip = !ctl || ctl.next || ctl.previous;
  const seekable = !ctl || ctl.seek;

  const displayPos = dragRatio != null ? dragRatio * media.duration : pos;

  return (
    <div
      className={`np${options.centerTitle ? " np-centered" : ""}`}
      onWheel={onCardWheel}
      onContextMenu={(e) => onSessionsMenu?.(e)}
    >
      {/* 常驻挂载 + show 类过渡（同 .music-mute-flash 范式）：此前条件渲染，
          滚轮调音量的浮现/消失都是硬切。 */}
      <div className={`np-vol${volPill != null ? " show" : ""}`} aria-hidden="true">
        <Volume2 size={11} />
        <span>{volPill != null ? `${volPill}%` : ""}</span>
      </div>
      <div className="np-cover-wrap">
        {media.playing && <span className="np-cover-glow" aria-hidden="true" />}
        <div
          className={`np-cover${media.playing ? " is-playing" : ""}${media.aumid ? " is-openable" : ""}`}
          onClick={openPlayer}
          role="button"
          tabIndex={media.aumid ? 0 : -1}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") openPlayer();
          }}
          aria-label={tr("打开播放器")}
          title={media.aumid ? tr("打开播放器") : undefined}
          data-interactive={media.aumid ? true : undefined}
        >
          {media.thumb ? (
            <img src={media.thumb} alt="" width={44} height={44} draggable={false} />
          ) : (
            <Disc3 size={26} />
          )}
        </div>
      </div>
      <div className="np-body">
        {/* 曲目/艺术家切换走 FxDecrypt 乱码解密（fx 关闭时退化为纯文本），
              替代此前的文本瞬换。 */}
        <div className="np-title" title={media.title}>
          <FxDecrypt text={media.title || tr("未知曲目")} />
        </div>
        <div className="np-artist" title={`${media.artist}${media.album ? " · " + media.album : ""}`}>
          <FxDecrypt text={`${media.artist || tr("未知艺术家")}${media.album ? ` · ${media.album}` : ""}`} />
        </div>
        {options.showSeekbar && (
          <div className="np-progress">
            <span className="np-time">{fmtTime(displayPos)}</span>
            <div
              ref={barRef}
              className={`np-bar-hit${seekable ? "" : " is-disabled"}`}
              aria-label={tr("播放进度")}
              onPointerDown={(e) => {
                if (!seekable) return;
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
                if (dragRatio == null) return;
                e.currentTarget.releasePointerCapture?.(e.pointerId);
                const r = ratioFromEvent(e) ?? dragRatio;
                setDragRatio(null);
                seekTo(r * media.duration);
              }}
              onPointerCancel={() => setDragRatio(null)}
            >
              <div className="np-bar">
                <div
                  className={`np-bar-fill${pctSnapped ? " snap" : ""}`}
                  style={{ transform: `scaleX(${displayPct / 100})` }}
                />
              </div>
            </div>
            <span className="np-time">{fmtTime(media.duration)}</span>
          </div>
        )}
      </div>
      <div className="np-controls">
        {/* 播放源选择此前仅右键可达：补一个齿轮按钮走同一菜单（键盘/触屏可用）。 */}
        <button
          className="np-btn np-gear"
          onClick={(e) => {
            e.stopPropagation();
            onSessionsMenu?.(e);
          }}
          aria-label={tr("选择播放源")}
          title={tr("选择播放源")}
          data-interactive
        >
          <Settings size={13} />
        </button>
        {/* 随机/循环（W-130，与音乐沉浸页同款）：按会话上报能力位出现，
              开关式动作由 Rust 按会话当前态处理；设置可整体隐藏。 */}
        {options.showModeButtons && ctl?.shuffle && (
          <button
            className={`np-btn np-mode${ctl.shuffleActive ? " is-on" : ""}`}
            onClick={() => control("shuffle")}
            aria-pressed={ctl.shuffleActive}
            aria-label={tr("随机播放")}
            title={tr("随机播放")}
            data-interactive
          >
            <Shuffle size={12} />
          </button>
        )}
        {options.showModeButtons && ctl?.repeat && (
          <button
            className={`np-btn np-mode${ctl.repeatMode !== "off" ? " is-on" : ""}`}
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
            {ctl.repeatMode === "one" ? <Repeat1 size={13} /> : <Repeat size={13} />}
          </button>
        )}
        <button
          className="np-btn"
          onClick={() => control("previous")}
          disabled={!canSkip}
          aria-label={tr("上一曲")}
          title={tr("上一曲")}
          data-interactive
        >
          <SkipBack size={14} />
        </button>
        <button
          className="np-btn np-toggle"
          onClick={() => control("toggle")}
          disabled={!canToggle}
          aria-label={media.playing ? tr("暂停") : tr("播放")}
          title={media.playing ? tr("暂停") : tr("播放")}
          data-interactive
        >
          {media.playing ? <Pause size={16} /> : <Play size={16} />}
        </button>
        <button
          className="np-btn"
          onClick={() => control("next")}
          disabled={!canSkip}
          aria-label={tr("下一曲")}
          title={tr("下一曲")}
          data-interactive
        >
          <SkipForward size={14} />
        </button>
      </div>
    </div>
  );
}

/**
 * 音频监控小组件 —— 频谱可视化 + 可选「正在播放」卡片。
 *
 * 数据链路：
 *  - 频谱：WASAPI 采集（audio.rs）→ audio:spectrum 事件 → AudioVisualizer；
 *  - 正在播放：SMTC（media.rs）→ get_system_media_info / control_system_media。
 *
 * 配置（config-schemas.ts）：
 *  - layout        spectrum / nowplaying / both（W-118）
 *  - visualStyle   bars / wave / mirror / minimal / radial / butterfly
 *  - visualHeight  可视化高度（10–100，占卡片内容区高度的百分比）
 *  - mode          检测源：playback / microphone / both
 *  - colorMode     theme / mono / rainbow（W-124）
 *  - gain          灵敏度 0.5–3（W-125）
 *  - smoothing     平滑度 0–1（W-125）
 *  - bandCount     频带数 16–96（W-119）
 *  - peakHold      峰值保持帽线（W-119）
 *  - dist          频带分布 log / linear（W-127）
 *  - showStatusText 底部状态文字行显示开关
 */
export function MusicWidget({ instanceId, forceLayout }: { instanceId: string; forceLayout?: MusicLayout }) {
  const tr = useT();
  const { config } = useWidgetConfig(instanceId);
  const visualStyle = ((config.visualStyle as VisualStyle) || "bars") as VisualStyle;
  /* 可视化高度：占卡片内容区高度的百分比（10–100），随卡片缩放而非固定 px。 */
  const visualHeight = typeof config.visualHeight === "number" ? config.visualHeight : 64;
  const visualHeightPct = `${Math.min(100, Math.max(10, visualHeight))}%`;
  const mode = ((config.mode as AudioSourceMode) || "playback") as AudioSourceMode;
  const layout = forceLayout ?? (((config.layout as MusicLayout) || "spectrum") as MusicLayout);
  const colorMode = ((config.colorMode as BandColorMode) || "theme") as BandColorMode;
  const gain = typeof config.gain === "number" ? config.gain : 1;
  const smoothing = typeof config.smoothing === "number" ? config.smoothing : 0.5;
  const bandCount = typeof config.bandCount === "number" ? config.bandCount : 64;
  const peakHold = config.peakHold === true;
  const dist = ((config.dist as BandDistMode) || "log") as BandDistMode;
  /* 底部状态文字（监听中/正在发声 + 来源提示行）可整体隐藏，纯频谱更干净。 */
  const showStatusText = config.showStatusText !== false;
  /* 透明（无底板）：对齐时钟——去掉卡片底板/边框/投影/毛玻璃，只留内容。 */
  const transparent = config.transparent === true;

  /* 正在播放卡片的展示开关（nowplaying 类型专段；音乐类型这些键无消费者）。 */
  const cardOptions = {
    centerTitle: config.centerTitle === true,
    showSeekbar: config.showSeekbar !== false,
    showModeButtons: config.showModeButtons !== false,
    wheelVolume: config.wheelVolume !== false
  };

  /* 监听音频事件：状态角标（是否正在发声）+ W-120 响度数值。
   * P2（审计修复）：事件率 30fps 直接 setLevelPct 会让本子树以事件率重渲。
   * 改为 rAF 合帧 + 差值阈值：仅在取整百分比变化时 setState，稳态音频播放
   * 时重渲染从 30 次/s 降到个位数。 */
  const [active, setActive] = useState(false);
  const [levelPct, setLevelPct] = useState(0);
  const activeTimer = useRef(0);
  const levelRaf = useRef(0);
  const pendingLevel = useRef<number | null>(null);
  const levelLastAt = useRef(0);
  useEffect(
    () => () => {
      window.clearTimeout(activeTimer.current);
      cancelAnimationFrame(levelRaf.current);
    },
    []
  );
  useTauriEvent<{ level?: number }>("audio:spectrum", (payload) => {
    const lv = Number(payload?.level);
    if (!Number.isFinite(lv)) return;
    if (lv > 0.02) {
      setActive(true);
      window.clearTimeout(activeTimer.current);
      activeTimer.current = window.setTimeout(() => setActive(false), 600);
    }
    pendingLevel.current = Math.round(Math.min(1, Math.max(0, lv)) * 100);
    if (levelRaf.current) return;
    levelRaf.current = requestAnimationFrame(() => {
      levelRaf.current = 0;
      const pct = pendingLevel.current;
      pendingLevel.current = null;
      /* 200ms 最小间隔（P-perf 三轮）：电平条的 style 写会触发 useClickThrough
         全量命中采集，5Hz 对 VU 读数与电平条视觉无损。 */
      const now = performance.now();
      if (pct == null || now - levelLastAt.current < 200) return;
      levelLastAt.current = now;
      setLevelPct((prev) => (prev === pct ? prev : pct));
    });
  });

  /* W-123 多媒体会话：3 秒轮询可用会话与当前锁定项，右键卡片即出选择器。
     只在「正在播放」卡实际显示时轮询：纯频谱布局下选择器没有入口，轮询是
     纯空转 IPC（每实例 2 次/3s，多实例放大）。 */
  const pollSessions = layout === "nowplaying" || layout === "both";
  // 共享轮询器（lib/media-sessions）：沉浸页展开 / 多实例并存时窗口内只跑
  // 一份 3s 轮询，订阅分发且内容不变保持旧引用。
  const { sessions, selectedId: sessionId } = useMediaSessions(pollSessions);
  const setSessionId = (id: string | null) => {
    if (isTauri()) void invoke("select_media_session", { id }).catch(() => {});
  };

  /* W-131 媒体监控行为偏好（全局设置 general.media）：黑名单在会话菜单里
     维护；独占播放入口有两处——此处就近管理 + 设置窗「正在播放」专段，
     两处读写同一份（双入口同源，灵动岛设置同款模式）。 */
  const mediaPrefs = useSettingsStore((s) => s.general.media);
  const setGeneral = useSettingsStore((s) => s.setGeneral);
  const blockedIds = mediaPrefs?.blockedSessions ?? [];
  const setBlocked = (list: string[]) =>
    setGeneral({
      media: {
        pauseOthers: mediaPrefs?.pauseOthers ?? false,
        blockedSessions: list,
        focusPause: mediaPrefs?.focusPause === true
      }
    });

  /* W-123/W-131 卡片右键：多媒体会话选择器。锁定点击会话名；「隐藏播放源…」
     二级弹出选择要隐藏的应用；已隐藏项在菜单底部点击恢复。 */
  const menuAnchor = useRef({ x: 0, y: 0 });
  const reopenMenuAtAnchor = (items: Parameters<typeof openContextMenu>[1]) => {
    const { x, y } = menuAnchor.current;
    openContextMenu({ clientX: x, clientY: y, preventDefault() {}, stopPropagation() {} }, items);
  };
  const onSessionsMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    menuAnchor.current = { x: e.clientX, y: e.clientY };
    const visible = sessions.filter((s) => !s.blocked);
    const hidden = sessions.filter((s) => s.blocked);
    const pauseOthers = mediaPrefs?.pauseOthers ?? false;
    openContextMenu(e, [
      /* 勾选态走 ctx-item-icon（lucide Check）；未选中传 null 占位，
         图标列不塌、标签对齐——此前是 "✓ "/"全角空格" 文本前缀 hack。 */
      { label: tr("自动选择播放源"), icon: sessionId ? <Check size={15} /> : null, onSelect: () => setSessionId(null) },
      { type: "separator" as const },
      ...visible.map((s) => ({
        label: `${s.name}${s.playing ? " ▶" : ""}`,
        icon: s.id === sessionId ? <Check size={15} /> : null,
        onSelect: () => setSessionId(s.id)
      })),
      ...(visible.length > 0
        ? ([
            { type: "separator" as const },
            {
              label: tr("独占播放"),
              icon: pauseOthers ? <Check size={15} /> : null,
              onSelect: () =>
                setGeneral({
                  media: {
                    pauseOthers: !pauseOthers,
                    blockedSessions: blockedIds,
                    focusPause: mediaPrefs?.focusPause === true
                  }
                })
            },
            {
              label: tr("隐藏播放源…"),
              onSelect: () =>
                reopenMenuAtAnchor(
                  visible.map((s) => ({
                    label: s.name,
                    onSelect: () => setBlocked([...blockedIds, s.id])
                  }))
                )
            }
          ] as Parameters<typeof openContextMenu>[1])
        : []),
      ...(hidden.length > 0
        ? ([
            { type: "separator" as const },
            ...hidden.map((s) => ({
              label: `${tr("已隐藏")} · ${s.name}`,
              onSelect: () => setBlocked(blockedIds.filter((b) => b !== s.id))
            }))
          ] as Parameters<typeof openContextMenu>[1])
        : [])
    ]);
  };

  /** W-121 组件右键 → 统一就地配置弹层（B1；原勾选式快捷菜单已删除）。
      类型取实例真实注册类型：nowplaying 实例布局锁定，快捷表只收卡片专属
      开关（进度条/居中/随机循环/滚轮音量），频谱字段只在音乐类型出现。 */
  const rootRef = useRef<HTMLDivElement>(null);
  const [configOpen, setConfigOpen] = useState(false);
  const [configAnchor, setConfigAnchor] = useState<PopoverAnchor>({ x: 0, y: 0, w: 0, h: 0 });
  const realType = useWidgetStore((s) => s.instances.find((i) => i.id === instanceId)?.type) ?? "music";
  const onContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const r = rootRef.current?.getBoundingClientRect();
    if (r) setConfigAnchor({ x: r.x, y: r.y, w: r.width, h: r.height });
    setConfigOpen(true);
  };

  const showSpectrum = layout === "spectrum" || layout === "both";
  const showCard = layout === "nowplaying" || layout === "both";

  return (
    <div
      ref={rootRef}
      className={`music music-pure${transparent ? " transparent" : ""}${active ? " live" : ""}${active ? "" : " idle"}`}
      onContextMenu={onContextMenu}
    >
      {showCard && <NowPlayingCard onSessionsMenu={onSessionsMenu} options={cardOptions} />}
      {showSpectrum && (
        <div className="music-pure-visual" style={{ "--music-visual-h": visualHeightPct } as React.CSSProperties}>
          <AudioVisualizer
            style={visualStyle}
            height="100%"
            mode={mode}
            colorMode={colorMode}
            gain={gain}
            smoothing={smoothing}
            bandCount={bandCount}
            peakHold={peakHold}
            dist={dist}
          />
        </div>
      )}
      {showSpectrum && showStatusText && (
        <div className="music-pure-bar">
          <span className="music-pure-status" key={active ? "live" : "idle"}>
            <span className="music-pure-dot" aria-hidden="true" />
            {active ? <Volume2 size={13} /> : <AudioLines size={13} />}
            <span>{active ? tr("正在发声") : tr("监听中")}</span>
          </span>
          <span className="music-pure-hint">
            {/* W-120 响度数值：简易 VU 表读数；迷你电平条以 scaleX 呈现同一数值。 */}
            <span className="music-pure-level">{levelPct}%</span>
            <span className="music-pure-meter" aria-hidden="true">
              <i style={{ transform: `scaleX(${levelPct / 100})` }} />
            </span>
            {mode === "microphone" ? <Mic size={12} /> : <Activity size={12} />}
            {mode === "microphone"
              ? tr("麦克风实时频谱")
              : mode === "both"
                ? tr("播放 + 麦克风实时频谱")
                : tr("系统音频实时频谱")}
          </span>
        </div>
      )}

      <WidgetConfigPopover
        instanceId={instanceId}
        widgetType={realType}
        anchor={configAnchor}
        open={configOpen}
        onClose={() => setConfigOpen(false)}
      />
    </div>
  );
}

/** W-129 「正在播放」作为独立小组件类型：复用 MusicWidget，锁定卡片布局。 */
export function NowPlayingWidget({ instanceId }: { instanceId: string }) {
  return <MusicWidget instanceId={instanceId} forceLayout="nowplaying" />;
}
