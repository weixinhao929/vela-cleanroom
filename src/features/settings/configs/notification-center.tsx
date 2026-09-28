/**
 * 通知中心磁贴配置字段（灵动岛 → 通知中心）：把「现在添加好的」会发通知的
 * 小组件逐个列出来，让用户选择通知或不通知。
 *
 * 开关全部是全局设置（settings.notifications 的 todo / pomodoro 总开关与
 * sources 逐源开关）而非磁贴私有数据——通知派发（lib/notifications）是应用级
 * 的，通知中心磁贴只是回看入口；本页按「当前已添加」（画布实例 + 岛磁贴 +
 * 杂项面板条目，按类型去重）过滤呈现，与待办小组件配置页的「通知来源」区块
 * 共享同一份事实来源，两边任一处改动即时互通。目前没有会发通知的小组件时
 * 给占位说明而不是留白。
 */
import { useEffect, useMemo, useState } from "react";
import { useSettingsStore, type NotificationSource } from "../../../store/settings-store";
import { useWidgetStore } from "../../../widget/widget-store";
import { getWidgetMeta } from "../../../widget/registry";
import { MISC_TYPE } from "../../../widget/widgets/misc/MiscBoardPanel";
import { sanitizeMiscItems } from "../../../widget/widgets/misc/misc-layout";
import { inDndSchedule, setDnd, setDndSchedule, useDnd, useDndSchedule } from "../../../lib/dnd";
import { invoke, isTauri } from "../../../lib/tauri";
import { SYSNOTIFY_STATUS_EVENT } from "../../../lib/system-notify";
import { useT } from "../../../i18n-lite";
import { SettingToggleRow, Toggle } from "../shared";

/** 小组件类型 → 逐源开关键（与 widgets/*.tsx 的 sourceNotify 调用一一对应；
    文案与待办组件配置页的「通知来源」区块保持一致，复用其英文翻译）。 */
const SOURCE_ROWS: { type: string; source: NotificationSource; title: string; desc: string }[] = [
  { type: "habit", source: "habit", title: "习惯打卡提醒", desc: "习惯到期未打卡时提醒" },
  { type: "calendar", source: "calendar", title: "日历提醒", desc: "日历事件到点提醒" },
  { type: "timetable", source: "timetable", title: "课程表上课提醒", desc: "下节课开始前推送提醒" },
  { type: "countdown", source: "countdown", title: "倒计时结束", desc: "小组件倒计时结束时提醒" },
  { type: "email", source: "email", title: "新邮件", desc: "收到未读邮件时提醒" },
  { type: "weather", source: "weather", title: "天气预警", desc: "气象预警发布时提醒" },
  { type: "bluetooth", source: "bluetooth", title: "蓝牙设备", desc: "断连与低电量提醒" }
];

/** 待办清单 / 截止日期共用的通知行标题：按实际添加了哪个动态取名。 */
function todoRowTitle(todoLike: readonly string[]): string {
  const name = (t: string) => getWidgetMeta(t)?.name ?? t;
  if (todoLike.length === 2) return `${name("todo")} / ${name("deadlines")}提醒`;
  return `${name(todoLike[0])}提醒`;
}

export function NotificationCenterConfig() {
  const tr = useT();
  const instances = useWidgetStore((s) => s.instances);
  const dockTiles = useWidgetStore((s) => s.dock.tiles);
  const n = useSettingsStore((s) => s.notifications);
  const setN = useSettingsStore((s) => s.setNotifications);
  const dnd = useDnd();
  const sched = useDndSchedule();
  /* 一.1 权限提示：Rust sysnotify:status（access=denied）经 DOM 事件转发到此，
     提示用户去系统设置开「通知」访问权（镜像开关本身开着但收不到任何东西）。 */
  const [accessDenied, setAccessDenied] = useState(false);
  useEffect(() => {
    const onStatus = (e: Event) => {
      setAccessDenied((e as CustomEvent<{ access: string }>).detail?.access === "denied");
    };
    window.addEventListener(SYSNOTIFY_STATUS_EVENT, onStatus);
    return () => window.removeEventListener(SYSNOTIFY_STATUS_EVENT, onStatus);
  }, []);
  /** 一.1 开关翻转：镜像持久化（下次启动 Rust 读回）+ 命令即时生效。 */
  const setSystemListener = (v: boolean) => {
    setN({ systemListener: v });
    if (isTauri()) void invoke("set_sysnotify_enabled", { enabled: v }).catch(() => {});
  };
  /** 一.3 推送端口编辑：提交（blur/回车）时钳 1–65535 再落盘。 */
  const [portDraft, setPortDraft] = useState(String(n.pushPort));
  useEffect(() => setPortDraft(String(n.pushPort)), [n.pushPort]);
  const commitPort = () => {
    const parsed = Number.parseInt(portDraft, 10);
    const port = Number.isFinite(parsed) && parsed >= 1 && parsed <= 65535 ? parsed : n.pushPort;
    setN({ pushPort: port });
    setPortDraft(String(port));
  };

  /** 当前已添加的小组件类型全集（画布 + 岛磁贴 + 杂项面板，按类型去重）。 */
  const added = useMemo(() => {
    const types = new Set<string>(instances.map((i) => i.type));
    for (const t of dockTiles) {
      types.add(t.type);
      if (t.type === MISC_TYPE) {
        for (const item of sanitizeMiscItems(t.config?.items)) types.add(item.type);
      }
    }
    return types;
  }, [instances, dockTiles]);

  const setSource = (source: NotificationSource, v: boolean) => setN({ sources: { ...n.sources, [source]: v } });

  /* 会发通知的已添加小组件 → 逐行开关。待办清单与截止日期走同一条
     todoNotification 管线（DeadlinePanel 也调 todoNotification），共用
     todoEnabled 总开关，合并成一行避免两行改同一个开关的困惑。 */
  const todoLike = (["todo", "deadlines"] as const).filter((t) => added.has(t));
  const rows = [
    ...(todoLike.length > 0
      ? [
          {
            key: "todo",
            title: todoRowTitle(todoLike),
            desc: "任务或截止日期临近时提醒（两者共用一个开关）",
            on: n.todoEnabled,
            onChange: (v: boolean) => setN({ todoEnabled: v })
          }
        ]
      : []),
    ...(added.has("pomodoro")
      ? [
          {
            key: "pomodoro",
            title: "番茄钟提醒",
            desc: "专注阶段完成或达成里程碑时提醒",
            on: n.pomodoroEnabled,
            onChange: (v: boolean) => setN({ pomodoroEnabled: v })
          }
        ]
      : []),
    ...SOURCE_ROWS.filter((r) => added.has(r.type)).map((r) => ({
      key: r.source,
      title: r.title,
      desc: r.desc,
      on: n.sources[r.source] !== false,
      onChange: (v: boolean) => setSource(r.source, v)
    }))
  ];

  return (
    <>
      <SettingToggleRow title="免打扰" desc="暂停所有通知弹窗与提示音，通知历史照常留档" on={dnd} onChange={setDnd} />
      {/* 勿扰时段计划：命中时段与手动开关同效（notifications.ts 走
          dndSuppressing 终判；跨午夜时段如 22:00–08:00 支持环绕）。 */}
      <div className="tm-setting-row">
        <div className="tm-setting-text">
          <span className="tm-setting-title">{tr("按时段自动开启")}</span>
          <span className="tm-setting-desc">
            {sched.enabled && inDndSchedule(sched)
              ? tr("当前处于勿扰时段，通知已自动静音")
              : tr("时段内自动静音（支持跨午夜，如 22:00 – 08:00）")}
          </span>
        </div>
        <div className="tm-dnd-sched">
          <input
            type="time"
            value={sched.start}
            aria-label={tr("勿扰开始时间")}
            onChange={(e) => setDndSchedule({ ...sched, start: e.target.value })}
            data-interactive
          />
          <span aria-hidden="true">–</span>
          <input
            type="time"
            value={sched.end}
            aria-label={tr("勿扰结束时间")}
            onChange={(e) => setDndSchedule({ ...sched, end: e.target.value })}
            data-interactive
          />
          <Toggle
            on={sched.enabled}
            ariaLabel={tr("按时段自动开启")}
            onChange={(v) => setDndSchedule({ ...sched, enabled: v })}
          />
        </div>
      </div>
      <div className="tm-section-title" style={{ marginTop: 4 }}>
        {tr("系统与外部")}
      </div>
      <p className="tm-setting-note">{tr("来自 Windows 与外部工具的消息：留档进通知历史并触发灵动岛提示。")}</p>
      <SettingToggleRow
        title="系统通知镜像"
        desc="其它应用的 Windows 通知同步到通知中心与灵动岛"
        on={n.systemListener}
        onChange={setSystemListener}
      />
      {n.systemListener && accessDenied && (
        <p className="tm-setting-error" role="alert">
          {tr("尚未获得通知访问权限：设置 → 隐私和安全性 → 通知，允许桌面应用访问通知")}
        </p>
      )}
      <SettingToggleRow
        title="外部推送（HTTP）"
        desc="接收脚本 / 手机转发工具发来的本机消息"
        on={n.pushEnabled}
        onChange={(v) => setN({ pushEnabled: v })}
      />
      {n.pushEnabled && (
        <div className="tm-setting-row">
          <div className="tm-setting-text">
            <span className="tm-setting-title">{tr("推送端口")}</span>
            <span className="tm-setting-desc">
              POST http://127.0.0.1:{n.pushPort}/api/notify · {tr("仅本机可访问")}
            </span>
          </div>
          <input
            className="tm-push-port"
            type="number"
            min={1}
            max={65535}
            value={portDraft}
            aria-label={tr("推送端口")}
            onChange={(e) => setPortDraft(e.target.value)}
            onBlur={commitPort}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitPort();
            }}
            data-interactive
          />
        </div>
      )}
      <div className="tm-section-title" style={{ marginTop: 4 }}>
        {tr("已添加的小组件")}
      </div>
      <p className="tm-setting-note">{tr("逐个选择现在添加好的小组件是否通知；专注模式（中/深）期间自动静音。")}</p>
      {rows.length === 0 ? (
        <div className="tm-setting-row">
          <div className="tm-setting-text">
            <span className="tm-setting-title">{tr("还没有会发通知的小组件")}</span>
            <span className="tm-setting-desc">
              {tr("先在视图或灵动岛添加待办、习惯、日历等小组件，再回到这里逐个开关通知")}
            </span>
          </div>
        </div>
      ) : (
        rows.map((r) => <SettingToggleRow key={r.key} title={r.title} desc={r.desc} on={r.on} onChange={r.onChange} />)
      )}
    </>
  );
}
