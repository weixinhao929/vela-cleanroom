/**
 * 设置页「连接」（ConnectionPage）行为测试（lib/network / ip-geo / ToastHost mock）：
 *  - 附加城市：输入城市名 Enter → geocode 命中后追加进 extra.weatherCities 落库；
 *  - 快速连删两个城市（Set + getState 修复）：两条退场定时器先后落拍时，
 *    删除走「现取最新表再过滤」，先删的城市不被后到的定时器复活；
 *    chipOut 退场态按 Set 独立互不腰斩；
 *  - 网络超时滑条（min 对齐）：min=1 与 store sanitize（1–60）一致，
 *    外部（跨窗同步 / 导入）写入 1 时滑条原值显示 1，键盘 Home 也能写回 1。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const h = vi.hoisted(() => ({
  geocodeMock: vi.fn(async (_q: string): Promise<{ lat: number; lon: number; name: string } | null> => null),
  toastMock: vi.fn()
}));

vi.mock("../../../lib/network", () => ({
  geocodeCity: (q: string) => h.geocodeMock(q),
  getCurrentPosition: async () => null as { lat: number; lon: number } | null,
  testConnectivity: async () => ({ online: true, latencyMs: 5 }),
  measureDownloadSpeed: async () => {
    throw new Error("offline");
  },
  measureUploadSpeed: async () => {
    throw new Error("offline");
  },
  formatByteRate: (n: number) => `${n} B/s`,
  formatBytesTotal: (n: number) => `${n} B`,
  mbpsToBps: (m: number) => m * 125000
}));

vi.mock("../../../lib/ip-geo", () => ({
  fetchIpGeo: async () => null as { city: string; lat: number; lon: number } | null,
  clearIpGeoCache: () => {},
  readIpGeoCache: () => null
}));

vi.mock("../../../components/ToastHost", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../../../components/ToastHost")>();
  return { ...mod, showToast: (text: string, kind?: string) => h.toastMock(text, kind) };
});

import { ConnectionPage } from "./ConnectionPage";
import { useSettingsStore } from "../../../store/settings-store";

const SETTINGS_KEY = "focus-desk.settings.v1";
const extra = () => useSettingsStore.getState().extra;
const snapshot = () =>
  JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "{}") as { extra?: { weatherCities?: { name: string }[] } };

beforeEach(() => {
  localStorage.clear();
  h.geocodeMock.mockReset();
  h.geocodeMock.mockImplementation(async () => null);
  h.toastMock.mockReset();
  useSettingsStore.setState((s) => ({
    extra: {
      ...s.extra,
      weatherCity: "北京",
      weatherLat: 39.9,
      weatherLon: 116.4,
      weatherCities: [
        { name: "上海", lat: 31.2, lon: 121.5 },
        { name: "广州", lat: 23.1, lon: 113.3 }
      ],
      weatherAutoLocate: false,
      networkTimeout: 10
    }
  }));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("ConnectionPage · 附加城市", () => {
  it("输入「南京」Enter → geocode 命中后追加进 weatherCities 落库，输入框清空并提示已添加", async () => {
    const user = userEvent.setup();
    h.geocodeMock.mockImplementation(async (q: string) =>
      q === "南京" ? { name: "南京", lat: 32.06, lon: 118.78 } : null
    );
    render(<ConnectionPage />);
    const input = screen.getByLabelText("附加城市") as HTMLInputElement;
    await user.type(input, "南京{enter}");
    await waitFor(() => expect(extra().weatherCities.map((c) => c.name)).toEqual(["上海", "广州", "南京"]));
    expect(input.value).toBe("");
    expect(screen.getByText("已添加：南京")).toBeInTheDocument();
    // 落库快照含新城市。
    await waitFor(() => expect(snapshot().extra?.weatherCities?.map((c) => c.name)).toEqual(["上海", "广州", "南京"]));
  });

  it("geocode 未命中 → 不落库，提示未找到该城市", async () => {
    const user = userEvent.setup();
    render(<ConnectionPage />);
    await user.type(screen.getByLabelText("附加城市"), "亚特兰蒂斯{enter}");
    await waitFor(() => expect(screen.getByText("未找到该城市，请检查名称后重试。")).toBeInTheDocument());
    expect(extra().weatherCities).toHaveLength(2);
  });

  it("已有 8 个城市时再添加 → 提示上限且不落库（旧实现 push 后 slice 静默丢弃却报「已添加」）", async () => {
    const user = userEvent.setup();
    h.geocodeMock.mockImplementation(async (q: string) =>
      q === "南京" ? { name: "南京", lat: 32.06, lon: 118.78 } : null
    );
    useSettingsStore.setState((s) => ({
      extra: {
        ...s.extra,
        weatherCities: Array.from({ length: 8 }, (_, i) => ({ name: `城市${i}`, lat: 0, lon: 0 }))
      }
    }));
    render(<ConnectionPage />);
    await user.type(screen.getByLabelText("附加城市"), "南京{enter}");
    await waitFor(() => expect(screen.getByText("最多添加 8 个城市")).toBeInTheDocument());
    expect(extra().weatherCities).toHaveLength(8);
    expect(extra().weatherCities.some((c) => c.name === "南京")).toBe(false);
  });
});

describe("ConnectionPage · 主城市名/坐标一致性", () => {
  it("输入新城市失焦 → geocode 成功后名称与坐标同拍落库（不再出现新名字配旧坐标）", async () => {
    const user = userEvent.setup();
    h.geocodeMock.mockImplementation(async (q: string) =>
      q === "上海" ? { name: "上海", lat: 31.23, lon: 121.47 } : null
    );
    render(<ConnectionPage />);
    const input = screen.getByLabelText("天气城市") as HTMLInputElement;
    await user.clear(input);
    await user.type(input, "上海");
    fireEvent.blur(input);
    await waitFor(() => expect(extra().weatherCity).toBe("上海"));
    expect(extra().weatherLat).toBe(31.23);
    expect(extra().weatherLon).toBe(121.47);
  });

  it("geocode 失败 → 名称不落库、草稿回滚为当前生效城市（store 坐标不被破坏）", async () => {
    const user = userEvent.setup();
    render(<ConnectionPage />);
    const input = screen.getByLabelText("天气城市") as HTMLInputElement;
    await user.clear(input);
    await user.type(input, "不存在的城市");
    fireEvent.blur(input);
    await waitFor(() => expect(screen.getByText("未找到该城市，请检查名称后重试。")).toBeInTheDocument());
    expect(extra().weatherCity).toBe("北京");
    expect(extra().weatherLat).toBe(39.9);
    expect(extra().weatherLon).toBe(116.4);
    await waitFor(() => expect(input.value).toBe("北京"));
  });
});

describe("ConnectionPage · 快速连删两个城市（F4 Set + getState 回归锁）", () => {
  it("160ms 退场窗口内连删两个 → 都真正移除，先删的不被复活；两枚 chip 退场态并存", async () => {
    vi.useFakeTimers();
    render(<ConnectionPage />);
    // 两枚 chip 的删除按钮（aria-label「删除{城市名}」）。
    const delShanghai = screen.getByRole("button", { name: "删除上海" });
    const delGuangzhou = screen.getByRole("button", { name: "删除广州" });
    const chipOf = (name: string) => screen.getByText(name).closest(".tm-city-chip") as HTMLElement;

    fireEvent.click(delShanghai);
    expect(chipOf("上海")).toHaveClass("is-closing");
    // 第二删在第一个的 160ms 退场窗口内：两枚 chip 各自持有退场态（Set 独立，
    // 修复前单值 + 共用定时器会互相腰斩退场动画并清掉对方的回退定时器）。
    fireEvent.click(delGuangzhou);
    expect(chipOf("上海")).toHaveClass("is-closing");
    expect(chipOf("广州")).toHaveClass("is-closing");

    // 两个退场定时器先后落拍：删除各自走「现取最新表再过滤」，
    // 后落拍的定时器不得用旧快照把先删的上海复活。
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(extra().weatherCities).toEqual([]);
    expect(screen.queryByText("上海")).toBeNull();
    expect(screen.queryByText("广州")).toBeNull();
    // 落库快照同样为空。
    expect(snapshot().extra?.weatherCities).toEqual([]);
  });
});

describe("ConnectionPage · 网络超时滑条（F4 min 对齐）", () => {
  it("滑条 aria-valuemin=1；外部导入/同步写入 1 时原值显示 1（不被旧 min=3 钳曲）", () => {
    useSettingsStore.setState((s) => ({ extra: { ...s.extra, networkTimeout: 1 } }));
    render(<ConnectionPage />);
    const slider = screen.getByRole("slider", { name: "网络超时" });
    expect(slider).toHaveAttribute("aria-valuemin", "1");
    expect(slider).toHaveAttribute("aria-valuenow", "1");
  });

  it("默认 10：Home 键可写回最小值 1 → store.networkTimeout=1（可写范围与 sanitize 1–60 一致）", async () => {
    render(<ConnectionPage />);
    const slider = screen.getByRole("slider", { name: "网络超时" });
    expect(slider).toHaveAttribute("aria-valuenow", "10");
    expect(slider).toHaveAttribute("aria-valuemin", "1");
    slider.focus();
    fireEvent.keyDown(slider, { key: "Home" });
    expect(extra().networkTimeout).toBe(1);
    expect(screen.getByRole("slider", { name: "网络超时" })).toHaveAttribute("aria-valuenow", "1");
  });
});
