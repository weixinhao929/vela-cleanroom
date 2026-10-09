/**
 * 设置搜索的行级跳转信道（侧栏搜索 / 命令面板共用）：词条命中此前只做
 * 页面级导航，「搜主色跳过去还要自己找哪一行」。本模块衔接「跳到页」与
 * 「落到行」：请求方写入 pending（page + 词条标题）并广播同窗事件；
 * SettingsView 在页面落地后按标题文本找到对应 .tm-setting-row，滚动居中
 * 并短暂脉冲强调。
 *
 * 匹配按标题文本而非给每个设置行编号：词条标题与行标题两侧同源（中文
 * 键），English 界面由调用方传翻译函数比对译后文本——新增设置行无需登记
 * 任何锚点，全部页面即刻覆盖。页面是 React.lazy，行渲染完成时机不定，
 * 执行器短轮询重试（上限约 2.4s），查不到安静放弃（词条与行标题脱节时
 * 不报错、不影响导航本身）。
 */
export type SettingsJump = { page: string; title: string };

/** 同窗广播事件名（页面未变时的同页跳转触发器）。 */
export const SETTINGS_JUMP_EVENT = "vela:settings-jump";

let pending: SettingsJump | null = null;

/** 发起一次行级跳转：写入 pending 并同步广播（无 title 则清除挂起跳转）。 */
export function requestSettingsJump(page: string, title?: string): void {
  pending = title ? { page, title } : null;
  if (pending) window.dispatchEvent(new CustomEvent(SETTINGS_JUMP_EVENT));
}

/** 只读窥视（消费方校验 page 匹配后再取走）。 */
export function peekPendingSettingsJump(): SettingsJump | null {
  return pending;
}

/** 取走挂起跳转（一次性；消费即清除）。 */
export function takePendingSettingsJump(): SettingsJump | null {
  const p = pending;
  pending = null;
  return p;
}

/** 清除挂起跳转（导航到无词条目标时的卫生操作）。 */
export function clearPendingSettingsJump(): void {
  pending = null;
}

/**
 * 行级跳转执行器：按标题文本（原文或译文）找到设置行 → 滚动居中 → 挂
 * .tm-row-flash 脉冲 1.8s。懒加载页面未渲染完时每 120ms 重试，上限 20 次。
 *
 * @returns 取消函数（停止重试并移除脉冲类）。
 */
export function flashSettingsRowByTitle(titleZh: string, translate: (s: string) => string): () => void {
  const want = new Set([titleZh.trim(), translate(titleZh).trim()]);
  let tries = 0;
  let timer = 0;
  let flashOff = 0;
  let row: HTMLElement | null = null;
  const stop = () => {
    window.clearTimeout(timer);
    if (row) {
      window.clearTimeout(flashOff);
      row.classList.remove("tm-row-flash");
    }
  };
  const attempt = () => {
    const titles = document.querySelectorAll<HTMLElement>(".tm-settings-window .tm-setting-title");
    for (const t of titles) {
      if (!want.has((t.textContent ?? "").trim())) continue;
      const hit = t.closest<HTMLElement>(".tm-setting-row");
      if (!hit) continue;
      row = hit;
      hit.scrollIntoView({ behavior: "smooth", block: "center" });
      hit.classList.add("tm-row-flash");
      flashOff = window.setTimeout(() => hit.classList.remove("tm-row-flash"), 1800);
      return;
    }
    if (++tries < 20) timer = window.setTimeout(attempt, 120);
  };
  attempt();
  return stop;
}
