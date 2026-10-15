param(
    [Parameter(Mandatory = $true)][string]$AllowedEmail,
    [int]$Port = 3210
)
$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path $PSScriptRoot -Parent
$taskRuntime = Join-Path $taskRoot '.runtime'
$taskBinary = Join-Path $taskRuntime 'tools\cloudflared.exe'
if ($AllowedEmail -notmatch '^[A-Za-z0-9._+%-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$') {
    throw '需要一个具体邮箱；不允许通配域名或多个邮箱。'
}
if (-not (Test-Path -LiteralPath $taskBinary)) { throw '请先安装 .runtime/tools/cloudflared.exe。' }
$taskHelp = & $taskBinary tunnel --help 2>&1 | Out-String
if ($taskHelp -notmatch '--allowed-mail') { throw '当前 cloudflared 不支持邮箱认证，拒绝开放入口。' }
$taskHealth = Invoke-RestMethod "http://127.0.0.1:$Port/healthz" -TimeoutSec 10
if (-not $taskHealth.ok -or $taskHealth.codex.mode -ne 'real' -or -not $taskHealth.codex.ready) {
    throw '本机真实 Codex 后端未就绪。'
}
$taskListeners = @(Get-NetTCPConnection -LocalPort $Port -State Listen)
if ($taskListeners.Count -ne 1 -or $taskListeners[0].LocalAddress -ne '127.0.0.1') {
    throw '源服务必须只监听 127.0.0.1。'
}
$taskStatePath = Join-Path $taskRuntime 'tunnel.json'
if (Test-Path -LiteralPath $taskStatePath) {
    $taskPrevious = Get-Content -LiteralPath $taskStatePath -Raw | ConvertFrom-Json
    $taskExisting = Get-CimInstance Win32_Process -Filter "ProcessId = $([int]$taskPrevious.pid)"
    if ($taskExisting -and $taskExisting.ExecutablePath -eq $taskBinary) {
        throw '本项目隧道仍在运行。使用已有地址或先运行 stop-tunnel.ps1。'
    }
}
$taskLog = Join-Path $taskRuntime 'tunnel.stderr.log'
$taskProcess = Start-Process -FilePath $taskBinary -ArgumentList @(
    'tunnel', '--no-autoupdate', '--protocol', 'http2',
    '--url', "http://127.0.0.1:$Port", '--allowed-mail', $AllowedEmail
) -WindowStyle Hidden -PassThru -WorkingDirectory $taskRuntime `
    -RedirectStandardOutput (Join-Path $taskRuntime 'tunnel.stdout.log') -RedirectStandardError $taskLog
$taskState = @{ pid = $taskProcess.Id; binary = $taskBinary; port = $Port; allowedEmail = $AllowedEmail; url = $null }
$taskState | ConvertTo-Json | Set-Content -LiteralPath $taskStatePath -Encoding utf8
for ($taskAttempt = 0; $taskAttempt -lt 90; $taskAttempt++) {
    if ($taskProcess.HasExited) { throw "隧道退出，请检查 $taskLog" }
    $taskLogs = Get-Content -LiteralPath $taskLog -Raw -ErrorAction SilentlyContinue
    if ($taskLogs -match 'https://[a-z0-9-]+\.trycloudflare\.com') {
        $taskState.url = $Matches[0]
        if ($taskLogs -match 'Registered tunnel connection') {
            $taskState | ConvertTo-Json | Set-Content -LiteralPath $taskStatePath -Encoding utf8
            $taskState.url | Set-Content -LiteralPath (Join-Path $taskRuntime 'public-url.txt') -Encoding utf8
            try {
                & (Join-Path $PSScriptRoot 'verify-tunnel.ps1')
            } catch {
                $taskCheck = Get-CimInstance Win32_Process -Filter "ProcessId = $($taskProcess.Id)"
                if ($taskCheck -and $taskCheck.ExecutablePath -eq $taskBinary) { Stop-Process -Id $taskProcess.Id }
                throw
            }
            Write-Output "邮箱认证隧道已建立：$($taskState.url)"
            exit 0
        }
    }
    Start-Sleep -Milliseconds 1000
}
# A failed start should never leave an unattended public tunnel behind.
$taskCheck = Get-CimInstance Win32_Process -Filter "ProcessId = $($taskProcess.Id)"
if ($taskCheck -and $taskCheck.ExecutablePath -eq $taskBinary) { Stop-Process -Id $taskProcess.Id }
throw "隧道未连接，已停止。检查 $taskLog"
