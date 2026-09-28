/**
 * 时钟时区数据共享模块。
 *
 * 世界时钟（W-001）的常用时区表与全量 IANA 枚举此前内联在 ClockWidget 里，
 * 就地配置弹层（B1）的时区编辑器与设置页同样需要这份名单。抽出为独立模块，
 * 避免 ClockWidget ↔ WidgetConfigPopover 相互 import 形成环。
 */

/** 常用时区列表（供时钟时区选择）。 */
export const TIMEZONES: { id: string; label: string }[] = [
  { id: "auto", label: "本地时区" },
  { id: "Asia/Shanghai", label: "北京 / 上海 (UTC+8)" },
  { id: "Asia/Tokyo", label: "东京 (UTC+9)" },
  { id: "Asia/Seoul", label: "首尔 (UTC+9)" },
  { id: "Asia/Singapore", label: "新加坡 (UTC+8)" },
  { id: "Asia/Dubai", label: "迪拜 (UTC+4)" },
  { id: "Europe/London", label: "伦敦 (UTC+0)" },
  { id: "Europe/Paris", label: "巴黎 / 柏林 (UTC+1)" },
  { id: "Europe/Moscow", label: "莫斯科 (UTC+3)" },
  { id: "America/New_York", label: "纽约 (UTC-5)" },
  { id: "America/Chicago", label: "芝加哥 (UTC-6)" },
  { id: "America/Denver", label: "丹佛 (UTC-7)" },
  { id: "America/Los_Angeles", label: "洛杉矶 (UTC-8)" },
  { id: "America/Sao_Paulo", label: "圣保罗 (UTC-3)" },
  { id: "Australia/Sydney", label: "悉尼 (UTC+10)" },
  { id: "Pacific/Auckland", label: "奥克兰 (UTC+12)" }
];

/* W-006 全量时区：Intl 枚举 + 常用列表置顶去重，海外用户也能找到自己城市。 */
export const ALL_TIMEZONES: string[] = (() => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const all = (Intl as any).supportedValuesOf?.("timeZone") as string[] | undefined;
    if (!Array.isArray(all)) return TIMEZONES.map((t) => t.id).filter((id) => id !== "auto");
    const common = TIMEZONES.map((t) => t.id).filter((id) => id !== "auto");
    return Array.from(new Set([...common, ...all]));
  } catch {
    return TIMEZONES.map((t) => t.id).filter((id) => id !== "auto");
  }
})();

/** 时区 id → 展示城市名（最后一段），如 Asia/Shanghai → 上海。 */
export const cityOf = (tz: string) => tz.split("/").pop()?.replace(/_/g, " ") || tz;

/** 校验并归一化一条时区输入：接受 IANA id 或常用表里的展示名，返回 id；非法返回 null。 */
export function normalizeZoneInput(v: string): string | null {
  const s = v.trim();
  if (!s) return null;
  if (!ALL_TIMEZONES.includes(s) && !TIMEZONES.some((t) => t.label === s)) return null;
  return TIMEZONES.find((t) => t.label === s)?.id ?? s;
}
