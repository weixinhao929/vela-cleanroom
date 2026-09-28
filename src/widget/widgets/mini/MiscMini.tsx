/**
 * 「杂项」迷你磁贴：格子图标 + 面板里的小组件数。
 * 条目数从 dock 配置里那枚 misc 磁贴的 config.items 读（未绑定磁贴同类型只允许一枚，
 * 见 widget-store.findDockTileConflict），经 sanitizeMiscItems 过滤坏条目再计数。
 */
import { useMemo } from "react";
import { LayoutGrid } from "lucide-react";
import { useWidgetStore } from "../../widget-store";
import { sanitizeMiscItems } from "../misc/misc-layout";
import type { MiniComponentProps } from "../../registry";

export function MiscMini(_props: MiniComponentProps) {
  // selector 只取 config 引用（store 任意更新都触发 selector，但 sanitizeMiscItems
  // 的 O(n²) 净化只在 config 真变时经 useMemo 跑一次）。
  const config = useWidgetStore((s) => s.dock.tiles.find((t) => t.type === "misc")?.config);
  const count = useMemo(() => (config ? sanitizeMiscItems(config.items).length : 0), [config]);
  return (
    <span className="dock-mini dock-mini-misc">
      <LayoutGrid size={14} className="dock-mini-ico" />
      <span className="dock-mini-num">{count}</span>
    </span>
  );
}
