import { beforeEach, describe, expect, it } from "vitest";
import {
  QUICK_NOTE_FALLBACK_ID,
  absorbQuickNoteOrphan,
  exportNotesMarkdown,
  loadNotes,
  parseNotesImport,
  pickQuickNoteTarget,
  saveNotes
} from "./notes-store";
import { parseNetscapeBookmarks } from "./widgets/BookmarksWidget";

describe("notes export/import roundtrip (W-065)", () => {
  it("导出 → 导入还原 id/正文/颜色/置顶", () => {
    const notes = [
      { id: "a1", text: "第一条\n- [ ] 待办", updatedAt: "2026-08-17T10:00:00.000Z", pinned: true, color: "amber" },
      { id: "b2", text: "第二条", updatedAt: "2026-08-16T09:00:00.000Z" }
    ];
    const parsed = parseNotesImport(exportNotesMarkdown(notes));
    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toMatchObject({ id: "a1", pinned: true, color: "amber" });
    expect(parsed[0].text).toBe("第一条\n- [ ] 待办");
    expect(parsed[1]).toMatchObject({ id: "b2", pinned: false });
  });

  it("无标记的纯文本整体作为一条新便签", () => {
    const parsed = parseNotesImport("就是一段随手粘贴的文本");
    expect(parsed).toHaveLength(1);
    expect(parsed[0].text).toBe("就是一段随手粘贴的文本");
    expect(parsed[0].id).toBeTruthy();
  });

  it("空文本导入返回空数组", () => {
    expect(parseNotesImport("   ")).toHaveLength(0);
  });
});

describe("quick-note 落点与兜底桶吸收（黑洞修复）", () => {
  beforeEach(() => localStorage.clear());

  const mk = (id: string) => ({ id, text: `t-${id}`, updatedAt: "2026-09-24T10:00:00.000Z" });

  it("没有任何便签实例时速记落到固定兜底桶", () => {
    expect(pickQuickNoteTarget()).toBe(QUICK_NOTE_FALLBACK_ID);
  });

  it("有实例时取便签数最多的实例作为落点", () => {
    saveNotes("a", [mk("1")]);
    saveNotes("b", [mk("2"), mk("3")]);
    expect(pickQuickNoteTarget()).toBe("b");
  });

  it("absorbQuickNoteOrphan 把孤儿便签搬进实例并删除兜底桶", () => {
    saveNotes(QUICK_NOTE_FALLBACK_ID, [mk("q1"), mk("q2")]);
    saveNotes("real", [mk("r1")]);
    expect(absorbQuickNoteOrphan("real")).toBe(2);
    expect(loadNotes("real").map((n) => n.id)).toEqual(["q1", "q2", "r1"]);
    expect(loadNotes(QUICK_NOTE_FALLBACK_ID)).toHaveLength(0);
  });

  it("无孤儿时吸收为 no-op；兜底 id 自身不吸收", () => {
    saveNotes("real", [mk("r1")]);
    expect(absorbQuickNoteOrphan("real")).toBe(0);
    expect(loadNotes("real").map((n) => n.id)).toEqual(["r1"]);
    saveNotes(QUICK_NOTE_FALLBACK_ID, [mk("q1")]);
    expect(absorbQuickNoteOrphan(QUICK_NOTE_FALLBACK_ID)).toBe(0);
    expect(loadNotes(QUICK_NOTE_FALLBACK_ID)).toHaveLength(1);
  });
});

describe("netscape bookmark import (W-072 shape)", () => {
  it("解析嵌套文件夹结构", () => {
    const html = `
      <!DOCTYPE NETSCAPE-Bookmark-file-1>
      <DL><p>
        <DT><A HREF="https://github.com">GitHub</A>
        <DT><H3>工作</H3>
        <DL><p>
          <DT><A HREF="https://example.com/work">工作站</A>
        </DL><p>
      </DL><p>`;
    const out = parseNetscapeBookmarks(html);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ name: "GitHub", url: "https://github.com", group: undefined });
    expect(out[1]).toMatchObject({ name: "工作站", url: "https://example.com/work", group: "工作" });
  });
});
