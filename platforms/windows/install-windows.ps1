# install-windows.ps1 — Windows 一键安装 + 自动搜模型导入 WorkBuddy + 启动桥
# 双击「start.bat」即可运行；也可在 PowerShell 中执行：
#   powershell -ExecutionPolicy Bypass -File .\install-windows.ps1
#
# 每次启动会：
#   1. 检测 Node.js (>=18)
#   2. 首次运行：在 %USERPROFILE%\.our-free-model 创建配置模板并提示填写
#   3. 自动搜索上游免费模型、生成总入口、同步导入 WorkBuddy 的 models.json（幂等）
#   4. 启动桥（前台，Ctrl+C 或关窗口停止）

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

function Info($m){ Write-Host "[OK] $m" -ForegroundColor Green }
function Warn($m){ Write-Host "[!] $m" -ForegroundColor Yellow }
function Fail($m){ Write-Host "[x] $m" -ForegroundColor Red; Read-Host "按 Enter 退出"; exit 1 }

Write-Host ""
Write-Host "=== OFM Ollama Bridge · Windows 一键安装 ===" -ForegroundColor Cyan
Write-Host ""

$SelfDir  = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot = Split-Path -Parent (Split-Path -Parent $SelfDir)
$HomeDir = if ($env:USERPROFILE) { $env:USERPROFILE } else { $HOME }
$DataDir = Join-Path $HomeDir ".our-free-model"
$WbDir   = Join-Path $HomeDir ".workbuddy"

# ── 1) Node.js (>=18) ──
$Node = $null
$cmd = Get-Command node.exe -ErrorAction SilentlyContinue
if ($cmd) { $Node = $cmd.Source }
if (-not $Node) {
  foreach ($c in @(
    (Join-Path (Join-Path $env:ProgramFiles "nodejs") "node.exe"),
    (Join-Path (Join-Path $env:LOCALAPPDATA "Programs\nodejs") "node.exe")
  )) { if ($c -and (Test-Path $c)) { $Node = $c; break } }
}
if (-not $Node) {
  Fail "未找到 Node.js。请先安装（任选其一）：
  winget install OpenJS.NodeJS.LTS
  或打开 https://nodejs.org 下载 LTS 版
安装后重新双击「start.bat」。"
}
$nodeVer = (& $Node -v) 2>$null
$major = 0
try { $major = [int](($nodeVer -replace '^v','').Split('.')[0]) } catch { $major = 0 }
if ($major -lt 18) { Fail "Node 版本过低：$nodeVer（需要 >= 18）。请升级后重试。" }
Info "Node $nodeVer  ($Node)"

# ── 2) 桥文件与导入脚本 ──
$Bridge = Join-Path $RepoRoot "src\ollama-bridge.mjs"
if (-not (Test-Path $Bridge)) { Fail "找不到 src\ollama-bridge.mjs（请从仓库根目录运行，保持目录结构完整）。" }
Info "桥文件：$Bridge"

$Setup = Join-Path $RepoRoot "src\setup-auto-entry.mjs"
$canSync = Test-Path $Setup
if ($canSync) { Info "导入脚本：$Setup" } else { Warn "未找到 src\setup-auto-entry.mjs，将跳过自动导入 WorkBuddy" }

# ── 3) 数据目录与配置 ──
if (-not (Test-Path $DataDir)) { New-Item -ItemType Directory -Force -Path $DataDir | Out-Null }
$Settings = Join-Path $DataDir "settings.json"
$Rescue   = Join-Path $DataDir "rescue-providers.json"
$firstRun = $false

if (-not (Test-Path $Settings)) {
  $tpl = Join-Path $RepoRoot "examples\settings.example.json"
  if (Test-Path $tpl) { Copy-Item $tpl $Settings }
  else {
    $fallback = '{"forwardKey":"请填写你的-forwardKey","managementKey":"","standalonePort":18900,"combos":[]}'
    Set-Content -Path $Settings -Value $fallback -Encoding UTF8
  }
  $firstRun = $true
}
if (-not (Test-Path $Rescue)) {
  $rtpl = Join-Path $RepoRoot "examples\rescue-providers.example.json"
  if (Test-Path $rtpl) { Copy-Item $rtpl $Rescue }
}

# 尽量收紧配置文件权限（Windows ACL）
try {
  foreach ($f in @($Settings, $Rescue)) {
    if (Test-Path $f) { icacls $f /inheritance:r /grant:r "$($env:USERNAME):(R,W)" | Out-Null }
  }
} catch { }

if ($firstRun) {
  Warn "首次运行：已在 $DataDir 创建配置模板。"
  Write-Host "  请编辑 settings.json 填入 forwardKey / standalonePort / combos 后保存。" -ForegroundColor Yellow
  Write-Host "  （如需外部救援，再编辑 rescue-providers.json 填真实 apiKey）" -ForegroundColor Yellow
  Write-Host "  保存后重新双击「start.bat」——届时会自动搜索免费模型并导入 WorkBuddy。`n" -ForegroundColor Yellow
  try { Start-Process notepad.exe $Settings } catch { }
  Read-Host "按 Enter 退出"
  exit 0
}

Info "配置目录：$DataDir"

# ── 4) 自动搜索免费模型并导入 WorkBuddy（幂等） ──
if ($canSync) {
  $wbModels = Join-Path $WbDir "models.json"
  if (-not (Test-Path $WbDir)) { New-Item -ItemType Directory -Force -Path $WbDir | Out-Null }
  if (-not (Test-Path $wbModels)) { Set-Content -Path $wbModels -Value "[]" -Encoding UTF8 }

  Write-Host ""
  Write-Host "==> 正在搜索上游免费模型并同步导入 WorkBuddy..." -ForegroundColor Cyan
  $env:OFM_HOME = $DataDir
  $env:OFM_DATA_DIR = $DataDir
  $env:OFM_WORKBUDDY_MODELS = $wbModels
  $env:OFM_RESCUE_CONFIG = $Rescue
  try {
    & $Node $Setup --wb 2>&1 | ForEach-Object { Write-Host "    $_" }
    Info "模型已同步到 WorkBuddy：$wbModels（幂等，可重复运行）"
  } catch {
    Warn "自动导入失败（不影响启动桥）：$($_.Exception.Message)"
    Write-Host "  可稍后手动运行：node `"$Setup`" --wb" -ForegroundColor DarkGray
  }
  # 尽量收紧 models.json 权限
  try { if (Test-Path $wbModels) { icacls $wbModels /inheritance:r /grant:r "$($env:USERNAME):(R,W)" | Out-Null } } catch { }
} else {
  Write-Host "  （跳过自动导入：未找到导入脚本）" -ForegroundColor DarkGray
}

# ── 5) 启动桥 ──
$LogDir = Join-Path $SelfDir "logs"
if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Force -Path $LogDir | Out-Null }
Write-Host ""
Write-Host "正在启动桥（端口 11435）...  按 Ctrl+C 或关闭窗口即停止。" -ForegroundColor Cyan
Write-Host "健康检查：http://127.0.0.1:11435/health" -ForegroundColor DarkGray
Write-Host "导入后在 WorkBuddy 模型列表中选择「⓪ 总入口（轮询双通道·抗 429）」即可使用。" -ForegroundColor DarkGray
Write-Host ""

& $Node $Bridge
$code = $LASTEXITCODE
if ($code -ne 0) {
  Warn "桥已退出，代码 $code。请查看上方输出排查。"
  Read-Host "按 Enter 关闭"
}
exit $code
