param([int]$Port = 3210, [string]$RepoConfig = '')
$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path $PSScriptRoot -Parent
$taskService = Join-Path $taskRoot 'services\rmtcdx'
$taskRuntime = Join-Path $taskRoot '.runtime'
$taskEntry = Join-Path $taskService 'apps\bridge\dist\main.js'
if (-not (Test-Path -LiteralPath $taskEntry)) { throw '请先在 services/rmtcdx 运行 npm ci 和 npm run build。' }
if ($Port -lt 1 -or $Port -gt 65535) { throw '无效端口' }
if (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue) {
    throw "端口 $Port 已被占用；先运行 verify-local.ps1 检查，避免重复启动。"
}

# Node spawn cannot execute npm's Windows .cmd shim without a shell.
# Use the native binary supplied by the already-installed official Codex package.
$taskCodexCommand = Get-Command codex -ErrorAction Stop
$taskCodexDirectory = Split-Path $taskCodexCommand.Source -Parent
$taskCodexPackage = Join-Path $taskCodexDirectory 'node_modules\@openai\codex'
$taskCodexBinary = Get-ChildItem -LiteralPath $taskCodexPackage -Recurse -Filter codex.exe |
    Select-Object -First 1 -ExpandProperty FullName
if (-not $taskCodexBinary) { throw '未找到官方 codex.exe，请检查 @openai/codex 安装。' }
New-Item -ItemType Directory -Path $taskRuntime -Force | Out-Null
$taskOriginalPath = $env:Path
$taskOriginalHost = $env:HOST
$taskOriginalPort = $env:PORT
$taskOriginalMode = $env:CODEX_MODE
$taskOriginalData = $env:DATA_DIR
$taskOriginalRepoConfig = $env:REPO_CONFIG_PATH
try {
    $env:Path = (Split-Path $taskCodexBinary -Parent) + ';' + $env:Path
    $env:HOST = '127.0.0.1'
    $env:PORT = "$Port"
    $env:CODEX_MODE = 'real'
    $env:DATA_DIR = Join-Path $taskRuntime 'data'
    $env:REPO_CONFIG_PATH = if ($RepoConfig) { (Resolve-Path -LiteralPath $RepoConfig).Path } else { Join-Path $taskRoot 'repos.json' }
    $taskNode = (Get-Command node -ErrorAction Stop).Source
    $taskProcess = Start-Process -FilePath $taskNode -ArgumentList @('"' + $taskEntry + '"', 'serve') `
        -WorkingDirectory $taskService -WindowStyle Hidden -PassThru `
        -RedirectStandardOutput (Join-Path $taskRuntime 'bridge.stdout.log') `
        -RedirectStandardError (Join-Path $taskRuntime 'bridge.stderr.log')
    @{ pid = $taskProcess.Id; port = $Port; entry = $taskEntry } |
        ConvertTo-Json | Set-Content -LiteralPath (Join-Path $taskRuntime 'bridge.json') -Encoding utf8
} finally {
    $env:Path = $taskOriginalPath
    $env:HOST = $taskOriginalHost
    $env:PORT = $taskOriginalPort
    $env:CODEX_MODE = $taskOriginalMode
    $env:DATA_DIR = $taskOriginalData
    $env:REPO_CONFIG_PATH = $taskOriginalRepoConfig
}
for ($taskAttempt = 0; $taskAttempt -lt 30; $taskAttempt++) {
    if ($taskProcess.HasExited) { throw "服务退出。检查 $taskRuntime\bridge.stderr.log" }
    try {
        $taskHealth = Invoke-RestMethod "http://127.0.0.1:$Port/healthz" -TimeoutSec 2
        if ($taskHealth.codex.mode -eq 'real' -and $taskHealth.codex.ready) {
            Write-Output "Codex 真实后端已启动：http://127.0.0.1:$Port （PID $($taskProcess.Id)）"
            exit 0
        }
    } catch { }
    Start-Sleep -Milliseconds 500
}
throw "服务未就绪。检查 $taskRuntime\bridge.stderr.log"
