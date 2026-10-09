import { describe, expect, it } from "vitest";
import {
  aggregateNormals,
  alertTimeMs,
  archiveUrl,
  dayKey,
  hourLabel,
  localTimeToMs,
  nextHourPrecip,
  normalForDate,
  polylinePath,
  precipKind,
  sliceNext24h,
  summarizeNextHour,
  valueRange
} from "./weather-station-data";

describe("weather-station-data 时间工具", () => {
  it("localTimeToMs 用 utc_offset_seconds 换算城市本地时间；缺失时退回本机解析", () => {
    // 东八区 15:00 = UTC 07:00
    expect(localTimeToMs("2026-09-15T15:00", 8 * 3600)).toBe(Date.parse("2026-09-15T07:00:00Z"));
    expect(localTimeToMs("2026-09-15T15:00", undefined)).toBe(new Date("2026-09-15T15:00").getTime());
  });

  it("hourLabel / dayKey 直接截取时间串", () => {
    expect(hourLabel("2026-09-15T07:00")).toBe("07:00");
    expect(hourLabel("garbage")).toBe("");
    expect(dayKey("2026-09-15")).toBe("09-15");
    expect(dayKey("2026-02-29T00:00")).toBe("02-29");
    expect(dayKey("x")).toBe("");
  });

  it("alertTimeMs：带偏移/Z 的串直接解析；无偏移按城市本地时间换算；坏串 NaN", () => {
    // 显式偏移（Open-Meteo alerts 常见形态）：不依赖 utcOffset 参数。
    expect(alertTimeMs("2026-10-07T06:00+08:00", -5 * 3600)).toBe(Date.parse("2026-10-07T06:00+08:00"));
    expect(alertTimeMs("2026-10-07T06:00Z", undefined)).toBe(Date.parse("2026-10-07T06:00:00Z"));
    expect(alertTimeMs("2026-10-07T06:00:00-04:00", 0)).toBe(Date.parse("2026-10-07T06:00:00-04:00"));
    // 无偏移（timezone=auto 的城市本地时间）：必须用 offset 换算，否则跨时区错位。
    expect(alertTimeMs("2026-10-07T06:00", 8 * 3600)).toBe(Date.parse("2026-10-07T06:00:00Z") - 8 * 3600 * 1000);
    expect(alertTimeMs("2026-10-07T06:00", -5 * 3600)).toBe(Date.parse("2026-10-07T06:00:00Z") + 5 * 3600 * 1000);
    // 无偏移且无 offset：退回本机时区解析（与 localTimeToMs 同口径）。
    expect(alertTimeMs("2026-10-07T06:00", undefined)).toBe(new Date("2026-10-07T06:00").getTime());
    // 坏串 / 空串 → NaN（调用方自行兜底，宁推勿漏）。
    expect(Number.isNaN(alertTimeMs("", 0))).toBe(true);
    expect(Number.isNaN(alertTimeMs("not-a-date", 0))).toBe(true);
  });
});

describe("气候常模（archive 聚合 + 滑窗）", () => {
  it("archiveUrl 覆盖完整年份区间并请求 max/min/mean", () => {
    const u = archiveUrl(31.2, 121.5, 2016, 2025);
    expect(u).toContain("archive-api.open-meteo.com/v1/archive");
    expect(u).toContain("start_date=2016-01-01");
    expect(u).toContain("end_date=2025-12-31");
    expect(u).toContain("temperature_2m_mean");
  });

  it("aggregateNormals 按 MM-DD 多年平均，null 样本跳过，缺 mean 用 (max+min)/2", () => {
    const n = aggregateNormals({
      time: ["2023-09-15", "2024-09-15", "2025-09-15", "2025-09-16"],
      temperature_2m_max: [30, 32, null, 28],
      temperature_2m_min: [20, 22, 21, 18],
      temperature_2m_mean: [25, null, 26, 23]
    });
    // 09-15：2023(30/20/25) + 2024(32/22/(32+22)/2=27)；2025 max=null 跳过
    expect(n["09-15"].samples).toBe(2);
    expect(n["09-15"].tmax).toBe(31);
    expect(n["09-15"].tmin).toBe(21);
    expect(n["09-15"].tmean).toBe(26);
    expect(n["09-16"]).toMatchObject({ tmax: 28, tmin: 18, tmean: 23, samples: 1 });
  });

  it("normalForDate ±window 按样本数加权平滑；无样本返回 null", () => {
    const n = {
      "09-14": { tmax: 30, tmin: 20, tmean: 25, samples: 1 },
      "09-15": { tmax: 34, tmin: 24, tmean: 29, samples: 3 },
      "09-16": { tmax: 30, tmin: 20, tmean: 25, samples: 1 }
    };
    const r = normalForDate(n, new Date(2026, 8, 15), 1)!;
    // (30×1 + 34×3 + 30×1) / 5 = 32.4
    expect(r.tmax).toBeCloseTo(32.4, 5);
    expect(r.samples).toBe(5);
    expect(normalForDate(n, new Date(2026, 0, 1), 1)).toBeNull();
  });

  it("normalForDate 跨年环绕（12-31 的窗口含 01-01）", () => {
    const n = { "01-01": { tmax: 5, tmin: -5, tmean: 0, samples: 2 } };
    expect(normalForDate(n, new Date(2026, 11, 31), 1)!.tmean).toBe(0);
  });
});

describe("minutely_15 未来一小时降雨", () => {
  const offset = 8 * 3600;
  // 城市本地 10:00 起 8 个槽
  const m = {
    time: [
      "2026-09-15T10:00",
      "2026-09-15T10:15",
      "2026-09-15T10:30",
      "2026-09-15T10:45",
      "2026-09-15T11:00",
      "2026-09-15T11:15",
      "2026-09-15T11:30",
      "2026-09-15T11:45"
    ],
    precipitation: [0, 0, 0.5, 1.2, 3, 0, null, 0]
  };

  it("从包含现在的槽起取 4 槽并换算 mm/h（×4）", () => {
    const now = localTimeToMs("2026-09-15T10:20", offset); // 落在 10:15 槽
    const slots = nextHourPrecip(m, now, offset);
    expect(slots.map((s) => s.time)).toEqual([
      "2026-09-15T10:15",
      "2026-09-15T10:30",
      "2026-09-15T10:45",
      "2026-09-15T11:00"
    ]);
    expect(slots.map((s) => s.mmPerHour)).toEqual([0, 2, 4.8, 12]);
  });

  it("序列不覆盖当前时刻 → 空（调用方隐藏）；null 槽按 0", () => {
    expect(nextHourPrecip(m, localTimeToMs("2026-09-15T13:00", offset), offset)).toEqual([]);
    expect(nextHourPrecip(undefined, Date.now(), offset)).toEqual([]);
    const late = nextHourPrecip(m, localTimeToMs("2026-09-15T11:20", offset), offset);
    expect(late.map((s) => s.mmPerHour)).toEqual([0, 0, 0]); // 11:15/11:30(null)/11:45，序列尾部不足 4 槽
  });

  it("summarizeNextHour：总量 / 峰值 / 起雨分钟 / 分级", () => {
    const now = localTimeToMs("2026-09-15T10:05", offset);
    const s = summarizeNextHour(nextHourPrecip(m, now, offset));
    expect(s.totalMm).toBeCloseTo(0 + 0 + 0.5 + 1.2, 6);
    expect(s.peakMmPerHour).toBe(4.8);
    expect(s.startsInMin).toBe(30);
    expect(s.kind).toBe("moderate");
    const dry = summarizeNextHour([
      { time: "t", mmPerHour: 0 },
      { time: "t", mmPerHour: 0.05 }
    ]);
    expect(dry.kind).toBe("none");
    expect(dry.startsInMin).toBeNull();
  });

  it("precipKind WMO 阈值", () => {
    expect(precipKind(0)).toBe("none");
    expect(precipKind(0.09)).toBe("none");
    expect(precipKind(0.1)).toBe("light");
    expect(precipKind(2.5)).toBe("moderate");
    expect(precipKind(10)).toBe("heavy");
    expect(precipKind(NaN)).toBe("none");
  });
});

describe("24h 多指标切片 + 折线几何", () => {
  it("sliceNext24h 从当前小时起取 24 点，兼容 weather_code / weathercode 两种键", () => {
    const time = Array.from({ length: 48 }, (_, i) => `2026-09-15T${String(i % 24).padStart(2, "0")}:00`);
    const h = {
      time: time.map((t, i) => (i < 24 ? t : t.replace("15T", "16T"))),
      temperature_2m: time.map((_, i) => i),
      weathercode: time.map(() => 3)
    };
    const now = localTimeToMs("2026-09-15T05:30", 0);
    const s = sliceNext24h(h, now, 0);
    expect(s).toHaveLength(24);
    expect(s[0].time).toBe("2026-09-15T05:00");
    expect(s[0].temp).toBe(5);
    expect(s[0].code).toBe(3);
    expect(s[0].feels).toBeNull(); // 缺列 → null
  });

  it("valueRange 加边距；恒定序列上下扩 1；全 null 回退 0..1", () => {
    expect(valueRange([10, 20], 0.1)).toEqual({ min: 9, max: 21 });
    expect(valueRange([5, 5])).toEqual({ min: 4, max: 6 });
    expect(valueRange([null, null])).toEqual({ min: 0, max: 1 });
  });

  it("polylinePath 等距 x、null 断线重新 M", () => {
    expect(polylinePath([0, 10], 100, 50, 0, 10)).toBe("M0.0,50.0 L100.0,0.0");
    expect(polylinePath([0, null, 10], 100, 50, 0, 10)).toBe("M0.0,50.0 M100.0,0.0");
    expect(polylinePath([], 100, 50, 0, 10)).toBe("");
    expect(polylinePath([5], 100, 50, 0, 10)).toBe("M50.0,25.0");
  });
});
