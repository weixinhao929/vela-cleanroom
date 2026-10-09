/**
 * [CLICK-SHIELD]弹窗/浮层关闭后的短暂点击屏蔽。
 *
 * 场景：浮层（文件夹弹窗 / 画廊 / 命令面板 / 右键菜单…）恰好停在某个可点
 * 元素上方时，用户连点「关闭」的第二次点击会穿透到下层（浮层已卸载，点击
 * 落到画布/桌面）。同类工具 的做法是关掉弹窗后屏蔽 3 帧点击；这里按
 * 同语义取 80ms（≈5 帧 @60Hz，覆盖一次误连点）。
 *
 * 默认关闭（`extra.popupClickShield`）：「替用户吞掉输入」会改变操作手感，
 * 只让明确需要的用户开启（用户裁定）。
 *
 * 依赖方向：本模块被 lib/anim.ts（统一退场原语 useDelayedUnmount）调用，
 * 开关值由 settings-store 订阅后经 {@link setPopupClickShieldEnabled} 推入
 * （依赖倒置——lib 层不反向 import store，避免环）。
 *
 * 实现要点：document 捕获层吞掉 pointerdown（preventDefault +
 * stopImmediatePropagation，click 由浏览器跟随抑制），到期自动失效；重复
 * arm 幂等（重置截止时刻，不叠加监听器）。
 */

/** 默认屏蔽时长（毫秒）。 */
const DEFAULT_SHIELD_MS = 80;

let enabled = false;
let armedUntil = 0;
let listenerInstalled = false;

function onPointerDown(e: PointerEvent) {
  if (Date.now() >= armedUntil) return;
  e.preventDefault();
  e.stopImmediatePropagation();
}

function installListener() {
  if (listenerInstalled) return;
  listenerInstalled = true;
  document.addEventListener("pointerdown", onPointerDown, {
    capture: true,
    passive: false
  });
}

/** settings-store 订阅推送开关值（sanitize 后的权威值）。 */
export function setPopupClickShieldEnabled(v: boolean): void {
  enabled = v;
}

/** 浮层关闭路径调用：开关开启时屏蔽后续 ~ms 毫秒的 pointerdown。 */
export function armPopupClickShield(ms: number = DEFAULT_SHIELD_MS): void {
  if (!enabled) return;
  armedUntil = Date.now() + ms;
  installListener();
}

/** 测试辅助：复位开关并移除监听器。 */
export function __resetClickShieldForTest(): void {
  enabled = false;
  armedUntil = 0;
  if (listenerInstalled) {
    listenerInstalled = false;
    document.removeEventListener("pointerdown", onPointerDown, { capture: true } as EventListenerOptions);
  }
}
