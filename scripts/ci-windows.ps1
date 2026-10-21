$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$tools = Join-Path (Get-Location).Path '.ci-tools'
New-Item -ItemType Directory -Path $tools -Force | Out-Null

function Get-VerifiedDownload([string] $Uri, [string] $ChecksumUri, [string] $Destination, [string] $ChecksumFilename, [string] $KnownChecksum = '') {
    $expected = $KnownChecksum
    if (-not $expected) {
        $checksums = (Invoke-WebRequest -UseBasicParsing -Uri $ChecksumUri).Content
        if ($ChecksumFilename) {
            $line = ($checksums -split "`n" | Where-Object { $_ -match ([regex]::Escape($ChecksumFilename) + '\s*$') } | Select-Object -First 1)
        } else { $line = $checksums }
        $expected = [regex]::Match($line, '[a-fA-F0-9]{64}').Value
    }
    if (-not $expected) { throw "Missing published checksum for $Uri" }
    if ((Test-Path -LiteralPath $Destination) -and (Get-FileHash -LiteralPath $Destination -Algorithm SHA256).Hash -ieq $expected) { return }
    $partial = $Destination + '.partial'
    & curl.exe --silent --show-error --fail --location --retry 3 --connect-timeout 30 --max-time 600 --output $partial $Uri
    if ($LASTEXITCODE -ne 0) { throw "Download failed: $Uri" }
    if ((Get-FileHash -LiteralPath $partial -Algorithm SHA256).Hash -ine $expected) { throw "Checksum mismatch: $partial" }
    $target = [IO.Path]::GetFullPath($Destination)
    if (-not $target.StartsWith($tools + [IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)) { throw 'Tool download target is outside the CI tools directory.' }
    Move-Item -LiteralPath $partial -Destination $target -Force
}

$nodeVersion = '22.23.3'
$nodeArchive = "node-v$nodeVersion-win-x64.zip"
$nodeDirectory = Join-Path $tools "node-v$nodeVersion-win-x64"
if (-not (Test-Path -LiteralPath (Join-Path $nodeDirectory 'node.exe'))) {
    $nodeZip = Join-Path $tools $nodeArchive
    Get-VerifiedDownload "https://nodejs.org/dist/v$nodeVersion/$nodeArchive" "https://nodejs.org/dist/v$nodeVersion/SHASUMS256.txt" $nodeZip $nodeArchive
    Expand-Archive -LiteralPath $nodeZip -DestinationPath $tools -Force
}
$env:PATH = "$nodeDirectory;$env:PATH"
$env:TEMP = Join-Path (Get-Location).Path 'test-output\tmp'
$env:TMP = $env:TEMP
New-Item -ItemType Directory -Path $env:TEMP -Force | Out-Null
$env:CSC_IDENTITY_AUTO_DISCOVERY = 'false'
node --version
npm --version
