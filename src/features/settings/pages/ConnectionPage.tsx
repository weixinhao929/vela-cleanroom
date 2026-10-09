/**
 * 设置页 · 连接页：网络连通性测试（延迟/测速）、天气城市管理与
 * 邮箱账户配置；探测经 lib/network 的多候选源策略。
 */
import { useEffect, useRef, useState } from "react";
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
  measureUploadSpeed,
  testConnectivity,
  formatByteRate,
  formatBytesTotal,
  mbpsToBps
} from "../../../lib/network";
import type { SpeedResult } from "../../../lib/network";
import type { NetworkDetail, TcpConnectionInfo, TrafficDay, TrafficSummary } from "../../../lib/system-stats";
import { clearIpGeoCache, fetchIpGeo, readIpGeoCache } from "../../../lib/ip-geo";
import type { IpGeo } from "../../../lib/ip-geo";
import { showToast } from "../../../components/ToastHost";
import { useSafeTimeout } from "../../../lib/use-safe-timeout";

export function ConnectionPage() {
  // 字段级订阅，见 AnimationPage 注释。
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
  /* 上行测速（XHR POST → Cloudflare __up，桌面端失败回退 Rust 直连）。 */
  const [upSpeed, setUpSpeed] = useState<SpeedResult | null>(null);
  const [upTesting, setUpTesting] = useState(false);
  const [upErr, setUpErr] = useState<string | null>(null);

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

  /* ── 网络监控增强 ── */
  const [traffic, setTraffic] = useState<TrafficSummary | null>(null);
  const [trafficDays, setTrafficDays] = useState<TrafficDay[]>([]);
  const [adapters, setAdapters] = useState<NetworkDetail[]>([]);
  const [conns, setConns] = useState<TcpConnectionInfo[]>([]);
  const [connsLoading, setConnsLoading] = useState(false);
  const [tbNet, setTbNet] = useState(false);
  /* 流量统计总开关（默认关，opt-in）：关闭 = Rust 侧无常驻采样线程、
     无周期落库；开启才起线程。告警依赖采样线程，一并门控。 */
  const [statsOn, setStatsOn] = useState(false);
  const [statsBusy, setStatsBusy] = useState(false);
  /* 卸载守卫：按需命令（TCP 表）异步回来时页面可能已切走，晚到回包不再
     setState（与下方流量 effect 的 alive 同一模式，此前 loadConns 漏了）。 */
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const loadAdapters = () => {
    if (!isTauri()) return;
    void invoke<NetworkDetail[]>("get_network_details")
      .then((d) => {
        if (mountedRef.current) setAdapters(d ?? []);
      })
      .catch(() => {});
  };

  // 开关初始态：以 Rust 内存态（启动时已按持久化值同步）为准。
  useEffect(() => {
    if (!isTauri()) return;
    void invoke<boolean>("get_traffic_stats_enabled")
      .then((v) => {
        if (mountedRef.current) setStatsOn(!!v);
      })
      .catch(() => {});
  }, []);

  const toggleStats = (on: boolean) => {
    if (statsBusy) return;
    // 乐观翻转；后端失败回退并提示（与任务栏网速条开关同款）。
    setStatsOn(on);
    setStatsBusy(true);
    void invoke("set_traffic_stats_enabled", { enabled: on })
      .catch(() => {
        if (!mountedRef.current) return;
        setStatsOn(!on);
        showToast(tr("流量统计开关切换失败"), "error");
      })
      .finally(() => {
        if (mountedRef.current) setStatsBusy(false);
      });
  };

  useEffect(() => {
    if (!isTauri()) return;
    let alive = true;
    void invoke<boolean>("get_taskbar_net_enabled")
      .then((v) => {
        if (alive) setTbNet(!!v);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  // 流量汇总/历史只在开关开启时拉取与轮询：关闭状态下既不展示也不浪费
  // 周期 IPC（今日值来自记录器内存，Rust 侧未起线程时命令也会报错）。
  useEffect(() => {
    if (!isTauri() || !statsOn) return;
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
    // 流量每 20s 自动刷新：今日值来自记录器内存（10s 采样一拍，权威且含未
    // 落库增量），旧注释按「60s 落库」推的刷新周期口径不对，滞后整整一分钟。
    const iv = window.setInterval(loadTraffic, 20_000);
    return () => {
      alive = false;
      window.clearInterval(iv);
    };
  }, [statsOn]);

  // 网卡详情跟随联网状态翻转重拉：插拔网卡 / 切 WiFi / 拨 VPN 常伴随
  // online/offline 事件，比固定轮询便宜也比「仅挂载时拉一次」新鲜
  // （后者会一直显示拔线前的旧网卡表直到重开设置页）。
  useEffect(() => {
    loadAdapters();
  }, [navOnline]);

  const loadConns = () => {
    setConnsLoading(true);
    void invoke<TcpConnectionInfo[]>("get_tcp_connections")
      .then((d) => {
        if (!mountedRef.current) return;
        setConns((d ?? []).filter((c) => c.state !== "LISTEN").slice(0, 60));
      })
      .catch(() => {
        if (mountedRef.current) setConns([]);
      })
      .finally(() => {
        if (mountedRef.current) setConnsLoading(false);
      });
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

  const runUpSpeed = async () => {
    setUpTesting(true);
    setUpErr(null);
    setUpSpeed(null);
    try {
      const result = await measureUploadSpeed();
      setUpSpeed(result);
    } catch {
      setUpErr(tr("无法测上传，请检查网络连接。"));
    } finally {
      setUpTesting(false);
    }
  };

  const applyCity = async (city: string) => {
    const trimmed = city.trim();
    if (!trimmed) return;
    setGeo("loading");
    setGeoMsg(null);
    const result = await geocodeCity(trimmed);
    if (result) {
      /* 名称与坐标同一拍写入：天气小组件标题用 weatherCity、数据用
         weatherLat/Lon，分两次写会出现「新名字配旧坐标」的错位窗口。 */
      s.setExtra({ weatherCity: result.name, weatherLat: result.lat, weatherLon: result.lon });
      setGeo("done");
      const where = result.country && result.country !== result.name ? `，${result.country}` : "";
      setGeoMsg(`${tr("已定位：")}${result.name}${where}（${result.lat.toFixed(2)}, ${result.lon.toFixed(2)}）`);
    } else {
      setGeo("fail");
      setGeoMsg(tr("未找到该城市，请检查名称后重试。"));
      /* 失败回滚草稿到当前生效城市：不留「输入框一个名、坐标另一个城市」
         的不一致观感（store 从未被改，只是把草稿弹回）。 */
      setCityDraft(useSettingsStore.getState().extra.weatherCity);
    }
  };

  /* 天气城市：草稿 + 失焦 / 回车提交（UpdatePage 更新源同款）——此前每个按键
     直写 store，逐键触发重渲 + 跨窗口同步广播；外部变更（恢复备份 / 自动定位
     回填）经 effect 跟随草稿。
     提交语义（一致性修复）：名称只有伴随 geocode 成功才落库——旧实现失焦
     即写名，坐标仍是旧城市，天气组件会拿新名字渲染旧城市的天气。空输入 /
     失败回滚到生效值。 */
  const [cityDraft, setCityDraft] = useState(ex.weatherCity);
  useEffect(() => setCityDraft(ex.weatherCity), [ex.weatherCity]);
  const commitCity = () => {
    if (geo === "loading") return;
    const v = cityDraft.trim();
    if (!v || v === ex.weatherCity) {
      setCityDraft(ex.weatherCity);
      return;
    }
    void applyCity(v);
  };
  const locateCity = () => {
    if (geo === "loading") return;
    const v = cityDraft.trim();
    if (!v) return;
    void applyCity(v);
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
     24h 缓存。失败只弹 toast 提示沿用手动城市，绝不改动已有坐标。
     附带公网 IP / 国家 / 运营商展示（服务端本来就回传，无额外请求）。 */
  const [ipLocating, setIpLocating] = useState(false);
  const [ipInfo, setIpInfo] = useState<IpGeo | null>(null);
  useEffect(() => {
    // 已开启且缓存仍有效：直接展示缓存里的 IP 信息（不发请求）。
    if (useSettingsStore.getState().extra.weatherAutoLocate) setIpInfo(readIpGeoCache());
  }, []);
  const runIpLocate = async (force: boolean) => {
    // 与城市 geocode 互斥：两条路径都终写 weatherCity/lat/lon，并发时后写
    // 者胜出，消息区（geo/geoMsg 共用）也会串台成「定位成功」配旧城市。
    if (geo === "loading") return;
    setIpLocating(true);
    setGeo("loading");
    setGeoMsg(null);
    const result = await fetchIpGeo({ force });
    setIpLocating(false);
    if (result) {
      setIpInfo(result);
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
      setIpInfo(null);
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
    const cur = useSettingsStore.getState().extra.weatherCities;
    /* 满额先拒：旧实现 push 后 slice(0,8) 把新城市静默丢掉、提示却仍是
       「已添加」，用户看到成功文案但列表没变。 */
    if (cur.length >= 8) {
      setGeo("fail");
      setGeoMsg(tr("最多添加 8 个城市"));
      return;
    }
    if (cur.some((c) => c.name === result.name) || result.name === ex.weatherCity) {
      setGeo("fail");
      setGeoMsg(tr("该城市已在列表中。"));
      return;
    }
    s.setExtra({ weatherCities: [...cur, { name: result.name, lat: result.lat, lon: result.lon }] });
    setExtraDraft("");
    setGeo("done");
    setGeoMsg(`${tr("已添加：")}${result.name}`);
  };

  const removeExtraCity = (name: string) => {
    /* 现取最新表再过滤——双删场景下两个退场定时器先后落拍，渲染快照
       里的旧表会把先删掉的城市复活。 */
    s.setExtra({ weatherCities: useSettingsStore.getState().extra.weatherCities.filter((c) => c.name !== name) });
  };

  /* #47：chip 退场先播 160ms 缩放淡出再真正移除。：单值 chipOut + 共用
     定时器在快速连删两个城市时会互相腰斩退场动画（后者覆盖前者的退场态、
     并清掉前者的回退定时器）——改 Set，每个 chip 独立超时后自摘；在飞守卫
     走 ref（密集连点下闭包态可能落后）。 */
  const chipPending = useRef<Set<string>>(new Set());
  const [chipOut, setChipOut] = useState<ReadonlySet<string>>(() => new Set());
  const removeChipSoon = (name: string) => {
    if (chipPending.current.has(name)) return;
    chipPending.current.add(name);
    setChipOut((prev) => new Set(prev).add(name));
    safeTimeout(() => {
      chipPending.current.delete(name);
      removeExtraCity(name);
      setChipOut((cur) => {
        if (!cur.has(name)) return cur;
        const done = new Set(cur);
        done.delete(name);
        return done;
      });
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
            {/* 与上行互斥：两个测速并发会互相抢带宽，峰谷值双双失真。 */}
            <button className="tm-btn-secondary" onClick={runSpeed} disabled={speedTesting || upTesting}>
              {speedTesting ? (
                <>
                  <span className="tm-spinner" />
                  {tr("测速中…")}
                </>
              ) : (
                tr("测下行")
              )}
            </button>
          </div>
          <div className="tm-conn-row">
            <span className="tm-conn-label">{tr("上传测速")}</span>
            <button className="tm-btn-secondary" onClick={runUpSpeed} disabled={upTesting || speedTesting}>
              {upTesting ? (
                <>
                  <span className="tm-spinner" />
                  {tr("上传中…")}
                </>
              ) : (
                tr("测上行")
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
          {speed && <SpeedResultBlock r={speed} arrow="↓" />}
          {speedErr && <div className="tm-conn-result err">{speedErr}</div>}
          {upSpeed && <SpeedResultBlock r={upSpeed} arrow="↑" />}
          {upErr && <div className="tm-conn-result err">{upErr}</div>}
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
            /* min 与 store sanitize（1–60）对齐——此前 3 起步，跨窗同步
               写入 1–2 秒的值时滑条显示与可写范围不一致。 */
            min={1}
            max={60}
            step={1}
            suffix="s"
            onChange={(v) => s.setExtraDebounced({ networkTimeout: v })}
          />
        </div>

        {/* 网速显示选项（经典网速工具 式全局口径，作用于所有监控组件）。 */}
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

        {/* 流量统计总开关（记录器生命周期）：默认关，关闭时 Rust 侧
            无常驻采样线程、无周期落库（告警依赖采样线程，一并隐藏）。 */}
        <NetToggleRow
          title={tr("流量统计记录")}
          desc={tr("常驻线程按天记录收发流量；关闭后停止后台采样与落库")}
          on={statsOn}
          onChange={toggleStats}
        />
        {statsOn ? (
          <>
            {/* 流量统计（记录器常驻采样，挂机期间也计入）。 */}
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

            {/* 阈值告警（判定在 Rust 记录器线程，常驻生效）。 */}
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
          </>
        ) : (
          <div className="tm-setting-row">
            <div className="tm-setting-text">
              <span className="tm-setting-desc">
                {tr("开启后记录今日 / 本月 / 近 7 天流量，并解锁网速与日流量告警；不开启则无后台采样")}
              </span>
            </div>
          </div>
        )}

        {/* 任务栏网速条（贴靠托盘左侧，经典网速工具 形态）。
            贴靠只认主屏 Shell_TrayWnd（与 经典网速工具 默认行为一致），
            提前说明避免多屏用户误判异常。 */}
        <NetToggleRow
          title={tr("任务栏网速条")}
          desc={`${tr("在系统任务栏托盘区左侧显示实时网速")} · ${tr("仅主屏任务栏（多屏时副屏不重复显示）")}`}
          on={tbNet}
          onChange={toggleTbNet}
        />

        {/* 网卡详情（GetAdaptersAddresses，与速率监控同名关联）。 */}
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
                      `${a.name}: ${a.mac}${a.ips.length ? ` · ${a.ips.slice(0, 2).join(" / ")}` : ""}${a.gateway ? ` → ${a.gateway}` : ""}${a.dns?.length ? ` · DNS ${a.dns.slice(0, 2).join(" / ")}` : ""}`
                  )
                  .join("；")}
              </span>
            </div>
          </div>
        )}

        {/* 当前连接（TCP 表 + 归属进程；按需刷新）。超过 12 条时明确
            告知总数，避免「列表就这么长」的误读。 */}
        <div className="tm-setting-row">
          <div className="tm-setting-text">
            <span className="tm-setting-title">{tr("当前连接")}</span>
            <span className="tm-setting-desc">
              {conns.length > 0
                ? `${conns
                    .slice(0, 12)
                    .map((c) => `${c.process || `PID ${c.pid}`} → ${c.remote}`)
                    .join("；")}${conns.length > 12 ? tr(" …等 {n} 条", { n: conns.length }) : ""}`
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
              value={cityDraft}
              placeholder={tr("输入城市名称")}
              aria-label={tr("天气城市")}
              onChange={(e) => setCityDraft(e.target.value)}
              onBlur={commitCity}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitCity();
              }}
            />
            <button className="tm-btn-secondary" onClick={locateCity} disabled={geo === "loading"}>
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
        <SettingRow
          icon={MapPin}
          title={tr("自动定位（IP）")}
          desc={tr("自动获取城市并回填")}
          highlighted={ex.weatherAutoLocate}
        >
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
        {ex.weatherAutoLocate && ipInfo && (
          <div className="tm-setting-row">
            <div className="tm-setting-text">
              <span className="tm-setting-title">{tr("公网出口")}</span>
              <span className="tm-setting-desc">
                {[ipInfo.ip, [ipInfo.country, ipInfo.isp].filter(Boolean).join(" · ")].filter(Boolean).join(" · ") ||
                  "—"}
              </span>
            </div>
          </div>
        )}
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
              <span className={`tm-city-chip${chipOut.has(c.name) ? " is-closing" : ""}`} key={c.name}>
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

/** 网络监控区的通用开关行（显示选项 / 告警 / 任务栏条）。 */
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

/** 测速结果块（下行 ↓ / 上行 ↑ 共用一套峰/谷/均值口径）。 */
function SpeedResultBlock({ r, arrow }: { r: SpeedResult; arrow: "↓" | "↑" }) {
  const tr = useT();
  return (
    <div className="tm-speed-result">
      <div className="tm-speed-main">
        <span className="tm-speed-value" key={`${arrow}${r.downloadMbps}`}>
          {arrow} {r.downloadMbps}
        </span>
        <span className="tm-speed-unit">Mbps</span>
        <span className="tm-speed-bytes">{formatByteRate(mbpsToBps(r.downloadMbps))}</span>
      </div>
      <div className="tm-speed-meta">
        <span className="tm-speed-chip">
          {tr("峰值")} {r.peakMbps} Mbps · {formatByteRate(mbpsToBps(r.peakMbps))}
        </span>
        <span className="tm-speed-chip">
          {tr("谷值")} {r.valleyMbps} Mbps · {formatByteRate(mbpsToBps(r.valleyMbps))}
        </span>
        <span className="tm-speed-chip">
          {tr("平均")} {r.downloadMbps} Mbps · {formatByteRate(mbpsToBps(r.downloadMbps))}
        </span>
        <span className="tm-speed-chip">
          {tr("用时")} {r.durationMs}ms · {Math.round(r.bytes / 1024)} KB
        </span>
      </div>
    </div>
  );
}
