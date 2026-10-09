/**
 * 批量自动排布测试：纯函数 + store 动作。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { computeArrangement, type ArrangeRect } from "./arrange";
import { useWidgetStore, flushWidgetLayoutSync, loadInstances } from "./widget-store";
import type { WidgetInstance } from "./widget-store";

vi.mock("../lib/local-backup", () => ({ persistMirrored: () => true }));

const VP = { w: 1920, h: 1080 };

const r = (id: string, x: number, y: number, w = 100, h = 100): ArrangeRect => ({ id, x, y, w, h });

const inst = (id: string, over: Partial<WidgetInstance> = {}): WidgetInstance => ({
  id,
  type: "clock",
  x: 0,
  y: 0,
  w: 100,
  h: 100,
  z: 1,
  ...over
});

beforeEach(() => {
  localStorage.clear();
  useWidgetStore.setState({
    instances: [],
    groups: [],
    selectedIds: [],
    selectedId: null,
    activeView: "home",
    views: [{ id: "home", name: "Home" }],
    trash: []
  });
});
afterEach(() => localStorage.clear());

describe("computeArrangement", () => {
  it("横排：放得下时等间隙铺满包围盒、非排布轴居中", () => {
    // 包围盒 x[0,600] y[100,300]，三张 100 宽 → gap = (600-300)/2 = 150；y 中线 200 → 顶 150。
    const out = computeArrangement([r("a", 0, 100), r("b", 300, 200), r("c", 500, 100)], "row", VP);
    expect(out.get("a")).toEqual({ x: 0, y: 150 });
    expect(out.get("b")).toEqual({ x: 250, y: 150 });
    expect(out.get("c")).toEqual({ x: 500, y: 150 });
  });

  it("横排放不下：等宽槽位降级（卡片槽内居中、可轻微重叠、不出包围盒）", () => {
    // 包围盒宽 240，四张 100 宽 → 槽宽 60，中心 30/90/150/210；首卡 -20 被 clamp 到 0。
    const out = computeArrangement([r("a", 0, 0), r("b", 50, 0), r("c", 100, 0), r("d", 140, 0)], "row", VP);
    expect([...out.values()].map((p) => p.x)).toEqual([0, 40, 100, 160]);
  });

  it("纵列：按 y 就近排序后垂直铺开", () => {
    const out = computeArrangement([r("b", 10, 300), r("a", 0, 0), r("c", 5, 600)], "column", { w: 800, h: 700 });
    // 包围盒 y[0,700) 高 700，三张 100 高 → gap=200；x 中线 = (0+110)/2 = 55 → 左 5。
    expect(out.get("a")).toEqual({ x: 5, y: 0 });
    expect(out.get("b")).toEqual({ x: 5, y: 300 });
    expect(out.get("c")).toEqual({ x: 5, y: 600 });
  });

  it("网格：⌈√n⌉ 列等分包围盒、扫描序入格、格内居中", () => {
    // 5 张卡 → 3 列 2 行；包围盒 300×200 → 格 100×100。
    const out = computeArrangement(
      [r("a", 0, 0), r("b", 100, 0), r("c", 200, 0), r("d", 0, 100), r("e", 100, 100)],
      "grid",
      VP
    );
    expect(out.get("a")).toEqual({ x: 0, y: 0 });
    expect(out.get("b")).toEqual({ x: 100, y: 0 });
    expect(out.get("c")).toEqual({ x: 200, y: 0 });
    expect(out.get("d")).toEqual({ x: 0, y: 100 });
    // 第 5 张在第 2 行第 2 列。
    expect(out.get("e")).toEqual({ x: 100, y: 100 });
  });

  it("视口 clamp：出界结果至少留 40px 抓边；成员 <2 返回空", () => {
    const out = computeArrangement([r("a", 1900, 1050), r("b", 1850, 1000)], "row", VP);
    for (const p of out.values()) {
      expect(p.x).toBeLessThanOrEqual(VP.w - 40);
      expect(p.y).toBeLessThanOrEqual(VP.h - 40);
    }
    expect(computeArrangement([r("a", 0, 0)], "grid", VP).size).toBe(0);
  });
});

describe("store.arrangeSelected", () => {
  it("多选排成一行并落盘；单选/无选择 no-op", () => {
    useWidgetStore.setState({
      instances: [inst("a", { x: 0, y: 300 }), inst("b", { x: 400, y: 500 }), inst("c", { x: 900, y: 100 })],
      selectedIds: ["a", "b", "c"]
    });
    useWidgetStore.getState().arrangeSelected("row");
    const after = useWidgetStore.getState().instances;
    const ys = after.map((i) => i.y);
    expect(new Set(ys).size).toBe(1); // 同一水平线
    const xs = after.map((i) => i.x).sort((p, q) => p - q);
    expect(xs[2] - xs[0]).toBe(900 + 100 - 100); // 首尾贴包围盒（x[0,1000)）
    flushWidgetLayoutSync();
    expect(loadInstances("home")).toHaveLength(3);

    useWidgetStore.setState({ selectedIds: ["a"] });
    const before = JSON.stringify(useWidgetStore.getState().instances);
    useWidgetStore.getState().arrangeSelected("grid");
    expect(JSON.stringify(useWidgetStore.getState().instances)).toBe(before);
  });
});
