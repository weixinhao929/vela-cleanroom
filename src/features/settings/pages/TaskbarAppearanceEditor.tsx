/**
 * 设置页 · 任务栏（TB-UI）：单套外观编辑器——（深拆）自
 * TaskbarPage.tsx 拆出。StateCard 与 RuleList（含非前台外观）复用本编辑器。
 *
 * accent 五选一 → 颜色 + 透明度 → 模糊半径（仅 blur）→ 顶线 / Peek 开关。能力未知
 * （尚无 taskbar:capabilities）时按目标机 XAML 渲染：顶线可用、Peek 隐藏、blur 可选；
 * 能力已知则按 隐藏不可用项。
 *
 * 即时预览：每次改动除写切片（350ms 防抖后整包 apply 落盘）外，还经 `onPreview`
 * 走预览通道立即下发——滑条拖动中 React 的 onChange 即原生 input 事件、逐帧触发，
 * Rust 侧按 ≤80ms 步进合并；独立复用本编辑器且未传 `onPreview` 的调用点则只写切片。
 *
 * 透明度 / 模糊半径滑条拖动期只进本地草稿 + 直发预览（onPreview 与
 * store 无关，直调即可保住实时预览），松手（onCommitEnd）才 patch 进切片
 * 一次——此前逐帧 patch 触发整页（7 张状态卡 + 规则编辑器）重渲 + 切片
 * sanitize；键盘步进是 onChange + onCommitEnd 同拍触发，行为不变。
 *
 * 提交竞态：onChange 只传本次改动的字段（Partial），由上层在提交时
 * 现取最新切片 merge（StateCard → TaskbarPage.setState / 规则 →
 * patchRuleAppearance）。此前 `onChange({ ...value, ...p })` 的 value 是渲染
 * 快照——拖动期间跨窗同步改了同切片其它字段时，松手提交会把整对象覆盖
 * 回去；透明度与模糊半径两条滑杆同修。
 */
import type { ReactNode } from "react";
import { Droplets, Eye, Minus, Palette, Ruler, SlidersHorizontal } from "lucide-react";
import { useSliderDraft } from "../../../lib/use-slider-draft";
import { useT } from "../../../i18n-lite";
import {
  DEFAULT_TASKBAR_APPEARANCE,
  normalizeTaskbarColor,
  type TaskbarAccent,
  type TaskbarAppearance
} from "../../../store/settings-store";
import type { TaskbarCapabilities } from "../../../types/bindings/TaskbarCapabilities";
import { ColorRow, Segmented, SettingRow, Toggle } from "../shared";
import { M3Slider as Slider } from "../../../components/ui/M3Slider";

/** 分段 / 下拉自身无 aria-label，用行标题命名（与 DockPage.Ctl 同法）。任务栏
 *  一族三处（效果 / 匹配类型 / 正在编辑）共用，随本文件导出供兄弟模块取用。 */
export function Ctl({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="tm-dock-ctl" role="group" aria-label={label}>
      {children}
    </div>
  );
}

/** accent 五值文案（§1.1 表；normal = 恢复系统默认外观）。 */
const ACCENT_OPTIONS: { id: TaskbarAccent; label: string }[] = [
  { id: "normal", label: "默认" },
  { id: "opaque", label: "不透明" },
  { id: "clear", label: "透明" },
  { id: "blur", label: "模糊" },
  { id: "acrylic", label: "亚克力" }
];

/** 切片存 `#rrggbbaa`；原生取色器只认 `#rrggbb`，透明度单独走 0–100% 滑条。 */
function splitColor(color: string): { rgb: string; alphaPct: number } {
  const full = normalizeTaskbarColor(color) ?? DEFAULT_TASKBAR_APPEARANCE.color;
  return { rgb: full.slice(0, 7), alphaPct: Math.round((parseInt(full.slice(7, 9), 16) / 255) * 100) };
}

/** 取色器 / 手输的 3、4、6、8 位 hex + 透明度百分比 → 统一 8 位小写存储。 */
function joinColor(rgb: string, alphaPct: number): string {
  const base = normalizeTaskbarColor(rgb) ?? DEFAULT_TASKBAR_APPEARANCE.color;
  const alpha = Math.round((Math.max(0, Math.min(100, alphaPct)) / 100) * 255);
  return `${base.slice(0, 7)}${alpha.toString(16).padStart(2, "0")}`;
}

export function AppearanceEditor({
  value,
  onChange,
  onPreview,
  caps,
  defaultColor = DEFAULT_TASKBAR_APPEARANCE.color
}: {
  value: TaskbarAppearance;
  /** 只传本次改动的字段；调用方负责现取最新值再 merge（见上方提交竞态说明）。 */
  onChange: (patch: Partial<TaskbarAppearance>) => void;
  onPreview?: (next: TaskbarAppearance) => void;
  caps: TaskbarCapabilities | null;
  defaultColor?: string;
}) {
  const tr = useT();
  const { rgb, alphaPct } = splitColor(value.color);
  const patch = (p: Partial<TaskbarAppearance>) => {
    onPreview?.({ ...value, ...p });
    onChange(p);
  };
  const accentOptions = ACCENT_OPTIONS.filter(
    (o) => o.id !== "blur" || !caps || caps.supportsBlur || value.accent === "blur"
  );
  const showLine = !caps || caps.supportsLine;
  const showPeek = Boolean(caps?.supportsPeek);
  /* 滑条草稿：slide 只写草稿 + 直发预览；commitEnd 一次 patch 进切片。 */
  const alpha = useSliderDraft((v) => patch({ color: joinColor(rgb, v) }));
  const slideAlpha = (v: number) => {
    alpha.slide(v);
    onPreview?.({ ...value, color: joinColor(rgb, v) });
  };
  const blur = useSliderDraft((v) => patch({ blurRadius: Math.round(v) }));
  const slideBlur = (v: number) => {
    blur.slide(v);
    onPreview?.({ ...value, blurRadius: Math.round(v) });
  };
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
          value={alpha.draft ?? alphaPct}
          min={0}
          max={100}
          step={1}
          suffix="%"
          onChange={slideAlpha}
          onCommitEnd={alpha.commitEnd}
        />
      </SettingRow>
      {value.accent === "blur" && (
        <SettingRow icon={Ruler} title="模糊半径" desc="越大越朦胧">
          <Slider
            label="模糊半径"
            value={blur.draft ?? value.blurRadius}
            min={0}
            max={750}
            step={1}
            suffix="px"
            onChange={slideBlur}
            onCommitEnd={blur.commitEnd}
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
