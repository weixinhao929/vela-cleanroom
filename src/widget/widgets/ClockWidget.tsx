/**
 * 时钟小组件：数字时钟（多时区）+ 模拟表盘 + 秒表 + 番茄钟迷你入口。
 * 时区校验结果模块级缓存（P-perf），表盘静态子树提取为常量元素。
 * 配置经统一就地弹层 WidgetConfigPopover（B1）：齿轮按钮打开，锚定本组件
 * 矩形；此前的自搓弹层（原生 checkbox/pill radio）已删除。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useWidgetConfig } from "../widget-config";
import { useT } from "../../i18n-lite";
import { useSettingsStore } from "../../store/settings-store";
import { useNow } from "../../lib/use-now";
import { useIdleDecor } from "../../lib/idle-decor";
import { cityOf } from "../clock-timezones";
import { WidgetConfigPopover, type PopoverAnchor } from "../WidgetConfigPopover";

/** P-perf：时区标识符合法性校验结果缓存。此前每次渲染（useNow(1000) →
    每秒）都对每个已配时区新建 Intl.DateTimeFormat 预检——该构造涉及
    ICU 解析，代价高且结果恒定，按 id 记忆化后每时区只构造一次。 */
const validTzCache = new Map<string, boolean>();
function isValidTimeZone(tz: string): boolean {
  let ok = validTzCache.get(tz);
  if (ok === undefined) {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: tz });
      ok = true;
    } catch {
      ok = false;
    }
    validTzCache.set(tz, ok);
  }
  return ok;
}

/** P-perf：Intl formatter 缓存。toLocaleTimeString/Date 每次调用都会按
    options 重新构造 DateTimeFormat（V8 的内部命中对逐次新建的字面量
    options 对象不稳定），时钟每秒重渲 × 多时区行 × 世界时钟城市数放大
    这一开销。按 (locale|tz|options) 签名缓存，条目数 = 配置组合数。
    条目上限兜底防长会话累积（正常用不满，满则整体重建）。 */
const fmtCache = new Map<string, Intl.DateTimeFormat>();
function fmt(locale: string, opts: Intl.DateTimeFormatOptions, tz?: string): Intl.DateTimeFormat {
  const key = `${locale}|${tz ?? ""}|${JSON.stringify(opts)}`;
  let f = fmtCache.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat(locale, { ...opts, timeZone: tz });
    if (fmtCache.size >= 64) fmtCache.clear();
    fmtCache.set(key, f);
  }
  return f;
}

/** 数字逐位渲染（#39）：每位数字以「位置+字面值」为 key，只有变化的位
    重挂载并播滑入动画。animate=false 时（秒表厘秒位等每帧变化的场景）
    不挂动画类，否则 key 每帧变化 → 入场动画每帧重播，数字永远处于
    半透明位移首帧造成抖动。 */
function Digits({ text, animate = true }: { text: string; animate?: boolean }) {
  return (
    <>
      {Array.from(text).map((ch, i) =>
        /\d/.test(ch) ? (
          <span className={animate ? "clock-digit" : undefined} key={`${i}-${ch}`}>
            {ch}
          </span>
        ) : (
          <span key={`${i}-s`}>{ch}</span>
        )
      )}
    </>
  );
}

/* W-003 秒表/正计时：点表冠在时钟 ↔ 秒表间切换（对标 iOS 秒表）。
   渲染分层：百分秒每帧直写 DOM（csRef.textContent，不进 React），
   mm/ss 只在实际秒值翻转时重渲（1Hz）走 Digits 数字滑动——旧版 rAF
   逐帧 setState 以 60fps 重渲整个秒表子树，是时钟组件最大的常驻开销。 */
function Stopwatch() {
  const tr = useT();
  const [running, setRunning] = useState(false);
  const [, tickSecond] = useState(0);
  const startRef = useRef(0);
  const baseRef = useRef(0);
  const elapsedRef = useRef(0);
  const lastSecRef = useRef(-1);
  const csRef = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!running) return;
    startRef.current = performance.now();
    /* 百分秒文本 30fps 刷新（~33ms 间隔）而非每帧：人眼对百分秒两位的
       流畅度感知到此为止，省掉高频 textContent 写与布局无效化。 */
    const CS_INTERVAL_MS = 33;
    let raf = 0;
    let lastPaint = 0;
    /* raf: ok 计时数据（百分秒文本）非装饰动画，30fps 已限速 */
    const loop = (now: number) => {
      elapsedRef.current = baseRef.current + (performance.now() - startRef.current);
      if (now - lastPaint >= CS_INTERVAL_MS) {
        lastPaint = now;
        if (csRef.current) {
          csRef.current.textContent = String(Math.floor((elapsedRef.current % 1000) / 10)).padStart(2, "0");
        }
      }
      const total = Math.floor(elapsedRef.current / 1000);
      if (total !== lastSecRef.current) {
        lastSecRef.current = total;
        tickSecond((v) => v + 1);
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [running]);
  const total = Math.floor(elapsedRef.current / 1000);
  const mm = String(Math.floor(total / 60)).padStart(2, "0");
  const ss = String(total % 60).padStart(2, "0");
  const cs = String(Math.floor((elapsedRef.current % 1000) / 10)).padStart(2, "0");
  return (
    <div className="clock-stopwatch">
      <div className="clock-stopwatch-time">
        <Digits text={mm} />:<Digits text={ss} />.<span ref={csRef}>{cs}</span>
      </div>
      <div className="clock-stopwatch-actions">
        <button
          className={`clock-stopwatch-btn${running ? " stop" : ""}`}
          onClick={() => {
            if (running) baseRef.current = elapsedRef.current;
            setRunning((v) => !v);
          }}
        >
          {running ? tr("停止") : tr("开始")}
        </button>
        <button
          className="clock-stopwatch-btn"
          onClick={() => {
            setRunning(false);
            baseRef.current = 0;
            elapsedRef.current = 0;
            lastSecRef.current = -1;
            if (csRef.current) csRef.current.textContent = "00";
            tickSecond((v) => v + 1);
          }}
        >
          {tr("归零")}
        </button>
      </div>
    </div>
  );
}

/* W-002 模拟表盘：SVG 指针时钟，指针角度随当前时间平滑旋转。 */

/* P-perf：表盘数字与 60 根刻度是纯静态 SVG 子树，提取为模块级常量元素。
   此前随每秒 tick 重新创建 64 个 React 元素再走一遍 reconcile。 */
const ANALOG_FACE_STATIC = (
  <>
    {[12, 3, 6, 9].map((n, i) => {
      const a = (i * 90 - 90) * (Math.PI / 180);
      return (
        <text
          key={n}
          className="clock-analog-num"
          x={50 + Math.cos(a) * 37}
          y={50 + Math.sin(a) * 37}
          textAnchor="middle"
          dominantBaseline="central"
        >
          {n}
        </text>
      );
    })}
    {Array.from({ length: 60 }, (_, i) => {
      const a = (i * 6 - 90) * (Math.PI / 180);
      const major = i % 5 === 0;
      const r1 = major ? 40 : 43;
      return (
        <line
          key={i}
          className={`clock-analog-tick${major ? " major" : ""}`}
          x1={50 + Math.cos(a) * r1}
          y1={50 + Math.sin(a) * r1}
          x2={50 + Math.cos(a) * 45}
          y2={50 + Math.sin(a) * 45}
        />
      );
    })}
  </>
);

function AnalogFace({ now, showSeconds }: { now: Date; showSeconds: boolean }) {
  const h = now.getHours() % 12;
  const m = now.getMinutes();
  const s = now.getSeconds();
  const degH = (h + m / 60) * 30;
  const degM = (m + s / 60) * 6;
  /* 秒针角度 = 纪元秒 × 6：严格单调（每分钟 354°→0° 不再整圈倒转），
     且是纯时间函数——旧版在渲染期对 ref 做累加，属并发渲染反模式
     （渲染被重放会双倍累加）。角度数值随纪元增长，CSS double 精度足够。 */
  const degS = Math.floor(now.getTime() / 1000) * 6;
  return (
    <svg className="clock-analog" viewBox="0 0 100 100" aria-hidden="true">
      <circle className="clock-analog-face" cx="50" cy="50" r="47" />
      {ANALOG_FACE_STATIC}
      <line
        className="clock-analog-hand hour"
        x1="50"
        y1="50"
        x2="50"
        y2="27"
        style={{ transform: `rotate(${degH}deg)`, transformOrigin: "50px 50px" }}
      />
      <line
        className="clock-analog-hand minute"
        x1="50"
        y1="50"
        x2="50"
        y2="18"
        style={{ transform: `rotate(${degM}deg)`, transformOrigin: "50px 50px" }}
      />
      {showSeconds && (
        <line
          className="clock-analog-hand second"
          x1="50"
          y1="56"
          x2="50"
          y2="15"
          style={{ transform: `rotate(${degS}deg)`, transformOrigin: "50px 50px" }}
        />
      )}
      <circle className="clock-analog-pin" cx="50" cy="50" r="2.4" />
    </svg>
  );
}

export function ClockWidget({ instanceId }: { instanceId: string }) {
  const tr = useT();
  const { config } = useWidgetConfig(instanceId);
  /* B1 统一就地配置弹层：齿轮打开，锚定本组件矩形（打开瞬间测量）。 */
  const rootRef = useRef<HTMLDivElement>(null);
  const [configOpen, setConfigOpen] = useState(false);
  const [configAnchor, setConfigAnchor] = useState<PopoverAnchor>({ x: 0, y: 0, w: 0, h: 0 });
  const openConfig = () => {
    const r = rootRef.current?.getBoundingClientRect();
    if (r) setConfigAnchor({ x: r.x, y: r.y, w: r.width, h: r.height });
    setConfigOpen(true);
  };
  /* G-9 空闲降频：presence Idle 期间降为 30s 档并收起秒位——秒级翻牌是
     桌面层空闲 CPU/GPU 的常驻大头（动态实测 ~0.47 单核）；分钟级照常走。
     任何输入立即恢复秒级。秒表/倒计时等主动计时不受影响（各自独立节拍）。 */
  const idleDecor = useIdleDecor();
  const now = useNow(idleDecor ? 30_000 : 1000);

  const showSeconds = config.showSeconds !== false && !idleDecor;
  const hour12 = !!config.hour12;
  const style = (config.style as string) || "standard";
  const showDate = config.showDate !== false;
  const showWeekday = config.showWeekday !== false;
  const weekdayStyle = (config.weekdayStyle as string) || "long";
  const transparentBg = !!config.transparent;
  const timeZone = (config.timeZone as string) || "auto";
  // P2（审计修复）：zones 此前只做 Array.isArray 检查，非字符串元素会传入
  // Intl 的 timeZone 抛 RangeError 把整卡打进错误边界。这里过滤非法元素，
  // 并用 try/catch 预检每个时区标识符（畸形时区直接丢弃）。
  const zones = (Array.isArray(config.zones) ? (config.zones as unknown[]) : []).filter(
    (z): z is string => typeof z === "string" && isValidTimeZone(z)
  );
  const face = (config.face as string) || "digital";
  const dateStyle = (config.dateStyle as string) || "auto";
  const fontScale = typeof config.fontScale === "number" ? config.fontScale : 1;
  const customColor = typeof config.color === "string" ? config.color : "";
  /* W-003 时钟 ↔ 秒表切换（组件内 state，不持久化）。 */
  const [stopwatch, setStopwatch] = useState(false);

  const tz: string | undefined = timeZone === "auto" ? undefined : timeZone;
  const lang = useSettingsStore((s) => s.general.language);
  const locale = lang === "English" ? "en-US" : "zh-CN";
  const time = fmt(
    locale,
    {
      hour: "2-digit",
      minute: "2-digit",
      second: showSeconds ? "2-digit" : undefined,
      hour12
    },
    tz
  ).format(now);

  /* P-perf：weekday/date 一天只变一次——以「当日键」为记忆化依据（useNow
     每秒换引用，直接依赖 now 会让 useMemo 每秒失效重算整段日期字符串）。 */
  const dayKey = fmt("en-US", { year: "numeric", month: "2-digit", day: "2-digit" }, tz).format(now);
  // W-004 日期格式：auto 沿用英文长格式；zh 输出中文「8月17日」；slash 输出 yyyy/MM/dd。
  const weekday = useMemo(
    () => fmt(locale, { weekday: "long" }, tz).format(now),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [dayKey, locale, tz]
  );
  const date = useMemo(() => {
    if (dateStyle === "zh") {
      const zh = fmt("zh-CN", { month: "long", day: "numeric" }, tz).format(now);
      return showWeekday ? `${weekday} · ${zh}` : zh;
    }
    if (dateStyle === "slash") {
      const p = (n: number) => String(n).padStart(2, "0");
      const d = new Date(now.toLocaleString("en-US", { timeZone: tz }));
      const iso = `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())}`;
      return showWeekday ? `${weekday} · ${iso}` : iso;
    }
    return fmt(
      "en-US",
      {
        weekday: showWeekday ? (weekdayStyle === "short" ? "short" : "long") : undefined,
        month: "long",
        day: "numeric"
      },
      tz
    ).format(now);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dayKey, dateStyle, showWeekday, weekdayStyle, tz, weekday, locale]);

  const styleGap = style === "compact" ? 2 : style === "loose" ? 16 : 8;
  const timeClass = style === "compact" ? "compact" : style === "loose" ? "loose" : "";
  /* W-005 字号/颜色：CSS 变量注入，主时间与世界时钟共用。 */
  const cssVars = {
    "--clock-scale": fontScale,
    ...(customColor ? { color: customColor } : {})
  } as React.CSSProperties;

  /* W-001 世界时钟：zones 非空时按城市并列（每个城市 HH:mm + 城市名）。
     options 对象提出渲染外只建一次，formatter 走缓存。 */
  const worldClock = zones.length > 0;
  const worldOpts: Intl.DateTimeFormatOptions = {
    hour: "2-digit",
    minute: "2-digit",
    second: showSeconds ? "2-digit" : undefined,
    hour12
  };

  return (
    <div
      ref={rootRef}
      className={`widget-clock${transparentBg ? " transparent" : ""}`}
      style={{ gap: styleGap, ...cssVars }}
    >
      {stopwatch ? (
        <Stopwatch />
      ) : worldClock ? (
        <div className="clock-world">
          {zones.map((z, i) => (
            <div className="clock-world-row" key={z} style={{ "--sti": i } as React.CSSProperties}>
              <span className="clock-world-city">{tr(cityOf(z))}</span>
              <span className="clock-world-time">
                <Digits text={fmt(locale, worldOpts, z).format(now)} />
              </span>
            </div>
          ))}
        </div>
      ) : face === "analog" ? (
        <AnalogFace now={now} showSeconds={showSeconds} />
      ) : (
        <div className={`widget-clock-time ${timeClass}`}>
          <Digits text={time} />
        </div>
      )}
      {!stopwatch && showDate && !worldClock && <div className="widget-clock-date">{date}</div>}
      {/* W-003 表冠按钮：时钟 ↔ 秒表切换 */}
      <button
        className={`clock-crown-btn${stopwatch ? " active" : ""}`}
        onClick={(e) => {
          e.stopPropagation();
          setStopwatch((v) => !v);
        }}
        title={stopwatch ? tr("返回时钟") : tr("秒表")}
        aria-label={stopwatch ? tr("返回时钟") : tr("秒表")}
        data-interactive
      >
        <svg
          width="13"
          height="13"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
        >
          {stopwatch ? (
            <>
              <circle cx="12" cy="12" r="9" />
              <path d="M12 7v5l3 3" />
            </>
          ) : (
            <>
              <circle cx="12" cy="13" r="8" />
              <path d="M12 9v4l2.5 2.5" />
              <path d="M9 2h6" />
              <path d="M12 2v3" />
            </>
          )}
        </svg>
      </button>

      {/* B1：齿轮打开统一就地配置弹层（原自搓弹层已删除，字段见 QUICK_CONFIG_FIELDS.clock） */}
      <button
        className="clock-settings-btn"
        onClick={(e) => {
          e.stopPropagation();
          openConfig();
        }}
        title={tr("时钟设置")}
        aria-label={tr("时钟设置")}
        aria-haspopup="dialog"
        aria-expanded={configOpen}
        data-interactive
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
      </button>

      <WidgetConfigPopover
        instanceId={instanceId}
        widgetType="clock"
        anchor={configAnchor}
        open={configOpen}
        onClose={() => setConfigOpen(false)}
      />
    </div>
  );
}
