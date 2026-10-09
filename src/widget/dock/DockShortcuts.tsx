/**
 * 灵动岛全局热键（ISLAND-LINK）：把 shortcuts.rs 第 8/9 个可配置动作接到岛上。
 *
 * 挂载点是 WidgetCanvas（不是 DockShell）：DockShell 在 dock.enabled=false 时整体
 * 返回 null，监听若随它卸载，关岛后 Ctrl+Alt+I / `--toggle-dock` 就只能关不能开。
 * 本组件与画布同生命周期，岛开关状态不影响它。
 *
 *  - `shortcut:toggle-dock`（默认 Ctrl+Alt+I / `vela.exe --toggle-dock`）→ 翻转本屏
 *    dock.enabled。关岛时顺带收起岛上正在展开的面（dock:<tileId> / dock:panel）：
 *    DockShell 关岛即整体卸载，expand-store 里残留的 id 会让重开时面板凭空弹出。
 *  - `shortcut:open-dock-panel`（默认 Ctrl+Alt+O / `--open-dock-panel`）→
 *    expand("dock:panel")。Rust dispatch 已先确保小组件层可见（层隐藏时面板无处
 *    可显，与 toggle-palette 同款）；岛未启用时不动作——「打开面板」不该顺手改
 *    持久化的岛开关。
 *
 * 两事件到达所有窗口，只有 primary（widget-0；浏览器预览视为 primary）响应，与
 * CommandPalette 的判定一致：dock 配置按屏独立持久化、经 sync:dock 按屏同步，多屏
 * 只翻转主屏那条，不会两屏同开两份面板。状态一律经 getState() 现读，热键回调
 * 不依赖渲染闭包。
 *
 * 岛内键盘导航（Tab 进岛后 ←/→ 移焦、Enter 展开、Esc 收起、Ctrl+←/→ 排序、
 * Delete 移除）属 ，由 KEYS 会话在此补齐。
 */
import { isPrimaryWidgetWindow } from "../../lib/tauri";
import { useTauriEvent } from "../../lib/use-tauri-event";
import { useWidgetExpand } from "../expand-store";
import { useWidgetStore } from "../widget-store";
import { DOCK_EXPAND_PREFIX, DOCK_PANEL_EXPAND_ID } from "./dock-logic";

export function DockShortcuts() {
  useTauriEvent("shortcut:toggle-dock", () => {
    if (!isPrimaryWidgetWindow()) return;
    const s = useWidgetStore.getState();
    if (s.dock.enabled) {
      const ex = useWidgetExpand.getState();
      if (ex.expandedId?.startsWith(DOCK_EXPAND_PREFIX)) ex.collapse();
    }
    s.setDock({ enabled: !s.dock.enabled });
  });

  useTauriEvent("shortcut:open-dock-panel", () => {
    if (!isPrimaryWidgetWindow()) return;
    if (!useWidgetStore.getState().dock.enabled) return;
    useWidgetExpand.getState().expand(DOCK_PANEL_EXPAND_ID);
  });

  return null;
}
