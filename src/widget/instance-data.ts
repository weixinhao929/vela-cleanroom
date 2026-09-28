/**
 * 按实例 id 分键存储的数据桶登记表。
 *
 * 部分小组件（便签/书签/日历/涂鸦）的数据存放在「实例 id 寻址」的
 * localStorage 键里；套用布局模板与复制实例都会重新分配实例 id，若不
 * 把数据桶一并搬家，用户看到的便是「布局回来了、内容没了」。本模块
 * 集中登记这些键型，供 widget-store 在 id 重映射时调用。
 *
 * gallery 不在此列：其元数据引用磁盘文件副本（storedPath 归原实例所有，
 * 删除实例时一并清理），复制元数据会让两个实例共享磁盘生命周期，
 * 互相删图时把对方的文件清掉——副本回到空库是更安全的降级。
 */
import { persistMirrored } from "../lib/local-backup";

/** (前缀, 尾缀) 对：完整键 = 前缀 + 实例 id + 尾缀。键型登记处见文件头。 */
const BUCKET_SHAPES: ReadonlyArray<{ prefix: string; suffix: string }> = [
  { prefix: "focus-desk.notes.", suffix: "" },
  { prefix: "focus-desk.notes.", suffix: ".trash" },
  { prefix: "focus-desk.bookmarks.", suffix: "" },
  { prefix: "focus-desk.calendar.", suffix: ".v1" },
  { prefix: "focus-desk.sketch.", suffix: "" }
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
  }
  return copied;
}
