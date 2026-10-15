$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path $PSScriptRoot -Parent
$taskFile = Join-Path $taskRoot '.runtime\control-processes.json'
if (-not (Test-Path -LiteralPath $taskFile)) { Write-Output '没有本地中转进程记录。'; exit 0 }
$taskRecords = @(Get-Content -LiteralPath $taskFile -Raw | ConvertFrom-Json)
foreach ($taskRecord in ($taskRecords | Sort-Object name -Descending)) {
    $taskProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $([int]$taskRecord.pid)"
    if (-not $taskProcess) { continue }
    $taskExpected = if ($taskRecord.name -eq 'control') { Join-Path $taskRoot 'control\src\cloud.mjs' } elseif ($taskRecord.name -eq 'windows-client') { Join-Path $taskRoot 'control\src\client.mjs' } else { throw '未知进程记录' }
    if ([IO.Path]::GetFullPath($taskRecord.entry) -ne $taskExpected -or $taskProcess.Name -ne 'node.exe' -or
        -not $taskProcess.CommandLine.Contains($taskRecord.entry)) { throw '进程身份不匹配，拒绝停止。' }
    Stop-Process -Id $taskRecord.pid -ErrorAction Stop
}
Write-Output '本地云端和连接客户端已停止；Codex bridge 保持运行。'
