/* eslint-disable react-refresh/only-export-components */
/**
 * 文件浏览小组件：浏览指定目录（Rust 列举），支持打开文件/文件夹、
 * 快捷路径收藏；懒加载目录内容，错误态内联提示。
 *
 * B5/B6/B8/B9：内容预览视图（图片缩略图 / 文本
 * 前几行）、批量选择 + 批量操作条、显示别名（不碰磁盘）、按类型排序
 * 与名称显示三态。纯函数导出供单测（同 FolderPopup 的豁免口径）。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  CheckSquare,
  ChevronRight,
  File,
  FileArchive,
  FileCode,
  FileImage,
  FileMusic,
  FileSpreadsheet,
  FileText,
  FileVideo,
  FilePlus2,
  Folder,
  FolderOpen,
  FolderPlus,
  LayoutGrid,
  List,
  RefreshCw,
  Search,
  X
} from "lucide-react";
import { invoke, isTauri } from "../../lib/tauri";
import { useTauriEvent } from "../../lib/use-tauri-event";
import { useIncrementalList } from "../../lib/use-incremental-list";
import { useDelayedUnmount } from "../../lib/anim";
import { animDurations } from "../../lib/durations";
import { useSettingsStore } from "../../store/settings-store";
import { useWidgetConfig } from "../widget-config";
import { useT, appLocale } from "../../i18n-lite";
import { promptDialog, alertDialog } from "../../components/PromptDialog";
import { pushAppToast } from "../../components/ToastHost";
import { useSafeTimeout } from "../../lib/use-safe-timeout";

type FileEntry = {
  name: string;
  path: string;
  is_dir: boolean;
  size: number | null;
  modified: string | null;
};

type SortBy = "name" | "size" | "modified" | "type";
type SortOrder = "asc" | "desc";
/** B9 名称显示三态。 */
type NameDisplay = "full" | "noext" | "noname";

const SAMPLE_FOLDERS = [
  "工作文档",
  "项目资料",
  "设计素材",
  "会议纪要",
  "学习笔记",
  "财务报表",
  "产品原型",
  "客户沟通",
  "团队协作",
  "个人备份",
  "软件安装包",
  "截图存档",
  "临时文件"
];

/** W-078 快捷 chips 的固定顺序（key 与 Rust known_dirs 对齐）。 */
const CHIPS: { key: string; label: string }[] = [
  { key: "downloads", label: "下载" },
  { key: "documents", label: "文档" },
  { key: "pictures", label: "图片" },
  { key: "music", label: "音乐" },
  { key: "videos", label: "视频" },
  { key: "desktop", label: "桌面" }
];

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function formatDate(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat(appLocale(), { month: "numeric", day: "numeric" }).format(d);
}

/** W-074 修改时间的排序键：Rust 返回 "YYYY-MM-DD HH:mm"，字典序即时间序。 */
function modifiedKey(iso: string | null): number {
  if (!iso) return 0;
  const t = new Date(iso).getTime();
  return Number.isFinite(t) ? t : 0;
}

function fileIcon(name: string) {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  if (["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "ico"].includes(ext)) return FileImage;
  if (["mp4", "mkv", "avi", "mov", "webm", "flv"].includes(ext)) return FileVideo;
  if (["mp3", "wav", "flac", "ogg", "m4a"].includes(ext)) return FileMusic;
  if (["zip", "rar", "7z", "tar", "gz"].includes(ext)) return FileArchive;
  if (["js", "ts", "tsx", "jsx", "py", "rs", "go", "java", "c", "cpp", "html", "css", "json"].includes(ext))
    return FileCode;
  if (["xls", "xlsx", "csv"].includes(ext)) return FileSpreadsheet;
  if (["txt", "md", "doc", "docx", "pdf"].includes(ext)) return FileText;
  return File;
}

/** 按文件类型返回主题化图标色，增强可辨识度。 */
function fileColor(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  if (["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "ico"].includes(ext)) return "var(--tm-image, #38bdf8)";
  if (["mp4", "mkv", "avi", "mov", "webm", "flv"].includes(ext)) return "var(--tm-video, #a78bfa)";
  if (["mp3", "wav", "flac", "ogg", "m4a"].includes(ext)) return "var(--tm-audio, #f472b6)";
  if (["zip", "rar", "7z", "tar", "gz"].includes(ext)) return "var(--tm-archive, #f59e0b)";
  if (["js", "ts", "tsx", "jsx", "py", "rs", "go", "java", "c", "cpp", "html", "css", "json"].includes(ext))
    return "var(--tm-code, #34d399)";
  if (["xls", "xlsx", "csv"].includes(ext)) return "var(--tm-sheet, #4ade80)";
  if (["txt", "md", "doc", "docx", "pdf"].includes(ext)) return "var(--tm-doc, #60a5fa)";
  return "var(--muted)";
}

/** 去掉扩展名（无扩展名或点开头的文件名原样返回）。B9 三态显示用。 */
export function stripExt(name: string): string {
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(0, i) : name;
}

/** B9 名称显示：full 完整 / noext 去扩展名 / noname 只留图标（返回空串）。 */
export function displayFileName(name: string, mode: NameDisplay): string {
  if (mode === "noext") return stripExt(name);
  if (mode === "noname") return "";
  return name;
}

/** B9 类型排序键：小写扩展名（无扩展名排最后）。 */
function extKey(name: string): string {
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(i + 1).toLowerCase() : "\uffff";
}

/** 预览模式的内容分类（B5）。 */
export function isImageFile(name: string): boolean {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  return ["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "ico"].includes(ext);
}
const TEXT_PREVIEW_EXTS = [
  "txt",
  "md",
  "json",
  "csv",
  "log",
  "xml",
  "html",
  "htm",
  "css",
  "js",
  "ts",
  "tsx",
  "jsx",
  "py",
  "rs",
  "go",
  "java",
  "ini",
  "yml",
  "yaml",
  "toml"
];
export function isTextPreviewable(name: string): boolean {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  return TEXT_PREVIEW_EXTS.includes(ext);
}

/**
 * W-074 排序：目录始终在前，组内按 sortBy/sortOrder。B9 补「类型」
 * （扩展名聚簇，同名扩展内再按名称）；nameOf 传入别名感知的显示名
 * （B8：排序跟随用户看到的名字）。
 */
export function sortEntries(
  list: FileEntry[],
  by: SortBy,
  order: SortOrder,
  nameOf: (e: FileEntry) => string = (e) => e.name
): FileEntry[] {
  const dir = order === "asc" ? 1 : -1;
  return [...list].sort((a, b) => {
    if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
    switch (by) {
      case "size":
        return ((a.size ?? 0) - (b.size ?? 0)) * dir;
      case "modified":
        return (modifiedKey(a.modified) - modifiedKey(b.modified)) * dir;
      case "type": {
        const ea = extKey(a.name);
        const eb = extKey(b.name);
        if (ea !== eb) return ea.localeCompare(eb) * dir;
        return nameOf(a).toLowerCase().localeCompare(nameOf(b).toLowerCase()) * dir;
      }
      default:
        return nameOf(a).toLowerCase().localeCompare(nameOf(b).toLowerCase()) * dir;
    }
  });
}

/** B5 预览拉取上限：极端大目录只预览前若干项，其余退回图标。 */
const PREVIEW_LIMIT = 48;
/** B5 文本预览取前几个非空行。 */
function firstLines(text: string, n = 3): string {
  return text
    .split(/\r?\n/)
    .filter((l) => l.trim() !== "")
    .slice(0, n)
    .join("\n");
}

/** 把路径拆成面包屑段：C:\Users\x\Desktop → [{name:"C:",path:"C:"},{name:"Users",path:"C:\Users"},…]。 */
function crumbsOf(path: string | null): { name: string; path: string }[] {
  if (!path) return [{ name: "桌面", path: "" }];
  const norm = path.replace(/\//g, "\\");
  const parts = norm.split("\\").filter(Boolean);
  const out: { name: string; path: string }[] = [];
  let acc = "";
  for (const part of parts) {
    acc = acc ? `${acc}\\${part}` : part;
    out.push({ name: part, path: acc });
  }
  return out;
}

/**
 * Vela-style Desktop file browser card. In Tauri it lists the real desktop
 * directory (and lets the user navigate into subfolders); in browser dev mode
 * it falls back to a sample folder list.
 */
export function FileBrowserWidget({ instanceId }: { instanceId: string }) {
  const tr = useT();
  const safeTimeout = useSafeTimeout();
  const fileBrowserRoot = useSettingsStore((s) => s.extra.fileBrowserRoot);
  const { config, update } = useWidgetConfig(instanceId);
  const showHidden = !!config.showHidden;
  const showFileSize = config.showFileSize !== false;
  const showModifiedDate = config.showModifiedDate !== false;
  const sortBy = (config.sortBy as SortBy) || "name";
  const sortOrder = (config.sortOrder as SortOrder) || "asc";
  /** B9 名称显示三态 / B5 视图模式 / B8 显示别名。 */
  const nameDisplay = (config.nameDisplay as NameDisplay) || "full";
  const viewMode = config.viewMode === "preview" ? "preview" : "list";
  const aliases = useMemo(
    () => (config.aliases && typeof config.aliases === "object" ? (config.aliases as Record<string, string>) : {}),
    [config.aliases]
  );
  const showChips = config.showChips !== false;
  const rememberPath = config.rememberPath !== false;

  // W-079 根目录：实例配置优先，其次全局，最后桌面（null）。
  const rootPath = (config.root as string) || fileBrowserRoot || null;
  // W-079 路径记忆：重启后回到最后浏览的目录（须仍在根下才算数，防止根改了还跳旧路径）。
  const initialPath = useRef<string | null>(
    rememberPath && config.lastPath && (!rootPath || (config.lastPath as string).startsWith(rootPath))
      ? (config.lastPath as string)
      : rootPath
  ).current;

  const [path, setPath] = useState<string | null>(initialPath);
  // W-075 前进/后退：路径历史栈 + 游标。
  const [hist, setHist] = useState<(string | null)[]>([initialPath]);
  const [histIdx, setHistIdx] = useState(0);
  // 导航方向（+1 前进左入 / -1 后退右入），驱动列表 key 重挂载的方向化滑动。
  const [navDir, setNavDir] = useState(1);
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  // W-078 快捷 chips 的目录映射。
  const [dirs, setDirs] = useState<Record<string, string>>({});
  // W-077 右键菜单：目标条目 + 屏幕坐标；删除需两段确认。
  const [menu, setMenu] = useState<{ x: number; y: number; entry: FileEntry } | null>(null);
  /* #57 统一弹层退场：关闭后播 .is-closing（ctx-menu-out）再卸载，期间以最后
     一份菜单快照渲染——与 ContextMenu.tsx 全局右键菜单同语言。 */
  const menuVisible = useDelayedUnmount(!!menu, Math.round(animDurations().fxFastMs));
  const lastMenu = useRef(menu);
  if (menu) lastMenu.current = menu;
  const shownMenu = menu ?? lastMenu.current;
  const [confirmDel, setConfirmDel] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  /* ---- B6 批量选择：会话态，
          进选择模式后点击行 = 勾选/取消（不再打开），底部浮出批量操作条；
          导航换目录时清空选择（保留模式）。 ---- */
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [batchBusy, setBatchBusy] = useState(false);
  const [confirmBatchDel, setConfirmBatchDel] = useState(false);
  useEffect(() => {
    setSelected(new Set());
    setConfirmBatchDel(false);
  }, [path]);

  /** B8 别名感知显示名：别名整体替换（不吃三态裁剪——那是给真实文件名的）。 */
  const nameOf = useMemo(() => {
    const hasAlias = Object.keys(aliases).length > 0;
    return (e: FileEntry): string => {
      const alias = hasAlias ? aliases[e.path] : undefined;
      return alias ?? displayFileName(e.name, nameDisplay);
    };
  }, [aliases, nameDisplay]);

  const navigate = (next: string | null) => {
    if (next === path) return;
    setNavDir(1);
    setPath(next);
    setQuery("");
    setHist((h) => [...h.slice(0, histIdx + 1), next]);
    setHistIdx((i) => i + 1);
  };

  const goBack = () => {
    if (histIdx <= 0) return;
    setNavDir(-1);
    const idx = histIdx - 1;
    setHistIdx(idx);
    setPath(hist[idx]);
    setQuery("");
  };
  const goForward = () => {
    if (histIdx >= hist.length - 1) return;
    setNavDir(1);
    const idx = histIdx + 1;
    setHistIdx(idx);
    setPath(hist[idx]);
    setQuery("");
  };

  // 序号守卫：快速连续导航时，慢请求后返回不得覆盖新路径的结果；
  // disposed 守卫：组件卸载后不再落地 setState。
  const loadSeq = useRef(0);
  /* BentoDesk 借鉴 #4：实时同步触发的重拉走静默路径（不闪 loading、
     不清空错误），手动刷新/导航仍完整反馈。 */
  const silentReload = useRef(false);
  useEffect(() => {
    const seq = ++loadSeq.current;
    const silent = silentReload.current;
    silentReload.current = false;
    let disposed = false;
    void (async () => {
      if (disposed) return;
      if (!isTauri()) {
        setEntries(
          SAMPLE_FOLDERS.map((name) => ({ name: tr(name), path: name, is_dir: true, size: null, modified: null }))
        );
        return;
      }
      if (!silent) {
        setLoading(true);
        setError(null);
      }
      try {
        const list = await invoke<FileEntry[]>("list_directory", {
          path: path ?? null,
          showHidden
        });
        if (seq === loadSeq.current && !disposed) setEntries(list);
      } catch (e) {
        if (seq === loadSeq.current && !disposed) {
          setError(String(e));
          setEntries([]);
        }
      } finally {
        if (seq === loadSeq.current && !disposed) setLoading(false);
      }
    })();
    return () => {
      disposed = true;
    };
  }, [path, tr, reloadKey, showHidden]);

  /* ---- BentoDesk 借鉴 #4 实时文件夹：当前目录登记到 Rust watch，变更
          事件（300ms 静默合并）→ 静默重拉；事件只当脏标记、真相在磁盘，
          前端零对账。绑定失败（网络盘/系统目录等校验不过）或关掉开关 →
          回退 W-076 的 20s 可见性轮询。 ---- */
  const liveSync = config.liveSync !== false;
  const [liveActive, setLiveActive] = useState(false);
  const watchPath = path ?? dirs["desktop"] ?? null;
  useEffect(() => {
    if (!isTauri() || !liveSync || !watchPath) {
      setLiveActive(false);
      return;
    }
    let disposed = false;
    void invoke<{ instanceId: string; error: string | null }[]>("apply_live_folders", {
      configs: [{ instanceId, path: watchPath }]
    })
      .then((r) => {
        if (!disposed && r.length > 0 && !r[0].error) setLiveActive(true);
      })
      .catch(() => {});
    return () => {
      disposed = true;
      setLiveActive(false);
      if (isTauri()) {
        void invoke("apply_live_folders", { configs: [{ instanceId, path: "" }] }).catch(() => {});
      }
    };
  }, [instanceId, liveSync, watchPath]);

  useTauriEvent<{ instanceId: string; path: string }>("live-folder:change", (p) => {
    if (!p || p.instanceId !== instanceId) return;
    silentReload.current = true;
    setReloadKey((k) => k + 1);
  });

  // W-076 目录监听（实时同步不可用时降级为轮询）：窗口可见时每 20s 静默重拉。
  useEffect(() => {
    if (!isTauri() || liveActive) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") setReloadKey((k) => k + 1);
    }, 20000);
    return () => window.clearInterval(timer);
  }, [liveActive]);

  // W-078 挂载时取一次常用目录映射。
  useEffect(() => {
    if (!isTauri()) return;
    invoke<Record<string, string>>("known_dirs")
      .then((m) => setDirs(m))
      .catch(() => {});
  }, []);

  // W-079 路径记忆：导航后防抖写入实例配置。
  useEffect(() => {
    if (!rememberPath) return;
    safeTimeout(() => update({ lastPath: path ?? "" }), 600);
    // update 引用稳定（useCallback by instanceId），path 变化即重记。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, rememberPath]);

  const openEntry = (entry: FileEntry) => {
    if (!isTauri()) return;
    if (entry.is_dir) {
      navigate(entry.path);
    } else {
      void invoke("open_path", { path: entry.path }).catch(() => {});
    }
  };

  const goUp = () => {
    if (!path) return;
    const parent = path.replace(/[\\/][^\\/]+$/, "");
    navigate(parent === path ? null : parent);
  };

  const goHome = () => navigate(rootPath);
  const refresh = () => setReloadKey((k) => k + 1);

  /* DeskOrder 借鉴 #3：在当前目录就地新建空文件 / 文件夹（带默认名，重名报错）。 */
  const createEntry = async (isDir: boolean) => {
    if (!isTauri()) return;
    const dir = path ?? rootPath ?? dirs["desktop"];
    if (!dir) {
      void alertDialog({ title: tr("无法确定当前目录") });
      return;
    }
    const label = await promptDialog({
      title: isDir ? tr("新建文件夹") : tr("新建文本文件"),
      initialValue: isDir ? tr("新建文件夹") : "新建文本.txt"
    });
    const name = label?.trim();
    if (!name) return;
    try {
      await invoke("create_entry", { dir, name, isDir });
      setReloadKey((k) => k + 1);
    } catch (e) {
      void alertDialog({ title: tr("创建失败"), message: e instanceof Error ? e.message : String(e) });
    }
  };

  const pickFolder = async () => {
    if (!isTauri()) return;
    const chosen = await invoke<string | null>("pick_folder").catch(() => null);
    if (!chosen) return;
    update({ root: chosen, lastPath: chosen });
    navigate(chosen);
  };

  // W-077 右键动作。
  const revealEntry = (entry: FileEntry) => {
    void invoke("reveal_in_explorer", { path: entry.path }).catch(() => {});
  };
  const copyPath = async (entry: FileEntry) => {
    try {
      await navigator.clipboard.writeText(entry.path);
    } catch {
      // WebView 剪贴板权限被拒时静默失败（路径仍显示在 tooltip 中）。
    }
  };
  const renameEntry = async (entry: FileEntry) => {
    const name = await promptDialog({ title: tr("重命名为"), initialValue: entry.name });
    const next = name?.trim();
    if (!next || next === entry.name) return;
    const dir = entry.path.replace(/[\\/][^\\/]+$/, "");
    try {
      setBusyId(entry.path);
      await invoke("rename_path", { oldPath: entry.path, newPath: `${dir}\\${next}` });
      refresh();
    } catch (e) {
      void alertDialog({ title: tr("操作失败"), message: String(e) });
    } finally {
      setBusyId(null);
    }
  };
  /* ---- E15 撤销删除：私有备份恢复（不依赖回收站）。命令失败静默降级——
          撤销承诺只在 toast 有效期内需要成立，超期即靠回收站。 ---- */
  const undoDelete = async (tickets: string[]) => {
    if (!isTauri() || tickets.length === 0) return;
    let restored = 0;
    for (const t of tickets) {
      const ok = await invoke<string>("undo_delete", { ticket: t }).catch(() => null);
      if (ok) restored++;
    }
    refresh();
    if (restored > 0) pushAppToast(tr("已恢复"), `${restored}`, "ok");
    else void alertDialog({ title: tr("恢复失败") });
  };

  const deleteEntry = async (entry: FileEntry) => {
    try {
      setBusyId(entry.path);
      const r = await invoke<{ ticket: string | null; undoable: boolean }>("delete_with_undo", {
        path: entry.path
      });
      refresh();
      if (r.ticket) {
        pushAppToast(tr("已删除到回收站"), entry.name, "ok", {
          action: { label: tr("撤销"), run: () => void undoDelete([r.ticket!]) }
        });
      }
    } catch (e) {
      void alertDialog({ title: tr("操作失败"), message: String(e) });
    } finally {
      setBusyId(null);
      setConfirmDel(null);
    }
  };

  /* ---- B6 批量动作 ---- */
  const toggleSelected = (entryPath: string) => {
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(entryPath)) next.delete(entryPath);
      else next.add(entryPath);
      return next;
    });
  };
  const openSelected = async () => {
    if (!isTauri() || selected.size === 0 || batchBusy) return;
    setBatchBusy(true);
    try {
      for (const p of selected) {
        await invoke("open_path", { path: p }).catch(() => {});
      }
    } finally {
      setBatchBusy(false);
    }
  };
  /* ---- B7 批量删除进度（PoggetMetaManager 的 IsCopying / CurrentFileName /
          CancelCount 三件套等价物）：进度 = 已完成/总数 + 当前文件名，取消 =
          停止发起后续删除（已完成的保留）。进度条用 scaleX（合成器友好，
          不触碰布局属性）。 ---- */
  const [batchRun, setBatchRun] = useState<{ total: number; done: number; current: string } | null>(null);
  const cancelRef = useRef(false);
  const deleteSelected = async () => {
    if (!isTauri() || selected.size === 0 || batchBusy) return;
    if (!confirmBatchDel) {
      setConfirmBatchDel(true);
      return;
    }
    const items = visible.filter((e) => selected.has(e.path));
    if (items.length === 0) return;
    cancelRef.current = false;
    setBatchBusy(true);
    setBatchRun({ total: items.length, done: 0, current: items[0].name });
    let done = 0;
    /** E15：逐条收票，完成 toast 的「撤销」一次回放整批。 */
    const tickets: string[] = [];
    try {
      for (const item of items) {
        if (cancelRef.current) break;
        setBatchRun({ total: items.length, done, current: item.name });
        const r = await invoke<{ ticket: string | null }>("delete_with_undo", { path: item.path }).catch(() => null);
        if (r?.ticket) tickets.push(r.ticket);
        done++;
      }
      setBatchRun({ total: items.length, done, current: "" });
      setSelected(new Set());
      setConfirmBatchDel(false);
      refresh();
      if (cancelRef.current) pushAppToast(tr("已取消删除"), `${tr("已完成")} ${done}/${items.length}`, "info");
      else
        pushAppToast(tr("删除完成"), `${done}`, "ok", {
          action: { label: tr("撤销"), run: () => void undoDelete(tickets) }
        });
    } finally {
      setBatchRun(null);
      setBatchBusy(false);
    }
  };

  /* ---- B8 显示别名：只改本实例展示，不碰磁盘。 ---- */
  const setAliasFor = async (entry: FileEntry) => {
    const label = await promptDialog({
      title: tr("设置显示名"),
      initialValue: aliases[entry.path] ?? entry.name
    });
    if (label === null) return; // 取消
    const next = label.trim();
    const nextAliases = { ...aliases };
    // 输入为空或与真实名一致 = 清除别名（回到跟随文件名）。
    if (!next || next === entry.name) delete nextAliases[entry.path];
    else nextAliases[entry.path] = next;
    update({ aliases: nextAliases });
  };
  const clearAliasFor = (entry: FileEntry) => {
    const nextAliases = { ...aliases };
    delete nextAliases[entry.path];
    update({ aliases: nextAliases });
  };

  // 右键菜单：点击空白处 / Esc 关闭。
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

  const currentName = path ? path.split(/[\\/]/).pop() || "Desktop" : "Desktop";
  const q = query.trim().toLowerCase();
  // E-增量窗口：大目录此前每次渲染都现算现排并全量 map 出行。过滤/排序收进
  // useMemo，挂载走 useIncrementalList 增量窗口（首屏 40 条，滚动补齐）。
  const visible = useMemo(
    () =>
      sortEntries(
        (q ? entries.filter((e) => e.name.toLowerCase().includes(q)) : entries).filter(
          (e) => showHidden || !e.name.startsWith(".")
        ),
        sortBy,
        sortOrder,
        nameOf
      ),
    [entries, q, showHidden, sortBy, sortOrder, nameOf]
  );
  const { items: windowedEntries, scrollRef } = useIncrementalList(visible, {
    initial: 40,
    step: 40
  });

  /* ---- B5 预览加载：只对当前
          增量窗口内的条目拉取——图片走 read_image_data_url（含解码上限与
          防图片炸弹），文本走 read_text_preview（头部 2KB）。失败也记入
          attempted，防止渲染循环里反复重试；并发 4 限制 IPC 压力。 ---- */
  const [previews, setPreviews] = useState<Record<string, string>>({});
  const attemptedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    attemptedRef.current = new Set();
    setPreviews({});
  }, [path]);
  const previewSig = windowedEntries.map((e) => e.path).join("|");
  useEffect(() => {
    if (viewMode !== "preview" || !isTauri()) return;
    let cancelled = false;
    const targets = windowedEntries
      .filter(
        (e) => !e.is_dir && (isImageFile(e.name) || isTextPreviewable(e.name)) && !attemptedRef.current.has(e.path)
      )
      .slice(0, PREVIEW_LIMIT);
    if (targets.length === 0) return;
    for (const t of targets) attemptedRef.current.add(t.path);
    void (async () => {
      for (let i = 0; i < targets.length; i += 4) {
        if (cancelled) return;
        const results = await Promise.all(
          targets
            .slice(i, i + 4)
            .map((e) =>
              (isImageFile(e.name)
                ? invoke<string>("read_image_data_url", { path: e.path })
                : invoke<string>("read_text_preview", { path: e.path, maxBytes: 2048 })
              )
                .then((r) => [e.path, r] as const)
                .catch(() => null)
            )
        );
        if (cancelled) return;
        const next: Record<string, string> = {};
        for (const r of results) if (r) next[r[0]] = r[1];
        if (Object.keys(next).length > 0) setPreviews((prev) => ({ ...prev, ...next }));
      }
    })();
    return () => {
      cancelled = true;
    };
    // previewSig 驱动（滚动补齐 / 换目录后重拉）；windowedEntries 引用每渲染漂移。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewMode, previewSig]);

  const crumbs = crumbsOf(path);
  const chipList = CHIPS.filter((c) => dirs[c.key]);

  return (
    <div className="widget-files">
      <div className="widget-files-titlebar">
        <span className="widget-files-title">
          <Folder size={14} />
          <button className="widget-files-home" onClick={goHome} title={tr("回到根目录")} data-interactive>
            {currentName}
          </button>
        </span>
        <span className="widget-files-actions">
          <button
            className="widget-files-up"
            onClick={goBack}
            disabled={histIdx <= 0}
            aria-label={tr("后退")}
            data-interactive
          >
            <ArrowLeft size={14} />
          </button>
          <button
            className="widget-files-up"
            onClick={goForward}
            disabled={histIdx >= hist.length - 1}
            aria-label={tr("前进")}
            data-interactive
          >
            <ArrowRight size={14} />
          </button>
          <button
            className="widget-files-up"
            onClick={() => void createEntry(true)}
            aria-label={tr("新建文件夹")}
            title={tr("新建文件夹")}
            data-interactive
          >
            <FolderPlus size={14} />
          </button>
          <button
            className="widget-files-up"
            onClick={() => void createEntry(false)}
            aria-label={tr("新建文本文件")}
            title={tr("新建文本文件")}
            data-interactive
          >
            <FilePlus2 size={14} />
          </button>
          <button
            className="widget-files-pick"
            onClick={pickFolder}
            aria-label={tr("选择文件夹")}
            title={tr("选择要浏览的文件夹")}
            data-interactive
          >
            <FolderOpen size={14} />
          </button>
          {/* B6 批量选择开关（会话态）：进入后点击行 = 勾选，底部浮出批量操作条。 */}
          <button
            className={`widget-files-up${selectMode ? " is-on" : ""}`}
            onClick={() => {
              setSelectMode((v) => !v);
              setSelected(new Set());
              setConfirmBatchDel(false);
            }}
            aria-label={tr("批量选择")}
            title={tr("批量选择")}
            aria-pressed={selectMode}
            data-interactive
          >
            <CheckSquare size={14} />
          </button>
          {/* B5 视图切换：列表 ⇄ 内容预览（持久化到实例配置）。 */}
          <button
            className={`widget-files-up${viewMode === "preview" ? " is-on" : ""}`}
            onClick={() => update({ viewMode: viewMode === "list" ? "preview" : "list" })}
            aria-label={tr("视图")}
            title={viewMode === "list" ? tr("切换到预览视图") : tr("切换到列表视图")}
            aria-pressed={viewMode === "preview"}
            data-interactive
          >
            {viewMode === "list" ? <LayoutGrid size={14} /> : <List size={14} />}
          </button>
          <button
            className="widget-files-search-toggle"
            onClick={() => setSearching((v) => !v)}
            aria-label={tr("搜索")}
            title={tr("搜索")}
            data-interactive
          >
            <Search size={14} />
          </button>
          <button
            className="widget-files-up"
            onClick={refresh}
            aria-label={tr("刷新")}
            title={tr("刷新")}
            data-interactive
          >
            <RefreshCw size={14} />
          </button>
          <button className="widget-files-up" onClick={goUp} disabled={!path} aria-label={tr("向上")} data-interactive>
            <ArrowUp size={14} />
          </button>
        </span>
      </div>
      {/* W-075 面包屑：点击任意层级直达；横向滚动容纳深路径。 */}
      <div className="fb-crumbs" key={path ?? "root"}>
        {crumbs.map((c, i) => (
          <span className="fb-crumb-group" key={c.path || i}>
            {i > 0 && <ChevronRight size={11} className="fb-crumb-sep" />}
            <button
              className="fb-crumb"
              onClick={() => navigate(c.path || null)}
              title={c.path || tr("桌面")}
              data-interactive
            >
              {c.name}
            </button>
          </span>
        ))}
      </div>
      {/* W-078 根目录快捷 chips。 */}
      {showChips && chipList.length > 0 && (
        <div className="fb-chips">
          {chipList.map((c) => (
            <button
              className={`fb-chip${dirs[c.key] === path ? " active" : ""}`}
              key={c.key}
              onClick={() => navigate(dirs[c.key])}
              title={dirs[c.key]}
              data-interactive
            >
              {tr(c.label)}
            </button>
          ))}
        </div>
      )}
      {searching && (
        <div className="widget-files-search">
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={tr("过滤当前文件夹…")}
            data-interactive
          />
          {query && (
            <button
              className="widget-files-clear"
              onClick={() => setQuery("")}
              aria-label={tr("清除搜索")}
              data-interactive
              title={tr("清除搜索")}
            >
              <X size={13} />
            </button>
          )}
        </div>
      )}
      {/* key 重挂载 + --fb-dir：前进左入 / 后退右入（对齐 tt-grid-dir 语言）。
          B5：viewMode=preview 时渲染内容预览网格（图片缩略图 / 文本前几行 /
          类型大图标），列表态维持原行布局。 */}
      {(() => {
        /* 加载/错误/空态在两种视图下同款。 */
        const stateBlock = (
          <>
            {loading && (
              <div className="widget-files-skeleton" aria-busy="true">
                {Array.from({ length: 5 }, (_, i) => (
                  <div
                    className="widget-skeleton files-skeleton-row"
                    key={i}
                    style={{ ["--sd" as string]: `${i * 0.08}s` }}
                  />
                ))}
              </div>
            )}
            {!loading && error && <div className="widget-files-empty">{error}</div>}
            {!loading && !error && visible.length === 0 && (
              <div className="widget-files-empty">{q ? tr("无匹配项") : tr("此文件夹为空")}</div>
            )}
          </>
        );
        /* 行为内公共：选择态点击 = 勾选；键盘 Enter 打开 / Shift+F10 菜单。 */
        const activate = (entry: FileEntry) => (selectMode ? toggleSelected(entry.path) : openEntry(entry));
        const onKey = (e: React.KeyboardEvent, entry: FileEntry) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            activate(entry);
          } else if ((e.key === "F10" && e.shiftKey) || e.key === "ContextMenu") {
            if (!isTauri()) return;
            e.preventDefault();
            const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
            setMenu({ x: r.left + 4, y: r.bottom + 4, entry });
          }
        };
        const onCtx = (e: React.MouseEvent, entry: FileEntry) => {
          if (!isTauri()) return;
          e.preventDefault();
          e.stopPropagation();
          setMenu({ x: e.clientX, y: e.clientY, entry });
        };
        if (viewMode === "preview") {
          return (
            <div
              className="widget-files-grid"
              key={path ?? "root"}
              ref={scrollRef}
              style={{ ["--fb-dir" as string]: String(navDir) }}
            >
              {stateBlock}
              {!loading &&
                !error &&
                windowedEntries.map((entry) => {
                  const Icon = entry.is_dir ? Folder : fileIcon(entry.name);
                  const name = nameOf(entry);
                  const preview = !entry.is_dir ? previews[entry.path] : undefined;
                  return (
                    <div
                      className={`fb-tile${entry.is_dir ? " is-dir" : ""}${selectMode && selected.has(entry.path) ? " is-selected" : ""}`}
                      key={entry.path}
                      role="button"
                      tabIndex={0}
                      title={entry.path}
                      onClick={() => activate(entry)}
                      onKeyDown={(e) => onKey(e, entry)}
                      onContextMenu={(e) => onCtx(e, entry)}
                    >
                      <span className="fb-tile-preview">
                        {isImageFile(entry.name) && preview ? (
                          <img src={preview} alt="" draggable={false} loading="lazy" />
                        ) : isTextPreviewable(entry.name) && preview ? (
                          <pre className="fb-tile-text">{firstLines(preview)}</pre>
                        ) : (
                          <Icon size={30} style={entry.is_dir ? undefined : { color: fileColor(entry.name) }} />
                        )}
                      </span>
                      {name && <span className="fb-tile-name">{name}</span>}
                    </div>
                  );
                })}
            </div>
          );
        }
        return (
          <div
            className="widget-files-list"
            key={path ?? "root"}
            ref={scrollRef}
            style={{ ["--fb-dir" as string]: String(navDir) }}
          >
            {stateBlock}
            {!loading &&
              !error &&
              windowedEntries.map((entry) => {
                const Icon = entry.is_dir ? Folder : fileIcon(entry.name);
                const name = nameOf(entry);
                return (
                  <div
                    className={`widget-file-row${entry.is_dir ? " is-dir" : ""}${busyId === entry.path ? " is-busy" : ""}${selectMode && selected.has(entry.path) ? " is-selected" : ""}`}
                    key={entry.path}
                    onClick={() => activate(entry)}
                    onKeyDown={(e) => onKey(e, entry)}
                    onContextMenu={(e) => onCtx(e, entry)}
                    role="button"
                    tabIndex={0}
                    title={aliases[entry.path] ? `${aliases[entry.path]}\n${entry.path}` : entry.path}
                  >
                    {selectMode && (
                      <span className={`fb-check${selected.has(entry.path) ? " on" : ""}`} aria-hidden="true" />
                    )}
                    <Icon
                      size={16}
                      className="widget-file-icon"
                      style={entry.is_dir ? undefined : { color: fileColor(entry.name) }}
                    />
                    <span className="widget-file-name">{name}</span>
                    {showFileSize && !entry.is_dir && entry.size != null && (
                      <span className="widget-file-meta">{formatSize(entry.size)}</span>
                    )}
                    {showModifiedDate && entry.modified && (
                      <span className="widget-file-meta">{formatDate(entry.modified)}</span>
                    )}
                  </div>
                );
              })}
          </div>
        );
      })()}
      {/* B6 批量操作条：选择模式下常驻底部；
          B7：批量执行中切换为进度态（n/total + 当前文件名 + 取消）。 */}
      {selectMode && (
        <div className="fb-batch" onClick={(e) => e.stopPropagation()}>
          {batchRun ? (
            <>
              <span className="fb-batch-count">
                {tr("正在删除")} {batchRun.done}/{batchRun.total}
              </span>
              <span className="fb-batch-current" title={batchRun.current}>
                {batchRun.current}
              </span>
              <span className="fb-batch-spacer" />
              <span className="fb-batch-progress" aria-hidden="true">
                <span
                  className="fb-batch-progress-fill"
                  style={{ transform: `scaleX(${batchRun.total > 0 ? batchRun.done / batchRun.total : 0})` }}
                />
              </span>
              <button
                className="fb-batch-btn"
                onClick={() => {
                  cancelRef.current = true;
                }}
                data-interactive
              >
                {tr("取消")}
              </button>
            </>
          ) : (
            <>
              <span className="fb-batch-count">
                {tr("已选")} {selected.size}
              </span>
              <span className="fb-batch-spacer" />
              <button
                className="fb-batch-btn"
                disabled={batchBusy || visible.length === 0}
                onClick={() =>
                  setSelected(selected.size === visible.length ? new Set() : new Set(visible.map((e) => e.path)))
                }
                data-interactive
              >
                {selected.size === visible.length ? tr("清除") : tr("全选")}
              </button>
              <button
                className="fb-batch-btn"
                disabled={batchBusy || selected.size === 0}
                onClick={() => void openSelected()}
                data-interactive
              >
                {tr("打开所选")}
              </button>
              <button
                className="fb-batch-btn danger"
                disabled={batchBusy || selected.size === 0}
                onClick={() => void deleteSelected()}
                onMouseLeave={() => setConfirmBatchDel(false)}
                data-interactive
              >
                {confirmBatchDel ? tr("再次点击确认删除") : tr("删除所选")}
              </button>
            </>
          )}
        </div>
      )}

      {menuVisible && shownMenu && (
        <div
          className={`widget-context-menu${menu ? "" : " is-closing"}`}
          style={{ left: shownMenu.x, top: shownMenu.y }}
          onClick={(e) => e.stopPropagation()}
          role="menu"
        >
          <button
            role="menuitem"
            onClick={() => {
              openEntry(shownMenu.entry);
              setMenu(null);
            }}
          >
            {tr("打开")}
          </button>
          <button
            role="menuitem"
            onClick={() => {
              revealEntry(shownMenu.entry);
              setMenu(null);
            }}
          >
            <FolderOpen size={13} /> {tr("在资源管理器中显示")}
          </button>
          <button
            role="menuitem"
            onClick={() => {
              void copyPath(shownMenu.entry);
              setMenu(null);
            }}
          >
            {tr("复制路径")}
          </button>
          <button
            role="menuitem"
            onClick={() => {
              void renameEntry(shownMenu.entry);
              setMenu(null);
            }}
          >
            {tr("重命名")}
          </button>
          {/* B8 显示别名：与物理重命名分离——只改本实例展示名，不碰磁盘。 */}
          <button
            role="menuitem"
            onClick={() => {
              void setAliasFor(shownMenu.entry);
              setMenu(null);
            }}
          >
            {tr("设置显示名")}
          </button>
          {aliases[shownMenu.entry.path] && (
            <button
              role="menuitem"
              onClick={() => {
                clearAliasFor(shownMenu.entry);
                setMenu(null);
              }}
            >
              {tr("清除显示名")}
            </button>
          )}
          <button
            role="menuitem"
            className="danger"
            onClick={() => {
              if (confirmDel === shownMenu.entry.path) {
                void deleteEntry(shownMenu.entry);
                setMenu(null);
              } else {
                setConfirmDel(shownMenu.entry.path);
              }
            }}
            onMouseLeave={() => setConfirmDel(null)}
          >
            {confirmDel === shownMenu.entry.path ? tr("再次点击确认删除") : tr("删除到回收站")}
          </button>
        </div>
      )}
    </div>
  );
}
