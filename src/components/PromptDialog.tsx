/**
 * 统一输入对话框（promise 化 API）：promptDialog({title}) 返回用户输入
 * （取消为 null）；遮罩点击/Esc 取消，Enter 提交，焦点自动落入输入框。
 */
import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { useDelayedUnmount } from "../lib/anim";
import { animDurations } from "../lib/durations";
import { useT } from "../i18n-lite";

/**
 * 统一 promise 化对话框，替代 window.prompt() / window.confirm() / window.alert()。
 *
 * WebView2（Tauri 的 Web 引擎）默认不渲染 window.prompt —— 它总是返回 null，
 * 且 confirm/alert 也常常被静默吞掉，导致「添加/重命名视图」「删除确认」
 * 「重置确认」等依赖原生对话框的功能在打包版里静默失效。
 * 这里用模块级单例 + 一个挂载在窗口根部的宿主组件，任何组件都能 await
 * `promptDialog / confirmDialog / alertDialog` 拿到结果，渲染层自动跟随
 * 当前明暗主题。
 *
 * 在小组件层（主窗口）会以覆盖层形式占满视口，配合 .fd-prompt-overlay 加入
 * useClickThrough 的 OVERLAY_SELECTOR，保证弹窗期间窗口可交互、点击外部可取消。
 */

type PromptOptions = {
  title: string;
  /** 输入框上方的补充说明（可选）。 */
  message?: string;
  /** 提交按钮文案，默认「确定」。 */
  confirmLabel?: string;
  placeholder?: string;
  /** 输入框初始值（用于重命名等场景）。 */
  initialValue?: string;
};

type ConfirmOptions = {
  title: string;
  /** 正文说明文字。 */
  message?: string;
  /** 确认按钮文案，默认「确定」。 */
  confirmLabel?: string;
  /** 取消按钮文案，默认「取消」。 */
  cancelLabel?: string;
  /** 危险操作（删除/重置）时确认按钮标红。 */
  danger?: boolean;
};

type AlertOptions = {
  title: string;
  message?: string;
  confirmLabel?: string;
};

type DialogState =
  | { kind: "prompt"; opts: PromptOptions; resolve: (v: string | null) => void }
  | { kind: "confirm"; opts: ConfirmOptions; resolve: (v: boolean) => void }
  | { kind: "alert"; opts: AlertOptions; resolve: () => void };

let currentListeners: ((s: DialogState | null) => void)[] = [];
/** 当前展示中的对话框（用于被顶替时按「取消」结算前一个 Promise）。 */
let currentDialog: DialogState | null = null;

function setDialog(s: DialogState | null) {
  // 被顶替/卸载的对话框按「取消」语义结算：此前直接替换 state，前一个
  // Promise 永不 resolve——await promptDialog/confirmDialog 的调用方（如
  // TimetableWidget.saveSession 的冲突确认）会永久挂起。正常关闭路径先
  // resolve 再 setDialog(null)，这里的二次 resolve 是 no-op（Promise 幂等）。
  const prev = currentDialog;
  currentDialog = s;
  if (prev && prev !== s) {
    if (prev.kind === "prompt") prev.resolve(null);
    else if (prev.kind === "confirm") prev.resolve(false);
    else prev.resolve();
  }
  currentListeners.forEach((l) => l(s));
}

export function promptDialog(opts: PromptOptions): Promise<string | null> {
  return new Promise<string | null>((resolve) => setDialog({ kind: "prompt", opts, resolve }));
}

export function confirmDialog(opts: ConfirmOptions): Promise<boolean> {
  return new Promise<boolean>((resolve) => setDialog({ kind: "confirm", opts, resolve }));
}

export function alertDialog(opts: AlertOptions): Promise<void> {
  return new Promise<void>((resolve) => setDialog({ kind: "alert", opts, resolve }));
}

export function PromptDialogHost() {
  const [state, setState] = useState<DialogState | null>(null);
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const tr = useT();

  /* #57 统一弹层退场：关闭后仍渲染 fxFast（--dur-fx-fast，标准档 150ms）播
     .is-closing 淡出再卸载；时长与 global.css 的 fd-prompt-*-out keyframes
     同源（animDurations），期间保留最后一份对话框快照供退场渲染
     （pointer-events 已被 CSS 关闭）。 */
  const visible = useDelayedUnmount(!!state, animDurations().fxFastMs);
  const lastDialog = useRef<DialogState | null>(null);
  if (state) lastDialog.current = state;
  const closing = !state;
  const dlg = state ?? lastDialog.current;

  useEffect(() => {
    currentListeners.push(setState);
    return () => {
      currentListeners = currentListeners.filter((l) => l !== setState);
    };
  }, []);

  const closePrompt = useCallback(
    (result: string | null) => {
      if (state?.kind === "prompt") state.resolve(result);
      setDialog(null);
      setValue("");
    },
    [state]
  );

  // 每次打开输入弹窗时写入初值，并在下一帧聚焦 + 全选，便于直接覆盖重命名（#B-2）。
  useEffect(() => {
    if (state?.kind === "prompt") {
      setValue(state.opts.initialValue ?? "");
      requestAnimationFrame(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      });
    }
  }, [state]);

  /* B4（可达性）：confirm/alert 打开时把焦点移入对话框（默认落在「取消」，
     危险操作需一次有意识的 Tab 才会到达确认键，防误触）。 */
  useEffect(() => {
    if (!state || state.kind === "prompt") return;
    requestAnimationFrame(() => {
      boxRef.current?.querySelector<HTMLButtonElement>(".fd-prompt-btn:not(.primary)")?.focus();
    });
  }, [state]);

  /* 关闭归还焦点：打开时记录触发元素，resolve / Esc / 遮罩关闭后归还——
     此前焦点跌落 body，键盘用户需重新 Tab 定位。isConnected 守卫同
     WidgetExpandOverlay（触发元素可能已卸载则退化为不动）。 */
  const prevFocusRef = useRef<HTMLElement | null>(null);
  const wasOpenRef = useRef(false);
  useEffect(() => {
    if (state && !wasOpenRef.current) {
      wasOpenRef.current = true;
      prevFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    } else if (!state && wasOpenRef.current) {
      wasOpenRef.current = false;
      const prev = prevFocusRef.current;
      prevFocusRef.current = null;
      if (prev && prev.isConnected) prev.focus({ preventScroll: true });
    }
  }, [state]);

  // 打开任意弹窗期间，把 Esc / Enter 正确路由到对应按钮，避免误触背后页面。
  useEffect(() => {
    if (!state) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        if (state.kind === "prompt") closePrompt(null);
        else if (state.kind === "confirm") state.resolve(false);
        else state.resolve();
        setDialog(null);
      } else if (e.key === "Enter" && state.kind === "confirm") {
        /* B4：焦点已在某个按钮上时交给原生激活（焦点在「取消」上按 Enter
           必须是取消而非确定——旧实现恒等于确定，属误触风险）。 */
        const ae = document.activeElement;
        if (ae instanceof HTMLButtonElement && boxRef.current?.contains(ae)) return;
        e.stopPropagation();
        state.resolve(true);
        setDialog(null);
      } else if (e.key === "Tab" && boxRef.current) {
        /* B4：简易焦点陷阱——Tab 在对话框内循环，不逃逸到背景页面。 */
        const focusables = Array.from(
          boxRef.current.querySelectorAll<HTMLElement>("button, input, [tabindex]:not([tabindex='-1'])")
        ).filter((el) => !el.hasAttribute("disabled"));
        if (focusables.length === 0) return;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        const ae = document.activeElement;
        if (e.shiftKey && (ae === first || !boxRef.current.contains(ae))) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && (ae === last || !boxRef.current.contains(ae))) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [state, closePrompt]);

  if (!visible || !dlg) return null;

  const overlayHandler = (e: ReactPointerEvent) => {
    // 按下遮罩空白处即关（统一 pointerdown 按下语义）：prompt/confirm 视为取消，alert 视为关闭。
    if (e.target !== e.currentTarget) return;
    if (dlg.kind === "prompt") closePrompt(null);
    else if (dlg.kind === "confirm") dlg.resolve(false);
    else dlg.resolve();
    setDialog(null);
  };

  if (dlg.kind === "prompt") {
    const { opts } = dlg;
    const submit = () => {
      const v = value.trim();
      if (!v) {
        inputRef.current?.focus();
        return;
      }
      closePrompt(v);
    };
    return (
      <div className={`fd-prompt-overlay${closing ? " is-closing" : ""}`} onPointerDown={overlayHandler}>
        <div
          ref={boxRef}
          className={`fd-prompt${closing ? " is-closing" : ""}`}
          role="dialog"
          aria-modal="true"
          aria-label={opts.title}
        >
          <div className="fd-prompt-title">{opts.title}</div>
          {opts.message && <div className="fd-prompt-message">{opts.message}</div>}
          <input
            ref={inputRef}
            className="fd-prompt-input"
            value={value}
            placeholder={opts.placeholder}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submit();
              else if (e.key === "Escape") closePrompt(null);
            }}
            data-interactive
          />
          <div className="fd-prompt-actions">
            <button className="fd-prompt-btn" onClick={() => closePrompt(null)} data-interactive>
              {tr("取消")}
            </button>
            <button className="fd-prompt-btn primary" onClick={submit} data-interactive>
              {opts.confirmLabel ?? tr("确定")}
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (dlg.kind === "confirm") {
    const { opts } = dlg;
    return (
      <div className={`fd-prompt-overlay${closing ? " is-closing" : ""}`} onPointerDown={overlayHandler}>
        <div
          ref={boxRef}
          className={`fd-prompt${closing ? " is-closing" : ""}`}
          role="alertdialog"
          aria-modal="true"
          aria-label={opts.title}
        >
          <div className="fd-prompt-title">{opts.title}</div>
          {opts.message && <div className="fd-prompt-message">{opts.message}</div>}
          <div className="fd-prompt-actions">
            <button
              className="fd-prompt-btn"
              onClick={() => {
                dlg.resolve(false);
                setDialog(null);
              }}
              data-interactive
            >
              {opts.cancelLabel ?? tr("取消")}
            </button>
            <button
              className={`fd-prompt-btn primary${opts.danger ? " danger" : ""}`}
              onClick={() => {
                dlg.resolve(true);
                setDialog(null);
              }}
              data-interactive
            >
              {opts.confirmLabel ?? tr("确定")}
            </button>
          </div>
        </div>
      </div>
    );
  }

  // alert
  const { opts } = dlg;
  return (
    <div className={`fd-prompt-overlay${closing ? " is-closing" : ""}`} onPointerDown={overlayHandler}>
      <div
        ref={boxRef}
        className={`fd-prompt${closing ? " is-closing" : ""}`}
        role="alertdialog"
        aria-modal="true"
        aria-label={opts.title}
      >
        <div className="fd-prompt-title">{opts.title}</div>
        {opts.message && <div className="fd-prompt-message">{opts.message}</div>}
        <div className="fd-prompt-actions">
          <button
            className="fd-prompt-btn primary"
            onClick={() => {
              dlg.resolve();
              setDialog(null);
            }}
            data-interactive
            autoFocus
          >
            {opts.confirmLabel ?? tr("确定")}
          </button>
        </div>
      </div>
    </div>
  );
}
