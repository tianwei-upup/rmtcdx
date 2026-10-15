$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path $PSScriptRoot -Parent
$taskStatePath = Join-Path $taskRoot '.runtime\tunnel.json'
if (-not (Test-Path -LiteralPath $taskStatePath)) { Write-Output '没有本项目隧道记录。'; exit 0 }
$taskState = Get-Content -LiteralPath $taskStatePath -Raw | ConvertFrom-Json
$taskBinary = Join-Path $taskRoot '.runtime\tools\cloudflared.exe'
$taskProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $([int]$taskState.pid)"
if (-not $taskProcess) { Write-Output '隧道已停止。'; exit 0 }
if ($taskState.binary -ne $taskBinary -or $taskProcess.ExecutablePath -ne $taskBinary) {
    throw '隧道 PID 与可执行文件不匹配，拒绝停止其他进程。'
}
Stop-Process -Id $taskState.pid
Write-Output '公网入口已关闭，本机 Codex 服务仍在运行。'
