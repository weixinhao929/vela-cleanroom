/**
 * 滑条（WakeSlider 集成）：波形手感、弹簧物理全部由基础
 * WakeSlider 组件承担（components/WakeSlider.tsx，motion 驱动）。本文件只是
 * 设置行适配层——沿用既有调用方 API（value/min/max/step/suffix/label/onChange），
 * 映射主题色与设置行尺寸，挂在 .tm-slider-row 上以继承两窗的宽度约束
 * （feature-polish.css 的 .wake-slider.tm-slider-row）。
 * A-2：自 features/settings 上移 components/ui（widget 层为借它反向 import
 * features 的目录级耦合源头之一）；settings 侧经 shared.tsx 以 `Slider` 名
 * 再导出，原调用点不改一行。
 */
import WakeSlider from "../WakeSlider";
import { useT } from "../../i18n-lite";

export function M3Slider({
  value,
  min,
  max,
  step = 1,
  suffix = "",
  label,
  variant = "default",
  onChange,
  onCommitEnd
}: {
  value: number;
  min: number;
  max: number;
  step?: number;
  suffix?: string;
  /** 可访问名称：与所在设置行标题同文案（读屏依赖）。 */
  label?: string;
  /** mini：灵动岛迷你磁贴紧凑档（12 条 / 24px 轨道 / 6px 静息高）。 */
  variant?: "default" | "mini";
  onChange: (v: number) => void;
  /** 提交会话结束（松手 / 键盘步进后），透传 WakeSlider。 */
  onCommitEnd?: () => void;
}) {
  const tr = useT();
  const shownSuffix = suffix ? tr(suffix) : "";
  const mini = variant === "mini";
  return (
    <WakeSlider
      className="tm-slider-row"
      value={value}
      min={min}
      max={max}
      step={step}
      bars={mini ? 12 : 26}
      height={mini ? 24 : 26}
      restHeight={mini ? 6 : 10}
      gap={mini ? 1 : 2}
      fillColor="var(--accent)"
      trackColor="var(--track)"
      showValue
      formatValue={(v) => `${v}${shownSuffix}`}
      ariaLabel={label ? tr(label) : tr("数值")}
      onChange={onChange}
      onCommitEnd={onCommitEnd}
    />
  );
}
