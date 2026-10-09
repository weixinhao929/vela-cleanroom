/**
 * 计划类配置（专注自动化规则编辑器）组件测试——回归：
 *  - 动作类型切「打开应用或网址」写非空占位 target，动作行不再被
 *    normalizeActions 剥掉（此前若规则只有这一个动作，整条规则被静默删除）；
 *    占位/空 target 在 UI 标红（aria-invalid），输入合法网址提交后恢复；
 *  - 触发方式 events→condition→events 来回切换，规则不消失
 *    （此前切回 events 时 events 恒为 []、切 condition 时非法草稿直写，
 *    两条路径都会让 normalize 丢弃整条规则）；
 *  - ：非法条件草稿只停留在草稿层（标红、不落库），blur / 来回切换
 *    触发方式都不吞规则，store 始终保留原合法条件。
 * 范式对齐 DockPage.test：直接断言 useSettingsStore 里经 setExtra →
 * sanitize → normalizeAutomationRules 之后的持久态（这才是引擎消费的数据）。
 */
import { beforeEach, describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { AutomationRulesEditor } from "./planner";
import { useSettingsStore } from "../../../store/settings-store";
import type { AutomationRule } from "../../../domain/automation";

/** 引擎真正消费的持久态：setExtra 落库前会整体 sanitize。 */
const rules = () => useSettingsStore.getState().extra.pomodoroAutomation;

function seedRule(trigger: AutomationRule["trigger"]): void {
  const rule: AutomationRule = {
    id: "r-test",
    name: "测试规则",
    enabled: true,
    trigger,
    actions: [{ kind: "notify", title: "", body: "" }]
  };
  useSettingsStore.setState((s) => ({ extra: { ...s.extra, pomodoroAutomation: [rule] } }));
}

describe("AutomationRulesEditor · P0 规则不再被静默吞掉", () => {
  beforeEach(() => {
    localStorage.clear();
    useSettingsStore.setState((s) => ({ extra: { ...s.extra, pomodoroAutomation: [] } }));
  });

  it("P0-1：切「打开应用或网址」后动作行仍在（占位 target 存活），输入合法网址后正常", async () => {
    const user = userEvent.setup();
    seedRule({ type: "events", events: ["focus-start"] });
    render(<AutomationRulesEditor />);

    // 动作类型下拉（触发器显示当前动作「发送通知」）→ 打开应用或网址。
    await user.click(screen.getByRole("button", { name: "发送通知" }));
    await user.click(screen.getByRole("option", { name: "打开应用或网址" }));

    // 动作没被剥掉：store 里仍是 1 条 open 动作，带非空占位 target。
    expect(rules()).toHaveLength(1);
    expect(rules()[0].actions).toHaveLength(1);
    expect(rules()[0].actions[0]).toMatchObject({ kind: "open", target: "https://" });

    // 输入行还在，且占位 target 标红提示（未填状态）。
    const input = screen.getByPlaceholderText("路径或 https://…");
    expect(input).toHaveValue("https://");
    expect(input).toHaveAttribute("aria-invalid", "true");

    // 输入合法网址 + Enter 提交：store 拿到真实 target，标红解除。
    await user.clear(input);
    await user.type(input, "https://example.com{enter}");
    expect(rules()[0].actions[0]).toMatchObject({ kind: "open", target: "https://example.com" });
    expect(screen.getByPlaceholderText("路径或 https://…")).not.toHaveAttribute("aria-invalid");
  });

  it("P0-2：触发方式 events→condition→events 来回切，规则不消失", async () => {
    const user = userEvent.setup();
    seedRule({ type: "events", events: ["focus-start"] });
    render(<AutomationRulesEditor />);

    // events → condition：无草稿条件，写默认占位条件，规则存活。
    await user.click(screen.getByRole("radio", { name: "条件" }));
    expect(rules()).toHaveLength(1);
    expect(rules()[0].trigger).toEqual({ type: "condition", condition: "state == focus" });

    // condition → events：离开过 events 模式后事件列表为空，写默认占位事件。
    await user.click(screen.getByRole("radio", { name: "事件" }));
    expect(rules()).toHaveLength(1);
    expect(rules()[0].trigger).toEqual({ type: "events", events: ["focus-start"] });

    // 再切回 condition：规则仍在，占位条件兜底。
    await user.click(screen.getByRole("radio", { name: "条件" }));
    expect(rules()).toHaveLength(1);
    expect(rules()[0].trigger).toEqual({ type: "condition", condition: "state == focus" });

    // 条件模式输入合法条件并提交后，再来回切不丢用户条件。
    const input = screen.getByPlaceholderText("条件，如 remaining <= 300 && isRunning");
    await user.clear(input);
    await user.type(input, "remaining <= 300 && isRunning{enter}");
    expect(rules()[0].trigger).toEqual({ type: "condition", condition: "remaining <= 300 && isRunning" });
    await user.click(screen.getByRole("radio", { name: "事件" }));
    await user.click(screen.getByRole("radio", { name: "条件" }));
    expect(rules()).toHaveLength(1);
    expect(rules()[0].trigger).toEqual({ type: "condition", condition: "remaining <= 300 && isRunning" });
  });

  it("P2-5：非法条件草稿不落库、不丢规则；blur 与触发方式切换都以占位条件兜底", async () => {
    const user = userEvent.setup();
    seedRule({ type: "condition", condition: "state == focus" });
    render(<AutomationRulesEditor />);

    const input = screen.getByPlaceholderText("条件，如 remaining <= 300 && isRunning");
    // 清空 + 敲出非法草稿（"state ==" 缺右操作数）：只进草稿、标红。
    await user.clear(input);
    await user.type(input, "state ==");
    expect(input).toHaveAttribute("aria-invalid", "true");
    // 逐键编辑期间 store 从未收到非法条件。
    expect(rules()).toHaveLength(1);
    expect(rules()[0].trigger).toEqual({ type: "condition", condition: "state == focus" });

    // blur：非法不提交（草稿保留、继续标红），规则原条件不变。
    await user.tab();
    expect(rules()[0].trigger).toEqual({ type: "condition", condition: "state == focus" });
    expect(rules()).toHaveLength(1);

    // 非法草稿悬置期间切 events 再切回：规则不消失，占位条件兜底。
    await user.click(screen.getByRole("radio", { name: "事件" }));
    expect(rules()).toHaveLength(1);
    expect(rules()[0].trigger).toEqual({ type: "events", events: ["focus-start"] });
    await user.click(screen.getByRole("radio", { name: "条件" }));
    expect(rules()).toHaveLength(1);
    expect(rules()[0].trigger).toEqual({ type: "condition", condition: "state == focus" });
  });
});
