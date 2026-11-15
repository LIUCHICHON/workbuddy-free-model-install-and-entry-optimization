# install-bridge-service.ps1 — 把桥注册为 Windows 计划任务（登录自启 + 崩溃自愈）
# 无需管理员权限（注册到当前用户）。对标 macOS 的 launchd KeepAlive。
# 用法：powershell -ExecutionPolicy Bypass -File install-bridge-service.ps1
#        加 -Uninstall 卸载。
param([switch]$Uninstall)

$ErrorActionPreference = 'Stop'
$TaskName = 'OFM-Ollama-Bridge'
$SelfDir  = Split-Path -Parent $MyInvocation.MyCommand.Path
$StartPs1 = Join-Path $SelfDir 'start-bridge.ps1'
$LogDir   = Join-Path $SelfDir 'logs'

if ($Uninstall) {
  if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host "[✓] 已卸载计划任务 $TaskName"
  } else {
    Write-Host "[i] 计划任务 $TaskName 不存在，无需卸载"
  }
  exit 0
}

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$outLog = Join-Path $LogDir 'bridge.out.log'
$errLog = Join-Path $LogDir 'bridge.err.log'

# 动作：通过 start-bridge.ps1 启动（它自己找 node 并做版本护栏）
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument (
  '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "{0}" *>> "{1}"' -f $StartPs1, $outLog
)
# 触发器：登录时启动
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
# 设置：失败自动重启（对标 KeepAlive）、不限制运行时长
$settings = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings `
  -Description 'OFM Ollama 协议桥（免费大模型 → Ollama/OpenAI 兼容），登录自启 + 崩溃自愈' | Out-Null

# 立即启动一次
Start-ScheduledTask -TaskName $TaskName
Start-Sleep -Seconds 3

# 自检：健康端点
try {
  $h = Invoke-RestMethod -Uri 'http://127.0.0.1:11435/health' -TimeoutSec 8
  Write-Host "[✓] 桥已启动：status=$($h.status) models=$($h.models)"
} catch {
  Write-Host "[!] 健康检查未通过，查看日志：$outLog"
  exit 1
}
Write-Host "[✓] 计划任务 $TaskName 已注册（登录自启 + 失败每分钟自愈）"
