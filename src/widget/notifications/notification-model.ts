/**
 * 通知中心纯函数层：分组排序 + 相对时间格式化 + 滑动删除的位移分配。
 * 无 React / 无 IO，供 notification-store 单测与组件共用。
 */
import type { NotificationRecord } from "../../types/bindings/NotificationRecord";

/** 来源分组：组内按时间倒序（新→旧），组间按各组最新一条的时间倒序。 */
export type NotificationGrouping = {
  source: string;
  records: NotificationRecord[];
};

export function groupNotifications(records: NotificationRecord[]): NotificationGrouping[] {
  const bySource = new Map<string, NotificationRecord[]>();
  // records 约定已是新→旧；分组保持插入序 = 组内新→旧。
  for (const r of records) {
    const list = bySource.get(r.source);
    if (list) list.push(r);
    else bySource.set(r.source, [r]);
  }
  const groups = [...bySource.entries()].map(([source, list]) => ({ source, records: list }));
  // 组间排序：比较各组第一条（最新）的 created_at。
  groups.sort((a, b) => timeOf(b.records[0]) - timeOf(a.records[0]));
  return groups;
}

function timeOf(r: NotificationRecord | undefined): number {
  if (!r) return 0;
  const t = new Date(r.created_at).getTime();
  return Number.isFinite(t) ? t : 0;
}

/**
 * 相对时间：刚刚 / N 分钟前 / N 小时前 / 昨天 / 前天 / 本年 MM-DD / 跨年 YYYY-MM-DD。
 * 与其它小组件的本地口径一致；`now` 可注入供测试，`tr` 为翻译回调
 * （组件传 useT() 的结果，缺省恒等——沿用 calendar-event-editor 的
 * `tr("{n} 分钟前").replace("{n}", …)` 模板约定）。
 */
export function friendlyTime(iso: string, now: number = Date.now(), tr: (zh: string) => string = (s) => s): string {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "";
  const diff = now - t;
  if (diff < 60_000) return tr("刚刚");
  if (diff < 3_600_000) return tr("{n} 分钟前").replace("{n}", String(Math.floor(diff / 60_000)));
  if (diff < 86_400_000) return tr("{n} 小时前").replace("{n}", String(Math.floor(diff / 3_600_000)));
  const d = new Date(t);
  const today = new Date(now);
  const sameYear = d.getFullYear() === today.getFullYear();
  const md = `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  // 1–2 天前按「昨天 / 前天」口语化，再往前走日期。
  if (diff < 3 * 86_400_000 && sameYear) {
    const days = Math.floor(diff / 86_400_000);
    return days === 1 ? tr("昨天") : tr("前天");
  }
  return sameYear ? md : `${d.getFullYear()}-${md}`;
}

/**
 * 滑动删除的邻卡弹性跟随：
 * 被拖项 1:1 跟手；相邻项按 |index 差| 衰减跟随（0.3× / 0.1×）；一旦被拖项
 * 越过确认阈值，邻卡立即脱跟（滑出即将发生，视觉重心让位）。
 *
 * @param dragIndex - 正被拖拽项的序号。
 * @param dragDistance - 拖拽水平位移（带方向）。
 * @param index - 待求位移的项序号。
 * @param threshold - 删除确认阈值（默认 70px）。
 * @returns 该项应施加的水平位移（px）。
 */
export function swipeFollowOffset(dragIndex: number, dragDistance: number, index: number, threshold = 70): number {
  const diff = Math.abs(dragIndex - index);
  if (diff === 0) return dragDistance;
  if (Math.abs(dragDistance) > threshold) return 0;
  if (diff === 1) return dragDistance * 0.3;
  if (diff === 2) return dragDistance * 0.1;
  return 0;
}
