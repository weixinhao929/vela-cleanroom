/* eslint-disable react-refresh/only-export-components */
/**
 * 文件浏览小组件：浏览指定目录（Rust 列举），支持打开文件/文件夹、
 * 快捷路径收藏；懒加载目录内容，错误态内联提示。
 *
 * 内容预览视图（图片缩略图 / 文本
 * 前几行）、批量选择 + 批量操作条、显示别名（不碰磁盘）、按类型排序
 * 与名称显示三态。纯函数导出供单测（同 FolderPopup 的豁免口径）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { copyText } from "../../lib/clipboard";
import { useViewportClampedPos } from "../../lib/menu-pos";
import { uiZoom } from "../../lib/ui-zoom";
import { useOsFileDrop } from "../use-os-file-drop";

type FileEntry = {
  name: string;
  path: string;
  is_dir: boolean;
  size: number | null;
  modified: string | null;
};

type SortBy = "name" | "size" | "modified" | "type";
type SortOrder = "asc" | "desc";
/** 名称显示三态。 */
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

/** 快捷 chips 的固定顺序（key 与 Rust known_dirs 对齐）。 */
const CHIPS: { key: string; label: string }[] = [
  { key: "downloads", label: "下载" },
  { key: "documents", label: "文档" },
  { key: "pictures", label: "图片" },
  { key: "music", label: "音乐" },
  { key: "videos", label: "视频" },
  { key: "desktop", label: "桌面" }
];

/** 前进/后退历史栈的会话内上限（内存卫兵；正常浏览远达不到）。 */
const HIST_CAP = 50;
/** 面包屑收敛段数（用户反馈：点开文件夹后条目越积越多，保留 2 段即可）。 */
const CRUMB_KEEP = 2;
/** 新建/重命名的名称防护：分隔符与 Windows 非法字符前置拦下——Rust 端只会
 *  报「仅支持同目录重命名」一类难以理解的失败，就地给出可读提示。 */
const INVALID_NAME_RE = /[\\/:*?"<>|]/;

/* ---- 应用内文件剪贴板（Ctrl+C/X 行内收集、Ctrl+V 粘贴；不占系统剪贴板，
        CF_HDROP 级系统互通另案）。模块级单份，多实例共享。 ---- */
const fileClipboard: { mode: "copy" | "cut"; paths: string[] } = { mode: "copy", paths: [] };
export function setFileClipboard(mode: "copy" | "cut", paths: string[]): void {
  fileClipboard.mode = mode;
  fileClipboard.paths = paths;
}
export function getFileClipboard(): { mode: "copy" | "cut"; paths: string[] } {
  return fileClipboard;
}
export function clearFileClipboard(): void {
  fileClipboard.paths = [];
}

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
  // （年份缺失）：只显「月/日」时旧文件的年份不可推断——非当年补年份。
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return new Intl.DateTimeFormat(
    appLocale(),
    sameYear ? { month: "numeric", day: "numeric" } : { year: "numeric", month: "numeric", day: "numeric" }
  ).format(d);
}

/** 修改时间的排序键：Rust 返回 "YYYY-MM-DD HH:mm"，字典序即时间序。 */
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

/** 去掉扩展名（无扩展名或点开头的文件名原样返回）。三态显示用。 */
export function stripExt(name: string): string {
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(0, i) : name;
}

/** 名称显示：full 完整 / noext 去扩展名 / noname 只留图标（返回空串）。 */
export function displayFileName(name: string, mode: NameDisplay): string {
  if (mode === "noext") return stripExt(name);
  if (mode === "noname") return "";
  return name;
}

/** 类型排序键：小写扩展名（无扩展名排最后）。 */
function extKey(name: string): string {
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(i + 1).toLowerCase() : "\uffff";
}

/** 预览模式的内容分类。 */
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
 * 排序：目录始终在前，组内按 sortBy/sortOrder。补「类型」
 * （扩展名聚簇，同名扩展内再按名称）；nameOf 传入别名感知的显示名
 * （排序跟随用户看到的名字）。
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

/** 预览拉取上限：极端大目录只预览前若干项，其余退回图标。 */
const PREVIEW_LIMIT = 48;
/** 文本预览取前几个非空行。 */
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

/** 面包屑收敛（与 FolderPopup breadcrumbSegments 同语义）：只保留最后 keep
 *  段，更早的折叠为「…」。用户反馈：点开文件夹后整条路径逐段铺开、条目
 *  越积越多，收敛为 2 段即可（完整路径仍可 hover 标题栏查看）。 */
export function truncateCrumbs<T>(list: T[], keep: number): { items: T[]; truncated: boolean } {
  const n = Math.max(1, Math.floor(keep));
  const truncated = list.length > n;
  return { items: truncated ? list.slice(-n) : list, truncated };
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
  /** 名称显示三态 / 视图模式 / 显示别名。 */
  const nameDisplay = (config.nameDisplay as NameDisplay) || "full";
  const viewMode = config.viewMode === "preview" ? "preview" : "list";
  const aliases = useMemo(
    () => (config.aliases && typeof config.aliases === "object" ? (config.aliases as Record<string, string>) : {}),
    [config.aliases]
  );
  const showChips = config.showChips !== false;
  const rememberPath = config.rememberPath !== false;
  // 根目录：实例配置优先，其次全局，最后桌面（null）。
  const rootPath = (config.root as string) || fileBrowserRoot || null;
  /** 锁定根目录：开启后向上/面包屑/深链不得跳出根（钳制回根）。 */
  const lockToRoot = !!config.lockToRoot && !!rootPath;
  // 路径记忆：重启后回到最后浏览的目录（须仍在根下才算数，防止根改了还跳旧路径）。
  // 裸 startsWith 可用 `C:\foo2` 冒充根 `C:\foo`（无分隔符边界），且大小写
  // 敏感（Windows 路径不区分）——归一化后按「等于根 或 以根+\ 开头」判定。
  const isWithinRoot = (candidate: string, root: string) => {
    const norm = (p: string) => p.replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();
    const c = norm(candidate);
    const r = norm(root);
    return c === r || c.startsWith(r.endsWith("\\") ? r : `${r}\\`);
  };
  const initialPath = useRef<string | null>(
    rememberPath && config.lastPath && (!rootPath || isWithinRoot(config.lastPath as string, rootPath))
      ? (config.lastPath as string)
      : rootPath
  ).current;

  const [path, setPath] = useState<string | null>(initialPath);
  // 前进/后退：路径历史栈 + 游标。
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
  // 快捷 chips 的目录映射。
  const [dirs, setDirs] = useState<Record<string, string>>({});
  // 右键菜单：目标条目 + 屏幕坐标；删除需两段确认。
  const [menu, setMenu] = useState<{ x: number; y: number; entry: FileEntry } | null>(null);
  /* 统一弹层退场：关闭后播 .is-closing（ctx-menu-out）再卸载，期间以最后
     一份菜单快照渲染——与 ContextMenu.tsx 全局右键菜单同语言。 */
  const menuVisible = useDelayedUnmount(!!menu, Math.round(animDurations().fxFastMs));
  const lastMenu = useRef(menu);
  if (menu) lastMenu.current = menu;
  const shownMenu = menu ?? lastMenu.current;
  /* 菜单位置视口钳制（同 ContextMenu 面板语义）：屏幕右/下缘右键时向内收，
     此前直接用 clientX/Y，菜单会被窗口边缘裁掉一半。 */
  const menuPos = useViewportClampedPos(shownMenu?.x ?? 0, shownMenu?.y ?? 0);
  const [confirmDel, setConfirmDel] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  /* ---- 批量选择：会话态，
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

  /** 别名感知显示名：别名整体替换（不吃三态裁剪——那是给真实文件名的）。 */
  const nameOf = useMemo(() => {
    const hasAlias = Object.keys(aliases).length > 0;
    return (e: FileEntry): string => {
      const alias = hasAlias ? aliases[e.path] : undefined;
      return alias ?? displayFileName(e.name, nameDisplay);
    };
  }, [aliases, nameDisplay]);

  // 焦点复位（键盘流导航）：列表容器 key 随路径重挂载，焦点会被打到 body——
  // 导航发起时焦点在列表内则标记，换目录后把焦点还给容器（tabIndex=-1）。
  const listHostRef = useRef<HTMLElement | null>(null);
  const restoreFocusRef = useRef(false);
  useEffect(() => {
    if (!restoreFocusRef.current) return;
    restoreFocusRef.current = false;
    requestAnimationFrame(() => listHostRef.current?.focus({ preventScroll: true }));
  }, [path]);

  const navigate = (next: string | null) => {
    // 锁定根目录：越界目标（向上/面包屑/chip 逃出根）钳制回根——点哪儿都
    // 有反馈，不静默忽略。
    let target = next;
    if (lockToRoot && target && !isWithinRoot(target, rootPath!)) target = rootPath;
    if (target === path) return;
    const host = listHostRef.current;
    restoreFocusRef.current = !!host && !!document.activeElement && host.contains(document.activeElement);
    setNavDir(1);
    setPath(target);
    setQuery("");
    // 有界历史：长会话里持续下钻不再无上限增长（游标同步钳制）。
    setHist((h) => {
      const cut = [...h.slice(0, histIdx + 1), target];
      return cut.length > HIST_CAP ? cut.slice(cut.length - HIST_CAP) : cut;
    });
    setHistIdx((i) => Math.min(i + 1, HIST_CAP - 1));
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
  /* 实时同步触发的重拉走静默路径（不闪 loading、
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

  /* ---- 实时文件夹：当前目录登记到 Rust watch，变更
          事件（300ms 静默合并）→ 静默重拉；事件只当脏标记、真相在磁盘，
          前端零对账。绑定失败（网络盘/系统目录等校验不过）或关掉开关 →
          回退 的 20s 可见性轮询。 ---- */
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

  // 目录监听（实时同步不可用时降级为轮询）：窗口可见时每 20s 静默重拉。
  // 只在「开着 liveSync 但 watcher 建立失败」的降级态轮询——用户显式关闭
  // liveSync 时（liveActive=false）同样落入此分支，关闭并不省流量。
  useEffect(() => {
    if (!isTauri() || !liveSync || liveActive) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") setReloadKey((k) => k + 1);
    }, 20000);
    return () => window.clearInterval(timer);
  }, [liveActive, liveSync]);

  // 挂载时取一次常用目录映射。
  useEffect(() => {
    if (!isTauri()) return;
    invoke<Record<string, string>>("known_dirs")
      .then((m) => setDirs(m))
      .catch(() => {});
  }, []);

  // 路径记忆：导航后防抖写入实例配置。写入守卫：挂载首次执行与
  // pickFolder 已写过的值不再重复落盘（少一次配置 JSON 序列化 + 镜像同步）。
  const lastWrittenPath = useRef<string>(typeof config.lastPath === "string" ? config.lastPath : "");
  useEffect(() => {
    if (!rememberPath) return;
    const v = path ?? "";
    if (lastWrittenPath.current === v) return;
    lastWrittenPath.current = v;
    safeTimeout(() => update({ lastPath: v }), 600);
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
    const stripped = path.replace(/[\\/][^\\/]+$/, "");
    // `C:`（无反斜杠）在 Windows 语义是「该盘的当前目录」而非盘根，
    // 列出来的目录不可预期——补反斜杠归一到真正的盘根。
    const parent = /^[A-Za-z]:$/.test(stripped) ? `${stripped}\\` : stripped;
    navigate(parent === path ? null : parent);
  };

  const goHome = () => navigate(rootPath);
  const refresh = () => setReloadKey((k) => k + 1);

  /* 在当前目录就地新建空文件 / 文件夹（带默认名，重名报错）。 */
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
    if (INVALID_NAME_RE.test(name)) {
      void alertDialog({ title: tr("名称不能包含这些字符"), message: '\\ / : * ? " < > |' });
      return;
    }
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

  /* ---- 传输（OS 拖放 / Ctrl+V 粘贴共用）：复制或移动进当前目录，重名由
          Rust 侧自动加 (n) 后缀（资源管理器语义）。 ---- */
  const [transferring, setTransferring] = useState(false);
  const [osOver, setOsOver] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const transferInto = async (sources: string[], cut: boolean) => {
    if (!isTauri() || transferring) return;
    const dir = path ?? rootPath ?? dirs["desktop"];
    if (!dir) {
      void alertDialog({ title: tr("无法确定当前目录") });
      return;
    }
    setTransferring(true);
    try {
      const r = await invoke<{ source: string; dest: string | null; error: string | null }[]>("transfer_into_dir", {
        sources,
        destDir: dir,
        cut
      });
      const ok = r.filter((x) => !x.error).length;
      const fail = r.length - ok;
      refresh();
      if (ok > 0) pushAppToast(cut ? tr("已移动") : tr("已复制"), `${ok}`, "ok");
      if (fail > 0) pushAppToast(cut ? tr("移动失败") : tr("复制失败"), `${fail}`, "error");
    } catch (e) {
      void alertDialog({ title: tr("操作失败"), message: String(e) });
    } finally {
      setTransferring(false);
    }
  };
  const pasteFromClipboard = async () => {
    const clip = getFileClipboard();
    if (clip.paths.length === 0) return;
    await transferInto(clip.paths, clip.mode === "cut");
    if (clip.mode === "cut") clearFileClipboard();
  };
  /* OS 文件拖入（use-os-file-drop 多实例各自命中测试，与快捷方式组件共存）：
     拖到本组件上松手 = 复制进当前目录。 */
  useOsFileDrop((e) => {
    const el = rootRef.current;
    if (!el) return;
    const hit = (x: number, y: number) => {
      const r = el.getBoundingClientRect();
      return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
    };
    if (e.type === "enter" || e.type === "over") {
      setOsOver(hit(e.x, e.y));
    } else if (e.type === "leave") {
      setOsOver(false);
    } else if (e.type === "drop") {
      const inside = hit(e.x, e.y);
      setOsOver(false);
      if (inside && e.paths.length > 0 && isTauri()) void transferInto(e.paths, false);
    }
  });

  // 右键动作。
  const revealEntry = (entry: FileEntry) => {
    void invoke("reveal_in_explorer", { path: entry.path }).catch(() => {});
  };
  const copyPath = async (entry: FileEntry) => {
    // 双路径降级（lib/clipboard）：WebView2 的 Clipboard API 不可用/被拒时回退
    // execCommand，不再静默失败（路径仍显示在 tooltip 中作兜底提示）。
    await copyText(entry.path);
  };
  const renameEntry = async (entry: FileEntry) => {
    const name = await promptDialog({ title: tr("重命名为"), initialValue: entry.name });
    const next = name?.trim();
    if (!next || next === entry.name) return;
    if (INVALID_NAME_RE.test(next)) {
      void alertDialog({ title: tr("名称不能包含这些字符"), message: '\\ / : * ? " < > |' });
      return;
    }
    const dir = entry.path.replace(/[\\/][^\\/]+$/, "");
    const newPath = `${dir}\\${next}`;
    try {
      setBusyId(entry.path);
      await invoke("rename_path", { oldPath: entry.path, newPath });
      // （rename 不迁移 aliases）：别名按路径键控，改名后旧键成孤儿、新路径
      // 显示名回落——成功后迁移到新键。
      if (aliases[entry.path] !== undefined) {
        const nextAliases = { ...aliases };
        nextAliases[newPath] = nextAliases[entry.path];
        delete nextAliases[entry.path];
        update({ aliases: nextAliases });
      }
      refresh();
    } catch (e) {
      void alertDialog({ title: tr("操作失败"), message: String(e) });
    } finally {
      setBusyId(null);
    }
  };
  /* ---- 撤销删除：私有备份恢复（不依赖回收站）。命令失败静默降级——
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

  /* （别名孤儿）：别名按绝对路径键控，删除文件后旧键成孤儿，配置 JSON
     里永久堆积（rename 已迁移、delete 一直没清）。撤销恢复会找回文件但
     找不回别名——别名纯展示态，可接受。 */
  const pruneAliases = (paths: string[]) => {
    if (!paths.some((p) => aliases[p] !== undefined)) return;
    const nextAliases = { ...aliases };
    for (const p of paths) delete nextAliases[p];
    update({ aliases: nextAliases });
  };

  const deleteEntry = async (entry: FileEntry) => {
    try {
      setBusyId(entry.path);
      const r = await invoke<{ ticket: string | null; undoable: boolean }>("delete_with_undo", {
        path: entry.path
      });
      pruneAliases([entry.path]);
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

  /* ---- 批量动作 ---- */
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
  /* ---- 批量删除进度（PoggetMetaManager 的 IsCopying / CurrentFileName /
          CancelCount 三件套等价物）：单 IPC 批命令逐条广播进度（此前前端
          逐条 invoke，N 次往返），取消 = Rust 侧停止发起后续删除。 ---- */
  const [batchRun, setBatchRun] = useState<{ total: number; done: number; current: string } | null>(null);
  const cancelRef = useRef(false);
  useTauriEvent<{ done: number; total: number; current: string; cancelled: boolean }>(
    "files:delete-batch-progress",
    (p) => {
      if (!p) return;
      setBatchRun((cur) => (cur ? { total: p.total, done: p.done, current: p.current } : cur));
    }
  );
  const deleteSelected = async () => {
    if (!isTauri() || selected.size === 0 || batchBusy) return;
    if (!confirmBatchDel) {
      setConfirmBatchDel(true);
      return;
    }
    // 删除清单以选中集为准（全量 entries 取展示名，裸路径兜底）。
    const displayName = (p: string) => entries.find((e) => e.path === p)?.name ?? p.slice(p.lastIndexOf("\\") + 1) ?? p;
    const paths = [...selected];
    const firstName = displayName(paths[0]);
    if (paths.length === 0) return;
    cancelRef.current = false;
    setBatchBusy(true);
    setBatchRun({ total: paths.length, done: 0, current: firstName });
    /** 完成 toast 的「撤销」一次回放整批。 */
    const tickets: string[] = [];
    /** 实际删除成功的路径：批量结束后一并清掉它们的别名键。 */
    const deletedPaths: string[] = [];
    let cancelled = false;
    let failed = 0;
    try {
      const outcomes = await invoke<
        { path: string; ticket: string | null; error: string | null; cancelled: boolean }[]
      >("delete_batch_with_undo", { paths });
      for (const o of outcomes) {
        if (o.ticket) {
          tickets.push(o.ticket);
          deletedPaths.push(o.path);
        } else if (o.cancelled) {
          cancelled = true;
        } else if (o.error) {
          failed++;
        }
      }
      setSelected(new Set());
      setConfirmBatchDel(false);
      pruneAliases(deletedPaths);
      refresh();
      if (cancelled) {
        pushAppToast(tr("已取消删除"), `${tr("已完成")} ${deletedPaths.length}/${paths.length}`, "info");
      } else if (deletedPaths.length === 0) {
        pushAppToast(tr("删除失败"), tr("没有文件被删除"), "error");
      } else {
        pushAppToast(tr("删除完成"), `${deletedPaths.length}`, "ok", {
          action: { label: tr("撤销"), run: () => void undoDelete(tickets) }
        });
      }
      if (failed > 0) pushAppToast(tr("删除失败"), `${failed}`, "error");
    } catch (e) {
      void alertDialog({ title: tr("操作失败"), message: String(e) });
    } finally {
      setBatchRun(null);
      setBatchBusy(false);
    }
  };

  /* ---- 显示别名：只改本实例展示，不碰磁盘。 ---- */
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
  // E-增量窗口：大目录此前每次渲染都现算现排并全量 map 出行。排序收进
  // useMemo 且只随条目/排序设置/别名重算；搜索词仅做保序过滤（与「过滤后
  // 排序」等价），连续击键不再整列重排。挂载走 useIncrementalList 增量窗口。
  const sortedEntries = useMemo(
    () =>
      sortEntries(
        entries.filter((e) => showHidden || !e.name.startsWith(".")),
        sortBy,
        sortOrder,
        nameOf
      ),
    [entries, showHidden, sortBy, sortOrder, nameOf]
  );
  const visible = useMemo(
    () => (q ? sortedEntries.filter((e) => e.name.toLowerCase().includes(q)) : sortedEntries),
    [sortedEntries, q]
  );
  const { items: windowedEntries, scrollRef } = useIncrementalList(visible, {
    initial: 40,
    step: 40,
    // resetKey：换目录重置回首屏窗口；实时同步/搜索引起的长度变化不重置
    //（深滚动位置不再被 20s 轮询或 watch 重拉闪回顶部）。
    resetKey: path ?? "root"
  });
  // 双 ref 合并：焦点复位需要容器节点，滚动监听仍由 hook 的 scrollRef 接管。
  const attachList = useCallback(
    (node: HTMLElement | null) => {
      listHostRef.current = node;
      scrollRef(node);
    },
    [scrollRef]
  );

  /* ---- 预览加载：只对当前
          增量窗口内的条目拉取——图片走 read_image_data_url（含解码上限与
          防图片炸弹），文本走 read_text_preview（头部 2KB）。失败也记入
          attempted，防止渲染循环里反复重试；并发 4 限制 IPC 压力。 ---- */
  const [previews, setPreviews] = useState<Record<string, string>>({});
  /** 预览拉取失败标记（权限/损坏等）：tile 降级图标 + 半透明 + title 提示，
      「还在加载」与「拉不到」从此可区分。 */
  const [previewFailed, setPreviewFailed] = useState<Record<string, boolean>>({});
  const attemptedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    attemptedRef.current = new Set();
    setPreviews({});
    setPreviewFailed({});
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
    // 已实际取回的条目：取消（滚动扩容/切视图触发 cleanup）时，未取回的
    // 条目要从 attempted 回滚——否则它们在本目录内被永久跳过、缩略图再不
    // 出现（attemptedRef 仅换 path 时重置）。
    const fetched = new Set<string>();
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
                .then((r) => [e.path, r, true] as const)
                .catch(() => [e.path, null, false] as const)
            )
        );
        if (cancelled) return;
        const next: Record<string, string> = {};
        const failedNow: Record<string, boolean> = {};
        for (const r of results) {
          if (r[2] && typeof r[1] === "string") {
            next[r[0]] = r[1];
            fetched.add(r[0]);
          } else {
            failedNow[r[0]] = true;
          }
        }
        if (Object.keys(next).length > 0) setPreviews((prev) => ({ ...prev, ...next }));
        if (Object.keys(failedNow).length > 0) setPreviewFailed((prev) => ({ ...prev, ...failedNow }));
      }
    })();
    return () => {
      cancelled = true;
      for (const t of targets) {
        if (!fetched.has(t.path)) attemptedRef.current.delete(t.path);
      }
    };
    // previewSig 驱动（滚动补齐 / 换目录后重拉）；windowedEntries 引用每渲染漂移。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewMode, previewSig]);

  const crumbs = crumbsOf(path);
  const shownCrumbs = truncateCrumbs(crumbs, CRUMB_KEEP);
  /* chips：锁定根目录时隐藏根外快捷项；高亮含嵌套（浏览 chip 目录的子目录
     时保持点亮，不再是仅精确匹配）。 */
  const curPathForChips = path ?? dirs["desktop"] ?? "";
  const chipList = CHIPS.filter((c) => dirs[c.key] && (!lockToRoot || isWithinRoot(dirs[c.key], rootPath!)));
  /** 路径等价比较（正反斜杠/大小写/尾分隔符归一）。 */
  const normEqPath = (a: string, b: string) =>
    a.replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase() ===
    b.replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();

  return (
    <div
      ref={rootRef}
      className={`widget-files${osOver ? " os-drop-over" : ""}${transferring ? " is-transferring" : ""}`}
    >
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
          {/* 批量选择开关（会话态）：进入后点击行 = 勾选，底部浮出批量操作条。 */}
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
          {/* 视图切换：列表 ⇄ 内容预览（持久化到实例配置）。 */}
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
          <button
            className="widget-files-up"
            onClick={goUp}
            disabled={!path || (lockToRoot && normEqPath(path, rootPath!))}
            aria-label={tr("向上")}
            data-interactive
          >
            <ArrowUp size={14} />
          </button>
        </span>
      </div>
      {/* 面包屑：点击任意层级直达；深路径只保留最后 CRUMB_KEEP 段
          （更早的折叠为「…」，点击回根目录），整条路径经容器 title 悬停可见。 */}
      <div className="fb-crumbs" key={path ?? "root"} title={path ?? undefined}>
        {shownCrumbs.truncated && (
          <span className="fb-crumb-group">
            <button
              className="fb-crumb"
              onClick={goHome}
              title={tr("回到根目录")}
              aria-label={tr("回到根目录")}
              data-interactive
            >
              …
            </button>
            <ChevronRight size={11} className="fb-crumb-sep" />
          </span>
        )}
        {shownCrumbs.items.map((c, i) => (
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
      {/* 根目录快捷 chips。 */}
      {showChips && chipList.length > 0 && (
        <div className="fb-chips">
          {chipList.map((c) => (
            <button
              className={`fb-chip${isWithinRoot(curPathForChips, dirs[c.key]) ? " active" : ""}`}
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
            onKeyDown={(e) => {
              // Esc 关搜索（清词收框）：与 FolderPopup 弹层的 Esc 语义对齐。
              if (e.key === "Escape") {
                e.stopPropagation();
                setQuery("");
                setSearching(false);
              }
            }}
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
          viewMode=preview 时渲染内容预览网格（图片缩略图 / 文本前几行 /
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
              <div className="widget-files-empty">
                {q ? tr("无匹配项") : tr("此文件夹为空")}
                {!q && isTauri() && (
                  <button className="widget-files-empty-act" onClick={() => void createEntry(true)} data-interactive>
                    <FolderPlus size={13} /> {tr("新建文件夹")}
                  </button>
                )}
              </div>
            )}
          </>
        );
        /* 行为内公共：选择态点击 = 勾选；键盘 Enter 打开 / Shift+菜单 /
            重命名（资源管理器同款）；Delete 呼出菜单走可见的两段删除确认
            （不做无反馈的键盘直删，防连按误删）；Ctrl+C/X 收进行内文件剪贴板
            （应用内，Ctrl+V 在列表容器上粘贴）。 */
        const activate = (entry: FileEntry) => (selectMode ? toggleSelected(entry.path) : openEntry(entry));
        const onKey = (e: React.KeyboardEvent, entry: FileEntry) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            activate(entry);
          } else if (e.key === "F2") {
            if (!isTauri() || selectMode) return;
            e.preventDefault();
            void renameEntry(entry);
          } else if ((e.ctrlKey || e.metaKey) && (e.key === "c" || e.key === "x")) {
            if (selectMode) return;
            e.preventDefault();
            const cut = e.key === "x";
            setFileClipboard(cut ? "cut" : "copy", [entry.path]);
            pushAppToast(cut ? tr("已剪切") : tr("已复制"), entry.name, "info");
          } else if ((e.key === "F10" && e.shiftKey) || e.key === "ContextMenu" || e.key === "Delete") {
            if (!isTauri()) return;
            e.preventDefault();
            const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
            /* gBCR 视觉坐标 → 布局单位：÷uiZoom（.widget-context-menu 为
               fixed 定位；+4 偏移本就在布局空间，不参与换算）。 */
            const z = uiZoom();
            setMenu({ x: r.left / z + 4, y: r.bottom / z + 4, entry });
          }
        };
        /* 容器级 Ctrl+V：粘贴（复制/剪切）文件剪贴板内容到当前目录。 */
        const onContainerKey = (e: React.KeyboardEvent) => {
          if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "v") {
            e.preventDefault();
            void pasteFromClipboard();
          }
        };
        const onCtx = (e: React.MouseEvent, entry: FileEntry) => {
          if (!isTauri()) return;
          e.preventDefault();
          e.stopPropagation();
          /* clientX/Y 视觉坐标 → 布局单位：÷uiZoom（同上方键盘分支）。 */
          setMenu({ x: e.clientX / uiZoom(), y: e.clientY / uiZoom(), entry });
        };
        if (viewMode === "preview") {
          return (
            <div
              className="widget-files-grid"
              key={path ?? "root"}
              ref={attachList}
              tabIndex={-1}
              style={{ ["--fb-dir" as string]: String(navDir) }}
              onKeyDown={onContainerKey}
            >
              {stateBlock}
              {!loading &&
                !error &&
                windowedEntries.map((entry) => {
                  const Icon = entry.is_dir ? Folder : fileIcon(entry.name);
                  const name = nameOf(entry);
                  const preview = !entry.is_dir ? previews[entry.path] : undefined;
                  const failed = !entry.is_dir && !preview && !!previewFailed[entry.path];
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
                      <span
                        className={`fb-tile-preview${failed ? " is-preview-failed" : ""}`}
                        title={failed ? tr("预览不可用") : undefined}
                      >
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
            ref={attachList}
            tabIndex={-1}
            style={{ ["--fb-dir" as string]: String(navDir) }}
            onKeyDown={onContainerKey}
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
      {/* 批量操作条：选择模式下常驻底部；
          批量执行中切换为进度态（n/total + 当前文件名 + 取消）。 */}
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
                  void invoke("cancel_delete_batch").catch(() => {});
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
          ref={menuPos.ref}
          className={`widget-context-menu${menu ? "" : " is-closing"}`}
          style={{ left: menuPos.pos.x, top: menuPos.pos.y }}
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
          {/* 显示别名：与物理重命名分离——只改本实例展示名，不碰磁盘。 */}
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
