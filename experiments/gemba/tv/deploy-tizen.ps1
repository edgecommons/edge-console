param(
    [Parameter(Mandatory = $true)]
    [string]$TvAddress,
    [string]$TizenCli = 'C:\tizen-studio\tools\ide\bin\tizen.bat',
    [string]$Sdb = 'C:\tizen-studio\tools\sdb.exe'
)

$ErrorActionPreference = 'Stop'
$project = Join-Path $PSScriptRoot 'tizen-gemba'
if (-not (Test-Path -LiteralPath $TizenCli)) { throw "Tizen CLI not found: $TizenCli" }
if (-not (Test-Path -LiteralPath $Sdb)) { throw "SDB not found: $Sdb" }
$package = Get-ChildItem -LiteralPath (Join-Path $project '.buildResult') -Filter '*.wgt' |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1
if (-not $package) { throw 'Build and sign the Tizen WGT before deployment.' }

$serial = "${TvAddress}:26101"
& $Sdb connect $serial
if ($LASTEXITCODE -ne 0) { throw "SDB could not connect to $serial" }
& $Sdb devices
& $TizenCli install-permit -s $serial
if ($LASTEXITCODE -ne 0) { throw "Install permission could not be granted on $serial" }
& $TizenCli install -s $serial --name $package.Name -- $package.DirectoryName
if ($LASTEXITCODE -ne 0) { throw "WGT installation failed on $serial" }
& $TizenCli run -s $serial -p ECGEMBATV1.GembaBoard
if ($LASTEXITCODE -ne 0) { throw "Tizen application launch failed on $serial" }
