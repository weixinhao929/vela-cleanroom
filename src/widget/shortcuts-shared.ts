/** 快捷方式小组件的共享类型与工具函数（独立于组件，避免 fast-refresh 警告）。 */

export type CustomShortcut = {
  id: string;
  label: string;
  path: string;
  kind: "file" | "folder" | "url";
  /**
   * 目标当前不存在：只标记不删除——移动盘未接、
   * 临时移除这类失效是可恢复的，恢复后由周期复检自动解除。标记期间禁打开。
   */
  missing?: boolean;
};

/**
 * 快捷方式文件夹（类手机桌面）：把若干自定义条目收进一枚可展开磁贴，
 * 单击弹出条目网格。childIds 引用 customShortcuts 的 id；条目进文件夹后
 * 不再直接铺在画布网格上（格位保留，移出时优先回原格）。
 * sort 为弹层展示排序：free（默认）
 * 保持 childIds 顺序（拖拽重排写的就是这个顺序），name/time 仅影响显示。
 */
export type ShortcutFolder = {
  id: string;
  label: string;
  childIds: string[];
  sort?: SfSortMode;
};

/**
 * 文件夹弹层展示排序：free 保持 childIds
 * 顺序（拖拽重排的目标序）；name 区域感知名称序；time 按目标修改时间倒序
 * （最新在前，未知时间排最后）。稳定排序：同键保持原相对顺序。
 */
export function sortFolderItems<T extends { label: string }>(
  items: readonly T[],
  mode: SfSortMode,
  mtimeOf?: (item: T) => number
): T[] {
  if (mode === "free") return [...items];
  const copy = [...items];
  if (mode === "name") {
    copy.sort((a, b) => a.label.localeCompare(b.label, "zh"));
    return copy;
  }
  copy.sort((a, b) => (mtimeOf?.(b) ?? 0) - (mtimeOf?.(a) ?? 0));
  return copy;
}

/**
 * 文件夹默认名避让：
 * base 未被占用原样返回；被占用则生成「base (n)」试探至空闲，n 封顶 1000。
 * 只用于新建时的默认名——显式重命名允许重名（文件夹按 id 寻址，不静默改用户输入）。
 */
export function uniqueFolderLabel(taken: ReadonlySet<string>, base: string): string {
  const normed = new Set(Array.from(taken, (s) => s.trim()));
  const baseKey = base.trim();
  if (!normed.has(baseKey)) return base;
  for (let n = 2; n <= 1000; n++) {
    const candidate = `${base} (${n})`;
    if (!normed.has(candidate.trim())) return candidate;
  }
  return base;
}

/** 分页页数（total/perPage 非正时回退单页）。 */
export function pageCountOf(total: number, perPage: number): number {
  if (total <= 0 || perPage <= 0) return 1;
  return Math.ceil(total / perPage);
}

/** 条目全局下标 → 所在页码（锚点保页：重排后让当前项跟随其新页）。 */
export function pageIndexOf(index: number, perPage: number): number {
  if (perPage <= 0 || index < 0) return 0;
  return Math.floor(index / perPage);
}

/** 页码钳制进 [0, pages-1]。 */
export function clampPage(page: number, pages: number): number {
  return Math.min(Math.max(0, page), Math.max(0, pages - 1));
}

/** 文件夹弹层展示排序：free 自由（childIds 顺序）/ name 名称 / time 时间。 */
export type SfSortMode = "free" | "name" | "time";

/** 自由排布的格位（内容区网格坐标，列 x / 行 y）。 */
export type ShortcutCell = { x: number; y: number };

/** 从配置中读取自定义快捷方式数组（容错解析）。 */
export function loadCustomShortcuts(config: Record<string, unknown>): CustomShortcut[] {
  const raw = config.customShortcuts;
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (s): s is CustomShortcut => !!s && typeof s === "object" && typeof (s as CustomShortcut).path === "string"
  );
}

/** 从配置中读取 id → 格位的自由排布表（容错解析）。 */
export function loadShortcutPositions(config: Record<string, unknown>): Record<string, ShortcutCell> {
  const raw = config.positions;
  if (!raw || typeof raw !== "object") return {};
  const out: Record<string, ShortcutCell> = {};
  for (const [id, cell] of Object.entries(raw as Record<string, unknown>)) {
    if (
      cell &&
      typeof cell === "object" &&
      Number.isFinite((cell as ShortcutCell).x) &&
      Number.isFinite((cell as ShortcutCell).y)
    ) {
      out[id] = {
        x: Math.max(0, Math.floor((cell as ShortcutCell).x)),
        y: Math.max(0, Math.floor((cell as ShortcutCell).y))
      };
    }
  }
  return out;
}

/**
 * 旧条目识别：路径仍指向 .lnk/.url 链接本体（lnk/url 解析落地之前拖入的
 * 形态）——桌面原快捷方式被删后这类入口即失效，需要重解析成目标路径。
 * 已解析条目的 path 是目标本体或 https:// 链接，天然不命中。
 */
export function isLinkFileEntry(s: Pick<CustomShortcut, "path">): boolean {
  return /\.(lnk|url)$/i.test(s.path);
}

/**
 * 把 classify_path 的重解析结果回灌进条目表（自愈迁移）：只改命中条目的
 * path/kind，其余字段与其余条目原样保留。fixes 为空、没有条目命中、或
 * 目标路径与现值相同（已被他处迁移）时返回原数组引用——调用方据引用是否
 * 变化决定要不要写盘，天然幂等零空写。
 */
export function applyResolvedTargets(
  items: CustomShortcut[],
  fixes: ReadonlyArray<{ id: string; path: string; kind: CustomShortcut["kind"] }>
): CustomShortcut[] {
  if (fixes.length === 0) return items;
  const byId = new Map(fixes.map((f) => [f.id, f]));
  let changed = false;
  const next = items.map((x) => {
    const f = byId.get(x.id);
    if (!f || f.path === x.path) return x;
    changed = true;
    return { ...x, path: f.path, kind: f.kind };
  });
  return changed ? next : items;
}

/** 从配置中读取快捷方式文件夹数组（容错解析，坏条目丢弃、不整表清空）。 */
export function loadShortcutFolders(config: Record<string, unknown>): ShortcutFolder[] {
  const raw = config.shortcutFolders;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((f) => {
    if (!f || typeof f !== "object") return [];
    const o = f as Partial<ShortcutFolder>;
    if (typeof o.id !== "string" || !o.id || typeof o.label !== "string") return [];
    const childIds = Array.isArray(o.childIds) ? o.childIds.filter((x): x is string => typeof x === "string") : [];
    const sort = o.sort === "name" || o.sort === "time" ? o.sort : undefined;
    return sort ? [{ id: o.id, label: o.label, childIds, sort }] : [{ id: o.id, label: o.label, childIds }];
  });
}

/** 文件夹占用的条目 id 全集：这些条目不再直接铺在画布网格上。 */
export function folderMemberIds(folders: ReadonlyArray<ShortcutFolder>): Set<string> {
  return new Set(folders.flatMap((f) => f.childIds));
}

/** 路径比较归一：小写 + 正斜杠统一反斜杠（与 Rust icon_cache_key 同规则）。 */
export function normShortcutPath(p: string): string {
  return p.toLowerCase().replace(/\//g, "\\");
}

/**
 * missing 标记与「当前真实失效的路径集合」对齐（watch 删除事件 / 挂载与周期
 * 复检共用）：在 missingPaths 里的条目标记、不在的清除。路径比较两侧都经
 * normShortcutPath 归一（大小写/分隔符不敏感）。无变化返回原数组引用，
 * 调用方据引用变化决定要不要写盘（幂等零空写）。
 */
export function markEntriesMissing(items: CustomShortcut[], missingPaths: Iterable<string>): CustomShortcut[] {
  const normed = new Set(Array.from(missingPaths, (p) => normShortcutPath(p)));
  let changed = false;
  const next = items.map((s) => {
    const want = s.kind !== "url" && normed.has(normShortcutPath(s.path));
    if (want && !s.missing) {
      changed = true;
      return { ...s, missing: true };
    }
    if (!want && s.missing) {
      changed = true;
      return { id: s.id, label: s.label, path: s.path, kind: s.kind };
    }
    return s;
  });
  return changed ? next : items;
}

/**
 * 弹层内拖拽重排：把 dragId 移到 beforeId 之前（null = 追加到末尾）。
 * order 不含 dragId 时原样返回；beforeId 就是相邻后继时返回原引用（无变化）。
 */
export function reorderChildIds(order: readonly string[], dragId: string, beforeId: string | null): string[] {
  const from = order.indexOf(dragId);
  if (from < 0) return [...order];
  const rest = order.filter((id) => id !== dragId);
  const to = beforeId == null ? rest.length : rest.indexOf(beforeId);
  const insertAt = to < 0 ? rest.length : to;
  if (insertAt === from) return [...order];
  const next = [...rest];
  next.splice(insertAt, 0, dragId);
  return next;
}

/** 弹层条目拖出弹层后的落点：画布格位，或另一枚文件夹磁贴。 */
export type SfDropTarget = { kind: "canvas"; cell: ShortcutCell } | { kind: "folder"; folderId: string };

/**
 * 文件夹弹层的打开方式：click 单击展开（默认）；
 * hover 悬停展开 + 离开宽限自动收回；pin 钉住（外点不关，仅 ×/Esc 收）。
 */
export type SfOpenMode = "click" | "hover" | "pin";

/**
 * 条目删除后同步剔除文件夹里的悬挂引用；无变化返回原数组引用，
 * 调用方据引用是否变化决定要不要把 shortcutFolders 写进同一次 update。
 */
export function pruneFolderChildren(folders: ShortcutFolder[], removedIds: ReadonlySet<string>): ShortcutFolder[] {
  if (removedIds.size === 0) return folders;
  let changed = false;
  const next = folders.map((f) => {
    const childIds = f.childIds.filter((id) => !removedIds.has(id));
    if (childIds.length === f.childIds.length) return f;
    changed = true;
    return { ...f, childIds };
  });
  return changed ? next : folders;
}

/**
 * watch 变更提交前的行级合并（纯函数）：latest 中被 watch 改过的行（next 里
 * 同 id 的新对象引用）替换为改后行，等待期间并发新增（next 没有、latest 有）
 * 的行原样保留，next 中多出的行追加；无任何实际差异返回 null（调用方不发
 * 空写）。行差异用**引用**比较——next 由 watch 处理对命中行重建对象，未命中
 * 行沿用 cur 的引用，引用比较既正确又零序列化。
 */
export function mergeWatchRows(latest: CustomShortcut[], next: CustomShortcut[]): CustomShortcut[] | null {
  const byId = new Map(next.map((s) => [s.id, s]));
  const merged = latest.map((s) => byId.get(s.id) ?? s);
  const latestIds = new Set(latest.map((s) => s.id));
  for (const s of next) if (!latestIds.has(s.id)) merged.push(s);
  // 追加行使 merged[i]（对象）≠ latest[i]（undefined），一处 some 全覆盖；
  // 此前组件内用 join("|") 比较，对象串成 "[object Object]" 内容差异恒假。
  return merged.some((s, i) => s !== latest[i]) ? merged : null;
}

/**
 * 下一个空闲格位：先取拖放落点格（占用时向后线性探测），没有落点则按
 * 行优先扫到第一个空格。用于新增条目的自动排布。
 */
export function nextFreeCell(taken: Map<string, ShortcutCell>, columns: number, dropCell?: ShortcutCell): ShortcutCell {
  // 防御钳制：columns ≤ 0 时行优先扫描的内层循环永不执行（y 无限自增），
  // 落点探测也只向纵向绕行——共享工具不信任调用方算出的列数。
  const cols = Math.max(1, Math.floor(columns));
  const occupied = new Set(Array.from(taken.values()).map((c) => `${c.x}:${c.y}`));
  const free = (c: ShortcutCell) => !occupied.has(`${c.x}:${c.y}`);
  if (dropCell) {
    let c: ShortcutCell = { x: dropCell.x, y: dropCell.y };
    while (!free(c)) {
      c = c.x + 1 < cols ? { x: c.x + 1, y: c.y } : { x: 0, y: c.y + 1 };
    }
    return c;
  }
  for (let y = 0; ; y++) {
    for (let x = 0; x < cols; x++) {
      if (free({ x, y })) return { x, y };
    }
  }
}
