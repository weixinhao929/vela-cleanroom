/**
 * 应用内 OSD 事件（G10）：画布小组件调整亮度 / 播放应用音量时，向灵动岛
 * 接管条广播一条「即时反馈」（对标 Windows 音量/亮度 OSD）。
 *
 * 只覆盖应用内自身的调整入口（画布卡片滑杆 / 音乐卡滚轮）——岛内
 * BrightnessMini 自带滑杆，同源调整若再触发接管会把正在拖动的磁贴层
 * 藏起来（接管期间磁贴隐藏），因此 dock 内的控件不发此事件。系统级
 * （键盘快捷键 / 显示器按键）变化需要 Rust 侧挂回调 watcher，不在本层。
 */
import type { TakeoverKind } from "../widget/dock/dock-logic";

export type OsdKind = Extract<TakeoverKind, "brightness" | "volume">;
export type OsdPayload = { kind: OsdKind; title: string; sub?: string };

export const OSD_EVENT = "focus-desk:osd";

/** 广播一条 OSD 接管（尽力而为，无监听者时静默丢弃）。 */
export function notifyOsd(kind: OsdKind, title: string, sub?: string): void {
  try {
    window.dispatchEvent(new CustomEvent<OsdPayload>(OSD_EVENT, { detail: { kind, title, sub } }));
  } catch {
    // ignore
  }
}
