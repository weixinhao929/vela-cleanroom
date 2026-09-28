/**
 * 首次启动引导（onboarding）：设置窗首次启动会自动弹出（windows.rs
 * show_settings_on_first_boot 的落地页），本覆盖层叠在其上给出 4 步核心
 * 上手指引（欢迎 / 添加小组件 / 快捷键 / 专注与通知）。
 *
 * 完成/跳过都写 extra.onboarded=true（持久化 + 跨窗口同步），此后不再弹；
 * 常规页保留「新手引导」重新入口（setExtra({onboarded:false}) 即可重看）。
 * 出场走 0.2s 淡出：先本地 closing 态播完退场再翻存储位，避免整层瞬删。
 */
import { useEffect, useState, type CSSProperties } from "react";
import { Bell, ChevronLeft, ChevronRight, Keyboard, LayoutGrid, Sparkles, X } from "lucide-react";
import { prefersReducedMotion } from "../../lib/anim";
import { animDurations } from "../../lib/durations";
import { useT } from "../../i18n-lite";
import { useSettingsStore } from "../../store/settings-store";
import { isShortcutBound } from "../../lib/shortcuts";

/** 引导步骤定义（图标 + i18n 键）。文案键在 i18n.ts 登记。 */
const STEPS = [
  {
    icon: Sparkles,
    title: "欢迎使用 Vela",
    body: "桌面效率工作台：小组件常驻桌面，专注、待办、日程一屏可见，所有数据都保存在本地。"
  },
  {
    icon: LayoutGrid,
    title: "把小组件放上桌面",
    body: "在桌面空白处右键选择「添加小组件」进入图库，双击卡片即可添加。组件可拖动、缩放，右键能编辑与配置；顶部灵动岛随时收纳常用功能。"
  },
  {
    icon: Keyboard,
    title: "常用快捷键",
    /* 键位占位符在渲染时注入实时值（可在设置页改绑/停用，文案不得写死）。 */
    body: "{settings} 打开设置、{note} 全局速记、{palette} 呼出命令面板、{layer} 显示 / 隐藏小组件。完整列表可在快捷键速查表（{cheat}）查看。"
  },
  {
    icon: Bell,
    title: "专注与通知",
    body: "番茄钟计时、截止与待办提醒都会进入通知中心；点击系统通知可直达对应组件。需要安静时，打开勿打扰即可静音全部提醒。"
  }
] as const;

export function OnboardingOverlay() {
  const tr = useT();
  const onboarded = useSettingsStore((s) => s.extra.onboarded);
  /* 全局快捷键实时值：引导文案里的键位占位符按当前绑定注入（停用显示
     「已停用」），改键后引导不再撒谎。 */
  const shortcuts = useSettingsStore((s) => s.shortcuts);
  const accelText = (accel: string): string => (isShortcutBound(accel) ? accel : tr("已停用"));
  const stepBody = (body: string): string =>
    tr(body)
      .replace("{settings}", accelText(shortcuts["show-settings"]))
      .replace("{note}", accelText(shortcuts["quick-note"]))
      .replace("{palette}", accelText(shortcuts["toggle-palette"]))
      .replace("{layer}", accelText(shortcuts["toggle-layer"]))
      .replace("{cheat}", "Ctrl+?");
  const [step, setStep] = useState(0);
  /* 步进方向（1 前进 / -1 后退）：内容舞台按方向滑入，替代此前的硬切。 */
  const [dir, setDir] = useState(1);
  const [closing, setClosing] = useState(false);
  const go = (delta: number) => {
    setDir(delta);
    setStep((i) => Math.min(STEPS.length - 1, Math.max(0, i + delta)));
  };

  // Esc = 跳过引导（capture 抢先，避免同窗其它 Esc 处理器连锁关闭）。此前
  // 引导对 Esc 无反应，与全应用「Esc 关弹层」心智相悖。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      e.preventDefault();
      setClosing(true);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  // 退场动画播完再写存储位（父级随 onboarded=true 卸载本层）。
  // 三.1：等待时长与 CSS（.tm-onb.is-closing 的 --dur-fx）同源取值，原固定
  // 200ms 与速度档脱钩；reduce-motion 命中时 CSS 已把退场压为瞬跳，直接翻
  // 存储位不再空等（useDelayedUnmount 的 F3 立即卸载规则同口径）。
  useEffect(() => {
    if (!closing) return;
    const finish = () => useSettingsStore.getState().setExtra({ onboarded: true });
    if (prefersReducedMotion()) {
      finish();
      return;
    }
    const id = window.setTimeout(finish, Math.round(animDurations().fxMs) + 20);
    return () => window.clearTimeout(id);
  }, [closing]);

  // onboarded=true 即卸载（自身退场：closing 先播 0.2s 再翻存储位；他窗同步
  // 置位则直接卸载，可接受）。
  if (onboarded) return null;
  const cur = STEPS[step];
  const Icon = cur.icon;
  const last = step === STEPS.length - 1;

  return (
    <div
      className={`tm-onb${closing ? " is-closing" : ""}`}
      role="dialog"
      aria-modal="true"
      aria-label={tr("新手引导")}
    >
      <div className="tm-onb-card" style={{ "--sti": step } as CSSProperties}>
        <button type="button" className="tm-onb-skip" onClick={() => setClosing(true)} aria-label={tr("跳过引导")}>
          <X size={14} />
          {tr("跳过")}
        </button>
        {/* key=step：步骤切换重挂内容舞台，按 dir 方向性滑入（此前 --sti 只在
            首挂载生效，4 步内容一直是硬切）。 */}
        <div className="tm-onb-stage" key={step} data-dir={dir}>
          <div className="tm-onb-icon" aria-hidden="true">
            <Icon size={26} />
          </div>
          <h2 className="tm-onb-title">{tr(cur.title)}</h2>
          <p className="tm-onb-body">{stepBody(cur.body)}</p>
        </div>
        {/* 纯视觉指示器：role=group（此前 role=tablist 下没有 tab，读屏播报
            空列表）。步骤切换走下方按钮。 */}
        <div className="tm-onb-dots" role="group" aria-label={tr("引导步骤")}>
          {STEPS.map((s, i) => (
            <span
              key={s.title}
              className={`tm-onb-dot${i === step ? " active" : ""}`}
              // 纯指示器：步骤切换走下方按钮，圆点不做交互目标。
              aria-hidden="true"
            />
          ))}
        </div>
        <div className="tm-onb-actions">
          {step > 0 ? (
            <button type="button" className="tm-onb-btn ghost" onClick={() => go(-1)}>
              <ChevronLeft size={14} />
              {tr("上一步")}
            </button>
          ) : (
            <span />
          )}
          <button
            type="button"
            className="tm-onb-btn primary"
            onClick={() => (last ? setClosing(true) : go(1))}
            autoFocus
          >
            {last ? tr("开始使用") : tr("下一步")}
            <ChevronRight size={14} />
          </button>
        </div>
      </div>
    </div>
  );
}
