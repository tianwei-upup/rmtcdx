$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path $PSScriptRoot -Parent
$taskTools = Join-Path $taskRoot '.runtime\tools'
$taskBinary = Join-Path $taskTools 'cloudflared.exe'
$taskExpectedHash = '86aee4017b26625cee8484c113558f48effa4cd47f7aa05fcf425604e5d2b23c'
New-Item -ItemType Directory -Path $taskTools -Force | Out-Null
if (-not (Test-Path -LiteralPath $taskBinary)) {
    Invoke-WebRequest -Uri 'https://github.com/cloudflare/cloudflared/releases/download/2026.10.0/cloudflared-windows-amd64.exe' `
        -OutFile $taskBinary
}
if ((Get-FileHash -LiteralPath $taskBinary -Algorithm SHA256).Hash -ne $taskExpectedHash) {
    throw 'cloudflared 文件校验失败，请从 Cloudflare 官方重新下载。'
}
& $taskBinary --version
if ($LASTEXITCODE -ne 0) { throw 'cloudflared 无法运行' }
