/**
 * 快捷键速查表（D 表）：Ctrl+? 呼出的全窗覆盖层，分类多列瀑布布局，Esc 关闭。
 *
 * 数据源（与实际行为严格一致，不手写「理想快捷键」）：
 *  1. 全局快捷键 —— settings-store.shortcuts（§4.5 SYS 可配置表，实时值）；
 *  2. 命令面板 —— lib/commands.buildCommands 的当前命令快照（动态标签
 *     如视图名 / 进入·退出编辑模式随状态变化）+ 面板自身键位；
 *  3. 窗口内按键 —— 逐处对照 keydown 处理器整理的静态表（编辑模式方向键 /
 *     Delete、设置搜索、速记窗、菜单导航等）。
 *
 * 覆盖层范式与 CommandPalette / WidgetGallery 同款：模块级 open 状态 +
 * 订阅（状态与控制函数在 lib/cheatsheet-store，本文件只导出组件）、
 * useDelayedUnmount 对称退场、Esc / 遮罩点击关闭、Tab 焦点陷阱、
 * 选择器登记进 useClickThrough.OVERLAY_SELECTOR 使桌面层打开期间保持可交互。
 * 两个窗口各挂一个 Host（App.tsx）。
 */
import { useEffect, useMemo, useRef, useSyncExternalStore, type CSSProperties } from "react";
import { Keyboard, X } from "lucide-react";
import { useSettingsStore } from "../store/settings-store";
import { SHORTCUT_ACTIONS, SHORTCUT_LABELS } from "../lib/shortcuts";
import { buildCommands } from "../lib/commands";
import {
  closeShortcutCheatsheet,
  isCheatsheetHotkey,
  isShortcutCheatsheetOpen,
  subscribeShortcutCheatsheet,
  toggleShortcutCheatsheet
} from "../lib/cheatsheet-store";
import { useDelayedUnmount } from "../lib/anim";
import { animDurations } from "../lib/durations";
import { useT } from "../i18n-lite";

type Row = { label: string; keys: string[][]; note?: string };
type Section = { id: string; title: string; rows: Row[]; note?: string };

/** 组合键字符串 → kbd 序列（`Ctrl+Alt+D` → [Ctrl, Alt, D]）。 */
function chord(accel: string): string[] {
  return accel
    .split("+")
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => (p === "Space" ? "␣" : p));
}

const ARROWS = ["↑", "↓", "←", "→"];

/** 速查表呼出键的展示文案（Ctrl+?）：处理器固定在 lib/cheatsheet-store
 *  .isCheatsheetHotkey（Ctrl+?，`?` 多数布局是 Shift+/ 也接）。导出给
 *  OnboardingOverlay 的引导文案共用——此前两处各自写死，注释承诺「实时值」
 *  与硬编码互相矛盾；常量化后语义不变。 */
export const CHEATSHEET_HOTKEY_DISPLAY = "Ctrl+?";

export function ShortcutCheatsheetHost() {
  const tr = useT();
  const open = useSyncExternalStore(subscribeShortcutCheatsheet, isShortcutCheatsheetOpen);
  const visible = useDelayedUnmount(open, animDurations().fxFastMs);
  const closing = !open && visible;
  const panelRef = useRef<HTMLDivElement | null>(null);
  const shortcuts = useSettingsStore((s) => s.shortcuts);
  /* 应用内快捷键（palette / settings-search 可改绑可停用）：速查表与实际行为
     严格一致（文件头承诺）——此前写死 Ctrl+K，改键用户的速查表是错的。 */
  const appShortcuts = useSettingsStore((s) => s.appShortcuts);
  const paletteKbd = appShortcuts.palette.enabled ? chord(appShortcuts.palette.accel) : null;
  const searchKbd = appShortcuts["settings-search"].enabled ? chord(appShortcuts["settings-search"].accel) : null;
  const isSettingsWin = window.location.hash === "#/settings";

  /* Ctrl+? 在两个窗口都注册（全局快捷键表本身是跨窗口的）。 */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isCheatsheetHotkey(e)) {
        e.preventDefault();
        toggleShortcutCheatsheet();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  /* 打开期间：Esc 关闭、Tab 焦点陷阱（PromptDialog 模型）、首焦到面板。 */
  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    requestAnimationFrame(() => panelRef.current?.focus());
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        closeShortcutCheatsheet();
      } else if (e.key === "Tab" && panelRef.current) {
        const focusables = Array.from(
          panelRef.current.querySelectorAll<HTMLElement>('button, [href], [tabindex]:not([tabindex="-1"])')
        );
        if (focusables.length === 0) {
          e.preventDefault();
          return;
        }
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        if (e.shiftKey && (document.activeElement === first || document.activeElement === panelRef.current)) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    // capture 阶段先于其它 Esc 处理器（palette / 图库）拿到事件，避免一键关两层。
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      prev?.focus?.();
    };
  }, [open]);

  /* 命令面板目录快照：打开时取一次（动态标签随当前状态）。 */
  const commands = useMemo(() => {
    if (!open) return [];
    return buildCommands(tr).filter((c) => !c.id.startsWith("set-"));
  }, [open, tr]);

  const sections: Section[] = useMemo(() => {
    const global: Section = {
      id: "global",
      title: tr("全局快捷键"),
      note: tr("系统级，任意位置可用；可在「常规 · 快捷键」中修改"),
      rows: SHORTCUT_ACTIONS.map((a) => ({ label: tr(SHORTCUT_LABELS[a]), keys: [chord(shortcuts[a])] }))
    };
    const palette: Section = {
      id: "palette",
      title: tr("命令面板"),
      /* 译文中替换子串保持 i18n（中英两个键都在词典里）。 */
      note: tr("桌面层 Ctrl+K 呼出；输入即搜应用、命令与设置项").replace(
        "Ctrl+K",
        appShortcuts.palette.enabled ? appShortcuts.palette.accel : tr("已停用")
      ),
      rows: [
        { label: tr("打开 / 关闭命令面板"), keys: [paletteKbd ?? [tr("已停用")]] },
        { label: tr("在结果间移动"), keys: [["↑"], ["↓"]] },
        { label: tr("执行选中项"), keys: [["Enter"]] },
        { label: tr("切换搜索引擎（仅网页兜底行）"), keys: [["Tab"]] },
        { label: tr("关闭"), keys: [["Esc"]] }
      ]
    };
    const catalog: Section = {
      id: "catalog",
      title: tr("命令目录"),
      note: tr("当前可执行的命令（在命令面板中输入名称）"),
      rows: commands.map((c) => ({
        label: c.label,
        keys: c.hint ? [chord(c.hint)] : [],
        note: c.group
      }))
    };
    const canvas: Section = {
      id: "canvas",
      title: tr("桌面画布 · 编辑模式"),
      rows: [
        { label: tr("移动选中的小组件（按网格）"), keys: ARROWS.map((k) => [k]) },
        { label: tr("调整选中小组件尺寸"), keys: [["Shift", "方向键"]] },
        { label: tr("删除选中的小组件"), keys: [["Delete"]] },
        { label: tr("添加小组件（图库卡片）"), keys: [[tr("双击")]] },
        { label: tr("关闭图库 / 收起沉浸展开"), keys: [["Esc"]] }
      ]
    };
    const settings: Section = {
      id: "settings",
      title: tr("设置窗口"),
      rows: [
        { label: tr("聚焦设置搜索框"), keys: [searchKbd ?? [tr("已停用")]] },
        { label: tr("在搜索结果间移动"), keys: [["↑"], ["↓"]] },
        { label: tr("打开选中的设置项"), keys: [["Enter"]] },
        { label: tr("清空搜索并失焦"), keys: [["Esc"]] }
      ]
    };
    const quick: Section = {
      id: "quick",
      title: tr("速记窗"),
      rows: [
        { label: tr("保存并关闭"), keys: [["Ctrl", "Enter"]] },
        { label: tr("关闭"), keys: [["Esc"]] }
      ]
    };
    const common: Section = {
      id: "common",
      title: tr("通用"),
      rows: [
        { label: tr("呼出 / 收起本速查表"), keys: [chord(CHEATSHEET_HOTKEY_DISPLAY)] },
        { label: tr("关闭弹层、菜单或对话框"), keys: [["Esc"]] },
        { label: tr("菜单项间移动"), keys: [["↑"], ["↓"], ["Home"], ["End"]] },
        { label: tr("激活菜单项 / 确认对话框"), keys: [["Enter"], ["␣"]] }
      ]
    };
    // 设置窗把「设置窗口」段提前；桌面层把画布段提前。
    return isSettingsWin
      ? [global, settings, common, palette, catalog, canvas, quick]
      : [global, canvas, palette, catalog, common, settings, quick];
  }, [tr, shortcuts, appShortcuts, paletteKbd, searchKbd, commands, isSettingsWin]);

  if (!visible) return null;

  return (
    <div
      className={`tm-cheatsheet${closing ? " is-closing" : ""}`}
      role="dialog"
      aria-modal="true"
      aria-label={tr("快捷键速查")}
      onClick={() => closeShortcutCheatsheet()}
      data-interactive
    >
      <div
        ref={panelRef}
        className={`tm-cheatsheet-panel${closing ? " is-closing" : ""}`}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        data-interactive
      >
        <div className="tm-cheatsheet-head">
          <span className="tm-cheatsheet-title">
            <Keyboard size={16} />
            {tr("快捷键速查")}
          </span>
          <span className="tm-cheatsheet-hint">
            <kbd>Esc</kbd> {tr("关闭")}
          </span>
          <button
            type="button"
            className="tm-cheatsheet-close"
            onClick={() => closeShortcutCheatsheet()}
            aria-label={tr("关闭")}
            data-interactive
          >
            <X size={15} />
          </button>
        </div>
        <div className="tm-cheatsheet-cols">
          {sections.map((sec, si) => (
            <section key={sec.id} className="tm-cheatsheet-section" style={{ "--sti": si } as CSSProperties}>
              <h3 className="tm-cheatsheet-section-title">{sec.title}</h3>
              {sec.note && <p className="tm-cheatsheet-note">{sec.note}</p>}
              <ul className="tm-cheatsheet-list">
                {sec.rows.map((row, ri) => (
                  <li key={`${sec.id}-${ri}`} className="tm-cheatsheet-row">
                    <span className="tm-cheatsheet-label">
                      {row.label}
                      {row.note && <em className="tm-cheatsheet-group">{row.note}</em>}
                    </span>
                    <span className="tm-cheatsheet-keys">
                      {row.keys.length === 0 && <span className="tm-cheatsheet-nokey">—</span>}
                      {row.keys.map((alt, ai) => (
                        <Chord key={ai} parts={alt} sep={ai < row.keys.length - 1 ? "/" : undefined} />
                      ))}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}

function Chord({ parts, sep }: { parts: string[]; sep?: string }) {
  return (
    <span className="tm-cheatsheet-chord">
      {parts.map((p, i) => (
        <kbd key={i}>{p}</kbd>
      ))}
      {sep && <span className="tm-cheatsheet-sep">{sep}</span>}
    </span>
  );
}
