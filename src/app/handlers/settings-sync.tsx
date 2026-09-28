/**
 * F7（组合根瘦身）：设置→Rust 单向推送桥 + 设置窗专属水合/对账组件。
 * 职责原居 App.tsx，按域拆出；行为与注释原样迁移。
 */
import { useEffect } from "react";
import { invoke, isTauri } from "../../lib/tauri";
import { useSettingsStore } from "../../store/settings-store";
import { SHORTCUT_ACTIONS, normalizeAccelerator, toRustAccelerator } from "../../lib/shortcuts";
import { useWidgetStore, readPersistedSettingsScreen } from "../../widget/widget-store";
import { resolveWindowKind } from "../window-kind";

/**
 * Hydrates the widget store in the settings window so it can list, configure
 * and manage the same widgets that live on the desktop layer. The settings
 * window renders SettingsView (not WidgetCanvas), so it must populate the
 * shared widget store itself.
 */
export function WidgetHydrate() {
  useEffect(() => {
    const store = useWidgetStore.getState();
    void store.hydrate().then(() => {
      // 恢复上次管理的屏幕分区：设置窗口默认只看主屏（screen 0），多显示器
      // 下用户上次切到外接屏管理时，重启后应回到同一屏（分区不存在时
      // switchScreen 会按该屏已存数据重建，拔掉的屏数据仍在，安全）。
      const saved = readPersistedSettingsScreen();
      if (saved !== "0" && saved !== useWidgetStore.getState().screenId) {
        useWidgetStore.getState().switchScreen(saved);
      }
    });
  }, []);
  return null;
}

/**
 * §4.5 快捷键配置对账（仅设置窗挂载）：store.shortcuts 每次变化（录制保存/
 * 导入/远端同步/重置后重启）把整表下发给 Rust 重注册；与 Rust 当前配置等价
 * 时跳过 IPC。注册失败（组合被其他应用占用）经 `shortcut:register-failed`
 * → SystemFeedbackListeners toast 反馈，无需在此重复提示。
 */
export function ShortcutConfigSync() {
  const shortcuts = useSettingsStore((s) => s.shortcuts);
  const isSettings = resolveWindowKind() === "settings";
  useEffect(() => {
    if (!isTauri() || !isSettings) return;
    const sameAsRust = (rust: Record<string, string>) =>
      SHORTCUT_ACTIONS.every((a) => normalizeAccelerator(rust[a] ?? "") === normalizeAccelerator(shortcuts[a]));
    void invoke<Record<string, string>>("get_shortcut_config")
      .then((rust) => {
        if (sameAsRust(rust ?? {})) return null;
        const config = Object.fromEntries(SHORTCUT_ACTIONS.map((a) => [a, toRustAccelerator(shortcuts[a])]));
        return invoke<string[]>("apply_shortcut_config", { config });
      })
      .catch(() => {
        // Rust 侧另有 shortcut:register-failed 广播；这里只吞 IPC 异常。
      });
  }, [shortcuts, isSettings]);
  return null;
}

/**
 * W-131 媒体监控行为偏好下发：settings.general.media 变更（含挂载首帧）
 * 单向推送给 Rust media watcher（独占播放开关 + 会话黑名单）。持久化在前
 * 端设置层；Rust 只保存运行期副本，重启后由本 hook 的首帧推送恢复。幂等
 * 推送（set 而非 toggle），多窗口并发调用无副作用。
 */
export function useMediaPrefsSync() {
  const media = useSettingsStore((s) => s.general.media);
  const pauseOthers = media?.pauseOthers ?? false;
  const blockedSessions = media?.blockedSessions;
  useEffect(() => {
    if (!isTauri()) return;
    void invoke("set_media_behavior", {
      pauseOthers,
      blockedSessions: blockedSessions ?? []
    }).catch(() => {});
  }, [pauseOthers, blockedSessions]);
  return null;
}

/**
 * DeskOrder 借鉴 #6：把「双击空白桌面切换小组件层显隐」设置单向推送到
 * Rust 鼠标钩子（幂等，多窗口并发调用无副作用）。启动与设置变化都生效，
 * 避免「设置里关掉后重启又变回开」。
 */
export function useDesktopDoubleClickSync() {
  const enabled = useSettingsStore((s) => s.general.desktopDoubleClick) !== false;
  useEffect(() => {
    if (!isTauri()) return;
    void invoke("set_desktop_double_click", { enabled }).catch(() => {});
  }, [enabled]);
  return null;
}
