/**
 * 课程表弹层共享件：星期名、弹层键盘处理与导入预览数据形状。
 * 独立于组件文件，避免 react-refresh 对「组件文件导出非组件」的告警。
 */

export const DAY_NAMES = ["一", "二", "三", "四", "五", "六", "日"];

/** 弹层通用键盘处理：Escape 取消 + Tab 焦点圈定在弹层内。 */
export function dialogKeyDown(
  e: {
    key: string;
    shiftKey: boolean;
    preventDefault(): void;
    stopPropagation(): void;
    currentTarget: EventTarget & HTMLElement;
  },
  onCancel: () => void
): void {
  if (e.key === "Escape") {
    e.preventDefault();
    e.stopPropagation();
    onCancel();
    return;
  }
  if (e.key !== "Tab") return;
  const root = e.currentTarget;
  const focusables = Array.from(
    root.querySelectorAll<HTMLElement>('button, input, select, textarea, [href], [tabindex]:not([tabindex="-1"])')
  ).filter((el) => !el.hasAttribute("disabled") && el.getClientRects().length > 0);
  if (focusables.length === 0) return;
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  const active = document.activeElement as HTMLElement | null;
  if (e.shiftKey && (active === first || !root.contains(active))) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && (active === last || !root.contains(active))) {
    e.preventDefault();
    first.focus();
  }
}

export type Preview = {
  rows: string[][];
  sessions: import("../timetable").TimetableSession[];
  mode: "grid" | "list";
  semesterStart: string;
  totalWeeks: number;
};
