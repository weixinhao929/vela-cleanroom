/**
 * 全局右键菜单（命令模式）：openContextMenu(e, items) 在任意位置弹出，
 * 支持图标/危险项/分隔符；Portal 渲染 + 边缘翻转定位 + 点击外部关闭。
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type ReactNode
} from "react";
import { createPortal } from "react-dom";
import { invoke, isTauri } from "../lib/tauri";
import { useT } from "../i18n-lite";
import { useDelayedUnmount } from "../lib/anim";
import { animDurations } from "../lib/durations";
import { useFocusReturn } from "../lib/use-focus-return";
import { uiZoom } from "../lib/ui-zoom";

/**
 * 统一右键菜单系统。
 *
 * WebView 自带的右键菜单是浏览器样式（刷新/检查/另存为…），与桌面应用的
 * 预期不符。本模块把右键行为全部接管：
 *  - 全局拦截原生 contextmenu（设置窗口、小组件层空白处不再出现浏览器菜单）；
 *  - 可编辑控件（input/textarea/contenteditable）弹出「剪切/复制/粘贴/全选」
 *    编辑菜单，粘贴走 Rust 侧 Win32 剪贴板（WebView2 的
 *    navigator.clipboard.readText 需要权限提示，Tauri 不授予）；
 *  - 业务代码通过 openContextMenu(e, items) 弹出自定义菜单（小组件卡片、
 *    画布空白处），在 React 合成事件阶段调用并 stopPropagation，早于全局
 *    监听器；
 *  - 菜单打开期间点击外部会吞掉该次点击（对齐原生菜单行为，避免误触发菜单
 *    下方的按钮），Esc / 滚动 / 缩放 / 失焦自动关闭。
 *
 * 鲁棒性要点：
 *  - 菜单状态放模块级外部 store（useSyncExternalStore 订阅），与 React 树
 *    解耦，任何地方都能命令式调用；
 *  - 弹出位置经测量后钳制在视口内（含任务栏方向），不会悬出屏幕；
 *  - 打开菜单时根据所在窗口（设置窗口 / 桌面层）选择对应主题变量，深浅色
 *    都保持可读。
 */

export type ContextMenuItem =
  | { type: "separator" }
  | {
      type?: "item";
      label: string;
      icon?: ReactNode;
      shortcut?: string;
      danger?: boolean;
      disabled?: boolean;
      onSelect?: () => void;
    };

type MenuEvent = {
  clientX: number;
  clientY: number;
  preventDefault(): void;
  stopPropagation(): void;
};

type MenuState = {
  x: number;
  y: number;
  items: ContextMenuItem[];
};

let menuState: MenuState | null = null;
const subscribers = new Set<() => void>();
const emit = () => subscribers.forEach((f) => f());
const subscribe = (fn: () => void) => {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
};
const getSnapshot = () => menuState;

/** openContextMenu 触发的时刻：全局监听器据此识别「本次事件已弹菜单」。
 *  不能用布尔标记——React 合成阶段 stopPropagation 会拦掉原生事件冒泡，
 *  window 监听器根本收不到本次事件，布尔值将残留并吞掉下一次右键。 */
let openedAt = 0;

/** clientX/Y 是视觉坐标（已含 --ui-zoom），fixed left/top 是布局单位。
 *  本组件是纯 clientX 路径（无 gBCR），此前落在 的 gBCR 扫描
 *  范围之外——进 fixed 前必须除回缩放，钳制比较也统一用布局单位视口。 */
const layoutPoint = (clientX: number, clientY: number): { x: number; y: number } => {
  const z = uiZoom();
  return { x: clientX / z, y: clientY / z };
};

export function isContextMenuOpen(): boolean {
  return menuState !== null;
}

export function closeContextMenu() {
  if (!menuState) return;
  menuState = null;
  emit();
  /* 焦点归还不再在这里做：统一由 ContextMenuPanel 的 useFocusReturn
     接管（此前只有编辑菜单经 target 归还输入框，业务菜单关闭后焦点跌落
     body；语义不变——关闭时把焦点还给打开菜单的元素，编辑菜单在真浏览器
     里右键按下即聚焦输入框，activeElement 记录到的正是它）。 */
}

export function openContextMenu(e: MenuEvent, items: ContextMenuItem[]) {
  e.preventDefault();
  e.stopPropagation();
  if (!items.length) {
    closeContextMenu();
    return;
  }
  menuState = { ...layoutPoint(e.clientX, e.clientY), items };
  openedAt = performance.now();
  emit();
}

/* ------------------------------------------------------------------ */
/* 编辑菜单（剪切 / 复制 / 粘贴 / 全选）                                */
/* ------------------------------------------------------------------ */

function isEditable(el: Element | null): el is HTMLElement {
  if (!el) return false;
  if (el instanceof HTMLInputElement) return true;
  if (el instanceof HTMLTextAreaElement) return true;
  return el instanceof HTMLElement && el.isContentEditable;
}

function selectionInfo(el: HTMLElement): { text: string; selectedLen: number } {
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    const start = el.selectionStart ?? 0;
    const end = el.selectionEnd ?? 0;
    return { text: el.value, selectedLen: Math.abs(end - start) };
  }
  const sel = window.getSelection();
  return { text: el.textContent ?? "", selectedLen: sel?.toString().length ?? 0 };
}

async function readClipboardText(): Promise<string> {
  if (isTauri()) return invoke<string>("read_clipboard_text");
  return navigator.clipboard.readText();
}

/* ------------------------------------------------------------------ */
/* 宿主组件：全局监听 + 渲染                                            */
/* ------------------------------------------------------------------ */

export function ContextMenuHost() {
  const tr = useT();
  const menu = useSyncExternalStore(subscribe, getSnapshot);
  const trRef = useRef(tr);
  trRef.current = tr;

  useEffect(() => {
    /** 菜单因外部点击关闭后，短暂吞掉随后的 click，防止误触发下层控件。 */
    let swallowClickUntil = 0;

    const openEditMenu = (el: HTMLElement, e: MouseEvent) => {
      const { text, selectedLen } = selectionInfo(el);
      const allSelected = text.length > 0 && selectedLen === text.length;
      const hasSelection = selectedLen > 0;
      const edit = (kind: "cut" | "copy") => {
        el.focus({ preventScroll: true });
        // execCommand 必须在用户激活的同一同步任务里执行（点击即激活）。
        document.execCommand(kind);
      };
      const selectAll = () => {
        el.focus({ preventScroll: true });
        if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) el.select();
        else document.execCommand("selectAll");
      };
      const paste = async () => {
        let text = "";
        try {
          text = await readClipboardText();
        } catch {
          return; // 剪贴板不可读（被占用 / 非文本）时静默失败
        }
        if (!text) return;
        el.focus({ preventScroll: true });
        // insertText 走编辑命令，保留撤销栈，并替换当前选区（原生行为）。
        document.execCommand("insertText", false, text);
      };
      const t = trRef.current;
      menuState = {
        ...layoutPoint(e.clientX, e.clientY),
        items: [
          { label: t("剪切"), shortcut: "Ctrl+X", disabled: !hasSelection, onSelect: () => edit("cut") },
          { label: t("复制"), shortcut: "Ctrl+C", disabled: !hasSelection, onSelect: () => edit("copy") },
          { label: t("粘贴"), shortcut: "Ctrl+V", onSelect: () => void paste() },
          { type: "separator" },
          { label: t("全选"), shortcut: "Ctrl+A", disabled: text.length === 0 || allSelected, onSelect: selectAll }
        ]
      };
      openedAt = performance.now();
      emit();
    };

    /** 全局兜底：未被业务代码接管的右键一律不出原生菜单。 */
    const onContextMenu = (e: MouseEvent) => {
      e.preventDefault();
      // 业务代码已在本事件中弹出菜单（React 合成阶段）：不要关闭/覆盖它。
      // 时间窗兜底「事件冒泡到 window 之前菜单刚被打开」的路径。
      if (menuState && performance.now() - openedAt < 250) return;
      const el = e.target as HTMLElement | null;
      const editable = el?.closest?.(
        "input, textarea, [contenteditable='true'], [contenteditable='']"
      ) as HTMLElement | null;
      if (isEditable(editable)) {
        openEditMenu(editable, e);
      } else {
        const prev = menuState;
        if (prev) {
          /* 菜单已开时右键空白处——与 shell 行为一致：旧菜单关闭并在
             新指针位置重开同一份菜单项，而不是静默关闭（用户换位置再按下
             右键，意图本就是在新位置看菜单）。面板 key 含坐标，位置变化即
             整面重挂，键盘高亮归零（等同一次全新打开）。 */
          menuState = { ...layoutPoint(e.clientX, e.clientY), items: prev.items };
          openedAt = performance.now();
          emit();
        } else {
          // 空白处右键（无菜单开着）：对齐正常软件——不出菜单，仅兜底关闭。
          closeContextMenu();
        }
      }
    };

    const onPointerDown = (e: PointerEvent) => {
      if (!menuState) return;
      /* 右键按下不在此关闭菜单——紧随其后的 contextmenu 会按新指针
         位置重开（空白处，见 onContextMenu）或换菜单（业务目标/编辑控件），
         若此处先关，「菜单开着再右键」就退化成静默关闭。左键/其它按键的
         外点关闭与吞点击语义不变。 */
      if (e.button === 2) return;
      const inside = (e.target as HTMLElement | null)?.closest?.(".ctx-menu");
      if (inside) return;
      // 吞掉这次按下：阻止它触发菜单下方控件的 pointerdown/click 处理器。
      e.preventDefault();
      e.stopPropagation();
      swallowClickUntil = performance.now() + 400;
      closeContextMenu();
    };

    const onClickCapture = (e: MouseEvent) => {
      if (performance.now() >= swallowClickUntil) return;
      const inside = (e.target as HTMLElement | null)?.closest?.(".ctx-menu");
      if (!inside) {
        e.preventDefault();
        e.stopPropagation();
      }
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (!menuState) return;
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        closeContextMenu();
      }
    };

    const close = () => closeContextMenu();

    window.addEventListener("contextmenu", onContextMenu);
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("click", onClickCapture, true);
    document.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("resize", close);
    window.addEventListener("blur", close);
    window.addEventListener("scroll", close, true);
    return () => {
      window.removeEventListener("contextmenu", onContextMenu);
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("click", onClickCapture, true);
      document.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("resize", close);
      window.removeEventListener("blur", close);
      window.removeEventListener("scroll", close, true);
      // Host 卸载时清模块态：菜单状态是模块级单例，宿主卸载后残留的
      // menuState 会让下一个挂载的 Host「开局就开着菜单」（测试隔离尤其）。
      close();
    };
  }, []);

  /* 统一弹层退场：关闭后延迟播 .is-closing 缩放淡出再卸载（= --dur-fx-fast，
     与 widget-anim.css 的 ctx-menu-out 同源，随速度档缩放），期间以最后一份
     菜单快照渲染（pointer-events 已被 CSS 关闭）。 */
  const visible = useDelayedUnmount(!!menu, Math.round(animDurations().fxFastMs));
  const lastMenu = useRef<MenuState | null>(null);
  if (menu) lastMenu.current = menu;
  const shown = menu ?? lastMenu.current;

  if (!visible || !shown) return null;
  return createPortal(<ContextMenuPanel key={`${shown.x},${shown.y}`} menu={shown} closing={!menu} />, document.body);
}

/* ------------------------------------------------------------------ */
/* 面板：定位钳制 + 键盘导航 + 渲染                                      */
/* ------------------------------------------------------------------ */

function ContextMenuPanel({ menu, closing = false }: { menu: MenuState; closing?: boolean }) {
  /* 关闭归还焦点（统一接管原「编辑菜单归还 target」特例）：打开时记录
     触发元素，closing 翻真（关闭/退场动画开始）即归还。必须放在组件 hook
     首位——下方 useLayoutEffect 会把焦点移入菜单容器，声明序即执行序，晚于
     它就只会记到菜单自身。 */
  useFocusReturn(!closing);
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x: menu.x, y: menu.y });
  const [origin, setOrigin] = useState("top left");
  const [kb, setKb] = useState(-1);

  const actionables = menu.items
    .map((it, i) => ({ it, i }))
    .filter((x) => x.it.type !== "separator" && !(x.it as { disabled?: boolean }).disabled);

  // 渲染后测量实际尺寸并把菜单钳制在视口内（右/下越界时向左/上翻转）。
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const MARGIN = 8;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    /* menu.x/y 与 offsetWidth 均为布局单位；window.innerWidth 本身就是
       布局单位（全库口径：视觉 px = innerWidth × uiZoom，见 useClickThrough
       的 Rust 命中测试契约）。：此前再 ÷zoom 属二次
       除——zoom>100% 时菜单被错误压进左上区域、提前翻转，zoom<100% 时可
       悬出屏幕右/下缘。钳制比较直接用布局单位视口。 */
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let x = menu.x;
    let y = menu.y;
    let o = "top left";
    if (x + w + MARGIN > vw) {
      x = Math.max(MARGIN, vw - w - MARGIN);
      o = "top right";
    }
    if (y + h + MARGIN > vh) {
      y = Math.max(MARGIN, vh - h - MARGIN);
      o = o === "top right" ? "bottom right" : "bottom left";
    }
    setPos({ x, y });
    setOrigin(o);
    el.focus({ preventScroll: true });
  }, [menu.x, menu.y]);

  const move = useCallback(
    (dir: 1 | -1) => {
      if (!actionables.length) return;
      if (kb === -1) {
        // 无高亮时：Down 落到第一项，Up 落到最后一项（对齐原生菜单）。
        setKb(dir === 1 ? actionables[0].i : actionables[actionables.length - 1].i);
        return;
      }
      const cur = actionables.findIndex((a) => a.i === kb);
      const next = (cur + dir + actionables.length) % actionables.length;
      setKb(actionables[next].i);
    },
    [actionables, kb]
  );

  const activate = (it: ContextMenuItem) => {
    if (it.type === "separator" || (it as { disabled?: boolean }).disabled) return;
    const onSelect = (it as { onSelect?: () => void }).onSelect;
    closeContextMenu();
    onSelect?.();
  };

  // 主题：设置窗口用其固定深/浅色板（portal 在 body 上，继承不到窗口内变量），
  // 桌面层走全局 CSS 变量随预设切换。
  const settingsWin = document.querySelector(".tm-settings-window");
  const themeClass = settingsWin
    ? settingsWin.getAttribute("data-theme") === "light"
      ? " ctx-in-settings ctx-theme-light"
      : " ctx-in-settings ctx-theme-dark"
    : "";

  return (
    <div
      ref={ref}
      className={`ctx-menu${themeClass}${closing ? " is-closing" : ""}`}
      role="menu"
      tabIndex={-1}
      style={{ left: pos.x, top: pos.y, transformOrigin: origin }}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        closeContextMenu();
      }}
      onKeyDown={(e) => {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          move(1);
        } else if (e.key === "ArrowUp") {
          e.preventDefault();
          move(-1);
        } else if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          const item = actionables.find((a) => a.i === kb);
          if (item) activate(item.it);
        } else if (e.key === "Home" && actionables.length) {
          e.preventDefault();
          setKb(actionables[0].i);
        } else if (e.key === "End" && actionables.length) {
          e.preventDefault();
          setKb(actionables[actionables.length - 1].i);
        } else if (e.key === "Tab") {
          /* Tab 焦点逃出菜单后菜单悬空保持打开——
             对齐原生菜单「Tab 即关闭」语义（全库其余弹层均有 Tab 陷阱，本组件
             是唯一缺口）。菜单容器 tabIndex=-1，Tab 默认焦点跳出后无键可达。 */
          e.preventDefault();
          closeContextMenu();
        }
      }}
    >
      {menu.items.map((it, i) =>
        it.type === "separator" ? (
          <div className="ctx-sep" key={i} />
        ) : (
          <button
            key={i}
            type="button"
            role="menuitem"
            className={`ctx-item${it.danger ? " danger" : ""}${it.disabled ? " disabled" : ""}${kb === i ? " kb-active" : ""}`}
            style={{ "--sti": i } as CSSProperties}
            aria-disabled={it.disabled || undefined}
            onClick={() => activate(it)}
            onMouseEnter={() => setKb(-1)}
          >
            {it.icon !== undefined && <span className="ctx-item-icon">{it.icon}</span>}
            <span className="ctx-item-label">{it.label}</span>
            {it.shortcut && <span className="ctx-shortcut">{it.shortcut}</span>}
          </button>
        )
      )}
    </div>
  );
}
