import { useSyncExternalStore } from "react";

/**
 * 空闲装饰降级：presence Idle ≥阈值期间为真的模块级事实源。
 *
 * 空闲是桌面常驻应用 99% 的时间占比——此前空闲只降载了采样（presence
 * 侧 sampling pause / 内存修剪），画布上的装饰动画（呼吸晕/封面旋转/
 * 天气光晕/倒计时脉冲）与时钟秒级重渲让 compositor 永不静默（动态实测
 * 空闲 ~0.47 单核 + GPU 持续活动）。这里提供两个消费面：
 *  - CSS：html[data-idle="1"] + 复用既有 ambientMotion 特效闸（data-fx-off
 *    追加 token）——装饰动画族已被该项目分类标注（功能性警示脉冲不受闸），
 *    零新增 CSS 规则即可整族暂停；
 *  - JS：useIdleDecor() 供时钟组件降频（1s 档 → 30s 档 + 收起秒位）。
 *
 * 写方唯一：app/handlers/presence.tsx 的 GlobalIdleDecor（监听 presence:state）。
 * 任何键鼠输入都会让 presence 翻回 active，降级即时解除。
 */

let idleDecor = false;
const listeners = new Set<() => void>();

function notify(): void {
  for (const fn of [...listeners]) fn();
}

/** 写方（presence handler）：翻转空闲装饰降级；同步维护根属性。 */
export function setIdleDecor(v: boolean): void {
  if (idleDecor === v) return;
  idleDecor = v;
  const root = document.documentElement;
  if (v) root.setAttribute("data-idle", "1");
  else root.removeAttribute("data-idle");
  notify();
}

/** 非组件读法（一次性判断）。 */
export function isIdleDecor(): boolean {
  return idleDecor;
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** 组件订阅：空闲装饰降级开启时为真（驱动时钟降频等 JS 侧降载）。 */
export function useIdleDecor(): boolean {
  return useSyncExternalStore(subscribe, isIdleDecor, isIdleDecor);
}
