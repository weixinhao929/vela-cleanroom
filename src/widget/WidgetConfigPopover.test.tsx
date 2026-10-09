/**
 * 就地配置弹层（WidgetConfigPopover）组件测试：
 * 渲染内容（通用行 + quick 字段）、写值链路（经 schema 洗涤落盘）、
 * Esc/外点关闭、单例互斥、placePopover 定位数学。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { WidgetConfigPopover, placePopover } from "./WidgetConfigPopover";
import { WidgetCard } from "./WidgetCard";
import { PromptDialogHost } from "../components/PromptDialog";
import { getWidgetMeta } from "./registry";
import { useWidgetStore } from "./widget-store";
import { loadWidgetConfig } from "./widget-config";
import { useSettingsStore } from "../store/settings-store";

const ANCHOR = { x: 200, y: 300, w: 220, h: 120 };

function seedConfig(instanceId: string, config: Record<string, unknown>) {
  localStorage.setItem(`focus-desk.widget-config.${instanceId}.v1`, JSON.stringify(config));
}

describe("placePopover 定位数学", () => {
  it("锚点居中、优先放上方", () => {
    const p = placePopover({ x: 400, y: 400, w: 200, h: 100 }, { w: 300, h: 200 }, { w: 1920, h: 1080 });
    expect(p.below).toBe(false);
    expect(p.left).toBe(350); // 400 + 100 - 150
    expect(p.top).toBe(400 - 200 - 8);
  });

  it("上方放不下时翻转到锚点下方", () => {
    const p = placePopover({ x: 400, y: 60, w: 200, h: 100 }, { w: 300, h: 200 }, { w: 1920, h: 1080 });
    expect(p.below).toBe(true);
    expect(p.top).toBe(60 + 100 + 8);
  });

  it("水平越界时钳制进视口", () => {
    const p = placePopover({ x: -50, y: 400, w: 100, h: 100 }, { w: 300, h: 200 }, { w: 1000, h: 800 });
    expect(p.left).toBe(10);
    const right = placePopover({ x: 980, y: 400, w: 100, h: 100 }, { w: 300, h: 200 }, { w: 1000, h: 800 });
    expect(right.left).toBe(1000 - 300 - 10);
  });

  it("垂直双向都放不下时贴底钳制（内容滚动）", () => {
    const p = placePopover({ x: 400, y: 300, w: 200, h: 100 }, { w: 300, h: 600 }, { w: 1000, h: 400 });
    expect(p.top).toBe(10); // max(MARGIN, viewport.h - h - MARGIN) → 贴顶（视口矮于弹层）
  });
});

describe("WidgetConfigPopover 组件", () => {
  beforeEach(() => {
    localStorage.clear();
    useSettingsStore.setState({ settingsPage: "style", settingsOpen: false });
  });

  it("渲染通用行（透明度/鼠标穿透）与 quick 字段，时钟含世界时钟编辑器", async () => {
    seedConfig("w-clock", { showSeconds: false, zones: ["Asia/Shanghai"] });
    render(<WidgetConfigPopover instanceId="w-clock" widgetType="clock" anchor={ANCHOR} open onClose={() => {}} />);
    /* 壳首次 open 才动态拉取实现 chunk（lazy），首查必须异步等待；并行
       全量跑时 chunk 收集/转换可能超 RTL 默认 1s，放宽到 3s。 */
    expect(await screen.findByRole("dialog", { name: "时钟 配置" }, { timeout: 3000 })).toBeTruthy();
    // 通用行
    expect(screen.getByRole("slider", { name: "透明度" })).toBeTruthy();
    expect(screen.getByRole("switch", { name: "鼠标穿透" })).toBeTruthy();
    // quick 字段：显示秒（预置 false → 开关关）
    expect((screen.getByRole("switch", { name: "显示秒" }) as HTMLButtonElement).getAttribute("aria-checked")).toBe(
      "false"
    );
    // 分段控件（表盘样式）
    expect(screen.getByRole("radio", { name: "模拟表盘" })).toBeTruthy();
    // 世界时钟：预置时区行 + 添加输入（datalist 全量时区）
    expect(screen.getByText("Asia/Shanghai")).toBeTruthy();
    expect(screen.getByLabelText("添加时区")).toBeTruthy();
    expect(document.querySelectorAll("#wcfg-all-timezones option").length).toBeGreaterThan(10);
  });

  it("S3：标题与名称行跟随显示名；名称行打开共享改名弹窗（独立卡最高频的就地入口）", async () => {
    seedConfig("w-name", {});
    useWidgetStore.setState({
      editMode: false,
      instances: [{ id: "w-name", type: "todo", x: 0, y: 0, w: 300, h: 200, z: 1, label: "我的待办" }]
    });
    render(
      <>
        <PromptDialogHost />
        <WidgetConfigPopover instanceId="w-name" widgetType="todo" anchor={ANCHOR} open onClose={() => {}} />
      </>
    );
    // 标题 = 实例显示名（重命名后不再显示类型名）。
    const dlg = await screen.findByRole("dialog", { name: "我的待办 配置" }, { timeout: 3000 });
    expect(dlg).toBeTruthy();
    // 名称行按钮文案即当前自定义名；点击弹共享改名弹窗（预填原值）。
    fireEvent.click(screen.getByRole("button", { name: "我的待办" }));
    const input = await screen.findByRole("textbox");
    expect((input as HTMLInputElement).value).toBe("我的待办");
  });

  it("切换 quick 开关 → 经 schema 洗涤落盘（补全其余默认字段）", async () => {
    const user = userEvent.setup();
    seedConfig("w-todo", {});
    render(<WidgetConfigPopover instanceId="w-todo" widgetType="todo" anchor={ANCHOR} open onClose={() => {}} />);
    await user.click(await screen.findByRole("switch", { name: "显示已完成" }));
    const saved = loadWidgetConfig("w-todo");
    expect(saved.showCompleted).toBe(false);
    // sanitize 补全的 schema 默认字段一并落盘
    expect(saved.showCount).toBe(true);
    expect(saved.sortOrder).toBe("newest");
  });

  it("点击分段选项写值；世界时钟可增删", async () => {
    const user = userEvent.setup();
    seedConfig("w-music", {});
    render(<WidgetConfigPopover instanceId="w-music" widgetType="music" anchor={ANCHOR} open onClose={() => {}} />);
    await user.click(await screen.findByRole("radio", { name: "环形" }));
    expect(loadWidgetConfig("w-music").visualStyle).toBe("radial");

    // 世界时钟（时钟类型）增删
    seedConfig("w-clock2", { zones: ["Asia/Tokyo"] });
    const { unmount } = render(
      <WidgetConfigPopover instanceId="w-clock2" widgetType="clock" anchor={ANCHOR} open onClose={() => {}} />
    );
    await user.click(await screen.findByRole("button", { name: "移除时区" }));
    expect(loadWidgetConfig("w-clock2").zones).toEqual([]);
    await user.type(screen.getByLabelText("添加时区"), "Asia/Seoul");
    await user.click(screen.getByRole("button", { name: "添加" }));
    expect(loadWidgetConfig("w-clock2").zones).toEqual(["Asia/Seoul"]);
    unmount();
  });

  it("Esc 关闭；弹层外 pointerdown 关闭、弹层内不关闭", async () => {
    const onClose = vi.fn();
    const { container } = render(
      <WidgetConfigPopover instanceId="w-clock" widgetType="clock" anchor={ANCHOR} open onClose={onClose} />
    );
    // 弹层内点击不关闭
    fireEvent.pointerDown(await screen.findByRole("dialog"), { button: 0 });
    expect(onClose).not.toHaveBeenCalled();
    // 弹层外（body 上的游离节点）pointerdown 关闭
    const outside = document.createElement("div");
    document.body.appendChild(outside);
    fireEvent.pointerDown(outside, { button: 0 });
    expect(onClose).toHaveBeenCalledTimes(1);
    // Esc 关闭
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(2);
    expect(container).toBeTruthy();
  });

  it("Tab 在弹层内循环（焦点陷阱），不逃逸到 body", async () => {
    render(<WidgetConfigPopover instanceId="w-clock" widgetType="clock" anchor={ANCHOR} open onClose={() => {}} />);
    const dialog = await screen.findByRole("dialog");
    const focusables = Array.from(
      dialog.querySelectorAll<HTMLElement>("button, input, [tabindex]:not([tabindex='-1'])")
    ).filter((el) => !el.hasAttribute("disabled"));
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    // 焦点在最后一个元素上按 Tab → 回到第一个
    last.focus();
    fireEvent.keyDown(window, { key: "Tab" });
    expect(document.activeElement).toBe(first);
    // 在第一个元素上按 Shift+Tab → 到最后一个
    fireEvent.keyDown(window, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(last);
  });

  it("单例互斥：另一处弹层打开事件到达时自动关闭", async () => {
    const onClose = vi.fn();
    render(<WidgetConfigPopover instanceId="w-a" widgetType="clock" anchor={ANCHOR} open onClose={onClose} />);
    // 实现模块就位（互斥监听随内芯挂载）后再模拟另一挂载点打开（令牌不同）
    await screen.findByRole("dialog");
    window.dispatchEvent(new CustomEvent("focus-desk:widget-config-popover-open", { detail: 999 }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("「更多设置」关闭弹层并跳设置窗口直达本实例配置页", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<WidgetConfigPopover instanceId="w-clock" widgetType="clock" anchor={ANCHOR} open onClose={onClose} />);
    await user.click(await screen.findByRole("button", { name: "更多设置" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    // 浏览器路径：不弹独立窗口，标记 settingsOpen 并直达实例页
    await waitFor(() => {
      expect(useSettingsStore.getState().settingsPage).toBe("widget-config-w-clock");
      expect(useSettingsStore.getState().settingsOpen).toBe(true);
    });
    const pending = JSON.parse(localStorage.getItem("focus-desk.pending-nav") ?? "null");
    expect(pending.page).toBe("widget-config-w-clock");
  });

  it("无 quick 字段的类型（recycle）只渲染通用行", async () => {
    render(<WidgetConfigPopover instanceId="w-r" widgetType="recycle" anchor={ANCHOR} open onClose={() => {}} />);
    expect(await screen.findByRole("slider", { name: "透明度" })).toBeTruthy();
    expect(screen.queryByRole("radio")).toBeNull();
  });

  it("集成：WidgetCard 悬浮工具条齿轮打开就地弹层并写值", async () => {
    const user = userEvent.setup();
    seedConfig("card-1", {});
    useWidgetStore.setState({
      editMode: false,
      instances: [{ id: "card-1", type: "todo", x: 100, y: 200, w: 300, h: 200, z: 1 }]
    });
    const { container } = render(<WidgetCard id="card-1" type="todo" x={100} y={200} w={300} h={200} z={1} />);
    // hover 唤出悬浮工具条（Portal 到 body）→ 点齿轮 → 就地弹层出现（不跳设置）
    fireEvent.mouseEnter(container.querySelector(".widget-card")!);
    const gear = await screen.findByRole("button", { name: "配置此小组件" });
    await user.click(gear);
    const dialog = await screen.findByRole("dialog", { name: `${getWidgetMeta("todo")!.name} 配置` });
    expect(dialog).toBeTruthy();
    expect(useSettingsStore.getState().settingsOpen).toBe(false); // 没有跳设置窗口
    // 就地改一项 quick 配置并落盘：开关就位且初值为开（todo schema 默认 showCompleted=true）再点击
    const sw = await screen.findByRole("switch", { name: "显示已完成" });
    expect(sw.getAttribute("aria-checked")).toBe("true");
    await user.click(sw);
    await waitFor(() => expect(loadWidgetConfig("card-1").showCompleted).toBe(false));
  });

  it("卡片挂载后立刻打开弹层：越过 160ms 退场窗口仍保持挂载（useDelayedUnmount 陈旧计时器回归）", async () => {
    seedConfig("card-2", {});
    useWidgetStore.setState({
      editMode: false,
      instances: [{ id: "card-2", type: "todo", x: 100, y: 200, w: 300, h: 200, z: 1 }]
    });
    const { container } = render(<WidgetCard id="card-2" type="todo" x={100} y={200} w={300} h={200} z={1} />);
    fireEvent.mouseEnter(container.querySelector(".widget-card")!);
    fireEvent.click(await screen.findByRole("button", { name: "配置此小组件" }));
    const dialog = await screen.findByRole("dialog", { name: `${getWidgetMeta("todo")!.name} 配置` });
    // 弹层随卡片以 open=false 挂载时会排下一个 duration 后卸载的计时器；打开后它不得再生效
    await act(() => new Promise((r) => setTimeout(r, 250)));
    expect(dialog.isConnected).toBe(true);
    expect(screen.getByRole("switch", { name: "显示已完成" })).toBeTruthy();
  });
});
