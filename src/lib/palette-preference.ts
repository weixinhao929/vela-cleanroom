/**
 * [PREF]（ZTools 借鉴 #6）搜索偏好：同一查询词「上次选中的条目」置顶。
 *
 * ZTools 在重排序里给 searchPreference（同一搜索词上次选中的指令）最高
 * 优先级之一。Vela 落地为面板级通用机制：执行任一命令时记录
 * `查询词 → 条目 id`（localStorage，LRU 上限 100），结果合并时把命中当前
 * 查询词的偏好条目稳定提到最前。纯函数 + 可注入存储，单测覆盖。
 */
const KEY = "focus-desk.palette-pref.v1";
const CAP = 100;

export type PrefStore = Record<string, string>;

function load(): PrefStore {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as PrefStore;
    }
  } catch {
    // ignore
  }
  return {};
}

let cache: PrefStore | null = null;

function ensure(): PrefStore {
  if (!cache) cache = load();
  return cache;
}

/** 归一化查询词（trim + 小写 + 压空白；空词不记录）。 */
export function normalizePrefQuery(q: string): string {
  return q.trim().toLowerCase().replace(/\s+/g, " ");
}

/** 记录一次选择（LRU：超过上限丢最旧键——依赖对象插入序）。 */
export function recordSelection(query: string, id: string): void {
  const k = normalizePrefQuery(query);
  if (!k || !id) return;
  const cur = ensure();
  delete cur[k];
  cur[k] = id;
  const keys = Object.keys(cur);
  if (keys.length > CAP) for (const extra of keys.slice(0, keys.length - CAP)) delete cur[extra];
  try {
    localStorage.setItem(KEY, JSON.stringify(cur));
  } catch {
    // 配额满：静默（下次进程重读即丢弃）
  }
}

/** 当前查询词的偏好条目 id（无则 null）。 */
export function preferredIdFor(query: string): string | null {
  const k = normalizePrefQuery(query);
  if (!k) return null;
  return ensure()[k] ?? null;
}

/** 把偏好条目稳定提到最前（不改变其余相对序；纯函数）。 */
export function boostPreferred<T extends { id: string }>(items: T[], query: string): T[] {
  const want = preferredIdFor(query);
  if (!want) return items;
  const hit = items.find((i) => i.id === want);
  if (!hit || items[0]?.id === want) return items;
  return [hit, ...items.filter((i) => i.id !== want)];
}

/** 测试注入：清空缓存与存储。 */
export function resetPreferenceForTest(): void {
  cache = null;
  try {
    localStorage.removeItem(KEY);
  } catch {
    // ignore
  }
}
