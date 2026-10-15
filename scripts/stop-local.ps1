$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path $PSScriptRoot -Parent
$taskStatePath = Join-Path $taskRoot '.runtime\bridge.json'
if (-not (Test-Path -LiteralPath $taskStatePath)) { Write-Output '没有本项目启动的服务记录。'; exit 0 }
$taskState = Get-Content -LiteralPath $taskStatePath -Raw | ConvertFrom-Json
$taskProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $([int]$taskState.pid)"
if (-not $taskProcess) { Write-Output '服务已经停止。'; exit 0 }
$taskExpectedEntry = Join-Path $taskRoot 'services\rmtcdx\apps\bridge\dist\main.js'
if ($taskState.entry -ne $taskExpectedEntry -or $taskProcess.Name -ne 'node.exe' -or
    -not $taskProcess.CommandLine.Contains($taskExpectedEntry)) {
    throw 'PID 与本项目服务不匹配，拒绝停止其他进程。'
}
# Stops only the verified bridge and its own app-server child; active runs will end.
taskkill /PID $taskState.pid /T /F
if ($LASTEXITCODE -ne 0) { throw '停止失败' }
