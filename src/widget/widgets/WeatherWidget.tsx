/**
 * 天气小组件：Open-Meteo 实况与逐小时/多日预报，磁盘缓存（lat/lon 槽位）
 * 优先展示、离线回退；城市经 geocode 解析，支持手动定位。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { AlarmClock, ChevronDown, CloudRain, CloudSun, RefreshCw, Sunrise, Sunset, WifiOff, X } from "lucide-react";
import { fetchIpGeo, readIpGeoCache } from "../../lib/ip-geo";
import { isAbortError } from "../../lib/retry";
import { isOnline, subscribeOnline, useOnline } from "../../lib/online-status";
import { useSettingsStore } from "../../store/settings-store";
import { useT } from "../../i18n-lite";
import { useDelayedUnmount } from "../../lib/anim";
import { animDurations } from "../../lib/durations";
import { useWidgetConfig } from "../widget-config";
import { sourceNotify } from "../../lib/notifications";
import { useSafeTimeout } from "../../lib/use-safe-timeout";
import { aqiLevel, fetchJsonShared, moodOf, weatherIcon, WEEKDAY_CN } from "./weather-shared";
import { markAlertNotified, readWeatherCache, weatherCacheSlot, writeWeatherCacheSlot } from "./weather-cache";
import {
  alertTimeMs,
  localTimeToMs,
  hourLabel,
  nextHourPrecip,
  summarizeNextHour,
  type PrecipSlot
} from "../weather-station-data";

type CurrentWeather = {
  temperature: number;
  weathercode: number;
  windspeed: number;
  apparent_temperature?: number;
};

type DailyForecast = {
  time: string[];
  weathercode: number[];
  temperature_2m_max: number[];
  temperature_2m_min: number[];
  sunrise?: string[];
  sunset?: string[];
};

type HourlyPoint = {
  time: string;
  temperature: number;
  weathercode: number;
  precip?: number;
};

/** Open-Meteo 天气预警（alerts 数组；无预警时为空）。 */
type WeatherAlert = {
  event: string;
  start: string;
  end: string;
  description?: string;
  severity?: string;
  headline?: string;
};

type OpenMeteoResponse = {
  current_weather?: { temperature: number; weathercode: number; windspeed: number };
  current?: { relative_humidity_2m?: number; apparent_temperature?: number };
  daily?: {
    time: string[];
    weathercode: number[];
    temperature_2m_max: number[];
    temperature_2m_min: number[];
    sunrise: string[];
    sunset: string[];
  };
  hourly?: { time: string[]; temperature_2m: number[]; weathercode: number[]; precipitation_probability?: number[] };
  /** §4.7 未来一小时降雨：15 分钟槽降水量（mm/15min）。 */
  minutely_15?: { time: string[]; precipitation: (number | null)[] };
  /** timezone=auto 时返回：所有时间串都是该城市本地时间（无偏移），需用它换算成 UTC 瞬时。 */
  utc_offset_seconds?: number;
  alerts?: WeatherAlert[];
};

/* 时间工具 / 图标映射 / AQI 分级已上移 weather-shared.ts 与 weather-station-data.ts（与 WeatherStation 沉浸页共用）。 */

/** Open-Meteo 空气质量接口（独立域名，仅 current 欧洲 AQI + UV 指数）。 */
type AirQualityResponse = {
  current?: { european_aqi?: number; uv_index?: number };
};

/** 离线缓存快照：按城市坐标落盘，断网时回退最近一次成功数据。 */
type WeatherSnapshot = {
  weather: CurrentWeather;
  forecast: DailyForecast | null;
  hourly: HourlyPoint[];
  humidity: number | null;
  alerts: WeatherAlert[];
  at: number;
  aqi?: number | null;
  uv?: number | null;
  /* 全天逐时（供逐日详情曲线；老缓存无此字段回退 hourly）。 */
  allHourly?: HourlyPoint[];
  /* §4.7 未来一小时降雨槽（拉取时刻换算好的 4×15min mm/h；老缓存无此字段 → 隐藏）。 */
  minutely?: PrecipSlot[];
  /* 拉取时刻的 utc_offset_seconds：缓存重放时预警生效窗口的换算依据（老缓存无 → 本机时区兜底）。 */
  utcOffset?: number;
};

/* 缓存槽读写走 weather-cache（WeatherMini 等只读方据此订阅刷新）。 */
const cacheSlot = weatherCacheSlot;
const readCache = () => readWeatherCache<WeatherSnapshot>();
const writeCache = (slot: string, snap: WeatherSnapshot): void => writeWeatherCacheSlot(slot, snap);

/* 天气多实例重复轮询/预警双推：
 *  - 同 URL 的在途请求跨实例合并 → fetchJsonShared（weather-shared，abort 解绑语义见其注释）；
 *  - 预警推送去重基线持久化在 localStorage（weather-cache markAlertNotified），
 *    同窗口多实例与多显示器多窗口都不再同一预警重复推送；key 含城市槽位，
 *    不同城市的同名同时预警各自有基线。 */
const alertKey = (slot: string, event: string, start: string) => `${slot}|${event}|${start}`;

/**
 * Weather widget backed by Open-Meteo (free, no API key). The city/coordinates
 * come from the settings ("连接" → 位置) so users can change the default city;
 * additional cities can be added there too and switched here.
 */
export function WeatherWidget({ instanceId }: { instanceId: string }) {
  const tr = useT();
  const safeTimeout = useSafeTimeout();
  const { config, update } = useWidgetConfig(instanceId);
  const [weather, setWeather] = useState<CurrentWeather | null>(null);
  const [forecast, setForecast] = useState<DailyForecast | null>(null);
  const [hourly, setHourly] = useState<HourlyPoint[]>([]);
  /* 全天逐时数据（详情曲线用），与 8 点显示条分离。 */
  const [allHourly, setAllHourly] = useState<HourlyPoint[]>([]);
  const [error, setError] = useState(false);
  const [stale, setStale] = useState(false);
  /* 城市选择持久化到组件配置，刷新/重启后不再回退主城市。 */
  const [cityIndex, setCityIndex] = useState(() => {
    const v = config.cityIndex;
    // useWidgetConfig 读的是原始值：手改/损坏配置里的 -5 / NaN 会让下面
    // cities[Math.min(idx, n-1)] 取到 undefined，整卡进错误边界。
    return typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : 0;
  });
  const [retryKey, setRetryKey] = useState(0);
  /* 手动刷新：请求在途时刷新图标旋转。 */
  const [refreshing, setRefreshing] = useState(false);
  /* 空气质量 + 紫外线。 */
  const [aqi, setAqi] = useState<number | null>(null);
  const [uv, setUv] = useState<number | null>(null);
  /* §4.7 未来一小时降雨（minutely_15 → 4 槽 mm/h；拉取/失败均静默降级为隐藏）。 */
  const [minutely, setMinutely] = useState<PrecipSlot[]>([]);
  /* 逐日详情展开层：展开的是 forecast 索引（0=今天）。 */
  const [openDay, setOpenDay] = useState<number | null>(null);
  /* 详情层退场：关闭后播 .is-closing 再卸载，期间以最后一次打开的天快照渲染。
     等待时长与 .widget-weather-daydetail.is-closing 的
     --dur-fx-fast 对齐（此前用 fxMs 多挂 50ms 空档）。 */
  const detailVisible = useDelayedUnmount(openDay != null, Math.round(animDurations().fxFastMs));
  const lastOpenDay = useRef<number | null>(openDay);
  if (openDay != null) lastOpenDay.current = openDay;
  const shownDay = openDay ?? lastOpenDay.current;
  const online = useOnline();
  const city = useSettingsStore((s) => s.extra.weatherCity);
  const lat = useSettingsStore((s) => s.extra.weatherLat);
  const lon = useSettingsStore((s) => s.extra.weatherLon);
  const extraCities = useSettingsStore((s) => s.extra.weatherCities);
  const unit = (config.unit as string) || "celsius";
  const showWindHumidity = config.showWindHumidity !== false;
  const showForecast = config.showForecast !== false;
  const showHourly = config.showHourly !== false;
  const showSunTimes = config.showSunTimes !== false;
  const showCity = config.showCity !== false;
  const showAqi = config.showAqi !== false;
  const alertNotify = config.alertNotify !== false;
  const refreshInterval = Math.max(5, (config.refreshInterval as number) || 30) * 60 * 1000;
  const [humidity, setHumidity] = useState<number | null>(null);
  const [alerts, setAlerts] = useState<WeatherAlert[]>([]);
  /* 拉取响应的 utc_offset_seconds：预警生效窗口按城市本地时间换算的依据。 */
  const [utcOffset, setUtcOffset] = useState<number | undefined>(undefined);
  const [showAlertDetail, setShowAlertDetail] = useState(false);

  const cities = useMemo(() => [{ name: city || "未知位置", lat, lon }, ...extraCities], [city, lat, lon, extraCities]);
  const active = cities[Math.min(cityIndex, cities.length - 1)];
  const activeLat = active.lat;
  const activeLon = active.lon;

  /* 附加城市在设置里删除后 cityIndex 可能超界：显示侧虽被 Math.min 钳制，
   * 但 chips 无高亮项、配置里也留着脏索引（下次重开仍指着已不存在的槽）。
   * 收缩时同步钳制并回写配置。 */
  useEffect(() => {
    const max = cities.length - 1;
    if (cityIndex > max) {
      setCityIndex(max);
      update({ cityIndex: max });
    }
  }, [cities.length, cityIndex, update]);

  // 轮询闭包持有 effect 创建时的旧 alertNotify/tr/aqi/uv——改"预警通知"
  // 开关或切语言后，下一次轮询仍读到旧值（首轮 aqi/uv 为 null 还会覆写缓存）。
  // 在 render 期同步的 ref 保活最新值，writeCache 与预警推送都读 ref：
  const alertNotifyRef = useRef(alertNotify);
  const trRef = useRef(tr);
  const aqiRef = useRef(aqi);
  const uvRef = useRef(uv);
  alertNotifyRef.current = alertNotify;
  trRef.current = tr;
  aqiRef.current = aqi;
  uvRef.current = uv;

  /* §4.7 IP 自动定位（默认关，隐私 opt-in）：启动与手动刷新时，若开启且 24h
     缓存已过期则向 ipwho.is 补一次定位；成功回填主城市坐标——activeLat/activeLon
     变化会让下方 effect 按新坐标重拉天气。缓存有效期内不动坐标（用户手动改
     过的城市不会被反复覆盖回去）；离线 / 失败返回 null，现有坐标原样保留。 */
  const weatherAutoLocate = useSettingsStore((s) => s.extra.weatherAutoLocate);
  useEffect(() => {
    if (!weatherAutoLocate || readIpGeoCache()) return;
    const controller = new AbortController();
    void fetchIpGeo({ signal: controller.signal }).then((geo) => {
      if (!geo || controller.signal.aborted) return;
      const { extra, setExtra } = useSettingsStore.getState();
      if (extra.weatherCity === geo.city && extra.weatherLat === geo.lat && extra.weatherLon === geo.lon) return;
      setExtra({ weatherCity: geo.city, weatherLat: geo.lat, weatherLon: geo.lon });
    });
    return () => controller.abort();
  }, [weatherAutoLocate, retryKey]);

  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;
    const slot = cacheSlot(activeLat, activeLon);
    const cached = readCache()[slot];
    if (cached) {
      setWeather(cached.weather);
      setForecast(cached.forecast);
      setHourly(cached.hourly);
      setAllHourly(cached.allHourly ?? []);
      setHumidity(cached.humidity);
      setAlerts(cached.alerts ?? []);
      setAqi(cached.aqi ?? null);
      setUv(cached.uv ?? null);
      setMinutely(cached.minutely ?? []);
      setUtcOffset(cached.utcOffset);
      setStale(true);
    } else {
      setWeather(null);
      setForecast(null);
      setHourly([]);
      setAllHourly([]);
      setHumidity(null);
      setAlerts([]);
      setAqi(null);
      setUv(null);
      setMinutely([]);
      setUtcOffset(undefined);
      setStale(false);
    }
    /* 缓存里的预警视为已处理（含他窗已推过的），进基线避免重挂载/换城后再推。 */
    for (const a of cached?.alerts ?? []) markAlertNotified(alertKey(slot, a.event, a.start));
    const load = () => {
      if (!isOnline()) {
        if (!readCache()[slot]) setError(true);
        return;
      }
      setRefreshing(true);
      const url = `https://api.open-meteo.com/v1/forecast?latitude=${activeLat}&longitude=${activeLon}&current_weather=true&current=relative_humidity_2m,apparent_temperature&hourly=temperature_2m,weathercode,precipitation_probability&daily=weathercode,temperature_2m_max,temperature_2m_min,sunrise,sunset&minutely_15=precipitation&timezone=auto&forecast_days=5&alerts=true`;
      fetchJsonShared<OpenMeteoResponse>(url, { retries: 2, signal: controller.signal })
        .then((data) => {
          if (cancelled || controller.signal.aborted) return;
          /* 本轮主快照写入时刻：AQI 回写只并入「仍属于本轮」的缓存（见下）。 */
          let mainAt = 0;
          if (data?.current_weather) {
            const nextWeather: CurrentWeather = {
              temperature: data.current_weather.temperature,
              weathercode: data.current_weather.weathercode,
              windspeed: data.current_weather.windspeed,
              apparent_temperature: data.current?.apparent_temperature
            };
            const nextHumidity = data.current?.relative_humidity_2m ?? null;
            let nextForecast: DailyForecast | null = null;
            if (data?.daily?.time) {
              nextForecast = {
                time: data.daily.time,
                weathercode: data.daily.weathercode,
                temperature_2m_max: data.daily.temperature_2m_max,
                temperature_2m_min: data.daily.temperature_2m_min,
                sunrise: data.daily.sunrise,
                sunset: data.daily.sunset
              };
            }
            let nextHourly: HourlyPoint[] = [];
            let nextAllHourly: HourlyPoint[] = [];
            if (Array.isArray(data?.hourly?.time)) {
              const nowMs = Date.now();
              const temps = data.hourly.temperature_2m as number[];
              const codes = data.hourly.weathercode as number[];
              const prec = (data.hourly.precipitation_probability ?? []) as number[];
              const times = data.hourly.time as string[];
              nextAllHourly = times.map((t, i) => ({
                time: t,
                temperature: temps[i],
                weathercode: codes[i],
                precip: prec[i]
              }));
              const from = times.findIndex((t) => localTimeToMs(t, data.utc_offset_seconds) >= nowMs);
              const start = from < 0 ? 0 : from;
              nextHourly = nextAllHourly.slice(start, start + 8);
            }
            const nextMinutely = nextHourPrecip(data.minutely_15, Date.now(), data.utc_offset_seconds);
            setWeather(nextWeather);
            setForecast(nextForecast);
            setHourly(nextHourly);
            setAllHourly(nextAllHourly);
            setMinutely(nextMinutely);
            setHumidity(nextHumidity);
            const nextAlerts = Array.isArray(data.alerts) ? data.alerts : [];
            setAlerts(nextAlerts);
            setUtcOffset(typeof data.utc_offset_seconds === "number" ? data.utc_offset_seconds : undefined);
            setError(false);
            setStale(false);
            mainAt = Date.now();
            writeCache(slot, {
              weather: nextWeather,
              forecast: nextForecast,
              hourly: nextHourly,
              allHourly: nextAllHourly,
              humidity: nextHumidity,
              alerts: nextAlerts,
              at: mainAt,
              aqi: aqiRef.current,
              uv: uvRef.current,
              minutely: nextMinutely,
              utcOffset: typeof data.utc_offset_seconds === "number" ? data.utc_offset_seconds : undefined
            });
            /* 记住本轮主快照时间：AQI 回写只并入「仍属于本轮」的缓存——期间
               沉浸页/他窗若已刷出更新的快照（at > mainAt），不再把本轮 AQI 盖
               上去（非原子回写竞态，对方有自己的 AQI 跟进）。 */
            /* 新预警推送：只推「首次出现且生效中」的预警。生效窗口用
               alertTimeMs 换算（timezone=auto 的无偏移本地时间 + 跨时区城市），
               解析失败的端点按「已开始 / 未结束」处理——预警宁推勿漏。 */
            const nowT = Date.now();
            for (const a of nextAlerts) {
              if (!markAlertNotified(alertKey(slot, a.event, a.start))) continue;
              const end = a.end ? alertTimeMs(a.end, data.utc_offset_seconds) : NaN;
              const startMs = a.start ? alertTimeMs(a.start, data.utc_offset_seconds) : NaN;
              const startOk = !Number.isFinite(startMs) || startMs <= nowT;
              const notEnded = !a.end || !Number.isFinite(end) || end > nowT;
              if (startOk && notEnded && alertNotifyRef.current) {
                void sourceNotify(
                  "weather",
                  `${trRef.current("天气预警")} · ${active.name}`,
                  a.headline || a.event || ""
                );
              }
            }
          }
          setRefreshing(false);
          /* 空气质量第二请求：失败静默（面板隐藏该行即可）。 */
          const aqUrl = `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${activeLat}&longitude=${activeLon}&current=european_aqi,uv_index&timezone=auto`;
          return fetchJsonShared<AirQualityResponse>(aqUrl, { retries: 1, signal: controller.signal })
            .then((aq) => {
              if (cancelled || controller.signal.aborted) return;
              const na = aq?.current?.european_aqi ?? null;
              const nu = aq?.current?.uv_index ?? null;
              setAqi(na);
              setUv(nu);
              const snap = readCache()[slot];
              if (snap && mainAt > 0 && snap.at <= mainAt) writeCache(slot, { ...snap, aqi: na, uv: nu });
            })
            .catch(() => {});
        })
        .catch((err) => {
          if (cancelled || isAbortError(err)) return;
          setRefreshing(false);
          if (!readCache()[slot]) setError(true);
        });
    };
    load();
    // Self-scheduling timeout chain so a slow network fetch never overlaps the
    // next one (avoids a stale response clobbering a fresher snapshot).
    let timer = 0;
    const schedule = () => {
      timer = window.setTimeout(() => {
        load();
        if (!cancelled) schedule();
      }, refreshInterval);
    };
    schedule();
    const unsubOnline = subscribeOnline((online) => {
      if (online && !cancelled) load();
    });
    return () => {
      cancelled = true;
      controller.abort();
      window.clearTimeout(timer);
      unsubOnline();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeLat, activeLon, retryKey, refreshInterval]);

  const Icon = weather ? weatherIcon(weather.weathercode) : CloudSun;

  const unitLabel = unit === "fahrenheit" ? "°F" : "°C";
  const fmtTemp = (c: number) => {
    if (!Number.isFinite(c)) return "—";
    const v = unit === "fahrenheit" ? (c * 9) / 5 + 32 : c;
    return `${Math.round(v)}°`;
  };
  /* 风速在显示层换算 mph（华氏口径用户惯例）：缓存里恒存 km/h，切换单位后
   * 旧缓存不会带错单位标签（请求层换算做不到这一点）。 */
  const fmtWind = (kmh: number) =>
    unit === "fahrenheit"
      ? tr("风速 {n} mph", { n: (kmh / 1.609344).toFixed(0) })
      : tr("风速 {n} km/h", { n: kmh.toFixed(0) });
  const clockFmt = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", hour12: false });
  const fmtClock = (iso?: string) => {
    if (!iso) return "";
    const d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    return clockFmt.format(d);
  };

  const forecastDays = showForecast && forecast ? forecast.time.slice(1, 5) : [];

  const forecastCode = (i: number): number => forecast?.weathercode?.[i] ?? 0;
  const forecastMax = (i: number): number => forecast?.temperature_2m_max?.[i] ?? NaN;
  const forecastMin = (i: number): number => forecast?.temperature_2m_min?.[i] ?? NaN;

  const feels = weather?.apparent_temperature;
  const sunrise = showSunTimes ? forecast?.sunrise?.[0] : undefined;
  const sunset = showSunTimes ? forecast?.sunset?.[0] : undefined;

  const nowMs = Date.now();
  const activeAlert = alerts.find((a) => {
    if (!a.end) return true;
    /* 生效窗口按城市本地时间换算（alertTimeMs）；解析失败的串按未结束处理
       （横幅宁多勿漏——与推送口径一致）。 */
    const end = alertTimeMs(a.end, utcOffset);
    return !Number.isFinite(end) || end > nowMs;
  });

  /* §4.7 未来一小时降雨摘要（无槽数据 → null，条隐藏）。 */
  const minutelySummary = minutely.length > 0 ? summarizeNextHour(minutely) : null;

  /* 动态背景色调：晴天暖 / 雨天冷 / 雪天亮蓝 / 雷暴偏紫。 */
  const mood = weather ? moodOf(weather.weathercode) : "cloudy";
  /* mood 交叉淡化：radial-gradient 之间 background 不可插值（transition 无效），
     双 overlay——旧 mood 层播 opacity 淡出，新层淡入。 */
  const [moodLayers, setMoodLayers] = useState<{ cur: string; prev: string | null }>({ cur: mood, prev: null });
  useEffect(() => {
    setMoodLayers((s) => (s.cur === mood ? s : { cur: mood, prev: s.cur }));
  }, [mood]);
  useEffect(() => {
    if (!moodLayers.prev) return;
    safeTimeout(() => setMoodLayers((s) => ({ ...s, prev: null })), 1300);
  }, [moodLayers.prev, safeTimeout]);

  /* 逐日详情：某天（forecast 索引）的 24h 温度曲线 + 降水概率。 */
  const dayDetail = (idx: number) => {
    const day = forecast?.time?.[idx];
    if (!day) return null;
    const use = allHourly.filter((h) => h.time.startsWith(day));
    if (use.length < 2) return null;
    const temps = use.map((p) => p.temperature);
    const min = Math.min(...temps);
    const max = Math.max(...temps);
    const w = 100;
    const h = 26;
    const path = use
      .map((p, i) => {
        const x = (i / (use.length - 1)) * w;
        const y = h - ((p.temperature - min) / Math.max(0.1, max - min)) * h;
        return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(" ");
    const precs = use.map((p) => p.precip ?? 0);
    const maxPrec = Math.max(...precs, 1);
    return { use, path, min, max, precs, maxPrec, w, h };
  };

  return (
    <div className={`widget-weather mood-${mood}`} key={cityIndex}>
      {/* 氛围光双层交叉淡化（见 moodLayers 注释）。 */}
      {moodLayers.prev && <div className={`weather-mood leaving mood-${moodLayers.prev}`} aria-hidden="true" />}
      <div className={`weather-mood on mood-${moodLayers.cur}`} aria-hidden="true" />
      {/* [POLISH] 等待指示规范：首拉取走覆盖层（docs/ui-guidelines.md）——
          绝对定位不占布局，骨架内容（温度 —）保持稳定不跳动；手动刷新时
          已有内容原地保留，仅刷新按钮旋转，同样不引起布局变化。 */}
      {refreshing && !weather && (
        <div className="widget-busy-veil" role="status" aria-label={tr("加载中…")}>
          <span className="widget-busy-spinner" aria-hidden="true" />
          {tr("加载中…")}
        </div>
      )}
      {/* 手动刷新按钮：右上角悬停出现，刷新中旋转。 */}
      <button
        className={`widget-weather-refresh${refreshing ? " spinning" : ""}`}
        onClick={(e) => {
          e.stopPropagation();
          setRetryKey((k) => k + 1);
        }}
        title={tr("刷新")}
        aria-label={tr("刷新")}
        data-interactive
      >
        <RefreshCw size={12} />
      </button>
      {/* 天气预警横幅：有生效中预警时优先展示，可点击展开详情 */}
      {activeAlert && (
        <div
          className={`widget-weather-alert${showAlertDetail ? " open" : ""}`}
          role="button"
          tabIndex={0}
          aria-expanded={showAlertDetail}
          aria-live="polite"
          onClick={() => setShowAlertDetail((v) => !v)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              setShowAlertDetail((v) => !v);
            }
          }}
          data-interactive
        >
          <span className="widget-weather-alert-icon">
            <AlarmClock size={13} />
          </span>
          <span className="widget-weather-alert-text">{activeAlert.event || tr("天气预警")}</span>
          {/* 几何字符 ▾/▸ 换 lucide 旋转箭头（随主题着色、跨平台一致）。 */}
          <span className={`widget-weather-alert-toggle${showAlertDetail ? " open" : ""}`}>
            <ChevronDown size={13} />
          </span>
          {activeAlert.description && (
            <div className={`widget-weather-alert-desc${showAlertDetail ? " open" : ""}`}>
              <div className="widget-weather-alert-desc-inner">{activeAlert.description}</div>
            </div>
          )}
        </div>
      )}
      {/* 多城市切换：附加城市存在时显示 chips（选择写入配置持久化） */}
      {cities.length > 1 && (
        <div className="widget-weather-cities" role="tablist" aria-label={tr("切换城市")}>
          {cities.map((c, i) => (
            <button
              key={`${c.name}-${i}`}
              role="tab"
              aria-selected={i === cityIndex}
              className={`widget-weather-city${i === cityIndex ? " active" : ""}`}
              onClick={() => {
                setCityIndex(i);
                update({ cityIndex: i });
              }}
              data-interactive
            >
              {tr(c.name)}
            </button>
          ))}
        </div>
      )}
      <div className="widget-weather-icon">
        <Icon size={34} />
      </div>
      <div className="widget-weather-main">
        <div className="widget-weather-temp" key={weather ? weather.temperature : -999}>
          {/* 首载骨架条替代「—」硬替换：错误/离线仍显示占位符与重试。 */}
          {weather ? (
            fmtTemp(weather.temperature)
          ) : error ? (
            "—"
          ) : (
            <span className="widget-skeleton widget-weather-temp-sk" aria-busy="true" />
          )}
        </div>
        <div className="widget-weather-unit">{weather ? unitLabel : ""}</div>
      </div>
      <div className="widget-weather-note">
        {error && !online ? (
          <span className="widget-weather-offline">
            <WifiOff size={11} /> {tr("当前离线，联网后自动更新")}
          </span>
        ) : error ? (
          <button
            className="widget-weather-retry"
            onClick={() => setRetryKey((k) => k + 1)}
            data-interactive
            aria-label={tr("重试加载天气")}
          >
            <RefreshCw size={11} /> {tr("加载失败，重试")}
          </button>
        ) : weather ? (
          <span>
            {showCity && `${tr(active.name)}`}
            {stale && ` · ${tr("离线缓存")}`}
            {feels != null && Number.isFinite(feels) && ` · ${tr("体感 {t}", { t: fmtTemp(feels) })}`}
            {showWindHumidity && Number.isFinite(weather.windspeed) && ` · ${fmtWind(weather.windspeed)}`}
            {showWindHumidity && humidity != null && " · "}
            {showWindHumidity && humidity != null && tr("湿度 {n}%", { n: humidity })}
            {!showWindHumidity && !showCity && feels == null && tr("已更新")}
          </span>
        ) : null}
      </div>

      {/* 空气质量 + 紫外线行 */}
      {showAqi && weather && (aqi != null || uv != null) && (
        <div className="widget-weather-aqi">
          {aqi != null && (
            <span className="aqi-item">
              <span className="aqi-dot" style={{ background: aqiLevel(aqi).color }} />
              {tr("空气质量")} {Math.round(aqi)} · {tr(aqiLevel(aqi).label)}
            </span>
          )}
          {uv != null && (
            <span className="aqi-item">
              {tr("紫外线")} {Math.round(uv)}
            </span>
          )}
        </div>
      )}

      {/* §4.7 未来一小时降雨：minutely_15 有雨时才占位（无雨/老缓存/拉取失败均隐藏降级）。
          样式内联：widget.css 归 DS 会话管，卡片内新 UI 不落全局样式表。 */}
      {weather && minutelySummary && minutelySummary.kind !== "none" && (
        <div
          className="widget-weather-minutely"
          role="img"
          aria-label={tr("未来一小时降雨")}
          data-interactive
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "5px 10px",
            borderRadius: "var(--radius-ctl, 8px)",
            border: "1px solid color-mix(in srgb, var(--accent-2) 40%, transparent)",
            background: "color-mix(in srgb, var(--accent-2) 12%, transparent)",
            fontSize: 11.5
          }}
        >
          <CloudRain size={13} style={{ flex: "0 0 auto", color: "var(--accent-2)" }} />
          <span style={{ flex: "0 0 auto", fontWeight: 600 }}>{tr("未来一小时降雨")}</span>
          <span style={{ display: "flex", alignItems: "flex-end", gap: 2, height: 14, flex: "0 0 auto" }}>
            {minutely.map((slot) => (
              <i
                key={slot.time}
                aria-hidden="true"
                style={{
                  display: "block",
                  width: 5,
                  height: `${Math.max(15, Math.min(100, (slot.mmPerHour / 10) * 100))}%`,
                  minHeight: 2,
                  borderRadius: 2,
                  background: slot.mmPerHour >= 2.5 ? "var(--accent)" : "var(--accent-2)",
                  opacity: slot.mmPerHour >= 0.1 ? 1 : 0.3
                }}
              />
            ))}
          </span>
          <span
            style={{
              flex: "1 1 auto",
              textAlign: "right",
              color: "var(--muted)",
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis"
            }}
          >
            {minutelySummary.startsInMin === 0 ? tr("正在下雨") : `${minutelySummary.startsInMin} ${tr("分钟后有雨")}`}
            {" · "}
            {minutelySummary.totalMm.toFixed(1)} mm
          </span>
        </div>
      )}

      {/* 今日日出 / 日落 */}
      {(sunrise || sunset) && (
        <div className="widget-weather-sun">
          <span className="sun-item">
            <Sunrise size={13} /> {tr("日出")} {fmtClock(sunrise)}
          </span>
          <span className="sun-item">
            <Sunset size={13} /> {tr("日落")} {fmtClock(sunset)}
          </span>
        </div>
      )}

      {/* 逐时预报：当前时刻起 8 小时温度条 */}
      {showHourly && hourly.length > 0 && (
        <div className="widget-weather-hourly">
          {hourly.map((h, i) => {
            const HIcon = weatherIcon(h.weathercode);
            return (
              <div className="widget-weather-hour" key={h.time} style={{ ["--sti" as string]: i }}>
                <span className="widget-weather-hour-name">{i === 0 ? tr("现在") : hourLabel(h.time)}</span>
                <HIcon size={13} />
                <span className="widget-weather-hour-temp">{fmtTemp(h.temperature)}</span>
              </div>
            );
          })}
        </div>
      )}

      {/* 未来预报：未来 4 天，图标 + 最高/最低温（点击展开当日详情） */}
      {forecastDays.length > 0 && forecast && (
        <div className="widget-weather-forecast">
          {forecastDays.map((day, i) => {
            const code = forecastCode(i + 1);
            const FIcon = weatherIcon(code);
            const date = new Date(forecast.time[i + 1] + "T00:00:00");
            const detail = dayDetail(i + 1);
            return (
              <div
                className={`widget-weather-day${openDay === i + 1 ? " open" : ""}${detail ? " clickable" : ""}`}
                key={day}
                style={{ ["--sti" as string]: i }}
                onClick={() => detail && setOpenDay((v) => (v === i + 1 ? null : i + 1))}
                role={detail ? "button" : undefined}
                tabIndex={detail ? 0 : undefined}
                aria-expanded={detail ? openDay === i + 1 : undefined}
                onKeyDown={(e) => {
                  if (detail && (e.key === "Enter" || e.key === " ")) {
                    e.preventDefault();
                    setOpenDay((v) => (v === i + 1 ? null : i + 1));
                  }
                }}
                data-interactive={!!detail}
              >
                <span className="widget-weather-day-name">
                  {Number.isNaN(date.getTime()) ? "" : tr(WEEKDAY_CN[date.getDay()])}
                </span>
                <FIcon size={14} />
                <span className="widget-weather-day-temp">
                  {fmtTemp(forecastMax(i + 1))} <span className="lo">/ {fmtTemp(forecastMin(i + 1))}</span>
                </span>
              </div>
            );
          })}
        </div>
      )}

      {/* 当日详情层：温度曲线 + 逐时降水概率。key=openDay 切换天时重挂
          重播曲线 draw；关闭播 .is-closing 淡出（useDelayedUnmount + 快照），
          不再瞬消/整层瞬换。 */}
      {detailVisible && shownDay != null && dayDetail(shownDay) && forecast && (
        <div className={`widget-weather-daydetail${openDay == null ? " is-closing" : ""}`} key={shownDay}>
          <div className="daydetail-head">
            <span>{forecast.time[shownDay]}</span>
            <span>
              {fmtTemp(forecastMin(shownDay))} ~ {fmtTemp(forecastMax(shownDay))}
            </span>
            <button
              className="daydetail-close"
              onClick={() => setOpenDay(null)}
              aria-label={tr("关闭")}
              data-interactive
            >
              <X size={14} />
            </button>
          </div>
          {(() => {
            const d = dayDetail(shownDay)!;
            return (
              <>
                <svg
                  className="daydetail-curve"
                  viewBox={`0 0 ${d.w} ${d.h}`}
                  preserveAspectRatio="none"
                  aria-hidden="true"
                >
                  <path
                    className="daydetail-curve-path"
                    d={d.path}
                    fill="none"
                    stroke="var(--accent)"
                    strokeWidth="1.6"
                    vectorEffect="non-scaling-stroke"
                    pathLength={1}
                  />
                </svg>
                <div className="daydetail-hours">
                  {/* 一天最多 24 点，均匀抽样至 ≤8 列保持可读。 */}
                  {d.use
                    .filter((_, i2) => i2 % Math.max(1, Math.ceil(d.use.length / 8)) === 0)
                    .map((p) => {
                      return (
                        <div className="daydetail-hour" key={p.time}>
                          <span className="dh-t">{hourLabel(p.time)}</span>
                          <span className="dh-temp">{fmtTemp(p.temperature)}</span>
                          <span className="dh-prec">{p.precip != null ? `${p.precip}%` : ""}</span>
                        </div>
                      );
                    })}
                </div>
              </>
            );
          })()}
        </div>
      )}
    </div>
  );
}
