param(
    [Parameter(Mandatory = $true)]
    [string]$CertificateProfile,
    [string]$TizenCli = 'C:\tizen-studio\tools\ide\bin\tizen.bat'
)

$ErrorActionPreference = 'Stop'
$project = Join-Path $PSScriptRoot 'tizen-gemba'
if (-not (Test-Path -LiteralPath $TizenCli)) { throw "Tizen CLI not found: $TizenCli" }

& $TizenCli build-web -- $project
if ($LASTEXITCODE -ne 0) { throw "Tizen Web build failed with exit code $LASTEXITCODE" }
$buildResult = Join-Path $project '.buildResult'
& $TizenCli package -t wgt -s $CertificateProfile -- $buildResult
if ($LASTEXITCODE -ne 0) { throw "Tizen WGT packaging failed with exit code $LASTEXITCODE" }

$generatedPackage = Join-Path $buildResult 'EdgeCommons Gemba.wgt'
if (-not (Test-Path -LiteralPath $generatedPackage)) {
    throw "Expected WGT package was not produced: $generatedPackage"
}

# The 2019 Samsung TV installer rejects otherwise-valid WGT files whose filenames contain spaces.
$normalizedPackage = Join-Path $buildResult 'EdgeCommonsGemba.wgt'
Move-Item -LiteralPath $generatedPackage -Destination $normalizedPackage -Force
$package = Get-Item -LiteralPath $normalizedPackage
$package | Select-Object FullName,Length,LastWriteTime
