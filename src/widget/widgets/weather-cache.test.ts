import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * weather-cache 新增能力回归：
 *  - markAlertNotified：预警推送去重基线持久化在 localStorage（同源多窗口共享），
 *    重复标记返回 false，容量上限 200 FIFO；
 *  - isWeatherSlotFresh：槽位新鲜度判定（卡片 / 磁贴 / 今日概览同一判龄口径）；
 *  - writeCurrentWeatherSlot 的 forecast 最小面合并（今日概览回写 hi/lo）。
 */
import {
  isWeatherSlotFresh,
  markAlertNotified,
  readWeatherCache,
  weatherCacheSlot,
  writeCurrentWeatherSlot,
  writeWeatherCacheSlot,
  WEATHER_CACHE_KEY
} from "./weather-cache";

const SLOT = weatherCacheSlot(31.2304, 121.4737);
const NOTIFIED_KEY = "focus-desk.weather.notified.v1";
const HOUR = 60 * 60 * 1000;

beforeEach(() => {
  localStorage.clear();
});

describe("markAlertNotified（跨窗口预警去重基线）", () => {
  it("首次标记返回 true，重复标记返回 false", () => {
    expect(markAlertNotified("s1|Rain|2026-10-06T00:00Z")).toBe(true);
    expect(markAlertNotified("s1|Rain|2026-10-06T00:00Z")).toBe(false);
  });

  it("不同城市槽位的同名同时预警各自有基线（key 含 slot）", () => {
    expect(markAlertNotified("s1|Rain|t")).toBe(true);
    expect(markAlertNotified("s2|Rain|t")).toBe(true);
  });

  it("模拟另一窗口先行写入：本窗口读最新落盘，不再推送", () => {
    localStorage.setItem(NOTIFIED_KEY, JSON.stringify(["s9|Heat|t"]));
    expect(markAlertNotified("s9|Heat|t")).toBe(false);
    expect(markAlertNotified("s9|Other|t")).toBe(true);
  });

  it("损坏存储按空基线处理；超上限丢最旧", () => {
    localStorage.setItem(NOTIFIED_KEY, "{not json");
    expect(markAlertNotified("k")).toBe(true);

    const many = Array.from({ length: 200 }, (_, i) => `old-${i}`);
    localStorage.setItem(NOTIFIED_KEY, JSON.stringify(many));
    expect(markAlertNotified("new-1")).toBe(true);
    const stored = JSON.parse(localStorage.getItem(NOTIFIED_KEY)!) as string[];
    expect(stored).toHaveLength(200);
    expect(stored[0]).toBe("old-1"); // 最旧的 old-0 被淘汰
    expect(stored[199]).toBe("new-1");
  });
});

describe("isWeatherSlotFresh", () => {
  const rawOf = (at: number) => JSON.stringify({ [SLOT]: { weather: { temperature: 20, weathercode: 0 }, at } });

  it("新鲜 / 过期 / 缺槽 / 缺 weather / 坏 JSON", () => {
    const now = Date.now();
    expect(isWeatherSlotFresh(rawOf(now), 31.2304, 121.4737, HOUR, now)).toBe(true);
    expect(isWeatherSlotFresh(rawOf(now - 2 * HOUR), 31.2304, 121.4737, HOUR, now)).toBe(false);
    expect(isWeatherSlotFresh(JSON.stringify({ other: { at: now } }), 31.2304, 121.4737, HOUR, now)).toBe(false);
    expect(isWeatherSlotFresh(JSON.stringify({ [SLOT]: { at: now } }), 31.2304, 121.4737, HOUR, now)).toBe(false);
    expect(isWeatherSlotFresh("{oops", 31.2304, 121.4737, HOUR, now)).toBe(false);
    expect(isWeatherSlotFresh("", 31.2304, 121.4737, HOUR, now)).toBe(false);
  });
});

describe("writeCurrentWeatherSlot forecast 合并", () => {
  it("富快照只换当前天气与 at，forecast 给到才覆盖，其余字段保留", () => {
    writeWeatherCacheSlot(SLOT, {
      weather: { temperature: 1, weathercode: 1, windspeed: 1 },
      forecast: null,
      hourly: [{ time: "2026-10-06T08:00", temperature: 20, weathercode: 0 }],
      humidity: 55,
      alerts: [{ event: "A", start: "s", end: "e" }],
      at: 1
    });
    writeCurrentWeatherSlot(31.2304, 121.4737, { temperature: 25, weathercode: 2, windspeed: 9 });
    let snap = readWeatherCache<Record<string, unknown>>()[SLOT] as Record<string, unknown>;
    expect((snap.weather as { temperature: number }).temperature).toBe(25);
    expect(snap.forecast).toBeNull();
    expect(Array.isArray(snap.hourly)).toBe(true);
    expect(snap.humidity).toBe(55);

    writeCurrentWeatherSlot(
      31.2304,
      121.4737,
      { temperature: 26, weathercode: 3, windspeed: 10 },
      {
        forecast: {
          time: ["2026-10-06"],
          weathercode: [3],
          temperature_2m_max: [28],
          temperature_2m_min: [18]
        }
      }
    );
    snap = readWeatherCache<Record<string, unknown>>()[SLOT] as Record<string, unknown>;
    const fc = snap.forecast as { temperature_2m_max: number[]; temperature_2m_min: number[] };
    expect(fc.temperature_2m_max[0]).toBe(28);
    expect(fc.temperature_2m_min[0]).toBe(18);
    // 之前合并的 humidity 仍在（未给的键不动已有值）。
    expect(snap.humidity).toBe(55);
  });

  it("写入口派发本窗口通知事件（今日概览等读方可订阅刷新）", () => {
    const spy = vi.fn();
    window.addEventListener("vela:weather-cache", spy);
    writeCurrentWeatherSlot(31.2304, 121.4737, { temperature: 1, weathercode: 0, windspeed: 0 });
    expect(spy).toHaveBeenCalledTimes(1);
    window.removeEventListener("vela:weather-cache", spy);
    expect(localStorage.getItem(WEATHER_CACHE_KEY)).toContain(SLOT);
  });
});
