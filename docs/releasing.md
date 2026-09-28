# 发布流程（releasing）

> 适用版本：0.1.0 ｜ 本文是发布的**唯一权威 checklist**：从构建到分发每一步的命令、判定标准与已知缺口。
> 来源：对标分析 §4.15（业界发布链的 SHA256SUMS → verify-assets → 标 latest 环节）；构建细节见 [ARCHITECTURE.md §8](../ARCHITECTURE.md) 与 [DEPLOYMENT.md](DEPLOYMENT.md)。
>
> 核心原则：**verify 通过（退出码 0）是「可发布」的唯一判据**。哈希清单生成与核对不是可选步骤。

---

## 1. 工具一览

| 脚本                         | 作用                                                                                                                           | 退出码                                         |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------- |
| `scripts/release/sum.ps1`    | 对 `src-tauri/target/release/bundle/` 下 `nsis/*.exe`、`msi/*.msi` 逐项计算 SHA-256，连同文件名、大小、版本号写入 `SHA256SUMS` | 0 成功；1 目录不存在 / 无产物 / 版本不一致     |
| `scripts/release/verify.ps1` | 按清单逐项核对（存在 / 大小 / 哈希），并扫描清单外的多余安装产物                                                               | 0 全部通过；1 篡改/缺失/多余；2 清单缺失或损坏 |

两脚本兼容 Windows PowerShell 5.1 与 PowerShell 7：`sum.ps1` 可指定 `-BundleDir` / `-OutFile` / `-Sidecars`，`verify.ps1` 可指定 `-ArtifactDir` / `-Manifest`，均可校验任意目录（CI 与本地共用同一套逻辑）。

版本号从 `package.json` 与 `src-tauri/tauri.conf.json` **双源读取**，不一致直接失败——安装包文件名的版本来自 `tauri.conf.json`，两处漂移是典型发布事故。（`Cargo.toml` 的 version 仅在 `tauri.conf.json` 缺省时被 Tauri 打包器采用，当前已显式声明，无需三处对齐。）

## 2. 发布 checklist

### 第 0 步 · 前置检查

- [ ] 版本号已按需更新，且 `package.json` 与 `src-tauri/tauri.conf.json` **一致**（`sum.ps1` 会硬校验）
- [ ] 质量门禁全绿：`npm run check`、`npm run lint`、`npm run lint:anim`、`npm run lint:tokens`、`npm run lint:i18n`、`npm test`；`src-tauri` 下 `cargo fmt --check`、`cargo clippy --all-targets -- -D warnings`、`cargo test --lib`
- [ ] 工作区干净（`git status`），基于 `master` 构建

### 第 1 步 · 构建

```powershell
npm run tauri:build
```

产物位于 `src-tauri/target/release/bundle/`：

| 产物                            | 用途                                                                                   |
| ------------------------------- | -------------------------------------------------------------------------------------- |
| `nsis/Vela_<ver>_x64-setup.exe` | 推荐分发形态；**自研更新链唯一接受的安装器**（`install_update` 以 `/S` 静默执行 NSIS） |
| `msi/Vela_<ver>_x64_en-US.msi`  | 企业/组网场景直装；不走更新链                                                          |

建议构建前清空 `bundle/` 下的旧版本残留——旧文件不会被误发布的原因正是第 3 步会把它当「多余」拦下，但一次干净构建更省事。

### 第 2 步 · 生成哈希清单（一条命令）

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\release\sum.ps1
```

输出 `bundle\SHA256SUMS`，格式（解析器为 `verify.ps1`，文件名是**行尾字段**以兼容含空格的产物名；本格式不能直接喂给 `sha256sum -c`）：

```text
# Vela (Focus Desk) release manifest
# product:   Vela
# version:   0.1.0
#   package.json:     0.1.0
#   tauri.conf.json:  0.1.0
# generated: 2026-09-27 13:22:33 +08:00
# artifacts: 2
# format:    <sha256>  <size-bytes>  <version>  <relative-path>
b7b13c3f…  10448896  0.1.0  msi/Vela_0.1.0_x64_en-US.msi
1720db8f…   7756059  0.1.0  nsis/Vela_0.1.0_x64-setup.exe
```

（示例大小为 2026-09-27 实测：MSI 10,448,896 字节 ≈ 10.0 MB、NSIS 7,756,059 字节 ≈ 7.4 MB；哈希为截断示意。）

**要部署自研更新源时**，加 `-Sidecars` 在每个产物旁生成 GNU sha256sum 兼容的 `<产物>.sha256`（内容 `哈希␠␠文件名`）——更新链 `download_update` 会请求与安装包同目录的 `<url>.sha256` 并取其中首个 64 位十六进制 token 作为期望哈希（`system_integration.rs` 的 `fetch_expected_sha256`），**缺了这个 sidecar，下载校验直接失败**。

### 第 3 步 · 更新源 endpoint 配置提醒（自研更新链）

更新链为自研实现（`src-tauri/src/system_integration.rs`），**不是** Tauri updater 插件。部署更新源时逐项确认：

- [ ] 更新源地址由用户在设置页配置（持久化于 `extra.updateEndpoint`），**下载地址必须与 endpoint 同域或为其子域**——每跳重定向都会重新执行「内网拒绝 + 同域校验」（SSRF 守卫，fail-closed：endpoint 未配置即拒绝下载）
- [ ] 更新源为 GitHub 仓库地址（`owner/repo`）时，下载域白名单自动放行 `github.com` 与官方资产域（`objects.githubusercontent.com` / `release-assets.githubusercontent.com`）；`.sha256` sidecar 仍须作为 Release 附件与安装包同传
- [ ] HTTP 服务器**不得**对安装包或 `.sha256` 做 301/302 跳转（客户端禁自动重定向，每跳重校验）
- [ ] 安装包与 `<url>.sha256` sidecar **同目录**上传（`-Sidecars` 产物）
- [ ] 更新链只分发 NSIS `.exe`；MSI 仅作官网/Release 直装附件
- [ ] **信任边界（F-6/D-1）**：`.sha256` sidecar 与安装包同源——它防损坏、**不防"源被攻破后连哈希一起换"的投毒**。因此更新源必须 **HTTPS**（客户端硬性拒绝 `http://`，D-1 已落地）且由项目方私有托管，不得挂在可被第三方写入的公共空间
- [ ] **manifest 签名（D-1 已落地）**：发布时用 `scripts/release/sign-manifest.mjs --key <仓库外私钥> --version vX.Y.Z [--notes …] --url https://… --sha256 <安装包哈希|或 --exe 路径现算>` 产出带 `sha256`+`sig` 的 manifest 部署到更新源。客户端（`update_sig.rs`）以离线内嵌公钥验签，验签过的哈希优先于 sidecar——更新源被完全攻破也无法伪造可安装的清单；不带签名的清单回退 sidecar 校验（仅防损坏）。私钥保存在仓库外（工作区 `release-keys/`），轮换时更换 `UPDATE_MANIFEST_PUBKEY_HEX` 并随版本发布

> ⚠ **已知缺口 B（2026-09-27 核对后收敛，如实标注）**：版本清单格式**已定义并落地**——前端 `src/lib/update-flow.ts` 的 `fetchRemoteManifest` 严格校验 `{ version, notes?, url? }`（版本形态、URL 禁带凭据/非 http(s)）；GitHub 仓库地址（`owner/repo`）原生支持：Insider 通道走 Releases API 取通道内最新，失败回退 `releases/latest` 302 探测（Rust 命令 `resolve_latest_tag`）。Rust 侧 `check_updates` 命令仍为占位（仅返回当前版本，真实检查由前端链路驱动）。**剩余待办**：官方更新源尚未实际部署、首个带 `.sha256` sidecar 的 Release 尚未发布——在此之前用户需手动下载完整安装包覆盖安装（用户数据在 `%APPDATA%\com.cleanroom.focusdesk\`，覆盖安装不丢数据）。

### 第 4 步 · verify 通过才可发布

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\release\verify.ps1
```

- [ ] 退出码 0（全部 PASS，无缺失/篡改/多余）→ 才允许进入第 5 步
- 退出码 1（篡改/缺失/多余）或 2（清单损坏）→ **禁止发布**，按下表处置后从第 1 或 2 步重来

| 失败类别 | 典型原因               | 处置                                       |
| -------- | ---------------------- | ------------------------------------------ |
| `[大小]` | 下载中断/旧残留/被改写 | 重新构建并重新生成清单                     |
| `[篡改]` | 字节级改动（大小不变） | 怀疑供应链问题时全量重建，勿仅重生成清单   |
| `[缺失]` | 清单生成后被删文件     | 确认产物完整性后重新 `sum.ps1`             |
| `[多余]` | bundle 残留旧版本产物  | 清掉旧文件（这步就是防「新旧混发」的闸门） |

### 第 5 步 · 发布

- [ ] 安装包与 `SHA256SUMS` **一起**作为 Release 附件发布（用户可自行核对哈希后再安装）
- [ ] （接入 endpoint 后）安装包 + `.sha256` sidecar 部署到更新源，并核对线上 sidecar 与本地清单一致

CI 侧等价物：GitHub Actions 的 `release-verify` job（手动触发，`.github/workflows/ci.yml`）在 windows runner 上完整执行 构建 → sum（带 `-Sidecars`）→ verify → 篡改自测（对副本翻转一个字节，断言 verify 非零退出），并把安装包、sidecar 与清单作为 artifact 上传，用于发布前在干净环境复验整条链。CI 仅此一个 workflow（frontend / backend / release-verify 三个 job）；E2E（`npm run test:e2e`，需 tauri-driver + msedgedriver + 先 `npm run tauri:build`）**未接 CI**，发布前自行决定是否本地跑一遍。

## 3. 已知缺口 A：未代码签名（如实标注，本次不做）

- **现状**：安装包**未做 Authenticode 代码签名**。Windows SmartScreen 会拦截首次运行——弹出「Windows 已保护你的电脑」，用户需点「更多信息 → 仍要运行」。
- **为什么还没做**：需要采购代码签名证书（OV 需实名认证、按年付费；EV 更贵但 SmartScreen 声誉即时生效，OV 需靠安装量逐步积累），**明确列为待办**，本发布链只覆盖哈希清单与校验，不涵盖签名本身。
- **过渡期话术**：Release 说明中应告知用户 SmartScreen 拦截的存在与「仍要运行」操作路径，并附 SHA256SUMS 供核验。
- **边界说明**：自研更新链的完整性靠 SHA-256 清单校验保证，**不依赖**代码签名；但签名仍是防「更新源同域被入侵后投毒」之外社会工程攻击（仿冒站、改名exe）与提升信任面的正解，证书到位后应在 `tauri.conf.json` 配置 `windows.certificateThumbprint` 并把 signtool 加入发布链，届时更新本 checklist。

## 4. 更新通道 / 回滚 / 版本历史（发布侧须知，2026-09-26 ClassSoftwareHub 批次落地）

更新页（设置 → 更新）已内置双通道、回滚列表与本机版本历史，发布侧需配合以下约定：

- **双通道 stable / insider**：生效通道 = 用户手动选择优先，否则**跟随构建**——安装包版本号含 `-insider` 后缀即默认 Insider 通道（`src/lib/update-flow.ts` 的 `defaultUpdateChannel`）。发布 Insider 版时版本号必须带 `-insider`（如 `0.2.0-insider`），否则 stable 用户也会被推到。
- **prerelease 标记即通道**：GitHub 仓库源（`owner/repo`）下，stable 通道只看非 prerelease 的 Release，insider 全量可见（`filterByChannel`）。把 Release 标为 prerelease 即等价「仅 Insider 可见」。
- **回滚列表**：Releases API 最近 20 条（`githubReleasesApiUrl`），点哪个装哪个，复用同一套下载校验与静默安装。Release 附件的安装包命名要能被 `pickReleaseAsset` 正确挑中（规则：与用户配置的产物名 `extra.updateArtifact` 精确同名 > 名含 `setup`/`installer` > 取最大文件；checksums/portable/blockmap 等杂项被排除）——当前实测产物名 `Vela_<ver>_x64-setup.exe` 命中 setup 规则。
- **本机版本历史**：`src/lib/version-history.ts` 进入更新页自动记录「版本 + 通道 + firstSeen/lastSeen」，上限 30 条，localStorage 轻数据随备份镜像，发布侧无需任何配合。

## 5. SHA256SUMS 格式细则（供其他工具/平台解析）

- 编码 UTF-8（无 BOM）、LF 换行；`#` 开头为头部注释，`# version:` 行是清单声明版本，条目版本必须与之相等
- 条目：`<64 位小写 hex>␠␠<字节数>␠␠<版本>␠␠<相对路径（正斜杠，可含空格，至行尾）>`
- 路径必须位于产物目录内（禁止绝对路径、盘符、`..`）；条目不可重复
- sidecar（`<产物>.sha256`）：`<64 位小写 hex>␠␠<文件名>`，GNU sha256sum 兼容，更新链取首个 token

---

_创建于 2026-09-15（会话 REL「发布校验链」，对标分析 §4.15 落地项）；2026-09-27 核对更新（双通道/回滚/版本历史批次、更新清单格式落地、产物实测大小）。流程变更时请同步更新本文与 `.github/workflows/ci.yml`。_
