/**
 * 单位换算小组件：长度/重量/温度/面积/体积/速度/数据等类别的双向换算，
 * 纯前端计算，类别切换保留输入值。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowUpDown, ChevronDown, Copy, History, RefreshCw, Search, X } from "lucide-react";
import { WidgetSelect } from "../../components/WidgetSelect";
import { copyText } from "../../lib/clipboard";
import { fetchJson } from "../../lib/network";
import { useT } from "../../i18n-lite";
import { useSafeTimeout } from "../../lib/use-safe-timeout";
import { useWidgetConfig } from "../widget-config";

type Unit = { id: string; name: string; factor: number };

const CATEGORIES: Record<string, { name: string; units: Unit[] }> = {
  length: {
    name: "长度",
    units: [
      { id: "mm", name: "毫米", factor: 0.001 },
      { id: "cm", name: "厘米", factor: 0.01 },
      { id: "m", name: "米", factor: 1 },
      { id: "km", name: "千米", factor: 1000 },
      { id: "in", name: "英寸", factor: 0.0254 },
      { id: "ft", name: "英尺", factor: 0.3048 }
    ]
  },
  weight: {
    name: "重量",
    units: [
      { id: "mg", name: "毫克", factor: 0.000001 },
      { id: "g", name: "克", factor: 0.001 },
      { id: "kg", name: "千克", factor: 1 },
      { id: "t", name: "吨", factor: 1000 },
      { id: "lb", name: "磅", factor: 0.45359237 }
    ]
  },
  temperature: {
    name: "温度",
    units: [
      { id: "c", name: "摄氏度", factor: 1 },
      { id: "f", name: "华氏度", factor: 1 },
      { id: "k", name: "开尔文", factor: 1 }
    ]
  },
  data: {
    name: "数据",
    units: [
      { id: "b", name: "字节", factor: 1 },
      { id: "kb", name: "KB", factor: 1024 },
      { id: "mb", name: "MB", factor: 1024 * 1024 },
      { id: "gb", name: "GB", factor: 1024 * 1024 * 1024 },
      { id: "tb", name: "TB", factor: 1024 ** 4 }
    ]
  },
  area: {
    name: "面积",
    units: [
      { id: "mm2", name: "平方毫米", factor: 0.000001 },
      { id: "cm2", name: "平方厘米", factor: 0.0001 },
      { id: "m2", name: "平方米", factor: 1 },
      { id: "km2", name: "平方千米", factor: 1e6 },
      { id: "ha", name: "公顷", factor: 10000 },
      { id: "acre", name: "英亩", factor: 4046.8564224 }
    ]
  },
  volume: {
    name: "体积",
    units: [
      { id: "ml", name: "毫升", factor: 0.001 },
      { id: "l", name: "升", factor: 1 },
      { id: "m3", name: "立方米", factor: 1000 },
      { id: "gal", name: "加仑", factor: 3.785411784 }
    ]
  },
  speed: {
    name: "速度",
    units: [
      { id: "mps", name: "米/秒", factor: 1 },
      { id: "kmh", name: "千米/小时", factor: 1 / 3.6 },
      { id: "mph", name: "英里/小时", factor: 0.44704 },
      { id: "knot", name: "节", factor: 0.514444 }
    ]
  },
  time: {
    name: "时间",
    units: [
      { id: "ms", name: "毫秒", factor: 0.001 },
      { id: "s", name: "秒", factor: 1 },
      { id: "min", name: "分钟", factor: 60 },
      { id: "h", name: "小时", factor: 3600 },
      { id: "day", name: "天", factor: 86400 }
    ]
  },
  // W-060 扩展类别：压强/能量/功率/角度（普通 factor 换算）。
  pressure: {
    name: "压强",
    units: [
      { id: "pa", name: "帕斯卡", factor: 1 },
      { id: "kpa", name: "千帕", factor: 1000 },
      { id: "bar", name: "巴", factor: 1e5 },
      { id: "atm", name: "标准大气压", factor: 101325 },
      { id: "mmhg", name: "毫米汞柱", factor: 133.3224 },
      { id: "psi", name: "磅/平方英寸", factor: 6894.7573 }
    ]
  },
  energy: {
    name: "能量",
    units: [
      { id: "j", name: "焦耳", factor: 1 },
      { id: "kj", name: "千焦", factor: 1000 },
      { id: "cal", name: "卡路里", factor: 4.184 },
      { id: "kcal", name: "千卡", factor: 4184 },
      { id: "wh", name: "瓦时", factor: 3600 },
      { id: "kwh", name: "千瓦时", factor: 3.6e6 }
    ]
  },
  power: {
    name: "功率",
    units: [
      { id: "w", name: "瓦特", factor: 1 },
      { id: "kw", name: "千瓦", factor: 1000 },
      { id: "ps", name: "公制马力", factor: 735.49875 },
      { id: "hp", name: "英制马力", factor: 745.69987 },
      { id: "btuh", name: "BTU/时", factor: 0.29307107 }
    ]
  },
  angle: {
    name: "角度",
    units: [
      { id: "deg", name: "度", factor: 1 },
      { id: "rad", name: "弧度", factor: 57.29577951308232 },
      { id: "gon", name: "梯度", factor: 0.9 },
      { id: "arcmin", name: "角分", factor: 1 / 60 },
      { id: "arcsec", name: "角秒", factor: 1 / 3600 },
      { id: "turn", name: "圆周", factor: 360 }
    ]
  },
  // W-060 鞋码：以脚长毫米为基准的特殊公式（同温度分支处理）。
  shoe: {
    name: "鞋码",
    units: [
      { id: "mm", name: "脚长毫米", factor: 1 },
      { id: "cm", name: "脚长厘米", factor: 1 },
      { id: "cn", name: "中国码", factor: 1 },
      { id: "eu", name: "欧码 EU", factor: 1 },
      { id: "us", name: "美码 US", factor: 1 },
      { id: "uk", name: "英码 UK", factor: 1 }
    ]
  },
  // W-059 货币：factor 由汇率动态填充（1/每美元兑该币汇率），未加载时为 1。
  currency: {
    name: "货币",
    units: [
      { id: "CNY", name: "人民币", factor: 1 },
      { id: "USD", name: "美元", factor: 1 },
      { id: "EUR", name: "欧元", factor: 1 },
      { id: "JPY", name: "日元", factor: 1 },
      { id: "HKD", name: "港币", factor: 1 },
      { id: "TWD", name: "新台币", factor: 1 },
      { id: "GBP", name: "英镑", factor: 1 },
      { id: "KRW", name: "韩元", factor: 1 },
      { id: "AUD", name: "澳元", factor: 1 },
      { id: "CAD", name: "加元", factor: 1 },
      { id: "SGD", name: "新加坡元", factor: 1 },
      { id: "CHF", name: "瑞士法郎", factor: 1 },
      { id: "RUB", name: "卢布", factor: 1 },
      { id: "THB", name: "泰铢", factor: 1 }
    ]
  }
};

/** 仅在开启「显示更多单位」时出现的扩展类别。 */
const EXTENDED_CATEGORIES = [
  "area",
  "volume",
  "speed",
  "time",
  "pressure",
  "energy",
  "power",
  "angle",
  "shoe",
  "currency"
];

// ── 鞋码特殊公式（基准：脚长毫米） ──────────────────────────────
// 中国码 = 脚长cm×2 − 10；EU ≈ 脚长cm×1.27 + 9.25；US(男) = 脚长in×3 − 22；UK = US − 0.5。
function shoeToMm(v: number, u: string): number {
  switch (u) {
    case "mm":
      return v;
    case "cm":
      return v * 10;
    case "cn":
      return (v + 10) * 5;
    case "eu":
      return ((v - 9.25) / 1.27) * 10;
    case "us":
      return ((v + 22) / 3) * 25.4;
    case "uk":
      return ((v + 22.5) / 3) * 25.4;
    default:
      return v;
  }
}

function mmToShoe(mm: number, u: string): number {
  switch (u) {
    case "mm":
      return mm;
    case "cm":
      return mm / 10;
    case "cn":
      return mm / 5 - 10;
    case "eu":
      return (mm / 10) * 1.27 + 9.25;
    case "us":
      return (mm / 25.4) * 3 - 22;
    case "uk":
      return (mm / 25.4) * 3 - 22.5;
    default:
      return mm;
  }
}

function convert(cat: string, value: number, from: string, to: string, units: Unit[]): number {
  if (cat === "temperature") {
    let c = value;
    if (from === "f") c = ((value - 32) * 5) / 9;
    if (from === "k") c = value - 273.15;
    if (to === "c") return c;
    if (to === "f") return (c * 9) / 5 + 32;
    return c + 273.15;
  }
  if (cat === "shoe") {
    return mmToShoe(shoeToMm(value, from), to);
  }
  // 防御：类别恢复自 localStorage 时 from/to 可能仍指向旧类别的单位，
  // find 落空时回退到该类别的前两个单位。
  const fromU = units.find((u) => u.id === from) ?? units[0];
  const toU = units.find((u) => u.id === to) ?? units[1] ?? units[0];
  if (!fromU || !toU) return value;
  return (value * fromU.factor) / toU.factor;
}

/** 结果格式化：极大/极小用科学计数法，其余保留最多 8 位有效数字。 */
function fmt(n: number): string {
  if (!Number.isFinite(n)) return "—";
  if (n === 0) return "0";
  const a = Math.abs(n);
  if (a >= 1e12 || a < 1e-6) return n.toExponential(4);
  return String(Number(n.toPrecision(8)));
}

// ── W-059 汇率获取（免费无 Key API + localStorage 缓存） ─────────
const FX_KEY = "focus-desk.uc.fx.v1";
const FX_TTL_MS = 6 * 60 * 60 * 1000;

type FxSnapshot = { rates: Record<string, number>; at: number };

async function fetchRates(): Promise<FxSnapshot> {
  try {
    const d = await fetchJson<{ result?: string; rates?: Record<string, number> }>(
      "https://open.er-api.com/v6/latest/USD",
      { retries: 1 }
    );
    if (d.rates && typeof d.rates.CNY === "number") return { rates: d.rates, at: Date.now() };
  } catch {
    // fall through to backup source
  }
  const d2 = await fetchJson<{ rates?: Record<string, number> }>("https://api.frankfurter.app/latest?from=USD", {
    retries: 1
  });
  if (d2.rates) return { rates: { USD: 1, ...d2.rates }, at: Date.now() };
  throw new Error("fx fetch failed");
}

function readFxCache(): FxSnapshot | null {
  try {
    const raw = localStorage.getItem(FX_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw) as FxSnapshot;
    return p && typeof p === "object" && p.rates && typeof p.rates.USD === "number" ? p : null;
  } catch {
    return null;
  }
}

// ── W-056 状态持久化 / W-058 历史 ──────────────────────────────
type SavedState = { cat: string; from: string; to: string; value: string };
type HistEntry = { cat: string; from: string; to: string; value: string; out: string; at: number };

export function UnitConverterWidget({ instanceId }: { instanceId: string }) {
  const tr = useT();
  const safeTimeout = useSafeTimeout();
  const { config } = useWidgetConfig(instanceId);
  const showExtended = !!config.showExtended;
  const rememberCategory = config.rememberCategory !== false;
  const showAllUnits = config.showAllUnits !== false;
  const showHistory = config.showHistory !== false;
  const stateKey = `focus-desk.uc.state.${instanceId}`;
  const histKey = `focus-desk.uc.history.${instanceId}`;
  const legacyCatKey = `focus-desk.uc.cat.${instanceId}`;

  const readSaved = (): SavedState | null => {
    try {
      const raw = localStorage.getItem(stateKey);
      if (raw) {
        const p = JSON.parse(raw) as SavedState;
        if (p && CATEGORIES[p.cat]) return p;
      }
      // 迁移旧的仅类别记忆 key。
      const legacy = localStorage.getItem(legacyCatKey);
      if (legacy && CATEGORIES[legacy]) return { cat: legacy, from: "", to: "", value: "1" };
    } catch {
      // ignore
    }
    return null;
  };

  const [saved] = useState(readSaved);
  const [cat, setCat] = useState(() => (rememberCategory && saved?.cat) || "length");
  const [from, setFrom] = useState(() => {
    const c = CATEGORIES[rememberCategory && saved?.cat ? saved.cat : "length"];
    const u = c?.units.find((x) => x.id === saved?.from);
    return u?.id ?? c?.units[0]?.id ?? "m";
  });
  const [to, setTo] = useState(() => {
    const c = CATEGORIES[rememberCategory && saved?.cat ? saved.cat : "length"];
    const u = c?.units.find((x) => x.id === saved?.to);
    return u?.id ?? c?.units[1]?.id ?? c?.units[0]?.id ?? "km";
  });
  const [value, setValue] = useState(() =>
    rememberCategory && saved?.value && !Number.isNaN(parseFloat(saved.value)) ? saved.value : "1"
  );
  const [copied, setCopied] = useState(false);
  const [query, setQuery] = useState("");
  const [histOpen, setHistOpen] = useState(false);
  const [history, setHistory] = useState<HistEntry[]>(() => {
    try {
      const raw = localStorage.getItem(histKey);
      const p = raw ? JSON.parse(raw) : [];
      return Array.isArray(p) ? p.filter((h) => h && CATEGORIES[h.cat]) : [];
    } catch {
      return [];
    }
  });

  // W-059 汇率状态。
  const [fx, setFx] = useState<FxSnapshot | null>(readFxCache);
  const [fxStatus, setFxStatus] = useState<"idle" | "loading" | "error">("idle");

  const refreshFx = useCallback(async () => {
    setFxStatus("loading");
    try {
      const fresh = await fetchRates();
      setFx(fresh);
      setFxStatus("idle");
      try {
        localStorage.setItem(FX_KEY, JSON.stringify(fresh));
      } catch {
        // best-effort cache
      }
    } catch {
      setFxStatus("error");
    }
  }, []);

  useEffect(() => {
    if (cat !== "currency") return;
    const cached = readFxCache();
    if (cached && Date.now() - cached.at < FX_TTL_MS) {
      setFx(cached);
      return;
    }
    void refreshFx();
  }, [cat, refreshFx]);

  // W-056 记住类别 + 单位 + 输入值。
  useEffect(() => {
    if (!rememberCategory) return;
    try {
      const s: SavedState = { cat, from, to, value };
      localStorage.setItem(stateKey, JSON.stringify(s));
      localStorage.setItem(legacyCatKey, cat);
    } catch {
      // best-effort
    }
  }, [cat, from, to, value, rememberCategory, stateKey, legacyCatKey]);

  const fxUnits = useMemo(
    () =>
      fx
        ? CATEGORIES.currency.units.map((c) => ({
            ...c,
            factor: c.id === "USD" ? 1 : 1 / (fx.rates[c.id] ?? Number.NaN)
          }))
        : null,
    [fx]
  );

  // 汇率未就绪（首次加载中/获取失败且无缓存）时货币 factor 一律 NaN → 结果
  // 显示「—」，状态行另有提示。此前回退到占位表（factor 全为 1），会把
  // 「1 USD = 1 CNY」当真实换算展示。
  const fxPendingUnits = useMemo(() => CATEGORIES.currency.units.map((c) => ({ ...c, factor: Number.NaN })), []);
  const units = cat === "currency" ? (fxUnits ?? fxPendingUnits) : CATEGORIES[cat].units;
  const catUnits = (id: string) => (id === "currency" ? CATEGORIES.currency.units : CATEGORIES[id].units);

  const switchCat = (id: string) => {
    const c = catUnits(id);
    setCat(id);
    setFrom(c[0].id);
    setTo(c[1].id);
  };

  // W-061 类别/单位搜索过滤。
  const visibleCategories = useMemo(() => {
    const base = Object.entries(CATEGORIES).filter(([id]) => showExtended || !EXTENDED_CATEGORIES.includes(id));
    const q = query.trim().toLowerCase();
    if (!q) return base;
    return base.filter(
      ([, c]) =>
        c.name.toLowerCase().includes(q) ||
        c.units.some((u) => u.name.toLowerCase().includes(q) || u.id.toLowerCase().includes(q))
    );
  }, [query, showExtended]);

  const num = parseFloat(value) || 0;
  const out = convert(cat, num, from, to, units);
  const pretty = fmt(out);

  const pushHistory = useCallback(
    (entryCat: string, entryFrom: string, entryTo: string, entryValue: string, entryOut: string) => {
      setHistory((prev) => {
        const next = [
          { cat: entryCat, from: entryFrom, to: entryTo, value: entryValue, out: entryOut, at: Date.now() },
          ...prev.filter(
            (h) => !(h.cat === entryCat && h.from === entryFrom && h.to === entryTo && h.value === entryValue)
          )
        ].slice(0, 10);
        try {
          localStorage.setItem(histKey, JSON.stringify(next));
        } catch {
          // best-effort
        }
        return next;
      });
    },
    [histKey]
  );

  const recordCurrent = () => {
    if (!value.trim()) return;
    if (!Number.isFinite(out)) return; // 汇率未就绪的「—」不进历史
    pushHistory(cat, from, to, value, pretty);
  };

  const copyResult = () => {
    const fromName = units.find((u) => u.id === from)?.name ?? "";
    const toName = units.find((u) => u.id === to)?.name ?? "";
    void copyText(`${value} ${fromName} = ${pretty} ${toName}`).then((ok) => {
      if (ok) {
        setCopied(true);
        safeTimeout(() => setCopied(false), 1200);
      }
    });
    recordCurrent();
  };

  const copyRow = (unitName: string, v: string) => {
    void copyText(`${v} ${unitName}`);
  };

  const applyHistory = (h: HistEntry) => {
    const c = catUnits(h.cat);
    setCat(h.cat);
    setFrom(c.find((u) => u.id === h.from)?.id ?? c[0].id);
    setTo(c.find((u) => u.id === h.to)?.id ?? c[1].id);
    setValue(h.value);
  };

  const fxTime = fx ? new Date(fx.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";

  return (
    <div className="uc">
      {/* W-061 单位/类别搜索 */}
      {showExtended && (
        <div className="uc-search">
          <Search size={12} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={tr("搜索类别或单位…")}
            data-interactive
          />
          {query && (
            <button className="uc-search-clear" onClick={() => setQuery("")} aria-label={tr("清空")} data-interactive>
              <X size={12} />
            </button>
          )}
        </div>
      )}
      <div className="uc-tabs">
        {visibleCategories.map(([id, c]) => (
          <button
            key={id}
            className={`uc-tab${cat === id ? " active" : ""}`}
            onClick={() => switchCat(id)}
            aria-pressed={cat === id}
          >
            {tr(c.name)}
          </button>
        ))}
        {visibleCategories.length === 0 && <span className="uc-empty-hint">{tr("无匹配类别")}</span>}
      </div>
      <div className="uc-row">
        <input
          className="uc-input"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") recordCurrent();
          }}
          inputMode="decimal"
        />
        {/* 自绘下拉替换原生 select：系统弹窗不跟随主题（用户反馈「简陋」）。 */}
        <WidgetSelect
          value={from}
          onChange={setFrom}
          ariaLabel={tr("源单位")}
          options={units.map((u) => ({ value: u.id, label: tr(u.name) }))}
        />
      </div>
      <div className="uc-eq">
        <button
          className="uc-swap"
          onClick={() => {
            setFrom(to);
            setTo(from);
          }}
          aria-label={tr("互换单位")}
          title={tr("互换单位")}
          data-interactive
        >
          {/* E9：字符 ⇅ 换 lucide 图标。 */}
          <ArrowUpDown size={13} />
        </button>
      </div>
      <div className="uc-row">
        <div className="uc-result" key={pretty}>
          {pretty}
        </div>
        <button
          className={`uc-copy${copied ? " done" : ""}`}
          onClick={copyResult}
          aria-label={tr("复制结果")}
          title={copied ? tr("已复制") : tr("复制换算结果")}
          data-interactive
        >
          <Copy size={13} />
        </button>
        <WidgetSelect
          value={to}
          onChange={setTo}
          ariaLabel={tr("目标单位")}
          options={units.map((u) => ({ value: u.id, label: tr(u.name) }))}
        />
      </div>

      {/* W-059 货币汇率状态行 */}
      {cat === "currency" && (
        <div className="uc-fx">
          {fxStatus === "loading" && (
            <span className="uc-fx-loading">
              <RefreshCw size={11} className="uc-fx-spin" />
              {tr("正在获取汇率…")}
            </span>
          )}
          {fxStatus === "error" && (
            <>
              <span className="uc-fx-err">{tr("汇率获取失败")}</span>
              <button className="uc-fx-refresh" onClick={() => void refreshFx()} data-interactive>
                <RefreshCw size={11} />
                {tr("重试")}
              </button>
            </>
          )}
          {fxStatus === "idle" && fx && (
            <>
              <span>
                {tr("汇率更新于")} {fxTime} · {tr("仅供参考")}
              </span>
              <button
                className="uc-fx-refresh"
                onClick={() => void refreshFx()}
                title={tr("刷新汇率")}
                aria-label={tr("刷新汇率")}
                data-interactive
              >
                <RefreshCw size={11} />
              </button>
            </>
          )}
        </div>
      )}

      {/* W-057 一表多单位同显 */}
      {showAllUnits && cat !== "currency" && (
        <div className="uc-all">
          {units.map((u, ui) => {
            const v = fmt(convert(cat, num, from, u.id, units));
            return (
              <button
                key={u.id}
                className={`uc-all-row${u.id === to ? " target" : ""}`}
                style={{ ["--sti" as string]: Math.min(ui, 12) }}
                onClick={() => copyRow(u.name, v)}
                title={tr("点击复制")}
                data-interactive
              >
                <span className="uc-all-name">{tr(u.name)}</span>
                <span className="uc-all-val">{v}</span>
              </button>
            );
          })}
        </div>
      )}
      {showAllUnits && cat === "currency" && fxUnits && (
        <div className="uc-all uc-all-fx">
          {units.map((u, ui) => {
            const v = fmt(convert(cat, num, from, u.id, units));
            return (
              <button
                key={u.id}
                className={`uc-all-row${u.id === to ? " target" : ""}`}
                style={{ ["--sti" as string]: Math.min(ui, 12) }}
                onClick={() => copyRow(u.name, v)}
                title={tr("点击复制")}
                data-interactive
              >
                <span className="uc-all-name">{tr(u.name)}</span>
                <span className="uc-all-val">{v}</span>
              </button>
            );
          })}
        </div>
      )}

      {/* W-058 换算历史 */}
      {showHistory && history.length > 0 && (
        <div className="uc-hist">
          <button className="uc-hist-toggle" onClick={() => setHistOpen((v) => !v)} data-interactive>
            <History size={11} />
            {tr("换算历史")}
            <span className="uc-hist-count">{history.length}</span>
            <ChevronDown size={11} className={`uc-hist-chevron${histOpen ? " open" : ""}`} />
          </button>
          {/* 折叠常驻挂载 + grid-rows 0fr→1fr（W-151 范式）：chevron 已暗示会动，
              容器高度不再硬切；inert 收起后不可聚焦。 */}
          <div className={`uc-hist-wrap${histOpen ? " open" : ""}`} inert={!histOpen}>
            <div className="uc-hist-clip">
              <div className="uc-hist-list">
                {history.map((h, hi) => {
                  const fn = catUnits(h.cat).find((u) => u.id === h.from)?.name ?? h.from;
                  const tn = catUnits(h.cat).find((u) => u.id === h.to)?.name ?? h.to;
                  return (
                    <button
                      className="uc-hist-row"
                      key={`${h.at}-${h.from}-${h.to}-${h.value}`}
                      style={{ ["--sti" as string]: Math.min(hi, 12) }}
                      onClick={() => applyHistory(h)}
                      data-interactive
                    >
                      <span className="uc-hist-time">
                        {new Date(h.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                      </span>
                      <span className="uc-hist-body">
                        {h.value} {tr(fn)} → {h.out} {tr(tn)}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      )}
      {cat === "shoe" && <div className="uc-note">{tr("鞋码为近似换算，以实物为准")}</div>}
    </div>
  );
}
