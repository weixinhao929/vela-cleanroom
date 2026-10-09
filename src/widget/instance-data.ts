/**
 * 按实例 id 分键存储的数据桶登记表。
 *
 * 部分小组件（便签/书签/日历/涂鸦）的数据存放在「实例 id 寻址」的
 * localStorage 键里；套用布局模板与复制实例都会重新分配实例 id，若不
 * 把数据桶一并搬家，用户看到的便是「布局回来了、内容没了」。本模块
 * 集中登记这些键型，供 widget-store 在 id 重映射时调用。
 *
 * gallery 的元数据键也在此清理（removeInstanceData）：其磁盘副本
 * （storedPath）随删除一并回收；但**复制**仍不走 copyInstanceData——
 * 两个实例共享磁盘生命周期会互相删图，副本回到空库是更安全的降级。
 */
import { invoke, isTauri } from "../lib/tauri";
import { persistMirrored, scheduleMirrorSync } from "../lib/local-backup";
import { evictGalleryFiles, loadGallery } from "./gallery-photos";

/** (前缀, 尾缀) 对：完整键 = 前缀 + 实例 id + 尾缀。键型登记处见文件头。 */
const BUCKET_SHAPES: ReadonlyArray<{ prefix: string; suffix: string }> = [
  { prefix: "focus-desk.notes.", suffix: "" },
  { prefix: "focus-desk.notes.", suffix: ".trash" },
  { prefix: "focus-desk.bookmarks.", suffix: "" },
  { prefix: "focus-desk.calendar.", suffix: ".v1" },
  { prefix: "focus-desk.sketch.", suffix: "" }
];

/** 除数据桶外，同样按实例 id 寻址的杂项键（配置/瞬态/历史）。 */
const SCOPED_KEYS: ReadonlyArray<(id: string) => string> = [
  (id) => `focus-desk.widget-config.${id}.v1`,
  (id) => `focus-desk.gallery.${id}`,
  (id) => `focus-desk.countdown.state.${id}`,
  (id) => `focus-desk.stopwatch.state.${id}`,
  (id) => `focus-desk.uc.state.${id}`,
  (id) => `focus-desk.uc.history.${id}`,
  (id) => `focus-desk.uc.cat.${id}`,
  (id) => `focus-desk.calc.history.${id}`,
  (id) => `focus-desk.calc.vars.${id}`
];

/**
 * 把 fromId 名下的全部实例数据桶复制到 toId 名下（源不动，镜像进备份）。
 * 源键缺失时跳过该桶。返回实际复制的键数（0 = 无数据可搬）。
 */
export function copyInstanceData(fromId: string, toId: string): number {
  if (!fromId || !toId || fromId === toId) return 0;
  let copied = 0;
  for (const { prefix, suffix } of BUCKET_SHAPES) {
    const src = `${prefix}${fromId}${suffix}`;
    let value: string | null = null;
    try {
      value = localStorage.getItem(src);
    } catch {
      continue;
    }
    if (value === null) continue;
    if (persistMirrored(`${prefix}${toId}${suffix}`, value)) copied++;
    // 涂鸦的 "file" 标记指向 sketches/<id>.png——只复制标记不复制文件，
    // 副本必为空白画布。经 read→save 走 Rust 落一份独立副本（浏览器 dev 的
    // dataURL 存档天然随键复制，无需处理）。
    if (prefix === "focus-desk.sketch." && value === "file" && isTauri()) {
      void invoke<string | null>("read_sketch_image", { instanceId: fromId })
        .then((dataUrl) => {
          if (dataUrl) return invoke("save_sketch_image", { instanceId: toId, dataUrl });
          return null;
        })
        .catch(() => {});
    }
  }
  return copied;
}

/**
 * 彻底删除实例 id 名下的**全部**数据：数据桶 + 杂项键 + 磁盘副本（涂鸦
 * PNG、gallery 图片与缩略图）。：此前 purge/清空回收站/逾期自动清除只
 * 删几何条目，实例数据永久滞留（gallery 最多 200 张/实例的磁盘副本随之
 * 泄漏），违背本文件头声明的清理契约。fire-and-forget：调用方不必等待。
 */
export function removeInstanceData(id: string): void {
  if (!id) return;
  const keys = [
    ...BUCKET_SHAPES.map(({ prefix, suffix }) => `${prefix}${id}${suffix}`),
    ...SCOPED_KEYS.map((k) => k(id))
  ];
  for (const key of keys) {
    try {
      localStorage.removeItem(key);
    } catch {
      // ignore
    }
  }
  // gallery 元数据先读后删：磁盘副本（原图 + 缩略图）一并回收。
  const gallery = loadGallery(id);
  if (isTauri()) {
    if (gallery) {
      evictGalleryFiles([...gallery.photos, ...gallery.evicted]);
    }
    void invoke("delete_sketch_image", { instanceId: id }).catch(() => {});
  }
  scheduleMirrorSync();
}
