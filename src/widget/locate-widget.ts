/**
 * 「在画布中定位」共享实现：灵动岛磁贴右键菜单（桌面层直接调用）与设置窗口
 * 的磁贴设置页（经 `vela:locate-widget` 事件由画布窗口执行）共用。
 *
 * 定位语义：实例不在当前视图时先切到所属视图；下一帧选中（复用画布选中态）
 * + 置顶 + accent 脉冲 1.2s，并尽力 scrollIntoView（桌面层不滚动时无害）。
 * 实例已不存在（任何视图都找不到）则不动作。
 */
import { prefersReducedMotion } from "../lib/anim";
import { loadInstances, useWidgetStore } from "./widget-store";

/** 找某类型小组件的第一个实例（当前视图优先，再扫其余视图；无则 null）。
    通知中心「定位来源组件」与命令面板内容搜索共用。 */
export function findInstanceIdByType(type: string): string | null {
  const st = useWidgetStore.getState();
  const cur = st.instances.find((i) => i.type === type);
  if (cur) return cur.id;
  for (const v of st.views) {
    if (v.id === st.activeView) continue;
    const hit = loadInstances(v.id).find((i) => i.type === type);
    if (hit) return hit.id;
  }
  return null;
}

/** 通知来源 → 可定位的小组件类型（app 来源无对应组件；未知来源不可定位）。
    通知中心「定位来源组件」与 OS 通知点击落地（os-notify:activated）共用。 */
export const SOURCE_TO_WIDGET: Partial<Record<string, string>> = {
  pomodoro: "pomodoro",
  todo: "todo",
  deadline: "deadlines",
  habit: "habit",
  calendar: "calendar",
  timetable: "timetable",
  countdown: "countdown",
  email: "email",
  weather: "weather",
  bluetooth: "bluetooth"
};

const LOCATE_PULSE_MS = 1200;

/** 画布窗口内执行定位（必须在挂载了 WidgetCanvas 的窗口调用）。 */
export function locateInstanceOnCanvas(instanceId: string): void {
  const st = useWidgetStore.getState();
  if (!st.instances.some((i) => i.id === instanceId)) {
    const owner = st.views.find((v) => loadInstances(v.id).some((i) => i.id === instanceId));
    if (!owner) return;
    st.setActiveView(owner.id);
  }
  requestAnimationFrame(() => {
    const s = useWidgetStore.getState();
    if (!s.instances.some((i) => i.id === instanceId)) return;
    s.selectWidget(instanceId);
    s.bringToFront(instanceId);
    useWidgetStore.setState((x) => ({
      pulseIds: x.pulseIds.includes(instanceId) ? x.pulseIds : [...x.pulseIds, instanceId]
    }));
    const el = document.querySelector<HTMLElement>(`[data-widget-id="${instanceId}"]`);
    if (el && typeof el.scrollIntoView === "function") {
      el.scrollIntoView({ block: "nearest", inline: "nearest", behavior: prefersReducedMotion() ? "auto" : "smooth" });
    }
    window.setTimeout(() => {
      useWidgetStore.setState((x) => ({ pulseIds: x.pulseIds.filter((id) => id !== instanceId) }));
    }, LOCATE_PULSE_MS);
  });
}

/** 跨窗口定位：设置窗口等无画布的窗口广播事件，由画布窗口执行。 */
export const LOCATE_WIDGET_EVENT = "vela:locate-widget";

export function locateWidgetCrossWindow(instanceId: string): void {
  void import("@tauri-apps/api/event").then(({ emit }) => emit(LOCATE_WIDGET_EVENT, instanceId)).catch(() => {});
}
