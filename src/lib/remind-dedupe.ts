/**
 * 提醒去重键（日历事件提醒 / 课程表上课提醒共用）。
 *
 * 键形如 `<prefix>.<…>.<YYYY-MM-DD>`：同一事件同一天只发一次。此前每个事件
 * 每天写一个永不清除的键，长期使用后 localStorage 无限增长；这里在写入时顺带
 * 清扫同前缀下日期早于今天的旧键，每个前缀每天最多扫一遍。
 */

const sweptOn = new Map<string, string>();

/** 键尾部的 `YYYY-MM-DD`；无法识别返回 null（保守不删）。 */
function dateTail(key: string): string | null {
  const tail = key.slice(key.lastIndexOf(".") + 1);
  return /^\d{4}-\d{2}-\d{2}$/.test(tail) ? tail : null;
}

/** 清扫 `prefix` 下日期早于 `today` 的去重键（ISO 日期串可直接按字典序比较）。 */
export function sweepStaleReminders(prefix: string, today: string): void {
  if (sweptOn.get(prefix) === today) return;
  sweptOn.set(prefix, today);
  try {
    const stale: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k || !k.startsWith(prefix)) continue;
      const d = dateTail(k);
      if (d && d < today) stale.push(k);
    }
    for (const k of stale) localStorage.removeItem(k);
  } catch {
    // best-effort
  }
}

/**
 * 标记「已提醒」。已标记返回 false（调用方跳过发送）；首次标记写入并返回 true；
 * 写入失败（配额）也返回 false，避免同一提醒无限重发。
 *
 * @param key - 完整去重键，尾部须为 `YYYY-MM-DD`。
 * @param prefix - 同类键的公共前缀（用于清扫）。
 * @param today - 今天的 `YYYY-MM-DD`。
 */
export function markReminded(key: string, prefix: string, today: string): boolean {
  sweepStaleReminders(prefix, today);
  try {
    if (localStorage.getItem(key)) return false;
    localStorage.setItem(key, "1");
    return true;
  } catch {
    return false;
  }
}
