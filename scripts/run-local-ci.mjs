#!/usr/bin/env node
/**
 * 本地 CI 等价链：与 .github/workflows/ci.yml 的 frontend + backend
 * 两个 job 逐步对齐的顺序执行器。仓库当前没有 git 远端——ci.yml 的
 * push/PR 触发从未真实运行过，「CI 绿灯」只是纸面能力；在配置远端并完成
 * 首次推送之前，提交前请跑 `npm run ci:local` 获得同等保证。
 *
 * 与 ci.yml 的对应关系：
 *  - frontend job 的 13 个步骤 → --frontend（默认开）
 *  - backend job 的 fmt/clippy/test/workspace crate/绑定漂移门 → --backend（默认开）
 *  - build（vite build）较慢且门禁价值与前述重复度高 → --build 显式开启
 *
 * 任一步骤失败立即以非零码退出（与 CI 的 fail-fast job 语义一致）。
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const argv = process.argv.slice(2);
const skipFrontend = argv.includes("--no-frontend");
const skipBackend = argv.includes("--no-backend");
const withBuild = argv.includes("--build");

/** [步骤名, cwd, 命令行]；cwd 相对仓库根。 */
const steps = [];
if (!skipFrontend) {
  steps.push(
    ["tsc", ".", ["npm", "run", "check"]],
    ["eslint", ".", ["npm", "run", "lint"]],
    ["prettier", ".", ["npm", "run", "format:check"]],
    ["lint:anim", ".", ["npm", "run", "lint:anim"]],
    ["lint:tokens", ".", ["npm", "run", "lint:tokens"]],
    ["lint:i18n", ".", ["npm", "run", "lint:i18n"]],
    // IME 组合期 Enter 守卫门禁——keydown 裸判 Enter
    // 而".nativeEvent.isComposing" 缺失即拦（中文输入法回车选字误提交）。
    ["lint:ime", ".", ["npm", "run", "lint:ime"]],
    ["lint:api", ".", ["npm", "run", "lint:api"]],
    ["lint:sizes", ".", ["npm", "run", "lint:sizes"]],
    ["lint:layering", ".", ["npm", "run", "lint:layering"]],
    ["lint:window-gates", ".", ["npm", "run", "lint:window-gates"]],
    // CSP 形态锁——style-src 'unsafe-inline' 是唯一
    // 基线（小组件内联样式结构性需求），script-src 'self' 锁死，白名单
    // 只能收不能放。
    ["lint:csp", ".", ["npm", "run", "lint:csp"]],
    /* vitest 步带 coverage——vite.config.ts 的 thresholds（实测-2pt
       棘轮）只在 --coverage 下强制，裸 npm test 不校验阈值，本地等价链
       会漏掉 CI（ci.yml 已同步改 test:coverage）的那道闸。 */
    ["vitest+coverage", ".", ["npm", "run", "test:coverage"]]
  );
  if (withBuild) steps.push(["build", ".", ["npm", "run", "build"]]);
}
if (!skipBackend) {
  const cargo = process.platform === "win32" ? "cargo.exe" : "cargo";
  if (!existsSync(path.join(root, "src-tauri", "Cargo.toml"))) {
    console.error("[ci:local] src-tauri/Cargo.toml 不存在，跳过 backend（用 --no-backend 显式关闭）");
  } else {
    steps.push(
      ["cargo fmt --check", "src-tauri", [cargo, "fmt", "--check"]],
      ["cargo clippy (root)", "src-tauri", [cargo, "clippy", "--all-targets", "--", "-D", "warnings"]],
      [
        "cargo clippy (workspace crates)",
        "src-tauri",
        [
          cargo,
          "clippy",
          "--all-targets",
          "-p",
          "velatap",
          "-p",
          "taskbar_common",
          "-p",
          "vela-symbolize",
          "--",
          "-D",
          "warnings"
        ]
      ],
      ["cargo test (root)", "src-tauri", [cargo, "test", "--lib"]],
      [
        "cargo test (workspace crates)",
        "src-tauri",
        [cargo, "test", "--lib", "-p", "velatap", "-p", "taskbar_common", "-p", "vela-symbolize"]
      ]
    );
  }
}

if (steps.length === 0) {
  console.error("[ci:local] 没有可执行步骤（frontend/backend 均被关闭）");
  process.exit(1);
}

let failed = 0;
const started = Date.now();
for (const [name, cwd, cmd] of steps) {
  const t0 = Date.now();
  const label = `▶ ${name}`;
  console.log(`\n${"=".repeat(60)}\n${label}\n${"=".repeat(60)}`);
  const r = spawnSync(cmd[0], cmd.slice(1), {
    cwd: path.join(root, cwd),
    stdio: "inherit",
    shell: process.platform === "win32"
  });
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  if (r.status !== 0) {
    failed = r.status ?? 1;
    console.error(`\n✗ ${name} 失败（exit ${failed}，${secs}s）——本地等价链中止`);
    break;
  }
  console.log(`✓ ${name}（${secs}s）`);
}

const total = ((Date.now() - started) / 1000).toFixed(1);
if (failed === 0) {
  console.log(`\n[ci:local] 全部 ${steps.length} 步通过（${total}s）`);
  // 与 ci.yml 的绑定漂移门对齐：ts-rs 导出若改写了 src/types/bindings 则视为漂移。
  if (!skipBackend) {
    const st = spawnSync("git", ["diff", "--stat", "--", "src/types/bindings"], { cwd: root, encoding: "utf8" });
    /* git 不可用（ENOENT）时 stdout 为 undefined，两道
       漂移门会静默通过——显式 fail-closed（本链其余步骤本就依赖 git 仓库）。 */
    if (st.error) {
      console.error(`[ci:local] 绑定漂移：git 不可用（${st.error.message}），无法核验绑定漂移`);
      process.exit(1);
    }
    if (st.stdout && st.stdout.trim().length > 0) {
      console.error("[ci:local] 绑定漂移：cargo test 改写了 src/types/bindings，请提交 regenerated 绑定");
      process.exit(1);
    }
    /* git diff 只看已跟踪文件——models.rs 新增导出类型生成
       的是 untracked 新文件，忘提交绑定的 PR 在本地与 CI 都绿灯（fresh clone
       上同样只产生 untracked，永不触发）。补 status --porcelain 非空即 fail。 */
    const untracked = spawnSync("git", ["status", "--porcelain", "--", "src/types/bindings"], {
      cwd: root,
      encoding: "utf8"
    });
    if (untracked.error) {
      console.error(`[ci:local] 绑定漂移：git 不可用（${untracked.error.message}），无法核验 untracked 绑定`);
      process.exit(1);
    }
    if (untracked.stdout && untracked.stdout.trim().length > 0) {
      console.error("[ci:local] 绑定漂移：cargo test 生成了未跟踪的绑定文件，请 git add 后提交：");
      console.error(untracked.stdout.trim());
      process.exit(1);
    }
  }
  process.exit(0);
}
process.exit(failed);
