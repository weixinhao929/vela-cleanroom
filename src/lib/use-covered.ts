/**
 * [COVERED]画布被完全遮挡的感知门。
 *
 * Rust presence 快照的 `covered`（前台全屏 / 单屏前台最大化，3s 去抖）表示
 * **桌面小组件层**整体被盖住——此刻窗口仍 document.visible（Chromium 无遮挡
 * 感知），rAF / interval 照跑、采样照发，纯烧 CPU/GPU（09-28 资源占用专项的
 * CSS 侧已降玻璃/停装饰，这里是 JS 节拍侧的收口）。
 *
 * 窗口作用域：covered 只对 `widget-*` 画布窗成立——全屏展示窗自己就是遮挡
 * 源（番茄钟大字钟必须继续走秒），settings/quick-note 等普通窗口同理豁免。
 *
 * 消费面：
 *  - use-now 共享节拍器（本模块的 [`coveredTickGate`]，全部 useNow 消费者
 *    一处挂起，恢复可见补一拍）；
 *  - AudioVisualizer rAF 绘制循环 / SystemBar 采样定时器（各自 import
 *    [`coveredTickGate`]，与 document.hidden 同一分支）。
 */
import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { currentWindowLabel, isTauri } from "./tauri";

type PresencePayload = { covered?: boolean };

/** covered 标志只在 widget-* 画布窗生效（全屏窗是遮挡源本身，必须继续走拍）。 */
const gateApplies = (currentWindowLabel() ?? "").startsWith("widget-");

let covered = false;
let installed = false;
const listeners = new Set<(covered: boolean) => void>();

function install(): void {
  if (installed || !isTauri()) return;
  installed = true;
  /* 模块级常驻（窗口生命周期，随页面卸载销毁——installed 幂等闸保证
     只注册一次；同类常驻见 layer-fade/system-notify）。：补 catch 防
     注册失败产生未处理 rejection。 */
  void listen<PresencePayload>("presence:state", (e) => {
    const next = !!e.payload?.covered;
    if (next === covered) return;
    covered = next;
    for (const fn of [...listeners]) fn(next);
  }).catch((err: unknown) => console.error("[covered] listen presence:state failed:", err));
}

/** tick / rAF / 采样循环的门：true = 本窗口被完全遮挡，跳过本拍工作。 */
export function coveredTickGate(): boolean {
  install();
  return gateApplies && covered;
}

/** 当前 covered 状态（React 版，重渲型消费）。 */
export function useCovered(): boolean {
  const [state, setState] = useState(() => coveredTickGate());
  useEffect(() => {
    install();
    const fn = (v: boolean) => setState(v);
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  }, []);
  return state;
}

/** 变更订阅（use-now 恢复补拍用）。 */
export function subscribeCoveredChange(fn: (covered: boolean) => void): () => void {
  install();
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
