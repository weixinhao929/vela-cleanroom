/* eslint-disable react-refresh/only-export-components -- TaskbarConfigSync 与预览
   常量从本文件 re-export 供 App.tsx 懒加载与单测取用（拆分后保留兼容路径）。 */
/**
 * 设置页 · 任务栏（TB-UI）：任务栏外观能力的控制面（需求 ～/
 * ～的 UI 侧）。数据只读写 settings-store 的 general.taskbar
 * 切片（CORE 契约，字段名即线协议）；生效链路由 TaskbarConfigSync.tsx 承担
 * （仅设置窗挂载，App.tsx 懒加载）对账 get_taskbar_config → 不同才 apply_taskbar_config。
 *
 * 降级（INJECT / STATE 未合入期间）：命令返回 Err、无任何 taskbar:* 事件——状态条
 * 显示「模块未就绪」、徽标显示「—」、能力未知时按目标机（XAML）默认渲染；不做
 * 等待逻辑，事件到达自然点亮（能力不可用 → 隐藏而非报错）。
 *
 * 区段：HEADER（总开关 / 状态条 / 能力摘要 / 操作按钮）· STATES（七态卡 + 外观
 * 编辑器）· RULES（visible / maximized 规则列表）· IGNORED（忽略窗口三组标签）·
 * DIAG（诊断快照 + 共存说明）。PREVIEW 在 STATES 区段加预览按钮、MONITOR 在
 * HEADER 区段加显示器选择器。（深拆）后 STATES/RULES 的组件实现与预览通道
 * 分居 TaskbarStateCard / TaskbarRuleList / TaskbarAppearanceEditor /
 * TaskbarPreview，本文件保留页面编排、IGNORED（TagList）与 HEADER/DIAG。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { AppWindow, Ban, ClipboardCopy, Monitor, PanelBottom, RefreshCw, RotateCcw, Tag } from "lucide-react";
import { invoke, isTauri } from "../../../lib/tauri";
import { useTauriEvent } from "../../../lib/use-tauri-event";
import { showToast } from "../../../components/ToastHost";
import { t, useT } from "../../../i18n-lite";
import { FxText } from "../../../lib/fx";
import {
  TASKBAR_MAX_IGNORED_PER_KIND,
  TASKBAR_STATE_KEYS,
  defaultTaskbarSettings,
  taskbarOverriddenKeys,
  taskbarSlotKey,
  taskbarViewForSlot,
  useSettingsStore,
  type TaskbarAppearance,
  type TaskbarIgnoredWindows,
  type TaskbarOverrideKey,
  type TaskbarOverridePatch,
  type TaskbarRule,
  type TaskbarRules,
  type TaskbarSettings,
  type TaskbarStateAppearance,
  type TaskbarStateKey
} from "../../../store/settings-store";
import type { TaskbarCapabilities } from "../../../types/bindings/TaskbarCapabilities";
import type { TaskbarStateChanged } from "../../../types/bindings/TaskbarStateChanged";
import type { TaskbarStatus } from "../../../types/bindings/TaskbarStatus";
import type { MonitorInfo } from "./DisplayPage";
import { Dropdown, SettingRow, SettingToggleRow } from "../shared";
import { Ctl } from "./TaskbarAppearanceEditor";
import { RuleList } from "./TaskbarRuleList";
import { StateCard } from "./TaskbarStateCard";
import { useTaskbarPreview } from "./TaskbarPreview";

/* ══════════════════════════════ 共用：页面级文案表 ══════════════════════════════ */
/* （深拆）：STATE_META → TaskbarStateCard，ACCENT_OPTIONS / splitColor /
   joinColor / Ctl → TaskbarAppearanceEditor，MATCH_OPTIONS / newRuleId →
   TaskbarRuleList；此处只剩本页直用项。 */

const TASKBAR_TYPE_LABEL: Record<TaskbarStatus["taskbarType"], string> = {
  xaml: "XAML",
  mixed: "Mixed",
  classic: "Classic",
  unknown: "未知"
};

const RULE_STATES: readonly (keyof TaskbarRules)[] = ["visibleWindow", "maximizedWindow"];

/* ══════════════════════════════ IGNORED：标签式输入 ══════════════════════════════ */

function TagList({
  title,
  desc,
  icon,
  items,
  placeholder,
  onChange
}: {
  title: string;
  desc: string;
  icon: typeof Monitor;
  items: string[];
  placeholder: string;
  onChange: (next: string[]) => void;
}) {
  const tr = useT();
  const [draft, setDraft] = useState("");
  const full = items.length >= TASKBAR_MAX_IGNORED_PER_KIND;
  const add = () => {
    const v = draft.trim();
    if (!v || full) return;
    if (!items.includes(v)) onChange([...items, v]);
    setDraft("");
  };
  return (
    <div className="tm-tb-tags">
      <SettingRow icon={icon} title={title} desc={desc}>
        <div className="tm-tb-tags-input">
          <input
            className="tm-text-input"
            value={draft}
            placeholder={tr(placeholder)}
            aria-label={tr(title)}
            spellCheck={false}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                add();
              }
            }}
          />
          <button type="button" className="tm-btn-secondary" onClick={add} disabled={!draft.trim() || full}>
            {tr("添加")}
          </button>
        </div>
      </SettingRow>
      {items.length > 0 && (
        <div className="tm-city-chips">
          {items.map((v) => (
            <span className="tm-city-chip" key={v}>
              {v}
              <button
                type="button"
                className="tm-city-chip-x"
                onClick={() => onChange(items.filter((x) => x !== v))}
                aria-label={tr("删除{name}", { name: v })}
                title={tr("删除")}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

/* ══════════════════════════════ HEADER：状态条语义 ══════════════════════════════ */

type StatusTone = "na" | "off" | "busy" | "ok" | "warn" | "err";

/**
 * 状态条文案：无状态 = 模块未就绪；idle 且总开关已开 = 模块尚未响应
 * （空壳期 / 注入尚未开始）同样按「模块未就绪」提示；其余按注入状态机 phase。
 */
function describeStatus(
  status: TaskbarStatus | null,
  enabled: boolean
): { tone: StatusTone; label: string; hint: string | null } {
  if (!status) return { tone: "na", label: "模块未就绪", hint: null };
  switch (status.phase) {
    case "idle":
      return enabled
        ? { tone: "na", label: "模块未就绪", hint: t("已开启，等待任务栏模块响应") }
        : { tone: "off", label: "未启用", hint: null };
    case "injecting":
      return { tone: "busy", label: "正在注入", hint: null };
    case "ready":
      return { tone: "ok", label: "运行中", hint: null };
    case "degraded":
      return { tone: "warn", label: "降级", hint: status.reason ?? t("部分能力不可用，已按可用能力应用") };
    case "failed":
      return { tone: "err", label: "故障", hint: status.reason ?? t("请点击「重新应用」，仍失败则重启资源管理器") };
  }
}

/** 显示器选择器的「所有显示器统一」项（槽位键恒为十进制数字串，不会撞名）。 */
const UNIFIED_TARGET = "__unified__";

/** 覆盖字段 → 徽标文案（复用页面既有区段标题词）。 */
const OVERRIDE_KEY_LABEL: Record<TaskbarOverrideKey, string> = {
  enabled: "本屏开关",
  states: "动态外观",
  rules: "窗口规则",
  ignoredWindows: "忽略的窗口"
};

/* ══════════════════════════════ 页面 ══════════════════════════════ */

export function TaskbarPage({ monitors: monitorsProp }: { monitors?: MonitorInfo[] }) {
  const tr = useT();
  const stored = useSettingsStore((s) => s.general.taskbar);
  const setStored = useSettingsStore((s) => s.setTaskbar);
  const setStoredOverride = useSettingsStore((s) => s.setTaskbarOverride);

  /* ══ HEADER · MONITOR══ 显示器选择器：list_monitors 动态枚举。列表
     优先复用 SettingsView 经 props 下发的唯一数据源（含热插拔刷新，此前本页
     自建一套拉取 + 订阅——挂载与每次热插拔都是双份 IPC）；未提供（单测 /
     独立挂载）时退回自取 + 自订阅，行为与旧版一致。`editSlot === null` =
     「所有显示器统一」编辑基础配置；选中某屏后，下方 STATES / RULES / IGNORED 编辑的
     是该屏的浅合并视图，写入只落 monitorOverrides[slot]（enabled / perMonitor 等顶层
     开关仍写统一配置）。`taskbar` / `setTaskbar` 在此按编辑目标改道，下方区段无感。 */
  const [ownMonitors, setOwnMonitors] = useState<MonitorInfo[]>([]);
  const monitors = monitorsProp ?? ownMonitors;
  useEffect(() => {
    if (monitorsProp || !isTauri()) return;
    let disposed = false;
    invoke<MonitorInfo[]>("list_monitors")
      .then((list) => {
        if (!disposed) setOwnMonitors(Array.isArray(list) ? list : []);
      })
      .catch(() => {
        if (!disposed) setOwnMonitors([]);
      });
    return () => {
      disposed = true;
    };
  }, [monitorsProp]);
  useTauriEvent("monitors-changed", () => {
    if (monitorsProp || !isTauri()) return;
    invoke<MonitorInfo[]>("list_monitors")
      .then((list) => setOwnMonitors(Array.isArray(list) ? list : []))
      .catch(() => setOwnMonitors([]));
  });
  const [editSlot, setEditSlot] = useState<string | null>(null);
  const overrideSlots = useMemo(() => Object.keys(stored.monitorOverrides), [stored.monitorOverrides]);
  /* 选中的屏既不在线也没有覆盖（拔掉且从未覆盖 / 覆盖刚被删）→ 回统一，避免编辑幽灵屏。
     monitors 瞬时空（枚举失败/热插拔刷新窗口）时 some() 恒 false，
     会把「选中且尚无覆盖」的屏误弹回统一，后续编辑静默写进统一配置——与
     activeList 的空列表保护（monitors.length === 0 保留现状）同款守卫。 */
  useEffect(() => {
    if (editSlot === null || monitors.length === 0) return;
    const online = monitors.some((m) => taskbarSlotKey(m.id) === editSlot);
    if (!online && !overrideSlots.includes(editSlot)) setEditSlot(null);
  }, [editSlot, monitors, overrideSlots]);
  const taskbar = useMemo(
    () => (editSlot === null ? stored : taskbarViewForSlot(stored, editSlot)),
    [stored, editSlot]
  );
  const setTaskbar = (patch: Partial<TaskbarSettings>) => {
    if (editSlot === null) {
      setStored(patch);
      return;
    }
    const { states, rules, ignoredWindows, ...rest } = patch;
    const ov: TaskbarOverridePatch = {};
    if (states !== undefined) ov.states = states;
    if (rules !== undefined) ov.rules = rules;
    if (ignoredWindows !== undefined) ov.ignoredWindows = ignoredWindows;
    if (Object.keys(ov).length > 0) setStoredOverride(editSlot, ov);
    if (Object.keys(rest).length > 0) setStored(rest);
  };
  const targetOptions = useMemo(() => {
    const opts: { id: string; label: string }[] = [{ id: UNIFIED_TARGET, label: tr("所有显示器统一") }];
    for (const m of monitors) {
      opts.push({
        id: taskbarSlotKey(m.id),
        label: m.is_primary
          ? tr("{name} · #{n}（主显示器）", { name: m.name, n: m.id })
          : tr("{name} · #{n}", { name: m.name, n: m.id })
      });
    }
    /* 有覆盖但当前未连接的屏也列出（可查看 / 删除其覆盖，热插拔回来自动接上）。 */
    for (const slot of overrideSlots) {
      if (!opts.some((o) => o.id === slot)) opts.push({ id: slot, label: tr("显示器 #{n}（未连接）", { n: slot }) });
    }
    return opts;
  }, [monitors, overrideSlots, tr]);
  const overriddenKeys = editSlot === null ? [] : taskbarOverriddenKeys(stored, editSlot);
  const resetOverride = () => {
    if (editSlot === null) return;
    setStoredOverride(editSlot, null);
    showToast(tr("已删除此显示器的覆盖，恢复为统一配置"), "ok");
  };

  /* ══ HEADER ══ 运行状态：挂载回读一次（GeneralPage 同法），此后由 taskbar:status 驱动；
     能力同理挂载回读 get_taskbar_capabilities（事件只在启动/探测时 emit，晚开的设置窗
     拿不到），此后由 taskbar:capabilities 驱动。 */
  const [status, setStatus] = useState<TaskbarStatus | null>(null);
  const [caps, setCaps] = useState<TaskbarCapabilities | null>(null);
  const [activeByMonitor, setActiveByMonitor] = useState<Record<number, TaskbarStateChanged>>({});
  const [hasStateEvents, setHasStateEvents] = useState(false);
  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    invoke<TaskbarStatus>("get_taskbar_status")
      .then((s) => {
        if (!disposed && s) setStatus(s);
      })
      .catch(() => {});
    invoke<TaskbarCapabilities>("get_taskbar_capabilities")
      .then((c) => {
        if (!disposed && c) setCaps(c);
      })
      .catch(() => {});
    return () => {
      disposed = true;
    };
  }, []);
  useTauriEvent<TaskbarStatus>("taskbar:status", (p) => {
    if (p) setStatus(p);
  });
  useTauriEvent<TaskbarCapabilities>("taskbar:capabilities", (p) => {
    if (p) setCaps(p);
  });
  useTauriEvent<TaskbarStateChanged>("taskbar:state-changed", (p) => {
    if (!p) return;
    setHasStateEvents(true);
    setActiveByMonitor((prev) => ({ ...prev, [p.monitor]: p }));
  });
  /* activeByMonitor 只会被事件填充、不会自我收敛——总开关关闭后引擎
     静默（不再有 state-changed），拔掉的显示器也不再上报，「当前生效」徽标
     就此残留。开关关闭即清空；在线显示器列表变化时把离线槽位的旧事件滤掉
     （monitors 为空 = 枚举不可用，保留现状不做误删）。 */
  useEffect(() => {
    if (stored.enabled) return;
    setActiveByMonitor({});
    setHasStateEvents(false);
  }, [stored.enabled]);

  /* 升级残留闭环（`stale_dll_resident`）：横幅一键「重启资源管理器」+ 自动
     重启（每次应用会话至多自动一次，防风暴）。开关落 localStorage——重启
     explorer 是机器级行为，不进跨窗口同步的设置切片。 */
  const [restartingExplorer, setRestartingExplorer] = useState(false);
  const [autoRestartUpgrade, setAutoRestartUpgrade] = useState(
    () => localStorage.getItem("focus-desk.taskbar.autoRestartExplorer") !== "0"
  );
  /* 自动重启守卫持久化到 localStorage——原 ref 在设置窗销毁重建
     后复位，「每次应用会话至多一次」的承诺被打破（同一会话可自动重启 explorer
     两次，机器级行为的防风暴线不该随窗口生命周期重置）。 */
  const autoRestartDone = useRef(localStorage.getItem("focus-desk.taskbar.autoRestartDone") === "1");
  const restartExplorer = async () => {
    if (!isTauri() || restartingExplorer) return;
    setRestartingExplorer(true);
    try {
      await invoke("restart_explorer");
      showToast(tr("资源管理器已重启，任务栏升级完成"), "ok");
    } catch (err) {
      showToast(tr("重启资源管理器失败：{err}", { err: String(err) }), "error");
    } finally {
      setRestartingExplorer(false);
    }
  };
  useEffect(() => {
    if (!isTauri() || status?.code !== "stale_dll_resident") return;
    if (!autoRestartUpgrade || autoRestartDone.current || restartingExplorer) return;
    autoRestartDone.current = true;
    localStorage.setItem("focus-desk.taskbar.autoRestartDone", "1");
    invoke("restart_explorer")
      .then(() => showToast(tr("资源管理器已重启，任务栏升级完成"), "ok"))
      .catch((err: unknown) => showToast(tr("重启资源管理器失败：{err}", { err: String(err) }), "error"));
  }, [status, autoRestartUpgrade, restartingExplorer, tr]);
  const activeList = useMemo(
    () =>
      Object.values(activeByMonitor).filter((p) => monitors.length === 0 || monitors.some((m) => m.id === p.monitor)),
    [activeByMonitor, monitors]
  );
  const view = describeStatus(status, stored.enabled);

  const [reapplying, setReapplying] = useState(false);
  const reapply = async () => {
    if (!isTauri()) {
      showToast(tr("该操作仅在桌面端可用"), "info");
      return;
    }
    setReapplying(true);
    try {
      // 走 apply 全链路（重新注入 + 等就绪 + 下发）。reset_taskbar_state
      // 在故障态是空操作（非 Ready 直接返回），DLL 缺失 / 杀软拦截 / 握手超时后
      // 用户会被「请点击重新应用」的提示引向死胡同。
      const failed = await invoke<string[]>("apply_taskbar_config", { config: stored });
      if (failed.length > 0) {
        showToast(tr("任务栏配置部分未生效：{parts}", { parts: failed.join("、") }), "error");
      } else {
        showToast(tr("已重新应用任务栏外观"), "ok");
      }
    } catch (err) {
      showToast(tr("重新应用失败：{err}", { err: String(err) }), "error");
    } finally {
      setReapplying(false);
    }
  };
  const restoreDefaults = () => {
    // 整切片重置（含全部显示器覆盖）→ 编辑目标回统一。
    setStored(defaultTaskbarSettings());
    setEditSlot(null);
    showToast(tr("已恢复任务栏默认配置"), "ok");
  };

  /* ══ DIAG ══ 诊断快照：能力 + 状态机 + 当前生效 + **统一**配置（覆盖表只列槽位）
     + 当前编辑目标。 */
  const copyDiagnostics = async () => {
    const snapshot = {
      generatedAt: new Date().toISOString(),
      capabilities: caps,
      status,
      activeStates: activeList,
      editingSlot: editSlot,
      monitors: monitors.map((m) => ({ slot: m.id, name: m.name, primary: m.is_primary })),
      config: {
        enabled: stored.enabled,
        states: stored.states,
        rules: {
          visibleWindow: stored.rules.visibleWindow.map(
            ({ id, matchType, pattern, appearance, inactiveAppearance }) => ({
              id,
              matchType,
              pattern,
              appearance,
              inactive: inactiveAppearance ?? null
            })
          ),
          maximizedWindow: stored.rules.maximizedWindow.map(
            ({ id, matchType, pattern, appearance, inactiveAppearance }) => ({
              id,
              matchType,
              pattern,
              appearance,
              inactive: inactiveAppearance ?? null
            })
          )
        },
        ignoredWindows: stored.ignoredWindows,
        perMonitor: stored.perMonitor,
        monitorOverrideSlots: Object.keys(stored.monitorOverrides)
      }
    };
    try {
      await navigator.clipboard.writeText(JSON.stringify(snapshot, null, 2));
      showToast(tr("诊断信息已复制到剪贴板"), "ok");
    } catch {
      showToast(tr("复制失败，请检查剪贴板权限"), "error");
    }
  };

  /* 滑杆草稿的提交竞态：commit 闭包可能落后于拖动期间跨窗同步写入的
     变更，渲染快照 merge 会把它们整对象覆盖回去——现取 getState 最新切片
     （覆盖模式下先取编辑视图）再合并本次 patch 的字段。 */
  const editingTaskbar = () => {
    const cur = useSettingsStore.getState().general.taskbar;
    return editSlot === null ? cur : taskbarViewForSlot(cur, editSlot);
  };
  const setState = (key: TaskbarStateKey, patch: Partial<TaskbarStateAppearance>) => {
    const base = editingTaskbar();
    setTaskbar({ states: { ...base.states, [key]: { ...base.states[key], ...patch } } });
  };
  /* ══ STATES · PREVIEW══ 预览取当前编辑目标所见的外观；总开关看统一配置。 */
  const preview = useTaskbarPreview(taskbar.states, stored.enabled);
  const setRules = (key: keyof TaskbarRules, next: TaskbarRule[]) => {
    setTaskbar({ rules: { ...editingTaskbar().rules, [key]: next } });
  };
  /* 规则内外观 / 非前台外观的字段级提交（滑杆松手路径）：与 setRules 的整表
     替换不同，规则条目与外观都现取现 merge。 */
  const patchRuleAppearance = (
    key: keyof TaskbarRules,
    idx: number,
    field: "appearance" | "inactiveAppearance",
    p: Partial<TaskbarAppearance>
  ) => {
    const base = editingTaskbar();
    const next = base.rules[key].map((r, i) => {
      if (i !== idx) return r;
      const merged = { ...(field === "appearance" ? r.appearance : (r.inactiveAppearance ?? r.appearance)), ...p };
      return field === "appearance" ? { ...r, appearance: merged } : { ...r, inactiveAppearance: merged };
    });
    setTaskbar({ rules: { ...base.rules, [key]: next } });
  };
  const setIgnored = (key: keyof TaskbarIgnoredWindows, next: string[]) =>
    /* 与 setState/setRules/patchAppearance 同款提交纪律——渲染
       快照 taskbar 可能落后于拖动期间的跨窗同步写入，现取 getState 最新切片。 */
    setTaskbar({ ignoredWindows: { ...editingTaskbar().ignoredWindows, [key]: next } });

  const pathLabel = caps
    ? caps.path === "xaml"
      ? "XAML (TAP)"
      : caps.path === "swca"
        ? /* 路径 A 未实现：Mixed 机型后端无任何应用分支，标注「未启用」
           避免用户按支持假象配置后无效果（能力芯片描述的是规划可用集）。 */
          tr("SWCA（未启用）")
        : tr("此系统版本暂不支持")
    : "—";
  const capChips = caps
    ? ([
        [tr("模糊"), caps.supportsBlur],
        [tr("顶部分隔线"), caps.supportsLine],
        [tr("显示桌面按钮"), caps.supportsPeek],
        [tr("省电模式"), caps.supportsBatteryState]
      ] as const)
    : null;
  const showBattery = !caps || caps.supportsBatteryState;

  return (
    <>
      {/* ══ HEADER ══ */}
      <section className="tm-section">
        <div className="tm-section-title">
          <FxText text={tr("任务栏")} />
        </div>
        <SettingToggleRow
          icon={PanelBottom}
          title="自定义任务栏外观"
          desc="改变任务栏的透明 / 模糊 / 亚克力外观"
          on={stored.enabled}
          onChange={(v) => setStored({ enabled: v })}
        />
        <div className="tm-tb-status" data-tone={view.tone} role="status">
          <span className="tm-tb-status-dot" aria-hidden="true" />
          <span className="tm-tb-status-label">{tr(view.label)}</span>
          {view.hint && <span className="tm-tb-status-hint">{view.hint}</span>}
          {status?.code === "stale_dll_resident" && (
            <>
              <button
                type="button"
                className="tm-btn-secondary"
                onClick={() => void restartExplorer()}
                disabled={restartingExplorer}
              >
                {restartingExplorer ? tr("正在重启资源管理器…") : tr("重启资源管理器")}
              </button>
              <button
                type="button"
                className="tm-btn-secondary"
                aria-pressed={autoRestartUpgrade}
                title={tr("DLL 升级后自动重启资源管理器")}
                onClick={() => {
                  const next = !autoRestartUpgrade;
                  setAutoRestartUpgrade(next);
                  localStorage.setItem("focus-desk.taskbar.autoRestartExplorer", next ? "1" : "0");
                }}
              >
                {tr("升级后自动重启")}：{autoRestartUpgrade ? tr("开") : tr("关")}
              </button>
            </>
          )}
          <span className="tm-tb-status-meta">
            <span>
              {tr("任务栏类型")}：{status ? tr(TASKBAR_TYPE_LABEL[status.taskbarType]) : "—"}
            </span>
            <span>
              {tr("实现路径")}：{pathLabel}
            </span>
            {caps && caps.osBuild > 0 && <span>Build {caps.osBuild}</span>}
            {status && <span>{tr("协议 v{n}", { n: status.protocolVersion })}</span>}
          </span>
        </div>
        {capChips && (
          <div className="tm-tb-caps" aria-label={tr("能力摘要")}>
            {capChips.map(([label, ok]) => (
              <span key={label} className={`tm-tb-badge${ok ? " is-on" : ""}`}>
                {label} {ok ? "✓" : "✗"}
              </span>
            ))}
          </div>
        )}
        <div className="tm-tb-actions">
          <button type="button" className="tm-btn-secondary" onClick={() => void reapply()} disabled={reapplying}>
            {reapplying ? <span className="tm-spinner" /> : <RefreshCw size={14} />}
            {tr("重新应用")}
          </button>
          <button type="button" className="tm-btn-secondary" onClick={restoreDefaults}>
            <RotateCcw size={14} />
            {tr("恢复默认")}
          </button>
          <button type="button" className="tm-btn-secondary" onClick={() => void copyDiagnostics()}>
            <ClipboardCopy size={14} />
            {tr("复制诊断信息")}
          </button>
        </div>

        {/* ══ HEADER · MONITOR══ 显示器选择器：统一 / 逐屏覆盖入口 */}
        <SettingToggleRow
          icon={Monitor}
          title="逐显示器独立配置"
          desc="各显示器可分别覆盖下方配置"
          on={stored.perMonitor}
          onChange={(v) => setStored({ perMonitor: v })}
        />
        <SettingRow
          icon={Monitor}
          title="正在编辑"
          desc="选中显示器后，修改只写入该屏覆盖"
          highlighted={editSlot !== null}
        >
          <Ctl label={tr("正在编辑")}>
            <Dropdown
              value={editSlot ?? UNIFIED_TARGET}
              options={targetOptions}
              onChange={(v) => setEditSlot(v === UNIFIED_TARGET ? null : v)}
            />
          </Ctl>
        </SettingRow>
        {editSlot !== null && (
          <div className="tm-tb-caps" role="status" aria-label={tr("覆盖状态")} data-testid="tb-override-status">
            {overriddenKeys.length > 0 ? (
              <>
                <span className="tm-tb-badge is-on">{tr("已覆盖")}</span>
                {overriddenKeys.map((k) => (
                  <span key={k} className="tm-tb-badge">
                    {tr(OVERRIDE_KEY_LABEL[k])}
                  </span>
                ))}
                <button type="button" className="tm-btn-secondary" onClick={resetOverride}>
                  <RotateCcw size={14} />
                  {tr("恢复为统一配置")}
                </button>
                {/* 覆盖粒度是「整组快照」——在此屏改一个字段会把
                    当时整套状态/规则写入覆盖，统一配置的后续调整对该屏不再生效。
                    刻意的设计（Rust effective_for_slot 同语义），但原先无任何提示，
                    用户会以为未改的字段仍跟随统一配置。 */}
                <span className="tm-tb-status-hint">
                  {tr("覆盖按创建时的整组快照保存：未单独修改的状态也冻结在当时的值，统一配置的后续调整不影响此屏")}
                </span>
              </>
            ) : (
              <span className="tm-tb-badge">{tr("尚未覆盖：修改下方任一项即为此显示器创建覆盖")}</span>
            )}
            {!stored.perMonitor && (
              <span className="tm-tb-status-hint">
                {tr("逐显示器独立配置已关闭：覆盖内容保留但不生效，所有显示器使用统一配置")}
              </span>
            )}
          </div>
        )}
      </section>

      <div className="tm-divider" />

      {/* ══ STATES ══ */}
      <section className="tm-section">
        <div className="tm-section-title">{tr("动态外观")}</div>
        <div className="tm-tb-hint">{tr("按桌面状态自动切换外观，越靠下优先级越高。")}</div>
        {TASKBAR_STATE_KEYS.map((key) => {
          if (key === "batterySaver" && !showBattery) return null;
          const ruled = (RULE_STATES as readonly string[]).includes(key) ? (key as keyof TaskbarRules) : null;
          return (
            <StateCard
              key={key}
              stateKey={key}
              state={taskbar.states[key]}
              onChange={(patch) => setState(key, patch)}
              caps={caps}
              active={activeList.filter((p) => p.activeState === key)}
              hasStateEvents={hasStateEvents}
              preview={preview}
            >
              {/* ══ RULES ══ */}
              {ruled && (
                <RuleList
                  rules={taskbar.rules[ruled]}
                  onChange={(next) => setRules(ruled, next)}
                  patchAppearance={(idx, field, p) => patchRuleAppearance(ruled, idx, field, p)}
                  caps={caps}
                  owningState={ruled}
                  preview={preview}
                />
              )}
            </StateCard>
          );
        })}
      </section>

      <div className="tm-divider" />

      {/* ══ IGNORED ══ */}
      <section className="tm-section">
        <div className="tm-section-title">{tr("忽略的窗口")}</div>
        <div className="tm-tb-hint">{tr("命中任一项的窗口不参与动态外观判定。")}</div>
        <TagList
          icon={Tag}
          title="窗口类"
          desc="精确匹配窗口类名"
          placeholder="如 Tauri Window"
          items={taskbar.ignoredWindows.classes}
          onChange={(next) => setIgnored("classes", next)}
        />
        <TagList
          icon={AppWindow}
          title="窗口标题"
          desc="标题包含该子串即命中"
          placeholder="如 任务管理器"
          items={taskbar.ignoredWindows.titles}
          onChange={(next) => setIgnored("titles", next)}
        />
        <TagList
          icon={Ban}
          title="进程名"
          desc="进程文件名，大小写不敏感精确匹配"
          placeholder="如 Vela.exe"
          items={taskbar.ignoredWindows.processes}
          onChange={(next) => setIgnored("processes", next)}
        />
      </section>

      {/* ══ DIAG ══ 共存说明 */}
      <div className="tm-tb-note">
        {tr(
          "与桌面小组件共存：任务栏区域始终位于桌面层之上。任务栏透明后，放在任务栏区域内的小组件会被任务栏叠压，属预期行为；灵动岛的避让不受影响。"
        )}
      </div>
    </>
  );
}

/* ══════════════════════════════ 生效链路与预览通道：re-export 兼容路径 ══════════════════════════════ */

/* （深拆）：生效链路在 TaskbarConfigSync.tsx、预览通道在 TaskbarPreview.ts，
   此处 re-export 保持既有导入路径（App.tsx 懒加载与单测均从本文件取）。 */
export { TASKBAR_APPLY_DEBOUNCE_MS, TaskbarConfigSync, taskbarConfigEquals } from "./TaskbarConfigSync";
export { TASKBAR_PREVIEW_HOLD_MS, TASKBAR_PREVIEW_SETTLE_GRACE_MS } from "./TaskbarPreview";
