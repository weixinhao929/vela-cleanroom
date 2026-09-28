/**
 * [SPLIT-THEME] 分体主题同步（借鉴 ClassSoftwareHub #13）：设置窗 / 速记窗
 * 按「浮窗深浅」设置，以**改写明暗档后的快照**在本窗口重放同一主题引擎
 * （applySettings 仍是唯一写入者，桌面层窗口不受影响）。挂载顺序必须在
 * SettingsSync 之后：本窗的覆盖写总在其全局写之后落定（订阅触发顺序同挂载
 * 顺序）；follow 档直接跳过（SettingsSync 的全局写即最终态）。
 */
import { useEffect } from "react";
import { applySettings, consumeFloatingThemeApplyDeferral } from "../lib/theme-engine";
import { themeEnvOf, useSettingsStore } from "../store/settings-store";

export function FloatingThemeSync() {
  useEffect(() => {
    const apply = () => {
      const st = useSettingsStore.getState();
      const mode = st.floatingThemeMode;
      if (mode === "follow") return;
      // P2-3：水墨接管期间吞掉本次覆盖重放（StylePage 的 onCovered 会带着
      // 分体快照统一上色），否则 token 先行硬切，晕开只剩装饰。
      if (consumeFloatingThemeApplyDeferral()) return;
      applySettings({ ...st, themeMode: mode }, themeEnvOf(st), st.general.reduceEffects);
    };
    apply();
    return useSettingsStore.subscribe(() => apply());
  }, []);
  return null;
}
