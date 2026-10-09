/**
 * 设置页 · 任务栏（TB-UI）：可见 / 最大化两态的逐窗口规则——（深拆）
 * 自 TaskbarPage.tsx 拆出，经 StateCard 的 children 挂进对应状态卡。
 *
 * 匹配类型 + 匹配值 + 完整外观 + 可选的非前台外观；增删改排序。匹配语义
 * （class 精确 / process 大小写不敏感精确 / title 子串）在 Rust 状态机实现，
 * 此处只编辑数据。
 */
import { AppWindow, ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import { showToast } from "../../../components/ToastHost";
import { useT } from "../../../i18n-lite";
import {
  DEFAULT_TASKBAR_APPEARANCE,
  TASKBAR_MAX_RULES_PER_STATE,
  type TaskbarAppearance,
  type TaskbarMatchType,
  type TaskbarRule,
  type TaskbarRules
} from "../../../store/settings-store";
import type { TaskbarCapabilities } from "../../../types/bindings/TaskbarCapabilities";
import { Dropdown, SettingRow, Toggle } from "../shared";
import { AppearanceEditor, Ctl } from "./TaskbarAppearanceEditor";
import type { TaskbarPreviewHandle } from "./TaskbarPreview";

const MATCH_OPTIONS: { id: TaskbarMatchType; label: string }[] = [
  { id: "class", label: "窗口类" },
  { id: "title", label: "窗口标题" },
  { id: "process", label: "进程名" }
];

function newRuleId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `rule-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function RuleList({
  rules,
  onChange,
  patchAppearance,
  caps,
  owningState,
  preview
}: {
  rules: TaskbarRule[];
  onChange: (next: TaskbarRule[]) => void;
  /** 规则内外观 / 非前台外观的字段级提交：与 onChange 的整表替换不同，提交时
   *  现取最新规则表 merge（滑杆草稿松手跨窗同步竞态，见 AppearanceEditor 头注）。 */
  patchAppearance: (idx: number, field: "appearance" | "inactiveAppearance", p: Partial<TaskbarAppearance>) => void;
  caps: TaskbarCapabilities | null;
  /** 规则所属状态键（visible / maximized，同为 TaskbarStateKey 成员）。 */
  owningState: keyof TaskbarRules;
  /** 预览控制面：规则内外观与非前台外观的编辑同样即时预览。 */
  preview?: TaskbarPreviewHandle;
}) {
  const tr = useT();
  const update = (idx: number, next: TaskbarRule) => onChange(rules.map((r, i) => (i === idx ? next : r)));
  const move = (idx: number, dir: -1 | 1) => {
    const to = idx + dir;
    if (to < 0 || to >= rules.length) return;
    const next = [...rules];
    [next[idx], next[to]] = [next[to], next[idx]];
    onChange(next);
  };
  const add = () => {
    if (rules.length >= TASKBAR_MAX_RULES_PER_STATE) return;
    /* 新建规则以空 pattern 起步，直接查重会永远命中上一条
       空规则——只对非空 pattern 查重（同 matchType+pattern 视为重复，忽略
       大小写与首尾空白，与 Rust 侧 process 大小写不敏感的匹配口径一致）。 */
    onChange([
      ...rules,
      { id: newRuleId(), matchType: "process", pattern: "", appearance: { ...DEFAULT_TASKBAR_APPEARANCE } }
    ]);
  };
  const patchPattern = (idx: number, pattern: string) => {
    const next = rules.map((r, i) => (i === idx ? { ...r, pattern } : r));
    /* 输入成与既有规则重复的匹配值时即时提示（不阻断输入——用户可能在
       调整顺序后删除旧条目）。 */
    const cur = next[idx];
    const dup =
      cur.pattern.trim() !== "" &&
      next.some(
        (r, i) =>
          i !== idx &&
          r.matchType === cur.matchType &&
          r.pattern.trim().toLowerCase() === cur.pattern.trim().toLowerCase()
      );
    if (dup) showToast(tr("已存在相同匹配值的规则，先命中的那条生效"), "info");
    onChange(next);
  };
  return (
    <div className="tm-tb-sub">
      <div className="tm-tb-sub-title">{tr("窗口规则")}</div>
      {/* 规则是「从上到下、先命中先生效」的有序列表，与状态卡
          「越靠下优先级越高」的语义恰好相反，页面原先唯一的顺序说明长在状态卡
          区，用户极易反向套用到规则上——此处就地写明。 */}
      <div className="tm-tb-note">{tr("规则从上到下依次匹配，先命中的生效；空匹配值的规则不会命中任何窗口")}</div>
      {rules.length === 0 && (
        <div className="tm-tb-empty">{tr("暂无规则：命中规则的窗口使用其专属外观，其余使用上方默认外观")}</div>
      )}
      <div className="tm-tb-rules">
        {rules.map((rule, idx) => (
          <div className="tm-tb-rule" key={rule.id} role="group" aria-label={tr("规则 {n}", { n: idx + 1 })}>
            <div className="tm-tb-rule-head">
              <Ctl label={tr("匹配类型")}>
                <Dropdown
                  value={rule.matchType}
                  options={MATCH_OPTIONS}
                  onChange={(matchType) => update(idx, { ...rule, matchType })}
                />
              </Ctl>
              <input
                className={`tm-text-input${rule.pattern.trim() === "" ? " tm-tb-rule-pattern-empty" : ""}`}
                value={rule.pattern}
                placeholder={tr("匹配值（类名精确 / 进程名如 notepad.exe / 标题子串）")}
                aria-label={tr("匹配值")}
                spellCheck={false}
                onChange={(e) => patchPattern(idx, e.target.value)}
              />
              {/* 空 pattern 恒不匹配（Rust 侧约定），无提示时用户
                  以为规则在生效——就地挂「未生效」徽标。 */}
              {rule.pattern.trim() === "" && <span className="tm-tb-rule-hint">{tr("未生效：匹配值为空")}</span>}
              <div className="tm-tb-rule-actions">
                <button
                  type="button"
                  className="tm-tb-icon-btn"
                  onClick={() => move(idx, -1)}
                  disabled={idx === 0}
                  aria-label={tr("上移")}
                  title={tr("上移")}
                >
                  <ArrowUp size={14} />
                </button>
                <button
                  type="button"
                  className="tm-tb-icon-btn"
                  onClick={() => move(idx, 1)}
                  disabled={idx === rules.length - 1}
                  aria-label={tr("下移")}
                  title={tr("下移")}
                >
                  <ArrowDown size={14} />
                </button>
                <button
                  type="button"
                  className="tm-tb-icon-btn danger"
                  onClick={() => onChange(rules.filter((_, i) => i !== idx))}
                  aria-label={tr("删除规则")}
                  title={tr("删除规则")}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            </div>
            <AppearanceEditor
              value={rule.appearance}
              onChange={(p) => patchAppearance(idx, "appearance", p)}
              onPreview={preview ? (appearance) => preview.onEdit(owningState, appearance) : undefined}
              caps={caps}
            />
            <SettingRow icon={AppWindow} title="非前台时使用不同外观" desc="命中窗口失去焦点时切换到下方外观">
              <Toggle
                on={rule.inactiveAppearance !== undefined}
                ariaLabel={tr("非前台时使用不同外观")}
                onChange={(on) => {
                  const next: TaskbarRule = { ...rule };
                  if (on) next.inactiveAppearance = { ...rule.appearance };
                  else delete next.inactiveAppearance;
                  update(idx, next);
                }}
              />
            </SettingRow>
            {rule.inactiveAppearance && (
              <div className="tm-tb-sub" role="group" aria-label={tr("非前台外观")}>
                <div className="tm-tb-sub-title">{tr("非前台外观")}</div>
                <AppearanceEditor
                  value={rule.inactiveAppearance}
                  onChange={(p) => patchAppearance(idx, "inactiveAppearance", p)}
                  onPreview={
                    preview ? (inactiveAppearance) => preview.onEdit(owningState, inactiveAppearance) : undefined
                  }
                  caps={caps}
                />
              </div>
            )}
          </div>
        ))}
      </div>
      <button
        type="button"
        className="tm-btn-secondary tm-tb-add"
        onClick={add}
        disabled={rules.length >= TASKBAR_MAX_RULES_PER_STATE}
      >
        <Plus size={14} />
        {tr("添加规则")}
      </button>
    </div>
  );
}
