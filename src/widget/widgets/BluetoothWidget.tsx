/**
 * 蓝牙设备小组件：经 Rust 列举已配对/已连接设备，展示电量与连接状态，
 * 支持连接/断开操作；设备变化由低频轮询驱动（无系统推送通道）。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  BluetoothConnected,
  Gamepad2,
  Check,
  Headphones,
  Keyboard,
  Mouse,
  Pen,
  Printer,
  RefreshCw,
  Settings,
  Smartphone,
  Watch
} from "lucide-react";
import { useWidgetConfig } from "../widget-config";
import { useT } from "../../i18n-lite";
import { invoke, isTauri } from "../../lib/tauri";
import { sourceNotify } from "../../lib/notifications";
import { openContextMenu } from "../../components/ContextMenu";
import { useSafeTimeout } from "../../lib/use-safe-timeout";

type Device = {
  name: string;
  connected: boolean;
  device_type: string;
  battery: number | null;
};

/** W-139 扩展图标集：手柄 / 打印机 / 手机 / 触控笔不再用通用图标。 */
function DeviceIcon({ type, size }: { type: string; size: number }) {
  if (type === "音频") return <Headphones size={size} />;
  if (type === "鼠标") return <Mouse size={size} />;
  if (type === "键盘") return <Keyboard size={size} />;
  if (type === "手表") return <Watch size={size} />;
  if (type === "手柄") return <Gamepad2 size={size} />;
  if (type === "打印机") return <Printer size={size} />;
  if (type === "手机") return <Smartphone size={size} />;
  if (type === "触控笔") return <Pen size={size} />;
  return <BluetoothConnected size={size} />;
}

function batteryColor(level: number | null): string {
  if (level === null) return "var(--muted, #9ca3af)";
  if (level <= 20) return "var(--danger, #ef4444)";
  if (level <= 50) return "var(--amber, #f59e0b)";
  // 健康电量走 success 语义色（此前误用 accent 品牌色，与警示档拉不开距离）。
  return "var(--success, #4ade80)";
}

/**
 * iOS-style battery ring: the device icon sits inside a circular SVG arc
 * that represents the battery level. When the battery is unknown (null) the
 * ring is drawn as a full muted circle.
 *
 * W-141：单击圆环快速连接/断开（classic 设备）；右键打开操作菜单。
 */
function BatteryRing({
  device,
  ringSize,
  showDeviceType,
  showBatteryLabel,
  showName,
  onToggle
}: {
  device: Device;
  ringSize: number;
  showDeviceType: boolean;
  showBatteryLabel: boolean;
  showName: boolean;
  onToggle: (device: Device, e: React.MouseEvent, menu?: boolean) => void;
}) {
  const tr = useT();
  const [showTooltip, setShowTooltip] = useState(false);
  const [tooltipPos, setTooltipPos] = useState<{ x: number; y: number } | null>(null);
  const tipRef = useRef<HTMLDivElement>(null);

  const radius = Math.max(10, ringSize / 2 - 4);
  const strokeWidth = Math.max(2, ringSize / 18);
  const circumference = 2 * Math.PI * radius;
  const battery = device.battery ?? 0;
  const dashLen = (battery / 100) * circumference;
  const color = batteryColor(device.battery);
  const iconSize = Math.max(12, ringSize * 0.35);

  const onMove = (e: React.MouseEvent) => {
    const tip = tipRef.current;
    const tw = tip?.offsetWidth ?? 120;
    const th = tip?.offsetHeight ?? 52;
    const gap = 12;
    let x = e.clientX + gap;
    let y = e.clientY + gap;
    if (x + tw > window.innerWidth - 8) x = e.clientX - tw - gap;
    if (y + th > window.innerHeight - 8) y = e.clientY - th - gap;
    setTooltipPos({ x: Math.max(4, x), y: Math.max(4, y) });
  };

  return (
    <>
      <div className="bt-ring-col">
        <div
          className="bt-ring-wrap"
          style={{ width: ringSize, height: ringSize }}
          role="button"
          tabIndex={0}
          aria-label={tr("单击连接/断开，右键更多操作")}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              onToggle(device, e as unknown as React.MouseEvent);
            }
          }}
          onMouseEnter={(e) => {
            setShowTooltip(true);
            onMove(e);
          }}
          onMouseMove={onMove}
          onMouseLeave={() => setShowTooltip(false)}
          onClick={(e) => onToggle(device, e)}
          onContextMenu={(e) => onToggle(device, e, true)}
          title={tr("单击连接/断开，右键更多操作")}
          data-interactive
        >
          <svg
            className="bt-ring"
            width={ringSize}
            height={ringSize}
            viewBox={`0 0 ${ringSize} ${ringSize}`}
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
          >
            <circle
              cx={ringSize / 2}
              cy={ringSize / 2}
              r={radius}
              stroke="var(--line, #e5e7eb)"
              strokeWidth={strokeWidth}
              fill="none"
            />
            <circle
              cx={ringSize / 2}
              cy={ringSize / 2}
              r={radius}
              stroke={color}
              strokeWidth={strokeWidth}
              fill="none"
              strokeLinecap="round"
              strokeDasharray={`${device.battery === null ? circumference : dashLen} ${circumference}`}
              transform={`rotate(-90 ${ringSize / 2} ${ringSize / 2})`}
              className="bt-ring-progress"
              style={{
                /* color 为 var(...) 时不能字符串拼 alpha（非法值导致整条 filter 失效），
                   改 color-mix 从颜色变量派生透明光晕。 */
                filter: `drop-shadow(0 0 6px color-mix(in srgb, ${color} 27%, transparent))`
              }}
            />
          </svg>
          <div className="bt-ring-icon">
            <DeviceIcon type={device.device_type} size={iconSize} />
          </div>
          {showBatteryLabel && (
            <div className="bt-ring-battery" style={{ color }}>
              {device.battery === null ? "—" : `${device.battery}%`}
            </div>
          )}
        </div>
        {showName && (
          <div className="bt-ring-name" title={device.name}>
            {device.name}
          </div>
        )}
      </div>
      {showTooltip &&
        tooltipPos &&
        createPortal(
          <div
            ref={tipRef}
            className="bt-tooltip"
            style={{
              left: tooltipPos.x,
              top: tooltipPos.y,
              transform: "translate(0, 0)"
            }}
          >
            <span className="bt-tooltip-name">{device.name}</span>
            {showDeviceType && <span className="bt-tooltip-type">{tr(device.device_type)}</span>}
            <span className="bt-tooltip-battery">
              {device.battery === null ? tr("电量未知") : `${device.battery}%`}
            </span>
          </div>,
          document.body
        )}
    </>
  );
}

/**
 * Bluetooth device widget — iOS-style, no header text. Reads the real paired
 * Bluetooth devices from the Rust backend (name / connection / battery).
 */
export function BluetoothWidget({ instanceId }: { instanceId: string }) {
  const tr = useT();
  const safeTimeout = useSafeTimeout();
  const [devices, setDevices] = useState<Device[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshed, setRefreshed] = useState(false);
  const [error, setError] = useState(false);
  const [ringSize, setRingSize] = useState(56);
  const containerRef = useRef<HTMLDivElement>(null);
  const loadSeq = useRef(0);
  /** 上次快照中已连接的设备名集合（W-136 断连通知的 diff 基线）。 */
  const prevConnected = useRef<Set<string> | null>(null);
  /** W-137 低电量通知去重：设备名 → 上次通知时间戳（同设备每小时最多一次）。 */
  const lowBatteryNotified = useRef<Map<string, number>>(new Map());
  const { config } = useWidgetConfig(instanceId);
  const showDisconnected = !!config.showDisconnected;
  const showDeviceType = config.showDeviceType !== false;
  const showBatteryLabel = config.showBatteryLabel === true;
  const showName = config.showName === true;
  const layout = (config.layout as string) || "grid";
  const ringGap = (config.gap as number) || (layout === "list" ? 12 : 16);
  const autoRefreshSeconds = typeof config.autoRefreshSeconds === "number" ? config.autoRefreshSeconds : 30;
  const lowBatteryThreshold = typeof config.lowBatteryThreshold === "number" ? config.lowBatteryThreshold : 20;
  const filterType = (config.filterType as string) || "all";
  const sortBy = (config.sortBy as string) || "default";

  const load = useCallback(
    async (disposed = false) => {
      if (!isTauri()) {
        if (disposed) return;
        setDevices([]);
        setError(true);
        return;
      }
      const mySeq = ++loadSeq.current;
      try {
        const list = await invoke<Device[]>("get_bluetooth_devices");
        // Discard stale results: a rapid refresh must not be overwritten by an
        // older in-flight response.
        if (disposed || mySeq !== loadSeq.current) return;
        setDevices(list ?? []);
        setError(false);

        // W-136 断连通知：与上次快照 diff，新断开的设备推系统通知
        const nowConnected = new Set(list.filter((d) => d.connected).map((d) => d.name));
        const prev = prevConnected.current;
        if (prev) {
          for (const name of prev) {
            if (!nowConnected.has(name)) {
              void sourceNotify("bluetooth", tr("蓝牙设备已断开"), name);
            }
          }
        }
        prevConnected.current = nowConnected;

        if (lowBatteryThreshold > 0) {
          const now = Date.now();
          for (const d of list) {
            if (d.battery !== null && d.battery <= lowBatteryThreshold) {
              const last = lowBatteryNotified.current.get(d.name) ?? 0;
              if (now - last > 60 * 60 * 1000) {
                lowBatteryNotified.current.set(d.name, now);
                void sourceNotify("bluetooth", tr("设备电量低"), `${d.name}：${d.battery}%`);
              }
            } else {
              lowBatteryNotified.current.delete(d.name);
            }
          }
        }
      } catch {
        if (disposed || mySeq !== loadSeq.current) return;
        setDevices([]);
        setError(true);
      }
    },
    [tr, lowBatteryThreshold]
  );

  useEffect(() => {
    let disposed = false;
    void load(disposed);
    return () => {
      disposed = true;
    };
  }, [load]);

  useEffect(() => {
    if (autoRefreshSeconds <= 0) return;
    const id = window.setInterval(() => {
      if (!document.hidden) void load();
    }, autoRefreshSeconds * 1000);
    return () => window.clearInterval(id);
  }, [autoRefreshSeconds, load]);

  // Responsive ring size: adapt to container dimensions
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        const minRing = 44;
        const gap = 12;
        const cols = Math.max(1, Math.floor((width + gap) / (minRing + gap)));
        const calculated = Math.floor((width - gap * (cols - 1)) / cols);
        const heightConstrained = Math.floor(height / 3);
        const final = Math.max(36, Math.min(calculated, heightConstrained, 72));
        setRingSize(final);
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const refresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
    setRefreshed(true);
    safeTimeout(() => setRefreshed(false), 1200);
  };

  /** W-138 打开系统「蓝牙和其他设备」设置页。 */
  const openSettings = () => {
    if (isTauri()) void invoke("open_bluetooth_settings").catch(() => {});
  };

  /** W-141 快速连接/断开：classic 设备直接切换；失败回落系统设置页。 */
  const toggleDevice = (device: Device, e: React.MouseEvent, menu = false) => {
    if (menu) {
      e.preventDefault();
      e.stopPropagation();
      openContextMenu(e, [
        {
          // 勾选态走 ctx-item-icon（同 MusicWidget 播放源菜单）；未选中传
          // null 占位保持图标列对齐，替代 "✓ "/"全角空格" 文本前缀 hack。
          label: tr(device.connected ? "断开连接" : "连接"),
          icon: device.connected ? <Check size={15} /> : null,
          onSelect: () => doToggle(device)
        },
        { type: "separator" as const },
        { label: tr("打开蓝牙设置"), onSelect: openSettings },
        { label: tr("刷新设备状态"), onSelect: () => void refresh() }
      ]);
      return;
    }
    doToggle(device);
  };

  const doToggle = (device: Device) => {
    if (!isTauri()) return;
    const next = !device.connected;
    void invoke<boolean>("bluetooth_toggle_connection", { name: device.name, connect: next })
      .then(() => {
        safeTimeout(() => void load(), 800);
      })
      .catch(() => {
        void invoke("open_bluetooth_settings").catch(() => {});
      });
  };

  const visible0 = showDisconnected ? devices : devices.filter((d) => d.connected);
  const visible = visible0
    .filter((d) => filterType === "all" || d.device_type === filterType)
    .slice()
    .sort((a, b) => {
      if (sortBy === "battery") {
        return (b.battery ?? -1) - (a.battery ?? -1) || a.name.localeCompare(b.name);
      }
      if (sortBy === "name") {
        return a.name.localeCompare(b.name, "zh-Hans-CN");
      }
      if (sortBy === "type") {
        return a.device_type.localeCompare(b.device_type, "zh-Hans-CN") || a.name.localeCompare(b.name);
      }
      return 0;
    });

  const onWidgetContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    openContextMenu(e, [
      { label: tr("打开蓝牙设置"), icon: <Settings size={14} />, onSelect: openSettings },
      { label: tr("刷新设备状态"), icon: <RefreshCw size={14} />, onSelect: () => void refresh() }
    ]);
  };

  return (
    <div className="bt bt-full" ref={containerRef} onContextMenu={onWidgetContextMenu}>
      <button
        className={`bt-refresh-float${refreshed ? " done" : ""}`}
        onClick={() => void refresh()}
        onContextMenu={(e) => e.stopPropagation()}
        aria-label={tr("刷新")}
        data-interactive
        title={refreshed ? tr("已刷新") : tr("刷新设备状态")}
      >
        <RefreshCw size={12} className={refreshing ? "spin" : ""} />
      </button>
      <div className={`bt-scroll bt-${layout}`} style={{ gap: ringGap }}>
        {error && (
          <div className="widget-empty" onClick={openSettings} title={tr("点击打开蓝牙设置")}>
            {tr("无法读取蓝牙设备")}
          </div>
        )}
        {!error && visible.length === 0 && (
          <div className="widget-empty">
            {filterType !== "all"
              ? tr("该类型暂无设备")
              : devices.length === 0
                ? tr("暂无蓝牙设备")
                : tr("暂无已连接设备")}
          </div>
        )}
        {!error &&
          visible.map((d) => (
            // Backend dedups by name, so `name` is a stable unique key. Using the
            // array index here would let React reuse a BatteryRing for a different
            // device after a re-sort, carrying over stale tooltip state.
            <BatteryRing
              key={`${d.device_type}-${d.name}`}
              device={d}
              ringSize={ringSize}
              showDeviceType={showDeviceType}
              showBatteryLabel={showBatteryLabel}
              showName={showName}
              onToggle={toggleDevice}
            />
          ))}
      </div>
    </div>
  );
}
