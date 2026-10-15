param([int]$Port = 3210)
$ErrorActionPreference = 'Stop'
$taskBase = "http://127.0.0.1:$Port"
$taskHealth = Invoke-RestMethod "$taskBase/healthz" -TimeoutSec 10
if (-not $taskHealth.ok -or $taskHealth.codex.mode -ne 'real' -or -not $taskHealth.codex.ready) {
    throw 'Codex 真实后端未就绪'
}
$taskListeners = @(Get-NetTCPConnection -LocalPort $Port -State Listen)
if ($taskListeners.Count -ne 1 -or $taskListeners[0].LocalAddress -ne '127.0.0.1') {
    throw '服务必须只监听 127.0.0.1'
}
$taskRepos = Invoke-RestMethod "$taskBase/api/repos" -TimeoutSec 30
$taskSessions = Invoke-RestMethod "$taskBase/api/sessions" -TimeoutSec 30
$taskMessageCount = 0
if ($taskSessions.sessions.Count -gt 0) {
    $taskSessionId = $taskSessions.sessions[0].id
    $taskMessages = Invoke-RestMethod "$taskBase/api/sessions/$taskSessionId/messages" -TimeoutSec 30
    $taskMessageCount = @($taskMessages.messages).Count
}
[pscustomobject]@{
    URL = $taskBase; Backend = $taskHealth.codex.mode; Ready = $taskHealth.codex.ready
    Repositories = @($taskRepos.repos).Count; Sessions = @($taskSessions.sessions).Count
    LatestSessionMessages = $taskMessageCount
} | Format-List
