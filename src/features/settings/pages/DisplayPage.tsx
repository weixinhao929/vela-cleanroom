/**
 * 设置页 · 显示页：显示器列表（切换桌面层 / 管理分区 / 跨屏复制布局）与
 * [ANTICAPTURE] 隐私开关。变更即时生效；显示器列表由 SettingsView 统一拉取
 * 并经 props 传入（唯一数据源，避免双份 IPC 与双份订阅）。
 */
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { Copy, EyeOff, Monitor, RefreshCw } from "lucide-react";
import { invoke, isTauri } from "../../../lib/tauri";
import { useT } from "../../../i18n-lite";
import { FxText } from "../../../lib/fx";
import { useWidgetStore } from "../../../widget/widget-store";
import { copyScreenLayout } from "../../../widget/screen-layout-copy";
import { choiceDialog, confirmDialog } from "../../../components/PromptDialog";
import { useSettingsStore } from "../../../store/settings-store";
import { SettingToggleRow } from "../shared";

export type MonitorInfo = {
  id: number;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /** 缩放比（DPI scale，如 1.5 = 150%）。Rust 恒定携带；浏览器兜底对象可缺省。 */
  scale?: number;
  is_primary: boolean;
};

/** 操作反馈的停留时长：成功/失败都自动清除，不再常驻到下一次操作。 */
const MSG_AUTO_CLEAR_MS = 4000;

export function DisplayPage({
  onManage,
  monitors,
  onRefresh
}: {
  onManage?: (slot: number) => void;
  monitors: MonitorInfo[];
  /** 手动刷新入口（SettingsView 的 reloadMonitors）。热插拔靠事件，事件
      通道可能丢播（monitor.rs 备注自认），这里留一条人工兜底。 */
  onRefresh?: () => void;
}) {
  const tr = useT();
  const [applying, setApplying] = useState<number | null>(null);
  /* 反馈分成功/失败两态（错误红色），4s 自动清除——此前成功失败同一样式
     且常驻到下一次操作，错误串（如「显示器 2 不存在」）会一直挂在页脚。 */
  const [msg, setMsg] = useState<{ text: string; kind: "ok" | "error" } | null>(null);
  const msgTimer = useRef(0);
  useEffect(() => () => window.clearTimeout(msgTimer.current), []);
  const showMsg = (text: string, kind: "ok" | "error") => {
    setMsg({ text, kind });
    window.clearTimeout(msgTimer.current);
    msgTimer.current = window.setTimeout(() => setMsg(null), MSG_AUTO_CLEAR_MS);
  };
  /* 当前「视图/小组件」管理分区指向的屏（设置窗口可切换，见 SettingsView）。 */
  const managedScreen = useWidgetStore((s) => s.screenId);
  /* [ANTICAPTURE] 开关（叶子级订阅，避免整店 rerender）。 */
  const antiCapture = useSettingsStore((s) => s.extra.antiCapture);
  const setExtra = useSettingsStore((s) => s.setExtra);

  const apply = async (id: number) => {
    if (!isTauri()) return;
    setApplying(id);
    const name = monitors.find((m) => m.id === id)?.name ?? tr("显示器");
    try {
      await invoke("set_monitor", { id });
      showMsg(tr("已切换到 {name}", { name }), "ok");
    } catch {
      /* 空屏按设计没有 widget-N 窗口（screen_has_content 门控），
         set_monitor 会报「显示器 {slot} 不存在」。先按镜像对账一次（可能
         顺带建窗）再重试；仍失败才报错，错误原文照附便于诊断。 */
      try {
        await invoke("reconcile_widget_windows");
        await invoke("set_monitor", { id });
        showMsg(tr("已切换到 {name}", { name }), "ok");
      } catch (e) {
        showMsg(tr("切换失败：{err}", { err: String(e) }), "error");
      }
    } finally {
      setApplying(null);
    }
  };

  /* 跨屏布局复制：把来源屏的视图/布局整体搬到该屏（整体替换，先确认）。
      来源不再限定主屏——多块其它屏时先弹选择；仅一块时直达确认。
      copyScreenLayout 本身支持任意 from→to，此前是纯 UI 限制。 */
  const copyToScreen = async (target: MonitorInfo) => {
    const others = monitors.filter((m) => m.id !== target.id);
    if (others.length === 0) return;
    let source = others[0];
    if (others.length > 1) {
      const picked = await choiceDialog({
        title: tr("选择来源显示器"),
        message: tr("把哪块显示器上的视图与小组件布局复制到「{name}」？", { name: target.name }),
        choices: others.map((m) => ({
          label: m.name + (m.is_primary ? tr("（主显示器）") : ""),
          value: String(m.id)
        })),
        cancelLabel: tr("取消")
      });
      if (picked === null) return;
      const found = others.find((m) => String(m.id) === picked);
      if (!found) return;
      source = found;
    }
    const sourceName = source.name;
    const targetName = target.name;
    if (
      !(await confirmDialog({
        title: tr("复制布局到此屏"),
        message: tr(
          "将把「{src}」的全部视图与小组件布局复制到「{name}」，该屏现有布局会被整体替换（不可用 Ctrl+Z 撤销）。两屏实例共用同一份组件数据，复制后各自编辑互不影响。",
          { src: sourceName, name: targetName }
        ),
        confirmLabel: tr("复制"),
        danger: true
      }))
    ) {
      return;
    }
    const result = copyScreenLayout(String(source.id), String(target.id));
    if (result)
      showMsg(
        tr("已复制 {v} 个视图、{n} 个小组件到 {name}", {
          v: result.views,
          n: result.instances,
          name: targetName
        }),
        "ok"
      );
    else showMsg(tr("该显示器还没有可复制的布局", { name: sourceName }), "error");
  };

  return (
    <section className="tm-section">
      <div className="tm-section-title">
        <FxText text={tr("显示器")} />
        {/* 手动刷新兜底（事件通道可能丢播）。 */}
        {onRefresh && isTauri() && (
          <button
            className="tm-monitor-refresh"
            onClick={onRefresh}
            title={tr("刷新显示器列表")}
            aria-label={tr("刷新显示器列表")}
          >
            <RefreshCw size={13} />
          </button>
        )}
      </div>
      {/* 侧栏「视图/小组件」始终作用于当前管理分区；这里点明指向哪块屏。 */}
      <div className="tm-monitor-managed-hint">
        {tr("视图与小组件的添加、配置作用于：")}
        <b>{monitors.find((m) => String(m.id) === managedScreen)?.name ?? tr("当前管理的显示器")}</b>
      </div>
      {!isTauri() ? (
        <div className="tm-placeholder">{tr("显示器选择仅在桌面应用（Tauri）中可用。")}</div>
      ) : (
        <div className="tm-monitor-list">
          {monitors.map((m, i) => (
            <div className="tm-monitor-card" key={m.id} style={{ "--sti": i } as CSSProperties}>
              <div className="tm-monitor-info">
                <Monitor size={18} />
                <div>
                  <div className="tm-monitor-name">
                    {m.name}
                    {m.is_primary && <span className="tm-monitor-primary">{tr("主显示器")}</span>}
                  </div>
                  {/* 补槽位号（同名双屏可区分）与 DPI 缩放比（物理分辨率
                      之外的有效信息）；坐标保留便于对照系统设置里的排布。 */}
                  <div className="tm-monitor-res">
                    #{m.id + 1} · {m.width} × {m.height}
                    {typeof m.scale === "number" && m.scale > 0 && ` · ${Math.round(m.scale * 100)}%`} @ ({m.x}, {m.y})
                  </div>
                </div>
              </div>
              <div className="tm-monitor-actions">
                <button className="tm-btn-secondary" onClick={() => apply(m.id)} disabled={applying === m.id}>
                  {/* 切换中：spinner + 禁用透明度过渡（与 #79 同语言） */}
                  {applying === m.id ? (
                    <>
                      <span className="tm-spinner" />
                      {tr("切换中…")}
                    </>
                  ) : (
                    tr("在此显示器显示")
                  )}
                </button>
                {onManage &&
                  (managedScreen === String(m.id) ? (
                    <button className="tm-btn-secondary" disabled title={tr("正在管理此屏的小组件")}>
                      {tr("正在管理")}
                    </button>
                  ) : (
                    <button className="tm-btn-secondary" onClick={() => onManage(m.id)}>
                      {tr("管理此屏小组件")}
                    </button>
                  ))}
                {monitors.some((m2) => m2.id !== m.id) && (
                  <button
                    className="tm-btn-secondary"
                    onClick={() => void copyToScreen(m)}
                    title={tr("把其它显示器的视图与小组件布局整体复制到此屏")}
                  >
                    <Copy size={14} />
                    {tr("复制布局到此屏")}
                  </button>
                )}
              </div>
            </div>
          ))}
          {monitors.length === 0 && <div className="tm-placeholder">{tr("未检测到显示器。")}</div>}
        </div>
      )}
      {msg && <div className={`tm-monitor-msg${msg.kind === "error" ? " is-error" : ""}`}>{msg.text}</div>}

      {/* [ANTICAPTURE]：共享屏幕/录屏时桌面层不裸奔。
          本地照常可见，截屏/录屏/共享画面中隐藏（WDA_EXCLUDEFROMCAPTURE，
          Win10 2004+；托盘菜单「防屏幕捕获」同源勾选）。 */}
      <div className="tm-section-title" style={{ marginTop: 24 }}>
        <FxText text={tr("隐私")} />
      </div>
      <SettingToggleRow
        title="在屏幕共享/录屏中隐藏桌面层"
        desc="本地正常显示，但截屏、录屏与共享画面中不出现 Vela 的任何窗口（需要 Windows 10 2004 或更高版本）"
        icon={EyeOff}
        on={antiCapture}
        onChange={(v) => setExtra({ antiCapture: v })}
      />
    </section>
  );
}
