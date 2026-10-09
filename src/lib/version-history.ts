/**
 * 本机版本历史：记录「这台电脑运行过哪些版本 +
 * 通道 + 首次/最近时间」，与远端 Release 列表分开展示。localStorage 轻数据
 * （persistMirrored 进备份镜像），与远端仓库无关。
 */
import { persistMirrored } from "./local-backup";
import type { UpdateChannel } from "./update-flow";

export type VersionEntry = {
  version: string;
  channel: UpdateChannel;
  firstSeen: number;
  lastSeen: number;
};

const KEY = "focus-desk.version-history.v1";
const CAP = 30;

function isEntry(v: unknown): v is VersionEntry {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.version === "string" &&
    o.version.length > 0 &&
    (o.channel === "stable" || o.channel === "insider") &&
    typeof o.firstSeen === "number" &&
    typeof o.lastSeen === "number"
  );
}

/** 读取历史（坏条目丢弃，按 lastSeen 降序）。 */
export function loadVersionHistory(): VersionEntry[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(isEntry)
      .sort((a: VersionEntry, b: VersionEntry) => b.lastSeen - a.lastSeen)
      .slice(0, CAP);
  } catch {
    return [];
  }
}

/** 记录当前运行版本（upsert：版本+通道已存在则刷新 lastSeen；通道变化算新条目）。
 *  返回更新后的列表（并已落盘）。 */
export function recordCurrentVersion(version: string, channel: UpdateChannel, now = Date.now()): VersionEntry[] {
  const v = version.trim();
  if (!v || v === "unknown") return loadVersionHistory();
  const prev = loadVersionHistory();
  const hit = prev.find((e) => e.version === v && e.channel === channel);
  const next = hit
    ? prev.map((e) => (e === hit ? { ...e, lastSeen: now } : e))
    : [{ version: v, channel, firstSeen: now, lastSeen: now }, ...prev];
  const capped = next.sort((a, b) => b.lastSeen - a.lastSeen).slice(0, CAP);
  try {
    persistMirrored(KEY, JSON.stringify(capped));
  } catch {
    // best-effort：镜像失败不阻断（localStorage 本体已在 persistMirrored 内写）。
  }
  return capped;
}
