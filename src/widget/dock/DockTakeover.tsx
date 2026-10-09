/* eslint-disable react-refresh/only-export-components */
/**
 * 接管层（ISLAND-CORE：自 DockContainer 迁出，行为不变）。
 *
 * - useDockTakeover：候选来源接线 + 到期回落。番茄钟响铃 > 媒体切歌 > 通知到达，
 *   dock-logic.resolveTakeover 仲裁。番茄钟/通知来自通知留档事件
 *   （本窗口 DOM + 跨窗口 Tauri），媒体来自 SYS §4.8 的 media:snapshot 事件
 *   （Rust 侧仅变化才 emit，dock 开启不再产生周期性媒体 IPC；启用时全量拉一次取初值）。
 *   可配置（ISLAND-LINK）：各 kind 开关经 enabledKinds 传入 resolveTakeover
 *   （缺省全开）；展示时长读本屏 dock.takeover.durationMs（默认 6s = TAKEOVER_MS），
 *   候选被接受时把 resolveTakeover 的定长到期换成配置时长——被丢弃的候选不动原到期。
 * - DockTakeoverLayer：接管条本体，与磁贴层常驻叠放在 DockShell 的同一格，
 *   切换的只是透明度（内容 200ms 交叉淡化）。接管条点击由 DockShell 处理：目标
 *   类型在岛上 → openTile，不在 → 仅 dismiss（不自动添加磁贴）。
 * - 亮度/音量接管：应用内调整（画布亮度卡滑杆 / 音乐卡滚轮音量）经
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
  clampTakeoverDurationMs,
  resolveTakeover,
  shortenUrl,
  takeoverContentEqual,
  trackChanged,
  type TakeoverFace,
  type TakeoverCandidate,
  type TakeoverKindToggles
} from "./dock-logic";

/** media:snapshot 事件 / get_system_media_info 载荷中 dock 所需的最小切片
 *  （完整结构见 src/lib/use-now-playing.ts 的 MediaSnapshotEvent）。 */
type MediaSnapshotEvent = { title: string; artist: string; thumbChanged?: boolean; thumb?: string | null };

/** 配置时长兜底：widget-store 载入与 setDock 已钳 3–15s，这里对绕过 store 的
 *  值（测试直改状态 / 陈旧内存）按同一区间折算（钳制逻辑单点化到
 *  dock-logic.clampTakeoverDurationMs——此前三处硬编码区间，任一改动即漂移；
 *  此前只查 >0，999_999 一类非法值会让接管条长驻）。 */

export function useDockTakeover(enabled: boolean, tr: (s: string) => string, enabledKinds?: TakeoverKindToggles) {
  /* state 形状剥离 until——到期时刻唯一真源是 untilRef（二.2：同内容
     续提案只顺延 ref 不换 state 引用），state.until 在续提案期间必然陈旧，
     任何新消费者读它都会拿到过期时刻（埋雷字段）。仲裁入参在事件处理器内
     用 untilRef 现组装。 */
  const [takeover, setTakeover] = useState<TakeoverFace | null>(null);
  /* 仲裁移出 setState updater——updater 内写 untilRef 是渲染期副作用，
     React 并发特性可重放 / 丢弃渲染期 updater，一旦重放链与最终状态错位，
     untilRef 与实际显示内容永久失同步（到期定时器按错误时刻排程——提前
     消失或超时不消失，文件注释自述过的 复发面）。propose 是事件处理器
     非渲染期，先经 takeoverRef 仲裁再一次性 set，ref 写入安全且幂等。 */
  const takeoverRef = useRef<TakeoverFace | null>(null);
  const untilRef = useRef(0);
  /* 通知去重改 LRU 集合——单值 lastRecordId 在双路（DOM + Tauri 事件）
     交错到达时（DOM(B) 先到、Tauri(A) 迟到），迟到的 A 不在单值里会被当作
     新通知重新提案，同级最新者胜反而让较旧的 A 顶掉较新的 B。Set 保持插入
     序，超上限删最旧。 */
  const seenRecords = useRef<Set<string>>(new Set());
  const lastMedia = useRef<MediaSnapshotEvent | null>(null);
  /* 开关与时长经 ref 读取：propose 身份稳定，事件监听不因配置改动反复重挂。 */
  const kindsRef = useRef(enabledKinds);
  kindsRef.current = enabledKinds;
  const durationMs = useWidgetStore((s) => s.dock.takeover.durationMs);
  const durationRef = useRef(durationMs);
  durationRef.current = durationMs;

  const propose = useCallback((c: TakeoverCandidate) => {
    const now = Date.now();
    const cur = takeoverRef.current;
    const curTimed = cur ? { ...cur, until: untilRef.current } : null;
    const next = resolveTakeover(curTimed, c, now, kindsRef.current);
    // 同引用 = 候选被丢弃（低优先级 / kind 已关），原到期时刻不动；null 只在空槽 + 已关时出现。
    if (next === curTimed || next === null) return;
    const until = now + clampTakeoverDurationMs(durationRef.current);
    untilRef.current = until;
    /* 剥掉仲裁内部字段 until（state 只承载展示面）。 */
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { until: _dropped, ...face } = next;
    // 同内容续提案（同 kind + 标题/副标/链接/封面一致）：state 引用不变即零
    // 重渲，到期判定走 untilRef。
    if (cur && takeoverContentEqual(cur, face)) return;
    takeoverRef.current = face;
    setTakeover(face);
  }, []);

  const dismiss = useCallback(() => {
    takeoverRef.current = null;
    setTakeover(null);
  }, []);

  /* 到期回落：按 until 排定时器；接管被抢占（state 引用变化）时重排。
     读 untilRef（二.2：续提案只更新 ref，state.until 不再刷新）。同内容续
     提案不换 state 引用 → effect 不重跑，旧定时器到点时 untilRef 已被顺延，
     必须按最新时刻**自重排**——否则定时器消费完后无人再排，接管条永不过期
     （音量顶格连按/重复通知即可复现）。 */
  useEffect(() => {
    if (!takeover) return;
    let t = 0;
    const schedule = () => {
      const left = Math.max(0, untilRef.current - Date.now());
      t = window.setTimeout(() => {
        if (Date.now() < untilRef.current) schedule();
        else setTakeover(null);
      }, left + 10);
    };
    schedule();
    return () => window.clearTimeout(t);
  }, [takeover]);

  /* 通知留档 → 番茄钟 kind 走番茄钟接管，其余走通知接管；发送窗口会同时
     收到 DOM 与 Tauri 两路，按 id 去重。 */
  useEffect(() => {
    if (!enabled) return;
    const onRecord = (record: NotificationRecord) => {
      /* LRU 集合去重（见 seenRecords 头注）。 */
      if (!record || seenRecords.current.has(record.id)) return;
      seenRecords.current.add(record.id);
      if (seenRecords.current.size > 64) {
        const oldest = seenRecords.current.values().next().value;
        if (oldest !== undefined) seenRecords.current.delete(oldest);
      }
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
     NextUp 封面：thumb 只在 thumbChanged 拍下发，本地保鲜最近封面，
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
     当作首采样忽略。事件已先到则不回退覆盖。：lastMedia 已有值时整段
     跳过（回复本来就会被丢弃）——岛开关反复翻转不再各浪费一次 IPC。
     拉式载荷是全量（thumb 恒为新值），lastThumb 一并填充——冷启动后的
     首个切歌接管也能带封面。 */
  useEffect(() => {
    if (!enabled || !isTauri() || lastMedia.current) return;
    let disposed = false;
    void invoke<MediaSnapshotEvent | null>("get_system_media_info")
      .then((info) => {
        if (disposed || lastMedia.current) return;
        if (info && info.title) {
          lastMedia.current = { title: info.title, artist: info.artist ?? "" };
          lastThumb.current = info.thumb ?? null;
        } else {
          lastMedia.current = null;
        }
      })
      .catch(() => {});
    return () => {
      disposed = true;
    };
  }, [enabled]);

  /* 应用内 OSD（亮度滑杆 / 音乐滚轮音量）：直接提案，仲裁与开关在
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
     副标题百分比；静音时显示「已静音」）。Rust 侧已节流到 ~20/s。
     受 enabled 门控——此前监听常装，关岛期间音量键照驱动 takeover
     状态与 DockShell 整树重渲，重开岛后还会弹出最长 6s 的陈旧音量条。 */
  useTauriEvent<{ level: number; muted: boolean } | null>("osd:volume", (payload) => {
    if (!enabled || !payload || typeof payload.level !== "number") return;
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

  return { takeover, dismiss };
}

/** 接管条：无接管时保持挂载但 opacity 0 + 不可聚焦（`.dock.has-takeover` 控制显隐）。
 *  媒体接管带封面时用缩略图替代缺省 Music 图标（NextUp 样式）。
 *  一.3 内容替换交叉淡化：kind 抢占 / 同 kind 换文案时递增 key 重挂图标与文字，
 *  新内容播 150ms 淡入（dock-takeover-swap），替代此前的就地瞬换；同内容续提案
 *  （二.2 合并）不改变签名，不重播。 */
export function DockTakeoverLayer({ takeover, onClick }: { takeover: TakeoverFace | null; onClick: () => void }) {
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
  /* 签名走 JSON 序列化（字段界定无歧义）——此前 "|" 拼接 + split，标题
     含 "|" 时字段错位、结构变化判定失真；结构变化 = kind / 标题（决定图标
     与主文案），直接比字段值，不回解签名字符串。 */
  const kind = takeover?.kind ?? "";
  const title = takeover?.title ?? "";
  const sig = takeover ? JSON.stringify([kind, title, takeover.sub ?? null, takeover.thumb ?? null]) : "";
  const lastSig = useRef(sig);
  const lastKind = useRef(kind);
  const lastTitle = useRef(title);
  const lastBumpRef = useRef(0);
  const [swapSeq, setSwapSeq] = useState(0);
  if (lastSig.current !== sig) {
    // 仅 sub/thumb 变化（拖亮度滑杆/音量 OSD ~20-60/s）节流 250ms——每次
    // 都重挂重播 150ms 淡入会让文字全程停在低不透明度；kind/标题变化仍立即重挂。
    const structural = lastKind.current !== kind || lastTitle.current !== title;
    const now = Date.now();
    if (structural || now - lastBumpRef.current > 250) {
      lastBumpRef.current = now;
      setSwapSeq((n) => n + 1);
    }
    lastSig.current = sig;
    lastKind.current = kind;
    lastTitle.current = title;
  }
  return (
    <button
      className={`dock-takeover is-${takeover?.kind ?? "none"}`}
      onClick={onClick}
      aria-hidden={!takeover}
      tabIndex={takeover ? 0 : -1}
      data-interactive
    >
      {/* 三个子节点此前共用同一 key（React duplicate-key 警告源，重挂动画
          可能错挂到别的子节点）——各用独立前缀 + 同一 swapSeq。 */}
      {showThumb ? (
        <img key={`ico-${swapSeq}`} src={takeover!.thumb} alt="" className="dock-takeover-thumb" draggable={false} />
      ) : (
        <TakeoverIcon key={`ico-${swapSeq}`} size={14} className="dock-takeover-ico" />
      )}
      <span key={`title-${swapSeq}`} className="dock-takeover-title">
        {takeover?.title ?? ""}
      </span>
      {takeover?.sub && (
        <span key={`sub-${swapSeq}`} className="dock-takeover-sub">
          {takeover.sub}
        </span>
      )}
      <ChevronDown size={12} className="dock-takeover-chev" />
    </button>
  );
}
