#Requires -Version 5.1
<#
.SYNOPSIS
    Vela (Focus Desk) 发布清单生成：对 bundle 下全部安装产物生成 SHA256SUMS。

.DESCRIPTION
    对 src-tauri\target\release\bundle 下 nsis\*.exe 与 msi\*.msi 逐项计算
    SHA-256，连同文件名、大小、版本号写入 SHA256SUMS（格式见文件头注释，
    由 scripts\release\verify.ps1 解析）。

    版本号从 package.json 与 src-tauri\tauri.conf.json 双源读取，二者不一致
    视为发布事故（安装包文件名的版本来自 tauri.conf.json），直接报错退出。

    -Sidecars 额外在每个产物旁生成 GNU sha256sum 兼容的 <产物>.sha256：
    自研更新链 download_update 会请求与安装包同目录的 <url>.sha256 并取其中
    首个 64 位十六进制 token 作为期望哈希（system_integration.rs 的
    fetch_expected_sha256），部署更新源时这些 sidecar 必须一并上传。

.PARAMETER BundleDir
    安装产物根目录，默认 <仓库>\src-tauri\target\release\bundle。

.PARAMETER OutFile
    清单输出路径，默认 <BundleDir>\SHA256SUMS。

.PARAMETER Sidecars
    同时生成每个产物的 <产物>.sha256（更新源部署所需）。

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\release\sum.ps1
#>
[CmdletBinding()]
param(
    [string]$BundleDir = '',
    [string]$OutFile = '',
    [switch]$Sidecars
)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

# ---------- 路径解析 ----------
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
if (-not $BundleDir) { $BundleDir = Join-Path $RepoRoot 'src-tauri\target\release\bundle' }
if (-not (Test-Path -LiteralPath $BundleDir -PathType Container)) {
    Write-Host "错误：产物目录不存在：$BundleDir（先运行 npm run tauri:build）"
    exit 1
}
$BundleDir = (Resolve-Path -LiteralPath $BundleDir).Path
if (-not $OutFile) { $OutFile = Join-Path $BundleDir 'SHA256SUMS' }

# ---------- 版本读取（package.json / tauri.conf.json 双源一致性门禁）----------
$pkgPath = Join-Path $RepoRoot 'package.json'
$confPath = Join-Path $RepoRoot 'src-tauri\tauri.conf.json'
foreach ($f in @($pkgPath, $confPath)) {
    if (-not (Test-Path -LiteralPath $f -PathType Leaf)) {
        Write-Host "错误：缺少版本来源文件：$f"
        exit 1
    }
}
# PS 5.1 对无 BOM 文件默认按 ANSI 读取（package.json 的中文 author 会破坏
# JSON 解析），必须显式 UTF-8。
$pkgVersion = (Get-Content -LiteralPath $pkgPath -Raw -Encoding UTF8 | ConvertFrom-Json).version
$confJson = Get-Content -LiteralPath $confPath -Raw -Encoding UTF8 | ConvertFrom-Json
$confVersion = $confJson.version
if (-not $pkgVersion) {
    Write-Host "错误：package.json 缺少 version 字段"
    exit 1
}
if (-not $confVersion) {
    Write-Host ("错误：tauri.conf.json 未显式声明 version（此时打包器退回 Cargo.toml），" +
        "发布清单要求版本来源确定，请在 tauri.conf.json 中显式写入 version")
    exit 1
}
if ($pkgVersion -ne $confVersion) {
    Write-Host "错误：版本号不一致——package.json = $pkgVersion，tauri.conf.json = $confVersion。" +
        "安装包文件名的版本来自 tauri.conf.json，发布前必须先对齐两处版本号。"
    exit 1
}
$Version = $confVersion
$Product = $confJson.productName
if (-not $Product) { $Product = 'Vela' }

# ---------- 收集安装产物 ----------
$artifacts = @()
$artifacts += Get-ChildItem -Path (Join-Path $BundleDir 'nsis') -Filter '*.exe' -File -ErrorAction SilentlyContinue
$artifacts += Get-ChildItem -Path (Join-Path $BundleDir 'msi') -Filter '*.msi' -File -ErrorAction SilentlyContinue
$artifacts = @($artifacts | Sort-Object -Property FullName)
if ($artifacts.Count -eq 0) {
    Write-Host "错误：$BundleDir 下未找到任何 nsis\*.exe 或 msi\*.msi（先运行 npm run tauri:build）"
    exit 1
}

# ---------- 计算哈希 ----------
$entries = @()
foreach ($a in $artifacts) {
    $rel = $a.FullName.Substring($BundleDir.Length + 1).Replace('\', '/')
    $hash = (Get-FileHash -LiteralPath $a.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    $entries += [pscustomobject]@{
        Rel  = $rel
        Name = $a.Name
        Hash = $hash
        Size = $a.Length
    }
    if ($a.Name -notlike "*$Version*") {
        Write-Host "警告：产物文件名不含当前版本号 $Version：$rel（可能是旧构建残留，确认后再发布）"
    }
}

# ---------- 写清单 ----------
$stamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss zzz'
$lines = New-Object System.Collections.Generic.List[string]
$lines.Add("# $Product (Focus Desk) release manifest")
$lines.Add("# product:   $Product")
$lines.Add("# version:   $Version")
$lines.Add("#   package.json:     $pkgVersion")
$lines.Add("#   tauri.conf.json:  $confVersion")
$lines.Add("# generated: $stamp")
$lines.Add("# artifacts: $($entries.Count)")
$lines.Add('# format:    <sha256>  <size-bytes>  <version>  <relative-path>')
$lines.Add('#            解析器为 scripts/release/verify.ps1；文件名（可能含空格）是行尾字段，')
$lines.Add('#            取第 4 个空白分隔字段之后的整段。本格式不能直接喂给 sha256sum -c。')
$lines.Add('#            更新源部署用 -Sidecars 生成 GNU 兼容的 <产物>.sha256。')
foreach ($e in $entries) {
    $lines.Add("$($e.Hash)  $($e.Size)  $Version  $($e.Rel)")
}
[System.IO.File]::WriteAllText($OutFile, (($lines -join "`n") + "`n"))

# ---------- 生成 sidecar（更新链 <url>.sha256 期望格式）----------
if ($Sidecars) {
    foreach ($e in $entries) {
        $sidecar = Join-Path $BundleDir (($e.Rel.Replace('/', '\')) + '.sha256')
        [System.IO.File]::WriteAllText($sidecar, "$($e.Hash)  $($e.Name)`n")
    }
}

# ---------- 汇总 ----------
Write-Host ""
Write-Host "清单已生成：$OutFile"
foreach ($e in $entries) {
    Write-Host ("  {0}  {1,12:N0} 字节  {2}…" -f $e.Rel, $e.Size, $e.Hash.Substring(0, 16))
}
Write-Host "共 $($entries.Count) 项产物，版本 $Version（package.json 与 tauri.conf.json 一致）"
if ($Sidecars) {
    Write-Host "已生成 GNU sha256sum 兼容 sidecar（<产物>.sha256）——更新源部署时须与安装包同目录"
}
Write-Host "下一步：powershell -NoProfile -ExecutionPolicy Bypass -File scripts\release\verify.ps1 校验通过后才可发布"
exit 0
