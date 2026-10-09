import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";

export default tseslint.config(
  // 本地扫描工具 hook-state 快照（25MB/1938 文件）
  // 落在 src/.mimosa 内——按扩展名（.source/.json）本就不进 lint 范围，但每次
  // 运行仍要遍历这棵目录树；显式忽略省掉枚举开销，也防未来快照出现 .ts 文件。
  // .mimosa 实际存在于 7 个位置（e2e/、scripts/、
  // src-tauri/、src/styles/ 等），精确路径只盖住其一——改 **/.mimosa 任意层
  // 语义（prettier 的裸 .mimosa 一直如此）。
  { ignores: ["dist", "node_modules", "src-tauri/target", "coverage", "**/.mimosa"] },
  {
    files: ["src/**/*.{ts,tsx}"],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: {
      ecmaVersion: 2022,
      globals: globals.browser
    },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // allowExportNames 声明的是"组件 + 命令式 API 同文件"的既有模式
      // （弹层 Host 组件配 open/confirm 等模块级函数）；拆文件收益为零、
      // 改动面大，这里显式豁免这些稳定 API 名。
      "react-refresh/only-export-components": [
        "warn",
        {
          allowConstantExport: true,
          allowExportNames: [
            "openCommandPalette",
            "closeCommandPalette",
            "isContextMenuOpen",
            "closeContextMenu",
            "openContextMenu",
            "promptDialog",
            "confirmDialog",
            "alertDialog",
            "choiceDialog",
            "compareVersions",
            "luminanceHex",
            "resolveDarkTheme",
            "useMediaPrefsSync",
            "useDesktopDoubleClickSync"
          ]
        }
      ],
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_" }]
    }
  },
  {
    //CI 门禁脚本纳入 lint 范围——此前 files 仅 src/**，脚本无任何
    // lint 守护（拼错变量名只能在运行期发现）。Node 环境（非 browser globals）；
    // e2e specs 暂不纳入（需 TS parser + wdio globals，其自身有 tsc 校验）。
    files: ["scripts/**/*.{mjs,cjs,js}"],
    extends: [js.configs.recommended],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: { ...globals.node }
    },
    rules: {
      // codemod 的 \u0000 占位哨兵是有意为之（保护替换片段不被二次改写）。
      "no-control-regex": "off"
    }
  }
);
