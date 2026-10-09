/**
 * html 级 UI 缩放系数（--ui-zoom，theme-engine 写内联值，global.css 的
 * `html { zoom }` 消费）。设置窗口「界面缩放」≠100% 时所有窗口生效。
 *
 * CSS zoom 下的坐标模型（ShortcutFolderPopup 拖拽幽灵已在实机 Chromium 验证）：
 *  - clientX/Y 与 getBoundingClientRect() 是**视觉**坐标（已含缩放）；
 *  - position:fixed 的 left/top 是**布局**单位，渲染时再乘 zoom；
 *  - window.innerWidth/innerHeight 是未缩放视口尺寸。
 * 因此把指针/矩形视觉坐标交给 fixed 定位（或与画布布局坐标做命中比较）前，
 * 必须除回本系数；读不到内联值（测试环境 / 未应用主题）按 1 处理。
 */
export function uiZoom(): number {
  const z = parseFloat(document.documentElement.style.getPropertyValue("--ui-zoom"));
  return Number.isFinite(z) && z > 0 ? z : 1;
}
