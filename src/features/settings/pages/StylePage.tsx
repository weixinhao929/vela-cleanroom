/**
 * 设置页 · 样式页：2 主题预设（每个自带深 / 浅两套，由「主题模式」选档）、
 * 明暗模式、主色、圆角、模糊与背景玻璃色等外观参数；另设「壁纸」区——
 * 选择壁纸文件夹后可从中一键更换桌面壁纸（Rust SPI_SETDESKWALLPAPER，
 * 真实生效），并按 Windows 个性化背景的方式缓存最近用过的 5 张。
 */
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import {
  AppWindow,
  Check,
  Droplets,
  FolderOpen,
  History,
  Image as ImageIcon,
  Layers,
  Monitor,
  Moon,
  Pipette,
  RotateCw,
  Square,
  StretchHorizontal,
  Sun,
  SunMoon,
  Type,
  Wind,
  ZoomIn
} from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import {
  PRESETS,
  RECENT_WALLPAPERS_MAX,
  applySettings,
  themeEnvOf,
  useSettingsStore,
  DEFAULT_CUSTOM_COLORS,
  type ThemeMode,
  type ThemePreset
} from "../../../store/settings-store";
import {
  PRESET_DEFAULT_OPACITY,
  UI_FONT_STACKS,
  cancelDeferNextThemeApply,
  deferNextThemeApply,
  cancelDeferNextFloatingThemeApply,
  deferNextFloatingThemeApply,
  resolveEffectiveTokens
} from "../../../lib/theme-engine";
import { armThemeInk, consumeThemeInkArm, playThemeInk } from "../../../lib/theme-ink";
import { ColorRow, Dropdown, PresetCard, Segmented, SettingRow } from "../shared";
import { M3Slider as Slider } from "../../../components/ui/M3Slider";
import { useT } from "../../../i18n-lite";
import { FxText } from "../../../lib/fx";
import { pushAppToast } from "../../../components/ToastHost";
import { invoke, isTauri } from "../../../lib/tauri";
import { pickFilePath } from "../../../lib/file-dialog";
import { useWallpaperStore } from "../../../lib/use-wallpaper-theme";
import {
  fetchGalleryManifest,
  installGalleryPreset,
  resolveGalleryManifestUrl,
  type GalleryPreset
} from "../../../lib/preset-gallery";
import { extractPalette, paletteToCustomColors, type ExtractedPalette } from "../../../domain/palette-extract";
import { copyText } from "../../../lib/clipboard";
import { listStylePresets } from "../../../lib/style-presets";

/** 壁纸候选拓展名（list_directory 结果按此过滤）。 */
const IMAGE_EXT = /\.(jpe?g|png|bmp|gif|webp|jfif)$/i;
/** 文件夹网格一次加载的缩略图上限（Rust 批量命令每批 ≤32）。 */
const FOLDER_GRID_CAP = 30;
/** Rust read_image_thumbnails 的单批硬上限（wallpaper.rs take(32)）。 */
const THUMB_BATCH = 32;

/** list_directory 返回项的本页所需字段。 */
type DirEntry = { name: string; path: string; is_dir: boolean };

/* 模块级缩略图缓存（path → 320px PNG dataURL）。每次应用壁纸都会把该路径
   去重置顶进 recentWallpapers → stripPaths 重排 → 若无缓存则 30+ 张全量
   重新 IPC + 解码一遍，且网格整体闪回占位符。缓存命中后只补拉新增路径，
   已解码的图直接复用；容量上限防长会话无限膨胀（约 5 个文件夹的量）。 */
const THUMB_CACHE_CAP = 160;
const thumbCache = new Map<string, string>();

function cacheThumb(path: string, url: string): void {
  if (thumbCache.has(path)) return;
  thumbCache.set(path, url);
  if (thumbCache.size > THUMB_CACHE_CAP) {
    const oldest = thumbCache.keys().next().value;
    if (oldest !== undefined) thumbCache.delete(oldest);
  }
}

/** 批量取缩略图（Rust read_image_thumbnails，单批 ≤32 张 320px PNG）。
 *  路径表超 32 条时自动分批合并结果——页面级合批（最近使用 + 文件夹去重）
 *  后总数可达 35，不分批则第 33 张起静默无缩略图。键按排序归一（recent
 *  置顶重排不触发重拉），缓存命中的条目同步先行供图，仅补拉缺失路径，
 *  完成后增量合并（不清空既有条目，失败时保留缓存）。 */
function useThumbnails(paths: string[]): Record<string, string> {
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  const key = useMemo(() => [...paths].sort().join("|"), [paths]);
  useEffect(() => {
    const list = key ? key.split("|") : [];
    // 先同步吐缓存命中（换页/重排回来时无占位符闪断）。
    const cached: Record<string, string> = {};
    for (const p of list) {
      const hit = thumbCache.get(p);
      if (hit) cached[p] = hit;
    }
    setThumbs(cached);
    const pending = list.filter((p) => !thumbCache.has(p));
    if (!isTauri() || pending.length === 0) return;
    let disposed = false;
    const batches: string[][] = [];
    for (let i = 0; i < pending.length; i += THUMB_BATCH) batches.push(pending.slice(i, i + THUMB_BATCH));
    Promise.all(batches.map((batch) => invoke<(string | null)[]>("read_image_thumbnails", { paths: batch })))
      .then((results) => {
        if (disposed) return;
        const fresh: Record<string, string> = {};
        batches.forEach((batch, bi) => {
          batch.forEach((p, i) => {
            const url = results[bi]?.[i];
            if (url) {
              cacheThumb(p, url);
              fresh[p] = url;
            }
          });
        });
        if (Object.keys(fresh).length > 0) setThumbs((prev) => ({ ...prev, ...fresh }));
      })
      .catch(() => {
        // 拉取失败：保留已供的缓存条目（此前整体清空，网络/IO 抖动一次全网格
        // 闪占位符）；未命中的路径下次键变化自然重试。
      });
    return () => {
      disposed = true;
    };
  }, [key]);
  return thumbs;
}

/**
 * 壁纸缩略图条（「最近使用」与「从文件夹选择」共用）：缩略图由页面级
 * useThumbnails 统一拉取注入（两条 strip 的路径合批去重，同图不重复解码），
 * 点击任一张即应用为桌面壁纸；当前生效的壁纸带勾徽。系统把壁纸转码成
 * TranscodedWallpaper 时无法按路径精确匹配，此时回退匹配「最近经 Vela
 * 应用的一张」（调用方传入的 current 已做该归一）。
 */
function WallpaperStrip({
  paths,
  thumbs,
  current,
  onPick
}: {
  paths: string[];
  thumbs: Record<string, string>;
  current: string;
  onPick: (path: string) => void;
}) {
  const tr = useT();
  return (
    <div className="tm-wallpaper-strip">
      {paths.map((p) => {
        const name = p.split(/[\\/]/).pop() || p;
        const isCurrent = p === current;
        return (
          <button
            key={p}
            type="button"
            className={`tm-wallpaper-thumb-btn${isCurrent ? " current" : ""}`}
            title={name}
            aria-label={`${tr("设为壁纸")}：${name}`}
            aria-pressed={isCurrent}
            onClick={() => onPick(p)}
            data-interactive
          >
            {thumbs[p] ? (
              <img src={thumbs[p]} alt="" loading="lazy" draggable={false} />
            ) : (
              <span className="tm-wallpaper-thumb-placeholder">
                <ImageIcon size={16} />
              </span>
            )}
            {isCurrent && (
              <span className="tm-check-badge">
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="3"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

export function StylePage() {
  // 字段级订阅——外观页只消费样式相关标量与 setter。
  const s = useSettingsStore(
    useShallow((st) => ({
      preset: st.preset,
      themeMode: st.themeMode,
      floatingThemeMode: st.floatingThemeMode,
      setFloatingThemeMode: st.setFloatingThemeMode,
      primaryColor: st.primaryColor,
      customColors: st.customColors,
      zoom: st.zoom,
      font: st.font,
      fontSize: st.fontSize,
      widgetBackground: st.widgetBackground,
      widgetOpacity: st.widgetOpacity,
      settingsWindowOpacity: st.settingsWindowOpacity,
      cornerRadius: st.cornerRadius,
      spacing: st.spacing,
      blur: st.blur,
      wallpaperFolder: st.wallpaperFolder,
      recentWallpapers: st.recentWallpapers,
      setPreset: st.setPreset,
      setThemeMode: st.setThemeMode,
      setCustomColors: st.setCustomColors,
      setPrimaryColor: st.setPrimaryColor,
      setZoom: st.setZoom,
      setFont: st.setFont,
      setFontSize: st.setFontSize,
      setWidgetBackground: st.setWidgetBackground,
      setWidgetOpacity: st.setWidgetOpacity,
      setSettingsWindowOpacity: st.setSettingsWindowOpacity,
      setCornerRadius: st.setCornerRadius,
      setSpacing: st.setSpacing,
      setBlur: st.setBlur,
      setWallpaperFolder: st.setWallpaperFolder,
      pushRecentWallpaper: st.pushRecentWallpaper,
      resetPrimaryColor: st.resetPrimaryColor,
      resetWidgetBackground: st.resetWidgetBackground
    }))
  );
  const tr = useT();
  const presets = Object.keys(PRESETS) as ThemePreset[];

  /* ---- 滴墨晕开（lib/theme-ink）：主题切换水墨过渡 ----
     点击发起的主题切换（预设 / 明暗 / 主色 / 浮窗深浅）在 commit 后接管
     上色时机：defer 拦下本次 SettingsSync 的即时 applySettings 与
     FloatingThemeSync 的分体覆盖重放（否则 token 先行硬切，晕开只剩装饰），
     墨层从点击落点晕开吞没设置窗，覆盖满的瞬间回放 applySettings 换肤
     （浮窗深浅非 follow 时携带分体快照），再沉降淡出。非点击路径（跨窗
     同步、系统明暗跟随）无武装 → 维持即时切换；墨层起不来（无 2d 上下文 /
     减少动态 / 已在播放）则取消 defer 立即上色兜底。 */
  const inkKeyRef = useRef<string | null>(null);
  useEffect(() => {
    const key = `${s.preset}|${s.themeMode}|${s.primaryColor}|${s.floatingThemeMode}|${JSON.stringify(s.customColors)}`;
    const prev = inkKeyRef.current;
    inkKeyRef.current = key;
    if (prev === null || prev === key) return;
    const origin = consumeThemeInkArm();
    if (!origin) return;
    const st = useSettingsStore.getState();
    const reduced =
      !!window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches ||
      !st.extra.enableAnimations ||
      st.extra.animationMode === "reduced";
    if (reduced) return;
    const container = document.querySelector<HTMLElement>(".tm-settings-window");
    if (!container) return;
    // 分体主题：非 follow 时本窗实际生效的是浮窗档，水墨目标色与覆盖满后的
    // 上色快照都要按改写后的快照算（与 FloatingThemeSync 同一口径）。
    const effSt = st.floatingThemeMode !== "follow" ? { ...st, themeMode: st.floatingThemeMode } : st;
    deferNextThemeApply();
    deferNextFloatingThemeApply();
    /* [INK-DUR]：播放时长走设置滑条（默认 1400ms ≈ 原自适应中值）。 */
    const inkDur = st.extra.themeInkDurationMs;
    /* 兜底：onCovered 依赖 rAF/transition 推进，窗口隐藏 / 系统节流 / 动画被打断
       时可能永不触发——defer 标志会一直武装，把之后每一次主题应用都吞掉（主题
       卡旧色直到下一次变更）。限时（时长 + 800ms 余量）未覆盖即取消接管立即
       上色——failsafe 必须盖过播放时长，否则长时长档会被中途掐断换肤。 */
    let covered = false;
    const failsafe = window.setTimeout(() => {
      if (covered) return;
      covered = true;
      cancelDeferNextThemeApply();
      cancelDeferNextFloatingThemeApply();
      const cur = useSettingsStore.getState();
      const eff = cur.floatingThemeMode !== "follow" ? { ...cur, themeMode: cur.floatingThemeMode } : cur;
      applySettings(eff, themeEnvOf(eff), eff.general.reduceEffects);
    }, inkDur + 800);
    const rect = container.getBoundingClientRect();
    const tokens = resolveEffectiveTokens(effSt.preset, effSt.themeMode, effSt.customColors);
    let started = false;
    try {
      started = playThemeInk({
        container,
        origin: {
          // 无点击落点（键盘触发）时回退窗口中心。
          x: origin.x < 0 ? rect.width / 2 : origin.x - rect.left,
          y: origin.y < 0 ? rect.height / 2 : origin.y - rect.top
        },
        colors: {
          bg: tokens.bg,
          ink: tokens.ink,
          accent: /^#[0-9a-f]{3,8}$/i.test(s.primaryColor) ? s.primaryColor : tokens.accent
        },
        opacity: st.settingsWindowOpacity / 100,
        durationMs: inkDur,
        onCovered: () => {
          if (covered) return;
          covered = true;
          window.clearTimeout(failsafe);
          // 携带分体快照统一上色：全局写 + 浮窗覆盖写一次到位（后者的即时
          // 重放已被 defer 吞掉，这里就是本窗口的最终写入者）。
          applySettings(effSt, themeEnvOf(effSt), effSt.general.reduceEffects);
        }
      });
    } catch (err) {
      // 墨层装配抛错：吞掉异常走兜底，绝不留下已设置的 defer 让主题卡旧色。
      console.warn("[theme-ink] play failed:", err);
      started = false;
    }
    if (!started) {
      // 墨层没起来：取消接管并立即上色，主题照常生效。
      window.clearTimeout(failsafe);
      covered = true;
      cancelDeferNextThemeApply();
      cancelDeferNextFloatingThemeApply();
      applySettings(effSt, themeEnvOf(effSt), effSt.general.reduceEffects);
    }
  }, [s.preset, s.themeMode, s.primaryColor, s.floatingThemeMode, s.customColors]);

  /* ---- 壁纸区状态 ---- */
  const wpInfo = useWallpaperStore((w) => w.info);
  /* [INK-DUR]：主题切换水墨时长滑条（300–3000ms，拖动防抖落盘）。 */
  const inkDurationMs = useSettingsStore((st) => st.extra.themeInkDurationMs);
  const setExtraDebounced = useSettingsStore((st) => st.setExtraDebounced);
  const [folderImages, setFolderImages] = useState<string[]>([]);
  /* 文件夹内图片总数（slice 前）——网格只展示前 FOLDER_GRID_CAP 张，
     截断时用真实总数提示「共 N 张，显示前 30 张」，避免误导只有 30 张。 */
  const [folderTotal, setFolderTotal] = useState(0);
  /* 文件夹枚举的刷新 nonce：文件夹内容在会话中变化（新下载图片等）时点
     「刷新」重列，不必重选文件夹。 */
  const [folderNonce, setFolderNonce] = useState(0);
  // 「当前壁纸」判定：路径精确匹配；系统把壁纸转码成 TranscodedWallpaper 时
  // 回退匹配「最近经 Vela 应用的一张」（recent[0]）。
  const transcoded = !!wpInfo && /TranscodedWallpaper/i.test(wpInfo.path);
  const currentWallpaper = wpInfo
    ? transcoded && s.recentWallpapers[0]
      ? s.recentWallpapers[0]
      : wpInfo.path
    : (s.recentWallpapers[0] ?? "");

  // 选择壁纸文件夹 → 记忆到设置（跨窗口同步），并枚举其中的图片。
  const pickWallpaperFolder = async () => {
    if (!isTauri()) return;
    try {
      const path = await invoke<string | null>("pick_folder");
      if (path) s.setWallpaperFolder(path);
    } catch {
      // 用户取消 / 对话框失败：静默。
    }
  };
  useEffect(() => {
    if (!isTauri() || !s.wallpaperFolder) {
      setFolderImages([]);
      setFolderTotal(0);
      return;
    }
    let disposed = false;
    invoke<DirEntry[]>("list_directory", { path: s.wallpaperFolder, showHidden: false })
      .then((list) => {
        if (disposed) return;
        const imgs = list.filter((e) => !e.is_dir && IMAGE_EXT.test(e.name)).map((e) => e.path);
        setFolderTotal(imgs.length);
        setFolderImages(imgs.slice(0, FOLDER_GRID_CAP));
      })
      .catch(() => {
        if (!disposed) {
          setFolderImages([]);
          setFolderTotal(0);
        }
      });
    return () => {
      disposed = true;
    };
  }, [s.wallpaperFolder, folderNonce]);

  /* 页面级合批缩略图：最近使用 + 文件夹两条 strip 的路径去重后一次拉取
     （此前两条 strip 各自 IPC，同一张图在两边时重复解码一次）。 */
  const stripPaths = useMemo(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const p of [...s.recentWallpapers, ...folderImages]) {
      if (p && !seen.has(p)) {
        seen.add(p);
        out.push(p);
      }
    }
    return out;
  }, [s.recentWallpapers, folderImages]);
  const stripThumbs = useThumbnails(stripPaths);

  // 应用壁纸：Rust SPI 真实切换 + 登记「最近使用」（去重置顶、最多 5 张）。
  const applyWallpaper = async (path: string) => {
    if (!isTauri()) return;
    try {
      await invoke("set_desktop_wallpaper", { path });
      s.pushRecentWallpaper(path);
      pushAppToast(tr("壁纸已更换"), path.split(/[\\/]/).pop() || path, "ok");
    } catch (err) {
      pushAppToast(tr("壁纸更换失败"), String(err).replace(/^Error:\s*/, ""), "error");
    }
  };

  // 「浏览照片」：从任意目录挑一张（不限于壁纸文件夹），应用后同样进最近使用。
  const browseWallpaper = async () => {
    try {
      // 过滤器补 jfif（IMAGE_EXT 认它，Windows 相机导出常见，此前选不了）。
      const path = await pickFilePath({
        title: tr("选择壁纸图片"),
        filters: [{ name: tr("图片"), extensions: ["jpg", "jpeg", "png", "bmp", "gif", "webp", "jfif"] }]
      });
      if (path) void applyWallpaper(path);
    } catch {
      // 浏览器模式 / 取消：静默。
    }
  };

  return (
    <>
      {/* 主题切换动效只保留水墨晕开（lib/theme-ink）；原 PixelSwap 像素翻牌
          与水墨叠加观感杂乱（用户反馈「翻转那个不要出现」），已整体移除。 */}
      <section className="tm-section">
        <div className="tm-section-title">
          <FxText text={tr("外观")} />
        </div>
        <div className="tm-preset-grid">
          {presets.map((p, i) => (
            <PresetCard
              key={p}
              id={p}
              selected={s.preset === p}
              onSelect={() => {
                armThemeInk();
                s.setPreset(p);
              }}
              style={{ "--sti": i } as CSSProperties}
            />
          ))}
        </div>
      </section>

      {s.preset === "custom" && (
        <>
          <div className="tm-divider" />
          <section className="tm-section">
            <div className="tm-section-title">{tr("自定义配色")}</div>
            <SettingRow icon={Moon} title="深色档背景" desc="自定义主题深色档的底色">
              <ColorRow
                color={s.customColors.dark.bg}
                onChange={(c) => {
                  armThemeInk();
                  s.setCustomColors({ dark: { bg: c } });
                }}
                onReset={() => {
                  armThemeInk();
                  s.setCustomColors({ dark: { bg: DEFAULT_CUSTOM_COLORS.dark.bg } });
                }}
              />
            </SettingRow>
            <SettingRow icon={Type} title="深色档文字" desc="自定义主题深色档的文字色">
              <ColorRow
                color={s.customColors.dark.ink}
                onChange={(c) => {
                  armThemeInk();
                  s.setCustomColors({ dark: { ink: c } });
                }}
                onReset={() => {
                  armThemeInk();
                  s.setCustomColors({ dark: { ink: DEFAULT_CUSTOM_COLORS.dark.ink } });
                }}
              />
            </SettingRow>
            <SettingRow icon={Sun} title="浅色档背景" desc="自定义主题浅色档的底色">
              <ColorRow
                color={s.customColors.light.bg}
                onChange={(c) => {
                  armThemeInk();
                  s.setCustomColors({ light: { bg: c } });
                }}
                onReset={() => {
                  armThemeInk();
                  s.setCustomColors({ light: { bg: DEFAULT_CUSTOM_COLORS.light.bg } });
                }}
              />
            </SettingRow>
            <SettingRow icon={SunMoon} title="浅色档文字" desc="自定义主题浅色档的文字色">
              <ColorRow
                color={s.customColors.light.ink}
                onChange={(c) => {
                  armThemeInk();
                  s.setCustomColors({ light: { ink: c } });
                }}
                onReset={() => {
                  armThemeInk();
                  s.setCustomColors({ light: { ink: DEFAULT_CUSTOM_COLORS.light.ink } });
                }}
              />
            </SettingRow>
            <SettingRow icon={Pipette} title="强调色" desc="自定义主题的界面强调色（即「主题」区主色）">
              <ColorRow
                color={s.primaryColor}
                onChange={(c) => {
                  armThemeInk();
                  s.setPrimaryColor(c);
                }}
                onReset={() => {
                  armThemeInk();
                  s.resetPrimaryColor();
                }}
              />
            </SettingRow>
          </section>
        </>
      )}

      <div className="tm-divider" />

      <section className="tm-section">
        <div className="tm-section-title">{tr("主题")}</div>
        {/* 行规范示范：三段式（leading 图标芯片 + title/subtitle + trailing） */}
        <SettingRow title="主题模式" desc="选择应用的外观主题" icon={SunMoon}>
          <Segmented<ThemeMode>
            value={s.themeMode}
            onChange={(m) => {
              armThemeInk();
              s.setThemeMode(m);
            }}
            options={[
              { id: "system", label: "系统", icon: Monitor },
              { id: "dark", label: "深色", icon: Moon },
              { id: "light", label: "浅色", icon: Sun }
            ]}
          />
        </SettingRow>
        {/* [SPLIT-THEME]：浮窗（设置窗/速记窗）独立明暗档——
            以改写后的快照在本窗重放同一主题引擎，桌面层不受影响。 */}
        <SettingRow title="浮窗深浅" desc="设置窗口与速记窗的独立明暗档（桌面小组件层不受影响）" icon={AppWindow}>
          <Segmented<"follow" | "light" | "dark">
            value={s.floatingThemeMode}
            onChange={(m) => {
              // 与相邻的主题模式控件同款水墨接管——arm 后由下方 ink
              // effect 统一 defer（全局写 + FloatingThemeSync 覆盖重放），
              // 覆盖满后携带分体快照上色；此前这里是先行硬切，同一页双标。
              armThemeInk();
              s.setFloatingThemeMode(m);
            }}
            options={[
              { id: "follow", label: "跟随全局" },
              { id: "dark", label: "深色", icon: Moon },
              { id: "light", label: "浅色", icon: Sun }
            ]}
          />
        </SettingRow>
        <SettingRow title="主色" desc="自定义界面强调色" icon={Pipette}>
          <ColorRow
            color={s.primaryColor}
            onChange={(c) => {
              armThemeInk();
              s.setPrimaryColor(c);
            }}
            onReset={() => {
              armThemeInk();
              s.resetPrimaryColor();
            }}
          />
        </SettingRow>
        {/* [INK-DUR]：切换动效时长滑条——调小更快、调大更舒展；双击回默认。 */}
        <SettingRow title="主题切换动效" desc="切换主题 / 明暗 / 主色时水墨晕开的时长（越小越快）" icon={Droplets}>
          <Slider
            label="主题切换动效"
            value={inkDurationMs}
            min={300}
            max={3000}
            step={50}
            suffix="ms"
            defaultValue={1400}
            onChange={(v) => setExtraDebounced({ themeInkDurationMs: v })}
          />
        </SettingRow>
      </section>

      <div className="tm-divider" />

      {/* 壁纸：选文件夹 → 列出图片 → 点击真实更换桌面壁纸；最近用过的 5 张
          像 Windows 个性化背景一样缓存在最前面，点一下即可回切。 */}
      <section className="tm-section">
        <div className="tm-section-title">{tr("壁纸")}</div>
        <SettingRow icon={FolderOpen} title="壁纸文件夹" desc={s.wallpaperFolder || "选择一个文件夹，从中挑选桌面壁纸"}>
          <button className="tm-btn-secondary" onClick={() => void pickWallpaperFolder()} data-interactive>
            {tr("选择文件夹")}
          </button>
        </SettingRow>
        {s.recentWallpapers.length > 0 && (
          <div className="tm-setting-row tm-setting-row-stack">
            <div className="tm-setting-text">
              <span className="tm-setting-title">{tr("最近使用")}</span>
              <span className="tm-setting-desc">
                {tr("最近应用过的 {n} 张壁纸，点击即回切").replace(
                  "{n}",
                  String(Math.min(RECENT_WALLPAPERS_MAX, s.recentWallpapers.length))
                )}
              </span>
            </div>
            <WallpaperStrip
              paths={s.recentWallpapers}
              thumbs={stripThumbs}
              current={currentWallpaper}
              onPick={(x) => void applyWallpaper(x)}
            />
          </div>
        )}
        {s.wallpaperFolder && (
          <div className="tm-setting-row tm-setting-row-stack">
            <div className="tm-setting-row-head">
              <div className="tm-setting-text">
                <span className="tm-setting-title">{tr("从文件夹选择")}</span>
                <span className="tm-setting-desc">
                  {folderImages.length > 0
                    ? `${s.wallpaperFolder} · ${
                        /* 截断时展示真实总数（整句模板，避免拼接式破坏英文语序）。 */
                        folderTotal > FOLDER_GRID_CAP
                          ? tr("共 {n} 张图片，显示前 {cap} 张", { n: folderTotal, cap: FOLDER_GRID_CAP })
                          : tr("{n} 张图片", { n: folderTotal })
                      }`
                    : tr("该文件夹中没有可用图片")}
                </span>
              </div>
              {/* 刷新：重列文件夹（新下载 / 删除的图片即时反映，此前只在
                  重选文件夹时才重新枚举）。 */}
              <button
                className="tm-btn-secondary tm-wallpaper-refresh"
                onClick={() => setFolderNonce((v) => v + 1)}
                data-interactive
              >
                <RotateCw size={13} />
                {tr("刷新")}
              </button>
            </div>
            {folderImages.length > 0 && (
              <WallpaperStrip
                paths={folderImages}
                thumbs={stripThumbs}
                current={currentWallpaper}
                onPick={(x) => void applyWallpaper(x)}
              />
            )}
          </div>
        )}
        <SettingRow icon={History} title="浏览照片" desc="从任意位置选择一张图片设为桌面壁纸">
          <button className="tm-btn-secondary" onClick={() => void browseWallpaper()} data-interactive>
            {tr("浏览照片")}
          </button>
        </SettingRow>
      </section>

      <div className="tm-divider" />

      <section className="tm-section">
        <SettingRow title="界面缩放" desc="调整界面整体大小" icon={ZoomIn}>
          <Slider
            label="界面缩放"
            value={s.zoom}
            min={60}
            max={160}
            step={5}
            suffix="%"
            defaultValue={100}
            onChange={s.setZoom}
          />
        </SettingRow>
        <SettingRow title="字体" desc="选择界面字体" icon={Type}>
          <Dropdown
            value={s.font}
            onChange={s.setFont}
            options={[
              { id: "系统", label: "系统默认", fontFamily: UI_FONT_STACKS["系统"] },
              { id: "Segoe UI", label: "Segoe UI", fontFamily: UI_FONT_STACKS["Segoe UI"] },
              { id: "Microsoft YaHei", label: "微软雅黑", fontFamily: UI_FONT_STACKS["Microsoft YaHei"] },
              { id: "PingFang SC", label: "苹方", fontFamily: UI_FONT_STACKS["PingFang SC"] },
              { id: "Noto Sans SC", label: "思源黑体", fontFamily: UI_FONT_STACKS["Noto Sans SC"] },
              { id: "Outfit", label: "Outfit", fontFamily: UI_FONT_STACKS.Outfit },
              { id: "JetBrains Mono", label: "JetBrains Mono", fontFamily: UI_FONT_STACKS["JetBrains Mono"] }
            ]}
          />
        </SettingRow>
        <SettingRow title="字号" desc="调整文字大小" icon={Type}>
          <Slider
            label="字号"
            value={s.fontSize}
            min={80}
            max={140}
            step={5}
            suffix="%"
            defaultValue={100}
            onChange={s.setFontSize}
          />
        </SettingRow>
      </section>

      <div className="tm-divider" />

      <section className="tm-section">
        <div className="tm-section-title">{tr("小组件 主体")}</div>
        <SettingRow title="背景" desc="小组件卡片背景色" icon={Layers}>
          <ColorRow color={s.widgetBackground} onChange={s.setWidgetBackground} onReset={s.resetWidgetBackground} />
        </SettingRow>
        <SettingRow title="不透明度" desc="0 磨砂透视 · 100 不透明" icon={Layers}>
          <Slider
            label="不透明度"
            value={s.widgetOpacity}
            min={0}
            max={100}
            step={1}
            suffix="%"
            /* 默认值跟随当前预设的玻璃质感档（PRESET_DEFAULT_OPACITY）。 */
            defaultValue={PRESET_DEFAULT_OPACITY[s.preset] ?? 55}
            onChange={s.setWidgetOpacity}
          />
        </SettingRow>
        <SettingRow title="圆角" desc="小组件卡片圆角大小" icon={Square}>
          <Slider
            label="圆角"
            value={s.cornerRadius}
            min={0}
            max={40}
            step={2}
            suffix="px"
            defaultValue={24}
            onChange={s.setCornerRadius}
          />
        </SettingRow>
        <SettingRow title="间距" desc="小组件内部边距" icon={StretchHorizontal}>
          <Slider
            label="间距"
            value={s.spacing}
            min={4}
            max={48}
            step={2}
            suffix="px"
            defaultValue={16}
            onChange={s.setSpacing}
          />
        </SettingRow>
        <SettingRow title="毛玻璃模糊" desc="小组件背景模糊强度（0 为实心）" icon={Wind}>
          <Slider
            label="毛玻璃模糊"
            value={s.blur}
            min={0}
            max={60}
            step={2}
            suffix="px"
            defaultValue={32}
            onChange={s.setBlur}
          />
        </SettingRow>
      </section>

      <div className="tm-divider" />

      <section className="tm-section">
        <SettingRow title="设置窗口不透明度" desc="设置窗口自身的透明度（降低可看到桌面背景）" icon={AppWindow}>
          <Slider
            label="设置窗口不透明度"
            value={s.settingsWindowOpacity}
            min={0}
            max={100}
            step={1}
            suffix="%"
            defaultValue={100}
            onChange={s.setSettingsWindowOpacity}
          />
        </SettingRow>
      </section>

      <div className="tm-divider" />

      <ImagePaletteSection />

      <div className="tm-divider" />

      <PresetGallerySection />
    </>
  );
}

/** [PALETTE-IMG]：从任意图片提取主题色板——
 *  选图 → Rust 缩略图（320px dataURL）→ canvas 解码 → median-cut（domain
 *  纯函数）→ 7 档梯度；点击复制 hex，基准色可一键设为界面主色。 */
function ImagePaletteSection() {
  const tr = useT();
  const [palette, setPalette] = useState<ExtractedPalette | null>(null);
  const [error, setError] = useState<string | null>(null);
  /* 五.8 复制反馈态：最近复制的色块 hex + 回退定时器。 */
  const [copiedHex, setCopiedHex] = useState<string | null>(null);
  const copiedTimer = useRef(0);
  /* 复制反馈定时器补卸载清理——设置页 lazy 化后换页卸载更频繁，
     迟到的 setCopiedHex(null) 会打到已卸载组件（setState-after-unmount）。 */
  useEffect(() => () => window.clearTimeout(copiedTimer.current), []);
  const armInk = armThemeInk;
  const setPrimaryColor = useSettingsStore((st) => st.setPrimaryColor);
  const setPreset = useSettingsStore((st) => st.setPreset);
  const setCustomColors = useSettingsStore((st) => st.setCustomColors);

  const pickAndExtract = async () => {
    setError(null);
    setPalette(null);
    try {
      const path = await pickFilePath({
        title: tr("选择要提取色板的图片"),
        filters: [{ name: tr("图片"), extensions: ["png", "jpg", "jpeg", "webp", "bmp", "gif"] }]
      });
      if (!path) return;
      const thumbs = await invoke<(string | null)[]>("read_image_thumbnails", { paths: [path] });
      const dataUrl = thumbs[0];
      if (!dataUrl) throw new Error(tr("无法解码该图片"));
      const img = new Image();
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error(tr("无法解码该图片")));
        img.src = dataUrl;
      });
      const canvas = document.createElement("canvas");
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) throw new Error(tr("无法解码该图片"));
      ctx.drawImage(img, 0, 0);
      const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const p = extractPalette(data);
      if (!p) throw new Error(tr("图片中没有可用的彩色像素"));
      setPalette(p);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <section className="tm-section">
      <div className="tm-section-title">
        <FxText text={tr("从图片提取色板")} />
      </div>
      <SettingRow icon={Pipette} title="提取源图片" desc="从任意图片提取 7 档主题色阶（本机处理，不上传）">
        <button className="tm-btn-secondary" onClick={() => void pickAndExtract()}>
          {tr("选择图片")}
        </button>
      </SettingRow>
      {error && <div className="tm-monitor-msg">{error}</div>}
      {palette && (
        <div className="tm-setting-row tm-setting-row-stack" data-interactive>
          <div className="tm-setting-text">
            <span className="tm-setting-title">{tr("色板")}</span>
            <span className="tm-setting-desc">{tr("点击色块复制 hex；中间档为基准色")}</span>
          </div>
          <div className="tm-palette-strip">
            {palette.shades.map((hex, i) => (
              <button
                key={`${hex}-${i}`}
                className={`tm-palette-swatch${copiedHex === hex ? " copied" : ""}`}
                style={{ background: hex }}
                title={hex}
                onClick={() => {
                  void copyText(hex);
                  /* 五.8 复制反馈：对勾弹入 1.2s（rb-badge-pop 同语言）——此前
                     点击零反馈（copyText 返回值被丢弃），与全项目复制语言脱节。 */
                  setCopiedHex(hex);
                  window.clearTimeout(copiedTimer.current);
                  copiedTimer.current = window.setTimeout(() => setCopiedHex(null), 1200);
                }}
                data-interactive
              >
                <span key={copiedHex === hex ? "ok" : "hex"} className="tm-palette-hex">
                  {copiedHex === hex ? <Check size={11} /> : hex.replace("#", "")}
                </span>
              </button>
            ))}
          </div>
          <div className="tm-palette-actions">
            <button
              className="tm-btn-secondary"
              onClick={() => {
                armInk();
                setPrimaryColor(palette.seed.hex);
              }}
            >
              {tr("设为主色")} {palette.seed.hex}
            </button>
            {/* 整组套用：梯度两端作深浅双档底/文字色 + 基准色作主色，一次
                切到自定义主题（三个 setter 同一点击内提交，React 批处理成
                单次渲染 → 水墨只晕一场）。 */}
            <button
              className="tm-btn-secondary"
              onClick={() => {
                armInk();
                setPreset("custom");
                setCustomColors(paletteToCustomColors(palette));
                setPrimaryColor(palette.seed.hex);
              }}
            >
              {tr("套用为自定义主题")}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

/** [GALLERY]：在线预设画廊——GitHub 仓库当内容
 *  后端，manifest + sha256 强校验下载，导入走既有预设包链路。 */
function PresetGallerySection() {
  const tr = useT();
  const extra = useSettingsStore(useShallow((st) => st.extra));
  const setExtra = useSettingsStore((st) => st.setExtra);
  const [draft, setDraft] = useState(extra.presetGallerySource);
  const [items, setItems] = useState<GalleryPreset[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [installingId, setInstallingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /* 已安装标记：画廊包装的是小组件样式预设（style-presets），同名即已装
     （导入同名跳过，重复点击是无效操作）——按钮置灰 + 成功色徽标。安装
     成功后即时补录；跨窗删除/导入的漂移在 items 变化时重算。 */
  const [installedNames, setInstalledNames] = useState<Set<string>>(() => new Set());
  useEffect(() => {
    setInstalledNames(new Set(listStylePresets().map((p) => p.name)));
  }, [items]);

  /* 跨窗同步跟随：另一窗口改了画廊源（广播进 store）时本地 draft 对齐，
     否则输入框停留旧值、加载按旧源发请求（此前 useState 初值只取一次）。 */
  useEffect(() => {
    setDraft(extra.presetGallerySource);
  }, [extra.presetGallerySource]);

  const commit = () => {
    const v = draft.trim();
    if (v !== extra.presetGallerySource) setExtra({ presetGallerySource: v });
  };

  const load = async () => {
    setBusy(true);
    setError(null);
    try {
      const list = await fetchGalleryManifest(draft);
      if (list.length === 0) setError(tr("画廊清单为空或格式不正确"));
      setItems(list);
    } catch (e) {
      setItems(null);
      setError(`${tr("画廊加载失败：")}${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const install = async (preset: GalleryPreset) => {
    const manifestUrl = resolveGalleryManifestUrl(draft);
    if (!manifestUrl) return;
    setInstallingId(preset.id);
    setError(null);
    try {
      const r = await installGalleryPreset(manifestUrl, preset);
      pushAppToast(tr("预设已安装"), `${r.added} ${tr("项新增")} · ${r.skipped} ${tr("项跳过")}`, "info");
      // 安装成功即补录（added>0 才真正入库；同名跳过时本就已在集合里）。
      if (r.added > 0) setInstalledNames((prev) => new Set(prev).add(preset.name));
    } catch (e) {
      setError(`${tr("安装失败：")}${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setInstallingId(null);
    }
  };

  const fmtSize = (n: number) =>
    n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`;

  return (
    <section className="tm-section">
      <div className="tm-section-title">
        <FxText text={tr("在线预设画廊")} />
      </div>
      {!isTauri() ? (
        <div className="tm-placeholder">{tr("在线画廊仅在桌面应用中可用")}</div>
      ) : (
        <>
          <SettingRow title="画廊源" desc="GitHub 仓库地址，或 gallery-manifest.json 直链" icon={Layers}>
            <input
              className="tm-text-input"
              style={{ width: 280 }}
              value={draft}
              placeholder="https://github.com/user/vela-presets"
              aria-label={tr("画廊源")}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={commit}
              onKeyDown={(e) => {
                if (e.key === "Enter") commit();
              }}
            />
          </SettingRow>
          <div className="tm-setting-row">
            <div className="tm-setting-text">
              <span className="tm-setting-title">{tr("加载画廊")}</span>
              <span className="tm-setting-desc">{tr("拉取清单并列出可安装的预设包（下载强制 sha256 校验）")}</span>
            </div>
            <button className="tm-btn-secondary" onClick={() => void load()} disabled={busy || !draft.trim()}>
              {busy ? tr("加载中…") : tr("加载")}
            </button>
          </div>
          {error && <div className="tm-monitor-msg">{error}</div>}
          {items && items.length > 0 && (
            <div className="tm-gallery-list" data-interactive>
              {items.map((p) => (
                <div key={p.id} className="tm-gallery-card">
                  <div className="tm-gallery-info">
                    <span className="tm-gallery-name">{p.name}</span>
                    {p.desc && <span className="tm-gallery-desc">{p.desc}</span>}
                    {p.size > 0 && <span className="tm-gallery-size">{fmtSize(p.size)}</span>}
                    {installedNames.has(p.name) && <span className="tm-gallery-installed">{tr("已安装")}</span>}
                  </div>
                  <button
                    className="tm-btn-primary"
                    disabled={installingId !== null || installedNames.has(p.name)}
                    onClick={() => void install(p)}
                  >
                    {installingId === p.id ? tr("安装中…") : installedNames.has(p.name) ? tr("已安装") : tr("安装")}
                  </button>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </section>
  );
}
