/**
 * 图库小组件：网格/漂移墙（纯 CSS 动画）两种展示，本地导入图片由
 * Rust 生成缩略图副本，点击打开全屏查看器（Portal + 键盘导航）。
 */
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { ChevronLeft, ChevronRight, Image, Link2, Plus, Trash2, X } from "lucide-react";
import { EmptyState } from "../../components/ui/EmptyState";
import { convertFileSrc } from "@tauri-apps/api/core";
import { invoke, isTauri } from "../../lib/tauri";
import { evictGalleryFiles, loadGallery, persistGallery, trimGallery, type GalleryPhoto } from "../gallery-photos";
import { pickFilePath } from "../../lib/file-dialog";
import { useWidgetConfig } from "../widget-config";
import { useT } from "../../i18n-lite";
import { useDelayedUnmount } from "../../lib/anim";
import { animDurations } from "../../lib/durations";
import { useConfirmAction, useDelayedRemoval } from "../../lib/use-confirm-remove";
import { useTauriEvent } from "../../lib/use-tauri-event";
/* 漂移墙样式原先在 rb.css（只随设置窗懒 chunk 加载），
   而本组件是它唯一消费方（桌面小组件窗）——改走组件附带范式随本 chunk 加载。 */
import "../../styles/gallery-drift.css";

/**
 * `storedPath`：本地图片经 `gallery_import_file` 复制进 app data/gallery 后
 * 的磁盘绝对路径（url 为其 asset 协议地址）。删除时一并清理磁盘文件；
 * 远程 URL 图片无此字段。
 *
 * `thumbUrl`：320px 缩略图的 asset 地址。网格用它、查看器用原图 ——
 * 之前网格直接渲染原图，9 张 4000×3000 手机照片会让浏览器解码近 1 亿像素、
 * 占用数百 MB 位图内存，仅靠 `object-fit: cover` 缩小显示并不能省下解码成本。
 * 老数据没有这个字段，取值时回退到 `url`，无需迁移。
 */
type Photo = GalleryPhoto;

/** 网格用缩略图，缺失时回退原图（远程 URL / avif / 小图都走这条路）。 */
const thumbOf = (p: Photo) => p.thumbUrl || p.url;

const DEMO: Photo[] = [
  { id: "d1", url: "", label: "晨光" },
  { id: "d2", url: "", label: "海岸" },
  { id: "d3", url: "", label: "山峦" },
  { id: "d4", url: "", label: "城市" },
  { id: "d5", url: "", label: "森林" },
  { id: "d6", url: "", label: "星空" }
];

const GRADIENTS = [
  "linear-gradient(135deg,#f6d365,#fda085)",
  "linear-gradient(135deg,#84fab0,#8fd3f4)",
  "linear-gradient(135deg,#a18cd1,#fbc2eb)",
  "linear-gradient(135deg,#fbc2eb,#a6c1ee)",
  "linear-gradient(135deg,#fccb90,#d57eeb)",
  "linear-gradient(135deg,#5ee7df,#b490ca)"
];

function load(instanceId: string): Photo[] {
  const res = loadGallery(instanceId);
  if (!res) return DEMO;
  // 读时截断（导入/备份恢复可带入超量数据），并清理被挤出条目的
  // 磁盘副本 + 落盘截断后的列表，否则孤儿文件永远留在 app data/gallery。
  if (res.evicted.length > 0) {
    evictGalleryFiles(res.evicted);
    persistGallery(instanceId, res.photos);
  }
  return res.photos;
}

export function GalleryWidget({ instanceId }: { instanceId: string }) {
  const tr = useT();
  const [photos, setPhotos] = useState<Photo[]>(() => load(instanceId));
  const [adding, setAdding] = useState(false);
  const [url, setUrl] = useState("");
  const [label, setLabel] = useState("");
  const [viewerIdx, setViewerIdx] = useState<number | null>(null);
  const [failed, setFailed] = useState<Set<string>>(new Set());
  const { config } = useWidgetConfig(instanceId);
  const columns = (config.columns as number) || 3;
  const showTags = config.showTags !== false;
  const gridGap = (config.gap as number) || 8;
  const thumbShape = (config.thumbShape as string) || "rounded";
  /** Drift Wall（）：图片以多列错速漂移的 3D 墙呈现，悬停暂停。 */
  const driftWall = config.driftWall === true;
  // 延迟卸载定时器里读取最新列表用（避免闭包捕获旧 photos）。
  const photosRef = useRef<Photo[]>(photos);
  photosRef.current = photos;
  const markFailed = (id: string) => setFailed((prev) => new Set(prev).add(id));
  const isBroken = (p: Photo) => p.url && failed.has(p.id);

  const viewer = viewerIdx === null ? null : (photos[viewerIdx] ?? null);
  /* 查看器对称退场——关闭后保留 160ms 播淡出（此前入场有动画、Esc 关闭瞬消）。 */
  const viewerVisible = useDelayedUnmount(viewerIdx !== null, animDurations().fxFastMs);
  const viewerClosing = viewerIdx === null && viewerVisible;
  /* 翻页方向（1 下一张 / -1 上一张）：图片按方向滑入，替代 key 重挂的硬换。 */
  const [pageDir, setPageDir] = useState(1);
  const lastViewerRef = useRef<{ photo: Photo } | null>(null);
  if (viewer) lastViewerRef.current = { photo: viewer };
  const shownViewer: Photo | null = viewer ?? (viewerClosing ? (lastViewerRef.current?.photo ?? null) : null);
  const step = (dir: number) => {
    if (viewerIdx === null || photos.length === 0) return;
    setPageDir(dir);
    setViewerIdx((prev) => (prev !== null ? (prev + dir + photos.length) % photos.length : null));
  };

  // 删除当前查看的图片后，将索引收敛到合法范围，避免越界导致查看器异常关闭。
  useEffect(() => {
    if (viewerIdx === null) return;
    if (viewerIdx >= photos.length) {
      setViewerIdx(photos.length === 0 ? null : photos.length - 1);
    }
  }, [photos.length, viewerIdx]);

  // 查看器内支持 ←/→ 切换、Esc 关闭。
  useEffect(() => {
    if (viewerIdx === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowLeft") step(-1);
      else if (e.key === "ArrowRight") step(1);
      else if (e.key === "Escape") setViewerIdx(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewerIdx, photos.length]);

  const { confirmingId: confirmDeleteId, request: confirmRequest } = useConfirmAction();
  /** 退场中的图片：先播 160ms 收拢淡出再真正移除（对齐便签/书签的删除语言）。 */
  const { removingIds: exitingIds, begin: beginExit } = useDelayedRemoval((id) => {
    const victim = photosRef.current.find((x) => x.id === id);
    setPhotos((list) => list.filter((x) => x.id !== id));
    // 本地导入的图片：连同磁盘副本一起清理，避免 app data 越积越大。
    if (victim?.storedPath && isTauri()) {
      void invoke("gallery_delete_file", { path: victim.storedPath }).catch(() => {});
    }
    /* 桌面侧删除此前只写本组件 state（落盘靠下方 photos effect），
       设置窗「图片管理」无从感知，之后在设置页任意提交会以陈旧列表整表
       写回复活已删图片。补同款广播（CustomEvent + tauri sync:gallery，与
       设置页 GalleryConfig.commit 同一套路）；延迟一拍让 photos effect 的
       persistGallery 先落盘，监听方回读才不会读到旧表。 */
    setTimeout(() => {
      window.dispatchEvent(new CustomEvent("focus-desk:gallery-changed", { detail: instanceId }));
      if (isTauri()) {
        void import("@tauri-apps/api/event").then(({ emit }) => emit("sync:gallery", { instanceId })).catch(() => {});
      }
    }, 0);
  }, 160);

  const requestDelete = (id: string) => {
    if (confirmRequest(id)) beginExit(id);
  };

  useEffect(() => {
    // 只存元数据（路径 + 标签），图片字节在磁盘上。
    // （演示数据挂载即持久化）：新实例初始 state 是 DEMO 引用——此前
    // 直接把它写进持久层，之后真导入的图片与假演示条目混存、无法区分。
    // 演示态不落盘；首次真实增删改时（state 已脱离 DEMO）才持久化。
    if (photos === DEMO) return;
    persistGallery(instanceId, photos);
  }, [photos, instanceId]);

  useEffect(() => {
    // 设置页「图片管理」增删图片后热重载列表：本窗口 CustomEvent +
    // 跨窗口 Tauri 事件（设置窗与桌面层是两个 WebView 窗口）。
    const onExternal = (e: Event) => {
      if ((e as CustomEvent).detail === instanceId) setPhotos(load(instanceId));
    };
    window.addEventListener("focus-desk:gallery-changed", onExternal);
    return () => window.removeEventListener("focus-desk:gallery-changed", onExternal);
  }, [instanceId]);
  useTauriEvent<{ instanceId: string }>("sync:gallery", (payload) => {
    if (payload?.instanceId === instanceId) setPhotos(load(instanceId));
  });

  /** 追加并按上限截断（最旧出列；本地导入图连带清理磁盘副本）。
   *  （同 tick 双 append 丢图 + 演示数据混入）：函数式 setState 基于最新
   *  state 截断（photosRef 只在渲染期同步，同一 tick 两次 append 第二次
   *  读到旧基座，第一次的图被覆盖）；演示态追加时整组替换为纯用户数据。
   *  磁盘清理经 microtask 移出 updater（保持纯函数；重复删除无害）。 */
  const appendPhotos = (photo: Photo) => {
    setPhotos((prev) => {
      const base = prev === DEMO ? [] : prev;
      const { kept, evicted } = trimGallery([...base, photo]);
      if (evicted.length > 0) queueMicrotask(() => evictGalleryFiles(evicted));
      return kept;
    });
  };

  const add = () => {
    const u = url.trim();
    if (!u) return;
    appendPhotos({ id: crypto.randomUUID(), url: u, label: label.trim() || tr("图片") });
    setUrl("");
    setLabel("");
    setAdding(false);
  };

  /** 本地图片导入：文件复制进 app data/gallery，localStorage 只留元数据，
   *  显示走 asset 协议 —— 图片字节不再撑爆 localStorage 配额。 */
  const addLocal = async () => {
    if (!isTauri()) return;
    try {
      const picked = await pickFilePath({
        title: tr("选择图片"),
        filters: [{ name: tr("图片"), extensions: ["png", "jpg", "jpeg", "webp", "gif", "bmp", "avif"] }]
      });
      if (!picked) return;
      // 返回 { path, thumb }：thumb 为 null 表示原图本身已足够小或格式无法解码。
      const res = await invoke<{ path: string; thumb: string | null }>("gallery_import_file", {
        path: picked
      });
      appendPhotos({
        id: crypto.randomUUID(),
        url: convertFileSrc(res.path),
        storedPath: res.path,
        thumbUrl: res.thumb ? convertFileSrc(res.thumb) : undefined,
        label: label.trim() || tr("图片")
      });
      setLabel("");
      setUrl("");
      setAdding(false);
    } catch (err) {
      console.error("gallery import failed", err);
    }
  };

  return (
    <div className="gal">
      <div className="gal-head">
        <div className="gal-title">
          <Image size={14} />
          <span>{tr("图库")}</span>
          <span className="gal-count" key={photos.length}>
            {photos.length}
          </span>
        </div>
        <button
          className="gal-add"
          onClick={() => setAdding((a) => !a)}
          aria-label={tr("添加图片")}
          aria-expanded={adding}
          aria-controls={`gal-form-${instanceId}`}
        >
          {adding ? <X size={14} /> : <Plus size={14} />}
        </button>
      </div>

      {adding && (
        <div className="gal-form" id={`gal-form-${instanceId}`}>
          <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder={tr("图片 URL")} data-interactive />
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder={tr("标签（可选）")}
            data-interactive
          />
          <button className="gal-save" onClick={add}>
            {tr("添加")}
          </button>
          {isTauri() && (
            <button
              className="gal-save"
              onClick={() => void addLocal()}
              title={tr("复制到应用图库目录，不占用浏览器存储")}
              data-interactive
            >
              <Link2 size={12} style={{ verticalAlign: -2, marginRight: 4 }} />
              {tr("本地图片")}
            </button>
          )}
        </div>
      )}

      {driftWall ? (
        <DriftWall photos={photos} onOpen={(i) => setViewerIdx(i)} />
      ) : (
        <div className="gal-grid" style={{ gridTemplateColumns: `repeat(${columns}, 1fr)`, gap: gridGap }}>
          {photos.map((p, i) => (
            <div
              className={`gal-tile shape-${thumbShape}${exitingIds.has(p.id) ? " is-closing" : ""}`}
              key={p.id}
              role="button"
              tabIndex={0}
              aria-label={tr(p.label)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  setViewerIdx(i);
                }
              }}
              onClick={() => setViewerIdx(i)}
            >
              {p.url && !isBroken(p) ? (
                <img
                  src={thumbOf(p)}
                  alt={tr(p.label)}
                  loading="lazy"
                  decoding="async"
                  /* 加载完成渐显（data-loaded 由 CSS 过渡消费）；ref 回调兜住
                   「缓存图片在 onLoad 挂上前已 complete」的情况。 */
                  ref={(el) => {
                    if (el && el.complete && el.naturalWidth > 0) el.setAttribute("data-loaded", "1");
                  }}
                  onLoad={(e) => e.currentTarget.setAttribute("data-loaded", "1")}
                  onError={() => markFailed(p.id)}
                />
              ) : (
                <div className="gal-ph" style={{ background: GRADIENTS[i % GRADIENTS.length] }} />
              )}
              {showTags && <span className="gal-label">{tr(p.label)}</span>}
              <button
                className={`gal-del${confirmDeleteId === p.id ? " danger" : ""}`}
                onClick={(e) => {
                  e.stopPropagation();
                  requestDelete(p.id);
                }}
                aria-label={tr("删除")}
                title={confirmDeleteId === p.id ? tr("再次点击确认删除") : tr("删除图片")}
                data-interactive
              >
                {confirmDeleteId === p.id ? <X size={12} /> : <Trash2 size={12} />}
              </button>
            </div>
          ))}
          {photos.length === 0 && <EmptyState text={tr("暂无图片")} hint={tr("从桌面拖入或点上方添加")} compact />}
        </div>
      )}

      {/* Portal to body: the viewer is `position: fixed`, but the widget card
          creates a transform/opacity stacking context (hover scale + card
          opacity) and clips overflow, which would trap + crop the "fullscreen"
          viewer inside the small card. */}
      {viewerVisible &&
        shownViewer &&
        createPortal(
          <div className={`gal-viewer${viewerClosing ? " is-closing" : ""}`} onClick={() => setViewerIdx(null)}>
            <div className="gal-viewer-card" onClick={(e) => e.stopPropagation()}>
              {shownViewer.url && !isBroken(shownViewer) ? (
                <img
                  key={shownViewer.id}
                  className="gal-page-in"
                  data-dir={pageDir}
                  src={shownViewer.url}
                  alt={tr(shownViewer.label)}
                  onError={() => markFailed(shownViewer.id)}
                />
              ) : (
                <div className="gal-viewer-ph" />
              )}
              <span className="gal-viewer-label">{tr(shownViewer.label)}</span>
              <button className="gal-viewer-close" onClick={() => setViewerIdx(null)} aria-label={tr("关闭")}>
                <X size={18} />
              </button>
              {photos.length > 1 && (
                <>
                  <button className="gal-viewer-nav prev" onClick={() => step(-1)} aria-label={tr("上一张")}>
                    <ChevronLeft size={20} />
                  </button>
                  <button className="gal-viewer-nav next" onClick={() => step(1)} aria-label={tr("下一张")}>
                    <ChevronRight size={20} />
                  </button>
                </>
              )}
            </div>
          </div>,
          document.body
        )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Drift Wall（.dev/components/drift-wall 的 CSS 复刻）：        */
/* 三列图片以不同速度/方向纵向漂移，平面带透视倾角，上下边缘羽化遮罩；   */
/* 悬停整墙暂停、单图提亮放大；点击磁贴打开与网格模式同一个查看器。     */
/* ------------------------------------------------------------------ */

function DriftWall({ photos, onOpen }: { photos: Photo[]; onOpen: (i: number) => void }) {
  const COLS = 3;
  const cols: { photo: Photo; idx: number }[][] = Array.from({ length: COLS }, () => []);
  photos.forEach((p, i) => cols[i % COLS].push({ photo: p, idx: i }));
  return (
    <div className="gal-drift">
      <div className="gal-drift-plane">
        {cols.map((col, ci) => (
          <div
            key={ci}
            className={`gal-drift-col${ci % 2 ? " rev" : ""}`}
            style={{ "--dur": `${15 + ci * 5}s` } as CSSProperties}
          >
            {/* 双份内容 + translateY(-50%) 无缝循环；点击回传原始索引。
                第二份为纯视觉克隆：aria-hidden + 不可聚焦，避免读屏重复。 */}
            {[...col, ...col].map(({ photo, idx }, k) => {
              const clone = k >= col.length;
              return (
                <div
                  className="gal-drift-tile"
                  key={`${photo.id}-${k}`}
                  role={clone ? undefined : "button"}
                  tabIndex={k === 0 ? 0 : -1}
                  aria-hidden={clone || undefined}
                  aria-label={photo.label}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      onOpen(idx);
                    }
                  }}
                  onClick={() => onOpen(idx)}
                  title={photo.label}
                >
                  {photo.url ? (
                    <img src={thumbOf(photo)} alt={photo.label} loading="lazy" decoding="async" draggable={false} />
                  ) : (
                    <div className="gal-ph" style={{ background: GRADIENTS[idx % GRADIENTS.length] }} />
                  )}
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
