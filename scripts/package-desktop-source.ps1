$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path $PSScriptRoot -Parent
$taskStage = Join-Path $taskRoot ('.runtime\desktop-source-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $taskStage -Force | Out-Null
$taskFiles = @(
    'README.md', 'AGENTS.md', 'docs/MAC_SETUP.md', 'docs/VALIDATION.md',
    'patches/remote-control.patch',
    'control/package.json', 'control/package-lock.json', 'control/README.md', 'control/.gitignore',
    'scripts/setup-mac.sh', 'scripts/start-mac.sh', 'scripts/setup-local.ps1',
    'scripts/start-local.ps1', 'scripts/stop-local.ps1', 'scripts/verify-local.ps1',
    'scripts/start-control-local.mjs', 'scripts/stop-control-local.ps1',
    'scripts/verify-compat.mjs', 'scripts/export-upstream-patch.mjs'
)
foreach ($taskFile in $taskFiles) {
    $taskDestination = Join-Path $taskStage $taskFile
    New-Item -ItemType Directory -Path (Split-Path $taskDestination -Parent) -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $taskRoot $taskFile) -Destination $taskDestination
}
foreach ($taskDirectory in @('control/src', 'control/test', 'control/deploy')) {
    Copy-Item -LiteralPath (Join-Path $taskRoot $taskDirectory) -Destination (Join-Path $taskStage 'control') -Recurse
}
$taskArtifacts = Join-Path $taskRoot 'artifacts'
New-Item -ItemType Directory -Path $taskArtifacts -Force | Out-Null
$taskZip = Join-Path $taskArtifacts 'rmtagt-desktop-source.zip'
$taskTemporaryZip = Join-Path $taskArtifacts ('rmtagt-desktop-source-' + [guid]::NewGuid().ToString('N') + '.zip')
Add-Type -AssemblyName System.IO.Compression.FileSystem
[IO.Compression.ZipFile]::CreateFromDirectory($taskStage, $taskTemporaryZip)
$taskInspect = [IO.Compression.ZipFile]::OpenRead($taskTemporaryZip)
try {
    foreach ($taskEntry in $taskInspect.Entries) {
        if ($taskEntry.FullName -match '(^|[/\\])(node_modules|\.runtime|\.git|\.client|\.state)([/\\]|$)') { throw '源码包包含禁止目录' }
    }
} finally { $taskInspect.Dispose() }
Move-Item -LiteralPath $taskTemporaryZip -Destination $taskZip -Force
Write-Output "桌面端源码包：$taskZip"
(Get-FileHash -LiteralPath $taskZip -Algorithm SHA256).Hash
