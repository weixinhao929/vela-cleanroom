/**
 * 设置页共享 UI：分区卡片、行控件等设置形态控件。
 * 统一键盘可达性与 data-interactive 标记，供各页面/配置表单复用。
 * Stepper / Segmented / Toggle 三个跨层原语已上移
 * components/ui/controls.tsx（widget 层此前为借它们反向 import 本目录），
 * 此处再导出保持全部调用方路径不变。
 */
export { Segmented, Stepper, Toggle } from "../../components/ui/controls";
import { Toggle } from "../../components/ui/controls";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useDelayedUnmount } from "../../lib/anim";
import { animDurations } from "../../lib/durations";
import { useDismissable } from "../../lib/use-dismissable";
import { uiZoom } from "../../lib/ui-zoom";
import { placePopover, type PopoverAnchor } from "../../widget/WidgetConfigPopover";
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

/** 下拉菜单水平钳制的视口留白（px）——与 placePopover 的 MARGIN
 *  同值（后者未导出，本地常量保持口径一致）。 */
const TM_MENU_MARGIN = 10;

export function Dropdown<T extends string>({
  value,
  options,
  onChange
}: {
  value: T;
  /** fontFamily：可选的逐选项预览字体栈（字体下拉每项用自身字体渲染）。 */
  options: { id: T; label: string; fontFamily?: string }[];
  onChange: (v: T) => void;
}) {
  const tr = useT();
  /* （对称退场）：菜单关闭后保留 120ms 播 .is-closing 淡出再卸载，
     与入场动画对称（此前展开有动画、收起瞬关）。 */
  const [open, setOpen] = useState(false);
  const menuVisible = useDelayedUnmount(open, animDurations().fxXfastMs);
  const menuClosing = !open && menuVisible;
  const ref = useRef<HTMLDivElement>(null);
  /* 菜单此前内联渲染在 .tm-select-wrap（relative）
     下 absolute 展开——触发行贴近 .tm-content（overflow-y:auto）可视底缘时
     菜单下半被整页滚动容器裁剪（同型）。改为 createPortal 到
     document.body + fixed 定位（与 DatePicker / WidgetSelect 统一
     口径）：锚点 = 触发器 gBCR ÷ uiZoom 打开时快照，渲染后按实测
     offsetWidth/Height 定位——垂直复用 placePopover（上方优先、放不下翻
     下方、视口钳制），水平保持左缘对齐并钳制视口；min-width 由 JS 按触发器
     宽度内联（fixed 下百分比包含块是视口）；定位完成前 visibility:hidden。 */
  const trigRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number; minW: number; side: "bottom" | "top" } | null>(null);
  /* 依赖含 menuVisible：useDelayedUnmount 的 render 比 open 晚一个 passive
     effect 提交才翻真，只盯 open 会在菜单挂载前空跑（量不到尺寸）。 */
  useLayoutEffect(() => {
    if (!open || !menuVisible) return;
    const trig = trigRef.current;
    const menu = menuRef.current;
    if (!trig || !menu) return;
    const r = trig.getBoundingClientRect();
    const z = uiZoom();
    const anchor: PopoverAnchor = { x: r.left / z, y: r.top / z, w: r.width / z, h: r.height / z };
    const placed = placePopover(
      anchor,
      { w: menu.offsetWidth, h: menu.offsetHeight },
      { w: window.innerWidth, h: window.innerHeight }
    );
    /* 水平：左缘对齐触发器（原 left:0 语义）+ 视口钳制（留白与 placePopover
       的 MARGIN 同值，其未导出、本地常量保持口径一致）。 */
    const left = Math.min(
      Math.max(anchor.x, TM_MENU_MARGIN),
      Math.max(TM_MENU_MARGIN, window.innerWidth - menu.offsetWidth - TM_MENU_MARGIN)
    );
    setPos({ left, top: placed.top, minW: anchor.w, side: placed.below ? "bottom" : "top" });
  }, [open, menuVisible]);
  /* fixed 菜单不随设置页滚——页面滚动（capture）/ resize / 失焦即收
     起（对齐 DatePicker / WidgetSelect 口径，否则菜单悬在原地与触发行脱节）；
     菜单自身 max-height 溢出滚动不算位移源，豁免。 */
  useEffect(() => {
    if (!open) return;
    const dismiss = () => setOpen(false);
    const onScroll = (e: Event) => {
      if (e.target instanceof Node && menuRef.current?.contains(e.target)) return;
      dismiss();
    };
    window.addEventListener("resize", dismiss);
    window.addEventListener("blur", dismiss);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      window.removeEventListener("resize", dismiss);
      window.removeEventListener("blur", dismiss);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [open]);
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
  /* 方向键在菜单项间移动（对齐 ContextMenu 键盘模型），Enter 确认，
     Esc/外点关闭后焦点归还触发器。关闭走统一骨架：外点 pointerdown capture
     （此前是 window mousedown 冒泡孤例）、Esc capture 抢先 stopPropagation
     （此前 bubble 不拦截，嵌套弹层会被一键关多层）、关闭归还打开时的焦点
     （打开时先记触发器，rAF 后焦点才移入菜单——归还回到触发器）。
     菜单 portal 到 body 后不再是 ref（wrap）的 DOM 后代，menuRef 进
     anchors 才不算外点。 */
  const [activeIdx, setActiveIdx] = useState(-1);
  useDismissable(open, ref, () => setOpen(false), { restoreFocus: true, anchors: [menuRef] });
  useEffect(() => {
    if (open) setActiveIdx(options.findIndex((o) => o.id === value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const current = options.find((o) => o.id === value);
  const currentFont = current?.fontFamily;
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
        ref={trigRef}
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
        <span style={currentFont ? { fontFamily: currentFont } : undefined}>{tr(current?.label ?? value)}</span>
        <ChevronDown size={14} className={open ? "open" : ""} />
      </div>
      {/* 菜单 portal 到 document.body——left/top/min-width 由 JS 内联
          （布局单位），CSS 只留 fixed 与视觉；定位完成前 visibility:hidden。 */}
      {menuVisible &&
        createPortal(
          <div
            ref={menuRef}
            className={`tm-select-menu${menuClosing ? " is-closing" : ""}`}
            data-interactive
            role="listbox"
            tabIndex={-1}
            data-side={pos?.side ?? "bottom"}
            style={pos ? { left: pos.left, top: pos.top, minWidth: pos.minW } : { visibility: "hidden" }}
            onKeyDown={menuKeyDown}
            /* 阻止 mousedown 抢焦点：否则点击选项先触发菜单 blur 关闭，onClick 收不到。 */
            onMouseDown={(e) => e.preventDefault()}
            onBlur={(e) => {
              if (
                !ref.current?.contains(e.relatedTarget as Node) &&
                !menuRef.current?.contains(e.relatedTarget as Node)
              )
                setOpen(false);
            }}
          >
            {options.map((o, i) => (
              <div
                key={o.id}
                className={`tm-select-item${o.id === value ? " active" : ""}${i === activeIdx ? " kb-focus" : ""}`}
                data-interactive
                role="option"
                aria-selected={o.id === value}
                style={o.fontFamily ? { fontFamily: o.fontFamily } : undefined}
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
          </div>,
          document.body
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
  /* 应用生效脉冲：取色板关闭（blur）或点「重置」时色块做一次 scale 脉冲。
     取色拖动过程中 onChange 连续触发，不脉冲，避免抖动噪音。 */
  const [pulse, setPulse] = useState(false);
  const firePulse = () => {
    setPulse(false);
    requestAnimationFrame(() => setPulse(true));
  };
  /* hex 精确输入：值是 #rrggbb 时展示可编辑文本框（粘贴设计稿色值直接用，
     不必在取色板里眯眼调）。rgba 值（widgetBackground 玻璃色）无对应 hex
     表示，不展示——不造假输入面。非法输入失焦/回退原值。 */
  const hexEditable = /^#[0-9a-f]{6}$/i.test(color);
  const [hexDraft, setHexDraft] = useState(color);
  useEffect(() => setHexDraft(color), [color]);
  const commitHex = () => {
    const v = hexDraft.trim();
    if (hexEditable && /^#[0-9a-f]{6}$/i.test(v)) {
      const next = v.toLowerCase();
      if (next !== color.toLowerCase()) onChange(next);
    } else {
      setHexDraft(color);
    }
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
      {hexEditable && (
        <input
          className="tm-color-hex"
          value={hexDraft}
          spellCheck={false}
          aria-label={tr("十六进制色值")}
          onChange={(e) => setHexDraft(e.target.value)}
          onBlur={commitHex}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commitHex();
            }
          }}
          data-interactive
        />
      )}
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
  const themeMode = useSettingsStore((s) => s.themeMode);
  const primaryColor = useSettingsStore((s) => s.primaryColor);
  const customColors = useSettingsStore((s) => s.customColors);
  /* 主题模式 = system 时，resolveEffectiveTokens 读的是「启动那一刻」的
     系统明暗；系统随后切换明暗，SettingsSync 会重放主题引擎，但本卡的
     live memo 依赖不含系统偏好 → 预览停在旧档。订阅 matchMedia 变化翻转
     版本号强制重算，与全窗 token 口径同步。 */
  const [sysDarkVersion, setSysDarkVersion] = useState(0);
  useEffect(() => {
    if (themeMode !== "system") return;
    const mq = window.matchMedia?.("(prefers-color-scheme: dark)");
    if (!mq) return;
    const bump = () => setSysDarkVersion((v) => v + 1);
    mq.addEventListener("change", bump);
    return () => mq.removeEventListener("change", bump);
  }, [themeMode]);
  /* 实时预览层：hover/选中时叠加「切到这张卡实际会得到」的迷你场景——
     中性 token（bg/glow/ink/paper）按当前 themeMode 经 resolveEffectiveTokens
     解析（浅色预设在 dark 模式下会展示通用深底），accent 取用户当前主色
     （与 applySettings 的 accent 口径一致）。静态缩略图保留为底图。 */
  const live = useMemo(() => {
    const t = resolveEffectiveTokens(id, themeMode, customColors);
    return {
      bg: t.bg,
      glow: t.bgGlow,
      ink: t.ink,
      paper: t.paper,
      accent: primaryColor
    };
    // sysDarkVersion 仅作 system 档的重算触发器（值本身不参与计算）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, themeMode, primaryColor, customColors, sysDarkVersion]);
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

/** 行规范：40px 圆角图标芯片（可选 leading 段）。 */
export function SettingLeading({ icon: Icon }: { icon: typeof Sun }) {
  return (
    <span className="tm-setting-leading" aria-hidden="true">
      <Icon size={18} />
    </span>
  );
}

/**
 * 三段式设置行（三段式设置行规范）：可选 leading 图标芯片 +
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
