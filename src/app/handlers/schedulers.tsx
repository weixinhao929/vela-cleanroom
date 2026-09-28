/**
 * F7（组合根瘦身）：仅主窗口（widget-0）驱动的周期调度——便签提醒扫描与
 * 更新检查。原为 App.tsx 内的两个 useEffect，收敛成组件后 App 的组合根
 * 只剩一行挂载。
 */
import { useEffect } from "react";
import { startNoteReminderScheduler } from "../../widget/notes-reminders";
import { purgeExpiredNotesTrash } from "../../widget/notes-store";
import { startUpdateScheduler } from "../../lib/update-scheduler";

/**
 * D-1 调度挂载点（仅 primary 渲染）：
 * - DeskOrder 借鉴 #8：便签定时提醒扫描（30s 一轮；首轮扫描承担错过补发）；
 *   同一时机执行一轮便签回收站 30 天过期清理（幂等）。
 * - BentoDesk 借鉴 #10：更新检查调度（启动即查 + 按间隔周期；与前台检查/
 *   下载共用 CAS 门，发现新版本 toast 直达更新页）。
 */
export function PrimarySchedulers() {
  useEffect(() => {
    purgeExpiredNotesTrash();
    return startNoteReminderScheduler();
  }, []);
  useEffect(() => startUpdateScheduler(), []);
  return null;
}
