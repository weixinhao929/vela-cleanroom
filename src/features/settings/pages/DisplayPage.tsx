/**
 * 设置页 · 显示页：界面缩放、字体与字号、小组件不透明度等显示参数；
 * 变更即时生效（CSS 变量驱动）。显示器列表由 SettingsView 统一拉取并经
 * props 传入（唯一数据源，避免双份 IPC 与双份订阅）。
 */
import { useState, type CSSProperties } from "react";
import { Copy, Monitor } from "lucide-react";
import { invoke, isTauri } from "../../../lib/tauri";
import { useT } from "../../../i18n-lite";
import { FxText } from "../../../lib/fx";
import { useWidgetStore } from "../../../widget/widget-store";
import { copyScreenLayout } from "../../../widget/screen-layout-copy";
import { confirmDialog } from "../../../components/PromptDialog";

export type MonitorInfo = {
  id: number;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  is_primary: boolean;
};

export function DisplayPage({ onManage, monitors }: { onManage?: (slot: number) => void; monitors: MonitorInfo[] }) {
  const tr = useT();
  const [applying, setApplying] = useState<number | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  /* 当前「视图/小组件」管理分区指向的屏（设置窗口可切换，见 SettingsView）。 */
  const managedScreen = useWidgetStore((s) => s.screenId);

  const apply = async (id: number) => {
    if (!isTauri()) return;
    setApplying(id);
    setMsg(null);
    try {
      await invoke("set_monitor", { id });
      setMsg(tr("已切换到 {name}", { name: monitors.find((m) => m.id === id)?.name ?? tr("显示器") }));
    } catch (e) {
      setMsg(String(e));
    } finally {
      setApplying(null);
    }
  };

  /* 跨屏布局复制：把主屏的视图/布局整体搬到该屏（整体替换，先确认）。
      副屏首用此前只能手动「导出 JSON → 切屏 → 导入」（且仅当前视图）。 */
  const copyFromPrimary = async (target: MonitorInfo) => {
    const primary = monitors.find((m) => m.is_primary);
    if (!primary || primary.id === target.id) return;
    const targetName = target.name;
    if (
      !(await confirmDialog({
        title: tr("复制布局到此屏"),
        message: tr(
          "将把主屏的全部视图与小组件布局复制到「{name}」，该屏现有布局会被整体替换（不可用 Ctrl+Z 撤销）。两屏实例共用同一份组件数据，复制后各自编辑互不影响。",
          { name: targetName }
        ),
        confirmLabel: tr("复制"),
        danger: true
      }))
    ) {
      return;
    }
    const result = copyScreenLayout(String(primary.id), String(target.id));
    setMsg(
      result
        ? tr("已复制 {v} 个视图、{n} 个小组件到 {name}", {
            v: result.views,
            n: result.instances,
            name: targetName
          })
        : tr("主屏还没有可复制的布局")
    );
  };

  return (
    <section className="tm-section">
      <div className="tm-section-title">
        <FxText text={tr("显示器")} />
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
                  <div className="tm-monitor-res">
                    {m.width} × {m.height} @ ({m.x}, {m.y})
                  </div>
                </div>
              </div>
              <div className="tm-monitor-actions">
                <button className="tm-btn-secondary" onClick={() => apply(m.id)} disabled={applying === m.id}>
                  {/* #88 切换中：spinner + 禁用透明度过渡（与 #79 同语言） */}
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
                {!m.is_primary && (
                  <button
                    className="tm-btn-secondary"
                    onClick={() => void copyFromPrimary(m)}
                    title={tr("把主屏的视图与小组件布局整体复制到此屏")}
                  >
                    <Copy size={14} />
                    {tr("复制主屏布局")}
                  </button>
                )}
              </div>
            </div>
          ))}
          {monitors.length === 0 && <div className="tm-placeholder">{tr("未检测到显示器。")}</div>}
        </div>
      )}
      {msg && <div className="tm-monitor-msg">{msg}</div>}
    </section>
  );
}
