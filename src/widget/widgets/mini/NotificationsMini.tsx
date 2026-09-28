/**
 * 通知中心迷你磁贴（ISLAND-CORE：自 DockContainer.NotificationTile 迁出，行为不变）：
 * 铃铛 + 未读角标（>99 显 99+）。只读 notification-store（监听由 DockShell 在
 * 岛启用时 ensureNotificationListeners 一次性挂好）。
 */
import { Bell } from "lucide-react";
import { selectUnreadCount, useNotificationStore } from "../../notifications/notification-store";

export function NotificationsMini() {
  const unread = useNotificationStore(selectUnreadCount);
  const label = unread > 99 ? "99+" : String(unread);
  return (
    <span className="dock-notif">
      <Bell size={14} />
      {/* key = 显示文本：角标出现与数字变化都重挂 → 重播 dock-badge-pop（一.9），
          数字不再硬蹦。unread 归 0 时条件卸载直接消失（微磁贴不值得退场窗口）。 */}
      {unread > 0 && (
        <span key={label} className="dock-badge">
          {label}
        </span>
      )}
    </span>
  );
}
