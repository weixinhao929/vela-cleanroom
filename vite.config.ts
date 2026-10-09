import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// 项目目录可能是目录联接（junction）：模块 id 会被 realpath 成真实路径，
// 而 server.fs.allow 默认只放行工作区根（联接路径），两不一致会导致
// 测试/开发时所有源文件读取被静默拒绝（报"Does the file exist?"）。
// 这里把两种形态都显式加入白名单。
const projectRoot = fileURLToPath(new URL(".", import.meta.url));
const realProjectRoot = (() => {
  try {
    return realpathSync(projectRoot);
  } catch {
    return projectRoot;
  }
})();

// __APP_VERSION__ 从 package.json version 注入（LicensePage 版本展示，
// __BUILD_TIME__ 同款 define）。用 readFileSync 而非 import，避免给本配置
// 文件追加 resolveJsonModule / JSON 命名空间导入的额外约束。
const appVersion = (() => {
  try {
    const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf-8")) as {
      version?: string;
    };
    return pkg.version ?? "0.1.0";
  } catch {
    return "0.1.0";
  }
})();

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  // 项目目录是目录联接（源盘 → 联接盘）时，Vite 默认按 realpath 给模块 id：
  // index.html 变成 E:/… 而 root 是 C:/…，跨盘算不出相对路径，Rollup 报
  // "fileName must be neither absolute nor relative"，生产构建整体失败。
  // preserveSymlinks 让文件身份以原始路径为准，dev/test/build 三条链路一致。
  resolve: { preserveSymlinks: true },
  server: {
    port: 1420,
    strictPort: true,
    fs: { allow: [projectRoot, realProjectRoot] }
  },
  envPrefix: ["VITE_", "TAURI_ENV_"],
  define: {
    /* 默认取配置加载时刻；提供 SOURCE_DATE_EPOCH
       （可复现构建通行约定，秒级 Unix 时间戳）时改读之——同 commit 两次
       构建产物可复现。 */
    __BUILD_TIME__: JSON.stringify(
      process.env.SOURCE_DATE_EPOCH
        ? new Date(Number(process.env.SOURCE_DATE_EPOCH) * 1000).toISOString()
        : new Date().toISOString()
    ),
    __APP_VERSION__: JSON.stringify(appVersion)
  },
  build: {
    // Windows 走 WebView2（Chromium 105+），其他平台按 Tauri 官方建议降级到 safari13。
    target: process.env.TAURI_ENV_PLATFORM === "windows" ? "chrome105" : "safari13",
    rollupOptions: {
      // 多页入口：任务栏网速条是零交互常驻小窗，走 taskbar-net.html
      // 精简入口（只带 stores 同步与本窗样式），不再共用 index.html 全量主包。
      // 扩展：snip / super-panel / fullscreen 三个瞬时卫星窗同款精简
      // 入口——原 index.html#hash 形态要解析 3.5 万行 CSS 大头 + 双 store 水合，
      // 拖慢「按键到可见」；main.tsx 保留旧 hash → 新入口的重定向兜底。
      // 必须用相对路径：本项目根可能是目录联接（C: → E:），绝对路径跨盘后
      // Rollup 算不出输出相对名（"fileName must be neither absolute nor
      // relative"），相对字符串按 config root 解析则与 root 同盘。
      input: {
        main: "index.html",
        "taskbar-net": "taskbar-net.html",
        snip: "snip.html",
        "super-panel": "super-panel.html",
        fullscreen: "fullscreen.html"
      },
      output: {
        /**
         * 手动分包。小组件已改为 React.lazy，Rollup 会自动为每个
         * 小组件切 chunk；这里额外把体积大、变动少的第三方库拆出来，
         * 让它们在应用代码迭代后仍能命中缓存（虽然是本地打包应用，
         * 更重要的收益是主 chunk 变小 → 首屏解析执行更快）。
         */
        manualChunks(id) {
          if (!id.includes("node_modules")) return undefined;
          // 图标库放最前：lucide-react 名字里含 "react"，若在 react 判断之后
          // 会被误并进 vendor-react。
          if (id.includes("lucide-react")) return "vendor-icons";
          // zustand 与 react 必须同 chunk：zustand 依赖 react 的 useSyncExternalStore，
          // 而 React 运行时又被 zustand 的 shim 引用，拆开会产生循环 chunk 警告。
          if (
            id.includes("react-dom") ||
            id.includes("/react/") ||
            id.includes("scheduler") ||
            id.includes("zustand") ||
            id.includes("use-sync-external-store")
          ) {
            return "vendor-react";
          }
          if (id.includes("@tauri-apps")) return "vendor-tauri";
          // motion 引擎（motion / motion-dom / motion-utils / framer-motion 同族）
          // 只被 M3Slider / WakeSlider 消费（口径修正：消费面不止设置页——
          // 亮度小组件 BrightnessWidget / BrightnessMini 也用 M3Slider，放一块
          // 亮度组件/磁贴会在常驻桌面层按需拉取本异步 chunk；仍是懒加载、非
          // 首屏负担）。并入静态 vendor 会让每个窗口的首屏关键路径都解析整套
          // 动画引擎。返回 undefined 走 Rollup 默认分组，motion 随首个异步
          // 引用方落进异步 chunk，首次渲染带滑条的界面时才加载。
          if (
            id.includes("node_modules/motion") ||
            id.includes("node_modules\\motion") ||
            id.includes("node_modules/framer-motion")
          ) {
            return undefined;
          }
          // zod 同理：只被冷路径消费（JSON 导入校验 / 一次性 legacy 迁移 /
          // 配置弹层的 32 个 schema，引用方全部异步）。手动分包是「凡
          // node_modules 一律并入静态 vendor」——即使引用方全异步也会把
          // zod 拽进首屏主包（实测 +70KB）；返回 undefined 随异步引用方
          // 落异步 chunk，备份导入/首次迁移时才加载。
          if (id.includes("node_modules/zod") || id.includes("node_modules\\zod")) {
            return undefined;
          }
          return "vendor";
        }
      }
    }
  },
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    css: false,
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
    /* 1,255+ 用例单进程跑，jsdom + 真实定时器在 CI 慢机上易产生时序
       flaky——CI 重试 2 次兜住环境抖动（本地 0 保持快速失败），显式超时
       收紧挂死用例的反馈环（vitest 默认 5s，401 cases 全绿基线下 15s 足够
       富余）。
       观测量留档（2026-10-07）：本地全量 0-retry 连跑绿 ⇒ retry=CI-only
       仍是环境抖动兜底而非用例级 flaky 掩盖；「偶发」集中在 e2e（msedgedriver
       时序，非门禁），vitest 侧未观测到依赖 retry 才能过的用例。若日后 CI
       出现「重试后绿」的用例名，优先修时序而非调大 retry——那是有真 flaky
       的信号（配合 vitest --reporter=verbose 的 retry 标记排查）。 */
    retry: process.env.CI ? 2 : 0,
    testTimeout: 15_000,
    hookTimeout: 20_000,
    /*覆盖率度量（`npm run test:coverage`）——此前 63 个文件 mock
       掉 IPC 层却无覆盖率数字佐证盲区。阈值=棘轮：先按 2026-10-07 基线设
       略低于实测的下限，只升不降；exclude 的四类是天然低价值面（DOM 入口 /
       类型壳 / 生成绑定 / 门禁脚本），不进分母。
       初设 38/30/35/38 与实测（51.16/44.14/
       45.38/53.1）差近 10pt 无强制点——按「实测 -2pt 向上取整」收紧到
       50/43/44/52，且 ci.yml frontend 与 run-local-ci.mjs 的测试步均改为
       test:coverage（裸 npm test 不校验阈值，此前从未有机器强制点）。 */
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: ["src/**/*.{ts,tsx}"],
      // 本地扫描产物（src/.mimosa，25MB/1938 文件）
      // 目前全是 .source/.json，按 include 扩展名天然不进覆盖率分母——显式
      // 排除是防未来快照格式出现 .ts 文件混入度量，同时让 glob 少扫这棵树。
      exclude: ["src/**/*-main.tsx", "src/types/**", "src/**/*.test.{ts,tsx}", "src/test/**", "src/.mimosa/**"],
      thresholds: {
        statements: 50,
        branches: 43,
        functions: 44,
        lines: 52
      }
    }
  }
});
