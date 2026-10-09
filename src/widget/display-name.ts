import { getWidgetMeta } from "./registry";

/**
 * 自动名（忽略 label）：类型译名 + 同类型 ≥2 个实例时追加创建序号
 * （时钟、时钟2…）。重命名弹窗的 placeholder 用它——widgetDisplayName 会
 * 优先返回 label，已命名的成员 placeholder 会与预填值相同，用户看不到
 * 「留空会恢复成什么」。
 */
export function widgetAutoName(
  type: string,
  id: string,
  instances: { id: string; type: string }[],
  tr: (s: string) => string
): string {
  const meta = getWidgetMeta(type);
  const base = meta ? tr(String(meta.name)) : type;
  let n = 0;
  let idx = -1;
  for (const i of instances) {
    if (i.type !== type) continue;
    if (i.id === id) idx = n;
    n++;
  }
  return n > 1 && idx >= 0 ? `${base}${idx + 1}` : base;
}

/**
 * 实例显示名：重命名标签（instance.label）优先——卡片标题 / 组标签 / 花瓣 /
 * 配置面板 / 设置页全走这一份，改名一处、处处同步；未设置时回落自动名
 * （widgetAutoName）。
 */
export function widgetDisplayName(
  type: string,
  id: string,
  instances: { id: string; type: string; label?: string }[],
  tr: (s: string) => string
): string {
  const named = instances.find((i) => i.id === id)?.label;
  if (typeof named === "string" && named.trim()) return named;
  return widgetAutoName(type, id, instances, tr);
}
