/**
 * W-171 / P2-8 任务栏网速条视图：Rust 侧把本窗口贴靠在 Shell_TrayWnd 托盘区左侧
 * （经典网速工具同款形态，独立 HWND、不注入 explorer）。
 *
 * 纯展示组件：订阅共享 sys:stats 广播（1s 档），按全局网速显示选项
 * （bit 计/简洁/隐藏单位/上下行交换，W-167）渲染 ↓/↑ 两个数字。
 * 浏览器模式/首帧前显示 "—"，绝不伪造数据。
 */
import { selectNetworkRows, useNetRate, useSystemBroadcast } from "../../lib/system-stats";
import { useT } from "../../i18n-lite";
/* F6：样式随组件走——主入口不再静态携带本窗样式（60KB），App 的懒加载 /
   taskbar-net 精简入口各自经 chunk 引用加载同一份 CSS。 */
import "../../styles/feature-taskbar-net.css";

export function TaskbarNetView() {
  const tr = useT();
  const frame = useSystemBroadcast(1);
  const { fmt, swap } = useNetRate();
  const agg = selectNetworkRows(frame?.networks ?? [], "aggregate", "", tr("合计"))[0];
  return (
    <div className="taskbar-net" role="status" aria-label={tr("实时网速")}>
      <span className={`taskbar-net-item ${swap ? "taskbar-net-up" : "taskbar-net-down"}`}>
        <span className="taskbar-net-arrow" aria-hidden="true">
          {swap ? "↑" : "↓"}
        </span>
        {agg ? fmt(swap ? agg.tx : agg.rx) : "—"}
      </span>
      <span className={`taskbar-net-item ${swap ? "taskbar-net-down" : "taskbar-net-up"}`}>
        <span className="taskbar-net-arrow" aria-hidden="true">
          {swap ? "↓" : "↑"}
        </span>
        {agg ? fmt(swap ? agg.rx : agg.tx) : "—"}
      </span>
    </div>
  );
}
