/**
 * 天气迷你磁贴（ISLAND-MINI）：weatherIcon(code) + 温度。
 * 读 WeatherWidget / 天气站落盘的共享缓存槽（weather-cache：localStorage
 * focus-desk.weather.cache.v1，slot = lat/lon 各取三位小数）：有绑定实例时按该实例
 * 配置的 cityIndex / unit 取城市；无实例读 settings extra.weatherCity/Lat/Lon（主城市）。
 *
 * 兜底拉取：槽位缺失或超过 STALE_MS 未更新时自己拉一次 current_weather 写回槽位。
 * 灵动岛里经类型选择器加入的天气磁贴没有绑定实例，桌面上又未必有天气卡片在维护
 * 缓存——此前这种磁贴永远显示「—」，只有点开天气站才有温度。卡片在（默认 30min
 * 刷新）时槽位不会过期，磁贴不会重复请求（F-10）；按槽位去重、失败后至少隔
 * RETRY_MS 再试，多枚磁贴 / 多次重渲染不放大请求。接管期（active=false）不拉取。
 *
 * 刷新：经 useSyncExternalStore 订阅 subscribeWeatherCache——卡片 / 天气站 / 本磁贴
 * 在任一窗口写槽时同步更新。快照是原始字符串，按值比较，缓存未变不重渲。
 */
import { useEffect, useMemo, useSyncExternalStore } from "react";
import { CloudSun } from "lucide-react";
import { fetchJson } from "../../../lib/network";
import { isOnline, useOnline } from "../../../lib/online-status";
import { useSettingsStore } from "../../../store/settings-store";
import { useWidgetConfig } from "../../widget-config";
import {
  subscribeWeatherCache,
  weatherCacheSlot,
  weatherCacheSnapshot,
  writeCurrentWeatherSlot
} from "../weather-cache";
import { weatherIcon } from "../weather-shared";
import type { MiniComponentProps } from "../../registry";

type CachedCurrent = { temperature: number; weathercode: number };
type CachedSlot = { weather: CachedCurrent | null; at: number };

/** 槽位超过此时长未更新视为过期（卡片默认 30min 刷新，正常情况下轮不到磁贴自己拉）。 */
const STALE_MS = 60 * 60 * 1000;
/** 同一槽位两次兜底拉取的最小间隔（含失败），防止接口异常时反复请求。 */
const RETRY_MS = 5 * 60 * 1000;
/** 过期复查周期。 */
const CHECK_MS = 60 * 1000;

const inflight = new Set<string>();
const lastAttempt = new Map<string, number>();

function readCachedSlot(raw: string, lat: number, lon: number): CachedSlot {
  if (!raw) return { weather: null, at: 0 };
  try {
    const all = JSON.parse(raw) as Record<string, { weather?: CachedCurrent; at?: number }>;
    const slot = all[weatherCacheSlot(lat, lon)];
    return { weather: slot?.weather ?? null, at: typeof slot?.at === "number" ? slot.at : 0 };
  } catch {
    return { weather: null, at: 0 };
  }
}

/** 兜底拉取一次当前天气并写回槽位（按槽位去重 + 最小重试间隔）。 */
function ensureCurrentWeather(lat: number, lon: number): void {
  const slot = weatherCacheSlot(lat, lon);
  if (inflight.has(slot)) return;
  const now = Date.now();
  if (now - (lastAttempt.get(slot) ?? 0) < RETRY_MS) return;
  lastAttempt.set(slot, now);
  inflight.add(slot);
  fetchJson<{ current_weather?: { temperature?: number; weathercode?: number; windspeed?: number } }>(
    `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current_weather=true&timezone=auto`,
    { retries: 1 }
  )
    .then((d) => {
      const cw = d?.current_weather;
      if (cw && typeof cw.temperature === "number") {
        writeCurrentWeatherSlot(lat, lon, {
          temperature: cw.temperature,
          weathercode: cw.weathercode ?? 0,
          windspeed: cw.windspeed ?? 0
        });
      }
    })
    .catch(() => {})
    .finally(() => {
      inflight.delete(slot);
    });
}

export function WeatherMini({ instanceId, active }: MiniComponentProps) {
  const { config } = useWidgetConfig(instanceId ?? "");
  const city = useSettingsStore((s) => s.extra.weatherCity);
  const lat = useSettingsStore((s) => s.extra.weatherLat);
  const lon = useSettingsStore((s) => s.extra.weatherLon);
  const extraCities = useSettingsStore((s) => s.extra.weatherCities);
  const cities = useMemo(() => [{ name: city, lat, lon }, ...extraCities], [city, lat, lon, extraCities]);
  const idx = instanceId && typeof config.cityIndex === "number" ? config.cityIndex : 0;
  const target = cities[Math.max(0, Math.min(idx, cities.length - 1))];
  const raw = useSyncExternalStore(subscribeWeatherCache, weatherCacheSnapshot, weatherCacheSnapshot);
  const cached = useMemo(() => readCachedSlot(raw, target.lat, target.lon), [raw, target.lat, target.lon]);
  const weather = cached.weather;
  const online = useOnline();

  useEffect(() => {
    if (!active || !online) return;
    const { lat: tLat, lon: tLon } = target;
    const check = () => {
      const { weather: w, at } = readCachedSlot(weatherCacheSnapshot(), tLat, tLon);
      const fresh = !!w && Number.isFinite(w.temperature) && Date.now() - at < STALE_MS;
      if (!fresh && isOnline()) ensureCurrentWeather(tLat, tLon);
    };
    check();
    const id = window.setInterval(check, CHECK_MS);
    return () => window.clearInterval(id);
  }, [active, online, target]);

  const fahrenheit = !!instanceId && config.unit === "fahrenheit";
  const Icon = weather ? weatherIcon(weather.weathercode) : CloudSun;
  const temp =
    weather && Number.isFinite(weather.temperature)
      ? `${Math.round(fahrenheit ? (weather.temperature * 9) / 5 + 32 : weather.temperature)}°`
      : "—";

  return (
    <span className="dock-mini dock-mini-weather">
      <Icon size={14} className="dock-mini-ico" />
      <span className="dock-mini-num">{temp}</span>
    </span>
  );
}
