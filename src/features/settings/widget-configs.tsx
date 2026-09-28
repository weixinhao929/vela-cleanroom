/**
 * 小组件配置表单注册与路由：把各 config 模块的编辑组件按 widget type
 * 组织起来，供 SettingsView 按 `widget-config-<instanceId>` 页面渲染。
 */
import { useDelayedUnmount } from "../../lib/anim";
import { animDurations } from "../../lib/durations";
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useTauriEvent } from "../../lib/use-tauri-event";
import { Check, LayoutGrid, Trash2 } from "lucide-react";
import { invoke, isTauri } from "../../lib/tauri";
import { pickFilePath } from "../../lib/file-dialog";
import { getWidgetMeta } from "../../widget/registry";
import { useWidgetStore } from "../../widget/widget-store";
import { useSettingsStore } from "../../store/settings-store";
import {
  loadWidgetConfig as loadSharedWidgetConfig,
  saveWidgetConfig as saveSharedWidgetConfig,
  CHANGE_EVENT,
  type WidgetConfig
} from "../../widget/widget-config";
import { loadCustomShortcuts, type CustomShortcut } from "../../widget/shortcuts-shared";
import { sanitizeWidgetConfig } from "../../widget/config-schemas";
import { addMinutesToTime, DEFAULT_SECTION_TIMES, parseTimeList, sanitizeTimetableData } from "../../widget/timetable";
import { MISC_TYPE } from "../../widget/widgets/misc/MiscBoardPanel";
import { removeItem, sanitizeMiscItems } from "../../widget/widgets/misc/misc-layout";
import { locateWidgetCrossWindow } from "../../widget/locate-widget";
import { useT } from "../../i18n-lite";
import { confirmDialog } from "../../components/PromptDialog";
import { type Page, DatePicker, Stepper, Segmented, SettingRow, SettingToggleRow } from "./shared";
import { M3Slider as Slider } from "../../components/ui/M3Slider";
import { suggestGroups, stemOf, type SuggestedGroup } from "../../widget/grouping-suggest";
import { ClockConfig, WeatherConfig, SystemMonitorConfig, HardwareConfig } from "./configs/ambient";
import { CalendarConfig, PomodoroWidgetConfig, TodoConfig, DeadlinesConfig } from "./configs/planner";
import { NotificationCenterConfig } from "./configs/notification-center";
import {
  NotesConfig,
  BookmarksConfig,
  FilesConfig,
  RecycleConfig,
  HabitConfig,
  TodayOverviewConfig,
  CountdownConfig
} from "./configs/notes";
import { EmailConfig, BluetoothConfig, ClipboardConfig } from "./configs/connect";
import { MusicConfig, NowPlayingConfig, GalleryConfig, SketchConfig, ColorPickerConfig } from "./configs/media";

function loadWidgetConfig(instanceId: string): WidgetConfig {
  return loadSharedWidgetConfig(instanceId);
}

function saveWidgetConfig(instanceId: string, config: WidgetConfig) {
  saveSharedWidgetConfig(instanceId, config);
}

/** 实例通用行为行（透明度 / 鼠标穿透 / 穿透角标）：画布实例设置页与灵动岛
    磁贴设置页（绑定实例时）共用，直接改 store 实例字段。 */
function InstanceBehaviorRows({ instanceId }: { instanceId: string }) {
  const tr = useT();
  const inst = useWidgetStore((s) => s.instances.find((i) => i.id === instanceId));
  /* 透明度拖动会话：onChange 只写瞬态预览（桌面画布不重渲），松手/键盘步进
     一次性写回 instances；受控 value 读预览避免拖动中回跳。 */
  const previewOpacity = useWidgetStore((s) =>
    s.opacityPreview && s.opacityPreview.id === instanceId ? s.opacityPreview.value : null
  );
  if (!inst) return null;
  return (
    <>
      {/* 通用：独立透明度 */}
      <div className="tm-setting-row">
        <div className="tm-setting-text">
          <span className="tm-setting-title">{tr("透明度")}</span>
          <span className="tm-setting-desc">{tr("此小组件的独立透明度（按总透明度比例叠加）")}</span>
        </div>
        <Slider
          label="透明度"
          value={Math.round((previewOpacity ?? inst.opacity ?? 1) * 100)}
          min={0}
          max={100}
          step={1}
          suffix="%"
          onChange={(v) => {
            useWidgetStore.getState().setOpacityPreview({ id: instanceId, value: v / 100 });
          }}
          onCommitEnd={() => {
            const st = useWidgetStore.getState();
            const pv = st.opacityPreview;
            st.setOpacityPreview(null);
            if (pv && pv.id === instanceId) st.updateWidget(instanceId, { opacity: pv.value });
          }}
        />
      </div>
      {/* 通用：鼠标穿透 */}
      <SettingToggleRow
        title={tr("鼠标穿透")}
        desc={tr("开启后点击直接穿透到桌面，此小组件不再响应鼠标")}
        on={inst.clickThrough === true}
        onChange={(v) => useWidgetStore.getState().updateWidget(instanceId, { clickThrough: v })}
      />
      {/* 通用：穿透角标显示开关（缺省显示；关闭后穿透开启时右上角不再出现「穿透」提示） */}
      <SettingToggleRow
        title={tr("显示穿透角标")}
        desc={tr("开启鼠标穿透后，在小组件右上角显示「穿透」提示角标")}
        on={inst.ctBadge !== false}
        onChange={(v) => useWidgetStore.getState().updateWidget(instanceId, { ctBadge: v })}
      />
    </>
  );
}

export function WidgetConfigPage({ instanceId, onNavigate }: { instanceId: string; onNavigate: (p: Page) => void }) {
  const tr = useT();
  const instances = useWidgetStore((s) => s.instances);
  const inst = instances.find((i) => i.id === instanceId);
  const removeWidget = useWidgetStore((s) => s.removeWidget);
  // 用共享 schema 洗掉损坏字段、补全缺失默认值，保证设置页读到的配置合法。
  const [config, setConfig] = useState<WidgetConfig>(() =>
    inst ? sanitizeWidgetConfig(inst.type, loadWidgetConfig(instanceId)) : {}
  );

  const update = (patch: Partial<WidgetConfig>) => {
    const next = { ...config, ...patch };
    setConfig(next);
    // 保存前同样过一遍 schema，保证落盘数据与定义一致。
    saveWidgetConfig(instanceId, sanitizeWidgetConfig(inst?.type ?? "", next));
  };

  // 桌面端（如时钟内置弹窗、课表导入）改了配置后，已打开的设置页要重读；
  // 否则下次 update() 以旧 state 为基底，会把桌面端的改动静默覆盖回去。
  useEffect(() => {
    const reload = () => {
      const type = useWidgetStore.getState().instances.find((i) => i.id === instanceId)?.type;
      if (type) setConfig(sanitizeWidgetConfig(type, loadWidgetConfig(instanceId)));
    };
    const onChanged = (e: Event) => {
      if ((e as CustomEvent<string>).detail === instanceId) reload();
    };
    window.addEventListener(CHANGE_EVENT, onChanged);
    return () => window.removeEventListener(CHANGE_EVENT, onChanged);
  }, [instanceId]);
  useTauriEvent<{ instanceId: string }>("sync:widget-config", (payload) => {
    if (payload?.instanceId !== instanceId) return;
    const type = useWidgetStore.getState().instances.find((i) => i.id === instanceId)?.type;
    if (type) setConfig(sanitizeWidgetConfig(type, loadWidgetConfig(instanceId)));
  });

  // 当小组件被删除（取消选中）时，配置区自动收起：绑定它的灵动岛磁贴仍在时
  // 回到该磁贴的配置页（岛磁贴要像正常视图一样可配置，而不是弹出视图小组件
  // 列表）；没有磁贴引用才回小组件列表页。
  useEffect(() => {
    if (inst) return;
    const tile = useWidgetStore.getState().dock.tiles.find((t) => t.instanceId === instanceId);
    onNavigate(tile ? `dock-tile-${tile.id}` : "widgets");
  }, [inst, instanceId, onNavigate]);

  if (!inst) {
    return null;
  }

  const meta = getWidgetMeta(inst.type);
  if (!meta) return null;

  return (
    <section className="tm-section">
      <div className="tm-section-title">
        {tr(meta.name)} {tr("配置")}
      </div>
      <div className="tm-config-grid">
        <InstanceBehaviorRows instanceId={instanceId} />
        <WidgetTypeConfigFields type={inst.type} instanceId={instanceId} config={config} update={update} />
      </div>
      <div className="tm-config-danger">
        <button
          className="tm-btn-danger"
          onClick={async () => {
            if (
              await confirmDialog({
                title: tr("删除小组件"),
                message: tr("确定删除此小组件？"),
                confirmLabel: tr("删除"),
                danger: true
              })
            )
              removeWidget(instanceId);
          }}
        >
          <Trash2 size={14} /> {tr("删除此小组件")}
        </button>
      </div>
    </section>
  );
}

/* ---- 各小组件类型配置字段的统一分派：实例配置页与杂项面板的组件设置页共用。
   instanceId 供 notes / gallery 等需要按实例读写独立数据的配置组件使用
   （杂项面板条目传 `<tileId>:<itemId>`，与画布渲染的取数键一致）。 ---- */

export function WidgetTypeConfigFields({
  type,
  instanceId,
  config,
  update
}: {
  type: string;
  instanceId: string;
  config: WidgetConfig;
  update: (p: Partial<WidgetConfig>) => void;
}) {
  return (
    <>
      {type === "clock" && <ClockConfig config={config} update={update} />}
      {type === "weather" && <WeatherConfig config={config} update={update} />}
      {type === "system" && <SystemMonitorConfig config={config} update={update} />}
      {type === "hardware" && <HardwareConfig config={config} update={update} />}
      {type === "calendar" && <CalendarConfig config={config} update={update} />}
      {type === "pomodoro" && <PomodoroWidgetConfig config={config} update={update} />}
      {type === "todo" && <TodoConfig config={config} update={update} />}
      {type === "deadlines" && <DeadlinesConfig config={config} update={update} />}
      {type === "notes" && <NotesConfig config={config} update={update} instanceId={instanceId} />}
      {type === "bookmarks" && <BookmarksConfig config={config} update={update} />}
      {type === "files" && <FilesConfig config={config} update={update} />}
      {type === "habit" && <HabitConfig config={config} update={update} />}
      {type === "countdown" && <CountdownConfig config={config} update={update} />}
      {type === "email" && <EmailConfig config={config} update={update} />}
      {type === "bluetooth" && <BluetoothConfig config={config} update={update} />}
      {type === "music" && <MusicConfig config={config} update={update} />}
      {type === "nowplaying" && <NowPlayingConfig config={config} update={update} />}
      {type === "calculator" && <CalculatorConfig config={config} update={update} />}
      {type === "unitconverter" && <UnitConverterConfig config={config} update={update} />}
      {type === "gallery" && <GalleryConfig config={config} update={update} instanceId={instanceId} />}
      {type === "sysbar" && <SysbarConfig config={config} update={update} />}
      {type === "shortcuts" && <ShortcutsConfig config={config} update={update} />}
      {type === "recycle" && <RecycleConfig />}
      {type === "sketch" && <SketchConfig config={config} update={update} />}
      {type === "analytics" && <AnalyticsConfig config={config} update={update} />}
      {type === "colorpicker" && <ColorPickerConfig config={config} update={update} />}
      {type === "timetable" && <TimetableConfig config={config} update={update} />}
      {type === "todayoverview" && <TodayOverviewConfig config={config} update={update} />}
      {type === "clipboard" && <ClipboardConfig />}
      {type === "notifications" && <NotificationCenterConfig />}
    </>
  );
}

/* ---- 各小组件配置子组件 ---- */

function TimetableConfig({ config, update }: { config: WidgetConfig; update: (p: Partial<WidgetConfig>) => void }) {
  const tr = useT();
  // 学期字段写在 config.data（导入流程写入）；这里防御性解析，损坏数据按无数据处理。
  const ttData = useMemo(() => sanitizeTimetableData(config.data) ?? null, [config.data]);
  return (
    <>
      {ttData && (
        <>
          <div className="tm-setting-row">
            <div className="tm-setting-text">
              <span className="tm-setting-title">{tr("学期第一周周一")}</span>
              <span className="tm-setting-desc">{tr("决定当前是第几周")}</span>
            </div>
            <DatePicker
              value={ttData.semesterStart ?? ""}
              ariaLabel={tr("学期第一周周一")}
              onChange={(v) => update({ data: { ...ttData, semesterStart: v } as unknown as Record<string, unknown> })}
            />
          </div>
          <div className="tm-setting-row">
            <div className="tm-setting-text">
              <span className="tm-setting-title">{tr("学期总周数")}</span>
              <span className="tm-setting-desc">{tr("超出范围的周次将被钳制")}</span>
            </div>
            <input
              type="number"
              min={1}
              max={60}
              className="tm-text-input"
              style={{ width: 88 }}
              aria-label={tr("学期总周数")}
              value={ttData.totalWeeks}
              onChange={(e) =>
                update({
                  data: {
                    ...ttData,
                    totalWeeks: Math.max(1, Math.min(60, Number(e.target.value) || 1))
                  } as unknown as Record<string, unknown>
                })
              }
              data-interactive
            />
          </div>
        </>
      )}
      <SettingToggleRow
        title="显示上课地点"
        desc="在课程块中显示教室"
        on={config.showLocation !== false}
        onChange={(v) => update({ showLocation: v })}
      />
      <SettingToggleRow
        title="显示周次徽标"
        desc="在课程块底部显示生效周次"
        on={config.showWeeksBadge !== false}
        onChange={(v) => update({ showWeeksBadge: v })}
      />
      <SettingToggleRow
        title="显示节次时间"
        desc="在左侧节次栏显示每节起止时间"
        on={config.showTimes !== false}
        onChange={(v) => update({ showTimes: v })}
      />
      {ttData && (
        <SettingToggleRow
          title="同步课程到日历"
          desc="在日历小组件中按实际上课时间显示每天课程；关闭即取消同步"
          on={config.calendarSync === true}
          onChange={(v) => update({ calendarSync: v })}
        />
      )}
      <SettingToggleRow
        title="紧凑模式"
        desc="缩小字号，适合小尺寸小组件"
        on={!!config.compact}
        onChange={(v) => update({ compact: v })}
      />
      <SettingToggleRow
        title="固定每日节次"
        desc="按固定节数显示网格（如 12 节制课表），关闭则跟随课程数据自动"
        on={!!config.totalSections}
        onChange={(v) => update({ totalSections: v ? 12 : 0 })}
      />
      {/* #126：固定节次开关展开/收起——延迟卸载补淡出退场。 */}
      {useDelayedUnmount(!!config.totalSections, animDurations().fxFastMs) && (
        <div className={`tm-setting-row tm-row-collapse${config.totalSections ? "" : " is-closing"}`}>
          <div className="tm-setting-text">
            <span className="tm-setting-title">{tr("每日节次")}</span>
            <span className="tm-setting-desc">{tr("网格固定显示 1–N 节（4–30）；悬浮窗中滚轮上下翻看")}</span>
          </div>
          <Stepper
            value={(config.totalSections as number) || 12}
            suffix={tr("节")}
            onChange={(v) => update({ totalSections: Math.max(4, Math.min(30, v)) })}
          />
        </div>
      )}
      <div className="tm-setting-row">
        <div className="tm-setting-text">
          <span className="tm-setting-title">{tr("课程格行高")}</span>
          <span className="tm-setting-desc">{tr("每节课程格的最小高度，调高后教室等长文本可完整换行显示")}</span>
        </div>
        <Slider
          label="课程格行高"
          value={(config.cellHeight as number) || 28}
          min={28}
          max={96}
          step={4}
          suffix="px"
          onChange={(v) => update({ cellHeight: v })}
        />
      </div>
      <div className="tm-setting-row">
        <div className="tm-setting-text">
          <span className="tm-setting-title">{tr("星期列宽")}</span>
          <span className="tm-setting-desc">{tr("每日列的最小宽度；0 为跟随窗口自适应")}</span>
        </div>
        <Slider
          label="星期列宽"
          value={(config.cellWidth as number) || 0}
          min={0}
          max={120}
          step={4}
          suffix="px"
          onChange={(v) => update({ cellWidth: v })}
        />
      </div>
      <SectionTimesEditor config={config} update={update} />
    </>
  );
}

/** 逐节编辑上课起止时间：写入 config.sectionTimes / sectionTimesEnd（逗号分隔串）。 */
function SectionTimesEditor({ config, update }: { config: WidgetConfig; update: (p: Partial<WidgetConfig>) => void }) {
  const tr = useT();
  // 上限与 totalSections 步进器 / config-schemas（≤30）一致；此前夹到 20，
  // 设成 21–30 节时后几节的起止时间无处编辑。
  const count = Math.max(8, Math.min(30, (config.totalSections as number) || 12));
  const starts = useMemo(() => {
    const parsed = parseTimeList(config.sectionTimes);
    return Array.from({ length: count }, (_, i) => parsed[i] ?? DEFAULT_SECTION_TIMES[i] ?? "");
  }, [config.sectionTimes, count]);
  const endsExplicit = useMemo(() => {
    const parsed = parseTimeList(config.sectionTimesEnd);
    return Array.from({ length: count }, (_, i) => parsed[i] ?? null);
  }, [config.sectionTimesEnd, count]);
  const ends = useMemo(() => {
    return Array.from({ length: count }, (_, i) => endsExplicit[i] ?? addMinutesToTime(starts[i], 45));
  }, [endsExplicit, starts, count]);

  /* #127：改开始时间且结束时间为联动默认值时，结束输入短暂高亮淡变提示联动。
     三.1：高亮窗口与 CSS tm-end-flash（--dur-spatial-fast）同源取值。 */
  const [flashIdx, setFlashIdx] = useState(-1);
  const flashTimer = useRef(0);
  const flashEnd = (i: number) => {
    setFlashIdx(i);
    window.clearTimeout(flashTimer.current);
    flashTimer.current = window.setTimeout(() => setFlashIdx(-1), animDurations().spatialFastMs + 20);
  };

  const setStart = (i: number, v: string) => {
    if (!v) return;
    const next = starts.map((t, j) => (j === i ? v : t));
    // 同步固化当前结束时间，避免开始时间变化后结束时间跟着漂移。
    update({ sectionTimes: next.join(","), sectionTimesEnd: ends.join(",") });
    if (endsExplicit[i] == null) flashEnd(i);
  };
  const setEnd = (i: number, v: string) => {
    if (!v) return;
    update({ sectionTimesEnd: ends.map((t, j) => (j === i ? v : t)).join(",") });
  };

  return (
    <div className="tm-setting-row tm-times-row">
      <div className="tm-setting-text">
        <span className="tm-setting-title">{tr("节次时间表")}</span>
        <span className="tm-setting-desc">{tr("逐节设置上课起止时间，默认工科作息（45 分钟一节）")}</span>
      </div>
      <div className="tm-times-grid">
        <div className="tm-times-heads">
          <span className="tm-times-head">{tr("节次")}</span>
          <span className="tm-times-head">{tr("开始")}</span>
          <span className="tm-times-head">{tr("结束")}</span>
        </div>
        {Array.from({ length: count }, (_, i) => (
          <div key={i} className="tm-times-item" style={{ "--sti": i } as CSSProperties}>
            <span className="tm-times-sec">{tr("第 {n} 节").replace("{n}", String(i + 1))}</span>
            <input
              type="time"
              value={starts[i]}
              onChange={(e) => setStart(i, e.target.value)}
              aria-label={`${tr("第 {n} 节").replace("{n}", String(i + 1))} ${tr("开始")}`}
              data-interactive
            />
            <input
              type="time"
              className={`tm-times-end${flashIdx === i ? " linked-flash" : ""}`}
              value={ends[i]}
              onChange={(e) => setEnd(i, e.target.value)}
              aria-label={`${tr("第 {n} 节").replace("{n}", String(i + 1))} ${tr("结束")}`}
              data-interactive
            />
          </div>
        ))}
      </div>
    </div>
  );
}

function CalculatorConfig({ config, update }: { config: WidgetConfig; update: (p: Partial<WidgetConfig>) => void }) {
  const tr = useT();
  return (
    <>
      <SettingToggleRow
        title="切换科学模式"
        desc="启用科学计算功能"
        on={!!config.scientificMode}
        onChange={(v) => update({ scientificMode: v })}
      />
      <SettingToggleRow
        title="显示算式预览"
        desc="在结果上方显示当前输入的算式，可直接编辑光标处内容"
        on={config.showExpression !== false}
        onChange={(v) => update({ showExpression: v })}
      />
      <SettingToggleRow
        title="历史记录纸带"
        desc="保留最近 50 条计算，点击回填继续算，重启不丢失"
        on={config.showHistory !== false}
        onChange={(v) => update({ showHistory: v })}
      />
      <div className="tm-setting-row">
        <div className="tm-setting-text">
          <span className="tm-setting-title">{tr("角度模式")}</span>
          <span className="tm-setting-desc">{tr("三角函数入参使用角度还是弧度")}</span>
        </div>
        <Segmented
          value={(config.angleMode as string) || "deg"}
          onChange={(v) => update({ angleMode: v })}
          options={[
            { id: "deg", label: "DEG" },
            { id: "rad", label: "RAD" }
          ]}
        />
      </div>
    </>
  );
}

function UnitConverterConfig({ config, update }: { config: WidgetConfig; update: (p: Partial<WidgetConfig>) => void }) {
  return (
    <>
      <SettingToggleRow
        title="显示更多单位"
        desc="在换算器中显示扩展单位列表（面积/压强/鞋码/货币等）"
        on={!!config.showExtended}
        onChange={(v) => update({ showExtended: v })}
      />
      <SettingToggleRow
        title="记住上次使用的类别"
        desc="切换页面后自动记住上次使用的换算类别"
        on={config.rememberCategory !== false}
        onChange={(v) => update({ rememberCategory: v })}
      />
      <SettingToggleRow
        title="显示全部单位对照表"
        desc="输入后一次列出当前类别所有单位的换算结果，逐行可复制"
        on={config.showAllUnits !== false}
        onChange={(v) => update({ showAllUnits: v })}
      />
      <SettingToggleRow
        title="显示换算历史"
        desc="保留最近 10 条换算记录，点击可回填"
        on={config.showHistory !== false}
        onChange={(v) => update({ showHistory: v })}
      />
    </>
  );
}

/** 图库图片条目（与 GalleryWidget 的 Photo 结构一致，仅元数据）。 */
const SYSBAR_ITEMS: { id: string; label: string }[] = [
  { id: "fps", label: "FPS" },
  { id: "lat", label: "延迟" },
  { id: "gpu", label: "GPU" },
  { id: "cpu", label: "CPU" },
  { id: "mem", label: "内存" },
  { id: "cores", label: "核数" },
  { id: "net", label: "网速" },
  { id: "battery", label: "电池" }
];
const SYSBAR_DEFAULT_ITEMS = ["fps", "lat", "gpu", "cpu", "mem", "cores"];

function SysbarConfig({ config, update }: { config: WidgetConfig; update: (p: Partial<WidgetConfig>) => void }) {
  const tr = useT();
  const valid = (v: string) => SYSBAR_ITEMS.some((i) => i.id === v);
  const saved = Array.isArray(config.items) ? (config.items as string[]).filter(valid) : [];
  const items = saved.length > 0 ? saved : SYSBAR_DEFAULT_ITEMS;
  const setItems = (next: string[]) => update({ items: next.filter(valid) });
  const toggleItem = (id: string) => setItems(items.includes(id) ? items.filter((k) => k !== id) : [...items, id]);
  const moveItem = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= items.length) return;
    const next = [...items];
    [next[i], next[j]] = [next[j], next[i]];
    setItems(next);
  };
  return (
    <>
      <div className="tm-setting-row" style={{ flexDirection: "column", alignItems: "stretch" }}>
        <div className="tm-setting-text">
          <span className="tm-setting-title">{tr("显示项")}</span>
          <span className="tm-setting-desc">{tr("勾选启用，箭头调整顺序")}</span>
        </div>
        <div className="sysbar-items">
          {SYSBAR_ITEMS.map(({ id, label }) => {
            const idx = items.indexOf(id);
            const on = idx >= 0;
            return (
              <div key={id} className={`sysbar-item-row${on ? " on" : ""}`}>
                <button
                  type="button"
                  className="sysbar-item-check"
                  aria-pressed={on}
                  aria-label={label === "FPS" ? "FPS" : tr(label)}
                  onClick={() => toggleItem(id)}
                >
                  {on && <Check size={11} />}
                </button>
                <span className="sysbar-item-label">{label === "FPS" ? label : tr(label)}</span>
                {on && (
                  <span className="sysbar-item-order">
                    <button
                      type="button"
                      className="sysbar-item-move"
                      disabled={idx === 0}
                      onClick={() => moveItem(idx, -1)}
                      title={tr("上移")}
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      className="sysbar-item-move"
                      disabled={idx === items.length - 1}
                      onClick={() => moveItem(idx, 1)}
                      title={tr("下移")}
                    >
                      ↓
                    </button>
                  </span>
                )}
              </div>
            );
          })}
        </div>
      </div>
      <div className="tm-setting-row">
        <div className="tm-setting-text">
          <span className="tm-setting-title">{tr("字号")}</span>
          <span className="tm-setting-desc">{tr("xs / sm / md")}</span>
        </div>
        <Segmented
          value={(config.fontSize as string) || "sm"}
          onChange={(v) => update({ fontSize: v })}
          options={[
            { id: "xs", label: "XS" },
            { id: "sm", label: "SM" },
            { id: "md", label: "MD" }
          ]}
        />
      </div>
      <div className="tm-setting-row">
        <div className="tm-setting-text">
          <span className="tm-setting-title">{tr("分隔符")}</span>
          <span className="tm-setting-desc">{tr("竖线 / 圆点 / 无")}</span>
        </div>
        <Segmented
          value={(config.separator as string) || "bar"}
          onChange={(v) => update({ separator: v })}
          options={[
            { id: "bar", label: tr("竖线") },
            { id: "dot", label: tr("圆点") },
            { id: "none", label: tr("无") }
          ]}
        />
      </div>
      <div className="tm-setting-row">
        <div className="tm-setting-text">
          <span className="tm-setting-title">{tr("刷新间隔")}</span>
          <span className="tm-setting-desc">{tr("数据刷新间隔（秒）")}</span>
        </div>
        <Stepper
          value={(config.refreshInterval as number) || 2}
          suffix="秒"
          onChange={(v) => update({ refreshInterval: Math.max(1, Math.min(10, v)) })}
        />
      </div>
    </>
  );
}

/** 内置位置全集（与 Rust SYSTEM_LOCATIONS 对齐）。 */
const BUILTIN_LOCATIONS: { id: string; label: string }[] = [
  { id: "recycle", label: "回收站" },
  { id: "computer", label: "此电脑" },
  { id: "documents", label: "文档" },
  { id: "downloads", label: "下载" },
  { id: "pictures", label: "图片" },
  { id: "music", label: "音乐" },
  { id: "videos", label: "视频" },
  { id: "desktop", label: "桌面" }
];
// 内置位置默认不带：图标以桌面拖入的真实快捷方式为主，系统位置按需勾选。
const DEFAULT_BUILTIN_LOCATIONS: string[] = [];

/** DeskOrder 借鉴 #1：自动整理规则编辑器（监视目录 / 扩展名 / 关键字 / 三态开关 / 存量扫描）。 */
const AUTO_ORGANIZE_EXT_PRESETS = [
  ".pdf",
  ".doc",
  ".docx",
  ".xls",
  ".xlsx",
  ".ppt",
  ".pptx",
  ".jpg",
  ".png",
  ".mp4",
  ".zip",
  ".exe"
];

type AutoOrganizeCfg = {
  watchPath: string;
  extensions: string[];
  nameTokens: string[];
  extEnabled: boolean;
  nameEnabled: boolean;
  notify: boolean;
  /** BentoDesk 借鉴 #6：年龄/体积附加 AND 条件（0 = 不启用）。 */
  olderThanDays: number;
  olderBy: "modified" | "created";
  minSizeMb: number;
};

function AutoOrganizeEditor({
  config,
  update,
  classify
}: {
  config: WidgetConfig;
  update: (p: Partial<WidgetConfig>) => void;
  classify: (path: string, fallbackLabel: string) => Promise<CustomShortcut>;
}) {
  const tr = useT();
  const [tokenText, setTokenText] = useState("");
  const [scanning, setScanning] = useState(false);
  const [scanMsg, setScanMsg] = useState<string | null>(null);
  /* BentoDesk 借鉴 #5：扫描不再直接入列——先生成建议（纯函数），用户逐组/
          逐文件勾选确认后才应用（应用走与此前相同的 classify + 去重入列）。 */
  const [suggestions, setSuggestions] = useState<SuggestedGroup[] | null>(null);
  const [groupOn, setGroupOn] = useState<Record<string, boolean>>({});
  const [filePick, setFilePick] = useState<Record<string, Set<string>>>({});
  const [applying, setApplying] = useState(false);
  const raw = config.autoOrganize as Partial<AutoOrganizeCfg> | undefined;
  const cfg: AutoOrganizeCfg = {
    watchPath: typeof raw?.watchPath === "string" ? raw.watchPath : "",
    extensions: Array.isArray(raw?.extensions) ? raw!.extensions : [],
    nameTokens: Array.isArray(raw?.nameTokens) ? raw!.nameTokens : [],
    extEnabled: raw?.extEnabled !== false,
    nameEnabled: raw?.nameEnabled === true,
    notify: raw?.notify === true,
    olderThanDays: typeof raw?.olderThanDays === "number" ? raw.olderThanDays : 0,
    olderBy: raw?.olderBy === "created" ? "created" : "modified",
    minSizeMb: typeof raw?.minSizeMb === "number" ? raw.minSizeMb : 0
  };
  const patch = (p: Partial<AutoOrganizeCfg>) => update({ autoOrganize: { ...cfg, ...p } });

  const pickWatch = async () => {
    if (!isTauri()) return;
    try {
      const path = await invoke<string | null>("pick_folder");
      if (path) patch({ watchPath: path });
    } catch {
      // ignore
    }
  };

  const scan = async () => {
    if (!isTauri() || !cfg.watchPath) return;
    setScanning(true);
    setScanMsg(null);
    setSuggestions(null);
    try {
      const paths = await invoke<string[]>("scan_auto_organize", {
        watchPath: cfg.watchPath,
        extensions: cfg.extensions,
        nameTokens: cfg.nameTokens,
        extEnabled: cfg.extEnabled,
        nameEnabled: cfg.nameEnabled,
        olderThanDays: cfg.olderThanDays,
        olderBy: cfg.olderBy,
        minSizeMb: cfg.minSizeMb
      });
      const groups = suggestGroups(paths);
      if (groups.length === 0) {
        setScanMsg(paths.length === 0 ? tr("没有扫描到符合条件的文件") : tr("没有发现可分组的文件"));
        return;
      }
      setSuggestions(groups);
      setGroupOn(Object.fromEntries(groups.map((g) => [g.id, true])));
      setFilePick(Object.fromEntries(groups.map((g) => [g.id, new Set(g.paths)])));
    } catch (e) {
      setScanMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setScanning(false);
    }
  };

  /** 应用勾选的建议：与旧「直接入列」同一 classify + 按 path 去重路径。 */
  const applySuggestions = async () => {
    if (!suggestions) return;
    setApplying(true);
    try {
      const picked = new Set<string>();
      for (const g of suggestions) {
        if (!groupOn[g.id]) continue;
        for (const p of filePick[g.id] ?? new Set(g.paths)) picked.add(p);
      }
      const current = loadCustomShortcuts(config);
      const fresh = [...picked].filter((p) => !current.some((x) => x.path === p));
      const items = await Promise.all(fresh.map((p) => classify(p, tr("文件"))));
      if (items.length > 0) update({ customShortcuts: [...current, ...items] });
      setScanMsg(
        `${tr("已整理")} ${items.length} ${tr("项")}${fresh.length > items.length ? `（${fresh.length - items.length} ${tr("项已存在")}）` : ""}`
      );
      setSuggestions(null);
    } finally {
      setApplying(false);
    }
  };

  const suggestionName = (g: SuggestedGroup): string => (g.source === "ext" ? tr(g.name) : g.name);

  const toggleExt = (ext: string) =>
    patch({
      extensions: cfg.extensions.includes(ext) ? cfg.extensions.filter((x) => x !== ext) : [...cfg.extensions, ext]
    });
  const addToken = () => {
    const t = tokenText.trim();
    if (!t || cfg.nameTokens.includes(t)) return;
    patch({ nameTokens: [...cfg.nameTokens, t] });
    setTokenText("");
  };

  return (
    <>
      <div className="tm-divider" />
      <div className="tm-setting-row">
        <div className="tm-setting-text">
          <span className="tm-setting-title">{tr("自动整理")}</span>
          <span className="tm-setting-desc">
            {tr("监视目录里的新文件命中规则后自动收进本组件（只加引用，不移动文件）")}
          </span>
        </div>
      </div>
      <div className="tm-setting-row">
        <div className="tm-setting-text">
          <span className="tm-setting-title">{tr("监视目录")}</span>
          <span className="tm-setting-desc">{cfg.watchPath || tr("未设置（不监视）")}</span>
        </div>
        <div className="tm-location-controls">
          <button className="tm-btn-secondary" onClick={() => void pickWatch()} data-interactive>
            {tr("选择目录")}
          </button>
          {cfg.watchPath && (
            <button className="tm-btn-secondary" onClick={() => patch({ watchPath: "" })} data-interactive>
              {tr("停止监视")}
            </button>
          )}
        </div>
      </div>
      <div className="tm-setting-row tm-setting-row-stack">
        <div className="tm-setting-text">
          <span className="tm-setting-title">{tr("扩展名规则")}</span>
          <span className="tm-setting-desc">
            {tr("点击选用常见类型，命中任一即算匹配（与关键字同时启用时取两者同时满足）")}
          </span>
        </div>
        <div className="tm-shortcut-builtin">
          {AUTO_ORGANIZE_EXT_PRESETS.map((ext) => {
            const on = cfg.extensions.includes(ext);
            return (
              <button
                key={ext}
                className={`tm-builtin-chip${on ? " on" : ""}`}
                onClick={() => toggleExt(ext)}
                data-interactive
              >
                {ext}
              </button>
            );
          })}
        </div>
      </div>
      <SettingToggleRow
        title="扩展名规则启用"
        desc="关闭后规则保留但不参与匹配"
        on={cfg.extEnabled}
        onChange={(v) => patch({ extEnabled: v })}
      />
      {/* C10 通知动作：命中入列时发系统通知，受通知中心「应用」来源门控。 */}
      <SettingToggleRow
        title="整理时通知"
        desc="命中规则的新文件入列时发系统通知"
        on={cfg.notify}
        onChange={(v) => patch({ notify: v })}
      />
      <div className="tm-setting-row">
        <div className="tm-setting-text">
          <span className="tm-setting-title">{tr("文件名关键字")}</span>
          <span className="tm-setting-desc">{tr("文件名包含任一关键字即算匹配（不区分大小写）")}</span>
        </div>
        <div className="tm-location-controls">
          <input
            className="tm-text-input"
            value={tokenText}
            placeholder={tr("输入关键字后添加")}
            aria-label={tr("添加关键字")}
            onChange={(e) => setTokenText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                addToken();
              }
            }}
            data-interactive
          />
          <button className="tm-btn-secondary" onClick={addToken} data-interactive>
            {tr("添加")}
          </button>
        </div>
      </div>
      {cfg.nameTokens.length > 0 && (
        <div className="tm-setting-row tm-setting-row-stack">
          <div className="tm-shortcut-builtin">
            {cfg.nameTokens.map((t) => (
              <button
                key={t}
                className="tm-builtin-chip on"
                onClick={() => patch({ nameTokens: cfg.nameTokens.filter((x) => x !== t) })}
                data-interactive
              >
                {t}
              </button>
            ))}
          </div>
        </div>
      )}
      <SettingToggleRow
        title="关键字规则启用"
        desc="关闭后规则保留但不参与匹配"
        on={cfg.nameEnabled}
        onChange={(v) => patch({ nameEnabled: v })}
      />
      {/* BentoDesk 借鉴 #6：年龄/体积附加 AND 条件（0 = 不启用）。 */}
      <div className="tm-setting-row">
        <div className="tm-setting-text">
          <span className="tm-setting-title">{tr("文件年龄下限")}</span>
          <span className="tm-setting-desc">
            {tr("只整理指定天数前创建或修改的文件（0 = 不限），与上面的规则同时满足")}
          </span>
        </div>
        <div className="tm-location-controls">
          <Segmented
            value={cfg.olderBy}
            options={[
              { id: "modified", label: tr("按修改时间") },
              { id: "created", label: tr("按创建时间") }
            ]}
            onChange={(v) => patch({ olderBy: v })}
          />
          <Stepper
            value={cfg.olderThanDays}
            min={0}
            max={3650}
            suffix={tr("天")}
            onChange={(v) => patch({ olderThanDays: v })}
          />
        </div>
      </div>
      <div className="tm-setting-row">
        <div className="tm-setting-text">
          <span className="tm-setting-title">{tr("最小体积")}</span>
          <span className="tm-setting-desc">{tr("只整理不小于该体积的文件（0 = 不限）")}</span>
        </div>
        <div className="tm-location-controls">
          <Stepper value={cfg.minSizeMb} min={0} max={16384} suffix="MB" onChange={(v) => patch({ minSizeMb: v })} />
        </div>
      </div>
      <div className="tm-setting-row">
        <div className="tm-setting-text">
          <span className="tm-setting-title">{tr("扫描存量文件")}</span>
          <span className="tm-setting-desc">{tr("按当前规则扫描监视目录，生成可勾选的分组建议，确认后才入列")}</span>
        </div>
        <div className="tm-location-controls">
          <button
            className="tm-btn-secondary"
            onClick={() => void scan()}
            disabled={!cfg.watchPath || scanning}
            data-interactive
          >
            {scanning ? tr("扫描中…") : tr("立即扫描")}
          </button>
        </div>
      </div>
      {/* BentoDesk 借鉴 #5：建议面板——逐组开关 + 逐文件 chips 勾选，确认才应用。 */}
      {suggestions && suggestions.length > 0 && (
        <div className="tm-setting-row tm-setting-row-stack">
          <div className="tm-setting-text">
            <span className="tm-setting-title">{tr("分组建议")}</span>
            <span className="tm-setting-desc">{tr("勾选要整理的分组，点击文件名可逐个剔除；确认后才入列")}</span>
          </div>
          {suggestions.map((g) => {
            const pick = filePick[g.id] ?? new Set(g.paths);
            return (
              <div key={g.id} className="ao-suggest-group">
                <label className="ao-suggest-head">
                  <input
                    type="checkbox"
                    checked={groupOn[g.id] !== false}
                    onChange={(e) => setGroupOn({ ...groupOn, [g.id]: e.target.checked })}
                    data-interactive
                  />
                  <span className="ao-suggest-name">
                    {suggestionName(g)} · {pick.size}/{g.paths.length}
                  </span>
                  <span className="ao-suggest-conf" title={tr("置信度")}>
                    {Math.round(g.confidence * 100)}%
                  </span>
                </label>
                <div className="tm-shortcut-builtin">
                  {g.paths.map((p) => {
                    const on = pick.has(p);
                    return (
                      <button
                        key={p}
                        className={`tm-builtin-chip${on ? " on" : ""}`}
                        title={p}
                        onClick={() => {
                          const next = new Set(pick);
                          if (next.has(p)) next.delete(p);
                          else next.add(p);
                          setFilePick({ ...filePick, [g.id]: next });
                        }}
                        data-interactive
                      >
                        {stemOf(p)}
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}
          <div className="tm-location-controls">
            <button
              className="tm-btn-secondary"
              disabled={applying}
              onClick={() => void applySuggestions()}
              data-interactive
            >
              {applying ? tr("整理中…") : tr("整理所选")}
            </button>
            <button className="tm-btn-secondary" onClick={() => setSuggestions(null)} data-interactive>
              {tr("取消")}
            </button>
          </div>
        </div>
      )}
      {scanMsg && <span className="tm-setting-desc">{scanMsg}</span>}
    </>
  );
}

function ShortcutsConfig({ config, update }: { config: WidgetConfig; update: (p: Partial<WidgetConfig>) => void }) {
  const tr = useT();
  const [urlText, setUrlText] = useState("");
  const custom = loadCustomShortcuts(config);
  const builtin = Array.isArray(config.builtinShortcuts)
    ? (config.builtinShortcuts as string[]).filter((id) => BUILTIN_LOCATIONS.some((b) => b.id === id))
    : DEFAULT_BUILTIN_LOCATIONS;

  /* .lnk/.url 经 classify_path 解析成目标路径（桌面删除快捷方式后仍可用），
     目标是文件夹时 kind 归位 folder；解析失败回退原路径。 */
  const classify = async (path: string, fallbackLabel: string): Promise<CustomShortcut> => {
    try {
      const r = await invoke<{ label: string; kind: string; path?: string | null }>("classify_path", { path });
      return {
        id: crypto.randomUUID(),
        label: r.label || fallbackLabel,
        path: r.path ?? path,
        kind: (["url", "folder", "file"].includes(r.kind) ? r.kind : "file") as CustomShortcut["kind"]
      };
    } catch {
      const name = path.split(/[\\/]/).pop() || fallbackLabel;
      return { id: crypto.randomUUID(), label: name, path, kind: "file" as const };
    }
  };

  const addFolder = async () => {
    if (!isTauri()) return;
    try {
      const path = await invoke<string | null>("pick_folder");
      if (!path) return;
      update({ customShortcuts: [...custom, await classify(path, tr("文件夹"))] });
    } catch {
      // ignore
    }
  };

  const addFile = async () => {
    if (!isTauri()) return;
    try {
      const path = await pickFilePath({ title: tr("选择文件") });
      if (!path) return;
      update({ customShortcuts: [...custom, await classify(path, tr("文件"))] });
    } catch {
      // ignore
    }
  };

  const addUrl = () => {
    const text = urlText.trim();
    if (!text) return;
    const path = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`;
    const label = text.replace(/^https?:\/\//i, "").split(/[/?#]/)[0] || text;
    const list = [...custom, { id: crypto.randomUUID(), label, path, kind: "url" as const }];
    update({ customShortcuts: list });
    setUrlText("");
  };

  const remove = (id: string) => {
    update({ customShortcuts: custom.filter((s) => s.id !== id) });
  };

  return (
    <>
      <SettingToggleRow
        title="显示标题"
        desc="在快捷方式上方显示 SHORTCUTS 标题"
        on={config.showTitle !== false}
        onChange={(v) => update({ showTitle: v })}
      />
      <SettingToggleRow
        title="标题紧凑"
        desc="压低 SHORTCUTS 标题行的占高"
        on={config.titleCompact === true}
        onChange={(v) => update({ titleCompact: v })}
      />
      <SettingToggleRow
        title="显示名称标签"
        desc="每枚图标下方的名称；隐藏后仅显示图标，悬停仍可见全名"
        on={config.showLabels !== false}
        onChange={(v) => update({ showLabels: v })}
      />
      <SettingToggleRow
        title="滚动展示"
        desc="Logo Loop：快捷方式以无限横向滚动带展示，悬停暂停；关闭则用网格排布"
        on={config.marquee === true}
        onChange={(v) => update({ marquee: v })}
      />
      <div className="tm-setting-row">
        <div className="tm-setting-text">
          <span className="tm-setting-title">{tr("文件夹打开方式")}</span>
          <span className="tm-setting-desc">
            {tr("文件夹磁贴展开条目网格的方式：单击、悬停（离开自动收回）或钉住")}
          </span>
        </div>
        <Segmented
          value={
            config.sfolderOpenMode === "hover" || config.sfolderOpenMode === "pin"
              ? (config.sfolderOpenMode as string)
              : "click"
          }
          onChange={(v) => update({ sfolderOpenMode: v })}
          options={[
            { id: "click", label: tr("单击") },
            { id: "hover", label: tr("悬停") },
            { id: "pin", label: tr("钉住") }
          ]}
        />
      </div>
      <div className="tm-setting-row">
        <div className="tm-setting-text">
          <span className="tm-setting-title">{tr("列数")}</span>
          <span className="tm-setting-desc">{tr("快捷方式图标的网格列数（滚动展示时不生效）")}</span>
        </div>
        <Stepper
          value={(config.columns as number) || 2}
          suffix="列"
          onChange={(v) => update({ columns: Math.max(1, Math.min(6, v)) })}
        />
      </div>

      {/* 内置位置可选：勾选要显示的系统位置。整行流式布局（8 个位置
        挤在行右侧会溢出），chips 随主题主色染色的选中态见 settings.css。 */}
      <div className="tm-setting-row tm-setting-row-stack">
        <div className="tm-setting-text">
          <span className="tm-setting-title">{tr("内置位置")}</span>
          <span className="tm-setting-desc">{tr("默认不带；按需勾选系统位置，回收站带真实角标")}</span>
        </div>
        <div className="tm-shortcut-builtin">
          {BUILTIN_LOCATIONS.map((b) => {
            const on = builtin.includes(b.id);
            return (
              <button
                key={b.id}
                className={`tm-builtin-chip${on ? " on" : ""}`}
                onClick={() =>
                  update({
                    builtinShortcuts: on ? builtin.filter((x) => x !== b.id) : [...builtin, b.id]
                  })
                }
                data-interactive
              >
                {tr(b.label)}
              </button>
            );
          })}
        </div>
      </div>

      <div className="tm-divider" />

      <div className="tm-setting-row">
        <div className="tm-setting-text">
          <span className="tm-setting-title">{tr("自定义快捷方式")}</span>
          <span className="tm-setting-desc">
            {tr("从桌面把文件或 .lnk 拖进卡片即可添加；此处也可手动添加文件、文件夹或链接")}
          </span>
        </div>
      </div>
      <div className="tm-shortcut-actions">
        <button className="tm-btn-secondary" onClick={() => void addFolder()} data-interactive>
          {tr("添加文件夹")}
        </button>
        <button className="tm-btn-secondary" onClick={() => void addFile()} data-interactive>
          {tr("添加文件")}
        </button>
      </div>
      <div className="tm-link-add">
        <input
          className="tm-text-input"
          value={urlText}
          onChange={(e) => setUrlText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") addUrl();
          }}
          placeholder={tr("粘贴链接，如 example.com")}
          aria-label={tr("添加链接")}
        />
        <button className="tm-btn-secondary" onClick={addUrl} data-interactive>
          {tr("添加链接")}
        </button>
      </div>

      {custom.length > 0 && (
        <div className="tm-shortcut-list">
          {custom.map((s) => (
            <div className="tm-shortcut-item" key={s.id}>
              <span className={`tm-shortcut-kind ${s.kind}`}>
                {s.kind === "url" ? tr("链接") : s.kind === "folder" ? tr("文件夹") : tr("文件")}
              </span>
              <span className="tm-shortcut-path" title={s.path}>
                {s.label}
              </span>
              <button
                className="tm-shortcut-del"
                onClick={() => remove(s.id)}
                aria-label={tr("删除快捷方式")}
                data-interactive
              >
                <Trash2 size={14} />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* DeskOrder 借鉴 #1：自动整理规则（监视目录 / 规则三态 / 存量扫描）。 */}
      <AutoOrganizeEditor config={config} update={update} classify={classify} />
    </>
  );
}

function AnalyticsConfig({ config, update }: { config: WidgetConfig; update: (p: Partial<WidgetConfig>) => void }) {
  const tr = useT();
  const extra = useSettingsStore((s) => s.extra);
  const setExtra = useSettingsStore((s) => s.setExtra);
  return (
    <>
      <div className="tm-setting-row">
        <div className="tm-setting-text">
          <span className="tm-setting-title">{tr("显示天数")}</span>
          <span className="tm-setting-desc">{tr("趋势图显示的天数范围")}</span>
        </div>
        <Slider
          label="显示天数"
          value={(config.days as number) || 7}
          min={3}
          max={30}
          step={1}
          suffix="天"
          onChange={(v) => update({ days: v })}
        />
      </div>
      <SettingToggleRow
        title="显示专注热力图"
        desc="显示本月/本年的专注热力图"
        on={config.showMonthHeatmap !== false}
        onChange={(v) => update({ showMonthHeatmap: v })}
      />
      <div className="tm-setting-row">
        <div className="tm-setting-text">
          <span className="tm-setting-title">{tr("累计专注起始日期")}</span>
          <span className="tm-setting-desc">{tr("留空则从最早记录起")}</span>
        </div>
        <DatePicker
          value={extra.analyticsStartDate ?? ""}
          ariaLabel={tr("累计专注起始日期")}
          onChange={(v) => setExtra({ analyticsStartDate: v || null })}
        />
      </div>
      {/* FocusTimer 借鉴：虚拟午夜——熬夜的「今天」延续到凌晨 2/4 点 */}
      <div className="tm-setting-row">
        <div className="tm-setting-text">
          <span className="tm-setting-title">{tr("统计日界")}</span>
          <span className="tm-setting-desc">{tr("跨午夜专注按此边界切分归日（熬夜可延到凌晨）")}</span>
        </div>
        <Segmented
          value={String(extra.virtualMidnightHour ?? 0)}
          options={[
            { id: "0", label: "0 点" },
            { id: "2", label: "2 点" },
            { id: "4", label: "4 点" }
          ]}
          onChange={(v) => setExtra({ virtualMidnightHour: (Number(v) || 0) as 0 | 2 | 4 })}
        />
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ *
 * 灵动岛磁贴配置页（侧栏「灵动岛」折叠列表的落点）：岛就是一个独立视图，
 * 磁贴在这里像桌面组件一样正常配置。
 *  - 绑定的实例**仍在画布上** → 跳转实例配置页（共享同一份 widget-config）；
 *  - 实例已被删除 / 仅存于回收站 → 停在本页按 tile.config 配置（此前会弹到
 *    「当前视图小组件」列表，用户点课程表看到的正是这个错误界面）；
 *  - 「杂项」磁贴 → 渲染面板组件列表（下级目录：磁贴 → 组件 → 设置）。
 * ------------------------------------------------------------------ */
export function DockTileConfigPage({ tileId, onNavigate }: { tileId: string; onNavigate: (p: Page) => void }) {
  const tr = useT();
  const dock = useWidgetStore((s) => s.dock);
  const setDockTileConfig = useWidgetStore((s) => s.setDockTileConfig);
  const removeDockTile = useWidgetStore((s) => s.removeDockTile);
  const tile = dock.tiles.find((t) => t.id === tileId);
  const meta = tile ? getWidgetMeta(tile.type) : undefined;
  // 绑定的画布实例（存在才用实例的配置源；实例被删后磁贴仍在 → 回落磁贴私有配置）。
  const inst = useWidgetStore((s) =>
    tile?.instanceId ? s.instances.find((i) => i.id === tile.instanceId) : undefined
  );
  const hasTile = !!tile;

  useEffect(() => {
    if (!hasTile) onNavigate("dock");
  }, [hasTile, onNavigate]);

  /* 配置状态与读写。两个来源，读写键与磁贴展开面（dockTileInstanceId）严格一致：
     - 绑定实例：读写实例的 widget-config 键（画布卡片 / 展开面同源），外部改动
       （桌面端弹窗、其他窗口）经 CHANGE_EVENT / sync:widget-config 重读；
     - 无实例（含实例已删的悬空绑定）：tile.config 为权威（store 订阅重读），
       写入时双写 tile.config（store + sync:dock + 备份）与 widget-config 键
       （已展开的面板即时生效）。 */
  const configKey = tile ? (tile.instanceId ?? `dock-tile-${tile.id}`) : "";
  const type = inst?.type ?? tile?.type ?? "";
  const [config, setConfig] = useState<WidgetConfig>(() => {
    if (!tile) return {};
    if (inst) return sanitizeWidgetConfig(type, loadWidgetConfig(configKey));
    // 无实例磁贴：合成键里除 tile.config 落种的展示开关外，还可能有组件自己
    // 写入的用户数据（如课程表 data/profiles）——必须以键内容为基底合并，
    // 否则保存展示开关时会把那些数据整键冲掉。
    return sanitizeWidgetConfig(
      type,
      tile.instanceId ? loadWidgetConfig(configKey) : { ...(tile.config ?? {}), ...loadWidgetConfig(configKey) }
    );
  });
  const configRef = useRef(config);
  configRef.current = config;

  // 重读监听（同 WidgetConfigPage 的理由：外部改动不能被本页的旧 state 覆盖）。
  useEffect(() => {
    if (!inst || !configKey) return;
    const reload = () => {
      const t = useWidgetStore.getState().instances.find((i) => i.id === configKey)?.type;
      if (t) setConfig(sanitizeWidgetConfig(t, loadWidgetConfig(configKey)));
    };
    const onChanged = (e: Event) => {
      if ((e as CustomEvent<string>).detail === configKey) reload();
    };
    window.addEventListener(CHANGE_EVENT, onChanged);
    return () => window.removeEventListener(CHANGE_EVENT, onChanged);
  }, [inst, configKey]);
  useTauriEvent<{ instanceId: string }>("sync:widget-config", (payload) => {
    if (!inst || payload?.instanceId !== configKey) return;
    const t = useWidgetStore.getState().instances.find((i) => i.id === configKey)?.type;
    if (t) setConfig(sanitizeWidgetConfig(t, loadWidgetConfig(configKey)));
  });
  // 无实例：tile.config 变化（就地配置弹层 / 其他窗口 / 撤销恢复）重读。
  const tileConfigRaw = useWidgetStore((s) => (tile ? s.dock.tiles.find((t) => t.id === tile.id)?.config : undefined));
  useEffect(() => {
    if (inst || !tile) return;
    const src = tile.instanceId ? loadWidgetConfig(configKey) : (tileConfigRaw ?? {});
    setConfig(sanitizeWidgetConfig(tile.type, src));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inst, tile?.id, tile?.type, tileConfigRaw]);

  const commit = (patch: Partial<WidgetConfig>) => {
    if (!tile) return;
    const next = sanitizeWidgetConfig(type, { ...configRef.current, ...patch });
    configRef.current = next;
    setConfig(next);
    if (inst) {
      saveWidgetConfig(configKey, next);
    } else {
      setDockTileConfig(tile.id, next);
      saveWidgetConfig(configKey, next);
    }
  };

  if (!tile || !meta) return null;

  /* 「杂项」磁贴：面板自己是一块组件板 —— 本页列出板上的组件（下级目录），
     点组件进入其设置页（dock-tile-item-<tileId>:<itemId>）。 */
  if (tile.type === MISC_TYPE) {
    return <MiscBoardConfigPage tileId={tileId} onNavigate={onNavigate} />;
  }

  const locate = () => {
    if (tile.instanceId) void locateWidgetCrossWindow(tile.instanceId);
  };

  return (
    <section className="tm-section">
      <div className="tm-section-title">
        {tr(meta.name)} · {tr("灵动岛磁贴")}
      </div>
      <div className="tm-config-grid">
        {inst && <InstanceBehaviorRows instanceId={inst.id} />}
        <WidgetTypeConfigFields type={tile.type} instanceId={configKey} config={config} update={commit} />
      </div>
      {/* 灵动岛磁贴区：定位 / 移除磁贴。磁贴移除不影响画布实例。 */}
      <div className="tm-config-danger">
        {inst && (
          <SettingRow title={tr("在画布中定位")} desc={tr("选中并置顶画布上的此小组件，桌面层高亮 1.2 秒")}>
            <button className="tm-btn-secondary" data-interactive onClick={locate}>
              {tr("定位")}
            </button>
          </SettingRow>
        )}
        <SettingRow title={tr("从灵动岛移除")} desc={tr("磁贴从岛上消失，画布实例与组件设置不受影响")}>
          <button className="tm-btn-danger" data-interactive onClick={() => removeDockTile(tile.id)}>
            {tr("移除")}
          </button>
        </SettingRow>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ *
 * 「杂项」面板的两级设置页：
 *  - MiscBoardConfigPage：列出面板上的组件（进入设置 / 移除）；
 *  - MiscItemConfigPage：单个组件的设置，读写 `<tileId>:<itemId>` 的
 *    widget-config（与 MiscBoardPanel 里画布组件的取数键一致，改动即时生效）。
 * ------------------------------------------------------------------ */
export function MiscBoardConfigPage({ tileId, onNavigate }: { tileId: string; onNavigate: (p: Page) => void }) {
  const tr = useT();
  const dock = useWidgetStore((s) => s.dock);
  const setDockTileConfig = useWidgetStore((s) => s.setDockTileConfig);
  const removeDockTile = useWidgetStore((s) => s.removeDockTile);
  const tile = dock.tiles.find((t) => t.id === tileId);
  const items = useMemo(() => sanitizeMiscItems(tile?.config?.items), [tile?.config]);

  const hasTile = !!tile;
  useEffect(() => {
    if (!hasTile) onNavigate("dock");
  }, [hasTile, onNavigate]);
  if (!tile) return null;

  return (
    <section className="tm-section">
      <div className="tm-section-title">
        {tr("杂项")} · {tr("灵动岛磁贴")}
      </div>
      <div className="tm-setting-row">
        <div className="tm-setting-text">
          <span className="tm-setting-title">{tr("面板里的组件")}</span>
          <span className="tm-setting-desc">{tr("点「设置」配置单个组件；在灵动岛展开面板可拖动排布、添加组件")}</span>
        </div>
      </div>
      {items.length === 0 ? (
        <div className="tm-setting-row">
          <div className="tm-setting-text">
            <span className="tm-setting-title">{tr("面板里还没有组件")}</span>
            <span className="tm-setting-desc">{tr("在灵动岛展开杂项面板，点右上角「+」添加小组件")}</span>
          </div>
        </div>
      ) : (
        <div className="tm-misc-set-grid">
          {items.map((item, i) => {
            const meta = getWidgetMeta(item.type);
            const Icon = meta?.icon ?? LayoutGrid;
            return (
              <div className="tm-misc-set-card" key={item.id} style={{ "--sti": i } as CSSProperties}>
                <Icon size={15} aria-hidden="true" />
                <span className="tm-misc-set-name">{meta ? tr(meta.name) : item.type}</span>
                <button
                  className="tm-btn-secondary"
                  onClick={() => onNavigate(`dock-tile-item-${tileId}:${item.id}`)}
                  data-interactive
                >
                  {tr("设置")}
                </button>
                <button
                  className="tm-btn-danger tm-misc-set-del"
                  aria-label={`${tr("移除")} ${meta ? tr(meta.name) : item.type}`}
                  title={tr("从面板移除")}
                  onClick={() => setDockTileConfig(tile.id, { items: removeItem(items, item.id) })}
                  data-interactive
                >
                  <Trash2 size={13} />
                </button>
              </div>
            );
          })}
        </div>
      )}
      <div className="tm-config-danger">
        <SettingRow title={tr("从灵动岛移除")} desc={tr("磁贴从岛上消失，面板组件的排布与设置保留在磁贴数据里")}>
          <button className="tm-btn-danger" data-interactive onClick={() => removeDockTile(tile.id)}>
            {tr("移除")}
          </button>
        </SettingRow>
      </div>
    </section>
  );
}

/** 杂项面板单个组件的设置页：`dock-tile-item-<tileId>:<itemId>`。 */
export function MiscItemConfigPage({ pageId, onNavigate }: { pageId: string; onNavigate: (p: Page) => void }) {
  const tr = useT();
  // pageId 形如 "dock-tile-item-<tileId>:<itemId>"：tile id（uuid）不含冒号，
  // 以第一个冒号切分即可无歧义还原两级 id。
  const rest = pageId.slice("dock-tile-item-".length);
  const sep = rest.indexOf(":");
  const tileId = sep > 0 ? rest.slice(0, sep) : rest;
  const itemId = sep > 0 ? rest.slice(sep + 1) : "";

  const dock = useWidgetStore((s) => s.dock);
  const setDockTileConfig = useWidgetStore((s) => s.setDockTileConfig);
  const tile = dock.tiles.find((t) => t.id === tileId);
  const items = useMemo(() => sanitizeMiscItems(tile?.config?.items), [tile?.config]);
  const item = items.find((i) => i.id === itemId);
  const meta = item ? getWidgetMeta(item.type) : undefined;
  const configId = `${tileId}:${itemId}`;

  // 磁贴或条目被移除 → 回杂项面板页（面板页再无磁贴时自己回灵动岛页）。
  const hasItem = !!item;
  useEffect(() => {
    if (!hasItem) onNavigate(`dock-tile-${tileId}`);
  }, [hasItem, tileId, onNavigate]);

  // 与 WidgetConfigPage 相同的配置读写与实时同步（改设置 → 岛上面板即时生效）。
  const [config, setConfig] = useState<WidgetConfig>(() => loadWidgetConfig(configId));
  useEffect(() => {
    setConfig(loadWidgetConfig(configId));
  }, [configId]);
  useEffect(() => {
    const reload = () => setConfig(loadWidgetConfig(configId));
    const onChanged = (e: Event) => {
      if ((e as CustomEvent<string>).detail === configId) reload();
    };
    window.addEventListener(CHANGE_EVENT, onChanged);
    return () => window.removeEventListener(CHANGE_EVENT, onChanged);
  }, [configId]);
  useTauriEvent<{ instanceId: string }>("sync:widget-config", (payload) => {
    if (payload?.instanceId !== configId) return;
    setConfig(loadWidgetConfig(configId));
  });

  if (!tile || !item || !meta) return null;

  const update = (patch: Partial<WidgetConfig>) => {
    const next = { ...config, ...patch };
    setConfig(next);
    saveWidgetConfig(configId, sanitizeWidgetConfig(item.type, next));
  };

  return (
    <section className="tm-section">
      <div className="tm-section-title">
        {tr(meta.name)} · {tr("杂项组件")}
      </div>
      <div className="tm-config-grid">
        <WidgetTypeConfigFields type={item.type} instanceId={configId} config={config} update={update} />
      </div>
      <div className="tm-config-danger">
        <button
          className="tm-btn-danger"
          onClick={() => {
            setDockTileConfig(tile.id, { items: removeItem(items, item.id) });
            onNavigate(`dock-tile-${tileId}`);
          }}
          data-interactive
        >
          <Trash2 size={14} /> {tr("从杂项移除")}
        </button>
      </div>
    </section>
  );
}
