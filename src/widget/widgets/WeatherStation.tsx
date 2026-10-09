/**
 * 天气站（天气沉浸页，§4.7 + 图表体系）：24h 多指标折线 + 「今日 vs
 * 历史同期」气候常模参考线（Open-Meteo archive）+ minutely_15「未来一小时
 * 降雨」条 + 空气质量/日出日落。
 *
 * 契约：registry `ExpandedComponent` 挂到天气卡片；active=false 保持挂载
 * 但暂停全部网络轮询（快照留存）。城市随实例配置（cityIndex）与设置中的
 * 城市列表联动，与卡片同源。
 *
 * 降级：预报 / 常模 / 空气质量三路数据各自带加载与失败态，互不拖累
 * （验收要求：新数据字段有加载/失败降级）。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { CloudSun, Droplets, RefreshCw, Sunrise, Sunset, Thermometer } from "lucide-react";
import { isAbortError } from "../../lib/retry";
import { fetchJsonShared } from "./weather-shared";
import { useOnline } from "../../lib/online-status";
import { useSettingsStore } from "../../store/settings-store";
import { useT } from "../../i18n-lite";
import { useWidgetConfig } from "../widget-config";
import { writeCurrentWeatherSlot } from "./weather-cache";
import type { ExpandedComponentProps } from "../expand-store";
import {
  loadClimateNormals,
  nextHourPrecip,
  normalForDate,
  polylinePath,
  sliceNext24h,
  summarizeNextHour,
  valueRange,
  yFor,
  type ClimateNormals,
  type DailyNormal,
  type HourlyMetric,
  type PrecipSlot
} from "../weather-station-data";
import { aqiLevel, weatherIcon } from "./weather-shared";
/* 样式（ws-*）由 WidgetExpandOverlay 统一引入 feature-immersive.css——沉浸组件只在遮罩内渲染。 */

type ForecastResponse = {
  current_weather?: { temperature: number; weathercode: number; windspeed: number };
  current?: { relative_humidity_2m?: number; apparent_temperature?: number };
  hourly?: {
    time: string[];
    temperature_2m: (number | null)[];
    apparent_temperature: (number | null)[];
    precipitation_probability?: (number | null)[];
    precipitation?: (number | null)[];
    relative_humidity_2m?: (number | null)[];
    wind_speed_10m?: (number | null)[];
    weather_code?: (number | null)[];
  };
  daily?: {
    time: string[];
    temperature_2m_max: number[];
    temperature_2m_min: number[];
    sunrise: string[];
    sunset: string[];
  };
  minutely_15?: { time: string[]; precipitation: (number | null)[] };
  utc_offset_seconds?: number;
};

type AirQualityResponse = { current?: { european_aqi?: number; uv_index?: number } };

/** 面板快照：一次 forecast 请求的全部沉浸页数据。 */
type StationSnapshot = {
  temp: number | null;
  code: number;
  wind: number | null;
  feels: number | null;
  humidity: number | null;
  hourly: HourlyMetric[];
  todayMax: number | null;
  todayMin: number | null;
  sunrise?: string;
  sunset?: string;
  precipSlots: PrecipSlot[];
};

const FORECAST_URL = "https://api.open-meteo.com/v1/forecast";
const AQI_URL = "https://air-quality-api.open-meteo.com/v1/air-quality";
/** 沉浸页刷新间隔（15min，卡片默认 30min——展开会话看得更细，收起即停）。 */
const REFRESH_MS = 15 * 60 * 1000;

type LoadState = "idle" | "loading" | "ok" | "error";

export function WeatherStation({ instanceId, active }: ExpandedComponentProps) {
  const tr = useT();
  const online = useOnline();
  const { config } = useWidgetConfig(instanceId);
  const unit = (config.unit as string) || "celsius";
  const cityIndex = typeof config.cityIndex === "number" ? config.cityIndex : 0;

  const city = useSettingsStore((s) => s.extra.weatherCity);
  const lat = useSettingsStore((s) => s.extra.weatherLat);
  const lon = useSettingsStore((s) => s.extra.weatherLon);
  const extraCities = useSettingsStore((s) => s.extra.weatherCities);
  const cities = useMemo(() => [{ name: city || "未知位置", lat, lon }, ...extraCities], [city, lat, lon, extraCities]);
  // cityIndex 双向钳制 + 非整数回退（手改/损坏配置里的 -5 / 2.5 会让
  // cities[...] 取 undefined，整站进错误边界——卡片侧 WeatherWidget 同款守卫）。
  const activeCity =
    cities[Number.isInteger(cityIndex) && cityIndex >= 0 ? Math.min(cityIndex, cities.length - 1) : 0] ?? cities[0];

  const [snap, setSnap] = useState<StationSnapshot | null>(null);
  const [snapState, setSnapState] = useState<LoadState>("idle");
  const [normals, setNormals] = useState<ClimateNormals | null>(null);
  const [normalsState, setNormalsState] = useState<LoadState>("idle");
  const [aqi, setAqi] = useState<number | null>(null);
  const [uv, setUv] = useState<number | null>(null);
  /* 指标开关：温度恒显；体感/降水/湿度/风可点选。 */
  const [metrics, setMetrics] = useState({ feels: true, precip: true, humidity: false, wind: false });
  /* 手动重试：自增后两个拉取 effect 重跑。 */
  const [reloadKey, setReloadKey] = useState(0);

  /* 双拉取各自持有代际号（防止两 effect 共用一个 seq 互相失效）；回调里
     校验代际，旧代际的迟到响应直接丢弃（AbortController 只能打断在途请求）。 */
  const forecastSeq = useRef(0);
  const normalsSeq = useRef(0);

  /* 预报主请求 + 空气质量：active 时拉取并按 REFRESH_MS 续期；城市切换或
     重试重拉。收起（active=false）停止续期，快照留存。 */
  useEffect(() => {
    if (!active) return;
    const seq = ++forecastSeq.current;
    const controller = new AbortController();
    let timer = 0;
    const load = () => {
      if (forecastSeq.current !== seq) return;
      setSnapState((s) => (snap ? s : "loading"));
      const url =
        `${FORECAST_URL}?latitude=${activeCity.lat}&longitude=${activeCity.lon}` +
        `&current_weather=true&current=relative_humidity_2m,apparent_temperature` +
        `&hourly=temperature_2m,apparent_temperature,precipitation_probability,precipitation,relative_humidity_2m,wind_speed_10m,weather_code` +
        `&daily=temperature_2m_max,temperature_2m_min,sunrise,sunset` +
        `&minutely_15=precipitation&timezone=auto&forecast_days=2`;
      /* 与卡片共享在途请求（fetchJsonShared）：展开瞬间的拉取若与卡片轮询
         重叠，同 URL 只发一次；卡片先发起则站点直接复用其结果。 */
      fetchJsonShared<ForecastResponse>(url, { retries: 2, signal: controller.signal })
        .then((d) => {
          if (forecastSeq.current !== seq || controller.signal.aborted) return;
          const nowMs = Date.now();
          setSnap({
            temp: d.current_weather?.temperature ?? null,
            code: d.current_weather?.weathercode ?? 0,
            wind: d.current_weather?.windspeed ?? null,
            feels: d.current?.apparent_temperature ?? null,
            humidity: d.current?.relative_humidity_2m ?? null,
            hourly: sliceNext24h(d.hourly, nowMs, d.utc_offset_seconds),
            todayMax: d.daily?.temperature_2m_max?.[0] ?? null,
            todayMin: d.daily?.temperature_2m_min?.[0] ?? null,
            sunrise: d.daily?.sunrise?.[0],
            sunset: d.daily?.sunset?.[0],
            precipSlots: nextHourPrecip(d.minutely_15, nowMs, d.utc_offset_seconds)
          });
          setSnapState("ok");
          // 回写共享缓存槽的「当前天气」：磁贴 / 今日概览只读缓存，此前展开页拉到的
          // 温度只留在本组件 state 里，收起后磁贴又退回「—」。
          const cw = d.current_weather;
          if (cw && typeof cw.temperature === "number") {
            writeCurrentWeatherSlot(
              activeCity.lat,
              activeCity.lon,
              {
                temperature: cw.temperature,
                weathercode: cw.weathercode ?? 0,
                windspeed: cw.windspeed ?? 0,
                ...(typeof d.current?.apparent_temperature === "number"
                  ? { apparent_temperature: d.current.apparent_temperature }
                  : {})
              },
              { humidity: d.current?.relative_humidity_2m ?? null }
            );
          }
        })
        .catch((err) => {
          if (forecastSeq.current !== seq || isAbortError(err)) return;
          setSnapState((s) => (s === "ok" ? s : "error"));
        });
      /* 空气质量独立降级：失败只隐藏该行；URL 与卡片完全同构，走共享合并。 */
      void fetchJsonShared<AirQualityResponse>(
        `${AQI_URL}?latitude=${activeCity.lat}&longitude=${activeCity.lon}&current=european_aqi,uv_index&timezone=auto`,
        { retries: 1, signal: controller.signal }
      )
        .then((aq) => {
          if (forecastSeq.current !== seq) return;
          setAqi(aq?.current?.european_aqi ?? null);
          setUv(aq?.current?.uv_index ?? null);
        })
        .catch(() => {});
      timer = window.setTimeout(load, REFRESH_MS);
    };
    load();
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
    // snap 有意不入依赖（load 内只作为「失败时保旧态」的初值读取）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, activeCity.lat, activeCity.lon, reloadKey]);

  /* 气候常模：缓存优先（30 天 TTL），仅 active 拉取，失败可重试。 */
  useEffect(() => {
    if (!active) return;
    const seq = ++normalsSeq.current;
    const controller = new AbortController();
    setNormalsState("loading");
    loadClimateNormals(activeCity.lat, activeCity.lon, controller.signal)
      .then((n) => {
        if (normalsSeq.current !== seq) return;
        setNormals(n);
        setNormalsState("ok");
      })
      .catch((err) => {
        if (normalsSeq.current !== seq || isAbortError(err)) return;
        setNormalsState("error");
      });
    return () => controller.abort();
  }, [active, activeCity.lat, activeCity.lon, reloadKey]);

  const retry = () => {
    setSnapState("idle");
    setNormalsState("idle");
    setReloadKey((k) => k + 1);
  };

  const fmtTemp = (c: number | null | undefined) => {
    if (c == null || !Number.isFinite(c)) return "—";
    return unit === "fahrenheit" ? `${Math.round((c * 9) / 5 + 32)}°` : `${Math.round(c)}°`;
  };
  /* 风速显示层换算 mph（与卡片 fmtWind 同口径：缓存/响应恒 km/h）。 */
  const fmtWind = (kmh: number | null | undefined) =>
    kmh == null || !Number.isFinite(kmh)
      ? ""
      : unit === "fahrenheit"
        ? `${Math.round(kmh / 1.609344)} mph`
        : `${Math.round(kmh)} km/h`;

  const Icon = weatherIcon(snap?.code ?? 2);
  const today = useMemo(() => (normals ? normalForDate(normals.byDay, new Date(), 3) : null), [normals]);

  /* ---- 24h 图表几何 ---- */
  const chart = useMemo(() => {
    const hs = snap?.hourly ?? [];
    if (hs.length < 2) return null;
    const temps = hs.map((h) => h.temp);
    const feels = metrics.feels ? hs.map((h) => h.feels) : [];
    /* 左轴：温度域 = 预报 + 常模带一起算，保证参考线落在图内。 */
    const domain = valueRange([...temps, ...(today ? [today.tmin, today.tmax] : []), ...feels], 0.14);
    const W = 640;
    const H = 168;
    const tempPath = polylinePath(temps, W, H, domain.min, domain.max);
    const feelsPath = polylinePath(feels, W, H, domain.min, domain.max);
    /* 右轴 0-100：降水概率柱 / 湿度线。 */
    const precipBars = hs.map((h, i) => ({ x: (i / (hs.length - 1)) * W, pct: h.precipProb ?? 0 }));
    const humidityPath = metrics.humidity
      ? polylinePath(
          hs.map((h) => h.humidity),
          W,
          H,
          0,
          100
        )
      : "";
    /* 风：按序列最大值归一到右轴（图例单位 km/h）。 */
    const windVals = metrics.wind ? hs.map((h) => h.wind) : [];
    const windMax = Math.max(1, ...windVals.filter((v): v is number => v != null));
    const windPath = polylinePath(
      windVals.map((v) => (v == null ? null : (v / windMax) * 100)),
      W,
      H,
      0,
      100
    );
    /* x 轴标签：每 3 点取一个（城市本地小时）。 */
    const labels = hs
      .map((h, i) => ({ i, label: i === 0 ? tr("现在") : `${h.time.slice(11, 13)}:00` }))
      .filter((_, i) => i % 3 === 0);
    return { W, H, domain, tempPath, feelsPath, precipBars, humidityPath, windPath, windMax, labels, count: hs.length };
  }, [snap, metrics, today, tr]);

  const nextHour = useMemo(() => summarizeNextHour(snap?.precipSlots ?? []), [snap]);
  const clockFmt = useMemo(
    () => new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", hour12: false }),
    []
  );
  const fmtClock = (iso?: string) =>
    iso && !Number.isNaN(new Date(iso).getTime()) ? clockFmt.format(new Date(iso)) : "";

  const precipSummary = (n: ReturnType<typeof summarizeNextHour>) => {
    if (n.slots.length === 0) return "";
    if (n.kind === "none") return tr("未来一小时无降雨");
    if (n.startsInMin === 0) return `${tr("正在下雨")} · ${n.totalMm.toFixed(1)} mm`;
    return `${n.startsInMin} ${tr("分钟后有雨")} · ${n.totalMm.toFixed(1)} mm`;
  };

  return (
    <div className="ws">
      {/* 头部：城市 / 实况 / 空气质量 / 日出日落 */}
      <div className="ws-head">
        <div className="ws-now">
          <Icon size={30} className="ws-now-icon" />
          <span className="ws-temp">{snap ? fmtTemp(snap.temp) : "—"}</span>
          <span className="ws-city">{tr(activeCity.name)}</span>
          <span className="ws-meta">
            {snap?.feels != null && (
              <>
                {tr("体感")} {fmtTemp(snap.feels)}
              </>
            )}
            {snap?.wind != null && (
              <>
                {" "}
                · {tr("风速")} {fmtWind(snap.wind)}
              </>
            )}
            {snap?.humidity != null && (
              <>
                {" "}
                · {tr("湿度")} {Math.round(snap.humidity)}%
              </>
            )}
          </span>
          {snapState === "error" && !snap && !online && (
            <button className="ws-error" onClick={retry} data-interactive>
              <RefreshCw size={12} /> {tr("加载失败，重试")}
            </button>
          )}
        </div>
        <div className="ws-badges">
          {aqi != null && (
            <span className="ws-badge">
              <span className="ws-badge-dot" style={{ background: aqiLevel(aqi).color }} />
              {tr("空气质量")} {Math.round(aqi)} {tr(aqiLevel(aqi).label)}
            </span>
          )}
          {uv != null && (
            <span className="ws-badge">
              {tr("紫外线")} {Math.round(uv)}
            </span>
          )}
          {(snap?.sunrise || snap?.sunset) && (
            <span className="ws-badge ws-sun">
              <Sunrise size={12} /> {fmtClock(snap?.sunrise)}
              <Sunset size={12} /> {fmtClock(snap?.sunset)}
            </span>
          )}
        </div>
      </div>

      {/* 未来一小时降雨（minutely_15） */}
      <section className="ws-section">
        <div className="ws-section-title">
          <Droplets size={13} />
          <span>{tr("未来一小时降雨")}</span>
          {snapState === "loading" && !snap && <span className="ws-loading-tag">{tr("加载中…")}</span>}
          {snap && nextHour.slots.length > 0 && (
            <span className={`ws-precip-sum k-${nextHour.kind}`}>{precipSummary(nextHour)}</span>
          )}
        </div>
        {snapState === "error" && !snap ? (
          <button className="ws-error" onClick={retry} data-interactive>
            <RefreshCw size={12} /> {tr("加载失败，重试")}
          </button>
        ) : snap && nextHour.slots.length > 0 ? (
          <div className="ws-precip-strip" role="img" aria-label={tr("降水强度")}>
            {nextHour.slots.map((s) => (
              <div className="ws-precip-slot" key={s.time}>
                <div className="ws-precip-bar">
                  <div
                    className={`ws-precip-fill k-${s.mmPerHour >= 10 ? 3 : s.mmPerHour >= 2.5 ? 2 : s.mmPerHour >= 0.1 ? 1 : 0}`}
                    style={{ transform: `scaleY(${Math.max(0.03, Math.min(1, s.mmPerHour / 10))})` }}
                  />
                </div>
                <span className="ws-precip-mm">{s.mmPerHour >= 0.1 ? s.mmPerHour.toFixed(1) : "—"}</span>
                <span className="ws-precip-t">{s.time.slice(11, 16)}</span>
              </div>
            ))}
          </div>
        ) : (
          <div className="ws-empty">{tr("数据缺失")}</div>
        )}
      </section>

      {/* 24h 多指标折线 + 常模参考带 */}
      <section className="ws-section ws-grow">
        <div className="ws-section-title">
          <Thermometer size={13} />
          <span>{tr("24 小时趋势")}</span>
          <span className="ws-legend">
            {(
              [
                ["feels", tr("体感温度")],
                ["precip", tr("降水概率")],
                ["humidity", tr("相对湿度")],
                ["wind", tr("风速")]
              ] as const
            ).map(([k, label]) => (
              <button
                key={k}
                className={`ws-chip l-${k}${metrics[k] ? " on" : ""}`}
                onClick={() => setMetrics((m) => ({ ...m, [k]: !m[k] }))}
                aria-pressed={metrics[k]}
                data-interactive
              >
                {label}
              </button>
            ))}
          </span>
        </div>
        {chart ? (
          <div className="ws-chart-wrap">
            <svg
              className="ws-chart"
              viewBox={`0 0 ${chart.W} ${chart.H}`}
              preserveAspectRatio="none"
              role="img"
              aria-label={tr("24 小时趋势")}
            >
              {/* 常模参考带：历史同期 tmin..tmax（水平带 + 均值虚线）。 */}
              {today && (
                <>
                  <rect
                    className="ws-normals-band"
                    x={0}
                    y={yFor(today.tmax, chart.domain.min, chart.domain.max, chart.H)}
                    width={chart.W}
                    height={Math.max(
                      1,
                      yFor(today.tmin, chart.domain.min, chart.domain.max, chart.H) -
                        yFor(today.tmax, chart.domain.min, chart.domain.max, chart.H)
                    )}
                  />
                  <line
                    className="ws-normals-line"
                    x1={0}
                    x2={chart.W}
                    y1={yFor(today.tmean, chart.domain.min, chart.domain.max, chart.H)}
                    y2={yFor(today.tmean, chart.domain.min, chart.domain.max, chart.H)}
                  />
                </>
              )}
              {/* 降水概率柱（右轴 0-100）。 */}
              {metrics.precip &&
                chart.precipBars.map((b, i) =>
                  b.pct > 0 ? (
                    <rect
                      key={i}
                      className="ws-precip-col"
                      x={b.x - Math.max(2, chart.W / chart.count / 3)}
                      y={chart.H - (b.pct / 100) * chart.H}
                      width={Math.max(4, (chart.W / chart.count) * 0.66)}
                      height={(b.pct / 100) * chart.H}
                    />
                  ) : null
                )}
              {/* 湿度 / 风（右轴）。 */}
              {metrics.humidity && chart.humidityPath && <path className="ws-line l-humidity" d={chart.humidityPath} />}
              {metrics.wind && chart.windPath && <path className="ws-line l-wind" d={chart.windPath} />}
              {/* 体感虚线 + 温度主折线（左轴）。 */}
              {metrics.feels && chart.feelsPath && <path className="ws-line l-feels" d={chart.feelsPath} />}
              <path className="ws-line l-temp" d={chart.tempPath} />
            </svg>
            <div className="ws-axis">
              {chart.labels.map((l) => (
                <span key={l.i} style={{ left: `${(l.i / (chart.count - 1)) * 100}%` }}>
                  {l.label}
                </span>
              ))}
            </div>
            <div className="ws-scale">
              <span>{fmtTemp(chart.domain.max)}</span>
              <span>{fmtTemp(chart.domain.min)}</span>
            </div>
            {today && (
              <div className="ws-normals-tag">
                {tr("历史同期")} {fmtTemp(today.tmin)}~{fmtTemp(today.tmax)}
              </div>
            )}
          </div>
        ) : (
          <div className="ws-empty">{snapState === "loading" ? tr("加载中…") : tr("数据缺失")}</div>
        )}
      </section>

      {/* 今日 vs 历史同期 */}
      <section className="ws-section">
        <div className="ws-section-title">
          <CloudSun size={13} />
          <span>{tr("今日 vs 历史同期")}</span>
          {normalsState === "loading" && <span className="ws-loading-tag">{tr("正在加载常模数据")}</span>}
          {normalsState === "error" && (
            <button className="ws-error" onClick={retry} data-interactive>
              <RefreshCw size={12} /> {tr("常模数据加载失败")} · {tr("重试")}
            </button>
          )}
          {normalsState === "ok" && normals && (
            <span className="ws-normals-years">
              {normals.fromYear}–{normals.toYear}
            </span>
          )}
        </div>
        <TodayVsNormals today={today} snap={snap} fmtTemp={fmtTemp} tr={tr} emptyText={tr("暂无常模数据")} />
      </section>
    </div>
  );
}

/** 今日实况与常模对比三格（均温/最高/最低）。 */
function TodayVsNormals({
  today,
  snap,
  fmtTemp,
  tr,
  emptyText
}: {
  today: DailyNormal | null;
  snap: StationSnapshot | null;
  fmtTemp: (c: number | null | undefined) => string;
  tr: (k: string) => string;
  emptyText: string;
}) {
  if (!today) {
    return <div className="ws-empty">{emptyText}</div>;
  }
  const cell = (label: string, actual: number | null | undefined, normal: number) => {
    const delta = actual == null ? null : actual - normal;
    return (
      <div className="ws-cmp" key={label}>
        <span className="ws-cmp-label">{label}</span>
        <span className="ws-cmp-actual">{fmtTemp(actual ?? null)}</span>
        <span className="ws-cmp-normal">
          {tr("历史同期")} {fmtTemp(normal)}
        </span>
        {delta != null && (
          <span className={`ws-cmp-delta${delta > 0.5 ? " up" : delta < -0.5 ? " down" : ""}`}>
            {delta > 0.5 ? "▲" : delta < -0.5 ? "▼" : "≈"} {fmtTemp(Math.abs(delta))}
          </span>
        )}
      </div>
    );
  };
  const mean = snap?.todayMax != null && snap?.todayMin != null ? (snap.todayMax + snap.todayMin) / 2 : null;
  return (
    <div className="ws-cmp-row">
      {cell(tr("今日均温"), mean, today.tmean)}
      {cell(tr("日最高"), snap?.todayMax ?? null, today.tmax)}
      {cell(tr("日最低"), snap?.todayMin ?? null, today.tmin)}
    </div>
  );
}

export default WeatherStation;
