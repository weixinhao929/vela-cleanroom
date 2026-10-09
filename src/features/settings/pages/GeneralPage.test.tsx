/**
 * 设置页「通用」（GeneralPage）行为测试：
 *  - 热键唤醒黑名单（草稿语义）：逐键输入不落库（此前每键 setGeneral
 *    整快照落盘 + 跨窗广播），blur / Enter 提交才写入（normalizeBlacklist
 *    小写化 + 去重后入 store 与持久化快照）；
 *  - 卸载兜底（unmount commit）：输入后不 blur 直接卸载（切页/关窗），
 *    store 仍收到一次提交；
 *  - 开机自启动（轮 快照守卫）：挂载回读 get_autostart 慢返回时，
 *    用户已翻转的开关值不被回读到的旧系统值覆盖。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

/* GeneralPage 的依赖链里有模块在顶层调用 isTauri()（先于测试体执行），
   mock 工厂共享态必须走 vi.hoisted，避免 TDZ。 */
const h = vi.hoisted(() => ({
  invokeMock: vi.fn(async (_cmd: string, _args?: unknown): Promise<unknown> => null),
  tauriOn: false
}));

vi.mock("../../../lib/tauri", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../../../lib/tauri")>();
  return {
    ...mod,
    isTauri: () => h.tauriOn,
    invoke: (cmd: string, args?: unknown) => h.invokeMock(cmd, args)
  };
});
const { invokeMock } = h;
const setTauri = (v: boolean) => {
  h.tauriOn = v;
};

import { GeneralPage } from "./GeneralPage";
import { useSettingsStore } from "../../../store/settings-store";

const SETTINGS_KEY = "focus-desk.settings.v1";
const general = () => useSettingsStore.getState().general;
const snapshot = () =>
  JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "{}") as { general?: { hotkeyBlacklist?: string[] } };

beforeEach(() => {
  localStorage.clear();
  invokeMock.mockReset();
  invokeMock.mockImplementation(async () => null);
  setTauri(false);
  useSettingsStore.setState((s) => ({ general: { ...s.general, hotkeyBlacklist: [], launchOnStartup: false } }));
});

describe("GeneralPage · 热键唤醒黑名单（P2-3 草稿语义 + F4 卸载兜底）", () => {
  it("逐键输入只进草稿不落库；blur 提交落库（小写化）；Enter 提交同样落库", async () => {
    const user = userEvent.setup();
    render(<GeneralPage />);
    const input = screen.getByPlaceholderText("game.exe, player.exe") as HTMLInputElement;
    await user.type(input, "A.EXE");
    // 键入期间 store 从未收到半成品草稿。
    expect(general().hotkeyBlacklist).toEqual([]);
    // blur（点走焦点）提交：normalizeBlacklist 小写化后入库。
    await user.tab();
    expect(general().hotkeyBlacklist).toEqual(["a.exe"]);
    expect(snapshot().general?.hotkeyBlacklist).toEqual(["a.exe"]);

    // Enter 提交：输入框承载整份逗号分隔列表，追加第二条后提交，去重与小写化同口径。
    await user.type(input, ", b.exe{enter}");
    expect(general().hotkeyBlacklist).toEqual(["a.exe", "b.exe"]);
    expect(snapshot().general?.hotkeyBlacklist).toEqual(["a.exe", "b.exe"]);

    // 整表替换语义 + 半角/全角分号与全角逗号、空白段切分，重复项去重。
    // （全角分号「；」曾不在分隔符表内，中文输入法整段会被当单条——已修，此处锁定。）
    await user.clear(input);
    await user.type(input, "a.exe, c.exe;d.exe；e.exe，  {enter}");
    expect(general().hotkeyBlacklist).toEqual(["a.exe", "c.exe", "d.exe", "e.exe"]);
  });

  it("卸载兜底（F4）：输入后不 blur 直接卸载 → store 仍收到提交并落库", async () => {
    const user = userEvent.setup();
    const view = render(<GeneralPage />);
    const input = screen.getByPlaceholderText("game.exe, player.exe");
    await user.type(input, "game.exe");
    expect(general().hotkeyBlacklist).toEqual([]);
    // 切页 / 关窗：不触发 blur，卸载 effect 补一次提交。
    view.unmount();
    expect(general().hotkeyBlacklist).toEqual(["game.exe"]);
    expect(snapshot().general?.hotkeyBlacklist).toEqual(["game.exe"]);
  });

  it("草稿与库同值时卸载不产生多余写入（值未变不写）", async () => {
    useSettingsStore.setState((s) => ({ general: { ...s.general, hotkeyBlacklist: ["x.exe"] } }));
    const view = render(<GeneralPage />);
    // 不动输入框（草稿 == 持久值），直接卸载：commitBlacklist 比对后不写。
    view.unmount();
    expect(general().hotkeyBlacklist).toEqual(["x.exe"]);
  });
});

describe("GeneralPage · 开机自启动（F1 轮 P1-3 回读竞态守卫）", () => {
  it("get_autostart 慢返回不覆盖用户已切换的值：回读到 false 时 store 仍是用户开启的 true", async () => {
    setTauri(true);
    // 挂载回读挂起直到测试显式 resolve（模拟慢 IPC）；用户拨开关后 setLaunch
    // 的对账回读是第二次调用，按「set_autostart 刚写成功」返回 true。
    let resolveMountReadback!: (v: boolean) => void;
    let readbackCalls = 0;
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "get_autostart") {
        readbackCalls += 1;
        if (readbackCalls === 1) {
          return new Promise<boolean>((res) => {
            resolveMountReadback = res;
          });
        }
        return Promise.resolve(true);
      }
      if (cmd === "get_desktop_icons") return Promise.resolve(true);
      return Promise.resolve(null);
    });
    render(<GeneralPage />);
    const sw = screen.getByRole("switch", { name: "开机启动" });
    expect(sw).toHaveAttribute("aria-checked", "false");

    // 慢回读仍在飞：用户先把开关拨到开（写 store + set_autostart）。
    const user = userEvent.setup();
    await user.click(sw);
    expect(general().launchOnStartup).toBe(true);
    expect(invokeMock.mock.calls.some(([cmd]) => cmd === "set_autostart")).toBe(true);

    // 慢回读此刻才返回系统旧值 false：不得覆盖用户刚写的 true。
    resolveMountReadback(false);
    await waitFor(() => expect(readbackCalls).toBe(2));
    // 让微任务队列冲刷完（.then 回调已执行）。
    await Promise.resolve();
    await Promise.resolve();
    expect(general().launchOnStartup).toBe(true);
    expect(screen.getByRole("switch", { name: "开机启动" })).toHaveAttribute("aria-checked", "true");
  });

  it("P2 协议对齐：set_autostart 失败时就地报错，并按回读值校正（不再假开）", async () => {
    setTauri(true);
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "get_autostart") return Promise.resolve(false); // 注册表仍为关
      if (cmd === "get_desktop_icons") return Promise.resolve(true);
      if (cmd === "set_autostart") return Promise.reject(new Error("denied by policy"));
      return Promise.resolve(null);
    });
    render(<GeneralPage />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("switch", { name: "开机启动" }));
    // 失败提示就地出现（2.6s 自动消失，此处只验证出现与内容）。
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("开机启动设置失败"));
    // 回读注册表仍为 false：开关回退为关。
    expect(general().launchOnStartup).toBe(false);
    expect(screen.getByRole("switch", { name: "开机启动" })).toHaveAttribute("aria-checked", "false");
  });

  it("对照：用户未动过开关时，慢回读的 true 正常回填", async () => {
    setTauri(true);
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "get_autostart") return Promise.resolve(true);
      if (cmd === "get_desktop_icons") return Promise.resolve(true);
      return Promise.resolve(null);
    });
    render(<GeneralPage />);
    await waitFor(() => expect(general().launchOnStartup).toBe(true));
    expect(screen.getByRole("switch", { name: "开机启动" })).toHaveAttribute("aria-checked", "true");
  });
});
