/**
 * 设置页 · 灵动岛（ISLAND-CFG · 全量项）：三段式行（leading 图标芯片 +
 * 标题/一句话说明 + trailing 控件），与编辑模式浮层 DockConfigPanel 读写同一份
 * widget-store.dock——每项改动经 CORE 动作即时生效并按屏落盘（键
 * focus-desk.screen.<N>.dock.v1），经 sync:dock 同步到桌面层，跨窗口不串屏。
 *
 * 覆盖：启用 / 位置（吸附 + 自由偏移）/ 外形（胶囊 · 贴边刘海 · 视图切换按钮）/ 鼠标动作
 * （悬停 · 点击空白 · 中键 · 滚轮）/ 接管（三开关 + 3–15s 时长）/ 自动隐藏（QQ 式开关）
 * / 密度 / 面板形态 / 顶部内边距。「贴边 顶 / 底」选择已移除：岛只贴顶边（贴底边没有使用价值）。
 *
 * 可达性：每行 leading 图标；开关经 SettingToggleRow 带 aria-label，滑条经 label，
 * 分段 / 下拉外包 role=group + aria-label（shared.tsx 的 Segmented / Dropdown 不接受
 * aria-label 参数，行标题即组名）。
 */
import { useEffect, useState, type ReactNode } from "react";
import { useSliderDraft } from "../../../lib/use-slider-draft";
import {
  AlignCenterHorizontal,
  ArrowDownFromLine,
  Bell,
  ChevronsLeftRight,
  ChevronsUpDown,
  Dock,
  EyeOff,
  Hourglass,
  LayoutGrid,
  Link2,
  Mouse,
  MousePointer2,
  MousePointerClick,
  MoveHorizontal,
  Music,
  Rows3,
  Shapes,
  SunDim,
  Timer,
  Volume2
} from "lucide-react";
import { useT } from "../../../i18n-lite";
import { FxText } from "../../../lib/fx";
import { invoke, isTauri } from "../../../lib/tauri";
import { useSettingsStore } from "../../../store/settings-store";
import {
  useWidgetStore,
  type DockConfig,
  type DockMouseActions,
  type DockSnap,
  type DockTakeoverConfig
} from "../../../widget/widget-store";
import {
  DOCK_TOP_INSET_MAX,
  TAKEOVER_DURATION_MAX_MS,
  TAKEOVER_DURATION_MIN_MS
} from "../../../widget/dock/dock-logic";
import { Dropdown, Segmented, SettingRow, SettingToggleRow } from "../shared";
import { M3Slider as Slider } from "../../../components/ui/M3Slider";

/** 吸附点 → 规范偏移（与 dock-logic.snapOffset 三点一致；DockConfigPanel 同表）。 */
const SNAP_OFFSET: Record<Exclude<DockSnap, "free">, number> = { start: 0, center: 0.5, end: 1 };

/** trailing 控件的可达性外包：Segmented / Dropdown 自身无 aria-label，用行标题命名。 */
function Ctl({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="tm-dock-ctl" role="group" aria-label={label}>
      {children}
    </div>
  );
}

export function DockPage() {
  const tr = useT();
  const dock = useWidgetStore((s) => s.dock);
  const setDock = useWidgetStore((s) => s.setDock);
  const setDockPlacement = useWidgetStore((s) => s.setDockPlacement);
  /* 子对象补丁从 getState() 取**当前**兄弟字段——此前展开渲染闭包里的
     dock.mouse / dock.takeover，滑条拖动中（useSliderDraft 连续回调）或跨窗
     同步刚到达时闭包已陈旧，会把对端 / 上一次回调刚写的字段整包回滚
     （setDock 的叶子合并只救「缺字段」，救不了「带陈旧全字段」）。 */
  const setMouse = (patch: Partial<DockMouseActions>) =>
    setDock({ mouse: { ...useWidgetStore.getState().dock.mouse, ...patch } });
  const setTakeover = (patch: Partial<DockTakeoverConfig>) =>
    setDock({ takeover: { ...useWidgetStore.getState().dock.takeover, ...patch } });
  const setSnap = (snap: DockSnap) =>
    snap === "free" ? setDockPlacement({ snap }) : setDockPlacement({ snap, offset: SNAP_OFFSET[snap] });
  /* 三个滑条（偏移 / 展示时长 / 顶部内边距）拖动期只进草稿，松手一次落盘
     （useSliderDraft 头注——此前逐 input 事件全量写 localStorage + SQLite 镜像
     + 窗口对账 + 跨窗广播）。 */
  const offset = useSliderDraft((v) => setDockPlacement({ snap: "free", offset: v / 100 }));
  const duration = useSliderDraft((v) => setTakeover({ durationMs: v * 1000 }));
  const topInset = useSliderDraft((v) => setDock({ topInset: v }));
  /* [DOCK-COVER]：封面背景开关与专注背景文件夹。 */
  const dockCoverBg = useSettingsStore((s) => s.extra.dockCoverBg);
  const dockFocusBgPath = useSettingsStore((s) => s.extra.dockFocusBgPath);
  const setExtra = useSettingsStore((s) => s.setExtra);
  /* 路径输入走草稿、失焦 / Enter 提交（ConnectionPage 天气城市同款）——
     此前每个按键都 setExtra（整快照落盘 + 跨窗同步广播）。「浏览」选出的
     新路径经 effect 跟随草稿。 */
  const [focusBgDraft, setFocusBgDraft] = useState(dockFocusBgPath);
  useEffect(() => setFocusBgDraft(dockFocusBgPath), [dockFocusBgPath]);
  const commitFocusBg = () => {
    const v = focusBgDraft.trim();
    if (v !== dockFocusBgPath) setExtra({ dockFocusBgPath: v });
  };

  const pickFocusBgFolder = async () => {
    if (!isTauri()) return;
    try {
      const path = await invoke<string | null>("pick_folder");
      if (path !== null) setExtra({ dockFocusBgPath: path });
    } catch {
      /* 用户取消 / 对话框失败：静默。 */
    }
  };

  return (
    <>
      <section className="tm-section">
        <div className="tm-section-title">
          <FxText text={tr("灵动岛")} />
        </div>
        <SettingToggleRow
          icon={Dock}
          title="启用灵动岛"
          desc="屏幕顶部的聚合条"
          on={dock.enabled}
          onChange={(v) => setDock({ enabled: v })}
        />
        <SettingRow icon={AlignCenterHorizontal} title="位置吸附" desc="沿边吸附或自由放置">
          <Ctl label={tr("位置吸附")}>
            <Segmented
              value={dock.snap}
              options={[
                { id: "start", label: "左" },
                { id: "center", label: "居中" },
                { id: "end", label: "右" },
                { id: "free", label: "自由" }
              ]}
              onChange={setSnap}
            />
          </Ctl>
        </SettingRow>
        <SettingRow icon={MoveHorizontal} title="偏移" desc="岛中心的位置（仅自由位可调）">
          <fieldset className="tm-dock-fieldset" disabled={dock.snap !== "free"} aria-label={tr("偏移")}>
            <Slider
              label="偏移"
              value={offset.draft ?? Math.round(dock.offset * 100)}
              min={0}
              max={100}
              step={1}
              suffix="%"
              onChange={offset.slide}
              onCommitEnd={offset.commitEnd}
            />
          </fieldset>
        </SettingRow>
      </section>

      <div className="tm-divider" />

      <section className="tm-section">
        <div className="tm-section-title">{tr("外形")}</div>
        <SettingRow icon={Shapes} title="外形" desc="胶囊 / 贴边刘海">
          <Ctl label={tr("外形")}>
            <Segmented
              value={dock.style}
              options={[
                { id: "pill", label: "胶囊" },
                { id: "bangs", label: "贴边刘海" }
              ]}
              onChange={(style) => setDock({ style })}
            />
          </Ctl>
        </SettingRow>
        <SettingToggleRow
          icon={ChevronsLeftRight}
          title="视图切换按钮"
          desc="点击切换上一个 / 下一个视图"
          on={dock.viewArrows}
          onChange={(v) => setDock({ viewArrows: v })}
        />
      </section>

      <div className="tm-divider" />

      <section className="tm-section">
        <div className="tm-section-title">{tr("鼠标动作")}</div>
        <SettingRow icon={MousePointer2} title="悬停" desc="悬停在岛上时的反应">
          <Ctl label={tr("悬停")}>
            <Dropdown
              value={dock.mouse.hover}
              options={[
                { id: "none", label: "无" },
                { id: "peak", label: "微涨" },
                { id: "expand-first", label: "展开首磁贴" }
              ]}
              onChange={(hover) => setMouse({ hover })}
            />
          </Ctl>
        </SettingRow>
        <SettingRow icon={MousePointerClick} title="点击空白" desc="点击磁贴之外的空白区域">
          <Ctl label={tr("点击空白")}>
            <Dropdown
              value={dock.mouse.blank}
              options={[
                { id: "none", label: "无" },
                { id: "panel", label: "全岛面板" }
              ]}
              onChange={(blank) => setMouse({ blank })}
            />
          </Ctl>
        </SettingRow>
        <SettingRow icon={Mouse} title="中键" desc="鼠标中键点击灵动岛">
          <Ctl label={tr("中键")}>
            <Dropdown
              value={dock.mouse.middle}
              options={[
                { id: "collapse", label: "收起全部" },
                { id: "panel", label: "全岛面板" }
              ]}
              onChange={(middle) => setMouse({ middle })}
            />
          </Ctl>
        </SettingRow>
        <SettingRow icon={ChevronsUpDown} title="滚轮" desc="在灵动岛上滚动鼠标滚轮">
          <Ctl label={tr("滚轮")}>
            <Dropdown
              value={dock.mouse.wheel}
              options={[
                { id: "none", label: "无" },
                { id: "cycle", label: "切换展开磁贴" }
              ]}
              onChange={(wheel) => setMouse({ wheel })}
            />
          </Ctl>
        </SettingRow>
      </section>

      <div className="tm-divider" />

      <section className="tm-section">
        <div className="tm-section-title">{tr("接管")}</div>
        <SettingToggleRow
          icon={Timer}
          title="番茄钟接管"
          desc="响铃时临时接管提示"
          on={dock.takeover.pomodoro}
          onChange={(v) => setTakeover({ pomodoro: v })}
        />
        <SettingToggleRow
          icon={Music}
          title="媒体接管"
          desc="切歌时显示正在播放"
          on={dock.takeover.media}
          onChange={(v) => setTakeover({ media: v })}
        />
        {/* 解析层与编辑浮层（DockConfigPanel 六开关）一直支持，设置页
            此前漏这两项——只进设置页的用户找不到关闭键盘音量/亮度 OSD 接管的入口。 */}
        <SettingToggleRow
          icon={Volume2}
          title="音量接管"
          desc="调整音量时显示百分比"
          on={dock.takeover.volume}
          onChange={(v) => setTakeover({ volume: v })}
        />
        <SettingToggleRow
          icon={SunDim}
          title="亮度接管"
          desc="调整亮度时显示临时提示"
          on={dock.takeover.brightness}
          onChange={(v) => setTakeover({ brightness: v })}
        />
        <SettingToggleRow
          icon={Bell}
          title="通知接管"
          desc="新通知到达时显示摘要"
          on={dock.takeover.notification}
          onChange={(v) => setTakeover({ notification: v })}
        />
        <SettingToggleRow
          icon={Link2}
          title="链接快开"
          desc="复制链接后在岛上显示快捷打开条"
          on={dock.takeover.link}
          onChange={(v) => setTakeover({ link: v })}
        />
        <SettingRow icon={Hourglass} title="展示时长" desc="接管提示停留时长">
          <Slider
            label="展示时长"
            value={duration.draft ?? Math.round(dock.takeover.durationMs / 1000)}
            /* 区间与 store 钳制 / 接管兜底同源（dock-logic 单点常量）。 */
            min={TAKEOVER_DURATION_MIN_MS / 1000}
            max={TAKEOVER_DURATION_MAX_MS / 1000}
            step={1}
            suffix="s"
            onChange={duration.slide}
            onCommitEnd={duration.commitEnd}
          />
        </SettingRow>
      </section>

      <div className="tm-divider" />

      <section className="tm-section">
        <div className="tm-section-title">{tr("自动隐藏")}</div>
        <SettingRow icon={EyeOff} title="自动隐藏" desc="关闭 / 常驻收起 / 仅播放时显示">
          <Ctl label={tr("自动隐藏")}>
            <Segmented
              value={dock.autoHide === true ? "always" : dock.autoHide === "when-playing" ? "when-playing" : "off"}
              options={[
                { id: "off", label: tr("关闭") },
                { id: "always", label: tr("常驻收起") },
                { id: "when-playing", label: tr("仅播放时") }
              ]}
              onChange={(v) =>
                setDock({ autoHide: v === "always" ? true : v === "when-playing" ? "when-playing" : false })
              }
            />
          </Ctl>
        </SettingRow>
      </section>

      <div className="tm-divider" />

      {/* [DOCK-COVER]：岛体背景层。 */}
      <section className="tm-section">
        <div className="tm-section-title">{tr("背景")}</div>
        <SettingToggleRow
          title="音乐封面背景"
          desc="媒体在播时岛体背景切换为当前曲目封面（模糊压暗，切歌淡入淡出）"
          icon={Music}
          on={dockCoverBg}
          onChange={(v) => setExtra({ dockCoverBg: v })}
        />
        <SettingRow
          icon={Shapes}
          title="专注背景文件夹"
          desc="番茄钟运行期间岛体背景随机取该文件夹中的一张图（每个专注会话换一次；留空关闭）"
        >
          <div className="tm-location-controls">
            <input
              className="tm-text-input"
              type="text"
              value={focusBgDraft}
              placeholder={tr("未设置")}
              aria-label={tr("专注背景文件夹")}
              onChange={(e) => setFocusBgDraft(e.target.value)}
              onBlur={commitFocusBg}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitFocusBg();
              }}
            />
            <button className="tm-btn-secondary" onClick={() => void pickFocusBgFolder()}>
              {tr("浏览")}
            </button>
          </div>
        </SettingRow>
      </section>

      <div className="tm-divider" />

      <section className="tm-section">
        <div className="tm-section-title">{tr("密度与面板")}</div>
        <SettingRow icon={Rows3} title="密度" desc="磁贴高度档位">
          <Ctl label={tr("密度")}>
            <Segmented
              value={String(dock.density)}
              options={[
                { id: "36", label: "36" },
                { id: "42", label: "42" },
                { id: "48", label: "48" }
              ]}
              onChange={(v) => setDock({ density: Number(v) as DockConfig["density"] })}
            />
          </Ctl>
        </SettingRow>
        <SettingRow icon={LayoutGrid} title="面板形态" desc="轮播或网格">
          <Ctl label={tr("面板形态")}>
            <Segmented
              value={dock.panel.mode}
              options={[
                { id: "carousel", label: "轮播" },
                { id: "grid", label: "网格" }
              ]}
              onChange={(mode) => setDock({ panel: { mode } })}
            />
          </Ctl>
        </SettingRow>
        <SettingRow icon={ArrowDownFromLine} title="顶部内边距" desc="岛与屏幕上缘的间距">
          <Slider
            label="顶部内边距"
            value={topInset.draft ?? dock.topInset}
            min={0}
            max={DOCK_TOP_INSET_MAX}
            step={1}
            suffix="px"
            onChange={topInset.slide}
            onCommitEnd={topInset.commitEnd}
          />
        </SettingRow>
      </section>
    </>
  );
}
