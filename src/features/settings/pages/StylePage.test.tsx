/**
 * 设置页「样式」（StylePage）行为测试：
 *  - 主色 ColorRow：取色器改色 → store.primaryColor 即时更新，350ms 防抖后
 *    持久化快照（focus-desk.settings.v1）含该值；
 *  - 主题模式 Segmented：切「深色」→ themeMode 即时落库（离散 setter 不防抖）；
 *  - 壁纸文件夹计数（截断修复）：目录内图片 >30 时描述为整句
 *    「共 N 张图片，显示前 30 张」且网格只渲染前 30 张缩略图；≤30 时
 *    「N 张图片」、不出现截断提示。list_directory 经 mock invoke 返回。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const invokeMock = vi.fn(async (_cmd: string, _args?: unknown): Promise<unknown> => null);
let tauriOn = true;

vi.mock("../../../lib/tauri", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../../../lib/tauri")>();
  return {
    ...mod,
    isTauri: () => tauriOn,
    invoke: (cmd: string, args?: unknown) => invokeMock(cmd, args)
  };
});

import { StylePage } from "./StylePage";
import { useSettingsStore } from "../../../store/settings-store";

const SETTINGS_KEY = "focus-desk.settings.v1";
const snapshot = () => JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "{}") as Record<string, unknown>;
/** list_directory 的当前应答（每个用例自行设定）。 */
let dirEntries: { name: string; path: string; is_dir: boolean }[] = [];

/** 构造含 n 张图片 + 1 个子目录 + 1 个非图片文件的目录列表。 */
const dirWithImages = (n: number) => [
  { name: "subdir", path: "C:/walls/subdir", is_dir: true },
  { name: "notes.txt", path: "C:/walls/notes.txt", is_dir: false },
  ...Array.from({ length: n }, (_, i) => {
    const name = `img-${String(i + 1).padStart(2, "0")}.jpg`;
    return { name, path: `C:/walls/${name}`, is_dir: false };
  })
];

beforeEach(() => {
  localStorage.clear();
  invokeMock.mockReset();
  invokeMock.mockImplementation(async (cmd: string, args?: unknown) => {
    if (cmd === "list_directory") return dirEntries;
    if (cmd === "read_image_thumbnails") {
      const paths = (args as { paths?: string[] } | undefined)?.paths ?? [];
      return paths.map(() => null);
    }
    return null;
  });
  tauriOn = true;
  dirEntries = [];
  useSettingsStore.setState({
    preset: "default",
    themeMode: "system",
    primaryColor: "#3b82f6",
    wallpaperFolder: "",
    recentWallpapers: []
  });
});

describe("StylePage · 主色 / 主题模式", () => {
  it("主色 ColorRow：取色器改 #ff8800 → store.primaryColor 即时更新，防抖落盘快照含该值", async () => {
    render(<StylePage />);
    // 页面上「主色」与小组件「背景」两行各有一个取色器（aria 同名）：按行限定。
    const picker = () =>
      within(screen.getByText("主色").closest(".tm-setting-row") as HTMLElement).getByLabelText(
        "选择颜色"
      ) as HTMLInputElement;
    fireEvent.change(picker(), { target: { value: "#ff8800" } });
    // store 即时更新（滑条/取色器高频路径 350ms 防抖只作用于落盘）。
    expect(useSettingsStore.getState().primaryColor).toBe("#ff8800");
    // 防抖到期后持久化快照含该值。
    await waitFor(() => expect(snapshot().primaryColor).toBe("#ff8800"), { timeout: 2000 });
    // 行内取色器回显新值。
    expect(picker().value).toBe("#ff8800");
  });

  it("主题模式 Segmented：切「深色」→ themeMode=dark 即时入 store 并落库", async () => {
    const user = userEvent.setup();
    render(<StylePage />);
    // 页面上有「主题模式」与「浮窗深浅」两组含「深色」的分段：按行容器限定。
    const row = screen.getByText("主题模式").closest(".tm-setting-row") as HTMLElement;
    const dark = within(row).getByRole("radio", { name: "深色" });
    await user.click(dark);
    expect(useSettingsStore.getState().themeMode).toBe("dark");
    // 离散 setter 即时落盘（无防抖）。
    expect(snapshot().themeMode).toBe("dark");
    expect(within(row).getByRole("radio", { name: "深色" })).toHaveAttribute("aria-checked", "true");
  });

  it("主色 hex 输入：合法值提交入 store，非法值失焦回显原值", async () => {
    const user = userEvent.setup();
    render(<StylePage />);
    const row = screen.getByText("主色").closest(".tm-setting-row") as HTMLElement;
    const hex = within(row).getByLabelText("十六进制色值") as HTMLInputElement;
    // 粘贴合法 hex + 回车 → 生效（小写归一）。
    await user.clear(hex);
    await user.type(hex, "#00FF88{Enter}");
    expect(useSettingsStore.getState().primaryColor).toBe("#00ff88");
    // 非法输入 + 失焦 → 不落，回显当前色。
    await user.clear(hex);
    await user.type(hex, "not-a-color");
    fireEvent.blur(hex);
    expect(useSettingsStore.getState().primaryColor).toBe("#00ff88");
    expect(hex.value).toBe("#00ff88");
  });
});

describe("StylePage · 壁纸文件夹计数（F4 截断修复）", () => {
  it("35 张图片：描述为整句「共 35 张图片，显示前 30 张」，网格只渲染前 30 张", async () => {
    dirEntries = dirWithImages(35);
    useSettingsStore.setState({ wallpaperFolder: "C:/walls" });
    render(<StylePage />);
    // 真实总数 35 出现在整句模板里（截断修复前误导为只有 30 张）。
    expect(await screen.findByText(/C:\/walls · 共 35 张图片，显示前 30 张/)).toBeInTheDocument();
    // 网格截断为前 30 张缩略图。
    await waitFor(() => expect(screen.getAllByRole("button", { name: /^设为壁纸：/ })).toHaveLength(30));
    // list_directory 收到选中文件夹路径且不带隐藏文件。
    expect(
      invokeMock.mock.calls.some(
        ([cmd, args]) => cmd === "list_directory" && (args as { path: string }).path === "C:/walls"
      )
    ).toBe(true);
  });

  it("12 张图片：描述为「12 张图片」整句，不出现「显示前」截断提示", async () => {
    dirEntries = dirWithImages(12);
    useSettingsStore.setState({ wallpaperFolder: "C:/walls" });
    render(<StylePage />);
    expect(await screen.findByText(/C:\/walls · 12 张图片$/)).toBeInTheDocument();
    expect(screen.queryByText(/显示前/)).toBeNull();
    expect(await screen.findAllByRole("button", { name: /^设为壁纸：/ })).toHaveLength(12);
  });

  it("30 张恰好不截断：仍显示「30 张图片」整句", async () => {
    dirEntries = dirWithImages(30);
    useSettingsStore.setState({ wallpaperFolder: "C:/walls" });
    render(<StylePage />);
    expect(await screen.findByText(/C:\/walls · 30 张图片$/)).toBeInTheDocument();
    expect(screen.queryByText(/显示前/)).toBeNull();
  });
});

describe("StylePage · 缩略图合批与刷新", () => {
  it("最近使用 + 文件夹去重后超 32 张自动分批：同图只请求一次、每批 ≤32", async () => {
    dirEntries = dirWithImages(30);
    // 最近 5 张里 1 张与文件夹内 img-01.jpg 相同 → 去重后唯一路径 34 条。
    useSettingsStore.setState({
      wallpaperFolder: "C:/walls",
      recentWallpapers: ["C:/walls/img-01.jpg", "C:/other/b.jpg", "C:/other/c.jpg", "C:/other/d.jpg", "C:/other/e.jpg"]
    });
    render(<StylePage />);
    await screen.findByText(/C:\/walls · 30 张图片$/);
    await waitFor(() => {
      const calls = invokeMock.mock.calls.filter(([cmd]) => cmd === "read_image_thumbnails");
      // stripPaths 随 folderImages 载入会重算（先 5 条后 34 条），累计多次 IPC；
      // 断言稳定不变式：唯一路径 34（5+30 含 1 重复）、每批不超 Rust 上限 32。
      const all = calls.flatMap(([, args]) => (args as { paths: string[] }).paths);
      expect(new Set(all).size).toBe(34);
      for (const [, args] of calls) expect((args as { paths: string[] }).paths.length).toBeLessThanOrEqual(32);
      // 终态批次已覆盖 34 条（文件夹载入后的请求合计 34）。
      const last = calls.slice(-2).flatMap(([, args]) => (args as { paths: string[] }).paths);
      expect(new Set(last).size).toBe(34);
    });
  });

  it("点「刷新」重新枚举文件夹（新下载的图片即时反映）", async () => {
    dirEntries = dirWithImages(2);
    useSettingsStore.setState({ wallpaperFolder: "C:/walls" });
    render(<StylePage />);
    expect(await screen.findByText(/C:\/walls · 2 张图片$/)).toBeInTheDocument();
    // 文件夹里新进了 3 张图：不重选文件夹，点刷新即重列。
    dirEntries = dirWithImages(5);
    const listCallsBefore = invokeMock.mock.calls.filter(([cmd]) => cmd === "list_directory").length;
    fireEvent.click(screen.getByRole("button", { name: "刷新" }));
    expect(await screen.findByText(/C:\/walls · 5 张图片$/)).toBeInTheDocument();
    expect(invokeMock.mock.calls.filter(([cmd]) => cmd === "list_directory").length).toBe(listCallsBefore + 1);
  });
});

describe("StylePage · 滑条双击恢复默认", () => {
  it("圆角滑条双击 → cornerRadius 回默认 24 并落盘", async () => {
    const user = userEvent.setup();
    useSettingsStore.setState({ cornerRadius: 8 });
    render(<StylePage />);
    // 页面有多个可重置滑条（缩放/字号/圆角…）：按「圆角」行限定目标。
    const row = screen.getByText("圆角").closest(".tm-setting-row") as HTMLElement;
    const target = row.querySelector(".tm-slider-reset-wrap") as HTMLElement;
    expect(target).toBeTruthy();
    expect(target).toHaveAttribute("title", "双击恢复默认");
    await user.dblClick(target);
    expect(useSettingsStore.getState().cornerRadius).toBe(24);
    await waitFor(() => expect(snapshot().cornerRadius).toBe(24), { timeout: 2000 });
  });

  it("主题切换动效滑条：双击回默认 1400ms（[INK-DUR] 时长可调）", async () => {
    const user = userEvent.setup();
    useSettingsStore.setState({ extra: { ...useSettingsStore.getState().extra, themeInkDurationMs: 500 } });
    render(<StylePage />);
    const row = screen.getByText("主题切换动效").closest(".tm-setting-row") as HTMLElement;
    const target = row.querySelector(".tm-slider-reset-wrap") as HTMLElement;
    expect(target).toBeTruthy();
    await user.dblClick(target);
    expect(useSettingsStore.getState().extra.themeInkDurationMs).toBe(1400);
    await waitFor(() => expect((snapshot().extra as { themeInkDurationMs?: number }).themeInkDurationMs).toBe(1400), {
      timeout: 2000
    });
  });
});

describe("StylePage · 在线画廊已安装标记", () => {
  it("同名样式预设已存在：显示「已安装」徽标且按钮禁用；未安装项按钮可点", async () => {
    const sha = "a".repeat(64);
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "fetch_url_text") {
        return JSON.stringify({
          presets: [
            { id: "1", name: "已装预设", file: "a.zip", sha256: sha, size: 10 },
            { id: "2", name: "新预设", file: "b.zip", sha256: sha, size: 20 }
          ]
        });
      }
      if (cmd === "list_directory") return [];
      if (cmd === "read_image_thumbnails") return [];
      return null;
    });
    // 本地已有同名样式预设（画廊包装的正是小组件样式预设库）。
    localStorage.setItem(
      "focus-desk.style-presets.v1",
      JSON.stringify([{ id: "x", name: "已装预设", widgetType: "clock", createdAt: 1, config: {} }])
    );
    useSettingsStore.setState({
      extra: { ...useSettingsStore.getState().extra, presetGallerySource: "https://github.com/u/r" }
    });
    render(<StylePage />);
    fireEvent.click(screen.getByRole("button", { name: "加载" }));
    // 清单落地：已装项带徽标 + 按钮禁用（重复导入同名只会跳过）。
    const installedName = await screen.findByText("已装预设");
    const card = installedName.closest(".tm-gallery-card") as HTMLElement;
    expect(card.querySelector(".tm-gallery-installed")).not.toBeNull();
    expect(within(card).getByRole("button", { name: "已安装" })).toBeDisabled();
    // 未装项：无徽标、按钮可点。
    const freshName = await screen.findByText("新预设");
    const freshCard = freshName.closest(".tm-gallery-card") as HTMLElement;
    expect(freshCard.querySelector(".tm-gallery-installed")).toBeNull();
    expect(within(freshCard).getByRole("button", { name: "安装" })).toBeEnabled();
  });
});
