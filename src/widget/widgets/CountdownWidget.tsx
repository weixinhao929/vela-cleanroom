/**
 * 倒计时小组件：目标日倒计时/正计时（周年纪念语义）、农历与节日标注、
 * 托盘提醒；多实例各自配置目标时间。
 */
import { useEffect, useId, useRef, useState, type CSSProperties } from "react";
import { CalendarHeart, Pause, Play, Plus, RotateCcw, Trash2 } from "lucide-react";
import { useGamePause } from "../../lib/useGamePause";
import { sourceNotify, playChime } from "../../lib/notifications";

/* /F-托盘多写入方：托盘倒计时只有一个句柄，多个实例此前各自整表覆盖
 * （last-write-wins、任一停止即写"未运行"、卸载不清理残留冻结文本）。
 * 这里做模块级注册表仲裁：优先展示任一运行中实例的文本；全部空闲时清空；
 * 卸载时注销并立即重算，杜绝残留。 */
const trayWriters = new Map<string, { running: () => boolean; label: () => string | null }>();

function recomputeTrayText() {
  if (!isTauri()) return;
  let text: string | null = null;
  for (const w of trayWriters.values()) {
    const t = w.running() ? w.label() : null;
    if (t) {
      text = t;
      break;
    }
  }
  void invoke("set_tray_countdown", { text }).catch(() => {});
}
import { useWidgetConfig } from "../widget-config";
import { useT } from "../../i18n-lite";
import { getPomodoroEventContext, useAppStore } from "../../store/app-store";
import { invoke, isTauri } from "../../lib/tauri";
import { promptDialog } from "../../components/PromptDialog";
import { useSafeTimeout } from "../../lib/use-safe-timeout";
import { useDelayedRemoval } from "../../lib/use-confirm-remove";
import { DatePicker } from "../../components/DatePicker";

const PRESETS = [60, 300, 600, 900, 1800, 3600];

/** 倒数日目标。 */
type CountdownTarget = { id: string; label: string; date: string };

const DEFAULT_TARGETS: CountdownTarget[] = [];

function fmt(total: number): string {
  const s = Math.max(0, Math.floor(total));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(sec).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

function loadTargets(raw: unknown): CountdownTarget[] {
  if (!Array.isArray(raw)) return DEFAULT_TARGETS;
  const out: CountdownTarget[] = [];
  for (const t of raw) {
    if (!t || typeof t !== "object") continue;
    const o = t as Record<string, unknown>;
    if (typeof o.id !== "string" || typeof o.label !== "string" || typeof o.date !== "string") continue;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(o.date)) continue;
    out.push({ id: o.id, label: o.label, date: o.date });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

/** 状态持久化：重启应用后倒计时接着跑。 */
type PersistedState = { total: number; left: number; running: boolean; endAt: number };

function stateKey(instanceId: string) {
  return `focus-desk.countdown.state.${instanceId}`;
}

function loadPersisted(instanceId: string, initial: number): PersistedState {
  try {
    const raw = localStorage.getItem(stateKey(instanceId));
    if (!raw) return { total: initial, left: initial, running: false, endAt: 0 };
    const p = JSON.parse(raw) as Partial<PersistedState>;
    if (typeof p.total !== "number" || p.total <= 0) return { total: initial, left: initial, running: false, endAt: 0 };
    if (p.running && typeof p.endAt === "number") {
      const remain = Math.max(0, Math.round((p.endAt - Date.now()) / 1000));
      if (remain > 0) return { total: p.total, left: remain, running: true, endAt: p.endAt };
      return { total: p.total, left: 0, running: false, endAt: 0 };
    }
    return {
      total: p.total,
      left: typeof p.left === "number" ? Math.max(0, p.left) : p.total,
      running: false,
      endAt: 0
    };
  } catch {
    return { total: initial, left: initial, running: false, endAt: 0 };
  }
}

export function CountdownWidget({ instanceId }: { instanceId: string }) {
  const tr = useT();
  const safeTimeout = useSafeTimeout();
  const { config, update } = useWidgetConfig(instanceId);
  const gradId = useId();
  const defaultPreset = (config.defaultPreset as number) || 25;
  const notifyOnEnd = config.notifyOnEnd !== false;
  const loopAfterComplete = !!config.loopAfterComplete;
  const showSeconds = config.showSeconds !== false;
  const showPresets = config.showPresets !== false;
  /* 结束提示音 / 联动番茄钟 / 托盘剩余时间。 */
  const endSound = config.endSound !== false;
  const linkPomodoro = !!config.linkPomodoro;
  const trayTime = config.trayTime !== false;
  const initial = Math.max(1, defaultPreset) * 60;

  /* 双模式：计时器 / 倒数日。 */
  const mode = config.mode === "days" ? "days" : "timer";
  const targets = loadTargets(config.targets);
  const [targetLabel, setTargetLabel] = useState("");
  const [targetDate, setTargetDate] = useState("");

  const [restored] = useState(() => loadPersisted(instanceId, initial));
  const [total, setTotal] = useState(restored.total);
  const [left, setLeft] = useState(restored.left);
  const [running, setRunning] = useState(restored.running);
  const [custom, setCustom] = useState("");
  const endRef = useRef<number>(restored.running ? restored.endAt : null);
  const runningRef = useRef(false);
  const totalRef = useRef(total);
  const leftRef = useRef(left);
  const loopRef = useRef(loopAfterComplete);
  const notifyRef = useRef(notifyOnEnd);
  const soundRef = useRef(endSound);
  const linkRef = useRef(linkPomodoro);
  const lastWriteRef = useRef(0);

  useEffect(() => {
    runningRef.current = running;
  }, [running]);
  useEffect(() => {
    totalRef.current = total;
  }, [total]);
  useEffect(() => {
    leftRef.current = left;
  }, [left]);
  useEffect(() => {
    loopRef.current = loopAfterComplete;
  }, [loopAfterComplete]);
  useEffect(() => {
    notifyRef.current = notifyOnEnd;
  }, [notifyOnEnd]);
  useEffect(() => {
    soundRef.current = endSound;
  }, [endSound]);
  useEffect(() => {
    linkRef.current = linkPomodoro;
  }, [linkPomodoro]);
  /* defaultPreset 此前仅经 useState 初始化器进 total/left，一旦有过持久化
     状态（任意一次运行后），设置页改默认预设永不生效。空闲且当前仍显示旧
     默认值时跟随新配置；用户手动设过的自定义时长（≠旧默认）不覆盖。 */
  const prevInitialRef = useRef(initial);
  useEffect(() => {
    if (running) return;
    const wasOldDefault = totalRef.current === prevInitialRef.current;
    prevInitialRef.current = initial;
    if (!wasOldDefault) return;
    setTotal(initial);
    setLeft(initial);
  }, [initial, running]);

  /** 节流落盘：状态切换立即写，运行中最多 3s 一次。读 ref 避免 interval 闭包拿到旧值。 */
  const persist = (force = true) => {
    const now = Date.now();
    if (!force && now - lastWriteRef.current < 3000) return;
    lastWriteRef.current = now;
    try {
      localStorage.setItem(
        stateKey(instanceId),
        JSON.stringify({
          total: totalRef.current,
          left: leftRef.current,
          running: runningRef.current,
          endAt: endRef.current ?? 0
        })
      );
    } catch {
      /* best-effort */
    }
  };

  // 单个 interval 驱动：结束时可选择自动循环，无需嵌套 interval。
  useEffect(() => {
    if (!running) return;
    endRef.current = Date.now() + left * 1000;
    const id = window.setInterval(() => {
      const remain = Math.max(0, Math.round((endRef.current! - Date.now()) / 1000));
      setLeft(remain);
      persist(false);
      if (remain <= 0) {
        if (loopRef.current) {
          // 自动循环：重新从总时长开始倒数，保持运行状态。
          endRef.current = Date.now() + totalRef.current * 1000;
          setLeft(totalRef.current);
          if (soundRef.current) playChime("pomodoro", "countdown");
        } else {
          window.clearInterval(id);
          setRunning(false);
          if (soundRef.current) playChime("pomodoro", "countdown");
          if (notifyRef.current) void sourceNotify("countdown", tr("倒计时结束"), tr("时间到，休息一下吧。"));
          // 倒计时结束自动切入番茄钟短休息。只在番茄钟**无在途段**
          // （含暂停）时接管——运行/暂停中的专注段被 setPomodoroMode 无记录
          // 跳掉；切入后自动开始，兑现「自动切入」语义。：等待回座
          // 自动开始（awaitingActivity）时也不接管——事件上下文的 mode 只看
          // isRunning/segmentStartedAt，会把等待态误判成「无在途段」，强切
          // 短休会清掉「等你回来」的承诺。
          if (
            linkRef.current &&
            getPomodoroEventContext().mode === "stopped" &&
            !useAppStore.getState().pomodoro.awaitingActivity
          ) {
            const st = useAppStore.getState();
            st.setPomodoroMode("shortBreak");
            st.togglePomodoro();
          }
          recomputeTrayText();
        }
      }
    }, 250);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running]);

  // 卸载前把最新状态写盘（切视图 / 关窗口不丢计时）。
  useEffect(() => () => persist(true), []); // eslint-disable-line react-hooks/exhaustive-deps

  // /F-托盘多写入方：本实例注册进模块级注册表，由仲裁器统一写托盘；
  // 运行中每 30s 重算一次，卸载/关开关/切模式时注销并立即重算（防残留）。
  useEffect(() => {
    if (!isTauri() || !trayTime || mode !== "timer") return;
    const entry = {
      running: () => runningRef.current,
      label: () => `${tr("倒计时")} ${fmt(leftRef.current)}`
    };
    trayWriters.set(instanceId, entry);
    recomputeTrayText();
    const id = window.setInterval(recomputeTrayText, 30_000);
    return () => {
      window.clearInterval(id);
      trayWriters.delete(instanceId);
      recomputeTrayText();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running, trayTime, mode, instanceId]);

  // Auto-pause when a fullscreen app (e.g. a game) takes over the screen.
  useGamePause({
    isRunning: () => runningRef.current,
    toggle: () => setRunning((r) => !r)
  });

  const start = (secs: number) => {
    setTotal(secs);
    setLeft(secs);
    setRunning(true);
    // 运行中点击预设：interval effect 的 deps 只有 running，不会重跑，
    // endRef 仍是旧 deadline，250ms 后 interval 会用旧值覆盖新显示。
    // 这里同步重设 endRef，保证下一次 tick 立即按新总时长计算。
    endRef.current = Date.now() + secs * 1000;
  };

  const applyCustom = () => {
    const parts = custom.split(":").map((p) => parseInt(p, 10));
    let secs = 0;
    if (parts.length === 3) secs = parts[0] * 3600 + parts[1] * 60 + (parts[2] || 0);
    else if (parts.length === 2) secs = parts[0] * 60 + (parts[1] || 0);
    else secs = parts[0] || 0;
    if (secs > 0) start(secs);
  };

  /* 自定义预设：右键编辑（输入 0 = 删除该槽位），加号追加。 */
  const presets = (() => {
    const raw = Array.isArray(config.presets) ? (config.presets as unknown[]) : [];
    const list = raw.filter((p): p is number => typeof p === "number" && p > 0 && Number.isFinite(p));
    return list.length ? list : PRESETS;
  })();
  const editPreset = async (index: number) => {
    const val = await promptDialog({
      title: tr("编辑预设时长"),
      message: tr("输入分钟数（支持小数）；输入 0 删除该预设"),
      initialValue: String(Math.round(presets[index] / 60)),
      confirmLabel: tr("保存"),
      placeholder: "25"
    });
    if (val === null) return;
    const mins = parseFloat(val.trim());
    const next = [...presets];
    if (!Number.isFinite(mins) || mins <= 0) {
      next.splice(index, 1);
    } else {
      next[index] = Math.max(1, Math.round(mins * 60));
    }
    update({ presets: next });
  };
  const addPreset = async () => {
    const val = await promptDialog({
      title: tr("添加预设时长"),
      message: tr("输入分钟数（支持小数）"),
      initialValue: "25",
      confirmLabel: tr("添加"),
      placeholder: "25"
    });
    if (val === null) return;
    const mins = parseFloat(val.trim());
    if (!Number.isFinite(mins) || mins <= 0) return;
    update({ presets: [...presets, Math.max(1, Math.round(mins * 60))] });
  };

  /* 倒数日目标管理。 */
  const addTarget = () => {
    const label = targetLabel.trim();
    if (!label || !targetDate) return;
    const list = [...targets, { id: crypto.randomUUID(), label, date: targetDate }];
    update({ targets: list.sort((a, b) => a.date.localeCompare(b.date)) });
    setTargetLabel("");
    setTargetDate("");
  };
  // 倒数日删除退场：先播 is-closing 收拢淡出，再真正落删。
  const { removingIds, begin: beginRemoval } = useDelayedRemoval(
    (id) => update({ targets: targets.filter((t) => t.id !== id) }),
    200
  );
  const removeTarget = (id: string) => beginRemoval(id);
  const daysUntil = (date: string) => {
    const d = new Date(`${date}T00:00:00`);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return Math.round((d.getTime() - today.getTime()) / 86_400_000);
  };

  const pct = total > 0 ? (left / total) * 100 : 0;
  // 显示格式：开启「显示秒数」时显示 mm:ss，否则仅显示 mm。
  const display = showSeconds ? fmt(left) : fmt(left).replace(/:\d{2}$/, "");

  /* 归零仪式感：非循环模式倒计时归零的一刻，整环满环闪烁 + 数字放大回弹 */
  const prevLeftRef = useRef(left);
  const [justEnded, setJustEnded] = useState(false);
  useEffect(() => {
    if (left === 0 && prevLeftRef.current > 0 && !loopRef.current) {
      setJustEnded(true);
      safeTimeout(() => setJustEnded(false), 850);
    }
    prevLeftRef.current = left;
  }, [left, safeTimeout]);

  // 进度弧（与专注表盘一致的 SVG 渐变弧 + 光点端点）
  const R = 88;
  const C = 2 * Math.PI * R;
  const clamped = Math.max(0, Math.min(100, pct));
  const tipAngle = ((clamped / 100) * 360 - 90) * (Math.PI / 180);

  if (mode === "days") {
    return (
      <div className="cd">
        <div
          className="cd-mode-tabs"
          role="tablist"
          onKeyDown={(e) => {
            if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
              e.preventDefault();
              update({ mode: "timer" });
            }
          }}
        >
          <button role="tab" aria-selected="false" onClick={() => update({ mode: "timer" })}>
            {tr("计时")}
          </button>
          <button className="active" role="tab" aria-selected="true">
            {tr("倒数日")}
          </button>
        </div>
        {/* key=mode：模式切换重挂内容舞台播轻交叉上浮（此前两个 return 分支硬切）。 */}
        <div className="cd-mode-stage" key="days">
          <div className="cd-targets">
            {targets.length === 0 && <div className="widget-empty">{tr("添加一个纪念日或目标日期")}</div>}
            {targets.map((t, i) => {
              const days = daysUntil(t.date);
              return (
                <div
                  className={`cd-target${days < 0 ? " past" : days === 0 ? " today" : ""}${removingIds.has(t.id) ? " is-closing" : ""}`}
                  key={t.id}
                  style={{ "--sti": i } as CSSProperties}
                >
                  <CalendarHeart size={14} className="cd-target-icon" />
                  <span className="cd-target-label">{t.label}</span>
                  <span className="cd-target-days">
                    {days > 0
                      ? tr("还有 {n} 天").replace("{n}", String(days))
                      : days === 0
                        ? tr("就是今天")
                        : tr("已过去 {n} 天").replace("{n}", String(-days))}
                  </span>
                  <button
                    className="cd-target-del"
                    onClick={() => removeTarget(t.id)}
                    aria-label={tr("删除")}
                    title={tr("删除")}
                    data-interactive
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              );
            })}
          </div>
          <div className="cd-target-form">
            <input
              value={targetLabel}
              onChange={(e) => setTargetLabel(e.target.value)}
              placeholder={tr("名称，如：生日")}
              data-interactive
            />
            <DatePicker value={targetDate} onChange={setTargetDate} ariaLabel={tr("目标日期")} />
            <button className="cd-apply" onClick={addTarget} aria-label={tr("添加")}>
              <Plus size={14} />
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="cd">
      <div
        className="cd-mode-tabs"
        role="tablist"
        onKeyDown={(e) => {
          if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
            e.preventDefault();
            update({ mode: "days" });
          }
        }}
      >
        <button className="active" role="tab" aria-selected="true">
          {tr("计时")}
        </button>
        <button role="tab" aria-selected="false" onClick={() => update({ mode: "days" })}>
          {tr("倒数日")}
        </button>
      </div>
      <div className="cd-mode-stage" key="timer">
        <div className={`cd-ring ${running ? "running" : ""}${justEnded ? " just-ended" : ""}`}>
          <svg viewBox="0 0 200 200" className="cd-ring-svg" aria-hidden="true">
            <defs>
              <linearGradient id={gradId} x1="0%" y1="0%" x2="100%" y2="100%">
                <stop offset="0%" stopColor="var(--accent)" />
                <stop offset="100%" stopColor="var(--accent-2)" />
              </linearGradient>
            </defs>
            <circle className="cd-ring-track" cx="100" cy="100" r={R} />
            <circle
              className="cd-ring-progress"
              cx="100"
              cy="100"
              r={R}
              stroke={`url(#${gradId})`}
              strokeDasharray={C}
              strokeDashoffset={C * (1 - clamped / 100)}
              transform="rotate(-90 100 100)"
            />
            {clamped > 0.5 && (
              <circle
                className="cd-ring-tip"
                cx={100 + R * Math.cos(tipAngle)}
                cy={100 + R * Math.sin(tipAngle)}
                r="4"
              />
            )}
          </svg>
          <div className="cd-ring-inner">
            {/* 翻秒：逐位拆分，仅变化的位以「位+字面值」为 key 重挂载播 y 轴滑入
              （ClockWidget clock-digit 同语言）；tabular-nums 保证无宽度抖动。
              归零庆祝仍由 just-ended 链路独立承担。 */}
            <div className="cd-time">
              {Array.from(display).map((ch, i) =>
                /\d/.test(ch) ? (
                  <span className="cd-digit" key={`${i}-${ch}`}>
                    {ch}
                  </span>
                ) : (
                  <span key={`${i}-s`}>{ch}</span>
                )
              )}
            </div>
            <div className="cd-state" key={running ? "r" : left === 0 ? "z" : "p"}>
              {running ? tr("进行中") : left === 0 ? tr("时间到") : tr("已暂停")}
            </div>
          </div>
        </div>

        {showPresets && (
          <div className="cd-presets">
            {presets.map((p, i) => (
              <button
                key={`${i}-${p}`}
                className={`cd-preset${total === p ? " active" : ""}`}
                onClick={() => start(p)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  void editPreset(i);
                }}
                title={tr("右键编辑预设")}
                aria-label={tr("设置 {时长} 倒计时").replace(
                  "{时长}",
                  p >= 3600 ? `${p / 3600}h` : p >= 60 ? `${p / 60}m` : `${p}s`
                )}
              >
                {p >= 3600
                  ? `${p / 3600}h`
                  : p >= 60
                    ? p % 60 === 0
                      ? `${p / 60}m`
                      : `${(p / 60).toFixed(1)}m`
                    : `${p}s`}
              </button>
            ))}
            <button
              className="cd-preset add"
              onClick={() => void addPreset()}
              title={tr("添加预设")}
              aria-label={tr("添加预设")}
            >
              <Plus size={12} />
            </button>
          </div>
        )}

        <div className="cd-custom">
          <input
            value={custom}
            onChange={(e) => setCustom(e.target.value)}
            /* IME 组合期 Enter（确认候选词）不当作提交。 */
            onKeyDown={(e) => e.key === "Enter" && !e.nativeEvent.isComposing && applyCustom()}
            placeholder={tr("自定义 mm:ss 或 hh:mm:ss")}
            aria-label={tr("自定义倒计时时长")}
            data-interactive
          />
          <button className="cd-apply" onClick={applyCustom}>
            {tr("设置")}
          </button>
        </div>

        <div className="cd-controls">
          <button
            className="cd-btn primary"
            aria-label={running ? tr("暂停倒计时") : left === 0 ? tr("再来一轮") : tr("开始倒计时")}
            onClick={() => {
              // 结束后（left 为 0）点击"开始"直接重新开始，无需先重置。
              if (left === 0 && !running) {
                setLeft(total);
                setRunning(true);
              } else {
                setRunning((r) => !r);
              }
            }}
          >
            <span key={running ? "p" : left === 0 ? "z" : "s"} className="cd-ico">
              {running ? <Pause size={16} /> : left === 0 ? <RotateCcw size={16} /> : <Play size={16} />}
            </span>
            {running ? tr("暂停") : left === 0 ? tr("再来一轮") : tr("开始")}
          </button>
          <button
            className="cd-btn"
            aria-label={tr("重置倒计时")}
            onClick={() => {
              setRunning(false);
              setLeft(total);
            }}
          >
            <RotateCcw size={15} />
            {tr("重置")}
          </button>
        </div>
      </div>
    </div>
  );
}
