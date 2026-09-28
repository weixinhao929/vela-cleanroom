import { useEffect } from "react";
import { useShallow } from "zustand/react/shallow";
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
  const settings = useSettingsStore(
    useShallow((s) => ({
      preset: s.preset,
      themeMode: s.themeMode,
      primaryColor: s.primaryColor,
      customColors: s.customColors,
      zoom: s.zoom,
      font: s.font,
      fontSize: s.fontSize,
      widgetBackground: s.widgetBackground,
      widgetOpacity: s.widgetOpacity,
      settingsWindowOpacity: s.settingsWindowOpacity,
      cornerRadius: s.cornerRadius,
      spacing: s.spacing,
      blur: s.blur,
      reduceEffects: s.general.reduceEffects,
      enableAnimations: s.extra.enableAnimations,
      animationSpeed: s.extra.animationSpeed,
      animationDuration: s.extra.animationDuration,
      animationMode: s.extra.animationMode,
      widgetEntrance: s.extra.widgetEntrance,
      viewTransition: s.extra.viewTransition,
      // 特效独立开关驱动 applySettings 重写 data-fx-off（CSS 侧门控）。
      // 此前不在此列：当前窗口切换开关后 JS 侧立即生效，但 CSS 门控的
      // 特效（侧栏流光/扫光等）须等重启或改其他外观项才刷新。
      fxToggles: s.extra.fxToggles,
      // B3 自定义曲线：--ease-custom / --ease-entrance 同样由 applySettings 写入。
      customEase: s.extra.customEase,
      customEaseEnabled: s.extra.customEaseEnabled
    }))
  );
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
