/**
 * 无实例磁贴的私有配置弹层（自 DockTile.tsx 原文迁出，行为不变）：
 * QUICK_CONFIG_FIELDS 驱动，读写 DockTile.config（setDockTileConfig，随
 * dock 配置按屏落盘）。
 *
 * 独立成 chunk 的原因：本文件静态依赖 config-schemas（32 个 zod schema）
 * 与 M3Slider（→ WakeSlider → motion/react）——DockShell 处于主 chunk，
 * 私有配置弹层只有用户右键/长按「配置」时才需要，不能随磁贴静态加载。
 * DockTile 以 lazy 壳按 open 门控引用（与 WidgetConfigPopover 同范式）。
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { useT } from "../../i18n-lite";
import { useDelayedUnmount } from "../../lib/anim";
import { animDurations } from "../../lib/durations";
import { uiZoom } from "../../lib/ui-zoom";
import { useDismissable } from "../../lib/use-dismissable";
import { useSliderDraft } from "../../lib/use-slider-draft";
import { Segmented, Stepper, Toggle } from "../../components/ui/controls";
import { M3Slider as Slider } from "../../components/ui/M3Slider";
import { defaultWidgetConfig, sanitizeWidgetConfig } from "../config-schemas";
import { QUICK_CONFIG_FIELDS, type QuickFieldDef } from "../quick-config-fields";
import { getWidgetMeta } from "../registry";
import { useWidgetStore, type DockTile as DockTileModel } from "../widget-store";
import type { WidgetConfig } from "../widget-config";
import { placePopover, type PopoverAnchor } from "../WidgetConfigPopover";

export function DockTileConfigPopover({
  tile,
  anchor,
  open,
  onClose
}: {
  tile: DockTileModel;
  anchor: PopoverAnchor;
  open: boolean;
  onClose: () => void;
}) {
  const tr = useT();
  const meta = getWidgetMeta(tile.type);
  const setDockTileConfig = useWidgetStore((s) => s.setDockTileConfig);
  const visible = useDelayedUnmount(open, animDurations().fxFastMs);
  const closing = !open && visible;
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<ReturnType<typeof placePopover> | null>(null);
  const fields = QUICK_CONFIG_FIELDS[tile.type] ?? [];
  const defaults = useMemo(() => defaultWidgetConfig(tile.type), [tile.type]);
  /* 读：过 schema 洗掉损坏字段、补默认；写：合并后再过一遍 schema 落盘（与 弹层同协议）。 */
  const clean = useMemo(() => sanitizeWidgetConfig(tile.type, tile.config ?? {}), [tile.type, tile.config]);
  const commit = (patch: Partial<WidgetConfig>) =>
    setDockTileConfig(tile.id, sanitizeWidgetConfig(tile.type, { ...clean, ...patch }));

  useLayoutEffect(() => {
    const el = ref.current;
    if (!visible || !el) return;
    /* 锚点来自磁贴 gBCR（**视觉**坐标，界面缩放下 = 布局 × uiZoom）——除回
       布局单位再交给 placePopover（fixed left/top 渲染会再乘 zoom，不换算
       时弹层随缩放漂移）；offsetWidth / innerWidth 本就是未缩放值。 */
    const z = uiZoom();
    const a = anchor;
    setPos(
      placePopover(
        { x: a.x / z, y: a.y / z, w: a.w / z, h: a.h / z },
        { w: el.offsetWidth, h: el.offsetHeight },
        { w: window.innerWidth, h: window.innerHeight }
      )
    );
  }, [visible, anchor]);

  useEffect(() => {
    if (!open) return;
    const raf = requestAnimationFrame(() => ref.current?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(raf);
  }, [open]);
  /* 统一关闭骨架：Esc capture 抢先 + 外点 pointerdown capture。 */
  useDismissable(open, ref, onClose);

  if (!visible || !meta) return null;

  const style: CSSProperties = pos
    ? { left: pos.left, top: pos.top, transformOrigin: pos.below ? "top center" : "bottom center" }
    : { left: -9999, top: -9999 };

  return createPortal(
    <div
      ref={ref}
      className={`wcfg-popover dock-tile-cfg${closing ? " is-closing" : ""}${pos?.below ? " is-below" : ""}`}
      role="dialog"
      aria-label={`${tr(meta.name)} ${tr("配置")}`}
      tabIndex={-1}
      data-interactive
      style={style}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => {
        if ((e.target as HTMLElement).closest("input, textarea")) return;
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }}
    >
      <div className="wcfg-header">
        <span className="wcfg-title">{tr(meta.name)}</span>
        <button type="button" className="wcfg-close" onClick={onClose} aria-label={tr("关闭")} data-interactive>
          <X size={13} />
        </button>
      </div>
      <div className="wcfg-body">
        {fields.map((f) => (
          <PrivateFieldRow
            key={f.key}
            def={f}
            value={clean[f.key]}
            fallback={defaults[f.key]}
            onChange={(v) => commit({ [f.key]: v })}
          />
        ))}
      </div>
    </div>,
    document.body
  );
}

function PrivateRow({ label, stack, children }: { label: string; stack?: boolean; children: ReactNode }) {
  return (
    <div className={`wcfg-row${stack ? " wcfg-row-stack" : ""}`}>
      <span className="wcfg-label">{label}</span>
      <span className="wcfg-control">{children}</span>
    </div>
  );
}

/** quick 滑条拖动期只进草稿、松手一次提交（useSliderDraft）——此前逐
 *  input 事件都走 onChange 提交链（zod sanitize + setDockTileConfig →
 * saveDock 的 LS 双写 + SQLite 镜像 + 80ms 防抖跨窗广播），拖一次触发几十轮；
 * Stepper 是离散控件，维持原样。 */
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

/** quick 字段渲染（toggle / segment / slider / stepper / color；zones 仅时钟实例有意义，私有配置不提供）。 */
function PrivateFieldRow({
  def,
  value,
  fallback,
  onChange
}: {
  def: QuickFieldDef;
  value: unknown;
  fallback: unknown;
  onChange: (v: unknown) => void;
}) {
  const tr = useT();
  switch (def.kind) {
    case "toggle": {
      const on = fallback === true ? value !== false : value === true;
      return (
        <PrivateRow label={tr(def.label)}>
          <Toggle on={on} onChange={onChange} ariaLabel={tr(def.label)} />
        </PrivateRow>
      );
    }
    case "segment": {
      const v = def.options.some((o) => o.id === value) ? (value as string) : String(fallback);
      return (
        <PrivateRow label={tr(def.label)} stack={def.options.length > 3}>
          <Segmented value={v} options={def.options} onChange={onChange} />
        </PrivateRow>
      );
    }
    case "slider":
    case "stepper": {
      const raw = typeof value === "number" && Number.isFinite(value) ? value : (fallback as number);
      const num = Math.min(Math.max(raw, def.min), def.max);
      return (
        <PrivateRow label={tr(def.label)}>
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
        </PrivateRow>
      );
    }
    case "color": {
      const color = typeof value === "string" ? value : "";
      return (
        <PrivateRow label={tr(def.label)}>
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
        </PrivateRow>
      );
    }
    default:
      return null;
  }
}
