/**
 * 弹层关闭后归还焦点：open 翻真时记录 document.activeElement（触发
 * 元素），翻假时若该元素仍在文档中则把焦点归还给它——此前右键菜单、小组件
 * 配置弹层、编组配置面板三类浮层关闭后焦点跌落 body，键盘用户每次都要重新
 * Tab 定位。契约与 PromptDialog 的「关闭归还焦点」（同源）一致：
 *
 *  - 记录发生在 open 变 true 的提交期（useLayoutEffect，先于各弹层把自己的
 *    焦点移入——有的弹层在 layout effect 里聚焦容器，普通 useEffect 会记到
 *    弹层自身而非触发元素）；弹层用 rAF 延迟聚焦的（如 wcfg 弹层）两种时序
 *    都安全；
 *  - 归还以 isConnected 守卫：触发元素可能已卸载（如卡片被删、菜单 DOM 退场
 *    完毕），此时退化为不动；focus 包 try——元素被禁用/隐藏时浏览器可能抛错，
 *    不让归还动作阻断关闭流程；
 *  - 成对翻转：open 每次翻 true 重记、翻假归还一次；组件在 open=true 期间
 *    整体卸载（宿主连坐消失）不归还——无从归还，焦点交给浏览器默认行为。
 */
import { useLayoutEffect, useRef } from "react";

export function useFocusReturn(
  /** 弹层打开状态；翻 false 视为「关闭完成开始」，延迟卸载动画期间即归还。 */
  open: boolean
): void {
  const prevFocusRef = useRef<HTMLElement | null>(null);
  const wasOpenRef = useRef(false);
  useLayoutEffect(() => {
    if (open && !wasOpenRef.current) {
      wasOpenRef.current = true;
      prevFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    } else if (!open && wasOpenRef.current) {
      wasOpenRef.current = false;
      const prev = prevFocusRef.current;
      prevFocusRef.current = null;
      if (prev && prev.isConnected) {
        try {
          prev.focus({ preventScroll: true });
        } catch {
          // 元素不可聚焦（隐藏/禁用）等异常不阻断弹层关闭。
        }
      }
    }
  }, [open]);
}
