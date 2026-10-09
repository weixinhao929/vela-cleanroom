/**
 * [DOCK-COVER]纯函数域：随机选图 + crossfade 状态机。
 * 独立成文件（dock-logic.ts 同款分层）：DockCoverBg.tsx 只导出组件，
 * react-refresh 边界干净；测试直接打这里。
 */

/** 专注背景可用的图片扩展名（与 read_image_thumbnails 支持面一致）。 */
export const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "webp", "gif", "bmp"]);

export type FileEntryLike = { name: string; path: string; is_dir: boolean };

/** 纯函数：从目录清单里挑一张随机图片（无图片 → null；测试可注入随机源）。 */
export function pickRandomImage(entries: FileEntryLike[], rand: () => number = Math.random): string | null {
  const images = entries.filter((e) => !e.is_dir && IMAGE_EXTS.has(e.name.split(".").pop()?.toLowerCase() ?? ""));
  if (images.length === 0) return null;
  /* 注入 rand 可能返回 1（如测试），floor 后等于 length 会越界——钳到末位。 */
  const idx = Math.min(images.length - 1, Math.floor(rand() * images.length));
  return images[idx].path;
}

/** 双层 crossfade 状态机（纯函数，单测覆盖）。 */
export function nextCoverLayers(
  prev: { cur: string | null; prev: string | null },
  src: string | null
): { cur: string | null; prev: string | null } {
  if (prev.cur === src) return prev;
  return { cur: src, prev: prev.cur };
}
