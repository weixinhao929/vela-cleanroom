/**
 * 音乐迷你磁贴（ISLAND-MINI，music 与 nowplaying 共用）：标题单行跑马 + 播放/暂停。
 * 数据只读 lib/use-now-playing（media:snapshot 事件源，无自建轮询）。跑马仅在
 * active 且标题溢出时走 CSS 动画（位移量由 useLayoutEffect 量出写入
 * --mini-scroll；reduce-motion 由 MINI 区段规则静止），active=false 即停。
 * 有 palette 时以 primary 作点缀色（--mini-accent）。播放键是 role=button 的
 * span——宿主磁贴本身是 <button>，不可嵌套；点击 stopPropagation 免触发展开。
 */
import { useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type SyntheticEvent } from "react";
import { Music, Pause, Play } from "lucide-react";
import { useT } from "../../../i18n-lite";
import { invoke } from "../../../lib/tauri";
import { useNowPlaying } from "../../../lib/use-now-playing";
import type { MiniComponentProps } from "../../registry";

export function MusicMini({ active }: MiniComponentProps) {
  const tr = useT();
  const { media } = useNowPlaying();
  const clipRef = useRef<HTMLSpanElement>(null);
  const [overflow, setOverflow] = useState(0);
  const text = media ? media.title || tr("未知曲目") : tr("暂无播放信息");

  useLayoutEffect(() => {
    const el = clipRef.current;
    setOverflow(el ? Math.max(0, el.scrollWidth - el.clientWidth) : 0);
  }, [text]);

  const marquee = active && overflow > 0;
  const toggle = (e: SyntheticEvent) => {
    e.stopPropagation();
    if (!media) return;
    void invoke("control_system_media", { action: media.playing ? "pause" : "play" }).catch(() => {});
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    toggle(e);
  };
  const style = {
    "--mini-scroll": `-${overflow}px`,
    ...(media?.palette ? { "--mini-accent": media.palette.primary } : {})
  } as CSSProperties;
  const cls = `dock-mini dock-mini-music${marquee ? " is-marquee" : ""}${media?.playing ? " is-playing" : ""}`;

  return (
    <span className={cls} style={style}>
      <Music size={13} className="dock-mini-ico" />
      <span className="dock-mini-music-clip" ref={clipRef}>
        <span className="dock-mini-music-text">{text}</span>
      </span>
      {media && (
        <span
          role="button"
          tabIndex={0}
          className="dock-mini-btn"
          onClick={toggle}
          onKeyDown={onKey}
          aria-label={media.playing ? tr("暂停") : tr("播放")}
          data-interactive
        >
          {media.playing ? <Pause size={11} /> : <Play size={11} />}
        </span>
      )}
    </span>
  );
}
