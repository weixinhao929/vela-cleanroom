/**
 * 主题化 tooltip（title= 全局接管）。
 *
 * 问题：全库 173 处原生 `title=` 提示在 WebView2 里渲染为系统样式白框——
 * 不跟随应用明暗主题、约 1s 系统延迟、无法定制。逐个改 173 个调用点不现实，
 * 这里做**委托式接管**：document 级监听 mouseover，命中 [title] 元素后
 * 立即摘除其 title（防原生框弹出，mouseout 还原——DOM 语义与屏幕阅读器
 * 兜底不受影响），350ms hover-intent 后以主题令牌浮层显示。
 *
 * 设计约束：
 *  - 浮层 pointer-events: none——永不拦截指针，桌面层点击穿透语义不受影响；
 *  - 模块级单例 + 幂等安装，多 Host 挂载（设置窗 + 桌面层）互不重复；
 *  - 委任给 CSS 令牌（--paper-solid/--line/--fs-11/--dur-fx-fast），
 *    明暗主题、圆角档、动效三档全部自动跟随；
 *  - mousedown / wheel / scroll / Esc / 窗口失焦立即隐藏（位置已过时或
 *    即将交互，原生 tooltip 同款语义）。
 *
 * 挂载：App.tsx 的设置窗与桌面层分支（速记/截图/取词等极简窗不挂）。
 */
import { useEffect } from "react";
import { uiZoom } from "../lib/ui-zoom";

const SHOW_DELAY_MS = 350;
const GAP_PX = 8;
const EDGE_PX = 8;
const MAX_WIDTH = 320;

let installed = false;
let tipEl: HTMLDivElement | null = null;
let curTarget: Element | null = null;
let savedTitle: string | null = null;
let showTimer = 0;

function ensureEl(): HTMLDivElement {
  if (tipEl) return tipEl;
  tipEl = document.createElement("div");
  tipEl.className = "fd-tip";
  tipEl.setAttribute("role", "tooltip");
  tipEl.setAttribute("aria-hidden", "true");
  tipEl.style.pointerEvents = "none";
  document.body.appendChild(tipEl);
  return tipEl;
}

/** 隐藏并还原当前目标的 title（restore=false 用于元素已离开 DOM 的兜底）。 */
function hideTip(restore: boolean): void {
  if (showTimer) {
    window.clearTimeout(showTimer);
    showTimer = 0;
  }
  if (curTarget && restore && savedTitle !== null) {
    try {
      curTarget.setAttribute("title", savedTitle);
    } catch {
      // 目标已被卸载（React 重渲/节点移除）：无法也无需还原。
    }
  }
  tipEl?.classList.remove("fd-tip-on");
  curTarget = null;
  savedTitle = null;
}

function showTip(): void {
  const target = curTarget;
  const text = savedTitle?.trim();
  if (!target || !text || !tipEl) return;
  tipEl.textContent = text;
  tipEl.style.maxWidth = `${MAX_WIDTH}px`;
  tipEl.classList.add("fd-tip-on");
  const r = target.getBoundingClientRect();
  const tw = tipEl.offsetWidth;
  const th = tipEl.offsetHeight;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  // gBCR 视觉坐标 → 布局单位：÷uiZoom（fixed left/top、offsetWidth、
  // innerWidth 均为布局，直接混算在缩放 ≠100% 时会漂移/错钳）。
  const z = uiZoom();
  const rt = r.top / z;
  const rb = r.bottom / z;
  const rl = r.left / z;
  const rw = r.width / z;
  // 优先上方，放不下翻下方；水平居中并钳在视口内。
  const above = rt - th - GAP_PX >= EDGE_PX;
  const top = above ? rt - th - GAP_PX : Math.min(rb + GAP_PX, vh - th - EDGE_PX);
  const left = Math.min(Math.max(rl + rw / 2 - tw / 2, EDGE_PX), vw - tw - EDGE_PX);
  tipEl.style.top = `${Math.max(EDGE_PX, Math.round(top))}px`;
  tipEl.style.left = `${Math.round(left)}px`;
}

function onOver(e: MouseEvent): void {
  const node = e.target instanceof Element ? e.target : null;
  const t = node?.closest?.("[title]") ?? null;
  // data-no-tip：调用方显式豁免（自绘提示已存在时）。
  if (!t || t.closest("[data-no-tip]")) {
    if (curTarget && t !== curTarget) hideTip(true);
    return;
  }
  if (t === curTarget) return; // 同一目标的子元素间移动，不重置计时
  hideTip(true);
  const title = t.getAttribute("title") ?? "";
  if (!title.trim()) return;
  curTarget = t;
  savedTitle = title;
  // 立即摘除：原生 tooltip 在 ~1s 后弹出，摘掉它主题化浮层才有唯一呈现权。
  t.removeAttribute("title");
  ensureEl();
  showTimer = window.setTimeout(showTip, SHOW_DELAY_MS);
}

function onOut(e: MouseEvent): void {
  if (!curTarget) return;
  const from = e.target instanceof Element ? e.target : null;
  if (!from || !(curTarget === from || curTarget.contains(from))) return;
  // relatedTarget 仍落在当前目标子树内（移到子元素上）→ 不算离开。
  const to = e.relatedTarget instanceof Element ? e.relatedTarget : null;
  if (to && (to === curTarget || curTarget.contains(to))) return;
  hideTip(true);
}

function install(): void {
  if (installed || typeof document === "undefined") return;
  installed = true;
  document.addEventListener("mouseover", onOver, true);
  document.addEventListener("mouseout", onOut, true);
  // 点击 / 滚轮 / 滚动 / 退格滚动：立即收起（原生 tooltip 同语义），capture
  // 捕获内层滚动容器的 scroll。
  document.addEventListener("mousedown", () => hideTip(true), true);
  document.addEventListener("wheel", () => hideTip(true), { capture: true, passive: true });
  document.addEventListener("scroll", () => hideTip(true), true);
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") hideTip(true);
  });
  window.addEventListener("blur", () => hideTip(true));
}

/** 挂载即安装全局接管（幂等；组件本身不渲染任何内容）。 */
export function ThemeTooltipHost(): null {
  useEffect(() => {
    install();
  }, []);
  return null;
}
