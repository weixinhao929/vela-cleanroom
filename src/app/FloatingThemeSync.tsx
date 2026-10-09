/**
 * [SPLIT-THEME] 分体主题同步：设置窗 / 速记窗
 * 按「浮窗深浅」设置，以**改写明暗档后的快照**在本窗口重放同一主题引擎
 * （applySettings 仍是唯一写入者，桌面层窗口不受影响）。挂载顺序必须在
 * SettingsSync 之后：本窗的覆盖写总在其全局写之后落定（订阅触发顺序同挂载
 * 顺序）；follow 档直接跳过（SettingsSync 的全局写即最终态）。
 */
import { useEffect } from "react";
import { useShallow } from "zustand/react/shallow";
import { applySettings, consumeFloatingThemeApplyDeferral } from "../lib/theme-engine";
import { themeEnvOf, useSettingsStore } from "../store/settings-store";
import { appearanceSettingsFields } from "../lib/appearance-fields";

export function FloatingThemeSync() {
  /* selector 浅比较订阅（此前订阅整店——settingsOpen 等无关写入也触发
     覆盖重放 + 全套 CSS 变量重写）。依赖集 = SettingsSync 导出的公共外观
     字段清单 + floatingThemeMode（单点维护，新增外观字段不再靠两份手写
     清单人工同步）。 */
  const settings = useSettingsStore(
    useShallow((s) => ({ ...appearanceSettingsFields(s), floatingThemeMode: s.floatingThemeMode }))
  );
  useEffect(() => {
    const mode = settings.floatingThemeMode;
    if (mode === "follow") return;
    // 水墨接管期间吞掉本次覆盖重放（StylePage 的 onCovered 会带着
    // 分体快照统一上色），否则 token 先行硬切，晕开只剩装饰。
    if (consumeFloatingThemeApplyDeferral()) return;
    applySettings(
      { ...settings, themeMode: mode },
      {
        enableAnimations: settings.enableAnimations,
        animationMode: settings.animationMode,
        animationDuration: settings.animationDuration,
        animationSpeed: settings.animationSpeed,
        fxToggles: settings.fxToggles,
        widgetEntrance: settings.widgetEntrance,
        viewTransition: settings.viewTransition,
        customEase: settings.customEase,
        customEaseEnabled: settings.customEaseEnabled
      },
      settings.reduceEffects
    );
  }, [settings]);
  /* 系统明暗切换冲掉浮窗覆盖——themeMode=system 时 SettingsSync 的
     matchMedia→reapplyTheme 会以全局档重写 html 且不触发任何 store 订阅，
     本窗的覆盖写被静默盖掉。自挂同一 matchMedia 监听重放覆盖写（挂载顺序在
     SettingsSync 之后，监听注册序即触发序，覆盖写总在其全局写之后落地）。
     仅在「覆盖生效 + 全局档为 system」时挂，避免与上面的 store 订阅重复
     重放；回调读实时 getState——事件时刻的最新设置才是应重放的快照。 */
  useEffect(() => {
    if (settings.floatingThemeMode === "follow" || settings.themeMode !== "system") return;
    const mq = window.matchMedia?.("(prefers-color-scheme: dark)");
    if (!mq) return;
    const onChange = () => {
      const st = useSettingsStore.getState();
      if (st.floatingThemeMode === "follow") return;
      if (consumeFloatingThemeApplyDeferral()) return;
      applySettings({ ...st, themeMode: st.floatingThemeMode }, themeEnvOf(st), st.general.reduceEffects);
    };
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [settings.floatingThemeMode, settings.themeMode]);
  return null;
}
