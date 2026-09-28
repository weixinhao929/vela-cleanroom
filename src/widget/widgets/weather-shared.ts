/**
 * 天气图标 / 语义分组 / AQI 分级：WeatherWidget 卡片与 WeatherStation
 * 沉浸页共用的纯映射（无状态、无 IO）。
 */
import { Cloud, CloudRain, CloudSun, Cloudy, Snowflake, Sun, Zap, type LucideIcon } from "lucide-react";

/** WMO weathercode → 图标。 */
export function weatherIcon(code: number): LucideIcon {
  if (code === 0) return Sun;
  if (code <= 2) return CloudSun;
  if (code === 3) return Cloudy;
  if (code >= 51 && code <= 67) return CloudRain;
  if (code >= 71 && code <= 77) return Snowflake;
  if (code >= 95) return Zap;
  return Cloud;
}

export type WeatherMood = "sunny" | "cloudy" | "rain" | "snow" | "storm";

/** W-011 weathercode → 语义分组（动态背景色调）。 */
export function moodOf(code: number): WeatherMood {
  if (code === 0 || code === 1) return "sunny";
  if (code <= 3) return "cloudy";
  if (code >= 95) return "storm";
  if (code >= 71) return "snow";
  return "rain";
}

/** W-008 欧洲 AQI 分级配色（优先主题 token，无对应色档保留内联值）。 */
export function aqiLevel(v: number): { label: string; color: string } {
  if (v <= 20) return { label: "优", color: "var(--success)" };
  if (v <= 40) return { label: "良", color: "#a3e635" };
  if (v <= 60) return { label: "中", color: "var(--amber)" };
  if (v <= 80) return { label: "差", color: "#fb923c" };
  if (v <= 100) return { label: "很差", color: "var(--danger)" };
  return { label: "极差", color: "#c084fc" };
}

export const WEEKDAY_CN = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
