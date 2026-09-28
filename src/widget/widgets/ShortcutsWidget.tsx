/**
 * 快捷方式小组件：从桌面 / 资源管理器把文件、文件夹或 .lnk 快捷方式直接拖进
 * 卡片即可自动识别（Tauri drag-drop + Rust `classify_path`），点击直接打开；
 * 图标在卡片内容区内自由拖动排布（磁性吸附到网格），类似「杂项」面板。
 *
 * - 条目 = 内置系统位置（默认不带，可在设置页勾选，回收站带真实角标）+
 *   拖入/设置页添加的自定义路径。真实图标经 Rust `get_app_icon`
 *   （SHGetFileInfoW，.lnk 解析到目标本体）提取，任何时刻都是系统图标。
 * - 排布：每条目在 config.positions 里有 {x,y} 格位（列 x / 行 y），pointer
 *   拖动 > 4px 视为移动（否则是点击打开），松手吸附到最近格；没有格位的
 *   条目按 columns 自动落到第一个空格。滚动带（marquee）模式维持原样。
 * - 快捷方式文件夹（类手机桌面）：config.shortcutFolders 聚合若干自定义
 *   条目成一枚可展开磁贴（2×2 迷你图标 + 成员数角标），单击弹条目网格；
 *   把条目拖到文件夹磁贴上、或右键「移入文件夹」即可收进（格位保留，移出
 *   优先回原格）。弹层（BentoDesk 借鉴）：WAAPI FLIP 从磁贴矩形连续变形、
 *   展开锁防双击误关、内联搜索过滤、条目可拖拽重排 / 拖出到画布或其它
 *   文件夹；打开方式可选 悬停 / 单击 / 钉住（config.sfolderOpenMode）。
 *   滚动带模式保持扁平：全部自定义条目照常参与，文件夹不进滚动带。
 * - 条目健康（BentoDesk file_missing）：失效引用只标缺失不删除，60s 复检
 *   自动治愈；Rust watch（shortcuts-watch:change）实时感知目标改名（classify
 *   重挂）/ 删除（标缺失）/ 内容变更（图标缓存失效重提取）。
 * - 文件夹操作入命令级撤销栈，
 *   Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y 全局生效，即时操作附「撤销」toast。
 * - 条目右键菜单 Portal 到 body：卡片壳层带 backdrop-filter，是 fixed 定位
 *   后代的包含块——菜单留在卡片内会按卡片坐标系换算 clientX/Y 而整体跑偏
 *   被裁剪（右键"无菜单"），Portal 到 body 才是真正的视口坐标。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  FileText,
  FolderClosed,
  FolderOpen,
  FolderPlus,
  Link2,
  Monitor,
  MousePointerClick,
  Trash2
} from "lucide-react";
import { invoke, isTauri } from "../../lib/tauri";
import { useDelayedUnmount } from "../../lib/anim";
import { animDurations } from "../../lib/durations";
import { useT } from "../../i18n-lite";
import { useWidgetConfig } from "../widget-config";
import {
  loadCustomShortcuts,
  loadShortcutFolders,
  loadShortcutPositions,
  nextFreeCell,
  applyResolvedTargets,
  folderMemberIds,
  isLinkFileEntry,
  markEntriesMissing,
  normShortcutPath,
  pruneFolderChildren,
  uniqueFolderLabel,
  type CustomShortcut,
  type ShortcutCell,
  type ShortcutFolder,
  type SfDropTarget,
  type SfOpenMode,
  type SfSortMode
} from "../shortcuts-shared";
import { ensureShortcutsUndoKeys, pushOp, undoOp } from "../shortcuts-undo";
import { pickFilePath } from "../../lib/file-dialog";
import { useOsFileDrop } from "../use-os-file-drop";
import { promptDialog, alertDialog, confirmDialog } from "../../components/PromptDialog";
import { loadWidgetConfig } from "../widget-config";
import { FolderPopup } from "./FolderPopup";
import { ShortcutFolderPopup } from "./ShortcutFolderPopup";
import { useTauriEvent } from "../../lib/use-tauri-event";
import { pushAppToast } from "../../components/ToastHost";
import { sourceNotify } from "../../lib/notifications";
import type { PopoverAnchor } from "../WidgetConfigPopover";
import type { PointerEvent as ReactPointerEvent } from "react";

type ShortcutDef = {
  id: string;
  label: string;
  icon: "recycle" | "pc" | "folder";
  /** shell: 位置（W-082 回收站角标只对 recycle 生效）。 */
  badge?: "recycle";
};

/** shortcuts-watch:change 的单条变更（Rust shortcut_watch 派发）。 */
type WatchChange = {
  type: "renamed" | "removed" | "modified";
  from?: string;
  to?: string;
  path?: string;
};

/** classify_path 的 kind 白名单归一（非法值回退 fallback）。 */
function normalizeKind(kind: string, fallback: CustomShortcut["kind"]): CustomShortcut["kind"] {
  return (["file", "folder", "url"] as const).includes(kind as CustomShortcut["kind"])
    ? (kind as CustomShortcut["kind"])
    : fallback;
}

/** 按 shapes 精确恢复文件夹 childIds（批量移入的 undo 用；已消失的文件夹跳过）。 */
function foldersWithShapes(
  folders: ShortcutFolder[],
  shapes: ReadonlyArray<{ id: string; childIds: string[] }>
): ShortcutFolder[] {
  const byId = new Map(shapes.map((s) => [s.id, s.childIds]));
  return folders.map((f) => (byId.has(f.id) ? { ...f, childIds: byId.get(f.id)! } : f));
}

/** W-081 内置位置全集：与 Rust SYSTEM_LOCATIONS 的 8 个 shell: 位置一一对应。 */
const ALL_BUILTIN: ShortcutDef[] = [
  { id: "recycle", label: "回收站", icon: "recycle", badge: "recycle" },
  { id: "computer", label: "此电脑", icon: "pc" },
  { id: "documents", label: "文档", icon: "folder" },
  { id: "downloads", label: "下载", icon: "folder" },
  { id: "pictures", label: "图片", icon: "folder" },
  { id: "music", label: "音乐", icon: "folder" },
  { id: "videos", label: "视频", icon: "folder" },
  { id: "desktop", label: "桌面", icon: "folder" }
];

/** 自由排布网格的行高/间距（列宽按卡片宽度与 columns 均分）。 */
const CELL_GAP = 10;
const CELL_H = 84;

type ShortcutEntry =
  | { kind: "builtin"; id: string; def: ShortcutDef; label: string }
  | { kind: "custom"; id: string; item: CustomShortcut; label: string }
  | { kind: "sfolder"; id: string; folder: ShortcutFolder; label: string };

/** 就地右键菜单的三种形态：条目菜单 / 移入文件夹选择器 / 文件夹磁贴菜单。 */
type MenuState =
  | { kind: "item"; x: number; y: number; item: CustomShortcut }
  | { kind: "move"; x: number; y: number; item: CustomShortcut }
  | { kind: "folder"; x: number; y: number; folder: ShortcutFolder; anchor: PopoverAnchor }
  | null;

function builtinIcon(icon: ShortcutDef["icon"]) {
  if (icon === "recycle") return <Trash2 size={26} />;
  if (icon === "pc") return <Monitor size={26} />;
  return <FolderOpen size={26} />;
}

export function ShortcutsWidget({ instanceId }: { instanceId: string }) {
  const tr = useT();
  const { config, update } = useWidgetConfig(instanceId);
  const showTitle = config.showTitle !== false;
  /** SHORTCUTS 标题紧凑高度（titleCompact）。 */
  const titleCompact = config.titleCompact === true;
  /** 图标下方的名称标签（隐藏后仅显示图标，悬停 title 仍可见全名）。 */
  const showLabels = config.showLabels !== false;
  const columns = Math.max(1, Math.min(6, (config.columns as number) || 2));
  const marquee = config.marquee === true;
  const custom = loadCustomShortcuts(config);
  // 内置位置默认不带（要的是拖入的真实快捷方式，不是预置的通用图标）。
  // useMemo 稳定引用：entries 的 useMemo 依赖它，避免每渲染重算。
  const builtin = useMemo(
    () =>
      Array.isArray(config.builtinShortcuts)
        ? (config.builtinShortcuts as string[]).filter((id) => ALL_BUILTIN.some((b) => b.id === id))
        : [],
    [config.builtinShortcuts]
  );
  const positions = loadShortcutPositions(config);
  const foldersRaw = useMemo(() => loadShortcutFolders(config), [config]);
  const customById = useMemo(() => new Map(custom.map((s) => [s.id, s])), [custom]);
  /** 悬挂引用防御：设置页删除条目不感知文件夹，渲染期把 childIds 过滤到现存条目。 */
  const folders = useMemo(
    () => foldersRaw.map((f) => ({ ...f, childIds: f.childIds.filter((id) => customById.has(id)) })),
    [foldersRaw, customById]
  );
  const memberIds = useMemo(() => folderMemberIds(folders), [folders]);

  /** path → data:image/png;base64 的真实图标缓存（本次挂载内）。iconVersion
      供 watch 的内容变更事件触发重提取（Rust 侧已删磁盘缓存）。 */
  const [icons, setIcons] = useState<Record<string, string>>({});
  const [iconVersion, setIconVersion] = useState(0);
  useEffect(() => {
    if (!isTauri()) return;
    let cancelled = false;
    const pending = custom.filter((s) => s.kind !== "url" && !icons[s.path]);
    if (pending.length === 0) return;
    void Promise.all(
      pending.map((s) =>
        invoke<string | null>("get_app_icon", { path: s.path })
          .then((b64) => (b64 ? ([s.path, `data:image/png;base64,${b64}`] as const) : null))
          .catch(() => null)
      )
    ).then((results) => {
      if (cancelled) return;
      const next: Record<string, string> = {};
      for (const r of results) if (r) next[r[0]] = r[1];
      if (Object.keys(next).length > 0) setIcons((prev) => ({ ...prev, ...next }));
    });
    return () => {
      cancelled = true;
    };
    // icons 仅作去重缓存，不触发重提取循环；iconVersion 由 watch 失效事件递增。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [iconVersion, custom.map((s) => s.path).join("|")]);

  /* ---- 旧条目自愈迁移：lnk/url 解析落地之前拖入的条目存的是链接本体路径，
          桌面原快捷方式被删后入口即失效。挂载时把仍指向 .lnk/.url 的条目经
          classify_path 重解析，能解析出目标的改存目标路径（kind 按目标归位），
          解析失败（链接已损坏/已删）保持原样。迁移只改 path/kind 不改 id——
          id 集不变则不重跑；写前现读权威副本，不覆写迁移期间的其他并发改动。 ---- */
  const customIdSig = custom.map((s) => s.id).join("|");
  useEffect(() => {
    if (!isTauri()) return;
    const stale = custom.filter(isLinkFileEntry);
    if (stale.length === 0) return;
    let cancelled = false;
    void Promise.all(
      stale.map((s) =>
        invoke<{ label: string; kind: string; path?: string | null }>("classify_path", { path: s.path })
          .then((r): { id: string; path: string; kind: CustomShortcut["kind"] } | null => {
            if (!r.path || r.path === s.path) return null;
            const kind = (["file", "folder", "url"] as const).includes(r.kind as CustomShortcut["kind"])
              ? (r.kind as CustomShortcut["kind"])
              : s.kind;
            return { id: s.id, path: r.path, kind };
          })
          .catch(() => null)
      )
    ).then((results) => {
      if (cancelled) return;
      const fixes = results.filter((r): r is { id: string; path: string; kind: CustomShortcut["kind"] } => r !== null);
      if (fixes.length === 0) return;
      const current = loadCustomShortcuts(loadWidgetConfig(instanceId));
      const next = applyResolvedTargets(current, fixes);
      if (next !== current) update({ customShortcuts: next });
    });
    return () => {
      cancelled = true;
    };
    // 迁移幂等：完成后的重渲染（path/kind 变了但 id 集没变）不会再次触发。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customIdSig]);

  /** W-082 系统回收站真实角标：低频轮询 $Recycle.Bin 条目数。 */
  const [binCount, setBinCount] = useState<number | null>(null);
  useEffect(() => {
    if (!isTauri()) return;
    let cancelled = false;
    const poll = () =>
      invoke<number>("recycle_bin_count")
        .then((n) => {
          if (!cancelled) setBinCount(n);
        })
        .catch(() => {});
    void poll();
    const timer = window.setInterval(poll, 60000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  const openCustom = (s: CustomShortcut) => {
    if (!isTauri()) return;
    if (s.missing) {
      pushAppToast(tr("目标缺失"), s.label, "error");
      return;
    }
    void invoke("open_path", { path: s.path }).catch(() => {});
  };

  /* ---- DeskOrder 借鉴 #1：目录监视自动整理。配置变化 → Rust 按实例整替
          watcher（哈希未变不拆建）；新文件命中规则 → auto-organize:add 事件
          → 与手动拖入同一条 classify 入列路径，按 path 去重。
          C10：notify 开启时命中额外发
          系统通知（走 sourceNotify，受通知中心来源门控与留档约束）。 ---- */
  const autoOrg = config.autoOrganize as
    | {
        watchPath: string;
        extensions: string[];
        nameTokens: string[];
        extEnabled: boolean;
        nameEnabled: boolean;
        notify: boolean;
        olderThanDays?: number;
        olderBy?: "modified" | "created";
        minSizeMb?: number;
      }
    | undefined;
  const autoOrgSig = JSON.stringify(autoOrg ?? null);
  useEffect(() => {
    if (!isTauri()) return;
    const cfg = autoOrg ?? {
      watchPath: "",
      extensions: [],
      nameTokens: [],
      extEnabled: true,
      nameEnabled: false,
      notify: false,
      olderThanDays: 0,
      olderBy: "modified",
      minSizeMb: 0
    };
    void invoke("apply_auto_organize", { configs: [{ instanceId, ...cfg }] }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instanceId, autoOrgSig]);

  const addPathsFromOrganizer = (paths: string[]) => {
    void Promise.all(
      paths.map((path) =>
        invoke<{ label: string; kind: string; path?: string }>("classify_path", { path })
          .then((r): CustomShortcut => ({
            id: crypto.randomUUID(),
            label: r.label,
            path: r.path ?? path,
            kind: (["file", "folder", "url"] as const).includes(r.kind as CustomShortcut["kind"])
              ? (r.kind as CustomShortcut["kind"])
              : ("file" as const)
          }))
          .catch(() => null)
      )
    ).then((results) => {
      const items = results.filter((r): r is CustomShortcut => r !== null);
      if (items.length === 0) return;
      const cur = loadCustomShortcuts(loadWidgetConfig(instanceId));
      const fresh = items.filter((it) => !cur.some((x) => x.path === it.path));
      if (fresh.length > 0) update({ customShortcuts: [...cur, ...fresh] });
    });
  };

  useTauriEvent<{ instanceId: string; path: string; notify?: boolean; watchPath?: string }>(
    "auto-organize:add",
    (p) => {
      if (!p || p.instanceId !== instanceId) return;
      // C10 通知动作：走通知中心来源门控（sourceNotify 内部处理留档）。
      if (p.notify) {
        const name = p.path.split(/[\\/]/).pop() ?? p.path;
        sourceNotify("app", tr("新文件已自动整理"), `${name}${p.watchPath ? ` · ${p.watchPath}` : ""}`);
      }
      addPathsFromOrganizer([p.path]);
    }
  );

  /* ---- BentoDesk file_missing 语义：失效引用只标缺失不删除——移动盘未接、
          临时移除这类失效可恢复，条目保留（渲染缺失态、禁打开）。挂载即查
          + 60s 周期复检，目标恢复自动解除标记；新检出缺失弹一次提示。 ---- */
  useEffect(() => {
    if (!isTauri()) return;
    let cancelled = false;
    const check = async () => {
      const cur = loadCustomShortcuts(loadWidgetConfig(instanceId));
      const targets = cur.filter((s) => s.kind !== "url");
      if (targets.length === 0) return;
      try {
        const ok = await invoke<boolean[]>("check_paths_exist", { paths: targets.map((s) => s.path) });
        if (cancelled || !Array.isArray(ok)) return;
        const missingPaths = targets.filter((_, i) => !ok[i]).map((s) => s.path);
        const wasMissing = cur.filter((s) => s.missing).length;
        const next = markEntriesMissing(cur, missingPaths);
        if (next !== cur) update({ customShortcuts: next });
        if (next.filter((s) => s.missing).length > wasMissing) {
          pushAppToast(tr("有快捷方式目标缺失"), tr("条目已保留，目标恢复后自动解除"), "error");
        }
      } catch {
        /* 单轮失败忽略，下轮复检兜底 */
      }
    };
    void check();
    const timer = window.setInterval(check, 60000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
    // 写前现读权威副本，不覆写并发改动。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instanceId]);

  /* ---- BentoDesk 借鉴 #4 引用侧：目标文件改名 / 删除 / 内容变更实时感知。
          Rust watch 各实例条目父目录（哈希未变不拆建），变更全局广播，
          前端按自身条目路径消费：改名→classify 重挂、删除→核实后标缺失、
          内容变更→弃前端图标缓存重提取（Rust 已删磁盘缓存）。 ---- */
  const watchSig = custom
    .filter((s) => s.kind !== "url")
    .map((s) => s.path)
    .join("|");
  useEffect(() => {
    if (!isTauri()) return;
    void invoke("apply_shortcut_watch", {
      configs: [{ instanceId, paths: watchSig ? watchSig.split("|") : [] }]
    }).catch(() => {});
  }, [instanceId, watchSig]);

  const handleWatchChanges = async (changes: WatchChange[]) => {
    const cur = loadCustomShortcuts(loadWidgetConfig(instanceId));
    if (cur.length === 0) return;
    const byPath = new Map(cur.map((s) => [normShortcutPath(s.path), s]));
    let next = cur;

    // 改名：classify 重挂（label/kind 归位），missing 一并解除（重建对象）。
    const renames = changes.filter((c) => c.type === "renamed" && c.from && c.to);
    if (renames.length > 0) {
      const fixes = await Promise.all(
        renames.map(async (c) => {
          const entry = byPath.get(normShortcutPath(c.from!));
          if (!entry) return null;
          try {
            const r = await invoke<{ label: string; kind: string; path?: string | null }>("classify_path", {
              path: c.to
            });
            return {
              id: entry.id,
              path: r.path ?? c.to!,
              kind: normalizeKind(r.kind, entry.kind),
              label: r.label || entry.label
            };
          } catch {
            return { id: entry.id, path: c.to!, kind: entry.kind, label: entry.label };
          }
        })
      );
      for (const f of fixes.filter((x): x is NonNullable<typeof x> => !!x)) {
        next = next.map((s) => (s.id === f.id ? { id: s.id, label: f.label, path: f.path, kind: f.kind } : s));
      }
    }

    // 删除：核实后标缺失（事件与磁盘状态可能短暂不一致）。
    const removedPaths = changes.filter((c) => c.type === "removed" && c.path).map((c) => c.path!);
    if (removedPaths.length > 0) {
      try {
        const ok = await invoke<boolean[]>("check_paths_exist", { paths: removedPaths });
        next = markEntriesMissing(
          next,
          removedPaths.filter((_, i) => !ok[i])
        );
      } catch {
        /* 60s 复检兜底 */
      }
    }

    if (next !== cur) update({ customShortcuts: next });

    // 内容变更：图标已过期——弃缓存并触发重提取。
    const modified = new Set(
      changes.filter((c) => c.type === "modified" && c.path).map((c) => normShortcutPath(c.path!))
    );
    if (modified.size > 0) {
      setIcons((prev) => Object.fromEntries(Object.entries(prev).filter(([k]) => !modified.has(normShortcutPath(k)))));
      setIconVersion((v) => v + 1);
    }
  };
  useTauriEvent<{ changes: WatchChange[] }>("shortcuts-watch:change", (p) => {
    if (!p?.changes?.length) return;
    void handleWatchChanges(p.changes);
  });

  /* ---- 操作历史：Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y 全局接线（模块幂等）。 ---- */
  useEffect(() => {
    ensureShortcutsUndoKeys();
  }, []);
  const openBuiltin = (id: string) => {
    if (!isTauri()) return;
    void invoke("open_system_location", { kind: id }).catch(() => {});
  };

  /* ---- 文件夹预览小窗（DeskOrder 借鉴 #13）：真实文件夹条目单击弹就地图标
          网格，再点同一条 = 关闭（toggle）；folderPreview 关闭时维持原行为
          直接开资源管理器。右键菜单「打开」不受影响，始终直达资源管理器。 ---- */
  const folderPreview = config.folderPreview !== false;
  const [folderPopup, setFolderPopup] = useState<{ path: string; anchor: PopoverAnchor } | null>(null);
  const activateEntry = (s: CustomShortcut, rect: DOMRect) => {
    if (folderPreview && s.kind === "folder" && isTauri()) {
      const anchor = { x: rect.x, y: rect.y, w: rect.width, h: rect.height };
      setFolderPopup((cur) => (cur && cur.path === s.path ? null : { path: s.path, anchor }));
      return;
    }
    openCustom(s);
  };

  /** 显示列表（画布网格）：内置 + 未入文件夹的自定义 + 文件夹磁贴，order 中的
      id 优先（自动排布用）；文件夹成员不直接铺网格，由文件夹磁贴代表。 */
  const entries = useMemo<ShortcutEntry[]>(() => {
    const list: ShortcutEntry[] = [
      ...builtin.map((id) => {
        const def = ALL_BUILTIN.find((b) => b.id === id)!;
        return { kind: "builtin" as const, id, def, label: tr(def.label) };
      }),
      ...custom
        .filter((item) => !memberIds.has(item.id))
        .map((item) => ({ kind: "custom" as const, id: item.id, item, label: item.label })),
      ...folders.map((folder) => ({ kind: "sfolder" as const, id: folder.id, folder, label: folder.label }))
    ];
    const order = Array.isArray(config.order) ? (config.order as string[]) : [];
    const rank = new Map(order.map((id, i) => [id, i]));
    return [...list].sort(
      (a, b) => (rank.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.id) ?? Number.MAX_SAFE_INTEGER)
    );
  }, [builtin, custom, folders, memberIds, config.order, tr]);

  /** 滚动带保持扁平：全部自定义条目（含文件夹成员）照常参与，文件夹不进带。 */
  const flatEntries = useMemo<ShortcutEntry[]>(() => {
    const list: ShortcutEntry[] = [
      ...builtin.map((id) => {
        const def = ALL_BUILTIN.find((b) => b.id === id)!;
        return { kind: "builtin" as const, id, def, label: tr(def.label) };
      }),
      ...custom.map((item) => ({ kind: "custom" as const, id: item.id, item, label: item.label }))
    ];
    const order = Array.isArray(config.order) ? (config.order as string[]) : [];
    const rank = new Map(order.map((id, i) => [id, i]));
    return [...list].sort(
      (a, b) => (rank.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.id) ?? Number.MAX_SAFE_INTEGER)
    );
  }, [builtin, custom, config.order, tr]);

  const entryById = useMemo(() => new Map(entries.map((e) => [e.id, e])), [entries]);

  /* ---- 快捷方式文件夹操作：全部写前现读权威副本，不覆写并发改动；
          每个操作入命令级撤销栈（undo/redo 现读现打逆补丁，与后续无关
          操作天然可组合）。 ---- */
  const createFolderWith = (childId?: string) => {
    const cfg = loadWidgetConfig(instanceId);
    // 默认名避让：重名自动 (n) 后缀。
    const taken = new Set(loadShortcutFolders(cfg).map((f) => f.label));
    const folder: ShortcutFolder = {
      id: crypto.randomUUID(),
      label: uniqueFolderLabel(taken, tr("新建文件夹")),
      childIds: childId ? [childId] : []
    };
    const pos = loadShortcutPositions(cfg);
    // 就地变换：新文件夹直接落在源条目的格位上（手机桌面同款）。
    const folderCell = childId && pos[childId] ? pos[childId] : undefined;
    update({
      shortcutFolders: [...loadShortcutFolders(cfg), folder],
      ...(folderCell ? { positions: { ...pos, [folder.id]: folderCell } } : {})
    });
    pushOp({
      label: tr("新建文件夹"),
      undo: () => {
        const now = loadWidgetConfig(instanceId);
        update({
          shortcutFolders: loadShortcutFolders(now).filter((f) => f.id !== folder.id),
          positions: Object.fromEntries(Object.entries(loadShortcutPositions(now)).filter(([id]) => id !== folder.id))
        });
      },
      redo: () => {
        const now = loadWidgetConfig(instanceId);
        update({
          shortcutFolders: [...loadShortcutFolders(now).filter((f) => f.id !== folder.id), folder],
          ...(folderCell ? { positions: { ...loadShortcutPositions(now), [folder.id]: folderCell } } : {})
        });
      }
    });
  };
  /** 移入文件夹；实际发生移动（入栈了操作）时返回 true，供调用方决定 toast。 */
  const moveIntoFolder = (childId: string, folderId: string): boolean => {
    const cur = loadShortcutFolders(loadWidgetConfig(instanceId));
    const target = cur.find((f) => f.id === folderId);
    if (!target || target.childIds.includes(childId)) return false;
    // 格位保留不删：移出时优先回原格（被占则重新分配）。
    update({
      shortcutFolders: cur.map((f) => (f.id === folderId ? { ...f, childIds: [...f.childIds, childId] } : f))
    });
    pushOp({
      label: tr("移入文件夹"),
      undo: () => {
        const now = loadShortcutFolders(loadWidgetConfig(instanceId));
        update({
          shortcutFolders: now.map((f) =>
            f.id === folderId ? { ...f, childIds: f.childIds.filter((id) => id !== childId) } : f
          )
        });
      },
      redo: () => {
        const now = loadShortcutFolders(loadWidgetConfig(instanceId));
        update({
          shortcutFolders: now.map((f) =>
            f.id === folderId && !f.childIds.includes(childId) ? { ...f, childIds: [...f.childIds, childId] } : f
          )
        });
      }
    });
    return true;
  };
  /** 移出文件夹（dropCell 可选：弹层拖出落格）；实际发生移动时返回 true。 */
  const moveOutOfFolder = (folderId: string, item: CustomShortcut, dropCell?: ShortcutCell): boolean => {
    const cfg = loadWidgetConfig(instanceId);
    const cur = loadShortcutFolders(cfg);
    if (!cur.some((f) => f.id === folderId && f.childIds.includes(item.id))) return false;
    const pos = loadShortcutPositions(cfg);
    const prevCell = pos[item.id];
    const taken = new Map(layoutCells);
    const cell = dropCell
      ? nextFreeCell(taken, columns, dropCell)
      : prevCell && ![...taken.values()].some((c) => c.x === prevCell.x && c.y === prevCell.y)
        ? prevCell
        : nextFreeCell(taken, columns);
    update({
      shortcutFolders: cur.map((f) =>
        f.id === folderId ? { ...f, childIds: f.childIds.filter((id) => id !== item.id) } : f
      ),
      positions: { ...pos, [item.id]: cell }
    });
    pushOp({
      label: tr("移出文件夹"),
      undo: () => {
        const now = loadWidgetConfig(instanceId);
        const nowPos = loadShortcutPositions(now);
        update({
          shortcutFolders: loadShortcutFolders(now).map((f) =>
            f.id === folderId && !f.childIds.includes(item.id) ? { ...f, childIds: [...f.childIds, item.id] } : f
          ),
          positions: prevCell
            ? { ...nowPos, [item.id]: prevCell }
            : Object.fromEntries(Object.entries(nowPos).filter(([id]) => id !== item.id))
        });
      },
      redo: () => {
        const now = loadWidgetConfig(instanceId);
        update({
          shortcutFolders: loadShortcutFolders(now).map((f) =>
            f.id === folderId ? { ...f, childIds: f.childIds.filter((id) => id !== item.id) } : f
          ),
          positions: { ...loadShortcutPositions(now), [item.id]: cell }
        });
      }
    });
    return true;
  };
  const renameFolder = async (folder: ShortcutFolder) => {
    const label = await promptDialog({ title: tr("重命名文件夹"), initialValue: folder.label });
    const next = label?.trim();
    if (!next || next === folder.label) return;
    const prev = folder.label;
    update({
      shortcutFolders: loadShortcutFolders(loadWidgetConfig(instanceId)).map((f) =>
        f.id === folder.id ? { ...f, label: next } : f
      )
    });
    pushOp({
      label: tr("重命名文件夹"),
      undo: () => {
        update({
          shortcutFolders: loadShortcutFolders(loadWidgetConfig(instanceId)).map((f) =>
            f.id === folder.id ? { ...f, label: prev } : f
          )
        });
      },
      redo: () => {
        update({
          shortcutFolders: loadShortcutFolders(loadWidgetConfig(instanceId)).map((f) =>
            f.id === folder.id ? { ...f, label: next } : f
          )
        });
      }
    });
  };
  const removeFolder = async (folder: ShortcutFolder) => {
    if (
      !(await confirmDialog({
        title: tr("移除文件夹"),
        message: tr("文件夹将删除，里面的快捷方式移回外面。"),
        confirmLabel: tr("移除"),
        danger: true
      }))
    )
      return;
    // 磁贴先播退场动画，播完再落删（成员回画布在 commit 内一次完成）。
    beginTileExit([folder.id], () => {
      const cfg = loadWidgetConfig(instanceId);
      const cur = loadShortcutFolders(cfg);
      const target = cur.find((f) => f.id === folder.id);
      if (!target) return;
      const kids = target.childIds.map((id) => customById.get(id)).filter((x): x is CustomShortcut => !!x);
      const pos = loadShortcutPositions(cfg);
      // 逆补丁要恢复的旧格位：文件夹 + 每个成员的原存格（可能本就没有）。
      const prevCells = new Map<string, ShortcutCell | undefined>([
        [target.id, pos[target.id]],
        ...kids.map((k) => [k.id, pos[k.id]] as const)
      ]);
      const nextPos = { ...pos };
      delete nextPos[target.id];
      // 成员回画布：优先回各自原格（空着才用），否则依次落到第一个空格。
      const taken = new Map(layoutCells);
      taken.delete(target.id);
      for (const k of kids) {
        const stored = nextPos[k.id];
        const cell =
          stored && ![...taken.values()].some((c) => c.x === stored.x && c.y === stored.y)
            ? stored
            : nextFreeCell(taken, columns);
        nextPos[k.id] = cell;
        taken.set(k.id, cell);
      }
      update({ shortcutFolders: cur.filter((f) => f.id !== target.id), positions: nextPos });
      pushOp({
        label: tr("移除文件夹"),
        undo: () => {
          const now = loadWidgetConfig(instanceId);
          const nowPos = { ...loadShortcutPositions(now) };
          for (const [id, cell] of prevCells) {
            if (cell) nowPos[id] = cell;
            else delete nowPos[id];
          }
          update({ shortcutFolders: [...loadShortcutFolders(now), target], positions: nowPos });
        },
        redo: () => {
          // 对当前配置重演同语义移除（成员回画布格位现算）。
          const now = loadWidgetConfig(instanceId);
          const nowFolders = loadShortcutFolders(now);
          const t = nowFolders.find((f) => f.id === target.id);
          if (!t) return;
          const nowPos = { ...loadShortcutPositions(now) };
          delete nowPos[t.id];
          const takenNow = new Map(layoutCells);
          takenNow.delete(t.id);
          const members = t.childIds.map((id) => customById.get(id)).filter((x): x is CustomShortcut => !!x);
          for (const k of members) {
            const stored = nowPos[k.id];
            const cell =
              stored && ![...takenNow.values()].some((c) => c.x === stored.x && c.y === stored.y)
                ? stored
                : nextFreeCell(takenNow, columns);
            nowPos[k.id] = cell;
            takenNow.set(k.id, cell);
          }
          update({ shortcutFolders: nowFolders.filter((f) => f.id !== t.id), positions: nowPos });
        }
      });
    });
  };

  /** 弹层内拖拽重排提交：完整 childIds 覆写（一条 undo 记录）。 */
  const reorderFolderChildren = (folderId: string, childIds: string[]) => {
    const cur = loadShortcutFolders(loadWidgetConfig(instanceId));
    const target = cur.find((f) => f.id === folderId);
    if (!target) return;
    const prev = target.childIds;
    if (prev.join("\u{1}") === childIds.join("\u{1}")) return;
    update({ shortcutFolders: cur.map((f) => (f.id === folderId ? { ...f, childIds } : f)) });
    pushOp({
      label: tr("调整顺序"),
      undo: () => {
        update({
          shortcutFolders: loadShortcutFolders(loadWidgetConfig(instanceId)).map((f) =>
            f.id === folderId ? { ...f, childIds: prev } : f
          )
        });
      },
      redo: () => {
        update({
          shortcutFolders: loadShortcutFolders(loadWidgetConfig(instanceId)).map((f) =>
            f.id === folderId ? { ...f, childIds } : f
          )
        });
      }
    });
  };

  /** 弹层展示排序（folder.sort 偏好，非内容操作、不入撤销栈）。 */
  const setFolderSort = (folderId: string, mode: SfSortMode) => {
    const cur = loadShortcutFolders(loadWidgetConfig(instanceId));
    if (!cur.some((f) => f.id === folderId)) return;
    update({
      shortcutFolders: cur.map((f) =>
        f.id === folderId ? { ...f, ...(mode === "free" ? { sort: undefined } : { sort: mode }) } : f
      )
    });
  };

  /** 弹层条目拖出松手：落到画布格位 = 带格位移出；落到其它文件夹 = 跨文件夹
      移动（一条合成操作）；无有效落点 = 取消。 */
  const dropOutsideFolder = (folder: ShortcutFolder, item: CustomShortcut, target: SfDropTarget | null) => {
    if (!target) return;
    if (target.kind === "canvas") {
      if (!moveOutOfFolder(folder.id, item, target.cell)) return;
      pushAppToast(tr("已移出文件夹"), item.label, "info", {
        action: { label: tr("撤销"), run: () => undoOp() }
      });
      return;
    }
    if (target.folderId === folder.id) return;
    const cur = loadShortcutFolders(loadWidgetConfig(instanceId));
    const to = cur.find((f) => f.id === target.folderId);
    if (!to || to.childIds.includes(item.id)) return;
    const applyMove = (folders: ShortcutFolder[]): ShortcutFolder[] =>
      folders.map((f) => {
        if (f.id === folder.id && f.childIds.includes(item.id))
          return { ...f, childIds: f.childIds.filter((id) => id !== item.id) };
        if (f.id === to.id) return { ...f, childIds: [...f.childIds, item.id] };
        return f;
      });
    update({ shortcutFolders: applyMove(cur) });
    pushOp({
      label: tr("移入文件夹"),
      undo: () => {
        const now = loadShortcutFolders(loadWidgetConfig(instanceId));
        update({
          shortcutFolders: now.map((f) => {
            if (f.id === folder.id && !f.childIds.includes(item.id))
              return { ...f, childIds: [...f.childIds, item.id] };
            if (f.id === to.id) return { ...f, childIds: f.childIds.filter((id) => id !== item.id) };
            return f;
          })
        });
      },
      redo: () => {
        update({ shortcutFolders: applyMove(loadShortcutFolders(loadWidgetConfig(instanceId))) });
      }
    });
    pushAppToast(tr("已移入文件夹"), to.label, "info", {
      action: { label: tr("撤销"), run: () => undoOp() }
    });
  };

  /* ---- 文件夹磁贴 → 条目网格弹层。打开方式（BentoDesk 三显示模式）：
          click 单击 toggle（默认）；hover 悬停意图 90ms 展开、离开 200ms
          宽限收回（重进取消）；pin 钉住（外点不关）。 ---- */
  const [sfPopup, setSfPopup] = useState<{ folderId: string; anchor: PopoverAnchor } | null>(null);
  const sfOpenMode: SfOpenMode =
    config.sfolderOpenMode === "hover" || config.sfolderOpenMode === "pin"
      ? (config.sfolderOpenMode as SfOpenMode)
      : "click";
  const openSfPopup = (folder: ShortcutFolder, rect: DOMRect) => {
    const anchor = { x: rect.x, y: rect.y, w: rect.width, h: rect.height };
    setSfPopup((cur) => (cur && cur.folderId === folder.id ? null : { folderId: folder.id, anchor }));
  };
  const sfFolder = sfPopup ? folders.find((f) => f.id === sfPopup.folderId) : undefined;

  /* hover 模式三定时器：意图（磁贴上悬停 90ms 才开）与宽限（离开 200ms 才收，
     期间重进取消）。弹层侧 pointerenter/leave 经 onHoverEnter/Leave 汇入。 */
  const hoverIntentRef = useRef<number | null>(null);
  const graceTimerRef = useRef<number | null>(null);
  const cancelHoverIntent = () => {
    if (hoverIntentRef.current != null) {
      window.clearTimeout(hoverIntentRef.current);
      hoverIntentRef.current = null;
    }
  };
  const cancelGraceClose = useCallback(() => {
    if (graceTimerRef.current != null) {
      window.clearTimeout(graceTimerRef.current);
      graceTimerRef.current = null;
    }
  }, []);
  const scheduleGraceClose = useCallback(() => {
    if (sfOpenMode !== "hover") return;
    cancelGraceClose();
    graceTimerRef.current = window.setTimeout(() => setSfPopup(null), 200);
  }, [sfOpenMode, cancelGraceClose]);
  useEffect(
    () => () => {
      cancelHoverIntent();
      cancelGraceClose();
    },
    [cancelGraceClose]
  );
  const tilePointerEnter = (folder: ShortcutFolder) => {
    if (sfOpenMode !== "hover" || sfPopup) return;
    cancelGraceClose();
    if (hoverIntentRef.current != null) return;
    hoverIntentRef.current = window.setTimeout(() => {
      hoverIntentRef.current = null;
      const el = folderTileRefs.current.get(folder.id);
      if (!el) return;
      const r = el.getBoundingClientRect();
      openSfPopup(folder, r);
    }, 90);
  };
  const tilePointerLeave = (folder: ShortcutFolder) => {
    if (sfOpenMode !== "hover") return;
    cancelHoverIntent();
    if (sfPopup?.folderId === folder.id) scheduleGraceClose();
  };

  /* ---- 弹层拖出/OS 拖入的画布命中测试：文件夹磁贴优先，其次内容区格位。
          供 ShortcutFolderPopup 的拖出落点与 OS drop 直入文件夹共用。 ---- */
  const folderTileRefs = useRef(new Map<string, HTMLElement>());
  const [outDrag, setOutDrag] = useState<SfDropTarget | null>(null);
  const [osFolderHover, setOsFolderHover] = useState<string | null>(null);
  /* 网格磁贴删除退场：确认后先挂 is-closing 播缩小淡出（w-card-exit 语言），
     240ms 播完再真正落删，网格不再「图标瞬消突然补位」。 */
  const [removingIds, setRemovingIds] = useState<ReadonlySet<string>>(() => new Set());
  const removingTimerRef = useRef(0);
  const beginTileExit = useCallback((ids: string[], commit: () => void) => {
    setRemovingIds((prev) => {
      const next = new Set(prev);
      for (const id of ids) next.add(id);
      return next;
    });
    window.clearTimeout(removingTimerRef.current);
    removingTimerRef.current = window.setTimeout(() => {
      setRemovingIds((prev) => {
        const next = new Set(prev);
        for (const id of ids) next.delete(id);
        return next;
      });
      commit();
    }, 240);
  }, []);
  const onDropTargetMove = useCallback((t: SfDropTarget | null) => setOutDrag(t), []);
  const hitTestCanvas = (x: number, y: number): SfDropTarget | null => {
    const rect = boardRef.current?.getBoundingClientRect();
    if (!rect || marquee) return null;
    for (const [id, el] of folderTileRefs.current) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return { kind: "folder", folderId: id };
    }
    if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) return null;
    return {
      kind: "canvas",
      cell: {
        x: Math.min(columns - 1, Math.max(0, Math.floor((x - rect.left) / (cellW + CELL_GAP)))),
        y: Math.max(0, Math.floor((y - rect.top) / (CELL_H + CELL_GAP)))
      }
    };
  };

  /** 内容区元素，用于测量列宽、OS 拖放命中。 */
  const boardRef = useRef<HTMLDivElement | null>(null);
  const [boardW, setBoardW] = useState(0);
  useEffect(() => {
    const el = boardRef.current;
    if (!el) return;
    const measure = () => setBoardW(el.clientWidth);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const cellW = boardW > 0 ? Math.max(40, (boardW - (columns - 1) * CELL_GAP) / columns) : 64;

  /** 渲染期布局：有存位用存位，缺位按顺序补第一个空格并**计入占用**——否则所有
      缺位条目独立算到同一个「第一个空格」，全部叠在一格（设置页新增 / 旧配置
      升级时 positions 为空表是常态）。只在内存累积，不回写配置。 */
  const layoutCells = useMemo(() => {
    const m = new Map<string, ShortcutCell>();
    for (const e of entries) {
      const c = positions[e.id] ?? nextFreeCell(m, columns);
      m.set(e.id, c);
    }
    return m;
  }, [entries, positions, columns]);

  /** 当前占用的最大行（拖动落格的纵向钳制：不许把图标拖出已用区域之外）。 */
  const maxRow = useMemo(() => {
    let mr = 0;
    for (const c of layoutCells.values()) mr = Math.max(mr, c.y);
    return mr;
  }, [layoutCells]);

  const addCustom = (items: CustomShortcut[], dropCell?: ShortcutCell) => {
    const list = loadCustomShortcuts(config);
    // 以完整布局为占用基线：新条目排在现有条目（含未存位的）之后，不与它们叠格。
    const taken = new Map(layoutCells);
    const nextPositions = { ...positions };
    let cursor = dropCell;
    for (const it of items) {
      const cell = nextFreeCell(taken, columns, cursor);
      taken.set(it.id, cell);
      nextPositions[it.id] = cell;
      cursor = cell.x + 1 < columns ? { x: cell.x + 1, y: cell.y } : { x: 0, y: cell.y + 1 };
    }
    update({ customShortcuts: [...list, ...items], positions: nextPositions });
  };

  /* ---- 自由拖动：pointer 捕获，位移 >4px 视为移动，松手吸附落格；
          落到已占用格 = 与占用者交换（互斥，拖动期 previewCells 实时预演）；
          落到文件夹磁贴 = 收进文件夹（拖动期被拖条目压在磁贴上预演）---- */
  const dragRef = useRef<{
    id: string;
    pointerId: number;
    startX: number;
    startY: number;
    origCell: ShortcutCell;
    moved: boolean;
  } | null>(null);
  /** 刚完成一次拖拽：随后的合成 click 不再触发打开（见 onItemUp）。 */
  const suppressClickRef = useRef(false);
  const [drag, setDrag] = useState<{ id: string; dx: number; dy: number; cell: ShortcutCell; moved: boolean } | null>(
    null
  );

  /** 拖动中的互斥预演：目标格已有条目时，把它实时挪到被拖条目的原格
      （两枚互换的落位在拖动期即可见，松手一次性落盘，见 onItemUp）。
      目标是文件夹磁贴时磁贴不动——被拖条目直接压上去，暗示"收进"。 */
  const previewCells = useMemo(() => {
    if (!drag || !drag.moved) return layoutCells;
    const origCell = layoutCells.get(drag.id);
    if (!origCell) return layoutCells;
    const occupant = [...layoutCells.entries()].find(
      ([id, c]) => id !== drag.id && c.x === drag.cell.x && c.y === drag.cell.y
    );
    if (!occupant) return layoutCells;
    const m = new Map(layoutCells);
    m.set(drag.id, drag.cell);
    if (entryById.get(occupant[0])?.kind !== "sfolder") m.set(occupant[0], origCell);
    return m;
  }, [drag, layoutCells, entryById]);

  const snapCell = (orig: ShortcutCell, dx: number, dy: number): ShortcutCell => {
    const stepX = cellW + CELL_GAP;
    const stepY = CELL_H + CELL_GAP;
    return {
      // 双向钳制：越出网格右缘 / 已用区域下缘的落点会把图标停在可视区外，抓不回来。
      x: Math.min(columns - 1, Math.max(0, Math.round((orig.x * stepX + dx) / stepX))),
      y: Math.min(maxRow, Math.max(0, Math.round((orig.y * stepY + dy) / stepY)))
    };
  };

  const onItemDown = (entry: ShortcutEntry, cell: ShortcutCell, e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || marquee) return;
    e.stopPropagation();
    dragRef.current = {
      id: entry.id,
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      origCell: cell,
      moved: false
    };
    e.currentTarget.setPointerCapture(e.pointerId);
    setDrag({ id: entry.id, dx: 0, dy: 0, cell, moved: false });
  };
  const onItemMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d || e.pointerId !== d.pointerId) return;
    const dx = e.clientX - d.startX;
    const dy = e.clientY - d.startY;
    if (!d.moved && Math.hypot(dx, dy) < 4) return;
    d.moved = true;
    setDrag({ id: d.id, dx, dy, cell: snapCell(d.origCell, dx, dy), moved: true });
  };
  const onItemUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d || e.pointerId !== d.pointerId) return;
    dragRef.current = null;
    const dx = e.clientX - d.startX;
    const dy = e.clientY - d.startY;
    const wasDrag = d.moved && Math.hypot(dx, dy) >= 4;
    setDrag(null);
    if (!wasDrag) return; // 纯点击：交给 onClick 打开
    // 指针捕获元素松手后浏览器会紧接着派发一次 click：拖拽后压住它，否则
    // 每次重排图标都会顺带打开对应文件/文件夹/链接。click 在同一任务内同步
    // 到达，宏任务里复位。
    suppressClickRef.current = true;
    window.setTimeout(() => {
      suppressClickRef.current = false;
    }, 0);
    const cell = snapCell(d.origCell, dx, dy);
    if (cell.x === d.origCell.x && cell.y === d.origCell.y) return;
    // 落到文件夹磁贴 = 收进文件夹（条目从网格消失；格位保留供移出还原）。
    const occupantId = [...layoutCells.entries()].find(
      ([id, c]) => id !== d.id && c.x === cell.x && c.y === cell.y
    )?.[0];
    if (occupantId && entryById.get(occupantId)?.kind === "sfolder" && entryById.get(d.id)?.kind === "custom") {
      if (moveIntoFolder(d.id, occupantId)) {
        const moved = customById.get(d.id);
        pushAppToast(tr("已移入文件夹"), moved?.label ?? "", "info", {
          action: { label: tr("撤销"), run: () => undoOp() }
        });
      }
      return;
    }
    // 互斥落格：目标格已有条目则与它交换（与拖动期 previewCells 预演一致），
    // 不再允许两枚图标叠在同一格。交换双方都显式写入 positions。
    const nextPositions = { ...positions, [d.id]: cell };
    if (occupantId) nextPositions[occupantId] = d.origCell;
    update({ positions: nextPositions });
  };

  const cellOf = (entry: ShortcutEntry): ShortcutCell => {
    const c = previewCells.get(entry.id);
    return c ?? nextFreeCell(previewCells, columns);
  };

  /* ---- OS 文件拖入：悬停高亮 + 落下自动识别入列。落点命中文件夹磁贴 =
          直接收进文件夹（BentoDesk per-zone drop hit-test）；其余落画布格位。 ---- */
  const [osHover, setOsHover] = useState(false);
  useOsFileDrop((ev) => {
    const rect = boardRef.current?.getBoundingClientRect();
    if (!rect || marquee) return;
    const inside = ev.x >= rect.left && ev.x <= rect.right && ev.y >= rect.top && ev.y <= rect.bottom;
    if (!inside) {
      setOsHover(false);
      setOsFolderHover(null);
      return;
    }
    if (ev.type === "drop") {
      setOsHover(false);
      const target = hitTestCanvas(ev.x, ev.y);
      setOsFolderHover(null);
      if (!isTauri() || ev.paths.length === 0) return;
      void Promise.all(
        ev.paths.map((path) =>
          // .lnk/.url 已由后端解析成目标路径（r.path）：桌面快捷方式被删后
          // 入口仍可用；目标是文件夹时 kind 归位 folder。
          invoke<{ label: string; kind: string; path?: string }>("classify_path", { path })
            .then((r): CustomShortcut | null => ({
              id: crypto.randomUUID(),
              label: r.label,
              path: r.path ?? path,
              kind: normalizeKind(r.kind, "file")
            }))
            .catch(() => null)
        )
      ).then((results) => {
        const items = results.filter((r): r is CustomShortcut => r !== null);
        if (items.length === 0) return;
        if (target?.kind === "folder") addCustomsToFolder(items, target.folderId);
        else addCustom(items, target?.kind === "canvas" ? target.cell : undefined);
      });
    } else {
      setOsHover(true);
      const hit = hitTestCanvas(ev.x, ev.y);
      setOsFolderHover(hit?.kind === "folder" ? hit.folderId : null);
    }
  });

  /** OS 拖放直接落进文件夹磁贴：新条目入列即入夹，画布已有条目原地移入
      （在其它文件夹里的先剔除旧归属）；整批合成一条撤销记录。 */
  const addCustomsToFolder = (items: CustomShortcut[], folderId: string) => {
    const cfg = loadWidgetConfig(instanceId);
    const curList = loadCustomShortcuts(cfg);
    const curFolders = loadShortcutFolders(cfg);
    const target = curFolders.find((f) => f.id === folderId);
    if (!target) return;
    const byNorm = new Map(curList.map((x) => [normShortcutPath(x.path), x]));
    const fresh: CustomShortcut[] = [];
    const movedIds: string[] = [];
    for (const it of items) {
      const exist = byNorm.get(normShortcutPath(it.path));
      if (exist) {
        if (!movedIds.includes(exist.id)) movedIds.push(exist.id);
      } else {
        fresh.push(it);
      }
    }
    const freshIds = fresh.map((it) => it.id);
    // 应用函数（redo 复用）：先剔除 movedIds 的旧归属，再并入目标文件夹。
    const applyFolders = (folders: ShortcutFolder[]): ShortcutFolder[] =>
      folders
        .map((f) => ({ ...f, childIds: f.childIds.filter((id) => !movedIds.includes(id)) }))
        .map((f) =>
          f.id === folderId ? { ...f, childIds: Array.from(new Set([...f.childIds, ...movedIds, ...freshIds])) } : f
        );
    const nextFolders = applyFolders(curFolders);
    if (fresh.length === 0 && JSON.stringify(nextFolders) === JSON.stringify(curFolders)) return;
    // 撤销要恢复的全部文件夹形状（目标 + 被剔除成员的原属文件夹）。
    const touched = new Set(curFolders.filter((f) => f.childIds.some((id) => movedIds.includes(id))).map((f) => f.id));
    touched.add(folderId);
    const prevShapes = curFolders.filter((f) => touched.has(f.id)).map((f) => ({ id: f.id, childIds: f.childIds }));
    update({
      customShortcuts: [...curList, ...fresh],
      shortcutFolders: nextFolders
    });
    pushOp({
      label: tr("移入文件夹"),
      undo: () => {
        const now = loadWidgetConfig(instanceId);
        const nowList = loadCustomShortcuts(now);
        const restored = foldersWithShapes(loadShortcutFolders(now), prevShapes);
        update({
          customShortcuts: nowList.filter((x) => !freshIds.includes(x.id)),
          shortcutFolders: restored
        });
      },
      redo: () => {
        const now = loadWidgetConfig(instanceId);
        const nowList = loadCustomShortcuts(now);
        const known = new Set(nowList.map((x) => x.id));
        update({
          customShortcuts: [...nowList, ...fresh.filter((x) => !known.has(x.id))],
          shortcutFolders: applyFolders(loadShortcutFolders(now))
        });
      }
    });
    pushAppToast(tr("已移入文件夹"), target.label, "info", {
      action: { label: tr("撤销"), run: () => undoOp() }
    });
  };

  const iconFor = (s: CustomShortcut) => {
    const real = icons[s.path];
    if (real) return <img src={real} alt="" draggable={false} />;
    if (s.kind === "url") return <Link2 size={26} />;
    if (s.kind === "folder") return <FolderOpen size={26} />;
    return <FileText size={26} />;
  };

  /** 文件夹磁贴图标：成员前 4 枚真实图标排 2×2 迷你网格（手机桌面同款）；
      空文件夹显示文件夹图标。成员图标与画布共享同一份缓存。 */
  const folderTileIcon = (folder: ShortcutFolder) => {
    const kids = folder.childIds
      .map((id) => customById.get(id))
      .filter((x): x is CustomShortcut => !!x)
      .slice(0, 4);
    if (kids.length === 0) return <FolderClosed size={26} />;
    return (
      <span className="widget-shortcut-folder-grid" aria-hidden="true">
        {kids.map((k) =>
          icons[k.path] ? (
            <img key={k.id} src={icons[k.path]} alt="" draggable={false} />
          ) : (
            <span key={k.id} className="widget-shortcut-folder-cell">
              {k.kind === "url" ? (
                <Link2 size={13} />
              ) : k.kind === "folder" ? (
                <FolderClosed size={13} />
              ) : (
                <FileText size={13} />
              )}
            </span>
          )
        )}
      </span>
    );
  };

  const entryIcon = (entry: ShortcutEntry) => {
    if (entry.kind === "builtin")
      return (
        <>
          {builtinIcon(entry.def.icon)}
          {badgeFor(entry.def)}
        </>
      );
    if (entry.kind === "custom") return iconFor(entry.item);
    return folderTileIcon(entry.folder);
  };

  /** 右键菜单（W-080）：自定义项免跳设置页直接编辑/删除；文件夹磁贴就地
      打开/重命名/移除；「移入文件夹」二级选择器完成手机桌面式收纳。 */
  const [menu, setMenu] = useState<MenuState>(null);
  /* #57 统一弹层退场：关闭后播 .is-closing（ctx-menu-out）再卸载，期间以最后
     一份菜单快照渲染——与 ContextMenu.tsx / FileBrowser 同语言。 */
  const menuVisible = useDelayedUnmount(!!menu, Math.round(animDurations().fxFastMs));
  const lastMenu = useRef(menu);
  if (menu) lastMenu.current = menu;
  const shownMenu = menu ?? lastMenu.current;
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("click", close);
    window.addEventListener("blur", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("blur", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [menu]);

  /** 条目右键 → 就地菜单（网格与滚动带共用；内置项无菜单，放行给卡片右键）。 */
  const openItemMenu = (
    e: {
      clientX: number;
      clientY: number;
      currentTarget: { getBoundingClientRect(): DOMRect };
      preventDefault(): void;
      stopPropagation(): void;
    },
    entry: ShortcutEntry
  ) => {
    if (!isTauri()) return;
    if (entry.kind === "sfolder") {
      e.preventDefault();
      e.stopPropagation();
      const rect = e.currentTarget.getBoundingClientRect();
      setMenu({
        kind: "folder",
        x: e.clientX,
        y: e.clientY,
        folder: entry.folder,
        anchor: { x: rect.x, y: rect.y, w: rect.width, h: rect.height }
      });
      return;
    }
    if (entry.kind !== "custom") return; // 内置项：放行给卡片右键菜单
    e.preventDefault();
    e.stopPropagation();
    setMenu({ kind: "item", x: e.clientX, y: e.clientY, item: entry.item });
  };

  const renameCustom = async (s: CustomShortcut) => {
    const label = await promptDialog({ title: tr("重命名快捷方式"), initialValue: s.label });
    const next = label?.trim();
    if (!next || next === s.label) return;
    update({
      customShortcuts: loadCustomShortcuts(loadWidgetConfig(instanceId)).map((x) =>
        x.id === s.id ? { ...x, label: next } : x
      )
    });
  };
  const removeCustom = async (s: CustomShortcut) => {
    if (
      !(await confirmDialog({
        title: tr("删除快捷方式"),
        message: `${tr("确定移除「")}${s.label}${tr("」吗？")}`,
        confirmLabel: tr("移除"),
        danger: true
      }))
    )
      return;
    // 磁贴先播退场动画，播完再落删（undo 记录在 commit 内按当时状态建）。
    beginTileExit([s.id], () => {
      const cfg = loadWidgetConfig(instanceId);
      const list = loadCustomShortcuts(cfg);
      const index = list.findIndex((x) => x.id === s.id);
      if (index < 0) return;
      const foldersCur = loadShortcutFolders(cfg);
      const hostIds = foldersCur.filter((f) => f.childIds.includes(s.id)).map((f) => f.id);
      const prevCell = loadShortcutPositions(cfg)[s.id];
      const foldersNext = pruneFolderChildren(foldersCur, new Set([s.id]));
      update({
        customShortcuts: list.filter((x) => x.id !== s.id),
        positions: Object.fromEntries(Object.entries(loadShortcutPositions(cfg)).filter(([id]) => id !== s.id)),
        ...(foldersNext !== foldersCur ? { shortcutFolders: foldersNext } : {})
      });
      pushOp({
        label: tr("移除快捷方式"),
        undo: () => {
          const now = loadWidgetConfig(instanceId);
          const nowList = loadCustomShortcuts(now);
          if (nowList.some((x) => x.id === s.id)) return;
          const at = Math.min(index, nowList.length);
          const restored: CustomShortcut = { id: s.id, label: s.label, path: s.path, kind: s.kind };
          const nowPos = { ...loadShortcutPositions(now) };
          if (prevCell) nowPos[s.id] = prevCell;
          update({
            customShortcuts: [...nowList.slice(0, at), restored, ...nowList.slice(at)],
            positions: nowPos,
            ...(hostIds.length > 0
              ? {
                  shortcutFolders: loadShortcutFolders(now).map((f) =>
                    hostIds.includes(f.id) && !f.childIds.includes(s.id) ? { ...f, childIds: [...f.childIds, s.id] } : f
                  )
                }
              : {})
          });
        },
        redo: () => {
          const now = loadWidgetConfig(instanceId);
          const nowFolders = pruneFolderChildren(loadShortcutFolders(now), new Set([s.id]));
          update({
            customShortcuts: loadCustomShortcuts(now).filter((x) => x.id !== s.id),
            positions: Object.fromEntries(Object.entries(loadShortcutPositions(now)).filter(([id]) => id !== s.id)),
            ...(nowFolders !== loadShortcutFolders(now) ? { shortcutFolders: nowFolders } : {})
          });
        }
      });
    });
  };
  /** 缺失条目重新定位：文件对话框选新目标，classify 重挂（id/格位/文件夹归属保留）。 */
  const relocateCustom = async (s: CustomShortcut) => {
    try {
      const path = await pickFilePath({ title: tr("重新定位") });
      if (!path) return;
      const r = await invoke<{ label: string; kind: string; path?: string | null }>("classify_path", { path });
      update({
        customShortcuts: loadCustomShortcuts(loadWidgetConfig(instanceId)).map((x) =>
          x.id === s.id
            ? { id: x.id, label: r.label || x.label, path: r.path ?? path, kind: normalizeKind(r.kind, x.kind) }
            : x
        )
      });
      pushAppToast(tr("已重新定位"), r.label || s.label, "ok");
    } catch {
      /* 用户取消或对话框不可用 */
    }
  };
  const copyCustomPath = async (s: CustomShortcut) => {
    try {
      await navigator.clipboard.writeText(s.path);
    } catch {
      void alertDialog({ title: tr("复制失败") });
    }
  };
  const revealCustom = (s: CustomShortcut) => {
    if (!isTauri() || s.kind === "url") return;
    void invoke("reveal_in_explorer", { path: s.path }).catch(() => {});
  };

  const badgeFor = (def: ShortcutDef) =>
    def.badge === "recycle" && binCount != null && binCount > 0 ? (
      <span className="widget-shortcut-badge">{binCount > 99 ? "99+" : binCount}</span>
    ) : undefined;

  const renderItem = (entry: ShortcutEntry) => {
    const isBuiltin = entry.kind === "builtin";
    const isFolder = entry.kind === "sfolder";
    const isMissing = entry.kind === "custom" && !!entry.item.missing;
    const dragging = drag && drag.id === entry.id && drag.moved ? drag : null;
    // 跟手关键：被拖条目的基准格始终是它的原格（previewCells 里它已映射到吸附
    // 目标格），指针位移全量交给 transform——否则基准 + 位移双重叠加会超前于指针。
    const cell = dragging ? (layoutCells.get(entry.id) ?? cellOf(entry)) : cellOf(entry);
    const stepX = cellW + CELL_GAP;
    const style: React.CSSProperties = {
      left: Math.round(cell.x * stepX),
      top: Math.round(cell.y * (CELL_H + CELL_GAP)),
      width: Math.round(cellW)
    };
    if (dragging) {
      style.transform = `translate(${dragging.dx}px, ${dragging.dy}px)`;
      style.zIndex = 2;
    }
    const folderHovered = osFolderHover === entry.id || (outDrag?.kind === "folder" && outDrag.folderId === entry.id);
    const activate = (rect: DOMRect) => {
      if (isBuiltin) openBuiltin(entry.id);
      else if (entry.kind === "custom") activateEntry(entry.item, rect);
      else if (isFolder) {
        if (sfOpenMode === "hover") {
          // 悬停模式：意图定时器已开则点击不再关闭（点选语义），未开立即开。
          cancelHoverIntent();
          cancelGraceClose();
          if (!sfPopup) openSfPopup(entry.folder, rect);
          return;
        }
        openSfPopup(entry.folder, rect);
      }
    };
    return (
      <div
        key={entry.id}
        ref={
          isFolder
            ? (el) => {
                const m = folderTileRefs.current;
                if (el) m.set(entry.id, el);
                else m.delete(entry.id);
              }
            : undefined
        }
        className={`widget-shortcut${dragging ? " is-dragging" : ""}${isMissing ? " is-missing" : ""}${
          folderHovered ? " os-folder-hover" : ""
        }${removingIds.has(entry.id) ? " is-closing" : ""}`}
        style={style}
        role="button"
        tabIndex={0}
        data-interactive
        aria-label={entry.label}
        onKeyDown={(e) => {
          if (e.key !== "Enter" && e.key !== " ") return;
          e.preventDefault();
          activate(e.currentTarget.getBoundingClientRect());
        }}
        onPointerDown={(e) => onItemDown(entry, cell, e)}
        onPointerMove={onItemMove}
        onPointerUp={onItemUp}
        onPointerCancel={() => {
          dragRef.current = null;
          setDrag(null);
        }}
        onPointerEnter={isFolder ? () => tilePointerEnter(entry.folder) : undefined}
        onPointerLeave={isFolder ? () => tilePointerLeave(entry.folder) : undefined}
        onClick={(e) => {
          if (suppressClickRef.current) return; // 拖拽重排后的合成 click，不是点击
          activate(e.currentTarget.getBoundingClientRect());
        }}
        onContextMenu={(e) => openItemMenu(e, entry)}
        title={
          isBuiltin
            ? entry.label
            : entry.kind === "custom"
              ? isMissing
                ? `${entry.item.path}（${tr("目标缺失")}）`
                : entry.item.path
              : entry.label
        }
      >
        <span className={`widget-shortcut-icon ${isBuiltin ? entry.def.icon : isFolder ? "sfolder" : "custom"}`}>
          {entryIcon(entry)}
          {isFolder && entry.folder.childIds.length > 0 && (
            <span className="widget-shortcut-count" aria-hidden="true">
              {entry.folder.childIds.length > 99 ? "99+" : entry.folder.childIds.length}
            </span>
          )}
          {isMissing && <span className="widget-shortcut-missing-dot" aria-hidden="true" title={tr("目标缺失")} />}
        </span>
        {showLabels && <span className="widget-shortcut-name">{entry.label}</span>}
      </div>
    );
  };

  return (
    <div className="widget-shortcuts">
      {showTitle && <div className={`widget-shortcuts-title${titleCompact ? " is-compact" : ""}`}>SHORTCUTS</div>}

      {marquee ? (
        <div className="sc-marquee">
          {/* 双份内容 + translateX(-50%) 无缝循环；第二份仅作视觉填充（aria-hidden
              不进无障碍树、不可聚焦），悬停暂停、单项浮起。滚动带保持扁平：
              全部自定义条目照常参与（含文件夹成员），文件夹磁贴不进带。 */}
          <div
            className="sc-marquee-track"
            style={{ "--dur": `${Math.max(18, flatEntries.length * 3.6)}s` } as React.CSSProperties}
          >
            {[0, 1].map((copy) =>
              flatEntries.map((entry, i) => {
                const clone = copy === 1;
                const isBuiltin = entry.kind === "builtin";
                const item = isBuiltin ? null : entry.kind === "custom" ? entry.item : null;
                const itemProps = clone
                  ? { "aria-hidden": true as const, tabIndex: -1 }
                  : {
                      role: "button" as const,
                      tabIndex: 0,
                      onKeyDown: (e: React.KeyboardEvent<HTMLDivElement>) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          if (isBuiltin) openBuiltin(entry.id);
                          else if (item) openCustom(item);
                        }
                      },
                      // 滚动带条目与网格条目同权：右键就地编辑/移除，不必回设置页。
                      onContextMenu: (e: React.MouseEvent<HTMLDivElement>) => openItemMenu(e, entry)
                    };
                return (
                  <div
                    className="sc-marquee-item"
                    key={`${copy}-${entry.id}-${i}`}
                    onClick={(e) => {
                      if (isBuiltin) openBuiltin(entry.id);
                      else if (item) activateEntry(item, e.currentTarget.getBoundingClientRect());
                    }}
                    title={isBuiltin ? entry.label : item?.path}
                    {...itemProps}
                    {...(clone ? {} : { "aria-label": entry.label })}
                  >
                    <span className={`widget-shortcut-icon ${isBuiltin ? entry.def.icon : "custom"}`}>
                      {isBuiltin ? builtinIcon(entry.def.icon) : item ? iconFor(item) : null}
                      {isBuiltin ? badgeFor(entry.def) : undefined}
                    </span>
                    {showLabels && <span className="widget-shortcut-name">{entry.label}</span>}
                  </div>
                );
              })
            )}
          </div>
        </div>
      ) : (
        <div
          ref={boardRef}
          className={`widget-shortcuts-board${osHover ? " os-hover" : ""}${drag ? " is-dragging" : ""}`}
          data-interactive
        >
          {entries.length === 0 && (
            <div className="widget-shortcuts-hint">
              <MousePointerClick size={20} />
              <span>{tr("把桌面上的文件或快捷方式拖进来")}</span>
              <span className="widget-shortcuts-hint-sub">{tr("松手自动识别，点击直接打开")}</span>
            </div>
          )}
          {drag && drag.moved && (
            <div
              className="widget-shortcut-placeholder"
              style={{
                left: Math.round(drag.cell.x * (cellW + CELL_GAP)),
                top: Math.round(drag.cell.y * (CELL_H + CELL_GAP)),
                width: Math.round(cellW),
                height: CELL_H
              }}
              aria-hidden="true"
            />
          )}
          {/* 弹层条目拖出到画布的落点预演（BentoDesk 投影落位）。 */}
          {outDrag?.kind === "canvas" && (
            <div
              className="widget-shortcut-placeholder"
              style={{
                left: Math.round(outDrag.cell.x * (cellW + CELL_GAP)),
                top: Math.round(outDrag.cell.y * (CELL_H + CELL_GAP)),
                width: Math.round(cellW),
                height: CELL_H
              }}
              aria-hidden="true"
            />
          )}
          {entries.map(renderItem)}
        </div>
      )}

      {/* 右键菜单必须 Portal 到 body：卡片壳层的 backdrop-filter 会成为 fixed
          后代的包含块，菜单留在卡片里会按卡片坐标系换算 clientX/Y 而跑偏被裁剪
          （用户右键"看不到菜单"）。Portal 后才是真视口坐标。 */}
      {menuVisible &&
        shownMenu &&
        createPortal(
          <div
            className={`widget-context-menu${menu ? "" : " is-closing"}`}
            style={{ left: shownMenu.x, top: shownMenu.y }}
            onClick={(e) => e.stopPropagation()}
            role="menu"
          >
            {shownMenu.kind === "item" && (
              <>
                <button
                  role="menuitem"
                  onClick={() => {
                    openCustom(shownMenu.item);
                    setMenu(null);
                  }}
                >
                  {tr("打开")}
                </button>
                {shownMenu.item.missing && (
                  <button
                    role="menuitem"
                    onClick={() => {
                      void relocateCustom(shownMenu.item);
                      setMenu(null);
                    }}
                  >
                    {tr("重新定位…")}
                  </button>
                )}
                {shownMenu.item.kind !== "url" && !shownMenu.item.missing && (
                  <button
                    role="menuitem"
                    onClick={() => {
                      revealCustom(shownMenu.item);
                      setMenu(null);
                    }}
                  >
                    <FolderOpen size={13} /> {tr("在资源管理器中显示")}
                  </button>
                )}
                <button
                  role="menuitem"
                  onClick={() => {
                    void copyCustomPath(shownMenu.item);
                    setMenu(null);
                  }}
                >
                  {tr("复制路径")}
                </button>
                <button
                  role="menuitem"
                  onClick={() => {
                    void renameCustom(shownMenu.item);
                    setMenu(null);
                  }}
                >
                  {tr("重命名")}
                </button>
                <button
                  role="menuitem"
                  onClick={() => {
                    setMenu({ kind: "move", x: shownMenu.x, y: shownMenu.y, item: shownMenu.item });
                  }}
                >
                  <FolderClosed size={13} /> {tr("移入文件夹")}
                </button>
                <button
                  role="menuitem"
                  className="danger"
                  onClick={() => {
                    void removeCustom(shownMenu.item);
                    setMenu(null);
                  }}
                >
                  <Trash2 size={13} /> {tr("移除")}
                </button>
              </>
            )}
            {shownMenu.kind === "move" && (
              <>
                <button
                  role="menuitem"
                  onClick={() => {
                    createFolderWith(shownMenu.item.id);
                    setMenu(null);
                  }}
                >
                  <FolderPlus size={13} /> {tr("新建文件夹")}
                </button>
                {folders.map((f) => (
                  <button
                    key={f.id}
                    role="menuitem"
                    onClick={() => {
                      if (moveIntoFolder(shownMenu.item.id, f.id)) {
                        pushAppToast(tr("已移入文件夹"), shownMenu.item.label, "info", {
                          action: { label: tr("撤销"), run: () => undoOp() }
                        });
                      }
                      setMenu(null);
                    }}
                  >
                    <FolderClosed size={13} /> {f.label}
                  </button>
                ))}
              </>
            )}
            {shownMenu.kind === "folder" && (
              <>
                <button
                  role="menuitem"
                  onClick={() => {
                    setSfPopup({ folderId: shownMenu.folder.id, anchor: shownMenu.anchor });
                    setMenu(null);
                  }}
                >
                  {tr("打开")}
                </button>
                <button
                  role="menuitem"
                  onClick={() => {
                    void renameFolder(shownMenu.folder);
                    setMenu(null);
                  }}
                >
                  {tr("重命名")}
                </button>
                <button
                  role="menuitem"
                  className="danger"
                  onClick={() => {
                    void removeFolder(shownMenu.folder);
                    setMenu(null);
                  }}
                >
                  <Trash2 size={13} /> {tr("移除文件夹")}
                </button>
              </>
            )}
          </div>,
          document.body
        )}

      {/* key 用初始目录：换目录预览时重挂载，旧实例的关闭计时器随卸载清除。 */}
      {folderPopup && (
        <FolderPopup
          key={folderPopup.path}
          path={folderPopup.path}
          anchor={folderPopup.anchor}
          onClose={() => setFolderPopup(null)}
        />
      )}

      {/* 快捷方式文件夹弹层：文件夹被移除后 sfFolder 落空即随之消失。 */}
      {sfFolder && sfPopup && (
        <ShortcutFolderPopup
          key={sfFolder.id}
          folder={sfFolder}
          items={sfFolder.childIds.flatMap((id) => {
            const item = customById.get(id);
            return item ? [item] : [];
          })}
          anchor={sfPopup.anchor}
          icons={icons}
          openMode={sfOpenMode}
          sort={sfFolder.sort ?? "free"}
          onSortChange={(mode) => setFolderSort(sfFolder.id, mode)}
          onClose={() => setSfPopup(null)}
          onOpenItem={openCustom}
          onMoveOut={(item) => {
            if (moveOutOfFolder(sfFolder.id, item)) {
              pushAppToast(tr("已移出文件夹"), item.label, "info", {
                action: { label: tr("撤销"), run: () => undoOp() }
              });
            }
          }}
          onRemoveItem={(item) => void removeCustom(item)}
          onRevealItem={revealCustom}
          onCopyItemPath={(item) => void copyCustomPath(item)}
          onRenameItem={(item) => void renameCustom(item)}
          onRelocateItem={(item) => void relocateCustom(item)}
          onReorder={(childIds) => reorderFolderChildren(sfFolder.id, childIds)}
          onDropOutside={(item, target) => dropOutsideFolder(sfFolder, item, target)}
          onDropTargetMove={onDropTargetMove}
          hitTestOutside={hitTestCanvas}
          onHoverEnter={cancelGraceClose}
          onHoverLeave={scheduleGraceClose}
        />
      )}
    </div>
  );
}
