/**
 * 就地配置弹层的真实现（壳见 WidgetConfigPopover.tsx）。
 *
 * 独立成 chunk 的原因：本文件静态依赖 config-schemas（32 个 zod schema +
 * QUICK_CONFIG_FIELDS）与 features/settings/shared（Slider = M3Slider →
 * WakeSlider → motion/react）——这些只有弹层打开时才需要，随壳静态进主
 * chunk 会让每个窗口（含任务栏网速条）在启动期构建全套 zod schema 并背走
 * motion 引擎。壳保持导出面不变，首次 open 翻真才动态拉取本模块。
 *
 * 行为与拆分前完全一致：锚定定位 / 单例互斥 / 键盘陷阱 / 外点关闭 /
 * quick 字段渲染 / 样式预设 / 世界时钟编辑器，全部原文迁移。
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { ChevronRight, X } from "lucide-react";
import { useDelayedUnmount } from "../lib/anim";
import { animDurations } from "../lib/durations";
import { useDismissable } from "../lib/use-dismissable";
import { useFocusReturn } from "../lib/use-focus-return";
import { useSliderDraft } from "../lib/use-slider-draft";
import { isTauri, invoke } from "../lib/tauri";
import { useT } from "../i18n-lite";
import { promptDialog, confirmDialog, alertDialog } from "../components/PromptDialog";
import { pushAppToast } from "../components/ToastHost";
/* 跨层 UI 原语直取 components/ui，widget 不再反向 import features/settings。 */
import { Segmented, Stepper, Toggle } from "../components/ui/controls";
import { M3Slider as Slider } from "../components/ui/M3Slider";
import { getWidgetMeta } from "./registry";
import { widgetDisplayName } from "./display-name";
import { promptRenameInstance } from "./rename";
import { useWidgetStore } from "./widget-store";
import { useWidgetConfig, type WidgetConfig } from "./widget-config";
import { defaultWidgetConfig, sanitizeWidgetConfig } from "./config-schemas";
import { QUICK_CONFIG_FIELDS, type QuickFieldDef } from "./quick-config-fields";
import {
  listStylePresets,
  saveStylePreset,
  deleteStylePreset,
  mergeStyleConfig,
  suggestPresetName,
  exportPresetsJson,
  importPresetsFromPackage,
  type StylePreset
} from "../lib/style-presets";
import { ALL_TIMEZONES, normalizeZoneInput } from "./clock-timezones";
import {
  openWidgetSettingsPage,
  placePopover,
  nextWcfgToken,
  WCFG_OPEN_EVENT,
  type PopoverAnchor,
  type WidgetConfigPopoverProps
} from "./WidgetConfigPopover";
import "../styles/feature-widget-config.css";

type Placement = ReturnType<typeof placePopover>;

export function WidgetConfigPopoverInner({ instanceId, widgetType, anchor, open, onClose }: WidgetConfigPopoverProps) {
  const tr = useT();
  const meta = getWidgetMeta(widgetType);
  /* 退场：关闭后保留 160ms 播 .is-closing 缩放淡出再卸载。 */
  const visible = useDelayedUnmount(open, animDurations().fxFastMs);
  const closing = !open && visible;
  /* 关闭归还焦点：打开时记录触发元素（齿轮/右键「配置」），关闭
     （Esc / 外点 / 互斥连坐）即归还——此前焦点跌落 body，键盘用户需重新
     Tab 定位。记录先于下方 rAF 把焦点移入弹层，记到的才是触发元素。 */
  useFocusReturn(open);
  const ref = useRef<HTMLDivElement>(null);
  const anchorRef = useRef<PopoverAnchor>(anchor);
  const tokenRef = useRef(0);
  const [pos, setPos] = useState<Placement | null>(null);
  /* 标题/aria 走显示名（重命名后弹层跟随；派生字符串订阅，改名才重渲）。 */
  const displayName = useWidgetStore((s) => widgetDisplayName(widgetType, instanceId, s.instances, tr));

  /* open 翻真：快照锚点、广播单例令牌、下一帧把焦点移入弹层。 */
  useEffect(() => {
    if (!open) return;
    anchorRef.current = anchor;
    /* 令牌改取全局单源自增（与编组面板同源，见 nextWcfgToken 注释）。 */
    tokenRef.current = nextWcfgToken();
    window.dispatchEvent(new CustomEvent<number>(WCFG_OPEN_EVENT, { detail: tokenRef.current }));
    const raf = requestAnimationFrame(() => ref.current?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(raf);
    // anchor 仅在打开瞬间取快照；后续变化不重定位。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  /* 单例互斥：别处的弹层打开时自动关闭。 */
  useEffect(() => {
    if (!open) return;
    const onOther = (e: Event) => {
      if ((e as CustomEvent<number>).detail !== tokenRef.current) onClose();
    };
    window.addEventListener(WCFG_OPEN_EVENT, onOther);
    return () => window.removeEventListener(WCFG_OPEN_EVENT, onOther);
  }, [open, onClose]);

  /* 透明度拖动会话的了结从「卸载」改挂
     「visible 翻假」——壳 armed 首开后 Inner 常驻挂载，Esc/互斥连坐/外点
     关闭只把 visible 翻假（150ms 退场窗后返回 null），组件并不卸载；若用户
     按住滑条超过退场窗才松手，WakeSlider 已随 DOM 移除、pointer capture
     静默丢失，onCommitEnd 永不触发，瞬态 opacityPreview 残留 store。退场窗
     结束即按预览值落盘（等效完成提交，保留用户意图），只碰本面板管辖的 id；
     卸载兜底保留（覆盖壳整体拆除的路径）。 */
  const commitOpacityPreview = useCallback(() => {
    const st = useWidgetStore.getState();
    const pv = st.opacityPreview;
    if (pv && pv.id === instanceId) {
      st.setOpacityPreview(null);
      st.updateWidget(instanceId, { opacity: pv.value });
    }
  }, [instanceId]);
  useEffect(() => {
    if (!visible) commitOpacityPreview();
  }, [visible, commitOpacityPreview]);
  useEffect(() => () => commitOpacityPreview(), [commitOpacityPreview]);

  /* 定位：渲染后测量实际尺寸（useLayoutEffect 在绘制前完成，无闪动），窗口尺寸
     变化与内容高度变化（世界时钟增删行）时重算。三个量同为布局单位——锚点是
     调用方传入的卡片/组几何（画布布局坐标）、el.offsetWidth 与 innerWidth 都是
     未缩放值（CSS zoom 下 fixed left/top 渲染再乘 zoom，不换算才能对准锚点）。
     需要除 uiZoom 的是 gBCR/clientX 这类**视觉**坐标（dock 侧弹层在自己
     place 里换算）；此前把布局锚点再除一次会在缩放 ≠100% 时向左上漂移。 */
  const place = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    setPos(
      placePopover(
        anchorRef.current,
        { w: el.offsetWidth, h: el.offsetHeight },
        { w: window.innerWidth, h: window.innerHeight }
      )
    );
  }, []);
  useLayoutEffect(() => {
    if (visible) place();
  }, [visible, place]);
  useEffect(() => {
    if (!visible) return;
    const el = ref.current;
    if (!el) return;
    window.addEventListener("resize", place);
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(place) : null;
    ro?.observe(el);
    return () => {
      window.removeEventListener("resize", place);
      ro?.disconnect();
    };
  }, [visible, place]);

  /* 键盘：Esc 关闭（capture 阶段拦截，不让画布/编辑模式的 Esc 监听抢先）；
     Tab 在弹层内循环。 */
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        // 分层关闭：右键菜单（ctx-menu）开着时第一下 Esc 只关菜单（Host 的
        // document 捕获处理器随后接手）；这里 stopPropagation 会拦掉它。
        if (document.querySelector(".ctx-menu")) return;
        e.stopPropagation();
        e.preventDefault();
        onClose();
      } else if (e.key === "Tab" && ref.current) {
        const focusables = Array.from(
          ref.current.querySelectorAll<HTMLElement>("button, input, select, textarea, [tabindex]:not([tabindex='-1'])")
        ).filter((el) => !el.hasAttribute("disabled"));
        if (focusables.length === 0) return;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        const ae = document.activeElement;
        if (e.shiftKey && (ae === first || !ref.current.contains(ae))) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && (ae === last || !ref.current.contains(ae))) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, onClose]);

  /* 外点关闭（统一骨架）：pointerdown capture 阶段判定目标不在弹层内即关闭
     （覆盖层期间整个视口可交互，见 useClickThrough OVERLAY_SELECTOR）。
     Esc 由上方 effect 分步处理（先清展开层再关弹层），hook 不接管。 */
  useDismissable(open, ref, onClose, { escape: false });

  if (!visible || !meta) return null;

  const style: CSSProperties = pos
    ? { left: pos.left, top: pos.top, transformOrigin: pos.below ? "top center" : "bottom center" }
    : { left: -9999, top: -9999 };

  return createPortal(
    <div
      ref={ref}
      className={`wcfg-popover${closing ? " is-closing" : ""}${pos?.below ? " is-below" : ""}`}
      role="dialog"
      aria-label={`${displayName} ${tr("配置")}`}
      tabIndex={-1}
      data-interactive
      style={style}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => {
        // 输入框保留原生「剪切/复制/粘贴」菜单；其它区域右键即关闭（与右键菜单同语义）。
        if ((e.target as HTMLElement).closest("input, textarea")) return;
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }}
    >
      <div className="wcfg-header">
        <span className="wcfg-title">{displayName}</span>
        <button type="button" className="wcfg-close" onClick={onClose} aria-label={tr("关闭")} data-interactive>
          <X size={13} />
        </button>
      </div>
      <div className="wcfg-body">
        <InstanceRows instanceId={instanceId} />
        <QuickFields instanceId={instanceId} widgetType={widgetType} />
        <PresetRow instanceId={instanceId} widgetType={widgetType} />
      </div>
      <button
        type="button"
        className="wcfg-more"
        onClick={() => {
          onClose();
          openWidgetSettingsPage(instanceId);
        }}
        data-interactive
      >
        <span>{tr("更多设置")}</span>
        <ChevronRight size={13} />
      </button>
    </div>,
    document.body
  );
}

/* ------------------------------------------------------------------ */
/*  通用行：实例级透明度 / 鼠标穿透（widget-store，而非 config）           */
/* ------------------------------------------------------------------ */

function InstanceRows({ instanceId }: { instanceId: string }) {
  const tr = useT();
  const inst = useWidgetStore((s) => s.instances.find((i) => i.id === instanceId));
  const updateWidget = useWidgetStore((s) => s.updateWidget);
  /* 透明度拖动会话：onChange 只写瞬态预览（画布不重渲），松手/键盘步进时
     一次性写回 instances；受控 value 读预览避免拖动中回跳。 */
  const previewOpacity = useWidgetStore((s) =>
    s.opacityPreview && s.opacityPreview.id === instanceId ? s.opacityPreview.value : null
  );
  const commitOpacity = useCallback(() => {
    const st = useWidgetStore.getState();
    const pv = st.opacityPreview;
    st.setOpacityPreview(null);
    if (pv && pv.id === instanceId) updateWidget(instanceId, { opacity: pv.value });
  }, [instanceId, updateWidget]);
  return (
    <>
      {/* 显示名入口（与卡片右键/设置页同一共享实现，独立卡最高频的就地面
          此前无重命名入口）。按钮文案即当前自定义名，留空回落「重命名」。 */}
      <Row label={tr("名称")}>
        <button
          type="button"
          className="wcfg-mini-btn"
          onClick={() => void promptRenameInstance(instanceId, tr)}
          data-interactive
        >
          {inst?.label?.trim() || tr("重命名")}
        </button>
      </Row>
      <Row label={tr("透明度")}>
        <Slider
          label="透明度"
          value={Math.round((previewOpacity ?? inst?.opacity ?? 1) * 100)}
          min={0}
          max={100}
          step={1}
          suffix="%"
          onChange={(v) => useWidgetStore.getState().setOpacityPreview({ id: instanceId, value: v / 100 })}
          onCommitEnd={commitOpacity}
        />
      </Row>
      <Row label={tr("鼠标穿透")}>
        <Toggle
          on={inst?.clickThrough === true}
          onChange={(v) => updateWidget(instanceId, { clickThrough: v })}
          ariaLabel={tr("鼠标穿透")}
        />
      </Row>
    </>
  );
}

/* ------------------------------------------------------------------ */
/*  quick 字段：schema 驱动                                             */
/* ------------------------------------------------------------------ */

function QuickFields({ instanceId, widgetType }: { instanceId: string; widgetType: string }) {
  const fields = QUICK_CONFIG_FIELDS[widgetType] ?? [];
  const { config, update } = useWidgetConfig(instanceId);
  const defaults = useMemo(() => defaultWidgetConfig(widgetType), [widgetType]);
  /* 读：过 schema 洗掉损坏字段、补默认；写：合并后再过一遍 schema 落盘（与设置页同协议）。 */
  const clean = useMemo(() => sanitizeWidgetConfig(widgetType, config), [widgetType, config]);
  const commit = useCallback(
    (patch: Partial<WidgetConfig>) => update(sanitizeWidgetConfig(widgetType, { ...clean, ...patch })),
    [update, widgetType, clean]
  );
  if (fields.length === 0) return null;
  return (
    <>
      <div className="wcfg-divider" role="separator" />
      {fields.map((f) => (
        <QuickFieldRow
          key={f.key}
          def={f}
          value={clean[f.key]}
          fallback={defaults[f.key]}
          onChange={(v) => commit({ [f.key]: v })}
        />
      ))}
    </>
  );
}

function QuickFieldRow({
  def,
  value,
  fallback,
  onChange
}: {
  def: QuickFieldDef;
  value: unknown;
  /** schema 默认值：读取惯例（`!== false` 还是 `=== true`）与枚举/数值兜底均由它决定。 */
  fallback: unknown;
  onChange: (v: unknown) => void;
}) {
  const tr = useT();
  switch (def.kind) {
    case "toggle": {
      const on = fallback === true ? value !== false : value === true;
      return (
        <Row label={tr(def.label)}>
          <Toggle on={on} onChange={onChange} ariaLabel={tr(def.label)} />
        </Row>
      );
    }
    case "segment": {
      const v = def.options.some((o) => o.id === value) ? (value as string) : String(fallback);
      return (
        <Row label={tr(def.label)} stack={def.options.length > 3}>
          <Segmented value={v} options={def.options} onChange={onChange} />
        </Row>
      );
    }
    case "slider":
    case "stepper": {
      const raw = typeof value === "number" && Number.isFinite(value) ? value : (fallback as number);
      const num = Math.min(Math.max(raw, def.min), def.max);
      return (
        <Row label={tr(def.label)}>
          {def.kind === "slider" ? (
            <DraftSlider
              label={def.label}
              value={num}
              min={def.min}
              max={def.max}
              step={def.step ?? 1}
              suffix={def.suffix ?? ""}
              onCommit={onChange}
            />
          ) : (
            <Stepper
              value={num}
              min={def.min}
              max={def.max}
              suffix={def.suffix ?? ""}
              onChange={(v) => onChange(Math.min(Math.max(Math.round(v), def.min), def.max))}
            />
          )}
        </Row>
      );
    }
    case "color": {
      const color = typeof value === "string" ? value : "";
      return (
        <Row label={tr(def.label)}>
          <span className="wcfg-color">
            <input
              type="color"
              className="wcfg-color-input"
              value={color || "#ffffff"}
              onChange={(e) => onChange(e.target.value)}
              aria-label={tr(def.label)}
              data-interactive
            />
            {color && (
              <button type="button" className="wcfg-mini-btn" onClick={() => onChange("")} data-interactive>
                {tr("重置")}
              </button>
            )}
          </span>
        </Row>
      );
    }
    case "zones":
      return (
        <ZonesEditor
          label={tr(def.label)}
          zones={(Array.isArray(value) ? value : []).filter((z): z is string => typeof z === "string")}
          onChange={onChange}
        />
      );
    default:
      return null;
  }
}

function Row({ label, stack, children }: { label: string; stack?: boolean; children: React.ReactNode }) {
  return (
    <div className={`wcfg-row${stack ? " wcfg-row-stack" : ""}`}>
      <span className="wcfg-label">{label}</span>
      <span className="wcfg-control">{children}</span>
    </div>
  );
}

/** quick 滑条拖动期只进草稿、松手一次提交（useSliderDraft）——此前逐
 *  input 事件都走 commit（zod sanitize + update 落盘 + 跨窗广播），拖一次
 *  触发几十轮；本文件透明度滑条的「瞬态预览 + onCommitEnd 提交」是同款先例。
 *  Stepper 是离散控件，维持原样。 */
function DraftSlider({
  label,
  value,
  min,
  max,
  step,
  suffix,
  onCommit
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  suffix: string;
  onCommit: (v: number) => void;
}) {
  const draft = useSliderDraft(onCommit);
  return (
    <Slider
      label={label}
      value={draft.draft ?? value}
      min={min}
      max={max}
      step={step}
      suffix={suffix}
      onChange={draft.slide}
      onCommitEnd={draft.commitEnd}
    />
  );
}

/* ------------------------------------------------------------------ */
/*  样式预设卡：存当前样式 / 套用同类型预设            */
/* ------------------------------------------------------------------ */

function PresetRow({ instanceId, widgetType }: { instanceId: string; widgetType: string }) {
  const tr = useT();
  const { config, update } = useWidgetConfig(instanceId);
  const inst = useWidgetStore((s) => s.instances.find((i) => i.id === instanceId));
  const updateWidget = useWidgetStore((s) => s.updateWidget);
  const [presets, setPresets] = useState<StylePreset[]>(() => listStylePresets(widgetType));
  const [selId, setSelId] = useState("");

  const refresh = () => setPresets(listStylePresets(widgetType));

  const apply = (preset: StylePreset) => {
    update(sanitizeWidgetConfig(widgetType, mergeStyleConfig(config, preset)));
    if (preset.opacity != null) updateWidget(instanceId, { opacity: preset.opacity });
  };

  const save = async () => {
    const label = await promptDialog({ title: tr("保存样式预设"), initialValue: suggestPresetName(widgetType) });
    const name = label?.trim();
    if (!name) return;
    const preset = saveStylePreset({ widgetType, name, config, opacity: inst?.opacity ?? null });
    refresh();
    setSelId(preset.id);
  };

  const remove = async (preset: StylePreset) => {
    if (
      !(await confirmDialog({
        title: tr("删除样式预设"),
        /* 整句模板 + {name} 占位符——拼接式（「确定删除预设「」+名+「」吗？」）
           的语序在英文里不成立，占位符模板才能给出自然译文。 */
        message: tr("确定删除预设「{name}」吗？", { name: preset.name }),
        danger: true
      }))
    )
      return;
    deleteStylePreset(preset.id);
    refresh();
    setSelId("");
  };

  /* 预设包导入 / 导出（Rust zip 加固校验 + 前端
     zod 重清洗 + 同名跳过；浏览器模式不显示）。 */
  const exportPackage = async () => {
    if (listStylePresets().length === 0) {
      void alertDialog({ title: tr("暂无可导出的预设") });
      return;
    }
    try {
      const saved = await invoke<string | null>("export_preset_package", { presetsJson: exportPresetsJson() });
      if (saved) pushAppToast(tr("已导出预设包"), saved, "info");
    } catch (e) {
      void alertDialog({ title: tr("导出失败"), message: e instanceof Error ? e.message : String(e) });
    }
  };
  const importPackage = async () => {
    try {
      const raw = await invoke<string | null>("import_preset_package");
      if (raw == null) return;
      const r = importPresetsFromPackage(raw);
      refresh();
      pushAppToast(tr("预设包已导入"), `${r.added} ${tr("项新增")} · ${r.skipped} ${tr("项跳过")}`, "info");
    } catch (e) {
      void alertDialog({ title: tr("导入失败"), message: e instanceof Error ? e.message : String(e) });
    }
  };

  const selected = presets.find((p) => p.id === selId) ?? null;

  return (
    <>
      <div className="wcfg-divider" role="separator" />
      <div className="wcfg-row wcfg-row-stack wcfg-preset">
        <span className="wcfg-label">{tr("样式预设")}</span>
        <div className="wcfg-preset-controls">
          <select
            className="wcfg-input wcfg-preset-select"
            value={selId}
            aria-label={tr("选择样式预设")}
            data-interactive
            onChange={(e) => {
              const id = e.target.value;
              setSelId(id);
              const preset = presets.find((p) => p.id === id);
              if (preset) apply(preset);
            }}
          >
            <option value="">{presets.length > 0 ? tr("选择预设…") : tr("暂无预设")}</option>
            {presets.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <button type="button" className="wcfg-mini-btn" onClick={() => void save()} data-interactive>
            {tr("存为预设")}
          </button>
          {selected && (
            <button type="button" className="wcfg-mini-btn" onClick={() => void remove(selected)} data-interactive>
              {tr("删除")}
            </button>
          )}
          {isTauri() && (
            <>
              <button type="button" className="wcfg-mini-btn" onClick={() => void exportPackage()} data-interactive>
                {tr("导出包")}
              </button>
              <button type="button" className="wcfg-mini-btn" onClick={() => void importPackage()} data-interactive>
                {tr("导入包")}
              </button>
            </>
          )}
        </div>
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ */
/*  世界时钟时区编辑器（时钟 zones 数组字段的专用控件，从时钟遗留弹层迁入）   */
/* ------------------------------------------------------------------ */

function ZonesEditor({ label, zones, onChange }: { label: string; zones: string[]; onChange: (v: string[]) => void }) {
  const tr = useT();
  const [input, setInput] = useState("");
  const add = () => {
    const id = normalizeZoneInput(input);
    if (id && !zones.includes(id)) onChange([...zones, id]);
    setInput("");
  };
  return (
    <div className="wcfg-row wcfg-row-stack wcfg-zones">
      <span className="wcfg-label">{label}</span>
      {zones.length > 0 && (
        <ul className="wcfg-zone-list">
          {zones.map((z) => (
            <li className="wcfg-zone-item" key={z}>
              <span className="wcfg-zone-name">{z}</span>
              <button
                type="button"
                className="wcfg-zone-remove"
                onClick={() => onChange(zones.filter((x) => x !== z))}
                aria-label={tr("移除时区")}
                title={tr("移除")}
                data-interactive
              >
                <X size={11} />
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="wcfg-zone-add">
        {/* 全量时区搜索：datalist 枚举全部 IANA 时区，输入即过滤 */}
        <input
          className="wcfg-input"
          list="wcfg-all-timezones"
          value={input}
          placeholder={tr("输入或选择时区")}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              add();
            }
          }}
          aria-label={tr("添加时区")}
          data-interactive
        />
        <datalist id="wcfg-all-timezones">
          {ALL_TIMEZONES.map((z) => (
            <option key={z} value={z} />
          ))}
        </datalist>
        <button type="button" className="wcfg-mini-btn" onClick={add} data-interactive>
          {tr("添加")}
        </button>
      </div>
    </div>
  );
}
