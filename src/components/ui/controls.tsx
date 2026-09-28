/**
 * 跨层共用 UI 原语（A-2）：Stepper / Segmented / Toggle 从
 * features/settings/shared.tsx 上移至此——此前 widget 层（就地配置弹层、
 * 亮度组件、灵动岛配置面板）为借这三个控件反向 import features/settings，
 * 造成目录级双向耦合。实现原样迁移，行为零变化；设置页侧经 shared.tsx
 * 的再导出继续使用（调用方无感）。样式类名（tm-stepper / tm-segmented /
 * tm-toggle*）不变，settings.css 的既有规则继续命中。
 */
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { Minus, Plus, Sun } from "lucide-react";
import { useT } from "../../i18n-lite";
import { SpecularFrame } from "../../lib/rb";
import { useFxEffectEnabled } from "../../lib/fx";

export function Stepper({
  value,
  suffix,
  onChange,
  min,
  max
}: {
  value: number;
  suffix: string;
  onChange: (v: number) => void;
  /** B9：可选边界——越界时按钮禁用，不再静默无效。 */ min?: number;
  max?: number;
}) {
  const tr = useT();
  const [text, setText] = useState(String(value));
  const [focused, setFocused] = useState(false);
  /* #82 数值弹跳：+/- 或外部改值时给 wrap 挂一次 num-pop（类先摘再挂以重触发） */
  const [numPop, setNumPop] = useState(false);
  const prevValue = useRef(value);
  useEffect(() => {
    if (prevValue.current !== value) {
      prevValue.current = value;
      setNumPop(false);
      const raf = requestAnimationFrame(() => setNumPop(true));
      return () => cancelAnimationFrame(raf);
    }
  }, [value]);
  useEffect(() => {
    if (!focused) setText(String(value));
  }, [value, focused]);
  /* B12：非法输入（非数字）回退时给一次 shake 反馈，替代静默回退。 */
  const [invalid, setInvalid] = useState(false);
  const commit = () => {
    const n = Number(text);
    if (!Number.isNaN(n) && text.trim() !== "") onChange(n);
    else {
      setText(String(value));
      setInvalid(false);
      requestAnimationFrame(() => setInvalid(true));
    }
  };
  const atMin = min !== undefined && value <= min;
  const atMax = max !== undefined && value >= max;
  return (
    <div className={`tm-stepper${invalid ? " invalid" : ""}`}>
      <button
        className="tm-stepper-btn"
        onClick={() => onChange(value - 1)}
        disabled={atMin}
        title={atMin ? tr("已达下限") : undefined}
        aria-label={tr("减少")}
      >
        <Minus size={14} />
      </button>
      <div className={`tm-stepper-input-wrap${numPop ? " num-pop" : ""}`}>
        <input
          className="tm-stepper-input"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              commit();
              (e.target as HTMLInputElement).blur();
            }
          }}
          inputMode="numeric"
          aria-label={tr(suffix)}
        />
        <span className="tm-stepper-suffix">{tr(suffix)}</span>
      </div>
      <button
        className="tm-stepper-btn"
        onClick={() => onChange(value + 1)}
        disabled={atMax}
        title={atMax ? tr("已达上限") : undefined}
        aria-label={tr("增加")}
      >
        <Plus size={14} />
      </button>
    </div>
  );
}

export function Segmented<T extends string>({
  value,
  options,
  onChange
}: {
  value: T;
  options: { id: T; label: string; icon?: typeof Sun }[];
  onChange: (v: T) => void;
}) {
  const tr = useT();
  // specular 特效被单独关闭时不渲染选中高光框（也省掉 rb.tsx 的共享 rAF 循环）。
  const specular = useFxEffectEnabled("specular");
  /* 滑动胶囊指示条：测量激活项几何，胶囊以 transform 平滑跟随
     （与侧栏 #90 共享指示条同语言，替代逐项背景瞬切）。
     [POLISH] 双速跟随（双速跟随配方）：同一几何渲染两层
     同色胶囊——快层 50ms 先到、慢层 220ms 跟进，两层并集在过渡期形成拉伸胶囊，
     到位后重合为一。外圆角位置感知：激活段贴组两端的外侧角取全圆、内侧角取小圆
     （M3 分段控件激活段外圆角），单项组退化为整胶囊。 */
  const wrapRef = useRef<HTMLDivElement>(null);
  const [pill, setPill] = useState<{ x: number; w: number } | null>(null);
  /* Rubber Segment（同名微交互）：每次胶囊位移记录方向与距离，
     注入 --seg-dir / --seg-stretch，由 feature-fx.css 播一次「朝目标方向
     拉伸 → 弹性收拢」的气泡动画（seq 作 key 变化即重放）；CSS 侧带
     data-fx + elastic 门控，减少动态走全局兜底。仅装饰，不参与定位。 */
  const [rubber, setRubber] = useState<{ dir: 1 | -1; stretch: number; seq: number } | null>(null);
  const prevPill = useRef<{ x: number; w: number } | null>(null);
  useLayoutEffect(() => {
    const wrap = wrapRef.current;
    const el = wrap?.querySelector<HTMLElement>(".tm-segmented-item.active");
    if (!wrap || !el) {
      setPill(null);
      prevPill.current = null;
      return;
    }
    /* 用布局值 offsetLeft/offsetWidth 测量（CSSOM：相对 offsetParent 边缘的
       纯布局位），不用 getBoundingClientRect —— 后者含 transform：激活项有
       fx-seg-pop 弹入缩放（scale 0.9→1.04→1），点击瞬间测到的是动画中间值，
       快速连点时胶囊跟着测量值乱跳；offset* 不受 transform/入场动画影响，
       未变换时与 rect 差值完全等价，视觉基线不变。 */
    const next = { x: el.offsetLeft, w: el.offsetWidth };
    setPill(next);
    const prev = prevPill.current;
    prevPill.current = next;
    if (prev && (prev.x !== next.x || prev.w !== next.w)) {
      const dx = next.x - prev.x;
      setRubber((r) => ({
        dir: dx >= 0 ? 1 : -1,
        stretch: Math.min(0.5, Math.max(0.15, Math.abs(dx) / 200)),
        seq: (r?.seq ?? 0) + 1
      }));
    }
    // options 为调用方内联字面量，仅随 value 重测即可。
  }, [value]);
  /* 五.7：窗口缩放 / 界面缩放（60%–160%）后胶囊几何重测——useLayoutEffect
     只在 value 变化时测量，缩放后不点分段则胶囊停留在旧几何。 */
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      const el = wrap.querySelector<HTMLElement>(".tm-segmented-item.active");
      if (el) setPill({ x: el.offsetLeft, w: el.offsetWidth });
    });
    ro.observe(wrap);
    return () => ro.disconnect();
  }, []);
  const activeIdx = options.findIndex((o) => o.id === value);
  const isFirst = activeIdx === 0;
  const isLast = activeIdx === options.length - 1;
  const outer = "999px";
  const inner = "7px";
  const pillRadius = `${isFirst ? outer : inner} ${isLast ? outer : inner} ${isLast ? outer : inner} ${isFirst ? outer : inner}`;
  /* B7：radiogroup 语义 + 方向键切换（此前是可点击 div，键盘完全不可达）。 */
  return (
    <div className="tm-segmented" role="radiogroup" ref={wrapRef}>
      {pill &&
        (["fast", "slow"] as const).map((layer) => (
          <span
            key={layer}
            className={`tm-segmented-pill pill-${layer}${rubber ? " is-rubber" : ""}`}
            aria-hidden="true"
            style={{
              transform: `translateX(${pill.x}px)`,
              width: `${pill.w}px`,
              ...(rubber ? ({ "--seg-dir": rubber.dir, "--seg-stretch": rubber.stretch } as CSSProperties) : {})
            }}
          >
            <i key={rubber?.seq ?? 0} className="tm-segmented-pill-b" style={{ borderRadius: pillRadius }} />
          </span>
        ))}
      {options.map((o, i) => {
        const Icon = o.icon;
        return (
          <div
            key={o.id}
            className={`tm-segmented-item${value === o.id ? " active" : ""}`}
            onClick={() => onChange(o.id)}
            role="radio"
            aria-checked={value === o.id}
            tabIndex={value === o.id ? 0 : i === 0 && !options.some((x) => x.id === value) ? 0 : -1}
            onKeyDown={(e) => {
              if (e.key === "ArrowRight" || e.key === "ArrowDown") {
                e.preventDefault();
                const next = options[(i + 1) % options.length];
                onChange(next.id);
              } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
                e.preventDefault();
                const prev = options[(i - 1 + options.length) % options.length];
                onChange(prev.id);
              }
            }}
          >
            {specular && value === o.id && <SpecularFrame />}
            {Icon && <Icon size={14} />}
            {tr(o.label)}
          </div>
        );
      })}
    </div>
  );
}

export function Toggle({
  on,
  onChange,
  ariaLabel
}: {
  on: boolean;
  onChange: (v: boolean) => void;
  /** 可访问名称：开关本身无可见文字，读屏依赖此名。 */ ariaLabel?: string;
}) {
  /* [POLISH] touch target ≥48px：交互元素是 48×48 的透明按钮（命中区），
     44×24 的轨道视觉作为子元素居中——.tm-toggle/.tm-toggle-knob 类名与结构
     不变，settings / fx / 就地弹层的既有视觉规则全部继续命中；按压「拇指涨径」
     等 :active 规则挂在 wrap 上（feature-animations.css）。 */
  return (
    <button
      type="button"
      className="tm-toggle-wrap"
      onClick={() => onChange(!on)}
      role="switch"
      aria-checked={on}
      aria-label={ariaLabel}
    >
      <span className={`tm-toggle${on ? " on" : ""}`} aria-hidden="true">
        <span className="tm-toggle-knob" />
      </span>
    </button>
  );
}
