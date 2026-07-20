param(
    [string]$AndroidSdk,
    [string]$GradleHome,
    [string]$JavaHome = 'C:\Users\breis\tools\jdk21'
)

$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
$toolRoot = Join-Path $repo '.codex-tmp\tv-tools'
if (-not $AndroidSdk) { $AndroidSdk = Join-Path $toolRoot 'android-sdk' }
if (-not $GradleHome) { $GradleHome = Join-Path $toolRoot 'gradle-9.4.1' }

$gradle = Join-Path $GradleHome 'bin\gradle.bat'
$project = Join-Path $PSScriptRoot 'google-tv-gemba'
if (-not (Test-Path -LiteralPath $gradle)) { throw "Gradle not found: $gradle" }
if (-not (Test-Path -LiteralPath (Join-Path $AndroidSdk 'platforms\android-36\android.jar'))) {
    throw "Android API 36 is not installed below: $AndroidSdk"
}
if (-not (Test-Path -LiteralPath $JavaHome)) { throw "JDK not found: $JavaHome" }

$env:ANDROID_HOME = $AndroidSdk
$env:ANDROID_SDK_ROOT = $AndroidSdk
$env:JAVA_HOME = $JavaHome
# Gradle's optional HTML problems report can be locked by a prior daemon even after APK assembly.
# It is not a build artifact for this experiment, so disable it through Gradle's supported switch.
& $gradle --no-problems-report --project-dir $project clean assembleDebug
if ($LASTEXITCODE -ne 0) { throw "Google TV Gradle build failed with exit code $LASTEXITCODE" }

$apk = Join-Path $project 'app\build\outputs\apk\debug\app-debug.apk'
if (-not (Test-Path -LiteralPath $apk)) { throw "Expected APK was not produced: $apk" }
Get-Item -LiteralPath $apk | Select-Object FullName,Length,LastWriteTime
