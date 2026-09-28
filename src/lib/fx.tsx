/* eslint-disable react-refresh/only-export-components */
/**
 * 增强动效基础设施（配合 settings → 动画 → 动效模式「增强」档）。
 *
 * 全部动效仅在动效模式为增强（html[data-fx="1"]）时激活；系统
 * prefers-reduced-motion 时 JS 侧特效一并禁用，CSS 侧由全局
 * [data-reduce-motion] 门控兜底。这里提供四类可复用件：
 *  - FxText：逐字 Blur / Pullup 入场（BlurText / Letter Pullup）
 *  - FxDecrypt：文字乱码解密切换（Decrypt Text）
 *  - FxCount：数值滚动（Count Up）
 *  - FxController：document 级委托监听，实现磁性按钮（Magnet）与
 *    卡片聚光跟随（Spotlight），无需在每个组件上挂 ref。
 */
import { useEffect, useState, type ReactNode } from "react";
import { useSettingsStore, type FxEffectId } from "../store/settings-store";
import { useCountUp, usePrefersReducedMotion } from "./anim";

/**
 * 增强动效总开关是否生效（hook）。
 * 条件：动效模式 = 增强 且 系统未开启减少动态（C11 实时响应，此前为
 * 模块级一次性快照）。
 *
 * @returns true 表示可播放增强动效。
 * @throws 无。
 */
export function useFxEnabled(): boolean {
  const reduced = usePrefersReducedMotion();
  return useSettingsStore((s) => !reduced && s.extra.enableAnimations && s.extra.animationMode === "enhanced");
}

/**
 * 单个特效是否生效（hook）。
 * 增强总开关开启且该特效未被「特效管理」单独关闭（fxToggles 只存显式
 * 覆盖项，缺省 = 开启；与 CSS 侧 html[data-fx-off~=id] 消费同一份开关，
 * JS/CSS 行为始终一致）。
 *
 * @param id - 特效标识（FxEffectId）。
 * @returns true 表示该特效应播放。
 * @throws 无。
 */
export function useFxEffectEnabled(id: FxEffectId): boolean {
  const reduced = usePrefersReducedMotion();
  return useSettingsStore(
    (s) =>
      !reduced && s.extra.enableAnimations && s.extra.animationMode === "enhanced" && s.extra.fxToggles[id] !== false
  );
}

/* ------------------------------------------------------------------ */
/* FxText：逐字入场                                                     */
/* ------------------------------------------------------------------ */

/**
 * 逐字入场文字组件。textFx 关闭时原样渲染纯文本，零开销零风险；
 * 开启时逐字符包 span，由 CSS 按 `--i` 做级联延迟动画（aria-label 保留
 * 完整文本供读屏）。
 *
 * @param text - 显示文本。
 * @param mode - 动画风格："blur" 模糊浮现 / "pullup" 上浮，默认 "blur"。
 * @param className - 追加到外层 span 的类名。
 * @returns React 节点。
 */
export function FxText({
  text,
  mode = "blur",
  className
}: {
  text: string;
  mode?: "blur" | "pullup";
  className?: string;
}) {
  const fx = useFxEffectEnabled("textFx");
  if (!fx || !text) return <>{text}</>;
  return (
    <span className={`fx-word fx-${mode}${className ? ` ${className}` : ""}`} aria-label={text}>
      {Array.from(text).map((ch, i) => (
        <span key={`${i}-${ch}`} aria-hidden="true" style={{ ["--i" as string]: i }}>
          {ch === " " ? "\u00A0" : ch}
        </span>
      ))}
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* FxDecrypt：乱码解密切换                                              */
/* ------------------------------------------------------------------ */

const SCRAMBLE_CHARS = "!<>-_\\/[]{}=+*^?#@$%&";

/**
 * 文本变化时播放「乱码 → 逐字解开」动画组件（时间驱动 rAF，约 28ms 一步，
 * 步数 ∝ 长度，动画 <2s 自动停止）；textFx 关闭时直接显示文本。
 * rAF 而非 setInterval(28)：28ms 与 60Hz 帧边界不对齐，实际步进落在
 * 33/50/66ms 抖动，长文本解锁呈一顿一顿的阶梯感。
 *
 * @param text - 目标文本；变化时重新播放解密动画。
 * @param className - 追加到外层 span 的类名。
 * @returns React 节点（aria-label 保留完整文本供读屏）。
 */
export function FxDecrypt({ text, className }: { text: string; className?: string }) {
  const fx = useFxEffectEnabled("textFx");
  const [out, setOut] = useState(text);

  useEffect(() => {
    if (!fx) {
      setOut(text);
      return;
    }
    const total = Math.max(14, Math.round(text.length * 1.8));
    const t0 = performance.now();
    let raf = 0;
    let lastFrame = -1;
    /* raf: ok 解码特效一次性，播完即止不再排帧 */
    const step = (now: number) => {
      const frame = Math.floor((now - t0) / 28);
      if (frame !== lastFrame) {
        lastFrame = frame;
        if (frame >= total) {
          setOut(text);
          return; // 播完即止，不再排帧
        }
        const reveal = frame / total - 0.25;
        setOut(
          Array.from(text)
            .map((ch, i) => {
              if (ch === " ") return ch;
              if (i / text.length < reveal) return ch;
              return SCRAMBLE_CHARS[Math.floor(Math.random() * SCRAMBLE_CHARS.length)];
            })
            .join("")
        );
      }
      raf = window.requestAnimationFrame(step);
    };
    raf = window.requestAnimationFrame(step);
    return () => window.cancelAnimationFrame(raf);
  }, [text, fx]);

  return (
    <span className={className} aria-label={text}>
      {out}
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* FxCount：数值滚动                                                    */
/* ------------------------------------------------------------------ */

/**
 * 数值变化时从旧值滚动到新值的组件（lib/anim useCountUp 的薄封装，D10
 * 合并双份实现）；textFx 关闭或减少动态时直接显示真实值。
 *
 * @param value - 目标数值（NaN/Infinity 按 0 处理）。
 * @param decimals - 小数位数，默认 0。
 * @param duration - 滚动时长毫秒数，默认 550。
 * @returns React 节点。
 */
export function FxCount({
  value,
  decimals = 0,
  duration = 550
}: {
  value: number;
  decimals?: number;
  duration?: number;
}) {
  const fx = useFxEffectEnabled("textFx");
  const safe = Number.isFinite(value) ? value : 0;
  const display = useCountUp(safe, { duration, decimals, disabled: !fx });
  return <>{display}</>;
}

/* ------------------------------------------------------------------ */
/* FxController：磁性按钮 + 聚光跟随（document 级委托）                  */
/* ------------------------------------------------------------------ */

const MAGNET_SELECTOR = ".tm-btn-primary, .tt-import-btn, .tt-preview-ok";
const SPOT_SELECTOR = ".tm-section";

/**
 * 单例监听：mousemove 时
 *  - 命中磁性选择器的元素向光标方向吸附（Magnet），离开后弹回；
 *  - 把光标位置写入最近 .tm-section 的 --mx/--my（Spotlight 高光跟随）。
 * 返回清理函数。
 */
function installFxPointer(): () => void {
  let magnetEl: HTMLElement | null = null;

  /* rAF 合帧（与 WidgetCanvas 拖拽、rb specLoop 同一范式）：mousemove 只
     记录指针状态，closest/rect 读取与样式写入统一收敛到每帧一次的 flush。
     此前逐事件「读 rect → 写样式」与下一事件交错，高回报率鼠标下变成
     逐事件强制布局；合帧后指针静止帧直接跳过，一帧至多一次重排。 */
  let pending: { x: number; y: number; target: EventTarget | null } | null = null;
  let rafId = 0;

  const resetMagnet = () => {
    if (magnetEl) {
      magnetEl.style.transform = "";
      magnetEl = null;
    }
  };

  const flush = () => {
    rafId = 0;
    const ev = pending;
    pending = null;
    const target = ev?.target as HTMLElement | null;
    if (!ev || !target || typeof target.closest !== "function") return;

    /* P-perf（布局抖动消除）：先集中完成全部几何读取，再统一写入。 */
    const spot = target.closest<HTMLElement>(SPOT_SELECTOR);
    const card = target.closest<HTMLElement>(".tm-preset-card");
    const m = target.closest<HTMLElement>(MAGNET_SELECTOR);
    const spotRect = spot?.getBoundingClientRect();
    const cardRect = card?.getBoundingClientRect();
    const mRect = m?.getBoundingClientRect();

    if (spot && spotRect) {
      spot.style.setProperty("--mx", `${ev.x - spotRect.left}px`);
      spot.style.setProperty("--my", `${ev.y - spotRect.top}px`);
    }

    /* Bento 光斑：预设卡片也记录光标局部坐标（rb.css 的 ::after 光斑消费）。 */
    if (card && cardRect) {
      card.style.setProperty("--mx", `${ev.x - cardRect.left}px`);
      card.style.setProperty("--my", `${ev.y - cardRect.top}px`);
    }

    if (magnetEl && magnetEl !== m) resetMagnet();
    if (m && mRect) {
      const dx = ev.x - (mRect.left + mRect.width / 2);
      const dy = ev.y - (mRect.top + mRect.height / 2);
      magnetEl = m;
      m.style.transform = `translate(${dx * 0.22}px, ${dy * 0.22}px)`;
    }
    /* 注：不给 .tm-section 施加磁吸 transform。大容器承载下拉/按钮等交互
       控件，位移会让点击落点漂移；transform 还会创建层叠上下文，把其中
       绝对定位的下拉菜单压到后续分区之下（点击被吞）。分区只保留
       Spotlight（::before）与边框光束（::after）两类纯装饰效果。 */
  };

  const onMove = (e: MouseEvent) => {
    pending = { x: e.clientX, y: e.clientY, target: e.target };
    if (!rafId) rafId = window.requestAnimationFrame(flush);
  };

  document.addEventListener("mousemove", onMove, { passive: true });
  const onLeave = () => resetMagnet();
  document.addEventListener("mouseleave", onLeave);
  return () => {
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseleave", onLeave);
    if (rafId) window.cancelAnimationFrame(rafId);
    rafId = 0;
    pending = null;
    resetMagnet();
  };
}

/**
 * 指针特效控制器组件：挂在应用根部，pointerFollow 开启时装载 document 级
 * 委托的聚光 / 磁性按钮特效（mousemove 经 rAF 合帧：一帧至多一次几何读 +
 * 样式写，指针静止帧零开销）。关闭时卸载监听并复位已位移元素。
 *
 * @returns null（纯副作用组件，不渲染布局内容）。
 */
export function FxController(): ReactNode {
  const fx = useFxEffectEnabled("pointerFollow");
  useEffect(() => {
    if (!fx) return;
    return installFxPointer();
  }, [fx]);
  return null;
}
