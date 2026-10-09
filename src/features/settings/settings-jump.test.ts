import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SETTINGS_JUMP_EVENT,
  clearPendingSettingsJump,
  flashSettingsRowByTitle,
  peekPendingSettingsJump,
  requestSettingsJump,
  takePendingSettingsJump
} from "./settings-jump";

/** 行级跳转信道（settings-jump）：pending 一次性语义、同窗广播、按标题
 *  找行的滚动 + 脉冲（scrollIntoView 打桩；jsdom 未实现）。 */
beforeEach(() => {
  clearPendingSettingsJump();
});

afterEach(() => {
  clearPendingSettingsJump();
  vi.useRealTimers();
});

describe("pending 信道", () => {
  it("request 写入并广播同窗事件；peek 不消费、take 一次性取走", () => {
    const heard = vi.fn();
    window.addEventListener(SETTINGS_JUMP_EVENT, heard);
    requestSettingsJump("style", "主色");
    expect(heard).toHaveBeenCalledTimes(1);
    expect(peekPendingSettingsJump()).toEqual({ page: "style", title: "主色" });
    expect(peekPendingSettingsJump()).toEqual({ page: "style", title: "主色" }); // 可重复窥视
    expect(takePendingSettingsJump()).toEqual({ page: "style", title: "主色" });
    expect(takePendingSettingsJump()).toBeNull();
    window.removeEventListener(SETTINGS_JUMP_EVENT, heard);
  });

  it("无 title 的 request 清除挂起且不广播", () => {
    requestSettingsJump("style", "圆角");
    const heard = vi.fn();
    window.addEventListener(SETTINGS_JUMP_EVENT, heard);
    requestSettingsJump("general");
    expect(heard).not.toHaveBeenCalled();
    expect(peekPendingSettingsJump()).toBeNull();
    window.removeEventListener(SETTINGS_JUMP_EVENT, heard);
  });
});

describe("flashSettingsRowByTitle", () => {
  const scrollIntoView = vi.fn();
  beforeEach(() => {
    scrollIntoView.mockReset();
    // jsdom 未实现 scrollIntoView：打桩防抛错并断言调用。
    Element.prototype.scrollIntoView = scrollIntoView;
  });

  function buildWindow(rows: string[]): HTMLElement {
    document.body.innerHTML = "";
    const win = document.createElement("div");
    win.className = "tm-settings-window";
    for (const title of rows) {
      const row = document.createElement("div");
      row.className = "tm-setting-row";
      const t = document.createElement("span");
      t.className = "tm-setting-title";
      t.textContent = title;
      row.appendChild(t);
      win.appendChild(row);
    }
    document.body.appendChild(win);
    return win;
  }

  it("按标题（原文或译文）命中行：滚动居中 + 挂脉冲类，1.8s 后自动移除", () => {
    vi.useFakeTimers();
    buildWindow(["主题模式", "主色", "圆角"]);
    const stop = flashSettingsRowByTitle("主色", (s) => `EN:${s}`);
    const rows = document.querySelectorAll(".tm-setting-row");
    expect(rows[1].classList.contains("tm-row-flash")).toBe(true);
    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: "smooth", block: "center" });
    vi.advanceTimersByTime(1800);
    expect(rows[1].classList.contains("tm-row-flash")).toBe(false);
    stop();
  });

  it("English 界面按译文文本命中（行渲染的是翻译后标题）", () => {
    buildWindow(["Primary color"]);
    flashSettingsRowByTitle("主色", () => "Primary color");
    const row = document.querySelector(".tm-setting-row") as HTMLElement;
    expect(row.classList.contains("tm-row-flash")).toBe(true);
  });

  it("未命中：120ms 轮询重试，行后到（懒加载）仍可命中；取消函数停止重试", () => {
    vi.useFakeTimers();
    buildWindow(["主题模式"]);
    const stop = flashSettingsRowByTitle("主色", (s) => s);
    // 尚未渲染「主色」行：脉冲未挂。
    expect(document.querySelector(".tm-setting-row")?.classList.contains("tm-row-flash")).toBe(false);
    // 100ms 后（下一轮 120ms 轮询前）懒加载补出目标行。
    vi.advanceTimersByTime(100);
    const late = document.createElement("div");
    late.className = "tm-setting-row";
    const t = document.createElement("span");
    t.className = "tm-setting-title";
    t.textContent = "主色";
    late.appendChild(t);
    document.querySelector(".tm-settings-window")!.appendChild(late);
    vi.advanceTimersByTime(40);
    expect(late.classList.contains("tm-row-flash")).toBe(true);
    stop();
  });

  it("永不命中时上限 20 次后安静放弃", () => {
    vi.useFakeTimers();
    buildWindow(["无关行"]);
    const stop = flashSettingsRowByTitle("主色", (s) => s);
    /* 空断言补强——20 次 × 120ms 上限（约 2.4s）
       耗尽后再补一个迟到目标行并推进时间，断言脉冲类不再挂上：证明轮询
       确实停止，而非「碰巧没命中所以没挂」。 */
    vi.advanceTimersByTime(3000);
    const late = document.createElement("div");
    late.className = "tm-setting-row";
    const t = document.createElement("span");
    t.className = "tm-setting-title";
    t.textContent = "主色";
    late.appendChild(t);
    document.querySelector(".tm-settings-window")!.appendChild(late);
    vi.advanceTimersByTime(1000);
    expect(late.classList.contains("tm-row-flash")).toBe(false);
    stop();
  });
});
