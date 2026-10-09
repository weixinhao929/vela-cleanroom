/* eslint-disable react-refresh/only-export-components */
/**
 * 应用内 toast 通知条（#99）。
 *
 * 番茄完成 / 里程碑 / 倒计时结束等此前只走 OS 通知，主窗口可见时无应用内
 * 提示。这里提供右上角固定栈（最多 3 条，超出挤掉最旧：旧条立即离场，余条
 * FLIP 上移补位）：入 = --anim-dur、停 4s（错误 8s）、出 = --dur-fx，时长随
 * 设置→动效 速度档缩放。与 OS 通知二选一 —— 由 notifications.ts 在主窗口
 * 可见时改走本栈。
 *
 * 设计与 CommandPalette 同款：模块级队列 + 订阅，非 React 代码可通过
 * pushAppToast() 触发。队列是每个 WebView 独立的模块级单例，因此每个需要
 * 展示 toast 的窗口都要挂载一个 Host（桌面层 + 设置窗口）；quick-note 极简
 * 窗口不挂。跨窗口不会重复弹：队列不随跨窗口事件同步，各窗口只显示自己
 * 代码发出的 toast。
 *
 * 类型图标前缀（CheckCircle/AlertTriangle/XCircle/Info）、
 * error 用 role=alert 立即播报、悬停暂停计时、× 手动关闭、action 插槽
 * （如「撤销」，危险操作轻确认的标准通道）。
 */

import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { AlertTriangle, CheckCircle2, Info, X, XCircle } from "lucide-react";
import { flipReorder } from "../lib/anim";
import { animDurations } from "../lib/durations";
import { useT } from "../i18n-lite";
/* 样式随组件走——snip 等精简入口窗口挂 Host 即有样式，不必背整份
   widget-anim.css（原在 widget-anim.css F 节）。 */
import "../styles/feature-toast.css";

type ToastKind = "pomodoro" | "todo" | "info" | "error" | "ok";

type ToastItem = {
  id: number;
  title: string;
  body: string;
  kind: ToastKind;
  /** 已进入退场阶段（200ms 后从队列移除）。 */
  closing: boolean;
  /** 本条自己的到期时刻（进入 / 恢复计时时刻 + stayMs）。每条只调度
      自己的定时器——新条进入不触碰旧条的到期时刻（此前全部重排完整时长，
      连续推多条时最旧一条近乎永不过期）。 */
  dueAt: number;
  /** 可选动作按钮（如「撤销」），点击后触发 action 并关闭本条。 */
  action?: { label: string; run: () => void };
  /** 本条以任何方式离场（停留超时 / 手动关闭 / 动作后关闭 / 被新条挤掉）时回调一次。
      供"删除 + 撤销"这类把副作用推迟到 toast 消失的场景使用，撤销窗口与可见性严格一致。 */
  onDismiss?: () => void;
};

let seq = 0;
let queue: ToastItem[] = [];
const listeners = new Set<() => void>();
const timers = new Map<number, number>();

/** 各类型停留时长：错误给更长的阅读时间。 */
function stayMs(kind: ToastKind): number {
  return kind === "error" ? 8000 : 4000;
}

/** 退场动画（CSS app-toast-out = --dur-fx）播完所需的移除延迟：时长实时跟随
 *  设置→动效 速度档（时长双轨制收口），+20ms 兜底动画尾帧与定时器竞争。 */
function exitLingerMs(): number {
  return Math.round(animDurations().fxMs) + 20;
}

/** 类型 → 图标与语义色 class（色弱用户不只依赖左边条颜色区分成败）。 */
export function toastIconOf(kind: ToastKind): ReactNode {
  const cls = "app-toast-ico";
  switch (kind) {
    case "ok":
      return <CheckCircle2 size={14} className={cls} aria-hidden="true" />;
    case "error":
      return <XCircle size={14} className={`${cls} err`} aria-hidden="true" />;
    case "todo":
    case "pomodoro":
      return <AlertTriangle size={14} className={`${cls} warn`} aria-hidden="true" />;
    default:
      return <Info size={14} className={`${cls} info`} aria-hidden="true" />;
  }
}

function notify(): void {
  for (const fn of [...listeners]) fn();
}

/** 置 closing 并触发一次 onDismiss（幂等：已 closing 的条目不再回调）。 */
function markClosing(id: number): void {
  const item = queue.find((x) => x.id === id);
  if (!item || item.closing) return;
  queue = queue.map((x) => (x.id === id ? { ...x, closing: true } : x));
  try {
    item.onDismiss?.();
  } catch {
    // 回调异常不得打断 toast 队列
  }
}

function scheduleRemove(id: number): void {
  const item = queue.find((x) => x.id === id);
  if (!item || item.closing) return;
  /* 按条目自己的到期时刻算剩余时长（进入时 now + duration，被暂停 /
      恢复时刷新）——调用方（新条进入）不再触碰旧条的到期时刻。 */
  const t = window.setTimeout(
    () => {
      timers.delete(id);
      // 先置 closing 播 200ms 退场，再真正移除。
      markClosing(id);
      notify();
      const t2 = window.setTimeout(() => removeWithFlip(id), exitLingerMs());
      timers.set(id, t2);
    },
    Math.max(0, item.dueAt - Date.now())
  );
  timers.set(id, t);
}

/** 悬停 / 焦点暂停后的恢复——按当前时刻重排完整停留时长（dueAt 刷新
 *  为 now + stayMs），与进度条 key 重挂重播对齐（离开时的视觉语义本就是
 *  重新计满，维持既有手势行为不变）。 */
function restartRemove(id: number): void {
  const item = queue.find((x) => x.id === id);
  if (!item || item.closing) return;
  queue = queue.map((x) => (x.id === id ? { ...x, dueAt: Date.now() + stayMs(x.kind) } : x));
  scheduleRemove(id);
}

function closeOne(id: number): void {
  const t = timers.get(id);
  if (t !== undefined) {
    window.clearTimeout(t);
    timers.delete(id);
  }
  markClosing(id);
  notify();
  const t2 = window.setTimeout(() => removeWithFlip(id), exitLingerMs());
  timers.set(id, t2);
}

/** 一.5：把已退场（closing）的条目从队列移除，余条用 flipReorder 从原位平滑
 *  上移补位——与「被新条挤掉」路径同语言（此前自然过期/手动关闭后余条瞬跳）。 */
function removeWithFlip(id: number): void {
  const stack = typeof document !== "undefined" ? document.querySelector<HTMLElement>(".app-toast-stack") : null;
  const commit = () => {
    timers.delete(id);
    queue = queue.filter((x) => x.id !== id);
    notify();
  };
  if (stack) flipReorder(stack, ".app-toast:not(.is-closing)", commit);
  else commit();
}

/** 推入应用内 toast（最多保留 3 条）。超出挤掉最旧：旧条播 is-closing 退场后
 *  移除（补发 onDismiss），余条用 flipReorder 从原位平滑上移补位，不再瞬跳。
 *  新条只带自己的到期时刻（dueAt = now + duration）、只调度自己的定时器
 *  此前进入时清掉全部旧条定时器并按完整时长重排，旧条的剩余停留时间被
 *  整体重置（连续推三条，第一条近乎永不过期）；退场中条目的 linger 移除
 *  定时器更是不可触碰（修复的回归点）。 */
export function pushAppToast(
  title: string,
  body: string,
  kind: ToastKind = "info",
  opts?: { action?: { label: string; run: () => void }; onDismiss?: () => void }
): void {
  const item: ToastItem = {
    id: ++seq,
    title,
    body,
    kind,
    closing: false,
    dueAt: Date.now() + stayMs(kind),
    action: opts?.action,
    onDismiss: opts?.onDismiss
  };
  const kept = [...queue.filter((x) => !x.closing), item];
  const evicted = kept.slice(0, Math.max(0, kept.length - 3));
  const next = kept.slice(-3);
  const commit = () => {
    // 被新条挤掉的旧条补发 onDismiss（撤销窗口止于被挤出的一刻）。
    for (const ev of evicted) {
      try {
        ev.onDismiss?.();
      } catch {
        // 回调异常不得打断 toast 队列
      }
    }
    // 被挤掉的旧条不再瞬删：保留挂载播 is-closing 退场（与超时/手动关闭同语言），
    // linger 后从队列移除（退场按钮隐藏、不重复补发 onDismiss，语义同 closeOne）。
    // 早前一次挤出仍在退场中的条目原样保留——它们的移除定时器不受本函数影响。
    queue = [...queue.filter((x) => x.closing), ...evicted.map((x) => ({ ...x, closing: true })), ...next];
    const linger = exitLingerMs();
    for (const ev of evicted) {
      // 被挤出条目的原停留定时器已无意义（停留被退场取代）：清掉再挂 linger，
      // 否则晚到的旧定时器会误删 linger 句柄、重复排一次移除。evicted 全部
      // 来自上方 !closing 过滤，不会误清退场中条目的 linger 移除定时器。
      const stale = timers.get(ev.id);
      if (stale !== undefined) {
        window.clearTimeout(stale);
        timers.delete(ev.id);
      }
      const t2 = window.setTimeout(() => removeWithFlip(ev.id), linger);
      timers.set(ev.id, t2);
    }
    // 只调度新条自己的定时器；保留下来的旧条定时器原样在跑
    // （到期时刻未被动过），与新条自然按各自的 shownAt 续排退场。
    scheduleRemove(item.id);
    notify();
  };
  if (evicted.length === 0) {
    commit();
    return;
  }
  // FLIP：先量旧位 → commit（React 提交后余条已上移）→ 从旧位过渡回 0。
  // 只翻排非退场中的条目；reduce-motion 下 flipReorder 直接执行 commit。
  const stack = typeof document !== "undefined" ? document.querySelector<HTMLElement>(".app-toast-stack") : null;
  if (stack) flipReorder(stack, ".app-toast:not(.is-closing)", commit);
  else commit();
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** 单条文本 toast 的统一入口（#）：转发到本 Host，避免此前双系统下静默丢弃。 */
export function showToast(text: string, kind: "ok" | "error" | "info" = "info"): void {
  pushAppToast(text, "", kind);
}

export function ToastHost() {
  const tr = useT();
  const [items, setItems] = useState<ToastItem[]>(queue);
  useEffect(() => subscribe(() => setItems([...queue])), []);
  /* 五.12 剩余时间条：悬停暂停计时（已有）此前不可见；离开时计时器重排为
     完整 stayMs，进度条以 key 重挂重启动画保持同步。gen 计数按条目记录。 */
  const [hoverGen, setHoverGen] = useState<Map<number, number>>(() => new Map());
  if (!items.length) return null;
  return (
    <div className="app-toast-stack">
      {items.map((t) => (
        /* error 用 role=alert（assertive 播报），其余 polite。 */
        <div
          key={t.id}
          role={t.kind === "error" ? "alert" : "status"}
          aria-live={t.kind === "error" ? "assertive" : "polite"}
          className={`app-toast kind-${t.kind}${t.closing ? " is-closing" : ""}`}
          onMouseEnter={() => {
            const h = timers.get(t.id);
            if (h !== undefined && !t.closing) {
              window.clearTimeout(h);
              timers.delete(t.id);
            }
          }}
          onMouseLeave={() => {
            if (t.closing) return;
            /* 恢复 = 从当前时刻重排完整时长（与进度条重播对齐，
               悬停手势的既有语义不变）。 */
            restartRemove(t.id);
            setHoverGen((m) => new Map(m).set(t.id, (m.get(t.id) ?? 0) + 1));
          }}
          /* 键盘/读屏焦点同样暂停停留计时：Tab 到「撤销」action 或关闭按钮时
             定时器不再把整条 toast 连同聚焦中的按钮一起摘掉（焦点跌落 body、
             撤销窗口提前关闭）。React onFocus/onBlur 冒泡（focusin/out 语义），
             挂容器即覆盖全部子按钮；焦点在子按钮间移动时 blur→focus 连发，
             净效果仍是暂停。 */
          onFocus={() => {
            const h = timers.get(t.id);
            if (h !== undefined && !t.closing) {
              window.clearTimeout(h);
              timers.delete(t.id);
            }
          }}
          onBlur={() => {
            if (t.closing) return;
            /* 焦点可能只是移到同条内另一按钮：blur 先触发 resume、同拍 focus
               再暂停，行为正确；仅当焦点真正离开本条时才会走到下一次超时。
               恢复同悬停——重排完整时长（restartRemove）。 */
            restartRemove(t.id);
            setHoverGen((m) => new Map(m).set(t.id, (m.get(t.id) ?? 0) + 1));
          }}
        >
          {/* 倒计时进度条：宽度 = 剩余停留时间（scaleX 1→0，合成器路径）；
              悬停经 animation-play-state: paused 即时暂停，与 JS 计时器
              暂停同步；离开重启（key 变化）对齐重排后的完整 stayMs。 */}
          <span
            key={`${t.id}:${hoverGen.get(t.id) ?? 0}`}
            className="app-toast-bar is-countdown"
            style={{ "--toast-stay": `${stayMs(t.kind)}ms` } as CSSProperties}
          />
          {toastIconOf(t.kind)}
          <div className="app-toast-body">
            <strong>{t.title}</strong>
            {t.body && <span>{t.body}</span>}
          </div>
          {t.action && !t.closing && (
            <button
              className="app-toast-action"
              onClick={() => {
                t.action!.run();
                closeOne(t.id);
              }}
              data-interactive
            >
              {t.action.label}
            </button>
          )}
          <button
            className="app-toast-close"
            aria-label={tr("关闭")}
            title={tr("关闭")}
            onClick={() => closeOne(t.id)}
            data-interactive
          >
            <X size={12} />
          </button>
        </div>
      ))}
    </div>
  );
}
