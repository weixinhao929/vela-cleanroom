import { useCallback, useSyncExternalStore } from "react";
import { useSettingsStore } from "./store/settings-store";

/**
 * 轻量 i18n 运行时（原 i18n.ts 的 API 部分；词典已拆到 i18n.ts 并改为
 * 独立 chunk）：以中文为唯一键，语言选择 English 时映射为英文，否则原样
 * 返回。这样无需改动既有字符串的调用位置，即可增量接入英文。
 *
 * 词典按需加载：切到 English 时动态 import() 词典 chunk（约百 KB，中文
 * 用户与其余窗口的首屏关键路径不再解析整本词典）。加载完成前 t()/tr()
 * 回退中文原文（与缺键回退同语义），就位后经内部版本号触发订阅组件重渲。
 */
export type Lang = "简体中文" | "English";

/** 语言切换选项（供设置页选择器使用）。 */
export const LANGUAGES: Lang[] = ["简体中文", "English"];

type Dict = Record<string, string>;

/** 词典缓存：null = 未加载（中文模式或英文词典仍在路上）。 */
let dict: Dict | null = null;
let dictVersion = 0;
let loading: Promise<void> | null = null;

const listeners = new Set<() => void>();
function notify() {
  dictVersion += 1;
  for (const fn of listeners) fn();
}
function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** 拉取英文词典（幂等；仅语言为 English 时真正加载）。 */
export function ensureEnglishDict(): Promise<void> {
  if (dict || loading) return loading ?? Promise.resolve();
  loading = import("./i18n")
    .then((m) => {
      dict = m.ZH_TO_EN;
      loading = null;
      notify();
    })
    .catch(() => {
      // 加载失败不阻断：保持中文回退，下次语言切换重试。
      loading = null;
    });
  return loading;
}

/**
 * 语言翻到 English 时补拉词典（含启动即英文的场景）。
 *
 * 惰性接线（首次 t()/useT() 调用时挂订阅）：不少测试用 vi.mock 替换
 * settings-store，模块初始化期访问 store 会在 mock 就位前炸（undefined
 * .getState）；原 i18n.ts 的实现同样只在调用期访问 store，保持该时序。
 */
let wired = false;
function wireLanguageWatch(): void {
  if (wired) return;
  wired = true;
  const syncRootLang = (lang: string) => {
    /* html lang 随应用内语言写入（三轮审查 L-3）：AT/拼写检查/字体回退
       跟随应用语言而非宿主 WebView 默认。 */
    if (typeof document !== "undefined") document.documentElement.lang = lang === "English" ? "en" : "zh-CN";
  };
  syncRootLang(useSettingsStore.getState().general.language);
  if (useSettingsStore.getState().general.language === "English") {
    void ensureEnglishDict();
  }
  useSettingsStore.subscribe((s) => {
    syncRootLang(s.general.language);
    if (s.general.language === "English") void ensureEnglishDict();
  });
}

/**
 * 翻译参数：整句模板里的 `{name}` 占位符替换值（G8 引入，G14 全面铺开）。
 * 中英文模板共用同一组占位符名，词典值保持 `{n} tasks` 形式。
 */
export type TranslateParams = Record<string, string | number>;

/** 把 `{key}` 占位符替换为参数值；缺失的占位符原样保留（便于发现漏传）。 */
function fillParams(text: string, params?: TranslateParams): string {
  if (!params) return text;
  return text.replace(/\{([a-zA-Z][a-zA-Z0-9_]*)\}/g, (m, k: string) => (k in params ? String(params[k]) : m));
}

/** 翻译函数签名（{@link t} 与 {@link useT} 返回值共用）。 */
export type TranslateFn = (zh: string, params?: TranslateParams) => string;

/**
 * 翻译函数（非 hook 版）：中文原文 → 当前语言文本。
 * 实现为 O(1) 字典查找；映射缺失时原样返回中文（中文即 key，天然兜底）。
 * 带参数时先查词典再统一替换 `{name}` 占位符——拼接式翻译（"已选 " + n）
 * 的语序在英文里经常不成立，整句模板 + 占位符才能给出自然译文。
 *
 * @param zh - 中文原文（同时作为词典键；可含 `{name}` 占位符）。
 * @param params - 占位符替换值（可选）。
 * @returns 英文模式返回映射值（缺失回退原文）；中文模式原样返回。
 *
 * @example
 * ```ts
 * showToast(t("保存失败，请重试"), "error");
 * showToast(t("共 {n} 条", { n }), "success");
 * ```
 */
export function t(zh: string, params?: TranslateParams): string {
  wireLanguageWatch();
  const lang = useSettingsStore.getState().general.language;
  return fillParams(lang === "English" ? (dict?.[zh] ?? zh) : zh, params);
}

/**
 * 应用内语言对应的 BCP-47 标签（E5）。
 * 供 Intl.DateTimeFormat / toLocaleString(locale) 使用——不传 locale 会
 * 跟随操作系统而非应用内设置，切英文后日期时间仍是中文格式。
 *
 * @returns `"en-US"` 或 `"zh-CN"`。O(1)。
 */
export function appLocale(): string {
  return useSettingsStore.getState().general.language === "English" ? "en-US" : "zh-CN";
}

/**
 * Hook 版 {@link appLocale}：语言切换时触发重渲。
 *
 * @returns 当前语言的 BCP-47 标签。
 * @throws 无。
 */
export function useAppLocale(): string {
  const lang = useSettingsStore((s) => s.general.language);
  return lang === "English" ? "en-US" : "zh-CN";
}

/**
 * Hook：订阅语言变化，返回实时翻译函数（useCallback 引用稳定，可安全
 * 放入依赖数组；组件内取文案一律用它而非全局 t() 以获得响应性）。
 *
 * 词典就位（异步 chunk 到达）也会触发重渲——订阅内部版本号，避免英文
 * 词典迟到时界面停留在中文直到下一次无关重渲。
 *
 * @param zh - 中文原文（同时作为词典键；可含 `{name}` 占位符）。
 * @param params - 占位符替换值（可选）。
 * @returns `(zh, params?) => translated` 的翻译函数。
 *
 * @example
 * ```tsx
 * const tr = useT();
 * <button>{tr("保存")}</button>
 * <span>{tr("共 {n} 条", { n })}</span>
 * ```
 */
export function useT(): TranslateFn {
  wireLanguageWatch();
  const lang = useSettingsStore((s) => s.general.language);
  // 订阅词典版本：英文词典 chunk 到达时让全部订阅组件换词。
  useSyncExternalStore(subscribe, () => dictVersion);
  const d = dict;
  return useCallback((zh, params) => fillParams(lang === "English" ? (d?.[zh] ?? zh) : zh, params), [lang, d]);
}
