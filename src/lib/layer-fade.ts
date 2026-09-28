/**
 * 层显隐淡入淡出：配合 Rust 侧 windows.rs::toggle_widget_layer 的显隐编排。
 *
 * - 隐藏：Rust 先广播 `layer:fade-out`，本模块给根节点挂 `.layer-vanishing`，
 *   body 以 --dur-fx 淡出；Rust 延迟 max(240ms, --dur-fx+40ms) 后无条件 hide
 *   （时长由 theme-engine 随速度档上报，见 windows.rs LAYER_FADE_FX_MS）——本
 *   模块不需要回执，WebView 卡死/未响应时只是退化为瞬时隐藏，绝不会藏不掉。
 * - 显示：Rust show 之后再广播 `layer:fade-in`（此时窗口呈现的是隐藏前的
 *   透明末帧），本模块挂 `.layer-revealing` 播 keyframes 从 opacity 0 淡入，
 *   播完停在基态；超时兜底摘类。
 *
 * 仅桌面层窗口安装（main.tsx）；浏览器开发模式与设置/速记窗不生效。
 * reduce-motion 不需要专门处理：全局 0.001s 压缩已让淡入淡出不可感知。
 */
import { isTauri } from "./tauri";
import { animDurations } from "./durations";

let installed = false;

export function installLayerFade(): void {
  if (installed || !isTauri()) return;
  installed = true;
  let revealTimer = 0;

  void import("@tauri-apps/api/event").then(({ listen }) => {
    void listen("layer:fade-out", () => {
      window.clearTimeout(revealTimer);
      const root = document.documentElement;
      root.classList.remove("layer-revealing");
      root.classList.add("layer-vanishing");
    });
    void listen("layer:fade-in", () => {
      const root = document.documentElement;
      root.classList.remove("layer-vanishing");
      root.classList.remove("layer-revealing");
      // 强制 reflow 后重挂类，保证连续 show 也能重播淡入。
      void root.offsetWidth;
      root.classList.add("layer-revealing");
      window.clearTimeout(revealTimer);
      // P1：兜底摘类时长与淡入 keyframes 同源（--dur-fx 派生 + 40ms 余量），
      // 对齐 Rust 侧 layer_fade_hide_after_ms 的同源派生——此前写死 400ms，
      // 只因 --anim-dur 恰有 0.5s 封顶使 --dur-fx 最大恰为 400ms 才不掐尾。
      revealTimer = window.setTimeout(() => root.classList.remove("layer-revealing"), animDurations().fxMs + 40);
    });
  });
}
