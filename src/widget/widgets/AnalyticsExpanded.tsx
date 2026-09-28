/**
 * 专注统计沉浸页（G9）：AnalyticsPanel 在展开遮罩内的全尺寸呈现。
 * 图表 / 热力图在 320px 卡片里被压得很密，展开后以 min(720px, 90vw) 呈现。
 * 面板无轮询 / rAF / 采集（仅 store 订阅 + 共享 30s ticker + 会话尾条驱动的
 * SQLite 聚合读取），active=false 时由遮罩 display:none 压制渲染成本，
 * 无需额外暂停逻辑（契约见 registry.lazyExpanded 注释）。
 */
import { AnalyticsPanel } from "../../features/analytics/AnalyticsPanel";
import { useWidgetExpand, type ExpandedComponentProps } from "../expand-store";
import "../../styles/feature-immersive.css";

export function AnalyticsExpanded({ instanceId }: ExpandedComponentProps) {
  /* 五.5：key=openEpoch——常驻挂载让入场动画只播一次（第二次展开起图表
     生长/count-up 全部失效，「第一次惊艳、之后平淡」）；用展开代数作 key
     在每次展开时重播入场，其余沉浸页不受影响。 */
  const openEpoch = useWidgetExpand((s) => s.openEpoch);
  return (
    <div className="imm-reuse">
      <div key={openEpoch}>
        <AnalyticsPanel instanceId={instanceId} />
      </div>
    </div>
  );
}
