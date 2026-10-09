/**
 * 重命名统一入口（rename.ts）与 PromptDialog 的 R 批回归：
 *  - ：IME 组词期 Enter 不提交（中文拼音选字按回车会带着半截拼音提交）；
 *  - ：maxLength 传到输入框（输入时挡下超长，而非提交后静默截断）；
 *  - ：改名 toast 带撤销，一键回旧值；
 *  - 截断按 Unicode 码点（不劈 emoji）；组名写 group.name、留空恢复。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { PromptDialogHost, promptDialog } from "../components/PromptDialog";
import { ToastHost } from "../components/ToastHost";
import { promptRenameGroup, promptRenameInstance, truncateLabel } from "./rename";
import { useWidgetStore, type WidgetGroup, type WidgetInstance } from "./widget-store";

const mkInst = (id: string, over: Partial<WidgetInstance> = {}): WidgetInstance => ({
  id,
  type: "clock",
  x: 0,
  y: 0,
  w: 200,
  h: 120,
  z: 1,
  ...over
});
const mkGroup = (over: Partial<WidgetGroup> = {}): WidgetGroup => ({
  id: "g1",
  x: 0,
  y: 0,
  w: 400,
  h: 200,
  z: 2,
  memberIds: ["a", "b"],
  activeId: "a",
  ...over
});

const prev = {
  instances: useWidgetStore.getState().instances,
  groups: useWidgetStore.getState().groups
};

const mountHosts = () =>
  render(
    <>
      <PromptDialogHost />
      <ToastHost />
    </>
  );

/** dispatch 原生 keydown（fireEvent 不支持 isComposing 初始化，手动 define）。 */
const keyDown = (el: Element, key: string, isComposing = false) => {
  const ev = new KeyboardEvent("keydown", { key, bubbles: true });
  Object.defineProperty(ev, "isComposing", { value: isComposing });
  el.dispatchEvent(ev);
};

beforeEach(() => {
  useWidgetStore.setState({ instances: [mkInst("a"), mkInst("b")], groups: [mkGroup()] });
});

afterEach(() => {
  useWidgetStore.setState(prev);
});

describe("truncateLabel（码点截断）", () => {
  it("emoji 代理对不被劈开（slice 按 UTF-16 码元会产出乱码半个字符）", () => {
    const many = "😊".repeat(30);
    const cut = truncateLabel(many);
    expect(Array.from(cut)).toHaveLength(24);
    expect(Array.from(cut).every((c) => c === "😊")).toBe(true);
  });

  it("首尾空白先 trim 再截断；中英混排按码点计数", () => {
    expect(truncateLabel("  时钟 abc  ")).toBe("时钟 abc");
    expect(Array.from(truncateLabel("时".repeat(30)))).toHaveLength(24);
  });
});

describe("PromptDialog（R4 IME / R5 maxLength）", () => {
  it("IME 组词期 Enter 不提交（弹窗保持，值不丢）；非组词 Enter 正常提交", async () => {
    mountHosts();
    let resolved: string | null = "pending";
    void promptDialog({ title: "t", allowEmpty: true }).then((v) => {
      resolved = v;
    });
    const input = await screen.findByRole("textbox");
    fireEvent.change(input, { target: { value: "天气" } });
    keyDown(input, "Enter", true);
    // 组词 Enter：不 resolve、弹窗仍在。
    expect(resolved).toBe("pending");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    keyDown(input, "Enter", false);
    await waitFor(() => expect(resolved).toBe("天气"));
  });

  it("maxLength 透传到输入框（输入时即挡下超长）", async () => {
    mountHosts();
    let resolved: string | null = "pending";
    void promptDialog({ title: "t", maxLength: 5, allowEmpty: true }).then((v) => {
      resolved = v;
    });
    const input = (await screen.findByRole("textbox")) as HTMLInputElement;
    expect(input.maxLength).toBe(5);
    keyDown(input, "Enter", false);
    await waitFor(() => expect(resolved).toBe(""));
  });
});

describe("promptRenameInstance（R10 撤销闭环）", () => {
  it("已命名成员的 placeholder 示自动名而非当前名（S1：留空恢复成什么要可见）", async () => {
    mountHosts();
    useWidgetStore.setState({ instances: [mkInst("a", { label: "我的时钟" }), mkInst("b")] });
    const p = promptRenameInstance("a", (s) => s);
    const input = await screen.findByRole("textbox");
    // 预填自定义名；placeholder 是忽略 label 的自动名（不依赖 registry 词条，
    // 只断言「不等于当前名且非空」——前它就是预填值的复读）。
    expect((input as HTMLInputElement).value).toBe("我的时钟");
    const ph = (input as HTMLInputElement).placeholder;
    expect(ph).not.toBe("");
    expect(ph).not.toBe("我的时钟");
    fireEvent.keyDown(input, { key: "Escape" });
    await p;
  });

  it("改名后 toast 撤销一键回旧值", async () => {
    mountHosts();
    useWidgetStore.setState({ instances: [mkInst("a", { label: "旧名字" }), mkInst("b")] });
    const p = promptRenameInstance("a", (s) => s);
    const input = await screen.findByRole("textbox");
    expect((input as HTMLInputElement).value).toBe("旧名字");
    expect((input as HTMLInputElement).maxLength).toBe(24);
    fireEvent.change(input, { target: { value: "新名字" } });
    fireEvent.click(screen.getByRole("button", { name: "重命名" }));
    await p;
    await waitFor(() => {
      expect(useWidgetStore.getState().instances.find((i) => i.id === "a")!.label).toBe("新名字");
    });
    // 撤销：toast 动作恢复旧值。
    const undo = await screen.findByRole("button", { name: "撤销" });
    fireEvent.click(undo);
    await waitFor(() => {
      expect(useWidgetStore.getState().instances.find((i) => i.id === "a")!.label).toBe("旧名字");
    });
  });

  it("原样提交（值未变）不写不发 toast", async () => {
    mountHosts();
    useWidgetStore.setState({ instances: [mkInst("a", { label: "同名" }), mkInst("b")] });
    const before = useWidgetStore.getState().instances;
    const p = promptRenameInstance("a", (s) => s);
    await screen.findByRole("textbox");
    fireEvent.click(screen.getByRole("button", { name: "重命名" }));
    await p;
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
    expect(useWidgetStore.getState().instances).toBe(before);
    expect(screen.queryByRole("button", { name: "撤销" })).not.toBeInTheDocument();
  });
});

describe("promptRenameGroup（R9 组名）", () => {
  it("写 group.name；留空恢复默认；撤销回旧值", async () => {
    mountHosts();
    const p = promptRenameGroup("g1", (s) => s);
    const input = await screen.findByRole("textbox");
    // 未命名：预填空 + placeholder 示默认名。
    expect((input as HTMLInputElement).value).toBe("");
    fireEvent.change(input, { target: { value: "工作台" } });
    fireEvent.click(screen.getByRole("button", { name: "重命名" }));
    await p;
    await waitFor(() => {
      expect(useWidgetStore.getState().groups[0].name).toBe("工作台");
    });
    // 撤销回 undefined。
    fireEvent.click(await screen.findByRole("button", { name: "撤销" }));
    await waitFor(() => {
      expect(useWidgetStore.getState().groups[0].name).toBeUndefined();
    });
  });

  it("留空提交恢复默认（group.name → undefined）", async () => {
    mountHosts();
    useWidgetStore.setState({ groups: [mkGroup({ name: "旧组名" })] });
    const p = promptRenameGroup("g1", (s) => s);
    const input = await screen.findByRole("textbox");
    expect((input as HTMLInputElement).value).toBe("旧组名");
    fireEvent.change(input, { target: { value: "" } });
    const dlg = screen.getByRole("dialog");
    fireEvent.click(within(dlg).getByRole("button", { name: "重命名" }));
    await p;
    await waitFor(() => {
      expect(useWidgetStore.getState().groups[0].name).toBeUndefined();
    });
  });
});

describe("removeGroupMember 反馈解散契约（P2 依赖的 store 行为）", () => {
  it("2 人组摘出成员 → 「已解散编组」toast + 撤销重建（拖标签摘出致解散走的就是这条路径）", async () => {
    mountHosts();
    useWidgetStore.getState().removeGroupMember("g1", "a");
    await screen.findByText("已解散编组");
    expect(useWidgetStore.getState().groups).toHaveLength(0);
    expect(useWidgetStore.getState().instances.every((i) => !i.groupId)).toBe(true);
    // 同文件前序用例的 toast 可能仍在退场窗口内：取最新一枚（追加在末尾）。
    const undos = screen.getAllByRole("button", { name: "撤销" });
    fireEvent.click(undos[undos.length - 1]);
    await waitFor(() => {
      expect(useWidgetStore.getState().groups[0]?.memberIds).toEqual(["a", "b"]);
    });
  });
});
