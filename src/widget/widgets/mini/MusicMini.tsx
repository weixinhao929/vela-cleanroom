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
  /* （4Hz 重渲）：本磁贴只用 title/palette/playing，不用逐秒 position——
     useNowPlaying(false) 冻结 position 推进（250ms tick 不再 setState），
    曲目/播放态变化仍经事件到达；跑马灯另用 active 门控（下方 CSS 层）。 */
  const { media } = useNowPlaying(false);
  const clipRef = useRef<HTMLSpanElement>(null);
  const [overflow, setOverflow] = useState(0);
  const text = media ? media.title || tr("未知曲目") : tr("暂无播放信息");

  useLayoutEffect(() => {
    const el = clipRef.current;
    if (!el) return;
    const measure = () => setOverflow(Math.max(0, el.scrollWidth - el.clientWidth));
    measure();
    /* 容器宽度变化（dock 缩放/换槽）也重测——此前只依赖 [text]，宽度变了
       跑马距离陈旧（溢出判定与 --mini-scroll 位移都错）。jsdom 等无
       ResizeObserver 的环境退化为仅文本变化时重测。 */
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
    ro?.observe(el);
    return () => ro?.disconnect();
  }, [text]);

  const marquee = active && overflow > 0;
  const toggle = (e: SyntheticEvent) => {
    e.stopPropagation();
    if (!media) return;
    /* 与卡片/沉浸页同口径走 toggle（SMTC 侧按当前态自翻转）——此前用
       play/pause 组合依赖可能过期的 playing 快照，快速连点会发反方向指令。 */
    void invoke("control_system_media", { action: "toggle" }).catch(() => {});
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
