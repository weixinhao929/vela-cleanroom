/* eslint-disable react-hooks/exhaustive-deps */
/**
 * C-9：把「失效信号」依赖模式收敛为具名 hook。
 *
 * 这类 effect/memo 的真实重跑条件是**数据版本**（rev / store 引用 / 计数），
 * 而不是闭包里顺手用到的全部值——写法上要么把整串闭包塞进依赖（放大重跑
 * 面），要么就地禁用 exhaustive-deps（全仓 46 处 lint 债务的主体，真实漏
 * 依赖会被淹没）。收敛到本 hook 后：
 *  - 调用点不再出现 eslint-disable——「为什么可以窄依赖」的答案集中在
 *    这一个文件里，可审计；
 *  - 语义显式化：signals 是声明的失效信号，body 读的其余值按渲染闭包
 *    最新快照取用（与手写窄依赖完全同语义，无行为变化）。
 *
 * 使用约束（违反即失去了收敛意义，回到裸禁用）：
 *  - body 不得有「signals 之外、但需要触发重跑」的值——那不是失效信号
 *    模式，是漏依赖，请补进 signals；
 *  - 清理函数语义与 useEffect 完全一致（返回的 cleanup 会在下一拍/卸载
 *    时执行）。
 */
import { useEffect } from "react";

/** 声明失效信号的 effect：signals 任一引用变化即重跑 body。 */
export function useInvalidationSignal(signals: readonly unknown[], effect: () => void | (() => void)): void {
  useEffect(effect, signals);
}
