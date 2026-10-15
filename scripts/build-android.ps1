$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path $PSScriptRoot -Parent
$taskAndroid = Join-Path $taskRoot 'android'
$taskJava = @('C:\Program Files\Android\Android Studio\jbr', 'C:\Program Files\Android\Android Studio1\jbr') |
    Where-Object { (Test-Path -LiteralPath (Join-Path $_ 'bin\java.exe')) -and
        (Test-Path -LiteralPath (Join-Path $_ 'lib\jvm.cfg')) } | Select-Object -First 1
if (-not $taskJava) { throw '未找到 Android Studio JBR，请安装 JDK 17+。' }
$taskSdk = Join-Path $env:LOCALAPPDATA 'Android\Sdk'
if (-not (Test-Path -LiteralPath $taskSdk)) { throw '未找到 Android SDK。' }
$taskSdkProperty = $taskSdk.Replace('\', '/')
"sdk.dir=$taskSdkProperty" | Set-Content -LiteralPath (Join-Path $taskAndroid 'local.properties') -Encoding ascii
$taskOriginalJava = $env:JAVA_HOME
try {
    $env:JAVA_HOME = $taskJava
    Push-Location $taskAndroid
    try {
        & .\gradlew.bat --no-daemon assembleDebug lintDebug
        if ($LASTEXITCODE -ne 0) { throw 'Android 构建或 lint 失败' }
    } finally { Pop-Location }
    $taskArtifacts = Join-Path $taskRoot 'artifacts'
    New-Item -ItemType Directory -Path $taskArtifacts -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $taskAndroid 'app\build\outputs\apk\debug\app-debug.apk') `
        -Destination (Join-Path $taskArtifacts 'codex-remote-debug.apk') -Force
    Get-FileHash -LiteralPath (Join-Path $taskArtifacts 'codex-remote-debug.apk') -Algorithm SHA256
} finally { $env:JAVA_HOME = $taskOriginalJava }
