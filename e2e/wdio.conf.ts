import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * WebDriverIO 配置，面向 Tauri 2 + WebView2。
 *
 * 前置条件（一次性的环境准备，见 README.md）：
 *   1. `cargo install tauri-driver`（如果 cargo 使用代理源，先加 `--registry crates-io`）
 *   2. 下载与本地 WebView2 版本匹配的 msedgedriver，放到 PATH（或 `tauri-driver --native-driver <路径>`）
 *   3. 先构建二进制：`npm run tauri:build`（或 `-- --debug`）
 *   4. 退出本机常驻的 Vela（single-instance 会把新实例的参数转发给老实例后立刻退出）
 *
 * tauri-driver 负责把 WebView2 暴露为 WebDriver 会话（browserName "wry"），
 * 并通过 `tauri:options.application`（可执行文件路径）拉起应用。
 */

const here = dirname(fileURLToPath(import.meta.url));

/**
 * 应用二进制定位。tauri-driver 2.x 的 `TauriOptions` 只有 `application` / `args` /
 * `webview_options` 三个键；v1 时代的 `applicationId` 不被识别，反序列化失败被
 * 静默吞掉，于是不会生成 `ms:edgeOptions.binary`——msedgedriver 拉起的是 Edge
 * 浏览器本体而非 Vela，`switchWindow("Vela Widgets")` 永远等不到。
 * 优先 VELA_E2E_APP；否则按 release → debug 顺序找 `tauri build` 重命名后的
 * Vela.exe 与 cargo 原名 focus-desk.exe（productName "Vela"，package "focus-desk"）。
 */
function resolveApplication(): string {
  const fromEnv = process.env.VELA_E2E_APP;
  if (fromEnv) {
    const p = resolve(here, fromEnv);
    if (!existsSync(p)) throw new Error(`VELA_E2E_APP 指向的文件不存在：${p}`);
    return p;
  }
  const candidates = [
    "../src-tauri/target/release/Vela.exe",
    "../src-tauri/target/release/focus-desk.exe",
    "../src-tauri/target/debug/Vela.exe",
    "../src-tauri/target/debug/focus-desk.exe"
  ].map((rel) => resolve(here, rel));
  const found = candidates.find((p) => existsSync(p));
  if (!found) {
    throw new Error(
      "未找到应用二进制。先在仓库根执行 `npm run tauri:build`（或 `-- --debug`），" +
        `或用 VELA_E2E_APP 指定路径。已尝试：\n${candidates.join("\n")}`
    );
  }
  return found;
}

/**
 * 单实例守卫。应用启用 tauri-plugin-single-instance：若本机已有 Vela 常驻（托盘
 * 常驻、关设置窗只是隐藏），tauri-driver 拉起的实例会把参数转发给老实例后立即
 * 退出，会话要么连不上要么连到错误实例——症状是挂起而非报错。默认发现即快速
 * 失败并给出指引；设 VELA_E2E_KILL=1 才自动结束它（会丢未落盘的防抖状态）。
 */
function guardRunningInstance(): void {
  if (process.platform !== "win32") return;
  for (const image of ["Vela.exe", "focus-desk.exe"]) {
    const out = execSync(`tasklist /FI "IMAGENAME eq ${image}" /NH`, { encoding: "utf8" });
    if (!out.toLowerCase().includes(image.toLowerCase())) continue;
    if (process.env.VELA_E2E_KILL === "1") {
      execSync(`taskkill /IM ${image} /F`, { stdio: "ignore" });
      continue;
    }
    throw new Error(`检测到正在运行的 ${image}：请先退出 Vela（托盘 → 退出），或设 VELA_E2E_KILL=1 让测试自动结束它。`);
  }
}

// v9 的配置类型是全局命名空间 WebdriverIO.Config（@wdio/globals/types 声明）；
// 旧写法 Options.Testrunner 没有 capabilities 字段，tsc 直接报错。
export const config: WebdriverIO.Config = {
  runner: "local",
  specs: ["./specs/**/*.e2e.ts"],
  exclude: [],
  maxInstances: 1,

  capabilities: [
    {
      // v9 把 capability 级并发键改成 "wdio:maxInstances"；顶层 maxInstances: 1 已足够。
      // "tauri:options" 是 tauri-driver 的厂商扩展键，不在 WebdriverIO 的能力类型里，需断言。
      browserName: "wry",
      "tauri:options": {
        application: resolveApplication()
      }
    } as WebdriverIO.Capabilities
  ],

  logLevel: "info",
  outputDir: "./.wdio-logs",
  bail: 0,
  waitforTimeout: 10_000,
  connectionRetryTimeout: 120_000,
  connectionRetryCount: 3,

  framework: "mocha",
  mochaOpts: {
    ui: "bdd",
    timeout: 60_000
  },

  reporters: ["spec"],

  onPrepare: () => {
    guardRunningInstance();
  },

  // 每个用例前把焦点切回主 widget 层，避免上一个用例停留在设置窗口。
  // widget 窗口 label 为 `widget-{slot}`（每显示器一个），title 统一为
  // "Vela Widgets"（monitor.rs create_widget_window），switchWindow 按 title 匹配。
  beforeTest: async function () {
    await browser.switchWindow("Vela Widgets");
  }
};
