/**
 * 计划类小组件的设置页配置表单（课程表、日历、倒计时、番茄钟等）：
 * 周次起点、显示天数、提醒档位等规划参数。番茄钟配置额外承载
 * 借鉴批次的三块：阶段推进门、事件级音效、专注自动化规则编辑器。
 */
import { useEffect, useRef, useState, type ChangeEvent, type KeyboardEvent } from "react";
import { Plus, Trash2 } from "lucide-react";
import { useSliderDraft } from "../../../lib/use-slider-draft";
import { useDelayedUnmount } from "../../../lib/anim";
import { animDurations } from "../../../lib/durations";
import { useSettingsStore } from "../../../store/settings-store";
import type { FocusMode } from "../../../store/settings-store";
import { useAppStore } from "../../../store/app-store";
import { ADVANCE_GATES, DIAL_THEMES, type PomodoroConfig, type PomodoroDialTheme } from "../../../domain/pomodoro";
import {
  AUTOMATION_ACTION_KINDS,
  AUTOMATION_EVENT_NAMES,
  validateCondition,
  type AutomationAction,
  type AutomationActionKind,
  type AutomationRule
} from "../../../domain/automation";
import { useT } from "../../../i18n-lite";
import type { WidgetConfig } from "../../../widget/widget-config";
import { Stepper, Segmented, SettingToggleRow, Dropdown } from "../shared";
import { M3Slider as Slider } from "../../../components/ui/M3Slider";

/* ---------- 专注自动化（事件/条件 → 白名单动作） ---------- */

const EVENT_LABELS: Record<string, string> = {
  "focus-start": "开始专注",
  "break-start": "开始休息",
  pause: "暂停",
  resume: "恢复计时",
  stop: "停止计时",
  "focus-finish": "完成专注",
  "break-finish": "完成休息",
  interrupt: "记录中断",
  skip: "跳过阶段"
};

const ACTION_LABELS: Record<AutomationActionKind, string> = {
  open: "打开应用或网址",
  notify: "发送通知",
  "toggle-layer": "切换小组件层",
  "show-desktop": "回到桌面",
  "task-view": "任务视图",
  lock: "锁定电脑"
};

const ACTION_KIND_OPTIONS = AUTOMATION_ACTION_KINDS.map((k) => ({ id: k, label: ACTION_LABELS[k] }));

/** 「打开应用或网址」切入瞬间的占位 target——normalizeActions 对空
 *  target 的 open 动作当场剥除（automation.ts「open 无目标 = 恒失败动作，
 *  不入库」），若该规则只有这一个动作，整条规则会被静默删除；先写一个能
 *  通过 sanitize 的非空占位保命，UI 对占位/空 target 标红提示。 */
const OPEN_TARGET_PLACEHOLDER = "https://";

/** 非法草稿的最小红边（本文件无现成 invalid 输入样式，CSS 不在本轮改动
 *  面，内联复用 --danger 令牌，与 .auto-cond-error 同色源）。 */
const INVALID_INPUT_STYLE = { borderColor: "var(--danger, #ef4444)" } as const;

/** 逐键全量落盘的文本输入改本地草稿——输入期只进草稿，blur / Enter
 *  提交、Esc 还原；valid 返回 false 时不落库（草稿保留、调用方标红）。
 *  外部持久值变化且不在编辑态时自动重同步草稿（如其它窗口改写后回填）。
 *  committedRef 防重：Enter 提交后随即 blur，避免同一草稿提交两次。 */
function useTextDraft(persisted: string, commit: (v: string) => void, valid?: (v: string) => boolean) {
  const [draft, setDraft] = useState(persisted);
  const editingRef = useRef(false);
  const committedRef = useRef(persisted);
  useEffect(() => {
    committedRef.current = persisted;
    if (!editingRef.current) setDraft(persisted);
  }, [persisted]);
  const ok = valid ? valid(draft) : true;
  const settle = (revert: boolean) => {
    editingRef.current = false;
    if (revert) {
      committedRef.current = persisted;
      setDraft(persisted);
    } else if (ok && draft !== committedRef.current) {
      committedRef.current = draft;
      commit(draft);
    }
  };
  return {
    draft,
    invalid: !ok,
    inputProps: {
      value: draft,
      onChange: (e: ChangeEvent<HTMLInputElement>) => {
        editingRef.current = true;
        setDraft(e.target.value);
      },
      onBlur: () => settle(false),
      onKeyDown: (e: KeyboardEvent<HTMLInputElement>) => {
        if (e.key === "Enter") {
          e.preventDefault();
          settle(false);
          e.currentTarget.blur();
        } else if (e.key === "Escape") {
          e.preventDefault();
          settle(true);
          e.currentTarget.blur();
        }
      }
    }
  };
}

/** 单条动作的编辑行：类型下拉 + 按类型的参数输入。 */
function AutomationActionRow({
  action,
  onChange,
  onRemove
}: {
  action: AutomationAction;
  onChange: (next: AutomationAction) => void;
  onRemove: () => void;
}) {
  const tr = useT();
  /* + ：三个参数输入都走草稿，blur / Enter 提交、Esc 还原。
     open 的 target 切入时是占位值 https://（防 normalizeActions 剥动作），
     占位/清空视为未填：标红且不落库，输入合法值后恢复。 */
  const target = useTextDraft(
    action.target ?? "",
    (v) => onChange({ ...action, target: v }),
    (v) => {
      const t = v.trim();
      return t !== "" && t !== OPEN_TARGET_PLACEHOLDER;
    }
  );
  const title = useTextDraft(action.title ?? "", (v) => onChange({ ...action, title: v }));
  const body = useTextDraft(action.body ?? "", (v) => onChange({ ...action, body: v }));
  return (
    <div className="auto-action-row">
      <Dropdown<AutomationActionKind>
        value={action.kind}
        options={ACTION_KIND_OPTIONS}
        onChange={(kind) =>
          onChange({
            kind,
            ...(kind === "open" ? { target: OPEN_TARGET_PLACEHOLDER } : { title: "", body: "" })
          })
        }
      />
      {action.kind === "open" && (
        <input
          className="tm-text-input"
          {...target.inputProps}
          placeholder={tr("路径或 https://…")}
          aria-invalid={target.invalid || undefined}
          style={target.invalid ? INVALID_INPUT_STYLE : undefined}
          data-interactive
        />
      )}
      {action.kind === "notify" && (
        <>
          <input className="tm-text-input" {...title.inputProps} placeholder={tr("通知标题")} data-interactive />
          <input className="tm-text-input" {...body.inputProps} placeholder={tr("通知正文")} data-interactive />
        </>
      )}
      <button
        type="button"
        className="auto-action-remove"
        onClick={onRemove}
        aria-label={tr("删除动作")}
        title={tr("删除动作")}
      >
        <Trash2 size={13} />
      </button>
    </div>
  );
}

/** 一组动作（事件模式 / 条件模式的进入或退出动作集）。 */
function AutomationActionsEditor({
  label,
  actions,
  onChange
}: {
  label: string;
  actions: AutomationAction[];
  onChange: (next: AutomationAction[]) => void;
}) {
  const tr = useT();
  /* 行 key 用会话级稳定 id（ref 按位对齐）——下标 key 在删除中段行
     时让后续行继承前一行身份，Dropdown 的 open 态会串行。id 不入领域类型
     （normalizeActions 白名单字段，即使意外持久化也会被剥掉）。编辑是逐行
     不可变更新，逐位对齐即与数据同步；外部整表替换（换配置/重置）按长度
     截齐补齐，那种重排本来就该整表重挂。 */
  const idsRef = useRef<string[]>([]);
  const seqRef = useRef(0);
  const ids = idsRef.current;
  if (ids.length > actions.length) ids.length = actions.length;
  while (ids.length < actions.length) ids.push(`act-${++seqRef.current}`);
  return (
    <div className="auto-actions">
      <span className="auto-actions-label">{label}</span>
      {actions.map((a, i) => (
        <AutomationActionRow
          key={ids[i]}
          action={a}
          onChange={(next) => onChange(actions.map((x, j) => (j === i ? next : x)))}
          onRemove={() => {
            ids.splice(i, 1);
            onChange(actions.filter((_, j) => j !== i));
          }}
        />
      ))}
      <button
        type="button"
        className="auto-actions-add"
        onClick={() => onChange([...actions, { kind: "notify", title: "", body: "" }])}
        disabled={actions.length >= 8}
      >
        <Plus size={12} />
        {tr("添加动作")}
      </button>
    </div>
  );
}

/** 单条规则卡片：名称/开关/触发方式（事件多选或条件表达式）/动作集。 */
function AutomationRuleCard({
  rule,
  onChange,
  onRemove
}: {
  rule: AutomationRule;
  onChange: (next: AutomationRule) => void;
  onRemove: () => void;
}) {
  const tr = useT();
  // 闭包内属性窄化会失效（rule.trigger 在回调里回到联合类型），提取局部别名。
  const eventNames = rule.trigger.type === "events" ? rule.trigger.events : [];
  const condValue = rule.trigger.type === "condition" ? rule.trigger.condition : "";
  const procValue = rule.trigger.type === "process" ? rule.trigger.process : undefined;
  /* + ：条件输入走草稿——输入期不落库（此前逐键写回，非法中间态
     会被 normalize 整条吞掉），blur / Enter 且合法才提交，非法保持草稿 +
     标红；外部 rule.trigger.condition 变化且不在编辑态时重同步草稿。
     重同步只认非空外部值：触发方式切到 events 后条件字段缺席不算外部
     改写，草稿保留，切回条件模式（condCandidate）复用，不因往返丢输入。 */
  const [condDraft, setCondDraft] = useState(condValue);
  const condEditingRef = useRef(false);
  const condCommittedRef = useRef(condValue);
  const condValid = condDraft.trim() !== "" && !validateCondition(condDraft);
  useEffect(() => {
    condCommittedRef.current = condValue;
    if (!condEditingRef.current && condValue) setCondDraft(condValue);
  }, [condValue]);
  const settleCond = (revert: boolean) => {
    condEditingRef.current = false;
    if (revert) {
      condCommittedRef.current = condValue;
      setCondDraft(condValue);
    } else if (condValid && condDraft !== condCommittedRef.current) {
      condCommittedRef.current = condDraft;
      onChange({ ...rule, trigger: { type: "condition", condition: condDraft } });
    }
  };
  const condError = condDraft.trim() ? validateCondition(condDraft) : null;
  /* 切 condition 时草稿合法才带上，否则写默认占位条件兜底
     （normalize 对无可解析条件的规则按整条丢弃处理）。 */
  const condCandidate = condValid ? condDraft : "state == focus";
  /* 规则名输入期只进草稿，blur / Enter 提交、Esc 还原。 */
  const name = useTextDraft(rule.name, (v) => onChange({ ...rule, name: v }));
  return (
    <div className="auto-rule">
      <div className="auto-rule-head">
        <input className="tm-text-input" {...name.inputProps} placeholder={tr("规则名称")} data-interactive />
        <label className="auto-rule-enabled" title={tr("启用该规则")}>
          <input
            type="checkbox"
            checked={rule.enabled}
            onChange={(e) => onChange({ ...rule, enabled: e.target.checked })}
            aria-label={tr("启用该规则")}
          />
        </label>
        <button
          type="button"
          className="auto-action-remove"
          onClick={onRemove}
          aria-label={tr("删除规则")}
          title={tr("删除规则")}
        >
          <Trash2 size={13} />
        </button>
      </div>
      <div className="tm-setting-row">
        <div className="tm-setting-text">
          <span className="tm-setting-title">{tr("触发方式")}</span>
          <span className="tm-setting-desc">
            {tr("事件 = 每次发生时执行；条件 = 进入/退出时分别执行；进程 = 指定进程启动/退出时执行")}
          </span>
        </div>
        <Segmented
          value={rule.trigger.type}
          options={[
            { id: "events", label: tr("事件") },
            { id: "condition", label: tr("条件") },
            { id: "process", label: tr("进程") }
          ]}
          onChange={(v) =>
            onChange(
              /* 切回 events 时若离开过 events 模式（eventNames 恒为
                 []），写默认占位事件，否则 normalize 按「事件为空」丢弃整条
                 规则；切 condition 时草稿非法则写默认占位条件（condCandidate
                 已兜底）。 */
              v === "events"
                ? { ...rule, trigger: { type: "events", events: eventNames.length ? eventNames : ["focus-start"] } }
                : v === "process"
                  ? {
                      ...rule,
                      trigger: {
                        type: "process",
                        process: procValue ?? { name: "cargo.exe", event: "exit" }
                      }
                    }
                  : { ...rule, trigger: { type: "condition", condition: condCandidate } }
            )
          }
        />
      </div>
      {rule.trigger.type === "events" ? (
        <div className="auto-events">
          {AUTOMATION_EVENT_NAMES.map((name) => {
            const on = eventNames.includes(name);
            return (
              <button
                key={name}
                type="button"
                className={`auto-event-chip${on ? " on" : ""}`}
                aria-pressed={on}
                onClick={() =>
                  onChange({
                    ...rule,
                    trigger: {
                      type: "events",
                      events: on ? eventNames.filter((e) => e !== name) : [...eventNames, name]
                    }
                  })
                }
              >
                {tr(EVENT_LABELS[name])}
              </button>
            );
          })}
        </div>
      ) : rule.trigger.type === "process" ? (
        <>
          {/* [PROC-WATCH]：进程模式编辑（通配与
              Rust wildcard_match 同语义）。 */}
          <div className="auto-cond">
            <input
              className="tm-text-input"
              value={procValue?.name ?? ""}
              onChange={(e) =>
                onChange({
                  ...rule,
                  trigger: {
                    type: "process",
                    process: { name: e.target.value, event: procValue?.event ?? "exit" }
                  }
                })
              }
              placeholder={tr("进程名，如 cargo.exe 或 *.exe（支持 * 和 ? 通配）")}
              data-interactive
            />
          </div>
          <div className="tm-setting-row">
            <div className="tm-setting-text">
              <span className="tm-setting-title">{tr("触发时机")}</span>
              <span className="tm-setting-desc">{tr("轮询检测（约 5 秒一拍）；已在运行的进程不算启动")}</span>
            </div>
            <Segmented
              value={procValue?.event ?? "exit"}
              options={[
                { id: "start", label: tr("启动时") },
                { id: "exit", label: tr("退出时") }
              ]}
              onChange={(v) =>
                onChange({
                  ...rule,
                  trigger: {
                    type: "process",
                    process: { name: procValue?.name ?? "cargo.exe", event: v === "start" ? "start" : "exit" }
                  }
                })
              }
            />
          </div>
          <AutomationActionsEditor
            label={tr("执行动作")}
            actions={rule.actions}
            onChange={(actions) => onChange({ ...rule, actions })}
          />
        </>
      ) : (
        <>
          <div className="auto-cond">
            <input
              className="tm-text-input"
              value={condDraft}
              onChange={(e) => {
                condEditingRef.current = true;
                setCondDraft(e.target.value);
              }}
              onBlur={() => settleCond(false)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  settleCond(false);
                  e.currentTarget.blur();
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  settleCond(true);
                  e.currentTarget.blur();
                }
              }}
              placeholder={tr("条件，如 remaining <= 300 && isRunning")}
              aria-invalid={!condValid || undefined}
              style={!condValid ? INVALID_INPUT_STYLE : undefined}
              data-interactive
            />
            {condError && <span className="auto-cond-error">{condError}</span>}
          </div>
          <AutomationActionsEditor
            label={tr("进入条件时")}
            actions={rule.actions}
            onChange={(actions) => onChange({ ...rule, actions })}
          />
          <AutomationActionsEditor
            label={tr("退出条件时")}
            actions={rule.exitActions ?? []}
            onChange={(exitActions) => onChange({ ...rule, exitActions })}
          />
        </>
      )}
      {rule.trigger.type === "events" && (
        <AutomationActionsEditor
          label={tr("执行动作")}
          actions={rule.actions}
          onChange={(actions) => onChange({ ...rule, actions })}
        />
      )}
    </div>
  );
}

/** 规则列表（settings.extra.pomodoroAutomation 的编辑面）。导出供组件测试
 *  直接渲染（不必挂起整页番茄钟配置）。 */
export function AutomationRulesEditor() {
  const tr = useT();
  const rules = useSettingsStore((s) => s.extra.pomodoroAutomation);
  const setExtra = useSettingsStore((s) => s.setExtra);
  const update = (next: AutomationRule[]) => setExtra({ pomodoroAutomation: next });
  return (
    <>
      <p className="tm-setting-note">
        {tr("在番茄钟开始/结束等节点自动执行动作；动作均为受控白名单，不执行任意脚本。")}
      </p>
      {rules.map((r) => (
        <AutomationRuleCard
          key={r.id}
          rule={r}
          onChange={(next) => update(rules.map((x) => (x.id === r.id ? next : x)))}
          onRemove={() => update(rules.filter((x) => x.id !== r.id))}
        />
      ))}
      <button
        type="button"
        className="auto-rule-add"
        onClick={() =>
          update([
            ...rules,
            {
              /* randomUUID 替代 `rule-${Date.now().toString(36)}`——批量建
                 规则/同毫秒重放会撞 id，撞键的规则被 normalize 按 seenIds 丢弃。 */
              id: crypto.randomUUID(),
              name: tr("新规则"),
              enabled: true,
              trigger: { type: "events", events: ["focus-start"] },
              actions: [{ kind: "notify", title: "", body: "" }]
            }
          ])
        }
      >
        <Plus size={12} />
        {tr("添加规则")}
      </button>
    </>
  );
}

export function CalendarConfig({
  config,
  update
}: {
  config: WidgetConfig;
  update: (p: Partial<WidgetConfig>) => void;
}) {
  const tr = useT();
  /* icsUrl 走草稿、blur / Enter 提交（提交时才 trim）——此前逐键
     trim + 全量落盘，粘贴/中间态输入被 trim 干扰且每键一次落盘链。 */
  const icsUrl = useTextDraft((config.icsUrl as string) || "", (v) => update({ icsUrl: v.trim() }));
  return (
    <>
      <div className="tm-setting-row">
        <div className="tm-setting-text">
          <span className="tm-setting-title">{tr("视图粒度")}</span>
          <span className="tm-setting-desc">{tr("月网格 / 单周清单 / 双月并排")}</span>
        </div>
        <Segmented
          value={(config.viewMode as string) || "month"}
          onChange={(v) => update({ viewMode: v })}
          options={[
            { id: "month", label: "月" },
            { id: "week", label: "周" },
            { id: "double", label: "双月" }
          ]}
        />
      </div>
      <SettingToggleRow
        title="显示农历"
        desc="在日历中显示农历日期"
        on={config.showLunar !== false}
        onChange={(v) => update({ showLunar: v })}
      />
      <SettingToggleRow
        title="显示节气"
        desc="在农历位置优先显示节气名"
        on={config.showSolarTerms !== false}
        onChange={(v) => update({ showSolarTerms: v })}
      />
      <SettingToggleRow
        title="显示节假日"
        desc="显示法定节假日与纪念日"
        on={config.showHolidays !== false}
        onChange={(v) => update({ showHolidays: v })}
      />
      <SettingToggleRow
        title="显示放假标记"
        desc="在放假日期右上角显示「休」标记"
        on={config.showRestMarks !== false}
        onChange={(v) => update({ showRestMarks: v })}
      />
      <SettingToggleRow
        title="显示纪念日标记"
        desc="在纪念日右上角显示「纪」标记"
        on={config.showMemorialMarks !== false}
        onChange={(v) => update({ showMemorialMarks: v })}
      />
      <SettingToggleRow
        title="显示事件圆点"
        desc="在有事件的日期下方显示圆点"
        on={config.showEventDots !== false}
        onChange={(v) => update({ showEventDots: v })}
      />
      <SettingToggleRow
        title="月格事件摘要"
        desc="在月视图格子里直接显示前两条事件名"
        on={config.showCellEvents !== false}
        onChange={(v) => update({ showCellEvents: v })}
      />
      <SettingToggleRow
        title="紧凑模式"
        desc="缩小格子间距，同屏显示更多月份内容"
        on={!!config.compact}
        onChange={(v) => update({ compact: v })}
      />
      <SettingToggleRow
        title="显示周数"
        desc="在日历左侧显示 ISO 周数"
        on={!!config.showWeekNumber}
        onChange={(v) => update({ showWeekNumber: v })}
      />
      <div className="tm-setting-row">
        <div className="tm-setting-text">
          <span className="tm-setting-title">{tr("每周首日")}</span>
          <span className="tm-setting-desc">{tr("日历周起始日")}</span>
        </div>
        <Segmented
          value={(config.firstDayOfWeek as string) || "monday"}
          onChange={(v) => update({ firstDayOfWeek: v })}
          options={[
            { id: "monday", label: "星期一" },
            { id: "sunday", label: "星期日" }
          ]}
        />
      </div>
      {/* ICS 订阅：Google/Outlook 日历只读同步。 */}
      <SettingToggleRow
        title="订阅外部日历"
        desc="通过 ICS 链接只读同步 Google / Outlook 日历事件"
        on={config.icsEnabled === true}
        onChange={(v) => update({ icsEnabled: v })}
      />
      {useDelayedUnmount(config.icsEnabled === true, animDurations().fxFastMs) && (
        <div className={`tm-setting-row tm-row-collapse${config.icsEnabled === true ? "" : " is-closing"}`}>
          <div className="tm-setting-text">
            <span className="tm-setting-title">{tr("ICS 订阅链接")}</span>
            <span className="tm-setting-desc">{tr("Google 日历 → 设置 → 私密网址 → iCal 链接")}</span>
          </div>
          <input
            type="url"
            className="tm-text-input"
            style={{ width: 240 }}
            placeholder="https://calendar.google.com/calendar/ical/…/basic.ics"
            aria-label={tr("ICS 订阅链接")}
            {...icsUrl.inputProps}
            data-interactive
          />
        </div>
      )}
    </>
  );
}

/** 表盘皮肤的可读名（稳定中文键，展示时经 tr 翻译）。 */
const DIAL_THEME_LABELS: Record<(typeof DIAL_THEMES)[number], string> = {
  accent: "主题色",
  mint: "薄荷",
  sunset: "日落",
  ocean: "海洋",
  violet: "紫罗兰"
};

export function PomodoroWidgetConfig({
  config: wc,
  update: wUpdate
}: {
  config: WidgetConfig;
  update: (p: Partial<WidgetConfig>) => void;
}) {
  const tr = useT();
  const config = useAppStore((s) => s.pomodoroConfig);
  const setConfig = useAppStore((s) => s.setPomodoroConfig);
  /* 标量 selector 替代整对象订阅（extra/general 每键 setExtra 时不再
     重渲本表单）。 */
  const focusMode = useSettingsStore((s) => s.extra.focusMode);
  const setExtra = useSettingsStore((s) => s.setExtra);
  const pauseWhenIdle = useSettingsStore((s) => s.general.pauseWhenIdle);
  const setGeneral = useSettingsStore((s) => s.setGeneral);
  // 通知设置原为侧栏独立页，现并入番茄钟组件配置的「通知」栏。
  const n = useSettingsStore((s) => s.notifications);
  const setN = useSettingsStore((s) => s.setNotifications);
  // 番茄钟计时器是全局共享的（托盘、快捷键、游戏暂停都使用同一计时器），
  // 因此小组件配置页直接写入全局配置，保证设置真正生效且不破坏联动。
  // 运行中修改**不会**重置当前段（app-store.setPomodoroConfig 只更新配置字段，
  // 新时长下一段生效），此前每拨一格滑条都弹"会重置当前计时"的确认框——与
  // 实际行为相反且极其扰人。
  const apply = (patch: Partial<PomodoroConfig>) => {
    setConfig({ ...config, ...patch });
  };
  /* 三个时长滑杆拖动期只进草稿、松手（onCommitEnd）一次 apply()
     （写入全局 store + 落盘链），不再逐 input 事件全量提交。 */
  const focusMinutes = useSliderDraft((v) => apply({ focusMinutes: v }));
  const shortBreakMinutes = useSliderDraft((v) => apply({ shortBreakMinutes: v }));
  const longBreakMinutes = useSliderDraft((v) => apply({ longBreakMinutes: v }));
  const goalMode = config.dailyGoalMode ?? "sessions";
  return (
    <>
      <div className="tm-setting-row">
        <div className="tm-setting-text">
          <span className="tm-setting-title">{tr("每日目标方式")}</span>
          <span className="tm-setting-desc">{tr("按轮数或时长计（专注统计的每日目标与连胜）")}</span>
        </div>
        <Segmented
          value={goalMode}
          options={[
            { id: "sessions", label: tr("轮数") },
            { id: "minutes", label: tr("时长") }
          ]}
          onChange={(v) => apply({ dailyGoalMode: v as "sessions" | "minutes" })}
        />
      </div>
      <div className="tm-setting-row">
        <div className="tm-setting-text">
          <span className="tm-setting-title">{tr("每日专注目标")}</span>
          <span className="tm-setting-desc">{tr("0 为不设目标")}</span>
        </div>
        <Stepper
          value={goalMode === "minutes" ? (config.dailyGoalMinutes ?? 120) : config.dailyGoalSessions}
          suffix={goalMode === "minutes" ? "分" : "轮"}
          min={0}
          max={goalMode === "minutes" ? 1440 : 24}
          onChange={(v) => apply(goalMode === "minutes" ? { dailyGoalMinutes: v } : { dailyGoalSessions: v })}
        />
      </div>
      <SettingToggleRow
        title="空闲时暂停"
        desc="无输入超过 5 分钟自动暂停专注"
        on={pauseWhenIdle}
        onChange={(v) => setGeneral({ pauseWhenIdle: v })}
      />
      <div className="tm-setting-row">
        <div className="tm-setting-text">
          <span className="tm-setting-title">{tr("专注时长")}</span>
          <span className="tm-setting-desc">{tr("单次专注时长（分钟）")}</span>
        </div>
        <Slider
          label="专注时长"
          value={focusMinutes.draft ?? config.focusMinutes}
          min={1}
          max={180}
          step={1}
          suffix="分钟"
          onChange={focusMinutes.slide}
          onCommitEnd={focusMinutes.commitEnd}
        />
      </div>
      <div className="tm-setting-row">
        <div className="tm-setting-text">
          <span className="tm-setting-title">{tr("短休时长")}</span>
          <span className="tm-setting-desc">{tr("阶段切换进入短休时的时长（分钟）")}</span>
        </div>
        <Slider
          label="短休时长"
          value={shortBreakMinutes.draft ?? config.shortBreakMinutes}
          min={1}
          max={60}
          step={1}
          suffix="分钟"
          onChange={shortBreakMinutes.slide}
          onCommitEnd={shortBreakMinutes.commitEnd}
        />
      </div>
      <div className="tm-setting-row">
        <div className="tm-setting-text">
          <span className="tm-setting-title">{tr("长休时长")}</span>
          <span className="tm-setting-desc">{tr("阶段切换进入长休时的时长（分钟）")}</span>
        </div>
        <Slider
          label="长休时长"
          value={longBreakMinutes.draft ?? config.longBreakMinutes}
          min={1}
          max={120}
          step={1}
          suffix="分钟"
          onChange={longBreakMinutes.slide}
          onCommitEnd={longBreakMinutes.commitEnd}
        />
      </div>
      <div className="tm-setting-row">
        <div className="tm-setting-text">
          <span className="tm-setting-title">{tr("长休间隔")}</span>
          <span className="tm-setting-desc">{tr("每完成几轮专注后进入一次长休")}</span>
        </div>
        <Stepper
          value={config.longBreakInterval}
          suffix="轮"
          onChange={(v) => apply({ longBreakInterval: Math.max(1, Math.min(12, v)) })}
        />
      </div>
      <SettingToggleRow
        title="自动开始下一轮"
        desc="倒计时结束后自动开始下一轮专注"
        on={config.autoStartNext !== false}
        onChange={(v) => apply({ autoStartNext: v })}
      />
      {/* （救活）：autoCycle 此前无任何 UI 入口，用户无法关闭自动循环。 */}
      <SettingToggleRow
        title="自动循环休息"
        desc="专注结束自动进入长短休、休息结束回到专注；关闭则专注结束回到新专注段"
        on={config.autoCycle !== false}
        onChange={(v) => apply({ autoCycle: v })}
      />
      {/* （救活）：表盘配色（5 套皮肤已在面板侧实现渲染）此前无任何
          UI 入口，配置永远停留在默认 accent。 */}
      <div className="tm-setting-row">
        <div className="tm-setting-text">
          <span className="tm-setting-title">{tr("表盘配色")}</span>
          <span className="tm-setting-desc">{tr("专注表盘进度弧的配色皮肤")}</span>
        </div>
        <Segmented
          value={config.dialTheme ?? "accent"}
          options={DIAL_THEMES.map((id: PomodoroDialTheme) => ({
            id,
            label: tr(DIAL_THEME_LABELS[id])
          }))}
          onChange={(v) => apply({ dialTheme: v as PomodoroDialTheme })}
        />
      </div>
      {/* 阶段推进门 */}
      <div className="tm-setting-row">
        <div className="tm-setting-text">
          <span className="tm-setting-title">{tr("阶段推进")}</span>
          <span className="tm-setting-desc">{tr("自动衔接；或每段结束等确认；或休息后等你回到座位再开始专注")}</span>
        </div>
        <Segmented
          value={config.advanceGate ?? "auto"}
          options={[
            { id: "auto", label: tr("自动") },
            { id: "confirm", label: tr("等确认") },
            { id: "wait-activity", label: tr("等我回来") }
          ]}
          onChange={(v) => apply({ advanceGate: v as (typeof ADVANCE_GATES)[number] })}
        />
      </div>
      <SettingToggleRow
        title="旋转外圈刻度"
        desc="专注时外圈刻度持续旋转（默认固定不动）"
        on={!!wc.spinRing}
        onChange={(v) => wUpdate({ spinRing: v })}
      />
      <div className="tm-setting-row">
        <div className="tm-setting-text">
          <span className="tm-setting-title">{tr("专注沉浸强度")}</span>
          <span className="tm-setting-desc">
            {tr("专注时对画布的处理强度：无=只高亮番茄钟；轻=隐藏其他小组件；深=隐藏并锁定交互")}
          </span>
        </div>
        <Segmented
          value={focusMode}
          onChange={(v) => setExtra({ focusMode: v as FocusMode })}
          options={[
            { id: "off", label: "无" },
            { id: "light", label: "轻" },
            { id: "medium", label: "中" },
            { id: "deep", label: "深" }
          ]}
        />
      </div>
      <p className="tm-setting-note">
        {tr("在小组件内通过「阶段」切换可进入短休/长休，休息采用倒计时；专注结束后保持单段模式，不自动进入休息。")}
      </p>
      <div className="tm-section-title" style={{ marginTop: 4 }}>
        {tr("通知")}
      </div>
      <SettingToggleRow
        title="启用番茄钟通知"
        desc="在专注 / 休息结束时发送通知"
        on={n.pomodoroEnabled}
        onChange={(v) => setN({ pomodoroEnabled: v })}
      />
      <SettingToggleRow
        title="结束时播放提示音"
        desc="专注或休息结束时播放声音提醒"
        on={n.pomodoroSound}
        onChange={(v) => setN({ pomodoroSound: v })}
      />
      <SettingToggleRow
        title="桌面通知"
        desc="在系统托盘显示完成提示"
        on={n.pomodoroToast}
        onChange={(v) => setN({ pomodoroToast: v })}
      />
      <SettingToggleRow
        title="自动切换模式"
        desc="结束当前阶段后自动进入下一阶段"
        on={n.pomodoroModeSwitch}
        onChange={(v) => setN({ pomodoroModeSwitch: v })}
      />
      {/* 事件级音效（音色/音量按事件独立配置） */}
      <div className="tm-setting-row">
        <div className="tm-setting-text">
          <span className="tm-setting-title">{tr("专注结束音")}</span>
          <span className="tm-setting-desc">{tr("完成一轮专注时播放")}</span>
        </div>
        <Dropdown
          value={n.pomodoroFocusEndSound}
          options={[
            { id: "soft", label: tr("轻双音") },
            { id: "bell", label: tr("响铃") },
            { id: "digital", label: tr("电子音") },
            { id: "marimba", label: tr("木琴") },
            { id: "none", label: tr("无") }
          ]}
          onChange={(v) => setN({ pomodoroFocusEndSound: v })}
        />
      </div>
      <div className="tm-setting-row">
        <div className="tm-setting-text">
          <span className="tm-setting-title">{tr("专注结束音量")}</span>
        </div>
        <Stepper
          value={n.pomodoroFocusEndVolume}
          suffix="%"
          min={0}
          max={100}
          onChange={(v) => setN({ pomodoroFocusEndVolume: v })}
        />
      </div>
      <div className="tm-setting-row">
        <div className="tm-setting-text">
          <span className="tm-setting-title">{tr("休息结束音")}</span>
          <span className="tm-setting-desc">{tr("休息结束时提醒回座（默认比专注结束更响）")}</span>
        </div>
        <Dropdown
          value={n.pomodoroBreakEndSound}
          options={[
            { id: "soft", label: tr("轻双音") },
            { id: "bell", label: tr("响铃") },
            { id: "digital", label: tr("电子音") },
            { id: "marimba", label: tr("木琴") },
            { id: "none", label: tr("无") }
          ]}
          onChange={(v) => setN({ pomodoroBreakEndSound: v })}
        />
      </div>
      <div className="tm-setting-row">
        <div className="tm-setting-text">
          <span className="tm-setting-title">{tr("休息结束音量")}</span>
        </div>
        <Stepper
          value={n.pomodoroBreakEndVolume}
          suffix="%"
          min={0}
          max={100}
          onChange={(v) => setN({ pomodoroBreakEndVolume: v })}
        />
      </div>
      <div className="tm-setting-row">
        <div className="tm-setting-text">
          <span className="tm-setting-title">{tr("专注滴答声")}</span>
          <span className="tm-setting-desc">{tr("专注进行中的循环背景音")}</span>
        </div>
        <Dropdown
          value={n.pomodoroTickSound}
          options={[
            { id: "none", label: tr("无") },
            { id: "clock", label: tr("挂钟") },
            { id: "metronome", label: tr("节拍器") }
          ]}
          onChange={(v) => setN({ pomodoroTickSound: v })}
        />
      </div>
      {n.pomodoroTickSound !== "none" && (
        <div className="tm-setting-row">
          <div className="tm-setting-text">
            <span className="tm-setting-title">{tr("滴答音量")}</span>
          </div>
          <Stepper
            value={n.pomodoroTickVolume}
            suffix="%"
            min={0}
            max={100}
            onChange={(v) => setN({ pomodoroTickVolume: v })}
          />
        </div>
      )}
      {/* 专注自动化规则 */}
      <div className="tm-section-title" style={{ marginTop: 4 }}>
        {tr("专注自动化")}
      </div>
      <AutomationRulesEditor />
    </>
  );
}

export function TodoConfig({ config, update }: { config: WidgetConfig; update: (p: Partial<WidgetConfig>) => void }) {
  const tr = useT();
  /* 最大显示条数滑杆拖动期只进草稿、松手一次 update()。 */
  const maxItems = useSliderDraft((v) => update({ maxItems: v }));
  // 通知设置原为侧栏独立页，现并入待办组件配置的「通知」栏。
  const n = useSettingsStore((s) => s.notifications);
  const setN = useSettingsStore((s) => s.setNotifications);
  return (
    <>
      <SettingToggleRow
        title="显示已完成"
        desc="在列表中显示已完成的任务"
        on={config.showCompleted !== false}
        onChange={(v) => update({ showCompleted: v })}
      />
      <SettingToggleRow
        title="显示完成计数"
        desc="在标题栏显示完成数量"
        on={config.showCount !== false}
        onChange={(v) => update({ showCount: v })}
      />
      <SettingToggleRow
        title="显示进度条"
        desc="在输入框下方显示完成进度条"
        on={config.showProgressTrack !== false}
        onChange={(v) => update({ showProgressTrack: v })}
      />
      <SettingToggleRow
        title="显示空状态提示"
        desc="没有任务时显示提示信息"
        on={config.showEmptyState !== false}
        onChange={(v) => update({ showEmptyState: v })}
      />
      <SettingToggleRow
        title="显示筛选栏"
        desc="在列表上方显示 全部/进行中/已完成 筛选"
        on={config.showFilter !== false}
        onChange={(v) => update({ showFilter: v })}
      />
      <SettingToggleRow
        title={tr("按截止分组")}
        desc={tr("逾期 / 今天到期 / 即将到来 分组显示")}
        on={config.showDueGrouping !== false}
        onChange={(v) => update({ showDueGrouping: v })}
      />
      <div className="tm-setting-row">
        <div className="tm-setting-text">
          <span className="tm-setting-title">{tr("排序方式")}</span>
          <span className="tm-setting-desc">{tr("未完成任务始终排在前面；手动排序可拖动调整")}</span>
        </div>
        <Segmented
          value={(config.sortOrder as string) || "newest"}
          onChange={(v) => update({ sortOrder: v })}
          options={[
            { id: "newest", label: "最新在前" },
            { id: "oldest", label: "最旧在前" },
            { id: "manual", label: "手动排序" }
          ]}
        />
      </div>
      <div className="tm-setting-row">
        <div className="tm-setting-text">
          <span className="tm-setting-title">{tr("最大显示条数")}</span>
          <span className="tm-setting-desc">{tr("0 表示不限制")}</span>
        </div>
        <Slider
          label="最大显示条数"
          value={maxItems.draft ?? ((config.maxItems as number) || 0)}
          min={0}
          max={50}
          step={1}
          suffix="条"
          onChange={maxItems.slide}
          onCommitEnd={maxItems.commitEnd}
        />
      </div>
      <div className="tm-section-title" style={{ marginTop: 4 }}>
        {tr("通知")}
      </div>
      <SettingToggleRow
        title="启用待办提醒"
        desc="在截止日期临近时提醒"
        on={n.todoEnabled}
        onChange={(v) => setN({ todoEnabled: v })}
      />
      <SettingToggleRow
        title="提醒提示音"
        desc="提醒时播放声音"
        on={n.todoSound}
        onChange={(v) => setN({ todoSound: v })}
      />
      <SettingToggleRow
        title="桌面通知"
        desc="在系统托盘显示待办提醒"
        on={n.todoToast}
        onChange={(v) => setN({ todoToast: v })}
      />
      <SettingToggleRow
        title="逾期提醒"
        desc="对已过期的待办持续提醒"
        on={n.todoOverdue}
        onChange={(v) => setN({ todoOverdue: v })}
      />
      <div className="tm-section-title" style={{ marginTop: 4 }}>
        {tr("通知来源")}
      </div>
      <p className="tm-setting-note">{tr("逐源控制各小组件的系统通知；专注模式（中/深）期间自动静音。")}</p>
      <SettingToggleRow
        title="习惯打卡提醒"
        desc="习惯到期未打卡时提醒"
        on={n.sources.habit !== false}
        onChange={(v) => setN({ sources: { ...n.sources, habit: v } })}
      />
      <SettingToggleRow
        title="日历提醒"
        desc="日历事件到点提醒"
        on={n.sources.calendar !== false}
        onChange={(v) => setN({ sources: { ...n.sources, calendar: v } })}
      />
      <SettingToggleRow
        title="课程表上课提醒"
        desc="下节课开始前推送提醒"
        on={n.sources.timetable !== false}
        onChange={(v) => setN({ sources: { ...n.sources, timetable: v } })}
      />
      <SettingToggleRow
        title="倒计时结束"
        desc="小组件倒计时结束时提醒"
        on={n.sources.countdown !== false}
        onChange={(v) => setN({ sources: { ...n.sources, countdown: v } })}
      />
      <SettingToggleRow
        title="新邮件"
        desc="收到未读邮件时提醒"
        on={n.sources.email !== false}
        onChange={(v) => setN({ sources: { ...n.sources, email: v } })}
      />
      <SettingToggleRow
        title="天气预警"
        desc="气象预警发布时提醒"
        on={n.sources.weather !== false}
        onChange={(v) => setN({ sources: { ...n.sources, weather: v } })}
      />
      <SettingToggleRow
        title="蓝牙设备"
        desc="断连与低电量提醒"
        on={n.sources.bluetooth !== false}
        onChange={(v) => setN({ sources: { ...n.sources, bluetooth: v } })}
      />
      <SettingToggleRow
        title="应用事件"
        desc="退出拦截、快捷键冲突等应用级提醒"
        on={n.sources.app !== false}
        onChange={(v) => setN({ sources: { ...n.sources, app: v } })}
      />
    </>
  );
}

export function DeadlinesConfig({
  config,
  update
}: {
  config: WidgetConfig;
  update: (p: Partial<WidgetConfig>) => void;
}) {
  const tr = useT();
  /* 同 TodoConfig，最大显示条数滑杆走草稿、松手一次提交。 */
  const maxItems = useSliderDraft((v) => update({ maxItems: v }));
  return (
    <>
      <SettingToggleRow
        title="显示已完成"
        desc="在列表中显示已完成的截止日期"
        on={config.showCompleted !== false}
        onChange={(v) => update({ showCompleted: v })}
      />
      <SettingToggleRow
        title="显示逾期高亮"
        desc="逾期未完成的截止日期以醒目颜色标出"
        on={config.showOverdue !== false}
        onChange={(v) => update({ showOverdue: v })}
      />
      <SettingToggleRow
        title="显示紧急程度"
        desc="未完成项左侧按紧急程度显示强调色条"
        on={config.showUrgency !== false}
        onChange={(v) => update({ showUrgency: v })}
      />
      <SettingToggleRow
        title="显示分组"
        desc="按逾期/今天/未来/已完成分组显示"
        on={config.showGrouping !== false}
        onChange={(v) => update({ showGrouping: v })}
      />
      <SettingToggleRow
        title="显示剩余时间"
        desc="在每项下方显示距离截止的相对时间"
        on={config.showRelativeTime !== false}
        onChange={(v) => update({ showRelativeTime: v })}
      />
      <div className="tm-setting-row">
        <div className="tm-setting-text">
          <span className="tm-setting-title">{tr("排序方式")}</span>
          <span className="tm-setting-desc">{tr("未完成项始终排在前面")}</span>
        </div>
        <Segmented
          value={(config.sortOrder as string) || "soonest"}
          onChange={(v) => update({ sortOrder: v })}
          options={[
            { id: "soonest", label: "最近到期" },
            { id: "latest", label: "最晚到期" }
          ]}
        />
      </div>
      <div className="tm-setting-row">
        <div className="tm-setting-text">
          <span className="tm-setting-title">{tr("最大显示条数")}</span>
          <span className="tm-setting-desc">{tr("0 表示不限制")}</span>
        </div>
        <Slider
          label="最大显示条数"
          value={maxItems.draft ?? ((config.maxItems as number) || 0)}
          min={0}
          max={50}
          step={1}
          suffix="条"
          onChange={maxItems.slide}
          onCommitEnd={maxItems.commitEnd}
        />
      </div>
      <SettingToggleRow
        title={tr("启用多档提醒")}
        desc={tr("到期前 24 小时 / 1 小时 / 10 分钟各提醒一次")}
        on={config.multiTierRemind !== false}
        onChange={(v) => update({ multiTierRemind: v })}
      />
    </>
  );
}
