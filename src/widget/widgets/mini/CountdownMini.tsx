/**
 * 倒计时迷你磁贴（ISLAND-MINI）：最近一个倒数日的剩余天数 + 名称。
 * 只读绑定实例的 widget config（useWidgetConfig，与 CountdownWidget 同 key），
 * targets 按 CountdownWidget.loadTargets 同口径过滤（label / date 形如
 * YYYY-MM-DD）；「最近」= 最早的未到期目标，全部已过则取最近过去的一个。
 * 天数由 lib/use-now 共享节拍器的日界驱动；无实例 / 无目标显「—」。
 */
import { useMemo } from "react";
import { CalendarHeart } from "lucide-react";
import { useT } from "../../../i18n-lite";
import { dayKeyOf, dayKeyToDate, useNow } from "../../../lib/use-now";
import { useWidgetConfig } from "../../widget-config";
import type { MiniComponentProps } from "../../registry";

type Target = { label: string; date: string };
type Nearest = { label: string; days: number };

function pickNearest(raw: unknown, todayMs: number): Nearest | null {
  if (!Array.isArray(raw)) return null;
  const list = (raw as Partial<Target>[])
    .filter(
      (t): t is Target =>
        typeof t?.label === "string" && typeof t.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(t.date)
    )
    .map((t) => ({
      label: t.label,
      days: Math.round((new Date(`${t.date}T00:00:00`).getTime() - todayMs) / 86_400_000)
    }))
    .filter((t) => Number.isFinite(t.days))
    .sort((a, b) => a.days - b.days);
  return list.find((t) => t.days >= 0) ?? list[list.length - 1] ?? null;
}

export function CountdownMini({ instanceId }: MiniComponentProps) {
  const tr = useT();
  const { config } = useWidgetConfig(instanceId ?? "");
  const todayKey = dayKeyOf(useNow());
  const nearest = useMemo(
    () => (instanceId ? pickNearest(config.targets, dayKeyToDate(todayKey)?.getTime() ?? 0) : null),
    [instanceId, config.targets, todayKey]
  );

  if (!nearest) {
    return (
      <span className="dock-mini dock-mini-countdown is-empty">
        <CalendarHeart size={13} className="dock-mini-ico" />
        <span className="dock-mini-num">—</span>
      </span>
    );
  }
  const { label, days } = nearest;
  const text =
    days > 0 ? `${days} ${tr("天")}` : days === 0 ? tr("就是今天") : tr("已过去 {n} 天").replace("{n}", String(-days));
  return (
    <span className={`dock-mini dock-mini-countdown${days === 0 ? " is-today" : days < 0 ? " is-past" : ""}`}>
      <span className="dock-mini-num">{text}</span>
      <span className="dock-mini-text">{label}</span>
    </span>
  );
}
