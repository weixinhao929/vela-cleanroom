import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";

/**
 * WeatherMini 回归：读 WeatherWidget / 天气站的缓存槽（同 key / 同 slot 格式）：
 *  - 无实例 → settings 主城市坐标的槽；
 *  - 有实例 → 该实例配置的 cityIndex（附加城市）与 unit（华氏）；
 *  - 挂载后缓存被卡片重写（本窗口 writeWeatherCacheSlot / 其他窗口 storage 事件）→ 同步刷新；
 *  - 兜底拉取：槽缺失 / 过期（>1h）时自己拉一次 current_weather 写回槽位（此前岛里
 *    无绑定实例的天气磁贴永远是「—」）；槽新鲜不请求；同槽位去重；接管期不拉；
 *    失败保持「—」且 5 分钟内不重试。
 * fetchJson 整体 mock；Date 用假时钟并逐用例推进 10 分钟，模块级重试门槛不跨用例串扰。
 */
const mocks = vi.hoisted(() => ({ fetchJson: vi.fn<(url: string) => Promise<unknown>>() }));
vi.mock("../../../lib/network", () => ({ fetchJson: mocks.fetchJson }));

import { useSettingsStore } from "../../../store/settings-store";
import { WEATHER_CACHE_KEY, readWeatherCache, writeWeatherCacheSlot } from "../weather-cache";
import { WeatherMini } from "./WeatherMini";

const CACHE_KEY = WEATHER_CACHE_KEY;
const SLOT = "31.230,121.474";
const HOUR = 60 * 60 * 1000;
const BASE = new Date(2026, 0, 1, 12, 0, 0).getTime();
let seq = 0;

/** 让 mock 的 fetch 链（then/finally）跑完并把写缓存引发的重渲染包进 act。 */
const flush = () => act(async () => {});

beforeEach(() => {
  localStorage.clear();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(BASE + seq++ * 10 * 60 * 1000);
  mocks.fetchJson.mockReset();
  mocks.fetchJson.mockResolvedValue({});
  useSettingsStore.setState((s) => ({
    extra: {
      ...s.extra,
      weatherCity: "上海",
      weatherLat: 31.2304,
      weatherLon: 121.4737,
      weatherCities: [{ name: "杭州", lat: 30.2741, lon: 120.1551 }]
    }
  }));
});
afterEach(() => {
  vi.useRealTimers();
});

const fresh = (slot: string, temperature: number, weathercode = 0) => {
  localStorage.setItem(
    CACHE_KEY,
    JSON.stringify({ [slot]: { weather: { temperature, weathercode }, at: Date.now() } })
  );
};

describe("WeatherMini", () => {
  it("无实例：读主城市槽（lat/lon 三位小数），温度四舍五入 + °；槽新鲜不请求", async () => {
    fresh(SLOT, 23.6);
    render(<WeatherMini active />);
    expect(screen.getByText("24°")).toBeInTheDocument();
    await flush();
    expect(mocks.fetchJson).not.toHaveBeenCalled();
  });

  it("有实例：按配置的 cityIndex 取附加城市槽，unit=fahrenheit 换算", () => {
    fresh("30.274,120.155", 20, 61);
    localStorage.setItem("focus-desk.widget-config.w1.v1", JSON.stringify({ cityIndex: 1, unit: "fahrenheit" }));
    render(<WeatherMini instanceId="w1" active />);
    expect(screen.getByText("68°")).toBeInTheDocument();
  });

  it("缓存缺失：先显示「—」，兜底拉取一次 current_weather 写回槽位（补齐卡片必填字段）后显示温度", async () => {
    mocks.fetchJson.mockResolvedValueOnce({ current_weather: { temperature: 23.6, weathercode: 2, windspeed: 3.4 } });
    render(<WeatherMini active />);
    expect(screen.getByText("—")).toBeInTheDocument();
    await flush();
    expect(mocks.fetchJson).toHaveBeenCalledTimes(1);
    expect(String(mocks.fetchJson.mock.calls[0][0])).toContain(
      "latitude=31.2304&longitude=121.4737&current_weather=true"
    );
    expect(screen.getByText("24°")).toBeInTheDocument();
    const slot = readWeatherCache<Record<string, unknown>>()[SLOT];
    expect(slot).toMatchObject({
      weather: { temperature: 23.6, weathercode: 2, windspeed: 3.4 },
      forecast: null,
      hourly: [],
      alerts: [],
      at: Date.now()
    });
  });

  it("缓存过期（>1h）：先显示旧温度，后台拉取后刷新；卡片写的富字段原样保留", async () => {
    localStorage.setItem(
      CACHE_KEY,
      JSON.stringify({
        [SLOT]: {
          weather: { temperature: 10, weathercode: 0 },
          forecast: { time: ["d"] },
          hourly: [{ time: "h" }],
          at: Date.now() - 2 * HOUR
        }
      })
    );
    mocks.fetchJson.mockResolvedValueOnce({ current_weather: { temperature: 12.4, weathercode: 1, windspeed: 1 } });
    render(<WeatherMini active />);
    expect(screen.getByText("10°")).toBeInTheDocument();
    await flush();
    expect(screen.getByText("12°")).toBeInTheDocument();
    expect(readWeatherCache<Record<string, unknown>>()[SLOT]).toMatchObject({
      forecast: { time: ["d"] },
      hourly: [{ time: "h" }]
    });
  });

  it("同城市多枚磁贴：按槽位去重，只请求一次；接管期（active=false）不拉取", async () => {
    mocks.fetchJson.mockResolvedValueOnce({ current_weather: { temperature: 5, weathercode: 0, windspeed: 0 } });
    const r = render(
      <>
        <WeatherMini active />
        <WeatherMini active />
      </>
    );
    await flush();
    expect(mocks.fetchJson).toHaveBeenCalledTimes(1);
    expect(screen.getAllByText("5°")).toHaveLength(2);
    r.unmount();

    localStorage.clear();
    mocks.fetchJson.mockClear();
    vi.setSystemTime(Date.now() + 10 * 60 * 1000);
    render(<WeatherMini active={false} />);
    await flush();
    expect(mocks.fetchJson).not.toHaveBeenCalled();
  });

  it("拉取失败：保持「—」不抛错，5 分钟内不再重试", async () => {
    mocks.fetchJson.mockRejectedValueOnce(new Error("boom"));
    const { unmount } = render(<WeatherMini active />);
    await flush();
    expect(screen.getByText("—")).toBeInTheDocument();
    expect(mocks.fetchJson).toHaveBeenCalledTimes(1);
    unmount();
    render(<WeatherMini active />);
    await flush();
    expect(mocks.fetchJson).toHaveBeenCalledTimes(1); // 重试门槛内重新挂载也不请求
  });

  it("挂载后卡片重写缓存槽（本窗口）→ 磁贴同步刷新；缓存从无到有也能从「—」变成温度", async () => {
    render(<WeatherMini active />);
    expect(screen.getByText("—")).toBeInTheDocument();
    await flush();
    act(() => {
      writeWeatherCacheSlot(SLOT, { weather: { temperature: 18.2, weathercode: 3 }, at: Date.now() });
    });
    expect(screen.getByText("18°")).toBeInTheDocument();
    act(() => {
      writeWeatherCacheSlot(SLOT, { weather: { temperature: 25.7, weathercode: 0 }, at: Date.now() });
    });
    expect(screen.getByText("26°")).toBeInTheDocument();
  });

  it("其他窗口写缓存（storage 事件，key 匹配）→ 刷新；无关 key 不触发重读", () => {
    fresh(SLOT, 10);
    render(<WeatherMini active />);
    expect(screen.getByText("10°")).toBeInTheDocument();
    // 模拟另一窗口：直接改 localStorage 后派发 storage 事件。
    fresh(SLOT, 30);
    act(() => {
      window.dispatchEvent(new StorageEvent("storage", { key: "focus-desk.something-else" }));
    });
    expect(screen.getByText("10°")).toBeInTheDocument();
    act(() => {
      window.dispatchEvent(new StorageEvent("storage", { key: CACHE_KEY }));
    });
    expect(screen.getByText("30°")).toBeInTheDocument();
  });
});
