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
 *   条目按 columns 自动落到第一个空格。
 * - 快捷方式文件夹（类手机桌面）：config.shortcutFolders 聚合若干自定义
 *   条目成一枚可展开磁贴（2×2 迷你图标 + 成员数角标），单击弹条目网格；
 *   把条目拖到文件夹磁贴上、或右键「移入文件夹」即可收进（格位保留，移出
 *   优先回原格）。弹层：WAAPI FLIP 从磁贴矩形连续变形、
 *   展开锁防双击误关、内联搜索过滤、条目可拖拽重排 / 拖出到画布或其它
 *   文件夹；打开方式可选 悬停 / 单击 / 钉住（config.sfolderOpenMode）。
 * - 条目健康：失效引用只标缺失不删除，60s 复检
 *   自动治愈；Rust watch（shortcuts-watch:change）实时感知目标改名（classify
 *   重挂）/ 删除（标缺失）/ 内容变更（图标缓存失效重提取）。
 * - 文件夹操作入命令级撤销栈，
 *   Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y 全局生效，即时操作附「撤销」toast。
 * - 条目右键菜单走统一 openContextMenu（ContextMenuHost）：视口钳制 +
 *   键盘导航 + 统一退场；卡片壳层带 backdrop-filter 会成为 fixed 后代的
 *   包含块，留在卡片内会按卡片坐标系换算 clientX/Y 整体跑偏被裁剪。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { uiZoom } from "../../lib/ui-zoom";
import { useT } from "../../i18n-lite";
import { useWidgetConfig } from "../widget-config";
import {
  loadCustomShortcuts,
  loadShortcutFolders,
  loadShortcutPositions,
  nextFreeCell,
  applyResolvedTargets,
  mergeWatchRows,
  folderMemberIds,
  isLinkFileEntry,
  markEntriesMissing,
  normShortcutPath,
  pruneFolderChildren,
  sortFolderItems,
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
import { openContextMenu } from "../../components/ContextMenu";
import { copyText } from "../../lib/clipboard";
import { cachedAppIcon, storeAppIcon, dropAppIcons } from "../../lib/app-icon-cache";
import { loadWidgetConfig } from "../widget-config";
import { FolderPopup } from "./FolderPopup";
import { ShortcutFolderPopup } from "./ShortcutFolderPopup";
import { useTauriEvent } from "../../lib/use-tauri-event";
import { pushAppToast } from "../../components/ToastHost";
import { sourceNotify } from "../../lib/notifications";
import type { PopoverAnchor } from "../WidgetConfigPopover";
import type { PointerEvent as ReactPointerEvent } from "react";

/** 条目 gBCR（视觉坐标）→ 弹层锚点（布局单位）：文件夹弹层两侧消费端
 *  （FolderPopup.place 与 ShortcutFolderPopup 的 place/FLIP）都用 offsetWidth /
 *  innerWidth 等布局值参与运算，锚点必须先除回 uiZoom，缩放 ≠100% 时
 *  弹层定位与 FLIP 变换才不漂移。 */
function sfAnchorFromRect(rect: DOMRect): PopoverAnchor {
  const z = uiZoom();
  return { x: rect.x / z, y: rect.y / z, w: rect.width / z, h: rect.height / z };
}

type ShortcutDef = {
  id: string;
  label: string;
  icon: "recycle" | "pc" | "folder";
  /** shell: 位置（回收站角标只对 recycle 生效）。 */
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

/** 内置位置全集：与 Rust SYSTEM_LOCATIONS 的 8 个 shell: 位置一一对应。 */
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
  /* （重渲纪律，同 GroupCard）：loadCustomShortcuts/loadShortcutPositions
     每次调用都返回新引用（filter/重建对象），不 memo 会让 customById →
     folders → memberIds → entries → layoutCells 整条派生链在每次渲染
     （拖拽期每个 pointermove）全量重算。config 引用在两次写入间稳定，
     以它为 memo 键即可。 */
  const custom = useMemo(() => loadCustomShortcuts(config), [config]);
  // 内置位置默认不带（要的是拖入的真实快捷方式，不是预置的通用图标）。
  // useMemo 稳定引用：entries 的 useMemo 依赖它，避免每渲染重算。
  const builtin = useMemo(
    () =>
      Array.isArray(config.builtinShortcuts)
        ? (config.builtinShortcuts as string[]).filter((id) => ALL_BUILTIN.some((b) => b.id === id))
        : [],
    [config.builtinShortcuts]
  );
  const positions = useMemo(() => loadShortcutPositions(config), [config]);
  const foldersRaw = useMemo(() => loadShortcutFolders(config), [config]);
  const customById = useMemo(() => new Map(custom.map((s) => [s.id, s])), [custom]);
  /** 悬挂引用防御：设置页删除条目不感知文件夹，渲染期把 childIds 过滤到现存条目。 */
  const folders = useMemo(
    () => foldersRaw.map((f) => ({ ...f, childIds: f.childIds.filter((id) => customById.has(id)) })),
    [foldersRaw, customById]
  );
  const memberIds = useMemo(() => folderMemberIds(folders), [folders]);

  /** path → data:image/png;base64 的真实图标缓存（本次挂载内）。iconVersion
      供 watch 的内容变更事件触发重提取。图标共三层：本实例 state（最快）、
      模块级共享缓存（lib/app-icon-cache，同窗口组件复用，免重复 IPC）、
      Rust 磁盘缓存（files.rs icon_cached，版本化键 + LRU，watch 联动失效，
      跨窗口共享提取结果）。 */
  const [icons, setIcons] = useState<Record<string, string>>({});
  const [iconVersion, setIconVersion] = useState(0);
  useEffect(() => {
    if (!isTauri()) return;
    let cancelled = false;
    /* 模块级共享缓存（app-icon-cache）先行：FolderPopup 等其它组件已提取过
       的路径直接复用，不再发 IPC。 */
    const seeded: Record<string, string> = {};
    for (const s of custom) {
      if (s.kind === "url" || icons[s.path]) continue;
      const hit = cachedAppIcon(s.path);
      if (hit) seeded[s.path] = hit;
    }
    if (Object.keys(seeded).length > 0) setIcons((prev) => ({ ...prev, ...seeded }));
    const pending = custom.filter((s) => s.kind !== "url" && !icons[s.path] && !seeded[s.path]);
    if (pending.length === 0) return;
    // （图标并发无上限）：此前一次性 Promise.all 打满 blocking 池（弹层开
    // 大目录时其它 spawn_blocking 命令全被图标提取挤住）。分批限并发 4，
    // 与 FileBrowser 预览加载同款。
    const CONC = 4;
    const next: Record<string, string> = {};
    let idx = 0;
    const worker = async (): Promise<void> => {
      while (idx < pending.length && !cancelled) {
        const s = pending[idx++];
        try {
          const b64 = await invoke<string | null>("get_app_icon", { path: s.path });
          if (b64) {
            const url = `data:image/png;base64,${b64}`;
            next[s.path] = url;
            storeAppIcon(s.path, url);
          }
        } catch {
          // 单个失败不影响其余
        }
      }
    };
    void Promise.all(Array.from({ length: Math.min(CONC, pending.length) }, worker)).then(() => {
      if (cancelled) return;
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

  /** 系统回收站真实角标：低频轮询 $Recycle.Bin 条目数。只在回收站
      磁贴实际展示时轮询——没勾选内置位置时是纯无效 IPC（Rust 侧虽有 30s
      TTL 缓存兜底，不必白养定时器）。 */
  const [binCount, setBinCount] = useState<number | null>(null);
  const binActive = builtin.includes("recycle");
  useEffect(() => {
    if (!isTauri() || !binActive) return;
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
  }, [binActive]);

  const openCustom = (s: CustomShortcut) => {
    if (!isTauri()) return;
    if (s.missing) {
      pushAppToast(tr("目标缺失"), s.label, "error");
      return;
    }
    // 打开失败（无关联程序 / 目标在复检间隙被删等）不再静默：missing 态有
    // toast，这里失败同样给出反馈，用户不用猜「点了没反应」的原因。
    void invoke("open_path", { path: s.path }).catch(() => {
      pushAppToast(tr("打开失败"), s.label, "error");
    });
  };

  /* ---- 目录监视自动整理。配置变化 → Rust 按实例整替
          watcher（哈希未变不拆建）；新文件命中规则 → auto-organize:add 事件
          → 与手动拖入同一条 classify 入列路径，按 path 去重。
          notify 开启时命中额外发
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
  /* 卸载归还（与 apply_shortcut_watch 同款）：Rust 侧按实例 upsert，watchPath
     空串 = 移除该实例的监视。此前没有归还——删除/切换视图后开了自动整理的
     组件在 Rust 侧继续监视目录直到进程退出（watcher + 接收线程白养）。 */
  useEffect(
    () => () => {
      if (!isTauri()) return;
      void invoke("apply_auto_organize", {
        configs: [
          {
            instanceId,
            watchPath: "",
            extensions: [],
            nameTokens: [],
            extEnabled: true,
            nameEnabled: false,
            notify: false,
            olderThanDays: 0,
            olderBy: "modified",
            minSizeMb: 0
          }
        ]
      }).catch(() => {});
    },
    [instanceId]
  );

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
      // 通知动作：走通知中心来源门控（sourceNotify 内部处理留档）。
      if (p.notify) {
        const name = p.path.split(/[\\/]/).pop() ?? p.path;
        sourceNotify("app", tr("新文件已自动整理"), `${name}${p.watchPath ? ` · ${p.watchPath}` : ""}`);
      }
      addPathsFromOrganizer([p.path]);
    }
  );

  /* ---- 同类桌面整理工具 file_missing 语义：失效引用只标缺失不删除——移动盘未接、
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

  /* ---- 引用侧：目标文件改名 / 删除 / 内容变更实时感知。
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
  /* （先拆后建抖动）：Rust 侧 apply_shortcut_watch 按实例整表 upsert——
     新表直接替换旧表，sig 变化时无需先发空表。旧实现的 cleanup 挂在 sig
     effect 里，每次路径变化都「拆掉全部 watcher → 重建」，双倍拆建且两次
     IPC 之间存在无监视空窗（漏事件）。归还监听只在真正卸载时发。 */
  useEffect(
    () => () => {
      if (!isTauri()) return;
      void invoke("apply_shortcut_watch", { configs: [{ instanceId, paths: [] }] }).catch(() => {});
    },
    [instanceId]
  );

  /* （customShortcuts 读改写互踩）：watch 处理含多个 await（classify/存在
   * 性核实），读-改-写窗口内并发的拖入/迁移/undo 会被基于旧基线的整表覆写
   * 丢掉。按实例串行化 watch 处理（promise 链互斥）。 */
  const watchChainRef = useRef<Promise<void>>(Promise.resolve());
  const handleWatchChanges = async (changes: WatchChange[]) => {
    const run = async () => {
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

      // 提交前重读权威副本做行级合并：等待期间其他路径（拖入/undo）新增的
      // 行不丢；本批没有实际改动时也不发起空写。
      const latest = loadCustomShortcuts(loadWidgetConfig(instanceId));
      if (latest !== cur) {
        // mergeWatchRows（引用级行比较）：此前这里用 join("|") 比较，对象串成
        // "[object Object]"，并发写窗口内的改名/标缺失会被静默丢弃——恰好是
        // 这个合并块要保护的竞态场景。
        const merged = mergeWatchRows(latest, next);
        if (merged) update({ customShortcuts: merged });
      } else if (next !== cur) {
        update({ customShortcuts: next });
      }

      // 内容变更：图标已过期——弃缓存并触发重提取。
      const modified = new Set(
        changes.filter((c) => c.type === "modified" && c.path).map((c) => normShortcutPath(c.path!))
      );
      if (modified.size > 0) {
        setIcons((prev) =>
          Object.fromEntries(Object.entries(prev).filter(([k]) => !modified.has(normShortcutPath(k))))
        );
        // 模块级共享缓存同步失效：否则重提取会被旧值命中，图标永远不换新。
        dropAppIcons(modified);
        setIconVersion((v) => v + 1);
      }
    };
    watchChainRef.current = watchChainRef.current.then(run, run);
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

  /* ---- 文件夹预览小窗：真实文件夹条目单击弹就地图标
          网格，再点同一条 = 关闭（toggle）；folderPreview 关闭时维持原行为
          直接开资源管理器。右键菜单「打开」不受影响，始终直达资源管理器。 ---- */
  const folderPreview = config.folderPreview !== false;
  const [folderPopup, setFolderPopup] = useState<{ path: string; anchor: PopoverAnchor } | null>(null);
  const activateEntry = (s: CustomShortcut, rect: DOMRect) => {
    if (folderPreview && s.kind === "folder" && isTauri()) {
      const anchor = sfAnchorFromRect(rect);
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

  /* ---- 文件夹磁贴 → 条目网格弹层。打开方式：
          click 单击 toggle（默认）；hover 悬停意图 90ms 展开、离开 200ms
          宽限收回（重进取消）；pin 钉住（外点不关）。 ---- */
  const [sfPopup, setSfPopup] = useState<{ folderId: string; anchor: PopoverAnchor } | null>(null);
  const sfOpenMode: SfOpenMode =
    config.sfolderOpenMode === "hover" || config.sfolderOpenMode === "pin"
      ? (config.sfolderOpenMode as SfOpenMode)
      : "click";
  const openSfPopup = (folder: ShortcutFolder, rect: DOMRect) => {
    const anchor = sfAnchorFromRect(rect);
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
  /** 待提交的退场批次：240ms 内连续两次删除时，后一次调用会重置计时器——
      commit 若只挂在 timer 上，前一批的删除会被静默丢弃（确认了却复活）。
      批次排队，计时器到点统一清状态并依次提交。 */
  const pendingExitsRef = useRef<Array<{ ids: string[]; commit: () => void }>>([]);
  const beginTileExit = useCallback((ids: string[], commit: () => void) => {
    pendingExitsRef.current.push({ ids: [...ids], commit });
    setRemovingIds((prev) => {
      const next = new Set(prev);
      for (const id of ids) next.add(id);
      return next;
    });
    window.clearTimeout(removingTimerRef.current);
    removingTimerRef.current = window.setTimeout(() => {
      const batch = pendingExitsRef.current;
      pendingExitsRef.current = [];
      setRemovingIds((prev) => {
        const next = new Set(prev);
        for (const b of batch) for (const id of b.ids) next.delete(id);
        return next;
      });
      for (const b of batch) b.commit();
    }, 240);
  }, []);
  const onDropTargetMove = useCallback((t: SfDropTarget | null) => setOutDrag(t), []);
  const hitTestCanvas = (x: number, y: number): SfDropTarget | null => {
    const rect = boardRef.current?.getBoundingClientRect();
    if (!rect) return null;
    for (const [id, el] of folderTileRefs.current) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return { kind: "folder", folderId: id };
    }
    if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) return null;
    /* x/y 是 gBCR 视觉坐标，cellW/CELL_H/CELL_GAP 是布局单位——先除回
       uiZoom 再算格位，否则缩放 ≠100% 时 OS 拖放与文件夹拖出整体偏移。 */
    const z = uiZoom();
    const lx = (x - rect.left) / z;
    const ly = (y - rect.top) / z;
    return {
      kind: "canvas",
      cell: {
        x: Math.min(columns - 1, Math.max(0, Math.floor(lx / (cellW + CELL_GAP)))),
        y: Math.max(0, Math.floor(ly / (CELL_H + CELL_GAP)))
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

  /** 渲染期布局，两阶段分配：先让有存位的条目落存位并**计入占用**，缺位条目
      再按顺序补第一个空格——单遍分配时内置位置（永远缺位，设置页勾选只写
      builtinShortcuts）先分到第一个空格，后面有存位的条目不查冲突直接落存位，
      第一枚图标（存位即首格）就与它叠在同一格。只在内存累积，不回写配置。 */
  const layoutCells = useMemo(() => {
    const m = new Map<string, ShortcutCell>();
    const occupied = new Set<string>();
    for (const e of entries) {
      const c = positions[e.id];
      if (!c) continue;
      // （columns 缩小格位越界）：列数调小后，存量存位 x ≥ columns 按新列宽
      // 渲染会排到画布右缘外抓不回来——视同缺位，第二遍归位到空格。
      if (c.x >= columns) continue;
      // 同格撞车的存位（撤销恢复旧格等路径可能产生）后者降级到第二遍。
      const key = `${c.x}:${c.y}`;
      if (occupied.has(key)) continue;
      occupied.add(key);
      m.set(e.id, c);
    }
    for (const e of entries) {
      if (m.has(e.id)) continue;
      m.set(e.id, nextFreeCell(m, columns));
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
    // 写前现读权威副本：drop 的 classify 是异步的，回来后渲染闭包里的
    // config/positions 可能已落后（watch 标缺失、并发的其它写入），
    // 拿旧闭包当基底会覆盖丢失——与组件其它写路径同一模式。
    const cfg = loadWidgetConfig(instanceId);
    const list = loadCustomShortcuts(cfg);
    // （画布直拖不去重）：拖进文件夹的路径有 byNorm 去重，画布直落没有
    // ——同一文件拖两次出两条。同款归一比对：已存在的跳过（位置不动）。
    const byNorm = new Map(list.map((s) => [normShortcutPath(s.path), s]));
    const fresh = items.filter((it) => !byNorm.has(normShortcutPath(it.path)));
    if (fresh.length === 0) return;
    // 以完整布局为占用基线：新条目排在现有条目（含未存位的）之后，不与它们叠格。
    const taken = new Map(layoutCells);
    const nextPositions = { ...loadShortcutPositions(cfg) };
    let cursor = dropCell;
    for (const it of fresh) {
      const cell = nextFreeCell(taken, columns, cursor);
      taken.set(it.id, cell);
      nextPositions[it.id] = cell;
      cursor = cell.x + 1 < columns ? { x: cell.x + 1, y: cell.y } : { x: 0, y: cell.y + 1 };
    }
    update({ customShortcuts: [...list, ...fresh], positions: nextPositions });
    /* 拖入新增入撤销栈（undo = 撤条目与格位，redo 原样补回）：行级按 id
       增删，与后续并发的其他改动天然可组合；redo 的格位若已被后来者占用，
       由 layoutCells 撞车降级在渲染期化解。 */
    const freshIds = new Set(fresh.map((it) => it.id));
    pushOp({
      label: tr("添加快捷方式"),
      undo: () => {
        const now = loadWidgetConfig(instanceId);
        const nowPos = loadShortcutPositions(now);
        update({
          customShortcuts: loadCustomShortcuts(now).filter((x) => !freshIds.has(x.id)),
          positions: Object.fromEntries(Object.entries(nowPos).filter(([id]) => !freshIds.has(id)))
        });
      },
      redo: () => {
        const now = loadWidgetConfig(instanceId);
        const known = new Set(loadCustomShortcuts(now).map((x) => x.id));
        const add = fresh.filter((x) => !known.has(x.id));
        update({
          customShortcuts: [...loadCustomShortcuts(now), ...add],
          positions: {
            ...loadShortcutPositions(now),
            ...Object.fromEntries(add.map((it) => [it.id, nextPositions[it.id]]))
          }
        });
      }
    });
  };

  /* ---- 自由拖动：pointer 捕获，位移 >4px 视为移动，松手吸附落格；
          落到已占用格 = 与占用者交换（互斥，拖动期 previewCells 实时预演）；
          落到文件夹磁贴 = 收进文件夹（拖动期被拖条目压在磁贴上预演）。
          二.4 rAF 合帧 + CSS 变量直写（GroupCard 同范式）：逐帧像素位移写
          --drag-dx/--drag-dy（合成器 transform，不重渲整树），setState 只在
          「过阈值起拖 / 吸附目标格变化」这两个结构性时刻发生（预演交换与
          占位框跟着走）。 ---- */
  const dragRef = useRef<{
    id: string;
    pointerId: number;
    startX: number;
    startY: number;
    origCell: ShortcutCell;
    moved: boolean;
    /** 最新位移（rAF 回调与松手共用，避免依赖 React 状态时序）。 */
    dx: number;
    dy: number;
    /** 上次发布的吸附格（格没变就不重渲）。 */
    lastCell: ShortcutCell;
    /** 被拖条目元素（CSS 变量直写的落点）。 */
    el: HTMLDivElement;
  } | null>(null);
  const dragRafRef = useRef(0);
  const clearDragVars = (el: HTMLElement | null) => {
    if (!el) return;
    el.style.removeProperty("--drag-dx");
    el.style.removeProperty("--drag-dy");
  };
  /** 刚完成一次拖拽：随后的合成 click 不再触发打开（见 onItemUp）。 */
  const suppressClickRef = useRef(false);
  const [drag, setDrag] = useState<{ id: string; dx: number; dy: number; cell: ShortcutCell; moved: boolean } | null>(
    null
  );
  /* 卸载兜底：在途拖拽会话的 rAF 与元素变量不能带到下一次挂载。 */
  useEffect(
    () => () => {
      if (dragRafRef.current) window.cancelAnimationFrame(dragRafRef.current);
      clearDragVars(dragRef.current?.el ?? null);
    },
    []
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
    if (e.button !== 0) return;
    e.stopPropagation();
    dragRef.current = {
      id: entry.id,
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      origCell: cell,
      moved: false,
      dx: 0,
      dy: 0,
      lastCell: cell,
      el: e.currentTarget
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
    const firstMove = !d.moved;
    d.moved = true;
    d.dx = dx;
    d.dy = dy;
    const cell = snapCell(d.origCell, dx, dy);
    const cellChanged = cell.x !== d.lastCell.x || cell.y !== d.lastCell.y;
    // 结构性时刻才 setState（起拖亮态 / 吸附格变化驱动预演与占位框）；
    // 逐帧位移由 rAF 写 CSS 变量承担，不再每个 pointermove 重渲整树。
    if (firstMove || cellChanged) {
      d.lastCell = cell;
      setDrag({ id: d.id, dx, dy, cell, moved: true });
    }
    if (dragRafRef.current) return;
    dragRafRef.current = window.requestAnimationFrame(() => {
      dragRafRef.current = 0;
      const cur = dragRef.current;
      if (!cur || !cur.moved) return;
      cur.el.style.setProperty("--drag-dx", `${cur.dx}px`);
      cur.el.style.setProperty("--drag-dy", `${cur.dy}px`);
    });
  };
  const onItemUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d || e.pointerId !== d.pointerId) return;
    dragRef.current = null;
    if (dragRafRef.current) {
      window.cancelAnimationFrame(dragRafRef.current);
      dragRafRef.current = 0;
    }
    clearDragVars(d.el);
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
    /* 格位调整入撤销栈（补齐与文件夹操作的一致性）：undo/redo 现读权威
       positions 后只改本组 id，其余条目的后续移动不受影响；冲突格由
       layoutCells 的撞车降级在渲染期自然化解。 */
    pushOp({
      label: tr("调整位置"),
      undo: () => {
        const nowPos = { ...loadShortcutPositions(loadWidgetConfig(instanceId)) };
        nowPos[d.id] = d.origCell;
        if (occupantId) nowPos[occupantId] = cell;
        update({ positions: nowPos });
      },
      redo: () => {
        const nowPos = { ...loadShortcutPositions(loadWidgetConfig(instanceId)) };
        nowPos[d.id] = cell;
        if (occupantId) nowPos[occupantId] = d.origCell;
        update({ positions: nowPos });
      }
    });
  };

  const cellOf = (entry: ShortcutEntry): ShortcutCell => {
    const c = previewCells.get(entry.id);
    return c ?? nextFreeCell(previewCells, columns);
  };

  /* ---- OS 文件拖入：悬停高亮 + 落下自动识别入列。落点命中文件夹磁贴 =
          直接收进文件夹；其余落画布格位。 ---- */
  const [osHover, setOsHover] = useState(false);
  useOsFileDrop((ev) => {
    // 拖拽离开窗口（不投放）：清掉高亮，防滞留（leave 此前被钩子吞掉）。
    if (ev.type === "leave") {
      setOsHover(false);
      setOsFolderHover(null);
      return;
    }
    const rect = boardRef.current?.getBoundingClientRect();
    if (!rect) return;
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

  /** 磁贴缩略图随 folder.sort：name 纯排序无 IO；time 需要目标 mtime——对
      time 排序的文件夹按成员签名批量拉一次（paths_mtimes，与弹层排序同一
      命令），此前磁贴恒为 free 序、弹层内却是排序后的，视觉不一致。 */
  const [tileMtimes, setTileMtimes] = useState<Record<string, number>>({});
  const timeFolders = useMemo(() => folders.filter((f) => f.sort === "time"), [folders]);
  const tileMtimeSig = timeFolders.map((f) => `${f.id}:${f.childIds.join("\u{1}")}`).join("\u{2}");
  useEffect(() => {
    if (!isTauri() || timeFolders.length === 0) return;
    const paths = [
      ...new Set(
        timeFolders.flatMap((f) => f.childIds.map((id) => customById.get(id)?.path).filter((p): p is string => !!p))
      )
    ];
    if (paths.length === 0) return;
    let cancelled = false;
    void invoke<number[]>("paths_mtimes", { paths })
      .then((arr) => {
        if (cancelled || !Array.isArray(arr)) return;
        setTileMtimes(Object.fromEntries(paths.map((p, i) => [p, arr[i] ?? 0])));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
    // 签名驱动：成员增删/换序才重拉；mtime 变化不追（磁贴预览容忍陈旧序）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tileMtimeSig]);

  /** 文件夹磁贴图标：按 folder.sort 排序后的前 4 枚真实图标排 2×2 迷你网格
      （手机桌面同款，与弹层内展示序一致）；空文件夹显示文件夹图标。成员图标
      与画布共享同一份缓存。 */
  const folderTileIcon = (folder: ShortcutFolder) => {
    const kids = sortFolderItems(
      folder.childIds.map((id) => customById.get(id)).filter((x): x is CustomShortcut => !!x),
      folder.sort ?? "free",
      (it) => tileMtimes[it.path] ?? 0
    ).slice(0, 4);
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

  /** 右键菜单：统一走 openContextMenu（ContextMenuHost 渲染）——
      自带视口钳制、键盘导航与统一退场，取代此前的私有 .widget-context-menu
      （无钳制：屏幕右/下缘右键菜单会被窗口裁掉；也无键盘导航）。自定义项免
      跳设置页直接编辑/删除；文件夹磁贴就地打开/重命名/移除；「移入文件夹」
      二级选择器完成手机桌面式收纳。 */
  const openMoveMenu = (item: CustomShortcut, x: number, y: number) => {
    openContextMenu(
      // 二级菜单沿一级菜单的原位展开（合成事件对象：菜单项 onSelect 里没有
      // 原生事件可用）。
      { clientX: x, clientY: y, preventDefault() {}, stopPropagation() {} },
      [
        { label: tr("新建文件夹"), icon: <FolderPlus size={15} />, onSelect: () => createFolderWith(item.id) },
        ...folders.map((f) => ({
          label: f.label,
          icon: <FolderClosed size={15} />,
          onSelect: () => {
            if (moveIntoFolder(item.id, f.id)) {
              pushAppToast(tr("已移入文件夹"), item.label, "info", {
                action: { label: tr("撤销"), run: () => undoOp() }
              });
            }
          }
        }))
      ]
    );
  };
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
      const rect = e.currentTarget.getBoundingClientRect();
      const anchor = sfAnchorFromRect(rect);
      openContextMenu(e, [
        {
          label: tr("打开"),
          onSelect: () => setSfPopup({ folderId: entry.folder.id, anchor })
        },
        { label: tr("重命名"), onSelect: () => void renameFolder(entry.folder) },
        {
          label: tr("移除文件夹"),
          icon: <Trash2 size={15} />,
          danger: true,
          onSelect: () => void removeFolder(entry.folder)
        }
      ]);
      return;
    }
    if (entry.kind !== "custom") return; // 内置项：放行给卡片右键菜单
    const item = entry.item;
    openContextMenu(e, [
      { label: tr("打开"), onSelect: () => openCustom(item) },
      ...(item.missing ? [{ label: tr("重新定位…"), onSelect: () => void relocateCustom(item) }] : []),
      ...(item.kind !== "url" && !item.missing
        ? [
            {
              label: tr("在资源管理器中显示"),
              icon: <FolderOpen size={15} />,
              onSelect: () => revealCustom(item)
            }
          ]
        : []),
      { label: tr("复制路径"), onSelect: () => void copyCustomPath(item) },
      { label: tr("重命名"), onSelect: () => void renameCustom(item) },
      {
        label: tr("移入文件夹"),
        icon: <FolderClosed size={15} />,
        onSelect: () => openMoveMenu(item, e.clientX, e.clientY)
      },
      { label: tr("移除"), icon: <Trash2 size={15} />, danger: true, onSelect: () => void removeCustom(item) }
    ]);
  };

  const renameCustom = async (s: CustomShortcut) => {
    const label = await promptDialog({ title: tr("重命名快捷方式"), initialValue: s.label });
    const next = label?.trim();
    if (!next || next === s.label) return;
    const prev = s.label;
    update({
      customShortcuts: loadCustomShortcuts(loadWidgetConfig(instanceId)).map((x) =>
        x.id === s.id ? { ...x, label: next } : x
      )
    });
    /* 与 renameFolder 对称：重命名入撤销栈（此前文件夹重命名可撤销、条目
       重命名不可，同一右键菜单里体验割裂）。 */
    pushOp({
      label: tr("重命名快捷方式"),
      undo: () => {
        update({
          customShortcuts: loadCustomShortcuts(loadWidgetConfig(instanceId)).map((x) =>
            x.id === s.id ? { ...x, label: prev } : x
          )
        });
      },
      redo: () => {
        update({
          customShortcuts: loadCustomShortcuts(loadWidgetConfig(instanceId)).map((x) =>
            x.id === s.id ? { ...x, label: next } : x
          )
        });
      }
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
      // 实例图标表只增不减会随增删缓慢累积（每枚数 KB～数十 KB base64）：
      // 条目落删时同步清掉它的缓存项（模块级共享缓存保留——FolderPopup 可能
      // 仍在显示同一路径，watch modified 才是它的失效时机）。
      setIcons((prev) => {
        if (!(s.path in prev)) return prev;
        const next = { ...prev };
        delete next[s.path];
        return next;
      });
      pushOp({
        label: tr("移除快捷方式"),
        undo: () => {
          const now = loadWidgetConfig(instanceId);
          const nowList = loadCustomShortcuts(now);
          if (nowList.some((x) => x.id === s.id)) return;
          const at = Math.min(index, nowList.length);
          const restored: CustomShortcut = {
            id: s.id,
            label: s.label,
            path: s.path,
            kind: s.kind,
            // 缺失态一并还原（此前重建丢标志，要等 60s 复检才补回）。
            ...(s.missing ? { missing: true } : {})
          };
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
  /** 缺失条目重新定位：文件对话框选新目标，classify 重挂（id/格位/文件夹归属保留）。
      新目标必然存在（刚从对话框选出）——顺手清 missing 标志，不必等 60s 复检；
      操作入撤销栈，undo 完整还原旧 path/kind/label 与缺失态。 */
  const relocateCustom = async (s: CustomShortcut) => {
    try {
      const path = await pickFilePath({ title: tr("重新定位") });
      if (!path) return;
      const r = await invoke<{ label: string; kind: string; path?: string | null }>("classify_path", { path });
      const prev = { path: s.path, kind: s.kind, label: s.label, missing: s.missing === true };
      const next = {
        path: r.path ?? path,
        kind: normalizeKind(r.kind, s.kind),
        label: r.label || s.label
      };
      const apply = (
        v: { path: string; kind: CustomShortcut["kind"]; label: string; missing?: boolean },
        clearMissing = false
      ) => {
        update({
          customShortcuts: loadCustomShortcuts(loadWidgetConfig(instanceId)).map((x) => {
            if (x.id !== s.id) return x;
            const merged = { ...x, ...v };
            if (clearMissing) delete merged.missing;
            return merged;
          })
        });
      };
      apply(next, true);
      pushOp({
        label: tr("重新定位"),
        undo: () => apply(prev),
        redo: () => apply(next, true)
      });
      pushAppToast(tr("已重新定位"), next.label, "ok");
    } catch {
      /* 用户取消或对话框不可用 */
    }
  };
  const copyCustomPath = async (s: CustomShortcut) => {
    // 走 lib/clipboard 的双路径降级：WebView2 的 Clipboard API 不可用/被拒时
    // 回退 execCommand，而不是直接弹「复制失败」。
    if (!(await copyText(s.path))) void alertDialog({ title: tr("复制失败") });
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
      // 位移走 CSS 变量（onItemMove 的 rAF 直写）：合成器层跟手，不重渲整树。
      style.transform = "translate(var(--drag-dx, 0px), var(--drag-dy, 0px))";
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
          const d = dragRef.current;
          dragRef.current = null;
          if (dragRafRef.current) {
            window.cancelAnimationFrame(dragRafRef.current);
            dragRafRef.current = 0;
          }
          clearDragVars(d?.el ?? null);
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
        {/* 弹层条目拖出到画布的落点预演。 */}
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
