/**
 * 统一空状态（图标 + 主文案 + 行动提示）。
 *
 * 此前空态散落为 12+ 种 bespoke 类名（widget-empty / bm-empty /
 * analytics-empty / ws-empty…），文案风格三级分化——有的带行动点
 * （「暂无磁贴，点「+」添加」），有的纯文字（「暂无邮件」），有的连
 * 结构都没有。本组件统一视觉与语义：图标槽（缺省 Inbox）+ 主文案 +
 * 可选行动提示（hint，告诉用户下一步怎么做的半句话）。
 *
 * 迁移策略：新代码一律用本组件；存量 bespoke 空态按「改到哪迁到哪」
 * 渐进替换（样式类保留给未迁移的调用点）。
 */
import type { ReactNode } from "react";
import { Inbox } from "lucide-react";

export function EmptyState({
  icon,
  text,
  hint,
  compact = false
}: {
  /** 自定义图标（ReactNode）；缺省用 Inbox 线稿。 */
  icon?: ReactNode;
  /** 主文案：为什么是空的（「暂无书签」）。 */
  text: string;
  /** 行动提示：怎么改变它（「点击上方添加」），可选。 */
  hint?: string;
  /** 紧凑档：弹出层/迷你容器等空间受限场景。 */
  compact?: boolean;
}) {
  return (
    <div className={`fd-empty${compact ? " fd-empty-compact" : ""}`}>
      {icon ?? <Inbox size={compact ? 16 : 20} aria-hidden="true" className="fd-empty-ico" />}
      <span className="fd-empty-text">{text}</span>
      {hint && <span className="fd-empty-hint">{hint}</span>}
    </div>
  );
}
