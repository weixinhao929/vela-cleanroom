/**
 * 样式预设卡核心逻辑测试：
 *  - 保存/列表/删除往返；同名覆盖保留 id 与 createdAt；
 *  - 「预设描述样式、不描述内容」：shortcuts 的条目/格位/顺序、files 的
 *    lastPath 被剥离；配置过 schema 清洗（损坏字段剔除、默认值补齐）；
 *  - mergeStyleConfig：预设样式覆盖、目标内容字段保留；
 *  - suggestPresetName 自动编号。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  importPresetsFromPackage,
  listStylePresets,
  saveStylePreset,
  deleteStylePreset,
  stripContentFields,
  mergeStyleConfig,
  suggestPresetName,
  type StylePreset
} from "./style-presets";

const KEY = "focus-desk.style-presets.v1";

beforeEach(() => {
  localStorage.clear();
});
afterEach(() => {
  localStorage.clear();
});

describe("样式预设：存取往返", () => {
  it("保存后可列出（按类型过滤）；删除生效", () => {
    const p1 = saveStylePreset({ widgetType: "clock", name: "大钟", config: { seconds: true }, opacity: 0.8 });
    saveStylePreset({ widgetType: "todo", name: "紧凑清单", config: {} });
    expect(listStylePresets("clock").map((p) => p.name)).toEqual(["大钟"]);
    expect(listStylePresets().length).toBe(2);
    expect(listStylePresets("clock")[0].opacity).toBe(0.8);

    deleteStylePreset(p1.id);
    expect(listStylePresets("clock")).toHaveLength(0);
    expect(listStylePresets("todo")).toHaveLength(1);
  });

  it("同名覆盖：保留原 id 与 createdAt，内容更新", () => {
    const first = saveStylePreset({ widgetType: "clock", name: "预设 A", config: { seconds: false } });
    const second = saveStylePreset({ widgetType: "clock", name: "预设 A", config: { seconds: true }, opacity: 0.5 });
    expect(listStylePresets("clock")).toHaveLength(1);
    const stored = listStylePresets("clock")[0];
    expect(stored.id).toBe(first.id);
    expect(stored.createdAt).toBe(first.createdAt);
    expect(stored.config.seconds).toBe(true);
    expect(second.id).toBe(first.id);
  });

  it("空名回落到自动编号；脏数据（非数组/缺字段）被过滤", () => {
    const p = saveStylePreset({ widgetType: "clock", name: "  ", config: {} });
    expect(p.name).toBe("预设 1");

    localStorage.setItem(
      KEY,
      JSON.stringify([
        null,
        42,
        { id: "x" },
        { id: "y", name: "n", widgetType: "clock", createdAt: 1, config: {}, opacity: null }
      ])
    );
    const list = listStylePresets("clock");
    expect(list.map((p2) => p2.id)).toEqual(["y"]);
  });
});

describe("预设描述样式、不描述内容", () => {
  it("shortcuts：customShortcuts / positions / order 被剥离，样式字段保留", () => {
    const preset = saveStylePreset({
      widgetType: "shortcuts",
      name: "双列带标签",
      config: {
        columns: 2,
        showLabels: true,
        customShortcuts: [{ id: "a", label: "A", path: "C:/a", kind: "file" }],
        positions: { a: { x: 0, y: 0 } },
        order: ["a"]
      }
    });
    expect(preset.config.columns).toBe(2);
    expect(preset.config.showLabels).toBe(true);
    expect(preset.config.customShortcuts).toBeUndefined();
    expect(preset.config.positions).toBeUndefined();
    expect(preset.config.order).toBeUndefined();
  });

  it("files：lastPath（导航状态）被剥离", () => {
    const preset = saveStylePreset({
      widgetType: "files",
      name: "隐藏文件开",
      config: { showHidden: true, lastPath: "C:/Users/x" }
    });
    expect(preset.config.showHidden).toBe(true);
    expect(preset.config.lastPath).toBeUndefined();
  });

  it("未登记类型：配置原样保留（其配置本身即纯样式）", () => {
    const next = stripContentFields("clock", { seconds: true, zones: ["Asia/Tokyo"] });
    expect(next).toEqual({ seconds: true, zones: ["Asia/Tokyo"] });
  });

  it("保存时过 schema 清洗：类型不符回默认值", () => {
    const preset = saveStylePreset({
      widgetType: "shortcuts",
      name: "清洗",
      config: { columns: 99, showLabels: "yes" }
    });
    expect(preset.config.columns).toBe(2); // 越界/类型不符 → 回 schema 默认
    // showLabels 默认值现为 true（滚动带改为标签常显），"yes" 仍按默认值清洗。
    expect(preset.config.showLabels).toBe(true);
  });
});

describe("套用合并", () => {
  it("预设样式覆盖目标，内容字段保留目标自己的", () => {
    const preset: StylePreset = {
      id: "p",
      name: "样式",
      widgetType: "shortcuts",
      createdAt: 1,
      config: { columns: 3, showLabels: false },
      opacity: null
    };
    const merged = mergeStyleConfig(
      { columns: 2, showLabels: true, customShortcuts: [{ id: "b", label: "B", path: "C:/b", kind: "folder" }] },
      preset
    );
    expect(merged.columns).toBe(3);
    expect(merged.showLabels).toBe(false);
    expect(merged.customShortcuts).toEqual([{ id: "b", label: "B", path: "C:/b", kind: "folder" }]);
  });
});

describe("自动编号", () => {
  it("跳过已占用名，取最小空位", () => {
    saveStylePreset({ widgetType: "clock", name: "预设 1", config: {} });
    saveStylePreset({ widgetType: "clock", name: "预设 3", config: {} });
    expect(suggestPresetName("clock")).toBe("预设 2");
    expect(suggestPresetName("todo")).toBe("预设 1");
  });
});

describe("预设包导入", () => {
  it("合法条目入库并重生成 id；同类型同名跳过；坏条目不计", () => {
    saveStylePreset({ widgetType: "clock", name: "本地已有", config: {} });
    const raw = JSON.stringify([
      { id: "external-1", name: "清爽", widgetType: "files", createdAt: 1, config: { showHidden: true }, opacity: 0.8 },
      { id: "external-2", name: "本地已有", widgetType: "clock", createdAt: 2, config: {} },
      { id: "external-3", name: "", widgetType: "clock", createdAt: 3, config: {} },
      "垃圾条目"
    ]);
    const r = importPresetsFromPackage(raw);
    expect(r).toEqual({ added: 1, skipped: 3 });
    const all = listStylePresets();
    const imported = all.find((p) => p.name === "清爽" && p.widgetType === "files")!;
    expect(imported.id).not.toBe("external-1"); // id 重生成
    expect(imported.config.showHidden).toBe(true);
    // 同名「本地已有」未被覆盖。
    expect(all.filter((p) => p.name === "本地已有")).toHaveLength(1);
  });

  it("非 JSON / 非数组载荷安全返回零", () => {
    expect(importPresetsFromPackage("not json")).toEqual({ added: 0, skipped: 0 });
    expect(importPresetsFromPackage('{"a":1}')).toEqual({ added: 0, skipped: 0 });
  });

  it("外部配置过 zod 重清洗（未知字段剔除）", () => {
    const raw = JSON.stringify([
      {
        id: "x",
        name: "注入测试",
        widgetType: "files",
        createdAt: 1,
        config: { evilField: "<script>", showChips: false }
      }
    ]);
    const r = importPresetsFromPackage(raw);
    expect(r.added).toBe(1);
    const p = listStylePresets().find((q) => q.name === "注入测试")!;
    expect((p.config as Record<string, unknown>).evilField).toBeUndefined();
    expect(p.config.showChips).toBe(false);
  });
});
