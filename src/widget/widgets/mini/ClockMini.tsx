/**
 * 时钟迷你磁贴（ISLAND-CORE：自 DockContainer.ClockTile 迁出，行为不变）：HH:MM。
 * 只订阅 lib/use-now 的共享节拍器（1s 档与迁出前一致，全窗口同 interval 共享
 * 一个定时器），不自建轮询；HH:MM 粒度下不因 active 切档，避免接管结束后
 * 分钟位滞后。
 *
 * 二.5：订阅 1s 节拍但仅当 formatClock 输出变化才提交 state——HH:MM 每分钟
 * 才变一次，此前每秒重渲一次（一小时 3600 次里 3540 次是无效渲染）。
 */
import { useEffect, useState } from "react";
import { useNow } from "../../../lib/use-now";
import { formatClock } from "../../dock/dock-logic";

export function ClockMini() {
  const now = useNow(1000);
  const [label, setLabel] = useState(() => formatClock(now));
  useEffect(() => {
    const next = formatClock(now);
    setLabel((prev) => (prev === next ? prev : next));
  }, [now]);
  return <span className="dock-clock">{label}</span>;
}
