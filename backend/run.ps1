# Starts the transcriber on http://127.0.0.1:8765 (the built page is served from the same address).
# Usage:  .\backend\run.ps1            (from the project folder)
#         $env:WHISPER_MODEL = "base"; .\backend\run.ps1   (pick a faster or more accurate speech model)
$ErrorActionPreference = "Stop"
Set-Location -LiteralPath $PSScriptRoot
$python = Join-Path $PSScriptRoot ".venv\Scripts\python.exe"
if (-not (Test-Path $python)) {
  Write-Host "No Python environment yet. Run backend\setup.ps1 first." -ForegroundColor Yellow
  exit 1
}
Write-Host "Video Transcriber: open http://127.0.0.1:8765" -ForegroundColor Green
& $python app.py
