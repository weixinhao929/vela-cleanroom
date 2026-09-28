/**
 * 组件编组（DeskOrder 借鉴 #12 + BentoDesk 借鉴 #2）：多选 ≥2 个小组件编成
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
  /** 成员实例 id（顺序即标签顺序）。 */
  memberIds: string[];
  /** 当前显示的成员 id。 */
  activeId: string;
};

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
 * 拖拽合并（BentoDesk 借鉴 #2）：拖 A 放到 B 上，以落点的 B（anchor）矩形
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
    w: Math.max(snap(x1) - x, 200),
    h: Math.max(snap(y1) - y, 160),
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
  const kept: WidgetGroup[] = [];
  let instancesChanged = false;
  const nextInstances = instances.map((i) => {
    if (i.groupId && !groups.some((g) => g.memberIds.includes(i.id))) {
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
    kept.push({
      ...g,
      memberIds: existing,
      activeId: existing.includes(g.activeId) ? g.activeId : existing[0]
    });
  }
  const groupsChanged =
    kept.length !== groups.length ||
    kept.some((g, i) => g !== groups[i] && (g.memberIds !== groups[i].memberIds || g.activeId !== groups[i].activeId));
  return {
    groups: groupsChanged ? kept : groups,
    instances: instancesChanged ? nextInstances : instances
  };
}

/** 结构校验（持久化/远端载荷元素级过滤用）。 */
export function isValidGroup(v: unknown): v is WidgetGroup {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.id === "string" &&
    typeof o.x === "number" &&
    typeof o.y === "number" &&
    typeof o.w === "number" &&
    typeof o.h === "number" &&
    typeof o.z === "number" &&
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
