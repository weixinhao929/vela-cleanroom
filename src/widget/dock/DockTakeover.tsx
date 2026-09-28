/* eslint-disable react-refresh/only-export-components */
/**
 * 接管层（ISLAND-CORE：自 DockContainer 迁出，行为不变）。
 *
 * - useDockTakeover：候选来源接线 + 到期回落。番茄钟响铃 > 媒体切歌 > 通知到达，
 *   dock-logic.resolveTakeover 仲裁。番茄钟/通知来自通知留档事件
 *   （本窗口 DOM + 跨窗口 Tauri），媒体来自 SYS §4.8 的 media:snapshot 事件
 *   （Rust 侧仅变化才 emit，dock 开启不再产生周期性媒体 IPC；启用时全量拉一次取初值）。
 *   F-8 可配置（ISLAND-LINK）：各 kind 开关经 enabledKinds 传入 resolveTakeover
 *   （缺省全开）；展示时长读本屏 dock.takeover.durationMs（默认 6s = TAKEOVER_MS），
 *   候选被接受时把 resolveTakeover 的定长到期换成配置时长——被丢弃的候选不动原到期。
 * - DockTakeoverLayer：接管条本体，与磁贴层常驻叠放在 DockShell 的同一格，
 *   切换的只是透明度（内容 200ms 交叉淡化）。接管条点击由 DockShell 处理：目标
 *   类型在岛上 → openTile，不在 → 仅 dismiss（不自动添加磁贴）。
 * - G10 亮度/音量接管：应用内调整（画布亮度卡滑杆 / 音乐卡滚轮音量）经
 *   osd-events 的 focus-desk:osd 事件接入，OSD 式即时反馈；岛内控件自发的
 *   调整不发该事件（接管会藏起正在拖动的磁贴层）。系统级变化（键盘快捷键）
 *   需 Rust watcher，见 osd-events.ts 注释。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Bell, ChevronDown, Link2, Music, SunDim, Timer, Volume2 } from "lucide-react";
import { invoke, isTauri } from "../../lib/tauri";
import { useTauriEvent } from "../../lib/use-tauri-event";
import { NOTIFICATION_RECORDED_EVENT } from "../../lib/notifications";
import { OSD_EVENT, type OsdPayload } from "../../lib/osd-events";
import { CLIP_LINK_EVENT } from "../../lib/system-notify";
import type { NotificationRecord } from "../../types/bindings/NotificationRecord";
import { useWidgetStore } from "../widget-store";
import {
  resolveTakeover,
  shortenUrl,
  TAKEOVER_MS,
  takeoverContentEqual,
  trackChanged,
  type Takeover,
  type TakeoverKindToggles
} from "./dock-logic";

/** media:snapshot 事件 / get_system_media_info 载荷中 dock 所需的最小切片
 *  （完整结构见 src/lib/use-now-playing.ts 的 MediaSnapshotEvent）。 */
type MediaSnapshotEvent = { title: string; artist: string; thumbChanged?: boolean; thumb?: string | null };

/** 配置时长兜底：widget-store 载入时已钳 3–15s，运行期 setDock 写入的非法值回默认 6s。 */
const takeoverDurationMs = (v: unknown): number =>
  typeof v === "number" && Number.isFinite(v) && v > 0 ? v : TAKEOVER_MS;

export function useDockTakeover(enabled: boolean, tr: (s: string) => string, enabledKinds?: TakeoverKindToggles) {
  const [takeover, setTakeover] = useState<Takeover | null>(null);
  /* 二.2 到期时刻单独放 ref：系统音量事件 ~20/s，同内容续提案只顺延 until、
     state 引用不变 → 持有 state 的 DockShell 不再每次事件都整树重渲；
     到期定时器从本 ref 读最新时刻（state 里的 until 只是首次挂载时的快照）。 */
  const untilRef = useRef(0);
  const lastRecordId = useRef<string | null>(null);
  const lastMedia = useRef<MediaSnapshotEvent | null>(null);
  /* 开关与时长经 ref 读取：propose 身份稳定，事件监听不因配置改动反复重挂。 */
  const kindsRef = useRef(enabledKinds);
  kindsRef.current = enabledKinds;
  const durationMs = useWidgetStore((s) => s.dock.takeover.durationMs);
  const durationRef = useRef(durationMs);
  durationRef.current = durationMs;

  const propose = useCallback((c: Omit<Takeover, "until">) => {
    setTakeover((cur) => {
      const now = Date.now();
      const next = resolveTakeover(cur, c, now, kindsRef.current);
      // 同引用 = 候选被丢弃（低优先级 / kind 已关），原到期时刻不动；null 只在空槽 + 已关时出现。
      if (next === cur || next === null) return next;
      const until = now + takeoverDurationMs(durationRef.current);
      untilRef.current = until;
      // 同内容续提案（同 kind + 标题/副标/链接/封面一致）：返回 cur 本身即零
      // 重渲，到期判定走 untilRef。
      if (cur && takeoverContentEqual(cur, next)) return cur;
      return { ...next, until };
    });
  }, []);

  /* 到期回落：按 until 排一次定时器；接管被抢占时重排。读 untilRef（二.2：
     续提案只更新 ref，state.until 不再刷新）。 */
  useEffect(() => {
    if (!takeover) return;
    const left = Math.max(0, untilRef.current - Date.now());
    const t = window.setTimeout(() => {
      setTakeover((cur) => (cur && Date.now() >= untilRef.current ? null : cur));
    }, left + 10);
    return () => window.clearTimeout(t);
  }, [takeover]);

  /* 通知留档 → 番茄钟 kind 走番茄钟接管，其余走通知接管；发送窗口会同时
     收到 DOM 与 Tauri 两路，按 id 去重。 */
  useEffect(() => {
    if (!enabled) return;
    const onRecord = (record: NotificationRecord) => {
      if (!record || record.id === lastRecordId.current) return;
      lastRecordId.current = record.id;
      propose({
        kind: record.kind === "pomodoro" ? "pomodoro" : "notification",
        title: record.title,
        sub: record.body || undefined
      });
    };
    const onDom = (e: Event) => onRecord((e as CustomEvent<NotificationRecord>).detail);
    window.addEventListener(NOTIFICATION_RECORDED_EVENT, onDom);
    let un: (() => void) | undefined;
    let disposed = false;
    if (isTauri()) {
      void import("@tauri-apps/api/event")
        .then(({ listen }) =>
          listen<NotificationRecord>("app:notification", (e) => onRecord(e.payload)).then((f) => {
            if (disposed) f();
            else un = f;
          })
        )
        .catch(() => {});
    }
    return () => {
      disposed = true;
      window.removeEventListener(NOTIFICATION_RECORDED_EVENT, onDom);
      un?.();
    };
  }, [enabled, propose]);

  /* 媒体切歌：订阅 SYS §4.8 的 media:snapshot 事件（Rust 仅变化才 emit，含
     空闲时的一次 null），标题/艺术家变化即接管，无周期性 IPC。基准 lastMedia
     无论开关都随事件保鲜——dock 关闭期间换的歌不当作重开后的「切歌」。
     W-131 NextUp 封面：thumb 只在 thumbChanged 拍下发，本地保鲜最近封面，
     切歌接管时一并展示（无封面沿用缺省图标）。 */
  const lastThumb = useRef<string | null>(null);
  useTauriEvent<MediaSnapshotEvent | null>("media:snapshot", (payload) => {
    if (payload) {
      if (payload.thumbChanged) lastThumb.current = payload.thumb ?? null;
    } else {
      lastThumb.current = null;
    }
    const next = payload && payload.title ? { title: payload.title, artist: payload.artist ?? "" } : null;
    if (enabled && trackChanged(lastMedia.current, next) && next) {
      propose({
        kind: "media",
        title: next.title,
        sub: next.artist || tr("正在播放"),
        thumb: lastThumb.current ?? undefined
      });
    }
    lastMedia.current = next;
  });

  /* 初值：冷启动时事件线程可能从未 emit 过（当前曲目无变化就无事件），
     全量拉一次填充 lastMedia，否则启用后的第一次切歌会被 trackChanged
     当作首采样忽略。事件已先到则不回退覆盖。 */
  useEffect(() => {
    if (!enabled || !isTauri()) return;
    let disposed = false;
    void invoke<MediaSnapshotEvent | null>("get_system_media_info")
      .then((info) => {
        if (disposed || lastMedia.current) return;
        lastMedia.current = info && info.title ? { title: info.title, artist: info.artist ?? "" } : null;
      })
      .catch(() => {});
    return () => {
      disposed = true;
    };
  }, [enabled]);

  /* G10 应用内 OSD（亮度滑杆 / 音乐滚轮音量）：直接提案，仲裁与开关在
     resolveTakeover 内统一处理。 */
  useEffect(() => {
    if (!enabled) return;
    const onOsd = (e: Event) => {
      const d = (e as CustomEvent<OsdPayload>).detail;
      if (!d) return;
      propose({ kind: d.kind, title: d.title, sub: d.sub });
    };
    window.addEventListener(OSD_EVENT, onOsd);
    return () => window.removeEventListener(OSD_EVENT, onOsd);
  }, [enabled, propose]);

  /* 一.2 系统级音量事件（Rust audio_events.rs）：键盘音量键 / 其它软件调
     音量 / 静音切换 → 与应用内 OSD 同一条接管路径（文案同款：标题「音量」，
     副标题百分比；静音时显示「已静音」）。Rust 侧已节流到 ~20/s。 */
  useTauriEvent<{ level: number; muted: boolean } | null>("osd:volume", (payload) => {
    if (!payload || typeof payload.level !== "number") return;
    const pct = Math.round(Math.max(0, Math.min(1, payload.level)) * 100);
    propose({
      kind: "volume",
      title: tr("音量"),
      sub: payload.muted ? tr("已静音") : `${pct}%`
    });
  });

  /* 一.4 剪贴板纯链接 → 「链接快开」接管（点击接管条 = 默认浏览器打开，
     打开动作在 DockShell.onTakeoverClick 处理）。Rust 只在采集开启 +
     linkPopup 开启时发事件；takeover.link 开关经 enabledKinds 生效。 */
  useEffect(() => {
    if (!enabled) return;
    const onLink = (e: Event) => {
      const url = (e as CustomEvent<{ url: string }>).detail?.url;
      if (!url) return;
      propose({ kind: "link", title: shortenUrl(url), sub: tr("点击打开链接"), url });
    };
    window.addEventListener(CLIP_LINK_EVENT, onLink);
    return () => window.removeEventListener(CLIP_LINK_EVENT, onLink);
  }, [enabled, propose, tr]);

  const dismiss = useCallback(() => setTakeover(null), []);
  return { takeover, dismiss };
}

/** 接管条：无接管时保持挂载但 opacity 0 + 不可聚焦（`.dock.has-takeover` 控制显隐）。
 *  W-131：媒体接管带封面时用缩略图替代缺省 Music 图标（NextUp 样式）。
 *  一.3 内容替换交叉淡化：kind 抢占 / 同 kind 换文案时递增 key 重挂图标与文字，
 *  新内容播 150ms 淡入（dock-takeover-swap），替代此前的就地瞬换；同内容续提案
 *  （二.2 合并）不改变签名，不重播。 */
export function DockTakeoverLayer({ takeover, onClick }: { takeover: Takeover | null; onClick: () => void }) {
  const TakeoverIcon =
    takeover?.kind === "pomodoro"
      ? Timer
      : takeover?.kind === "media"
        ? Music
        : takeover?.kind === "brightness"
          ? SunDim
          : takeover?.kind === "volume"
            ? Volume2
            : takeover?.kind === "link"
              ? Link2
              : Bell;
  const showThumb = takeover?.kind === "media" && !!takeover.thumb;
  const sig = takeover ? `${takeover.kind}|${takeover.title}|${takeover.sub ?? ""}|${takeover.thumb ?? ""}` : "";
  const lastSig = useRef(sig);
  const [swapSeq, setSwapSeq] = useState(0);
  if (lastSig.current !== sig) {
    lastSig.current = sig;
    setSwapSeq((n) => n + 1);
  }
  return (
    <button
      className={`dock-takeover is-${takeover?.kind ?? "none"}`}
      onClick={onClick}
      aria-hidden={!takeover}
      tabIndex={takeover ? 0 : -1}
      data-interactive
    >
      {showThumb ? (
        <img key={swapSeq} src={takeover!.thumb} alt="" className="dock-takeover-thumb" draggable={false} />
      ) : (
        <TakeoverIcon key={swapSeq} size={14} className="dock-takeover-ico" />
      )}
      <span key={swapSeq} className="dock-takeover-title">
        {takeover?.title ?? ""}
      </span>
      {takeover?.sub && (
        <span key={swapSeq} className="dock-takeover-sub">
          {takeover.sub}
        </span>
      )}
      <ChevronDown size={12} className="dock-takeover-chev" />
    </button>
  );
}
