import { useEffect } from "react";
import { useShallow } from "zustand/react/shallow";
import { appearanceSettingsFields } from "../lib/appearance-fields";
import { applySettings, reapplyTheme, useSettingsStore } from "../store/settings-store";

/**
 * 把持久化的外观设置应用到 CSS 变量：启动时与任意外观设置变化时。
 * selector 用浅比较——只有外观相关值真正变化才重渲（settingsOpen 等
 * 无关 store 写入不触发）。
 *
 * 自 App.tsx 拆出为独立模块：taskbar-net.html 精简入口也要挂它（主题
 * token 跟随），不能因此背上整个 App 组合根（画布/设置窗/托盘全家）。
 */
export function SettingsSync() {
  const settings = useSettingsStore(useShallow(appearanceSettingsFields));
  useEffect(() => {
    const st = useSettingsStore.getState();
    applySettings(
      settings,
      {
        enableAnimations: st.extra.enableAnimations,
        animationMode: st.extra.animationMode,
        animationDuration: st.extra.animationDuration,
        animationSpeed: st.extra.animationSpeed,
        fxToggles: st.extra.fxToggles,
        widgetEntrance: st.extra.widgetEntrance,
        viewTransition: st.extra.viewTransition,
        customEase: st.extra.customEase,
        customEaseEnabled: st.extra.customEaseEnabled
      },
      st.general.reduceEffects
    );
  }, [settings]);
  // 主题模式 = 系统 时跟随操作系统明暗切换：matchMedia 变化即重跑主题引擎
  // （设置本身没变，不走落盘 / 广播，纯 CSS 变量重写）。
  useEffect(() => {
    if (useSettingsStore.getState().themeMode !== "system") return;
    const mq = window.matchMedia?.("(prefers-color-scheme: dark)");
    if (!mq) return;
    const onChange = () => reapplyTheme();
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [settings.themeMode]);
  return null;
}
