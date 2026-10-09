/**
 * get_app_icon 提取结果的模块级共享缓存（归一 path → dataURL）。
 *
 * ShortcutsWidget 与 FolderPopup 此前各自维护实例内 icons 表，同一路径在
 * 两个组件里会重复走 SHGetFileInfoW + base64 IPC。本缓存跨组件共享提取
 * 结果：先查缓存命中直接复用，未命中才发命令，提取成功回写。
 *
 * 失效：目标文件内容变更（shortcuts-watch 的 modified 事件）时由调用方
 * dropAppIcons 摘除旧值再触发重提取——缓存不感知 watch，只做存取。
 * 键归一与 shortcuts-shared 的 normShortcutPath 同规则（小写 + 正斜杠归一）。
 */

const cache = new Map<string, string>();

function norm(p: string): string {
  return p.toLowerCase().replace(/\//g, "\\");
}

/** 缓存命中返回 dataURL，未命中返回 undefined。 */
export function cachedAppIcon(path: string): string | undefined {
  return cache.get(norm(path));
}

/** 提取成功后回写（dataURL 形如 `data:image/png;base64,…`）。 */
export function storeAppIcon(path: string, dataUrl: string): void {
  cache.set(norm(path), dataUrl);
}

/** 目标内容变更失效：摘除后再提取才不会拿到旧图标（可重复归一，幂等）。 */
export function dropAppIcons(paths: Iterable<string>): void {
  for (const p of paths) cache.delete(norm(p));
}

/** 测试辅助：模块单例跨用例存活，用例间显式清空防串扰。 */
export function __resetAppIconCacheForTest(): void {
  cache.clear();
}
