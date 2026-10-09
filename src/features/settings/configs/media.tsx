/**
 * 媒体/展示类小组件的设置页配置表单（音乐、正在播放、频谱、硬件监控等）：
 * 展示密度、可见指标、音频源与播放行为选项。
 */
import { useEffect, useState } from "react";
import { Trash2 } from "lucide-react";
import { invoke, isTauri } from "../../../lib/tauri";
import { convertFileSrc } from "@tauri-apps/api/core";
import { pickFilePath } from "../../../lib/file-dialog";
import { useT } from "../../../i18n-lite";
import { confirmDialog } from "../../../components/PromptDialog";
import { useSettingsStore, type MediaBehaviorSettings } from "../../../store/settings-store";
import { useMediaSessions } from "../../../lib/media-sessions";
import { useSliderDraft } from "../../../lib/use-slider-draft";
import { useTauriEvent } from "../../../lib/use-tauri-event";
import type { WidgetConfig } from "../../../widget/widget-config";
import {
  evictGalleryFiles,
  loadGallery,
  persistGallery,
  trimGallery,
  type GalleryPhoto
} from "../../../widget/gallery-photos";
import { Stepper, Segmented, SettingToggleRow } from "../shared";
import { M3Slider as Slider } from "../../../components/ui/M3Slider";

export function MusicConfig({
  config,
  update,
  showLayout = true
}: {
  config: WidgetConfig;
  update: (p: Partial<WidgetConfig>) => void;
  showLayout?: boolean;
}) {
  const tr = useT();
  /* 频谱四滑杆（高度/频带/灵敏度/平滑）拖动期只进草稿、松手
     （onCommitEnd）一次 update()——此前逐 input 事件全量走配置写回链。 */
  const visualHeight = useSliderDraft((v) => update({ visualHeight: v }));
  const bandCount = useSliderDraft((v) => update({ bandCount: v }));
  const gain = useSliderDraft((v) => update({ gain: v }));
  const smoothing = useSliderDraft((v) => update({ smoothing: v }));
  return (
    <>
      {/* nowplaying 类型布局被组件锁定为「正在播放」卡片，展示该选项只会误导。 */}
      {showLayout && (
        <div className="tm-setting-row">
          <div className="tm-setting-text">
            <span className="tm-setting-title">{tr("布局方式")}</span>
            <span className="tm-setting-desc">{tr("频谱、正在播放卡片或两者")}</span>
          </div>
          <Segmented
            value={(config.layout as string) || "spectrum"}
            onChange={(v) => update({ layout: v })}
            options={[
              { id: "spectrum", label: "频谱" },
              { id: "nowplaying", label: "正在播放" },
              { id: "both", label: "两者" }
            ]}
          />
        </div>
      )}
      <div className="tm-setting-row">
        <div className="tm-setting-text">
          <span className="tm-setting-title">{tr("检测源")}</span>
          <span className="tm-setting-desc">{tr("采集播放音频、麦克风或两者（麦克风需系统授权并可正常采集）")}</span>
        </div>
        <Segmented
          value={(config.mode as string) || "playback"}
          onChange={(v) => update({ mode: v })}
          options={[
            { id: "playback", label: "播放音频" },
            { id: "microphone", label: "麦克风" },
            { id: "both", label: "两者" }
          ]}
        />
      </div>
      <div className="tm-setting-row">
        <div className="tm-setting-text">
          <span className="tm-setting-title">{tr("可视化样式")}</span>
          <span className="tm-setting-desc">{tr("频谱动画的呈现形式")}</span>
        </div>
        <Segmented
          value={(config.visualStyle as string) || "bars"}
          onChange={(v) => update({ visualStyle: v })}
          options={[
            { id: "bars", label: "频谱条" },
            { id: "wave", label: "波形" },
            { id: "mirror", label: "镜像" },
            { id: "minimal", label: "极简" },
            { id: "radial", label: "环形" },
            { id: "butterfly", label: "蝴蝶" }
          ]}
        />
      </div>
      <div className="tm-setting-row">
        <div className="tm-setting-text">
          <span className="tm-setting-title">{tr("配色模式")}</span>
          <span className="tm-setting-desc">{tr("跟随主题 / 单色 / 彩虹渐变")}</span>
        </div>
        <Segmented
          value={(config.colorMode as string) || "theme"}
          onChange={(v) => update({ colorMode: v })}
          options={[
            { id: "theme", label: "主题色" },
            { id: "mono", label: "单色" },
            { id: "rainbow", label: "彩虹" }
          ]}
        />
      </div>
      <div className="tm-setting-row">
        <div className="tm-setting-text">
          <span className="tm-setting-title">{tr("可视化高度")}</span>
          <span className="tm-setting-desc">{tr("频谱占卡片内容区高度的比例，放大卡片时频谱跟着变大")}</span>
        </div>
        <Slider
          label="可视化高度"
          value={visualHeight.draft ?? ((config.visualHeight as number) || 64)}
          min={10}
          max={100}
          step={5}
          suffix="%"
          onChange={visualHeight.slide}
          onCommitEnd={visualHeight.commitEnd}
        />
      </div>
      <div className="tm-setting-row">
        <div className="tm-setting-text">
          <span className="tm-setting-title">{tr("频带数")}</span>
          <span className="tm-setting-desc">{tr("窄卡片用少、宽卡片用多")}</span>
        </div>
        <Slider
          label="频带数"
          value={bandCount.draft ?? ((config.bandCount as number) || 64)}
          min={16}
          max={96}
          step={8}
          suffix={tr("根")}
          onChange={bandCount.slide}
          onCommitEnd={bandCount.commitEnd}
        />
      </div>
      <div className="tm-setting-row">
        <div className="tm-setting-text">
          <span className="tm-setting-title">{tr("灵敏度")}</span>
          <span className="tm-setting-desc">{tr("小音量场景把频谱抬起来")}</span>
        </div>
        <Slider
          label="灵敏度"
          value={gain.draft ?? (config.gain as number) ?? 1}
          min={0.5}
          max={3}
          step={0.1}
          suffix="×"
          onChange={gain.slide}
          onCommitEnd={gain.commitEnd}
        />
      </div>
      <div className="tm-setting-row">
        <div className="tm-setting-text">
          <span className="tm-setting-title">{tr("平滑度")}</span>
          <span className="tm-setting-desc">{tr("越高动画越柔和但响应越慢")}</span>
        </div>
        <Slider
          label="平滑度"
          value={smoothing.draft ?? (config.smoothing as number) ?? 0.5}
          min={0}
          max={1}
          step={0.05}
          onChange={smoothing.slide}
          onCommitEnd={smoothing.commitEnd}
        />
      </div>
      <div className="tm-setting-row">
        <div className="tm-setting-text">
          <span className="tm-setting-title">{tr("频带分布")}</span>
          <span className="tm-setting-desc">{tr("log 音乐低频细分 / linear 语音均匀")}</span>
        </div>
        <Segmented
          value={(config.dist as string) || "log"}
          onChange={(v) => update({ dist: v })}
          options={[
            { id: "log", label: "对数" },
            { id: "linear", label: "线性" }
          ]}
        />
      </div>
      <SettingToggleRow
        title={tr("显示状态文字")}
        desc={tr("频谱下方的监听状态与来源提示行，隐藏后仅保留频谱")}
        on={config.showStatusText !== false}
        onChange={(v) => update({ showStatusText: v })}
      />
      <SettingToggleRow
        title={tr("透明（无底板）")}
        desc={tr("去掉小组件底板，只显示频谱与播放内容（对齐时钟透明模式）")}
        on={config.transparent === true}
        onChange={(v) => update({ transparent: v })}
      />
      <SettingToggleRow
        title="峰值保持"
        desc="每根条上方显示缓慢下落的峰值帽线"
        on={config.peakHold === true}
        onChange={(v) => update({ peakHold: v })}
      />
      <p className="tm-note">{tr("提示：点击频谱区域可快速切换系统静音；「正在播放」卡片右键可选择播放源。")}</p>
    </>
  );
}

/**
 * 「正在播放」独立类型（nowplaying）的设置段。卡片布局被组件锁定、不渲染
 * 频谱——此前借用 MusicConfig 展示的一排频谱字段对它全是死控件，这里只收
 * 真正生效的卡片开关（对齐同类媒体浮窗 媒体浮窗设置页的项位）。
 * 独占播放是全局媒体行为（general.media，App 单向推送 Rust watcher）：
 * 此处与卡片右键菜单读写同一份 store（双入口同源，灵动岛设置同款模式）。
 */
export function NowPlayingConfig({
  config,
  update
}: {
  config: WidgetConfig;
  update: (p: Partial<WidgetConfig>) => void;
}) {
  const tr = useT();
  const media = useSettingsStore((s) => s.general.media);
  const pauseOthers = media?.pauseOthers ?? false;
  const focusPause = media?.focusPause === true;
  return (
    <>
      <SettingToggleRow
        title={tr("独占播放")}
        desc={tr("某播放源开播时自动暂停其余在播播放源")}
        on={pauseOthers}
        onChange={(v) => patchMediaBehavior({ pauseOthers: v })}
      />
      <SettingToggleRow
        title={tr("专注时暂停音乐")}
        desc={tr("专注开始自动暂停在播媒体，结束或休息时智能恢复（别的播放器在播则不顶掉）")}
        on={focusPause}
        onChange={(v) => patchMediaBehavior({ focusPause: v })}
      />
      <SettingToggleRow
        title={tr("标题与歌手居中")}
        desc={tr("关闭时标题与歌手左对齐")}
        on={config.centerTitle === true}
        onChange={(v) => update({ centerTitle: v })}
      />
      <SettingToggleRow
        title={tr("显示进度条")}
        desc={tr("隐藏后播放控制仍在，仅收起可点/可拖的进度行")}
        on={config.showSeekbar !== false}
        onChange={(v) => update({ showSeekbar: v })}
      />
      <SettingToggleRow
        title={tr("显示随机/循环按钮")}
        desc={tr("播放器上报对应能力时出现在卡片上，与音乐沉浸页同款")}
        on={config.showModeButtons !== false}
        onChange={(v) => update({ showModeButtons: v })}
      />
      <SettingToggleRow
        title={tr("滚轮调节应用音量")}
        desc={tr("在卡片上滚动滚轮步进当前播放源的应用音量")}
        on={config.wheelVolume !== false}
        onChange={(v) => update({ wheelVolume: v })}
      />
      <SettingToggleRow
        title={tr("透明（无底板）")}
        desc={tr("去掉小组件底板，只显示封面、文字与控制键（对齐时钟透明模式）")}
        on={config.transparent === true}
        onChange={(v) => update({ transparent: v })}
      />
      <p className="tm-note">
        {tr("提示：右键卡片或点卡片上的齿轮可锁定播放源、维护已隐藏播放源；不支持的控件会按播放器上报的能力自动置灰。")}
      </p>
    </>
  );
}

/**
 * （同型）：general.media 是整节替换切片（setGeneral → sync:settings
 * 广播 → 各窗 applySettings 整对象覆盖）。写前必须现取最新基底再合并本次
 * 变更——渲染闭包快照会把在途的跨窗写入（如桌面层右键「隐藏播放源」的
 * blockedSessions）整节回退。设置页两个分区与卡片右键菜单（MusicWidget
 * 内联同款）三入口统一口径。
 */
function patchMediaBehavior(patch: Partial<MediaBehaviorSettings>): void {
  const { setGeneral, general } = useSettingsStore.getState();
  setGeneral({ media: { ...general.media, ...patch } });
}

/**
 * 全局媒体行为（general.media）的常规页常驻分区。此前唯一表单入口
 * 挂在「正在播放」实例配置页——删光音频监控/正在播放小组件后，「独占播放」
 * 等全局行为仍在 Rust watcher 里持续生效，却没有任何 UI 能关掉（设置搜索
 * 也搜不到）。与实例配置页、卡片右键菜单读写同一份 store（三入口同源）。
 * 黑名单复用共享会话订阅（Rust 的 media:sessions 已扩投到设置窗）。
 */
export function MediaBehaviorConfig() {
  const tr = useT();
  const media = useSettingsStore((s) => s.general.media);
  const pauseOthers = media?.pauseOthers ?? false;
  const focusPause = media?.focusPause === true;
  const blockedIds = media?.blockedSessions ?? [];
  const { sessions } = useMediaSessions(true);
  const setBlocked = (list: string[]) => patchMediaBehavior({ blockedSessions: list });
  /* 播放源按「可见 → 已隐藏」排序：隐藏入口常用在前，已隐藏项沉底便于恢复。 */
  const ordered = [...sessions].sort((a, b) => Number(!!a.blocked) - Number(!!b.blocked));
  return (
    <>
      <SettingToggleRow
        title={tr("独占播放")}
        desc={tr("某播放源开播时自动暂停其余在播播放源")}
        on={pauseOthers}
        onChange={(v) => patchMediaBehavior({ pauseOthers: v })}
      />
      <SettingToggleRow
        title={tr("专注时暂停音乐")}
        desc={tr("专注开始自动暂停在播媒体，结束或休息时智能恢复（别的播放器在播则不顶掉）")}
        on={focusPause}
        onChange={(v) => patchMediaBehavior({ focusPause: v })}
      />
      {ordered.length > 0 && (
        <>
          <div className="tm-setting-row">
            <div className="tm-setting-text">
              <span className="tm-setting-title">{tr("隐藏播放源")}</span>
              <span className="tm-setting-desc">{tr("被隐藏的应用不参与会话选择，也不被媒体功能打扰")}</span>
            </div>
          </div>
          {ordered.map((s) => (
            <div className="tm-setting-row" key={s.id}>
              <div className="tm-setting-text">
                <span className="tm-setting-title">
                  {s.name}
                  {s.blocked ? ` · ${tr("已隐藏")}` : ""}
                </span>
                <span className="tm-setting-desc">{s.playing ? tr("正在播放") : s.id}</span>
              </div>
              <button
                className="tm-btn-secondary"
                onClick={() =>
                  s.blocked ? setBlocked(blockedIds.filter((b) => b !== s.id)) : setBlocked([...blockedIds, s.id])
                }
              >
                {s.blocked ? tr("恢复") : tr("隐藏")}
              </button>
            </div>
          ))}
        </>
      )}
      <p className="tm-note">{tr("这些是全局媒体行为，对所有正在播放/音频监控小组件生效。")}</p>
    </>
  );
}

export function GalleryConfig({
  config,
  update,
  instanceId
}: {
  config: WidgetConfig;
  update: (p: Partial<WidgetConfig>) => void;
  instanceId: string;
}) {
  const tr = useT();
  const [photos, setPhotos] = useState<GalleryPhoto[]>(() => loadGallery(instanceId)?.photos ?? []);
  const [urlText, setUrlText] = useState("");
  /* 链接输入的行内错误提示（非法 URL / 重复添加），输入即清除。 */
  const [urlError, setUrlError] = useState<string | null>(null);
  /* 间距滑杆走草稿、松手一次 update()。 */
  const gap = useSliderDraft((v) => update({ gap: v }));

  /** 写回 localStorage 并广播：本窗口走 CustomEvent，设置窗 ↔ 桌面层跨窗
      口走 Tauri 事件（与 widget-config 的 sync:widget-config 同一套路）。
      写入统一经 trimGallery 截断（与桌面组件同上限），被挤出的本地
      导入图连带清理磁盘副本。
      (a)：写前现读权威 loadGallery 为基底再应用本次变更（对齐
      ShortcutsConfig「写前现读」口径）——渲染闭包里的 photos 在确认
      对话框 / 文件选择等异步间隙可能已被桌面侧删除更新，拿它当基底整表
      写回会把已删图片复活。 */
  const commit = (apply: (base: GalleryPhoto[]) => GalleryPhoto[]) => {
    const base = loadGallery(instanceId)?.photos ?? [];
    const { kept, evicted } = trimGallery(apply(base));
    evictGalleryFiles(evicted);
    setPhotos(kept);
    persistGallery(instanceId, kept);
    window.dispatchEvent(new CustomEvent("focus-desk:gallery-changed", { detail: instanceId }));
    if (isTauri()) {
      void import("@tauri-apps/api/event").then(({ emit }) => emit("sync:gallery", { instanceId })).catch(() => {});
    }
  };

  /* (b)：监听外部变更（桌面图库组件删除图片后 GalleryWidget 广播同款
      CustomEvent + sync:gallery）重读列表，保持本地面与权威存储一致。 */
  useEffect(() => {
    const onExternal = (e: Event) => {
      if ((e as CustomEvent).detail === instanceId) setPhotos(loadGallery(instanceId)?.photos ?? []);
    };
    window.addEventListener("focus-desk:gallery-changed", onExternal);
    return () => window.removeEventListener("focus-desk:gallery-changed", onExternal);
  }, [instanceId]);
  useTauriEvent<{ instanceId: string }>("sync:gallery", (payload) => {
    if (payload?.instanceId === instanceId) setPhotos(loadGallery(instanceId)?.photos ?? []);
  });

  // 装载时收敛导入/备份恢复带入的超量列表。commit 稳定性无意义
  // （组件无其它提交源），只随 instanceId 跑一次。
  useEffect(() => {
    const res = loadGallery(instanceId);
    if (!res || res.evicted.length === 0) return;
    evictGalleryFiles(res.evicted);
    commit(() => res.photos);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instanceId]);

  const addUrl = () => {
    const text = urlText.trim();
    if (!text) return;
    /* ShortcutsConfig 同款归一化——无 scheme 的裸域名补 https://，
       归一化后仍解析失败 / 与现有图片按 url 去重时行内提示，不入库。 */
    const url = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`;
    try {
      new URL(url);
    } catch {
      setUrlError(tr("请输入有效的图片链接"));
      return;
    }
    const base = loadGallery(instanceId)?.photos ?? [];
    if (base.some((p) => p.url === url)) {
      setUrlError(tr("该图片链接已存在，请勿重复添加"));
      return;
    }
    commit((list) => [...list, { id: crypto.randomUUID(), url, label: tr("图片") }]);
    setUrlText("");
  };

  const addLocal = async () => {
    if (!isTauri()) return;
    try {
      const picked = await pickFilePath({
        title: tr("选择图片"),
        filters: [{ name: tr("图片"), extensions: ["png", "jpg", "jpeg", "webp", "gif", "bmp", "avif"] }]
      });
      if (!picked) return;
      const res = await invoke<{ path: string; thumb: string | null }>("gallery_import_file", { path: picked });
      commit((list) => [
        ...list,
        {
          id: crypto.randomUUID(),
          url: convertFileSrc(res.path),
          storedPath: res.path,
          thumbUrl: res.thumb ? convertFileSrc(res.thumb) : undefined,
          label: picked.split(/[\\/]/).pop() || tr("图片")
        }
      ]);
    } catch {
      // 取消或导入失败：保持现状
    }
  };

  const removePhoto = async (id: string) => {
    const victim = photos.find((p) => p.id === id);
    /* 本地导入的图片会连同磁盘文件一起物理删除（不可恢复），必须确认。 */
    if (victim?.storedPath) {
      const ok = await confirmDialog({
        title: tr("删除图片"),
        message: tr("本地图片文件将被一并从磁盘删除，无法恢复。"),
        confirmLabel: tr("删除"),
        danger: true
      });
      if (!ok) return;
    }
    commit((list) => list.filter((p) => p.id !== id));
    if (victim?.storedPath && isTauri()) {
      void invoke("gallery_delete_file", { path: victim.storedPath }).catch(() => {});
    }
  };

  return (
    <>
      <SettingToggleRow
        title="漂移墙"
        desc="Drift Wall：图片以多列错速漂移的 3D 墙呈现（悬停暂停，点击查看大图）"
        on={config.driftWall === true}
        onChange={(v) => update({ driftWall: v })}
      />
      <div className="tm-setting-row">
        <div className="tm-setting-text">
          <span className="tm-setting-title">{tr("每行列数")}</span>
          <span className="tm-setting-desc">{tr("图库网格的列数（漂移墙模式下固定三列）")}</span>
        </div>
        <Stepper
          value={(config.columns as number) || 3}
          suffix="列"
          onChange={(v) => update({ columns: Math.max(2, Math.min(6, v)) })}
        />
      </div>
      <div className="tm-setting-row">
        <div className="tm-setting-text">
          <span className="tm-setting-title">{tr("间距")}</span>
          <span className="tm-setting-desc">{tr("缩略图之间的空隙")}</span>
        </div>
        <Slider
          label="间距"
          value={gap.draft ?? ((config.gap as number) || 8)}
          min={2}
          max={24}
          step={2}
          suffix="px"
          onChange={gap.slide}
          onCommitEnd={gap.commitEnd}
        />
      </div>
      <div className="tm-setting-row">
        <div className="tm-setting-text">
          <span className="tm-setting-title">{tr("缩略图形状")}</span>
          <span className="tm-setting-desc">{tr("缩略图四角的圆润程度")}</span>
        </div>
        <Segmented
          value={(config.thumbShape as string) || "rounded"}
          onChange={(v) => update({ thumbShape: v })}
          options={[
            { id: "square", label: "直角" },
            { id: "rounded", label: "圆角" },
            { id: "circle", label: "圆形" }
          ]}
        />
      </div>
      <SettingToggleRow
        title="显示标签"
        desc="在图片上显示标签"
        on={config.showTags !== false}
        onChange={(v) => update({ showTags: v })}
      />

      <div className="tm-divider" />

      <div className="tm-setting-row">
        <div className="tm-setting-text">
          <span className="tm-setting-title">{tr("图片管理")}</span>
          <span className="tm-setting-desc">{tr("在这里添加的图片会同步到图库小组件")}</span>
        </div>
      </div>
      <div className="tm-shortcut-actions">
        {isTauri() && (
          <button className="tm-btn-secondary" onClick={() => void addLocal()} data-interactive>
            {tr("添加本地图片")}
          </button>
        )}
      </div>
      <div className="tm-link-add">
        <input
          className="tm-text-input"
          value={urlText}
          onChange={(e) => {
            setUrlText(e.target.value);
            setUrlError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") addUrl();
          }}
          placeholder={tr("粘贴图片 URL…")}
          aria-label={tr("添加图片链接")}
          aria-invalid={urlError ? true : undefined}
          data-interactive
        />
        <button className="tm-btn-secondary" onClick={addUrl} data-interactive>
          {tr("添加链接")}
        </button>
      </div>
      {/* 非法 / 重复链接的行内提示（复用条件输入的错误文案样式）。 */}
      {urlError && <span className="auto-cond-error">{urlError}</span>}
      {photos.length > 0 && (
        <div className="tm-shortcut-list">
          {photos.map((p) => (
            <div className="tm-shortcut-item" key={p.id}>
              <span className="tm-shortcut-kind folder">{tr("图片")}</span>
              <span className="tm-shortcut-path" title={p.label}>
                {p.label}
              </span>
              <button
                className="tm-shortcut-del"
                onClick={() => void removePhoto(p.id)}
                aria-label={tr("删除图片")}
                data-interactive
              >
                <Trash2 size={14} />
              </button>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

/** 速写小组件配置：默认画笔大小与导出质量（JPEG 质量百分比）。 */
export function SketchConfig({ config, update }: { config: WidgetConfig; update: (p: Partial<WidgetConfig>) => void }) {
  const tr = useT();
  /* 画笔大小 / 导出质量两滑杆走草稿、松手一次 update()。 */
  const defaultBrushSize = useSliderDraft((v) => update({ defaultBrushSize: v }));
  const exportQuality = useSliderDraft((v) => update({ exportQuality: Math.round(v * 100) / 100 }));
  return (
    <>
      <div className="tm-setting-row">
        <div className="tm-setting-text">
          <span className="tm-setting-title">{tr("默认画笔大小")}</span>
          <span className="tm-setting-desc">{tr("新建涂鸦时的默认画笔粗细")}</span>
        </div>
        <Slider
          label="默认画笔大小"
          value={defaultBrushSize.draft ?? ((config.defaultBrushSize as number) || 3)}
          min={1}
          max={20}
          step={1}
          suffix="px"
          onChange={defaultBrushSize.slide}
          onCommitEnd={defaultBrushSize.commitEnd}
        />
      </div>
      <div className="tm-setting-row">
        <div className="tm-setting-text">
          <span className="tm-setting-title">{tr("默认颜色")}</span>
          <span className="tm-setting-desc">{tr("新建涂鸦时的默认画笔颜色")}</span>
        </div>
        <Segmented
          value={(config.defaultColor as string) || "white"}
          onChange={(v) => update({ defaultColor: v })}
          options={[
            { id: "white", label: "白色" },
            { id: "gray", label: "灰色" },
            { id: "blue", label: "蓝色" },
            { id: "green", label: "绿色" }
          ]}
        />
      </div>
      <div className="tm-setting-row">
        <div className="tm-setting-text">
          <span className="tm-setting-title">{tr("画布背景")}</span>
          <span className="tm-setting-desc">{tr("透明画布导出 PNG 时保留透明度")}</span>
        </div>
        <Segmented
          value={(config.bgMode as string) || "grid"}
          onChange={(v) => update({ bgMode: v })}
          options={[
            { id: "transparent", label: "透明" },
            { id: "grid", label: "网格" },
            { id: "white", label: "白底" },
            { id: "dark", label: "深色" }
          ]}
        />
      </div>
      <div className="tm-setting-row">
        <div className="tm-setting-text">
          <span className="tm-setting-title">{tr("JPEG 导出质量")}</span>
          <span className="tm-setting-desc">{tr("导出 JPEG 时的压缩质量")}</span>
        </div>
        <Slider
          label="JPEG 导出质量"
          value={exportQuality.draft ?? ((config.exportQuality as number) || 0.92)}
          min={0.5}
          max={1}
          step={0.02}
          suffix=""
          onChange={exportQuality.slide}
          onCommitEnd={exportQuality.commitEnd}
        />
      </div>
    </>
  );
}

export function ColorPickerConfig({
  config,
  update
}: {
  config: WidgetConfig;
  update: (p: Partial<WidgetConfig>) => void;
}) {
  const tr = useT();
  return (
    <>
      <SettingToggleRow
        title="自动复制"
        desc="选色时自动把 HEX 复制到剪贴板"
        on={!!config.autoCopy}
        onChange={(v) => update({ autoCopy: v })}
      />
      <SettingToggleRow
        title="显示 HEX"
        desc="显示并支持复制 HEX 值"
        on={config.showHex !== false}
        onChange={(v) => update({ showHex: v })}
      />
      <SettingToggleRow
        title="显示 RGB"
        desc="显示并支持复制 RGB 值"
        on={config.showRgb !== false}
        onChange={(v) => update({ showRgb: v })}
      />
      <SettingToggleRow
        title="显示 HSL"
        desc="显示并支持复制 HSL 值"
        on={config.showHsl !== false}
        onChange={(v) => update({ showHsl: v })}
      />
      <SettingToggleRow
        title="显示 HSV"
        desc="设计师常用的 HSB 色值"
        on={!!config.showHsv}
        onChange={(v) => update({ showHsv: v })}
      />
      <SettingToggleRow
        title="显示 CMYK"
        desc="印刷用四色分量的近似换算"
        on={!!config.showCmyk}
        onChange={(v) => update({ showCmyk: v })}
      />
      <SettingToggleRow
        title="显示 RGBA"
        desc="带透明度滑杆的 RGBA 值"
        on={!!config.showRgba}
        onChange={(v) => update({ showRgba: v })}
      />
      <SettingToggleRow
        title="显示 CSS 变量"
        desc="复制即用的 CSS 自定义属性写法"
        on={!!config.showCssVar}
        onChange={(v) => update({ showCssVar: v })}
      />
      <SettingToggleRow
        title="显示历史颜色"
        desc="在下方显示最近选过的颜色，可固定/删除"
        on={config.showHistory !== false}
        onChange={(v) => update({ showHistory: v })}
      />
      <div className="tm-setting-row">
        <div className="tm-setting-text">
          <span className="tm-setting-title">{tr("历史容量")}</span>
          <span className="tm-setting-desc">{tr("固定到历史中的颜色不会被自动淘汰")}</span>
        </div>
        <Stepper
          value={(config.historyCap as number) || 8}
          suffix=" 色"
          onChange={(v) => update({ historyCap: Math.min(24, Math.max(4, Math.round(v))) })}
        />
      </div>
    </>
  );
}
