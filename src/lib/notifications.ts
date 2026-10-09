import { useSettingsStore } from "../store/settings-store";
import type { NotificationSource } from "../store/settings-store";
import { pushAppToast } from "../components/ToastHost";
import { invoke, isTauri } from "./tauri";
import { dndSuppressing } from "./dnd";
import { playEventSound } from "./chimes";
import type { NotificationRecord } from "../types/bindings/NotificationRecord";

/**
 * 通知派发门面（DOCK 改造）。
 *
 * 三条自发通知路径（sourceNotify / pomodoroNotification / todoNotification）
 * 在各自的启用门控通过后，一律把记录写入通知历史（SQLite v7 表）——
 * 免打扰只压制「打扰」（toast / 系统通知 / 提示音），不阻止留档：用户回头
 * 仍能在通知中心看到这段时间发生了什么。系统级 toast 拦截（Windows
 * UserNotificationListener + 包身份）超出本期范围，不做承诺。
 */

/** 历史留档的 kind → IPC 白名单（Rust 侧未知值回落 info）。 */
export type HistoryKind = "pomodoro" | "todo" | "info";

/** 本窗口内广播「一条通知已留档」（notification-store 消费，去重后入列）。 */
export const NOTIFICATION_RECORDED_EVENT = "vela:notification-recorded";

function localRecord(source: string, title: string, body: string, kind: HistoryKind): NotificationRecord {
  return {
    id: crypto.randomUUID(),
    source,
    title,
    body,
    kind,
    read: false,
    created_at: new Date().toISOString()
  };
}

function broadcast(record: NotificationRecord): void {
  try {
    window.dispatchEvent(new CustomEvent(NOTIFICATION_RECORDED_EVENT, { detail: record }));
  } catch {
    // best-effort：UI 广播失败只影响本窗口实时性，下次 hydrate 会补齐
  }
}

/**
 * 留档一条通知历史：Tauri 下走 add_notification（Rust 生成 id/时间戳并顺手
 * 清理过期行），成功后经 Tauri 事件广播到所有窗口（多屏 dock 同步亮角标）；
 * IPC 失败或浏览器模式降级为本地构造记录 + 仅本窗口广播。fire-and-forget，
 * 永不阻塞通知主流程。
 *
 * 导出供 system-notify（系统镜像 / 外部推送两条外部链路）复用——三路留档
 * 共享同一份广播纪律（DOM + app:notification），不各养一份实现。
 */
export function recordHistory(source: string, title: string, body: string, kind: HistoryKind): void {
  if (!isTauri()) {
    broadcast(localRecord(source, title, body, kind));
    return;
  }
  void invoke<NotificationRecord>("add_notification", { source, title, body, kind })
    .then((record) => {
      broadcast(record);
      void import("@tauri-apps/api/event").then(({ emit }) => emit("app:notification", record).catch(() => {}));
    })
    .catch((err) => {
      console.warn("[notifications] history write failed:", err);
      broadcast(localRecord(source, title, body, kind));
    });
}

/**
 * 发送 OS 系统通知（Tauri Rust 直发 / 插件 / Web Notification API 三级路径）。
 * 权限缺失时按需请求；任何失败静默忽略——通知绝不能打断主流程。
 *
 * Tauri 下优先走 send_os_notification（os_notify.rs）：同一展示层（同 AUMID
 * 的 WinRT toast）但带进程内点击回调——点击通知 → os-notify:activated →
 * Rust 亮出小组件层 + 前端定位来源组件。命令失败（无 WinRT toast 的老系统
 * 等）回落插件路径，行为不劣化。
 *
 * @param title - 通知标题。
 * @param body - 通知正文。
 * @param meta - 点击落地信息：source 用于映射来源组件类型；instanceId 精确
 *               定位实例（调用方持有实例时优先）。
 * @returns 无（fire-and-forget）。
 * @throws 无。
 */
export async function notifyUser(title: string, body: string, meta?: { source?: string; instanceId?: string }) {
  try {
    if ("__TAURI_INTERNALS__" in window) {
      try {
        await invoke("send_os_notification", {
          title,
          body,
          source: meta?.source,
          instanceId: meta?.instanceId
        });
        return;
      } catch {
        // Rust 直发不可用（老系统 / 命令未注册）：回落插件路径，仅失去点击
        // 回调，展示不受影响。
      }
      const { isPermissionGranted, requestPermission, sendNotification } =
        await import("@tauri-apps/plugin-notification");
      let granted = await isPermissionGranted();
      if (!granted) granted = (await requestPermission()) === "granted";
      if (granted) sendNotification({ title, body });
      return;
    }
    if (!("Notification" in window)) return;
    let permission = Notification.permission;
    if (permission === "default") permission = await Notification.requestPermission();
    if (permission === "granted") new Notification(title, { body });
  } catch {
    // Notification failures should never break the productivity flow.
  }
}

/** 专注模式静音：medium/deep 沉浸期间，非番茄钟核心的提示音与系统通知
 *  一律降级为静默（此前只有 WidgetCanvas 消费 focusMode，DDL 提醒等照常
 *  轰炸）。番茄钟自身的完成/换段通知仍由其专属开关治理——那是专注者
 *  需要知道「这段结束了」的信号，不在此静音。 */
function focusSilent(): boolean {
  const fm = useSettingsStore.getState().extra.focusMode;
  return fm === "medium" || fm === "deep";
}

/**
 * 判断某通知来源是否被允许（设置「通知来源」逐源开关，缺省开启）。
 *
 * @param source - 通知来源标识。
 * @returns true 表示允许发送。O(1)。
 */
export function sourceEnabled(source: NotificationSource): boolean {
  const sources = useSettingsStore.getState().notifications.sources;
  return sources?.[source] !== false;
}

/**
 * 来源门控的系统通知（门面模式）：小组件直连 notifyUser 的调用点统一改走
 * 这里，同时尊重「通知来源」逐源开关与专注模式静音（medium/deep 沉浸期间
 * 非番茄钟核心通知一律降级静默）。
 *
 * @param source - 通知来源（决定受哪个开关治理）。
 * @param title - 通知标题。
 * @param body - 通知正文。
 * @returns 无；被门控拦截时为 no-op。
 *
 * @example
 * ```ts
 * sourceNotify("habit", tr("习惯打卡提醒"), "微信 今天还没打卡");
 * ```
 */
export function sourceNotify(source: NotificationSource, title: string, body: string): void {
  if (!sourceEnabled(source)) return;
  if (focusSilent()) return;
  recordHistory(source, title, body, "info");
  if (dndSuppressing()) return;
  void notifyUser(title, body, { source });
}

/**
 * 通知派发：主窗口可见时走应用内 toast（右上角滑入滑出），否则回落
 * OS 系统通知 —— 两者二选一，避免同一事件双重打扰。kind 用于 toast 左侧
 * 色条区分番茄钟 / 待办，并作为 OS 通知的 source 供点击落地映射。
 */
function dispatchToast(title: string, body: string, kind: "pomodoro" | "todo" | "info") {
  if (typeof document !== "undefined" && document.visibilityState === "visible") {
    pushAppToast(title, body, kind);
    return;
  }
  void notifyUser(title, body, { source: kind });
}

/** 模块级惰性单例 AudioContext。此前每次提示音都新建
    context 且从不 resume()——自动播放策略下无用户手势前 context 处于
    suspended，osc.start 静默无声（番茄钟完成音在启动后未经交互时永远不响）；
    高频提醒时的反复创建/销毁也是浪费。 */
let sharedCtx: AudioContext | null = null;

function getAudioContext(): AudioContext | null {
  const Ctx =
    window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctx) return null;
  try {
    if (!sharedCtx || sharedCtx.state === "closed") sharedCtx = new Ctx();
    // 自动播放策略：suspended 时尝试恢复（用户手势后的调用会成功）。
    if (sharedCtx.state === "suspended") void sharedCtx.resume().catch(() => {});
    return sharedCtx;
  } catch {
    return null;
  }
}

/**
 * 轻提示音（WebAudio 合成短促双音 660Hz→880Hz，惰性单例 AudioContext）。
 * 门控规则：传 source 时受「通知来源」开关 + 专注静音治理；番茄钟核心
 * 链路不传 source，保持既有开关语义；对应「提示音」开关关闭时不响。
 *
 * @param kind - 音色归属（决定读取哪个开关），默认 "pomodoro"。
 * @param source - 可选来源门控（小组件自发声源传入）。
 * @returns 无。
 * @throws 无（WebAudio 全程 try 包裹，best-effort）。
 *
 * @example
 * ```ts
 * playChime("todo", "deadline"); // DDL 提醒音（受来源开关+静音治理）
 * ```
 */
export function playChime(kind: "pomodoro" | "todo" = "pomodoro", source?: NotificationSource) {
  try {
    if (dndSuppressing()) return; // 免打扰：任何来源的提示音一律静默
    if (source && (!sourceEnabled(source) || focusSilent())) return;
    if (!source && kind === "todo" && focusSilent()) return;
    const n = useSettingsStore.getState().notifications;
    const enabled = kind === "todo" ? n.todoSound : n.pomodoroSound;
    if (!enabled) return;
    const ctx = getAudioContext();
    if (!ctx) return;
    const now = ctx.currentTime;
    const notes = [660, 880];
    notes.forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      const t = now + i * 0.14;
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.18, t + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t);
      osc.stop(t + 0.2);
    });
  } catch {
    // Audio is best-effort.
  }
}

/**
 * 逐项门控的番茄钟通知。
 * 门控链：pomodoroEnabled 总开关 → modeSwitch（仅"阶段完成"类）→
 * pomodoroToast 决定弹通知、pomodoroSound 决定响铃（两者独立）。
 *
 * @param opts - `kind`：mode-switch 阶段切换 / milestone 里程碑 / complete
 *               整段完成；`title`/`body`：文案；`sound`：
 *               事件级音效来源——提供时按设置里的独立音色/音量播放，缺省
 *               沿用统一双音。
 * @returns 无；任一门控不满足时为 no-op。
 *
 * @example
 * `ts
 * pomodoroNotification({ kind: "complete", title: "专注完成", body: "休息一下吧", sound: { event: "focus-end" } });
 * `
 */
export function pomodoroNotification(opts: {
  kind: "mode-switch" | "milestone" | "complete" | "upcoming";
  title: string;
  body: string;
  sound?: { event: "focus-end" | "break-end" };
}) {
  const n = useSettingsStore.getState().notifications;
  if (!n.pomodoroEnabled) return;
  // （开关治理）：「阶段完成」类含 30 秒预告（upcoming）——此前只有
  // mode-switch 受 pomodoroModeSwitch 门控，关掉阶段通知的用户仍会被
  // 「即将完成」预告打扰，与设置文案「在专注 / 休息结束时发送通知」相悖。
  if ((opts.kind === "mode-switch" || opts.kind === "upcoming") && !n.pomodoroModeSwitch) return;
  // 门控通过即意味着「有事发生」：只要 toast/响铃任一通道开着就留档
  // （响铃-only 时用户没看到弹窗，更需要历史可回看）。免打扰压制两个
  // 打扰通道但不压制留档。
  if (n.pomodoroToast || n.pomodoroSound) recordHistory("pomodoro", opts.title, opts.body, "pomodoro");
  const quiet = dndSuppressing();
  if (n.pomodoroToast && !quiet) dispatchToast(opts.title, opts.body, "pomodoro");
  if (n.pomodoroSound && !quiet) {
    if (opts.sound) {
      // 专注/休息结束各走各的音色与音量（0-100 → 0..1）。
      const id = opts.sound.event === "focus-end" ? n.pomodoroFocusEndSound : n.pomodoroBreakEndSound;
      const volume = (opts.sound.event === "focus-end" ? n.pomodoroFocusEndVolume : n.pomodoroBreakEndVolume) / 100;
      if (!playEventSound(id, volume)) playChime("pomodoro");
    } else {
      playChime("pomodoro");
    }
  }
}

/**
 * 逐项门控的待办/DDL 通知。
 * 门控链：todoEnabled 总开关 → 专注静音（沉浸期不轰炸）→ overdue 仅在
 * 「逾期提醒」开启时发 → todoToast/todoSound 独立决定弹窗与响铃。
 *
 * @param opts - `overdue`：是否逾期通知（默认 false）；`title`/`body`：文案。
 * @returns 无；任一门控不满足时为 no-op。
 *
 * @example
 * ```ts
 * todoNotification({ overdue: true, title: "任务逾期", body: "交周报" });
 * ```
 */
export function todoNotification(opts: { overdue?: boolean; title: string; body: string }) {
  const n = useSettingsStore.getState().notifications;
  if (!n.todoEnabled) return;
  if (focusSilent()) return; // F-专注静音：沉浸期间 DDL 提醒不再轰炸
  if (opts.overdue && !n.todoOverdue) return;
  if (n.todoToast || n.todoSound) recordHistory("todo", opts.title, opts.body, "todo");
  const quiet = dndSuppressing();
  if (n.todoToast && !quiet) dispatchToast(opts.title, opts.body, "todo");
  if (n.todoSound && !quiet) playChime("todo");
}
