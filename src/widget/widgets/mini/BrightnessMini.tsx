/**
 * 亮度迷你磁贴（ISLAND-MINI）：M3Slider 紧凑档控「当前屏」亮度。
 * 当前屏 = list_brightness_monitors 首个 supported 的显示器（与 BrightnessWidget
 * 同枚举源）；首次 active 后只拉一次列表，无轮询。拖动走 set_brightness（Rust
 * 侧 300ms 防抖，与 BrightnessWidget 同命令），本地乐观值跟手不回读。
 * 滑条位于磁贴 <button> 内：pointer / click / key 一律 stopPropagation，避免
 * 拖动触发磁贴展开或方向键冒泡到磁贴层。紧凑尺寸由 MINI 区段样式覆盖。
 */
import { useEffect, useRef, useState, type SyntheticEvent } from "react";
import { SunDim } from "lucide-react";
import { M3Slider } from "../../../components/ui/M3Slider";
import { invoke, isTauri } from "../../../lib/tauri";
import type { MiniComponentProps } from "../../registry";

type Monitor = { key: string; label: string; supported: boolean; current: number | null };

const stop = (e: SyntheticEvent) => e.stopPropagation();

export function BrightnessMini({ active }: MiniComponentProps) {
  const [monitor, setMonitor] = useState<Monitor | null>(null);
  const [value, setValue] = useState<number | null>(null);
  const requested = useRef(false);

  useEffect(() => {
    if (!active || requested.current || !isTauri()) return;
    // （一次性拉取不重试）：requested 只在成功回调里置位——失败后磁贴永远
    // 显示 "—"；active 再次翻转（磁贴重新可见）即重拉。
    void invoke<Monitor[]>("list_brightness_monitors")
      .then((rows) => {
        requested.current = true;
        const m = rows.find((r) => r.supported) ?? null;
        setMonitor(m);
        setValue(m?.current ?? null);
      })
      .catch(() => {});
  }, [active]);

  const onChange = (v: number) => {
    setValue(v);
    if (monitor) void invoke("set_brightness", { key: monitor.key, value: v }).catch(() => {});
  };

  return (
    <span className="dock-mini dock-mini-brightness">
      <SunDim size={13} className="dock-mini-ico" />
      {monitor ? (
        <span className="dock-mini-slider" onClick={stop} onPointerDown={stop} onKeyDown={stop} data-interactive>
          <M3Slider
            variant="mini"
            value={Math.round(value ?? 100)}
            min={0}
            max={100}
            step={1}
            suffix="%"
            label="亮度"
            onChange={onChange}
          />
        </span>
      ) : (
        <span className="dock-mini-num">—</span>
      )}
    </span>
  );
}
