/**
 * 邮件沉浸页：EmailWidget 在展开遮罩内的全尺寸呈现（更长预览、
 * 更多账户页签同屏）。EmailWidget 自带按配置周期的刷新 interval——经
 * paused 门控（active=false 时停轮询），符合沉浸组件暂停契约。
 */
import { EmailWidget } from "./EmailWidget";
import type { ExpandedComponentProps } from "../expand-store";
import "../../styles/feature-immersive.css";

export function EmailExpanded({ instanceId, active }: ExpandedComponentProps) {
  return (
    <div className="imm-reuse">
      <EmailWidget instanceId={instanceId} paused={!active} />
    </div>
  );
}
