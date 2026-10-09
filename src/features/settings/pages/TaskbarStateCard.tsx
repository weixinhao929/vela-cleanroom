/**
 * 设置页 · 任务栏（TB-UI）：七态状态卡——（深拆）自
 * TaskbarPage.tsx 拆出。TaskbarPage 按 TASKBAR_STATE_KEYS 逐卡挂载，带规则的
 * 两态（visible / maximized）经 children 挂 RuleList。
 */
import type { ReactNode } from "react";
import { AppWindow, BatteryLow, Eye, EyeOff, Layers, LayoutGrid, Maximize2, Monitor, Search } from "lucide-react";
import { useT } from "../../../i18n-lite";
import type { TaskbarStateAppearance, TaskbarStateKey } from "../../../store/settings-store";
import type { TaskbarCapabilities } from "../../../types/bindings/TaskbarCapabilities";
import type { TaskbarStateChanged } from "../../../types/bindings/TaskbarStateChanged";
import { Toggle } from "../shared";
import { AppearanceEditor } from "./TaskbarAppearanceEditor";
import type { TaskbarPreviewHandle } from "./TaskbarPreview";

/** 七态元信息（顺序 = TASKBAR_STATE_KEYS：桌面在上、省电在下；越靠下优先级越高）。 */
const STATE_META: Record<TaskbarStateKey, { name: string; desc: string; icon: typeof Monitor }> = {
  desktop: { name: "桌面", desc: "桌面可见、没有用户窗口时的基础外观（始终启用）", icon: Monitor },
  visibleWindow: { name: "可见窗口", desc: "存在非最大化的用户窗口时（可按前台窗口配置规则）", icon: AppWindow },
  maximizedWindow: { name: "最大化窗口", desc: "存在最大化窗口时（按最顶层最大化窗口匹配规则）", icon: Maximize2 },
  startOpened: { name: "开始菜单打开", desc: "开始菜单打开时（只影响所在显示器）", icon: LayoutGrid },
  searchOpened: { name: "搜索打开", desc: "搜索面板打开时（只影响所在显示器）", icon: Search },
  taskViewOpened: { name: "任务视图打开", desc: "任务视图打开时（影响全部显示器）", icon: Layers },
  batterySaver: { name: "省电模式", desc: "系统进入省电模式时（影响全部显示器）", icon: BatteryLow }
};

export function StateCard({
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
  /** 字段级提交（含 enabled）：现取最新切片 merge，见 AppearanceEditor 头注。 */
  onChange: (patch: Partial<TaskbarStateAppearance>) => void;
  caps: TaskbarCapabilities | null;
  /** 命中本态的显示器事件（可多屏）。 */
  active: TaskbarStateChanged[];
  /** 是否收过任何 state-changed 事件（无 → 徽标显「—」）。 */
  hasStateEvents: boolean;
  /** 预览控制面（缺省 = 无预览按钮、编辑不预览）。 */
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
    .map((p) =>
      p.matchedRule
        ? `${tr("显示器 {n}", { n: p.monitor })} · ${tr("规则 {id}", { id: p.matchedRule })}`
        : tr("显示器 {n}", { n: p.monitor })
    )
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
            onChange={(v) => onChange({ enabled: v })}
            ariaLabel={tr("启用 {name}", { name: tr(meta.name) })}
          />
        )}
      </div>
      {enabled && (
        <div className="tm-tb-card-body">
          <AppearanceEditor
            value={state}
            onChange={onChange}
            onPreview={preview ? (next) => preview.onEdit(stateKey, next) : undefined}
            caps={caps}
          />
          {children}
        </div>
      )}
    </div>
  );
}
