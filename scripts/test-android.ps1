param([string]$Device = 'emulator-5554', [string]$CloudConfig = '')
$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path $PSScriptRoot -Parent
$taskOriginalJava = $env:JAVA_HOME
try {
    $taskJava = @('C:\Program Files\Android\Android Studio\jbr', 'C:\Program Files\Android\Android Studio1\jbr') |
        Where-Object { (Test-Path -LiteralPath (Join-Path $_ 'bin\java.exe')) -and
            (Test-Path -LiteralPath (Join-Path $_ 'lib\jvm.cfg')) } | Select-Object -First 1
    if (-not $taskJava) { throw '未找到可用的 Android Studio JBR。' }
    $env:JAVA_HOME = $taskJava
    Push-Location (Join-Path $taskRoot 'android')
    try {
        & .\gradlew.bat --no-daemon assembleDebug assembleDebugAndroidTest
        if ($LASTEXITCODE -ne 0) { throw '测试 APK 构建失败' }
    } finally { Pop-Location }
    adb -s $Device reverse tcp:3220 tcp:3220
    if ($LASTEXITCODE -ne 0) { throw 'adb reverse 失败' }
    adb -s $Device install -r (Join-Path $taskRoot 'android\app\build\outputs\apk\debug\app-debug.apk')
    if ($LASTEXITCODE -ne 0) { throw '客户端安装失败' }
    adb -s $Device install -r (Join-Path $taskRoot 'android\app\build\outputs\apk\androidTest\debug\app-debug-androidTest.apk')
    if ($LASTEXITCODE -ne 0) { throw '测试包安装失败' }
    $taskTestClass = 'com.liutw.codexremote.RemoteSmokeTest'
    if ($CloudConfig) {
        if (-not (Test-Path -LiteralPath $CloudConfig -PathType Leaf)) { throw '云端测试配置文件不存在' }
        # Credentials are copied into private app storage, never printed or passed as shell arguments.
        adb -s $Device push $CloudConfig /data/local/tmp/rmtagt-cloud-test.json | Out-Null
        if ($LASTEXITCODE -ne 0) { throw '上传测试配置失败' }
        adb -s $Device shell run-as com.liutw.codexremote mkdir -p files
        adb -s $Device shell run-as com.liutw.codexremote cp /data/local/tmp/rmtagt-cloud-test.json files/cloud-test.json
        if ($LASTEXITCODE -ne 0) { throw '写入测试配置失败' }
        adb -s $Device shell rm /data/local/tmp/rmtagt-cloud-test.json
        $taskTestClass = 'com.liutw.codexremote.CloudSmokeTest'
    }
    $taskUserReady = $false
    for ($taskAttempt = 0; $taskAttempt -lt 60; $taskAttempt++) {
        $taskUsers = adb -s $Device shell dumpsys user | Out-String
        if ($taskUsers -match '0=RUNNING_UNLOCKED') { $taskUserReady = $true; break }
        Start-Sleep -Milliseconds 500
    }
    if (-not $taskUserReady) { throw 'Android 用户尚未解锁，无法启动 instrumentation。' }
    $taskRuntime = Join-Path $taskRoot '.runtime'
    New-Item -ItemType Directory -Path $taskRuntime -Force | Out-Null
    $taskOutput = Join-Path $taskRuntime 'instrumentation.stdout.log'
    $taskErrors = Join-Path $taskRuntime 'instrumentation.stderr.log'
    $taskRunner = Start-Process -FilePath (Get-Command adb).Source -WindowStyle Hidden -PassThru `
        -ArgumentList @('-s', $Device, 'shell', 'am', 'instrument', '-w', '-e', 'class', $taskTestClass,
            'com.liutw.codexremote.test/android.test.InstrumentationTestRunner') `
        -RedirectStandardOutput $taskOutput -RedirectStandardError $taskErrors
    for ($taskAttempt = 0; $taskAttempt -lt 12; $taskAttempt++) {
        if ($taskRunner.WaitForExit(30000)) { break }
    }
    if (-not $taskRunner.HasExited) {
        $taskRunner.Kill()
        adb -s $Device shell am force-stop com.liutw.codexremote
        throw 'Android 测试超时，已停止本次测试。'
    }
    $taskResult = Get-Content -LiteralPath $taskOutput
    $taskResult | Write-Output
    if ($taskRunner.ExitCode -ne 0 -or -not (($taskResult -join "`n") -match '(?m)^OK \(\d+ tests?\)\s*$')) {
        Get-Content -LiteralPath $taskErrors | Write-Output
        throw 'Android 集成测试未通过'
    }
    if ($CloudConfig) {
        adb -s $Device pull /sdcard/Android/data/com.liutw.codexremote/files/cloud-smoke.png `
            (Join-Path $taskRuntime 'android-cloud-smoke.png') | Out-Null
    }
} finally {
    if ($CloudConfig) {
        adb -s $Device shell rm -f /data/local/tmp/rmtagt-cloud-test.json
        adb -s $Device shell run-as com.liutw.codexremote rm -f files/cloud-test.json
    }
    $env:JAVA_HOME = $taskOriginalJava
}
