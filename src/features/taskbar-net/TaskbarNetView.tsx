/**
 * 任务栏网速条视图：Rust 侧把本窗口贴靠在 Shell_TrayWnd 托盘区左侧
 * （经典网速工具 同款形态，独立 HWND、不注入 explorer）。
 *
 * 纯展示组件：订阅共享 sys:stats 广播（1s 档），按全局网速显示选项
 * （bit 计/简洁/隐藏单位/上下行交换）渲染 ↓/↑ 两个数字。
 * 浏览器模式/首帧前/数据陈旧时显示 "—"，绝不伪造数据。
 *
 * [HUD-GIVEWAY] 悬停避让在本窗已退役：修复后窗口全时点击穿透（不再吞
 * 任务栏点击），pointer 事件不再到达本页——穿透本身就是完整的「让路」；
 * extra.hudGiveWay 设置继续服务全屏 HUD。
 *
 * 本组件按当前格式化档位实测内容宽度并上报 Rust（set_taskbar_net_width），
 * 贴靠线程据此定窗宽，消除硬编码截断。
 * 采样暂停（presence 空闲）时广播停帧，旧值会一直僵着显示——超过
 * 2.5s 没有新帧即视为陈旧，回落 "—" 而不是冻结成假的实时数字。
 */
import { useEffect, useRef, useState } from "react";
import { selectNetworkRows, useNetRate, useSystemBroadcast } from "../../lib/system-stats";
import { invoke, isTauri } from "../../lib/tauri";
import { useT } from "../../i18n-lite";
/* 样式随组件走——主入口不再静态携带本窗样式（60KB），App 的懒加载 /
   taskbar-net 精简入口各自经 chunk 引用加载同一份 CSS。 */
import "../../styles/feature-taskbar-net.css";

export function TaskbarNetView() {
  const tr = useT();
  // netOnly——本窗只消费 networks，Rust 据此在无全量订阅者时跳过
  // CPU/GPU/磁盘/电池采样，不再把全系统遥测钉在 1Hz。
  const frame = useSystemBroadcast(1, { netOnly: true });
  const { fmt, swap } = useNetRate();
  const agg = selectNetworkRows(frame?.networks ?? [], "aggregate", "", tr("合计"))[0];
  const rootRef = useRef<HTMLDivElement>(null);
  const lastWidthRef = useRef(0);
  const lastFrameAtRef = useRef(0);
  const [stale, setStale] = useState(true);

  // 陈旧检测——广播停帧（presence 暂停/引擎降级）超 2.5s 视为数据过期。
  useEffect(() => {
    if (frame) {
      lastFrameAtRef.current = Date.now();
      setStale(false);
    }
  }, [frame]);
  useEffect(() => {
    const id = window.setInterval(() => {
      setStale(Date.now() - lastFrameAtRef.current > 2_500);
    }, 1_000);
    return () => window.clearInterval(id);
  }, []);

  // 内容宽度实测上报。根元素 inset:0 填满窗，nowrap+overflow:hidden 下
  // scrollWidth 即「装下当前两个数字所需宽度」（含 padding）。宽度变化才发
  // IPC（1Hz 重渲染下绝大多数拍是 no-op）。
  useEffect(() => {
    const el = rootRef.current;
    if (!el || !isTauri()) return;
    const w = el.scrollWidth;
    if (w > 0 && w !== lastWidthRef.current) {
      lastWidthRef.current = w;
      void invoke("set_taskbar_net_width", { width: w }).catch(() => {});
    }
  });

  const live = frame && !stale ? agg : null;

  return (
    /* 容器去 role="status"、降为普通 div——live
       region 语义下 1Hz 数字刷新会让读屏每秒播报一遍；数字区（两个
       taskbar-net-item）整体 aria-hidden 移出可访问性树，读屏用户不再被
       刷新轰炸（纯展示 HUD，无可操作语义，隐藏无损）。 */
    <div ref={rootRef} className="taskbar-net">
      <span className={`taskbar-net-item ${swap ? "taskbar-net-up" : "taskbar-net-down"}`} aria-hidden="true">
        <span className="taskbar-net-arrow" aria-hidden="true">
          {swap ? "↑" : "↓"}
        </span>
        {live ? fmt(swap ? live.tx : live.rx) : "—"}
      </span>
      <span className={`taskbar-net-item ${swap ? "taskbar-net-down" : "taskbar-net-up"}`} aria-hidden="true">
        <span className="taskbar-net-arrow" aria-hidden="true">
          {swap ? "↓" : "↑"}
        </span>
        {live ? fmt(swap ? live.rx : live.tx) : "—"}
      </span>
    </div>
  );
}
