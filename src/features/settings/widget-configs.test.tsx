/**
 * 小组件配置页（widget-configs）行为测试（浏览器模式，真实 widget-config
 * localStorage 读写链 + CHANGE_EVENT，无需 mock）：
 *  - DockTileConfigPage 双读合并（轮 ）：无实例磁贴的 tile.config 与
 *    widget-config 合成键各持一半数据时，拨任一开关提交后两边数据都保留
 *    （此前挂载只回读单一源，整键写回会把另一源的数据冲掉）；
 *  - AutoOrganizeEditor Stepper 手输越界钳制：olderThanDays / minSizeMb
 *    手输提交经 Math.min/max 钳到边界，不因 schema catch 静默归 0；
 *  - 节次时间表行数随 totalSections（4–30）变化：SectionTimesEditor 的 count
 *    下限为 4（此前夹到 8，设 4–7 节时后几节无处编辑）。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { DockTileConfigPage, WidgetConfigPage } from "./widget-configs";
import { useWidgetStore, type DockTile, type WidgetInstance } from "../../widget/widget-store";
import { loadWidgetConfig, saveWidgetConfig } from "../../widget/widget-config";

/** 无实例磁贴：type + tile.config，无 instanceId（config 权威分居两处）。 */
const seedTile = (tile: DockTile) =>
  useWidgetStore.setState((s) => ({
    dock: { ...s.dock, tiles: [tile] },
    instances: [],
    groups: [],
    opacityPreview: null
  }));

const seedInstance = (inst: WidgetInstance) =>
  useWidgetStore.setState((_s) => ({ instances: [inst], groups: [], opacityPreview: null }));

const tile = () => useWidgetStore.getState().dock.tiles[0];

beforeEach(() => {
  localStorage.clear();
});

describe("DockTileConfigPage · 无实例磁贴双读合并（P1-4 回归）", () => {
  it("tile.config 持展示开关、widget-config 键持用户数据：提交展示开关后两边数据都保留", async () => {
    const user = userEvent.setup();
    // 两半数据：tile.config 落种 showLocation=false；合成键里是展开面写入的
    // 课程表 profiles / activeProfile（用户数据）。
    saveWidgetConfig("dock-tile-t1", { profiles: [{ id: "p1", name: "课表一" }], activeProfile: "p1" });
    seedTile({ id: "t1", type: "timetable", config: { showLocation: false } });

    render(<DockTileConfigPage tileId="t1" onNavigate={vi.fn()} />);
    const sw = screen.getByRole("switch", { name: "显示上课地点" });
    expect(sw).toHaveAttribute("aria-checked", "false");
    await user.click(sw);

    // 开关翻转为 true 落进 tile.config（store 侧）。
    expect(tile()?.config?.showLocation).toBe(true);
    // 键侧另一半（profiles / activeProfile）在整键写回后原样保留——
    // 旧实现以 tile.config 单一源为基底，此处会把 profiles 冲掉。
    const key = loadWidgetConfig("dock-tile-t1");
    expect(key.showLocation).toBe(true);
    expect(key.profiles).toEqual([{ id: "p1", name: "课表一" }]);
    expect(key.activeProfile).toBe("p1");
    // store 侧磁贴 config 同样保有键侧数据（双写）。
    expect(tile()?.config?.activeProfile).toBe("p1");
    expect(screen.getByRole("switch", { name: "显示上课地点" })).toHaveAttribute("aria-checked", "true");
  });

  it("挂载期间外部经合成键写入新数据，随后的提交不冲掉它（CHANGE_EVENT 重读兜底）", async () => {
    const user = userEvent.setup();
    seedTile({ id: "t2", type: "timetable", config: { showLocation: true } });
    render(<DockTileConfigPage tileId="t2" onNavigate={vi.fn()} />);
    // 桌面端展开面（外部）经合成键写入课程数据 + CHANGE_EVENT。
    saveWidgetConfig("dock-tile-t2", { profiles: [{ id: "px", name: "外部课表" }], activeProfile: "px" });
    // 本页随后拨动展示开关。
    await user.click(screen.getByRole("switch", { name: "显示周次徽标" }));
    const key = loadWidgetConfig("dock-tile-t2");
    expect(key.showWeeksBadge).toBe(false);
    expect(key.profiles).toEqual([{ id: "px", name: "外部课表" }]);
  });
});

describe("AutoOrganizeEditor · Stepper 手输越界钳制（F4）", () => {
  it("olderThanDays 手输 9999 → 3650（不静默归 0）；-3 → 0；非法文本不写库", async () => {
    const user = userEvent.setup();
    seedInstance({ id: "sc1", type: "shortcuts", x: 0, y: 0, w: 6, h: 4, z: 1 });
    render(<WidgetConfigPage instanceId="sc1" onNavigate={vi.fn()} />);
    const days = screen.getByRole("textbox", { name: "天" }) as HTMLInputElement;

    await user.clear(days);
    await user.type(days, "9999{enter}");
    // 越界被钳到上限 3650；修复前 schema 的 num().catch(0) 会把手输越界值
    // 静默归 0（等价于「不限」），用户设的条件下限悄悄失效。
    expect(loadWidgetConfig("sc1").autoOrganize).toMatchObject({ olderThanDays: 3650 });

    await user.clear(days);
    await user.type(days, "-3{enter}");
    expect(loadWidgetConfig("sc1").autoOrganize).toMatchObject({ olderThanDays: 0 });

    // 非数字：commit 不写库（shake 回退），配置保持上一合法值。
    await user.clear(days);
    await user.type(days, "abc{enter}");
    expect(loadWidgetConfig("sc1").autoOrganize).toMatchObject({ olderThanDays: 0 });
    expect((screen.getByRole("textbox", { name: "天" }) as HTMLInputElement).value).toBe("0");
  });

  it("minSizeMb 手输 99999 → 钳到 16384", async () => {
    const user = userEvent.setup();
    seedInstance({ id: "sc2", type: "shortcuts", x: 0, y: 0, w: 6, h: 4, z: 1 });
    render(<WidgetConfigPage instanceId="sc2" onNavigate={vi.fn()} />);
    const mb = screen.getByRole("textbox", { name: "MB" }) as HTMLInputElement;
    await user.clear(mb);
    await user.type(mb, "99999{enter}");
    expect(loadWidgetConfig("sc2").autoOrganize).toMatchObject({ minSizeMb: 16384 });
  });
});

describe("TimetableConfig · 节次时间表行数随 4–30 设置变化（count 下限修复）", () => {
  it("默认 12 行；设 6 → 6 行；设 4（下限）→ 4 行（此前夹到 8）；设 30 → 30 行", async () => {
    const user = userEvent.setup();
    seedInstance({ id: "tt1", type: "timetable", x: 0, y: 0, w: 8, h: 6, z: 1 });
    render(<WidgetConfigPage instanceId="tt1" onNavigate={vi.fn()} />);

    // totalSections 缺省 0 → 回落 12 行。
    const startInputs = () => screen.getAllByLabelText(/节开始$/);
    expect(startInputs()).toHaveLength(12);

    // 打开「固定每日节次」→ totalSections=12；步进器手输 6。
    await user.click(screen.getByRole("switch", { name: "固定每日节次" }));
    const step = screen.getByRole("textbox", { name: "节" }) as HTMLInputElement;
    await user.clear(step);
    await user.type(step, "6{enter}");
    expect(loadWidgetConfig("tt1").totalSections).toBe(6);
    expect(startInputs()).toHaveLength(6);

    // 下限 4：修复前 count 被夹到 8，4–7 节时第 5 节起无处编辑。
    await user.clear(step);
    await user.type(step, "4{enter}");
    expect(loadWidgetConfig("tt1").totalSections).toBe(4);
    expect(startInputs()).toHaveLength(4);
    expect(screen.getByLabelText("第 4 节开始")).toBeInTheDocument();

    // 上限 30。
    await user.clear(step);
    await user.type(step, "30{enter}");
    expect(loadWidgetConfig("tt1").totalSections).toBe(30);
    expect(startInputs()).toHaveLength(30);

    // 步进器手输越界同样被钳（>30 → 30，<4 → 4）。
    await user.clear(step);
    await user.type(step, "99{enter}");
    expect(loadWidgetConfig("tt1").totalSections).toBe(30);
    await user.clear(step);
    await user.type(step, "1{enter}");
    expect(loadWidgetConfig("tt1").totalSections).toBe(4);
  });
});

describe("TimetableConfig · 学期字段写入 profiles（多方案架构回归）", () => {
  it("改总周数后 profiles 与镜像 data 同步更新（旧实现只写 data，被 loadProfiles 忽略）", async () => {
    // 课表小组件经 profilesPatch 写入的真实形态：profiles + activeProfile + 镜像 data。
    const data = {
      semesterStart: "2026-08-31",
      totalWeeks: 18,
      sessions: [
        {
          id: "s1",
          name: "高数",
          rawName: "高数",
          day: 1,
          startSection: 1,
          endSection: 2,
          weeks: [1],
          weeksLabel: "1周",
          location: "",
          teacher: ""
        }
      ],
      importedAt: 1
    };
    saveWidgetConfig("tt2", { profiles: [{ id: "p1", name: "本学期", data }], activeProfile: "p1", data });
    seedInstance({ id: "tt2", type: "timetable", x: 0, y: 0, w: 8, h: 6, z: 1 });
    render(<WidgetConfigPage instanceId="tt2" onNavigate={vi.fn()} />);

    const weeks = screen.getByRole("spinbutton", { name: "学期总周数" }) as HTMLInputElement;
    // 受控数字输入逐键 onChange 会把中间值写库，一次性赋终值。
    fireEvent.change(weeks, { target: { value: "20" } });

    const saved = loadWidgetConfig("tt2");
    // 激活方案里的 totalWeeks 跟着改（小组件 loadProfiles 读的是这里）。
    const prof = (saved.profiles as { id: string; data: { totalWeeks: number; semesterStart: string } }[]).find(
      (p) => p.id === "p1"
    );
    expect(prof?.data.totalWeeks).toBe(20);
    expect(prof?.data.semesterStart).toBe("2026-08-31");
    // 镜像 data 同步（今日概览 / 日历同步读取的旧口径）。
    expect((saved.data as { totalWeeks: number }).totalWeeks).toBe(20);
  });
});
