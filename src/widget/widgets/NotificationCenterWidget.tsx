/**
 * 通知中心小组件（DOCK / 方案 D）：Vela 自发通知的历史回看。
 *
 * 数据来自 SQLite 通知历史（db v7），经 notification-store 内存镜像；交互
 * 细节（分组折叠 / 70px 滑动删除 + 邻卡弹性跟随 / 恢复 / 免打扰 / 一键清除 /
 * 空状态）在共用的 NotificationCenterList 中实现，dock 通知面板亦复用。
 */
import { Bell } from "lucide-react";
import { useT } from "../../i18n-lite";
import { selectUnreadCount, useNotificationStore } from "../notifications/notification-store";
import { NotificationCenterList } from "../notifications/NotificationCenterList";

export function NotificationCenterWidget() {
  const tr = useT();
  const unread = useNotificationStore(selectUnreadCount);
  return (
    <div className="ncw">
      <div className="ncw-head" data-interactive>
        <Bell size={14} className="ncw-ico" />
        <span className="ncw-title">{tr("通知中心")}</span>
        {unread > 0 && <span className="ncw-badge">{unread > 99 ? "99+" : unread}</span>}
      </div>
      <NotificationCenterList />
    </div>
  );
}
