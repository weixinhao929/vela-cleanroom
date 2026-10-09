import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";

/**
 * WeatherWidget 卡片层回归（本轮天气审计的行为改动）：
 *  - cityIndex 超界（附加城市被删）→ 钳制到最后一个城市并回写配置，
 *    chips 高亮不再悬空；
 *  - 预警横幅生效窗口：过期的隐藏、生效中的展示；时间串按城市本地时间
 *    （utc_offset_seconds）换算，坏串按「未结束」兜底（宁多勿漏）；
 *  - 预警推送去重：key 含城市槽位（不同城市同名同时预警各自推），基线在
 *    localStorage（第二个实例冷启动不重复推）。
 * fetchJson 整体 mock（weather-shared 的共享请求也走它）；sourceNotify mock。
 */
const mocks = vi.hoisted(() => ({
  fetchJson: vi.fn<(url: string, opts?: unknown) => Promise<unknown>>(),
  sourceNotify: vi.fn()
}));
vi.mock("../../lib/network", () => ({ fetchJson: mocks.fetchJson }));
vi.mock("../../lib/notifications", () => ({ sourceNotify: mocks.sourceNotify }));

import { useSettingsStore } from "../../store/settings-store";
import { WEATHER_CACHE_KEY, weatherCacheSlot } from "./weather-cache";
import { WeatherWidget } from "./WeatherWidget";

const CFG_KEY = "focus-desk.widget-config.wx-test.v1";
const SLOT_MAIN = weatherCacheSlot(31.2304, 121.4737); // 上海

/** Open-Meteo 最小可用载荷（current_weather 缺失时组件静默跳过主流程）。 */
const omPayload = (alerts: Array<{ event: string; start: string; end: string; headline?: string }>) => ({
  current_weather: { temperature: 21.4, weathercode: 2, windspeed: 12 },
  current: { relative_humidity_2m: 60, apparent_temperature: 20 },
  utc_offset_seconds: 8 * 3600,
  alerts
});

const flush = () => act(async () => {});

beforeEach(() => {
  localStorage.clear();
  mocks.fetchJson.mockReset();
  mocks.fetchJson.mockResolvedValue({});
  mocks.sourceNotify.mockClear();
  useSettingsStore.setState((s) => ({
    extra: {
      ...s.extra,
      weatherCity: "上海",
      weatherLat: 31.2304,
      weatherLon: 121.4737,
      weatherCities: [{ name: "杭州", lat: 30.2741, lon: 120.1551 }],
      weatherAutoLocate: false
    }
  }));
});

describe("WeatherWidget 城市索引钳制", () => {
  it("cityIndex 超界：钳制到最后城市、chips 有高亮、配置回写", async () => {
    localStorage.setItem(CFG_KEY, JSON.stringify({ cityIndex: 5 }));
    render(<WeatherWidget instanceId="wx-test" />);
    await flush();
    const tabs = screen.getAllByRole("tab");
    expect(tabs).toHaveLength(2);
    expect(tabs[1]).toHaveAttribute("aria-selected", "true"); // 杭州（最后城市）
    expect(JSON.parse(localStorage.getItem(CFG_KEY)!).cityIndex).toBe(1);
  });

  it("合法 cityIndex 不动配置", async () => {
    localStorage.setItem(CFG_KEY, JSON.stringify({ cityIndex: 0 }));
    render(<WeatherWidget instanceId="wx-test" />);
    await flush();
    expect(screen.getAllByRole("tab")[0]).toHaveAttribute("aria-selected", "true");
    expect(JSON.parse(localStorage.getItem(CFG_KEY)!).cityIndex).toBe(0);
  });
});

describe("WeatherWidget 预警横幅生效窗口", () => {
  const seedCache = (alerts: Array<{ event: string; start: string; end: string }>, utcOffset: number) => {
    localStorage.setItem(
      WEATHER_CACHE_KEY,
      JSON.stringify({
        [SLOT_MAIN]: {
          weather: { temperature: 20, weathercode: 2, windspeed: 8 },
          forecast: null,
          hourly: [],
          humidity: null,
          alerts,
          at: Date.now(),
          utcOffset
        }
      })
    );
  };

  it("已过期（按城市本地时间换算）→ 不显示横幅", async () => {
    seedCache([{ event: "过期预警", start: "2020-01-01T00:00", end: "2020-01-02T00:00" }], 8 * 3600);
    render(<WeatherWidget instanceId="wx-test" />);
    await flush();
    expect(screen.queryByText("过期预警")).toBeNull();
  });

  it("生效中（本地时间窗口）→ 显示横幅", async () => {
    seedCache([{ event: "生效预警", start: "2020-01-01T00:00", end: "2099-01-01T00:00" }], 8 * 3600);
    render(<WeatherWidget instanceId="wx-test" />);
    await flush();
    expect(screen.getByText("生效预警")).toBeTruthy();
  });

  it("坏 end 串（解析 NaN）→ 按「未结束」兜底显示（宁多勿漏）", async () => {
    seedCache([{ event: "坏串预警", start: "2020-01-01T00:00", end: "not-a-date" }], 8 * 3600);
    render(<WeatherWidget instanceId="wx-test" />);
    await flush();
    expect(screen.getByText("坏串预警")).toBeTruthy();
  });
});

describe("WeatherWidget 预警推送去重（key 含城市槽位 + localStorage 基线）", () => {
  it("同槽位：第二实例冷启动不重复推；不同城市同名同时预警各自推", async () => {
    const alerts = [{ event: "Heavy Rain", start: "2020-01-01T00:00:00Z", end: "2099-01-01T00:00:00Z" }];
    mocks.fetchJson.mockImplementation((url: string) =>
      Promise.resolve(typeof url === "string" && url.includes("air-quality-api") ? {} : omPayload(alerts))
    );

    // 实例 1：上海（cityIndex 0）→ 推一次。
    const u1 = render(<WeatherWidget instanceId="wx-a" />);
    await waitFor(() => expect(mocks.sourceNotify).toHaveBeenCalledTimes(1));
    u1.unmount();

    // 实例 2：同城市（上海）冷启动，缓存已含该预警且基线已标记 → 不再推。
    const u2 = render(<WeatherWidget instanceId="wx-b" />);
    await flush();
    expect(mocks.sourceNotify).toHaveBeenCalledTimes(1);
    u2.unmount();

    // 实例 3：杭州（cityIndex 1）同名同时预警 → 不同城市槽位，照常推。
    localStorage.setItem("focus-desk.widget-config.wx-c.v1", JSON.stringify({ cityIndex: 1 }));
    render(<WeatherWidget instanceId="wx-c" />);
    await waitFor(() => expect(mocks.sourceNotify).toHaveBeenCalledTimes(2));
    expect(mocks.sourceNotify.mock.calls[1][1]).toContain("杭州");
  });
});
