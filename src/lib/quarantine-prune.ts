/**
 * localStorage 损坏隔离副本（`${baseKey}.corrupt-<ts>`）的统一清理策略。
 * 独立成 lib 模块：settings-store（focus-desk.settings.v1）与 persistence
 * 适配器（local-storage.ts / migration.ts，focus-desk.state.v1）都要用，
 * 而 persistence 层不能反向依赖 store（分层门禁），公共策略只能沉到这里。
 */

/** `.corrupt-` 隔离副本的保留上限（含即将写入的新副本）。取证价值集中
 *  在最近一两次；无清理的「每次损坏新增一键」会让反复损坏的机器把配额
 *  永久蚀掉（副本又不进 local-backup 镜像，无人回收）。 */
export const CORRUPT_QUARANTINE_KEEP = 2;

/**
 * 清理 `${baseKey}.corrupt-<ts>` 隔离副本，只保留最近 keep 份（按后缀
 * 时间戳排序删旧）。写新副本**前**调用（先腾位再写，配额紧张时新副本才有
 * 机会落盘）。
 */
export function pruneCorruptQuarantineCopies(baseKey: string, keep = CORRUPT_QUARANTINE_KEEP): void {
  try {
    const prefix = `${baseKey}.corrupt-`;
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(prefix)) keys.push(k);
    }
    if (keys.length <= keep) return;
    // 后缀是 Date.now() 的十进制串（等宽至 2286 年），字典序即时间序；解析
    // 失败的异常后缀按 0 排最旧、先删。
    keys.sort((a, b) => (Number(a.slice(prefix.length)) || 0) - (Number(b.slice(prefix.length)) || 0));
    for (let i = 0; i < keys.length - keep; i++) localStorage.removeItem(keys[i]);
  } catch {
    // best-effort：清理失败不影响隔离正确性，只影响占用。
  }
}
