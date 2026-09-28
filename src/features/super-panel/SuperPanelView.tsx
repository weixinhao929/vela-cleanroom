/**
 * [SUPER-PANEL]（ZTools 借鉴 #11）超级面板视图（index.html#super-panel）。
 *
 * Rust 侧长按右键取词流程建窗后 emit `super-panel:content`（载荷 = 取到的
 * 文本/文件列表 + 光标位置——窗口定位已在 Rust 完成）。本视图：
 *  - 挂载即补拉最近载荷（get_super_panel_payload，防 emit 早于监听丢事件）
 *    并完成就绪握手（show 窗口）；
 *  - 复用 #1 的粘贴态动作构建器（buildPayloadCommands）渲染动作列表；
 *  - Esc / 点选动作 / 窗口失焦 → 收起（hide，不销毁——下次复用）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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

/** C-11：Rust 载荷守卫——kind/坐标/文本/文件列表任一形状不对就当畸形丢弃，
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

  /* 就绪握手 + 补拉：窗口创建 visible(false)，拉到载荷才显示。C-11：补拉
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

  /* 后续取词（窗口已复用）：Rust 定位 + show 后 emit。C-11：畸形载荷不再
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
    <div key={epoch} className={`super-panel${closing ? " is-closing" : ""}`} role="dialog" aria-label={tr("超级面板")}>
      <div className="super-panel-summary" title={summary}>
        {summary || tr("未取到内容")}
      </div>
      <div className="super-panel-list">
        {commands.map((c, i) => (
          <button
            key={c.id}
            type="button"
            className="super-panel-item"
            style={{ animationDelay: `${Math.min(i, 7) * 0.02}s` }}
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
