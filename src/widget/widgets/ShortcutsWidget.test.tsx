/**
 * 快捷方式组件测试（jsdom，格宽走 boardW=0 回退 64px）：
 *  - 拖动 A 到已占用的 B 格 = **交换**（互斥），双方位置都显式写入 positions；
 *  - 拖到空格 = 正常落位；
 *  - showLabels 默认显示名称标签，false 时隐藏（悬停 title 保留）；
 *  - 条目右键能就地打开菜单并「移除」（确认弹窗）；
 *  - 快捷方式文件夹（类手机桌面）：右键「移入文件夹 → 新建文件夹」就地成组
 *    （新文件夹落在源条目格位）、拖条目到文件夹磁贴 = 收进、单击磁贴弹条目
 *    网格、「移出文件夹」优先回原格、右键磁贴「移除文件夹」成员全体回画布；
 *  - 旧 .lnk 条目挂载时经 classify_path 自愈迁移成目标路径，位置保留；
 *  - 文件夹条目单击弹预览小窗（toggle 再关）；文件条目与 folderPreview=false
 *    维持原行为直接 open_path。
 */
import { beforeAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import { ShortcutsWidget } from "./ShortcutsWidget";
import { PromptDialogHost } from "../../components/PromptDialog";
import { ContextMenuHost, closeContextMenu } from "../../components/ContextMenu";
import { loadWidgetConfig } from "../widget-config";
import { __resetMirrorSyncStateForTests } from "../../lib/local-backup";
import { __resetAppIconCacheForTest } from "../../lib/app-icon-cache";
import { __resetShortcutsUndoForTest } from "../shortcuts-undo";
import { loadShortcutFolders, type CustomShortcut } from "../shortcuts-shared";

/* Tauri 门面 mock：右键菜单与迁移都要求 isTauri()。默认对所有命令返回
   永不结算的 Promise（防测试外 setState 刷警告），classify_path 由迁移用例
   自行 mockImplementation 提供解析结果。 */
const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn<(cmd: string, args?: Record<string, unknown>) => Promise<unknown>>()
}));
vi.mock("../../lib/tauri", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../../lib/tauri")>();
  return { ...mod, isTauri: () => true, invoke: invokeMock };
});
/* useOsFileDrop 在 isTauri 下会取窗口几何并订阅拖放：给不拒绝的桩，避免
   jsdom 下拿到 unhandled rejection。 */
vi.mock("@tauri-apps/api/webviewWindow", () => ({
  getCurrentWebviewWindow: () => ({
    outerPosition: async () => ({ x: 0, y: 0 }),
    scaleFactor: async () => 1,
    onDragDropEvent: async () => () => {}
  })
}));

/** 默认对所有命令挂起不回包（迁移/图标等副作用等待中，不产生测试外 setState）。 */
beforeEach(() => {
  invokeMock.mockImplementation(() => new Promise(() => {}));
});
afterEach(() => {
  // mockClear 而非 mockReset：reset 会连「永不结算」实现一并摘掉，上一用例
  // 滞后的 effect 若在此窗口再调 invoke 会拿到 undefined → .then 抛错（高负载
  // 并行下全量套件偶发红的根源）；clear 只清调用记录，实现保留到下一 beforeEach。
  invokeMock.mockClear();
  // persistMirrored 的 500ms 防抖镜像定时器跨用例存活，会把上一用例的配置
  // 回写进下一用例的 seed——模块为此提供专门的重置入口。
  __resetMirrorSyncStateForTests();
  // 图标共享缓存是模块单例：跨用例清空，防止上一用例的提取结果串扰下一用例。
  __resetAppIconCacheForTest();
  // 右键菜单状态同为模块单例：开着菜单卸载会把「外点吞按下」带给下一用例
  // （拖拽起不来）。Host 卸载时已自清，这里再兜一层。
  closeContextMenu();
  // 撤销栈同为模块单例：上一用例 pushOp 的残留会让本用例的 Ctrl+Z 撤到
  // 别人的操作闭包（写回上一用例的 instanceId 配置）。
  __resetShortcutsUndoForTest();
});

const ID = "w-sc";

const seed = (config: Record<string, unknown>) => {
  localStorage.setItem(`focus-desk.widget-config.${ID}.v1`, JSON.stringify(config));
};

const items: CustomShortcut[] = [
  { id: "a", label: "甲工具", path: "C:/a.exe", kind: "file" },
  { id: "b", label: "乙工具", path: "C:/b.exe", kind: "file" },
  { id: "c", label: "丙工具", path: "C:/c.exe", kind: "file" }
];

const positionsOf = () => loadWidgetConfig(ID).positions as Record<string, { x: number; y: number }>;

const foldersOf = () => loadShortcutFolders(loadWidgetConfig(ID));

class PointerEventPolyfill extends MouseEvent {
  readonly pointerId: number;
  readonly pointerType: string;
  readonly isPrimary: boolean;
  constructor(type: string, init: PointerEventInit = {}) {
    super(type, init);
    this.pointerId = init.pointerId ?? 1;
    this.pointerType = init.pointerType ?? "mouse";
    this.isPrimary = init.isPrimary ?? true;
  }
}

beforeAll(() => {
  const w = window as unknown as { PointerEvent?: unknown };
  if (!w.PointerEvent) w.PointerEvent = PointerEventPolyfill;
  const proto = Element.prototype as unknown as Record<string, unknown>;
  proto.setPointerCapture ??= () => {};
  proto.releasePointerCapture ??= () => {};
  proto.hasPointerCapture ??= () => false;
});

const el = (label: string) => document.querySelector<HTMLElement>(`.widget-shortcut[aria-label="${label}"]`)!;

/** 以 pointer 序列模拟一次自由拖动（clientY 不变，横向位移 dx px）。 */
const dragBy = (label: string, dx: number) => {
  const node = el(label);
  const down = new PointerEvent("pointerdown", { bubbles: true, pointerId: 1, button: 0, clientX: 40, clientY: 40 });
  node.dispatchEvent(down);
  const move = new PointerEvent("pointermove", { bubbles: true, pointerId: 1, clientX: 40 + dx, clientY: 40 });
  node.dispatchEvent(move);
  const up = new PointerEvent("pointerup", { bubbles: true, pointerId: 1, clientX: 40 + dx, clientY: 40 });
  node.dispatchEvent(up);
};

describe("ShortcutsWidget 拖动互斥", () => {
  it("拖到已占用格：与占用者交换，不叠加", () => {
    seed({
      customShortcuts: items,
      positions: { a: { x: 0, y: 0 }, b: { x: 1, y: 0 }, c: { x: 0, y: 1 } }
    });
    render(
      <>
        <ShortcutsWidget instanceId={ID} />
        <ContextMenuHost />
      </>
    );
    // A(0,0) 拖到 B 的 (1,0)：boardW=0 → cellW=64，stepX=74，dx=100 吸附到第 1 列。
    act(() => dragBy("甲工具", 100));
    const p = positionsOf();
    expect(p.a).toEqual({ x: 1, y: 0 });
    expect(p.b).toEqual({ x: 0, y: 0 }); // 占用者换到 A 的原格
    expect(p.c).toEqual({ x: 0, y: 1 }); // 无关条目不动
  });

  it("拖到空格：正常落位，他人不动", () => {
    seed({
      customShortcuts: items,
      positions: { a: { x: 0, y: 0 }, b: { x: 1, y: 0 }, c: { x: 0, y: 1 } }
    });
    render(
      <>
        <ShortcutsWidget instanceId={ID} />
        <ContextMenuHost />
      </>
    );
    // C(0,1) 右移一格到 (1,1)（空格；stepX=74，dx=100 吸附到第 1 列，行不变）。
    act(() => dragBy("丙工具", 100));
    const p = positionsOf();
    expect(p.c).toEqual({ x: 1, y: 1 });
    expect(p.a).toEqual({ x: 0, y: 0 });
    expect(p.b).toEqual({ x: 1, y: 0 });
  });

  it("showLabels 默认显示名称标签；false 时隐藏（悬停名保留）", () => {
    seed({ customShortcuts: items });
    const { unmount } = render(<ShortcutsWidget instanceId={ID} />);
    expect(screen.getByText("甲工具")).toBeTruthy();
    unmount();
    seed({ customShortcuts: items, showLabels: false });
    render(
      <>
        <ShortcutsWidget instanceId={ID} />
        <ContextMenuHost />
      </>
    );
    expect(screen.queryByText("甲工具")).toBeNull();
    expect(el("甲工具").getAttribute("title")).toContain("C:/a.exe");
  });
});

describe("ShortcutsWidget 内置位置布局避让", () => {
  /** 渲染条目的格位（boardW=0 → cellW=64，stepX=74，行高 84+10）。 */
  const cellOf = (label: string) => ({
    left: el(label).style.left,
    top: el(label).style.top
  });

  it("勾选内置位置后不与已有图标叠格：存位条目先占格，缺位条目补第一个空格", () => {
    // 用户场景回归：先拖入图标（存位 0,0），再在设置页勾选回收站——
    // 单遍分配会把缺位的回收站分到 (0,0)，与存位条目叠在同一格。
    seed({
      customShortcuts: [items[0]],
      positions: { a: { x: 0, y: 0 } },
      builtinShortcuts: ["recycle"]
    });
    render(
      <>
        <ShortcutsWidget instanceId={ID} />
        <ContextMenuHost />
      </>
    );
    expect(cellOf("甲工具")).toEqual({ left: "0px", top: "0px" });
    // columns 默认 2：回收站避开 (0,0) 补到 (1,0)。
    expect(cellOf("回收站")).toEqual({ left: "74px", top: "0px" });
  });

  it("多条目缺位仍按顺序落格互不叠加；重复存位撞车时后者降级到空格", () => {
    seed({
      customShortcuts: items,
      // a、b 存位撞车（撤销恢复等路径可产生）：b 降级补空格，不再双占 (0,0)。
      positions: { a: { x: 0, y: 0 }, b: { x: 0, y: 0 } },
      builtinShortcuts: ["recycle", "computer"]
    });
    render(
      <>
        <ShortcutsWidget instanceId={ID} />
        <ContextMenuHost />
      </>
    );
    // 缺位分配按 entries 顺序（内置在前）：回收站 (1,0)、此电脑 (0,1)、乙 (1,1)。
    expect(cellOf("甲工具")).toEqual({ left: "0px", top: "0px" });
    expect(cellOf("回收站")).toEqual({ left: "74px", top: "0px" });
    expect(cellOf("此电脑")).toEqual({ left: "0px", top: "94px" });
    expect(cellOf("乙工具")).toEqual({ left: "74px", top: "94px" });
  });
});

describe("ShortcutsWidget 条目右键菜单", () => {
  it("网格模式：右键条目 → 菜单「移除」→ 确认后该条目删除，其余保留", async () => {
    seed({
      customShortcuts: items,
      positions: { a: { x: 0, y: 0 }, b: { x: 1, y: 0 }, c: { x: 0, y: 1 } }
    });
    render(
      <>
        <ShortcutsWidget instanceId={ID} />
        <PromptDialogHost />
        <ContextMenuHost />
      </>
    );
    fireEvent.contextMenu(el("甲工具"));
    fireEvent.click(screen.getByRole("menuitem", { name: "移除" }));
    const dialog = await screen.findByRole("alertdialog", { name: "删除快捷方式" });
    fireEvent.click(within(dialog).getByText("移除"));
    await waitFor(() => {
      const list = loadWidgetConfig(ID).customShortcuts as CustomShortcut[];
      expect(list.map((s) => s.id)).toEqual(["b", "c"]);
    });
    expect(positionsOf().a).toBeUndefined();
    expect(positionsOf().b).toEqual({ x: 1, y: 0 });
  });

  it("240ms 退场窗内连续删除两个条目：两笔都落删（后一次不吞前一次的提交）", async () => {
    // beginTileExit 回归：第二次确认会 clearTimeout 重置退场计时器，commit
    // 只挂在 timer 上时第一笔删除被静默丢弃（条目闪一下又回来）。
    seed({ customShortcuts: items });
    render(
      <>
        <ShortcutsWidget instanceId={ID} />
        <PromptDialogHost />
        <ContextMenuHost />
      </>
    );
    const confirmRemove = async (label: string) => {
      fireEvent.contextMenu(el(label));
      fireEvent.click(screen.getByRole("menuitem", { name: "移除" }));
      const dialog = await screen.findByRole("alertdialog", { name: "删除快捷方式" });
      fireEvent.click(within(dialog).getByText("移除"));
    };
    // 两次确认都在 240ms 退场窗内完成（同步事件序列，毫秒级）。
    await confirmRemove("甲工具");
    await confirmRemove("乙工具");
    await waitFor(() => {
      const list = loadWidgetConfig(ID).customShortcuts as CustomShortcut[];
      expect(list.map((s) => s.id)).toEqual(["c"]);
    });
    expect(positionsOf().a).toBeUndefined();
    expect(positionsOf().b).toBeUndefined();
  });
});

describe("ShortcutsWidget 旧条目自愈迁移", () => {
  it("仍指向 .lnk 的条目挂载时重解析成目标路径，位置与名称保留", async () => {
    invokeMock.mockImplementation(async (cmd: string) =>
      cmd === "classify_path" ? { label: "旧工具", kind: "file", path: "C:/apps/旧工具.exe" } : new Promise(() => {})
    );
    seed({
      customShortcuts: [{ id: "a", label: "旧工具", path: "C:/Users/me/Desktop/旧工具.lnk", kind: "file" }],
      positions: { a: { x: 1, y: 0 } }
    });
    render(
      <>
        <ShortcutsWidget instanceId={ID} />
        <ContextMenuHost />
      </>
    );
    await waitFor(() => {
      const list = loadWidgetConfig(ID).customShortcuts as CustomShortcut[];
      expect(list[0].path).toBe("C:/apps/旧工具.exe");
    });
    const list = loadWidgetConfig(ID).customShortcuts as CustomShortcut[];
    expect(list[0].kind).toBe("file");
    expect(list[0].label).toBe("旧工具");
    expect(positionsOf().a).toEqual({ x: 1, y: 0 });
  });

  it("已解析条目不触发重解析（幂等零写）", async () => {
    seed({ customShortcuts: items });
    render(
      <>
        <ShortcutsWidget instanceId={ID} />
        <ContextMenuHost />
      </>
    );
    await act(() => new Promise((r) => setTimeout(r, 0)));
    expect(invokeMock.mock.calls.filter(([cmd]) => cmd === "classify_path")).toHaveLength(0);
    expect((loadWidgetConfig(ID).customShortcuts as CustomShortcut[]).map((s) => s.path)).toEqual([
      "C:/a.exe",
      "C:/b.exe",
      "C:/c.exe"
    ]);
  });
});

describe("ShortcutsWidget 文件夹预览小窗", () => {
  const folders: CustomShortcut[] = [
    { id: "f", label: "工作目录", path: "C:/work", kind: "folder" },
    { id: "g", label: "乙工具", path: "C:/b.exe", kind: "file" }
  ];

  beforeEach(() => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "list_directory") return [];
      if (cmd === "get_app_icon") return null;
      return new Promise(() => {});
    });
  });

  it("文件夹条目单击弹预览小窗而非资源管理器；再点同一条关闭（toggle）", async () => {
    seed({ customShortcuts: folders, positions: { f: { x: 0, y: 0 }, g: { x: 1, y: 0 } } });
    render(
      <>
        <ShortcutsWidget instanceId={ID} />
        <ContextMenuHost />
      </>
    );
    fireEvent.click(el("工作目录"));
    expect(document.querySelector(".folder-popup")).toBeTruthy();
    await waitFor(() =>
      expect(
        invokeMock.mock.calls.some(([c, a]) => c === "list_directory" && (a as { path: string }).path === "C:/work")
      ).toBe(true)
    );
    expect(invokeMock.mock.calls.filter(([c]) => c === "open_path")).toHaveLength(0);
    fireEvent.click(el("工作目录"));
    expect(document.querySelector(".folder-popup")).toBeNull();
  });

  it("文件条目维持原行为：单击直接 open_path，不弹小窗", () => {
    seed({ customShortcuts: folders, positions: { f: { x: 0, y: 0 }, g: { x: 1, y: 0 } } });
    render(
      <>
        <ShortcutsWidget instanceId={ID} />
        <ContextMenuHost />
      </>
    );
    fireEvent.click(el("乙工具"));
    expect(
      invokeMock.mock.calls.some(([c, a]) => c === "open_path" && (a as { path: string }).path === "C:/b.exe")
    ).toBe(true);
    expect(document.querySelector(".folder-popup")).toBeNull();
  });

  it("folderPreview 关闭时退回原行为：文件夹单击直接 open_path", () => {
    seed({ customShortcuts: folders, positions: { f: { x: 0, y: 0 }, g: { x: 1, y: 0 } }, folderPreview: false });
    render(
      <>
        <ShortcutsWidget instanceId={ID} />
        <ContextMenuHost />
      </>
    );
    fireEvent.click(el("工作目录"));
    expect(
      invokeMock.mock.calls.some(([c, a]) => c === "open_path" && (a as { path: string }).path === "C:/work")
    ).toBe(true);
    expect(document.querySelector(".folder-popup")).toBeNull();
  });
});

describe("ShortcutsWidget 快捷方式文件夹（类手机桌面）", () => {
  beforeEach(() => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "get_app_icon") return null;
      return new Promise(() => {});
    });
  });

  it("右键「移入文件夹 → 新建文件夹」：就地成组——新文件夹落在源条目格位，条目退出网格", () => {
    seed({
      customShortcuts: items,
      positions: { a: { x: 1, y: 0 }, b: { x: 0, y: 0 }, c: { x: 0, y: 1 } }
    });
    render(
      <>
        <ShortcutsWidget instanceId={ID} />
        <ContextMenuHost />
      </>
    );
    fireEvent.contextMenu(el("甲工具"));
    fireEvent.click(within(screen.getByRole("menu")).getByRole("menuitem", { name: "移入文件夹" }));
    fireEvent.click(within(screen.getByRole("menu")).getByRole("menuitem", { name: "新建文件夹" }));
    const folders = foldersOf();
    expect(folders).toHaveLength(1);
    expect(folders[0].childIds).toEqual(["a"]);
    expect(el("甲工具")).toBeNull(); // 条目退出画布网格，由文件夹磁贴代表
    expect(el("新建文件夹")).toBeTruthy();
    expect(positionsOf()[folders[0].id]).toEqual({ x: 1, y: 0 }); // 就地变换：落在源格位
    expect(positionsOf().b).toEqual({ x: 0, y: 0 }); // 其他条目不动
    expect(positionsOf().c).toEqual({ x: 0, y: 1 });
  });

  it("新建文件夹重名避让：已有「新建文件夹」时新默认名带 (2) 后缀", () => {
    seed({
      customShortcuts: items,
      positions: { a: { x: 1, y: 0 }, b: { x: 0, y: 0 }, c: { x: 0, y: 1 }, f1: { x: 1, y: 1 } },
      shortcutFolders: [{ id: "f1", label: "新建文件夹", childIds: [] }]
    });
    render(
      <>
        <ShortcutsWidget instanceId={ID} />
        <ContextMenuHost />
      </>
    );
    fireEvent.contextMenu(el("甲工具"));
    fireEvent.click(within(screen.getByRole("menu")).getByRole("menuitem", { name: "移入文件夹" }));
    // 菜单里「新建文件夹」动作项与同名既有文件夹磁贴条目并存：动作项渲染在前。
    fireEvent.click(screen.getAllByRole("menuitem", { name: "新建文件夹" })[0]);
    const folders = foldersOf();
    expect(folders).toHaveLength(2);
    expect(folders[1].label).toBe("新建文件夹 (2)");
    expect(el("新建文件夹 (2)")).toBeTruthy();
  });

  it("拖条目到文件夹磁贴 = 收进文件夹；成员不再直接铺网格", () => {
    seed({
      customShortcuts: items,
      positions: { a: { x: 0, y: 0 }, b: { x: 1, y: 0 }, c: { x: 0, y: 1 }, f1: { x: 1, y: 1 } },
      shortcutFolders: [{ id: "f1", label: "工作", childIds: [] }]
    });
    render(
      <>
        <ShortcutsWidget instanceId={ID} />
        <ContextMenuHost />
      </>
    );
    // C(0,1) 右移一格落到 (1,1) = 文件夹磁贴格。
    act(() => dragBy("丙工具", 100));
    const folders = foldersOf();
    expect(folders[0].childIds).toEqual(["c"]);
    expect(el("丙工具")).toBeNull();
    // 文件夹磁贴原地不动（不与条目交换）。
    expect(positionsOf().f1).toEqual({ x: 1, y: 1 });
    expect(el("工作")).toBeTruthy();
  });

  it("单击文件夹磁贴弹条目网格；「移出文件夹」优先回原格（空着才用）", () => {
    seed({
      customShortcuts: items,
      positions: { a: { x: 0, y: 0 }, b: { x: 1, y: 0 }, c: { x: 0, y: 1 }, f1: { x: 1, y: 1 } },
      shortcutFolders: [{ id: "f1", label: "工作", childIds: ["b"] }]
    });
    render(
      <>
        <ShortcutsWidget instanceId={ID} />
        <ContextMenuHost />
      </>
    );
    expect(el("乙工具")).toBeNull(); // 成员不直接铺网格
    fireEvent.click(el("工作"));
    expect(document.querySelector(".sfolder-popup")).toBeTruthy();
    expect(screen.getByText("乙工具")).toBeTruthy();
    fireEvent.contextMenu(document.querySelector('.sfolder-popup-item[aria-label="乙工具"]')!);
    fireEvent.click(within(screen.getByRole("menu")).getByRole("menuitem", { name: "移出文件夹" }));
    expect(foldersOf()[0].childIds).toEqual([]);
    expect(el("乙工具")).toBeTruthy(); // 回到画布
    expect(positionsOf().b).toEqual({ x: 1, y: 0 }); // 原格空闲 → 原位恢复
  });

  it("右键文件夹磁贴 →「移除文件夹」：成员全体回画布，文件夹格位清除", async () => {
    seed({
      customShortcuts: items,
      positions: { a: { x: 0, y: 0 }, b: { x: 1, y: 0 }, c: { x: 0, y: 1 }, f1: { x: 1, y: 1 } },
      shortcutFolders: [{ id: "f1", label: "工作", childIds: ["b", "c"] }]
    });
    render(
      <>
        <ShortcutsWidget instanceId={ID} />
        <PromptDialogHost />
        <ContextMenuHost />
      </>
    );
    fireEvent.contextMenu(el("工作"));
    fireEvent.click(within(screen.getByRole("menu")).getByRole("menuitem", { name: "移除文件夹" }));
    const dialog = await screen.findByRole("alertdialog", { name: "移除文件夹" });
    fireEvent.click(within(dialog).getByText("移除"));
    await waitFor(() => {
      expect(foldersOf()).toHaveLength(0);
    });
    expect(el("乙工具")).toBeTruthy();
    expect(el("丙工具")).toBeTruthy();
    expect(positionsOf().b).toEqual({ x: 1, y: 0 }); // 原格空闲 → 原位恢复
    expect(positionsOf().c).toEqual({ x: 0, y: 1 });
    expect(positionsOf().f1).toBeUndefined(); // 文件夹格位清除
  });

  it("弹层内联搜索：contains 过滤 + 无结果态 + Enter 打开首个匹配并收起", () => {
    seed({
      customShortcuts: items,
      positions: { c: { x: 0, y: 0 }, f1: { x: 1, y: 0 } },
      shortcutFolders: [{ id: "f1", label: "工作", childIds: ["a", "b"] }]
    });
    render(
      <>
        <ShortcutsWidget instanceId={ID} />
        <ContextMenuHost />
      </>
    );
    fireEvent.click(el("工作"));
    const input = document.querySelector<HTMLInputElement>(".sfolder-popup-search-input")!;
    expect(input).toBeTruthy();
    expect(screen.getByText("甲工具")).toBeTruthy();
    fireEvent.change(input, { target: { value: "乙" } });
    expect(screen.queryByText("甲工具")).toBeNull();
    expect(screen.getByText("乙工具")).toBeTruthy();
    fireEvent.change(input, { target: { value: "不存在的名字" } });
    expect(screen.getByText("没有找到匹配结果")).toBeTruthy();
    fireEvent.change(input, { target: { value: "甲" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(
      invokeMock.mock.calls.some(([c, a]) => c === "open_path" && (a as { path: string }).path === "C:/a.exe")
    ).toBe(true);
  });

  it("弹层条目右键菜单补齐：在资源管理器中显示 / 复制路径 / 重命名", () => {
    seed({
      customShortcuts: items,
      positions: { c: { x: 0, y: 0 }, f1: { x: 1, y: 0 } },
      shortcutFolders: [{ id: "f1", label: "工作", childIds: ["a"] }]
    });
    render(
      <>
        <ShortcutsWidget instanceId={ID} />
        <ContextMenuHost />
      </>
    );
    fireEvent.click(el("工作"));
    fireEvent.contextMenu(document.querySelector('.sfolder-popup-item[aria-label="甲工具"]')!);
    const menu = screen.getByRole("menu");
    expect(within(menu).getByRole("menuitem", { name: "在资源管理器中显示" })).toBeTruthy();
    expect(within(menu).getByRole("menuitem", { name: "复制路径" })).toBeTruthy();
    expect(within(menu).getByRole("menuitem", { name: "重命名" })).toBeTruthy();
    expect(within(menu).getByRole("menuitem", { name: "移出文件夹" })).toBeTruthy();
  });

  it("文件夹磁贴带成员数角标", () => {
    seed({
      customShortcuts: items,
      positions: { c: { x: 0, y: 0 }, f1: { x: 1, y: 0 } },
      shortcutFolders: [{ id: "f1", label: "工作", childIds: ["a", "b"] }]
    });
    render(
      <>
        <ShortcutsWidget instanceId={ID} />
        <ContextMenuHost />
      </>
    );
    const badge = el("工作").querySelector(".widget-shortcut-count");
    expect(badge?.textContent).toBe("2");
  });

  it("sort=name 时弹层按名称序展示（不改 childIds 存储顺序）", () => {
    seed({
      customShortcuts: items,
      positions: { c: { x: 0, y: 0 }, f1: { x: 1, y: 0 } },
      // zh 拼音序：丙(bǐng) < 甲(jiǎ) < 乙(yǐ)，与 childIds 插入序相反。
      shortcutFolders: [{ id: "f1", label: "工作", childIds: ["a", "b", "c"], sort: "name" }]
    });
    render(
      <>
        <ShortcutsWidget instanceId={ID} />
        <ContextMenuHost />
      </>
    );
    fireEvent.click(el("工作"));
    const names = Array.from(document.querySelectorAll(".sfolder-page .sfolder-popup-name")).map((n) => n.textContent);
    expect(names).toEqual(["丙工具", "甲工具", "乙工具"]);
    // 存储顺序不变（排序仅影响展示）。
    expect(foldersOf()[0].childIds).toEqual(["a", "b", "c"]);
  });

  it("浏览态渲染分页容器；搜索态退化为滚动网格", () => {
    seed({
      customShortcuts: items,
      positions: { c: { x: 0, y: 0 }, f1: { x: 1, y: 0 } },
      shortcutFolders: [{ id: "f1", label: "工作", childIds: ["a", "b"] }]
    });
    render(
      <>
        <ShortcutsWidget instanceId={ID} />
        <ContextMenuHost />
      </>
    );
    fireEvent.click(el("工作"));
    expect(document.querySelector(".sfolder-pages")).toBeTruthy();
    expect(document.querySelector(".sfolder-dots")).toBeNull(); // 单页无页点
    const input = document.querySelector<HTMLInputElement>(".sfolder-popup-search-input")!;
    fireEvent.change(input, { target: { value: "甲" } });
    expect(document.querySelector(".sfolder-pages")).toBeNull();
    expect(document.querySelector(".sfolder-popup-grid")).toBeTruthy();
    expect(screen.getByText("甲工具")).toBeTruthy();
  });
});

describe("ShortcutsWidget 失效条目标记缺失", () => {
  it("目标不存在的条目保留并标 missing；打开被拦截", async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "check_paths_exist") return [false];
      return new Promise(() => {});
    });
    seed({ customShortcuts: [{ id: "a", label: "甲工具", path: "C:/gone/a.exe", kind: "file" }] });
    render(
      <>
        <ShortcutsWidget instanceId={ID} />
        <ContextMenuHost />
      </>
    );
    await waitFor(() => {
      const list = loadWidgetConfig(ID).customShortcuts as CustomShortcut[];
      expect(list[0].missing).toBe(true);
    });
    expect(el("甲工具")).toBeTruthy();
    expect(el("甲工具").className).toContain("is-missing");
    fireEvent.click(el("甲工具"));
    expect(invokeMock.mock.calls.some(([c]) => c === "open_path")).toBe(false);
  });

  it("目标恢复后 missing 标记自动解除（下次复检同路径）", async () => {
    let exists = false;
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "check_paths_exist") return [exists];
      return new Promise(() => {});
    });
    seed({
      customShortcuts: [{ id: "a", label: "甲工具", path: "C:/a.exe", kind: "file", missing: true }]
    });
    const { unmount } = render(<ShortcutsWidget instanceId={ID} />);
    // 目标恢复后重挂（等价于下一轮复检）：标记解除、条目保留。
    exists = true;
    unmount();
    render(
      <>
        <ShortcutsWidget instanceId={ID} />
        <ContextMenuHost />
      </>
    );
    await waitFor(() => {
      const list = loadWidgetConfig(ID).customShortcuts as CustomShortcut[];
      expect(list[0].missing).toBeUndefined();
    });
    expect(el("甲工具")).toBeTruthy();
  });
});

describe("ShortcutsWidget 撤销（命令级操作历史）", () => {
  it("移入文件夹后 Ctrl+Z 撤销、Ctrl+Y 重做", async () => {
    seed({
      customShortcuts: items,
      positions: { a: { x: 0, y: 0 }, b: { x: 1, y: 0 }, c: { x: 0, y: 1 }, f1: { x: 1, y: 1 } },
      shortcutFolders: [{ id: "f1", label: "工作", childIds: [] }]
    });
    render(
      <>
        <ShortcutsWidget instanceId={ID} />
        <ContextMenuHost />
      </>
    );
    // 拖 C 到文件夹磁贴 = 移入。
    act(() => dragBy("丙工具", 100));
    expect(foldersOf()[0].childIds).toEqual(["c"]);
    // Ctrl+Z：撤销移入（成员回画布）。
    fireEvent.keyDown(window, { key: "z", ctrlKey: true });
    expect(foldersOf()[0].childIds).toEqual([]);
    // Ctrl+Y：重做。
    fireEvent.keyDown(window, { key: "y", ctrlKey: true });
    expect(foldersOf()[0].childIds).toEqual(["c"]);
  });

  it("文本输入焦点内 Ctrl+Z 不拦截（交给原生撤销）", () => {
    seed({ customShortcuts: items });
    render(
      <>
        <ShortcutsWidget instanceId={ID} />
        <ContextMenuHost />
      </>
    );
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();
    // 无操作可撤销也不抛错；焦点在输入框内时快捷键被放行（这里仅验证不抛错）。
    expect(() => fireEvent.keyDown(input, { key: "z", ctrlKey: true })).not.toThrow();
    input.remove();
  });
});
