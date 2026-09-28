/**
 * 复制文本到系统剪贴板（双路径降级）。
 * 优先 Clipboard API（需安全上下文）；失败或不可用时回退隐藏
 * textarea + execCommand 的传统方案。
 *
 * @param text - 要复制的文本。
 * @returns true 表示复制成功，两条路径都失败为 false。
 * @throws 无（全部内部捕获）。
 *
 * @example
 * ```ts
 * if (await copyText(code)) showToast("已复制", "ok");
 * ```
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to the legacy path
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}
