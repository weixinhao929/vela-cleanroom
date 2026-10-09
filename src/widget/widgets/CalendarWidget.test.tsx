import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";

/**
 * CalendarWidget 组件级回归（渲染 / 编辑流 / 删除语义 / 时间线交互）：
 * 纯函数层（shared/ics/reminders）已有单测，这里覆盖组件把它们串起来的
 * 行为——默认选中今天、周条换天、添加（定时/全天）、二次确认删除 + 撤销、
 * 重复事件三选一删除（仅此日 → excepted）、仅此日编辑分裂、时间轴空白
 * 点击预填、搜索跳转、月格方向键。
 * holiday-update mock（杜绝测试内网络）；定时器 fake（Date 固定在
 * 2026-10-08 周四 10:00）。
 */
vi.mock("../../lib/holiday-update", () => ({
  ensureHolidayData: () => Promise.resolve(),
  subscribeRemoteHolidays: () => () => {},
  // lunar.ts 的 getHoliday 也从这里取远程表（内置固定节日照常生效）。
  remoteHoliday: () => null,
  remoteHolidayVersion: () => 0
}));

import { CalendarWidget } from "./CalendarWidget";

const KEY = (id: string) => `focus-desk.calendar.${id}.v1`;
const flush = () => act(async () => {});

/** v2 事件构造器（与 calendar-shared 契约一致）。 */
const ev = (p: Record<string, unknown>): Record<string, unknown> => ({
  endTime: "",
  color: "",
  repeat: "none",
  repeatEvery: 1,
  repeatUntil: "",
  excepted: [],
  remind: 0,
  location: "",
  note: "",
  ...p
});

const readEvents = (id: string) => JSON.parse(localStorage.getItem(KEY(id)) ?? "{}");

beforeEach(() => {
  localStorage.clear();
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  vi.setSystemTime(new Date(2026, 9, 8, 10, 0, 0)); // 2026-10-08 周四 10:00
});
afterEach(() => vi.useRealTimers());

/** 时间线滚动容器的 getBoundingClientRect mock（固定像素网格，52px/小时）。 */
const mockRects = () => {
  const spy = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect");
  spy.mockImplementation(function (this: HTMLElement) {
    if (this.classList.contains("widget-cal-tl-canvas")) {
      return { top: 0, left: 0, width: 300, height: 780, right: 300, bottom: 780, x: 0, y: 0, toJSON: () => ({}) };
    }
    return { top: 0, left: 0, width: 300, height: 100, right: 300, bottom: 100, x: 0, y: 0, toJSON: () => ({}) };
  });
  return spy;
};

describe("CalendarWidget 组件级回归", () => {
  it("默认选中今天：详情面板 + 周条 + 空时间线骨架（刻度常驻）", () => {
    render(<CalendarWidget instanceId="cw1" />);
    // 详情标题：今天日期 + 星期四。
    expect(screen.getByText("2026年10月 星期四", { exact: false })).toBeTruthy();
    // 周条 7 天（周一为界：10-05 ~ 10-11），今天带 today 类。
    const strip = document.querySelector(".widget-cal-weekstrip");
    expect(strip?.querySelectorAll(".widget-cal-weekstrip-day")).toHaveLength(7);
    expect(strip?.querySelector(".today")?.getAttribute("data-wsdate")).toBe("2026-10-08");
    // 无事件：时间轴骨架 15 格刻度 + 空态提示。
    expect(document.querySelectorAll(".widget-cal-tl-hours span").length).toBeGreaterThanOrEqual(15);
    expect(screen.getByText(/暂无安排/)).toBeTruthy();
  });

  it("点月格换天：详情切换 + 周条选中移动", () => {
    render(<CalendarWidget instanceId="cw1" />);
    fireEvent.click(screen.getByRole("button", { name: "2026年10月10日 星期六" }));
    expect(screen.getByText("2026年10月 星期六", { exact: false })).toBeTruthy();
    const strip = document.querySelector(".widget-cal-weekstrip");
    expect(strip?.querySelector(".selected")?.getAttribute("data-wsdate")).toBe("2026-10-10");
  });

  it("添加定时事件：表单提交 → localStorage 落盘 + 时间线出块 + 空态消失", async () => {
    render(<CalendarWidget instanceId="cw2" />);
    const times = screen.getAllByTitle("开始时间（可选）");
    fireEvent.change(times[0], { target: { value: "14:00" } });
    fireEvent.change(screen.getByPlaceholderText("添加事件…"), { target: { value: "下午评审" } });
    fireEvent.click(screen.getByRole("button", { name: "添加" }));
    await flush();
    const stored = readEvents("cw2");
    expect(stored["2026-10-08"]).toHaveLength(1);
    expect(stored["2026-10-08"][0]).toMatchObject({ text: "下午评审", time: "14:00" });
    // 时间线出现该块（aria-label 含时刻与标题）。
    expect(screen.getByRole("button", { name: /14:00.*下午评审/ })).toBeTruthy();
    expect(screen.queryByText(/暂无安排/)).toBeNull();
  });

  it("添加全天事件：进置顶区而非时间轴", async () => {
    render(<CalendarWidget instanceId="cw3" />);
    fireEvent.change(screen.getByPlaceholderText("添加事件…"), { target: { value: "全天事项" } });
    fireEvent.click(screen.getByRole("button", { name: "添加" }));
    await flush();
    const chip = document.querySelector(".widget-cal-allday-chip.event");
    expect(chip?.textContent).toContain("全天事项");
    expect(readEvents("cw3")["2026-10-08"][0].time).toBe("");
  });

  it("删除非重复事件：二次确认 → 落删 → 撤销条 → localStorage 同步", async () => {
    localStorage.setItem(
      KEY("cw4"),
      JSON.stringify({ "2026-10-08": [ev({ id: "d1", text: "临时会", time: "15:00" })] })
    );
    render(<CalendarWidget instanceId="cw4" />);
    // 第一次点删除 → 确认态（title 变化）；再点 → 真删。
    fireEvent.click(screen.getByTitle("删除事件"));
    fireEvent.click(screen.getByTitle("再次点击确认删除"));
    await flush();
    expect(readEvents("cw4")["2026-10-08"]).toBeUndefined();
    expect(screen.getByText(/已删除.*临时会/)).toBeTruthy();
    // 撤销：事件回到存储与界面。
    fireEvent.click(screen.getByRole("button", { name: "撤销" }));
    await flush();
    expect(readEvents("cw4")["2026-10-08"]).toHaveLength(1);
  });

  it("删除重复事件：三选一菜单，「仅此日」把查看日写进例外", async () => {
    localStorage.setItem(
      KEY("cw5"),
      JSON.stringify({ "2026-10-01": [ev({ id: "r1", text: "每周会", time: "09:00", repeat: "weekly" })] })
    );
    render(<CalendarWidget instanceId="cw5" />);
    // 直接点块上的删除（不进入编辑——编辑器 scope 行也有「仅此日」会撞名）。
    fireEvent.click(screen.getByTitle("删除事件"));
    fireEvent.click(screen.getByRole("button", { name: "仅此日" }));
    await flush();
    const stored = readEvents("cw5");
    expect(stored["2026-10-01"][0].excepted).toContain("2026-10-08");
    // 界面上今天不再显示（例外过滤）。
    expect(screen.queryByRole("button", { name: /09:00.*每周会/ })).toBeNull();
  });

  it("编辑重复事件：仅此日保存触发系列分裂（当日单次 + 新锚点续系列）", async () => {
    localStorage.setItem(
      KEY("cw6"),
      JSON.stringify({ "2026-10-08": [ev({ id: "r2", text: "每周例会", time: "09:00", repeat: "weekly" })] })
    );
    render(<CalendarWidget instanceId="cw6" />);
    fireEvent.click(screen.getByRole("button", { name: /09:00.*每周例会/ })); // 进入编辑
    const editor = document.querySelector(".widget-cal-pop-add") as HTMLElement;
    expect(within(editor).getByRole("button", { name: "整个系列" })).toBeTruthy();
    fireEvent.change(within(editor).getByPlaceholderText("修改事件…"), { target: { value: "每周例会（改）" } });
    fireEvent.click(within(editor).getByRole("button", { name: "仅此日" }));
    fireEvent.click(within(editor).getByRole("button", { name: "保存" }));
    await flush();
    const stored = readEvents("cw6");
    expect(stored["2026-10-08"][0]).toMatchObject({ text: "每周例会（改）", repeat: "none" });
    expect(stored["2026-10-15"]).toHaveLength(1); // 续系列新锚点 = 下周四
    expect(stored["2026-10-15"][0]).toMatchObject({ text: "每周例会", repeat: "weekly" });
  });

  it("时间轴空白点击：15 分钟吸附预填添加行", () => {
    const spy = mockRects();
    try {
      render(<CalendarWidget instanceId="cw7" />);
      const canvas = document.querySelector(".widget-cal-tl-canvas") as HTMLElement;
      fireEvent.click(canvas, { clientY: 150 }); // 150/52≈2.88h → 3h → 07:00+3h = 10:00
      const times = screen.getAllByTitle("开始时间（可选）");
      expect((times[0] as HTMLInputElement).value).toBe("10:00");
    } finally {
      spy.mockRestore();
    }
  });

  it("搜索：跨日命中、点击跳转并选中该日", async () => {
    localStorage.setItem(
      KEY("cw8"),
      JSON.stringify({
        "2026-09-20": [ev({ id: "s1", text: "秋游", time: "08:00" })],
        "2026-10-08": [ev({ id: "s2", text: "日常站会", time: "09:00" })]
      })
    );
    render(<CalendarWidget instanceId="cw8" />);
    fireEvent.click(screen.getByRole("button", { name: "搜索事件" }));
    fireEvent.change(screen.getByPlaceholderText("搜索事件 / 地点 / 备注…"), { target: { value: "秋游" } });
    fireEvent.click(screen.getByRole("button", { name: /2026-09-20/ }));
    await flush();
    expect(screen.getByText("2026年9月 星期日", { exact: false })).toBeTruthy();
    expect(screen.getByRole("button", { name: /08:00.*秋游/ })).toBeTruthy();
  });

  it("月格方向键：ArrowRight 选中下一天（不跨月）", () => {
    render(<CalendarWidget instanceId="cw9" />);
    const cell = document.querySelector('[data-cdate="2026-10-08"]') as HTMLElement;
    cell.focus();
    fireEvent.keyDown(cell, { key: "ArrowRight" });
    const strip = document.querySelector(".widget-cal-weekstrip");
    expect(strip?.querySelector(".selected")?.getAttribute("data-wsdate")).toBe("2026-10-09");
  });

  it("拖拽调时刻：pointer 下移 78px（1.5h → 吸附 90min）落盘新时刻、时长保持", () => {
    const spy = mockRects();
    try {
      localStorage.setItem(
        KEY("cw10"),
        JSON.stringify({ "2026-10-08": [ev({ id: "g1", text: "可拖会", time: "09:00", endTime: "10:00" })] })
      );
      render(<CalendarWidget instanceId="cw10" />);
      const block = screen.getByRole("button", { name: /09:00–10:00 可拖会/ });
      // jsdom 未实现 PointerEvent 构造器（fireEvent.pointerX 静默失败）：
      // 用 MouseEvent 承载 pointer* 事件类型（React 根监听只认 type）。
      const ptr = (type: string, init: { clientY?: number } = {}) =>
        new MouseEvent(type, { button: 0, bubbles: true, clientY: init.clientY });
      fireEvent(block, ptr("pointerdown", { clientY: 100 }));
      fireEvent(block, ptr("pointermove", { clientY: 178 })); // +78px ≈ 1.5h → 90min
      fireEvent(block, ptr("pointerup"));
      const stored = readEvents("cw10")["2026-10-08"][0];
      expect(stored).toMatchObject({ time: "10:30", endTime: "11:30" }); // 09:00+90min，时长 1h 保持
    } finally {
      spy.mockRestore();
    }
  });

  it("拖拽阈值内（≤4px）视为点击：进编辑而非改时刻", () => {
    localStorage.setItem(
      KEY("cw11"),
      JSON.stringify({ "2026-10-08": [ev({ id: "g2", text: "点击会", time: "09:00" })] })
    );
    render(<CalendarWidget instanceId="cw11" />);
    const block = screen.getByRole("button", { name: /09:00.*点击会/ });
    const ptr = (type: string, clientY?: number) => new MouseEvent(type, { button: 0, bubbles: true, clientY });
    fireEvent(block, ptr("pointerdown", 100));
    fireEvent(block, ptr("pointermove", 103)); // 3px：阈值内
    fireEvent(block, ptr("pointerup"));
    fireEvent.click(block);
    // 进入编辑（scope 行不存在=非重复无 scope；出现修改占位输入框）。
    expect(screen.getByPlaceholderText("修改事件…")).toBeTruthy();
    expect(readEvents("cw11")["2026-10-08"][0].time).toBe("09:00"); // 时刻未变
  });

  it("块上方向键：ArrowDown ±15 分钟落盘（Shift=±60）", () => {
    localStorage.setItem(
      KEY("cw12"),
      JSON.stringify({ "2026-10-08": [ev({ id: "g3", text: "键盘会", time: "09:00", endTime: "09:30" })] })
    );
    render(<CalendarWidget instanceId="cw12" />);
    const block = screen.getByRole("button", { name: /09:00–09:30 键盘会/ });
    fireEvent.keyDown(block, { key: "ArrowDown" });
    expect(readEvents("cw12")["2026-10-08"][0]).toMatchObject({ time: "09:15", endTime: "09:45" });
    fireEvent.keyDown(block, { key: "ArrowUp", shiftKey: true });
    expect(readEvents("cw12")["2026-10-08"][0]).toMatchObject({ time: "08:15", endTime: "08:45" });
  });
});

/** 2026-10-09 回归：编辑器冻结分裂日——换天后「仅此日」
 *  保存不再记到新查看的日期；仅此日删除的撤销 = 从例外集移回该日，
 *  与系列分裂正交——叠加场景不再复活整系列与分裂产物并存。 */
describe("CalendarWidget · 编辑器分裂日与仅此日撤销（2026-10-09）", () => {
  it("WD-1：编辑器打开后换天再「仅此日」保存——分裂发生在打开编辑器那天，不是换天后的查看日", async () => {
    localStorage.setItem(
      KEY("w1"),
      JSON.stringify({ "2026-10-08": [ev({ id: "w1r", text: "每周例会", time: "09:00", repeat: "weekly" })] })
    );
    render(<CalendarWidget instanceId="w1" />);
    // 今天（10-08 周四，系列命中日）点块进入编辑——冻结日 = 2026-10-08。
    fireEvent.click(screen.getByRole("button", { name: /09:00.*每周例会/ }));
    expect(document.querySelector(".widget-cal-pop-add")).toBeTruthy();
    // 编辑器常驻不卸载的情况下换天（点周条周五 10-09）。注意：换天会替换
    // 编辑器 DOM 节点（组件状态/草稿保留），交互需重取当前节点。
    fireEvent.click(document.querySelector('[data-wsdate="2026-10-09"]') as HTMLElement);
    const editor = document.querySelector(".widget-cal-pop-add") as HTMLElement;
    fireEvent.change(within(editor).getByPlaceholderText("修改事件…"), { target: { value: "每周例会（改）" } });
    fireEvent.click(within(editor).getByRole("button", { name: "仅此日" }));
    fireEvent.click(within(editor).getByRole("button", { name: "保存" }));
    await flush();
    const stored = readEvents("w1");
    // 修复后：once 落在冻结日 10-08（修复前会落到换天后的 10-09）。
    expect(stored["2026-10-08"][0]).toMatchObject({ text: "每周例会（改）", repeat: "none" });
    expect(Object.keys(stored)).not.toContain("2026-10-09");
    // 续系列从冻结日之后重锚 = 下周四 10-15。
    expect(stored["2026-10-15"]).toHaveLength(1);
  });

  it("WD-4：仅此日删除 → 仅此日编辑叠加后撤销——例外日移回、分裂产物保留（不再整系列复活双份）", async () => {
    localStorage.setItem(
      KEY("w2"),
      JSON.stringify({ "2026-10-05": [ev({ id: "w2r", text: "晨会", time: "09:00", repeat: "daily" })] })
    );
    render(<CalendarWidget instanceId="w2" />);
    // ① 今天 10-08（daily 命中）：仅此日删除。
    fireEvent.click(screen.getByTitle("删除事件"));
    fireEvent.click(screen.getByRole("button", { name: "仅此日" }));
    await flush();
    expect(readEvents("w2")["2026-10-05"][0].excepted).toContain("2026-10-08");
    // ② 撤销窗内（fake timers 冻结）：换到 10-09 对同一系列做「仅此日」编辑。
    fireEvent.click(document.querySelector('[data-wsdate="2026-10-09"]') as HTMLElement);
    fireEvent.click(screen.getByRole("button", { name: /09:00.*晨会/ }));
    const editor = document.querySelector(".widget-cal-pop-add") as HTMLElement;
    fireEvent.change(within(editor).getByPlaceholderText("修改事件…"), { target: { value: "晨会（改）" } });
    fireEvent.click(within(editor).getByRole("button", { name: "仅此日" }));
    fireEvent.click(within(editor).getByRole("button", { name: "保存" }));
    await flush();
    // 分裂后：残系列（保原 id，终止 10-08）+ once@10-09 + 续系列@10-10。
    expect(readEvents("w2")["2026-10-05"][0]).toMatchObject({ repeatUntil: "2026-10-08" });
    expect(readEvents("w2")["2026-10-09"][0]).toMatchObject({ text: "晨会（改）", repeat: "none" });
    expect(readEvents("w2")["2026-10-10"]).toHaveLength(1);
    // ③ 撤销①的删除：例外集移回 10-08，分裂产物原样保留。
    fireEvent.click(screen.getByRole("button", { name: "撤销" }));
    await flush();
    const stored = readEvents("w2");
    expect(stored["2026-10-05"][0].excepted).not.toContain("2026-10-08");
    // 残系列仍终止在 10-08（修复前会被整对象替换回未截断快照 → 未来日双份）。
    expect(stored["2026-10-05"][0].repeatUntil).toBe("2026-10-08");
    expect(stored["2026-10-09"][0].text).toBe("晨会（改）");
    expect(stored["2026-10-10"]).toHaveLength(1);
  });
});
