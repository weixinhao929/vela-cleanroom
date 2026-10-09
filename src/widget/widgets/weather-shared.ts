/**
 * 天气图标 / 语义分组 / AQI 分级 / 同 URL 在途请求合并：WeatherWidget 卡片、
 * WeatherStation 沉浸页与 TodayOverview 共用（除 fetchJsonShared 外均为
 * 无状态、无 IO 的纯映射）。
 */
import { Cloud, CloudFog, CloudRain, CloudSun, Cloudy, Snowflake, Sun, Zap, type LucideIcon } from "lucide-react";
import { fetchJson } from "../../lib/network";

/** WMO weathercode → 图标。85/86（雪阵）补入雪系——此前落到通用 Cloud，
 *  与 moodOf 的雪色背景不一致；45/48（雾）单列 CloudFog。 */
export function weatherIcon(code: number): LucideIcon {
  if (code === 0) return Sun;
  if (code <= 2) return CloudSun;
  if (code === 3) return Cloudy;
  if (code === 45 || code === 48) return CloudFog;
  if (code >= 51 && code <= 67) return CloudRain;
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return Snowflake;
  if (code >= 95) return Zap;
  return Cloud;
}

export type WeatherMood = "sunny" | "cloudy" | "rain" | "snow" | "storm";

/** weathercode → 语义分组（动态背景色调）。 */
export function moodOf(code: number): WeatherMood {
  if (code === 0 || code === 1) return "sunny";
  if (code <= 3) return "cloudy";
  if (code >= 95) return "storm";
  if (code >= 71) return "snow";
  return "rain";
}

/** 欧洲 AQI 分级配色（优先主题 token，无对应色档保留内联值）。 */
export function aqiLevel(v: number): { label: string; color: string } {
  if (v <= 20) return { label: "优", color: "var(--success)" };
  if (v <= 40) return { label: "良", color: "#a3e635" };
  if (v <= 60) return { label: "中", color: "var(--amber)" };
  if (v <= 80) return { label: "差", color: "#fb923c" };
  if (v <= 100) return { label: "很差", color: "var(--danger)" };
  return { label: "极差", color: "#c084fc" };
}

export const WEEKDAY_CN = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

/* ------------------------------------------------------------------ */
/*  同 URL 在途请求合并（卡片 / 天气站 / 今日概览共用）                    */
/* ------------------------------------------------------------------ */

const sharedInflight = new Map<string, Promise<unknown>>();

/**
 * 单调用方的中止视图：共享请求本身不携带任何调用方的 signal（否则第一个
 * 调用方卸载 abort 会把后来加入者的结果一起打掉），改为每个调用方用
 * Promise.race 把共享结果与自己的 abort 竞速——先到者胜，监听器必清理。
 */
function raceAbort<T>(p: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return p;
  if (signal.aborted) return Promise.reject(new DOMException("Aborted", "AbortError"));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(new DOMException("Aborted", "AbortError"));
    };
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(
      (v) => {
        cleanup();
        resolve(v);
      },
      (e) => {
        cleanup();
        reject(e);
      }
    );
  });
}

/**
 * 同 URL 的在途请求跨组件合并：重叠窗口内只发一次网络请求，结果共享
 * （同城市卡片 + 天气站 + 今日概览的轮询相位不同也不重复请求）。
 *
 * abort 语义（与直连 fetchJson 的关键差异）：**请求不随单个调用方中止**。
 * 共享请求不传调用方 signal；调用方卸载/换城市时只是不再接收结果，底层
 * 请求继续跑完（超时仍受用户设置约束）。代价是卸载后浪费一次已在途的
 * 请求，换来的是后加入的其他调用方不因首调用方 abort 拿到 AbortError、
 * 干等下一轮轮询（间隔可长达 30–120 分钟）。
 *
 * @typeParam T - 期望的 JSON 结构类型。
 * @param url - 目标 URL（合并键）。
 * @param opts - `retries` 最大重试次数；`signal` 仅用于提前放弃等待结果。
 * @returns 反序列化后的 JSON；调用方中止时 reject AbortError（isAbortError 可判）。
 */
export function fetchJsonShared<T>(url: string, opts?: { retries?: number; signal?: AbortSignal }): Promise<T> {
  // 已中止的调用不发起/加入请求（否则会白发一次没人等的结果）。
  if (opts?.signal?.aborted) return Promise.reject(new DOMException("Aborted", "AbortError"));
  const hit = sharedInflight.get(url);
  if (hit) return raceAbort(hit as Promise<T>, opts?.signal);
  const p = fetchJson<T>(url, { retries: opts?.retries }).finally(() => {
    sharedInflight.delete(url);
  });
  sharedInflight.set(url, p);
  return raceAbort(p, opts?.signal);
}
