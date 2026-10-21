@echo off
cd /d "%~dp0"
if not exist "node_modules\electron\dist\electron.exe" (
  echo Desktop runtime missing. Run npm ci in this folder first.
  pause
  exit /b 1
)
start "" "node_modules\electron\dist\electron.exe" "desktop\main.cjs"
