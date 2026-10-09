/**
 * 外观相关字段公共清单（浅比较 selector 用）：SettingsSync（全局应用）与
 * FloatingThemeSync（分体覆盖，追加 floatingThemeMode）共用同一份——新增
 * 外观字段只改这里，杜绝两份手写清单漂移（二轮修复 ：此前两处各抄
 * 一份 23 项，靠注释提醒人工同步）。
 *
 * 独立 lib 模块而非从 SettingsSync.tsx 导出：react-refresh 门禁要求组件
 * 文件只导出组件（fast refresh 边界）。
 */
import type { SettingsState } from "../store/settings-store";

export function appearanceSettingsFields(s: SettingsState) {
  return {
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
    // 自定义曲线：--ease-custom / --ease-entrance 同样由 applySettings 写入。
    customEase: s.extra.customEase,
    customEaseEnabled: s.extra.customEaseEnabled
  };
}
