param([switch] $NodeOnly)

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
if ($NodeOnly) { return }

# Server images can omit the Windows media DLLs that FFmpeg and Electron use.
# This provisions only the disposable CI server, never a studio workstation.
if ($env:CI -and -not (Test-Path -LiteralPath (Join-Path $env:WINDIR 'System32\mfplat.dll')) -and (Get-Command Install-WindowsFeature -ErrorAction SilentlyContinue)) {
    Write-Output 'Installing Windows Server Media Foundation for CI audio tests.'
    $mediaFeature = Install-WindowsFeature -Name Server-Media-Foundation
    if (-not $mediaFeature.Success) { throw 'Could not install Windows Server Media Foundation.' }
}

# These binaries are used only to test CI builds, never copied into the release.
$ffmpegArchive = Join-Path $tools 'ffmpeg-9.0.1-essentials_build.zip'
# Hash published by the Gyan.FFmpeg.Essentials WinGet manifest for this release.
Get-VerifiedDownload 'https://github.com/GyanD/codexffmpeg/releases/download/9.0.1/ffmpeg-9.0.1-essentials_build.zip' '' $ffmpegArchive '' 'fec81ae03971d9dd4be3ebe02e263bd2ec1d789483f931bdba5f5715e65da2e9'
$ffmpegDirectory = Join-Path $tools 'ffmpeg-essentials'
Expand-Archive -LiteralPath $ffmpegArchive -DestinationPath $ffmpegDirectory -Force
$ffmpeg = Get-ChildItem -LiteralPath $ffmpegDirectory -Filter ffmpeg.exe -Recurse | Select-Object -First 1
if (-not $ffmpeg) { throw 'CI FFmpeg executable was not found.' }
$env:SIFT_FFMPEG = $ffmpeg.FullName
$env:SIFT_FFPROBE = Join-Path $ffmpeg.DirectoryName 'ffprobe.exe'
node scripts/check-audio-tools.mjs
if ($LASTEXITCODE -ne 0) { throw 'CI audio-tool verification failed; see the diagnostic above.' }
