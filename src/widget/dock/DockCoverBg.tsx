/**
 * [DOCK-COVER]灵动岛封面背景层：
 *  - 媒体在播：岛体背景 = 当前曲目封面（模糊压暗保证磁贴文字可读），切歌
 *    300ms 淡入淡出；
 *  - 专注态（`extra.dockFocusBgPath` 配置了文件夹且番茄钟运行中）：背景 =
 *    文件夹内随机一张（每个专注会话开始时换一次）。
 * 优先级：媒体封面 > 专注背景（专注期媒体常被自动化规则暂停，两者很少同抢）。
 * 开关：`extra.dockCoverBg`（默认开，纯装饰）；专注背景路径空 = 关。
 *
 * 渲染：绝对定位铺满岛体（border-radius:inherit 随外形），双层 crossfade——
 * 新图 key 重挂播入场淡入叠在旧图上，~340ms 后旧层退位（reduce-motion 由
 * 全局门控压为瞬切，退位计时器只是清 DOM，无视觉等待）。
 */
import { useEffect, useRef, useState } from "react";
import { animDurations } from "../../lib/durations";
import { useNowPlaying } from "../../lib/use-now-playing";
import { invoke, isTauri } from "../../lib/tauri";
import { useAppStore } from "../../store/app-store";
import { useSettingsStore } from "../../store/settings-store";
import { nextCoverLayers, pickRandomImage, type FileEntryLike } from "./dock-cover-logic";

export function DockCoverBg() {
  const coverEnabled = useSettingsStore((s) => s.extra.dockCoverBg);
  const focusPath = useSettingsStore((s) => s.extra.dockFocusBgPath);
  /* 媒体封面/播放态走共享 useNowPlaying store（active=false：不订阅 4Hz 进度
   * 推进）。此前自带一份 media:snapshot 监听只吃 thumbChanged 拍——冷启动时
   * 已在播的曲目要等下次换曲才有事件，封面一直空着；store 的初值全量拉取
   * 天然补上这个缺口（与 DockTakeover 的 lastMedia 初值同款问题）。 */
  const { media } = useNowPlaying(false);
  const mediaPlaying = !!media && !!media.playing && !!media.title;
  const thumb = media?.thumb ?? null;
  const focusRunning = useAppStore((s) => s.pomodoro.isRunning);

  /* 专注背景：每个专注会话（false→true 边沿）随机换一张。 */
  const [focusBg, setFocusBg] = useState<string | null>(null);
  const lastRunning = useRef(focusRunning);
  useEffect(() => {
    const was = lastRunning.current;
    lastRunning.current = focusRunning;
    if (was || !focusRunning || !focusPath.trim() || !isTauri()) return;
    let cancelled = false;
    void (async () => {
      try {
        const list = await invoke<FileEntryLike[]>("list_directory", {
          path: focusPath,
          showHidden: false
        });
        const picked = pickRandomImage(list ?? []);
        if (!picked) return;
        /* 缩略图通道（320px PNG，与壁纸选择器同管线）：背景层不需要全尺寸，
           也避免 read_image_data_url 全量解码大图。 */
        const thumbs = await invoke<(string | null)[]>("read_image_thumbnails", { paths: [picked] });
        if (!cancelled && thumbs[0]) setFocusBg(thumbs[0]);
      } catch {
        /* 目录失效/为空：本会话无背景，静默（设置页有路径校验入口）。 */
      }
    })();
    return () => {
      cancelled = true;
    };
    // focusPath 变更不重跑（只在会话边沿取图）；eslint 依赖按边沿语义豁免。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusRunning]);

  /* 源选择与 crossfade。 */
  const src = !coverEnabled ? null : mediaPlaying && thumb ? thumb : focusRunning ? focusBg : null;
  const [layers, setLayers] = useState<{ cur: string | null; prev: string | null }>({
    cur: src,
    prev: null
  });
  useEffect(() => {
    setLayers((s) => nextCoverLayers(s, src));
  }, [src]);
  /* 旧层退位：淡入完成后清除（双保险 reduce-motion：全局门控压动画，计时器只清 DOM）。
     时长与 CSS `.dock-cover-bg.is-in` 的 --dur-fx-slow 同源（标准档 300ms）
     ——此前硬编码 340，慢速档下淡入被提前掐断。 */
  useEffect(() => {
    if (!layers.prev) return;
    const t = window.setTimeout(
      () => setLayers((s) => ({ ...s, prev: null })),
      Math.round(animDurations().fxSlowMs) + 40
    );
    return () => window.clearTimeout(t);
  }, [layers.prev]);

  if (!layers.cur && !layers.prev) return null;
  return (
    <>
      {layers.prev && (
        <div
          className="dock-cover-bg is-out"
          key={`prev-${layers.prev}`}
          aria-hidden="true"
          style={{ backgroundImage: `url(${layers.prev})` }}
        />
      )}
      {layers.cur && (
        <div
          className="dock-cover-bg is-in"
          key={`cur-${layers.cur}`}
          aria-hidden="true"
          style={{ backgroundImage: `url(${layers.cur})` }}
        />
      )}
    </>
  );
}
