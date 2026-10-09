/**
 * 设置页 · 通用页：语言、开机自启、桌面图标显示、游戏时暂停与
 * 「减少特效」等全局行为开关。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { ShieldCheck } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { invoke, isTauri } from "../../../lib/tauri";
import { useSettingsStore, clearSettingsMirror } from "../../../store/settings-store";
import {
  currentScreenId,
  exportScreenLayoutSnapshots,
  importScreenLayoutSnapshot,
  loadGroups,
  loadInstances,
  reconcileDockTiles,
  useWidgetStore
} from "../../../widget/widget-store";
import { Dropdown, SettingRow, SettingToggleRow, Slider, Toggle } from "../shared";
import { useT, t } from "../../../i18n-lite";
/* 设置项运行期下发失败时的用户提示。 */
import { showToast } from "../../../components/ToastHost";
import { FxText } from "../../../lib/fx";
import { confirmDialog } from "../../../components/PromptDialog";
import { DataPanel } from "../DataPanel";
import { ClipboardConfig } from "../configs/connect";
import { MediaBehaviorConfig } from "../configs/media";
import { getCrashLog, clearCrashLog, type CrashEntry } from "../../../lib/crash-log";
import { readBootProfile, formatBootProfile, type BootMark } from "../../../lib/boot-profile";
import type { VelatapDigest } from "../../../types/bindings/VelatapDigest";
import { useDelayedUnmount } from "../../../lib/anim";
import { animDurations } from "../../../lib/durations";
import { useSafeTimeout } from "../../../lib/use-safe-timeout";
import { useTauriEvent } from "../../../lib/use-tauri-event";
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
  /** 最近数条（新→旧，含 panic 与 frontend）：排查连续崩溃看脉络。 */
  recent: CrashRecord[];
};
type CrashRecord = { ts: number; kind: "panic" | "frontend" | string; source: string; summary: string };

/**
 * 诊断区：崩溃统计（§4.9 第一步：只计数）。
 *
 * Rust panic hook 与前端 crash-log 汇聚落盘在 app_data/crash-log.json，
 * 这里展示「近 7 天崩溃 N 次 + 最近 5 条明细」——先拿到数据，再决定
 * 是否值得做自重启。仅桌面端有该文件，Web 预览整块隐藏。
 */
function CrashStatsPanel() {
  const tr = useT();
  const [stats, setStats] = useState<CrashStats | null>(null);
  const [error, setError] = useState<string | null>(null);
  /* 清空执行中：按钮 loading 防连点；成功后 crash:logged 事件驱动刷新。 */
  const [clearing, setClearing] = useState(false);

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
  // 实时刷新：任意窗口上报新崩溃（report_frontend_crash 落库后 Rust 广播
  // crash:logged）即重读统计——此前设置窗开着不动就永远停在旧计数。
  useTauriEvent<unknown>("crash:logged", () => {
    invoke<CrashStats>("get_crash_stats")
      .then((s) => {
        setStats(s);
        setError(null);
      })
      .catch(() => {});
  });

  if (!isTauri()) return null;

  const count = stats?.count7d ?? 0;
  return (
    <div className="tm-crashlog">
      <div className="tm-crashlog-head">
        <span className="tm-setting-title">{tr("崩溃统计")}</span>
        <span className="tm-setting-desc">
          {error !== null
            ? tr("读取崩溃统计失败：{err}", { err: error })
            : stats === null
              ? tr("读取中…")
              : count === 0
                ? tr("近 7 天无崩溃记录")
                : tr("近 7 天崩溃 {n} 次 · 累计 {m} 次", { n: count, m: stats.total })}
        </span>
        {/* 清空 Rust 侧崩溃文件（统计面板此前无清除入口，与「崩溃日志」
            面板的清空不对称）；成功后经 crash:logged 事件刷新两面板。 */}
        {stats !== null && stats.total > 0 && (
          <button
            className="tm-btn-ghost"
            data-interactive
            disabled={clearing}
            onClick={() => {
              if (clearing) return;
              setClearing(true);
              void invoke("clear_crash_stats")
                .catch((e) => setError(String(e)))
                .finally(() => setClearing(false));
            }}
          >
            {clearing ? tr("清空中…") : tr("清空")}
          </button>
        )}
      </div>
      {stats !== null && stats.recent.length > 0 && (
        <div className="tm-crashlog-list">
          {stats.recent.map((r) => (
            <details className="tm-crashlog-item" key={`${r.ts}-${r.source}`}>
              <summary>
                <ShieldCheck size={12} />
                <span className="tm-crashlog-src">{r.kind === "panic" ? tr("panic") : tr("前端异常")}</span>
                <span className="tm-crashlog-time">{new Date(r.ts).toLocaleString()}</span>
                <span className="tm-crashlog-msg">{r.summary}</span>
              </summary>
              <pre>
                {r.source}
                {"\n"}
                {r.summary}
              </pre>
            </details>
          ))}
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
  /* 清空退场：列表先播 200ms 收拢淡出，再真正清掉数据。 */
  const [clearing, setClearing] = useState(false);
  /* 默认折叠前 8 条，超过时提供「显示全部 / 收起」。 */
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    setEntries(getCrashLog());
    const onChanged = () => setEntries(getCrashLog());
    window.addEventListener("focus", onChanged);
    return () => window.removeEventListener("focus", onChanged);
  }, []);
  // 实时刷新：桌面层 / 速记窗等其它窗口记录的崩溃经 crash:logged 广播
  // 到达（同窗口写入不产生事件，本地清空已就地更新）。
  useTauriEvent<unknown>("crash:logged", () => setEntries(getCrashLog()));

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
        <>
          <div className={`tm-crashlog-list${clearing ? " is-clearing" : ""}`}>
            {(expanded ? entries : entries.slice(0, 8)).map((e, i) => (
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
          {entries.length > 8 && (
            <button type="button" className="tm-btn-ghost" data-interactive onClick={() => setExpanded((v) => !v)}>
              {expanded ? tr("收起") : tr("显示全部（{n}）", { n: entries.length })}
            </button>
          )}
        </>
      )}
    </div>
  );
}

/**
 * 诊断区：velatap.dll 完整性。安装包未签名期间，用户可把这里的
 * SHA-256 与发布侧 SHA256SUMS 人工比对；解包副本与分发 DLL 不一致时给出
 * 醒目提示（注入链自身有 §5.4 哈希校验，会拒绝不一致副本并重拷）。
 */
function VelatapDigestPanel() {
  const tr = useT();
  const safeTimeout = useSafeTimeout();
  const [digest, setDigest] = useState<VelatapDigest | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!isTauri()) return;
    void invoke<VelatapDigest>("get_velatap_digest")
      .then(setDigest)
      .catch(() => setDigest(null));
  }, []);

  if (!digest?.bundled_sha256) return null; // DLL 未交付（未开任务栏注入）时不占版面

  return (
    <div className="tm-bootprofile">
      <div className="tm-crashlog-head">
        <span className="tm-setting-title">{tr("任务栏组件完整性")}</span>
        <span className="tm-setting-desc">
          {digest.unpacked_sha256
            ? digest.unpacked_matches_bundled
              ? tr("注入副本与分发文件一致")
              : tr("注入副本哈希与分发文件不一致（下次注入会自动重新解包）")
            : tr("尚未注入")}
        </span>
        <button
          className="tm-btn-ghost"
          data-interactive
          onClick={() => {
            void navigator.clipboard?.writeText(`${digest.bundled_sha256 ?? ""}  velatap.dll`).then(
              () => {
                setCopied(true);
                safeTimeout(() => setCopied(false), 1600);
              },
              () => {}
            );
          }}
        >
          <span className={`tm-copied-label${copied ? " on" : ""}`} key={copied ? "y" : "n"}>
            {copied ? tr("已复制") : tr("复制哈希")}
          </span>
        </button>
      </div>
      <div className="tm-bootprofile-list">
        <div className="tm-bootprofile-row">
          <span className="tm-setting-desc">SHA-256</span>
          <code style={{ userSelect: "text", fontSize: 11 }}>{digest.bundled_sha256}</code>
        </div>
      </div>
    </div>
  );
}

/**
 * 诊断区：冷启动耗时分段。
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
          {total !== null ? tr("本次启动首帧用时 {n}ms", { n: Math.round(total) }) : tr("暂无启动数据")}
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
            {/* 复制↔已复制：key 重建 + 淡入（与 tm-setting-saved 同语言） */}
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
 * 诊断区：运行日志。
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
      .then((raw) => setText(raw.trim().length > 0 ? raw : tr("暂无日志记录")))
      .catch((err) => setText(tr("读取日志失败：{err}", { err: String(err) })))
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
  /* （rerender）：此前整店订阅——store 任何写入（滑杆每帧 setExtra、
     跨窗口同步 setState）都会重渲整个 GeneralPage。改 useShallow 只取用到的
     general 字段与 setter。 */
  const g = useSettingsStore(useShallow((s) => s.general));
  const setGeneral = useSettingsStore((s) => s.setGeneral);
  const setGeneralDebounced = useSettingsStore((s) => s.setGeneralDebounced);
  /* 本页还消费 extra 的低频字段（标量订阅）。 */
  const popupClickShield = useSettingsStore((s) => s.extra.popupClickShield);
  const hudGiveWay = useSettingsStore((s) => s.extra.hudGiveWay);
  const setExtra = useSettingsStore((s) => s.setExtra);
  const s = useMemo(
    () => ({ general: g, setGeneral, setGeneralDebounced, extra: { popupClickShield, hudGiveWay }, setExtra }),
    [g, setGeneral, setGeneralDebounced, popupClickShield, hudGiveWay, setExtra]
  );
  /* 番茄钟每日目标（方式 + 数值）：与番茄钟面板共享同一份配置。 */
  const tr = useT();

  /* 导入/导出反馈：成功淡入 / 失败 shake（复用 tm-setting-saved / error） */
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

  /* 重置中：reset_app_data 执行期间按钮 loading（与 #78 同语言） */
  const [resetting, setResetting] = useState(false);
  /* 本页几处就地报错（自启失败 / 黑名单超限）共用的安全定时器：卸载自动清理。 */
  const safeTimeout = useSafeTimeout();

  /* [WAKE-BL]黑名单草稿：受控输入（逗号分隔 → 数组落 store；
     恢复备份等外部变更不跟随，重开页面即对齐）。：提交（blur/回车）才
     落 store——此前每个按键都 setGeneral（整快照落盘 + 跨窗同步广播）。 */
  const [blacklistDraft, setBlacklistDraft] = useState(() =>
    useSettingsStore.getState().general.hotkeyBlacklist.join(", ")
  );
  /* 64 条上限会在 normalizeBlacklist 里静默截断——超限时就地提示，别让
     输入框里的条目无声消失。 */
  const [blWarn, setBlWarn] = useState<string | null>(null);
  const commitBlacklist = () => {
    const all = blacklistDraft
      /* 全角分号「；」与全角逗号「，」同为中文输入法常用分隔（漏掉时
         「d.exe；e.exe」会被当成单条，黑名单静默失效）。 */
      .split(/[,，;；]/)
      .map((x) => x.trim())
      .filter(Boolean);
    if (new Set(all.map((x) => x.toLowerCase())).size > 64) {
      setBlWarn(tr("最多保留 64 项，超出的部分已被忽略"));
      safeTimeout(() => setBlWarn(null), 2600);
    }
    /* 落库口径对齐：normalizeBlacklist 统一小写化——比对也用小写，否则含
       大写的草稿（"Game.EXE"）每次 blur / 卸载都判「值变了」重复整快照写。 */
    const list = all.map((x) => x.toLowerCase());
    const cur = useSettingsStore.getState().general.hotkeyBlacklist;
    if (list.join("\u0000") !== cur.join("\u0000")) s.setGeneral({ hotkeyBlacklist: list });
  };
  /* 卸载兜底：切页 / 关窗等不触发 blur 的路径会丢输入——卸载时补一次
     提交。ref 持最新提交闭包（内部再 getState 现值比对，值未变不写），避免
     effect 空依赖固化的旧草稿覆盖新输入。 */
  const commitBlacklistRef = useRef(commitBlacklist);
  commitBlacklistRef.current = commitBlacklist;
  useEffect(() => () => commitBlacklistRef.current(), []);

  // Sync the real system state (autostart / desktop icons) on mount and drive
  // the native commands when the user flips the corresponding toggles.
  /* 挂载与每次窗口 focus 都对账系统真值（用户在任务管理器 /
     注册表侧的外部改动此前要重开设置页才可见，诊断区面板早有 focus 刷新
     先例）。竞态守卫同款：快照取自本次对账开始时刻——慢 IPC 返回时 store
     已被用户动过（≠ 快照）则以用户为准。 */
  useEffect(() => {
    if (!isTauri()) return;
    const sync = () => {
      const launchAtStart = useSettingsStore.getState().general.launchOnStartup;
      invoke<boolean>("get_autostart")
        .then((enabled) => {
          if (useSettingsStore.getState().general.launchOnStartup === launchAtStart)
            s.setGeneral({ launchOnStartup: enabled });
        })
        .catch(() => {});
      const iconsAtStart = useSettingsStore.getState().general.showDesktopIcons;
      invoke<boolean>("get_desktop_icons")
        .then((shown) => {
          if (useSettingsStore.getState().general.showDesktopIcons === iconsAtStart)
            s.setGeneral({ showDesktopIcons: shown });
        })
        .catch(() => {});
    };
    sync();
    window.addEventListener("focus", sync);
    return () => window.removeEventListener("focus", sync);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* 协议对齐：开机自启此前 set_autostart 失败（组策略锁 Run 键等）被
     静默吞掉，UI 停在「开」。改为与桌面图标开关同一套——先乐观更新，再以
     回读到的真实注册表状态校正，失败/不一致时就地报错。 */
  const [autoErr, setAutoErr] = useState<string | null>(null);
  const setLaunch = async (v: boolean) => {
    s.setGeneral({ launchOnStartup: v });
    if (!isTauri()) return;
    let failed = false;
    try {
      await invoke("set_autostart", { enabled: v });
    } catch {
      failed = true;
    }
    const enabled = await invoke<boolean>("get_autostart").catch(() => (failed ? !v : v));
    s.setGeneral({ launchOnStartup: enabled });
    if (failed || enabled !== v) {
      setAutoErr(tr("开机启动设置失败"));
      safeTimeout(() => setAutoErr(null), 2600);
    }
  };
  /* 桌面图标开关失败提示：就地显示在开关行下方，2.6s 后自动消失。 */
  const [iconErr, setIconErr] = useState<string | null>(null);
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
          {/* 「跟随系统」档——按 OS locale 解析实际语言（英文系统装完
              不必再手动切 English）。 */}
          <Dropdown<"跟随系统" | "简体中文" | "English">
            value={g.language as "跟随系统" | "简体中文" | "English"}
            options={[
              { id: "跟随系统", label: "跟随系统" },
              { id: "简体中文", label: "简体中文" },
              { id: "English", label: "English" }
            ]}
            onChange={(v) => s.setGeneral({ language: v })}
          />
        </div>
        <SettingToggleRow title="开机启动" desc="登录时自动启动" on={g.launchOnStartup} onChange={setLaunch} />
        {autoErr && (
          <span className="tm-setting-error" role="status">
            {autoErr}
          </span>
        )}
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
            /* store 已落盘（重启由 Rust 读回生效），
               但运行期下发失败时本次会话的桌面双击钩子不会变——不再静默，
               补 toast 提示（不回滚 store：设置本身已保存，重启生效是对的）。 */
            if (isTauri())
              invoke("set_desktop_double_click", { enabled: v }).catch(() => {
                showToast(tr("已保存，但桌面双击开关本次会话未生效，重启后生效"), "error");
              });
          }}
        />
        <SettingToggleRow
          title="减少特效"
          desc="关闭小组件和菜单背后的毛玻璃模糊效果"
          on={g.reduceEffects}
          onChange={(v) => s.setGeneral({ reduceEffects: v })}
        />
        {/* [CLICK-SHIELD]/[HUD-GIVEWAY]：交互防误触
            两项均默认关闭——「替用户吞掉输入 / 改变悬停行为」只有明确需要的
            用户才应开启（用户裁定）。 */}
        <SettingToggleRow
          title="弹窗关闭后屏蔽误连点"
          desc="关闭弹窗 / 浮层后的瞬间屏蔽一次点击，防止连点穿透到下层（约 80 毫秒）"
          on={s.extra.popupClickShield}
          onChange={(v) => s.setExtra({ popupClickShield: v })}
        />
        <SettingToggleRow
          title="鼠标悬停时 HUD 淡出避让"
          desc="鼠标移到全屏展示窗上时将其淡化，不遮挡底下的内容（网速条已改为点击穿透，无需避让）"
          on={s.extra.hudGiveWay}
          onChange={(v) => s.setExtra({ hudGiveWay: v })}
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

      {/* [SUPER-PANEL]/[DOUBLE-TAP]/[WAKE-BL]：
          长按右键取词面板 / 双击修饰键呼出 / 唤醒热键黑名单。三项均默认关；
          Rust 侧经设置镜像消费，写路径落库后变更即醒（settings_mirror 的
          notify_changed 广播），改动即时生效。 */}
      <section className="tm-section">
        <div className="tm-section-title">
          <FxText text={tr("面板与唤起")} />
        </div>
        {/* （同型，单写者潜伏面）：切片写前现取最新基底，与 media 口径统一。 */}
        <SettingToggleRow
          title="超级面板"
          desc="选中文字后按住右键约半秒，在光标旁弹出快捷操作面板（取词靠模拟 Ctrl+C 实现：会临时覆盖剪贴板内容，取到的文字不入剪贴板历史）"
          on={g.superPanel.enabled}
          onChange={(v) =>
            s.setGeneral({ superPanel: { ...useSettingsStore.getState().general.superPanel, enabled: v } })
          }
        />
        {g.superPanel.enabled && (
          /* 长按时长从 4 档离散下拉改为 300–1000ms 连续滑杆（描述本就写
             的是区间）；双击滑杆恢复出厂 500ms。拖动走 setGeneralDebounced，
             防逐帧整快照落盘。 */
          <SettingRow title="长按时长" desc="按住右键多久触发面板（300–1000 毫秒）">
            <Slider
              label="长按时长"
              value={g.superPanel.durationMs}
              min={300}
              max={1000}
              step={50}
              suffix="ms"
              defaultValue={500}
              onChange={(v) =>
                s.setGeneralDebounced({
                  superPanel: { ...useSettingsStore.getState().general.superPanel, durationMs: v }
                })
              }
            />
          </SettingRow>
        )}
        <SettingToggleRow
          title="双击修饰键呼出面板"
          desc="快速按两次 Ctrl（或 Alt）呼出命令面板，与 Ctrl+Alt+K 等效"
          on={g.doubleTapSummon.enabled}
          onChange={(v) =>
            s.setGeneral({ doubleTapSummon: { ...useSettingsStore.getState().general.doubleTapSummon, enabled: v } })
          }
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
            onChange={(e) => setBlacklistDraft(e.target.value)}
            onBlur={commitBlacklist}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitBlacklist();
            }}
          />
        </div>
        {/* 提交落库此前零反馈——已生效条数常驻显示；超限截断就地告警。 */}
        {g.hotkeyBlacklist.length > 0 && (
          <span className="tm-setting-desc" role="status">
            {tr("已生效 {n} 项", { n: g.hotkeyBlacklist.length })}
          </span>
        )}
        {blWarn && (
          <span className="tm-setting-error" role="status">
            {blWarn}
          </span>
        )}
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

      {/* （可达性）：剪贴板隐私开关原先只挂在小组件实例的配置页里——画布上
          没有剪贴板小组件时，「关闭记录」这类隐私开关无处可关。常规页恢复一个
          常驻入口（与实例配置页共用同一组件与 store 状态，两处渲染不冲突）。 */}
      <section className="tm-section">
        <div className="tm-section-title">
          <FxText text={tr("剪贴板历史")} />
        </div>
        <ClipboardConfig />
      </section>

      <div className="tm-divider" />

      {/* （可达性，同剪贴板先例）：全局媒体行为（独占播放/专注暂停/隐藏
          播放源）此前唯一入口挂在「正在播放」实例配置页——画布上没有该小组件
          时这些全局行为（Rust watcher 持续执行）无处可关，设置搜索也搜不到。
          常规页恢复常驻入口（与实例配置页、卡片右键菜单三入口同源）。 */}
      <section className="tm-section">
        <div className="tm-section-title">
          <FxText text={tr("媒体行为")} />
        </div>
        <MediaBehaviorConfig />
      </section>

      <div className="tm-divider" />

      <section className="tm-section">
        <div className="tm-section-title">{tr("诊断")}</div>
        <CrashStatsPanel />
        <CrashLogPanel />
        <BootProfilePanel />
        <VelatapDigestPanel />
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
            <span className="tm-setting-desc">{tr("导出设置与布局（轻量）；完整备份请用「数据」区")}</span>
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
            <span className="tm-setting-desc">{tr("从 vela-settings.json 恢复；完整数据请用「数据」区的备份")}</span>
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
        {/* 结果反馈条 */}
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
  // 编组随布局同出（此前导出只有实例表，导入往返后编组全灭）；screens 携带
  // 全部屏幕分区（多显示器下其它屏的布局此前根本不进备份）。
  const screens = exportScreenLayoutSnapshots();
  /* 旧三字段（viewsList / views / groups）从 screens 快照派生——快照
     直读 localStorage（跨窗权威源），不受设置窗 widget-store 水合竞态影响
     （打开设置后立刻导出时，内存视图表可能还是默认值）。导入端优先采用
     screens，旧字段只为旧版本文件兼容保留。快照缺当前屏（视图表损坏整屏
     跳过的防御）时退回内存 store，保持旧行为。 */
  const curScreen = screens[currentScreenId()];
  const viewsList = curScreen?.views ?? ws.views;
  const layouts: Record<string, unknown> = {};
  const groupsByView: Record<string, unknown> = {};
  if (curScreen) {
    Object.assign(layouts, curScreen.layouts);
    Object.assign(groupsByView, curScreen.groups);
  } else {
    for (const v of ws.views) {
      layouts[v.id] = loadInstances(v.id);
      groupsByView[v.id] = loadGroups(v.id);
    }
  }
  // 保持旧字段形状：视图表里每个视图都有 layouts / groups 条目（缺布局 = 空数组）。
  for (const v of viewsList) {
    if (layouts[v.id] === undefined) layouts[v.id] = [];
    if (groupsByView[v.id] === undefined) groupsByView[v.id] = [];
  }
  const payload = {
    // 导出格式版本：v2 起与 snapshotFor 持久化口径对齐（v1 缺
    // customColors/floatingThemeMode/wallpaper 四件套——自定义配色等导入
    // 往返后静默丢失）。导入侧按字段有无兼容，不据此拒收旧文件。
    version: 2,
    preset: state.preset,
    themeMode: state.themeMode,
    primaryColor: state.primaryColor,
    customColors: state.customColors,
    floatingThemeMode: state.floatingThemeMode,
    wallpaperFolder: state.wallpaperFolder,
    recentWallpapers: state.recentWallpapers,
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
    viewsList,
    views: layouts,
    groups: groupsByView,
    screens
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  // 文件名带日期戳（与 DataPanel 的 vela-backup-<date>.json 同款）——
  // 固定名多次导出只能靠浏览器自动改名 (1) 区分，新旧难辨。
  a.download = `vela-settings-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

/** 导入设置：返回结果状态供调用方给出成功/失败反馈（cancel = 未选文件）。
 *  桌面端走 Rust 侧 import_settings_file（原生对话框 + 读取，路径不进
 *  WebView，与预设包导入同模式）；浏览器预览保留 <input> 兜底。 */
async function importSettings(): Promise<"ok" | "fail" | "cancel"> {
  if (isTauri()) {
    try {
      const text = await invoke<string | null>("import_settings_file");
      if (text === null || text === undefined) return "cancel";
      return applyImportedSettings(text);
    } catch {
      return "fail";
    }
  }
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
      reader.onload = () => resolve(applyImportedSettings(String(reader.result)));
      reader.onerror = () => resolve("fail");
      reader.readAsText(file);
    };
    input.click();
  });
}

/** 导入文本的应用入口（桌面对话框与浏览器 input 两条取文路径共用）。 */
function applyImportedSettings(raw: string): "ok" | "fail" {
  try {
    const data = JSON.parse(raw);
    // 至少含一个已知顶层字段才当设置文件处理——此前任意合法 JSON
    //（空对象 / vela-backup 完整备份 / 无关文件）也都报「导入成功」。
    const KNOWN_KEYS = [
      "version",
      "preset",
      "themeMode",
      "primaryColor",
      "customColors",
      "floatingThemeMode",
      "wallpaperFolder",
      "recentWallpapers",
      "zoom",
      "font",
      "fontSize",
      "widgetBackground",
      "widgetOpacity",
      "settingsWindowOpacity",
      "cornerRadius",
      "spacing",
      "blur",
      "general",
      "extra",
      "notifications",
      "shortcuts",
      "appShortcuts",
      "activeView",
      "viewsList",
      "views",
      "groups",
      "screens",
      "widgetLayout"
    ];
    if (
      typeof data !== "object" ||
      data === null ||
      Array.isArray(data) ||
      !KNOWN_KEYS.some((k) => data[k] !== undefined)
    ) {
      return "fail";
    }
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
    // v2 起随导出补齐的四件套（与 snapshotFor 持久化口径对齐）：setter
    // 自带清洗（颜色归一 / 枚举白名单 / 非空串过滤），坏值字段级回退。
    if (data.customColors !== undefined) st.setCustomColors(data.customColors);
    if (data.floatingThemeMode !== undefined) st.setFloatingThemeMode(data.floatingThemeMode);
    if (data.wallpaperFolder !== undefined) st.setWallpaperFolder(data.wallpaperFolder);
    if (Array.isArray(data.recentWallpapers)) {
      for (const p of data.recentWallpapers) {
        if (typeof p === "string" && p) st.pushRecentWallpaper(p);
      }
    }
    // Restore the view list if the file includes it（元素级过滤：id/name
    // 非字符串的坏条目不入库）。
    const viewsListRaw = data.viewsList as unknown[] | undefined;
    const viewsList = Array.isArray(viewsListRaw)
      ? viewsListRaw.filter(
          (v): v is { id: string; name: string } =>
            !!v &&
            typeof v === "object" &&
            typeof (v as Record<string, unknown>).id === "string" &&
            typeof (v as Record<string, unknown>).name === "string"
        )
      : [];
    // 新格式：screens 整屏快照（全部屏幕 + 编组）逐屏恢复；旧格式退回
    // 当前屏单表（文件无编组，按空组恢复——与文件内容一致）。两条路径
    // 都走 importScreenLayoutSnapshot：立即落盘绕开单槽防抖（此前多视图
    // 循环里只有最后一个视图真正落盘），编组随实例同进同出。
    const screens = data.screens as
      Record<string, { views?: unknown; layouts?: unknown; groups?: unknown }> | undefined;
    let restoredViews = false;
    if (screens && typeof screens === "object") {
      for (const [sid, snap] of Object.entries(screens)) {
        if (!/^\d+$/.test(sid)) continue;
        restoredViews = importScreenLayoutSnapshot(sid, snap) || restoredViews;
      }
    } else if (viewsList.length > 0 || data.views) {
      restoredViews = importScreenLayoutSnapshot(currentScreenId(), {
        views: viewsList.length > 0 ? viewsList : useWidgetStore.getState().views,
        layouts: data.views,
        groups: data.groups
      });
    }
    if (restoredViews) {
      // 落定活动视图：导入数据已在盘上，重载目标视图（含编组）到本窗内存。
      const candidate = (data.activeView as string) || "home";
      const wsNow = useWidgetStore.getState();
      const target = wsNow.views.some((v) => v.id === candidate) ? candidate : (wsNow.views[0]?.id ?? "home");
      if (target !== wsNow.activeView) wsNow.setActiveView(target);
    } else if (data.widgetLayout?.instances) {
      // Backwards-compatible path for older single-view exports.
      const ws = useWidgetStore.getState();
      ws.importLayout(JSON.stringify({ instances: data.widgetLayout.instances }));
    }
    if (restoredViews || data.widgetLayout?.instances) {
      // 绑定实例可能已随导入消失：磁贴对账降级（读防抖缓冲，不必先落盘）。
      reconcileDockTiles();
    }
    // 系统级开关的 Rust 副作用只挂在手动拨开关的路径上——导入后
    // store 与注册表/桌面实际状态脱节，下次打开常规页还会被挂载回读
    // 「纠正」回来（导入值静默失效）。落定后对账下发一次（两命令均幂等）。
    if (isTauri() && typeof data.general === "object" && data.general !== null) {
      const gi = data.general as { launchOnStartup?: unknown; showDesktopIcons?: unknown };
      if (typeof gi.launchOnStartup === "boolean") {
        void invoke("set_autostart", { enabled: gi.launchOnStartup }).catch(() => {});
      }
      if (typeof gi.showDesktopIcons === "boolean") {
        void invoke("set_desktop_icons", { show: gi.showDesktopIcons }).catch(() => {});
      }
    }
    return "ok";
  } catch {
    return "fail";
  }
}

/** 重置：返回是否真正执行（false = 用户在确认框取消）。 */
async function resetVela(): Promise<boolean> {
  if (
    !(await confirmDialog({
      title: t("重置应用"),
      message: t(
        "确定要重置 Vela 吗？此操作将清除所有视图、小组件、布局和设置。运行日志与崩溃记录会保留，用于问题诊断。"
      ),
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
    // OS 级副作用不随 DB/localStorage 清除而复位——注册表 Run 项与
    // 桌面图标隐藏状态会存留，且下次打开常规页会被挂载回读进 store，
    // 「恢复默认」对这两项不成立。重置时显式归零（await：随后整窗 reload
    // 会切断在飞 IPC）。
    const sysGeneral = useSettingsStore.getState().general;
    if (sysGeneral.launchOnStartup) {
      await invoke("set_autostart", { enabled: false }).catch(() => {});
    }
    if (!sysGeneral.showDesktopIcons) {
      await invoke("set_desktop_icons", { show: true }).catch(() => {});
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
