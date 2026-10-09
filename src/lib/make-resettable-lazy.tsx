/**
 * 可重置 lazy 组件工厂（lazy chunk 拉取失败后「重试」永久失效）。
 *
 * 背景：React.lazy 会把 rejected 的 import 永久缓存在 LazyExoticComponent
 * 内部——chunk 拉取失败一次（断网 / 文件被占用 / 更新窗口期），错误边界上的
 * 「重试」重建的仍是同一个 lazy 实例，再次渲染立刻重抛缓存的 rejection，
 * 该组件从此再也打不开。WidgetCanvas 曾为 DockConfigPanel 私下实现过
 * 「失败即弃缓存、下次取用重建 lazy」的补丁，本文件是它的通用化提法。
 *
 * 语义（与裸 lazy 完全一致，只多一条失败通道）：
 *  - 渲染侧照旧由消费方的 <Suspense> 提供骨架 / null 占位；
 *  - loader 失败的当次错误照旧抛给最近的错误边界（fallback 语义不变）；
 *  - 差别仅在失败之后：缓存的 lazy 被丢弃，错误边界「重试」重挂载子树时
 *    重新执行 import（真重试，而不是重放缓存的失败）。
 *
 * 类型口径：load 的 default 成员按 unknown 收（具名/默认导出、无 props/
 * 联名签名组件模块都能直接喂进来），props 泛型 P 由带 props 的调用方显式
 * 给（registry/WidgetCanvas 同款 as 收口）；缺省 Record<string, unknown> 适配
 * 无 props 视图组件与带任意 props 的页面组件（页面模块内部保持强类型）——这避免了「组件型泛型 vs React.lazy 的 any 约束」在
 * React 19 类型下的不协变。
 */
import { lazy, type ComponentType, type FunctionComponent, type JSX } from "react";

/** 工厂返回：Component 直接当组件渲染；reset 供错误边界「重试」显式弃缓存。 */
export type ResettableLazy<P> = {
  /** 与裸 lazy 等价的组件（恒定身份，模块级创建一次）。 */
  Component: ComponentType<P>;
  /** 丢弃缓存的懒组件（下一次渲染重新 import）。loader 失败时已自动触发；
      显式调用是错误边界 onRetry 回调的接线位（双保险）。 */
  reset: () => void;
};

/**
 * 创建可重置的 lazy 组件。
 *
 * @param load - 动态 import 加载器（须返回 `{ default: 组件 }`）。
 * @param name - 包装组件的 displayName（DevTools / 崩溃栈可读）。
 * @returns `{ Component, reset }`。
 */
export function makeResettableLazy<P = Record<string, unknown>>(
  load: () => Promise<{ default: unknown }>,
  name = "ResettableLazy"
): ResettableLazy<P> {
  /* 当前生效的 lazy 实例。失败（rejected import）或 reset() 后置空，
     下一次渲染经 getLazy() 重建并重新 import。 */
  type LazyComp = ReturnType<typeof lazy<ComponentType<P>>>;
  let current: LazyComp | null = null;
  const getLazy = (): LazyComp => {
    current ??= lazy(async () => {
      try {
        return (await load()) as { default: ComponentType<P> };
      } catch (err) {
        // 关键一步：弃缓存——错误边界「重试」重挂载时才会重新 import，
        // 而不是重放 React 缓存在 lazy 内部的同一次 rejection。
        current = null;
        throw err;
      }
    });
    return current;
  };
  /* 包装组件：渲染时取「当前」lazy（失败后会被替换成新的）。必须经 JSX
     渲染——LazyExoticComponent 是 exotic 对象而非可调用函数，直接调用会
     TypeError（React 19 实测）；JSX 按 $$typeof 正确走 lazy 分支。 */
  const Render: FunctionComponent<P> = (props) => {
    const Lazy = getLazy() as unknown as FunctionComponent<P>;
    // 未约束泛型 P 在 JSX 展开处需并入 IntrinsicAttributes（React 19 中为空
    // 标记接口）才满足元素 props 检查——单点断言，不影响调用方类型。
    return <Lazy {...(props as P & JSX.IntrinsicAttributes)} />;
  };
  Render.displayName = name;
  return {
    Component: Render,
    reset: () => {
      current = null;
    }
  };
}
