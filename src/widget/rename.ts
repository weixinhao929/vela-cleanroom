/**
 * 重命名统一入口（收口）：此前 GroupCard / GroupConfigPanel / 设置页三份
 * 拷贝，任何口径调整（长度上限、撤销、IME）都要改三遍。实例显示名写
 * instance.label（widgetDisplayName 全局优先读取——标签 / 花瓣 / 卡片标题 /
 * 配置面板 / 设置页处处同步），组名写 group.name（侧栏 / 设置页 / 无障碍
 * 标签），都经 store 落盘并跨窗口广播。
 *
 * 共同行为：
 *  - 弹窗带 maxLength，输入时即挡下超长（不做事后静默截断）；提交值仍按
 *    Unicode 码点兜底截断（slice 按 UTF-16 码元切会劈开 emoji 代理对）。
 *  - 留空（allowEmpty 提交 ""）恢复默认名。
 *  - 提交与现值相同 → no-op（不写、不弹）。
 *  - 有变化 → toast 带撤销（编组的解散/删除/合并都有撤销，改名这个高频
 *    试错动作此前反而没有）。
 */
import { alertDialog, promptDialog } from "../components/PromptDialog";
import { pushAppToast } from "../components/ToastHost";
import type { TranslateFn } from "../i18n-lite";
import { widgetAutoName } from "./display-name";
import { useWidgetStore } from "./widget-store";

/** 显示名长度上限（按 Unicode 码点计）。 */
export const LABEL_MAX_CHARS = 24;

/** 按码点截断：slice(0, n) 以 UTF-16 码元计数，会把 emoji 代理对劈成乱码。 */
export function truncateLabel(name: string): string {
  return Array.from(name.trim()).slice(0, LABEL_MAX_CHARS).join("");
}

/** 视图新建 / 重命名的统一入口（设置窗侧栏与视图管理页共用）：
 *  - 弹窗带 maxLength（LABEL_MAX_CHARS），提交值按码点兜底截断；
 *  - 传入 existing（重命名场景）时与既有视图重名（selfId 除外）直接拦下并
 *    提示——store 的 renameView 撞名是 no-op，提前拦下并说明原因比静默
 *    无效更诚实；新建场景不传 existing：store 的 addView/duplicateView 会
 *    自动加序号（"Work" → "Work 2"），无需拦截；
 *  - 取消 / 空返回 null，调用方直接丢弃。
 *  此前视图命名无任何约束（组件/编组重命名却有三件套），是口径缺口。 */
export async function promptViewName(
  tr: TranslateFn,
  opts: { title: string; initial?: string; existing?: { id: string; name: string }[]; selfId?: string }
): Promise<string | null> {
  const name = await promptDialog({
    title: opts.title,
    initialValue: opts.initial,
    maxLength: LABEL_MAX_CHARS
  });
  if (name === null) return null;
  const trimmed = truncateLabel(name);
  if (!trimmed) return null;
  if (opts.existing?.some((v) => v.id !== opts.selfId && v.name === trimmed)) {
    await alertDialog({
      title: tr("无法使用该名称"),
      message: tr("已存在同名视图「{name}」。", { name: trimmed })
    });
    return null;
  }
  return trimmed;
}

/** 重命名小组件显示名（组内成员 / 独立卡片 / 设置页共用）。 */
export async function promptRenameInstance(id: string, tr: (s: string) => string): Promise<void> {
  const inst = useWidgetStore.getState().instances.find((i) => i.id === id);
  if (!inst) return;
  const name = await promptDialog({
    title: tr("重命名标签"),
    message: tr("留空恢复默认名称"),
    initialValue: typeof inst.label === "string" ? inst.label : "",
    /* placeholder 示「留空恢复成什么」——须用忽略 label 的自动名，
       widgetDisplayName 会优先返回 label，已命名时 placeholder 与预填值相同。 */
    placeholder: widgetAutoName(inst.type, inst.id, useWidgetStore.getState().instances, tr),
    confirmLabel: tr("重命名"),
    allowEmpty: true,
    maxLength: LABEL_MAX_CHARS
  });
  if (name === null) return;
  const label = truncateLabel(name);
  if ((inst.label ?? "") === label) return;
  useWidgetStore.getState().updateWidget(id, { label: label || undefined });
  pushAppToast(label ? tr("已重命名") : tr("已恢复默认名称"), "", "info", {
    action: {
      label: tr("撤销"),
      run: () => useWidgetStore.getState().updateWidget(id, { label: inst.label })
    }
  });
}

/** 重命名编组（组容器名：侧栏 / 设置页 / 无障碍标签用；留空回落「编组」）。 */
export async function promptRenameGroup(groupId: string, tr: (s: string) => string): Promise<void> {
  const group = useWidgetStore.getState().groups.find((g) => g.id === groupId);
  if (!group) return;
  const name = await promptDialog({
    title: tr("重命名编组"),
    message: tr("留空恢复默认名称"),
    initialValue: typeof group.name === "string" ? group.name : "",
    placeholder: tr("编组"),
    confirmLabel: tr("重命名"),
    allowEmpty: true,
    maxLength: LABEL_MAX_CHARS
  });
  if (name === null) return;
  const next = truncateLabel(name);
  if ((group.name ?? "") === next) return;
  useWidgetStore.getState().updateGroup(groupId, { name: next || undefined });
  pushAppToast(next ? tr("已重命名编组") : tr("已恢复默认名称"), "", "info", {
    action: {
      label: tr("撤销"),
      run: () => useWidgetStore.getState().updateGroup(groupId, { name: group.name })
    }
  });
}
