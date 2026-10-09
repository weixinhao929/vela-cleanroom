/**
 * shortcuts-shared 纯函数测试（自愈迁移辅助 + 快捷方式文件夹）：
 *  - isLinkFileEntry：识别仍指向 .lnk/.url 链接本体的旧条目；
 *  - applyResolvedTargets：解析结果按 id 回灌，幂等（未命中/已同值返回原引用）；
 *  - loadShortcutFolders / folderMemberIds / pruneFolderChildren：文件夹配置的
 *    容错解析、成员集合与删除后的悬挂引用清理（无变化返回原引用）。
 */
import { describe, expect, it } from "vitest";

import {
  applyResolvedTargets,
  clampPage,
  folderMemberIds,
  isLinkFileEntry,
  loadShortcutFolders,
  markEntriesMissing,
  mergeWatchRows,
  pageCountOf,
  pageIndexOf,
  pruneFolderChildren,
  reorderChildIds,
  sortFolderItems,
  uniqueFolderLabel,
  type CustomShortcut
} from "./shortcuts-shared";

const item = (over: Partial<CustomShortcut>): CustomShortcut => ({
  id: "x",
  label: "工具",
  path: "C:/apps/tool.exe",
  kind: "file",
  ...over
});

describe("isLinkFileEntry", () => {
  it("链接本体路径命中（大小写不敏感，.lnk 与 .url）", () => {
    expect(isLinkFileEntry(item({ path: "C:\\Users\\me\\Desktop\\工具.lnk" }))).toBe(true);
    expect(isLinkFileEntry(item({ path: "C:\\Users\\me\\Desktop\\站点.LNK" }))).toBe(true);
    expect(isLinkFileEntry(item({ path: "C:/links/站点.url" }))).toBe(true);
  });

  it("已解析的目标路径与网页链接不命中", () => {
    expect(isLinkFileEntry(item({ path: "C:/apps/tool.exe" }))).toBe(false);
    expect(isLinkFileEntry(item({ path: "C:/要/目录" }))).toBe(false);
    expect(isLinkFileEntry(item({ path: "https://example.com" }))).toBe(false);
  });
});

describe("applyResolvedTargets", () => {
  const items = [
    item({ id: "a", path: "C:/links/a.lnk", kind: "file" }),
    item({ id: "b", path: "C:/apps/b.exe", kind: "file" })
  ];

  it("按 id 改写命中条目的 path/kind，其余条目与顺序原样保留", () => {
    const next = applyResolvedTargets(items, [{ id: "a", path: "C:/apps/a.exe", kind: "file" }]);
    expect(next).not.toBe(items);
    expect(next[0]).toEqual({ ...items[0], path: "C:/apps/a.exe" });
    expect(next[1]).toBe(items[1]);
  });

  it("空 fixes / 无命中 / 目标与现值相同：返回原引用（零写入）", () => {
    expect(applyResolvedTargets(items, [])).toBe(items);
    expect(applyResolvedTargets(items, [{ id: "missing", path: "C:/x.exe", kind: "file" }])).toBe(items);
    expect(applyResolvedTargets(items, [{ id: "b", path: "C:/apps/b.exe", kind: "file" }])).toBe(items);
  });
});

describe("loadShortcutFolders", () => {
  it("容错解析：坏条目丢弃、childIds 只留字符串，合法条目保留", () => {
    const folders = loadShortcutFolders({
      shortcutFolders: [
        { id: "f1", label: "工作", childIds: ["a", 3, null] },
        null,
        { id: "f2", label: "空", childIds: "oops" },
        { label: "无 id" },
        "junk"
      ]
    });
    expect(folders).toEqual([
      { id: "f1", label: "工作", childIds: ["a"] },
      { id: "f2", label: "空", childIds: [] }
    ]);
  });

  it("非数组 / 缺字段回退空表", () => {
    expect(loadShortcutFolders({})).toEqual([]);
    expect(loadShortcutFolders({ shortcutFolders: "nope" })).toEqual([]);
  });
});

describe("folderMemberIds / pruneFolderChildren", () => {
  const folders = [
    { id: "f1", label: "工作", childIds: ["a", "b"] },
    { id: "f2", label: "生活", childIds: ["c"] }
  ];

  it("folderMemberIds 汇总全部成员 id", () => {
    expect(folderMemberIds(folders)).toEqual(new Set(["a", "b", "c"]));
    expect(folderMemberIds([])).toEqual(new Set());
  });

  it("pruneFolderChildren 剔除被删条目的引用；无命中返回原引用（零写入）", () => {
    const next = pruneFolderChildren(folders, new Set(["a", "c"]));
    expect(next).toEqual([
      { id: "f1", label: "工作", childIds: ["b"] },
      { id: "f2", label: "生活", childIds: [] }
    ]);
    expect(pruneFolderChildren(folders, new Set(["missing"]))).toBe(folders);
    expect(pruneFolderChildren(folders, new Set())).toBe(folders);
  });
});

describe("markEntriesMissing", () => {
  it("按归一路径标记 missing；url 条目不参与；路径大小写/分隔符差异归一", () => {
    const list = [
      item({ id: "a", path: "C:/gone/a.exe", kind: "file" }),
      item({ id: "b", path: "C:/ok/b.exe", kind: "file" }),
      item({ id: "u", path: "https://example.com", kind: "url" })
    ];
    const next = markEntriesMissing(list, new Set(["c:/GONE/a.exe"]));
    expect(next[0]).toEqual({ ...list[0], missing: true });
    expect(next[1]).toBe(list[1]);
    expect(next[2]).toBe(list[2]);
  });

  it("路径恢复后解除标记（重建对象剥掉 missing 键）", () => {
    const list = [item({ id: "a", path: "C:/back/a.exe", kind: "file", missing: true })];
    const next = markEntriesMissing(list, new Set());
    expect(next[0]).toEqual({ id: "a", label: "工具", path: "C:/back/a.exe", kind: "file" });
    expect("missing" in next[0]).toBe(false);
  });

  it("无变化返回原引用（幂等零写）", () => {
    const list = [
      item({ id: "a", path: "C:/gone/a.exe", kind: "file", missing: true }),
      item({ id: "b", path: "C:/ok/b.exe", kind: "file" })
    ];
    expect(markEntriesMissing(list, new Set(["c:/gone/a.exe"]))).toBe(list);
    expect(markEntriesMissing([], new Set(["x"]))).toEqual([]);
  });
});

describe("reorderChildIds（弹层拖拽重排）", () => {
  const order = ["a", "b", "c", "d"];

  it("后移：移到目标之前", () => {
    expect(reorderChildIds(order, "a", "c")).toEqual(["b", "a", "c", "d"]);
  });

  it("前移：移到目标之前", () => {
    expect(reorderChildIds(order, "d", "b")).toEqual(["a", "d", "b", "c"]);
  });

  it("null = 追加末尾", () => {
    expect(reorderChildIds(order, "a", null)).toEqual(["b", "c", "d", "a"]);
  });

  it("相邻原位 / 未知 dragId：返回等价或原序", () => {
    expect(reorderChildIds(order, "a", "b")).toEqual(order);
    expect(reorderChildIds(order, "zz", "b")).toEqual(order);
  });
});

describe("sortFolderItems", () => {
  const list = [
    { id: "1", label: "丙工具" },
    { id: "2", label: "甲工具" },
    { id: "3", label: "乙工具" }
  ];

  it("free 原样返回（新数组，不改 childIds 序）", () => {
    expect(sortFolderItems(list, "free")).toEqual(list);
    expect(sortFolderItems(list, "free")).not.toBe(list);
  });

  it("name 区域感知名称序，稳定排序", () => {
    // zh 拼音序：丙(bǐng) < 甲(jiǎ) < 乙(yǐ)。
    expect(sortFolderItems(list, "name").map((i) => i.label)).toEqual(["丙工具", "甲工具", "乙工具"]);
  });

  it("time 按修改时间倒序（最新在前，未知时间排最后）", () => {
    const mtimes: Record<string, number> = { "1": 100, "2": 300, "3": 0 };
    const out = sortFolderItems(list, "time", (i) => mtimes[i.id] ?? 0);
    expect(out.map((i) => i.id)).toEqual(["2", "1", "3"]);
  });
});

describe("uniqueFolderLabel（重名避让）", () => {
  it("未占用原样返回", () => {
    expect(uniqueFolderLabel(new Set(["其它"]), "新建文件夹")).toBe("新建文件夹");
  });

  it("被占用生成 (n) 后缀试探到空闲", () => {
    const taken = new Set(["新建文件夹", "新建文件夹 (2)", "新建文件夹 (3)"]);
    expect(uniqueFolderLabel(taken, "新建文件夹")).toBe("新建文件夹 (4)");
    expect(uniqueFolderLabel(new Set(["新建文件夹"]), "新建文件夹")).toBe("新建文件夹 (2)");
  });

  it("首尾空白归一比较", () => {
    expect(uniqueFolderLabel(new Set([" 新建文件夹 "]), "新建文件夹")).toBe("新建文件夹 (2)");
  });
});

describe("分页纯函数", () => {
  it("pageCountOf：向上取整，非正入参回退单页", () => {
    expect(pageCountOf(0, 12)).toBe(1);
    expect(pageCountOf(13, 12)).toBe(2);
    expect(pageCountOf(24, 12)).toBe(2);
    expect(pageCountOf(5, 0)).toBe(1);
  });

  it("pageIndexOf：下标折算页码", () => {
    expect(pageIndexOf(0, 12)).toBe(0);
    expect(pageIndexOf(11, 12)).toBe(0);
    expect(pageIndexOf(12, 12)).toBe(1);
    expect(pageIndexOf(3, 0)).toBe(0);
  });

  it("clampPage：钳进 [0, pages-1]", () => {
    expect(clampPage(3, 2)).toBe(1);
    expect(clampPage(-1, 2)).toBe(0);
    expect(clampPage(1, 0)).toBe(0);
  });
});

describe("mergeWatchRows（watch 提交前行级合并）", () => {
  const cur = [item({ id: "a", path: "C:/old/a.exe" }), item({ id: "b", path: "C:/ok/b.exe" })];
  // watch 处理的产物：a 行改名后重建对象，b 行未命中沿用引用。
  const next = [item({ id: "a", path: "C:/new/a.exe" }), cur[1]];

  it("并发写窗口内：改过的行替换、并发新增的行保留", () => {
    const concurrent = [...cur, item({ id: "c", path: "C:/drop/c.exe" })];
    const merged = mergeWatchRows(concurrent, next);
    expect(merged).not.toBeNull();
    expect(merged!.map((s) => s.id)).toEqual(["a", "b", "c"]);
    expect(merged![0].path).toBe("C:/new/a.exe");
    expect(merged![1]).toBe(concurrent[1]);
    expect(merged![2]).toBe(concurrent[2]);
  });

  it("next 多出的行追加（保险路径）", () => {
    const merged = mergeWatchRows([cur[1]], next);
    expect(merged!.map((s) => s.id)).toEqual(["b", "a"]);
  });

  it("无实际差异返回 null（零空写）——引用比较，非对象字符串化", () => {
    // 回归锚点：此前的 join("|") 实现里下面这个场景会因两边都串成
    // "[object Object]" 而恒判相等（丢写）；无差异时则恒判相等（碰巧对）。
    expect(mergeWatchRows(cur, next)).not.toBeNull();
    expect(mergeWatchRows(cur, [cur[0], cur[1]])).toBeNull();
    expect(mergeWatchRows([], [])).toBeNull();
  });
});

describe("loadShortcutFolders 保留 sort 字段", () => {
  it("合法 sort 保留、非法丢弃", () => {
    const folders = loadShortcutFolders({
      shortcutFolders: [
        { id: "f1", label: "A", childIds: [], sort: "name" },
        { id: "f2", label: "B", childIds: [], sort: "bogus" },
        { id: "f3", label: "C", childIds: [] }
      ]
    });
    expect(folders[0]).toEqual({ id: "f1", label: "A", childIds: [], sort: "name" });
    expect(folders[1]).toEqual({ id: "f2", label: "B", childIds: [] });
    expect(folders[2]).toEqual({ id: "f3", label: "C", childIds: [] });
  });
});
