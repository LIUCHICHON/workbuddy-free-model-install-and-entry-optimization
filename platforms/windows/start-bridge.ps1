# start-bridge.ps1 — Windows 版桥启动脚本（设备无关）
# 行为与 macOS 的 start-bridge.sh 对齐：路径全部由脚本自身位置 + $env:USERPROFILE 推导。
# 用法：powershell -ExecutionPolicy Bypass -File start-bridge.ps1
$ErrorActionPreference = 'Stop'

$SelfDir  = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot = Split-Path -Parent (Split-Path -Parent $SelfDir)
$HomeDir = if ($env:USERPROFILE) { $env:USERPROFILE } else { $HOME }

# 找 Node：先 PATH，再 WorkBuddy 自带，最后常见安装位置
$Node = $null
$cmd = Get-Command node.exe -ErrorAction SilentlyContinue
if ($cmd) { $Node = $cmd.Source }
if (-not $Node) {
  $wbDir = Join-Path $Home '.workbuddy\binaries\node\versions'
  if (Test-Path $wbDir) {
    $Node = Get-ChildItem $wbDir -Directory | Sort-Object LastWriteTime -Descending |
      ForEach-Object { Join-Path $_.FullName 'bin\node.exe' } |
      Where-Object { Test-Path $_ } | Select-Object -First 1
  }
}
if (-not $Node) {
  foreach ($c in @(
    (Join-Path $env:ProgramFiles 'nodejs\node.exe'),
    (Join-Path ${env:ProgramFiles(x86)} 'nodejs\node.exe'),
    (Join-Path $env:LOCALAPPDATA 'Programs\nodejs\node.exe')
  )) { if ($c -and (Test-Path $c)) { $Node = $c; break } }
}
if (-not $Node) {
  Write-Error '[x] 找不到 node.exe。请安装 Node.js >= 18（winget install OpenJS.NodeJS.LTS 或 https://nodejs.org）。'
  exit 1
}

# Node >= 18 才有内置 fetch / ReadableStream
$major = [int](& $Node -p 'process.versions.node.split(''.'')[0]')
if ($major -lt 18) {
  Write-Error "[x] Node 版本过低：$(& $Node -v)（需要 >= 18）。升级后再启动桥。"
  exit 1
}

Write-Host "[ofm-bridge] node=$Node (& $Node -v)"
& $Node (Join-Path $RepoRoot 'src\ollama-bridge.mjs')
exit $LASTEXITCODE
