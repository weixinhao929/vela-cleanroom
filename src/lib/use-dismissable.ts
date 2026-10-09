/**
 * 弹层关闭交互的统一骨架（ex-三套并存：document pointerdown capture /
 * window mousedown 冒泡 / onClick 外点；Esc capture 与 bubble 各半）。
 *
 * 职责：
 *  - 外点关闭：document `pointerdown` capture 阶段判定目标不在弹层（及可选
 *    触发锚点）内即关闭——按下即关，时序与 touch/笔输入一致；
 *  - Esc 关闭：window `keydown` capture 阶段 stopPropagation + preventDefault，
 *    嵌套弹层时只关最上层（capture 先于页面上其它 Esc 处理器拿到事件，
 *    避免一键关两层）；
 *  - 焦点归还（可选）：打开时记录 document.activeElement，关闭时归还
 *    （isConnected 守卫，触发元素已卸载则退化为不动）。
 *
 * opts 经 ref 读取：effect 只依赖 open，回调/锚点数组每轮新建不重挂监听。
 */
import { useEffect, useRef, type RefObject } from "react";

export interface DismissableOptions {
  /** 处理 Esc 关闭（默认 true）。弹层自带分步 Esc 逻辑时置 false。 */
  escape?: boolean;
  /** 处理外点关闭（默认 true）。 */
  outside?: boolean;
  /** 关闭时把焦点归还给打开时的 document.activeElement（默认 false）。 */
  restoreFocus?: boolean;
  /** 额外视为「内部」的元素（触发按钮 / 锚点）：pointerdown 命中不关闭。 */
  anchors?: readonly RefObject<Node | null>[];
}

export function useDismissable(
  /** 打开状态；false 时不挂任何监听。 */
  open: boolean,
  /** 弹层根元素 ref（外点判定的「内部」）。 */
  ref: RefObject<Node | null>,
  /** 请求关闭（外点 / Esc）。 */
  onClose: () => void,
  opts: DismissableOptions = {}
): void {
  const { escape = true, outside = true, restoreFocus = false, anchors } = opts;
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  /* opts 快照经 ref 读取：effect 只依赖 open，escape/outside/anchors 每轮新建
     或翻转都不重挂监听（也满足 exhaustive-deps）。 */
  const optsRef = useRef({ escape, outside, anchors });
  optsRef.current = { escape, outside, anchors };
  const prevFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    if (restoreFocus) {
      prevFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    }
    const inside = (target: EventTarget | null): boolean => {
      if (!(target instanceof Node)) return true;
      if (ref.current?.contains(target)) return true;
      for (const a of optsRef.current.anchors ?? []) {
        if (a.current?.contains(target)) return true;
      }
      return false;
    };
    /* 与统一右键菜单（ContextMenuHost）的分层协作（DOM 判定，不反向
       import components 保持 lib 依赖方向）：
       - 右键菜单开着时，菜单内的按下不是「弹层外点」——点菜单项不应连坐
         关闭它底下的弹层（菜单有自己的关闭管理）；
       - Esc 分层：菜单开着时第一下 Esc 只关菜单（Host 的 document 捕获
           处理器随后接手），本弹层不抢键——否则 stopPropagation 会把菜单
           留成无主浮层。 */
    const ctxMenuOpen = () => document.querySelector(".ctx-menu") !== null;
    const onDown = (e: PointerEvent) => {
      if (!optsRef.current.outside || inside(e.target)) return;
      /* fd-prompt-overlay（PromptDialog 模态确认/
         命名对话框）同 ctx-menu 语义——配置弹层内唤起的对话框上按下「取消」
         不得连坐关闭底下的配置面板（GroupConfigPanel / WidgetConfigPopover）。 */
      if ((e.target as Element | null)?.closest?.(".ctx-menu, .fd-prompt-overlay")) return;
      closeRef.current();
    };
    const onKey = (e: KeyboardEvent) => {
      if (!optsRef.current.escape || e.key !== "Escape") return;
      if (ctxMenuOpen()) return;
      e.stopPropagation();
      e.preventDefault();
      closeRef.current();
    };
    document.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
      if (restoreFocus) {
        const prev = prevFocusRef.current;
        prevFocusRef.current = null;
        if (prev && prev.isConnected) prev.focus({ preventScroll: true });
      }
    };
  }, [open, ref, restoreFocus]);
}
