$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path $PSScriptRoot -Parent
$taskRuntime = Join-Path $taskRoot '.runtime'
$taskUrl = (Get-Content -LiteralPath (Join-Path $taskRuntime 'public-url.txt') -Raw).Trim()
if ($taskUrl -notmatch '^https://[a-z0-9-]+\.trycloudflare\.com$') { throw '隧道地址无效' }
foreach ($taskRoute in @('/', '/api/repos', '/ws')) {
    $taskName = if ($taskRoute -eq '/') { 'root' } elseif ($taskRoute -eq '/ws') { 'ws' } else { 'api' }
    $taskHeaders = Join-Path $taskRuntime "anon-$taskName.headers"
    $taskBody = Join-Path $taskRuntime "anon-$taskName.body"
    $taskArgs = @('-sS', '--max-time', '25', '-D', $taskHeaders, '-o', $taskBody, ($taskUrl + $taskRoute))
    if ($taskName -eq 'ws') {
        $taskArgs += @('-H', 'Connection: Upgrade', '-H', 'Upgrade: websocket',
            '-H', 'Sec-WebSocket-Version: 13', '-H', 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==')
    }
    & curl.exe @taskArgs
    if ($LASTEXITCODE -ne 0) { throw "公网请求失败：$taskRoute" }
    $taskText = Get-Content -LiteralPath $taskHeaders -Raw
    $taskStatuses = [regex]::Matches($taskText, 'HTTP/[^ ]+ ([0-9]{3})')
    if ($taskStatuses.Count -eq 0) { throw "未收到 HTTP 响应：$taskRoute" }
    $taskStatus = [int]$taskStatuses[$taskStatuses.Count - 1].Groups[1].Value
    $taskLocation = [regex]::Match($taskText, '(?im)^location:\s*(.+)$').Groups[1].Value.Trim()
    $taskAuthRedirect = $false
    if ($taskLocation) {
        $taskRedirect = [Uri]$taskLocation
        $taskAuthRedirect = $taskRedirect.Scheme -eq 'https' -and
            $taskRedirect.Host -eq 'login.trycloudflare.com' -and $taskRedirect.AbsolutePath -eq '/authorize'
    }
    Write-Output "$taskRoute => HTTP $taskStatus, authentication redirect: $taskAuthRedirect"
    if ($taskStatus -notin @(302, 303, 401, 403) -or
        ($taskStatus -in @(302, 303) -and -not $taskAuthRedirect)) {
        throw "认证保护未确认：$taskRoute"
    }
}
Write-Output "匿名网页、API 和 WebSocket 均被阻止访问：$taskUrl"
