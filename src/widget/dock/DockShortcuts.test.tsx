/**
 * ISLAND-LINK 全局热键（F-10）回归：DockShortcuts 必须在 dock.enabled 门控之外
 * 存活（I-01：挂载点是 WidgetCanvas 而非 DockShell）——关岛后 Ctrl+Alt+I /
 * `vela.exe --toggle-dock` 仍能重新开岛；开岛热键顺带收起岛上残留的展开面，
 * open-dock-panel 在岛未启用时不动作。
 *
 * 事件层直接 mock `use-tauri-event`（同步登记到 handlers 表），不走
 * `@tauri-apps/api/event` 的动态 import：vitest 对同一 mock 模块的两个**并发**
 * 动态 import 会把第二个解析成真实模块（顺序 import 不受影响），而本组件恰好
 * 在同一渲染里挂两个监听。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render } from "@testing-library/react";

const handlers = new Map<string, (payload: unknown) => void>();

vi.mock("../../lib/use-tauri-event", async () => {
  const { useEffect, useRef } = await import("react");
  return {
    useTauriEvent: (event: string, handler: (payload: unknown) => void) => {
      const ref = useRef(handler);
      ref.current = handler;
      useEffect(() => {
        handlers.set(event, (p) => ref.current(p));
        return () => {
          handlers.delete(event);
        };
      }, [event]);
    }
  };
});

import { DockShortcuts } from "./DockShortcuts";
import { useWidgetExpand } from "../expand-store";
import { DEFAULT_DOCK, useWidgetStore } from "../widget-store";

const emitShortcut = (name: string) => {
  const h = handlers.get(name);
  expect(h, `${name} 监听未注册`).toBeTruthy();
  act(() => {
    h!({});
  });
};

describe("DockShortcuts（I-01：enabled 门控之外）", () => {
  beforeEach(() => {
    localStorage.clear();
    handlers.clear();
    useWidgetExpand.setState({ expandedId: null, mountedIds: [] });
    useWidgetStore.setState({ dock: { ...DEFAULT_DOCK, enabled: false } });
  });
  afterEach(() => {
    useWidgetStore.setState({ dock: { ...DEFAULT_DOCK, enabled: false } });
  });

  it("挂载即登记两条热键；岛已关时 toggle-dock 仍能把岛打开（组件不在 DockShell 的 enabled 门控内）", () => {
    render(<DockShortcuts />);
    expect(handlers.has("shortcut:toggle-dock")).toBe(true);
    expect(handlers.has("shortcut:open-dock-panel")).toBe(true);
    expect(useWidgetStore.getState().dock.enabled).toBe(false);
    emitShortcut("shortcut:toggle-dock");
    expect(useWidgetStore.getState().dock.enabled).toBe(true);
    emitShortcut("shortcut:toggle-dock");
    expect(useWidgetStore.getState().dock.enabled).toBe(false);
  });

  it("关岛顺带收起岛上展开面（dock:<tileId> / dock:panel）；画布实例的展开不受影响", () => {
    render(<DockShortcuts />);
    act(() => {
      useWidgetStore.setState({ dock: { ...DEFAULT_DOCK, enabled: true } });
      useWidgetExpand.getState().expand("dock:panel");
    });
    emitShortcut("shortcut:toggle-dock");
    expect(useWidgetStore.getState().dock.enabled).toBe(false);
    expect(useWidgetExpand.getState().expandedId).toBeNull();

    // 展开的是画布实例（非 dock: 前缀）：关岛不收它。
    act(() => {
      useWidgetStore.setState({ dock: { ...DEFAULT_DOCK, enabled: true } });
      useWidgetExpand.getState().expand("widget-1");
    });
    emitShortcut("shortcut:toggle-dock");
    expect(useWidgetStore.getState().dock.enabled).toBe(false);
    expect(useWidgetExpand.getState().expandedId).toBe("widget-1");
  });

  it("open-dock-panel：岛启用时展开全岛面板；未启用时不动作（不改持久开关）", () => {
    render(<DockShortcuts />);
    act(() => useWidgetStore.setState({ dock: { ...DEFAULT_DOCK, enabled: true } }));
    emitShortcut("shortcut:open-dock-panel");
    expect(useWidgetExpand.getState().expandedId).toBe("dock:panel");

    act(() => {
      useWidgetExpand.getState().collapse();
      useWidgetStore.setState({ dock: { ...DEFAULT_DOCK, enabled: false } });
    });
    emitShortcut("shortcut:open-dock-panel");
    expect(useWidgetExpand.getState().expandedId).toBeNull();
    expect(useWidgetStore.getState().dock.enabled).toBe(false);
  });

  it("卸载即退订：热键不再有响应者", () => {
    const r = render(<DockShortcuts />);
    expect(handlers.size).toBe(2);
    r.unmount();
    expect(handlers.size).toBe(0);
  });
});
