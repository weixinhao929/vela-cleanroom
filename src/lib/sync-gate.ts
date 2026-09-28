/**
 * 跨窗口同步的「远端应用」门闩。
 *
 * cross-window 在采纳远端载荷时置位，抑制订阅把采纳结果当本地编辑再次广播；
 * settings/app 两 store 的**晚到水合**（hydrateSettingsFromDb / hydrateApp 的
 * 异步 DB 合并，可能落在同步 hook 挂载之后——启动 4s 安全网放行渲染、或
 * 慢盘慢库时）也必须走同一扇门：否则水合 setState 会被订阅视为本地编辑，
 * 盖上新鲜时间戳并广播——把一份陈旧 DB 快照变成「全网最新值」，正是
 * 「设置里快速切换后一直来回切换」风暴的第一块多米诺。
 *
 * 门闩独立成模块（而非 cross-window 的模块级变量）正是为了允许 store 层
 * 引用而不制造初始化期循环依赖：两侧都只在运行期函数内取值。
 */

let depth = 0;

/** 进入远端应用区段（可嵌套；务必在 finally 里配对 end）。 */
export function beginRemoteApply(): void {
  depth++;
}

/** 退出远端应用区段（下界 0，防误配对后永久卡死广播）。 */
export function endRemoteApply(): void {
  depth = Math.max(0, depth - 1);
}

/** 当前是否处于远端应用区段（同步订阅据此跳过广播与编辑盖章）。 */
export function isRemoteApplying(): boolean {
  return depth > 0;
}

/** 同步执行 fn 并抑制其对跨窗口广播的可见性；异常原样抛出。 */
export function withRemoteApply<T>(fn: () => T): T {
  beginRemoteApply();
  try {
    return fn();
  } finally {
    endRemoteApply();
  }
}
