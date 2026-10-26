# Development convenience: runs the local server and opens Sift in the default
# browser. The desktop app (installer or Start Sift Desktop.cmd) is the main way to run Sift.
$ErrorActionPreference = 'Stop'
$siftRoot = $PSScriptRoot
$siftUrl = 'http://127.0.0.1:4317'
$siftRunning = $false
try {
    $siftResponse = Invoke-RestMethod -Uri "$siftUrl/api/capabilities" -TimeoutSec 2
    $siftRunning = $siftResponse.handoff -eq 1
} catch {}
if (-not $siftRunning) {
    if (-not (Test-Path -LiteralPath "$siftRoot\node_modules\essentia.js")) { throw 'Audio analysis dependencies are missing. Run npm ci --ignore-scripts in the Sift folder first.' }
    $siftNode = (Get-Command node.exe -ErrorAction Stop).Source
    Start-Process -FilePath $siftNode -ArgumentList 'server.mjs' -WorkingDirectory $siftRoot -WindowStyle Hidden -RedirectStandardOutput "$siftRoot\sift.log" -RedirectStandardError "$siftRoot\sift-error.log"
    for ($siftAttempt = 0; $siftAttempt -lt 40; $siftAttempt++) {
        Start-Sleep -Milliseconds 250
        try {
            $siftResponse = Invoke-RestMethod -Uri "$siftUrl/api/capabilities" -TimeoutSec 1
            $siftRunning = $siftResponse.handoff -eq 1
            if ($siftRunning) { break }
        } catch {}
    }
}
if (-not $siftRunning) { throw 'Sift did not start. See sift-error.log in this folder.' }
Start-Process $siftUrl
