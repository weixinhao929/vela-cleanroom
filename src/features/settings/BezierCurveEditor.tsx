/**
 * B3 贝塞尔曲线编辑器（动画页「自定义曲线」）。
 *
 * 结构：左侧 SVG 画板（网格 + 对角参考线 + 曲线 + 两个可拖控制点 + 循环
 * 播放的 playhead）与下方水平演示道（小球按曲线映射的进度平移）；右侧
 * 预设芯片、四个数值输入、CSS 串与合法性状态。
 *
 * 提交闸门（曲线有效性校验）：只有 lib/bezier.bezierValidity
 * 通过的曲线才回调 onChange；拖拽时 X 被夹在 [0,1]（Y 允许 -0.5~1.5 表达
 * 过冲），故拖拽永远合法；数值框可键入越界值，提交时拒绝并给出原因，
 * 画板以红色曲线 + 状态行抖动提示，已保存值不变。
 *
 * playhead 用 rAF 直写 DOM 属性（不走 React 状态，60fps 不重渲）；
 * reduce-motion 双信号命中时不自动循环，「播放」只跑单趟；页面隐藏暂停。
 */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent
} from "react";
import { Pause, Play } from "lucide-react";
import {
  BEZIER_PRESETS,
  bezierEase,
  bezierValidity,
  toCubicBezierCss,
  type BezierInvalidReason,
  type BezierPoints
} from "../../lib/bezier";
import { prefersReducedMotion } from "../../lib/anim";
import { useT } from "../../i18n-lite";

/** 画板逻辑尺寸（SVG viewBox），CSS 决定实际像素。 */
const PAD = 200;
/** Y 轴可视域 [-0.5, 1.5]：为过冲/回拉曲线留出上下各半格。 */
const Y_MIN = -0.5;
const Y_MAX = 1.5;
/** 单趟播放 1000ms + 尾部停顿 400ms。 */
const TRAVEL_MS = 1000;
const PERIOD_MS = 1400;

const toPx = (x: number, y: number) => ({
  px: x * PAD,
  py: ((Y_MAX - y) / (Y_MAX - Y_MIN)) * PAD
});

const INVALID_TEXT: Record<BezierInvalidReason, string> = {
  "not-finite": "数值无效",
  "x-out-of-range": "X 需在 0~1 之间",
  "non-monotonic": "曲线非单调（x 回头）"
};

function samePoints(a: BezierPoints, b: BezierPoints): boolean {
  return a.every((v, i) => Math.abs(v - b[i]) < 1e-9);
}

export function BezierCurveEditor({
  value,
  onChange,
  enabled = true
}: {
  /** 已保存（合法）的控制点。 */
  value: BezierPoints;
  /** 仅在曲线合法时回调。 */
  onChange: (p: BezierPoints) => void;
  /** 仅影响提示文案：未启用时说明曲线暂不作用于入场。 */
  enabled?: boolean;
}) {
  const tr = useT();
  /* draft：正在编辑（拖拽中 / 键入中）的控制点；value 外部变化时同步。 */
  const [draft, setDraft] = useState<BezierPoints>(value);
  useEffect(() => {
    setDraft((d) => (samePoints(d, value) ? d : value));
  }, [value]);
  const validity = bezierValidity(draft);
  const [rejected, setRejected] = useState<BezierInvalidReason | null>(null);
  const [shake, setShake] = useState(0);

  /* 四个数值框各自持有文本（允许中间态如 "0."），失焦/Enter 提交。 */
  const [texts, setTexts] = useState<string[]>(() => draft.map((v) => String(v)));
  const focusedIdx = useRef<number | null>(null);
  useEffect(() => {
    setTexts((t) => t.map((s, i) => (focusedIdx.current === i ? s : String(Math.round(draft[i] * 1000) / 1000))));
  }, [draft]);

  const commit = useCallback(
    (p: BezierPoints) => {
      const v = bezierValidity(p);
      if (v.ok) {
        setRejected(null);
        if (!samePoints(p, value)) onChange(p);
        return true;
      }
      setRejected(v.reason);
      setShake((k) => k + 1);
      return false;
    },
    [onChange, value]
  );

  /* ---- 拖拽控制点 ---- */
  const svgRef = useRef<SVGSVGElement | null>(null);
  const dragIdx = useRef<0 | 1 | null>(null);
  /* 拖拽期间的最新草稿：pointerup 提交时不依赖 React 是否已完成上一次
     pointermove 的渲染（事件任务之间通常有渲染，但不作假设）。 */
  const latestDraft = useRef<BezierPoints>(draft);
  latestDraft.current = draft;
  const pointFromEvent = (e: { clientX: number; clientY: number }) => {
    const r = svgRef.current?.getBoundingClientRect();
    if (!r || r.width === 0) return null;
    const x = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    const yRaw = Y_MAX - ((e.clientY - r.top) / r.height) * (Y_MAX - Y_MIN);
    const y = Math.min(Y_MAX, Math.max(Y_MIN, yRaw));
    return { x: Math.round(x * 1000) / 1000, y: Math.round(y * 1000) / 1000 };
  };
  const onHandleDown = (idx: 0 | 1) => (e: ReactPointerEvent<SVGCircleElement>) => {
    e.preventDefault();
    dragIdx.current = idx;
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
  };
  const onHandleMove = (e: ReactPointerEvent<SVGCircleElement>) => {
    const idx = dragIdx.current;
    if (idx === null) return;
    const p = pointFromEvent(e);
    if (!p) return;
    const d = latestDraft.current;
    const next: [number, number, number, number] = [d[0], d[1], d[2], d[3]];
    next[idx * 2] = p.x;
    next[idx * 2 + 1] = p.y;
    latestDraft.current = next;
    setDraft(next);
  };
  const onHandleUp = (e: ReactPointerEvent<SVGCircleElement>) => {
    if (dragIdx.current === null) return;
    dragIdx.current = null;
    (e.currentTarget as Element).releasePointerCapture(e.pointerId);
    commit(latestDraft.current);
  };
  const onHandleKey = (idx: 0 | 1) => (e: ReactKeyboardEvent<SVGCircleElement>) => {
    const step = e.shiftKey ? 0.1 : 0.01;
    let dx = 0;
    let dy = 0;
    if (e.key === "ArrowLeft") dx = -step;
    else if (e.key === "ArrowRight") dx = step;
    else if (e.key === "ArrowUp") dy = step;
    else if (e.key === "ArrowDown") dy = -step;
    else return;
    e.preventDefault();
    const next: [number, number, number, number] = [draft[0], draft[1], draft[2], draft[3]];
    next[idx * 2] = Math.min(1, Math.max(0, Math.round((next[idx * 2] + dx) * 1000) / 1000));
    next[idx * 2 + 1] = Math.min(Y_MAX, Math.max(Y_MIN, Math.round((next[idx * 2 + 1] + dy) * 1000) / 1000));
    setDraft(next);
    commit(next);
  };

  /* ---- 数值框 ---- */
  const commitTexts = (nextTexts: string[]) => {
    const nums = nextTexts.map((s) => Number(s.trim()));
    const p: BezierPoints = [nums[0], nums[1], nums[2], nums[3]];
    setDraft(p);
    commit(p);
  };

  /* ---- 播放头 ---- */
  const [playing, setPlaying] = useState(() => !prefersReducedMotion());
  const headRef = useRef<SVGCircleElement | null>(null);
  const ballRef = useRef<HTMLSpanElement | null>(null);
  const laneRef = useRef<HTMLDivElement | null>(null);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    const start = performance.now();
    const singlePass = prefersReducedMotion();
    /* raf: ok 一次性预览，singlePass 播完即止 */
    const frame = (now: number) => {
      const elapsed = now - start;
      if (singlePass && elapsed >= TRAVEL_MS) {
        paint(1);
        setPlaying(false);
        return;
      }
      const phase = elapsed % PERIOD_MS;
      paint(Math.min(1, phase / TRAVEL_MS));
      raf = requestAnimationFrame(frame);
    };
    const paint = (x: number) => {
      const p = draftRef.current;
      const y = bezierValidity(p).ok ? bezierEase(p, x) : x;
      const { px, py } = toPx(x, y);
      headRef.current?.setAttribute("cx", px.toFixed(2));
      headRef.current?.setAttribute("cy", py.toFixed(2));
      const lane = laneRef.current;
      const ball = ballRef.current;
      if (lane && ball) {
        const travel = lane.clientWidth - ball.offsetWidth;
        ball.style.transform = `translateX(${(y * travel).toFixed(1)}px)`;
      }
    };
    const onVis = () => {
      if (document.hidden) cancelAnimationFrame(raf);
      else raf = requestAnimationFrame(frame);
    };
    document.addEventListener("visibilitychange", onVis);
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [playing]);

  /* ---- 几何 ---- */
  const p0 = toPx(0, 0);
  const p3 = toPx(1, 1);
  const c1 = toPx(draft[0], draft[1]);
  const c2 = toPx(draft[2], draft[3]);
  const path = `M ${p0.px} ${p0.py} C ${c1.px} ${c1.py}, ${c2.px} ${c2.py}, ${p3.px} ${p3.py}`;
  const gridLines = [0, 0.25, 0.5, 0.75, 1];
  const css = toCubicBezierCss(draft);
  const activePreset = BEZIER_PRESETS.find((pr) => samePoints(pr.points, draft))?.id ?? null;
  const statusText = rejected
    ? tr(INVALID_TEXT[rejected])
    : !validity.ok
      ? tr(INVALID_TEXT[validity.reason])
      : enabled
        ? tr("曲线合法，已作用于小组件入场")
        : tr("曲线合法（打开上方开关后作用于小组件入场）");

  return (
    <div className={`tm-bezier${validity.ok ? "" : " is-invalid"}`}>
      <div className="tm-bezier-stage">
        <svg
          ref={svgRef}
          className="tm-bezier-pad"
          viewBox={`0 0 ${PAD} ${PAD}`}
          role="img"
          aria-label={tr("缓动曲线画板")}
        >
          {gridLines.map((g) => {
            const { py } = toPx(0, g);
            return (
              <g key={g}>
                <line className="tm-bezier-grid" x1={0} x2={PAD} y1={py} y2={py} />
                <line className="tm-bezier-grid" y1={0} y2={PAD} x1={g * PAD} x2={g * PAD} />
              </g>
            );
          })}
          {/* 0 与 1 两条基线加重：越出即为过冲/回拉 */}
          <line className="tm-bezier-base" x1={0} x2={PAD} y1={toPx(0, 0).py} y2={toPx(0, 0).py} />
          <line className="tm-bezier-base" x1={0} x2={PAD} y1={toPx(0, 1).py} y2={toPx(0, 1).py} />
          <line className="tm-bezier-diag" x1={p0.px} y1={p0.py} x2={p3.px} y2={p3.py} />
          <line className="tm-bezier-arm" x1={p0.px} y1={p0.py} x2={c1.px} y2={c1.py} />
          <line className="tm-bezier-arm" x1={p3.px} y1={p3.py} x2={c2.px} y2={c2.py} />
          <path className="tm-bezier-curve" d={path} />
          <circle className="tm-bezier-end" cx={p0.px} cy={p0.py} r={3.5} />
          <circle className="tm-bezier-end" cx={p3.px} cy={p3.py} r={3.5} />
          <circle ref={headRef} className="tm-bezier-head" cx={p0.px} cy={p0.py} r={4.5} aria-hidden="true" />
          {([0, 1] as const).map((idx) => {
            const c = idx === 0 ? c1 : c2;
            return (
              <circle
                /* C-12：两个控制点是固定二元组，用语义键代替下标。 */
                key={idx === 0 ? "handle-c1" : "handle-c2"}
                className="tm-bezier-handle"
                cx={c.px}
                cy={c.py}
                r={9}
                tabIndex={0}
                role="slider"
                aria-label={idx === 0 ? tr("控制点 1") : tr("控制点 2")}
                aria-valuetext={`${draft[idx * 2]}, ${draft[idx * 2 + 1]}`}
                onPointerDown={onHandleDown(idx)}
                onPointerMove={onHandleMove}
                onPointerUp={onHandleUp}
                onPointerCancel={onHandleUp}
                onKeyDown={onHandleKey(idx)}
                data-interactive
              />
            );
          })}
        </svg>
        <div className="tm-bezier-lane" ref={laneRef} aria-hidden="true">
          <span className="tm-bezier-ball" ref={ballRef} />
        </div>
      </div>

      <div className="tm-bezier-side">
        <div className="tm-bezier-presets" role="list">
          {BEZIER_PRESETS.map((pr) => (
            <button
              key={pr.id}
              type="button"
              className={`tm-bezier-chip${activePreset === pr.id ? " active" : ""}`}
              onClick={() => {
                setDraft(pr.points);
                commit(pr.points);
              }}
              data-interactive
            >
              {tr(pr.label)}
            </button>
          ))}
        </div>
        <div className="tm-bezier-inputs">
          {(["x1", "y1", "x2", "y2"] as const).map((name, i) => (
            <label key={name} className="tm-bezier-field">
              <span>{name}</span>
              <input
                className="tm-text-input tm-bezier-input"
                inputMode="decimal"
                value={texts[i]}
                aria-label={name}
                onFocus={() => {
                  focusedIdx.current = i;
                }}
                onChange={(e) => {
                  const next = texts.slice();
                  next[i] = e.target.value;
                  setTexts(next);
                }}
                onBlur={() => {
                  focusedIdx.current = null;
                  commitTexts(texts);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    commitTexts(texts);
                    (e.target as HTMLInputElement).blur();
                  } else if (e.key === "Escape") {
                    setTexts(draft.map((v) => String(v)));
                    (e.target as HTMLInputElement).blur();
                  }
                }}
              />
            </label>
          ))}
        </div>
        <code className="tm-bezier-css" title={tr("当前曲线的 CSS 值")}>
          {css}
        </code>
        <div className="tm-bezier-foot">
          <span
            key={shake}
            className={`tm-bezier-status${validity.ok && !rejected ? "" : " bad"}${shake ? " shake" : ""}`}
            role="status"
          >
            {statusText}
          </span>
          <button
            type="button"
            className="tm-btn-ghost tm-bezier-play"
            onClick={() => setPlaying((p) => !p)}
            aria-label={playing ? tr("暂停预览") : tr("播放预览")}
            data-interactive
          >
            {playing ? <Pause size={14} /> : <Play size={14} />}
          </button>
        </div>
      </div>
    </div>
  );
}
