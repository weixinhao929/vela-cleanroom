#Requires -Version 5.1
<#
.SYNOPSIS
    Vela (Focus Desk) 发布校验：对产物目录逐项核对 SHA256SUMS。

.DESCRIPTION
    解析 sum.ps1 生成的 SHA256SUMS，对每个条目核对：文件存在、SHA-256 一致、
    大小一致；另扫描产物目录中清单未收录的 *.exe / *.msi（多余文件）。
    篡改 / 缺失 / 多余任一情况 => 退出码 1；清单缺失或格式损坏 => 退出码 2。
    CI 与发布流程以退出码 0 作为「可发布」的唯一判据。

    清单条目格式：<sha256>  <size-bytes>  <version>  <relative-path>
    （文件名是行尾字段，可含空格；路径必须位于产物目录内，禁止 .. / 盘符 / 绝对路径）。

.PARAMETER ArtifactDir
    安装产物根目录，默认 <仓库>\src-tauri\target\release\bundle。

.PARAMETER Manifest
    清单路径，默认 <ArtifactDir>\SHA256SUMS。

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\release\verify.ps1
#>
[CmdletBinding()]
param(
    [string]$ArtifactDir = '',
    [string]$Manifest = ''
)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

# ---------- 路径解析 ----------
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
if (-not $ArtifactDir) { $ArtifactDir = Join-Path $RepoRoot 'src-tauri\target\release\bundle' }
if (-not (Test-Path -LiteralPath $ArtifactDir -PathType Container)) {
    Write-Host "错误：产物目录不存在：$ArtifactDir"
    exit 2
}
$ArtifactDir = (Resolve-Path -LiteralPath $ArtifactDir).Path
if (-not $Manifest) { $Manifest = Join-Path $ArtifactDir 'SHA256SUMS' }
if (-not (Test-Path -LiteralPath $Manifest -PathType Leaf)) {
    Write-Host "错误：清单不存在：$Manifest（先运行 scripts\release\sum.ps1）"
    exit 2
}

# ---------- 解析清单 ----------
$raw = [System.IO.File]::ReadAllText($Manifest)
if ($raw.Length -gt 0 -and $raw[0] -eq [char]0xFEFF) { $raw = $raw.Substring(1) }
$lines = @($raw -split "`n" | ForEach-Object { $_.TrimEnd("`r") })

$entries = @()
$malformed = @()
$manifestVersion = ''
$inconsistentVersion = $false
for ($i = 0; $i -lt $lines.Count; $i++) {
    $line = $lines[$i]
    if ($line.Trim() -eq '' -or $line.StartsWith('#')) {
        if ($line -match '^#\s*version:\s*(\S+)') { $manifestVersion = $Matches[1] }
        continue
    }
    # 文件名为行尾字段（兼容含空格的产物名，如 "Focus Desk_0.1.0_x64-setup.exe"）
    if ($line -match '^([0-9a-fA-F]{64})[ \t]+([0-9]+)[ \t]+(\S+)[ \t]+(.+?)[ \t]*$') {
        $entries += [pscustomobject]@{
            Hash    = $Matches[1].ToLowerInvariant()
            Size    = [int64]$Matches[2]
            Version = $Matches[3]
            Rel     = $Matches[4]
        }
    }
    else {
        $malformed += "第 $($i + 1) 行无法解析：$line"
    }
}
if ($malformed.Count -gt 0) {
    $malformed | ForEach-Object { Write-Host "错误：$_" }
    exit 2
}
if ($entries.Count -eq 0) {
    Write-Host "错误：清单没有任何产物条目：$Manifest"
    exit 2
}
# 路径安全 + 内部版本一致性
foreach ($e in $entries) {
    $rel = $e.Rel.Replace('\', '/')
    if ($rel -match '^/' -or $rel -match '^[A-Za-z]:' -or ($rel -split '/') -contains '..') {
        Write-Host "错误：清单条目路径越界（禁止绝对路径 / 盘符 / ..）：$rel"
        exit 2
    }
    if ($manifestVersion -and $e.Version -ne $manifestVersion) {
        $inconsistentVersion = $true
        Write-Host "错误：条目版本 $(${e}.Version) 与清单头版本 $manifestVersion 不一致：$rel"
    }
}
if ($inconsistentVersion) { exit 2 }
$dupes = @($entries | Group-Object -Property { $_.Rel.Replace('\', '/') } | Where-Object { $_.Count -gt 1 })
if ($dupes.Count -gt 0) {
    $dupes | ForEach-Object { Write-Host "错误：清单条目重复：$($_.Name) x$($_.Count)" }
    exit 2
}

# ---------- 逐项校验 ----------
$fail = 0
$pass = 0
foreach ($e in $entries) {
    $relNorm = $e.Rel.Replace('\', '/')
    $path = Join-Path $ArtifactDir ($relNorm.Replace('/', '\'))
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        Write-Host "FAIL  [缺失]    $relNorm" -ForegroundColor Red
        $fail++
        continue
    }
    $actualSize = (Get-Item -LiteralPath $path).Length
    if ($actualSize -ne $e.Size) {
        Write-Host ("FAIL  [大小]    {0}  期望 {1:N0} 字节，实际 {2:N0} 字节" -f $relNorm, $e.Size, $actualSize) -ForegroundColor Red
        $fail++
        continue
    }
    $actualHash = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actualHash -ne $e.Hash) {
        Write-Host ("FAIL  [篡改]    {0}  期望 {1}…，实际 {2}…" -f $relNorm, $e.Hash.Substring(0, 16), $actualHash.Substring(0, 16)) -ForegroundColor Red
        $fail++
        continue
    }
    Write-Host ("PASS  {0}  ({1:N0} 字节  sha256 {2}…)" -f $relNorm, $actualSize, $actualHash.Substring(0, 16)) -ForegroundColor Green
    $pass++
}

# ---------- 多余文件扫描（清单外的安装产物一律视为多余）----------
$known = @{}
foreach ($e in $entries) { $known[$e.Rel.Replace('\', '/')] = $true }
# 注意 @() 必须包在命令调用上：零结果时得到空数组而非含 $null 的数组
$found = @(Get-ChildItem -Path $ArtifactDir -Recurse -File -Include '*.exe', '*.msi' -ErrorAction SilentlyContinue)
foreach ($f in $found) {
    $relNorm = $f.FullName.Substring($ArtifactDir.Length + 1).Replace('\', '/')
    if (-not $known.ContainsKey($relNorm)) {
        Write-Host "FAIL  [多余]    $relNorm（产物目录中存在清单未收录的安装产物）" -ForegroundColor Red
        $fail++
    }
}

# ---------- 汇总 ----------
Write-Host ""
if ($fail -gt 0) {
    Write-Host "校验失败：$fail 项问题，$pass 项通过 —— 禁止发布" -ForegroundColor Red
    exit 1
}
Write-Host "校验通过：$pass 项产物全部匹配（无缺失 / 篡改 / 多余），可以发布" -ForegroundColor Green
exit 0
