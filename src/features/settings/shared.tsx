/**
 * 设置页共享 UI：分区卡片、行控件等设置形态控件。
 * 统一键盘可达性与 data-interactive 标记，供各页面/配置表单复用。
 * A-2：Stepper / Segmented / Toggle 三个跨层原语已上移
 * components/ui/controls.tsx（widget 层此前为借它们反向 import 本目录），
 * 此处再导出保持全部调用方路径不变。
 */
export { Segmented, Stepper, Toggle } from "../../components/ui/controls";
import { Toggle } from "../../components/ui/controls";
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useDelayedUnmount } from "../../lib/anim";
import { animDurations } from "../../lib/durations";
import { useDismissable } from "../../lib/use-dismissable";
import { ChevronDown, Monitor, Moon, Sun } from "lucide-react";
import { PRESET_NAMES, useSettingsStore, type ThemeMode, type ThemePreset } from "../../store/settings-store";
import { resolveEffectiveTokens, systemPrefersDark } from "../../lib/theme-engine";
import { useT } from "../../i18n-lite";
import { SpecularFrame } from "../../lib/rb";
import { useFxEffectEnabled } from "../../lib/fx";

/** 设置页内导航目标的 id（侧栏项 / view-xx / widget-config-xx / gallery 等）。 */
export type Page = string;

/** 与主题引擎 resolveEffectiveTokens 相同的明暗判定：
    dark / light 显式，system 跟随操作系统明暗偏好（预设自带深浅两套）。 */
export function resolveDarkTheme(preset: ThemePreset, themeMode: ThemeMode): boolean {
  if (themeMode === "light") return false;
  if (themeMode === "dark") return true;
  return systemPrefersDark();
}

/**
 * 条状滑块：连续数值区间（透明度、缩放、圆角、时长等）用它比步进器更直观，
 * 拖动即所见即所得，右侧实时显示当前值。原生 range 输入保证键盘可达。
 * [POLISH] 实现已升级为 M3Slider（16px 厚轨道 / 断口 / 竖条 handle / 值气泡），
 * 此处以原名再导出，全部调用方 API 不变。
 */
export { M3Slider as Slider } from "../../components/ui/M3Slider";

export function Dropdown<T extends string>({
  value,
  options,
  onChange
}: {
  value: T;
  options: { id: T; label: string }[];
  onChange: (v: T) => void;
}) {
  const tr = useT();
  /* D3（对称退场）：菜单关闭后保留 120ms 播 .is-closing 淡出再卸载，
     与入场动画对称（此前展开有动画、收起瞬关）。 */
  const [open, setOpen] = useState(false);
  const menuVisible = useDelayedUnmount(open, animDurations().fxXfastMs);
  const menuClosing = !open && menuVisible;
  const ref = useRef<HTMLDivElement>(null);
  /* 键盘可达关键：打开后把焦点移入菜单（tabIndex=-1），方向键/Enter 的
     menuKeyDown 才能收到事件——此前焦点留在触发器上，导航是死路径。 */
  const menuRef = useRef<HTMLDivElement | null>(null);
  const openMenu = () => {
    setOpen(true);
    requestAnimationFrame(() => menuRef.current?.focus());
  };
  const toggleMenu = () => {
    if (open) setOpen(false);
    else openMenu();
  };
  /* B11：方向键在菜单项间移动（对齐 ContextMenu 键盘模型），Enter 确认，
     Esc/外点关闭后焦点归还触发器。关闭走统一骨架：外点 pointerdown capture
     （此前是 window mousedown 冒泡孤例）、Esc capture 抢先 stopPropagation
     （此前 bubble 不拦截，嵌套弹层会被一键关多层）、关闭归还打开时的焦点
     （打开时先记触发器，rAF 后焦点才移入菜单——归还回到触发器）。 */
  const [activeIdx, setActiveIdx] = useState(-1);
  useDismissable(open, ref, () => setOpen(false), { restoreFocus: true });
  useEffect(() => {
    if (open) setActiveIdx(options.findIndex((o) => o.id === value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const current = options.find((o) => o.id === value)?.label ?? value;
  const menuKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIdx((i) => Math.min(options.length - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIdx((i) => Math.max(0, i - 1));
    } else if (e.key === "Enter" && activeIdx >= 0) {
      e.preventDefault();
      const o = options[activeIdx];
      onChange(o.id);
      setOpen(false);
      ref.current?.querySelector<HTMLDivElement>(".tm-dropdown")?.focus();
    }
  };
  return (
    <div className="tm-select-wrap" ref={ref}>
      <div
        className="tm-dropdown"
        onClick={toggleMenu}
        tabIndex={0}
        role="button"
        data-interactive
        aria-haspopup="listbox"
        aria-expanded={open}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            toggleMenu();
          } else if ((e.key === "ArrowDown" || e.key === "ArrowUp") && !open) {
            e.preventDefault();
            openMenu();
          }
        }}
      >
        <span>{tr(current)}</span>
        <ChevronDown size={14} className={open ? "open" : ""} />
      </div>
      {menuVisible && (
        <div
          ref={menuRef}
          className={`tm-select-menu${menuClosing ? " is-closing" : ""}`}
          data-interactive
          role="listbox"
          tabIndex={-1}
          onKeyDown={menuKeyDown}
          /* 阻止 mousedown 抢焦点：否则点击选项先触发菜单 blur 关闭，onClick 收不到。 */
          onMouseDown={(e) => e.preventDefault()}
          onBlur={(e) => {
            if (!ref.current?.contains(e.relatedTarget as Node)) setOpen(false);
          }}
        >
          {options.map((o, i) => (
            <div
              key={o.id}
              className={`tm-select-item${o.id === value ? " active" : ""}${i === activeIdx ? " kb-focus" : ""}`}
              data-interactive
              role="option"
              aria-selected={o.id === value}
              onMouseEnter={() => setActiveIdx(i)}
              onClick={() => {
                onChange(o.id);
                setOpen(false);
                ref.current?.querySelector<HTMLDivElement>(".tm-dropdown")?.focus();
              }}
            >
              {tr(o.label)}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function ColorRow({
  color,
  onChange,
  onReset
}: {
  color: string;
  onChange: (c: string) => void;
  onReset: () => void;
}) {
  const tr = useT();
  /* #86 应用生效脉冲：取色板关闭（blur）或点「重置」时色块做一次 scale 脉冲。
     取色拖动过程中 onChange 连续触发，不脉冲，避免抖动噪音。 */
  const [pulse, setPulse] = useState(false);
  const firePulse = () => {
    setPulse(false);
    requestAnimationFrame(() => setPulse(true));
  };
  return (
    <div className={`tm-color-row${pulse ? " swatch-pulse" : ""}`}>
      <label className="tm-color-picker" title={tr("点击打开取色板")}>
        <span className="tm-color-swatch" style={{ background: color }} />
        <input
          type="color"
          value={color}
          onChange={(e) => onChange(e.target.value)}
          onBlur={firePulse}
          aria-label={tr("选择颜色")}
        />
      </label>
      <button
        className="tm-btn-reset"
        onClick={() => {
          onReset();
          firePulse();
        }}
      >
        {tr("重置")}
      </button>
    </div>
  );
}

export function PresetCard({
  id,
  selected,
  onSelect,
  style
}: {
  id: ThemePreset;
  selected: boolean;
  onSelect: () => void;
  /** 透传 --sti 等动画变量。 */ style?: CSSProperties;
}) {
  const tr = useT();
  const specular = useFxEffectEnabled("specular");
  /* B3 实时预览层：hover/选中时叠加「切到这张卡实际会得到」的迷你场景——
     中性 token（bg/glow/ink/paper）按当前 themeMode 经 resolveEffectiveTokens
     解析（浅色预设在 dark 模式下会展示通用深底），accent 取用户当前主色
     （与 applySettings 的 accent 口径一致）。静态缩略图保留为底图。 */
  const themeMode = useSettingsStore((s) => s.themeMode);
  const primaryColor = useSettingsStore((s) => s.primaryColor);
  const customColors = useSettingsStore((s) => s.customColors);
  const live = useMemo(() => {
    const t = resolveEffectiveTokens(id, themeMode, customColors);
    return {
      bg: t.bg,
      glow: t.bgGlow,
      ink: t.ink,
      paper: t.paper,
      accent: primaryColor
    };
  }, [id, themeMode, primaryColor, customColors]);
  return (
    <button
      type="button"
      className={`tm-preset-card${selected ? " selected" : ""}`}
      onClick={onSelect}
      aria-pressed={selected}
      style={style}
    >
      {specular && selected && <SpecularFrame thickness={2} />}
      {selected && (
        <span className="tm-check-badge">
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="3"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <polyline points="20 6 9 17 4 12" />
          </svg>
        </span>
      )}
      <div className={`tm-preset-thumbnail tm-thumb-${id}`}>
        <span
          className="tm-preset-live"
          aria-hidden="true"
          style={
            {
              "--pv-bg": live.bg,
              "--pv-glow": live.glow,
              "--pv-ink": live.ink,
              "--pv-paper": live.paper,
              "--pv-accent": live.accent
            } as CSSProperties
          }
        >
          <span className="tm-preset-live-glow" />
          <span className="tm-preset-live-card">
            <span className="tm-preset-live-dot" />
            <span className="tm-preset-live-line w1" />
            <span className="tm-preset-live-line w2" />
          </span>
        </span>
      </div>
      <div className="tm-preset-info">
        <span className="tm-preset-name">{tr(PRESET_NAMES[id])}</span>
      </div>
    </button>
  );
}

/** B2 行规范：40px 圆角图标芯片（可选 leading 段）。 */
export function SettingLeading({ icon: Icon }: { icon: typeof Sun }) {
  return (
    <span className="tm-setting-leading" aria-hidden="true">
      <Icon size={18} />
    </span>
  );
}

/**
 * B2 三段式设置行（三段式设置行规范）：可选 leading 图标芯片 +
 * title/subtitle + trailing 控件，行高 56。children 作为 trailing 段。
 * 旧的两段式裸结构（div.tm-setting-text + 控件）继续兼容。
 */
export function SettingRow({
  title,
  desc,
  icon,
  highlighted,
  children
}: {
  title: string;
  desc: string;
  /** 可选 leading 图标（lucide 组件）。 */ icon?: typeof Sun;
  /** 芯片转 accent 强调态（选中/激活语义）。 */ highlighted?: boolean;
  children?: ReactNode;
}) {
  const tr = useT();
  return (
    <div className={`tm-setting-row${highlighted ? " highlighted" : ""}`}>
      <div className="tm-setting-main">
        {icon && <SettingLeading icon={icon} />}
        <div className="tm-setting-text">
          <span className="tm-setting-title">{tr(title)}</span>
          <span className="tm-setting-desc">{tr(desc)}</span>
        </div>
      </div>
      {children && <div className="tm-setting-trailing">{children}</div>}
    </div>
  );
}

export function SettingToggleRow({
  title,
  desc,
  icon,
  on,
  onChange
}: {
  title: string;
  desc: string;
  /** 可选 leading 图标（lucide 组件）。 */ icon?: typeof Sun;
  on: boolean;
  onChange: (v: boolean) => void;
}) {
  const tr = useT();
  return (
    <div className="tm-setting-row">
      <div className="tm-setting-main">
        {icon && <SettingLeading icon={icon} />}
        <div className="tm-setting-text">
          <span className="tm-setting-title">{tr(title)}</span>
          <span className="tm-setting-desc">{tr(desc)}</span>
        </div>
      </div>
      <Toggle on={on} onChange={onChange} ariaLabel={tr(title)} />
    </div>
  );
}

/** 供侧栏使用的图标 re-export，避免各页各自引入同一批图标。 */
export { Monitor, Moon };

/* DatePicker 已迁至 components/DatePicker.tsx（桌面小组件共用），此处保留再导出。 */
export { DatePicker, DateTimePicker } from "../../components/DatePicker";
