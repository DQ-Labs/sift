$ErrorActionPreference = 'Stop'
$tools = Join-Path (Get-Location).Path '.ci-tools'
New-Item -ItemType Directory -Path $tools -Force | Out-Null

function Get-VerifiedDownload([string] $Uri, [string] $ChecksumUri, [string] $Destination, [string] $ChecksumFilename) {
    $checksums = (Invoke-WebRequest -UseBasicParsing -Uri $ChecksumUri).Content
    if ($ChecksumFilename) {
        $line = ($checksums -split "`n" | Where-Object { $_ -match ([regex]::Escape($ChecksumFilename) + '\s*$') } | Select-Object -First 1)
    } else { $line = $checksums }
    $expected = [regex]::Match($line, '[a-fA-F0-9]{64}').Value
    if (-not $expected) { throw "Missing published checksum for $Uri" }
    if (-not (Test-Path -LiteralPath $Destination)) { Invoke-WebRequest -UseBasicParsing -Uri $Uri -OutFile $Destination }
    if ((Get-FileHash -LiteralPath $Destination -Algorithm SHA256).Hash -ine $expected) { throw "Checksum mismatch: $Destination" }
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

# These binaries are used only to test CI builds, never copied into the release.
$ffmpegArchive = Join-Path $tools 'ffmpeg-release-full.7z'
Get-VerifiedDownload 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-full.7z' 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-full.7z.sha256' $ffmpegArchive ''
$sevenZip = (Get-Command 7z.exe -ErrorAction SilentlyContinue).Source
if (-not $sevenZip) { $sevenZip = 'C:\Program Files\7-Zip\7z.exe' }
$ffmpegDirectory = Join-Path $tools 'ffmpeg'
& $sevenZip x $ffmpegArchive "-o$ffmpegDirectory" -y -bd | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Could not extract CI audio tools.' }
$ffmpeg = Get-ChildItem -LiteralPath $ffmpegDirectory -Filter ffmpeg.exe -Recurse | Select-Object -First 1
if (-not $ffmpeg) { throw 'CI FFmpeg executable was not found.' }
$env:SIFT_FFMPEG = $ffmpeg.FullName
$env:SIFT_FFPROBE = Join-Path $ffmpeg.DirectoryName 'ffprobe.exe'
$filter = & $env:SIFT_FFMPEG -hide_banner -h filter=rubberband 2>&1
if ($LASTEXITCODE -ne 0 -or -not ($filter -match '^Filter rubberband')) { throw 'CI FFmpeg needs Rubber Band.' }
$env:TEMP = Join-Path (Get-Location).Path 'test-output\tmp'
$env:TMP = $env:TEMP
New-Item -ItemType Directory -Path $env:TEMP -Force | Out-Null
$env:CSC_IDENTITY_AUTO_DISCOVERY = 'false'
node --version
npm --version
