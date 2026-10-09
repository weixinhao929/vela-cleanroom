/**
 * 编辑模式「铬件」的命中判定（共享小工具）。
 *
 * 背景：WidgetCard / GroupCard 的全局 keydown（方向键微移 / Delete 删除 /
 * 重命名）只排除了文本输入——焦点 Tab 到编辑工具栏按钮、面板或各类弹层
 * 控件上时，target 是 BUTTON/DIV，typing 守卫拦不住：用户在工具栏上按
 * 方向键（ARIA toolbar 导航）或 Delete，选中的小组件会随之微移甚至误删。
 * 两侧监听共用这份判定，口径永远一致。
 */

/** 视为编辑铬件的选择器：编辑工具栏、弹层（模板/历史/灵动岛）、批量工具栏
 *  与各类菜单/弹层（右键菜单、图库、就地配置弹层、提示对话框、命令面板）。 */
const EDIT_CHROME_SELECTOR = [
  ".widget-edit-toolbar",
  ".widget-batch-toolbar",
  ".widget-template-panel",
  ".dock-cfg",
  ".ctx-menu",
  ".widget-menu",
  ".widget-context-menu",
  ".widget-gallery-overlay",
  ".wcfg-popover",
  ".folder-popup",
  ".sfolder-popup",
  ".fd-prompt-overlay",
  ".cmd-palette"
].join(", ");

/** 事件目标是否位于编辑铬件内（在铬件上按键不应作用到画布层）。 */
export function isEditChromeTarget(target: EventTarget | null): boolean {
  return !!(target as Element | null)?.closest?.(EDIT_CHROME_SELECTOR);
}

/** 交互控件标签（含 contenteditable 两种序列化形态）。 */
const CONTROL_TAGS = [
  "button",
  "input",
  "textarea",
  "select",
  "a",
  "[contenteditable='true']",
  "[contenteditable='']",
  "[data-interactive]"
].join(", ");

/** 卡片/编组容器/展开浮层宿主：焦点落在其内部交互控件上时，方向键应归控件
 *  的原生行为（select 换项、slider 步进、复选框 Space……），卡片监听此前
 *  的 preventDefault 会直接吞掉它们。宿主壳层本身（如卡片 tabIndex=0 的
 *  根 div）不匹配——壳层上的方向键微移是 的既定行为。 */
const WIDGET_CONTROL_SELECTOR = [".widget-card", ".widget-group", ".wexp"]
  .map((host) => `${host} ${CONTROL_TAGS}`)
  .join(", ");

/** 事件目标是否位于小组件卡片/编组容器/展开浮层的内部交互控件上。 */
export function isWidgetControlTarget(target: EventTarget | null): boolean {
  return !!(target as Element | null)?.closest?.(WIDGET_CONTROL_SELECTOR);
}
