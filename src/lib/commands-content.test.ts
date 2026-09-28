import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildCommands } from "./commands";
import { useAppStore } from "../store/app-store";
import { useWidgetStore } from "../widget/widget-store";
import { saveNotes } from "../widget/notes-store";

/* 书签段按 isTauri 门控（open_path 落地），jsdom 下 mock 为桌面态。 */
vi.mock("../lib/tauri", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../lib/tauri")>();
  return { ...orig, isTauri: () => true, invoke: vi.fn(async () => {}) };
});

/**
 * 命令面板内容级搜索：有查询词时便签/待办/DDL/书签进入 `content-` 段并
 * 预匹配；空查询不产生内容条目（首屏命令列表不被内容淹没）。
 * 落地动作依赖定位/打开等窗口副作用，这里只断言目录结构与匹配行为。
 */

const tr = (s: string) => s;
const opts = { settingsQuery: "", fallbackQuery: "", close: () => {} };

describe("buildCommands 内容级搜索段", () => {
  beforeEach(() => {
    localStorage.clear();
    useAppStore.setState({
      tasks: [
        {
          id: "t1",
          title: "买咖啡豆",
          completed: false,
          createdAt: "2026-09-24T00:00:00.000Z",
          dueAt: "",
          priority: 0,
          tags: [],
          sortOrder: 0
        },
        {
          id: "t2",
          title: "写周报",
          completed: true,
          createdAt: "2026-09-24T00:00:00.000Z",
          dueAt: "",
          priority: 0,
          tags: [],
          sortOrder: 1
        }
      ],
      deadlines: [
        {
          id: "d1",
          title: "项目验收",
          dueAt: "2026-10-01T00:00:00.000Z",
          notified: false,
          completed: false,
          notifiedTiers: [],
          repeat: "none"
        }
      ]
    });
    useWidgetStore.setState({ instances: [], views: [{ id: "v1", name: "默认" }], activeView: "v1" });
    saveNotes("note-inst-1", [{ id: "n1", text: "创业板指数跟踪笔记\n第二行", updatedAt: "2026-09-24T00:00:00.000Z" }]);
    localStorage.setItem(
      "focus-desk.bookmarks.bm-1",
      JSON.stringify([{ id: "b1", name: "MDN", url: "https://developer.mozilla.org" }])
    );
  });

  it("空查询不产生内容条目；基础命令不受影响", () => {
    const cmds = buildCommands(tr, opts);
    expect(cmds.some((c) => c.id.startsWith("content-"))).toBe(false);
    expect(cmds.some((c) => c.id === "edit-mode")).toBe(true);
  });

  it("查询命中便签（全文匹配，标题取首行）", () => {
    const cmds = buildCommands(tr, { ...opts, settingsQuery: "创业板" });
    const note = cmds.find((c) => c.id === "content-note-note-inst-1-n1");
    expect(note).toBeDefined();
    expect(note!.label).toBe("创业板指数跟踪笔记");
    expect(note!.group).toBe("便签");
  });

  it("查询命中待办（带完成态提示）与 DDL", () => {
    const todo = buildCommands(tr, { ...opts, settingsQuery: "周报" }).find((c) => c.id === "content-task-t2");
    expect(todo).toBeDefined();
    expect(todo!.hint).toBe("已完成");
    const ddl = buildCommands(tr, { ...opts, settingsQuery: "验收" }).find((c) => c.id === "content-ddl-d1");
    expect(ddl).toBeDefined();
  });

  it("书签按名称或 URL 匹配；不匹配查询的源不进段", () => {
    const bm = buildCommands(tr, { ...opts, settingsQuery: "mozilla" }).find((c) => c.group === "书签");
    expect(bm).toBeDefined();
    expect(bm!.hint).toBe("https://developer.mozilla.org");
    const none = buildCommands(tr, { ...opts, settingsQuery: "绝不存在的查询词xyz" }).filter((c) =>
      c.id.startsWith("content-")
    );
    expect(none).toHaveLength(0);
  });
});
