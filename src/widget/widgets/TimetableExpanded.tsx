/**
 * 课程表沉浸页（G9）：TimetableWidget 周视图在展开遮罩内的全周呈现。
 * 卡片尺寸下 7 列网格 + 周次导航很拥挤；展开后以 min(720px, 90vw) 全览。
 * 组件无私有轮询（当前课高亮走 useNow 共享 30s ticker），active=false 由
 * 遮罩 display:none 压制渲染成本，无需暂停接线。
 */
import { TimetableWidget } from "./TimetableWidget";
import type { ExpandedComponentProps } from "../expand-store";
import "../../styles/feature-immersive.css";

export function TimetableExpanded({ instanceId }: ExpandedComponentProps) {
  return (
    <div className="imm-reuse">
      <TimetableWidget instanceId={instanceId} />
    </div>
  );
}
