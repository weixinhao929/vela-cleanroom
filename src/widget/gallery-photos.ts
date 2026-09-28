/**
 * 图库图片列表的共享存储与上限（G12）：桌面小组件（GalleryWidget）与
 * 设置页「图片管理」（settings/configs/media）此前各自解析同一份
 * localStorage 元数据，且都无上限——图片字节虽已外置磁盘，但条目数随
 * 年头无限增长：localStorage 元数据膨胀 + 网格一次性渲染全部瓦片的
 * DOM/解码成本。收敛到本模块统一读写并截断，双方行为一致。
 */
import { invoke, isTauri } from "../lib/tauri";
import { persistMirrored } from "../lib/local-backup";

export type GalleryPhoto = {
  id: string;
  url: string;
  label: string;
  /** 本地导入图的磁盘绝对路径（删除时一并清理，见 gallery_delete_file）。 */
  storedPath?: string;
  /** 320px 缩略图地址（网格用，缺失回退 url）。 */
  thumbUrl?: string;
};

/** 每实例图片条数上限：超出按最旧出列。缩略图已控住单图内存，200 张
 *  网格瓦片（懒加载 img）是流畅渲染与长年积累之间的平衡点。 */
export const GALLERY_CAP = 200;

export function galleryKey(instanceId: string): string {
  return `focus-desk.gallery.${instanceId}`;
}

/** 读取结果：photos 为截断后的列表；evicted 为读时被挤出的超量条目
 *  （导入/备份恢复可带入超量数据），调用方须传给 {@link evictGalleryFiles}
 *  清理磁盘副本并落盘截断后的列表。null 表示键不存在（回落演示数据）。 */
export type LoadedGallery = { photos: GalleryPhoto[]; evicted: GalleryPhoto[] } | null;

export function loadGallery(instanceId: string): LoadedGallery {
  try {
    const raw = localStorage.getItem(galleryKey(instanceId));
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    const { kept, evicted } = trimGallery(parsed as GalleryPhoto[]);
    return { photos: kept, evicted };
  } catch {
    return null;
  }
}

/** 截断到上限：保留最新（尾部追加序），返回被挤出的条目。 */
export function trimGallery(list: GalleryPhoto[]): { kept: GalleryPhoto[]; evicted: GalleryPhoto[] } {
  if (list.length <= GALLERY_CAP) return { kept: list, evicted: [] };
  const overflow = list.length - GALLERY_CAP;
  return { kept: list.slice(overflow), evicted: list.slice(0, overflow) };
}

/** 清理被挤出条目的磁盘副本（仅本地导入图有 storedPath）。 */
export function evictGalleryFiles(evicted: GalleryPhoto[]): void {
  if (evicted.length === 0 || !isTauri()) return;
  for (const p of evicted) {
    if (p.storedPath) void invoke("gallery_delete_file", { path: p.storedPath }).catch(() => {});
  }
}

/** 持久化（进备份的防抖镜像写）。列表应已经过 {@link trimGallery}。 */
export function persistGallery(instanceId: string, list: GalleryPhoto[]): void {
  persistMirrored(galleryKey(instanceId), JSON.stringify(list));
}
