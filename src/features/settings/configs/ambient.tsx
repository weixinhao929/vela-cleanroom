/**
 * 环境音/氛围类小组件的设置页配置表单集合（图库、涂鸦、音乐、环境音等）。
 * 每个导出组件对应一种 widget type，经 widget-configs.tsx 统一挂载。
 */
import { useEffect, useState } from "react";
import { useT } from "../../../i18n-lite";
import { invoke, isTauri } from "../../../lib/tauri";
import type { NetworkDetail } from "../../../lib/system-stats";
import type { WidgetConfig } from "../../../widget/widget-config";
import { Dropdown, Segmented, SettingToggleRow } from "../shared";
import { M3Slider as Slider } from "../../../components/ui/M3Slider";

export function ClockConfig({ config, update }: { config: WidgetConfig; update: (p: Partial<WidgetConfig>) => void }) {
  const tr = useT();
  const TIMEZONES: { id: string; label: string }[] = [
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
  return (
    <>
      <SettingToggleRow
        title="显示秒"
        desc="在时钟上显示秒数"
        on={config.showSeconds !== false}
        onChange={(v) => update({ showSeconds: v })}
      />
      <SettingToggleRow
        title="显示日期"
        desc="在时钟下方显示日期"
        on={config.showDate !== false}
        onChange={(v) => update({ showDate: v })}
      />
      <SettingToggleRow
        title="显示星期"
        desc="在日期前显示星期"
        on={config.showWeekday !== false}
        onChange={(v) => update({ showWeekday: v })}
      />
      <SettingToggleRow
        title="透明（无底板）"
        desc="去掉小组件背景，只显示时钟文字"
        on={!!config.transparent}
        onChange={(v) => update({ transparent: v })}
      />
      <div className="tm-setting-row">
        <div className="tm-setting-text">
          <span className="tm-setting-title">{tr("时区")}</span>
          <span className="tm-setting-desc">{tr("显示的时区（默认跟随系统）")}</span>
        </div>
        <Dropdown<string>
          value={(config.timeZone as string) || "auto"}
          options={TIMEZONES}
          onChange={(v) => update({ timeZone: v })}
        />
      </div>
      <div className="tm-setting-row">
        <div className="tm-setting-text">
          <span className="tm-setting-title">{tr("显示星期的样式")}</span>
          <span className="tm-setting-desc">{tr("缩写（Mon/Tue）或完整（Monday/Tuesday）")}</span>
        </div>
        <Segmented
          value={(config.weekdayStyle as string) || "long"}
          onChange={(v) => update({ weekdayStyle: v })}
          options={[
            { id: "short", label: "缩写" },
            { id: "long", label: "完整" }
          ]}
        />
      </div>
      <div className="tm-setting-row">
        <div className="tm-setting-text">
          <span className="tm-setting-title">{tr("时间格式")}</span>
          <span className="tm-setting-desc">{tr("12 小时制或 24 小时制")}</span>
        </div>
        <Segmented
          value={(config.hour12 as boolean) ? "12h" : "24h"}
          onChange={(v) => update({ hour12: v === "12h" })}
          options={[
            { id: "12h", label: "12h" },
            { id: "24h", label: "24h" }
          ]}
        />
      </div>
      <div className="tm-setting-row">
        <div className="tm-setting-text">
          <span className="tm-setting-title">{tr("样式")}</span>
          <span className="tm-setting-desc">{tr("紧凑、标准或宽松布局")}</span>
        </div>
        <Segmented
          value={(config.style as string) || "standard"}
          onChange={(v) => update({ style: v })}
          options={[
            { id: "compact", label: "紧凑" },
            { id: "standard", label: "标准" },
            { id: "loose", label: "宽松" }
          ]}
        />
      </div>
    </>
  );
}

export function WeatherConfig({
  config,
  update
}: {
  config: WidgetConfig;
  update: (p: Partial<WidgetConfig>) => void;
}) {
  const tr = useT();
  return (
    <>
      <div className="tm-setting-row">
        <div className="tm-setting-text">
          <span className="tm-setting-title">{tr("温度单位")}</span>
          <span className="tm-setting-desc">{tr("摄氏或华氏")}</span>
        </div>
        <Segmented
          value={(config.unit as string) || "celsius"}
          onChange={(v) => update({ unit: v })}
          options={[
            { id: "celsius", label: "°C" },
            { id: "fahrenheit", label: "°F" }
          ]}
        />
      </div>
      <SettingToggleRow
        title="显示风力和湿度"
        desc="在天气信息中显示风速与湿度"
        on={config.showWindHumidity !== false}
        onChange={(v) => update({ showWindHumidity: v })}
      />
      <SettingToggleRow
        title="显示城市名"
        desc="在温度旁边显示当前城市名"
        on={config.showCity !== false}
        onChange={(v) => update({ showCity: v })}
      />
      <SettingToggleRow
        title="显示未来预报"
        desc="显示未来几天的天气预报"
        on={config.showForecast !== false}
        onChange={(v) => update({ showForecast: v })}
      />
      <SettingToggleRow
        title="显示逐时预报"
        desc="显示当前起 8 小时的温度趋势条"
        on={config.showHourly !== false}
        onChange={(v) => update({ showHourly: v })}
      />
      <SettingToggleRow
        title="显示日出日落"
        desc="显示今日日出与日落时间"
        on={config.showSunTimes !== false}
        onChange={(v) => update({ showSunTimes: v })}
      />
      <SettingToggleRow
        title="显示空气质量"
        desc="显示 AQI 空气质量指数与紫外线强度"
        on={config.showAqi !== false}
        onChange={(v) => update({ showAqi: v })}
      />
      <SettingToggleRow
        title="预警系统通知"
        desc="新气象预警到达时推送系统通知"
        on={config.alertNotify !== false}
        onChange={(v) => update({ alertNotify: v })}
      />
      <div className="tm-setting-row">
        <div className="tm-setting-text">
          <span className="tm-setting-title">{tr("刷新间隔")}</span>
          <span className="tm-setting-desc">{tr("天气数据自动刷新间隔（分钟）")}</span>
        </div>
        <Slider
          label="刷新间隔"
          value={(config.refreshInterval as number) || 30}
          min={5}
          max={120}
          step={5}
          suffix="分钟"
          onChange={(v) => update({ refreshInterval: v })}
        />
      </div>
    </>
  );
}

/** W-145 指定网卡选择行：显示时按需拉一次网卡列表（get_network_details）。 */
function AdapterSelectRow({
  show,
  value,
  onChange
}: {
  show: boolean;
  value: string;
  onChange: (name: string) => void;
}) {
  const tr = useT();
  const [adapters, setAdapters] = useState<NetworkDetail[]>([]);
  useEffect(() => {
    if (!show || !isTauri()) return;
    let alive = true;
    void invoke<NetworkDetail[]>("get_network_details")
      .then((d) => {
        if (alive) setAdapters(d ?? []);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [show]);
  if (!show) return null;
  const options = adapters.map((a) => ({ id: a.name, label: a.name }));
  return (
    <div className="tm-setting-row">
      <div className="tm-setting-text">
        <span className="tm-setting-title">{tr("选择网卡")}</span>
        <span className="tm-setting-desc">
          {adapters.length === 0 ? tr("未枚举到网卡，可稍后重试") : tr("指定后只显示该网卡的速率")}
        </span>
      </div>
      <Dropdown
        value={options.some((o) => o.id === value) ? value : ""}
        options={options.length > 0 ? options : [{ id: "", label: tr("暂无网卡") }]}
        onChange={(v) => onChange(v)}
      />
    </div>
  );
}

export function SystemMonitorConfig({
  config,
  update
}: {
  config: WidgetConfig;
  update: (p: Partial<WidgetConfig>) => void;
}) {
  const tr = useT();
  return (
    <>
      <SettingToggleRow
        title="显示 CPU"
        desc="CPU 使用率"
        on={config.showCPU !== false}
        onChange={(v) => update({ showCPU: v })}
      />
      <SettingToggleRow
        title="显示内存"
        desc="内存使用率"
        on={config.showRAM !== false}
        onChange={(v) => update({ showRAM: v })}
      />
      <SettingToggleRow
        title="显示 GPU"
        desc="GPU 使用率"
        on={config.showGPU !== false}
        onChange={(v) => update({ showGPU: v })}
      />
      <SettingToggleRow
        title="显示磁盘"
        desc="磁盘使用率"
        on={config.showDisk !== false}
        onChange={(v) => update({ showDisk: v })}
      />
      <SettingToggleRow
        title="显示网络"
        desc="网络速度"
        on={config.showNetwork !== false}
        onChange={(v) => update({ showNetwork: v })}
      />
      <SettingToggleRow
        title="紧凑模式"
        desc="使用更紧凑的布局显示监控数据"
        on={!!config.compactMode}
        onChange={(v) => update({ compactMode: v })}
      />
      <SettingToggleRow
        title={tr("趋势曲线")}
        desc={tr("每行末尾的迷你趋势曲线")}
        on={!!config.showTrend}
        onChange={(v) => update({ showTrend: v })}
      />
      <SettingToggleRow
        title={tr("全部磁盘")}
        desc={tr("显示全部磁盘（默认只显示第一块）")}
        on={!!config.showAllDisks}
        onChange={(v) => update({ showAllDisks: v })}
      />
      <SettingToggleRow
        title={tr("阈值告警")}
        desc={tr("CPU/内存 >80% 时进度条与数值变红")}
        on={config.thresholdAlert !== false}
        onChange={(v) => update({ thresholdAlert: v })}
      />
      <div className="tm-setting-row">
        <div className="tm-setting-text">
          <span className="tm-setting-title">{tr("网卡显示")}</span>
          <span className="tm-setting-desc">{tr("自动选最活跃 / 全部网卡 / 聚合速率 / 指定网卡")}</span>
        </div>
        <Segmented
          value={(config.networkMode as string) || "first"}
          onChange={(v) => update({ networkMode: v })}
          options={[
            { id: "first", label: tr("自动") },
            { id: "all", label: tr("全部") },
            { id: "aggregate", label: tr("聚合") },
            { id: "select", label: tr("指定") }
          ]}
        />
      </div>
      <AdapterSelectRow
        show={(config.networkMode as string) === "select"}
        value={(config.networkSelect as string) || ""}
        onChange={(name) => update({ networkSelect: name })}
      />
      <SettingToggleRow
        title={tr("每核小格子")}
        desc={tr("CPU 每核占用小格子（任务管理器形态）")}
        on={!!config.showCoresGrid}
        onChange={(v) => update({ showCoresGrid: v })}
      />
      <div className="tm-setting-row">
        <div className="tm-setting-text">
          <span className="tm-setting-title">{tr("刷新间隔")}</span>
          <span className="tm-setting-desc">{tr("监控数据刷新间隔（秒）")}</span>
        </div>
        <Slider
          label="刷新间隔"
          value={(config.refreshInterval as number) || 3}
          min={1}
          max={30}
          step={1}
          suffix="秒"
          onChange={(v) => update({ refreshInterval: v })}
        />
      </div>
    </>
  );
}

export function HardwareConfig({
  config,
  update
}: {
  config: WidgetConfig;
  update: (p: Partial<WidgetConfig>) => void;
}) {
  const tr = useT();
  return (
    <>
      <SettingToggleRow
        title="CPU"
        desc="显示 CPU 详情"
        on={config.showCPU !== false}
        onChange={(v) => update({ showCPU: v })}
      />
      <SettingToggleRow
        title="内存"
        desc="显示内存详情"
        on={config.showRAM !== false}
        onChange={(v) => update({ showRAM: v })}
      />
      <SettingToggleRow
        title="GPU"
        desc="显示 GPU 详情"
        on={config.showGPU !== false}
        onChange={(v) => update({ showGPU: v })}
      />
      <SettingToggleRow
        title="磁盘"
        desc="显示磁盘详情"
        on={config.showDisk !== false}
        onChange={(v) => update({ showDisk: v })}
      />
      <SettingToggleRow
        title="网络"
        desc="显示网络速度"
        on={config.showNetwork !== false}
        onChange={(v) => update({ showNetwork: v })}
      />
      <SettingToggleRow
        title="电池"
        desc="显示电池状态"
        on={config.showBattery !== false}
        onChange={(v) => update({ showBattery: v })}
      />
      <SettingToggleRow
        title="显示趋势图"
        desc="显示 CPU / 内存 / GPU 的迷你趋势图"
        on={config.showTrend !== false}
        onChange={(v) => update({ showTrend: v })}
      />
      <SettingToggleRow
        title={tr("静态信息头")}
        desc={tr("CPU/GPU 型号 + 总内存")}
        on={config.showStaticInfo !== false}
        onChange={(v) => update({ showStaticInfo: v })}
      />
      <SettingToggleRow
        title={tr("开机时长与进程数")}
        desc={tr("信息头里追加开机时长 + 进程数")}
        on={config.showUptimeProcess !== false}
        onChange={(v) => update({ showUptimeProcess: v })}
      />
      <div className="tm-setting-row">
        <div className="tm-setting-text">
          <span className="tm-setting-title">{tr("趋势窗口")}</span>
          <span className="tm-setting-desc">{tr("趋势窗口样本数（刷新间隔 × N ≈ 时间范围）")}</span>
        </div>
        <Slider
          label="趋势窗口"
          value={(config.historyLen as number) || 40}
          min={10}
          max={120}
          step={5}
          suffix={tr("点")}
          onChange={(v) => update({ historyLen: v })}
        />
      </div>
      <SettingToggleRow
        title={tr("峰值虚线")}
        desc={tr("曲线上叠加峰值虚线")}
        on={!!config.showPeak}
        onChange={(v) => update({ showPeak: v })}
      />
      <div className="tm-setting-row">
        <div className="tm-setting-text">
          <span className="tm-setting-title">{tr("刷新间隔")}</span>
          <span className="tm-setting-desc">{tr("监控数据刷新间隔（秒）")}</span>
        </div>
        <Slider
          label="刷新间隔"
          value={(config.refreshInterval as number) || 3}
          min={1}
          max={30}
          step={1}
          suffix="秒"
          onChange={(v) => update({ refreshInterval: v })}
        />
      </div>
    </>
  );
}
