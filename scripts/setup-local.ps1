$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path $PSScriptRoot -Parent
$taskService = Join-Path $taskRoot 'services\rmtcdx'
$taskCommit = '82433524e8fb431185fbc7556d1e8a1cf2f2976d'
if (-not (Test-Path -LiteralPath $taskService)) {
    New-Item -ItemType Directory -Path (Split-Path $taskService -Parent) -Force | Out-Null
    git clone https://github.com/tianwei-upup/rmtcdx.git $taskService
    if ($LASTEXITCODE -ne 0) { throw 'rmtcdx 下载失败' }
    git -C $taskService checkout --detach $taskCommit
    if ($LASTEXITCODE -ne 0) { throw '固定版本 checkout 失败' }
}
$taskActualCommit = git -C $taskService rev-parse HEAD
if ($LASTEXITCODE -ne 0 -or $taskActualCommit -ne $taskCommit) { throw '服务目录版本不匹配，拒绝覆盖。' }
foreach ($taskPatchName in @('remote-control.patch')) {
    $taskPatch = Join-Path $taskRoot "patches\$taskPatchName"
    git -C $taskService apply --check $taskPatch 2>$null
    if ($LASTEXITCODE -eq 0) {
        git -C $taskService apply $taskPatch
        if ($LASTEXITCODE -ne 0) { throw "补丁 $taskPatchName 应用失败" }
    } else {
        git -C $taskService apply --reverse --check $taskPatch 2>$null
        if ($LASTEXITCODE -ne 0) { throw "补丁 $taskPatchName 不匹配，拒绝覆盖已有改动。" }
    }
}
Push-Location $taskService
try {
    npm ci
    if ($LASTEXITCODE -ne 0) { throw 'npm ci 失败' }
    npm run build
    if ($LASTEXITCODE -ne 0) { throw '服务构建失败' }
} finally { Pop-Location }
Push-Location (Join-Path $taskRoot 'control')
try {
    npm ci
    if ($LASTEXITCODE -ne 0) { throw '中转服务依赖安装失败' }
} finally { Pop-Location }
Write-Output '本地服务已安装。运行 scripts/start-local.ps1 启动。'
