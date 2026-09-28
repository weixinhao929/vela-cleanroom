/**
 * 设置页 · 通用页：语言、开机自启、桌面图标显示、游戏时暂停与
 * 「减少特效」等全局行为开关。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { ShieldCheck } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { invoke, isTauri } from "../../../lib/tauri";
import { useSettingsStore, clearSettingsMirror } from "../../../store/settings-store";
import { useWidgetStore, loadInstances } from "../../../widget/widget-store";
import { Dropdown, SettingToggleRow, Toggle } from "../shared";
import { useT, t } from "../../../i18n-lite";
import { FxText } from "../../../lib/fx";
import { confirmDialog } from "../../../components/PromptDialog";
import { DataPanel } from "../DataPanel";
import { getCrashLog, clearCrashLog, type CrashEntry } from "../../../lib/crash-log";
import { readBootProfile, formatBootProfile, type BootMark } from "../../../lib/boot-profile";
import { useDelayedUnmount } from "../../../lib/anim";
import { animDurations } from "../../../lib/durations";
import { useSafeTimeout } from "../../../lib/use-safe-timeout";
import { pauseOtherWindowsPersistence } from "../../../lib/persist-gate";
import {
  APP_SHORTCUT_DESCS,
  APP_SHORTCUT_IDS,
  APP_SHORTCUT_LABELS,
  APP_SHORTCUT_SCOPES,
  DEFAULT_APP_SHORTCUTS,
  DEFAULT_SHORTCUTS,
  SHORTCUT_ACTIONS,
  SHORTCUT_LABELS,
  SHORTCUT_UNBOUND,
  acceleratorFromEvent,
  findDuplicate,
  hasModifier,
  isShortcutBound,
  normalizeAccelerator,
  type AppShortcutConfig,
  type AppShortcutId,
  type ShortcutAction
} from "../../../lib/shortcuts";

/**
 * §4.5 快捷键配置区（全局 + 应用内）：每行 =「启用开关（有无）+ 组合键芯片（点击
 * 录制具体键位）+ 恢复默认」。全局动作经 settings-store 下发 Rust 注册（App.tsx
 * ShortcutConfigSync 驱动，冲突经 shortcut:register-failed toast 反馈）；应用内
 * 动作存 appShortcuts，由各窗口的 keydown 处理器实时读取。录制按下新组合
 * （event.code 物理键位，忽略纯修饰键）即保存，Esc 取消；保存前查重，全局表还
 * 要求至少一个修饰键（无修饰全局热键会系统级吞键）。
 */
type RecordingTarget = { kind: "global"; action: ShortcutAction } | { kind: "app"; id: AppShortcutId } | null;

function ShortcutSection() {
  const tr = useT();
  const shortcuts = useSettingsStore(useShallow((s) => s.shortcuts));
  const appShortcuts = useSettingsStore(useShallow((s) => s.appShortcuts));
  const setShortcut = useSettingsStore((s) => s.setShortcut);
  const setAppShortcut = useSettingsStore((s) => s.setAppShortcut);
  const [recording, setRecording] = useState<RecordingTarget>(null);
  const [warn, setWarn] = useState<string | null>(null);
  const safeTimeout = useSafeTimeout();
  /* 关闭开关前的键位记忆：重新开启时优先恢复（而不是直接跳回出厂默认）。 */
  const remembered = useRef<Partial<Record<string, string>>>({});
  const flashWarn = (text: string) => {
    setWarn(text);
    safeTimeout(() => setWarn(null), 2600);
  };

  useEffect(() => {
    if (!recording) return;
    const target = recording;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.code === "Escape") {
        setRecording(null);
        return;
      }
      const accel = acceleratorFromEvent(e);
      if (!accel) return; // 纯修饰键：继续等主键
      if (target.kind === "global" && !hasModifier(accel)) {
        flashWarn(tr("至少需要一个修饰键（Ctrl / Alt / Shift / Win）"));
        return;
      }
      const table = target.kind === "global" ? shortcuts : appShortcutsSameScope(appShortcuts, target.id);
      const dup = findDuplicate(table, target.kind === "global" ? target.action : target.id, accel);
      if (dup) {
        flashWarn(tr("与「{a}」的快捷键冲突").replace("{a}", dupLabel(dup, target.kind, tr)));
        return;
      }
      if (target.kind === "global") setShortcut(target.action, accel);
      else setAppShortcut(target.id, { accel, enabled: true });
      setRecording(null);
    };
    // capture 阶段拦截：录制期间的按键不应触发设置页里的其它快捷键（Ctrl+K 搜索等）。
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recording, shortcuts, appShortcuts, setShortcut, setAppShortcut, tr]);

  /* ---- 全局动作行 ---- */
  const toggleGlobal = (action: ShortcutAction, on: boolean) => {
    if (!on) {
      if (isShortcutBound(shortcuts[action])) remembered.current[action] = shortcuts[action];
      setShortcut(action, SHORTCUT_UNBOUND);
      return;
    }
    const candidate =
      remembered.current[action] && isShortcutBound(remembered.current[action]!)
        ? remembered.current[action]!
        : DEFAULT_SHORTCUTS[action];
    // 出厂就不绑定的动作（taskbar:toggle）：直接进入录制。
    if (!isShortcutBound(candidate)) {
      setRecording({ kind: "global", action });
      return;
    }
    const dup = findDuplicate(shortcuts, action, candidate);
    if (dup) {
      flashWarn(tr("与「{a}」的快捷键冲突").replace("{a}", tr(SHORTCUT_LABELS[dup as ShortcutAction])));
      return;
    }
    setShortcut(action, candidate);
  };
  const restoreGlobal = (action: ShortcutAction) => {
    const dup = findDuplicate(shortcuts, action, DEFAULT_SHORTCUTS[action]);
    if (dup) {
      flashWarn(tr("与「{a}」的快捷键冲突").replace("{a}", tr(SHORTCUT_LABELS[dup as ShortcutAction])));
      return;
    }
    setShortcut(action, DEFAULT_SHORTCUTS[action]);
  };

  /* ---- 应用内动作行 ---- */
  const toggleApp = (id: AppShortcutId, on: boolean) => {
    if (!on) {
      remembered.current[`app:${id}`] = appShortcuts[id].accel;
      setAppShortcut(id, { enabled: false });
      return;
    }
    setAppShortcut(id, { enabled: true });
  };
  const restoreApp = (id: AppShortcutId) => {
    const def = DEFAULT_APP_SHORTCUTS[id].accel;
    const dup = findDuplicate(appShortcutsSameScope(appShortcuts, id), id, def);
    if (dup && dup !== id) {
      flashWarn(tr("与「{a}」的快捷键冲突").replace("{a}", tr(APP_SHORTCUT_LABELS[dup as AppShortcutId])));
      return;
    }
    setAppShortcut(id, { accel: def, enabled: DEFAULT_APP_SHORTCUTS[id].enabled });
  };

  /* 同作用域内启用条目的键位表（跨窗口不查重：palette 与 settings-search 默认同为 Ctrl+K）。 */
  const appConflictPairs = (): [AppShortcutId, AppShortcutId] | null => {
    for (let i = 0; i < APP_SHORTCUT_IDS.length; i++) {
      const a = APP_SHORTCUT_IDS[i];
      if (!appShortcuts[a].enabled) continue;
      for (let j = i + 1; j < APP_SHORTCUT_IDS.length; j++) {
        const b = APP_SHORTCUT_IDS[j];
        if (!appShortcuts[b].enabled) continue;
        if (APP_SHORTCUT_SCOPES[a] !== APP_SHORTCUT_SCOPES[b]) continue;
        if (
          normalizeAccelerator(appShortcuts[a].accel) &&
          normalizeAccelerator(appShortcuts[a].accel) === normalizeAccelerator(appShortcuts[b].accel)
        )
          return [a, b];
      }
    }
    return null;
  };
  const appConflict = appConflictPairs();

  return (
    <>
      <div className="tm-setting-desc">{tr("任何应用在前台时都有效")}</div>
      {SHORTCUT_ACTIONS.map((action) => {
        const bound = isShortcutBound(shortcuts[action]);
        const isRec = recording?.kind === "global" && recording.action === action;
        const shown = isRec ? tr("按下新组合…") : bound ? shortcuts[action] : tr("未设置");
        return (
          <div className="tm-shortcut-row" key={action}>
            <Toggle
              on={bound}
              onChange={(v) => toggleGlobal(action, v)}
              ariaLabel={`${tr(SHORTCUT_LABELS[action])} ${tr("快捷键开关")}`}
            />
            <span className="tm-shortcut-name">{tr(SHORTCUT_LABELS[action])}</span>
            <button
              type="button"
              className={`tm-shortcut-combo${bound ? "" : " is-unbound"}${isRec ? " is-recording" : ""}`}
              data-interactive
              aria-pressed={isRec}
              aria-label={`${tr(SHORTCUT_LABELS[action])}: ${shown}`}
              title={isRec ? tr("按 Esc 取消") : tr("点击录制新组合")}
              onClick={() => setRecording(isRec ? null : { kind: "global", action })}
            >
              {shown}
            </button>
            {shortcuts[action] !== DEFAULT_SHORTCUTS[action] && (
              <button type="button" className="tm-btn-ghost" data-interactive onClick={() => restoreGlobal(action)}>
                {tr("恢复默认")}
              </button>
            )}
          </div>
        );
      })}
      {warn && (
        <span className="tm-setting-error" role="status">
          {warn}
        </span>
      )}

      <div className="tm-setting-desc tm-shortcut-subhead">{tr("仅应用窗口内生效")}</div>
      {APP_SHORTCUT_IDS.map((id) => {
        const entry = appShortcuts[id];
        const isRec = recording?.kind === "app" && recording.id === id;
        const shown = isRec ? tr("按下新组合…") : entry.enabled ? entry.accel : tr("已停用");
        const customized =
          entry.accel !== DEFAULT_APP_SHORTCUTS[id].accel || entry.enabled !== DEFAULT_APP_SHORTCUTS[id].enabled;
        const conflicting = appConflict && (appConflict[0] === id || appConflict[1] === id);
        return (
          <div className="tm-shortcut-row" key={id}>
            <Toggle
              on={entry.enabled}
              onChange={(v) => toggleApp(id, v)}
              ariaLabel={`${tr(APP_SHORTCUT_LABELS[id])} ${tr("快捷键开关")}`}
            />
            <span className="tm-shortcut-name">
              {tr(APP_SHORTCUT_LABELS[id])}
              <span className="tm-shortcut-sub">{tr(APP_SHORTCUT_DESCS[id])}</span>
            </span>
            <button
              type="button"
              className={`tm-shortcut-combo${entry.enabled ? "" : " is-unbound"}${isRec ? " is-recording" : ""}${conflicting ? " is-conflict" : ""}`}
              data-interactive
              aria-pressed={isRec}
              aria-label={`${tr(APP_SHORTCUT_LABELS[id])}: ${shown}`}
              title={isRec ? tr("按 Esc 取消") : tr("点击录制新组合")}
              onClick={() => setRecording(isRec ? null : { kind: "app", id })}
            >
              {shown}
            </button>
            {customized && (
              <button type="button" className="tm-btn-ghost" data-interactive onClick={() => restoreApp(id)}>
                {tr("恢复默认")}
              </button>
            )}
          </div>
        );
      })}
      {appConflict && (
        <span className="tm-setting-error" role="status">
          {tr("「{a}」与「{b}」键位相同，后者不生效")
            .replace("{a}", tr(APP_SHORTCUT_LABELS[appConflict[0]]))
            .replace("{b}", tr(APP_SHORTCUT_LABELS[appConflict[1]]))}
        </span>
      )}
    </>
  );
}

/** appShortcuts → findDuplicate 的 Record<string,string> 视图：只含与 target 同窗口
 *  作用域且启用的条目（跨作用域不冲突，见 APP_SHORTCUT_SCOPES）。 */
function appShortcutsSameScope(cfg: AppShortcutConfig, target: AppShortcutId): Record<string, string> {
  const out: Record<string, string> = {};
  for (const id of APP_SHORTCUT_IDS) {
    if (APP_SHORTCUT_SCOPES[id] !== APP_SHORTCUT_SCOPES[target]) continue;
    out[id] = cfg[id].enabled ? cfg[id].accel : "";
  }
  return out;
}
function dupLabel(dup: string, kind: "global" | "app", tr: (s: string) => string): string {
  return kind === "global" && dup in SHORTCUT_LABELS
    ? tr(SHORTCUT_LABELS[dup as ShortcutAction])
    : tr(APP_SHORTCUT_LABELS[dup as AppShortcutId]);
}

/** §4.9 Rust 侧崩溃统计（get_crash_stats 返回形状，serde camelCase）。 */
type CrashStats = {
  count7d: number;
  total: number;
  latest: CrashRecord | null;
  latestPanic: CrashRecord | null;
};
type CrashRecord = { ts: number; kind: "panic" | "frontend" | string; source: string; summary: string };

/**
 * 诊断区：崩溃统计（§4.9 第一步：只计数）。
 *
 * Rust panic hook 与前端 crash-log 汇聚落盘在 app_data/crash-log.json，
 * 这里展示「近 7 天崩溃 N 次 + 最近 panic 摘要」——先拿到数据，再决定
 * 是否值得做自重启。仅桌面端有该文件，Web 预览整块隐藏。
 */
function CrashStatsPanel() {
  const tr = useT();
  const [stats, setStats] = useState<CrashStats | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    const load = () => {
      invoke<CrashStats>("get_crash_stats")
        .then((s) => {
          if (!disposed) setStats(s);
        })
        .catch((e) => {
          if (!disposed) setError(String(e));
        });
    };
    load();
    // 与 CrashLogPanel 同款：切回窗口时刷新（崩溃通常发生在别处）。
    window.addEventListener("focus", load);
    return () => {
      disposed = true;
      window.removeEventListener("focus", load);
    };
  }, []);

  if (!isTauri()) return null;

  const count = stats?.count7d ?? 0;
  const latest = stats?.latestPanic ?? stats?.latest ?? null;
  return (
    <div className="tm-crashlog">
      <div className="tm-crashlog-head">
        <span className="tm-setting-title">{tr("崩溃统计")}</span>
        <span className="tm-setting-desc">
          {error !== null
            ? `${tr("读取崩溃统计失败：")}${error}`
            : stats === null
              ? tr("读取中…")
              : count === 0
                ? tr("近 7 天无崩溃记录")
                : `${tr("近 7 天崩溃 {n} 次").replace("{n}", String(count))} · ${tr("累计 {n} 次").replace("{n}", String(stats.total))}`}
        </span>
      </div>
      {latest && (
        <div className="tm-crashlog-list">
          <details className="tm-crashlog-item">
            <summary>
              <ShieldCheck size={12} />
              <span className="tm-crashlog-src">{latest.kind === "panic" ? tr("最近 panic") : tr("最近前端异常")}</span>
              <span className="tm-crashlog-time">{new Date(latest.ts).toLocaleString()}</span>
              <span className="tm-crashlog-msg">{latest.summary}</span>
            </summary>
            <pre>
              {latest.source}
              {"\n"}
              {latest.summary}
            </pre>
          </details>
        </div>
      )}
    </div>
  );
}

/** 诊断区：崩溃日志（小组件错误边界 + 全局异常兜底收集）。 */
function CrashLogPanel() {
  const tr = useT();
  const safeTimeout = useSafeTimeout();
  const [entries, setEntries] = useState<CrashEntry[]>([]);
  /* #93 清空退场：列表先播 200ms 收拢淡出，再真正清掉数据。 */
  const [clearing, setClearing] = useState(false);

  useEffect(() => {
    setEntries(getCrashLog());
    const onChanged = () => setEntries(getCrashLog());
    window.addEventListener("focus", onChanged);
    return () => window.removeEventListener("focus", onChanged);
  }, []);

  return (
    <div className="tm-crashlog">
      <div className="tm-crashlog-head">
        <span className="tm-setting-title">{tr("崩溃日志")}</span>
        <span className="tm-setting-desc">
          {entries.length > 0 ? tr("最近问题（仅本地记录，用于诊断）") : tr("暂无异常记录，运行状态良好")}
        </span>
        {entries.length > 0 && (
          <button
            className="tm-btn-ghost"
            data-interactive
            disabled={clearing}
            onClick={() => {
              if (clearing) return;
              setClearing(true);
              /* 三.1：收拢动画 tm-list-collapse 走 --dur-fx，这里同源取值
                 （原固定 200ms 与速度档脱钩）。+20ms 兜底动画尾帧。 */
              safeTimeout(
                () => {
                  clearCrashLog();
                  setEntries([]);
                  setClearing(false);
                },
                Math.round(animDurations().fxMs) + 20
              );
            }}
          >
            {tr("清空")}
          </button>
        )}
      </div>
      {entries.length > 0 && (
        <div className={`tm-crashlog-list${clearing ? " is-clearing" : ""}`}>
          {entries.slice(0, 8).map((e, i) => (
            <details key={`${e.ts}-${i}`} className="tm-crashlog-item">
              <summary>
                <ShieldCheck size={12} />
                <span className="tm-crashlog-src">{e.source}</span>
                <span className="tm-crashlog-time">{new Date(e.ts).toLocaleString()}</span>
                <span className="tm-crashlog-msg">{e.message}</span>
              </summary>
              {e.stack && <pre>{e.stack}</pre>}
            </details>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * 诊断区：冷启动耗时分段（P4）。
 *
 * 启动慢时能直接看出瓶颈在哪一段：`script-eval` 大说明 bundle 解析慢，
 * `hydrate-db` 大说明 SQLite 读取慢，`first-paint` 与 `hydrate-settings`
 * 差距大说明首帧渲染重。反馈问题时可一键复制。
 */
function BootProfilePanel() {
  const tr = useT();
  const safeTimeout = useSafeTimeout();
  const [marks, setMarks] = useState<BootMark[]>([]);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    setMarks(readBootProfile());
  }, []);

  const total = marks.find((m) => m.phase === "first-paint")?.at ?? null;

  return (
    <div className="tm-bootprofile">
      <div className="tm-crashlog-head">
        <span className="tm-setting-title">{tr("启动耗时")}</span>
        <span className="tm-setting-desc">
          {total !== null ? `${tr("本次启动首帧用时")} ${Math.round(total)}ms` : tr("暂无启动数据")}
        </span>
        {marks.length > 0 && (
          <button
            className="tm-btn-ghost"
            data-interactive
            onClick={() => {
              // 复制失败（无剪贴板权限）时静默忽略，不打断诊断流程。
              void navigator.clipboard?.writeText(formatBootProfile(marks)).then(
                () => {
                  setCopied(true);
                  safeTimeout(() => setCopied(false), 1600);
                },
                () => {}
              );
            }}
          >
            {/* #92 复制↔已复制：key 重建 + 淡入（与 tm-setting-saved 同语言） */}
            <span className={`tm-copied-label${copied ? " on" : ""}`} key={copied ? "y" : "n"}>
              {copied ? tr("已复制") : tr("复制")}
            </span>
          </button>
        )}
      </div>
      {marks.length > 0 && (
        <div className="tm-bootprofile-list">
          {marks.map((m, i) => {
            const prev = i === 0 ? 0 : marks[i - 1].at;
            const delta = Math.max(0, m.at - prev);
            // 用相对总耗时的比例画一条轻量条形，无需引图表库。
            const pct = total && total > 0 ? Math.min(100, (delta / total) * 100) : 0;
            return (
              <div className="tm-bootprofile-row" key={m.phase}>
                <span className="tm-bootprofile-phase">{m.phase}</span>
                <span className="tm-bootprofile-bar" aria-hidden="true">
                  <i style={{ width: `${pct}%` }} />
                </span>
                <span className="tm-bootprofile-ms">+{Math.round(delta)}ms</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
/**
 * 诊断区：运行日志（S1）。
 *
 * 崩溃日志只收集前端异常，Rust 侧的命令失败（数据库、文件、系统采集）此前
 * 只打到 stderr，打包后完全看不到。这里把落盘日志的尾部读出来，并提供
 * 「打开日志目录」入口，用户反馈问题时可以直接附上文件。
 */
function RuntimeLogPanel() {
  const tr = useT();
  const [text, setText] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // 仅桌面端有日志文件，Web 预览下整块隐藏而不是显示一个必然失败的按钮。
  if (!isTauri()) return null;

  const load = () => {
    setLoading(true);
    invoke<string>("read_recent_log", { lines: 200 })
      .then((raw) => setText(raw.trim().length > 0 ? raw : tr("今日暂无日志记录")))
      .catch((err) => setText(`${tr("读取日志失败：")}${String(err)}`))
      .finally(() => setLoading(false));
  };

  return (
    <div className="tm-runtimelog">
      <div className="tm-crashlog-head">
        <span className="tm-setting-title">{tr("运行日志")}</span>
        <span className="tm-setting-desc">{tr("按天滚动保存，自动保留最近 7 天")}</span>
        <button className="tm-btn-ghost" data-interactive disabled={loading} onClick={load}>
          {loading ? tr("读取中…") : text === null ? tr("查看") : tr("刷新")}
        </button>
        <button
          className="tm-btn-ghost"
          data-interactive
          onClick={() => {
            void invoke("open_log_dir").catch(() => {});
          }}
        >
          {tr("打开目录")}
        </button>
      </div>
      {text !== null && <pre className="tm-runtimelog-body">{text}</pre>}
    </div>
  );
}

export function GeneralPage() {
  /* C8（rerender）：此前整店订阅——store 任何写入（滑杆每帧 setExtra、
     跨窗口同步 setState）都会重渲整个 GeneralPage。改 useShallow 只取用到的
     general 字段与 setter。 */
  const g = useSettingsStore(useShallow((s) => s.general));
  const setGeneral = useSettingsStore((s) => s.setGeneral);
  /* C8：本页还消费 extra.analyticsStartDate（低频字段，标量订阅）。 */
  const analyticsStartDate = useSettingsStore((s) => s.extra.analyticsStartDate);
  const setExtra = useSettingsStore((s) => s.setExtra);
  const s = useMemo(
    () => ({ general: g, setGeneral, extra: { analyticsStartDate }, setExtra }),
    [g, setGeneral, analyticsStartDate, setExtra]
  );
  /* 番茄钟每日目标（方式 + 数值）：与番茄钟面板共享同一份配置。 */
  const tr = useT();

  /* #81 导入/导出反馈：成功淡入 / 失败 shake（复用 tm-setting-saved / error） */
  const [ioMsg, setIoMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const ioVisible = useDelayedUnmount(ioMsg !== null, animDurations().fxMs);
  const ioClosing = ioMsg === null && ioVisible;
  const ioTimer = useRef<number>(0);
  const lastIo = useRef<{ ok: boolean; text: string } | null>(null);
  const showIo = (ok: boolean, text: string) => {
    setIoMsg({ ok, text });
    window.clearTimeout(ioTimer.current);
    ioTimer.current = window.setTimeout(() => setIoMsg(null), 2600);
  };
  useEffect(() => () => window.clearTimeout(ioTimer.current), []);
  if (ioMsg !== null) lastIo.current = ioMsg;

  /* #87 重置中：reset_app_data 执行期间按钮 loading（与 #78 同语言） */
  const [resetting, setResetting] = useState(false);

  /* [WAKE-BL]（ZTools #14）黑名单草稿：受控输入（逗号分隔 → 数组落 store；
     恢复备份等外部变更不跟随，重开页面即对齐）。 */
  const [blacklistDraft, setBlacklistDraft] = useState(() =>
    useSettingsStore.getState().general.hotkeyBlacklist.join(", ")
  );

  // Sync the real system state (autostart / desktop icons) on mount and drive
  // the native commands when the user flips the corresponding toggles.
  useEffect(() => {
    if (!isTauri()) return;
    invoke<boolean>("get_autostart")
      .then((enabled) => s.setGeneral({ launchOnStartup: enabled }))
      .catch(() => {});
    invoke<boolean>("get_desktop_icons")
      .then((shown) => s.setGeneral({ showDesktopIcons: shown }))
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const setLaunch = (v: boolean) => {
    s.setGeneral({ launchOnStartup: v });
    if (isTauri()) invoke("set_autostart", { enabled: v }).catch(() => {});
  };
  /* 桌面图标开关失败提示：就地显示在开关行下方，2.6s 后自动消失。 */
  const [iconErr, setIconErr] = useState<string | null>(null);
  const safeTimeout = useSafeTimeout();
  const setDesktopIcons = async (v: boolean) => {
    s.setGeneral({ showDesktopIcons: v });
    if (!isTauri()) return;
    // 后端的 0x7402 是"切换"而非"赋值"，且 explorer 应用需要时间：先乐观
    // 更新，再以回读到的真实状态校正，避免显示为开而桌面图标仍隐藏。
    let failed = false;
    try {
      await invoke("set_desktop_icons", { show: v });
    } catch {
      failed = true;
    }
    const shown = await invoke<boolean>("get_desktop_icons").catch(() => (failed ? !v : v));
    s.setGeneral({ showDesktopIcons: shown });
    if (failed || shown !== v) {
      setIconErr(tr("桌面图标切换失败"));
      safeTimeout(() => setIconErr(null), 2600);
    }
  };

  return (
    <>
      <section className="tm-section">
        <div className="tm-section-title">
          <FxText text={tr("常规")} />
        </div>
        <div className="tm-setting-row">
          <div className="tm-setting-text">
            <span className="tm-setting-title">{tr("语言")}</span>
            <span className="tm-setting-desc">{tr("应用显示语言")}</span>
          </div>
          <Dropdown<"简体中文" | "English">
            value={g.language as "简体中文" | "English"}
            options={[
              { id: "简体中文", label: "简体中文" },
              { id: "English", label: "English" }
            ]}
            onChange={(v) => s.setGeneral({ language: v })}
          />
        </div>
        <SettingToggleRow title="开机启动" desc="登录时自动启动" on={g.launchOnStartup} onChange={setLaunch} />
        <SettingToggleRow
          title="显示桌面图标"
          desc="隐藏或显示 Windows 桌面上的图标"
          on={g.showDesktopIcons}
          onChange={setDesktopIcons}
        />
        {iconErr && (
          <span className="tm-setting-error" role="status">
            {iconErr}
          </span>
        )}
        <SettingToggleRow
          title="游戏时暂停"
          desc="检测到全屏应用时暂停小组件"
          on={g.pauseDuringGaming}
          onChange={(v) => s.setGeneral({ pauseDuringGaming: v })}
        />
        <SettingToggleRow
          title="双击桌面切换显示"
          desc="双击空白桌面显示或隐藏小组件层（与 Ctrl+Alt+D 等效）"
          on={g.desktopDoubleClick}
          onChange={(v) => {
            s.setGeneral({ desktopDoubleClick: v });
            if (isTauri()) invoke("set_desktop_double_click", { enabled: v }).catch(() => {});
          }}
        />
        <SettingToggleRow
          title="减少特效"
          desc="关闭小组件和菜单背后的毛玻璃模糊效果"
          on={g.reduceEffects}
          onChange={(v) => s.setGeneral({ reduceEffects: v })}
        />
        {/* 首启引导重看入口：只重置 extra.onboarded（引导层随即覆盖在设置窗
            内容之上），不影响其它任何设置。 */}
        <div className="tm-setting-row">
          <div className="tm-setting-text">
            <span className="tm-setting-title">{tr("新手引导")}</span>
            <span className="tm-setting-desc">{tr("重新查看首次启动的使用指引")}</span>
          </div>
          <button type="button" className="tm-onb-replay" onClick={() => s.setExtra({ onboarded: false })}>
            {tr("重新查看")}
          </button>
        </div>
      </section>

      <div className="tm-divider" />

      {/* [SUPER-PANEL]/[DOUBLE-TAP]/[WAKE-BL]（ZTools 借鉴 #11/#13/#14）：
          长按右键取词面板 / 双击修饰键呼出 / 唤醒热键黑名单。三项均默认关，
          Rust 侧从设置镜像 2s 周期刷新，改动最迟 2s 生效。 */}
      <section className="tm-section">
        <div className="tm-section-title">
          <FxText text={tr("面板与唤起")} />
        </div>
        <SettingToggleRow
          title="超级面板"
          desc="选中文字后按住右键约半秒，在光标旁弹出快捷操作面板（取词靠模拟 Ctrl+C 实现：会临时覆盖剪贴板内容，取到的文字不入剪贴板历史）"
          on={g.superPanel.enabled}
          onChange={(v) => s.setGeneral({ superPanel: { ...g.superPanel, enabled: v } })}
        />
        {g.superPanel.enabled && (
          <div className="tm-setting-row">
            <div className="tm-setting-text">
              <span className="tm-setting-title">{tr("长按时长")}</span>
              <span className="tm-setting-desc">{tr("按住右键多久触发面板（300–1000 毫秒）")}</span>
            </div>
            <Dropdown<"300" | "500" | "800" | "1000">
              value={String(g.superPanel.durationMs) as "300" | "500" | "800" | "1000"}
              options={[
                { id: "300", label: "0.3s" },
                { id: "500", label: "0.5s" },
                { id: "800", label: "0.8s" },
                { id: "1000", label: "1s" }
              ]}
              onChange={(v) => s.setGeneral({ superPanel: { ...g.superPanel, durationMs: Number(v) } })}
            />
          </div>
        )}
        <SettingToggleRow
          title="双击修饰键呼出面板"
          desc="快速按两次 Ctrl（或 Alt）呼出命令面板，与 Ctrl+Alt+K 等效"
          on={g.doubleTapSummon.enabled}
          onChange={(v) => s.setGeneral({ doubleTapSummon: { ...g.doubleTapSummon, enabled: v } })}
        />
        {g.doubleTapSummon.enabled && (
          <div className="tm-setting-row">
            <div className="tm-setting-text">
              <span className="tm-setting-title">{tr("触发键")}</span>
              <span className="tm-setting-desc">{tr("两次按下同一修饰键触发（350 毫秒内）")}</span>
            </div>
            <Dropdown<"ctrl" | "alt">
              value={g.doubleTapSummon.key}
              options={[
                { id: "ctrl", label: "Ctrl" },
                { id: "alt", label: "Alt" }
              ]}
              onChange={(v) => s.setGeneral({ doubleTapSummon: { ...g.doubleTapSummon, key: v } })}
            />
          </div>
        )}
        <div className="tm-setting-row">
          <div className="tm-setting-text">
            <span className="tm-setting-title">{tr("热键唤醒黑名单")}</span>
            <span className="tm-setting-desc">{tr("前台应用命中时命令面板 / 速记热键不触发（exe 名，逗号分隔）")}</span>
          </div>
          <input
            className="tm-text-input"
            data-interactive
            value={blacklistDraft}
            placeholder="game.exe, player.exe"
            onChange={(e) => {
              const v = e.target.value;
              setBlacklistDraft(v);
              const list = v
                .split(/[,，;]/)
                .map((x) => x.trim())
                .filter(Boolean);
              s.setGeneral({ hotkeyBlacklist: list });
            }}
          />
        </div>
      </section>

      <div className="tm-divider" />

      <section className="tm-section">
        <div className="tm-section-title">{tr("数据")}</div>
        <div className="tm-setting-row">
          <div className="tm-setting-text">
            <span className="tm-setting-title">{tr("数据存储")}</span>
            <span className="tm-setting-desc">{tr("所有数据均保存在本地，不会上传到任何服务器")}</span>
          </div>
        </div>
        <DataPanel />
      </section>

      <div className="tm-divider" />

      <section className="tm-section">
        <div className="tm-section-title">{tr("诊断")}</div>
        <CrashStatsPanel />
        <CrashLogPanel />
        <BootProfilePanel />
        <RuntimeLogPanel />
      </section>

      <div className="tm-divider" />

      <section className="tm-section">
        <div className="tm-section-title">{tr("快捷键")}</div>
        <ShortcutSection />
      </section>

      <div className="tm-divider" />

      <section className="tm-section">
        <div className="tm-section-title">{tr("导入 / 导出")}</div>
        <div className="tm-setting-row">
          <div className="tm-setting-text">
            <span className="tm-setting-title">{tr("导出设置")}</span>
            <span className="tm-setting-desc">{tr("保存到文件")}</span>
          </div>
          <button
            className="tm-btn-secondary"
            onClick={() => {
              exportSettings();
              showIo(true, tr("设置已导出"));
            }}
          >
            {tr("导出")}
          </button>
        </div>
        <div className="tm-setting-row">
          <div className="tm-setting-text">
            <span className="tm-setting-title">{tr("导入设置")}</span>
            <span className="tm-setting-desc">{tr("从备份文件恢复")}</span>
          </div>
          <button
            className="tm-btn-secondary"
            onClick={async () => {
              const r = await importSettings();
              if (r === "ok") showIo(true, tr("设置导入成功"));
              else if (r === "fail") showIo(false, tr("导入失败：文件格式不正确"));
            }}
          >
            {tr("导入")}
          </button>
        </div>
        {/* #81 结果反馈条 */}
        {ioVisible && lastIo.current && (
          <span
            className={`${lastIo.current.ok ? "tm-setting-saved" : "tm-setting-error"}${ioClosing ? " is-closing" : ""}`}
            role="status"
          >
            {lastIo.current.text}
          </span>
        )}
      </section>

      <div className="tm-divider" />

      <section className="tm-section">
        <div className="tm-section-title">{tr("重置")}</div>
        <div className="tm-setting-row">
          <div className="tm-setting-text">
            <span className="tm-setting-title">{tr("重置 Vela")}</span>
            <span className="tm-setting-desc">{tr("清除全部数据并恢复默认")}</span>
          </div>
          <button
            className="tm-btn-danger"
            disabled={resetting}
            onClick={async () => {
              setResetting(true);
              const went = await resetVela();
              if (!went) setResetting(false);
            }}
          >
            {resetting ? (
              <>
                <span className="tm-spinner" />
                {tr("重置中…")}
              </>
            ) : (
              tr("重置")
            )}
          </button>
        </div>
      </section>
    </>
  );
}

function exportSettings() {
  const state = useSettingsStore.getState();
  const ws = useWidgetStore.getState();
  // Export a clean payload (no runtime-only fields like settingsOpen) plus the
  // view list and the layouts of every view so the whole setup survives a
  // backup / restore.
  const layouts: Record<string, unknown> = {};
  for (const v of ws.views) layouts[v.id] = loadInstances(v.id);
  const payload = {
    preset: state.preset,
    themeMode: state.themeMode,
    primaryColor: state.primaryColor,
    zoom: state.zoom,
    font: state.font,
    fontSize: state.fontSize,
    widgetBackground: state.widgetBackground,
    widgetOpacity: state.widgetOpacity,
    settingsWindowOpacity: state.settingsWindowOpacity,
    cornerRadius: state.cornerRadius,
    spacing: state.spacing,
    blur: state.blur,
    general: state.general,
    extra: state.extra,
    notifications: state.notifications,
    shortcuts: state.shortcuts,
    appShortcuts: state.appShortcuts,
    activeView: ws.activeView,
    viewsList: ws.views,
    views: layouts
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "vela-settings.json";
  a.click();
  URL.revokeObjectURL(url);
}

/** #81 导入设置：返回结果状态供调用方给出成功/失败反馈（cancel = 未选文件）。 */
function importSettings(): Promise<"ok" | "fail" | "cancel"> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "application/json";
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) {
        resolve("cancel");
        return;
      }
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const data = JSON.parse(String(reader.result));
          const st = useSettingsStore.getState();
          if (data.preset) st.setPreset(data.preset);
          if (data.themeMode) st.setThemeMode(data.themeMode);
          if (data.primaryColor) st.setPrimaryColor(data.primaryColor);
          if (data.zoom) st.setZoom(data.zoom);
          if (data.font) st.setFont(data.font);
          if (data.fontSize) st.setFontSize(data.fontSize);
          if (data.general) st.setGeneral(data.general);
          if (data.extra) st.setExtra(data.extra);
          if (data.notifications) st.setNotifications(data.notifications);
          // §4.5 快捷键表：经 sanitize 互斥校验后入库；Rust 重注册由 ShortcutConfigSync 跟进。
          if (data.shortcuts) st.setShortcuts(data.shortcuts);
          // 应用内快捷键（有无 + 键位）：逐条走 setAppShortcut，只传文件里给到的字段。
          if (data.appShortcuts && typeof data.appShortcuts === "object") {
            const g = useSettingsStore.getState();
            for (const id of APP_SHORTCUT_IDS) {
              const raw = (data.appShortcuts as Record<string, { enabled?: unknown; accel?: unknown }>)[id];
              if (!raw) continue;
              const patch: { enabled?: boolean; accel?: string } = {};
              if (typeof raw.enabled === "boolean") patch.enabled = raw.enabled;
              if (typeof raw.accel === "string" && raw.accel.trim()) patch.accel = raw.accel.trim();
              if (Object.keys(patch).length > 0) g.setAppShortcut(id, patch);
            }
          }
          // 外观字段必须走 setter：裸 setState 不触发 saveSettings，导入值只改
          // 内存不落盘，且会被上方 setPreset 强制重置过的预设默认值覆盖后留存。
          if (data.widgetBackground !== undefined) st.setWidgetBackground(data.widgetBackground);
          if (data.widgetOpacity !== undefined) st.setWidgetOpacity(data.widgetOpacity);
          if (data.settingsWindowOpacity !== undefined) st.setSettingsWindowOpacity(data.settingsWindowOpacity);
          if (data.cornerRadius !== undefined) st.setCornerRadius(data.cornerRadius);
          if (data.spacing !== undefined) st.setSpacing(data.spacing);
          if (data.blur !== undefined) st.setBlur(data.blur);
          // Restore the view list if the file includes it.
          const viewsList = data.viewsList as { id: string; name: string }[] | undefined;
          if (Array.isArray(viewsList) && viewsList.length > 0) {
            useWidgetStore.setState({ views: viewsList });
          }
          // Restore each view's widget layout if the file includes them.
          const views = data.views as Record<string, unknown> | undefined;
          if (views) {
            const ws = useWidgetStore.getState();
            for (const id of Object.keys(views)) {
              const list = views[id];
              if (Array.isArray(list)) {
                // importLayout writes to the store's *active* view, so switch to
                // the target view first, then restore; persist back to storage.
                useWidgetStore.setState({ activeView: id });
                ws.importLayout(JSON.stringify({ instances: list }));
              }
            }
            // Activate the exported view and load its widget instances.
            const target = (data.activeView as string) || "home";
            useWidgetStore.getState().setActiveView(target);
          } else if (data.widgetLayout?.instances) {
            // Backwards-compatible path for older single-view exports.
            const ws = useWidgetStore.getState();
            ws.importLayout(JSON.stringify({ instances: data.widgetLayout.instances }));
          }
          resolve("ok");
        } catch {
          resolve("fail");
        }
      };
      reader.onerror = () => resolve("fail");
      reader.readAsText(file);
    };
    input.click();
  });
}

/** #87 重置：返回是否真正执行（false = 用户在确认框取消）。 */
async function resetVela(): Promise<boolean> {
  if (
    !(await confirmDialog({
      title: t("重置应用"),
      message: t("确定要重置 Vela 吗？此操作将清除所有视图、小组件、布局和设置。"),
      confirmLabel: t("重置"),
      danger: true
    }))
  )
    return false;
  // SQLite 里还有布局/回收站/任务/设置镜像（重启后会复活），必须一并清掉；
  // localStorage.clear() 只清浏览器侧存储。
  if (isTauri()) {
    // 先让所有窗口（含本窗口）关上持久化闸门（与「恢复完整备份」同一 pause-ack
    // 协议）：否则其他窗口 300/350/500ms 内在飞的防抖落盘、以及 reload 前的
    // pagehide 冲刷，会把旧布局/设置写回刚清空的库，静默撤销本次重置。
    // 各窗口直到 reload 前都保持闸门置位——reload 后模块态自然归零，无需 release。
    try {
      await pauseOtherWindowsPersistence();
    } catch {
      // 握手异常（极端情况）仍继续重置，最坏退回旧行为。
    }
    try {
      await invoke("reset_app_data");
    } catch {
      // 数据库清理失败仍继续本地清理，避免用户被卡在无法重置的状态。
    }
  }
  localStorage.clear();
  clearSettingsMirror();
  if (isTauri()) {
    // 只刷新本窗口的话，桌面层/悬浮窗仍持有旧内存状态，随时可能把旧数据
    // 写回 SQLite（配置同步、镜像 flush），静默撤销本次重置。让所有窗口
    // 一起重载（与"恢复完整备份"同一机制）。
    void import("@tauri-apps/api/event").then(({ emit }) => emit("app:reload-all")).catch(() => {});
  }
  window.location.reload();
  return true;
}
