/**
 * 全局命令面板（I1）→ Spotlight（SPOT）。
 *
 * 桌面层按 Ctrl+K 弹出：搜索并执行跨功能动作 —— 切换视图、进入编辑模式、
 * 开关番茄钟、打开设置指定页、添加小组件等。命令列表在打开时快照当前
 * store 状态（视图、编辑态），避免订阅太多 store 导致频繁重建。
 *
 * SPOT 升级：
 *  - 应用模式：输入即搜已安装应用（lib/spotlight 共享索引 + 拼音 + 频率/tier
 *    排序），Enter 启动；应用组排在命令/设置结果之前合流显示。
 *  - 网页兜底：无本地结果时唯一结果行 = 用默认搜索引擎打开，Tab / 点击芯片
 *    循环切换引擎（Bing/Google/百度/DuckDuckGo，配置暂存 localStorage）。
 *  - G11 文件模式：查询带路径痕迹（\、/ 或盘符）时防抖搜索用户常用目录，
 *    文件组排在应用之后，Enter 经系统默认处理器打开并累计频率。
 *
 * ZTools 借鉴批次：
 *  - #1 [PASTE] 粘贴态路由：粘贴/拖入文本·文件·图片 → 载荷芯片 + 按类型
 *    匹配动作（存便签/建任务/入快捷方式/复制路径/入图库…，见
 *    lib/palette-payload）。Esc 先清载荷再收面板。
 *  - #2 [CTX] 窗口上下文：打开时探一次「呼出前前台」（get_summon_foreground
 *    快照），Explorer → 复制当前路径/在终端打开；浏览器 → 复制网址/收藏书签。
 *  - #5 [DIRECT] 直达项：纯 URL →「打开网址」；绝对路径 →「前往文件夹」。
 *  - #6 [PREF] 搜索偏好：同一查询词上次选中的条目置顶（palette-preference）。
 *
 * 设计：
 *  - 模块级 open 状态 + 订阅（与 ContextMenu 同款），组件卸载时状态保留。
 *  - 仅桌面层（非 #/settings）注册 Ctrl+K；设置窗口沿用其自身的搜索框快捷键。
 *  - 覆盖层加入 useClickThrough.OVERLAY_SELECTOR，打开期间窗口保持可交互。
 */

import { useCallback, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { isPrimaryWidgetWindow, isTauri, invoke } from "../lib/tauri";
import { appAccelMatches } from "../lib/shortcuts";
import { useSettingsStore } from "../store/settings-store";
import { useTauriEvent } from "../lib/use-tauri-event";
import { useT } from "../i18n-lite";
import { prefersReducedMotion, useDelayedUnmount } from "../lib/anim";
import { animDurations } from "../lib/durations";
import { buildCommands, type Command } from "../lib/commands";
/* A-1：设置索引搜索经注入进入命令目录（lib 不得反向 import features）；
   组件层是合法的 features 消费方。 */
import { searchSettings } from "../features/settings/settings-search";
import {
  buildPayloadCommands,
  isAbsolutePath,
  isPureUrl,
  palettePayload,
  payloadFromTransfer,
  setPalettePayload,
  subscribePayload,
  type PalettePayload
} from "../lib/palette-payload";
import { buildContextCommands, probeForegroundContext, type ForegroundContext } from "../lib/palette-context";
import { boostPreferred, recordSelection } from "../lib/palette-preference";
import {
  SEARCH_ENGINES,
  appAvatarColors,
  appInitial,
  cycleSearchEngine,
  isPathLikeQuery,
  launchApp,
  launchFileHit,
  loadAppIndex,
  loadLaunchStats,
  loadPinnedApps,
  loadSpotlightSettings,
  openWebSearch,
  saveSpotlightSettings,
  searchApps,
  searchFiles,
  type AppInfo,
  type FileHit,
  type LaunchStats,
  type SearchEngineId
} from "../lib/spotlight";
/* 面板样式随本 chunk 走（App 经 lazy 壳引用本模块）：不再由 main 入口静态
   打进所有窗口。 */
import "../styles/command-palette.css";

/** 面板内应用结果上限：避免淹没命令/设置结果。 */
const APP_RESULT_LIMIT = 8;
/** G11 文件结果上限（path-like 查询才触发，文件组排在应用之后）。 */
const FILE_RESULT_LIMIT = 8;
/** 文件搜索防抖：逐键扫盘太吵，停顿 250ms 再发起（Rust 侧另有 300ms 预算）。 */
const FILE_SEARCH_DEBOUNCE_MS = 250;
/**
 * [PASTE] 短单行文本粘贴仍落入输入框（搜索意图常见）；多行或超长文本转
 * 载荷芯片（内容意图）。文件 / 图片粘贴恒为载荷（ZTools 语义）。
 */
const PASTE_TEXT_PAYLOAD_MIN = 200;

function engineLabelOf(id: SearchEngineId): string {
  return SEARCH_ENGINES.find((e) => e.id === id)?.label ?? SEARCH_ENGINES[0].label;
}

/* ---- 模块级打开状态 ---- */
let paletteOpen = false;
const listeners = new Set<() => void>();
function notify(): void {
  for (const fn of [...listeners]) fn();
}
function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
export function openCommandPalette(): void {
  // 打开时总是回到第一屏（避免重开时残留旧查询与旧载荷）。
  resetQuery();
  setPalettePayload(null);
  paletteOpen = true;
  notify();
}
export function closeCommandPalette(): void {
  paletteOpen = false;
  // [PASTE] 收面板即清载荷（下一次打开回到普通搜索态；超级面板不经此路径，
  // 它的载荷生命周期由 SuperPanelView 自管）。
  setPalettePayload(null);
  notify();
  // [HOTKEY] 让 Rust 撤销全局呼出（Ctrl+Alt+K）时的临时置顶 / 前台编排
  // （windows.rs release_palette_window）。只有 primary 会被热键打开，也只由它
  // 回发；窗口内 Ctrl+K 打开的面板 Rust 侧无编排记录，收到后 no-op。
  if (isTauri() && isPrimaryWidgetWindow()) {
    void import("@tauri-apps/api/event").then(({ emit }) => emit("command-palette:closed")).catch(() => {});
  }
}
let pendingQuery = "";
function resetQuery(): void {
  pendingQuery = "";
}

function matchCommand(c: Command, q: string): boolean {
  const qq = q.trim().toLowerCase();
  if (!qq) return true;
  if (c.label.toLowerCase().includes(qq)) return true;
  if (c.group.toLowerCase().includes(qq)) return true;
  return (c.keywords ?? []).some((k) => k.toLowerCase().includes(qq));
}

export function CommandPaletteHost() {
  const tr = useT();
  const [openState, setOpenState] = useState(paletteOpen);
  const [query, setQuery] = useState(pendingQuery);
  const [hi, setHi] = useState(0);
  /* 指针扫过高亮合帧（P2 三轮）：onPointerEnter 逐行触发整面板重渲 + 指示条
     layoutEffect（读 offsetTop 强制 layout）。rAF 合帧让快速扫过 N 行至多
     每帧一次 setHi，视觉无差别。 */
  const hiRaf = useRef(0);
  const hoverHi = useCallback((i: number) => {
    if (hiRaf.current) cancelAnimationFrame(hiRaf.current);
    hiRaf.current = requestAnimationFrame(() => {
      hiRaf.current = 0;
      setHi(i);
    });
  }, []);
  useEffect(() => () => cancelAnimationFrame(hiRaf.current), []);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  /* [PASTE]（ZTools #1）粘贴态：模块级单值 + 订阅（与 open 态同款）。
     载荷清理挂在 closeCommandPalette（不在此处用「面板关闭即清」effect——
     桌面层每个窗口都挂了本组件，effect 会把超级面板刚设置的载荷清掉）。 */
  const [payloadState, setPayloadState] = useState<PalettePayload | null>(palettePayload());
  /* 载荷芯片退场窗口 + 最后快照（P2 三轮）：清除后保留一拍播淡出再卸载，
     期间以最后一份载荷渲染（与 ContextMenu 的 lastMenu 同范式）。 */
  const payloadVisible = useDelayedUnmount(payloadState != null, animDurations().fxXfastMs);
  const lastPayload = useRef<PalettePayload | null>(null);
  if (payloadState) lastPayload.current = payloadState;
  const shownPayload = payloadState ?? lastPayload.current;
  useEffect(
    () =>
      subscribePayload(() => {
        setPayloadState(palettePayload());
        setHi(0);
      }),
    []
  );

  /* [CTX]（ZTools #2）窗口上下文：打开时探一次「呼出前前台」；关闭即清。 */
  const [ctxState, setCtxState] = useState<ForegroundContext | null>(null);
  useEffect(() => {
    if (!openState) {
      setCtxState(null);
      return;
    }
    let alive = true;
    void probeForegroundContext().then((r) => {
      if (alive) setCtxState(r);
    });
    return () => {
      alive = false;
    };
  }, [openState]);

  /* #57：关闭后延迟卸载播退场（= --dur-fx-fast，与 command-palette.css 的
     pop-out 同源，随速度档缩放）；期间以最后一次结果快照渲染。 */
  const visible = useDelayedUnmount(openState, Math.round(animDurations().fxFastMs));
  const closing = !openState && visible;
  const lastResults = useRef<Command[]>([]);

  // 仅桌面层注册 Ctrl+K（设置窗口沿用其搜索框快捷键）。
  const isSettingsWin = window.location.hash === "#/settings";

  // 订阅模块级打开状态
  useEffect(
    () =>
      subscribe(() => {
        setOpenState(paletteOpen);
        setQuery(pendingQuery);
        setHi(0);
      }),
    []
  );

  // 打开时聚焦输入框。visible（useDelayedUnmount）比 openState 晚一次渲染才为
  // 真，输入框在那之后才挂载——只依赖 openState 时这里的 ref 恒为 null，面板
  // 打开后焦点停在文档根、打字无处可去（[HOTKEY] 全局呼出时用无障碍树实测抓到）。
  useEffect(() => {
    if (openState && visible) inputRef.current?.focus();
  }, [openState, visible]);

  /* 关闭归还焦点（与 ShortcutCheatsheet 同范式）：aria-modal 对话框关闭后
     焦点不得跌落 body。打开时记录触发元素，退场动画播完（visible 归零）后
     归还（isConnected 守卫：触发元素可能已卸载）。 */
  const prevFocusRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (openState) {
      prevFocusRef.current = document.activeElement as HTMLElement | null;
    } else if (!visible && prevFocusRef.current) {
      const prev = prevFocusRef.current;
      prevFocusRef.current = null;
      if (prev.isConnected) prev.focus({ preventScroll: true });
    }
  }, [openState, visible]);

  /* SPOT 应用模式：打开时拉取共享应用索引（模块级缓存命中即同步回调；首扫
     经典列表先到、UWP 后台合并二次回调）与使用统计/置顶快照。 */
  const [appList, setAppList] = useState<AppInfo[]>([]);
  const [launchMeta, setLaunchMeta] = useState<{ stats: LaunchStats; pinned: string[] }>({
    stats: {},
    pinned: []
  });
  const [engine, setEngine] = useState<SearchEngineId>(() => loadSpotlightSettings().engine);
  useEffect(() => {
    if (!openState) return;
    setLaunchMeta({ stats: loadLaunchStats(), pinned: loadPinnedApps() });
    loadAppIndex(setAppList);
  }, [openState]);

  /* C7（性能）：检索用 useDeferredValue——每键全量重建设置索引段是重活，
     输入框保持同步，结果列表延迟一帧跟进；文件搜索的防抖同样以 deferred
     值为触发源；results/hi 用 ref 进键盘 effect，避免逐键拆挂监听。 */
  const deferredQuery = useDeferredValue(query);

  /* SPOT-G11 文件模式：path-like 查询（含 \ / 或盘符）停顿 250ms 后发起
     异步搜索；晚到的旧结果经序号丢弃（alive 标记）。非文件意图 / 关闭时清空。
     搜索期间保留上一批命中（避免逐键闪空）。 */
  const [fileHits, setFileHits] = useState<FileHit[]>([]);
  useEffect(() => {
    if (!openState || !isPathLikeQuery(deferredQuery)) {
      setFileHits([]);
      return;
    }
    let alive = true;
    const t = window.setTimeout(() => {
      void searchFiles(deferredQuery, FILE_RESULT_LIMIT).then((hits) => {
        if (alive) setFileHits(hits);
      });
    }, FILE_SEARCH_DEBOUNCE_MS);
    return () => {
      alive = false;
      window.clearTimeout(t);
    };
  }, [openState, deferredQuery]);

  /** SPOT 网页兜底：循环切换搜索引擎并落盘本地配置（Tab 键 / 点击芯片共用）。 */
  const cycleEngine = useCallback(() => {
    setEngine((prev) => {
      const next = cycleSearchEngine(prev);
      saveSpotlightSettings({ engine: next });
      return next;
    });
  }, []);

  const commands = useMemo(
    () => (openState ? buildCommands(tr, { close: closeCommandPalette, settingsSearch: searchSettings }) : []),
    [openState, tr]
  );
  // P2（审计修复）：设置搜索项此前只在 openState 变化时用 pendingQuery（恒为
  // 空串）构建一次，之后输入 query 只对这批固定命令做过滤——绝大多数设置项
  // 永远搜不到。改为 query 变化时用实时 query 重建设置索引段，与已匹配的
  // 基础命令合并。
  const results = useMemo(() => {
    if (!openState) return [];
    const q = deferredQuery.trim();
    const base = commands
      .filter((c) => !c.id.startsWith("set-") && !c.id.startsWith("content-") && !c.id.startsWith("mset-"))
      .filter((c) => matchCommand(c, deferredQuery));
    // 内容级搜索段（便签/待办/DDL/书签）+ [MSET]（ZTools #3）设置深链段：与
    // 设置段同款「带实时 query 重建 + 段内预匹配」，仅在有查询词时产生条目。
    const queried = buildCommands(tr, {
      settingsQuery: deferredQuery,
      fallbackQuery: pendingQuery,
      settingsSearch: searchSettings,
      close: closeCommandPalette
    });
    const settingCmds = queried.filter((c) => c.id.startsWith("set-"));
    const contentCmds = queried.filter((c) => c.id.startsWith("content-"));
    const msetCmds = queried.filter((c) => c.id.startsWith("mset-"));
    // SPOT 应用模式：输入即搜（空查询不列应用，命令首屏不被淹没），应用组在前。
    const appCmds: Command[] = q
      ? searchApps(appList, q, launchMeta.stats, launchMeta.pinned, { limit: APP_RESULT_LIMIT }).map((app) => {
          const [c1, c2] = appAvatarColors(app.name);
          return {
            id: `app:${app.path}`,
            label: app.name,
            group: tr("应用程序"),
            avatar: { letter: appInitial(app.name), c1, c2 },
            run: () => {
              closeCommandPalette();
              launchApp(app);
            }
          };
        })
      : [];
    // G11 文件组：path-like 查询的异步命中（搜索期间可能滞后于输入）。
    const fileCmds: Command[] = fileHits.map((hit) => {
      const [c1, c2] = appAvatarColors(hit.name);
      return {
        id: `file:${hit.path}`,
        label: hit.name,
        group: tr("文件"),
        avatar: { letter: appInitial(hit.name), c1, c2 },
        title: hit.path,
        run: () => {
          closeCommandPalette();
          launchFileHit(hit);
        }
      };
    });
    // [PASTE]（ZTools #1）粘贴态动作段：载荷存在时置顶。
    const payloadCmds = payloadState
      ? buildPayloadCommands(tr, { engine, openWeb: openWebSearch, close: closeCommandPalette })
      : [];
    // [DIRECT]（ZTools #5）直达项：无载荷时，纯 URL / 绝对路径各给一条直达。
    const directCmds: Command[] = [];
    if (!payloadState && q) {
      const target = q.replace(/^["']|["']$/g, "");
      if (isPureUrl(target)) {
        directCmds.push({
          id: "direct-open-url",
          label: tr("打开网址"),
          group: tr("直达"),
          hint: target.slice(0, 80),
          keywords: ["open", "url"],
          run: () => {
            closeCommandPalette();
            if (isTauri()) void invoke("open_path", { path: target }).catch(() => {});
          }
        });
      } else if (isAbsolutePath(target)) {
        directCmds.push({
          id: "direct-open-folder",
          label: tr("前往文件夹"),
          group: tr("直达"),
          hint: target,
          keywords: ["folder", "explorer"],
          run: () => {
            closeCommandPalette();
            if (isTauri()) void invoke("open_path", { path: target }).catch(() => {});
          }
        });
      }
    }
    // [CTX]（ZTools #2）窗口上下文段（呼出前是 Explorer / 浏览器时）。
    const ctxCmds = ctxState ? buildContextCommands(ctxState, tr, closeCommandPalette) : [];
    const mergedAll = [
      ...payloadCmds,
      ...directCmds,
      ...ctxCmds,
      ...appCmds,
      ...fileCmds,
      ...base,
      ...settingCmds,
      ...msetCmds,
      ...contentCmds
    ];
    // [PREF]（ZTools #6）搜索偏好：同词上次选中的条目稳定置顶，再截 40。
    const merged = boostPreferred(mergedAll, q).slice(0, 40);
    // SPOT 网页兜底：无本地结果时唯一结果行 = 用当前引擎搜索，回车即开。
    if (merged.length === 0 && q) {
      return [
        {
          id: "web-search",
          label: tr("搜索「{query}」").replace("{query}", () => q),
          group: tr("网页"),
          hint: "Tab",
          engineLabel: tr(engineLabelOf(engine)),
          run: () => {
            closeCommandPalette();
            openWebSearch(engine, q);
          }
        }
      ];
    }
    return merged;
  }, [commands, openState, deferredQuery, tr, appList, launchMeta, engine, fileHits, payloadState, ctxState]);
  if (openState && results.length) lastResults.current = results;
  const resultsRef = useRef<Command[]>(results);
  resultsRef.current = results;
  const hiRef = useRef(hi);
  hiRef.current = hi;
  const queryRef = useRef(query);
  queryRef.current = query;

  /** [PREF]（ZTools #6）执行前记录「当前查询词 → 条目 id」，下次同词置顶。 */
  const runWithPreference = useCallback((c: Command) => {
    const q = queryRef.current.trim();
    if (q) recordSelection(q, c.id);
    c.run();
  }, []);

  useEffect(() => {
    if (isSettingsWin) return;
    const onKey = (e: KeyboardEvent) => {
      // 窗口内呼出键走可配置的应用内快捷键表（默认 Ctrl+K，可在设置页改/停用）。
      const entry = useSettingsStore.getState().appShortcuts.palette;
      if (!entry.enabled || !appAccelMatches(entry.accel, e)) return;
      e.preventDefault();
      if (paletteOpen) closeCommandPalette();
      else openCommandPalette();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isSettingsWin]);

  // [HOTKEY] 全局快捷键（默认 Ctrl+Alt+K，可在设置页改键）→ Rust dispatch 已先
  // 显示隐藏的层并把 widget-0 置前，再广播本事件。事件到达所有窗口，只有
  // primary（widget-0；浏览器预览视为 primary）响应，多屏不会同开两份面板。
  // 与窗口内 Ctrl+K 同为切换语义：面板已开则收起。
  useTauriEvent("shortcut:toggle-palette", () => {
    if (isSettingsWin || !isPrimaryWidgetWindow()) return;
    if (paletteOpen) closeCommandPalette();
    else openCommandPalette();
  });

  // 打开时：Escape 分步退出（[PASTE] 先清载荷再收面板，ZTools 同款）、方向键
  // 移动选择、Enter 执行（[PREF] 记录偏好）；Tab 在网页兜底行为唯一结果时循环
  // 切换搜索引擎（其余场景保留焦点导航）。
  // C7：results/hi 经 ref 读取，effect 只依赖开关状态，不再反复重挂监听。
  useEffect(() => {
    if (!openState || isSettingsWin) return;
    const onKey = (e: KeyboardEvent) => {
      const cur = resultsRef.current;
      if (e.key === "Escape") {
        e.preventDefault();
        if (palettePayload()) setPalettePayload(null);
        else closeCommandPalette();
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        /* 空结果时不再产生 -1 脏值（此前依赖后续 setHi(0) 修正）。 */
        if (cur.length === 0) return;
        setHi((h) => Math.min(h + 1, cur.length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        if (cur.length === 0) return;
        setHi((h) => Math.max(h - 1, 0));
      } else if (e.key === "Enter") {
        e.preventDefault();
        if (cur.length === 0) return;
        const c = cur[Math.max(0, Math.min(hiRef.current, cur.length - 1))];
        if (c) runWithPreference(c);
      } else if (e.key === "Tab" && cur.length === 1 && cur[0].id === "web-search") {
        e.preventDefault();
        cycleEngine();
      } else if (e.key === "Tab") {
        /* 焦点陷阱：aria-modal 面板内 Tab 循环（此前会逃逸到背景元素）。
           面板可聚焦元素 = 输入框 / 载荷清除钮 / 结果行；循环首尾相接。 */
        const box = boxRef.current;
        if (!box) return;
        e.preventDefault();
        const focusables = Array.from(
          box.querySelectorAll<HTMLElement>("input:not([tabindex='-1']), button:not([disabled])")
        ).filter((el) => el.offsetParent !== null || el === document.activeElement);
        if (focusables.length === 0) return;
        const idx = focusables.indexOf(document.activeElement as HTMLElement);
        const next = e.shiftKey
          ? focusables[(idx <= 0 ? focusables.length : idx) - 1]
          : focusables[(idx + 1) % focusables.length];
        next?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openState, isSettingsWin, cycleEngine, runWithPreference]);

  // 高亮项滚入视野
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-cmd-index="${hi}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [hi]);

  const shownResults = closing ? lastResults.current : results;

  /* 结果集高度过渡：逐键增减结果（及载荷芯片出入）时面板高度平滑伸缩，
     不再瞬跳。量高 FLIP——渲染提交后先清内联量出自然高度，从上一帧高度
     过渡到新值，过渡完清除内联交还自然布局（内容超出仍走列表滚动）。
     reduce-motion 直接跳过（只记高度不动画）。 */
  const boxRef = useRef<HTMLDivElement | null>(null);
  const boxHRef = useRef<number | null>(null);
  useLayoutEffect(() => {
    const el = boxRef.current;
    if (!el || !visible) {
      boxHRef.current = null;
      return;
    }
    el.style.transition = "none";
    el.style.height = "";
    const next = el.offsetHeight;
    const prev = boxHRef.current;
    boxHRef.current = next;
    if (prev == null || prev === next || prefersReducedMotion()) return;
    const ms = animDurations().animMs;
    el.style.height = `${prev}px`;
    void el.offsetHeight;
    // 量高 FLIP：面板高度从上一帧值一次性过渡到新值（逐键触发、播完清除内联
    // 交还自然布局），非常驻逐帧动画；Spotlight 式面板伸缩无合成器等价。
    /* layout-anim: ok height 一次性量高过渡（本文件唯一内联布局动画） */
    el.style.transition = `height ${ms}ms var(--ease-card-reflow)`;
    el.style.height = `${next}px`;
    const t = window.setTimeout(() => {
      el.style.transition = "";
      el.style.height = "";
    }, ms + 60);
    return () => window.clearTimeout(t);
  }, [shownResults, payloadState, visible]);

  /* #110 键盘导航滑移指示条：绝对定位滑块随 hi 平移，消除逐项背景切换的「瞬移感」 */
  const indicatorRef = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const list = listRef.current;
    const ind = indicatorRef.current;
    if (!list || !ind) return;
    const el = list.querySelector<HTMLElement>(`[data-cmd-index="${hi}"]`);
    if (!el) {
      ind.style.opacity = "0";
      return;
    }
    ind.style.transform = `translateY(${el.offsetTop}px)`;
    ind.style.height = `${el.offsetHeight}px`;
    ind.style.opacity = "1";
  }, [hi, shownResults, visible]);

  if (!visible) return null;

  /** [PASTE] 粘贴 → 载荷：文件/图片恒转；多行或超长文本转（内容意图），
   *  短单行文本仍落输入框（搜索意图）。返回是否拦截了默认粘贴。 */
  const acceptTransfer = (dt: DataTransfer | null): boolean => {
    const p = payloadFromTransfer(dt);
    if (!p) return false;
    if (p.kind === "text" && !p.text.includes("\n") && p.text.length < PASTE_TEXT_PAYLOAD_MIN) return false;
    setPalettePayload(p);
    setHi(0);
    return true;
  };

  const payloadChipLabel = (): string => {
    if (!payloadState) return "";
    if (payloadState.kind === "text") return payloadState.text.split("\n")[0].slice(0, 60) || tr("文本");
    if (payloadState.kind === "files")
      return payloadState.paths.length > 1
        ? tr("{n} 个文件").replace("{n}", String(payloadState.paths.length))
        : (payloadState.paths[0] ?? "").split(/[\\/]/).pop() || tr("文件");
    return payloadState.name;
  };

  return (
    <div
      className={`cmd-palette${closing ? " is-closing" : ""}`}
      role="dialog"
      aria-modal="true"
      aria-label={tr("命令面板")}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        acceptTransfer(e.dataTransfer);
      }}
    >
      <div className="cmd-palette-backdrop" onPointerDown={() => closeCommandPalette()} />
      <div ref={boxRef} className={`cmd-palette-box${closing ? " is-closing" : ""}`} data-testid="cmd-palette-box">
        <div className="cmd-palette-input">
          <input
            ref={inputRef}
            value={query}
            /* WAI-ARIA 1.2 combobox 模式：键盘高亮经 aria-activedescendant 播报，
               结果容器为 listbox（键盘焦点恒在输入框，方向键移动高亮）。 */
            role="combobox"
            aria-expanded={shownResults.length > 0}
            aria-controls="cmd-palette-listbox"
            aria-activedescendant={shownResults.length > 0 ? `cmd-opt-${hi}` : undefined}
            aria-autocomplete="list"
            onChange={(e) => {
              setQuery(e.target.value);
              pendingQuery = e.target.value;
              setHi(0);
            }}
            onPaste={(e) => {
              if (acceptTransfer(e.clipboardData)) e.preventDefault();
            }}
            placeholder={tr("搜索应用、命令或设置…")}
            data-interactive
          />
          <kbd>Esc</kbd>
        </div>
        {payloadVisible && shownPayload && (
          /* [PASTE] 载荷芯片：显示当前粘贴态 + 一键清除（Esc 第一步同义）。
             P2 三轮补退场：清除后保留一拍播淡出（快照渲染）再卸载。 */
          <div className={`cmd-palette-payload${payloadState ? "" : " is-closing"}`} data-interactive>
            <span
              className="cmd-palette-payload-chip"
              title={shownPayload.kind === "text" ? shownPayload.text.slice(0, 400) : undefined}
            >
              {shownPayload.kind === "text" && `${tr("文本")} · `}
              {payloadChipLabel()}
            </span>
            <button
              type="button"
              className="cmd-palette-payload-clear"
              aria-label={tr("清除粘贴内容")}
              onPointerDown={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setPalettePayload(null);
                inputRef.current?.focus();
              }}
            >
              ×
            </button>
          </div>
        )}
        {shownResults.length > 0 ? (
          <div
            className="cmd-palette-list"
            ref={listRef}
            role="listbox"
            id="cmd-palette-listbox"
            aria-label={tr("命令面板")}
          >
            {/* #110 键盘导航滑移指示条：随选中项平滑滑移 */}
            <div className="cmd-palette-indicator" ref={indicatorRef} aria-hidden="true" />
            {shownResults.map((c, i) => (
              <button
                key={c.id}
                data-cmd-index={i}
                title={c.title}
                className={`cmd-palette-item${i === hi ? " active" : ""}`}
                role="option"
                id={`cmd-opt-${i}`}
                aria-selected={i === hi}
                /* #56 过滤新增项错落入场：延迟随序号递增、7 项封顶 */
                style={{ animationDelay: `${Math.min(i, 7) * 0.03}s` }}
                data-interactive
                onPointerEnter={() => hoverHi(i)}
                onPointerDown={(e) => {
                  e.preventDefault();
                  runWithPreference(c);
                }}
              >
                {c.avatar && (
                  <span
                    className="cmd-palette-item-avatar"
                    style={{ background: `linear-gradient(135deg, ${c.avatar.c1}, ${c.avatar.c2})` }}
                    aria-hidden="true"
                  >
                    {c.avatar.letter}
                  </span>
                )}
                <span className="cmd-palette-item-label">{c.label}</span>
                {c.engineLabel && (
                  /* 芯片拦下 pointerdown：不触发整行 run，只循环引擎 */
                  <span
                    className="cmd-palette-engine"
                    title={tr("切换搜索引擎（Tab）")}
                    onPointerDown={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      cycleEngine();
                    }}
                  >
                    {c.engineLabel}
                  </span>
                )}
                <span className="cmd-palette-item-group">{c.group}</span>
                {c.hint && <kbd className="cmd-palette-hint">{c.hint}</kbd>}
              </button>
            ))}
          </div>
        ) : (
          <div className="cmd-palette-empty">{tr("没有匹配的命令")}</div>
        )}
      </div>
    </div>
  );
}
