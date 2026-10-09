/**
 * 组件编组：多选 ≥2 个小组件编成
 * 一个带标签条的容器（GroupCard），标签点击切换显示成员。编组只是渲染态：
 * 成员 x/y/w/h/z 原样保留（编组期间不渲染卡片、坐标不参与），解散/摘成员
 * 即回到编组前原位，零成本还原。
 *
 * 纯函数与类型在此，store 动作/持久化在 widget-store.ts。
 */
import type { WidgetInstance } from "./widget-store";
import { GRID } from "./widget-store";

export type WidgetGroup = {
  id: string;
  /** 容器几何（画布坐标，与卡片同系）。 */
  x: number;
  y: number;
  w: number;
  h: number;
  z: number;
  /** 整组不透明度乘数（0–1，缺省 1）：作用在容器壳背景上，与成员自身
   *  opacity 是上下级关系（组 × 成员逐级相乘）。 */
  opacity?: number;
  /** 组名（可选）：设置侧栏 / 编组设置页 / 无障碍标签显示用——两个
   *  以上编组靠「编组 · N」无法区分。缺省回落「编组」。 */
  name?: string;
  /** 成员实例 id（顺序即标签顺序）。 */
  memberIds: string[];
  /** 当前显示的成员 id。 */
  activeId: string;
};

/** 组容器的最小尺寸（创建包围盒与手动缩放共用下限，网格对齐值）。 */
export const GROUP_MIN_SIZE = { w: 200, h: 160 };

/**
 * 由选中成员构造组：几何取成员包围盒（吸附网格），成员坐标原样保留、仅挂
 * groupId。返回 { group, members }；成员数 <2 或含已编组成员返回 null。
 */
export function buildGroupFromMembers(
  members: WidgetInstance[],
  makeId: () => string,
  nextZ: () => number
): { group: WidgetGroup; members: WidgetInstance[] } | null {
  if (members.length < 2) return null;
  if (members.some((m) => m.groupId)) return null;
  const group = groupFromRect(
    Math.min(...members.map((m) => m.x)),
    Math.min(...members.map((m) => m.y)),
    Math.max(...members.map((m) => m.x + m.w)),
    Math.max(...members.map((m) => m.y + m.h)),
    makeId,
    nextZ,
    members.map((m) => m.id)
  );
  return { group, members: members.map((m) => ({ ...m, groupId: group.id })) };
}

/**
 * 拖拽合并：拖 A 放到 B 上，以落点的 B（anchor）矩形
 * 为组几何、成员 = [anchor, ...others]，坐标全部不动。anchor 须未编组。
 */
export function buildGroupFromAnchor(
  anchor: WidgetInstance,
  others: WidgetInstance[],
  makeId: () => string,
  nextZ: () => number
): { group: WidgetGroup; members: WidgetInstance[] } | null {
  if (!others.length || anchor.groupId) return null;
  if (others.some((m) => m.groupId)) return null;
  const group = groupFromRect(anchor.x, anchor.y, anchor.x + anchor.w, anchor.y + anchor.h, makeId, nextZ, [
    anchor.id,
    ...others.map((m) => m.id)
  ]);
  const members = [anchor, ...others].map((m) => ({ ...m, groupId: group.id }));
  return { group, members };
}

/** 拖拽合并投放目标：落到未编组卡片上 = 以该卡建组/并入其组；落到编组容器上 = 并入该组。 */
export type MergeTarget = { kind: "widget" | "group"; id: string };

/**
 * 合并投放命中（纯函数）：在 points 顺序里取第一个命中者。候选 = 未编组且
 * 未被拖拽的卡片 + 全部编组容器（按容器矩形，成员卡不渲染、其存储坐标早已
 * 不代表视觉位置），同点命中取 z 最高者——即投放点可见的最上层。
 *
 * 此前只命中未编组卡片：拖到编组容器上永远不合并（mergeIntoGroup 的入组
 * 分支成了死代码）；坐标一律用画布布局单位（指针视觉坐标需先除 uiZoom）。
 */
export function findMergeTargetAt(
  instances: { id: string; x: number; y: number; w: number; h: number; z: number; groupId?: string }[],
  groups: { id: string; x: number; y: number; w: number; h: number; z: number }[],
  point: { x: number; y: number },
  draggedIds: string[],
  fallbackPoints: { x: number; y: number }[] = []
): MergeTarget | null {
  // Set 化：拖拽每帧（rAF）对每个候选做 includes 数组扫描 → O(1) 查表。
  const dragged = new Set(draggedIds);
  const hitAt = (px: number, py: number): MergeTarget | null => {
    let best: MergeTarget | null = null;
    let bestZ = -Infinity;
    for (const i of instances) {
      if (dragged.has(i.id) || i.groupId) continue;
      if (px < i.x || px > i.x + i.w || py < i.y || py > i.y + i.h) continue;
      if (i.z > bestZ) {
        bestZ = i.z;
        best = { kind: "widget", id: i.id };
      }
    }
    for (const g of groups) {
      if (px < g.x || px > g.x + g.w || py < g.y || py > g.y + g.h) continue;
      if (g.z > bestZ) {
        bestZ = g.z;
        best = { kind: "group", id: g.id };
      }
    }
    return best;
  };
  for (const p of [point, ...fallbackPoints]) {
    const hit = hitAt(p.x, p.y);
    if (hit) return hit;
  }
  return null;
}

function groupFromRect(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  makeId: () => string,
  nextZ: () => number,
  memberIds: string[]
): WidgetGroup {
  const x = snap(x0);
  const y = snap(y0);
  return {
    id: makeId(),
    x,
    y,
    w: Math.max(snap(x1) - x, GROUP_MIN_SIZE.w),
    h: Math.max(snap(y1) - y, GROUP_MIN_SIZE.h),
    z: nextZ(),
    memberIds,
    activeId: memberIds[0]
  };
}

function snap(v: number): number {
  return Math.round(v / GRID) * GRID;
}

/**
 * 清洗：组的成员不足 2 人 / 成员不存在 → 解散（成员去 groupId、组删除）；
 * activeId 不在成员表 → 回落首个成员；实例引用了不存在的组 → 去 groupId。
 * 返回净化后的 { groups, instances }（输入不变式，返回新引用仅在有变化时）。
 */
export function sanitizeGroups(
  groups: WidgetGroup[],
  instances: WidgetInstance[]
): { groups: WidgetGroup[]; instances: WidgetInstance[] } {
  const byId = new Map(instances.map((i) => [i.id, i]));
  /* 全部成员 id 汇成一个 Set：孤儿判定（实例挂了 groupId 却不在任何组的
     成员表里）从 O(实例×组×成员) 的嵌套扫描线性化。 */
  const allMemberIds = new Set(groups.flatMap((g) => g.memberIds));
  const kept: WidgetGroup[] = [];
  let instancesChanged = false;
  const nextInstances = instances.map((i) => {
    if (i.groupId && !allMemberIds.has(i.id)) {
      instancesChanged = true;
      const { groupId: _drop, ...rest } = i;
      void _drop;
      return rest as WidgetInstance;
    }
    return i;
  });
  for (const g of groups) {
    const existing = g.memberIds.filter((id) => byId.has(id));
    if (existing.length < 2) {
      // 解散：成员去 groupId。
      for (const id of existing) {
        const idx = nextInstances.findIndex((i) => i.id === id);
        if (idx >= 0 && nextInstances[idx].groupId) {
          const { groupId: _drop, ...rest } = nextInstances[idx];
          void _drop;
          nextInstances[idx] = rest as WidgetInstance;
          instancesChanged = true;
        }
      }
      continue;
    }
    const activeOk = existing.includes(g.activeId);
    /* 引用稳定契约（「返回新引用仅在有变化时」）：existing 与原成员表等长
       （filter 只删不增、保序）且 activeId 有效 ⇒ 组内容未变，push 原引用。
       此前无条件新建对象/数组使 groupsChanged 恒真——跨窗同步/切视图/
       hydrate 的每次 sanitize 都让全部 GroupCard memo 失效重渲。 */
    if (existing.length === g.memberIds.length && activeOk) {
      kept.push(g);
      continue;
    }
    kept.push({ ...g, memberIds: existing, activeId: activeOk ? g.activeId : existing[0] });
  }
  const groupsChanged =
    kept.length !== groups.length ||
    kept.some((g, i) => g !== groups[i] && (g.memberIds !== groups[i].memberIds || g.activeId !== groups[i].activeId));
  return {
    groups: groupsChanged ? kept : groups,
    instances: instancesChanged ? nextInstances : instances
  };
}

/**
 * 标签拖拽重排（纯函数）：把 id 移到 beforeId 之前；beforeId=null 移到末尾；
 * beforeId 即被拖者自身或不在剩余成员里 → 原样返回（不重排）。
 */
export function reorderMemberIds(memberIds: string[], id: string, beforeId: string | null): string[] {
  const rest = memberIds.filter((m) => m !== id);
  if (beforeId == null) return [...rest, id];
  const idx = rest.indexOf(beforeId);
  if (idx < 0) return memberIds;
  return [...rest.slice(0, idx), id, ...rest.slice(idx)];
}

/** 结构校验（持久化/远端载荷元素级过滤用）。几何/z 用 Number.isFinite：
 *  NaN / Infinity 也是 number，但流入共享 z 序空间（renormalizeZ 取
 *  instances ∪ groups 极值）会毒化 zCounter，必须在入口剔除。opacity 可选，
 *  出现即须为有限数——字符串/NaN 会顺着组壳背景的 CSS calc 与面板滑条
 *  （opacity × 100）静默错乱。name 可选，出现即须为字符串且长度
 *  ≤256（UI 写入钳 24，这里只挡被篡改存储的极端值，与 isValidInstance
 *  对 label 的收口同口径）。 */
export function isValidGroup(v: unknown): v is WidgetGroup {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.id === "string" &&
    Number.isFinite(o.x) &&
    Number.isFinite(o.y) &&
    Number.isFinite(o.w) &&
    Number.isFinite(o.h) &&
    Number.isFinite(o.z) &&
    (o.opacity === undefined || (typeof o.opacity === "number" && Number.isFinite(o.opacity))) &&
    (o.name === undefined || (typeof o.name === "string" && o.name.length <= 256)) &&
    Array.isArray(o.memberIds) &&
    o.memberIds.every((m) => typeof m === "string") &&
    typeof o.activeId === "string"
  );
}

/** 从实例/组集合剥离 groupId（布局模板与导出快照不携带编组）。 */
export function stripGroupId(instances: WidgetInstance[]): WidgetInstance[] {
  return instances.map((i) => {
    if (!i.groupId) return i;
    const { groupId: _drop, ...rest } = i;
    void _drop;
    return rest as WidgetInstance;
  });
}
