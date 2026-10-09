/* eslint-disable react-refresh/only-export-components */
/**
 * 就地配置弹层（「配置在上下文中」）：锚定在小组件卡片上方的玻璃弹层，
 * 不跳设置窗口即可修改该实例的常用配置。
 *
 * 本文件是壳：保留全部导出面（类型 / openWidgetSettingsPage / placePopover
 * 定位数学 / WidgetConfigPopover 组件），真实现懒加载自 WidgetConfigPopoverInner
 * 实现 chunk 静态依赖 config-schemas（zod）与 settings/shared（M3Slider →
 * motion/react），只有弹层打开时才需要，不能随画布进主 chunk。调用方多以
 * open=false 常驻挂载，故首次 open 翻真才 arm 拉取；弹层由用户手势（齿轮/
 * 右键「配置」）打开，本地 chunk 加载瞬时完成。
 *
 * 键盘 / 单例互斥 / 点击穿透语义见 Inner 文件头与实现内注释（原文迁移）。
 */
import { Suspense, useEffect, useState } from "react";
import { isTauri, openSettingsWindow } from "../lib/tauri";
import { makeResettableLazy } from "../lib/make-resettable-lazy";
import { useSettingsStore } from "../store/settings-store";
import { currentScreenId } from "./widget-store";

/**
 * 锚定矩形（布局单位）：与 WidgetCard/GroupCard 传入的实例/组几何同坐标系。
 * 注意 getBoundingClientRect() 返回的是**视觉**坐标（界面缩放下 = 布局 ×
 * uiZoom），由 gBCR 构造锚点的调用方（dock 磁贴等）必须先除回 uiZoom。
 */
export type PopoverAnchor = { x: number; y: number; w: number; h: number };

export type WidgetConfigPopoverProps = {
  instanceId: string;
  /** 小组件类型（registry type）；决定 quick 字段表与标题。 */
  widgetType: string;
  /** 锚定矩形。open 翻真时取一次快照，之后卡片位置变化不跟随（非编辑模式下卡片不会动）。 */
  anchor: PopoverAnchor;
  open: boolean;
  onClose: () => void;
};

/* ------------------------------------------------------------------ */
/*  深度设置入口：跳设置窗口直达本实例配置页（从 WidgetCard.openConfig 迁出） */
/* ------------------------------------------------------------------ */

/**
 * 呼出设置窗口并直达本实例配置页。双通道保证可靠：Tauri 事件 + localStorage
 * 兜底（设置窗口挂载/聚焦时读取）。载荷带本窗口的 screenId：设置窗口的 store
 * 默认绑定主屏分区，外接屏的组件必须先让对端切换分区，否则配置页找不到实例。
 */
export function openWidgetSettingsPage(instanceId: string): void {
  const page = `widget-config-${instanceId}`;
  const screenId = currentScreenId();
  useSettingsStore.getState().setSettingsPage(page);
  try {
    localStorage.setItem("focus-desk.pending-nav", JSON.stringify({ page, screenId }));
  } catch {
    // best-effort
  }
  if (isTauri()) {
    void openSettingsWindow();
    void import("@tauri-apps/api/event").then(({ emit }) => emit("app:navigate-settings", { page, screenId }));
  } else {
    useSettingsStore.getState().setSettingsOpen(true);
  }
}

/**
 * 编组版深度设置入口：直达设置窗口的编组配置页（group-config-<gid>：组级
 * 透明度 / 成员管理 / 解散）。与实例版同一条双通道（Tauri 事件 + localStorage
 * 兜底 + screenId 分区提示）。
 */
export function openGroupSettingsPage(groupId: string): void {
  const page = `group-config-${groupId}`;
  const screenId = currentScreenId();
  useSettingsStore.getState().setSettingsPage(page);
  try {
    localStorage.setItem("focus-desk.pending-nav", JSON.stringify({ page, screenId }));
  } catch {
    // best-effort
  }
  if (isTauri()) {
    void openSettingsWindow();
    void import("@tauri-apps/api/event").then(({ emit }) => emit("app:navigate-settings", { page, screenId }));
  } else {
    useSettingsStore.getState().setSettingsOpen(true);
  }
}

/** 单例互斥事件名：卡片配置弹层与编组配置弹层共用（打开方广播令牌，他方收到即自关）。 */
export const WCFG_OPEN_EVENT = "focus-desk:widget-config-popover-open";

/**
 * 弹层互斥令牌全局单源：互斥协议要求「打开方广播的令牌」与「自己
 * 记住的令牌」在全窗范围内可比且唯一——此前两套并存（Inner 用模块级自增
 * openSeq、编组面板用 Date.now()），Date.now() 毫秒精度下同毫秒连开两个
 * 面板会同令牌，互斥判定 detail !== token 会把「别人」误判成「自己」而漏关。
 * 收敛为同一模块级自增序列（本壳文件两侧——Inner 与 GroupConfigPanel——
 * 都从这里取号），单调递增、永不撞号。
 */
let wcfgTokenSeq = 0;

/** 取下一个弹层互斥令牌（模块级自增，见上方说明）。 */
export function nextWcfgToken(): number {
  wcfgTokenSeq += 1;
  return wcfgTokenSeq;
}

/* ------------------------------------------------------------------ */
/*  几何                                                                */
/* ------------------------------------------------------------------ */

/** 弹层与视口边缘 / 锚点之间的留白（px）。 */
const MARGIN = 10;
const GAP = 8;

type Placement = { left: number; top: number; below: boolean };

/**
 * 计算弹层位置：水平居中于锚点并钳制进视口；垂直优先放锚点上方，放不下时翻转
 * 到下方（与悬浮工具条 `y < 40 → 下方` 同一策略，只是阈值换成实测高度），仍
 * 越界则贴底钳制。纯函数便于单测。
 */
export function placePopover(
  anchor: PopoverAnchor,
  size: { w: number; h: number },
  viewport: { w: number; h: number }
): Placement {
  let left = anchor.x + anchor.w / 2 - size.w / 2;
  left = Math.min(Math.max(left, MARGIN), Math.max(MARGIN, viewport.w - size.w - MARGIN));
  let top = anchor.y - size.h - GAP;
  let below = false;
  if (top < MARGIN) {
    top = anchor.y + anchor.h + GAP;
    below = true;
  }
  if (top + size.h > viewport.h - MARGIN) top = Math.max(MARGIN, viewport.h - size.h - MARGIN);
  return { left, top, below };
}

/* ------------------------------------------------------------------ */
/*  组件：懒加载壳                                                      */
/* ------------------------------------------------------------------ */

/* 可重置 lazy——实现 chunk 拉取失败后弃缓存，重开弹层即重新 import
   （弹层由用户手势打开，失败沿画布冒泡；无本地错误边界，靠弃缓存自愈）。 */
const WidgetConfigPopoverInner = makeResettableLazy(
  () => import("./WidgetConfigPopoverInner").then((m) => ({ default: m.WidgetConfigPopoverInner })),
  "WidgetConfigPopoverInner"
);

export function WidgetConfigPopover(props: WidgetConfigPopoverProps) {
  /* open=false 时 Inner 不挂载：常驻挂载的调用方（WidgetCard 工具条、时钟齿轮、
     磁贴右键配置…）在用户第一次打开弹层前不应触发实现 chunk 的加载。 */
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (props.open) setArmed(true);
  }, [props.open]);
  if (!armed) return null;
  return (
    <Suspense fallback={null}>
      <WidgetConfigPopoverInner.Component {...props} />
    </Suspense>
  );
}
