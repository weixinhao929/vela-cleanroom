/**
 * 设置页 · 任务栏（TB-UI）：任务栏外观能力的控制面（需求 F-1～F-5 /
 * F-7 / F-10 / F-12～F-15 的 UI 侧）。数据只读写 settings-store 的 general.taskbar
 * 切片（CORE 契约，字段名即线协议）；生效链路由本文件导出的 TaskbarConfigSync
 * （仅设置窗挂载，App.tsx 懒加载）对账 get_taskbar_config → 不同才 apply_taskbar_config。
 *
 * 降级（INJECT / STATE 未合入期间）：命令返回 Err、无任何 taskbar:* 事件——状态条
 * 显示「模块未就绪」、徽标显示「—」、能力未知时按目标机（XAML）默认渲染；不做
 * 等待逻辑，事件到达自然点亮（D7：能力不可用 → 隐藏而非报错）。
 *
 * 区段：HEADER（总开关 / 状态条 / 能力摘要 / 操作按钮）· STATES（七态卡 + 外观
 * 编辑器）· RULES（visible / maximized 规则列表）· IGNORED（忽略窗口三组标签）·
 * DIAG（诊断快照 + 共存说明）。PREVIEW 在 STATES 区段加预览按钮、MONITOR 在
 * HEADER 区段加显示器选择器。
 */
import { useEffect, useMemo, useRef, useState, type MutableRefObject, type ReactNode } from "react";
import {
  AppWindow,
  ArrowDown,
  ArrowUp,
  Ban,
  BatteryLow,
  ClipboardCopy,
  Droplets,
  Eye,
  EyeOff,
  Layers,
  LayoutGrid,
  Maximize2,
  Minus,
  Monitor,
  Palette,
  PanelBottom,
  Plus,
  RefreshCw,
  RotateCcw,
  Ruler,
  Search,
  SlidersHorizontal,
  Tag,
  Trash2
} from "lucide-react";
import { invoke, isTauri, previewTaskbarState } from "../../../lib/tauri";
import { useTauriEvent } from "../../../lib/use-tauri-event";
import { showToast } from "../../../components/ToastHost";
import { t, useT } from "../../../i18n-lite";
import { FxText } from "../../../lib/fx";
import {
  DEFAULT_TASKBAR_APPEARANCE,
  TASKBAR_MAX_IGNORED_PER_KIND,
  TASKBAR_MAX_RULES_PER_STATE,
  TASKBAR_STATE_KEYS,
  defaultTaskbarSettings,
  normalizeTaskbar,
  normalizeTaskbarColor,
  taskbarOverriddenKeys,
  taskbarSlotKey,
  taskbarViewForSlot,
  useSettingsStore,
  type TaskbarAccent,
  type TaskbarAppearance,
  type TaskbarIgnoredWindows,
  type TaskbarMatchType,
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
import { ColorRow, Dropdown, Segmented, SettingRow, SettingToggleRow, Toggle } from "../shared";
import { M3Slider as Slider } from "../../../components/ui/M3Slider";

/* ══════════════════════════════ 共用：文案表与颜色归一 ══════════════════════════════ */

/** 七态元信息（顺序 = TASKBAR_STATE_KEYS：桌面在上、省电在下；越靠下优先级越高，F-3）。 */
const STATE_META: Record<TaskbarStateKey, { name: string; desc: string; icon: typeof Monitor }> = {
  desktop: { name: "桌面", desc: "桌面可见、没有用户窗口时的基础外观（始终启用）", icon: Monitor },
  visibleWindow: { name: "可见窗口", desc: "存在非最大化的用户窗口时（可按前台窗口配置规则）", icon: AppWindow },
  maximizedWindow: { name: "最大化窗口", desc: "存在最大化窗口时（按最顶层最大化窗口匹配规则）", icon: Maximize2 },
  startOpened: { name: "开始菜单打开", desc: "开始菜单打开时（只影响所在显示器）", icon: LayoutGrid },
  searchOpened: { name: "搜索打开", desc: "搜索面板打开时（只影响所在显示器）", icon: Search },
  taskViewOpened: { name: "任务视图打开", desc: "任务视图打开时（影响全部显示器）", icon: Layers },
  batterySaver: { name: "省电模式", desc: "系统进入省电模式时（影响全部显示器）", icon: BatteryLow }
};

/** accent 五值文案（§1.1 表；normal = 恢复系统默认外观）。 */
const ACCENT_OPTIONS: { id: TaskbarAccent; label: string }[] = [
  { id: "normal", label: "默认" },
  { id: "opaque", label: "不透明" },
  { id: "clear", label: "透明" },
  { id: "blur", label: "模糊" },
  { id: "acrylic", label: "亚克力" }
];

const MATCH_OPTIONS: { id: TaskbarMatchType; label: string }[] = [
  { id: "class", label: "窗口类" },
  { id: "title", label: "窗口标题" },
  { id: "process", label: "进程名" }
];

const TASKBAR_TYPE_LABEL: Record<TaskbarStatus["taskbarType"], string> = {
  xaml: "XAML",
  mixed: "Mixed",
  classic: "Classic",
  unknown: "未知"
};

const RULE_STATES: readonly (keyof TaskbarRules)[] = ["visibleWindow", "maximizedWindow"];

/** 切片存 `#rrggbbaa`；原生取色器只认 `#rrggbb`，透明度单独走 0–100% 滑条。 */
function splitColor(color: string): { rgb: string; alphaPct: number } {
  const full = normalizeTaskbarColor(color) ?? DEFAULT_TASKBAR_APPEARANCE.color;
  return { rgb: full.slice(0, 7), alphaPct: Math.round((parseInt(full.slice(7, 9), 16) / 255) * 100) };
}

/** 取色器 / 手输的 3、4、6、8 位 hex + 透明度百分比 → 统一 8 位小写存储（F-2）。 */
function joinColor(rgb: string, alphaPct: number): string {
  const base = normalizeTaskbarColor(rgb) ?? DEFAULT_TASKBAR_APPEARANCE.color;
  const alpha = Math.round((Math.max(0, Math.min(100, alphaPct)) / 100) * 255);
  return `${base.slice(0, 7)}${alpha.toString(16).padStart(2, "0")}`;
}

function newRuleId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `rule-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** 分段 / 下拉自身无 aria-label，用行标题命名（与 DockPage.Ctl 同法）。 */
function Ctl({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="tm-dock-ctl" role="group" aria-label={label}>
      {children}
    </div>
  );
}

/* ══════════════════════════════ STATES：外观编辑器 ══════════════════════════════ */

/**
 * 单套外观（F-2 / F-7）：accent 五选一 → 颜色 + 透明度 → 模糊半径（仅 blur）→ 顶线 /
 * Peek 开关。能力未知（尚无 taskbar:capabilities）时按目标机 XAML 渲染：顶线可用、
 * Peek 隐藏、blur 可选；能力已知则按 D7 隐藏不可用项。
 *
 * F-8 即时预览：每次改动除写切片（350ms 防抖后整包 apply 落盘）外，还经 `onPreview`
 * 走预览通道立即下发——滑条拖动中 React 的 onChange 即原生 input 事件、逐帧触发，
 * Rust 侧按 ≤80ms 步进合并；状态卡与规则行（含非前台外观，T-15）都接线，
 * 独立复用本编辑器且未传 `onPreview` 的调用点则只写切片。
 */
function AppearanceEditor({
  value,
  onChange,
  onPreview,
  caps,
  defaultColor = DEFAULT_TASKBAR_APPEARANCE.color
}: {
  value: TaskbarAppearance;
  onChange: (next: TaskbarAppearance) => void;
  onPreview?: (next: TaskbarAppearance) => void;
  caps: TaskbarCapabilities | null;
  defaultColor?: string;
}) {
  const tr = useT();
  const { rgb, alphaPct } = splitColor(value.color);
  const patch = (p: Partial<TaskbarAppearance>) => {
    const next = { ...value, ...p };
    onPreview?.(next);
    onChange(next);
  };
  const accentOptions = ACCENT_OPTIONS.filter(
    (o) => o.id !== "blur" || !caps || caps.supportsBlur || value.accent === "blur"
  );
  const showLine = !caps || caps.supportsLine;
  const showPeek = Boolean(caps?.supportsPeek);
  return (
    <>
      <SettingRow icon={Palette} title="效果" desc="默认 / 不透明 / 透明 / 模糊 / 亚克力">
        <Ctl label={tr("效果")}>
          <Segmented value={value.accent} options={accentOptions} onChange={(accent) => patch({ accent })} />
        </Ctl>
      </SettingRow>
      <SettingRow icon={Droplets} title="颜色" desc="任务栏着色">
        <ColorRow
          color={rgb}
          onChange={(c) => patch({ color: joinColor(c, alphaPct) })}
          onReset={() => patch({ color: defaultColor })}
        />
      </SettingRow>
      <SettingRow icon={SlidersHorizontal} title="透明度" desc="0% 透明 · 100% 不透明">
        <Slider
          label="透明度"
          value={alphaPct}
          min={0}
          max={100}
          step={1}
          suffix="%"
          onChange={(v) => patch({ color: joinColor(rgb, v) })}
        />
      </SettingRow>
      {value.accent === "blur" && (
        <SettingRow icon={Ruler} title="模糊半径" desc="越大越朦胧">
          <Slider
            label="模糊半径"
            value={value.blurRadius}
            min={0}
            max={750}
            step={1}
            suffix="px"
            onChange={(v) => patch({ blurRadius: Math.round(v) })}
          />
        </SettingRow>
      )}
      {showLine && (
        <SettingRow icon={Minus} title="顶部分隔线" desc="顶部 1px 分隔线">
          <Toggle on={value.showLine} onChange={(v) => patch({ showLine: v })} ariaLabel={tr("顶部分隔线")} />
        </SettingRow>
      )}
      {showPeek && (
        <SettingRow icon={Eye} title="显示桌面按钮" desc="任务栏右端的「显示桌面」Peek 按钮">
          <Toggle on={value.showPeek} onChange={(v) => patch({ showPeek: v })} ariaLabel={tr("显示桌面按钮")} />
        </SettingRow>
      )}
    </>
  );
}

/* ══════════════════════════════ RULES：窗口规则列表 ══════════════════════════════ */

/**
 * 可见 / 最大化两态的逐窗口规则（F-4）：匹配类型 + 匹配值 + 完整外观 + 可选的
 * 非前台外观；增删改排序。匹配语义（class 精确 / process 大小写不敏感精确 /
 * title 子串）在 Rust 状态机实现，此处只编辑数据。
 */
function RuleList({
  rules,
  onChange,
  caps,
  owningState,
  preview
}: {
  rules: TaskbarRule[];
  onChange: (next: TaskbarRule[]) => void;
  caps: TaskbarCapabilities | null;
  /** 规则所属状态键（visible / maximized，同为 TaskbarStateKey 成员）。 */
  owningState: keyof TaskbarRules;
  /** F-8 预览控制面：规则内外观与非前台外观的编辑同样即时预览（T-15）。 */
  preview?: TaskbarPreviewHandle;
}) {
  const tr = useT();
  const update = (idx: number, next: TaskbarRule) => onChange(rules.map((r, i) => (i === idx ? next : r)));
  const move = (idx: number, dir: -1 | 1) => {
    const to = idx + dir;
    if (to < 0 || to >= rules.length) return;
    const next = [...rules];
    [next[idx], next[to]] = [next[to], next[idx]];
    onChange(next);
  };
  const add = () => {
    if (rules.length >= TASKBAR_MAX_RULES_PER_STATE) return;
    onChange([
      ...rules,
      { id: newRuleId(), matchType: "process", pattern: "", appearance: { ...DEFAULT_TASKBAR_APPEARANCE } }
    ]);
  };
  return (
    <div className="tm-tb-sub">
      <div className="tm-tb-sub-title">{tr("窗口规则")}</div>
      {rules.length === 0 && (
        <div className="tm-tb-empty">{tr("暂无规则：命中规则的窗口使用其专属外观，其余使用上方默认外观")}</div>
      )}
      <div className="tm-tb-rules">
        {rules.map((rule, idx) => (
          <div className="tm-tb-rule" key={rule.id} role="group" aria-label={`${tr("规则")} ${idx + 1}`}>
            <div className="tm-tb-rule-head">
              <Ctl label={tr("匹配类型")}>
                <Dropdown
                  value={rule.matchType}
                  options={MATCH_OPTIONS}
                  onChange={(matchType) => update(idx, { ...rule, matchType })}
                />
              </Ctl>
              <input
                className="tm-text-input"
                value={rule.pattern}
                placeholder={tr("匹配值（类名精确 / 进程名如 notepad.exe / 标题子串）")}
                aria-label={tr("匹配值")}
                spellCheck={false}
                onChange={(e) => update(idx, { ...rule, pattern: e.target.value })}
              />
              <div className="tm-tb-rule-actions">
                <button
                  type="button"
                  className="tm-tb-icon-btn"
                  onClick={() => move(idx, -1)}
                  disabled={idx === 0}
                  aria-label={tr("上移")}
                  title={tr("上移")}
                >
                  <ArrowUp size={14} />
                </button>
                <button
                  type="button"
                  className="tm-tb-icon-btn"
                  onClick={() => move(idx, 1)}
                  disabled={idx === rules.length - 1}
                  aria-label={tr("下移")}
                  title={tr("下移")}
                >
                  <ArrowDown size={14} />
                </button>
                <button
                  type="button"
                  className="tm-tb-icon-btn danger"
                  onClick={() => onChange(rules.filter((_, i) => i !== idx))}
                  aria-label={tr("删除规则")}
                  title={tr("删除规则")}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            </div>
            <AppearanceEditor
              value={rule.appearance}
              onChange={(appearance) => update(idx, { ...rule, appearance })}
              onPreview={preview ? (appearance) => preview.onEdit(owningState, appearance) : undefined}
              caps={caps}
            />
            <SettingRow icon={AppWindow} title="非前台时使用不同外观" desc="命中窗口失去焦点时切换到下方外观">
              <Toggle
                on={rule.inactiveAppearance !== undefined}
                ariaLabel={tr("非前台时使用不同外观")}
                onChange={(on) => {
                  const next: TaskbarRule = { ...rule };
                  if (on) next.inactiveAppearance = { ...rule.appearance };
                  else delete next.inactiveAppearance;
                  update(idx, next);
                }}
              />
            </SettingRow>
            {rule.inactiveAppearance && (
              <div className="tm-tb-sub" role="group" aria-label={tr("非前台外观")}>
                <div className="tm-tb-sub-title">{tr("非前台外观")}</div>
                <AppearanceEditor
                  value={rule.inactiveAppearance}
                  onChange={(inactiveAppearance) => update(idx, { ...rule, inactiveAppearance })}
                  onPreview={
                    preview ? (inactiveAppearance) => preview.onEdit(owningState, inactiveAppearance) : undefined
                  }
                  caps={caps}
                />
              </div>
            )}
          </div>
        ))}
      </div>
      <button
        type="button"
        className="tm-btn-secondary tm-tb-add"
        onClick={add}
        disabled={rules.length >= TASKBAR_MAX_RULES_PER_STATE}
      >
        <Plus size={14} />
        {tr("添加规则")}
      </button>
    </div>
  );
}

/* ══════════════════════════════ STATES：实时预览通道（F-8，TB-PREVIEW） ══════════════════════════════ */

/** 「预览此状态」钉住时长：与 Rust `PREVIEW_HOLD`（60s）同值，到点两侧各自收尾（重复取消是 no-op）。 */
export const TASKBAR_PREVIEW_HOLD_MS = 60_000;
/** 拖动落定后再留的余量：让 350ms 防抖的真实 apply 先落地，随后才「切回钉住的状态卡 /
 *  取消拖动预览」——否则先到的切回会被紧随的真实 apply 结束，钉住效果闪一下就没了。 */
export const TASKBAR_PREVIEW_SETTLE_GRACE_MS = 120;

/** 状态卡的预览控制面（StateCard 消费）。 */
type TaskbarPreviewHandle = {
  /** 当前被钉住预览的状态键（null = 无）。 */
  pinned: TaskbarStateKey | null;
  /** 总开关关闭时按钮禁用、拖动不发 IPC（Rust 侧未就绪，预览必失败）。 */
  disabled: boolean;
  /** 钉住 / 解除（再按同卡 = 解除，按他卡 = 直接切换，不经过取消以免闪回真实外观）。 */
  toggle: (key: TaskbarStateKey) => void;
  /** 外观编辑器的一次改动：立即预览；静默落定后回到钉住的卡或取消拖动预览。 */
  onEdit: (key: TaskbarStateKey, next: TaskbarAppearance) => void;
};

/** 切片单态 → 纯外观（去掉 `enabled`，预览载荷只认五个外观字段）。 */
function appearanceOf(state: TaskbarStateAppearance): TaskbarAppearance {
  const { accent, color, showPeek, showLine, blurRadius } = state;
  return { accent, color, showPeek, showLine, blurRadius };
}

function clearTimer(ref: MutableRefObject<number | null>) {
  if (ref.current !== null) {
    window.clearTimeout(ref.current);
    ref.current = null;
  }
}

/**
 * F-8 预览通道（两条即时链路共用一个 Rust 命令，见 lib/tauri.ts previewTaskbarState）：
 * - 拖动：编辑器每次改动立即 `preview(state, 整套外观)`；最后一次改动后静默
 *   350ms + 余量视为松手——有钉住的卡就切回它，否则 `preview(null)` 取消。真实
 *   落定由 TaskbarConfigSync 的 350ms 对账 apply 负责（Rust 端 apply 即结束预览）。
 * - 钉住：按钮 `preview(state, 该状态外观)` 强制生效；再按 / 60s / 离开页面 / 总开关
 *   关闭 → 解除。Rust 侧同样 60s 自动取消，两侧独立计时、重复取消无副作用。
 * 预览 IPC 是 best-effort：拖动中的失败静默；按钮触发的失败 toast 并回退钉住态。
 * 全程不写切片、不 invoke set_setting / apply_taskbar_config。
 */
function useTaskbarPreview(
  states: Record<TaskbarStateKey, TaskbarStateAppearance>,
  moduleEnabled: boolean
): TaskbarPreviewHandle {
  const tr = useT();
  const [pinned, setPinnedState] = useState<TaskbarStateKey | null>(null);
  const pinnedRef = useRef<TaskbarStateKey | null>(null);
  const statesRef = useRef(states);
  statesRef.current = states;
  const settleTimer = useRef<number | null>(null);
  const holdTimer = useRef<number | null>(null);
  /** Rust 侧可能仍有预览在生效（决定卸载 / 解除时是否要发取消）。 */
  const liveRef = useRef(false);

  const setPinned = (key: TaskbarStateKey | null) => {
    pinnedRef.current = key;
    setPinnedState(key);
  };
  const send = (key: TaskbarStateKey | null, overrides?: Partial<TaskbarAppearance>) => {
    liveRef.current = key !== null;
    return previewTaskbarState(key, overrides);
  };
  const unpin = (notifyRust: boolean) => {
    clearTimer(holdTimer);
    setPinned(null);
    if (notifyRust && liveRef.current) void send(null).catch(() => {});
  };

  const toggle = (key: TaskbarStateKey) => {
    if (!isTauri()) {
      showToast(tr("该操作仅在桌面端可用"), "info");
      return;
    }
    if (pinnedRef.current === key) {
      unpin(true);
      return;
    }
    // 拖动落定的回滚不再执行（目标已换）；60s 计时从本次钉住重新起算。
    clearTimer(settleTimer);
    clearTimer(holdTimer);
    setPinned(key);
    holdTimer.current = window.setTimeout(() => {
      holdTimer.current = null;
      unpin(true);
    }, TASKBAR_PREVIEW_HOLD_MS);
    send(key, appearanceOf(statesRef.current[key])).catch((err: unknown) => {
      showToast(`${tr("预览失败")}：${String(err)}`, "error");
      if (pinnedRef.current === key) unpin(false);
    });
  };

  const onEdit = (key: TaskbarStateKey, next: TaskbarAppearance) => {
    if (!isTauri() || !moduleEnabled) return;
    // 编辑器的 value 运行时是切片单态（可选态带 enabled），载荷只留五个外观字段。
    void send(key, appearanceOf(next)).catch(() => {});
    clearTimer(settleTimer);
    settleTimer.current = window.setTimeout(() => {
      settleTimer.current = null;
      const p = pinnedRef.current;
      if (p !== null) void send(p, appearanceOf(statesRef.current[p])).catch(() => {});
      else void send(null).catch(() => {});
    }, TASKBAR_APPLY_DEBOUNCE_MS + TASKBAR_PREVIEW_SETTLE_GRACE_MS);
  };

  // 总开关关闭：Rust 侧 apply(enabled=false) 已结束预览并恢复系统默认，本地只收钉住态。
  useEffect(() => {
    if (moduleEnabled || pinnedRef.current === null) return;
    clearTimer(holdTimer);
    pinnedRef.current = null;
    setPinnedState(null);
  }, [moduleEnabled]);

  // 离开页面：取消一切预览（F-8「离开页面自动取消」）并清定时器。
  useEffect(
    () => () => {
      clearTimer(settleTimer);
      clearTimer(holdTimer);
      if (liveRef.current && isTauri()) void previewTaskbarState(null).catch(() => {});
    },
    []
  );

  return { pinned, disabled: !moduleEnabled, toggle, onEdit };
}

/* ══════════════════════════════ STATES：状态卡 ══════════════════════════════ */

function StateCard({
  stateKey,
  state,
  onChange,
  caps,
  active,
  hasStateEvents,
  preview,
  children
}: {
  stateKey: TaskbarStateKey;
  state: TaskbarStateAppearance;
  onChange: (next: TaskbarStateAppearance) => void;
  caps: TaskbarCapabilities | null;
  /** 命中本态的显示器事件（可多屏）。 */
  active: TaskbarStateChanged[];
  /** 是否收过任何 state-changed 事件（无 → 徽标显「—」，F-14）。 */
  hasStateEvents: boolean;
  /** F-8 预览控制面（缺省 = 无预览按钮、编辑不预览）。 */
  preview?: TaskbarPreviewHandle;
  children?: ReactNode;
}) {
  const tr = useT();
  const meta = STATE_META[stateKey];
  const Icon = meta.icon;
  const isDesktop = stateKey === "desktop";
  const enabled = isDesktop || state.enabled === true;
  const isActive = active.length > 0;
  const activeTitle = active
    .map((p) => `${tr("显示器")} ${p.monitor}${p.matchedRule ? ` · ${tr("规则")} ${p.matchedRule}` : ""}`)
    .join("\n");
  const previewing = preview?.pinned === stateKey;
  const previewLabel = previewing ? tr("停止预览") : tr("预览此状态");
  return (
    <div className={`tm-tb-card${isActive ? " is-active" : ""}`} role="group" aria-label={tr(meta.name)}>
      <div className="tm-tb-card-head">
        <span className="tm-setting-leading" aria-hidden="true">
          <Icon size={18} />
        </span>
        <div className="tm-tb-card-text">
          <span className="tm-tb-card-title">{tr(meta.name)}</span>
          <span className="tm-tb-card-desc">{tr(meta.desc)}</span>
        </div>
        {previewing && <span className="tm-tb-badge is-on">{tr("预览中")}</span>}
        {isActive ? (
          <span className="tm-tb-badge is-on" title={activeTitle}>
            {tr("当前生效")}
            {active.length > 1 ? ` ×${active.length}` : ""}
          </span>
        ) : (
          !hasStateEvents && (
            <span className="tm-tb-badge" title={tr("尚未收到状态事件")} aria-label={tr("当前生效状态未知")}>
              —
            </span>
          )
        )}
        {preview && (
          <button
            type="button"
            className="tm-tb-icon-btn"
            onClick={() => preview.toggle(stateKey)}
            disabled={preview.disabled}
            aria-pressed={previewing}
            aria-label={previewLabel}
            title={preview.disabled ? tr("请先开启「自定义任务栏外观」") : previewLabel}
          >
            {previewing ? <EyeOff size={14} /> : <Eye size={14} />}
          </button>
        )}
        {isDesktop ? (
          <span className="tm-tb-badge">{tr("始终启用")}</span>
        ) : (
          <Toggle
            on={enabled}
            onChange={(v) => onChange({ ...state, enabled: v })}
            ariaLabel={`${tr("启用")} ${tr(meta.name)}`}
          />
        )}
      </div>
      {enabled && (
        <div className="tm-tb-card-body">
          <AppearanceEditor
            value={state}
            onChange={(next) => onChange({ ...state, ...next })}
            onPreview={preview ? (next) => preview.onEdit(stateKey, next) : undefined}
            caps={caps}
          />
          {children}
        </div>
      )}
    </div>
  );
}

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
                aria-label={`${tr("删除")}${v}`}
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
 * 状态条文案（F-10）：无状态 = 模块未就绪；idle 且总开关已开 = 模块尚未响应
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

export function TaskbarPage() {
  const tr = useT();
  const stored = useSettingsStore((s) => s.general.taskbar);
  const setStored = useSettingsStore((s) => s.setTaskbar);
  const setStoredOverride = useSettingsStore((s) => s.setTaskbarOverride);

  /* ══ HEADER · MONITOR（F-6）══ 显示器选择器：list_monitors 动态枚举（SettingsView
     同法，热插拔随 monitors-changed 刷新；id = 稳定槽位）。`editSlot === null` =
     「所有显示器统一」编辑基础配置；选中某屏后，下方 STATES / RULES / IGNORED 编辑的
     是该屏的浅合并视图，写入只落 monitorOverrides[slot]（enabled / perMonitor 等顶层
     开关仍写统一配置）。`taskbar` / `setTaskbar` 在此按编辑目标改道，下方区段无感。 */
  const [monitors, setMonitors] = useState<MonitorInfo[]>([]);
  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    invoke<MonitorInfo[]>("list_monitors")
      .then((list) => {
        if (!disposed) setMonitors(Array.isArray(list) ? list : []);
      })
      .catch(() => {
        if (!disposed) setMonitors([]);
      });
    return () => {
      disposed = true;
    };
  }, []);
  useTauriEvent("monitors-changed", () => {
    if (!isTauri()) return;
    invoke<MonitorInfo[]>("list_monitors")
      .then((list) => setMonitors(Array.isArray(list) ? list : []))
      .catch(() => setMonitors([]));
  });
  const [editSlot, setEditSlot] = useState<string | null>(null);
  const overrideSlots = useMemo(() => Object.keys(stored.monitorOverrides), [stored.monitorOverrides]);
  /* 选中的屏既不在线也没有覆盖（拔掉且从未覆盖 / 覆盖刚被删）→ 回统一，避免编辑幽灵屏。 */
  useEffect(() => {
    if (editSlot === null) return;
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
      opts.push({ id: taskbarSlotKey(m.id), label: `${m.name} · #${m.id}${m.is_primary ? tr("（主显示器）") : ""}` });
    }
    /* 有覆盖但当前未连接的屏也列出（可查看 / 删除其覆盖，热插拔回来自动接上）。 */
    for (const slot of overrideSlots) {
      if (!opts.some((o) => o.id === slot))
        opts.push({ id: slot, label: `${tr("显示器")} #${slot}${tr("（未连接）")}` });
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
  /* T-13：activeByMonitor 只会被事件填充、不会自我收敛——总开关关闭后引擎
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
  const autoRestartDone = useRef(false);
  const restartExplorer = async () => {
    if (!isTauri() || restartingExplorer) return;
    setRestartingExplorer(true);
    try {
      await invoke("restart_explorer");
      showToast(tr("资源管理器已重启，任务栏升级完成"), "ok");
    } catch (err) {
      showToast(`${tr("重启资源管理器失败")}：${String(err)}`, "error");
    } finally {
      setRestartingExplorer(false);
    }
  };
  useEffect(() => {
    if (!isTauri() || status?.code !== "stale_dll_resident") return;
    if (!autoRestartUpgrade || autoRestartDone.current || restartingExplorer) return;
    autoRestartDone.current = true;
    invoke("restart_explorer")
      .then(() => showToast(tr("资源管理器已重启，任务栏升级完成"), "ok"))
      .catch((err: unknown) => showToast(`${tr("重启资源管理器失败")}：${String(err)}`, "error"));
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
      // T-05：走 apply 全链路（重新注入 + 等就绪 + 下发）。reset_taskbar_state
      // 在故障态是空操作（非 Ready 直接返回），DLL 缺失 / 杀软拦截 / 握手超时后
      // 用户会被「请点击重新应用」的提示引向死胡同。
      const failed = await invoke<string[]>("apply_taskbar_config", { config: stored });
      if (failed.length > 0) {
        showToast(`${tr("任务栏配置部分未生效")}：${failed.join("、")}`, "error");
      } else {
        showToast(tr("已重新应用任务栏外观"), "ok");
      }
    } catch (err) {
      showToast(`${tr("重新应用失败")}：${String(err)}`, "error");
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

  /* ══ DIAG ══ 诊断快照（F-13）：能力 + 状态机 + 当前生效 + **统一**配置（覆盖表只列槽位）
     + 当前编辑目标（F-6）。 */
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

  const setState = (key: TaskbarStateKey, next: TaskbarStateAppearance) =>
    setTaskbar({ states: { ...taskbar.states, [key]: next } });
  /* ══ STATES · PREVIEW（F-8）══ 预览取当前编辑目标所见的外观；总开关看统一配置。 */
  const preview = useTaskbarPreview(taskbar.states, stored.enabled);
  const setRules = (key: keyof TaskbarRules, next: TaskbarRule[]) =>
    setTaskbar({ rules: { ...taskbar.rules, [key]: next } });
  const setIgnored = (key: keyof TaskbarIgnoredWindows, next: string[]) =>
    setTaskbar({ ignoredWindows: { ...taskbar.ignoredWindows, [key]: next } });

  const pathLabel = caps
    ? caps.path === "xaml"
      ? "XAML (TAP)"
      : caps.path === "swca"
        ? /* 路径 A 未实现（P3）：Mixed 机型后端无任何应用分支，标注「未启用」
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
            {status && (
              <span>
                {tr("协议")} v{status.protocolVersion}
              </span>
            )}
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

        {/* ══ HEADER · MONITOR（F-6）══ 显示器选择器：统一 / 逐屏覆盖入口 */}
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
              onChange={(next) => setState(key, next)}
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

      {/* ══ DIAG ══ 共存说明（F-15） */}
      <div className="tm-tb-note">
        {tr(
          "与桌面小组件共存：任务栏区域始终位于桌面层之上。任务栏透明后，放在任务栏区域内的小组件会被任务栏叠压，属预期行为；灵动岛的避让不受影响。"
        )}
      </div>
    </>
  );
}

/* ══════════════════════════════ 生效链路：TaskbarConfigSync ══════════════════════════════ */

/** 对账防抖：拖动透明度 / 半径期间切片连续变化，静默此时长后只对账 + apply 一次
 *  （与 settings-store scheduleSave 同窗口；F-13「防抖内连续拖动只触发一次」）。 */
export const TASKBAR_APPLY_DEBOUNCE_MS = 350;

/** 两侧均经 normalizeTaskbar 归一后比较：抹平键序 / `inactiveAppearance: null` 等序列化差异。 */
function taskbarConfigEquals(a: unknown, b: unknown): boolean {
  return JSON.stringify(normalizeTaskbar(a)) === JSON.stringify(normalizeTaskbar(b));
}

/**
 * F-1 生效链路（模式 B，照 App.tsx ShortcutConfigSync）：仅设置窗挂载；订阅
 * general.taskbar → get_taskbar_config 对账 → 不同才 apply_taskbar_config 整包下发。
 * apply 返回的非致命失败项与 Err 均 toast 提示，UI 不因空壳期恒 Err 而中断。
 * 定义在本文件（而非 App.tsx）以便随设置页 chunk 懒加载并可独立单测。
 */
export function TaskbarConfigSync() {
  const taskbar = useSettingsStore((s) => s.general.taskbar);
  useEffect(() => {
    if (!isTauri() || window.location.hash !== "#/settings") return;
    const timer = window.setTimeout(() => {
      void invoke<TaskbarSettings>("get_taskbar_config")
        .then((rust) => {
          if (rust && taskbarConfigEquals(rust, taskbar)) return null;
          return invoke<string[]>("apply_taskbar_config", { config: taskbar });
        })
        .then((failed) => {
          if (failed && failed.length > 0) showToast(`${t("任务栏配置部分未生效")}：${failed.join("、")}`, "error");
        })
        .catch((err: unknown) => {
          showToast(`${t("任务栏配置应用失败")}：${String(err)}`, "error");
        });
    }, TASKBAR_APPLY_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [taskbar]);
  return null;
}
