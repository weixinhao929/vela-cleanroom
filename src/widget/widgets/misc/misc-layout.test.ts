import { describe, expect, it } from "vitest";
import {
  collides,
  compactLayout,
  findFreeSlot,
  gridSizeFor,
  moveItem,
  placeNewItem,
  removeItem,
  resizeItem,
  sanitizeMiscItems,
  type MiscItem
} from "./misc-layout";

/**
 * 「杂项」面板网格引擎：
 *  - 压实：条目向上填空，拖动中的条目钉住不动；
 *  - 移动：目标格被占 → 压住的条目连锁下推，其余上移填空，无重叠；越界钳回；
 *  - 新增：扫第一个放得下的空位；移除后压实；
 *  - 校验：坏条目 / 重复 id 剔除，重叠后来者下推，结果无重叠。
 */
const it_ = (id: string, x: number, y: number, w = 1, h = 1): MiscItem => ({ id, type: "clock", x, y, w, h });

function assertNoOverlap(items: MiscItem[]) {
  for (const a of items)
    for (const b of items) if (a.id !== b.id) expect(collides(a, b), `${a.id} × ${b.id}`).toBe(false);
}

describe("misc-layout", () => {
  it("gridSizeFor：常规 320×200 卡片 → 2×2；小工具 160 宽 → 1 列；超大钳到列数 / 4 行", () => {
    expect(gridSizeFor({ w: 320, h: 200 })).toEqual({ w: 2, h: 2 });
    expect(gridSizeFor({ w: 160, h: 100 })).toEqual({ w: 1, h: 1 });
    expect(gridSizeFor({ w: 2000, h: 2000 })).toEqual({ w: 4, h: 4 });
  });

  it("compactLayout：悬空的条目向上填空，同列先来者在上；钉住的条目不动", () => {
    const out = compactLayout([it_("a", 0, 3), it_("b", 0, 0), it_("c", 1, 5, 2, 2)]);
    const pos = Object.fromEntries(out.map((i) => [i.id, [i.x, i.y]]));
    expect(pos).toEqual({ a: [0, 1], b: [0, 0], c: [1, 0] });
    // 钉住 a 在 y=3：b 压到 0，a 不动。
    const pinned = compactLayout([it_("a", 0, 3), it_("b", 0, 0)], 4, "a");
    expect(pinned.find((i) => i.id === "a")!.y).toBe(3);
    expect(pinned.find((i) => i.id === "b")!.y).toBe(0);
  });

  it("moveItem：移到被占的格 → 原占位者下推、无重叠；越界钳回列内", () => {
    const start = [it_("a", 0, 0, 2, 1), it_("b", 2, 0, 2, 1), it_("c", 0, 1, 2, 1)];
    const out = moveItem(start, "b", 0, 0);
    const b = out.find((i) => i.id === "b")!;
    expect([b.x, b.y]).toEqual([0, 0]);
    assertNoOverlap(out);
    // a 被推到 b 下面，c 再往下（连锁），之后压实：a=1, c=2。
    expect(out.find((i) => i.id === "a")!.y).toBe(1);
    expect(out.find((i) => i.id === "c")!.y).toBe(2);
    // 顺序与 key 稳定：输出顺序等于输入顺序。
    expect(out.map((i) => i.id)).toEqual(["a", "b", "c"]);

    const clamped = moveItem(start, "b", 99, -5);
    const b2 = clamped.find((i) => i.id === "b")!;
    expect([b2.x, b2.y]).toEqual([2, 0]);
    expect(moveItem(start, "zzz", 0, 0)).toEqual(start);
  });

  it("placeNewItem / findFreeSlot：先填第一行空隙，满了才开新行；removeItem 后压实", () => {
    let items = placeNewItem([], { id: "a", type: "clock", w: 2, h: 2 });
    items = placeNewItem(items, { id: "b", type: "weather", w: 2, h: 1 });
    items = placeNewItem(items, { id: "c", type: "todo", w: 1, h: 1 });
    const pos = Object.fromEntries(items.map((i) => [i.id, [i.x, i.y]]));
    expect(pos).toEqual({ a: [0, 0], b: [2, 0], c: [2, 1] });
    expect(findFreeSlot(items, 4, 1)).toEqual({ x: 0, y: 2 });
    assertNoOverlap(items);

    const after = removeItem(items, "a");
    expect(after.map((i) => i.id)).toEqual(["b", "c"]);
    expect(after.find((i) => i.id === "c")!.y).toBe(1); // 仍在 b 下面（同列）
    // 宽度超过列数的条目钳到整行。
    expect(placeNewItem([], { id: "wide", type: "x", w: 9, h: 1 })[0].w).toBe(4);
  });

  it("resizeItem：原地改尺寸、压住谁谁下推；宽出右缘 x 左移钳回；高钳 1..4；未知 id 原样返回", () => {
    const start = [it_("a", 0, 0, 1, 1), it_("b", 1, 0, 2, 1), it_("c", 0, 1, 4, 1)];
    // a 变 2×1：压到 b → b 下推；压实后 b 在 a 右侧同一行放不下 → b 落到下一行。
    const out = resizeItem(start, "a", 2, 1);
    const a = out.find((i) => i.id === "a")!;
    expect([a.x, a.y, a.w, a.h]).toEqual([0, 0, 2, 1]);
    assertNoOverlap(out);
    // a 变 4×2：x 钳回 0，b 下推到 y=2（a 占 0-1 行）。
    const wide = resizeItem(start, "a", 9, 99);
    const wa = wide.find((i) => i.id === "a")!;
    expect([wa.x, wa.w, wa.h]).toEqual([0, 4, 4]);
    assertNoOverlap(wide);
    // 缩小：不移动别人（只压实）。
    const shrink = resizeItem([it_("a", 0, 0, 2, 2), it_("b", 0, 2, 1, 1)], "a", 1, 1);
    expect(shrink.find((i) => i.id === "a")!.w).toBe(1);
    expect(shrink.find((i) => i.id === "b")!.y).toBe(1); // 压实上移
    expect(resizeItem(start, "zzz", 2, 2)).toEqual(start);
  });

  it("sanitizeMiscItems：非数组 → []；坏条目 / 重复 id 剔除；越界钳回；重叠后来者下推；结果无重叠且压实", () => {
    expect(sanitizeMiscItems(null)).toEqual([]);
    expect(sanitizeMiscItems("x")).toEqual([]);
    const out = sanitizeMiscItems([
      { id: "a", type: "clock", x: 0, y: 0, w: 2, h: 1 },
      { id: "a", type: "clock", x: 3, y: 3 }, // 重复 id
      { id: "b", type: "weather", x: 9, y: -2, w: 2, h: 1 }, // 越界 → x=2,y=0
      { id: "c", type: "todo", x: 0, y: 0, w: 2, h: 1 }, // 与 a 重叠 → 下推
      { type: "no-id" },
      { id: "d", type: "x", x: "1", y: 7, w: 0, h: 99 } // 坏值回退：x=0,w=1,h=4
    ]);
    expect(out.map((i) => i.id)).toEqual(["a", "b", "c", "d"]);
    assertNoOverlap(out);
    const pos = Object.fromEntries(out.map((i) => [i.id, [i.x, i.y, i.w, i.h]]));
    expect(pos.a).toEqual([0, 0, 2, 1]);
    expect(pos.b).toEqual([2, 0, 2, 1]);
    expect(pos.c).toEqual([0, 1, 2, 1]);
    expect(pos.d).toEqual([0, 2, 1, 4]);
  });
});
