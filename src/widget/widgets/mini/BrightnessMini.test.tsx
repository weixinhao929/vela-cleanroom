import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

/**
 * BrightnessMini 回归：active 后拉一次 list_brightness_monitors，取首个 supported
 * 的屏渲染紧凑滑条；拖动走 set_brightness（与 BrightnessWidget 同命令）；
 * active=false 不发任何 IPC；滑条事件不冒泡到宿主磁贴。
 */
const invokeMock = vi.fn(async (_cmd: string, _args?: unknown): Promise<unknown> => null);

vi.mock("../../../lib/tauri", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../../../lib/tauri")>();
  return { ...mod, isTauri: () => true, invoke: (cmd: string, args?: unknown) => invokeMock(cmd, args) };
});

import { BrightnessMini } from "./BrightnessMini";

const monitors = [
  { key: "ddc:1", slot: 1, label: "外接屏", kind: "ddc", supported: false, current: null },
  { key: "wmi:0", slot: 0, label: "内置屏", kind: "internal", supported: true, current: 55 }
];

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockImplementation(async (cmd: string) => (cmd === "list_brightness_monitors" ? monitors : null));
});

describe("BrightnessMini", () => {
  it("active：拉一次列表，首个 supported 屏的亮度成为滑条值；拖动发 set_brightness 且不冒泡", async () => {
    const onTile = vi.fn();
    render(
      <button onClick={onTile}>
        <BrightnessMini active />
      </button>
    );
    // WakeSlider 集成：role=slider 是键盘驱动按钮，无原生 input.value。
    const slider = (await screen.findByRole("slider")) as HTMLButtonElement;
    expect(slider.getAttribute("aria-valuenow")).toBe("55");
    expect(invokeMock.mock.calls.filter(([cmd]) => cmd === "list_brightness_monitors")).toHaveLength(1);

    for (let i = 0; i < 15; i++) fireEvent.keyDown(slider, { key: "ArrowRight" });
    expect(invokeMock).toHaveBeenCalledWith("set_brightness", { key: "wmi:0", value: 70 });
    expect(slider.getAttribute("aria-valuenow")).toBe("70");
    // 波形层 pointer-events:none（键盘手柄覆盖全轨道），点击不会冒泡到外层按钮。
    fireEvent.click(slider);
    expect(onTile).not.toHaveBeenCalled();
  });

  it("active=false：不发 IPC，显示占位「—」；翻 true 后才拉列表", async () => {
    const { rerender } = render(<BrightnessMini active={false} />);
    await Promise.resolve();
    expect(invokeMock).not.toHaveBeenCalled();
    expect(screen.getByText("—")).toBeInTheDocument();
    rerender(<BrightnessMini active />);
    expect(await screen.findByRole("slider")).toBeInTheDocument();
  });

  it("无可用显示器：保持占位「—」", async () => {
    invokeMock.mockImplementation(async () => []);
    render(<BrightnessMini active />);
    await Promise.resolve();
    expect(screen.getByText("—")).toBeInTheDocument();
    expect(screen.queryByRole("slider")).toBeNull();
  });
});
