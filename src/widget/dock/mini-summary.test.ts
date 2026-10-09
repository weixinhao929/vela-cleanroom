/**
 * 通用磁贴摘要测试：registry 为无富形态（MiniComponent）的常见入岛类型
 * （今日概览 / 截止日期 / 便签 / 回收站 / 快捷方式 / 桌面文件）登记的
 * miniSummary 同步快照 + miniSummarySubscribe 变更通知，以及 i18n-lite
 * 的 `{n}` 占位符替换（机制）。
 *
 * 摘要经 getWidgetMeta(type).miniSummary 消费（与 DockTile 同路径），
 * 直接断言中文文案；英文走词典映射，缺省回退中文。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getWidgetMeta } from "../registry";
import { useAppStore } from "../../store/app-store";
import { useWidgetStore, type TrashWidget } from "../widget-store";
import { t } from "../../i18n-lite";
import type { Deadline, Task } from "../../domain/schemas";

const NOW = Date.now();
const iso = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();

function task(id: string, completed: boolean): Task {
  return {
    id,
    title: id,
    completed,
    createdAt: iso(0),
    dueAt: "",
    priority: 0,
    tags: [],
    sortOrder: 0
  };
}

function deadline(id: string, completed: boolean, dueOffsetMs: number): Deadline {
  return {
    id,
    title: id,
    dueAt: iso(dueOffsetMs),
    notified: false,
    completed,
    notifiedTiers: [],
    repeat: "none"
  };
}

function trashWidget(id: string): TrashWidget {
  return { id, type: "clock", x: 0, y: 0, w: 100, h: 100, z: 1, view: "main", deletedAt: iso(0) };
}

function summaryOf(type: string, instanceId?: string): string {
  const meta = getWidgetMeta(type);
  expect(meta, `registry 缺少 ${type} 条目`).toBeTruthy();
  expect(meta!.miniSummary, `${type} 未登记 miniSummary`).toBeTypeOf("function");
  return meta!.miniSummary!(instanceId);
}

describe("t() 占位符替换（G14 机制）", () => {
  it("替换已提供的占位符", () => {
    expect(t("{n} 项未完成 · 逾期 {k}", { n: 2, k: 1 })).toBe("2 项未完成 · 逾期 1");
    expect(t("共 {n} 条", { n: 5 })).toBe("共 5 条");
  });

  it("未提供 / 未知的占位符原样保留", () => {
    expect(t("共 {n} 条")).toBe("共 {n} 条");
    expect(t("共 {n} 条", {})).toBe("共 {n} 条");
  });

  it("无参数调用与纯文本不受影响", () => {
    expect(t("空")).toBe("空");
  });
});

describe("通用磁贴摘要（G8）", () => {
  const appPrev = { tasks: useAppStore.getState().tasks, deadlines: useAppStore.getState().deadlines };
  const trashPrev = useWidgetStore.getState().trash;

  beforeEach(() => {
    useAppStore.setState({ tasks: [], deadlines: [] });
    useWidgetStore.setState({ trash: [] });
    localStorage.clear();
  });

  afterEach(() => {
    useAppStore.setState({ tasks: appPrev.tasks, deadlines: appPrev.deadlines });
    useWidgetStore.setState({ trash: trashPrev });
    localStorage.clear();
  });

  it("今日概览：未完成待办数，零时显示无待办", () => {
    useAppStore.setState({
      tasks: [task("a", false), task("b", false), task("c", true)]
    });
    expect(summaryOf("todayoverview")).toBe("2 项待办");
    useAppStore.setState({ tasks: [task("c", true)] });
    expect(summaryOf("todayoverview")).toBe("今日无待办");
  });

  it("截止日期：未完成数与逾期数，与 DeadlinePanel 同口径", () => {
    useAppStore.setState({
      deadlines: [
        deadline("overdue", false, -86_400_000),
        deadline("future", false, 86_400_000),
        deadline("done", true, -86_400_000)
      ]
    });
    expect(summaryOf("deadlines")).toBe("2 项未完成 · 逾期 1");
    useAppStore.setState({ deadlines: [deadline("future", false, 86_400_000)] });
    expect(summaryOf("deadlines")).toBe("1 项未完成");
    useAppStore.setState({ deadlines: [] });
    expect(summaryOf("deadlines")).toBe("无未完成截止");
  });

  it("便签：按实例计数，未绑定实例不显示摘要", () => {
    localStorage.setItem("focus-desk.notes.notes-1", JSON.stringify([{ id: "1", text: "a", updatedAt: iso(0) }]));
    expect(summaryOf("notes", "notes-1")).toBe("共 1 条");
    expect(summaryOf("notes", "missing")).toBe("共 0 条");
    expect(summaryOf("notes")).toBe("");
  });

  it("回收站：可恢复数，空时显示空", () => {
    useWidgetStore.setState({ trash: [trashWidget("a"), trashWidget("b")] });
    expect(summaryOf("recycle")).toBe("2 个可恢复");
    useWidgetStore.setState({ trash: [] });
    expect(summaryOf("recycle")).toBe("空");
  });

  it("快捷方式：自定义条目数，未添加 / 未绑定实例的文案", () => {
    localStorage.setItem(
      "focus-desk.widget-config.sc-1.v1",
      JSON.stringify({ customShortcuts: [{ id: "1" }, { id: "2" }, { id: "3" }] })
    );
    expect(summaryOf("shortcuts", "sc-1")).toBe("共 3 个");
    localStorage.setItem("focus-desk.widget-config.sc-2.v1", JSON.stringify({}));
    expect(summaryOf("shortcuts", "sc-2")).toBe("未添加");
    expect(summaryOf("shortcuts")).toBe("");
  });

  it("桌面文件：根目录名，未设置显示桌面", () => {
    localStorage.setItem("focus-desk.widget-config.fb-1.v1", JSON.stringify({ root: "C:\\Users\\me\\Pictures" }));
    expect(summaryOf("files", "fb-1")).toBe("Pictures");
    localStorage.setItem("focus-desk.widget-config.fb-2.v1", JSON.stringify({ root: "D:/Docs/" }));
    expect(summaryOf("files", "fb-2")).toBe("Docs");
    localStorage.setItem("focus-desk.widget-config.fb-3.v1", JSON.stringify({}));
    expect(summaryOf("files", "fb-3")).toBe("桌面");
    expect(summaryOf("files")).toBe("");
  });

  it("miniSummarySubscribe：数据变化触发回调，退订后不再触发", () => {
    let fired = 0;
    const unsub = getWidgetMeta("deadlines")!.miniSummarySubscribe!("tile-1", () => {
      fired += 1;
    });
    useAppStore.setState({ deadlines: [deadline("future", false, 86_400_000)] });
    expect(fired).toBe(1);
    unsub();
    useAppStore.setState({ deadlines: [] });
    expect(fired).toBe(1);
  });

  it("快捷方式 / 桌面文件订阅本实例的配置变更事件", () => {
    for (const type of ["shortcuts", "files"]) {
      let fired = 0;
      const unsub = getWidgetMeta(type)!.miniSummarySubscribe!("cfg-1", () => {
        fired += 1;
      });
      window.dispatchEvent(new CustomEvent("focus-desk:widget-config-changed", { detail: "cfg-1" }));
      expect(fired, type).toBe(1);
      window.dispatchEvent(new CustomEvent("focus-desk:widget-config-changed", { detail: "other" }));
      expect(fired, type).toBe(1);
      unsub();
    }
  });
});
