/**
 * 设置页 · 动效页：动效总开关、模式（增强/标准/减少）、速度与时长微调、
 * 逐特效开关与入场/转场风格选择；变更即时写回 settings-store。
 */
import { useEffect, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { ArrowLeftRight, Gauge, LayoutGrid, Moon, Sparkles, Spline, Timer, Wand2, Zap } from "lucide-react";
import {
  FX_EFFECT_IDS,
  useSettingsStore,
  type AnimationMode,
  type AnimationSpeed,
  type FxEffectId,
  type WidgetEntrance,
  type ViewTransition
} from "../../../store/settings-store";
import { Segmented, SettingRow, SettingToggleRow } from "../shared";
import { M3Slider as Slider } from "../../../components/ui/M3Slider";
import { useT } from "../../../i18n-lite";
import { FxText } from "../../../lib/fx";
import { BezierCurveEditor } from "../BezierCurveEditor";

/** 特效管理：14 类增强特效的名称与说明（顺序 = 设置页展示顺序，与
 *  settings-store 的 FX_EFFECT_IDS 同集——核对：pixelSwap / particleText /
 *  cardHover 补齐后为 14 类）。 */
const FX_META: { id: FxEffectId; title: string; desc: string }[] = [
  { id: "starBorder", title: "流光边框", desc: "侧栏激活项、分段控件与主按钮边缘旋转行进的双色光点" },
  { id: "shinyText", title: "标题扫光", desc: "标题栏文字周期性高光扫过" },
  { id: "textFx", title: "文字动效", desc: "逐字入场、乱码解密与数值滚动" },
  { id: "listStagger", title: "错落入场", desc: "设置行与侧栏项依次滑入" },
  { id: "pointerFollow", title: "指针跟随", desc: "聚光光斑、磁吸平移与磁性按钮" },
  { id: "ambientGlow", title: "常驻氛围", desc: "侧栏光带、液态分隔线与章节下划线光带" },
  { id: "ambientMotion", title: "常驻动效", desc: "画廊漂移墙与岛内音乐跑马的循环位移" },
  { id: "hoverGlow", title: "悬停辉光", desc: "按钮光环、卡片扫光与输入聚焦光环" },
  { id: "elastic", title: "弹性反馈", desc: "开关弹性、分段弹入、胶囊橡胶拉伸、滑条尾迹与右键菜单入场" },
  { id: "springCheck", title: "弹簧勾选", desc: "待办完成的弹性填充、对勾描边画出与删除线滞后划入" },
  { id: "specular", title: "选中高光框", desc: "分段与预设卡片选中态的圆周高光" },
  { id: "pixelSwap", title: "像素涟漪", desc: "切换样式预设时荡开的像素格波纹" },
  { id: "particleText", title: "粒子文字", desc: "许可证页 Vela 粒子聚合与环形文字" },
  { id: "cardHover", title: "悬浮窗卡片", desc: "悬停放大、双色描边与视图切换器呼吸晕" }
];

export function AnimationPage() {
  // 字段级选择订阅，替代整店订阅——任何无关设置字段（主题/缩放
  // 等）变化不再触发本页全量重渲。此前订阅整个 st.extra 对象引用：sanitize
  // 每次写 extra 都新建该对象，extra 内的无关字段（网络告警阈值、点击穿透
  // 开关等）一变，本页也跟着全量重渲。字段同名展开后组件内 ex.* 引用不变。
  const ex = useSettingsStore(
    useShallow((st) => ({
      enableAnimations: st.extra.enableAnimations,
      animationSpeed: st.extra.animationSpeed,
      animationMode: st.extra.animationMode,
      animationDuration: st.extra.animationDuration,
      fxToggles: st.extra.fxToggles,
      widgetEntrance: st.extra.widgetEntrance,
      viewTransition: st.extra.viewTransition,
      customEase: st.extra.customEase,
      customEaseEnabled: st.extra.customEaseEnabled,
      idleDim: st.extra.idleDim,
      idleGlassOff: st.extra.idleGlassOff,
      setExtra: st.setExtra,
      setExtraDebounced: st.setExtraDebounced
    }))
  );
  const tr = useT();
  const [previewTick, setPreviewTick] = useState(0);

  // Auto-replay the preview whenever any animation setting changes, so the user
  // sees the effect immediately without having to click "播放预览" each time.
  // 自定义曲线开关/控制点变化同样重播——预览卡消费 --ease-entrance，所见即所得。
  // 两组拆分：离散控件（分段/开关/曲线）变化立即重播；「时长微调」滑条拖动中
  // 每 5% 触发一次 onChange，立即重播会让预览卡连闪（key 连变 → 连续重挂载），
  // 单独走 300ms trailing debounce——拖动停下后才播一次最终值。
  useEffect(() => {
    if (!ex.enableAnimations) return;
    setPreviewTick((t) => t + 1);
  }, [
    ex.enableAnimations,
    ex.animationSpeed,
    ex.animationMode,
    ex.widgetEntrance,
    ex.viewTransition,
    ex.customEaseEnabled,
    ex.customEase
  ]);
  useEffect(() => {
    // 关动画时无需重播（previewClass 为空，卡片无动画可播）。
    const id = window.setTimeout(() => setPreviewTick((t) => t + 1), 300);
    return () => window.clearTimeout(id);
  }, [ex.animationDuration]);

  // 特效开关：fxToggles 只存显式覆盖项（缺省 = 开启），打开 = 删除条目。
  // 一律从 store 现值展开（而非渲染闭包里的 ex）：连续快速点多个开关时
  // React 还没来得及重渲，闭包基线是旧的，会把上一次的改动悄悄回滚。
  const toggleFx = (id: FxEffectId, on: boolean) => {
    const next = { ...useSettingsStore.getState().extra.fxToggles };
    if (on) delete next[id];
    else next[id] = false;
    ex.setExtra({ fxToggles: next });
  };
  const allFxOn = FX_EFFECT_IDS.every((id) => ex.fxToggles[id] !== false);
  const allFxOff = FX_EFFECT_IDS.every((id) => ex.fxToggles[id] === false);

  // Determine which entrance class to apply to the preview card.
  // 视图切换优先演示（与底部提示同一优先级）；fade 档此前缺失——视图切换=淡入
  // 且小组件出现=无时预览卡无动画，提示却说「视图切换 · 当前：淡入」，自相矛盾。
  // tw-widget-fade 与 tw-view-fade 同为纯 opacity 0→1，复用 run-fade 即可。
  const previewClass = !ex.enableAnimations
    ? ""
    : ex.viewTransition === "slide"
      ? "run-slide"
      : ex.viewTransition === "fade"
        ? "run-fade"
        : ex.widgetEntrance === "scale"
          ? "run-scale"
          : ex.widgetEntrance === "fade"
            ? "run-fade"
            : "";
  // 增强档示意：动效模式=增强时预览卡点亮流光边框（feature-fx.css 的
  // .fx-demo 规则，与特效管理 starBorder 开关同闸），切换档位时预览区能
  // 直接看出「增强」比「标准」多了什么。
  const fxEnhanced = ex.enableAnimations && ex.animationMode === "enhanced";

  return (
    <>
      <section className="tm-section">
        <div className="tm-section-title">
          <FxText text={tr("动画")} />
        </div>
        <SettingToggleRow
          title="启用动画"
          desc="启用菜单、小组件和界面的过渡动画"
          icon={Zap}
          on={ex.enableAnimations}
          onChange={(v) => ex.setExtra({ enableAnimations: v })}
        />
        <SettingRow title="动画速度" desc="调整界面动画的快慢" icon={Gauge}>
          <Segmented<AnimationSpeed>
            value={ex.animationSpeed}
            onChange={(v) => ex.setExtra({ animationSpeed: v })}
            options={[
              { id: "slow", label: "慢" },
              { id: "normal", label: "标准" },
              { id: "fast", label: "快" }
            ]}
          />
        </SettingRow>
        <SettingRow title="动效模式" desc="流光边框、扫光标题等全套特效" icon={Sparkles}>
          <Segmented<AnimationMode>
            value={ex.animationMode}
            onChange={(v) => ex.setExtra({ animationMode: v })}
            options={[
              { id: "enhanced", label: "增强" },
              { id: "standard", label: "标准" },
              { id: "reduced", label: "减少动态" }
            ]}
          />
        </SettingRow>
        <SettingRow title="动画时长微调" desc="在所选速度基础上整体增减动画时长（%）" icon={Timer}>
          <Slider
            label="动画时长微调"
            value={ex.animationDuration}
            min={50}
            max={200}
            step={5}
            suffix="%"
            onChange={(v) => ex.setExtraDebounced({ animationDuration: v })}
          />
        </SettingRow>
      </section>

      <div className="tm-divider" />

      <section className="tm-section">
        <div className="tm-section-title">{tr("过渡效果")}</div>
        <SettingRow title="小组件出现" desc="添加小组件时的入场过渡" icon={LayoutGrid}>
          <Segmented<WidgetEntrance>
            value={ex.widgetEntrance}
            onChange={(v) => ex.setExtra({ widgetEntrance: v })}
            options={[
              { id: "fade", label: "淡入" },
              { id: "scale", label: "淡入缩放" },
              { id: "none", label: "无" }
            ]}
          />
        </SettingRow>
        <SettingRow title="视图切换" desc="在 Home / Work / Focus 间切换的过渡" icon={ArrowLeftRight}>
          <Segmented<ViewTransition>
            value={ex.viewTransition}
            onChange={(v) => ex.setExtra({ viewTransition: v })}
            options={[
              { id: "slide", label: "滑动" },
              { id: "fade", label: "淡入" },
              { id: "none", label: "无" }
            ]}
          />
        </SettingRow>
        {/* 空闲淡化：presence Idle ≥60s 时统一降低
            桌面卡片透明度；动一下鼠标即恢复。根类方案，非逐卡订阅。
            仅桌面（Tauri）模式生效——presence 事件由 Rust 侧发出。 */}
        <SettingToggleRow
          title="空闲时淡化卡片"
          desc="无键鼠输入约一分钟后降低桌面卡片透明度，动一下即恢复（仅桌面模式）"
          icon={Moon}
          on={ex.idleDim}
          onChange={(v) => ex.setExtra({ idleDim: v })}
        />
        {/* 空闲降玻璃：人不在桌面时全局关掉毛玻璃（data-no-glass 总闸，
            与「减少特效」同一条 CSS 门控路径），GPU 不再保留合成纹理；
            动一下鼠标即恢复原外观。 */}
        <SettingToggleRow
          title="空闲时降级玻璃"
          desc="无键鼠输入约一分钟后关闭桌面毛玻璃效果以省电，动一下即恢复（仅桌面模式）"
          icon={Zap}
          on={ex.idleGlassOff}
          onChange={(v) => ex.setExtra({ idleGlassOff: v })}
        />
      </section>

      <div className="tm-divider" />

      {/* 自定义曲线：编辑器产出经 theme-engine 写入 --ease-custom；开关决定
          小组件入场/预览卡的 --ease-entrance 是否指向它。非法曲线在编辑器内
          被拒绝，store 只会收到合法控制点。 */}
      <section className="tm-section">
        <div className="tm-section-title">{tr("自定义曲线")}</div>
        <SettingToggleRow
          title="使用自定义曲线"
          desc="用下方贝塞尔曲线替换小组件入场与预览的缓动"
          icon={Spline}
          on={ex.customEaseEnabled}
          onChange={(v) => ex.setExtra({ customEaseEnabled: v })}
        />
        <BezierCurveEditor
          value={ex.customEase}
          enabled={ex.customEaseEnabled}
          onChange={(p) => ex.setExtra({ customEase: p })}
        />
      </section>

      <div className="tm-divider" />

      <section className="tm-section">
        <div className="tm-section-title">{tr("动画预览")}</div>
        <div className="tm-anim-preview">
          <div className="tm-anim-preview-hint">{tr("更改设置将自动重播；也可手动播放")}</div>
          <button className="tm-btn-secondary" onClick={() => setPreviewTick((t) => t + 1)}>
            {tr("播放预览")}
          </button>
        </div>
        <div className="tm-preview-stage">
          <div className="preview-widgets">
            <div
              key={`card-${previewTick}`}
              className={`tm-preview-card w1 ${previewClass}${fxEnhanced ? " fx-demo" : ""}`}
            >
              <span className="preview-dot" />
              <span className="preview-line" />
            </div>
            <div
              key={`card2-${previewTick}`}
              className={`tm-preview-card w2 ${previewClass}${fxEnhanced ? " fx-demo" : ""}`}
            >
              <span className="preview-dot alt" />
              <span className="preview-line short" />
            </div>
          </div>
          <div className="tm-preview-hint-bottom">
            {/* 提示文案随设置切换：key 重建触发 4px 上滑淡入 */}
            <span
              key={`${ex.enableAnimations}-${ex.viewTransition}-${ex.widgetEntrance}-${fxEnhanced}-${ex.fxToggles.starBorder}`}
            >
              {!ex.enableAnimations
                ? tr("动画已关闭")
                : fxEnhanced
                  ? ex.fxToggles.starBorder === false
                    ? tr("增强档已开启（流光边框已在特效管理中关闭）")
                    : tr("增强档：卡片边缘演示流光边框（特效管理可逐项关闭）")
                  : ex.viewTransition !== "none"
                    ? `${tr("视图切换 · 当前：")}${ex.viewTransition === "slide" ? tr("滑动") : tr("淡入")}`
                    : ex.widgetEntrance !== "none"
                      ? `${tr("小组件入场 · 当前：")}${ex.widgetEntrance === "scale" ? tr("淡入缩放") : tr("淡入")}`
                      : tr("未选择过渡效果")}
            </span>
          </div>
        </div>
      </section>

      <div className="tm-divider" />

      <section className="tm-section tm-fx-manage" data-fx-inactive={fxEnhanced ? "0" : "1"}>
        <div className="tm-section-title">{tr("特效管理")}</div>
        <SettingRow
          title="单独开关增强特效"
          desc={
            ex.animationMode === "enhanced"
              ? "逐项开关增强档内的特效，关闭立即生效"
              : "仅在动效模式为「增强」时生效，当前未启用增强档"
          }
          icon={Wand2}
        >
          <div className="tm-fx-bulk">
            <button
              className="tm-btn-ghost"
              disabled={allFxOn}
              onClick={() => ex.setExtra({ fxToggles: {} })}
              data-interactive
            >
              {tr("全部开启")}
            </button>
            <button
              className="tm-btn-ghost"
              disabled={allFxOff}
              onClick={() =>
                ex.setExtra({
                  fxToggles: Object.fromEntries(FX_EFFECT_IDS.map((id) => [id, false] as const))
                })
              }
              data-interactive
            >
              {tr("全部关闭")}
            </button>
          </div>
        </SettingRow>
        {FX_META.map(({ id, title, desc }) => (
          <SettingToggleRow
            key={id}
            title={title}
            desc={desc}
            on={ex.fxToggles[id] !== false}
            onChange={(v) => toggleFx(id, v)}
          />
        ))}
      </section>
    </>
  );
}
