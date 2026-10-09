import { useRef, useState } from "react";

/**
 * 滑条拖动期只进草稿、松手（onCommitEnd）一次提交。
 *
 * 提交链昂贵的滑条（DockPage 的 setDock 落盘链、quick 配置弹层的 zod
 * sanitize + 落盘 + 跨窗广播）此前逐 input 事件全量走一遍，拖一次触发
 * 几十轮；本 hook 把「拖动期预览」与「提交」拆开——滑块照常跟手（受控于
 * 草稿值），松手才调用一次 commit。
 *
 * 草稿经 ref 保鲜：键盘步进是 onChange + onCommitEnd 同拍触发，闭包里的
 * state 是步进前的旧值，直接读会永远提交不出。
 *
 * @param commit 松手 / 键盘步进提交时调用（每次拖动会话至多一次）。
 * @returns `{ draft, slide, commitEnd }`：draft 为当前草稿值（null = 无拖动，
 *          消费方回落持久值）；slide 接 M3Slider.onChange；commitEnd 接
 *          M3Slider.onCommitEnd。
 */
export function useSliderDraft(commit: (v: number) => void) {
  const draftRef = useRef<number | null>(null);
  const [draft, setDraft] = useState<number | null>(null);
  return {
    draft,
    slide: (v: number) => {
      draftRef.current = v;
      setDraft(v);
    },
    commitEnd: () => {
      const v = draftRef.current;
      draftRef.current = null;
      setDraft(null);
      if (v !== null) commit(v);
    }
  };
}
