/**
 * 便签类小组件的设置页配置表单（便签、习惯、回收站等）：
 * 排序方式、显示开关与提醒选项。
 */
import { useState, type CSSProperties } from "react";
import { useSettingsStore } from "../../../store/settings-store";
import { emptyTrash, loadTrash, purgeTrash, restoreFromTrash, type TrashNote } from "../../../widget/notes-store";
import { useT } from "../../../i18n-lite";
import { confirmDialog } from "../../../components/PromptDialog";
import type { WidgetConfig } from "../../../widget/widget-config";
import { Segmented, SettingToggleRow } from "../shared";
import { M3Slider as Slider } from "../../../components/ui/M3Slider";

export function NotesConfig({
  config,
  update,
  instanceId
}: {
  config: WidgetConfig;
  update: (p: Partial<WidgetConfig>) => void;
  instanceId: string;
}) {
  const tr = useT();
  const [trash, setTrash] = useState<TrashNote[]>(() => loadTrash(instanceId));
  const refresh = () => setTrash(loadTrash(instanceId));
  return (
    <>
      <div className="tm-setting-row">
        <div className="tm-setting-text">
          <span className="tm-setting-title">{tr("字号")}</span>
          <span className="tm-setting-desc">{tr("便签文字大小")}</span>
        </div>
        <Segmented
          value={(config.fontSize as string) || "medium"}
          onChange={(v) => update({ fontSize: v })}
          options={[
            { id: "small", label: "小" },
            { id: "medium", label: "中" },
            { id: "large", label: "大" }
          ]}
        />
      </div>
      <div className="tm-setting-row">
        <div className="tm-setting-text">
          <span className="tm-setting-title">{tr("排序")}</span>
          <span className="tm-setting-desc">{tr("便签的排序方式")}</span>
        </div>
        <Segmented
          value={(config.sortBy as string) || "newest"}
          onChange={(v) => update({ sortBy: v })}
          options={[
            { id: "newest", label: "最新" },
            { id: "oldest", label: "最旧" },
            { id: "manual", label: "手动" }
          ]}
        />
      </div>
      <SettingToggleRow
        title="显示时间"
        desc="在便签下方显示相对时间"
        on={config.showDate !== false}
        onChange={(v) => update({ showDate: v })}
      />
      <SettingToggleRow
        title="显示便签计数"
        desc="在底部显示便签总数"
        on={config.showCount !== false}
        onChange={(v) => update({ showCount: v })}
      />
      <SettingToggleRow
        title="显示搜索框"
        desc="在顶部显示便签搜索框"
        on={config.showSearch !== false}
        onChange={(v) => update({ showSearch: v })}
      />
      <SettingToggleRow
        title="显示空状态提示"
        desc="没有便签时显示提示信息"
        on={config.showEmptyState !== false}
        onChange={(v) => update({ showEmptyState: v })}
      />
      <SettingToggleRow
        title="Markdown 渲染"
        desc="支持标题、清单、代码、链接与 #标签"
        on={config.markdown !== false}
        onChange={(v) => update({ markdown: v })}
      />
      <SettingToggleRow
        title="显示标签栏"
        desc="在搜索框下方显示 #标签 筛选"
        on={config.showTagBar !== false}
        onChange={(v) => update({ showTagBar: v })}
      />
      <div className="tm-section-title" style={{ marginTop: 4 }}>
        {tr("回收站")}
      </div>
      {trash.length === 0 ? (
        <p className="tm-placeholder">{tr("回收站为空")}</p>
      ) : (
        <>
          {trash.map((t, i) => (
            <div className="tm-notes-trash-row" key={t.id} style={{ "--sti": i } as CSSProperties}>
              <span className="tm-notes-trash-text">{t.text}</span>
              <button
                className="tm-notes-trash-btn"
                onClick={() => {
                  restoreFromTrash(instanceId, t.id);
                  refresh();
                }}
                data-interactive
              >
                {tr("恢复")}
              </button>
              <button
                className="tm-notes-trash-btn danger"
                onClick={async () => {
                  /* B1：彻底删除不可恢复，补确认（对齐小组件回收站标准）。 */
                  if (
                    await confirmDialog({
                      title: tr("彻底删除"),
                      message: tr("该便签将被永久删除，无法恢复。"),
                      confirmLabel: tr("删除"),
                      danger: true
                    })
                  ) {
                    purgeTrash(instanceId, t.id);
                    refresh();
                  }
                }}
                data-interactive
              >
                {tr("删除")}
              </button>
            </div>
          ))}
          <div className="tm-notes-trash-actions">
            <button
              className="tm-notes-trash-clear"
              onClick={async () => {
                if (
                  await confirmDialog({
                    title: tr("清空回收站"),
                    message: tr("所有已删便签将被永久删除。"),
                    confirmLabel: tr("清空"),
                    danger: true
                  })
                ) {
                  emptyTrash(instanceId);
                  refresh();
                }
              }}
              data-interactive
            >
              {tr("清空回收站")}
            </button>
          </div>
        </>
      )}
    </>
  );
}

export function BookmarksConfig({
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
          <span className="tm-setting-title">{tr("布局")}</span>
          <span className="tm-setting-desc">{tr("书签的展示方式")}</span>
        </div>
        <Segmented
          value={(config.layout as string) || "list"}
          onChange={(v) => update({ layout: v })}
          options={[
            { id: "list", label: "列表" },
            { id: "grid", label: "网格" }
          ]}
        />
      </div>
      <div className="tm-setting-row">
        <div className="tm-setting-text">
          <span className="tm-setting-title">{tr("排序")}</span>
          <span className="tm-setting-desc">{tr("书签的排序方式")}</span>
        </div>
        <Segmented
          value={(config.sortBy as string) || "newest"}
          onChange={(v) => update({ sortBy: v })}
          options={[
            { id: "newest", label: "最新" },
            { id: "name", label: "名称" },
            { id: "manual", label: "手动" }
          ]}
        />
      </div>
      <SettingToggleRow
        title="显示网站图标"
        desc="自动获取网站 favicon，失败时回退首字母头像"
        on={config.showFavicon !== false}
        onChange={(v) => update({ showFavicon: v })}
      />
      <SettingToggleRow
        title="显示搜索框"
        desc="在书签列表上方按名称/网址/分组过滤"
        on={config.showSearch !== false}
        onChange={(v) => update({ showSearch: v })}
      />
    </>
  );
}

export function FilesConfig({ config, update }: { config: WidgetConfig; update: (p: Partial<WidgetConfig>) => void }) {
  /* C8：标量 selector 替代整店订阅（fileBrowserRoot 每键 setExtra 时不再
     重渲其它整店订阅者）。 */
  const fileBrowserRoot = useSettingsStore((s) => s.extra.fileBrowserRoot);
  const setExtra = useSettingsStore((s) => s.setExtra);
  const tr = useT();
  const sortBy = (config.sortBy as string) || "name";
  const sortOrder = (config.sortOrder as string) || "asc";
  return (
    <>
      <SettingToggleRow
        title="显示隐藏文件"
        desc="在文件浏览器中显示隐藏文件"
        on={!!config.showHidden}
        onChange={(v) => update({ showHidden: v })}
      />
      <SettingToggleRow
        title="显示文件大小"
        desc="在文件列表中显示文件大小"
        on={config.showFileSize !== false}
        onChange={(v) => update({ showFileSize: v })}
      />
      <SettingToggleRow
        title="显示修改日期"
        desc="在文件列表中显示最后修改日期"
        on={config.showModifiedDate !== false}
        onChange={(v) => update({ showModifiedDate: v })}
      />
      {/* 排序选项。 */}
      <div className="tm-setting-row">
        <div className="tm-setting-text">
          <span className="tm-setting-title">{tr("排序依据")}</span>
          <span className="tm-setting-desc">{tr("目录始终排在文件前面")}</span>
        </div>
        <div className="tm-segmented">
          {[
            ["name", tr("名称")],
            ["size", tr("大小")],
            ["modified", tr("修改时间")]
          ].map(([v, label]) => (
            <button
              key={v}
              className={sortBy === v ? "on" : ""}
              aria-pressed={sortBy === v}
              onClick={() => update({ sortBy: v })}
              data-interactive
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      <div className="tm-setting-row">
        <div className="tm-setting-text">
          <span className="tm-setting-title">{tr("排序方向")}</span>
          <span className="tm-setting-desc">{tr("升序或降序")}</span>
        </div>
        <div className="tm-segmented">
          {[
            ["asc", tr("升序")],
            ["desc", tr("降序")]
          ].map(([v, label]) => (
            <button
              key={v}
              className={sortOrder === v ? "on" : ""}
              aria-pressed={sortOrder === v}
              onClick={() => update({ sortOrder: v })}
              data-interactive
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      {/* 快捷 chips。 */}
      <SettingToggleRow
        title={tr("显示快捷目录")}
        desc={tr("顶部一键直达下载/文档/图片等")}
        on={config.showChips !== false}
        onChange={(v) => update({ showChips: v })}
      />
      {/* 每实例根目录 + 路径记忆。 */}
      <div className="tm-setting-row">
        <div className="tm-setting-text">
          <span className="tm-setting-title">{tr("本组件根目录")}</span>
          <span className="tm-setting-desc">{tr("留空跟随全局默认文件夹")}</span>
        </div>
        <input
          className="tm-text-input"
          value={typeof config.root === "string" ? config.root : ""}
          placeholder={tr("跟随默认")}
          aria-label={tr("本组件根目录")}
          onChange={(e) => update({ root: e.target.value })}
          style={{ width: 200 }}
        />
      </div>
      <SettingToggleRow
        title={tr("记住浏览位置")}
        desc={tr("重启后回到最后浏览的文件夹")}
        on={config.rememberPath !== false}
        onChange={(v) => update({ rememberPath: v })}
      />
      {/* BentoDesk 借鉴 #4：实时同步（目录变化即时静默刷新；绑定失败自动
          回退 20s 轮询）。放完整编辑器而非快捷配置（quick ≤5 项守卫）。 */}
      <SettingToggleRow
        title={tr("实时同步目录")}
        desc={tr("目录内容变化即时刷新（不可用时自动回退 20 秒轮询）")}
        on={config.liveSync !== false}
        onChange={(v) => update({ liveSync: v })}
      />
      <div className="tm-setting-row">
        <div className="tm-setting-text">
          <span className="tm-setting-title">{tr("默认文件夹（全局）")}</span>
          <span className="tm-setting-desc">{tr("所有文件浏览组件的根目录（留空为桌面）")}</span>
        </div>
        <input
          className="tm-text-input"
          value={fileBrowserRoot}
          placeholder={tr("桌面")}
          aria-label={tr("默认文件夹")}
          onChange={(e) => setExtra({ fileBrowserRoot: e.target.value })}
          style={{ width: 200 }}
        />
      </div>
    </>
  );
}

/** 回收站保留期（全局设置，作用于所有屏幕分区）。 */
export function RecycleConfig() {
  /* C8：标量 selector。 */
  const days = useSettingsStore((s) => s.extra.recycleRetentionDays) || 30;
  const setExtra = useSettingsStore((s) => s.setExtra);
  const tr = useT();
  return (
    <div className="tm-setting-row">
      <div className="tm-setting-text">
        <span className="tm-setting-title">{tr("保留天数")}</span>
        <span className="tm-setting-desc">{tr("到期自动彻底清除，恢复不可逆")}</span>
      </div>
      <div className="tm-segmented">
        {[7, 15, 30, 60, 90].map((d) => (
          <button
            key={d}
            aria-pressed={days === d}
            className={days === d ? "on" : ""}
            onClick={() => setExtra({ recycleRetentionDays: d })}
            data-interactive
          >
            {d}
          </button>
        ))}
      </div>
    </div>
  );
}

export function HabitConfig({ config, update }: { config: WidgetConfig; update: (p: Partial<WidgetConfig>) => void }) {
  return (
    <>
      <SettingToggleRow
        title="显示已完成"
        desc="在列表中显示已完成的习惯"
        on={config.showCompleted !== false}
        onChange={(v) => update({ showCompleted: v })}
      />
      <SettingToggleRow
        title="显示连续天数"
        desc="在习惯卡片上显示连续打卡天数"
        on={config.showStreak !== false}
        onChange={(v) => update({ showStreak: v })}
      />
      <SettingToggleRow
        title="显示完成计数"
        desc="在标题栏显示今日完成数"
        on={config.showCount !== false}
        onChange={(v) => update({ showCount: v })}
      />
    </>
  );
}

export function TodayOverviewConfig({
  config,
  update
}: {
  config: WidgetConfig;
  update: (p: Partial<WidgetConfig>) => void;
}) {
  const tr = useT();
  const maxOf = (key: string, fallback: number) =>
    typeof config[key] === "number" && (config[key] as number) > 0 ? (config[key] as number) : fallback;
  return (
    <>
      <SettingToggleRow
        title={tr("显示今日待办")}
        desc={tr("聚合未完成任务与完成进度")}
        on={config.showTasks !== false}
        onChange={(v) => update({ showTasks: v })}
      />
      <SettingToggleRow
        title={tr("显示今日课程")}
        desc={tr("读取课程表小组件的今日课程")}
        on={config.showTimetable !== false}
        onChange={(v) => update({ showTimetable: v })}
      />
      <SettingToggleRow
        title={tr("显示今日日程")}
        desc={tr("聚合全部日历小组件的今日事件（含重复规则）")}
        on={config.showEvents !== false}
        onChange={(v) => update({ showEvents: v })}
      />
      <SettingToggleRow
        title={tr("显示截止日期")}
        desc={tr("已到期或 24 小时内的截止任务")}
        on={config.showDeadlines !== false}
        onChange={(v) => update({ showDeadlines: v })}
      />
      <SettingToggleRow
        title={tr("显示天气")}
        desc={tr("标题栏的当前天气与高低温")}
        on={config.showWeather !== false}
        onChange={(v) => update({ showWeather: v })}
      />
      <SettingToggleRow
        title={tr("显示问候语")}
        desc={tr("按时段显示问候或自定义文本")}
        on={config.showGreeting !== false}
        onChange={(v) => update({ showGreeting: v })}
      />
      <SettingToggleRow
        title={tr("显示今日专注")}
        desc={tr("今日番茄轮数与专注时长")}
        on={config.showFocus !== false}
        onChange={(v) => update({ showFocus: v })}
      />
      <div className="tm-setting-row">
        <div className="tm-setting-text">
          <span className="tm-setting-title">{tr("自定义问候语")}</span>
          <span className="tm-setting-desc">{tr("留空则按时段自动问候")}</span>
        </div>
        <input
          className="tm-text-input"
          value={typeof config.greeting === "string" ? config.greeting : ""}
          placeholder={tr("早上好")}
          aria-label={tr("自定义问候语")}
          onChange={(e) => update({ greeting: e.target.value })}
          style={{ width: 200 }}
        />
      </div>
      <div className="tm-setting-row">
        <div className="tm-setting-text">
          <span className="tm-setting-title">{tr("待办条数上限")}</span>
          <span className="tm-setting-desc">{tr("概览中最多显示的待办行数")}</span>
        </div>
        <Slider
          label="待办条数上限"
          value={maxOf("maxTasks", 5)}
          min={1}
          max={12}
          step={1}
          onChange={(v) => update({ maxTasks: v })}
        />
      </div>
      <div className="tm-setting-row">
        <div className="tm-setting-text">
          <span className="tm-setting-title">{tr("课程条数上限")}</span>
          <span className="tm-setting-desc">{tr("概览中最多显示的课程行数")}</span>
        </div>
        <Slider
          label="课程条数上限"
          value={maxOf("maxCourses", 6)}
          min={1}
          max={12}
          step={1}
          onChange={(v) => update({ maxCourses: v })}
        />
      </div>
      <div className="tm-setting-row">
        <div className="tm-setting-text">
          <span className="tm-setting-title">{tr("截止条数上限")}</span>
          <span className="tm-setting-desc">{tr("概览中最多显示的截止行数")}</span>
        </div>
        <Slider
          label="截止条数上限"
          value={maxOf("maxDeadlines", 5)}
          min={1}
          max={12}
          step={1}
          onChange={(v) => update({ maxDeadlines: v })}
        />
      </div>
      <div className="tm-setting-row">
        <div className="tm-setting-text">
          <span className="tm-setting-title">{tr("日程条数上限")}</span>
          <span className="tm-setting-desc">{tr("概览中最多显示的日历事件行数")}</span>
        </div>
        <Slider
          label="日程条数上限"
          value={maxOf("maxEvents", 5)}
          min={1}
          max={12}
          step={1}
          onChange={(v) => update({ maxEvents: v })}
        />
      </div>
    </>
  );
}

export function CountdownConfig({
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
          <span className="tm-setting-title">{tr("默认预设")}</span>
          <span className="tm-setting-desc">{tr("启动时的默认倒计时时长（分钟）")}</span>
        </div>
        <Slider
          label="默认预设"
          value={(config.defaultPreset as number) || 25}
          min={1}
          max={120}
          step={1}
          suffix="分钟"
          onChange={(v) => update({ defaultPreset: v })}
        />
      </div>
      <SettingToggleRow
        title="完成后自动循环"
        desc="倒计时结束后自动重新开始"
        on={!!config.loopAfterComplete}
        onChange={(v) => update({ loopAfterComplete: v })}
      />
      <SettingToggleRow
        title="结束时通知"
        desc="倒计时结束时弹出系统通知"
        on={config.notifyOnEnd !== false}
        onChange={(v) => update({ notifyOnEnd: v })}
      />
      <SettingToggleRow
        title="显示秒数"
        desc="在倒计时中显示秒数"
        on={config.showSeconds !== false}
        onChange={(v) => update({ showSeconds: v })}
      />
      <SettingToggleRow
        title="显示快捷预设"
        desc="在表盘下方显示常用的时长快捷按钮"
        on={config.showPresets !== false}
        onChange={(v) => update({ showPresets: v })}
      />
    </>
  );
}
