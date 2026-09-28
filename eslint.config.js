import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";

export default tseslint.config(
  { ignores: ["dist", "node_modules", "src-tauri/target"] },
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
  }
);
