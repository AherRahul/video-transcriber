# One-time setup: Python environment and packages. Needs Python 3.13 (the 3.12 build is blocked by
# Defender on this laptop) and, for some sites, FFmpeg (winget install Gyan.FFmpeg.Essentials).
$ErrorActionPreference = "Stop"
Set-Location -LiteralPath $PSScriptRoot
$py = Join-Path $env:LOCALAPPDATA "Programs\Python\Python313\python.exe"
if (-not (Test-Path $py)) { $py = "python" }
if (-not (Test-Path ".venv")) { & $py -m venv .venv }
$venvPy = Join-Path $PSScriptRoot ".venv\Scripts\python.exe"
& $venvPy -m pip install --upgrade pip
& $venvPy -m pip install --timeout 180 --resume-retries 50 -r requirements.txt
Write-Host "Done. Start it with backend\run.ps1" -ForegroundColor Green
