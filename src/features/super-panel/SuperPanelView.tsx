/**
 * [SUPER-PANEL]超级面板视图（index.html#super-panel）。
 *
 * Rust 侧长按右键取词流程建窗后 emit `super-panel:content`（载荷 = 取到的
 * 文本/文件列表 + 光标位置——窗口定位已在 Rust 完成）。本视图：
 *  - 挂载即补拉最近载荷（get_super_panel_payload，防 emit 早于监听丢事件）
 *    并完成就绪握手（show 窗口）；
 *  - 复用 #1 的粘贴态动作构建器（buildPayloadCommands）渲染动作列表；
 *  - Esc / 点选动作 / 窗口失焦 → 收起（hide，不销毁——下次复用）。
 *
 * （键盘可达）：role=dialog 此前无初始焦点、无方向键巡览、无 Tab 陷阱——
 * 键盘焦点落在 body 上打空。借 CommandPalette 的范式补齐：打开（每次取词
 * epoch 重挂）即聚焦面板容器（tabIndex=-1，listbox 巡览经 aria-activedescendant
 * 播报）；ArrowUp/Down 循环移动高亮、Enter 激活、Tab 在面板内循环不逃逸；
 * Esc 收起沿用原有 window 级监听。鼠标交互（点击 / 悬停高亮）不受影响。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke, isTauri } from "../../lib/tauri";
import { useTauriEvent } from "../../lib/use-tauri-event";
import { prefersReducedMotion } from "../../lib/anim";
import { animDurations } from "../../lib/durations";
import { useT } from "../../i18n-lite";
import { buildPayloadCommands, setPalettePayload, type PalettePayload } from "../../lib/palette-payload";
import { openWebSearch, loadSpotlightSettings, type SearchEngineId } from "../../lib/spotlight";
import type { Command } from "../../lib/commands";
import "./super-panel.css";

type SuperPanelContent = {
  kind: "text" | "files";
  text?: string;
  files?: string[];
  x: number;
  y: number;
};

/** 载荷转换（Rust 载荷 → palette-payload 的三态形状；仅本文件使用）。 */
function payloadOfContent(c: SuperPanelContent): PalettePayload {
  if (c.kind === "files" && c.files && c.files.length > 0) {
    return { kind: "files", paths: c.files };
  }
  return { kind: "text", text: c.text ?? "" };
}

/** Rust 载荷守卫——kind/坐标/文本/文件列表任一形状不对就当畸形丢弃，
 * 不再 as 断言直喂动作构建器（畸形载荷会渲染出 undefined 摘要与空动作）。 */
function isSuperPanelContent(c: unknown): c is SuperPanelContent {
  if (!c || typeof c !== "object") return false;
  const o = c as Record<string, unknown>;
  if (o.kind !== "text" && o.kind !== "files") return false;
  if (typeof o.x !== "number" || typeof o.y !== "number") return false;
  if (o.kind === "files") return Array.isArray(o.files) && o.files.every((f) => typeof f === "string");
  return o.text === undefined || typeof o.text === "string";
}

const win = () => getCurrentWindow();

export function SuperPanelView() {
  const tr = useT();
  const [engine, setEngine] = useState<SearchEngineId>(() => loadSpotlightSettings().engine);
  const [payload, setLocalPayload] = useState<PalettePayload | null>(null);
  /* 进出场（对齐 CommandPalette/ContextMenu 手感）：accept 重挂载根节点重播
     入场；收起先播 .is-closing 再 hide 窗口。epoch/key 让每次取词都重放。 */
  const [closing, setClosing] = useState(false);
  const [epoch, setEpoch] = useState(0);
  const hideTimer = useRef(0);

  /* 键盘巡览状态——hi 为高亮动作下标（listbox 语义，容器持有焦点经
     aria-activedescendant 播报）。每次取词（epoch 重挂）归零。 */
  const [hi, setHi] = useState(0);
  /* 指针扫过高亮合帧（CommandPalette 同范式）：onPointerEnter 逐行 setState
     会整面板重渲；rAF 合帧让快速扫过 N 行至多每帧一次。 */
  const hiRaf = useRef(0);
  const hoverHi = useCallback((i: number) => {
    if (hiRaf.current) cancelAnimationFrame(hiRaf.current);
    hiRaf.current = requestAnimationFrame(() => {
      hiRaf.current = 0;
      setHi(i);
    });
  }, []);
  useEffect(() => () => cancelAnimationFrame(hiRaf.current), []);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  const hidePanel = useCallback(() => {
    if (hideTimer.current) return; // 已在退场窗口内
    setClosing(true);
    const exitMs = prefersReducedMotion() ? 0 : Math.round(animDurations().fxXfastMs) + 10;
    hideTimer.current = window.setTimeout(() => {
      hideTimer.current = 0;
      setClosing(false);
      setPalettePayload(null);
      setLocalPayload(null);
      void win()
        .hide()
        .catch(() => {});
    }, exitMs);
  }, []);

  const accept = useCallback((c: SuperPanelContent) => {
    // 退场中途来新取词：取消挂起的 hide，重置回展示态并重播入场。
    if (hideTimer.current) {
      window.clearTimeout(hideTimer.current);
      hideTimer.current = 0;
      setClosing(false);
    }
    setEpoch((e) => e + 1);
    // 新载荷 = 新列表，键盘高亮归零（防止残留越界下标）。
    setHi(0);
    const p = payloadOfContent(c);
    setLocalPayload(p);
    setPalettePayload(p);
  }, []);

  useEffect(
    () => () => {
      if (hideTimer.current) window.clearTimeout(hideTimer.current);
    },
    []
  );

  /* 就绪握手 + 补拉：窗口创建 visible(false)，拉到载荷才显示。：补拉
     结果同样过形状守卫——畸形载荷按「未取到内容」处理，不喂动作构建器。 */
  useEffect(() => {
    if (!isTauri()) return;
    let alive = true;
    void invoke<SuperPanelContent | null>("get_super_panel_payload")
      .then((c) => {
        if (!alive) return;
        if (isSuperPanelContent(c)) accept(c);
        else if (c) console.warn("[super-panel] 补拉载荷形状异常，已忽略", c);
        void win()
          .show()
          .catch(() => {});
      })
      .catch(() => {
        if (alive)
          void win()
            .show()
            .catch(() => {});
      });
    return () => {
      alive = false;
    };
  }, [accept]);

  /* 后续取词（窗口已复用）：Rust 定位 + show 后 emit。：畸形载荷不再
     as 断言透传，直接收起面板（宁可无动作也不渲染垃圾）。 */
  useTauriEvent<SuperPanelContent>("super-panel:content", (c) => {
    if (!isSuperPanelContent(c)) {
      hidePanel();
      return;
    }
    accept(c);
  });

  /* 失焦收起：点了别处 / 切窗口。 */
  useEffect(() => {
    if (!isTauri()) return;
    const un = win().onFocusChanged((focused) => {
      if (!focused) hidePanel();
    });
    return () => {
      void un.then((f) => f()).catch(() => {});
    };
  }, [hidePanel]);

  /* Esc 收起。 */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        hidePanel();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [hidePanel]);

  const commands: Command[] = useMemo(() => {
    if (!payload) return [];
    return buildPayloadCommands(tr, {
      engine,
      openWeb: (eng, q) => {
        setEngine(eng);
        openWebSearch(eng, q);
      },
      close: hidePanel
    });
  }, [payload, tr, engine, hidePanel]);

  /* 打开（每次取词 epoch 重挂面板节点）即把焦点移进面板容器——
     role=dialog 无初始焦点时方向键落空在 body 上。容器 tabIndex=-1 不进
     Tab 序；巡览状态 hi 由容器 onKeyDown 驱动。 */
  useEffect(() => {
    if (epoch > 0) panelRef.current?.focus({ preventScroll: true });
  }, [epoch]);

  /* 列表收缩（畸形载荷收起 / 换词重建）时钳制高亮，防止
     aria-activedescendant 指向已不存在的选项。 */
  useEffect(() => {
    setHi((h) => Math.max(0, Math.min(h, commands.length - 1)));
  }, [commands.length]);

  /* 高亮项滚入视野（面板定高、列表可滚）。 */
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-item-index="${hi}"]`)?.scrollIntoView({ block: "nearest" });
  }, [hi]);

  const commandsRef = useRef(commands);
  commandsRef.current = commands;
  const hiRef = useRef(hi);
  hiRef.current = hi;

  /* 容器级键盘巡览（CommandPalette 同款语义）：
     - ArrowUp/Down 循环移动高亮（焦点恒在容器，经 aria-activedescendant 播报）；
     - Enter 激活高亮项——焦点已落在某个动作按钮上时（Tab 进入）让浏览器原生
       激活，避免双触发；
     - Tab 在面板内循环（陷阱），shift+Tab 反向，不逃逸到 body；
     - Esc 由上方 window 级监听收起（保留原行为）。 */
  const onPanelKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const cur = commandsRef.current;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (cur.length === 0) return;
      e.preventDefault();
      const delta = e.key === "ArrowDown" ? 1 : -1;
      setHi((h) => (h + delta + cur.length) % cur.length);
    } else if (e.key === "Enter") {
      if (e.target !== e.currentTarget) return; // 焦点在动作按钮上：原生激活
      if (cur.length === 0) return;
      e.preventDefault();
      const c = cur[Math.max(0, Math.min(hiRef.current, cur.length - 1))];
      c?.run();
    } else if (e.key === "Tab") {
      const box = panelRef.current;
      if (!box) return;
      e.preventDefault();
      const focusables = Array.from(box.querySelectorAll<HTMLElement>("button:not([disabled])")).filter(
        (el) => el.offsetParent !== null || el === document.activeElement
      );
      if (focusables.length === 0) return;
      const idx = focusables.indexOf(document.activeElement as HTMLElement);
      const next = e.shiftKey
        ? focusables[(idx <= 0 ? focusables.length : idx) - 1]
        : focusables[(idx + 1) % focusables.length];
      next?.focus();
    }
  };

  const summary = payload
    ? payload.kind === "text"
      ? payload.text.split("\n")[0].slice(0, 80)
      : payload.kind === "files"
        ? payload.paths.length > 1
          ? tr("{n} 个文件").replace("{n}", String(payload.paths.length))
          : ((payload.paths[0] ?? "").split(/[\\/]/).pop() ?? "")
        : payload.name
    : "";

  return (
    <div
      key={epoch}
      ref={panelRef}
      className={`super-panel${closing ? " is-closing" : ""}`}
      role="dialog"
      aria-label={tr("超级面板")}
      /* 容器可聚焦（打开即 focus），巡览高亮经 aria-activedescendant 播报
         ——焦点不逐项移动，Tab 陷阱 / Enter 激活见 onPanelKeyDown。 */
      tabIndex={-1}
      aria-activedescendant={commands.length > 0 ? `sp-opt-${hi}` : undefined}
      onKeyDown={onPanelKeyDown}
    >
      <div className="super-panel-summary" title={summary}>
        {summary || tr("未取到内容")}
      </div>
      <div className="super-panel-list" ref={listRef} role="listbox" aria-label={tr("可用操作")}>
        {commands.map((c, i) => (
          <button
            key={c.id}
            type="button"
            role="option"
            id={`sp-opt-${i}`}
            aria-selected={i === hi}
            data-item-index={i}
            className={`super-panel-item${i === hi ? " active" : ""}`}
            style={{ animationDelay: `${Math.min(i, 7) * 0.02}s` }}
            onPointerEnter={() => hoverHi(i)}
            onClick={() => c.run()}
          >
            <span className="super-panel-item-label">{c.label}</span>
            {c.hint && <span className="super-panel-item-hint">{c.hint}</span>}
          </button>
        ))}
        {commands.length === 0 && <div className="super-panel-empty">{tr("未取到内容")}</div>}
      </div>
    </div>
  );
}
