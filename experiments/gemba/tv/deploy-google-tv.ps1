param(
    [Parameter(Mandatory = $true)]
    [string]$DeviceAddress,
    [string]$GatewayUrl = 'ws://192.168.1.224:18445/apps/tv-board/ws',
    [int]$AdbPort = 5555,
    [string]$AdbPath
)

$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
if (-not $AdbPath) {
    $AdbPath = Join-Path $repo '.codex-tmp\tv-tools\android-sdk\platform-tools\adb.exe'
}
$apk = Join-Path $PSScriptRoot 'google-tv-gemba\app\build\outputs\apk\debug\app-debug.apk'
if (-not (Test-Path -LiteralPath $AdbPath)) { throw "adb not found: $AdbPath" }
if (-not (Test-Path -LiteralPath $apk)) { throw "Build the APK first: $apk" }

$target = "${DeviceAddress}:$AdbPort"
& $AdbPath connect $target
if ($LASTEXITCODE -ne 0) { throw "adb could not connect to $target" }
& $AdbPath -s $target install -r $apk
if ($LASTEXITCODE -ne 0) { throw "APK installation failed on $target" }
& $AdbPath -s $target shell am force-stop dev.edgecommons.gembatv
& $AdbPath -s $target shell am start -n dev.edgecommons.gembatv/.MainActivity --es bridgeUrl $GatewayUrl
if ($LASTEXITCODE -ne 0) { throw "Google TV application launch failed on $target" }
& $AdbPath -s $target shell dumpsys package dev.edgecommons.gembatv | Select-String -Pattern 'versionName|versionCode'
