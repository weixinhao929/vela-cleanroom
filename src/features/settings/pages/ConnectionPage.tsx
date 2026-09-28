/**
 * 设置页 · 连接页：网络连通性测试（延迟/测速）、天气城市管理与
 * 邮箱账户配置；探测经 lib/network 的多候选源策略。
 */
import { useEffect, useState } from "react";
import { MapPin } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { useSettingsStore } from "../../../store/settings-store";
import { SettingRow, Toggle } from "../shared";
import { M3Slider as Slider } from "../../../components/ui/M3Slider";
import { useT } from "../../../i18n-lite";
import { FxText } from "../../../lib/fx";
import { invoke, isTauri } from "../../../lib/tauri";
import {
  geocodeCity,
  getCurrentPosition,
  measureDownloadSpeed,
  testConnectivity,
  formatByteRate,
  formatBytesTotal,
  mbpsToBps
} from "../../../lib/network";
import type { SpeedResult } from "../../../lib/network";
import type { NetworkDetail, TcpConnectionInfo, TrafficDay, TrafficSummary } from "../../../lib/system-stats";
import { clearIpGeoCache, fetchIpGeo } from "../../../lib/ip-geo";
import { showToast } from "../../../components/ToastHost";
import { useSafeTimeout } from "../../../lib/use-safe-timeout";

export function ConnectionPage() {
  // F2（审计）：字段级订阅，见 AnimationPage 注释。
  const s = useSettingsStore(
    useShallow((st) => ({
      extra: st.extra,
      setExtra: st.setExtra,
      setExtraDebounced: st.setExtraDebounced
    }))
  );
  const tr = useT();
  const safeTimeout = useSafeTimeout();
  const ex = s.extra;
  const [geo, setGeo] = useState<"idle" | "loading" | "done" | "fail">("idle");
  const [geoMsg, setGeoMsg] = useState<string | null>(null);
  const [extraDraft, setExtraDraft] = useState("");
  const [extraBusy, setExtraBusy] = useState(false);
  const [conn, setConn] = useState<{ online: boolean; latencyMs: number | null } | null>(null);
  const [testing, setTesting] = useState(false);
  const [speed, setSpeed] = useState<SpeedResult | null>(null);
  const [speedTesting, setSpeedTesting] = useState(false);
  const [speedErr, setSpeedErr] = useState<string | null>(null);

  // Subscribe to navigator.onLine changes so the status chip stays accurate.
  const [navOnline, setNavOnline] = useState<boolean>(() => typeof navigator === "undefined" || navigator.onLine);
  useEffect(() => {
    const on = () => setNavOnline(true);
    const off = () => setNavOnline(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
    };
  }, []);

  /* ── W-153/W-167/W-168/W-169/P2-8 网络监控增强 ── */
  const [traffic, setTraffic] = useState<TrafficSummary | null>(null);
  const [trafficDays, setTrafficDays] = useState<TrafficDay[]>([]);
  const [adapters, setAdapters] = useState<NetworkDetail[]>([]);
  const [conns, setConns] = useState<TcpConnectionInfo[]>([]);
  const [connsLoading, setConnsLoading] = useState(false);
  const [tbNet, setTbNet] = useState(false);

  useEffect(() => {
    if (!isTauri()) return;
    let alive = true;
    const loadTraffic = () => {
      void invoke<TrafficSummary>("get_traffic_summary")
        .then((d) => {
          if (alive) setTraffic(d);
        })
        .catch(() => {});
      void invoke<TrafficDay[]>("get_traffic_daily", { days: 7 })
        .then((d) => {
          if (alive) setTrafficDays(d ?? []);
        })
        .catch(() => {});
    };
    loadTraffic();
    // 流量每分钟自动刷新（记录器 60s 落库一次，更频无意义）。
    const iv = window.setInterval(loadTraffic, 60_000);
    void invoke<NetworkDetail[]>("get_network_details")
      .then((d) => {
        if (alive) setAdapters(d ?? []);
      })
      .catch(() => {});
    void invoke<boolean>("get_taskbar_net_enabled")
      .then((v) => {
        if (alive) setTbNet(!!v);
      })
      .catch(() => {});
    return () => {
      alive = false;
      window.clearInterval(iv);
    };
  }, []);

  const loadConns = () => {
    setConnsLoading(true);
    void invoke<TcpConnectionInfo[]>("get_tcp_connections")
      .then((d) => setConns((d ?? []).filter((c) => c.state !== "LISTEN").slice(0, 60)))
      .catch(() => setConns([]))
      .finally(() => setConnsLoading(false));
  };

  const toggleTbNet = (on: boolean) => {
    // 乐观翻转；后端失败回退并提示，避免开关停在未生效的状态上。
    setTbNet(on);
    void invoke("set_taskbar_net_enabled", { enabled: on }).catch(() => {
      setTbNet(!on);
      showToast(tr("任务栏网速条开启失败"), "error");
    });
  };

  const runTest = async () => {
    setTesting(true);
    setConn(null);
    const result = await testConnectivity();
    setConn(result);
    setTesting(false);
  };

  const runSpeed = async () => {
    setSpeedTesting(true);
    setSpeedErr(null);
    setSpeed(null);
    try {
      const result = await measureDownloadSpeed();
      setSpeed(result);
    } catch {
      setSpeedErr(tr("无法测速，请检查网络连接。"));
    } finally {
      setSpeedTesting(false);
    }
  };

  const applyCity = async (city: string) => {
    const trimmed = city.trim();
    if (!trimmed) return;
    setGeo("loading");
    setGeoMsg(null);
    const result = await geocodeCity(trimmed);
    if (result) {
      s.setExtra({ weatherCity: result.name, weatherLat: result.lat, weatherLon: result.lon });
      setGeo("done");
      setGeoMsg(`${tr("已定位：")}${result.name}（${result.lat.toFixed(2)}, ${result.lon.toFixed(2)}）`);
    } else {
      setGeo("fail");
      setGeoMsg(tr("未找到该城市，请检查名称后重试。"));
    }
  };

  const locate = async () => {
    setGeo("loading");
    setGeoMsg(null);
    const pos = await getCurrentPosition();
    if (pos) {
      s.setExtra({ weatherLat: pos.lat, weatherLon: pos.lon, weatherCity: "当前位置" });
      setGeo("done");
      setGeoMsg(tr("已使用设备当前位置。"));
    } else {
      setGeo("fail");
      setGeoMsg(tr("无法获取当前位置，请检查系统定位权限。"));
    }
  };

  /* §4.7 IP 自动定位：开启开关即定位一次并回填主城市；「重新定位」强制跳过
     24h 缓存。失败只弹 toast 提示沿用手动城市，绝不改动已有坐标。 */
  const [ipLocating, setIpLocating] = useState(false);
  const runIpLocate = async (force: boolean) => {
    setIpLocating(true);
    setGeoMsg(null);
    const result = await fetchIpGeo({ force });
    setIpLocating(false);
    if (result) {
      s.setExtra({ weatherCity: result.city, weatherLat: result.lat, weatherLon: result.lon });
      setGeo("done");
      setGeoMsg(`${tr("已定位：")}${result.city}（${result.lat.toFixed(2)}, ${result.lon.toFixed(2)}）`);
    } else {
      setGeo("fail");
      setGeoMsg(tr("自动定位失败，沿用手动城市"));
      showToast(tr("自动定位失败，沿用手动城市"), "error");
    }
  };
  const toggleAutoLocate = (on: boolean) => {
    s.setExtra({ weatherAutoLocate: on });
    if (on) {
      void runIpLocate(false);
    } else {
      // 关闭即清缓存：不留本机定位痕迹，下次开启重新获取。
      clearIpGeoCache();
    }
  };

  // 附加城市：定位成功后追加到 weatherCities（去重，上限 8）。
  const addExtraCity = async () => {
    const trimmed = extraDraft.trim();
    if (!trimmed) return;
    setExtraBusy(true);
    const result = await geocodeCity(trimmed);
    setExtraBusy(false);
    if (!result) {
      setGeo("fail");
      setGeoMsg(tr("未找到该城市，请检查名称后重试。"));
      return;
    }
    const next = [...ex.weatherCities];
    if (next.some((c) => c.name === result.name) || result.name === ex.weatherCity) {
      setGeo("fail");
      setGeoMsg(tr("该城市已在列表中。"));
      return;
    }
    next.push({ name: result.name, lat: result.lat, lon: result.lon });
    s.setExtra({ weatherCities: next.slice(0, 8) });
    setExtraDraft("");
    setGeo("done");
    setGeoMsg(`${tr("已添加：")}${result.name}`);
  };

  const removeExtraCity = (name: string) => {
    s.setExtra({ weatherCities: ex.weatherCities.filter((c) => c.name !== name) });
  };

  /* #47：chip 退场先播 160ms 缩放淡出再真正移除。 */
  const [chipOut, setChipOut] = useState<string | null>(null);
  const removeChipSoon = (name: string) => {
    if (chipOut === name) return;
    setChipOut(name);
    safeTimeout(() => {
      removeExtraCity(name);
      setChipOut(null);
    }, 160);
  };

  return (
    <>
      <section className="tm-section">
        <div className="tm-section-title">
          <FxText text={tr("网络状态")} />
        </div>
        <div className="tm-conn-card">
          <div className="tm-conn-row">
            <span className="tm-conn-label">{tr("网络连接")}</span>
            <span className={`tm-conn-badge ${navOnline ? "ok" : "off"}`}>
              <span className="tm-conn-dot" />
              {navOnline ? tr("在线") : tr("离线")}
            </span>
          </div>
          <div className="tm-conn-row">
            <span className="tm-conn-label">{tr("测速")}</span>
            <button className="tm-btn-secondary" onClick={runTest} disabled={testing}>
              {testing ? (
                <>
                  <span className="tm-spinner" />
                  {tr("测试中…")}
                </>
              ) : (
                tr("测试连接")
              )}
            </button>
          </div>
          <div className="tm-conn-row">
            <span className="tm-conn-label">{tr("网速测试")}</span>
            <button className="tm-btn-secondary" onClick={runSpeed} disabled={speedTesting}>
              {speedTesting ? (
                <>
                  <span className="tm-spinner" />
                  {tr("测速中…")}
                </>
              ) : (
                tr("测网速")
              )}
            </button>
          </div>
          {conn && (
            <div className={`tm-conn-result ${conn.online ? "ok" : "err"}`}>
              {conn.online ? (
                <>{tr("连接正常 · 延迟 {n}ms", { n: conn.latencyMs ?? 0 })}</>
              ) : (
                tr("无法访问外网，请检查网络或代理设置")
              )}
            </div>
          )}
          {speed && (
            <div className="tm-speed-result">
              <div className="tm-speed-main">
                <span className="tm-speed-value" key={speed.downloadMbps}>
                  {speed.downloadMbps}
                </span>
                <span className="tm-speed-unit">Mbps</span>
                <span className="tm-speed-bytes">{formatByteRate(mbpsToBps(speed.downloadMbps))}</span>
              </div>
              <div className="tm-speed-meta">
                <span className="tm-speed-chip">
                  {tr("峰值")} {speed.peakMbps} Mbps · {formatByteRate(mbpsToBps(speed.peakMbps))}
                </span>
                <span className="tm-speed-chip">
                  {tr("谷值")} {speed.valleyMbps} Mbps · {formatByteRate(mbpsToBps(speed.valleyMbps))}
                </span>
                <span className="tm-speed-chip">
                  {tr("平均")} {speed.downloadMbps} Mbps · {formatByteRate(mbpsToBps(speed.downloadMbps))}
                </span>
                <span className="tm-speed-chip">
                  {tr("用时")} {speed.durationMs}ms · {Math.round(speed.bytes / 1024)} KB
                </span>
              </div>
            </div>
          )}
          {speedErr && <div className="tm-conn-result err">{speedErr}</div>}
        </div>
      </section>

      <div className="tm-divider" />

      <section className="tm-section">
        <div className="tm-section-title">{tr("网络")}</div>
        <div className="tm-setting-row">
          <div className="tm-setting-text">
            <span className="tm-setting-title">{tr("网络超时")}</span>
            <span className="tm-setting-desc">{tr("在线请求的超时秒数（作用于天气等小组件）")}</span>
          </div>
          <Slider
            label="网络超时"
            value={ex.networkTimeout}
            min={3}
            max={60}
            step={1}
            suffix="s"
            onChange={(v) => s.setExtraDebounced({ networkTimeout: v })}
          />
        </div>

        {/* W-167 网速显示选项（经典网速工具式全局口径，作用于所有监控组件）。 */}
        <NetToggleRow
          title={tr("按 bit 计速")}
          desc={tr("以 bps/Kbps/Mbps 显示（默认按字节）")}
          on={ex.netRateBits}
          onChange={(v) => s.setExtra({ netRateBits: v })}
        />
        <NetToggleRow
          title={tr("简洁模式")}
          desc={tr("单位紧跟数字（1.2M/s）并少一位小数")}
          on={ex.netRateCompact}
          onChange={(v) => s.setExtra({ netRateCompact: v })}
        />
        <NetToggleRow
          title={tr("隐藏单位")}
          desc={tr("速率只显示数字")}
          on={ex.netRateHideUnit}
          onChange={(v) => s.setExtra({ netRateHideUnit: v })}
        />
        <NetToggleRow
          title={tr("上下行交换")}
          desc={tr("速率行 ↑ 在前（默认 ↓ 在前）")}
          on={ex.netSwapUpDown}
          onChange={(v) => s.setExtra({ netSwapUpDown: v })}
        />

        {/* W-153 流量统计（记录器常驻采样，挂机期间也计入）。 */}
        <div className="tm-setting-row">
          <div className="tm-setting-text">
            <span className="tm-setting-title">{tr("流量统计")}</span>
            <span className="tm-setting-desc">
              {traffic
                ? `${tr("今日")} ${formatBytesTotal(traffic.today_rx + traffic.today_tx)} · ${tr("本月")} ${formatBytesTotal(traffic.month_rx + traffic.month_tx)}`
                : tr("按天累计本机收发流量")}
            </span>
          </div>
          <span className="tm-conn-label">
            {traffic ? `↓${formatBytesTotal(traffic.today_rx)} ↑${formatBytesTotal(traffic.today_tx)}` : "—"}
          </span>
        </div>
        {trafficDays.length > 0 && (
          <div className="tm-setting-row">
            <div className="tm-setting-text">
              <span className="tm-setting-title">{tr("近 7 天")}</span>
              <span className="tm-setting-desc">
                {trafficDays
                  .slice()
                  .reverse()
                  .map((d) => `${d.day.slice(5)} ${formatBytesTotal(d.rx + d.tx)}`)
                  .join(" · ")}
              </span>
            </div>
          </div>
        )}

        {/* W-170 阈值告警（判定在 Rust 记录器线程，常驻生效）。 */}
        <NetToggleRow
          title={tr("网速告警")}
          desc={tr("持续超过阈值时系统通知，回落后重新武装")}
          on={ex.netSpeedAlert}
          onChange={(v) => s.setExtra({ netSpeedAlert: v })}
        />
        {ex.netSpeedAlert && (
          <div className="tm-setting-row">
            <div className="tm-setting-text">
              <span className="tm-setting-title">{tr("网速阈值")}</span>
            </div>
            <Slider
              label="网速阈值"
              value={ex.netSpeedAlertMbps}
              min={1}
              max={500}
              step={1}
              suffix="Mbps"
              onChange={(v) => s.setExtraDebounced({ netSpeedAlertMbps: v })}
            />
          </div>
        )}
        <NetToggleRow
          title={tr("日流量告警")}
          desc={tr("当日收发合计超过阈值时通知一次")}
          on={ex.netTrafficAlert}
          onChange={(v) => s.setExtra({ netTrafficAlert: v })}
        />
        {ex.netTrafficAlert && (
          <div className="tm-setting-row">
            <div className="tm-setting-text">
              <span className="tm-setting-title">{tr("流量阈值")}</span>
            </div>
            <Slider
              label="流量阈值"
              value={ex.netTrafficAlertGB}
              min={1}
              max={200}
              step={1}
              suffix="GB"
              onChange={(v) => s.setExtraDebounced({ netTrafficAlertGB: v })}
            />
          </div>
        )}

        {/* W-171 / P2-8 任务栏网速条（贴靠托盘左侧，经典网速工具形态）。 */}
        <NetToggleRow
          title={tr("任务栏网速条")}
          desc={tr("在系统任务栏托盘区左侧显示实时网速")}
          on={tbNet}
          onChange={toggleTbNet}
        />

        {/* W-168 网卡详情（GetAdaptersAddresses，与速率监控同名关联）。 */}
        {adapters.length > 0 && (
          <div className="tm-setting-row">
            <div className="tm-setting-text">
              <span className="tm-setting-title">{tr("网卡")}</span>
              <span className="tm-setting-desc">
                {adapters
                  .map(
                    (a) =>
                      `${a.name}${a.link_mbps > 0 ? ` · ${a.link_mbps >= 1000 ? `${(a.link_mbps / 1000).toFixed(1)}G` : `${Math.round(a.link_mbps)}M`}bps` : ""} · ${a.oper_status === "up" ? tr("已连接") : tr("未连接")}`
                  )
                  .join("；")}
              </span>
            </div>
          </div>
        )}
        {adapters.some((a) => a.mac) && (
          <div className="tm-setting-row">
            <div className="tm-setting-text">
              <span className="tm-setting-title">{tr("地址")}</span>
              <span className="tm-setting-desc">
                {adapters
                  .filter((a) => a.mac)
                  .map(
                    (a) =>
                      `${a.name}: ${a.mac}${a.ips.length ? ` · ${a.ips[0]}` : ""}${a.gateway ? ` → ${a.gateway}` : ""}`
                  )
                  .join("；")}
              </span>
            </div>
          </div>
        )}

        {/* W-169 当前连接（TCP 表 + 归属进程；按需刷新）。 */}
        <div className="tm-setting-row">
          <div className="tm-setting-text">
            <span className="tm-setting-title">{tr("当前连接")}</span>
            <span className="tm-setting-desc">
              {conns.length > 0
                ? conns
                    .slice(0, 12)
                    .map((c) => `${c.process || `PID ${c.pid}`} → ${c.remote}`)
                    .join("；")
                : tr("查看本机对外 TCP 连接及其归属进程")}
            </span>
          </div>
          <button className="tm-btn-secondary" onClick={loadConns} disabled={connsLoading}>
            {connsLoading ? (
              <>
                <span className="tm-spinner" />
                {tr("获取中…")}
              </>
            ) : (
              tr("刷新连接")
            )}
          </button>
        </div>
      </section>

      <div className="tm-divider" />

      <section className="tm-section">
        <div className="tm-section-title">{tr("位置")}</div>
        <div className="tm-setting-row">
          <div className="tm-setting-text">
            <span className="tm-setting-title">{tr("天气城市")}</span>
            <span className="tm-setting-desc">{tr("输入后点「定位」自动换算经纬度")}</span>
          </div>
          <div className="tm-location-controls">
            <input
              className="tm-text-input"
              value={ex.weatherCity}
              placeholder={tr("输入城市名称")}
              aria-label={tr("天气城市")}
              onChange={(e) => s.setExtra({ weatherCity: e.target.value || "" })}
            />
            <button className="tm-btn-secondary" onClick={() => applyCity(ex.weatherCity)} disabled={geo === "loading"}>
              {geo === "loading" ? (
                <>
                  <span className="tm-spinner" />
                  {tr("定位中…")}
                </>
              ) : (
                tr("定位")
              )}
            </button>
            <button className="tm-btn-secondary" onClick={locate} disabled={geo === "loading"}>
              {geo === "loading" ? <span className="tm-spinner" /> : tr("使用当前位置")}
            </button>
          </div>
        </div>
        <SettingRow icon={MapPin} title="自动定位（IP）" desc="自动获取城市并回填" highlighted={ex.weatherAutoLocate}>
          {ex.weatherAutoLocate && (
            <button className="tm-btn-secondary" onClick={() => void runIpLocate(true)} disabled={ipLocating}>
              {ipLocating ? (
                <>
                  <span className="tm-spinner" />
                  {tr("定位中…")}
                </>
              ) : (
                tr("重新定位")
              )}
            </button>
          )}
          <Toggle on={ex.weatherAutoLocate} onChange={toggleAutoLocate} ariaLabel={tr("自动定位（IP）")} />
        </SettingRow>
        <div className="tm-setting-row">
          <div className="tm-setting-text">
            <span className="tm-setting-title">{tr("坐标")}</span>
            <span className="tm-setting-desc">{tr("纬度 / 经度（天气小组件据此请求）")}</span>
          </div>
          <span className="tm-coord">
            ({ex.weatherLat.toFixed(2)}, {ex.weatherLon.toFixed(2)})
          </span>
        </div>
        <div className="tm-setting-row">
          <div className="tm-setting-text">
            <span className="tm-setting-title">{tr("附加城市")}</span>
            <span className="tm-setting-desc">{tr("添加后可在天气小组件顶部切换，最多 8 个")}</span>
          </div>
          <div className="tm-location-controls">
            <input
              className="tm-text-input"
              value={extraDraft}
              placeholder={tr("输入城市名称")}
              aria-label={tr("附加城市")}
              onChange={(e) => setExtraDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void addExtraCity();
              }}
            />
            <button className="tm-btn-secondary" onClick={() => void addExtraCity()} disabled={extraBusy}>
              {extraBusy ? (
                <>
                  <span className="tm-spinner" />
                  {tr("定位中…")}
                </>
              ) : (
                tr("添加")
              )}
            </button>
          </div>
        </div>
        {ex.weatherCities.length > 0 && (
          <div className="tm-city-chips">
            {ex.weatherCities.map((c) => (
              <span className={`tm-city-chip${chipOut === c.name ? " is-closing" : ""}`} key={c.name}>
                {tr(c.name)}
                <button
                  className="tm-city-chip-x"
                  onClick={() => removeChipSoon(c.name)}
                  aria-label={`${tr("删除")}${c.name}`}
                  title={tr("删除")}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}
        {geoMsg && <div className={`tm-geo-msg ${geo === "fail" ? "err" : ""}`}>{geoMsg}</div>}
      </section>
    </>
  );
}

/** 网络监控区的通用开关行（W-167 显示选项 / W-170 告警 / P2-8 任务栏条）。 */
function NetToggleRow({
  title,
  desc,
  on,
  onChange
}: {
  title: string;
  desc: string;
  on: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="tm-setting-row">
      <div className="tm-setting-text">
        <span className="tm-setting-title">{title}</span>
        <span className="tm-setting-desc">{desc}</span>
      </div>
      <Toggle on={on} onChange={onChange} ariaLabel={title} />
    </div>
  );
}
